import { app, ipcMain, type WebContents } from 'electron'
import { randomUUID } from 'node:crypto'
import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { WebSocket, WebSocketServer } from 'ws'
import { IDE_TOOLS, type IdeToolResult } from '../shared/ide'
import { tm } from './i18n'

/**
 * IDE 桥接服务（和官方 VS Code 扩展的做法一致）：
 * 在 127.0.0.1 的随机端口上开一个 WebSocket MCP 服务，把地址和随机令牌写到
 * ~/.claude/ide/<端口>.lock；内置终端里设置 CLAUDE_CODE_SSE_PORT，终端里运行的 claude 会自动连上来。
 *
 * 提供的工具：openDiff（在编辑器里对比并由你接受 / 拒绝修改）、getDiagnostics（语言服务诊断）、
 * close_tab、closeAllDiffTabs；并推送 selection_changed（编辑器选区）和 at_mentioned（插入引用）。
 *
 * 每个窗口一个服务（各自的端口、令牌、lock 文件和工作区），和 VS Code 每个窗口一个扩展宿主一致：
 * 窗口 A 终端里的 claude 只连窗口 A，openDiff 不会跑到别的窗口，关掉别的窗口也不影响它。
 *
 * 安全：只监听本机；连接必须带 lock 文件里的令牌（lock 文件只有当前用户可读）；
 * 拒绝带 Origin 头的连接（浏览器里的网页发起的连接总会带 Origin）。
 * 工具的实际执行在界面进程里（诊断、标签页都在那里），这里只做协议和转发。
 */

const IDE_NAME = 'Infinite Studio'
const SERVER_NAME = 'Claude Code Infinite Studio MCP'

type Json = Record<string, unknown>

interface Call {
  ws: WebSocket
  rpcId: string | number
  resolve: (r: IdeToolResult) => void
}

/** 一个窗口的桥接服务 */
interface Bridge {
  /** 执行工具的界面进程（就是这个窗口） */
  wc: WebContents
  server: http.Server
  port: number
  token: string
  lockFile: string | null
  folders: string[]
  /** 界面进程是否已经登记（登记之后才能执行工具） */
  ready: boolean
  /** 当前连接的 claude（同一时间只服务一个，和 VS Code 扩展一致：新连接替换旧连接） */
  client: WebSocket | null
  /** 最近一次的选区，新连接建立后补发 */
  lastSelection: Json | null
  calls: Map<number, Call>
}

/** webContents id → 桥接服务（创建中的也在这里，避免重复创建） */
const bridges = new Map<number, Promise<Bridge | null>>()
const live = new Map<number, Bridge>()
let nextCall = 1

/* ---------------- lock 文件 ---------------- */

function lockDir(): string {
  return path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'ide')
}

function writeLock(b: Bridge): void {
  try {
    const dir = lockDir()
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    b.lockFile = path.join(dir, `${b.port}.lock`)
    const info = { pid: process.pid, workspaceFolders: b.folders, ideName: IDE_NAME, transport: 'ws', runningInWindows: process.platform === 'win32', authToken: b.token }
    writeFileSync(b.lockFile, JSON.stringify(info), { mode: 0o600 })
  } catch (e) {
    console.error('[ide] 无法写入 lock 文件', e)
  }
}

function removeLock(b: Bridge): void {
  if (!b.lockFile) return
  try {
    unlinkSync(b.lockFile)
  } catch {
    /* 已经不在了 */
  }
  b.lockFile = null
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

function notify(b: Bridge, method: string, params: Json): void {
  if (b.client) send(b.client, { method, params })
}

/** 把工具调用交给这个窗口的界面进程执行 */
function runTool(b: Bridge, ws: WebSocket, rpcId: string | number, name: string, args: Json): void {
  if (!b.ready || b.wc.isDestroyed()) {
    send(ws, { id: rpcId, error: { code: -32603, message: tm('{0} 窗口未就绪', IDE_NAME) } })
    return
  }
  const id = nextCall++
  b.calls.set(id, {
    ws,
    rpcId,
    resolve: (r) => {
      b.calls.delete(id)
      if (r.error) send(ws, { id: rpcId, error: { code: -32603, message: r.error } })
      else send(ws, { id: rpcId, result: { content: r.content ?? [] } })
    }
  })
  b.wc.send('ide:call', id, name, args)
}

function cancelCalls(b: Bridge, match: (c: Call) => boolean): void {
  for (const [id, c] of b.calls) {
    if (!match(c)) continue
    b.calls.delete(id)
    if (!b.wc.isDestroyed()) b.wc.send('ide:cancel', id)
  }
}

function onMessage(b: Bridge, ws: WebSocket, raw: string): void {
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
      cancelCalls(b, (c) => c.ws === ws && c.rpcId === rid)
    } else if (method === 'notifications/initialized') {
      // 和 VS Code 扩展一样：连上后补发当前选区
      setTimeout(() => {
        if (b.lastSelection && b.client === ws) send(ws, { method: 'selection_changed', params: b.lastSelection })
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
      return runTool(b, ws, id, name, args)
    }
    case 'resources/list':
      return send(ws, { id, result: { resources: [] } })
    case 'prompts/list':
      return send(ws, { id, result: { prompts: [] } })
    default:
      return send(ws, { id, error: { code: -32601, message: `Method not found: ${method}` } })
  }
}

/* ---------------- 启动 / 关闭 ---------------- */

async function createBridge(wc: WebContents): Promise<Bridge | null> {
  const s = http.createServer((_req, res) => {
    res.writeHead(404)
    res.end()
  })
  let port: number | null = null
  for (let i = 0; i < 50 && port === null; i++) {
    const p = 10000 + Math.floor(Math.random() * 55536)
    if (await listenOn(s, p)) port = p
  }
  if (port === null) {
    console.error('[ide] 找不到可用端口，IDE 桥接未启动')
    return null
  }
  // 端口找好之前窗口就关了
  if (wc.isDestroyed()) {
    s.close()
    return null
  }
  const b: Bridge = { wc, server: s, port, token: randomUUID(), lockFile: null, folders: [], ready: false, client: null, lastSelection: null, calls: new Map() }
  const wss = new WebSocketServer({ server: s, maxPayload: 64 * 1024 * 1024 })
  wss.on('error', () => {})
  wss.on('connection', (ws, req) => {
    if (req.headers['x-claude-code-ide-authorization'] !== b.token || req.headers.origin) {
      ws.close(1008, 'Unauthorized')
      return
    }
    if (b.client) {
      const old = b.client
      cancelCalls(b, (c) => c.ws === old)
      try {
        old.close(1000, 'A newer Claude Code session connected')
      } catch {
        /* 忽略 */
      }
    }
    b.client = ws
    emitStatus(b)
    ws.on('message', (data) => onMessage(b, ws, data.toString()))
    ws.on('error', () => {})
    ws.on('close', () => {
      cancelCalls(b, (c) => c.ws === ws)
      if (b.client === ws) {
        b.client = null
        emitStatus(b)
      }
    })
  })
  live.set(wc.id, b)
  writeLock(b)
  wc.once('destroyed', () => closeBridge(wc.id))
  return b
}

function closeBridge(id: number): void {
  const b = live.get(id)
  bridges.delete(id)
  if (!b) return
  live.delete(id)
  b.calls.clear()
  removeLock(b)
  try {
    b.client?.close(1001, 'IDE window closed')
  } catch {
    /* 忽略 */
  }
  b.server.close()
}

/** 这个窗口的桥接服务，没有就创建（终端创建时要用到它的端口） */
function ensureBridge(wc: WebContents): Promise<Bridge | null> {
  let p = bridges.get(wc.id)
  if (!p) {
    p = createBridge(wc).catch((e) => {
      console.error('[ide] 桥接服务启动失败', e)
      bridges.delete(wc.id)
      return null
    })
    bridges.set(wc.id, p)
  }
  return p
}

function emitStatus(b: Bridge): void {
  if (b.ready && !b.wc.isDestroyed()) b.wc.send('ide:status', b.client !== null)
}

/** 内置终端的环境变量：终端里运行的 claude 据此自动连到它所在窗口的 IDE 服务 */
export async function ideTerminalEnv(wc: WebContents): Promise<Record<string, string>> {
  const b = await ensureBridge(wc)
  return b ? { CLAUDE_CODE_SSE_PORT: String(b.port) } : {}
}

export function registerIdeIpc(): void {
  // 退出时删掉所有窗口的 lock 文件
  const removeAll = () => live.forEach(removeLock)
  app.on('will-quit', removeAll)
  process.on('exit', removeAll)

  // 界面进程就绪后登记自己，这个窗口的工具调用发到这里
  ipcMain.on('ide:register', (e) => {
    void ensureBridge(e.sender).then((b) => {
      if (!b) return
      b.ready = true
      emitStatus(b)
    })
  })
  ipcMain.on('ide:result', (e, id: number, result: IdeToolResult) => {
    live.get(e.sender.id)?.calls.get(id)?.resolve(result && typeof result === 'object' ? result : { error: '无效的结果' })
  })
  ipcMain.on('ide:workspace', (e, list: unknown) => {
    if (!Array.isArray(list)) return
    const folders = list.filter((x): x is string => typeof x === 'string' && path.isAbsolute(x))
    void ensureBridge(e.sender).then((b) => {
      if (!b) return
      b.folders = folders
      writeLock(b)
    })
  })
  ipcMain.on('ide:selection', (e, sel: Json) => {
    const b = live.get(e.sender.id)
    if (!b || !sel || typeof sel !== 'object') return
    b.lastSelection = sel
    notify(b, 'selection_changed', sel)
  })
  ipcMain.handle('ide:atMention', (e, params: Json) => {
    const b = live.get(e.sender.id)
    if (!b || !b.client || !params || typeof params !== 'object') return false
    notify(b, 'at_mentioned', params)
    return true
  })
}
