import { app, ipcMain, safeStorage, type WebContents } from 'electron'
import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { createReadStream, promises as fs } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import zlib from 'node:zlib'
import { PLUGINS } from '../shared/plugins'
import { ACP_ARGS, CLAUDE_MODES, type AgentStart, type ClaudeLoginMethod, type LoginEvent, type SessionInfo } from '../shared/agents'
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
 * - Gemini CLI / Kimi Code / DeepSeek Harness：每个对话一个 ACP 服务进程（`gemini --acp` / `kimi acp` / `dsh --profile acp`，JSON-RPC）
 */

interface Run {
  proc: ChildProcess
  wc: WebContents
  plugin: string
  /** 进程的工作目录（ACP 要求绝对路径，界面没打开文件夹时由这里补上） */
  cwd: string
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

/** 界面可以调用的 ACP 方法 */
const ACP_METHODS = new Set([
  'initialize',
  'authenticate',
  'logout',
  'session/new',
  'session/load',
  'session/resume',
  'session/list',
  'session/close',
  'session/prompt',
  'session/set_mode',
  'session/set_model',
  'session/set_config_option'
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

/** 窗口关闭时调用 fn；返回的函数把回调摘掉（进程结束时调用，免得窗口上的回调越积越多） */
function whenClosed(wc: WebContents, fn: () => void): () => void {
  wc.once('destroyed', fn)
  return () => {
    if (!wc.isDestroyed()) wc.off('destroyed', fn)
  }
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
  const args = req.plugin === 'claude' ? claudeArgs(req) : req.plugin === 'codex' ? ['app-server'] : (ACP_ARGS[req.plugin] ?? null)
  if (!args) throw new Error(tm('未知插件：{0}', req.plugin))
  const launch = await resolveLaunch(def.command, { systemNode: def.systemNode })
  if (!launch) throw new Error(tm('没有找到 {0} 命令行工具，请先在插件页安装', def.name))

  let cwd = os.homedir()
  if (req.cwd) {
    const st = await fs.stat(req.cwd).catch(() => null)
    if (st?.isDirectory()) cwd = req.cwd
  }
  const env = { ...launch.env }
  if (req.plugin === 'gemini' && !env.GEMINI_API_KEY) {
    // 在 IDE 里填过的 API Key（gemini 的 ACP 模式不会自己保存它）
    const key = await readGeminiKey()
    if (key) env.GEMINI_API_KEY = key
  }
  if (req.plugin === 'claude') {
    // 文件检查点：支持“回退代码”
    env.CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING = 'true'
  }

  const proc = spawn(launch.file, [...launch.pre, ...args], { cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  const id = nextId++
  const run: Run = { proc, wc, plugin: req.plugin, cwd }
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
    detach()
    send('agent:exit', code ?? -1, stderr.trim())
  })
  const detach = whenClosed(wc, () => {
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
  if (ACP_ARGS[plugin]) {
    if (msg.jsonrpc !== '2.0') return false
    // 通知：取消当前轮次
    if (msg.method === 'session/cancel' && msg.id === undefined) return true
    if (typeof msg.method === 'string') return ACP_METHODS.has(msg.method) && (typeof msg.id === 'number' || typeof msg.id === 'string')
    // 对 agent 请求（授权等）的回复
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
    detach()
    const tail = out.trim().split('\n').slice(-3).join('\n')
    send({ type: 'exit', ok: code === 0, message: code === 0 ? undefined : tail || tm('登录失败（{0}）', code) })
  })
  const detach = whenClosed(wc, () => killLogin(id))
  return id
}

function killLogin(id: number): void {
  const r = logins.get(id)
  if (!r) return
  logins.delete(id)
  kill({ proc: r.proc, wc: r.wc, plugin: 'claude', cwd: '' })
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

/* ---------------- Kimi 登录（kimi login，设备码） ---------------- */

async function kimiLogin(wc: WebContents): Promise<number> {
  const def = PLUGINS.find((p) => p.id === 'kimi')!
  const launch = await resolveLaunch(def.command)
  if (!launch) throw new Error(tm('没有找到 {0} 命令行工具，请先在插件页安装', def.name))
  for (const [id, r] of logins) if (r.wc === wc) killLogin(id)
  const proc = spawn(launch.file, [...launch.pre, 'login'], { cwd: os.homedir(), env: launch.env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  const id = nextLoginId++
  logins.set(id, { proc, wc })
  const send = (ev: LoginEvent) => {
    if (!wc.isDestroyed()) wc.send('agent:login', id, ev)
  }
  let out = ''
  let urlSent = false
  let codeSent = false
  const onData = (d: Buffer) => {
    const text = stripAnsi(d.toString('utf8'))
    out = (out + text).slice(-8000)
    if (!urlSent) {
      const m = out.match(/https:\/\/\S+/)
      if (m && /\s/.test(out.slice((m.index ?? 0) + m[0].length, (m.index ?? 0) + m[0].length + 1))) {
        urlSent = true
        send({ type: 'url', url: m[0] })
      }
    }
    if (!codeSent) {
      const c = out.match(/enter code:\s*([A-Z0-9-]{4,})/i) ?? out.match(/user_code=([A-Z0-9-]{4,})/i)
      if (c) {
        codeSent = true
        send({ type: 'code', code: c[1] })
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
    detach()
    const tail = out.trim().split('\n').slice(-3).join('\n')
    send({ type: 'exit', ok: code === 0, message: code === 0 ? undefined : tail || tm('登录失败（{0}）', code) })
  })
  const detach = whenClosed(wc, () => killLogin(id))
  return id
}

/* ---------------- DeepSeek API Key（~/.dsh/.credentials.yaml 的 refs.DEEPSEEK_API_KEY） ---------------- */

const DSH_KEY = 'DEEPSEEK_API_KEY'

function dshHome(): string {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}

function credFile(): string {
  return path.join(dshHome(), '.credentials.yaml')
}

/** YAML 标量 → 字符串（只处理 refs 里会出现的单行写法） */
function yamlScalar(raw: string): string {
  const v = raw.replace(/\s+#.*$/, '').trim()
  if (v.startsWith('"')) {
    try {
      return JSON.parse(v)
    } catch {
      return v.slice(1, -1)
    }
  }
  if (v.startsWith("'")) return v.slice(1, -1).replace(/''/g, "'")
  return v
}

/** 在凭据文件文本里设置（value 为 null 时删除）refs 下的一个键，其余内容和注释原样保留 */
function setRef(text: string, key: string, value: string | null): string {
  const lines = text.split(/\r?\n/)
  const entry = (indent: string) => `${indent}${key}: ${JSON.stringify(value)}`
  let r = lines.findIndex((l) => /^refs:\s*(\{\s*\})?\s*(#.*)?$/.test(l))
  if (r >= 0 && /\{\s*\}/.test(lines[r])) lines[r] = 'refs:'
  if (r < 0) {
    if (value === null) return text
    const body = text.trimEnd()
    return `${body ? body + '\n\n' : 'version: 1\n\n'}refs:\n${entry('  ')}\n`
  }
  // refs 段：之后缩进的行和空行
  let end = r + 1
  while (end < lines.length && (lines[end].trim() === '' || /^\s/.test(lines[end]))) end++
  let indent = '  '
  let at = -1
  for (let i = r + 1; i < end; i++) {
    const m = lines[i].match(/^(\s+)([^\s:#][^:]*?)\s*:/)
    if (!m) continue
    indent = m[1]
    if (m[2] === key || m[2] === `"${key}"` || m[2] === `'${key}'`) {
      at = i
      break
    }
  }
  if (at >= 0) {
    // 连同多行值（更深缩进的续行）一起去掉
    let stop = at + 1
    while (stop < end && (lines[stop].trim() === '' ? stop + 1 < end && lines[stop + 1].startsWith(indent + ' ') : lines[stop].startsWith(indent + ' '))) stop++
    lines.splice(at, stop - at, ...(value === null ? [] : [entry(indent)]))
  } else if (value !== null) lines.splice(r + 1, 0, entry(indent))
  return lines.join('\n')
}

async function deepseekKeyStatus(): Promise<{ configured: boolean; masked?: string; source?: 'file' | 'env' }> {
  const text = await fs.readFile(credFile(), 'utf8').catch(() => '')
  const m = text.match(new RegExp(`^\\s+["']?${DSH_KEY}["']?\\s*:\\s*(.+)$`, 'm'))
  const v = m ? yamlScalar(m[1]) : ''
  const mask = (k: string) => (k.length > 12 ? `${k.slice(0, 5)}…${k.slice(-4)}` : '••••')
  if (v) return { configured: true, masked: mask(v), source: 'file' }
  const env = process.env[DSH_KEY]
  if (env) return { configured: true, masked: mask(env), source: 'env' }
  const dotenv = await fs.readFile(path.join(dshHome(), '.env'), 'utf8').catch(() => '')
  const e = dotenv.match(new RegExp(`^\\s*${DSH_KEY}\\s*=\\s*(.+)$`, 'm'))
  if (e) return { configured: true, masked: mask(yamlScalar(e[1])), source: 'env' }
  return { configured: false }
}

async function setDeepseekKey(key: string | null): Promise<void> {
  if (key !== null) {
    key = String(key).trim()
    if (!key || key.length > 512 || /[\r\n]/.test(key)) throw new Error(tm('API Key 格式不正确'))
  }
  const file = credFile()
  const text = await fs.readFile(file, 'utf8').catch((e: NodeJS.ErrnoException) => {
    if (e.code === 'ENOENT') return ''
    throw e
  })
  const next = setRef(text, DSH_KEY, key)
  if (next === text) return
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, next, { encoding: 'utf8', mode: 0o600 })
}

/* ---------------- Gemini：API Key、登录方式、本地会话记录 ---------------- */

const geminiHome = (): string => path.join(os.homedir(), '.gemini')
/** 在 IDE 里填的 Gemini API Key：用系统密钥存储加密后放在这里 */
const geminiKeyFile = (): string => path.join(app.getPath('userData'), 'gemini-api-key.bin')

async function readGeminiKey(): Promise<string | null> {
  try {
    if (!safeStorage.isEncryptionAvailable()) return null
    return safeStorage.decryptString(await fs.readFile(geminiKeyFile())) || null
  } catch {
    return null
  }
}

async function setGeminiKey(key: string | null): Promise<void> {
  if (key === null) return fs.rm(geminiKeyFile(), { force: true })
  key = String(key).trim()
  if (!key || key.length > 512 || /\s/.test(key)) throw new Error(tm('API Key 格式不正确'))
  if (!safeStorage.isEncryptionAvailable()) throw new Error(tm('系统密钥存储不可用，无法安全保存登录信息'))
  await fs.mkdir(path.dirname(geminiKeyFile()), { recursive: true })
  await fs.writeFile(geminiKeyFile(), safeStorage.encryptString(key), { mode: 0o600 })
}

/** gemini 记下的登录方式（~/.gemini/settings.json 的 security.auth.selectedType）和可用的 API Key */
async function geminiAuthStatus(): Promise<{ authType: string | null; key?: { masked: string; source: 'app' | 'env' } }> {
  // settings.json 允许写注释，不按 JSON 解析，只取这一个字段
  const text = await fs.readFile(path.join(geminiHome(), 'settings.json'), 'utf8').catch(() => '')
  const authType = text.match(/"selectedType"\s*:\s*"([\w-]+)"/)?.[1] ?? null
  const mask = (k: string): string => (k.length > 12 ? `${k.slice(0, 4)}…${k.slice(-4)}` : '••••')
  const stored = await readGeminiKey()
  if (stored) return { authType, key: { masked: mask(stored), source: 'app' } }
  const env = process.env.GEMINI_API_KEY
  return env ? { authType, key: { masked: mask(env), source: 'env' } } : { authType }
}

/** 消息内容 → 文本（字符串，或 [{ text }] 这样的分段） */
function geminiText(c: unknown): string {
  if (typeof c === 'string') return c
  if (Array.isArray(c)) return c.map(geminiText).join('')
  if (c && typeof c === 'object' && typeof (c as { text?: unknown }).text === 'string') return (c as { text: string }).text
  return ''
}

/** 一个会话文件（新版是 JSONL：元数据行 + 每条消息一行；旧版是一个 JSON 对象） → 会话 id、标题 */
async function geminiSessionInfo(file: string): Promise<SessionInfo | null> {
  const st = await fs.stat(file).catch(() => null)
  if (!st) return null
  // 只读开头一段：元数据和第一条用户消息都在前面
  const fh = await fs.open(file, 'r')
  const buf = Buffer.alloc(Math.min(st.size, 4 * 1024 * 1024))
  try {
    await fh.read(buf, 0, buf.length, 0)
  } finally {
    await fh.close()
  }
  const text = buf.toString('utf8')
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const records: any[] = []
  if (file.endsWith('.json')) {
    try {
      const obj = JSON.parse(text)
      records.push(obj, ...(Array.isArray(obj?.messages) ? obj.messages : []))
    } catch {
      return null
    }
  } else {
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      try {
        records.push(JSON.parse(line))
      } catch {
        /* 被截断的最后一行 */
      }
    }
  }
  let id = ''
  let summary = ''
  let first = ''
  for (const r of records) {
    if (!r || typeof r !== 'object') continue
    if (typeof r.sessionId === 'string' && !id) id = r.sessionId
    if (r.kind === 'subagent') return null
    if (typeof r.summary === 'string' && r.summary.trim()) summary = r.summary
    if (!first && r.type === 'user') {
      // 去掉 IDE 自动附带的编辑器上下文，跳过 / 命令
      const t = geminiText(r.content)
        .replace(/<(ide_opened_file|ide_selection)>[\s\S]*?<\/\1>/g, '')
        .trim()
      if (t && !t.startsWith('/')) first = t
    }
  }
  const title = (summary || first).replace(/\s+/g, ' ').trim()
  if (!id || !SAFE_ID.test(id) || !title) return null
  return { id, title: title.slice(0, 120), updatedAt: st.mtimeMs }
}

/** gemini 在这个文件夹里的对话（~/.gemini/tmp/<项目短名>/chats/session-*.json(l)） */
async function geminiSessions(cwd: string): Promise<SessionInfo[]> {
  const root = path.resolve(cwd)
  const dirs: string[] = []
  // 项目短名记在 ~/.gemini/projects.json；Windows 上路径按小写记
  try {
    const reg = JSON.parse(await fs.readFile(path.join(geminiHome(), 'projects.json'), 'utf8')) as { projects?: Record<string, unknown> }
    const short = reg.projects?.[process.platform === 'win32' ? root.toLowerCase() : root]
    if (typeof short === 'string' && SAFE_ID.test(short)) dirs.push(path.join(geminiHome(), 'tmp', short, 'chats'))
  } catch {
    /* 还没在这个文件夹里用过 */
  }
  // 旧版：按路径的 sha256 命名
  dirs.push(path.join(geminiHome(), 'tmp', createHash('sha256').update(root).digest('hex'), 'chats'))
  const out = new Map<string, SessionInfo>()
  for (const dir of dirs) {
    const files = (await fs.readdir(dir).catch(() => [] as string[])).filter((f) => f.startsWith('session-') && /\.jsonl?$/.test(f))
    const infos = await Promise.all(files.map((f) => geminiSessionInfo(path.join(dir, f)).catch(() => null)))
    for (const s of infos) if (s && (out.get(s.id)?.updatedAt ?? 0) < s.updatedAt) out.set(s.id, s)
  }
  return [...out.values()].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 200)
}

/* ---------------- DeepSeek 历史会话（session/resume 不回放，读本地日志） ---------------- */

/** 日志是若干个 zstd 帧拼起来的 JSONL */
function zstdFrames(buf: Buffer): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const z = zlib as any
  if (typeof z.zstdDecompressSync !== 'function') throw new Error(tm('当前运行环境不支持读取 zstd 日志'))
  const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
  const starts: number[] = []
  for (let i = buf.indexOf(magic); i >= 0; i = buf.indexOf(magic, i + 1)) starts.push(i)
  let out = ''
  for (let k = 0; k < starts.length; k++) {
    try {
      out += z.zstdDecompressSync(buf.subarray(starts[k], starts[k + 1] ?? buf.length)).toString('utf8')
    } catch {
      /* 帧内容里碰巧出现魔数时切错了：跳过，下一段会接上 */
    }
  }
  return out
}

async function deepseekLogFile(id: string): Promise<string> {
  const base = path.join(dshHome(), 'sessions')
  for (const dir of await fs.readdir(base).catch(() => [] as string[])) {
    const d = path.join(base, dir, id)
    const names = await fs.readdir(d).catch(() => [] as string[])
    const f = names.filter((n) => /^session\.v\d+\.jsonl(\.zstd)?$/.test(n)).sort().pop()
    if (f) return path.join(d, f)
  }
  throw new Error(tm('找不到这个会话'))
}

const textOf = (content: unknown): string =>
  Array.isArray(content)
    ? content
        .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text as string)
        .join('\n')
    : ''

/** 把 DeepSeek Harness 的会话日志转换成 ACP session/update（和实时事件同一套处理） */
async function deepseekTranscript(id: string): Promise<Record<string, unknown>[]> {
  if (!SAFE_ID.test(id)) throw new Error('无效的会话 id')
  const file = await deepseekLogFile(id)
  const buf = await fs.readFile(file)
  const text = file.endsWith('.zstd') ? zstdFrames(buf) : buf.toString('utf8')
  const out: Record<string, unknown>[] = []
  const clipText = (s: string) => (s.length > 20_000 ? s.slice(0, 20_000) + '\n…' : s)
  for (const line of text.split('\n')) {
    if (!line.startsWith('{')) continue
    let e: { type?: string; time?: number; data?: Record<string, unknown> }
    try {
      e = JSON.parse(line)
    } catch {
      continue
    }
    const d = e.data ?? {}
    switch (e.type) {
      case 'user/message': {
        const src = d.source as { kind?: string } | undefined
        if (d.role !== 'user' || src?.kind !== 'user') break
        const s = textOf(d.content)
        if (!s || s.startsWith('<system-reminder>')) break
        out.push({ sessionUpdate: 'user_message_chunk', messageId: d.id, time: e.time, content: { type: 'text', text: s } })
        break
      }
      case 'assistant/message': {
        const msg = d.message as { id?: string; content?: { type: string; text?: string }[] } | undefined
        for (const b of msg?.content ?? []) {
          if (b.type === 'reasoning' && b.text) out.push({ sessionUpdate: 'agent_thought_chunk', messageId: msg?.id, content: { type: 'text', text: b.text } })
          else if (b.type === 'text' && b.text) out.push({ sessionUpdate: 'agent_message_chunk', messageId: msg?.id, content: { type: 'text', text: b.text } })
        }
        break
      }
      case 'tool/call': {
        let input: unknown = d.arguments
        try {
          input = JSON.parse(String(d.arguments))
        } catch {
          /* 保留原文 */
        }
        out.push({ sessionUpdate: 'tool_call', toolCallId: d.callId, title: d.name, kind: 'other', status: 'in_progress', rawInput: input })
        break
      }
      case 'tool/result': {
        const msg = d.message as { toolCallId?: string; content?: unknown; isError?: boolean } | undefined
        if (!msg?.toolCallId) break
        const s = textOf(msg.content)
        out.push({
          sessionUpdate: 'tool_call_update',
          toolCallId: msg.toolCallId,
          status: msg.isError ? 'failed' : 'completed',
          content: s ? [{ type: 'content', content: { type: 'text', text: clipText(s) } }] : []
        })
        break
      }
      case 'turn/end': {
        const reason = d.reason as { kind?: string; error?: { message?: string } } | undefined
        if (reason?.kind === 'error' && reason.error?.message) out.push({ sessionUpdate: '_error', text: reason.error.message })
        break
      }
    }
  }
  return out.slice(-3000)
}

/** DeepSeek 的 session/list 只有 id 和目录：从本地日志补上标题（没有用户消息的空会话不返回）和更新时间 */
async function deepseekSessionMeta(ids: string[]): Promise<Record<string, { title: string; updatedAt: number }>> {
  const out: Record<string, { title: string; updatedAt: number }> = {}
  await Promise.all(
    ids
      .filter((id) => typeof id === 'string' && SAFE_ID.test(id))
      .slice(0, 300)
      .map(async (id) => {
        try {
          const file = await deepseekLogFile(id)
          const st = await fs.stat(file)
          const buf = await fs.readFile(file)
          const text = file.endsWith('.zstd') ? zstdFrames(buf) : buf.toString('utf8')
          let title = ''
          let first = ''
          for (const line of text.split('\n')) {
            if (line.includes('"type":"session/title"')) {
              try {
                title = String(JSON.parse(line).data?.title ?? '') || title
              } catch {
                /* ignore */
              }
            } else if (!first && line.includes('"type":"user/message"') && line.includes('"kind":"user"')) {
              try {
                const s = textOf(JSON.parse(line).data?.content)
                if (s && !s.startsWith('<system-reminder>')) first = s
              } catch {
                /* ignore */
              }
            }
          }
          if (!first && !title) return
          out[id] = { title: (title || first).replace(/\s+/g, ' ').trim().slice(0, 120), updatedAt: st.mtimeMs }
        } catch {
          /* 找不到日志的会话不显示 */
        }
      })
  )
  return out
}

export function registerAgentIpc(): void {
  ipcMain.handle('agent:deepseekSessionMeta', (_e, ids: string[]) => deepseekSessionMeta(Array.isArray(ids) ? ids : []))
  ipcMain.handle('agent:kimiLogin', (e) => kimiLogin(e.sender))
  ipcMain.handle('agent:deepseekKeyStatus', () => deepseekKeyStatus())
  ipcMain.handle('agent:geminiAuthStatus', () => geminiAuthStatus())
  ipcMain.handle('agent:setGeminiKey', (_e, key: string | null) => setGeminiKey(typeof key === 'string' ? key : null))
  ipcMain.handle('agent:setDeepseekKey', (_e, key: string | null) => setDeepseekKey(typeof key === 'string' ? key : null))
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
    const params = msg.params as Record<string, unknown> | undefined
    if (ACP_ARGS[r.plugin] && params && typeof params === 'object' && 'cwd' in params && !params.cwd) msg = { ...msg, params: { ...params, cwd: r.cwd } }
    if (r.proc.stdin?.writable) r.proc.stdin.write(JSON.stringify(msg) + '\n', 'utf8')
  })

  ipcMain.on('agent:stop', (e, runId: number) => {
    const r = runs.get(runId)
    if (r && r.wc === e.sender) kill(r)
  })

  // 没打开文件夹时，进程在用户主目录里运行，会话也记在那里
  const dirOf = (cwd: unknown) => (typeof cwd === 'string' && cwd ? cwd : os.homedir())
  ipcMain.handle('agent:sessions', (_e, plugin: string, cwd: string | null) =>
    plugin === 'claude' ? claudeSessions(dirOf(cwd)) : plugin === 'gemini' ? geminiSessions(dirOf(cwd)) : []
  )
  ipcMain.handle('agent:transcript', (_e, plugin: string, cwd: string | null, id: string) => {
    if (plugin === 'deepseek') return deepseekTranscript(String(id))
    if (plugin !== 'claude') throw new Error('不支持')
    return claudeTranscript(dirOf(cwd), id)
  })
  ipcMain.handle('agent:saveImage', (_e, dataUrl: string) => saveImage(dataUrl))
  ipcMain.handle('agent:dailyUsage', (_e, plugin: string) => dailyUsage(plugin))
}
