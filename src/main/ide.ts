import { app, ipcMain, type WebContents } from 'electron'
import { randomUUID } from 'node:crypto'
import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { WebSocket, WebSocketServer } from 'ws'
import { IDE_TOOLS, type IdeToolResult } from '../shared/ide'

/**
 * IDE 桥接服务（和官方 VS Code 扩展的做法一致）：
 * 在 127.0.0.1 的随机端口上开一个 WebSocket MCP 服务，把地址和随机令牌写到
 * ~/.claude/ide/<端口>.lock；内置终端里设置 CLAUDE_CODE_SSE_PORT，终端里运行的 claude 会自动连上来。
 *
 * 提供的工具：openDiff（在编辑器里对比并由你接受 / 拒绝修改）、getDiagnostics（语言服务诊断）、
 * close_tab、closeAllDiffTabs；并推送 selection_changed（编辑器选区）和 at_mentioned（插入引用）。
 *
 * 安全：只监听本机；连接必须带 lock 文件里的令牌（lock 文件只有当前用户可读）；
 * 拒绝带 Origin 头的连接（浏览器里的网页发起的连接总会带 Origin）。
 * 工具的实际执行在界面进程里（诊断、标签页都在那里），这里只做协议和转发。
 */

const IDE_NAME = 'Infinite Studio'
const SERVER_NAME = 'Claude Code Infinite Studio MCP'

type Json = Record<string, unknown>

let server: http.Server | null = null
let port: number | null = null
const token = randomUUID()
let lockFile: string | null = null
let folders: string[] = []
/** 当前连接的 claude（同一时间只服务一个，和 VS Code 扩展一致：新连接替换旧连接） */
let client: WebSocket | null = null
/** 执行工具的界面进程 */
let ui: WebContents | null = null
/** 最近一次的选区，新连接建立后补发 */
let lastSelection: Json | null = null

interface Call {
  ws: WebSocket
  rpcId: string | number
  resolve: (r: IdeToolResult) => void
}
const calls = new Map<number, Call>()
let nextCall = 1

/* ---------------- lock 文件 ---------------- */

function lockDir(): string {
  return path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'ide')
}

function writeLock(): void {
  if (port === null) return
  try {
    const dir = lockDir()
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    lockFile = path.join(dir, `${port}.lock`)
    const info = { pid: process.pid, workspaceFolders: folders, ideName: IDE_NAME, transport: 'ws', runningInWindows: process.platform === 'win32', authToken: token }
    writeFileSync(lockFile, JSON.stringify(info), { mode: 0o600 })
  } catch (e) {
    console.error('[ide] 无法写入 lock 文件', e)
  }
}

function removeLock(): void {
  if (!lockFile) return
  try {
    unlinkSync(lockFile)
  } catch {
    /* 已经不在了 */
  }
  lockFile = null
}

/* ---------------- 端口 ---------------- */

function listenOn(s: http.Server, p: number): Promise<boolean> {
  return new Promise((resolve) => {
    const onError = () => {
      s.off('listening', onListening)
      resolve(false)
    }
    const onListening = () => {
      s.off('error', onError)
      resolve(true)
    }
    s.once('error', onError)
    s.once('listening', onListening)
    s.listen(p, '127.0.0.1')
  })
}

/* ---------------- MCP ---------------- */

function send(ws: WebSocket, msg: Json): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ jsonrpc: '2.0', ...msg }))
}

function notify(method: string, params: Json): void {
  if (client) send(client, { method, params })
}

/** 把工具调用交给界面进程执行 */
function runTool(ws: WebSocket, rpcId: string | number, name: string, args: Json): void {
  if (!ui || ui.isDestroyed()) {
    send(ws, { id: rpcId, error: { code: -32603, message: `${IDE_NAME} 窗口未就绪` } })
    return
  }
  const id = nextCall++
  calls.set(id, {
    ws,
    rpcId,
    resolve: (r) => {
      calls.delete(id)
      if (r.error) send(ws, { id: rpcId, error: { code: -32603, message: r.error } })
      else send(ws, { id: rpcId, result: { content: r.content ?? [] } })
    }
  })
  ui.send('ide:call', id, name, args)
}

function cancelCalls(match: (c: Call) => boolean): void {
  for (const [id, c] of calls) {
    if (!match(c)) continue
    calls.delete(id)
    if (ui && !ui.isDestroyed()) ui.send('ide:cancel', id)
  }
}

function onMessage(ws: WebSocket, raw: string): void {
  let msg: Json
  try {
    msg = JSON.parse(raw)
  } catch {
    return
  }
  const method = typeof msg.method === 'string' ? msg.method : null
  const id = msg.id as string | number | undefined
  const params = (msg.params ?? {}) as Json
  if (!method) return // 我们不向对方发请求，收到的回复忽略

  if (id === undefined) {
    // 通知
    if (method === 'notifications/cancelled') {
      const rid = params.requestId
      cancelCalls((c) => c.ws === ws && c.rpcId === rid)
    } else if (method === 'notifications/initialized') {
      // 和 VS Code 扩展一样：连上后补发当前选区
      setTimeout(() => {
        if (lastSelection && client === ws) send(ws, { method: 'selection_changed', params: lastSelection })
      }, 500)
    }
    // ide_connected 等其它通知不需要处理
    return
  }

  switch (method) {
    case 'initialize':
      return send(ws, {
        id,
        result: {
          protocolVersion: typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-06-18',
          capabilities: { tools: { listChanged: true } },
          serverInfo: { name: SERVER_NAME, version: app.getVersion() }
        }
      })
    case 'ping':
      return send(ws, { id, result: {} })
    case 'tools/list':
      return send(ws, { id, result: { tools: IDE_TOOLS } })
    case 'tools/call': {
      const name = String(params.name ?? '')
      if (!IDE_TOOLS.some((t) => t.name === name)) return send(ws, { id, error: { code: -32602, message: `Tool ${name} not found` } })
      const args = params.arguments && typeof params.arguments === 'object' ? (params.arguments as Json) : {}
      return runTool(ws, id, name, args)
    }
    case 'resources/list':
      return send(ws, { id, result: { resources: [] } })
    case 'prompts/list':
      return send(ws, { id, result: { prompts: [] } })
    default:
      return send(ws, { id, error: { code: -32601, message: `Method not found: ${method}` } })
  }
}

/* ---------------- 启动 ---------------- */

export async function startIdeServer(): Promise<void> {
  if (server) return
  const s = http.createServer((_req, res) => {
    res.writeHead(404)
    res.end()
  })
  let ok = false
  for (let i = 0; i < 50 && !ok; i++) {
    const p = 10000 + Math.floor(Math.random() * 55536)
    if (await listenOn(s, p)) {
      port = p
      ok = true
    }
  }
  if (!ok) {
    console.error('[ide] 找不到可用端口，IDE 桥接未启动')
    return
  }
  server = s
  const wss = new WebSocketServer({ server: s, maxPayload: 64 * 1024 * 1024 })
  wss.on('error', () => {})
  wss.on('connection', (ws, req) => {
    if (req.headers['x-claude-code-ide-authorization'] !== token || req.headers.origin) {
      ws.close(1008, 'Unauthorized')
      return
    }
    if (client) {
      const old = client
      cancelCalls((c) => c.ws === old)
      try {
        old.close(1000, 'A newer Claude Code session connected')
      } catch {
        /* 忽略 */
      }
    }
    client = ws
    emitStatus()
    ws.on('message', (data) => onMessage(ws, data.toString()))
    ws.on('error', () => {})
    ws.on('close', () => {
      cancelCalls((c) => c.ws === ws)
      if (client === ws) {
        client = null
        emitStatus()
      }
    })
  })
  writeLock()
  app.on('will-quit', removeLock)
  process.on('exit', removeLock)
}

function emitStatus(): void {
  if (ui && !ui.isDestroyed()) ui.send('ide:status', client !== null)
}

/** 内置终端的环境变量：终端里运行的 claude 据此自动连到本 IDE */
export function ideTerminalEnv(): Record<string, string> {
  return port === null ? {} : { CLAUDE_CODE_SSE_PORT: String(port) }
}

export function registerIdeIpc(): void {
  // 界面进程就绪后登记自己，工具调用发到这里
  ipcMain.on('ide:register', (e) => {
    ui = e.sender
    e.sender.once('destroyed', () => {
      if (ui === e.sender) {
        ui = null
        cancelCalls(() => true)
      }
    })
    emitStatus()
  })
  ipcMain.on('ide:result', (e, id: number, result: IdeToolResult) => {
    if (e.sender !== ui) return
    calls.get(id)?.resolve(result && typeof result === 'object' ? result : { error: '无效的结果' })
  })
  ipcMain.on('ide:workspace', (e, list: unknown) => {
    if (e.sender !== ui || !Array.isArray(list)) return
    folders = list.filter((x): x is string => typeof x === 'string' && path.isAbsolute(x))
    writeLock()
  })
  ipcMain.on('ide:selection', (e, sel: Json) => {
    if (e.sender !== ui || !sel || typeof sel !== 'object') return
    lastSelection = sel
    notify('selection_changed', sel)
  })
  ipcMain.handle('ide:atMention', (e, params: Json) => {
    if (e.sender !== ui || !client || !params || typeof params !== 'object') return false
    notify('at_mentioned', params)
    return true
  })
}
