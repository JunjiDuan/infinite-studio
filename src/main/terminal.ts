import { ipcMain, type WebContents } from 'electron'
import { execFileSync } from 'node:child_process'
import os from 'node:os'
import type { IPty } from '@lydell/node-pty'
import { childEnv } from './plugins'
import { ideTerminalEnv } from './ide'

interface Term {
  pty: IPty
  wc: WebContents
}

const terms = new Map<number, Term>()
let nextId = 1
let shellCache: { file: string; args: string[] } | null = null

function onPath(cmd: string): boolean {
  try {
    execFileSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { stdio: 'ignore', windowsHide: true })
    return true
  } catch {
    return false
  }
}

function pickShell(): { file: string; args: string[] } {
  if (shellCache) return shellCache
  if (process.platform === 'win32') {
    shellCache = onPath('pwsh.exe') ? { file: 'pwsh.exe', args: ['-NoLogo'] } : { file: 'powershell.exe', args: ['-NoLogo'] }
  } else {
    shellCache = { file: process.env.SHELL || '/bin/bash', args: ['-l'] }
  }
  return shellCache
}

// node-pty 是原生模块，延迟加载：加载失败时只影响终端，不影响整个应用
let ptyModule: typeof import('@lydell/node-pty') | null = null
function loadPty(): typeof import('@lydell/node-pty') {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  if (!ptyModule) ptyModule = require('@lydell/node-pty') as typeof import('@lydell/node-pty')
  return ptyModule
}

export function registerTerminalIpc(): void {
  ipcMain.handle('term:create', (e, opts: { cwd?: string; cols: number; rows: number }) => {
    const pty = loadPty()
    const shell = pickShell()
    const env: Record<string, string> = {}
    // 不要把宿主注入的变量（ELECTRON_RUN_AS_NODE、CLAUDECODE 等）带进用户的 shell：
    // 否则在终端里运行 claude 会被当成嵌套会话，或者连到 VS Code 的 IDE 服务
    for (const [k, v] of Object.entries(childEnv(ideTerminalEnv()))) if (v !== undefined) env[k] = v
    env.TERM_PROGRAM = 'InfiniteStudio'
    env.COLORTERM = 'truecolor'
    const proc = pty.spawn(shell.file, shell.args, {
      name: 'xterm-256color',
      cols: Math.max(2, opts.cols | 0),
      rows: Math.max(1, opts.rows | 0),
      cwd: opts.cwd || os.homedir(),
      env
    })
    const id = nextId++
    const wc = e.sender
    terms.set(id, { pty: proc, wc })
    proc.onData((data) => {
      if (!wc.isDestroyed()) wc.send('term:data', id, data)
    })
    proc.onExit(({ exitCode }) => {
      terms.delete(id)
      if (!wc.isDestroyed()) wc.send('term:exit', id, exitCode)
    })
    wc.once('destroyed', () => {
      const t = terms.get(id)
      if (t) {
        t.pty.kill()
        terms.delete(id)
      }
    })
    return { id, shell: shell.file.replace(/\.exe$/i, '') }
  })

  ipcMain.on('term:write', (_e, id: number, data: string) => terms.get(id)?.pty.write(data))
  ipcMain.on('term:resize', (_e, id: number, cols: number, rows: number) => {
    try {
      terms.get(id)?.pty.resize(Math.max(2, cols | 0), Math.max(1, rows | 0))
    } catch {
      // 进程刚退出时 resize 会抛错，忽略
    }
  })
  ipcMain.on('term:kill', (_e, id: number) => {
    const t = terms.get(id)
    if (!t) return
    t.pty.kill()
    terms.delete(id)
  })
}
