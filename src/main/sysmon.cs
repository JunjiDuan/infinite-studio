using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

// 系统监视器采样器：由 PowerShell 的 Add-Type 在运行时编译（Windows 自带的 C# 5 编译器），
// 每隔一段时间往标准输出写一行 JSON。只读性能计数器和显卡内核接口，不需要管理员权限。
public static class InfiniteSysMon
{
    [StructLayout(LayoutKind.Sequential)]
    struct LUID { public uint Low; public int High; }

    [StructLayout(LayoutKind.Sequential)]
    struct ADAPTERINFO { public uint hAdapter; public LUID Luid; public uint NumOfSources; public int Precise; }

    [StructLayout(LayoutKind.Sequential)]
    struct ENUMADAPTERS2 { public uint NumAdapters; public IntPtr pAdapters; }

    [StructLayout(LayoutKind.Sequential)]
    struct ENUMADAPTERS3 { public ulong Filter; public uint NumAdapters; public IntPtr pAdapters; }

    [StructLayout(LayoutKind.Sequential)]
    struct QUERYADAPTERINFO { public uint hAdapter; public int Type; public IntPtr pData; public uint Size; }

    [StructLayout(LayoutKind.Sequential)]
    struct CLOSEADAPTER { public uint hAdapter; }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct REGISTRYINFO
    {
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string AdapterString;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string BiosString;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string DacType;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string ChipType;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct SEGMENTSIZEINFO { public ulong DedicatedVideo; public ulong DedicatedSystem; public ulong SharedSystem; }

    [StructLayout(LayoutKind.Sequential)]
    struct PERFDATA
    {
        public uint PhysicalAdapterIndex;
        public ulong MemoryFrequency;
        public ulong MaxMemoryFrequency;
        public ulong MaxMemoryFrequencyOC;
        public ulong MemoryBandwidth;
        public ulong PCIEBandwidth;
        public uint FanRPM;
        public uint Power;
        public uint Temperature;
        public byte PowerStateOverride;
    }

    [DllImport("gdi32.dll")] static extern int D3DKMTEnumAdapters2(ref ENUMADAPTERS2 p);
    [DllImport("gdi32.dll")] static extern int D3DKMTEnumAdapters3(ref ENUMADAPTERS3 p);
    [DllImport("gdi32.dll")] static extern int D3DKMTQueryAdapterInfo(ref QUERYADAPTERINFO p);
    [DllImport("gdi32.dll")] static extern int D3DKMTCloseAdapter(ref CLOSEADAPTER p);

    const int QAI_SEGMENTSIZE = 3;
    const int QAI_REGISTRYINFO = 8;
    const int QAI_ADAPTERTYPE = 15;
    const int QAI_PERFDATA = 62;

    class Adapter
    {
        public uint Handle;
        public string Key;
        public string Name = "";
        public bool Npu;
        public bool Software;
        public ulong Dedicated;
        public ulong Shared;
    }

    static readonly Dictionary<string, Adapter> adapters = new Dictionary<string, Adapter>();

    static string LuidKey(LUID l) { return string.Format("0x{0:X8}_0x{1:X8}", (uint)l.High, l.Low); }

    static bool Query<T>(uint h, int type, ref T data) where T : struct
    {
        int size = Marshal.SizeOf(typeof(T));
        IntPtr buf = Marshal.AllocHGlobal(size);
        try
        {
            Marshal.StructureToPtr(data, buf, false);
            var q = new QUERYADAPTERINFO { hAdapter = h, Type = type, pData = buf, Size = (uint)size };
            if (D3DKMTQueryAdapterInfo(ref q) != 0) return false;
            data = (T)Marshal.PtrToStructure(buf, typeof(T));
            return true;
        }
        finally { Marshal.FreeHGlobal(buf); }
    }

    static ADAPTERINFO[] Enumerate()
    {
        int sz = Marshal.SizeOf(typeof(ADAPTERINFO));
        // 先试 EnumAdapters3（能列出 NPU 这类只做计算的设备），老系统退回 EnumAdapters2
        try
        {
            var e3 = new ENUMADAPTERS3 { Filter = 1 };
            if (D3DKMTEnumAdapters3(ref e3) == 0 && e3.NumAdapters > 0)
            {
                IntPtr buf = Marshal.AllocHGlobal(sz * (int)e3.NumAdapters);
                try
                {
                    e3.pAdapters = buf;
                    if (D3DKMTEnumAdapters3(ref e3) == 0) return Read(buf, (int)e3.NumAdapters, sz);
                }
                finally { Marshal.FreeHGlobal(buf); }
            }
        }
        catch (EntryPointNotFoundException) { }
        var e2 = new ENUMADAPTERS2();
        if (D3DKMTEnumAdapters2(ref e2) != 0 || e2.NumAdapters == 0) return new ADAPTERINFO[0];
        IntPtr b2 = Marshal.AllocHGlobal(sz * (int)e2.NumAdapters);
        try
        {
            e2.pAdapters = b2;
            if (D3DKMTEnumAdapters2(ref e2) != 0) return new ADAPTERINFO[0];
            return Read(b2, (int)e2.NumAdapters, sz);
        }
        finally { Marshal.FreeHGlobal(b2); }
    }

    static ADAPTERINFO[] Read(IntPtr buf, int n, int sz)
    {
        var r = new ADAPTERINFO[n];
        for (int i = 0; i < n; i++) r[i] = (ADAPTERINFO)Marshal.PtrToStructure(new IntPtr(buf.ToInt64() + i * sz), typeof(ADAPTERINFO));
        return r;
    }

    static void LoadAdapters()
    {
        foreach (var a in Enumerate())
        {
            var key = LuidKey(a.Luid);
            if (adapters.ContainsKey(key)) { var c = new CLOSEADAPTER { hAdapter = a.hAdapter }; D3DKMTCloseAdapter(ref c); continue; }
            var ad = new Adapter { Handle = a.hAdapter, Key = key };
            var reg = new REGISTRYINFO();
            if (Query(a.hAdapter, QAI_REGISTRYINFO, ref reg)) ad.Name = (reg.AdapterString ?? "").Trim();
            uint type = 0;
            if (Query(a.hAdapter, QAI_ADAPTERTYPE, ref type))
            {
                ad.Software = (type & (1u << 2)) != 0;
                ad.Npu = (type & (1u << 11)) != 0;
            }
            var seg = new SEGMENTSIZEINFO();
            if (Query(a.hAdapter, QAI_SEGMENTSIZE, ref seg)) { ad.Dedicated = seg.DedicatedVideo; ad.Shared = seg.SharedSystem; }
            adapters[key] = ad;
        }
        // 只做计算的设备（NPU）查不到注册表名称，用“计算加速器”设备类里的驱动描述补上
        var unnamed = new List<Adapter>();
        foreach (var ad in adapters.Values) if (ad.Npu && ad.Name.Length == 0) unnamed.Add(ad);
        if (unnamed.Count == 0) return;
        var names = new List<string>();
        try
        {
            using (var cls = Microsoft.Win32.Registry.LocalMachine.OpenSubKey(@"SYSTEM\CurrentControlSet\Control\Class\{f01a9d53-3ff6-48d2-9f97-c8a7004be10c}"))
            {
                if (cls != null)
                    foreach (var sub in cls.GetSubKeyNames())
                        using (var k = cls.OpenSubKey(sub))
                        {
                            var d = k == null ? null : k.GetValue("DriverDesc") as string;
                            if (!string.IsNullOrEmpty(d)) names.Add(d);
                        }
            }
        }
        catch (Exception) { }
        for (int i = 0; i < unnamed.Count; i++)
            unnamed[i].Name = names.Count == unnamed.Count ? names[i] : names.Count > 0 ? string.Join(" / ", names.ToArray()) : "NPU";
    }

    // ---------------- 性能计数器 ----------------

    static Dictionary<string, CounterSample> prev = new Dictionary<string, CounterSample>();
    static Dictionary<string, CounterSample> cur = new Dictionary<string, CounterSample>();

    static void ReadCategory(string category, string[] counters, Dictionary<string, Dictionary<string, double>> raw, bool rate)
    {
        try
        {
            var cat = new PerformanceCounterCategory(category);
            var all = cat.ReadCategory();
            foreach (var cn in counters)
            {
                if (!all.Contains(cn)) continue;
                var coll = all[cn];
                var m = new Dictionary<string, double>();
                foreach (InstanceData d in coll.Values)
                {
                    string id = category + "|" + cn + "|" + d.InstanceName;
                    var s = d.Sample;
                    cur[id] = s;
                    if (!rate) { m[d.InstanceName] = s.RawValue; continue; }
                    CounterSample p;
                    if (prev.TryGetValue(id, out p)) m[d.InstanceName] = CounterSample.Calculate(p, s);
                }
                raw[category + "|" + cn] = m;
            }
        }
        catch (Exception) { }
    }

    static double Get(Dictionary<string, Dictionary<string, double>> raw, string key, string inst)
    {
        Dictionary<string, double> m;
        double v;
        if (!raw.TryGetValue(key, out m)) return -1;
        if (m.TryGetValue(inst, out v)) return v;
        // 单实例的类别（System、Memory）实例名是一串内部占位符，直接取唯一的那个值
        if (inst == "" && m.Count == 1) foreach (var x in m.Values) return x;
        return -1;
    }

    static readonly StringBuilder sb = new StringBuilder();
    static void Num(string k, double v) { sb.Append('"').Append(k).Append("\":").Append(double.IsNaN(v) || double.IsInfinity(v) ? "null" : v.ToString("0.###", CultureInfo.InvariantCulture)).Append(','); }
    static void Str(string k, string v)
    {
        sb.Append('"').Append(k).Append("\":\"");
        foreach (char ch in v ?? "")
        {
            if (ch == '"' || ch == '\\') sb.Append('\\').Append(ch);
            else if (ch < 0x20) sb.Append(' ');
            else sb.Append(ch);
        }
        sb.Append("\",");
    }
    static void EndObj() { if (sb[sb.Length - 1] == ',') sb.Length--; }

    static void Sample()
    {
        var raw = new Dictionary<string, Dictionary<string, double>>();
        cur = new Dictionary<string, CounterSample>();
        ReadCategory("GPU Engine", new[] { "Utilization Percentage" }, raw, true);
        ReadCategory("GPU Adapter Memory", new[] { "Dedicated Usage", "Shared Usage" }, raw, false);
        ReadCategory("Processor Information", new[] { "% Processor Utility", "% Processor Performance" }, raw, true);
        ReadCategory("Memory", new[] { "Committed Bytes", "Commit Limit", "Cache Bytes", "Pool Paged Bytes", "Pool Nonpaged Bytes", "Standby Cache Normal Priority Bytes", "Standby Cache Reserve Bytes", "Standby Cache Core Bytes", "Modified Page List Bytes" }, raw, false);
        ReadCategory("Paging File", new[] { "% Usage" }, raw, true);
        ReadCategory("System", new[] { "Processes", "Threads", "System Up Time" }, raw, false);
        ReadCategory("Process", new[] { "Handle Count" }, raw, false);
        ReadCategory("PhysicalDisk", new[] { "% Idle Time", "Disk Read Bytes/sec", "Disk Write Bytes/sec" }, raw, true);
        ReadCategory("Network Interface", new[] { "Bytes Received/sec", "Bytes Sent/sec", "Current Bandwidth" }, raw, true);
        ReadCategory("Thermal Zone Information", new[] { "Temperature" }, raw, false);
        prev = cur;

        sb.Length = 0;
        sb.Append('{');
        Num("t", (DateTime.UtcNow - new DateTime(1970, 1, 1)).TotalMilliseconds);

        // CPU
        sb.Append("\"cpu\":{");
        Num("utility", Get(raw, "Processor Information|% Processor Utility", "_Total"));
        Num("perf", Get(raw, "Processor Information|% Processor Performance", "_Total"));
        Num("processes", Get(raw, "System|Processes", ""));
        Num("threads", Get(raw, "System|Threads", ""));
        Num("handles", Get(raw, "Process|Handle Count", "_Total"));
        double temp = -1;
        Dictionary<string, double> tz;
        if (raw.TryGetValue("Thermal Zone Information|Temperature", out tz))
            foreach (var v in tz.Values) if (v > 200 && v - 273.15 > temp) temp = v - 273.15;
        Num("temp", temp);
        EndObj();
        sb.Append("},");

        // 内存
        sb.Append("\"mem\":{");
        Num("committed", Get(raw, "Memory|Committed Bytes", ""));
        Num("commitLimit", Get(raw, "Memory|Commit Limit", ""));
        double standby = 0;
        foreach (var k in new[] { "Standby Cache Normal Priority Bytes", "Standby Cache Reserve Bytes", "Standby Cache Core Bytes" })
        {
            double v = Get(raw, "Memory|" + k, "");
            if (v > 0) standby += v;
        }
        Num("standby", standby);
        Num("modified", Get(raw, "Memory|Modified Page List Bytes", ""));
        Num("paged", Get(raw, "Memory|Pool Paged Bytes", ""));
        Num("nonpaged", Get(raw, "Memory|Pool Nonpaged Bytes", ""));
        Num("pagefile", Get(raw, "Paging File|% Usage", "_Total"));
        EndObj();
        sb.Append("},");

        // 显卡与 NPU：按 luid 汇总各引擎的占用（同类引擎相加，取最忙的一类作为总占用，和任务管理器一致）
        var engines = new Dictionary<string, Dictionary<string, double>>();
        Dictionary<string, double> util;
        if (raw.TryGetValue("GPU Engine|Utilization Percentage", out util))
        {
            foreach (var kv in util)
            {
                string n = kv.Key;
                int li = n.IndexOf("luid_");
                int pi = n.IndexOf("_phys_");
                int ei = n.IndexOf("engtype_");
                if (li < 0 || pi < 0 || ei < 0) continue;
                string key = n.Substring(li + 5, pi - li - 5).ToUpperInvariant().Replace("0X", "0x");
                string eng = n.Substring(ei + 8);
                if (eng.Length == 0) continue;
                Dictionary<string, double> m;
                if (!engines.TryGetValue(key, out m)) engines[key] = m = new Dictionary<string, double>();
                double old;
                m.TryGetValue(eng, out old);
                m[eng] = old + kv.Value;
            }
        }
        var dedi = new Dictionary<string, double>();
        var shar = new Dictionary<string, double>();
        foreach (var pair in new[] { new KeyValuePair<string, Dictionary<string, double>>("Dedicated Usage", dedi), new KeyValuePair<string, Dictionary<string, double>>("Shared Usage", shar) })
        {
            Dictionary<string, double> m;
            if (!raw.TryGetValue("GPU Adapter Memory|" + pair.Key, out m)) continue;
            foreach (var kv in m)
            {
                int li = kv.Key.IndexOf("luid_");
                int pi = kv.Key.IndexOf("_phys_");
                if (li < 0) continue;
                string key = (pi > li ? kv.Key.Substring(li + 5, pi - li - 5) : kv.Key.Substring(li + 5)).ToUpperInvariant().Replace("0X", "0x");
                double old;
                pair.Value.TryGetValue(key, out old);
                pair.Value[key] = old + kv.Value;
            }
        }

        sb.Append("\"gpus\":[");
        foreach (var ad in adapters.Values)
        {
            if (ad.Software) continue;
            sb.Append('{');
            Str("id", ad.Key);
            Str("name", ad.Name);
            sb.Append("\"npu\":").Append(ad.Npu ? "true" : "false").Append(',');
            Num("dedicatedTotal", ad.Dedicated);
            Num("sharedTotal", ad.Shared);
            double d, s;
            Num("dedicatedUsed", dedi.TryGetValue(ad.Key, out d) ? d : -1);
            Num("sharedUsed", shar.TryGetValue(ad.Key, out s) ? s : -1);
            var perf = new PERFDATA();
            if (!ad.Npu && Query(ad.Handle, QAI_PERFDATA, ref perf))
            {
                Num("temp", perf.Temperature > 0 ? perf.Temperature / 10.0 : -1);
                Num("fan", perf.FanRPM > 0 ? (double)perf.FanRPM : -1);
                Num("power", perf.Power > 0 ? perf.Power / 10.0 : -1);
            }
            sb.Append("\"engines\":{");
            Dictionary<string, double> em;
            if (engines.TryGetValue(ad.Key, out em))
                foreach (var kv in em) Num(kv.Key, Math.Min(100, kv.Value));
            EndObj();
            sb.Append("}},");
        }
        EndObj();
        sb.Append("],");

        // 磁盘
        sb.Append("\"disks\":[");
        Dictionary<string, double> idle;
        if (raw.TryGetValue("PhysicalDisk|% Idle Time", out idle))
        {
            foreach (var kv in idle)
            {
                if (kv.Key == "_Total") continue;
                sb.Append('{');
                Str("name", kv.Key);
                Num("active", Math.Max(0, Math.Min(100, 100 - kv.Value)));
                Num("read", Get(raw, "PhysicalDisk|Disk Read Bytes/sec", kv.Key));
                Num("write", Get(raw, "PhysicalDisk|Disk Write Bytes/sec", kv.Key));
                EndObj();
                sb.Append("},");
            }
        }
        EndObj();
        sb.Append("],");

        // 网络
        sb.Append("\"nets\":[");
        Dictionary<string, double> rx;
        if (raw.TryGetValue("Network Interface|Bytes Received/sec", out rx))
        {
            foreach (var kv in rx)
            {
                sb.Append('{');
                Str("name", kv.Key);
                Num("rx", kv.Value);
                Num("tx", Get(raw, "Network Interface|Bytes Sent/sec", kv.Key));
                Num("bandwidth", Get(raw, "Network Interface|Current Bandwidth", kv.Key));
                EndObj();
                sb.Append("},");
            }
        }
        EndObj();
        sb.Append(']');

        sb.Append('}');
        Console.Out.WriteLine(sb.ToString());
        Console.Out.Flush();
    }

    public static void Run(int intervalMs)
    {
        Console.OutputEncoding = new UTF8Encoding(false);
        // 父进程（IDE）退出时标准输入会关闭，随之退出，避免留下孤儿进程
        var watcher = new Thread(() => { try { while (Console.In.ReadLine() != null) { } } catch (Exception) { } Environment.Exit(0); });
        watcher.IsBackground = true;
        watcher.Start();
        try { LoadAdapters(); } catch (Exception) { }
        Sample();
        int tick = 0;
        while (true)
        {
            Thread.Sleep(intervalMs);
            // 显卡热插拔（外接显卡坞、驱动重装）时重新枚举
            if (++tick % 30 == 0) { try { LoadAdapters(); } catch (Exception) { } }
            try { Sample(); } catch (Exception) { }
        }
    }
}
