// LZMA 解码器（.lzma / "LZMA alone" 格式），只读流，按需解压。
// 按 LZMA SDK 的参考实现（LzmaSpec，公有领域）移植，纯托管代码，C# 5 可编译，不依赖任何外部程序。
// 文件头：1 字节属性（lc/lp/pb）+ 4 字节字典大小 + 8 字节解压后大小（-1 表示未知，以结束标记收尾）。

using System;
using System.IO;
using System.Runtime.CompilerServices;

sealed class LzmaStream : Stream
{
    const int NumStates = 12;
    const int PosBitsMax = 4;
    const int EndPosModelIndex = 14;
    const int NumFullDistances = 128;
    const int MatchMinLen = 2;
    const uint TopValue = 1u << 24;
    const ushort ProbInit = 1024;

    readonly Stream input;
    readonly byte[] inBuf = new byte[1 << 16];
    int inPos, inLen;
    uint range, code;

    readonly byte[] dict;
    readonly uint dictSize;
    uint dictPos;
    ulong totalPos;

    readonly int lc, lp, pb;
    readonly ushort[] literal;
    readonly ushort[] isMatch = new ushort[NumStates << PosBitsMax];
    readonly ushort[] isRep = new ushort[NumStates];
    readonly ushort[] isRepG0 = new ushort[NumStates];
    readonly ushort[] isRepG1 = new ushort[NumStates];
    readonly ushort[] isRepG2 = new ushort[NumStates];
    readonly ushort[] isRep0Long = new ushort[NumStates << PosBitsMax];
    readonly ushort[] posSlot = new ushort[4 << 6];
    readonly ushort[] posDecoders = new ushort[1 + NumFullDistances - EndPosModelIndex];
    readonly ushort[] align = new ushort[1 << 4];
    // 长度解码器：[0] choice，[1] choice2，[2..130) low，[130..258) mid，[258..514) high
    readonly ushort[] lenProbs = new ushort[514];
    readonly ushort[] repLenProbs = new ushort[514];

    uint rep0, rep1, rep2, rep3;
    int state;
    int remLen;
    bool finished;
    readonly bool sizeKnown;
    ulong remaining;

    byte[] outArr;
    int outOff;

    public LzmaStream(Stream input)
    {
        this.input = input;
        byte[] h = new byte[13];
        for (int n = 0; n < 13; n++)
        {
            int b = input.ReadByte();
            if (b < 0) throw new InvalidDataException("LZMA 文件头不完整");
            h[n] = (byte)b;
        }
        int d = h[0];
        if (d >= 9 * 5 * 5) throw new InvalidDataException("LZMA 属性无效");
        lc = d % 9; d /= 9;
        lp = d % 5;
        pb = d / 5;
        uint ds = BitConverter.ToUInt32(h, 1);
        if (ds < 4096) ds = 4096;
        dictSize = ds;
        dict = new byte[ds];
        ulong size = BitConverter.ToUInt64(h, 5);
        sizeKnown = size != ulong.MaxValue;
        remaining = size;

        literal = new ushort[0x300 << (lc + lp)];
        foreach (ushort[] p in new[] { literal, isMatch, isRep, isRepG0, isRepG1, isRepG2, isRep0Long, posSlot, posDecoders, align, lenProbs, repLenProbs })
            for (int i = 0; i < p.Length; i++) p[i] = ProbInit;

        if (NextByte() != 0) throw new InvalidDataException("LZMA 数据损坏");
        for (int i = 0; i < 4; i++) code = (code << 8) | NextByte();
        range = 0xFFFFFFFF;
        if (code == range) throw new InvalidDataException("LZMA 数据损坏");
    }

    /* ---------- 区间解码 ---------- */

    byte NextByte()
    {
        if (inPos == inLen)
        {
            inLen = input.Read(inBuf, 0, inBuf.Length);
            inPos = 0;
            if (inLen <= 0) throw new InvalidDataException("LZMA 数据提前结束");
        }
        return inBuf[inPos++];
    }

    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    uint Bit(ushort[] probs, int i)
    {
        uint v = probs[i];
        uint bound = (range >> 11) * v;
        uint bit;
        if (code < bound)
        {
            v += ((1u << 11) - v) >> 5;
            range = bound;
            bit = 0;
        }
        else
        {
            v -= v >> 5;
            code -= bound;
            range -= bound;
            bit = 1;
        }
        probs[i] = (ushort)v;
        if (range < TopValue)
        {
            range <<= 8;
            code = (code << 8) | NextByte();
        }
        return bit;
    }

    uint DirectBits(int numBits)
    {
        uint res = 0;
        do
        {
            range >>= 1;
            code -= range;
            uint t = 0 - (code >> 31);
            code += range & t;
            if (code == range) throw new InvalidDataException("LZMA 数据损坏");
            if (range < TopValue)
            {
                range <<= 8;
                code = (code << 8) | NextByte();
            }
            res = (res << 1) + t + 1;
        } while (--numBits > 0);
        return res;
    }

    uint BitTree(ushort[] probs, int offset, int numBits)
    {
        uint m = 1;
        for (int i = 0; i < numBits; i++) m = (m << 1) + Bit(probs, offset + (int)m);
        return m - (1u << numBits);
    }

    uint BitTreeReverse(ushort[] probs, int offset, int numBits)
    {
        uint m = 1, sym = 0;
        for (int i = 0; i < numBits; i++)
        {
            uint bit = Bit(probs, offset + (int)m);
            m = (m << 1) + bit;
            sym |= bit << i;
        }
        return sym;
    }

    uint Len(ushort[] p, int posState)
    {
        if (Bit(p, 0) == 0) return BitTree(p, 2 + (posState << 3), 3);
        if (Bit(p, 1) == 0) return 8 + BitTree(p, 130 + (posState << 3), 3);
        return 16 + BitTree(p, 258, 8);
    }

    uint Distance(uint len)
    {
        uint lenState = len > 3 ? 3 : len;
        uint slot = BitTree(posSlot, (int)(lenState << 6), 6);
        if (slot < 4) return slot;
        int numDirectBits = (int)((slot >> 1) - 1);
        uint dist = (2 | (slot & 1)) << numDirectBits;
        if (slot < EndPosModelIndex) return dist + BitTreeReverse(posDecoders, (int)(dist - slot), numDirectBits);
        dist += DirectBits(numDirectBits - 4) << 4;
        return dist + BitTreeReverse(align, 0, 4);
    }

    /* ---------- 输出窗口 ---------- */

    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    void Put(byte b)
    {
        dict[dictPos++] = b;
        if (dictPos == dictSize) dictPos = 0;
        totalPos++;
        outArr[outOff++] = b;
        remaining--;
    }

    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    byte Get(uint dist) // dist 从 1 开始
    {
        return dict[dictPos >= dist ? dictPos - dist : dictSize - dist + dictPos];
    }

    /* ---------- 解码一步 ---------- */

    // 解出一个符号：字面量或短重复直接输出 1 字节，匹配则设置 remLen 交给 Read 复制
    void Step()
    {
        if (sizeKnown && remaining == 0)
        {
            finished = true;
            return;
        }
        int posState = (int)(totalPos & ((1u << pb) - 1));

        if (Bit(isMatch, (state << PosBitsMax) + posState) == 0)
        {
            uint prev = totalPos > 0 ? Get(1) : 0u;
            int baseIdx = 0x300 * (int)((((uint)totalPos & ((1u << lp) - 1)) << lc) + (prev >> (8 - lc)));
            uint sym = 1;
            if (state >= 7)
            {
                uint matchByte = Get(rep0 + 1);
                do
                {
                    uint matchBit = (matchByte >> 7) & 1;
                    matchByte <<= 1;
                    uint bit = Bit(literal, baseIdx + (int)(((1 + matchBit) << 8) + sym));
                    sym = (sym << 1) | bit;
                    if (matchBit != bit) break;
                } while (sym < 0x100);
            }
            while (sym < 0x100) sym = (sym << 1) | Bit(literal, baseIdx + (int)sym);
            Put((byte)(sym - 0x100));
            state = state < 4 ? 0 : state < 10 ? state - 3 : state - 6;
            return;
        }

        uint len;
        if (Bit(isRep, state) != 0)
        {
            if (totalPos == 0) throw new InvalidDataException("LZMA 数据损坏");
            if (Bit(isRepG0, state) == 0)
            {
                if (Bit(isRep0Long, (state << PosBitsMax) + posState) == 0)
                {
                    state = state < 7 ? 9 : 11;
                    Put(Get(rep0 + 1));
                    return;
                }
            }
            else
            {
                uint dist;
                if (Bit(isRepG1, state) == 0) dist = rep1;
                else
                {
                    if (Bit(isRepG2, state) == 0) dist = rep2;
                    else
                    {
                        dist = rep3;
                        rep3 = rep2;
                    }
                    rep2 = rep1;
                }
                rep1 = rep0;
                rep0 = dist;
            }
            len = Len(repLenProbs, posState);
            state = state < 7 ? 8 : 11;
        }
        else
        {
            rep3 = rep2;
            rep2 = rep1;
            rep1 = rep0;
            len = Len(lenProbs, posState);
            state = state < 7 ? 7 : 10;
            rep0 = Distance(len);
            if (rep0 == 0xFFFFFFFF)
            {
                // 结束标记
                if (code != 0) throw new InvalidDataException("LZMA 数据损坏");
                finished = true;
                return;
            }
            if (rep0 >= dictSize || rep0 >= totalPos) throw new InvalidDataException("LZMA 数据损坏");
        }
        len += MatchMinLen;
        if (sizeKnown && len > remaining) throw new InvalidDataException("LZMA 数据损坏");
        remLen = (int)len;
    }

    public override int Read(byte[] buffer, int offset, int count)
    {
        outArr = buffer;
        outOff = offset;
        int end = offset + count;
        while (outOff < end)
        {
            if (remLen > 0)
            {
                uint dist = rep0 + 1;
                int n = Math.Min(remLen, end - outOff);
                remLen -= n;
                while (n-- > 0) Put(Get(dist));
                continue;
            }
            if (finished) break;
            Step();
        }
        outArr = null;
        return outOff - offset;
    }

    public override bool CanRead { get { return true; } }
    public override bool CanSeek { get { return false; } }
    public override bool CanWrite { get { return false; } }
    public override long Length { get { throw new NotSupportedException(); } }
    public override long Position { get { return (long)totalPos; } set { throw new NotSupportedException(); } }
    public override void Flush() { }
    public override long Seek(long offset, SeekOrigin origin) { throw new NotSupportedException(); }
    public override void SetLength(long value) { throw new NotSupportedException(); }
    public override void Write(byte[] buffer, int offset, int count) { throw new NotSupportedException(); }
}
