import { app, ipcMain, type WebContents } from 'electron'
import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { createReadStream, promises as fs } from 'node:fs'
import { randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { PLUGINS } from '../shared/plugins'
import { CLAUDE_MODES, type AgentStart, type ClaudeLoginMethod, type LoginEvent, type SessionInfo } from '../shared/agents'
import { resolveLaunch } from './plugins'
import { PANEL_MCP_SERVER, PANEL_TOOLS } from '../shared/ide'
import { dailyUsage } from './usage'
import { tm } from './i18n'

/**
 * 对话进程的传输层。协议逻辑在界面里（renderer/src/agent/*），这里只负责：
 * 启动进程、按行收发 JSON、校验界面发来的消息类型、读取 Claude 的本地会话记录。
 *
 * - Claude Code：每个对话一个 `claude -p --input-format stream-json` 常驻进程
 * - Codex：每个对话一个 `codex app-server` 常驻进程（JSON-RPC）
 */

interface Run {
  proc: ChildProcess
  wc: WebContents
  plugin: string
}

const runs = new Map<number, Run>()
let nextId = 1

const SAFE_ID = /^[\w-]{1,128}$/
const MODEL_RE = /^[\w.:\[\]/-]{1,100}$/
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']

/** 界面可以发给 Claude 的控制请求 */
const CLAUDE_CONTROL = new Set([
  'initialize',
  'interrupt',
  'set_permission_mode',
  'set_model',
  'set_max_thinking_tokens',
  'rewind_files',
  'get_context_usage',
  'mcp_status'
])

/** 界面可以调用的 Codex app-server 方法 */
const CODEX_METHODS = new Set([
  'initialize',
  'thread/start',
  'thread/resume',
  'thread/read',
  'thread/list',
  'thread/name/set',
  'thread/compact/start',
  'thread/archive',
  'turn/start',
  'turn/steer',
  'turn/interrupt',
  'review/start',
  'model/list',
  'account/read',
  'account/login/start',
  'account/login/cancel',
  'account/logout',
  'account/rateLimits/read',
  'skills/list',
  'fuzzyFileSearch'
])

function claudeArgs(req: AgentStart): string[] {
  const mode = req.mode && CLAUDE_MODES.some((m) => m.id === req.mode) ? req.mode : 'default'
  if (req.resume && !SAFE_ID.test(req.resume)) throw new Error('无效的会话 id')
  if (req.resumeAt && !SAFE_ID.test(req.resumeAt)) throw new Error('无效的消息 id')
  if (req.model && !MODEL_RE.test(req.model)) throw new Error('无效的模型')
  if (req.effort && !EFFORTS.includes(req.effort)) throw new Error('无效的思考强度')
  return [
    '-p',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--replay-user-messages',
    '--permission-prompt-tool',
    'stdio',
    '--permission-mode',
    mode,
    // 和 VS Code 扩展一样：允许之后在界面里切换到“跳过权限”
    '--allow-dangerously-skip-permissions',
    // 编辑器提供的工具（getDiagnostics），通过 control_request: mcp_message 在界面里执行
    '--mcp-config',
    JSON.stringify({ mcpServers: { [PANEL_MCP_SERVER]: { type: 'sdk', name: PANEL_MCP_SERVER } } }),
    // 只读工具，不用每次授权
    '--allowedTools',
    PANEL_TOOLS.filter((t) => t.annotations?.readOnlyHint).map((t) => `mcp__${PANEL_MCP_SERVER}__${t.name}`).join(','),
    ...(req.model ? ['--model', req.model] : []),
    ...(req.effort ? ['--effort', req.effort] : []),
    ...(req.resume ? ['--resume', req.resume] : []),
    ...(req.resume && req.resumeAt ? ['--resume-session-at', req.resumeAt] : [])
  ]
}

function kill(r: Run): void {
  const pid = r.proc.pid
  if (!pid || r.proc.exitCode !== null) return
  if (process.platform === 'win32') execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }, () => {})
  else r.proc.kill('SIGTERM')
}

async function start(wc: WebContents, req: AgentStart): Promise<number> {
  const def = PLUGINS.find((p) => p.id === req.plugin)
  if (!def) throw new Error(tm('未知插件'))
  const args = req.plugin === 'claude' ? claudeArgs(req) : req.plugin === 'codex' ? ['app-server'] : null
  if (!args) throw new Error(tm('未知插件：{0}', req.plugin))
  const launch = await resolveLaunch(def.command)
  if (!launch) throw new Error(tm('没有找到 {0} 命令行工具，请先在插件页安装', def.name))

  let cwd = os.homedir()
  if (req.cwd) {
    const st = await fs.stat(req.cwd).catch(() => null)
    if (st?.isDirectory()) cwd = req.cwd
  }
  const env = { ...launch.env }
  if (req.plugin === 'claude') {
    // 文件检查点：支持“回退代码”
    env.CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING = 'true'
  }

  const proc = spawn(launch.file, [...launch.pre, ...args], { cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  const id = nextId++
  const run: Run = { proc, wc, plugin: req.plugin }
  runs.set(id, run)
  const send = (ch: string, ...a: unknown[]) => {
    if (!wc.isDestroyed()) wc.send(ch, id, ...a)
  }

  // stdout：一行一个 JSON
  let buf = ''
  proc.stdout!.setEncoding('utf8')
  proc.stdout!.on('data', (chunk: string) => {
    buf += chunk
    let i: number
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim()
      buf = buf.slice(i + 1)
      if (!line) continue
      let ev: unknown
      try {
        ev = JSON.parse(line)
      } catch {
        send('agent:event', { type: '__text', text: line })
        continue
      }
      send('agent:event', ev)
    }
  })
  let stderr = ''
  proc.stderr!.setEncoding('utf8')
  proc.stderr!.on('data', (d: string) => {
    stderr = (stderr + d).slice(-8000)
  })
  proc.stdin!.on('error', () => {})
  proc.on('error', (err) => {
    stderr += String(err)
  })
  proc.on('close', (code) => {
    runs.delete(id)
    send('agent:exit', code ?? -1, stderr.trim())
  })
  wc.once('destroyed', () => {
    const r = runs.get(id)
    if (r) kill(r)
  })
  return id
}

/** 校验界面发给进程的消息，只放行协议里用得到的那几类 */
function allowed(plugin: string, msg: Record<string, unknown>): boolean {
  if (!msg || typeof msg !== 'object') return false
  if (plugin === 'claude') {
    if (msg.type === 'user') return true
    if (msg.type === 'control_response') return true
    if (msg.type === 'control_request') {
      const sub = (msg.request as { subtype?: string } | undefined)?.subtype
      return typeof sub === 'string' && CLAUDE_CONTROL.has(sub)
    }
    return false
  }
  if (plugin === 'codex') {
    // 通知
    if (msg.method === 'initialized' && msg.id === undefined) return true
    // 请求
    if (typeof msg.method === 'string') return CODEX_METHODS.has(msg.method) && (typeof msg.id === 'number' || typeof msg.id === 'string')
    // 对服务器请求（授权等）的回复
    return msg.id !== undefined && ('result' in msg || 'error' in msg)
  }
  return false
}

/* ---------------- Claude 本地会话记录 ---------------- */

function claudeHome(): string {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
}

/** ~/.claude/projects 下对应某个工作目录的文件夹（Windows 上盘符大小写可能不同，都算） */
async function projectDirs(cwd: string): Promise<string[]> {
  const base = path.join(claudeHome(), 'projects')
  const enc = cwd.replace(/[^a-zA-Z0-9]/g, '-')
  const names = await fs.readdir(base).catch(() => [] as string[])
  const hit = names.filter((n) => (process.platform === 'win32' ? n.toLowerCase() === enc.toLowerCase() : n === enc))
  return hit.map((n) => path.join(base, n))
}

async function readSlice(file: string, start: number, len: number): Promise<string> {
  const fh = await fs.open(file, 'r')
  try {
    const b = Buffer.alloc(len)
    const { bytesRead } = await fh.read(b, 0, len, start)
    return b.subarray(0, bytesRead).toString('utf8')
  } finally {
    await fh.close()
  }
}

function userText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('\n')
}

/** 去掉界面自动附带的上下文标签，得到用户真正输入的内容 */
function cleanPrompt(s: string): string {
  return s
    .replace(/<(ide_opened_file|ide_selection|system-reminder)>[\s\S]*?<\/\1>/g, '')
    .replace(/<command-(?:message|args)>[\s\S]*?<\/command-(?:message|args)>/g, '')
    .replace(/<command-name>([\s\S]*?)<\/command-name>/g, '$1')
    .trim()
}

async function sessionTitle(file: string, size: number): Promise<string | null> {
  const TAIL = 256 * 1024
  const tail = await readSlice(file, Math.max(0, size - TAIL), Math.min(size, TAIL))
  let custom = ''
  let ai = ''
  let summary = ''
  let last = ''
  for (const line of tail.split('\n')) {
    if (!line.startsWith('{"type":"')) continue
    try {
      const o = JSON.parse(line)
      if (o.type === 'custom-title' && o.customTitle) custom = o.customTitle
      else if (o.type === 'ai-title' && o.aiTitle) ai = o.aiTitle
      else if (o.type === 'summary' && o.summary) summary = o.summary
      else if (o.type === 'last-prompt' && o.lastPrompt) last = o.lastPrompt
    } catch {
      /* 截断的行 */
    }
  }
  const t = custom || ai || summary || cleanPrompt(last)
  if (t) return t
  // 再从开头找第一条用户消息
  const head = await readSlice(file, 0, Math.min(size, 128 * 1024))
  for (const line of head.split('\n')) {
    if (!line.includes('"type":"user"')) continue
    try {
      const o = JSON.parse(line)
      if (o.type !== 'user' || o.isMeta || o.isSidechain) continue
      const s = cleanPrompt(userText(o.message?.content))
      if (s) return s
    } catch {
      /* ignore */
    }
  }
  return null
}

async function claudeSessions(cwd: string): Promise<SessionInfo[]> {
  const out: SessionInfo[] = []
  for (const dir of await projectDirs(cwd)) {
    const names = await fs.readdir(dir).catch(() => [] as string[])
    await Promise.all(
      names
        .filter((n) => n.endsWith('.jsonl') && SAFE_ID.test(n.slice(0, -6)))
        .map(async (n) => {
          const file = path.join(dir, n)
          const st = await fs.stat(file).catch(() => null)
          if (!st || st.size === 0) return
          const title = await sessionTitle(file, st.size).catch(() => null)
          if (title) out.push({ id: n.slice(0, -6), title: title.replace(/\s+/g, ' ').slice(0, 120), updatedAt: st.mtimeMs })
        })
    )
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 200)
}

/** 图片内容太大，读取历史时只保留占位 */
function stripImages(content: unknown): unknown {
  if (!Array.isArray(content)) return content
  return content.map((b) => {
    if (b?.type === 'image') return { type: 'image', omitted: true }
    if (b?.type === 'tool_result' && Array.isArray(b.content)) return { ...b, content: stripImages(b.content) }
    return b
  })
}

/**
 * 读取一个 Claude 会话，按 parentUuid 链从最后一条往回走（回退过的分支不显示），
 * 返回可直接按实时事件处理的 user / assistant 消息。
 */
async function claudeTranscript(cwd: string, id: string): Promise<unknown[]> {
  if (!SAFE_ID.test(id)) throw new Error('无效的会话 id')
  let file: string | null = null
  for (const dir of await projectDirs(cwd)) {
    const f = path.join(dir, id + '.jsonl')
    if (await fs.stat(f).then(() => true, () => false)) file = f
  }
  if (!file) throw new Error(tm('找不到这个会话'))

  const parent = new Map<string, string | null>()
  const keep = new Map<string, Record<string, unknown>>()
  let leaf: string | null = null
  const rl = readline.createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity })
  for await (const line of rl) {
    if (!line) continue
    let o: Record<string, unknown>
    try {
      o = JSON.parse(line)
    } catch {
      continue
    }
    const uuid = typeof o.uuid === 'string' ? o.uuid : null
    if (!uuid) continue
    const p = (typeof o.parentUuid === 'string' ? o.parentUuid : null) ?? (typeof o.logicalParentUuid === 'string' ? o.logicalParentUuid : null)
    parent.set(uuid, p)
    if ((o.type === 'user' || o.type === 'assistant') && !o.isSidechain) {
      leaf = uuid
      const msg = o.message as Record<string, unknown> | undefined
      if (o.isMeta || !msg) continue
      keep.set(uuid, {
        type: o.type,
        uuid,
        timestamp: o.timestamp,
        isCompactSummary: o.isCompactSummary || undefined,
        message: { ...msg, content: stripImages(msg.content) },
        tool_use_result: o.toolUseResult && typeof o.toolUseResult === 'object' ? o.toolUseResult : undefined
      })
    }
  }
  const chain: Record<string, unknown>[] = []
  const seen = new Set<string>()
  for (let u = leaf; u && !seen.has(u); u = parent.get(u) ?? null) {
    seen.add(u)
    const e = keep.get(u)
    if (e) chain.push(e)
  }
  return chain.reverse().slice(-800)
}

/* ---------------- 粘贴的图片（Codex 用本地文件） ---------------- */

const IMG_RE = /^data:image\/(png|jpeg|gif|webp);base64,([A-Za-z0-9+/=]+)$/

async function saveImage(dataUrl: string): Promise<string> {
  const m = typeof dataUrl === 'string' ? dataUrl.match(IMG_RE) : null
  if (!m) throw new Error(tm('不支持的图片格式'))
  const bytes = Buffer.from(m[2], 'base64')
  if (bytes.length > 20 * 1024 * 1024) throw new Error(tm('图片超过 20 MB'))
  const dir = path.join(app.getPath('temp'), 'infinite-studio', 'images')
  await fs.mkdir(dir, { recursive: true })
  const file = path.join(dir, `${randomUUID()}.${m[1] === 'jpeg' ? 'jpg' : m[1]}`)
  await fs.writeFile(file, bytes)
  return file
}

/* ---------------- Claude 登录（claude auth login） ---------------- */

interface LoginRun {
  proc: ChildProcess
  wc: WebContents
}

const logins = new Map<number, LoginRun>()
let nextLoginId = 1

/** 去掉 ANSI 控制序列 */
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07]*(\x07|\x1b\\)/g, '')

async function claudeLogin(wc: WebContents, method: ClaudeLoginMethod): Promise<number> {
  const def = PLUGINS.find((p) => p.id === 'claude')!
  const launch = await resolveLaunch(def.command)
  if (!launch) throw new Error(tm('没有找到 Claude Code 命令行工具，请先在插件页安装'))
  // 同一个窗口同时只跑一个登录流程
  for (const [id, r] of logins) if (r.wc === wc) killLogin(id)
  const args = ['auth', 'login', method === 'console' ? '--console' : '--claudeai']
  const proc = spawn(launch.file, [...launch.pre, ...args], { cwd: os.homedir(), env: launch.env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  const id = nextLoginId++
  logins.set(id, { proc, wc })
  const send = (ev: LoginEvent) => {
    if (!wc.isDestroyed()) wc.send('agent:login', id, ev)
  }
  let out = ''
  let urlSent = false
  const onData = (d: Buffer) => {
    const text = stripAnsi(d.toString('utf8'))
    out = (out + text).slice(-8000)
    if (!urlSent) {
      const m = out.match(/https:\/\/\S+/)
      // 链接可能分几次输出：等到换行再发
      if (m && /\s/.test(out.slice((m.index ?? 0) + m[0].length, (m.index ?? 0) + m[0].length + 1))) {
        urlSent = true
        send({ type: 'url', url: m[0] })
      }
    }
    send({ type: 'output', text })
  }
  proc.stdout!.on('data', onData)
  proc.stderr!.on('data', onData)
  proc.stdin!.on('error', () => {})
  proc.on('error', (e) => {
    out += String(e)
  })
  proc.on('close', (code) => {
    logins.delete(id)
    const tail = out.trim().split('\n').slice(-3).join('\n')
    send({ type: 'exit', ok: code === 0, message: code === 0 ? undefined : tail || tm('登录失败（{0}）', code) })
  })
  wc.once('destroyed', () => killLogin(id))
  return id
}

function killLogin(id: number): void {
  const r = logins.get(id)
  if (!r) return
  logins.delete(id)
  kill({ proc: r.proc, wc: r.wc, plugin: 'claude' })
}

function claudeLogout(): Promise<void> {
  return new Promise((resolve, reject) => {
    void resolveLaunch('claude').then((launch) => {
      if (!launch) return reject(new Error(tm('没有找到 Claude Code 命令行工具')))
      execFile(launch.file, [...launch.pre, 'auth', 'logout'], { env: launch.env, windowsHide: true, timeout: 30_000 }, (err, _o, stderr) => {
        if (err) reject(new Error(String(stderr).trim() || err.message))
        else resolve()
      })
    }, reject)
  })
}

export function registerAgentIpc(): void {
  ipcMain.handle('agent:claudeLogin', (e, method: ClaudeLoginMethod) => claudeLogin(e.sender, method === 'console' ? 'console' : 'claudeai'))
  ipcMain.on('agent:loginWrite', (e, id: number, text: string) => {
    const r = logins.get(id)
    if (!r || r.wc !== e.sender || typeof text !== 'string') return
    // 授权码只有一行
    const line = text.replace(/[\r\n]+/g, '').slice(0, 4096)
    if (r.proc.stdin?.writable) r.proc.stdin.write(line + '\n', 'utf8')
  })
  ipcMain.on('agent:loginCancel', (e, id: number) => {
    if (logins.get(id)?.wc === e.sender) killLogin(id)
  })
  ipcMain.handle('agent:claudeLogout', () => claudeLogout())

  ipcMain.handle('agent:start', (e, req: AgentStart) => start(e.sender, req))

  ipcMain.on('agent:write', (e, runId: number, msg: Record<string, unknown>) => {
    const r = runs.get(runId)
    if (!r || r.wc !== e.sender || r.proc.exitCode !== null) return
    if (!allowed(r.plugin, msg)) return
    if (r.proc.stdin?.writable) r.proc.stdin.write(JSON.stringify(msg) + '\n', 'utf8')
  })

  ipcMain.on('agent:stop', (e, runId: number) => {
    const r = runs.get(runId)
    if (r && r.wc === e.sender) kill(r)
  })

  // 没打开文件夹时，进程在用户主目录里运行，会话也记在那里
  const dirOf = (cwd: unknown) => (typeof cwd === 'string' && cwd ? cwd : os.homedir())
  ipcMain.handle('agent:sessions', (_e, plugin: string, cwd: string | null) => (plugin === 'claude' ? claudeSessions(dirOf(cwd)) : []))
  ipcMain.handle('agent:transcript', (_e, plugin: string, cwd: string | null, id: string) => {
    if (plugin !== 'claude') throw new Error('不支持')
    return claudeTranscript(dirOf(cwd), id)
  })
  ipcMain.handle('agent:saveImage', (_e, dataUrl: string) => saveImage(dataUrl))
  ipcMain.handle('agent:dailyUsage', (_e, plugin: string) => dailyUsage(plugin))
}
