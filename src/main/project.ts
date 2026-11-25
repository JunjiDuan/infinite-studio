import { BrowserWindow, dialog, ipcMain } from 'electron'
import { execFile } from 'node:child_process'
import { existsSync, promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { NewProjectOptions, ProjectCreated, ProjectKind, ProjectProbe, ProjectTarget, ProjectTool } from '../shared/types'
import { invoke, shellKind } from '../shared/shell'
import { tm } from './i18n'
import { childEnv } from './plugins'
import { cachedToolchains, detectLanguage, exec, refreshPath } from './toolchains'

/**
 * 新建项目：按模板在磁盘上生成项目骨架（目录、示例代码、构建文件、.gitignore），
 * 需要时再初始化 Git 仓库、创建 Python 虚拟环境。模板都写在这里，页面只传选项。
 */

const isWin = process.platform === 'win32'
const isMac = process.platform === 'darwin'
const KINDS: ProjectKind[] = ['empty', 'java', 'python', 'cpp', 'csharp', 'node']
const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i
const PACKAGE_RE = /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$/

/* ---------------- 工具检测 ---------------- */

/** PATH 里的命令（Windows 上也认 .cmd / .bat：mvn、gradle、npm 都是批处理） */
function findCmd(name: string): string | null {
  const exts = isWin ? ['.exe', '.cmd', '.bat'] : ['']
  const key = isWin ? (Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') ?? 'Path') : 'PATH'
  for (const dir of (process.env[key] ?? '').split(path.delimiter)) {
    if (!dir) continue
    for (const ext of exts) {
      const p = path.join(dir.replace(/^"|"$/g, ''), name + ext)
      if (existsSync(p)) return p
    }
  }
  return null
}

/** 运行批处理或可执行文件取版本号（.cmd / .bat 要交给 cmd.exe 执行） */
function version(file: string, args: string[]): Promise<string | undefined> {
  const batch = isWin && /\.(cmd|bat)$/i.test(file)
  const [exe, argv] = batch ? [process.env.ComSpec || 'cmd.exe', ['/d', '/c', file, ...args]] : [file, args]
  return new Promise((resolve) => {
    execFile(exe, argv, { timeout: 10000, windowsHide: true, env: childEnv(), encoding: 'utf8' }, (_err, stdout, stderr) =>
      resolve(/\d+(?:\.\d+)+/.exec(`${stdout ?? ''}${stderr ?? ''}`)?.[0])
    )
  })
}

const pick = (win: string, mac: string, linux: string): string => (isWin ? win : isMac ? mac : linux)
const winget = (id: string): string => `winget install -e --id ${id} --accept-source-agreements --accept-package-agreements`

async function probe(kind: ProjectKind): Promise<ProjectProbe> {
  const tools: ProjectTool[] = []
  if (kind === 'python' || kind === 'java' || kind === 'cpp' || kind === 'csharp') {
    const st = await detectLanguage(kind)
    const tc = cachedToolchains()
    if (kind === 'python') tools.push({ id: 'python', ok: !!tc.python, detail: tc.python ? `Python ${tc.python.version}` : undefined, install: tc.python ? undefined : st.installScript })
    if (kind === 'java') {
      tools.push({ id: 'jdk', ok: !!tc.java, detail: tc.java ? `JDK ${tc.java.version}` : undefined, install: tc.java ? undefined : st.installScript })
      const mvn = findCmd('mvn')
      tools.push({ id: 'maven', ok: !!mvn, detail: mvn ? `Maven ${(await version(mvn, ['-v'])) ?? ''}`.trim() : undefined, install: mvn ? undefined : pick('', 'brew install maven', 'sudo apt-get install -y maven') || undefined })
      const gradle = findCmd('gradle')
      tools.push({ id: 'gradle', ok: !!gradle, detail: gradle ? 'Gradle' : undefined, install: gradle ? undefined : pick('', 'brew install gradle', 'sudo apt-get install -y gradle') || undefined })
    }
    if (kind === 'cpp') {
      tools.push({ id: 'cc', ok: !!tc.cpp, detail: tc.cpp ? `${path.basename(tc.cpp.cxx).replace(/\.exe$/i, '')} ${tc.cpp.version}` : undefined, install: tc.cpp ? undefined : st.installScript })
      const cmake = findCmd('cmake')
      tools.push({ id: 'cmake', ok: !!cmake, detail: cmake ? `CMake ${(await version(cmake, ['--version'])) ?? ''}`.trim() : undefined, install: cmake ? undefined : pick(winget('Kitware.CMake'), 'brew install cmake', 'sudo apt-get install -y cmake') })
    }
    if (kind === 'csharp') tools.push({ id: 'dotnet', ok: !!tc.csharp, detail: tc.csharp ? `.NET SDK ${tc.csharp.sdk}` : undefined, install: tc.csharp ? undefined : st.installScript })
  } else if (kind === 'node') {
    await refreshPath()
    const node = findCmd('node')
    tools.push({ id: 'node', ok: !!node, detail: node ? `Node.js ${(await version(node, ['--version'])) ?? ''}`.trim() : undefined, install: node ? undefined : pick(winget('OpenJS.NodeJS.LTS'), 'brew install node', 'sudo apt-get install -y nodejs npm') })
  }
  if (kind === 'empty') await refreshPath()
  const git = findCmd('git')
  tools.push({ id: 'git', ok: !!git, optional: true, detail: git ? `Git ${(await version(git, ['--version'])) ?? ''}`.trim() : undefined, install: git ? undefined : pick(winget('Git.Git'), 'xcode-select --install', 'sudo apt-get install -y git') })
  return { tools }
}

/* ---------------- 校验 ---------------- */

function checkName(name: string): void {
  if (!name.trim()) throw new Error(tm('项目名称不能为空'))
  if (name === '.' || name === '..' || /[\\/:*?"<>|\x00-\x1f]/.test(name) || /[. ]$/.test(name) || RESERVED.test(name)) throw new Error(tm('项目名称包含非法字符'))
}

async function target(location: string, name: string): Promise<ProjectTarget> {
  if (!location || !path.isAbsolute(location)) return { path: '', state: 'invalid', message: tm('位置必须是绝对路径') }
  try {
    checkName(name)
  } catch (e) {
    return { path: '', state: 'invalid', message: (e as Error).message }
  }
  const p = path.join(location, name)
  try {
    const st = await fs.stat(p)
    if (!st.isDirectory()) return { path: p, state: 'invalid', message: tm('目标已存在且不是文件夹：{0}', p) }
    if ((await fs.readdir(p)).length) return { path: p, state: 'invalid', message: tm('文件夹已存在且不为空：{0}', p) }
    return { path: p, state: 'empty' }
  } catch {
    return { path: p, state: 'free' }
  }
}

/** 第一个还没被占用的默认名称：untitled、untitled1、untitled2… */
async function freeName(location: string, base: string): Promise<string> {
  for (let i = 0; i < 100; i++) {
    const n = i ? `${base}${i}` : base
    if ((await target(location, n)).state !== 'invalid') return n
  }
  return base
}

/* ---------------- 模板 ---------------- */

type Files = Record<string, string>

const javaMajor = (v: string | undefined): number => {
  const m = /^(\d+)(?:\.(\d+))?/.exec(v ?? '')
  if (!m) return 17
  return m[1] === '1' && m[2] ? Number(m[2]) : Number(m[1])
}
const slug = (s: string, re: RegExp, fallback: string): string => s.toLowerCase().replace(re, '-').replace(/^[-._]+|[-._]+$/g, '') || fallback
const xml = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const MAIN_JAVA = (pkg: string): string => `package ${pkg};

public class Main {
    public static void main(String[] args) {
        System.out.println("Hello, World!");
    }
}
`

function javaFiles(o: NewProjectOptions): { files: Files; open?: string; dirs: string[] } {
  const pkg = o.java?.package || 'com.example'
  if (!PACKAGE_RE.test(pkg)) throw new Error(tm('包名不合法：{0}', pkg))
  const build = o.java?.build ?? 'none'
  const rel = javaMajor(cachedToolchains().java?.version)
  const pkgPath = pkg.split('.').join('/')
  const srcRoot = build === 'none' ? 'src' : 'src/main/java'
  const main = `${srcRoot}/${pkgPath}/Main.java`
  const files: Files = {}
  const dirs = [`${srcRoot}/${pkgPath}`]
  if (o.sample) files[main] = MAIN_JAVA(pkg)
  if (build === 'maven') {
    dirs.push('src/main/resources', 'src/test/java')
    files['pom.xml'] = `<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0"
         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 https://maven.apache.org/xsd/maven-4.0.0.xsd">
    <modelVersion>4.0.0</modelVersion>

    <groupId>${xml(pkg)}</groupId>
    <artifactId>${xml(slug(o.name, /[^a-z0-9._-]+/g, 'app'))}</artifactId>
    <version>1.0-SNAPSHOT</version>
    <packaging>jar</packaging>

    <properties>
        <maven.compiler.release>${rel}</maven.compiler.release>
        <project.build.sourceEncoding>UTF-8</project.build.sourceEncoding>
        <exec.mainClass>${xml(pkg)}.Main</exec.mainClass>
    </properties>

    <dependencies>
    </dependencies>
</project>
`
    files['.gitignore'] = 'target/\n.idea/\n.vscode/\n'
  } else if (build === 'gradle') {
    dirs.push('src/main/resources', 'src/test/java')
    files['settings.gradle'] = `rootProject.name = '${o.name.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'\n`
    files['build.gradle'] = `plugins {
    id 'application'
}

group = '${pkg}'
version = '1.0-SNAPSHOT'

repositories {
    mavenCentral()
}

tasks.withType(JavaCompile).configureEach {
    options.encoding = 'UTF-8'
    options.release = ${rel}
}

application {
    mainClass = '${pkg}.Main'
}
`
    files['.gitignore'] = '.gradle/\nbuild/\n.idea/\n.vscode/\n'
  } else {
    files['.gitignore'] = 'out/\n*.class\n.idea/\n.vscode/\n'
  }
  return { files, dirs, open: o.sample ? main : undefined }
}

function pythonFiles(o: NewProjectOptions): { files: Files; open?: string } {
  const files: Files = { '.gitignore': '__pycache__/\n*.py[cod]\n.venv/\nvenv/\n.idea/\n.vscode/\n' }
  if (o.sample)
    files['main.py'] = `def main() -> None:
    print("Hello, World!")


if __name__ == "__main__":
    main()
`
  return { files, open: o.sample ? 'main.py' : undefined }
}

function cppFiles(o: NewProjectOptions): { files: Files; open?: string } {
  const isC = o.cpp?.lang === 'c'
  const cmake = !!o.cpp?.cmake
  const main = isC ? 'main.c' : 'main.cpp'
  const files: Files = { '.gitignore': 'build/\ncmake-build-*/\n*.o\n*.obj\n*.exe\n*.out\n.idea/\n.vscode/\n' }
  // CMakeLists.txt 要引用源文件，用 CMake 时总是生成 main
  if (o.sample || cmake)
    files[main] = isC
      ? `#include <stdio.h>

int main(void) {
    printf("Hello, World!\\n");
    return 0;
}
`
      : `#include <iostream>

int main() {
    std::cout << "Hello, World!" << std::endl;
    return 0;
}
`
  if (cmake) {
    const target = o.name.replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'app'
    files['CMakeLists.txt'] = isC
      ? `cmake_minimum_required(VERSION 3.16)
project(${target} LANGUAGES C)

set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)

add_executable(${target} ${main})
`
      : `cmake_minimum_required(VERSION 3.16)
project(${target} LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

add_executable(${target} ${main})
`
  }
  return { files, open: files[main] ? main : undefined }
}

/** SDK 风格的控制台项目（和 dotnet new console 生成的一样），目标框架跟随本机最新的 SDK */
function csharpFiles(o: NewProjectOptions): { files: Files; open?: string } {
  const major = cachedToolchains().csharp?.sdkMajor ?? 10
  const file = o.name.replace(/[^\p{L}\p{N}_.-]+/gu, '_').replace(/^[._]+|[._]+$/g, '') || 'App'
  // 命名空间要是合法的 C# 标识符（可以是中文），不能以数字开头
  const ns = file.replace(/[^\p{L}\p{N}_]+/gu, '_').replace(/^(\p{N})/u, '_$1')
  const files: Files = {
    '.gitignore': 'bin/\nobj/\n.vs/\n.idea/\n.vscode/\n*.user\n',
    [`${file}.csproj`]: `<Project Sdk="Microsoft.NET.Sdk">

  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net${major}.0</TargetFramework>
    <RootNamespace>${xml(ns)}</RootNamespace>
    <ImplicitUsings>enable</ImplicitUsings>
    <Nullable>enable</Nullable>
  </PropertyGroup>

</Project>
`
  }
  if (o.sample) files['Program.cs'] = 'Console.WriteLine("Hello, World!");\n'
  return { files, open: o.sample ? 'Program.cs' : undefined }
}

function nodeFiles(o: NewProjectOptions): { files: Files; open?: string } {
  const ts = !!o.node?.ts
  const name = slug(o.name, /[^a-z0-9._~-]+/g, 'app').slice(0, 214)
  const pkg: Record<string, unknown> = { name, version: '1.0.0', private: true, type: 'module' }
  const files: Files = { '.gitignore': ts ? 'node_modules/\ndist/\n.idea/\n.vscode/\n' : 'node_modules/\n.idea/\n.vscode/\n' }
  let open: string | undefined
  if (ts) {
    pkg.main = 'dist/index.js'
    pkg.scripts = { build: 'tsc', dev: 'tsc --watch', start: 'node dist/index.js' }
    files['tsconfig.json'] =
      JSON.stringify(
        {
          compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', outDir: 'dist', rootDir: 'src', strict: true, esModuleInterop: true, skipLibCheck: true },
          include: ['src']
        },
        null,
        2
      ) + '\n'
    if (o.sample) {
      files['src/index.ts'] = "const greet = (name: string): string => `Hello, ${name}!`\n\nconsole.log(greet('World'))\n"
      open = 'src/index.ts'
    }
  } else {
    pkg.main = 'index.js'
    pkg.scripts = { start: 'node index.js' }
    if (o.sample) {
      files['index.js'] = "console.log('Hello, World!')\n"
      open = 'index.js'
    }
  }
  files['package.json'] = JSON.stringify(pkg, null, 2) + '\n'
  return { files, open }
}

/**
 * TypeScript 的依赖用 npm 装（记下当时的最新版本），在终端里跑，用户能看到进度。
 * 用 --prefix 指定项目目录：终端的 shell 配置文件可能会切换工作目录，不能依赖终端的 cwd
 */
function nodePost(o: NewProjectOptions, root: string): string | undefined {
  if (!o.node?.ts || !findCmd('npm')) return undefined
  return invoke(shellKind(process.platform), isWin ? 'npm.cmd' : 'npm', ['install', '--prefix', root, '--save-dev', 'typescript', '@types/node'])
}

/* ---------------- 创建 ---------------- */

async function create(o: NewProjectOptions): Promise<ProjectCreated> {
  if (!o || !KINDS.includes(o.kind)) throw new Error(tm('未知项目类型：{0}', String(o?.kind)))
  const t = await target(o.location, o.name)
  if (t.state === 'invalid') throw new Error(t.message)
  const root = t.path

  let tpl: { files: Files; open?: string; dirs?: string[] } = { files: {} }
  if (o.kind === 'java') tpl = javaFiles(o)
  else if (o.kind === 'python') tpl = pythonFiles(o)
  else if (o.kind === 'cpp') tpl = cppFiles(o)
  else if (o.kind === 'csharp') tpl = csharpFiles(o)
  else if (o.kind === 'node') tpl = nodeFiles(o)

  const created = t.state === 'free'
  try {
    await fs.mkdir(root, { recursive: true })
    for (const d of tpl.dirs ?? []) await fs.mkdir(path.join(root, d), { recursive: true })
    for (const [rel, content] of Object.entries(tpl.files)) {
      const p = path.join(root, rel)
      await fs.mkdir(path.dirname(p), { recursive: true })
      await fs.writeFile(p, content, { encoding: 'utf8', flag: 'wx' })
    }
  } catch (e) {
    // 写到一半失败：删掉这次新建的目录，不留半成品（原来就存在的空目录只清空不删）
    if (created) await fs.rm(root, { recursive: true, force: true }).catch(() => undefined)
    else for (const n of await fs.readdir(root).catch(() => [] as string[])) await fs.rm(path.join(root, n), { recursive: true, force: true }).catch(() => undefined)
    throw e
  }

  const warnings: string[] = []
  if (o.kind === 'python' && o.python?.venv) {
    const py = cachedToolchains().python
    if (!py) warnings.push(tm('没有找到 Python 解释器，未创建虚拟环境'))
    else {
      const r = await exec(py.exe, ['-m', 'venv', '.venv'], { cwd: root, timeout: 180000 })
      if (!r.ok) warnings.push(tm('虚拟环境创建失败：{0}', r.out.trim().split(/\r?\n/).pop() ?? ''))
    }
  }
  if (o.git) {
    const r = await exec('git', ['init'], { cwd: root, timeout: 30000 })
    if (!r.ok) warnings.push(tm('Git 仓库初始化失败：{0}', r.out.trim().split(/\r?\n/).pop() || tm('没有找到 git')))
  }
  return { path: root, open: tpl.open ? path.join(root, tpl.open) : undefined, post: o.kind === 'node' ? nodePost(o, root) : undefined, warnings }
}

export function registerProjectIpc(): void {
  ipcMain.handle('project:home', () => path.join(os.homedir(), 'Projects'))
  ipcMain.handle('project:pickLocation', async (e, start?: string) => {
    const w = BrowserWindow.fromWebContents(e.sender)
    const opts: Electron.OpenDialogOptions = {
      title: tm('选择项目位置'),
      defaultPath: typeof start === 'string' && start ? start : undefined,
      properties: ['openDirectory', 'createDirectory']
    }
    const r = w ? await dialog.showOpenDialog(w, opts) : await dialog.showOpenDialog(opts)
    return r.canceled || !r.filePaths.length ? null : r.filePaths[0]
  })
  ipcMain.handle('project:probe', (_e, kind: ProjectKind) => probe(KINDS.includes(kind) ? kind : 'empty'))
  ipcMain.handle('project:target', (_e, location: string, name: string) => target(String(location ?? ''), String(name ?? '')))
  ipcMain.handle('project:freeName', (_e, location: string, base: string) => freeName(String(location ?? ''), String(base || 'untitled')))
  ipcMain.handle('project:create', (_e, o: NewProjectOptions) => create(o))
}
