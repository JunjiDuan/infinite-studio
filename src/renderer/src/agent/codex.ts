import { CODEX_MODES, type CodexMode, type SessionInfo } from '../../../shared/agents'
import { listen, unlisten } from './bus'
import { applyHunks, countChanges, parseUnified, type Hunk } from './diff'
import type { ChatHost, DiffInfo, Driver, LoginMethod, LoginUi, ModelOption, PermissionOption, Question, SlashCommand, Todo, ToolView, UserInput } from './types'
import { basenameOf, clip, readText, rel } from './util'
import { resolvePath } from './markdown'

/**
 * Codex 驱动：和官方 VS Code 扩展一样，常驻一个 `codex app-server` 进程，
 * 通过 JSON-RPC 管理线程（thread）和轮次（turn），授权请求由服务器发给界面。
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

const CODEX_COMMANDS: SlashCommand[] = [
  { name: 'review', description: '审查当前未提交的修改' },
  { name: 'compact', description: '总结之前的对话，释放上下文' },
  { name: 'init', description: '生成 AGENTS.md，说明这个项目的约定' },
  { name: 'status', description: '查看当前模型、模式和用量' }
]

const INIT_PROMPT = `Generate a file named AGENTS.md that serves as a contributor guide for this repository.
Your goal is to produce a clear, concise, and well-structured document with descriptive headings and actionable explanations for each section.
Follow the outline below, but adapt as needed — add sections if relevant, and omit those that do not apply to this project.

Document Requirements
- Title the document "Repository Guidelines".
- Use Markdown headings (#, ##, etc.) for structure.
- Keep the document concise. 200-400 words is optimal.
- Keep explanations short, direct, and specific to this repository.
- Provide examples where helpful (commands, directory paths, naming patterns).
- Maintain a professional, instructional tone.

Recommended Sections
- Project Structure & Module Organization
- Build, Test, and Development Commands
- Coding Style & Naming Conventions
- Testing Guidelines
- Commit & Pull Request Guidelines
- (Optional) Security & Configuration Tips, Architecture Overview, or Agent-Specific Instructions`

export interface CodexOptions {
  mode: string
  model?: string
  effort?: string
}

export class CodexDriver implements Driver {
  models: ModelOption[] = []
  readonly commands = CODEX_COMMANDS
  readonly canRewind = false
  account?: string

  private runId: number | null = null
  private starting: Promise<void> | null = null
  private seq = 0
  private pending = new Map<number, { resolve: (v: Any) => void; reject: (e: Error) => void }>()
  private threadId: string | null = null
  private turnId: string | null = null
  private mode: CodexMode
  private model?: string
  private effort?: string
  private items = new Map<string, Any>()
  private reasoningPart = new Map<string, number>()
  private tokens: { total: number; window: number | null } | null = null
  private replay = false
  private modelsReady: Promise<void> = Promise.resolve()
  /** thread/start 返回的、按配置解析出的模型 */
  private resolvedModel?: string
  /** 实际使用的模型（界面显示用） */
  activeModel?: string

  constructor(
    private host: ChatHost,
    opts: CodexOptions
  ) {
    this.mode = CODEX_MODES.find((m) => m.id === opts.mode) ?? CODEX_MODES[0]
    this.model = opts.model
    this.effort = opts.effort
  }

  get sessionId(): string | null {
    return this.threadId
  }

  /* ---------------- 进程 / JSON-RPC ---------------- */

  start(): Promise<void> {
    return this.ensure()
  }

  private ensure(): Promise<void> {
    if (this.runId != null) return Promise.resolve()
    if (this.starting) return this.starting
    this.starting = (async () => {
      const id = await window.api.agent.start({ plugin: 'codex', cwd: this.host.cwd ?? undefined })
      this.runId = id
      listen(id, { event: (m) => this.onMessage(m), exit: (c, s) => this.onExit(id, c, s) })
      await this.request('initialize', { clientInfo: { name: 'infinite_studio', title: 'Infinite Studio', version: '0.1.0' }, capabilities: null }, 60_000)
      this.write({ method: 'initialized' })
      // 模型列表需要联网，不阻塞启动
      this.modelsReady = this.loadModels()
      void this.refreshAccount()
    })().finally(() => {
      this.starting = null
    })
    return this.starting
  }

  private async refreshAccount(): Promise<void> {
    try {
      const r = await this.request('account/read', {})
      const a = r?.account
      this.account = a ? [a.email, a.planType].filter(Boolean).join(' · ') || a.type : undefined
      this.host.capabilities()
    } catch {
      /* 读取失败不影响对话 */
    }
  }

  /* ---------------- 登录（和 VS Code 扩展一样走 app-server 的 account/login/*） ---------------- */

  readonly loginMethods: LoginMethod[] = [
    { id: 'chatgpt', label: '使用 ChatGPT 登录', hint: 'Plus、Pro、Business 等 ChatGPT 订阅' },
    { id: 'chatgptDeviceCode', label: '设备码登录', hint: '浏览器无法跳回本机时使用：在网页上输入一次性代码' },
    { id: 'apiKey', label: '使用 API Key', hint: '按 OpenAI API 用量计费', input: { label: 'OpenAI API Key', placeholder: 'sk-…', secret: true } }
  ]

  /** 等待 account/login/completed：loginId → 回调；先到的结果暂存 */
  private loginWaiters = new Map<string, (p: Any) => void>()
  private loginResults = new Map<string, Any>()

  async login(method: string, ui: LoginUi): Promise<void> {
    await this.ensure()
    if (method === 'apiKey') {
      const key = ui.input?.trim()
      if (!key) throw new Error('请输入 API Key')
      await this.request('account/login/start', { type: 'apiKey', apiKey: key }, 60_000)
    } else {
      const r = await this.request('account/login/start', { type: method === 'chatgptDeviceCode' ? 'chatgptDeviceCode' : 'chatgpt' }, 60_000)
      const loginId = String(r?.loginId ?? '')
      if (!loginId) throw new Error('无法开始登录')
      if (r.type === 'chatgptDeviceCode') {
        ui.code(String(r.userCode ?? ''))
        ui.url(String(r.verificationUrl), true)
      } else {
        ui.url(String(r.authUrl), true)
      }
      const done = await new Promise<Any>((resolve, reject) => {
        const early = this.loginResults.get(loginId)
        if (early) {
          this.loginResults.delete(loginId)
          return resolve(early)
        }
        this.loginWaiters.set(loginId, resolve)
        ui.onCancel(() => {
          this.loginWaiters.delete(loginId)
          this.request('account/login/cancel', { loginId }).catch(() => {})
          reject(new Error('已取消登录'))
        })
      })
      if (!done.success) throw new Error(done.error || '登录失败')
    }
    await this.refreshAccount()
    // 模型列表和账号有关，登录后重新读取
    this.modelsReady = this.loadModels()
  }

  async logout(): Promise<void> {
    await this.ensure()
    await this.request('account/logout', {})
    this.account = undefined
    this.host.capabilities()
  }

  private async loadModels(): Promise<void> {
    try {
      const r = await this.request('model/list', {}, 60_000)
      const data: Any[] = Array.isArray(r?.data) ? r.data : []
      this.models = data
        .filter((m) => !m.hidden)
        .map((m) => ({
          id: String(m.model ?? m.id),
          label: String(m.displayName ?? m.model),
          description: m.description,
          efforts: Array.isArray(m.supportedReasoningEfforts) ? m.supportedReasoningEfforts.map((e: Any) => e.reasoningEffort) : [],
          defaultEffort: m.defaultReasoningEffort,
          isDefault: !!m.isDefault
        }))
      this.host.capabilities()
    } catch {
      /* 离线时没有模型列表，用配置里的默认模型 */
    }
  }

  private write(msg: Record<string, unknown>): void {
    if (this.runId != null) window.api.agent.write(this.runId, msg)
  }

  private request(method: string, params: unknown, timeout = 120_000): Promise<Any> {
    const id = ++this.seq
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${method} 超时`))
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
      this.write({ id, method, params })
    })
  }

  private reply(id: unknown, result: unknown): void {
    this.write({ id, result } as Record<string, unknown>)
  }

  private replyError(id: unknown, message: string): void {
    this.write({ id, error: { code: -32601, message } } as Record<string, unknown>)
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
    if (this.host.busy() && !reported) this.host.crashed(stderr ? stderr.split('\n').slice(-6).join('\n') : `Codex 进程退出（${code}）`)
  }

  /* ---------------- 界面调用 ---------------- */

  private sandboxPolicy(): Any {
    switch (this.mode.sandbox) {
      case 'read-only':
        return { type: 'readOnly', networkAccess: false }
      case 'danger-full-access':
        return { type: 'dangerFullAccess' }
      default:
        return { type: 'workspaceWrite', writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false }
    }
  }

  private async ensureThread(): Promise<string> {
    await this.ensure()
    if (this.threadId) return this.threadId
    const r = await this.request('thread/start', {
      cwd: this.host.cwd ?? undefined,
      model: this.model || undefined,
      approvalPolicy: this.mode.approval,
      sandbox: this.mode.sandbox
    })
    this.threadId = r?.thread?.id ?? null
    if (!this.threadId) throw new Error('无法创建会话')
    if (typeof r.model === 'string') this.resolvedModel = r.model
    this.host.session(this.threadId)
    return this.threadId
  }

  /**
   * 这一轮用的模型：用户选过就用选的；否则用配置里的模型，
   * 但配置的模型不在当前账号可用的列表里时，改用列表的默认模型（和 VS Code 扩展的模型选择器一致）
   */
  private async effectiveModel(): Promise<string | undefined> {
    if (this.model) return this.model
    await Promise.race([this.modelsReady, new Promise((r) => setTimeout(r, 15_000))])
    const ids = this.models.map((m) => m.id)
    if (!ids.length || (this.resolvedModel && ids.includes(this.resolvedModel))) return undefined
    return this.models.find((m) => m.isDefault)?.id ?? ids[0]
  }

  async send(input: UserInput): Promise<void> {
    const slash = input.text.match(/^\/(review|compact|init|status)\b\s*([\s\S]*)$/)
    if (slash && !input.images.length) return this.runCommand(slash[1], slash[2].trim())
    const threadId = await this.ensureThread()
    const items = await this.buildInput(input)
    const model = await this.effectiveModel()
    this.setActive(model ?? this.resolvedModel)
    this.host.turnStarted()
    try {
      const r = await this.request('turn/start', {
        threadId,
        input: items,
        model,
        effort: this.effort || undefined,
        approvalPolicy: this.mode.approval,
        sandboxPolicy: this.sandboxPolicy()
      })
      if (r?.turn?.id) this.turnId = r.turn.id
    } catch (e) {
      this.host.turnEnded({ ok: false, error: (e as Error).message })
    }
  }

  /** 正在运行时补充说明（turn/steer） */
  async steer(text: string): Promise<boolean> {
    if (!this.threadId || !this.turnId) return false
    try {
      await this.request('turn/steer', { threadId: this.threadId, expectedTurnId: this.turnId, input: [{ type: 'text', text, text_elements: [] }] })
      return true
    } catch {
      return false
    }
  }

  private async buildInput(input: UserInput): Promise<Any[]> {
    const ctx = input.context
    let text = input.text
    // 和 VS Code 的 Codex 扩展一样的 IDE 上下文：当前文件、选中内容、打开的标签页
    const file = ctx.selection?.path ?? ctx.file
    const tabs = ctx.openTabs ?? []
    if (file || tabs.length) {
      let block = ''
      if (file) block += `\n## Active file: ${rel(file)}\n`
      if (ctx.selection) block += `\n## Active selection of the file:\n${ctx.selection.text}`
      if (tabs.length) {
        block += '\n## Open tabs:\n'
        for (const p of tabs) block += `- ${basenameOf(p)}: ${rel(p)}\n`
      }
      text = `# Context from my IDE setup:\n${block}\n## My request for Codex:\n${text}`
    }
    const items: Any[] = [{ type: 'text', text, text_elements: [] }]
    for (const img of input.images) {
      const path = await window.api.agent.saveImage(img.dataUrl)
      items.push({ type: 'localImage', path })
    }
    // @文件 → mention
    const seen = new Set<string>()
    for (const m of input.text.matchAll(/(?:^|\s)@(?:"([^"]+)"|(\S+))/g)) {
      const p = (m[1] ?? m[2]).replace(/#L\d+(?:-\d+)?$/, '')
      if (seen.has(p) || !/[./\\]/.test(p)) continue
      seen.add(p)
      items.push({ type: 'mention', name: basenameOf(p), path: resolvePath(p) })
    }
    return items
  }

  private setActive(m: string | undefined): void {
    if (!m || m === this.activeModel) return
    this.activeModel = m
    this.host.capabilities()
  }

  private async runCommand(name: string, args: string): Promise<void> {
    if (name === 'init') return this.send({ text: INIT_PROMPT, images: [], context: {} })
    if (name === 'status') {
      const lines = [
        `模型：${this.model || this.activeModel || '默认'}${this.effort ? `（思考强度 ${this.effort}）` : ''}`,
        `模式：${this.mode.label}（沙箱 ${this.mode.sandbox}，审批 ${this.mode.approval}）`,
        `工作目录：${this.host.cwd ?? '用户主目录'}`
      ]
      if (this.account) lines.push(`账号：${this.account}`)
      if (this.threadId) lines.push(`会话：${this.threadId}`)
      if (this.tokens) lines.push(`上下文：${this.tokens.total.toLocaleString()} tokens${this.tokens.window ? ` / ${this.tokens.window.toLocaleString()}` : ''}`)
      try {
        await this.ensure()
        const rl = await this.request('account/rateLimits/read', {}, 15_000)
        const p = rl?.rateLimits?.primary
        if (p?.usedPercent != null) lines.push(`5 小时用量：${Math.round(p.usedPercent)}%`)
        const s = rl?.rateLimits?.secondary
        if (s?.usedPercent != null) lines.push(`每周用量：${Math.round(s.usedPercent)}%`)
      } catch {
        /* 没有用量信息 */
      }
      this.host.note(lines.join('\n'))
      // 界面发送时已经进入“运行中”，本地命令没有轮次，要自己结束
      if (this.host.busy()) this.host.turnEnded({ ok: true })
      return
    }
    const threadId = await this.ensureThread()
    this.host.turnStarted()
    try {
      if (name === 'compact') await this.request('thread/compact/start', { threadId })
      else {
        const target = args ? { type: 'custom', instructions: args } : { type: 'uncommittedChanges' }
        const r = await this.request('review/start', { threadId, target, delivery: 'inline' })
        if (r?.turn?.id) this.turnId = r.turn.id
      }
    } catch (e) {
      this.host.turnEnded({ ok: false, error: (e as Error).message })
    }
  }

  interrupt(): void {
    if (!this.threadId || !this.turnId) {
      if (this.host.busy()) this.host.turnEnded({ ok: false, interrupted: true })
      return
    }
    this.request('turn/interrupt', { threadId: this.threadId, turnId: this.turnId }, 10_000).catch(() => {
      if (this.host.busy()) this.host.turnEnded({ ok: false, interrupted: true })
    })
  }

  setMode(id: string): void {
    this.mode = CODEX_MODES.find((m) => m.id === id) ?? this.mode
  }

  setModel(id: string, effort?: string): void {
    this.model = id || undefined
    this.effort = effort
  }

  async listSessions(): Promise<SessionInfo[]> {
    await this.ensure()
    const r = await this.request('thread/list', { limit: 100, sortKey: 'updated_at', cwd: this.host.cwd ?? undefined }, 30_000)
    const data: Any[] = Array.isArray(r?.data) ? r.data : []
    return data.map((t) => ({ id: String(t.id), title: String(t.name || t.preview || '（无标题）').replace(/\s+/g, ' ').slice(0, 120), updatedAt: (t.updatedAt ?? t.createdAt ?? 0) * 1000 }))
  }

  async resume(id: string): Promise<void> {
    await this.ensure()
    const r = await this.request('thread/resume', { threadId: id, cwd: this.host.cwd ?? undefined, approvalPolicy: this.mode.approval, sandbox: this.mode.sandbox })
    this.threadId = id
    this.turnId = null
    this.items.clear()
    const thread = r?.thread
    const turns: Any[] = Array.isArray(thread?.turns) ? thread.turns : []
    this.replay = true
    try {
      for (const t of turns) for (const it of t.items ?? []) this.renderItem(it, true)
    } finally {
      this.replay = false
    }
    this.host.session(id, thread?.name || thread?.preview || undefined)
  }

  reset(): void {
    this.threadId = null
    this.turnId = null
    this.items.clear()
    this.tokens = null
  }

  dispose(): void {
    this.stopProcess()
  }

  /* ---------------- 消息 ---------------- */

  private onMessage(m: Any): void {
    if (!m || typeof m !== 'object') return
    // 我们发出的请求的回复
    if (m.id !== undefined && m.method === undefined) {
      const p = this.pending.get(m.id)
      if (!p) return
      this.pending.delete(m.id)
      if (m.error) p.reject(new Error(String(m.error.message ?? '请求失败')))
      else p.resolve(m.result)
      return
    }
    // 服务器发来的请求（授权等）
    if (m.id !== undefined && typeof m.method === 'string') {
      void this.onServerRequest(m.id, m.method, m.params ?? {})
      return
    }
    if (typeof m.method === 'string') this.onNotification(m.method, m.params ?? {})
  }

  private mine(p: Any): boolean {
    return !p?.threadId || p.threadId === this.threadId
  }

  private onNotification(method: string, p: Any): void {
    if (method === 'account/login/completed') {
      const id = String(p.loginId ?? '')
      const w = this.loginWaiters.get(id)
      if (w) {
        this.loginWaiters.delete(id)
        w(p)
      } else if (id) this.loginResults.set(id, p)
      return
    }
    if (method === 'account/updated') {
      void this.refreshAccount()
      return
    }
    if (!this.mine(p)) return
    switch (method) {
      case 'turn/started':
        if (p.turn?.id) this.turnId = p.turn.id
        if (!this.host.busy()) this.host.turnStarted()
        return
      case 'turn/completed': {
        const t = p.turn ?? {}
        if (t.id && this.turnId && t.id !== this.turnId) return
        this.turnId = null
        if (!this.host.busy()) return
        if (t.status === 'interrupted') this.host.turnEnded({ ok: false, interrupted: true, durationMs: t.durationMs ?? undefined })
        else if (t.status === 'failed') this.host.turnEnded({ ok: false, error: t.error?.message ?? '出错了', durationMs: t.durationMs ?? undefined })
        else this.host.turnEnded({ ok: true, durationMs: t.durationMs ?? undefined })
        return
      }
      case 'item/started':
        return this.renderItem(p.item, false)
      case 'item/completed':
        return this.renderItem(p.item, true)
      case 'item/agentMessage/delta':
        return this.host.text(p.itemId, String(p.delta ?? ''), true)
      case 'item/reasoning/summaryTextDelta': {
        const last = this.reasoningPart.get(p.itemId)
        const sep = last !== undefined && last !== p.summaryIndex ? '\n\n' : ''
        this.reasoningPart.set(p.itemId, p.summaryIndex)
        return this.host.thinking(p.itemId, sep + String(p.delta ?? ''), { append: true })
      }
      case 'item/reasoning/summaryPartAdded':
        return
      case 'item/commandExecution/outputDelta': {
        const t = this.host.getTool(p.itemId)
        if (t) this.host.tool(p.itemId, { output: clip((t.output ?? '') + String(p.delta ?? ''), 60_000) })
        return
      }
      case 'turn/plan/updated': {
        const plan: Any[] = Array.isArray(p.plan) ? p.plan : []
        const todos: Todo[] = plan.map((s) => ({ content: String(s.step ?? ''), status: s.status === 'completed' ? 'completed' : s.status === 'inProgress' ? 'in_progress' : 'pending' }))
        this.host.todos(todos)
        return
      }
      case 'thread/tokenUsage/updated': {
        const u = p.tokenUsage
        const used = u?.last?.totalTokens ?? 0
        this.tokens = { total: used, window: u?.modelContextWindow ?? null }
        if (used) this.host.usage(used, u?.modelContextWindow ?? null)
        return
      }
      case 'thread/name/updated':
        if (p.threadName) this.host.session(this.threadId, p.threadName)
        return
      case 'thread/compacted':
        return this.host.note('对话已压缩，之前的内容已总结')
      case 'error': {
        const msg = p.error?.message ?? '出错了'
        if (p.willRetry) this.host.status(`出错了，正在重试…（${msg}）`)
        // 轮次中的错误会随 turn/completed 一起显示
        else if (!this.host.busy()) this.host.note(msg, 'error')
        return
      }
      case 'warning':
      case 'guardianWarning':
        if (p.message) this.host.note(String(p.message))
        return
      case 'serverRequest/resolved':
        if (p.requestId !== undefined) this.host.cancelPermission(String(p.requestId))
        return
      case 'model/rerouted':
        if (p.toModel) this.host.note(`已切换到模型 ${p.toModel}`)
        return
    }
  }

  private renderItem(it: Any, completed: boolean): void {
    if (!it?.id) return
    this.items.set(it.id, it)
    const id: string = it.id
    switch (it.type) {
      case 'userMessage': {
        if (!this.replay) return
        const text = (it.content ?? [])
          .filter((c: Any) => c.type === 'text')
          .map((c: Any) => stripContext(String(c.text ?? '')))
          .join('\n')
        const images = (it.content ?? []).filter((c: Any) => c.type === 'image' || c.type === 'localImage').length
        if (text || images) this.host.userMessage(text, { images, id })
        return
      }
      case 'agentMessage':
        if (completed || it.text) this.host.text(id, String(it.text ?? ''))
        return
      case 'reasoning': {
        const text = (it.summary?.length ? it.summary : (it.content ?? [])).join('\n\n')
        if (completed && !text && !this.host.getTool(id)) return
        this.host.thinking(id, text, { done: completed })
        return
      }
      case 'plan':
        this.host.tool(id, { icon: 'plan', verb: '计划', summary: '', markdown: String(it.text ?? ''), status: completed ? 'done' : 'running', expanded: true })
        return
      case 'commandExecution':
        this.host.tool(id, { ...describeCommand(it), status: statusOf(it.status, completed, it.exitCode) })
        return
      case 'fileChange': {
        const changes: Any[] = Array.isArray(it.changes) ? it.changes : []
        const applied = it.status === 'completed'
        changes.forEach((c, k) => {
          const hunks = parseUnified(String(c.diff ?? ''))
          const kind = c.kind?.type
          this.host.tool(changes.length > 1 ? `${id}:${k}` : id, {
            icon: kind === 'add' ? 'write' : 'edit',
            verb: kind === 'add' ? '新建' : kind === 'delete' ? '删除' : '编辑',
            summary: rel(c.path) + (c.kind?.move_path ? ` → ${rel(c.kind.move_path)}` : ''),
            path: kind === 'delete' ? undefined : (c.kind?.move_path ?? c.path),
            diff: changeDiff(c.kind?.move_path ?? c.path, hunks, applied),
            status: statusOf(it.status, completed),
            expanded: true
          })
        })
        return
      }
      case 'mcpToolCall':
        this.host.tool(id, {
          icon: 'mcp',
          verb: String(it.server ?? 'MCP'),
          summary: String(it.tool ?? ''),
          input: it.arguments ? clip(JSON.stringify(it.arguments, null, 2), 2000) : undefined,
          output: it.error?.message ?? mcpText(it.result),
          status: statusOf(it.status, completed, it.error ? 1 : 0)
        })
        return
      case 'dynamicToolCall':
        this.host.tool(id, { icon: 'other', verb: String(it.tool ?? '工具'), summary: '', input: it.arguments ? clip(JSON.stringify(it.arguments, null, 2), 2000) : undefined, status: statusOf(it.status, completed, it.success === false ? 1 : 0) })
        return
      case 'webSearch': {
        const a = it.action
        const summary = it.query || a?.query || a?.url || (Array.isArray(a?.queries) ? a.queries.join('，') : '') || ''
        this.host.tool(id, { icon: 'web', verb: a?.type === 'openPage' ? '打开网页' : '搜索网络', summary: String(summary), status: completed ? 'done' : 'running' })
        return
      }
      case 'imageView':
        this.host.tool(id, { icon: 'read', verb: '查看图片', summary: rel(it.path), path: it.path, status: 'done' })
        return
      case 'collabAgentToolCall':
      case 'subAgentActivity':
        this.host.tool(id, { icon: 'task', verb: '子任务', summary: String(it.prompt ?? it.tool ?? it.description ?? ''), status: completed ? 'done' : 'running' })
        return
      case 'enteredReviewMode':
        if (!completed) this.host.note('正在审查代码…')
        return
      case 'exitedReviewMode':
        if (completed && it.review) this.host.text(id, String(it.review))
        return
      case 'contextCompaction':
        if (completed) this.host.note('对话已压缩，之前的内容已总结')
        return
    }
  }

  /* ---------------- 授权 ---------------- */

  private async onServerRequest(id: number | string, method: string, p: Any): Promise<void> {
    const key = String(id)
    try {
      switch (method) {
        case 'item/commandExecution/requestApproval': {
          const options: PermissionOption[] = [
            { id: 'accept', label: '是' },
            { id: 'session', label: '是，本次会话中不再询问' }
          ]
          const amend = p.proposedExecpolicyAmendment
          if (amend && Array.isArray(amend.command ?? amend)) options.push({ id: 'amend', label: `是，以后允许以“${(amend.command ?? amend).join(' ')}”开头的命令` })
          options.push({ id: 'decline', label: '否，告诉 Codex 该怎么做', feedback: true })
          const a = await this.host.permission({ title: 'Codex 想要运行这条命令', detail: p.reason ?? undefined, code: unwrapShell(String(p.command ?? '')), options }, key)
          const decision = a.option === 'accept' ? 'accept' : a.option === 'session' ? 'acceptForSession' : a.option === 'amend' ? { acceptWithExecpolicyAmendment: { execpolicy_amendment: amend } } : 'decline'
          this.reply(id, { decision })
          if (a.option === 'decline' && a.feedback) void this.steer(a.feedback)
          return
        }
        case 'item/fileChange/requestApproval': {
          const item = this.items.get(p.itemId)
          const changes: Any[] = Array.isArray(item?.changes) ? item.changes : []
          const first = changes[0]
          const diff = first ? changeDiff(first.kind?.move_path ?? first.path, parseUnified(String(first.diff ?? '')), false) : undefined
          const names = changes.map((c) => rel(c.path)).join('、')
          const a = await this.host.permission(
            {
              title: names ? `Codex 想要修改 ${clip(names, 120)}` : 'Codex 想要修改文件',
              detail: p.reason ?? (p.grantRoot ? `并获得 ${p.grantRoot} 的写入权限` : undefined),
              diff,
              options: [
                { id: 'accept', label: '是' },
                { id: 'session', label: '是，本次会话中允许所有修改' },
                { id: 'decline', label: '否，告诉 Codex 该怎么做', feedback: true }
              ]
            },
            key
          )
          this.reply(id, { decision: a.option === 'accept' ? 'accept' : a.option === 'session' ? 'acceptForSession' : 'decline' })
          if (a.option === 'decline' && a.feedback) void this.steer(a.feedback)
          return
        }
        case 'item/tool/requestUserInput': {
          const qs: Question[] = (p.questions ?? []).map((q: Any) => ({
            id: String(q.id),
            header: q.header,
            question: String(q.question ?? ''),
            options: Array.isArray(q.options) ? q.options.map((o: Any) => ({ label: String(o.label), description: o.description })) : [],
            allowOther: !!q.isOther || !q.options?.length
          }))
          const ans = await this.host.ask(qs, key)
          const answers: Record<string, { answers: string[] }> = {}
          if (ans) for (const q of qs) answers[q.id] = { answers: ans[q.id] ?? [] }
          this.reply(id, { answers })
          return
        }
        case 'execCommandApproval':
        case 'applyPatchApproval':
          this.reply(id, { decision: 'denied' })
          return
        default:
          this.replyError(id, `Infinite Studio 不支持 ${method}`)
      }
    } catch {
      // 授权被撤回 / 视图关闭
      if (method === 'item/tool/requestUserInput') this.reply(id, { answers: {} })
      else if (method.endsWith('requestApproval')) this.reply(id, { decision: 'cancel' })
    }
  }
}

/* ---------------- 工具描述 ---------------- */

function statusOf(s: string | undefined, completed: boolean, exitCode?: number | null): ToolView['status'] {
  if (s === 'declined') return 'denied'
  if (s === 'failed' || (typeof exitCode === 'number' && exitCode !== 0 && completed)) return 'error'
  if (s === 'completed' || completed) return 'done'
  return 'running'
}

/** 去掉 bash -lc '…' / powershell -Command "…" 外壳，只显示真正的命令 */
function unwrapShell(cmd: string): string {
  // 可执行文件可能是带空格的带引号路径，例如 "C:\Program Files\PowerShell\7\pwsh.exe"
  const m = cmd.match(
    /^(?:(?:"[^"]*(?:bash|zsh|sh)(?:\.exe)?"|\S*(?:bash|zsh|sh)(?:\.exe)?)\s+-l?c\s+|(?:"[^"]*(?:powershell|pwsh)(?:\.exe)?"|\S*(?:powershell|pwsh)(?:\.exe)?)\s+(?:-NoLogo\s+)?(?:-NoProfile\s+)?-Command\s+)(['"])([\s\S]*)\1$/i
  )
  return m ? m[2] : cmd
}

function describeCommand(it: Any): Omit<ToolView, 'status'> {
  const cmd = unwrapShell(String(it.command ?? ''))
  const acts: Any[] = Array.isArray(it.commandActions) ? it.commandActions : []
  const output = it.aggregatedOutput || undefined
  if (acts.length && acts.every((a) => a.type === 'read')) {
    return { icon: 'read', verb: '读取', summary: acts.map((a) => rel(a.path ?? a.name)).join('、'), path: acts.length === 1 ? acts[0].path : undefined, input: cmd, output }
  }
  if (acts.length && acts.every((a) => a.type === 'search' || a.type === 'listFiles')) {
    const a = acts[0]
    return { icon: 'search', verb: a.type === 'search' ? '搜索' : '列出文件', summary: String(a.query ?? a.path ?? cmd), input: cmd, output }
  }
  return { icon: 'bash', verb: '运行', summary: cmd, input: cmd, output, outputHint: it.exitCode != null && it.exitCode !== 0 ? `退出码 ${it.exitCode}` : undefined }
}

function changeDiff(path: string, hunks: Hunk[], applied: boolean): DiffInfo {
  return {
    path,
    hunks,
    ...countChanges(hunks),
    load: async () => {
      const now = await readText(path)
      return applied ? { original: applyHunks(now, hunks, true), modified: now } : { original: now, modified: applyHunks(now, hunks) }
    }
  }
}

function mcpText(result: Any): string | undefined {
  const c = result?.content
  if (!Array.isArray(c)) return undefined
  return clip(c.map((x: Any) => (x.type === 'text' ? x.text : `[${x.type}]`)).join('\n'), 20_000) || undefined
}

function stripContext(s: string): string {
  const i = s.indexOf('## My request for Codex:')
  return (i >= 0 ? s.slice(i + '## My request for Codex:'.length) : s).trim()
}

