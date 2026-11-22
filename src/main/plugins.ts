import { app, ipcMain } from 'electron'
import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PLUGINS, type PluginStatus } from '../shared/plugins'
import { tm } from './i18n'
import { resetLspServers } from './lsp'
import { detectLanguage, runPlan } from './toolchains'

const isWin = process.platform === 'win32'

/**
 * 应用从 VS Code / Claude Code 的终端里启动时继承到的宿主变量。
 * 带着它们启动的 claude 会以为自己运行在别的宿主里（连到 VS Code 的 IDE 服务、按嵌套会话处理）。
 */
const HOST_VARS = ['ELECTRON_RUN_AS_NODE', 'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SSE_PORT', 'ENABLE_IDE_INTEGRATION', 'CLAUDE_AGENT_SDK_VERSION']

/** 子进程环境：去掉宿主注入的变量 */
export function childEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const k of HOST_VARS) delete env[k]
  return { ...env, ...extra }
}

function run(file: string, args: string[], env = childEnv()): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: 15000, windowsHide: true, env }, (err, stdout) => resolve(err ? null : String(stdout)))
  })
}

/** 在 PATH 里找命令；Windows 上优先 .exe，其次 .cmd（PowerShell 可能禁止运行 .ps1） */
export async function locate(command: string): Promise<string | null> {
  const out = await run(isWin ? 'where.exe' : 'which', [command])
  const hits = (out ?? '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
  const found = isWin ? (hits.find((p) => /\.exe$/i.test(p)) ?? hits.find((p) => /\.cmd$/i.test(p))) : hits[0]
  if (found) return found
  // 应用启动之后才安装的工具不在当前进程的 PATH 里：再查常见的安装位置
  for (const p of fallbackPaths(command)) {
    if (await fs.access(p).then(() => true, () => false)) return p
  }
  return null
}

function fallbackPaths(command: string): string[] {
  const home = os.homedir()
  if (isWin) {
    const appData = process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming')
    return [path.join(home, '.local', 'bin', `${command}.exe`), path.join(appData, 'npm', `${command}.cmd`)]
  }
  return [path.join(home, '.local', 'bin', command), path.join('/usr/local/bin', command), path.join('/opt/homebrew/bin', command), path.join(home, '.npm-global', 'bin', command)]
}

/**
 * 用 Electron 自带的 Node 跑 JS 入口时预先加载的脚本。
 * Electron 是窗口程序，没有控制台；JS 入口（例如 codex.js）再启动 codex.exe 这类控制台程序时，
 * 如果没写 windowsHide，Windows 会给它新开一个控制台窗口（启动时一闪而过的黑框）。
 * 这里把 child_process 的启动函数默认改成 windowsHide: true。
 */
const HIDE_HOOK = `'use strict'
const cp = require('child_process')
const hide = (o) => (o && typeof o === 'object' ? ('windowsHide' in o ? o : { ...o, windowsHide: true }) : { windowsHide: true })
for (const name of ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'fork', 'exec', 'execSync']) {
  const orig = cp[name]
  if (typeof orig !== 'function') continue
  const withArgs = name !== 'exec' && name !== 'execSync'
  cp[name] = function (...a) {
    const i = withArgs && Array.isArray(a[1]) ? 2 : 1
    if (a[i] == null) a[i] = { windowsHide: true }
    else if (typeof a[i] === 'object') a[i] = hide(a[i])
    else a.splice(i, 0, { windowsHide: true })
    return orig.apply(this, a)
  }
}
require('module').syncBuiltinESMExports()
`

let hookFile: Promise<string> | null = null
function hideHook(): Promise<string> {
  hookFile ??= (async () => {
    const file = path.join(app.getPath('userData'), 'hide-child-windows.cjs')
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, HIDE_HOOK, 'utf8')
    return file
  })().catch((e) => {
    hookFile = null
    throw e
  })
  return hookFile
}

export interface Launch {
  file: string
  /** 放在用户参数前面的参数（例如 JS 入口脚本） */
  pre: string[]
  env: NodeJS.ProcessEnv
}

/**
 * 把命令解析成可以直接 spawn 的程序，不经过 cmd.exe：
 * npm 生成的 .cmd 包装脚本里要么直接调用 .exe，要么用 node 跑一个 JS 入口。
 * 后者用 Electron 自带的 Node（ELECTRON_RUN_AS_NODE=1）执行，用户机器上不需要额外的 node。
 */
export async function resolveLaunch(command: string, opts: { systemNode?: boolean } = {}): Promise<Launch | null> {
  const file = await locate(command)
  if (!file) return null
  if (!/\.cmd$/i.test(file)) return { file, pre: [], env: childEnv() }
  const dir = path.dirname(file)
  const text = await fs.readFile(file, 'utf8').catch(() => '')
  const exe = text.match(/"%dp0%\\([^"]+?\.exe)"/i)
  // npm 的包装脚本总会写 "%dp0%\node.exe"（存在时用它跑 JS），那不是真正的程序
  if (exe && !/(^|\\)node\.exe$/i.test(exe[1])) return { file: path.join(dir, exe[1]), pre: [], env: childEnv() }
  const js = text.match(/"%dp0%\\([^"]+?\.(?:c?js|mjs))"/i)
  if (js) {
    const pre = [path.join(dir, js[1])]
    if (isWin) pre.unshift('--require', await hideHook())
    // 有的工具（DeepSeek Harness）会检查运行时，拒绝在 Electron 里运行：用本机安装的 node
    if (opts.systemNode) {
      const node = path.join(dir, 'node.exe')
      const sys = (await fs.access(node).then(() => node, () => null)) ?? (await locate('node'))
      if (!sys) throw new Error(tm('没有找到 Node.js，{0} 需要本机安装的 Node.js', command))
      return { file: sys, pre, env: childEnv() }
    }
    return { file: process.execPath, pre, env: childEnv({ ELECTRON_RUN_AS_NODE: '1' }) }
  }
  return null
}

async function detect(id: string): Promise<PluginStatus> {
  const def = PLUGINS.find((p) => p.id === id)
  if (!def) throw new Error(tm('未知插件：{0}', id))
  if (def.category === 'language') {
    const s = await detectLanguage(id)
    resetLspServers()
    return s
  }
  const file = await locate(def.command)
  if (!file) return { installed: false }
  const l = await resolveLaunch(def.command, { systemNode: def.systemNode }).catch(() => null)
  const out = l ? await run(l.file, [...l.pre, '--version'], l.env) : null
  const version = out?.match(/\d+\.\d+\.\d+[\w.-]*/)?.[0]
  return { installed: true, version, launch: isWin ? path.basename(file) : def.command }
}

export function registerPluginIpc(): void {
  ipcMain.handle('plugins:detect', (_e, id: string) => detect(id))
  ipcMain.handle('plugins:runPlan', async (_e, id: string, file: string) => {
    try {
      return await runPlan(id, file)
    } catch (e) {
      return { error: String((e as Error)?.message ?? e) }
    }
  })
}
