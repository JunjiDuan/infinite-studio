// Infinite Studio 安装 / 卸载程序
//
// 用 Windows 自带的 .NET Framework 4.8 编译（C# 5），不依赖任何运行库，界面是自绘的 WPF：
//   - 定义 SETUP 时编译成安装程序：内嵌 payload.zip（应用文件）和 uninstall.exe；
//   - 不定义时编译成卸载程序，安装时放进安装目录。
// 按用户安装到 %LOCALAPPDATA%\Programs\Infinite Studio，不需要管理员权限。
// 覆盖安装：检测到已安装的版本时装回原目录，个人设置（%APPDATA%\Infinite Studio）始终保留。
//
// 命令行：/S 静默安装或卸载；/D=路径 指定安装目录（静默安装时）

#pragma warning disable 0219 // 两个编译变体各自只用到一部分命令行参数
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
using System.Text;
using System.Threading;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Markup;
using System.Windows.Media;
using System.Windows.Media.Animation;
using System.Windows.Shapes;
using Microsoft.Win32;
using Path = System.Windows.Shapes.Path;

[assembly: AssemblyTitle("Infinite Studio Setup")]
[assembly: AssemblyProduct("Infinite Studio")]
[assembly: AssemblyCompany(BuildInfo.Publisher)]
[assembly: AssemblyCopyright(BuildInfo.Copyright)]
[assembly: AssemblyVersion(BuildInfo.Version + ".0")]
[assembly: AssemblyFileVersion(BuildInfo.Version + ".0")]

namespace InfiniteSetup
{
    static class L
    {
        public static readonly bool Zh = CultureInfo.CurrentUICulture.Name.StartsWith("zh", StringComparison.OrdinalIgnoreCase);
        public static string T(string zh, string en) { return Zh ? zh : en; }
    }

    static class Product
    {
        public const string Name = "Infinite Studio";
        public const string Exe = "Infinite Studio.exe";
        public const string Uninstaller = "Uninstall Infinite Studio.exe";
        public const string UninstallKey = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\InfiniteStudio";
        public const string UninstallRoot = @"Software\Microsoft\Windows\CurrentVersion\Uninstall";

        public static string DefaultDir
        {
            get { return System.IO.Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", Name); }
        }
        /** Electron 的 userData：%APPDATA%\Infinite Studio */
        public static string DataDir
        {
            get { return System.IO.Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), Name); }
        }
        /**
         * 为所有用户安装（装在用户目录以外，例如 Program Files）：快捷方式放公共位置、注册表写 HKLM，需要管理员权限。
         * 旧版 NSIS 安装程序“为所有用户安装”的版本就在这里，覆盖安装时沿用。
         */
        public static bool Machine;

        public static bool IsMachineDir(string dir)
        {
            string profile = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
            return !Engine.Normalize(dir).StartsWith(Engine.Normalize(profile), StringComparison.OrdinalIgnoreCase);
        }

        public static bool IsElevated
        {
            get
            {
                try { return new System.Security.Principal.WindowsPrincipal(System.Security.Principal.WindowsIdentity.GetCurrent()).IsInRole(System.Security.Principal.WindowsBuiltInRole.Administrator); }
                catch { return false; }
            }
        }

        public static RegistryKey Hive { get { return Machine ? Registry.LocalMachine : Registry.CurrentUser; } }

        public static string StartMenuLink
        {
            get { return System.IO.Path.Combine(Environment.GetFolderPath(Machine ? Environment.SpecialFolder.CommonPrograms : Environment.SpecialFolder.Programs), Name + ".lnk"); }
        }
        public static string DesktopLink
        {
            get { return System.IO.Path.Combine(Environment.GetFolderPath(Machine ? Environment.SpecialFolder.CommonDesktopDirectory : Environment.SpecialFolder.DesktopDirectory), Name + ".lnk"); }
        }
    }

    /** 已安装的版本（自己的注册表项，或旧版 NSIS 安装程序写的项；当前用户和所有用户都找） */
    class Installed
    {
        public string Dir;
        public string Version;
        public bool Machine;
        /** 指向这个目录的所有卸载项：(是否 HKLM, 键名) */
        public List<KeyValuePair<bool, string>> Keys = new List<KeyValuePair<bool, string>>();

        public static Installed Find(string onlyDir = null)
        {
            Installed found = null;
            foreach (bool machine in new[] { false, true })
            {
                RegistryKey hive = machine ? Registry.LocalMachine : Registry.CurrentUser;
                using (RegistryKey root = hive.OpenSubKey(Product.UninstallRoot))
                {
                    if (root == null) continue;
                    foreach (string name in root.GetSubKeyNames())
                    {
                        using (RegistryKey k = root.OpenSubKey(name))
                        {
                            if (k == null) continue;
                            string display = k.GetValue("DisplayName") as string ?? "";
                            if (name != "InfiniteStudio" && !display.StartsWith(Product.Name, StringComparison.OrdinalIgnoreCase)) continue;
                            string dir = k.GetValue("InstallLocation") as string;
                            if (string.IsNullOrEmpty(dir)) dir = DirFromCommand(k.GetValue("UninstallString") as string);
                            if (string.IsNullOrEmpty(dir)) dir = DirFromCommand(k.GetValue("DisplayIcon") as string);
                            if (string.IsNullOrEmpty(dir)) continue;
                            dir = dir.TrimEnd('\\');
                            if (onlyDir != null && Engine.Normalize(dir) != Engine.Normalize(onlyDir)) continue;
                            if (found == null) found = new Installed { Dir = dir, Version = k.GetValue("DisplayVersion") as string ?? "", Machine = machine };
                            if (Engine.Normalize(found.Dir) == Engine.Normalize(dir)) found.Keys.Add(new KeyValuePair<bool, string>(machine, name));
                        }
                    }
                }
            }
            return found;
        }

        /** 删除指向 dir 的旧卸载项（没有权限的跳过） */
        public static void RemoveKeys(string dir, bool keepOwn)
        {
            Installed other = Find(dir);
            if (other == null) return;
            foreach (KeyValuePair<bool, string> k in other.Keys)
            {
                if (keepOwn && k.Value == "InfiniteStudio" && k.Key == Product.Machine) continue;
                try { (k.Key ? Registry.LocalMachine : Registry.CurrentUser).DeleteSubKeyTree(Product.UninstallRoot + "\\" + k.Value, false); } catch { }
            }
        }

        static string DirFromCommand(string cmd)
        {
            if (string.IsNullOrEmpty(cmd)) return null;
            cmd = cmd.Trim();
            string exe;
            if (cmd.StartsWith("\"")) exe = cmd.Substring(1, Math.Max(0, cmd.IndexOf('"', 1) - 1));
            else
            {
                int i = cmd.IndexOf(".exe", StringComparison.OrdinalIgnoreCase);
                exe = i > 0 ? cmd.Substring(0, i + 4) : cmd;
            }
            int comma = exe.LastIndexOf(',');
            if (comma > exe.LastIndexOf('\\')) exe = exe.Substring(0, comma);
            try { return System.IO.Path.GetDirectoryName(exe); } catch { return null; }
        }
    }

    static class Engine
    {
        public delegate void Progress(double fraction, string detail);

        /** 正在运行的、位于 dir 里的程序进程 */
        public static List<Process> Running(string dir)
        {
            List<Process> list = new List<Process>();
            string full = Normalize(dir);
            foreach (Process p in Process.GetProcessesByName(System.IO.Path.GetFileNameWithoutExtension(Product.Exe)))
            {
                try
                {
                    string exe = p.MainModule.FileName;
                    if (Normalize(System.IO.Path.GetDirectoryName(exe)).StartsWith(full, StringComparison.OrdinalIgnoreCase)) list.Add(p);
                }
                catch { list.Add(p); }
            }
            return list;
        }

        public static void Kill(List<Process> procs)
        {
            foreach (Process p in procs)
            {
                try { p.Kill(); p.WaitForExit(5000); } catch { }
            }
            Thread.Sleep(300);
        }

        public static string Normalize(string p)
        {
            try { return System.IO.Path.GetFullPath(p).TrimEnd('\\') + "\\"; } catch { return p; }
        }

        /** 目录里是不是一个已安装的 Infinite Studio（防止误删用户文件） */
        public static bool LooksInstalled(string dir)
        {
            return File.Exists(System.IO.Path.Combine(dir, Product.Exe)) && Directory.Exists(System.IO.Path.Combine(dir, "resources"));
        }

        /**
         * 选中的目录不是空的、也不是已安装的目录时，装到它下面的 Infinite Studio 子目录，
         * 避免把用户自己的文件夹当成程序目录（卸载时会整个删掉）
         */
        public static string ResolveTarget(string dir)
        {
            dir = dir.Trim().TrimEnd('\\');
            if (dir.Length <= 3) return System.IO.Path.Combine(dir + "\\", Product.Name);
            if (!Directory.Exists(dir) || LooksInstalled(dir)) return dir;
            if (Directory.GetFileSystemEntries(dir).Length == 0) return dir;
            return System.IO.Path.Combine(dir, Product.Name);
        }

#if SETUP
        public static void Install(string dir, bool desktop, Progress progress, Installed previous)
        {
            Assembly asm = Assembly.GetExecutingAssembly();
            Directory.CreateDirectory(dir);

            // 覆盖安装：先清掉旧的程序文件（只在确认是本程序的目录时）
            if (LooksInstalled(dir))
            {
                progress(0, L.T("正在移除旧版本文件…", "Removing previous version…"));
                foreach (string sub in new[] { "resources", "locales" })
                {
                    string p = System.IO.Path.Combine(dir, sub);
                    if (Directory.Exists(p)) DeleteDir(p);
                }
            }

            using (Stream s = asm.GetManifestResourceStream("payload.zip"))
            using (ZipArchive zip = new ZipArchive(s, ZipArchiveMode.Read))
            {
                long total = 0;
                foreach (ZipArchiveEntry e in zip.Entries) total += e.Length;
                long done = 0;
                byte[] buf = new byte[1 << 16];
                string root = Normalize(dir);
                foreach (ZipArchiveEntry e in zip.Entries)
                {
                    string name = e.FullName.Replace('/', '\\');
                    while (name.StartsWith(".\\")) name = name.Substring(2);
                    name = name.TrimStart('\\');
                    if (name.Length == 0) continue;
                    string target = System.IO.Path.GetFullPath(System.IO.Path.Combine(dir, name));
                    if (!target.StartsWith(root, StringComparison.OrdinalIgnoreCase)) continue;
                    if (name.EndsWith("\\")) { Directory.CreateDirectory(target); continue; }
                    Directory.CreateDirectory(System.IO.Path.GetDirectoryName(target));
                    progress(total > 0 ? (double)done / total * 0.96 : 0, name);
                    WriteWithRetry(target, e, buf, ref done, total, progress, name);
                }
            }

            progress(0.97, L.T("正在写入卸载程序…", "Writing uninstaller…"));
            using (Stream u = asm.GetManifestResourceStream("uninstall.exe"))
            using (FileStream f = File.Create(System.IO.Path.Combine(dir, Product.Uninstaller)))
                u.CopyTo(f);

            progress(0.98, L.T("正在创建快捷方式…", "Creating shortcuts…"));
            string exe = System.IO.Path.Combine(dir, Product.Exe);
            Directory.CreateDirectory(System.IO.Path.GetDirectoryName(Product.StartMenuLink));
            Shortcut.Create(Product.StartMenuLink, exe, dir);
            if (desktop) Shortcut.Create(Product.DesktopLink, exe, dir);
            else if (File.Exists(Product.DesktopLink)) try { File.Delete(Product.DesktopLink); } catch { }

            progress(0.99, L.T("正在注册程序…", "Registering…"));
            // 旧版安装程序（NSIS）留下的、指向同一个目录的卸载项删掉，只保留一个“Infinite Studio”
            Installed.RemoveKeys(dir, true);
            using (RegistryKey k = Product.Hive.CreateSubKey(Product.UninstallKey))
            {
                string un = System.IO.Path.Combine(dir, Product.Uninstaller);
                k.SetValue("DisplayName", Product.Name);
                k.SetValue("DisplayVersion", BuildInfo.Version);
                k.SetValue("Publisher", BuildInfo.Publisher);
                k.SetValue("DisplayIcon", exe + ",0");
                k.SetValue("InstallLocation", dir);
                k.SetValue("UninstallString", "\"" + un + "\"");
                k.SetValue("QuietUninstallString", "\"" + un + "\" /S");
                k.SetValue("URLInfoAbout", BuildInfo.Homepage);
                k.SetValue("InstallDate", DateTime.Now.ToString("yyyyMMdd"));
                k.SetValue("EstimatedSize", (int)BuildInfo.SizeKB, RegistryValueKind.DWord);
                k.SetValue("NoModify", 1, RegistryValueKind.DWord);
                k.SetValue("NoRepair", 1, RegistryValueKind.DWord);
            }
            Shortcut.NotifyShell();
            progress(1, "");
        }

        static void WriteWithRetry(string target, ZipArchiveEntry e, byte[] buf, ref long done, long total, Progress progress, string name)
        {
            for (int attempt = 0; ; attempt++)
            {
                long before = done;
                try
                {
                    using (Stream src = e.Open())
                    using (FileStream dst = new FileStream(target, FileMode.Create, FileAccess.Write, FileShare.None))
                    {
                        int n;
                        long sinceReport = 0;
                        while ((n = src.Read(buf, 0, buf.Length)) > 0)
                        {
                            dst.Write(buf, 0, n);
                            done += n;
                            sinceReport += n;
                            if (sinceReport > (4 << 20))
                            {
                                sinceReport = 0;
                                progress(total > 0 ? (double)done / total * 0.96 : 0, name);
                            }
                        }
                    }
                    return;
                }
                catch (IOException)
                {
                    // 文件被占用（杀毒软件扫描等），稍等重试
                    done = before;
                    if (attempt >= 8) throw;
                    Thread.Sleep(400);
                }
            }
        }
#endif

        public static void Uninstall(string dir, bool removeData, Progress progress)
        {
            progress(0.05, L.T("正在删除快捷方式…", "Removing shortcuts…"));
            string exe = System.IO.Path.Combine(dir, Product.Exe);
            foreach (string link in new[] { Product.StartMenuLink, Product.DesktopLink })
                try { if (File.Exists(link)) File.Delete(link); } catch { }

            progress(0.15, L.T("正在删除程序文件…", "Removing program files…"));
            if (Directory.Exists(dir))
            {
                string[] files = Directory.GetFiles(dir, "*", SearchOption.AllDirectories);
                for (int i = 0; i < files.Length; i++)
                {
                    try { File.SetAttributes(files[i], FileAttributes.Normal); File.Delete(files[i]); } catch { }
                    if (i % 20 == 0) progress(0.15 + 0.7 * i / Math.Max(1, files.Length), files[i].Substring(Math.Min(files[i].Length, dir.Length + 1)));
                }
                DeleteDir(dir);
            }

            if (removeData)
            {
                progress(0.9, L.T("正在删除个人设置与数据…", "Removing settings and data…"));
                if (Directory.Exists(Product.DataDir)) DeleteDir(Product.DataDir);
            }

            progress(0.97, L.T("正在清理注册表…", "Cleaning up registry…"));
            Installed.RemoveKeys(dir, false);
            Shortcut.NotifyShell();
            progress(1, "");
        }

        public static void DeleteDir(string dir)
        {
            for (int attempt = 0; attempt < 6; attempt++)
            {
                try
                {
                    if (!Directory.Exists(dir)) return;
                    foreach (string f in Directory.GetFiles(dir, "*", SearchOption.AllDirectories))
                        try { File.SetAttributes(f, FileAttributes.Normal); } catch { }
                    Directory.Delete(dir, true);
                    return;
                }
                catch
                {
                    Thread.Sleep(300);
                }
            }
        }

        /** 可用空间（字节）；拿不到时返回 -1 */
        public static long FreeSpace(string dir)
        {
            try
            {
                string root = System.IO.Path.GetPathRoot(System.IO.Path.GetFullPath(dir));
                return new DriveInfo(root).AvailableFreeSpace;
            }
            catch { return -1; }
        }
    }

    /* ---------------- 快捷方式（带 AppUserModelID，任务栏图标才能和运行中的窗口合并） ---------------- */

    static class Shortcut
    {
        [ComImport, Guid("000214F9-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        interface IShellLinkW
        {
            void GetPath([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszFile, int cch, IntPtr pfd, int fFlags);
            void GetIDList(out IntPtr ppidl);
            void SetIDList(IntPtr pidl);
            void GetDescription([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszName, int cch);
            void SetDescription([MarshalAs(UnmanagedType.LPWStr)] string pszName);
            void GetWorkingDirectory([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszDir, int cch);
            void SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] string pszDir);
            void GetArguments([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszArgs, int cch);
            void SetArguments([MarshalAs(UnmanagedType.LPWStr)] string pszArgs);
            void GetHotkey(out short pwHotkey);
            void SetHotkey(short wHotkey);
            void GetShowCmd(out int piShowCmd);
            void SetShowCmd(int iShowCmd);
            void GetIconLocation([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszIconPath, int cch, out int piIcon);
            void SetIconLocation([MarshalAs(UnmanagedType.LPWStr)] string pszIconPath, int iIcon);
            void SetRelativePath([MarshalAs(UnmanagedType.LPWStr)] string pszPathRel, int dwReserved);
            void Resolve(IntPtr hwnd, int fFlags);
            void SetPath([MarshalAs(UnmanagedType.LPWStr)] string pszFile);
        }

        [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        interface IPropertyStore
        {
            void GetCount(out uint cProps);
            void GetAt(uint iProp, out PropertyKey pkey);
            void GetValue(ref PropertyKey key, IntPtr pv);
            void SetValue(ref PropertyKey key, ref PropVariant pv);
            void Commit();
        }

        [StructLayout(LayoutKind.Sequential, Pack = 4)]
        struct PropertyKey
        {
            public Guid fmtid;
            public uint pid;
        }

        [StructLayout(LayoutKind.Explicit)]
        struct PropVariant
        {
            [FieldOffset(0)] public ushort vt;
            [FieldOffset(8)] public IntPtr p;
        }

        [ComImport, Guid("00021401-0000-0000-C000-000000000046")]
        class CShellLink { }

        [DllImport("shell32.dll")]
        static extern void SHChangeNotify(int wEventId, int uFlags, IntPtr dwItem1, IntPtr dwItem2);

        public static void Create(string lnk, string target, string workDir)
        {
            IShellLinkW link = (IShellLinkW)new CShellLink();
            link.SetPath(target);
            link.SetWorkingDirectory(workDir);
            link.SetIconLocation(target, 0);
            link.SetDescription(L.T("Infinite Studio · 无界工作室", "Infinite Studio"));
            IPropertyStore store = (IPropertyStore)link;
            PropertyKey key = new PropertyKey { fmtid = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"), pid = 5 };
            PropVariant v = new PropVariant { vt = 31 /* VT_LPWSTR */, p = Marshal.StringToCoTaskMemUni(BuildInfo.AppId) };
            try
            {
                store.SetValue(ref key, ref v);
                store.Commit();
            }
            finally
            {
                Marshal.FreeCoTaskMem(v.p);
            }
            ((IPersistFile)link).Save(lnk, true);
            Marshal.ReleaseComObject(link);
        }

        public static void NotifyShell()
        {
            try { SHChangeNotify(0x08000000 /* SHCNE_ASSOCCHANGED */, 0, IntPtr.Zero, IntPtr.Zero); } catch { }
        }
    }

    /* ---------------- 现代样式的选择文件夹对话框 ---------------- */

    static class FolderPicker
    {
        [ComImport, Guid("DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7")]
        class FileOpenDialogRCW { }

        [ComImport, Guid("42f85136-db7e-439c-85f1-e4075d135fc8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        interface IFileOpenDialog
        {
            [PreserveSig] int Show(IntPtr parent);
            void SetFileTypes();
            void SetFileTypeIndex();
            void GetFileTypeIndex();
            void Advise();
            void Unadvise();
            void SetOptions(uint fos);
            void GetOptions(out uint fos);
            void SetDefaultFolder(IShellItem psi);
            void SetFolder(IShellItem psi);
            void GetFolder(out IShellItem ppsi);
            void GetCurrentSelection(out IShellItem ppsi);
            void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string pszName);
            void GetFileName();
            void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string pszTitle);
            void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string pszText);
            void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string pszLabel);
            void GetResult(out IShellItem ppsi);
        }

        [ComImport, Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        interface IShellItem
        {
            void BindToHandler();
            void GetParent();
            void GetDisplayName(uint sigdnName, [MarshalAs(UnmanagedType.LPWStr)] out string ppszName);
        }

        [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
        static extern void SHCreateItemFromParsingName([MarshalAs(UnmanagedType.LPWStr)] string pszPath, IntPtr pbc, [MarshalAs(UnmanagedType.LPStruct)] Guid riid, out IShellItem ppv);

        public static string Pick(IntPtr owner, string title, string initial)
        {
            IFileOpenDialog dlg = (IFileOpenDialog)new FileOpenDialogRCW();
            try
            {
                uint fos;
                dlg.GetOptions(out fos);
                dlg.SetOptions(fos | 0x20 /* PICKFOLDERS */ | 0x40 /* FORCEFILESYSTEM */ | 0x800 /* PATHMUSTEXIST */);
                dlg.SetTitle(title);
                string dir = initial;
                while (!string.IsNullOrEmpty(dir) && !Directory.Exists(dir)) dir = System.IO.Path.GetDirectoryName(dir);
                if (!string.IsNullOrEmpty(dir))
                {
                    try
                    {
                        IShellItem item;
                        SHCreateItemFromParsingName(dir, IntPtr.Zero, typeof(IShellItem).GUID, out item);
                        dlg.SetFolder(item);
                    }
                    catch { }
                }
                if (dlg.Show(owner) != 0) return null;
                IShellItem result;
                dlg.GetResult(out result);
                string path;
                result.GetDisplayName(0x80058000 /* SIGDN_FILESYSPATH */, out path);
                return path;
            }
            finally
            {
                Marshal.ReleaseComObject(dlg);
            }
        }
    }

    /* ---------------- 界面 ---------------- */

    class Ui
    {
        readonly Window w;
        readonly bool uninstall;
        readonly Installed previous;
        string dir;
        bool working;
        bool finished;
        Action onPrimary;
        Action onSecondary;

        T F<T>(string name) where T : class { return w.FindName(name) as T; }

        public Ui(bool uninstall, string installDir)
        {
            this.uninstall = uninstall;
            using (Stream s = Assembly.GetExecutingAssembly().GetManifestResourceStream("Setup.xaml"))
                w = (Window)XamlReader.Load(s);
            previous = Installed.Find();
            dir = installDir ?? (previous != null && Directory.Exists(previous.Dir) ? previous.Dir : Product.DefaultDir);

            w.Title = uninstall ? L.T("卸载 Infinite Studio", "Uninstall Infinite Studio") : L.T("安装 Infinite Studio", "Infinite Studio Setup");
            w.MouseLeftButtonDown += delegate (object sender, MouseButtonEventArgs e)
            {
                if (e.ButtonState == MouseButtonState.Pressed && !(e.OriginalSource is TextBox)) try { w.DragMove(); } catch { }
            };
            F<Button>("MinBtn").Click += delegate { w.WindowState = WindowState.Minimized; };
            F<Button>("CloseBtn").Click += delegate { TryClose(); };
            w.Closing += delegate (object sender, System.ComponentModel.CancelEventArgs e) { if (working) e.Cancel = true; };
            w.KeyDown += delegate (object sender, KeyEventArgs e) { if (e.Key == Key.Escape && !working) TryClose(); };
            F<Button>("PrimaryBtn").Click += delegate { if (onPrimary != null) onPrimary(); };
            F<Button>("SecondaryBtn").Click += delegate { if (onSecondary != null) onSecondary(); };
            F<Button>("BrowseBtn").Click += delegate { Browse(); };

            F<TextBlock>("Tagline").Text = L.T("无界工作室 · 极简、高度个性化的 IDE", "A minimal, deeply personal IDE");
            F<TextBlock>("VersionText").Text = "v" + BuildInfo.Version;
            F<TextBlock>("Copyright").Text = BuildInfo.Copyright;

            // 背景光晕裁剪成和外框一样的圆角
            Canvas glows = F<Canvas>("Glows");
            glows.SizeChanged += delegate { glows.Clip = new RectangleGeometry(new Rect(0, 0, glows.ActualWidth, glows.ActualHeight), 18, 18); };

            w.Loaded += delegate { Intro(); };
            if (uninstall) ShowUninstallWelcome();
            else ShowInstallWelcome();
        }

        public Window Window { get { return w; } }

        void TryClose()
        {
            if (working) return;
            w.Close();
        }

        /* ---------- 动画 ---------- */

        static readonly IEasingFunction Ease = new CubicEase { EasingMode = EasingMode.EaseOut };

        void Intro()
        {
            // 窗口淡入上浮
            FrameworkElement root = (FrameworkElement)w.Content;
            TranslateTransform tt = new TranslateTransform(0, 14);
            root.RenderTransform = tt;
            root.Opacity = 0;
            root.BeginAnimation(UIElement.OpacityProperty, new DoubleAnimation(0, 1, TimeSpan.FromMilliseconds(320)) { EasingFunction = Ease });
            tt.BeginAnimation(TranslateTransform.YProperty, new DoubleAnimation(14, 0, TimeSpan.FromMilliseconds(420)) { EasingFunction = Ease });

            // 无限符号：先画出来，然后流光一直绕着走
            Path inf = F<Path>("InfBase");
            inf.StrokeDashArray = new DoubleCollection(new double[] { 60, 60 });
            DoubleAnimation draw = new DoubleAnimation(60, 0, TimeSpan.FromMilliseconds(1400)) { EasingFunction = new CubicEase { EasingMode = EasingMode.EaseInOut } };
            draw.Completed += delegate { inf.StrokeDashArray = null; };
            inf.BeginAnimation(Shape.StrokeDashOffsetProperty, draw);

            Path shine = F<Path>("InfShine");
            shine.Opacity = 0;
            DoubleAnimation run = new DoubleAnimation(60, 0, TimeSpan.FromSeconds(3.2)) { RepeatBehavior = RepeatBehavior.Forever };
            shine.BeginAnimation(Shape.StrokeDashOffsetProperty, run);
            shine.BeginAnimation(UIElement.OpacityProperty, new DoubleAnimation(0, 0.85, TimeSpan.FromMilliseconds(600)) { BeginTime = TimeSpan.FromMilliseconds(1200) });

            // 背景光晕缓慢呼吸
            Breathe(F<Ellipse>("GlowA"), 7);
            Breathe(F<Ellipse>("GlowB"), 9);
        }

        static void Breathe(UIElement el, double seconds)
        {
            DoubleAnimation a = new DoubleAnimation(0.65, 1, TimeSpan.FromSeconds(seconds))
            {
                AutoReverse = true,
                RepeatBehavior = RepeatBehavior.Forever,
                EasingFunction = new SineEase { EasingMode = EasingMode.EaseInOut }
            };
            el.BeginAnimation(UIElement.OpacityProperty, a);
        }

        void ShowPage(string name)
        {
            foreach (string p in new[] { "PageWelcome", "PageProgress", "PageDone" })
            {
                FrameworkElement el = F<FrameworkElement>(p);
                el.Visibility = p == name ? Visibility.Visible : Visibility.Collapsed;
            }
            FrameworkElement page = F<FrameworkElement>(name);
            TranslateTransform tt = new TranslateTransform(18, 0);
            page.RenderTransform = tt;
            page.BeginAnimation(UIElement.OpacityProperty, new DoubleAnimation(0, 1, TimeSpan.FromMilliseconds(260)) { EasingFunction = Ease });
            tt.BeginAnimation(TranslateTransform.XProperty, new DoubleAnimation(18, 0, TimeSpan.FromMilliseconds(360)) { EasingFunction = Ease });
        }

        void SetButtons(string primary, Action p, string secondary, Action s)
        {
            Button pb = F<Button>("PrimaryBtn");
            Button sb = F<Button>("SecondaryBtn");
            pb.Content = primary;
            pb.Visibility = primary == null ? Visibility.Collapsed : Visibility.Visible;
            pb.IsEnabled = true;
            sb.Content = secondary;
            sb.Visibility = secondary == null ? Visibility.Collapsed : Visibility.Visible;
            onPrimary = p;
            onSecondary = s;
            if (primary != null) pb.Focus();
        }

        /** 浮层确认框 */
        void Confirm(string title, string text, string yes, string no, Action onYes)
        {
            Border overlay = F<Border>("Overlay");
            F<TextBlock>("OverlayTitle").Text = title;
            F<TextBlock>("OverlayText").Text = text;
            Button y = F<Button>("OverlayYes");
            Button n = F<Button>("OverlayNo");
            y.Content = yes;
            n.Content = no;
            RoutedEventHandler hy = null, hn = null;
            Action close = delegate
            {
                y.Click -= hy;
                n.Click -= hn;
                DoubleAnimation fade = new DoubleAnimation(1, 0, TimeSpan.FromMilliseconds(140));
                fade.Completed += delegate { overlay.Visibility = Visibility.Collapsed; };
                overlay.BeginAnimation(UIElement.OpacityProperty, fade);
            };
            hy = delegate { close(); onYes(); };
            hn = delegate { close(); };
            y.Click += hy;
            n.Click += hn;
            overlay.Visibility = Visibility.Visible;
            overlay.BeginAnimation(UIElement.OpacityProperty, new DoubleAnimation(0, 1, TimeSpan.FromMilliseconds(180)));
            y.Focus();
        }

        /* ---------- 安装 ---------- */

        void ShowInstallWelcome()
        {
            bool upgrade = previous != null && Directory.Exists(previous.Dir);
            F<TextBlock>("WelcomeTitle").Text = upgrade ? L.T("更新 Infinite Studio", "Update Infinite Studio") : L.T("安装 Infinite Studio", "Install Infinite Studio");
            F<TextBlock>("WelcomeText").Text = L.T(
                "为写代码的人准备的安静空间。选择安装位置，然后开始。",
                "A quiet place to write code. Choose where to install, then begin.");
            if (upgrade)
            {
                F<Border>("UpgradeNote").Visibility = Visibility.Visible;
                string from = string.IsNullOrEmpty(previous.Version) ? "" : " " + previous.Version;
                F<TextBlock>("UpgradeText").Text = L.T(
                    "检测到已安装的版本" + from + "，将覆盖安装到原位置。",
                    "Version" + from + " is already installed and will be updated in place.");
            }
            F<TextBlock>("LocationLabel").Text = L.T("安装位置", "INSTALL LOCATION");
            F<Button>("BrowseBtn").Content = L.T("更改…", "Change…");
            UpdatePath();
            F<CheckBox>("DesktopCheck").Content = L.T("创建桌面快捷方式", "Create a desktop shortcut");
            F<CheckBox>("DesktopCheck").IsChecked = !upgrade || File.Exists(Product.DesktopLink);
            F<CheckBox>("LaunchCheck").Content = L.T("安装完成后启动", "Launch when finished");
            SetButtons(upgrade ? L.T("更新", "Update") : L.T("安装", "Install"), StartInstall, L.T("取消", "Cancel"), TryClose);
        }

        void UpdatePath()
        {
            F<TextBlock>("PathText").Text = dir;
            F<TextBlock>("PathText").ToolTip = dir;
            Product.Machine = Product.IsMachineDir(dir);
            long free = Engine.FreeSpace(dir);
            string need = (BuildInfo.SizeKB / 1024.0).ToString("0") + " MB";
            string text = free < 0
                ? L.T("需要约 " + need + " 磁盘空间", "Requires about " + need)
                : L.T("需要约 " + need + " · 可用 " + (free / 1073741824.0).ToString("0.0") + " GB", "Requires about " + need + " · " + (free / 1073741824.0).ToString("0.0") + " GB available");
            if (Product.Machine) text += L.T(" · 为所有用户安装，需要管理员权限", " · For all users, requires administrator permission");
            F<TextBlock>("SpaceText").Text = text;
        }

        void Browse()
        {
            IntPtr hwnd = new System.Windows.Interop.WindowInteropHelper(w).Handle;
            string picked = null;
            try { picked = FolderPicker.Pick(hwnd, L.T("选择安装位置", "Choose install location"), dir); } catch { }
            if (picked == null) return;
            dir = Engine.ResolveTarget(picked);
            UpdatePath();
        }

        void StartInstall()
        {
#if SETUP
            List<Process> running = Engine.Running(dir);
            if (running.Count > 0)
            {
                Confirm(L.T("Infinite Studio 正在运行", "Infinite Studio is running"),
                    L.T("关闭它以继续。", "Close it to continue."),
                    L.T("关闭并继续", "Close and continue"), L.T("取消", "Cancel"),
                    delegate { Engine.Kill(running); StartInstall(); });
                return;
            }
            try
            {
                if (Engine.FreeSpace(dir) >= 0 && Engine.FreeSpace(dir) < BuildInfo.SizeKB * 1024L)
                {
                    ShowError(L.T("磁盘空间不足", "Not enough disk space"), L.T("请换一个安装位置。", "Please choose another location."), ShowInstallWelcome);
                    return;
                }
            }
            catch { }

            bool desktop = F<CheckBox>("DesktopCheck").IsChecked == true;
            bool launch = F<CheckBox>("LaunchCheck").IsChecked == true;
            string target = dir;
            ShowPage("PageProgress");
            F<TextBlock>("ProgressTitle").Text = L.T("正在安装", "Installing");
            F<TextBlock>("ProgressText").Text = L.T("正在把 Infinite Studio 安装到你的电脑上。", "Installing Infinite Studio on your computer.");
            SetButtons(null, null, null, null);
            working = true;
            Action<Exception> after = delegate (Exception err)
            {
                working = false;
                if (err != null)
                {
                    ShowError(L.T("安装没有完成", "Installation failed"), err.Message, ShowInstallWelcome);
                    return;
                }
                finished = true;
                string exe = System.IO.Path.Combine(target, Product.Exe);
                if (launch)
                {
                    Launch(exe);
                    // 自动启动时稍微展示一下完成页再关
                    ShowDone(L.T("安装完成", "All set"), L.T("Infinite Studio 正在启动…", "Infinite Studio is starting…"));
                    SetButtons(L.T("完成", "Done"), TryClose, null, null);
                    DispatcherTimerClose(2200);
                }
                else
                {
                    ShowDone(L.T("安装完成", "All set"), L.T("Infinite Studio 已经准备好了。在开始菜单或桌面上都能找到它。", "Infinite Studio is ready. Find it in the Start menu or on your desktop."));
                    SetButtons(L.T("立即启动", "Launch now"), delegate { Launch(exe); TryClose(); }, L.T("完成", "Done"), TryClose);
                }
            };
            Product.Machine = Product.IsMachineDir(target);
            if (Product.Machine && !Product.IsElevated)
            {
                // 装到 Program Files 等位置：以管理员身份静默安装，这里显示进度；启动程序仍由这里（普通权限）来做
                F<TextBlock>("ProgressText").Text = L.T("请在弹出的窗口中允许管理员权限。", "Allow administrator permission in the prompt that appears.");
                string args = "/S /D=\"" + target + "\" /desktop=" + (desktop ? "1" : "0");
                RunElevated(Assembly.GetExecutingAssembly().Location, args, after);
            }
            else RunWorker(delegate (Engine.Progress p) { Engine.Install(target, desktop, p, previous); }, after);
#endif
        }

        /** 以管理员身份静默运行 exe，从进度文件读进度显示在界面上 */
        void RunElevated(string exe, string args, Action<Exception> done)
        {
            string file = System.IO.Path.Combine(System.IO.Path.GetTempPath(), "InfiniteStudio-progress-" + Guid.NewGuid().ToString("N").Substring(0, 8) + ".txt");
            Process proc;
            try
            {
                proc = Process.Start(new ProcessStartInfo(exe, args + " /progress=\"" + file + "\"") { UseShellExecute = true, Verb = "runas" });
            }
            catch (System.ComponentModel.Win32Exception e)
            {
                done(new Exception(e.NativeErrorCode == 1223
                    ? L.T("没有获得管理员权限。这个位置需要管理员权限才能写入。", "Administrator permission was not granted. This location requires it.")
                    : e.Message));
                return;
            }
            ResetProgress();
            System.Windows.Threading.DispatcherTimer timer = new System.Windows.Threading.DispatcherTimer { Interval = TimeSpan.FromMilliseconds(150) };
            string error = null;
            Action read = delegate
            {
                try
                {
                    string text;
                    using (FileStream fs = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
                    using (StreamReader r = new StreamReader(fs, Encoding.UTF8))
                        text = r.ReadToEnd();
                    int bar = text.IndexOf('|');
                    if (bar < 0) return;
                    string head = text.Substring(0, bar);
                    if (head == "ERR") error = text.Substring(bar + 1);
                    else
                    {
                        double v;
                        if (double.TryParse(head, NumberStyles.Float, CultureInfo.InvariantCulture, out v)) SetProgress(v, text.Substring(bar + 1));
                    }
                }
                catch { }
            };
            timer.Tick += delegate
            {
                read();
                if (!proc.HasExited) return;
                timer.Stop();
                read();
                int code = proc.ExitCode;
                try { File.Delete(file); } catch { }
                done(code == 0 ? null : new Exception(error ?? L.T("后台进程意外退出（" + code + "）", "The background process exited unexpectedly (" + code + ")")));
            };
            timer.Start();
        }

        void DispatcherTimerClose(int ms)
        {
            System.Windows.Threading.DispatcherTimer timer = new System.Windows.Threading.DispatcherTimer { Interval = TimeSpan.FromMilliseconds(ms) };
            timer.Tick += delegate { timer.Stop(); TryClose(); };
            timer.Start();
        }

        static void Launch(string exe)
        {
            try { Process.Start(new ProcessStartInfo(exe) { UseShellExecute = true, WorkingDirectory = System.IO.Path.GetDirectoryName(exe) }); } catch { }
        }

        /* ---------- 卸载 ---------- */

        void ShowUninstallWelcome()
        {
            F<TextBlock>("WelcomeTitle").Text = L.T("卸载 Infinite Studio", "Uninstall Infinite Studio");
            F<TextBlock>("WelcomeText").Text = L.T(
                "将从这台电脑上移除 Infinite Studio 及其快捷方式。",
                "Infinite Studio and its shortcuts will be removed from this computer.");
            F<TextBlock>("LocationLabel").Text = L.T("程序位置", "LOCATION");
            F<Button>("BrowseBtn").Visibility = Visibility.Collapsed;
            F<TextBlock>("PathText").Text = dir;
            F<TextBlock>("SpaceText").Text = "";
            F<CheckBox>("DesktopCheck").Visibility = Visibility.Collapsed;
            F<CheckBox>("LaunchCheck").Visibility = Visibility.Collapsed;
            CheckBox data = F<CheckBox>("RemoveDataCheck");
            data.Visibility = Visibility.Visible;
            data.Margin = new Thickness(0);
            data.Content = L.T("同时删除个人设置、空间与登录信息", "Also remove settings, spaces and sign-in data");
            SetButtons(L.T("卸载", "Uninstall"), StartUninstall, L.T("取消", "Cancel"), TryClose);
        }

        void StartUninstall()
        {
            List<Process> running = Engine.Running(dir);
            if (running.Count > 0)
            {
                Confirm(L.T("Infinite Studio 正在运行", "Infinite Studio is running"),
                    L.T("关闭它以卸载。", "Close it to uninstall."),
                    L.T("关闭并卸载", "Close and uninstall"), L.T("取消", "Cancel"),
                    delegate { Engine.Kill(running); StartUninstall(); });
                return;
            }
            bool removeData = F<CheckBox>("RemoveDataCheck").IsChecked == true;
            string target = dir;
            ShowPage("PageProgress");
            F<TextBlock>("ProgressTitle").Text = L.T("正在卸载", "Uninstalling");
            F<TextBlock>("ProgressText").Text = L.T("正在移除程序文件。", "Removing program files.");
            SetButtons(null, null, null, null);
            working = true;
            Action<Exception> after = delegate (Exception err)
            {
                working = false;
                if (err != null)
                {
                    ShowError(L.T("卸载没有完成", "Uninstall failed"), err.Message, ShowUninstallWelcome);
                    return;
                }
                finished = true;
                ShowDone(L.T("已卸载", "Uninstalled"), removeData
                    ? L.T("Infinite Studio 及其数据已从这台电脑上移除。", "Infinite Studio and its data have been removed.")
                    : L.T("Infinite Studio 已移除。", "Infinite Studio has been removed."));
                SetButtons(L.T("完成", "Done"), TryClose, null, null);
            };
            Product.Machine = Product.IsMachineDir(target);
            if (Product.Machine && !Product.IsElevated)
            {
                F<TextBlock>("ProgressText").Text = L.T("请在弹出的窗口中允许管理员权限。", "Allow administrator permission in the prompt that appears.");
                RunElevated(Assembly.GetExecutingAssembly().Location, "--from-temp \"" + target + "\" /S" + (removeData ? " /data" : ""), after);
            }
            else RunWorker(delegate (Engine.Progress p) { Engine.Uninstall(target, removeData, p); }, after);
        }

        /* ---------- 公共 ---------- */

        double shownProgress;

        void ResetProgress()
        {
            shownProgress = 0;
            ProgressBar bar = F<ProgressBar>("Bar");
            bar.BeginAnimation(System.Windows.Controls.Primitives.RangeBase.ValueProperty, null);
            bar.Value = 0;
            F<TextBlock>("PercentText").Text = "0%";
            F<TextBlock>("FileText").Text = "";
        }

        /** 只在界面线程调用；进度只增不减 */
        void SetProgress(double fraction, string detail)
        {
            double v = Math.Max(shownProgress, Math.Min(100, fraction * 100));
            shownProgress = v;
            F<ProgressBar>("Bar").BeginAnimation(System.Windows.Controls.Primitives.RangeBase.ValueProperty, new DoubleAnimation(v, TimeSpan.FromMilliseconds(220)) { EasingFunction = Ease });
            F<TextBlock>("PercentText").Text = ((int)v) + "%";
            if (!string.IsNullOrEmpty(detail)) F<TextBlock>("FileText").Text = detail;
        }

        void RunWorker(Action<Engine.Progress> work, Action<Exception> done)
        {
            ResetProgress();
            DateTime last = DateTime.MinValue;
            Engine.Progress report = delegate (double fraction, string detail)
            {
                DateTime now = DateTime.UtcNow;
                if (fraction < 1 && (now - last).TotalMilliseconds < 60) return;
                last = now;
                w.Dispatcher.BeginInvoke(new Action(delegate { SetProgress(fraction, detail); }));
            };
            Thread t = new Thread(delegate ()
            {
                Exception err = null;
                try { work(report); }
                catch (Exception e) { err = e; }
                w.Dispatcher.BeginInvoke(new Action(delegate { done(err); }));
            });
            t.IsBackground = true;
            t.Start();
        }

        void ShowDone(string title, string text)
        {
            ShowPage("PageDone");
            F<TextBlock>("DoneTitle").Text = title;
            F<TextBlock>("DoneText").Text = text;
            F<Path>("ErrorMark").Visibility = Visibility.Collapsed;
            Path mark = F<Path>("DoneMark");
            mark.Visibility = Visibility.Visible;
            F<Ellipse>("DoneCircle").Fill = (Brush)w.FindResource("AccentGradient");
            ScaleTransform sc = F<ScaleTransform>("DoneScale");
            DoubleAnimation pop = new DoubleAnimation(0.4, 1, TimeSpan.FromMilliseconds(520)) { EasingFunction = new BackEase { EasingMode = EasingMode.EaseOut, Amplitude = 0.5 } };
            sc.BeginAnimation(ScaleTransform.ScaleXProperty, pop);
            sc.BeginAnimation(ScaleTransform.ScaleYProperty, pop);
            mark.BeginAnimation(Shape.StrokeDashOffsetProperty, new DoubleAnimation(9, 0, TimeSpan.FromMilliseconds(420)) { BeginTime = TimeSpan.FromMilliseconds(220), EasingFunction = Ease });
        }

        void ShowError(string title, string text, Action back)
        {
            ShowPage("PageDone");
            F<TextBlock>("DoneTitle").Text = title;
            F<TextBlock>("DoneText").Text = text;
            F<Path>("DoneMark").Visibility = Visibility.Collapsed;
            F<Path>("ErrorMark").Visibility = Visibility.Visible;
            F<Ellipse>("DoneCircle").Fill = new LinearGradientBrush(Color.FromRgb(0xE0, 0x6C, 0x75), Color.FromRgb(0xC2, 0x4E, 0x7A), 45);
            SetButtons(L.T("返回", "Back"), delegate { ShowPage("PageWelcome"); back(); }, L.T("关闭", "Close"), TryClose);
        }

        public bool Finished { get { return finished; } }
    }

    static class Program
    {
        [STAThread]
        static int Main(string[] args)
        {
            bool silent = false;
            bool desktop = true;
            bool removeData = false;
            string dirArg = null;
            string fromTemp = null;
            string progressFile = null;
            for (int i = 0; i < args.Length; i++)
            {
                string a = args[i];
                if (a.Equals("/S", StringComparison.OrdinalIgnoreCase)) silent = true;
                else if (a.StartsWith("/D=", StringComparison.OrdinalIgnoreCase)) dirArg = a.Substring(3).Trim('"');
                else if (a.Equals("/desktop=0", StringComparison.OrdinalIgnoreCase)) desktop = false;
                else if (a.Equals("/data", StringComparison.OrdinalIgnoreCase)) removeData = true;
                else if (a.StartsWith("/progress=", StringComparison.OrdinalIgnoreCase)) progressFile = a.Substring(10).Trim('"');
                else if (a == "--from-temp" && i + 1 < args.Length) fromTemp = args[++i];
            }
            Engine.Progress report = SilentReporter(progressFile);

#if SETUP
            if (silent)
            {
                Installed prev = Installed.Find();
                string dir = dirArg ?? (prev != null && Directory.Exists(prev.Dir) ? prev.Dir : Product.DefaultDir);
                Product.Machine = Product.IsMachineDir(dir);
                try
                {
                    Engine.Kill(Engine.Running(dir));
                    Engine.Install(dir, desktop, report, prev);
                    return 0;
                }
                catch (Exception e)
                {
                    ReportError(progressFile, e);
                    return 1;
                }
            }
            return RunUi(false, dirArg);
#else
            // 卸载程序在安装目录里运行时没法删掉自己：复制到临时目录再启动
            string self = Assembly.GetExecutingAssembly().Location;
            string selfDir = System.IO.Path.GetDirectoryName(self);
            if (fromTemp == null)
            {
                string tmp = System.IO.Path.Combine(System.IO.Path.GetTempPath(), "InfiniteStudio-uninstall-" + Guid.NewGuid().ToString("N").Substring(0, 8) + ".exe");
                File.Copy(self, tmp, true);
                string pass = "--from-temp \"" + selfDir + "\"" + (silent ? " /S" : "");
                Process.Start(new ProcessStartInfo(tmp, pass) { UseShellExecute = false });
                return 0;
            }
            int code;
            if (silent)
            {
                Product.Machine = Product.IsMachineDir(fromTemp);
                try
                {
                    Engine.Kill(Engine.Running(fromTemp));
                    Engine.Uninstall(fromTemp, removeData, report);
                    code = 0;
                }
                catch (Exception e)
                {
                    ReportError(progressFile, e);
                    code = 1;
                }
            }
            else code = RunUi(true, fromTemp);
            // 退出后删掉临时目录里的自己
            try
            {
                Process.Start(new ProcessStartInfo("cmd.exe", "/c ping 127.0.0.1 -n 3 > nul & del /f /q \"" + self + "\"") { CreateNoWindow = true, UseShellExecute = false, WindowStyle = ProcessWindowStyle.Hidden });
            }
            catch { }
            return code;
#endif
        }

        /** 静默运行（被界面以管理员身份启动）时，把进度写进文件：“0.42|文件名” */
        static Engine.Progress SilentReporter(string file)
        {
            if (file == null) return delegate { };
            DateTime last = DateTime.MinValue;
            return delegate (double fraction, string detail)
            {
                DateTime now = DateTime.UtcNow;
                if (fraction < 1 && (now - last).TotalMilliseconds < 120) return;
                last = now;
                try { File.WriteAllText(file, fraction.ToString("0.0000", CultureInfo.InvariantCulture) + "|" + (detail ?? ""), Encoding.UTF8); } catch { }
            };
        }

        static void ReportError(string file, Exception e)
        {
            if (file == null) return;
            try { File.WriteAllText(file, "ERR|" + e.Message, Encoding.UTF8); } catch { }
        }

        static int RunUi(bool uninstall, string dir)
        {
            Application app = new Application();
            app.ShutdownMode = ShutdownMode.OnMainWindowClose;
            Ui ui = new Ui(uninstall, dir);
            app.Run(ui.Window);
            return ui.Finished ? 0 : 2;
        }
    }
}
