import type { LoginEvent, SessionInfo } from '../../../shared/agents'
import { PANEL_MCP_SERVER, PANEL_TOOLS } from '../../../shared/ide'
import { captureBaseline, findNewDiagnostics, panelDiagnostics, saveIfDirty } from '../ide'
import { listen, unlisten } from './bus'
import { applyHunks, countChanges, hunksFrom, lineDiff, type Hunk } from './diff'
import type { ChatHost, DiffInfo, Driver, LoginMethod, LoginUi, ModelOption, PermissionOption, Question, SlashCommand, ToolView, UserInput } from './types'
import { clip, readText, rel, todoMarkdown } from './util'

/**
 * Claude Code 驱动：和官方 VS Code 扩展一样，常驻一个
 * `claude -p --input-format stream-json --output-format stream-json` 进程，
 * 用 control_request / control_response 处理授权、切换模式和模型、中断、回退文件。
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

interface Pending {
  resolve: (v: Any) => void
  reject: (e: Error) => void
}

export interface ClaudeOptions {
  mode: string
  model?: string
  effort?: string
}

const HOOK_BASELINE = 'ide_capture_baseline'
const HOOK_SAVE = 'ide_save_if_dirty'
const HOOK_DIAGNOSTICS = 'ide_new_diagnostics'

/** 和 VS Code 扩展相同的钩子：改文件前后对比诊断；读写前保存编辑器里未保存的修改 */
const IDE_HOOKS = {
  PreToolUse: [
    { matcher: 'Edit|Write|MultiEdit', hookCallbackIds: [HOOK_BASELINE] },
    { matcher: 'Edit|Write|Read', hookCallbackIds: [HOOK_SAVE] }
  ],
  PostToolUse: [{ matcher: 'Edit|Write|MultiEdit', hookCallbackIds: [HOOK_DIAGNOSTICS], contextOnly: true }]
}

const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit'])

export class ClaudeDriver implements Driver {
  models: ModelOption[] = []
  commands: SlashCommand[] = []
  sessionId: string | null = null
  account?: string
  readonly canRewind = true

  private runId: number | null = null
  private starting: Promise<void> | null = null
  private pending = new Map<string, Pending>()
  private reqSeq = 0
  private mode: string
  private model?: string
  private effort?: string
  /** 进程启动时用的思考强度；不同就要重启进程 */
  private procEffort?: string
  private resumeAt?: string
  /** 最近一条消息的 uuid（下一条用户消息的“上一条”） */
  private lastUuid?: string
  private tools = new Map<string, { name: string; input: Any }>()
  /** 流式块：message id → 还没被完整消息认领的块 */
  private streamBlocks = new Map<string, { type: string; id: string }[]>()
  private curMsg = ''
  private blockIds = new Map<number, { type: string; id: string }>()
  private ctxWindow = 200_000
  private lastUsed = 0
  private interrupting = false
  private killTimer: ReturnType<typeof setTimeout> | undefined
  private replay = false

  constructor(
    private host: ChatHost,
    opts: ClaudeOptions
  ) {
    this.mode = opts.mode
    this.model = opts.model
    this.effort = opts.effort
  }

  /* ---------------- 进程 ---------------- */

  start(): Promise<void> {
    return this.ensure()
  }

  private ensure(): Promise<void> {
    if (this.runId != null) return Promise.resolve()
    if (this.starting) return this.starting
    this.starting = (async () => {
      const effort = this.effort
      const id = await window.api.agent.start({
        plugin: 'claude',
        cwd: this.host.cwd ?? undefined,
        mode: this.mode,
        model: this.model && this.model !== 'default' ? this.model : undefined,
        effort,
        resume: this.sessionId ?? undefined,
        resumeAt: this.sessionId ? this.resumeAt : undefined
      })
      this.runId = id
      this.procEffort = effort
      this.resumeAt = undefined
      listen(id, { event: (ev) => this.onEvent(ev), exit: (c, s) => this.onExit(id, c, s) })
      // 和 VS Code 扩展一样：注册编辑器的 MCP 服务和诊断钩子
      const init = await this.control({ subtype: 'initialize', sdkMcpServers: [PANEL_MCP_SERVER], hooks: IDE_HOOKS }, 60_000)
      this.applyInit(init)
    })().finally(() => {
      this.starting = null
    })
    return this.starting
  }

  private applyInit(r: Any): void {
    if (!r) return
    if (Array.isArray(r.models) && r.models.length) {
      this.models = r.models.map((m: Any) => ({
        id: String(m.value),
        label: String(m.displayName ?? m.value),
        description: m.description,
        efforts: m.supportsEffort ? (m.supportedEffortLevels as string[]) : [],
        isDefault: m.value === 'default'
      }))
    }
    if (Array.isArray(r.commands)) {
      this.commands = r.commands
        .filter((c: Any) => c?.name && !String(c.name).startsWith('__') && !/^\(removed\)/.test(c.description ?? ''))
        .map((c: Any) => ({ name: String(c.name), description: String(c.description ?? ''), hint: c.argumentHint || undefined }))
    }
    const a = r.account
    if (a) this.account = [a.email, a.subscriptionType ?? a.organization].filter(Boolean).join(' · ') || undefined
    this.host.capabilities()
  }

  private stopProcess(): void {
    if (this.runId == null) return
    const id = this.runId
    this.runId = null
    unlisten(id)
    window.api.agent.stop(id)
    for (const p of this.pending.values()) p.reject(new Error('进程已结束'))
    this.pending.clear()
  }

  private onExit(id: number, code: number, stderr: string): void {
    if (this.runId !== id) return
    this.runId = null
    // 还有请求在等回复（例如启动时的 initialize）：错误随请求失败报告，不再重复提示
    const reported = this.pending.size > 0
    for (const p of this.pending.values()) p.reject(new Error(stderr.split('\n').slice(-4).join('\n') || '进程已退出'))
    this.pending.clear()
    clearTimeout(this.killTimer)
    if (this.host.busy()) {
      if (this.interrupting) {
        this.interrupting = false
        this.host.turnEnded({ ok: false, interrupted: true })
      } else if (!reported) this.host.crashed(code === 0 ? '进程已结束' : stderr ? stderr.split('\n').slice(-6).join('\n') : `进程退出（${code}）`)
    }
  }

  private write(msg: Record<string, unknown>): void {
    if (this.runId != null) window.api.agent.write(this.runId, msg)
  }

  private control(request: Record<string, unknown>, timeout = 30_000): Promise<Any> {
    const id = `req_${++this.reqSeq}_${Date.now().toString(36)}`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('请求超时'))
      }, timeout)
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer)
          resolve(v)
        },
        reject: (e) => {
          clearTimeout(timer)
          reject(e)
        }
      })
      this.write({ type: 'control_request', request_id: id, request })
    })
  }

  /* ---------------- 界面调用 ---------------- */

  async send(input: UserInput): Promise<void> {
    // 思考强度只能在启动时指定：空闲时重启进程（带上会话 id 续接）
    if (this.runId != null && this.procEffort !== this.effort) this.stopProcess()
    await this.ensure()
    const content: Any[] = []
    const ctx = input.context
    if (ctx.selection) {
      const s = ctx.selection
      content.push({
        type: 'text',
        text: `<ide_selection>The user selected the lines ${s.startLine} to ${s.endLine} from ${s.path}:\n${s.text}\n\nThis may or may not be related to the current task.</ide_selection>`
      })
    } else if (ctx.file) {
      content.push({ type: 'text', text: `<ide_opened_file>The user opened the file ${ctx.file} in the IDE. This may or may not be related to the current task.</ide_opened_file>` })
    }
    for (const img of input.images) {
      const m = img.dataUrl.match(/^data:([^;]+);base64,(.*)$/)
      if (m) content.push({ type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } })
    }
    content.push({ type: 'text', text: input.text })
    this.host.turnStarted()
    this.write({ type: 'user', session_id: this.sessionId ?? '', parent_tool_use_id: null, message: { role: 'user', content } })
  }

  interrupt(): void {
    if (this.runId == null) return
    this.interrupting = true
    this.control({ subtype: 'interrupt' }, 5000).catch(() => {})
    clearTimeout(this.killTimer)
    // 进程没响应中断：直接结束，下次发送时用会话 id 续接
    this.killTimer = setTimeout(() => {
      if (!this.host.busy()) return
      this.stopProcess()
      this.interrupting = false
      this.host.turnEnded({ ok: false, interrupted: true })
    }, 4000)
  }

  setMode(id: string): void {
    this.mode = id
    if (this.runId != null) this.control({ subtype: 'set_permission_mode', mode: id }).catch((e) => this.host.note('切换模式失败：' + e.message, 'error'))
  }

  setModel(id: string, effort?: string): void {
    const changed = id !== this.model
    this.model = id
    this.effort = effort
    if (changed && this.runId != null) this.control({ subtype: 'set_model', model: id === 'default' ? undefined : id }).catch((e) => this.host.note('切换模型失败：' + e.message, 'error'))
  }

  listSessions(): Promise<SessionInfo[]> {
    return window.api.agent.sessions('claude', this.host.cwd)
  }

  async resume(id: string): Promise<void> {
    const entries = await window.api.agent.transcript('claude', this.host.cwd, id)
    this.stopProcess()
    this.sessionId = id
    this.resumeAt = undefined
    this.lastUuid = undefined
    this.tools.clear()
    this.replay = true
    try {
      for (const e of entries) this.onEvent(e)
    } finally {
      this.replay = false
    }
    this.host.session(id)
    // 后台先把进程拉起来，发消息时更快
    this.ensure().catch(() => {})
  }

  reset(): void {
    this.stopProcess()
    this.sessionId = null
    this.resumeAt = undefined
    this.lastUuid = undefined
    this.tools.clear()
    this.ensure().catch(() => {})
  }

  async rewind(messageId: string, prev: string | undefined, what: { code: boolean; conversation: boolean }): Promise<void> {
    if (what.code) {
      await this.ensure()
      const r = await this.control({ subtype: 'rewind_files', user_message_id: messageId }, 60_000)
      if (r?.canRewind === false) throw new Error(r.error || '没有这条消息的文件检查点')
      const n = Array.isArray(r?.filesChanged) ? r.filesChanged.length : undefined
      this.host.note(n != null ? `已恢复 ${n} 个文件` : '已恢复文件')
    }
    if (what.conversation) {
      this.stopProcess()
      if (prev) this.resumeAt = prev
      else this.sessionId = null
      this.lastUuid = prev
      this.ensure().catch(() => {})
    }
  }

  /* ---------------- 登录 ---------------- */

  readonly loginMethods: LoginMethod[] = [
    { id: 'claudeai', label: 'Claude 订阅账号', hint: 'Pro、Max、Team 或 Enterprise 订阅' },
    { id: 'console', label: 'Anthropic Console', hint: '按 API 用量计费' }
  ]

  async login(method: string, ui: LoginUi): Promise<void> {
    // 先订阅再启动，避免漏掉最早的输出
    let loginId: number | null = null
    const early: LoginEvent[] = []
    let handle: (ev: LoginEvent) => void = (ev) => early.push(ev)
    const off = window.api.agent.onLogin((id, ev) => {
      if (loginId === null || id === loginId) handle(ev)
    })
    try {
      loginId = await window.api.agent.claudeLogin(method === 'console' ? 'console' : 'claudeai')
      const id = loginId
      await new Promise<void>((resolve, reject) => {
        handle = (ev) => {
          if (ev.type === 'url') {
            // 命令行工具会自己打开浏览器；浏览器回调失败时页面会给出授权码，粘贴到这里
            ui.url(ev.url, false)
            ui.askCode((code) => window.api.agent.loginWrite(id, code))
          } else if (ev.type === 'exit') {
            if (ev.ok) resolve()
            else reject(new Error(ev.message || '登录失败'))
          }
        }
        early.splice(0).forEach(handle)
        ui.onCancel(() => {
          window.api.agent.loginCancel(id)
          reject(new Error('已取消登录'))
        })
      })
    } finally {
      off()
    }
    // 新的凭据要重启进程才生效
    this.stopProcess()
    this.account = undefined
    await this.ensure()
  }

  async logout(): Promise<void> {
    await window.api.agent.claudeLogout()
    this.stopProcess()
    this.account = undefined
    this.host.capabilities()
  }

  dispose(): void {
    clearTimeout(this.killTimer)
    this.stopProcess()
  }

  /* ---------------- 事件 ---------------- */

  private onEvent(ev: Any): void {
    switch (ev?.type) {
      case 'control_response':
        return this.onControlResponse(ev.response)
      case 'control_request':
        if (ev.request?.subtype === 'can_use_tool') void this.onPermission(ev.request_id, ev.request)
        else if (ev.request?.subtype === 'mcp_message') this.onMcpMessage(ev.request_id, ev.request)
        else if (ev.request?.subtype === 'hook_callback') void this.onHook(ev.request_id, ev.request)
        else this.write({ type: 'control_response', response: { subtype: 'error', request_id: ev.request_id, error: 'Unsupported request' } })
        return
      case 'control_cancel_request':
        return this.host.cancelPermission(ev.request_id)
      case 'system':
        return this.onSystem(ev)
      case 'stream_event':
        if (!ev.parent_tool_use_id) this.onStream(ev.event)
        return
      case 'assistant':
        return this.onAssistant(ev)
      case 'user':
        return this.onUser(ev)
      case 'result':
        return this.onResult(ev)
      case '__text':
        return
    }
  }

  private onControlResponse(r: Any): void {
    const p = this.pending.get(r?.request_id)
    if (!p) return
    this.pending.delete(r.request_id)
    if (r.subtype === 'error') p.reject(new Error(String(r.error ?? '请求失败')))
    else p.resolve(r.response)
  }

  private onSystem(ev: Any): void {
    if (ev.subtype === 'init') {
      if (ev.session_id && ev.session_id !== this.sessionId) {
        this.sessionId = ev.session_id
        this.host.session(ev.session_id)
      }
      if (ev.permissionMode && ev.permissionMode !== this.mode) {
        this.mode = ev.permissionMode
        this.host.setMode(ev.permissionMode)
      }
    } else if (ev.subtype === 'status') {
      this.host.status(ev.status === 'compacting' ? '正在压缩对话…' : null)
    } else if (ev.subtype === 'compact_boundary') {
      this.host.note('对话已压缩，之前的内容已总结')
    } else if (ev.subtype === 'api_retry' || ev.subtype === 'api_error') {
      const msg = ev.error?.message ?? ev.message
      if (msg) this.host.status(`接口出错，正在重试…（${msg}）`)
    }
  }

  private onStream(e: Any): void {
    if (!e) return
    if (e.type === 'message_start') {
      this.curMsg = e.message?.id ?? ''
      this.blockIds.clear()
      return
    }
    if (e.type === 'content_block_start') {
      const cb = e.content_block
      const id = `${this.curMsg}:${e.index}`
      if (cb?.type === 'text') {
        this.queueBlock('text', id)
        this.host.text(id, cb.text ?? '')
      } else if (cb?.type === 'thinking') {
        this.queueBlock('thinking', id)
        this.host.thinking(id, cb.thinking ?? '')
      } else if (cb?.type === 'tool_use' && cb.id) {
        if (!this.tools.has(cb.id)) {
          this.tools.set(cb.id, { name: cb.name, input: {} })
          this.host.tool(cb.id, { ...describe(cb.name, {}), status: 'running' })
        }
        return
      } else return
      this.blockIds.set(e.index, { type: cb.type, id })
      return
    }
    const b = this.blockIds.get(e.index)
    if (!b) return
    if (e.type === 'content_block_delta') {
      if (e.delta?.type === 'text_delta' && b.type === 'text') this.host.text(b.id, e.delta.text, true)
      else if (e.delta?.type === 'thinking_delta' && b.type === 'thinking') this.host.thinking(b.id, e.delta.thinking, { append: true })
    } else if (e.type === 'content_block_stop' && b.type === 'thinking') {
      this.host.thinking(b.id, '', { append: true, done: true })
    }
  }

  private queueBlock(type: string, id: string): void {
    const q = this.streamBlocks.get(this.curMsg) ?? []
    q.push({ type, id })
    this.streamBlocks.set(this.curMsg, q)
  }

  /** 完整消息里的块对应到流式阶段建好的块；没有流式（回放历史）就新建 */
  private claimBlock(msgId: string, type: string, k: number): string {
    const q = this.streamBlocks.get(msgId)
    const i = q?.findIndex((x) => x.type === type) ?? -1
    if (q && i >= 0) return q.splice(i, 1)[0].id
    return `${msgId || 'm'}:${type}:${k}:${this.lastUuid ?? ''}`
  }

  private onAssistant(ev: Any): void {
    const msg = ev.message
    if (!msg) return
    if (ev.parent_tool_use_id) {
      // 子任务内部的步骤：挂在子任务卡片下面
      for (const item of msg.content ?? []) {
        if (item.type !== 'tool_use') continue
        const parent = this.host.getTool(ev.parent_tool_use_id)
        if (!parent) continue
        const d = describe(item.name, item.input ?? {})
        this.host.tool(ev.parent_tool_use_id, { steps: [...(parent.steps ?? []), `${d.verb} ${d.summary}`.trim()] })
      }
      return
    }
    const content: Any[] = Array.isArray(msg.content) ? msg.content : []
    content.forEach((item, k) => {
      if (item.type === 'text') {
        if (!item.text) return
        this.host.text(this.claimBlock(msg.id, 'text', k), item.text)
      } else if (item.type === 'thinking') {
        if (!item.thinking) return
        this.host.thinking(this.claimBlock(msg.id, 'thinking', k), item.thinking, { done: true })
      } else if (item.type === 'tool_use') {
        const input = item.input ?? {}
        this.tools.set(item.id, { name: item.name, input })
        const prev = this.host.getTool(item.id)
        this.host.tool(item.id, { ...describe(item.name, input), status: prev?.status && prev.status !== 'running' ? prev.status : 'running' })
        if (item.name === 'TodoWrite' && Array.isArray(input.todos)) this.host.todos(input.todos)
      }
    })
    const u = msg.usage
    if (u && !this.replay) {
      const used = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.output_tokens ?? 0)
      if (used > 0) {
        this.lastUsed = used
        this.host.usage(used, this.ctxWindow)
      }
    }
    if (ev.uuid) this.lastUuid = ev.uuid
  }

  private onUser(ev: Any): void {
    if (ev.parent_tool_use_id) return
    const content = ev.message?.content
    const results = Array.isArray(content) ? content.filter((x: Any) => x?.type === 'tool_result') : []
    if (results.length) {
      for (const r of results) this.onToolResult(r, ev.tool_use_result)
      if (ev.uuid) this.lastUuid = ev.uuid
      return
    }
    const prev = this.lastUuid
    if (ev.uuid) this.lastUuid = ev.uuid
    const raw = textOf(content)
    // 本地命令（/compact 等）的输出
    const out = raw.match(/<local-command-(?:stdout|stderr)>([\s\S]*?)<\/local-command-(?:stdout|stderr)>/)
    if (out) {
      const t = out[1].replace(/\x1b\[[0-9;]*m/g, '').trim()
      if (t) this.host.note(t)
      return
    }
    if (ev.isCompactSummary) {
      if (this.replay) this.host.note('之前的对话已压缩')
      return
    }
    if (!this.replay) {
      // 我们自己发的消息被回显：补上 uuid（回退用）
      if (ev.uuid) this.host.ackUser(ev.uuid, prev)
      return
    }
    const text = cleanPrompt(raw)
    const images = Array.isArray(content) ? content.filter((x: Any) => x?.type === 'image').length : 0
    if (!text && !images) return
    const time = ev.timestamp ? Date.parse(ev.timestamp) : undefined
    this.host.userMessage(text, { images, id: ev.uuid, prev, time })
  }

  private onToolResult(r: Any, extra: Any): void {
    const rec = this.tools.get(r.tool_use_id)
    const output = toolOutput(r.content)
    const denied = r.is_error && /doesn't want to proceed|rejected|denied|用户拒绝/i.test(output)
    const patch: Partial<ToolView> = { status: denied ? 'denied' : r.is_error ? 'error' : 'done', output: output || undefined }
    if (rec) Object.assign(patch, describeResult(rec.name, rec.input, output, extra, !!r.is_error))
    this.host.tool(r.tool_use_id, patch)
  }

  private onResult(ev: Any): void {
    clearTimeout(this.killTimer)
    if (ev.session_id && ev.session_id !== this.sessionId) {
      this.sessionId = ev.session_id
      this.host.session(ev.session_id)
    }
    const mu = ev.modelUsage && typeof ev.modelUsage === 'object' ? (Object.values(ev.modelUsage) as Any[]) : []
    const win = mu.map((m) => m?.contextWindow).find((x) => typeof x === 'number' && x > 0)
    if (win) this.ctxWindow = win
    // 窗口大小在 result 里才知道，用它重新算一次占用比例
    if (this.lastUsed) this.host.usage(this.lastUsed, this.ctxWindow, ev.total_cost_usd)
    const interrupted = this.interrupting
    this.interrupting = false
    // 结束时把还在“运行中”的工具标成完成
    if (!this.host.busy()) return
    const isErr = !!ev.is_error && !interrupted
    let error: string | undefined
    if (isErr) {
      error = String(ev.result || (Array.isArray(ev.errors) ? ev.errors.join('\n') : '') || ev.subtype || '出错了')
      if (ev.subtype === 'error_max_turns') error = '已达到最大轮数'
    }
    this.host.turnEnded({ ok: !isErr && !interrupted, interrupted, error, durationMs: ev.duration_ms, costUsd: ev.total_cost_usd })
  }

  /* ---------------- 授权 ---------------- */

  private respond(requestId: string, response: Record<string, unknown>): void {
    this.write({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response } })
  }

  /* ---------------- 编辑器提供的工具（SDK MCP）和钩子 ---------------- */

  /** CLI 转来的 MCP 消息（发给我们注册的 infinite-studio 服务） */
  private onMcpMessage(requestId: string, r: Any): void {
    const msg = r.message ?? {}
    if (r.server_name !== PANEL_MCP_SERVER) {
      this.write({ type: 'control_response', response: { subtype: 'error', request_id: requestId, error: `Unknown MCP server: ${r.server_name}` } })
      return
    }
    // 通知不需要结果
    if (msg.id === undefined || msg.id === null) return this.respond(requestId, { mcp_response: { jsonrpc: '2.0', result: {}, id: 0 } })
    const reply = (body: Record<string, unknown>) => this.respond(requestId, { mcp_response: { jsonrpc: '2.0', id: msg.id, ...body } })
    const p = msg.params ?? {}
    switch (msg.method) {
      case 'initialize':
        return reply({
          result: {
            protocolVersion: typeof p.protocolVersion === 'string' ? p.protocolVersion : '2025-06-18',
            capabilities: { tools: {} },
            serverInfo: { name: PANEL_MCP_SERVER, version: '0.1.0' }
          }
        })
      case 'ping':
        return reply({ result: {} })
      case 'tools/list':
        return reply({ result: { tools: PANEL_TOOLS } })
      case 'tools/call': {
        const args = p.arguments ?? {}
        if (p.name === 'getDiagnostics') {
          const list = panelDiagnostics(typeof args.uri === 'string' && args.uri ? args.uri : undefined, typeof args.minSeverity === 'string' ? args.minSeverity : undefined)
          return reply({ result: { content: [{ type: 'text', text: JSON.stringify(list) }] } })
        }
        return reply({ result: { content: [{ type: 'text', text: `Tool ${p.name} not found` }], isError: true } })
      }
      default:
        return reply({ error: { code: -32601, message: `Method not found: ${msg.method}` } })
    }
  }

  /** 钩子回调：改文件前记下诊断、读写前保存未保存的修改、改完后报告新出现的诊断 */
  private async onHook(requestId: string, r: Any): Promise<void> {
    const input = (r.input ?? {}) as Record<string, unknown>
    let out: Record<string, unknown> = { continue: true }
    // 回放历史时不会有钩子；子代理的修改也一样处理
    if (r.callback_id === HOOK_BASELINE) out = await captureBaseline(input)
    else if (r.callback_id === HOOK_SAVE) out = await saveIfDirty(input)
    else if (r.callback_id === HOOK_DIAGNOSTICS) out = await findNewDiagnostics(input)
    this.respond(requestId, out)
  }

  private async onPermission(requestId: string, r: Any): Promise<void> {
    const name: string = r.tool_name
    const input = (r.input ?? {}) as Record<string, Any>
    const suggestions: Any[] = Array.isArray(r.permission_suggestions) ? r.permission_suggestions : []
    const deny = (feedback?: string) =>
      this.respond(requestId, {
        behavior: 'deny',
        message: feedback ? `The user doesn't want to proceed with this tool use. They said: ${feedback}` : "The user doesn't want to proceed with this tool use. The tool use was rejected.",
        interrupt: !feedback
      })

    try {
      if (name === 'AskUserQuestion' && Array.isArray(input.questions)) {
        const qs: Question[] = input.questions.map((q: Any, i: number) => ({
          id: String(i),
          header: q.header,
          question: String(q.question ?? ''),
          multiSelect: !!q.multiSelect,
          options: Array.isArray(q.options) ? q.options.map((o: Any) => ({ label: String(o.label ?? o), description: o.description })) : [],
          allowOther: true
        }))
        const ans = await this.host.ask(qs, requestId)
        if (!ans) return deny('用户跳过了问题')
        const answers: Record<string, string> = {}
        qs.forEach((q) => {
          const a = ans[q.id]
          if (a?.length) answers[q.question] = a.join(', ')
        })
        return this.respond(requestId, { behavior: 'allow', updatedInput: { ...input, answers } })
      }

      if (name === 'ExitPlanMode') {
        const a = await this.host.permission(
          {
            title: 'Claude 已经拟好计划，要开始执行吗？',
            markdown: String(input.plan ?? ''),
            options: [
              { id: 'auto', label: '是，并自动接受编辑' },
              { id: 'manual', label: '是，每次编辑前询问' },
              { id: 'no', label: '否，继续完善计划', feedback: true }
            ]
          },
          requestId
        )
        if (a.option === 'no') return deny(a.feedback || '用户想继续完善计划')
        const mode = a.option === 'auto' ? 'acceptEdits' : 'default'
        this.mode = mode
        this.host.setMode(mode)
        return this.respond(requestId, { behavior: 'allow', updatedInput: input, updatedPermissions: [{ type: 'setMode', mode, destination: 'session' }] })
      }

      const d = describe(name, input)
      const options: PermissionOption[] = [{ id: 'yes', label: '是' }]
      let always: Any[] | null = null
      let alwaysMode: string | null = null
      if (EDIT_TOOLS.has(name)) {
        always = suggestions.length ? suggestions : [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }]
        alwaysMode = always.find((s) => s.type === 'setMode')?.mode ?? null
        options.push({ id: 'always', label: '是，本次会话中允许所有编辑' })
      } else if (suggestions.length) {
        always = suggestions
        options.push({ id: 'always', label: suggestionLabel(name, suggestions) })
      }
      options.push({ id: 'no', label: '否，告诉 Claude 该怎么做', feedback: true })

      let diff: DiffInfo | undefined
      if (EDIT_TOOLS.has(name)) diff = await proposedDiff(name, input).catch(() => undefined)
      const title =
        name === 'Bash'
          ? '要运行这条命令吗？'
          : EDIT_TOOLS.has(name)
            ? `要${name === 'Write' ? '写入' : '修改'} ${rel(input.file_path ?? input.notebook_path)} 吗？`
            : name === 'WebFetch'
              ? `要访问 ${input.url} 吗？`
              : `要让 Claude 使用 ${d.verb}${d.summary ? '：' + clip(d.summary, 80) : ''} 吗？`
      const a = await this.host.permission(
        {
          title,
          detail: name === 'Bash' ? input.description : undefined,
          code: name === 'Bash' ? String(input.command ?? '') : !EDIT_TOOLS.has(name) && name !== 'WebFetch' ? jsonBrief(input) : undefined,
          diff,
          options
        },
        requestId
      )
      if (a.option === 'no') return deny(a.feedback)
      if (a.option === 'always' && always) {
        if (alwaysMode) {
          this.mode = alwaysMode
          this.host.setMode(alwaysMode)
        }
        return this.respond(requestId, { behavior: 'allow', updatedInput: input, updatedPermissions: always })
      }
      return this.respond(requestId, { behavior: 'allow', updatedInput: input })
    } catch {
      // 授权被撤回 / 视图关闭
      deny()
    }
  }
}

/* ---------------- 工具描述 ---------------- */

function textOf(content: Any): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((b: Any) => b?.type === 'text')
    .map((b: Any) => b.text)
    .join('\n')
}

function cleanPrompt(s: string): string {
  return s
    .replace(/<(ide_opened_file|ide_selection|system-reminder)>[\s\S]*?<\/\1>/g, '')
    .replace(/<command-message>[\s\S]*?<\/command-message>/g, '')
    .replace(/<command-name>([\s\S]*?)<\/command-name>\s*(?:<command-args>([\s\S]*?)<\/command-args>)?/g, (_m, n, a) => `${n}${a ? ' ' + a : ''}`)
    .trim()
}

function toolOutput(content: Any): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map((x: Any) => (x?.type === 'text' ? String(x.text) : x?.type === 'image' ? '[图片]' : '')).join('\n')
  return ''
}

function jsonBrief(input: Any): string | undefined {
  const j = JSON.stringify(input, null, 2)
  return j && j !== '{}' ? clip(j, 1500) : undefined
}

function suggestionLabel(tool: string, sugg: Any[]): string {
  const rules = sugg.flatMap((s) => (s.type === 'addRules' && Array.isArray(s.rules) ? s.rules : []))
  const r = rules[0]
  if (r?.ruleContent) return `是，并且不再询问 ${r.toolName ?? tool}(${clip(String(r.ruleContent), 60)})`
  const dirs = sugg.flatMap((s) => (s.type === 'addDirectories' && Array.isArray(s.directories) ? s.directories : []))
  if (dirs.length) return `是，并允许访问 ${rel(dirs[0])}`
  return '是，并且不再询问'
}

export function describe(name: string, i: Any): Omit<ToolView, 'status'> {
  const file = i.file_path ?? i.notebook_path
  switch (name) {
    case 'Read': {
      const range = i.offset ? ` (${i.offset}${i.limit ? '-' + (i.offset + i.limit - 1) : ''})` : ''
      return { icon: 'read', verb: '读取', summary: rel(file) + range, path: file, line: i.offset }
    }
    case 'Write':
      return { icon: 'write', verb: '写入', summary: rel(file), path: file, expanded: true }
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit': {
      const edits: Any[] = name === 'MultiEdit' && Array.isArray(i.edits) ? i.edits : name === 'Edit' ? [i] : []
      let diff: DiffInfo | undefined
      if (edits.length) {
        const hunks = edits.flatMap((e) => hunksFrom(lineDiff(String(e.old_string ?? ''), String(e.new_string ?? '')), 3))
        diff = { path: file, hunks, ...countChanges(hunks) }
      }
      return { icon: 'edit', verb: '编辑', summary: rel(file), path: file, diff, expanded: true }
    }
    case 'Bash':
      return { icon: 'bash', verb: '运行', summary: String(i.description || i.command || ''), input: i.command ? String(i.command) : undefined }
    case 'BashOutput':
    case 'KillShell':
    case 'KillBash':
      return { icon: 'bash', verb: name === 'BashOutput' ? '查看输出' : '结束进程', summary: String(i.bash_id ?? i.shell_id ?? '') }
    case 'Glob':
      return { icon: 'search', verb: '查找文件', summary: String(i.pattern ?? '') + (i.path ? `  ·  ${rel(i.path)}` : '') }
    case 'Grep':
      return { icon: 'search', verb: '搜索', summary: String(i.pattern ?? '') + (i.path ? `  ·  ${rel(i.path)}` : i.glob ? `  ·  ${i.glob}` : '') }
    case 'WebFetch':
      return { icon: 'web', verb: '访问网页', summary: String(i.url ?? '') }
    case 'WebSearch':
      return { icon: 'web', verb: '搜索网络', summary: String(i.query ?? '') }
    case 'Task':
    case 'Agent':
      return { icon: 'task', verb: i.subagent_type ? `子任务 · ${i.subagent_type}` : '子任务', summary: String(i.description ?? ''), input: i.prompt ? String(i.prompt) : undefined }
    case 'TodoWrite': {
      const todos: Any[] = Array.isArray(i.todos) ? i.todos : []
      const done = todos.filter((t) => t.status === 'completed').length
      return { icon: 'todo', verb: '更新待办', summary: todos.length ? `${done}/${todos.length} 已完成` : '', markdown: todos.length ? todoMarkdown(todos) : undefined, expanded: true }
    }
    case 'ExitPlanMode':
      return { icon: 'plan', verb: '计划', summary: '', markdown: i.plan ? String(i.plan) : undefined, expanded: true }
    case 'AskUserQuestion':
      return { icon: 'other', verb: '提问', summary: Array.isArray(i.questions) ? String(i.questions[0]?.question ?? '') : '' }
    case 'Skill':
      return { icon: 'other', verb: '使用技能', summary: String(i.skill ?? i.command ?? '') }
    case 'SlashCommand':
      return { icon: 'other', verb: '命令', summary: String(i.command ?? '') }
    case 'EnterPlanMode':
      return { icon: 'plan', verb: '进入计划模式', summary: '' }
    default: {
      const mcp = name.match(/^mcp__(.+?)__(.+)$/)
      if (mcp && mcp[1] === PANEL_MCP_SERVER && mcp[2] === 'getDiagnostics') {
        const uri = typeof i.uri === 'string' && i.uri ? i.uri : ''
        const path = uri ? decodeURIComponent(uri.replace(/^file:\/\/\/?/i, '')) : ''
        return { icon: 'search', verb: '查看诊断', summary: path ? rel(path) : '所有文件', path: path || undefined }
      }
      if (mcp) return { icon: 'mcp', verb: mcp[1].replace(/_/g, ' '), summary: mcp[2], input: jsonBrief(i) }
      const brief = JSON.stringify(i)
      return { icon: 'other', verb: name, summary: brief === '{}' ? '' : clip(brief, 120), input: jsonBrief(i) }
    }
  }
}

function patchHunks(sp: Any): Hunk[] {
  if (!Array.isArray(sp)) return []
  // 去掉 "\ No newline at end of file" 这类标记行
  return sp.map((p: Any) => ({ oldStart: p.oldStart, newStart: p.newStart, lines: Array.isArray(p.lines) ? p.lines.filter((l: string) => !l.startsWith('\\')) : [] }))
}

/** 已执行完的编辑：从现在的文件反推原文 */
function appliedDiff(path: string, hunks: Hunk[]): DiffInfo {
  return {
    path,
    hunks,
    ...countChanges(hunks),
    load: async () => {
      const modified = await readText(path)
      return { original: applyHunks(modified, hunks, true), modified }
    }
  }
}

function describeResult(name: string, input: Any, output: string, extra: Any, isError: boolean): Partial<ToolView> {
  if (isError) return { output, expanded: false }
  switch (name) {
    case 'Read': {
      const n = extra?.file?.numLines ?? (output ? output.split('\n').length : 0)
      return { output: undefined, outputHint: n ? `${n} 行` : undefined }
    }
    case 'Edit':
    case 'MultiEdit':
    case 'Write': {
      const path = extra?.filePath ?? input.file_path
      if (extra?.type === 'create' && typeof extra.content === 'string') {
        const lines = extra.content.split(/\r?\n/)
        if (lines[lines.length - 1] === '') lines.pop()
        const hunks: Hunk[] = [{ oldStart: 0, newStart: 1, lines: lines.map((l: string) => '+' + l) }]
        return { output: undefined, diff: appliedDiff(path, hunks), outputHint: '新文件' }
      }
      const hunks = patchHunks(extra?.structuredPatch)
      if (hunks.length) return { output: undefined, diff: appliedDiff(path, hunks) }
      return { output: undefined }
    }
    case 'Bash': {
      const out = extra && typeof extra.stdout === 'string' ? [extra.stdout, extra.stderr].filter(Boolean).join('\n') : output
      return { output: out || undefined, outputHint: out ? undefined : '无输出' }
    }
    case 'Glob': {
      const n = extra?.numFiles ?? (output ? output.split('\n').filter(Boolean).length : 0)
      return { outputHint: `${n} 个文件` }
    }
    case 'Grep': {
      const n = extra?.numFiles ?? extra?.numLines
      return { outputHint: n != null ? `${n} 个结果` : undefined }
    }
    case 'TodoWrite':
      return { output: undefined }
    case 'ExitPlanMode':
      return { output: undefined }
    case 'Task':
    case 'Agent':
      return { markdown: output || undefined, output: undefined, expanded: false }
    default:
      return {}
  }
}

/** 授权前的修改预览：读取现在的文件，算出修改后的内容 */
async function proposedDiff(name: string, i: Any): Promise<DiffInfo | undefined> {
  const path = String(i.file_path ?? '')
  if (!path) return undefined
  const original = await readText(path)
  let modified = original
  if (name === 'Write') modified = String(i.content ?? '')
  else {
    const edits: Any[] = name === 'MultiEdit' ? (i.edits ?? []) : [i]
    for (const e of edits) {
      const from = String(e.old_string ?? '')
      const to = String(e.new_string ?? '')
      if (!from) modified = to + modified
      else if (e.replace_all) modified = modified.split(from).join(to)
      else {
        const at = modified.indexOf(from)
        if (at < 0) return undefined
        modified = modified.slice(0, at) + to + modified.slice(at + from.length)
      }
    }
  }
  const hunks = hunksFrom(lineDiff(original, modified), 3)
  return { path, hunks, ...countChanges(hunks), load: async () => ({ original, modified }) }
}
