/**
 * 文本文件的编码：读取时识别 UTF-8（可带 BOM）和 GBK，保存时按原编码写回，
 * 避免把 GBK 文件当 UTF-8 打开、保存后原来的字节永久丢失。
 */
import type { TextEncodingName } from '../shared/types'

export interface DecodedText {
  text: string
  encoding: TextEncodingName
  bom: boolean
  /** 既不是有效的 UTF-8 也不是 GBK：按 UTF-8 解码，无效字节已变成 U+FFFD，保存会丢掉它们 */
  lossy: boolean
}

const BOM = Buffer.from([0xef, 0xbb, 0xbf])

/** GBK 双字节编码表：字符 → 字节（Node 只有 GBK 解码器，编码表由解码器反推出来） */
let gbkTable: Map<string, number> | null = null
function gbk(): Map<string, number> {
  if (gbkTable) return gbkTable
  const table = new Map<string, number>()
  const dec = new TextDecoder('gbk')
  const pair = new Uint8Array(2)
  for (let lead = 0x81; lead <= 0xfe; lead++) {
    for (let trail = 0x40; trail <= 0xfe; trail++) {
      if (trail === 0x7f) continue
      pair[0] = lead
      pair[1] = trail
      const ch = dec.decode(pair)
      if (ch.length === 1 && ch !== '�' && !table.has(ch)) table.set(ch, (lead << 8) | trail)
    }
  }
  gbkTable = table
  return table
}

/** 编码成 GBK；有 GBK 表示不了的字符时抛错（不能悄悄写成问号） */
function encodeGbk(text: string): Buffer {
  const table = gbk()
  const out = Buffer.allocUnsafe(text.length * 2)
  let n = 0
  for (const ch of text) {
    const c = ch.codePointAt(0)!
    if (c < 0x80) {
      out[n++] = c
      continue
    }
    const code = table.get(ch)
    if (code === undefined) throw new Error(`“${ch}” (U+${c.toString(16).toUpperCase().padStart(4, '0')}) cannot be saved in GBK encoding`)
    out[n++] = code >> 8
    out[n++] = code & 0xff
  }
  return out.subarray(0, n)
}

export function decodeText(buf: Buffer): DecodedText {
  const bom = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf
  const body = bom ? buf.subarray(3) : buf
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(body), encoding: 'utf8', bom, lossy: false }
  } catch {
    /* 不是有效的 UTF-8 */
  }
  if (!bom) {
    try {
      const text = new TextDecoder('gbk', { fatal: true }).decode(body)
      // 只有能原样写回时才按 GBK 处理（GB18030 的四字节字符等写不回去）
      if (encodeGbk(text).equals(body)) return { text, encoding: 'gbk', bom: false, lossy: false }
    } catch {
      /* 也不是 GBK */
    }
  }
  return { text: body.toString('utf8'), encoding: 'utf8', bom, lossy: true }
}

export function encodeText(text: string, opts: { encoding?: TextEncodingName; bom?: boolean } = {}): Buffer {
  if (opts.encoding === 'gbk') return encodeGbk(text)
  const body = Buffer.from(text, 'utf8')
  return opts.bom ? Buffer.concat([BOM, body]) : body
}
