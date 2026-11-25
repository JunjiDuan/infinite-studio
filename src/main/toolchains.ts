import { app } from 'electron'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, promises as fs, readdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { PluginStatus, RunPlan, ToolComponent } from '../shared/plugins'
import { andThen, invoke, quote, shellKind } from '../shared/shell'
import { childEnv } from './plugins'
import { tm } from './i18n'

/**
 * 编程语言插件的工具链：检测解释器 / 编译器 / 调试器 / 语言服务，生成安装命令和运行命令。
 * 工具链本身不随应用打包，安装时用系统的包管理器（Windows 上是 winget）。
 */

const isWin = process.platform === 'win32'
const isMac = process.platform === 'darwin'
const sh = shellKind(process.platform)

interface ExecResult {
  ok: boolean
  out: string
}

/** 运行程序并取 stdout + stderr（java -version 之类的输出在 stderr） */
export function exec(file: string, args: string[], opts: { timeout?: number; cwd?: string } = {}): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { timeout: opts.timeout ?? 15000, cwd: opts.cwd, windowsHide: true, env: childEnv(), maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' },
      (err, stdout, stderr) => resolve({ ok: !err, out: `${stdout ?? ''}${stderr ?? ''}` })
    )
  })
}

/* ---------------- PATH ---------------- */

const pathKey = isWin ? (Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') ?? 'Path') : 'PATH'

/**
 * 应用启动之后才装的工具不在本进程的 PATH 里（winget 改的是注册表）。
 * 每次检测前把注册表里最新的 PATH 合并进来，之后启动的终端、语言服务、调试器都能找到它们。
 */
export async function refreshPath(): Promise<void> {
  const cur = (process.env[pathKey] ?? '').split(path.delimiter).filter(Boolean)
  const extra: string[] = []
  if (isWin) {
    const read = async (key: string): Promise<string[]> => {
      const r = await exec('reg', ['query', key, '/v', 'Path'], { timeout: 5000 })
      const m = /^\s*Path\s+REG(?:_EXPAND)?_SZ\s+(.*)$/im.exec(r.out)
      if (!m) return []
      return m[1]
        .trim()
        .replace(/%([^%]+)%/g, (all, k: string) => process.env[k] ?? all)
        .split(';')
        .filter(Boolean)
    }
    extra.push(...(await read('HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment')), ...(await read('HKCU\\Environment')))
  } else {
    const home = os.homedir()
    extra.push('/opt/homebrew/bin', '/usr/local/bin', path.join(home, '.local', 'bin'))
  }
  const seen = new Set(cur.map((p) => norm(p)))
  for (const p of extra) {
    if (seen.has(norm(p))) continue
    seen.add(norm(p))
    cur.push(p)
  }
  process.env[pathKey] = cur.join(path.delimiter)
}

const norm = (p: string): string => (isWin ? p.replace(/[\\/]+$/, '').toLowerCase() : p.replace(/\/+$/, ''))

/** PATH 里所有叫这个名字的可执行文件（Windows 上只要 .exe） */
function whichAll(name: string): string[] {
  const exts = isWin ? ['.exe'] : ['']
  const out: string[] = []
  for (const dir of (process.env[pathKey] ?? '').split(path.delimiter)) {
    if (!dir) continue
    for (const ext of exts) {
      const p = path.join(dir.replace(/^"|"$/g, ''), name + ext)
      if (existsSync(p) && !out.some((x) => norm(x) === norm(p))) out.push(p)
    }
  }
  return out
}

function which(name: string): string | null {
  return whichAll(name)[0] ?? null
}

/** 在若干目录（支持一层通配：.../jdk-*\/bin）里找可执行文件 */
function findIn(patterns: string[], name: string): string | null {
  const exe = isWin ? name + '.exe' : name
  for (const pat of patterns) {
    const star = pat.indexOf('*')
    const dirs: string[] = []
    if (star < 0) dirs.push(pat)
    else {
      const parent = path.dirname(pat.slice(0, star + 1))
      const prefix = path.basename(pat.slice(0, star + 1)).replace('*', '')
      const rest = pat.slice(star + 1).replace(/^[^\\/]*/, '')
      try {
        for (const d of readdirSync(parent).filter((n) => n.toLowerCase().startsWith(prefix.toLowerCase())).sort().reverse()) dirs.push(path.join(parent, d, rest))
      } catch {
        /* 目录不存在 */
      }
    }
    for (const d of dirs) {
      const p = path.join(d, exe)
      if (existsSync(p)) return p
    }
  }
  return null
}

const firstLine = (s: string): string => s.split(/\r?\n/).find((l) => l.trim())?.trim() ?? ''
const ver = (s: string): string | undefined => /\d+(?:\.\d+)+/.exec(s)?.[0]

/* ---------------- Python ---------------- */

export interface PythonInfo {
  exe: string
  version: string
  debugpy?: string
  /** pip 安装的命令行脚本所在目录（basedpyright-langserver 在这里） */
  scripts: string[]
}

async function probePython(exe: string, pre: string[] = []): Promise<PythonInfo | null> {
  const code = [
    'import sys, os, json, sysconfig, importlib.util as u',
    'def v(m):',
    '    try:',
    '        import importlib.metadata as md',
    '        return md.version(m)',
    '    except Exception:',
    "        return '?'",
    'd = [sysconfig.get_path("scripts")]',
    'for s in ("nt_user", "posix_user", "osx_framework_user"):',
    '    try:',
    '        d.append(sysconfig.get_path("scripts", s))',
    '    except Exception:',
    '        pass',
    'print(json.dumps({"exe": sys.executable, "version": sys.version.split()[0], "debugpy": v("debugpy") if u.find_spec("debugpy") else None, "scripts": [x for x in d if x]}))'
  ].join('\n')
  const r = await exec(exe, [...pre, '-c', code], { timeout: 10000 })
  if (!r.ok) return null
  try {
    const j = JSON.parse(r.out.trim().split(/\r?\n/).pop()!) as { exe: string; version: string; debugpy: string | null; scripts: string[] }
    if (!/^3\./.test(j.version)) return null
    return { exe: j.exe || exe, version: j.version, debugpy: j.debugpy ?? undefined, scripts: j.scripts }
  } catch {
    return null
  }
}

async function findPython(): Promise<PythonInfo | null> {
  const cands = isWin ? [...whichAll('python'), ...whichAll('python3')] : [...whichAll('python3'), ...whichAll('python')]
  if (isWin) {
    const local = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local')
    const p = findIn([path.join(local, 'Programs', 'Python', 'Python3*'), 'C:\\Program Files\\Python3*'], 'python')
    if (p) cands.push(p)
  }
  for (const exe of cands) {
    const info = await probePython(exe)
    if (info) return info
  }
  // Windows 的 py 启动器：python 不在 PATH 里时（官方安装包默认不加 PATH）
  const py = isWin ? which('py') : null
  if (py) return probePython(py, ['-3'])
  return null
}

function pythonLsp(info: PythonInfo | null): { cmd: string; args: string[] } | null {
  const names: [string, string[]][] = [
    ['basedpyright-langserver', ['--stdio']],
    ['pyright-langserver', ['--stdio']],
    ['pylsp', []]
  ]
  for (const [name, args] of names) {
    const hit = which(name) ?? (info ? findIn(info.scripts, name) : null)
    if (hit) return { cmd: hit, args }
  }
  return null
}

/* ---------------- Java ---------------- */

export interface JavaInfo {
  javac: string
  java: string
  jdb: string
  version: string
}

async function findJava(): Promise<JavaInfo | null> {
  const homes = [process.env.JAVA_HOME, process.env.JDK_HOME].filter((x): x is string => !!x).map((h) => path.join(h, 'bin'))
  const scan = isWin
    ? ['C:\\Program Files\\Microsoft\\jdk-*\\bin', 'C:\\Program Files\\Eclipse Adoptium\\jdk-*\\bin', 'C:\\Program Files\\Java\\jdk*\\bin', 'C:\\Program Files\\Zulu\\zulu*\\bin', 'C:\\Program Files\\Amazon Corretto\\jdk*\\bin']
    : isMac
      ? ['/Library/Java/JavaVirtualMachines/*/Contents/Home/bin', '/opt/homebrew/opt/openjdk/bin']
      : ['/usr/lib/jvm/*/bin']
  const javac = which('javac') ?? findIn(homes, 'javac') ?? findIn(scan, 'javac')
  if (!javac) return null
  const bin = path.dirname(javac)
  const exe = (n: string) => path.join(bin, isWin ? n + '.exe' : n)
  const r = await exec(javac, ['-version'])
  // macOS 的 /usr/bin/javac 是占位程序，没装 JDK 时会报错
  if (!r.ok) return null
  return { javac, java: exe('java'), jdb: exe('jdb'), version: ver(r.out) ?? '' }
}

/* ---------------- C/C++ ---------------- */

export interface CppInfo {
  cc: string
  cxx: string
  version: string
  gdb?: string
  /** 没有 gdb 时用 lldb-dap（macOS） */
  lldbDap?: string
  clangd?: string
}

async function findCpp(): Promise<CppInfo | null> {
  const gcc = which('gcc')
  const gxx = which('g++')
  const clang = which('clang')
  const clangxx = which('clang++')
  let cc: string | null = null
  let cxx: string | null = null
  if (gcc && gxx) [cc, cxx] = [gcc, gxx]
  else if (clang && clangxx) [cc, cxx] = [clang, clangxx]
  if (!cc || !cxx) return null
  const r = await exec(cc, ['--version'])
  if (!r.ok) return null
  let lldbDap = which('lldb-dap') ?? which('lldb-vscode') ?? undefined
  if (!lldbDap && isMac) {
    const x = await exec('xcrun', ['-f', 'lldb-dap'])
    if (x.ok && existsSync(x.out.trim())) lldbDap = x.out.trim()
  }
  return { cc, cxx, version: ver(firstLine(r.out)) ?? '', gdb: which('gdb') ?? undefined, lldbDap, clangd: which('clangd') ?? undefined }
}

/* ---------------- C# ---------------- */

export interface CsharpInfo {
  dotnet: string
  /** 最新的 SDK 版本 */
  sdk: string
  sdkMajor: number
  netcoredbg?: string
  /** csharp-ls（dotnet tool install -g 装在 ~/.dotnet/tools，不一定在 PATH 上） */
  lsp?: string
}

/** netcoredbg 没有包管理器的包，从 GitHub release 下载解压到这里（压缩包里自带一层 netcoredbg/ 目录） */
const NETCOREDBG_PARENT = isWin
  ? path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'), 'Programs')
  : path.join(os.homedir(), '.local', 'share')
/** netcoredbg 的发布包：Windows x64、Linux x64 / arm64、macOS arm64（没有 Intel Mac 的包） */
const NETCOREDBG_ASSET = isWin
  ? 'netcoredbg-win64.zip'
  : isMac
    ? process.arch === 'arm64'
      ? 'netcoredbg-osx-arm64.zip'
      : null
    : process.arch === 'arm64'
      ? 'netcoredbg-linux-arm64.tar.gz'
      : process.arch === 'x64'
        ? 'netcoredbg-linux-amd64.tar.gz'
        : null
/** 最后一个支持 .NET 10 SDK 的 csharp-ls；更新的版本要 .NET 11 SDK */
const CSHARP_LS_NET10 = '0.28.0'

async function findCsharp(): Promise<CsharpInfo | null> {
  const fixed = isWin
    ? [path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'dotnet')]
    : isMac
      ? ['/usr/local/share/dotnet', path.join(os.homedir(), '.dotnet')]
      : ['/usr/lib/dotnet', '/usr/share/dotnet', path.join(os.homedir(), '.dotnet')]
  const dotnet = which('dotnet') ?? findIn(fixed, 'dotnet')
  if (!dotnet) return null
  // 只装了运行时（没有 SDK）时列表是空的，不能编译
  const r = await exec(dotnet, ['--list-sdks'])
  const sdks = [...r.out.matchAll(/^(\d+)\.(\d+)\.(\d+)\S*\s+\[/gm)].map((m) => ({ v: m[0].split(/\s/)[0], k: [Number(m[1]), Number(m[2]), Number(m[3])] }))
  if (!sdks.length) return null
  sdks.sort((a, b) => a.k[0] - b.k[0] || a.k[1] - b.k[1] || a.k[2] - b.k[2])
  const best = sdks[sdks.length - 1]
  const tools = path.join(os.homedir(), '.dotnet', 'tools')
  return {
    dotnet,
    sdk: best.v,
    sdkMajor: best.k[0],
    netcoredbg: which('netcoredbg') ?? findIn([path.join(NETCOREDBG_PARENT, 'netcoredbg')], 'netcoredbg') ?? undefined,
    lsp: which('csharp-ls') ?? findIn([tools], 'csharp-ls') ?? undefined
  }
}

/** 运行 / 调试 C# 文件的目标：所在的项目（往上找 .csproj），找不到时当作单文件程序（.NET 10 起支持） */
export async function csharpTarget(file: string): Promise<{ project?: string; cwd: string }> {
  let dir = path.dirname(file)
  for (let i = 0; i < 8; i++) {
    const names = await fs.readdir(dir).catch(() => [] as string[])
    const projs = names.filter((n) => /\.csproj$/i.test(n)).sort()
    if (projs.length) {
      // 一个目录里有多个项目时，优先和目录同名的那个
      const pick = projs.find((n) => n.slice(0, -7).toLowerCase() === path.basename(dir).toLowerCase()) ?? projs[0]
      return { project: path.join(dir, pick), cwd: dir }
    }
    const up = path.dirname(dir)
    if (up === dir) break
    dir = up
  }
  return { cwd: path.dirname(file) }
}

/* ---------------- 检测结果 ---------------- */

export interface Toolchains {
  python: PythonInfo | null
  pythonLsp: { cmd: string; args: string[] } | null
  java: JavaInfo | null
  jdtls: string | null
  cpp: CppInfo | null
  csharp: CsharpInfo | null
}

let cache: Partial<Toolchains> = {}

/** 最近一次检测到的结果（语言服务启动时用，不重新检测） */
export function cachedToolchains(): Partial<Toolchains> {
  return cache
}

export async function detectLanguage(id: string): Promise<PluginStatus> {
  await refreshPath()
  const c: ToolComponent[] = []
  let installed = false
  let version: string | undefined
  if (id === 'python') {
    const py = await findPython()
    const lsp = pythonLsp(py)
    cache.python = py
    cache.pythonLsp = lsp
    c.push({ name: tm('解释器'), ok: !!py, detail: py ? `Python ${py.version}` : undefined })
    c.push({ name: tm('调试器'), ok: !!py?.debugpy, detail: py?.debugpy ? `debugpy ${py.debugpy}` : undefined })
    c.push({ name: tm('语言服务'), ok: !!lsp, optional: true, detail: lsp ? path.basename(lsp.cmd).replace(/\.(exe|cmd)$/i, '') : undefined })
    installed = !!py?.debugpy
    version = py?.version
  } else if (id === 'java') {
    const j = await findJava()
    cache.java = j
    cache.jdtls = which('jdtls')
    c.push({ name: tm('编译器'), ok: !!j, detail: j ? `javac ${j.version}` : undefined })
    c.push({ name: tm('调试器'), ok: !!j && existsSync(j.jdb), detail: j && existsSync(j.jdb) ? 'jdb' : undefined })
    c.push({ name: tm('语言服务'), ok: !!cache.jdtls, optional: true, detail: cache.jdtls ? 'jdtls' : undefined })
    installed = !!j && existsSync(j.jdb)
    version = j?.version
  } else if (id === 'cpp') {
    const x = await findCpp()
    cache.cpp = x
    const dbg = x?.gdb ? 'gdb' : x?.lldbDap ? 'lldb-dap' : undefined
    c.push({ name: tm('编译器'), ok: !!x, detail: x ? `${path.basename(x.cc).replace(/\.exe$/i, '')} ${x.version}` : undefined })
    c.push({ name: tm('调试器'), ok: !!dbg, detail: dbg })
    c.push({ name: tm('语言服务'), ok: !!x?.clangd, optional: true, detail: x?.clangd ? 'clangd' : undefined })
    installed = !!x && !!dbg
    version = x?.version
  } else if (id === 'csharp') {
    const cs = await findCsharp()
    cache.csharp = cs
    // Intel Mac 没有 netcoredbg 的发布包：调试器装不上，只能运行
    const dbgOptional = !NETCOREDBG_ASSET
    c.push({ name: tm('编译器'), ok: !!cs, detail: cs ? `.NET SDK ${cs.sdk}` : undefined })
    c.push({ name: tm('调试器'), ok: !!cs?.netcoredbg, optional: dbgOptional || undefined, detail: cs?.netcoredbg ? 'netcoredbg' : undefined })
    c.push({ name: tm('语言服务'), ok: !!cs?.lsp, optional: true, detail: cs?.lsp ? 'csharp-ls' : undefined })
    installed = !!cs && (!!cs.netcoredbg || dbgOptional)
    version = cs?.sdk
  } else throw new Error(tm('未知插件：{0}', id))
  return { installed, version, components: c, installScript: installScript(id) || undefined }
}

/* ---------------- 安装命令 ---------------- */

const winget = (id: string): string => `winget install -e --id ${id} --accept-source-agreements --accept-package-agreements`
/** winget 装完后，同一个终端里刷新 PATH，后面的步骤才能找到新装的程序 */
const REFRESH_PATH = "$env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')"

/** 缺少的组件的安装命令；全部装好时返回空串 */
function installScript(id: string): string {
  const steps: string[] = []
  if (id === 'python') {
    const py = cache.python
    if (py?.debugpy && cache.pythonLsp) return ''
    let runner: string
    if (py) runner = invoke(sh, py.exe)
    else if (isWin) {
      steps.push(winget('Python.Python.3.14'), REFRESH_PATH)
      runner = 'py -3'
    } else {
      steps.push(isMac ? 'brew install python' : 'sudo apt-get install -y python3 python3-pip')
      runner = 'python3'
    }
    const extra = isWin ? [] : ['--user', '--break-system-packages']
    steps.push(`${runner} -m pip install --disable-pip-version-check --upgrade ${extra.join(' ')} debugpy basedpyright`.replace(/\s+/g, ' '))
  } else if (id === 'java') {
    if (cache.java && existsSync(cache.java.jdb)) return ''
    steps.push(isWin ? winget('Microsoft.OpenJDK.25') : isMac ? 'brew install --cask temurin' : 'sudo apt-get install -y default-jdk')
  } else if (id === 'cpp') {
    const x = cache.cpp
    const hasDbg = !!(x?.gdb || x?.lldbDap)
    if (x && hasDbg && x.clangd) return ''
    if (!x || !hasDbg) steps.push(isWin ? winget('BrechtSanders.WinLibs.POSIX.UCRT.LLVM') : isMac ? 'xcode-select --install' : 'sudo apt-get install -y build-essential gdb clangd')
    else steps.push(isWin ? winget('LLVM.LLVM') : isMac ? 'brew install llvm' : 'sudo apt-get install -y clangd')
  } else if (id === 'csharp') {
    const cs = cache.csharp
    // 单文件程序（dotnet run app.cs）和 csharp-ls 都要 .NET 10 以上的 SDK；旧版 SDK 保留，新版并排安装
    const needSdk = !cs || cs.sdkMajor < 10
    const needDbg = !cs?.netcoredbg && !!NETCOREDBG_ASSET
    const needLsp = !cs?.lsp
    if (!needSdk && !needDbg && !needLsp) return ''
    let dotnet: string
    if (needSdk) {
      steps.push(isWin ? winget('Microsoft.DotNet.SDK.10') : isMac ? 'brew install --cask dotnet-sdk' : 'sudo apt-get install -y dotnet-sdk-10.0')
      if (isWin) steps.push(REFRESH_PATH)
      // 新装的 SDK 在 PATH 上（Windows 刷新过 PATH，macOS / Linux 的安装包会建好链接）
      dotnet = 'dotnet'
    } else dotnet = invoke(sh, cs.dotnet)
    if (needLsp) {
      const major = needSdk ? 10 : cs.sdkMajor
      steps.push(`${dotnet} tool install --global csharp-ls${major < 11 ? ` --version ${CSHARP_LS_NET10}` : ''}`)
    }
    if (needDbg) {
      const url = `https://github.com/Samsung/netcoredbg/releases/latest/download/${NETCOREDBG_ASSET}`
      if (isWin)
        steps.push(
          `$d = Join-Path $env:LOCALAPPDATA 'Programs'; New-Item -ItemType Directory -Force $d | Out-Null; $z = Join-Path $env:TEMP 'netcoredbg.zip'; Invoke-WebRequest -UseBasicParsing '${url}' -OutFile $z; Expand-Archive -Force $z $d; Remove-Item $z`
        )
      else if (isMac) steps.push(`mkdir -p ~/.local/share && curl -fsSL -o /tmp/netcoredbg.zip ${url} && unzip -oq /tmp/netcoredbg.zip -x '__MACOSX/*' -d ~/.local/share && rm /tmp/netcoredbg.zip`)
      else steps.push(`mkdir -p ~/.local/share && curl -fsSL ${url} | tar -xz -C ~/.local/share`)
    }
  }
  return sh === 'pwsh' ? steps.join('; ') : steps.join(' && ')
}

/* ---------------- 运行 ---------------- */

export function buildRoot(): string {
  return path.join(app.getPath('temp'), 'infinite-studio-build')
}

const hash = (s: string): string => createHash('sha1').update(isWin ? s.toLowerCase() : s).digest('hex').slice(0, 10)

/** Java 源文件：根据 package 声明算出源码根目录和完整类名 */
export async function javaTarget(file: string): Promise<{ srcRoot: string; mainClass: string; outDir: string }> {
  const text = await fs.readFile(file, 'utf8').catch(() => '')
  const pkg = /^\s*package\s+([\w.]+)\s*;/m.exec(text.replace(/\/\*[\s\S]*?\*\//g, ''))?.[1]
  const name = path.basename(file, path.extname(file))
  let srcRoot = path.dirname(file)
  if (pkg) for (let i = 0; i < pkg.split('.').length; i++) srcRoot = path.dirname(srcRoot)
  return { srcRoot, mainClass: pkg ? `${pkg}.${name}` : name, outDir: path.join(buildRoot(), 'java', hash(srcRoot)) }
}

export function cppTarget(file: string): { exe: string; isC: boolean } {
  const name = path.basename(file, path.extname(file))
  return { exe: path.join(buildRoot(), 'cpp', hash(file), isWin ? name + '.exe' : name), isC: /\.c$/i.test(file) }
}

export function javacArgs(file: string, t: { srcRoot: string; outDir: string }): string[] {
  return ['-g', '-encoding', 'UTF-8', '-d', t.outDir, '-sourcepath', t.srcRoot, file]
}

export function ccArgs(file: string, exe: string, extra: string[] = []): string[] {
  return ['-g', '-O0', file, ...extra, '-o', exe]
}

/** 在终端里运行当前文件的命令 */
export async function runPlan(id: string, file: string): Promise<RunPlan> {
  const key = ({ python: 'python', java: 'java', cpp: 'cpp', csharp: 'csharp' } as const)[id]
  if (!key) throw new Error(tm('未知插件：{0}', id))
  if (!cache[key]) await detectLanguage(id)
  if (id === 'python') {
    const py = cache.python
    if (!py) throw new Error(tm('没有找到 Python 解释器，请先在插件页安装 Python 插件'))
    return { cwd: path.dirname(file), command: invoke(sh, py.exe, [file]) }
  }
  if (id === 'java') {
    const j = cache.java
    if (!j) throw new Error(tm('没有找到 JDK，请先在插件页安装 Java 插件'))
    const t = await javaTarget(file)
    await fs.mkdir(t.outDir, { recursive: true })
    return { cwd: t.srcRoot, command: andThen(sh, [invoke(sh, j.javac, javacArgs(file, t)), invoke(sh, j.java, ['-Dfile.encoding=UTF-8', '-cp', t.outDir, t.mainClass])]) }
  }
  if (id === 'cpp') {
    const x = cache.cpp
    if (!x) throw new Error(tm('没有找到 C/C++ 编译器，请先在插件页安装 C/C++ 插件'))
    const t = cppTarget(file)
    await fs.mkdir(path.dirname(t.exe), { recursive: true })
    return { cwd: path.dirname(file), command: andThen(sh, [invoke(sh, t.isC ? x.cc : x.cxx, ccArgs(file, t.exe)), invoke(sh, t.exe)]) }
  }
  if (id === 'csharp') {
    const cs = cache.csharp
    if (!cs) throw new Error(tm('没有找到 .NET SDK，请先在插件页安装 C# 插件'))
    const t = await csharpTarget(file)
    if (t.project) return { cwd: t.cwd, command: invoke(sh, cs.dotnet, ['run', '--project', t.project]) }
    if (cs.sdkMajor < 10) throw new Error(tm('没有找到 .csproj 项目文件；直接运行单个 .cs 文件需要 .NET 10 或更新的 SDK'))
    return { cwd: t.cwd, command: invoke(sh, cs.dotnet, ['run', file]) }
  }
  throw new Error(tm('未知插件：{0}', id))
}

export { quote, sh }
