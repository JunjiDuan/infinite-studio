import { app, ipcMain, type WebContents } from 'electron'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import type { LspServerInfo } from '../shared/types'

interface Launch {
  cmd: string
  args: string[]
  shell: boolean
}

interface ServerDef extends LspServerInfo {
  resolve(): Launch | null
}

function which(cmd: string): string | null {
  try {
    const out = execFileSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
    return out.split(/\r?\n/).find(Boolean)?.trim() ?? null
  } catch {
    return null
  }
}

/** 按顺序找第一个装了的命令；Windows 上的 .cmd 包装需要通过 shell 启动 */
function firstOnPath(candidates: [string, string[]][]): Launch | null {
  for (const [cmd, args] of candidates) {
    const p = which(cmd)
    if (!p) continue
    const shell = /\.(cmd|bat)$/i.test(p)
    return { cmd: shell ? `"${p}"` : p, args, shell }
  }
  return null
}

/**
 * TypeScript 7 原生编译器自带 LSP，随应用一起打包。
 * 它要从可执行文件旁边读取 lib.*.d.ts，所以打包时整个目录作为 extraResources 原样复制到 resources/typescript-native
 * （electron-builder 会过滤掉 node_modules 里的 .d.ts，不能走 asar）。
 */
function bundledTypeScript(): Launch | null {
  const exeName = process.platform === 'win32' ? 'tsc.exe' : 'tsc'
  const exe = app.isPackaged
    ? path.join(process.resourcesPath, 'typescript-native', exeName)
    : path.join(app.getAppPath(), 'node_modules', '@typescript', `typescript-${process.platform}-${process.arch}`, 'lib', exeName)
  return existsSync(exe) ? { cmd: exe, args: ['--lsp', '--stdio'], shell: false } : null
}

const DEFS: ServerDef[] = [
  { id: 'typescript', name: 'TypeScript', languages: ['typescript', 'javascript'], resolve: bundledTypeScript },
  {
    id: 'python',
    name: 'Python',
    languages: ['python'],
    resolve: () => firstOnPath([['pyright-langserver', ['--stdio']], ['basedpyright-langserver', ['--stdio']], ['pylsp', []]])
  },
  { id: 'rust', name: 'Rust', languages: ['rust'], resolve: () => firstOnPath([['rust-analyzer', []]]) },
  { id: 'go', name: 'Go', languages: ['go'], resolve: () => firstOnPath([['gopls', []]]) },
  { id: 'cpp', name: 'C/C++', languages: ['cpp', 'c'], resolve: () => firstOnPath([['clangd', []]]) }
]

let resolved: Map<string, Launch> | null = null
function resolveAll(): Map<string, Launch> {
  if (!resolved) {
    resolved = new Map()
    for (const d of DEFS) {
      const l = d.resolve()
      if (l) resolved.set(d.id, l)
    }
  }
  return resolved
}

/** LSP 基于 Content-Length 分帧 */
class Framer {
  private buf = Buffer.alloc(0)
  constructor(private onMessage: (msg: unknown) => void) {}
  push(chunk: Buffer): void {
    this.buf = Buffer.concat([this.buf, chunk])
    for (;;) {
      const sep = this.buf.indexOf('\r\n\r\n')
      if (sep < 0) return
      const m = /Content-Length:\s*(\d+)/i.exec(this.buf.subarray(0, sep).toString('ascii'))
      if (!m) {
        // 头部损坏：丢掉这一段，避免死循环
        this.buf = this.buf.subarray(sep + 4)
        continue
      }
      const len = Number(m[1])
      if (this.buf.length < sep + 4 + len) return
      const body = this.buf.subarray(sep + 4, sep + 4 + len).toString('utf8')
      this.buf = this.buf.subarray(sep + 4 + len)
      try {
        this.onMessage(JSON.parse(body))
      } catch (e) {
        console.warn('LSP 消息解析失败', e)
      }
    }
  }
}

interface Session {
  proc: ChildProcess
  wc: WebContents
  stderr: string
}

const sessions = new Map<number, Session>()
let nextId = 1

function killSession(id: number): void {
  const s = sessions.get(id)
  if (!s) return
  sessions.delete(id)
  if (s.proc.exitCode === null) s.proc.kill()
}

export function registerLspIpc(): void {
  ipcMain.handle('lsp:servers', (): LspServerInfo[] => {
    const r = resolveAll()
    return DEFS.filter((d) => r.has(d.id)).map(({ id, name, languages }) => ({ id, name, languages }))
  })

  ipcMain.handle('lsp:start', (e, serverId: string, root: string) => {
    const launch = resolveAll().get(serverId)
    if (!launch) throw new Error('没有可用的语言服务：' + serverId)
    const env: Record<string, string> = {}
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
    delete env.ELECTRON_RUN_AS_NODE
    const proc = spawn(launch.cmd, launch.args, { cwd: root, env, shell: launch.shell, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    const id = nextId++
    const wc = e.sender
    const session: Session = { proc, wc, stderr: '' }
    sessions.set(id, session)
    const framer = new Framer((msg) => {
      if (!wc.isDestroyed()) wc.send('lsp:message', id, msg)
    })
    proc.stdout!.on('data', (d: Buffer) => framer.push(d))
    proc.stderr!.on('data', (d: Buffer) => {
      session.stderr = (session.stderr + d.toString('utf8')).slice(-4000)
    })
    const exited = (code: number | null) => {
      if (!sessions.has(id)) return
      sessions.delete(id)
      if (!wc.isDestroyed()) wc.send('lsp:exit', id, code ?? -1, session.stderr)
    }
    proc.on('exit', exited)
    proc.on('error', (err) => {
      session.stderr += '\n' + String(err)
      exited(-1)
    })
    proc.stdin!.on('error', () => {
      /* 进程已退出时写入会报 EPIPE，忽略 */
    })
    wc.once('destroyed', () => killSession(id))
    return id
  })

  ipcMain.on('lsp:send', (_e, id: number, msg: unknown) => {
    const s = sessions.get(id)
    if (!s || !s.proc.stdin?.writable) return
    const body = Buffer.from(JSON.stringify(msg), 'utf8')
    s.proc.stdin.write(`Content-Length: ${body.length}\r\n\r\n`)
    s.proc.stdin.write(body)
  })

  // 客户端会先发 shutdown/exit；2 秒后还没退出就强制结束
  ipcMain.on('lsp:stop', (_e, id: number) => {
    setTimeout(() => killSession(id), 2000)
  })

  app.on('before-quit', () => {
    for (const id of [...sessions.keys()]) killSession(id)
  })
}
