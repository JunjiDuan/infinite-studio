import { AGENT_MODES, type LoginEvent, type SessionInfo } from '../../../shared/agents'
import type { PluginDef } from '../../../shared/plugins'
import { listen, unlisten } from './bus'
import { describe } from './claude'
import { countChanges, hunksFrom, lineDiff } from './diff'
import { resolvePath } from './markdown'
import type { ChatHost, DiffInfo, Driver, LoginMethod, LoginUi, ModelOption, PermissionOption, SlashCommand, Todo, ToolView, UserInput } from './types'
import { basenameOf, clip, readText, rel } from './util'
import { t } from '../i18n'

/**
 * ACP（Agent Client Protocol）驱动：Gemini（Antigravity CLI，`agy acp`）、Kimi Code（`kimi acp`）和 DeepSeek Harness（`dsh --profile acp`）。
 * 每个对话一个常驻进程，JSON-RPC 2.0：initialize → session/new | session/load | session/resume →
 * session/prompt（期间 agent 推送 session/update、发来 session/request_permission）。
 *
 * 各自的差别：
 * - Gemini（插件 id 为 antigravity）：Google 账号登录（authenticate oauth-personal，agy 自己打开浏览器；凭据存在系统钥匙串）；
 *   不用它的模式，授权请求由界面按模式应答；session/list 列出历史，session/load 回放。
 * - Kimi：需要登录（kimi login 设备码）；有模式（session/set_mode）、斜杠命令、待办计划；session/load 回放历史。
 * - DeepSeek：API Key 存在 ~/.dsh/.credentials.yaml；没有模式（授权由界面按模式应答）；
 *   session/resume 不回放，历史由主进程读本地日志转换成 session/update。
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

export interface AcpOptions {
  mode: string
  model?: string
  effort?: string
}

/** 解析出的 select 型配置项（模型 / 思考强度 / 模式） */
interface ConfigSelect {
  id: string
  category?: string
  current: string
  options: { value: string; name: string; description?: string }[]
}

interface ToolState {
  title: string
  kind?: string
  input: Any
  path?: string
  view: Omit<ToolView, 'status'>
  /** 规范化的工具名（Read / Edit / Bash…），认不出时为空 */
  name?: string
}

const NO_TIMEOUT = 0

export class AcpDriver implements Driver {
  models: ModelOption[] = []
  commands: SlashCommand[] = []
  readonly canRewind = false
  account?: string
  activeModel?: string

  private readonly plugin: string
  private runId: number | null = null
  private starting: Promise<void> | null = null
  private creating: Promise<string> | null = null
  private seq = 0
  private pending = new Map<number, { resolve: (v: Any) => void; reject: (e: Error) => void }>()
  private sid: string | null = null
  private caps: Any = {}
  private config: ConfigSelect[] = []
  /** session/new 返回的 models（没有 model 配置项时用 session/set_model） */
  private legacyModels = false
  private availableModes: string[] = []
  private mode: string
  private model?: string
  private effort?: string
  private promptActive = false
  private tools = new Map<string, ToolState>()
  private replay = false
  /** 文本 / 思考块：连续的同类更新合并到一个块里 */
  private blockSeq = 0
  private last: { kind: 'text' | 'thought' | 'tool' | 'user'; id: string; msg?: string } | null = null
  private userBuf: { id?: string; text: string; time?: number } | null = null
  /** listSessions 记下的会话目录（DeepSeek 的 session/resume 要求原工作区） */
  private sessionCwd = new Map<string, string>()
  private disposed = false

  constructor(
    private host: ChatHost,
    private def: PluginDef,
    opts: AcpOptions
  ) {
    this.plugin = def.id
    const modes = AGENT_MODES[def.id] ?? []
    this.mode = modes.some((m) => m.id === opts.mode) ? opts.mode : (modes[0]?.id ?? '')
    this.model = opts.model
    this.effort = opts.effort
  }

  get sessionId(): string | null {
    return this.sid
  }

  private get isKimi(): boolean {
    return this.plugin === 'kimi'
  }

  private get isAntigravity(): boolean {
    return this.plugin === 'antigravity'
  }

  /** 授权请求由界面按模式应答（agent 没有可用的模式）：选“自动批准”时直接同意 */
  private get uiModes(): boolean {
    return this.plugin === 'deepseek' || this.isAntigravity
  }

  /** 模式由 agent 自己执行（session/set_mode）；DeepSeek 没有模式，由界面应答授权 */
  private get agentModes(): boolean {
    return this.isKimi
  }

  /* ---------------- 进程 / JSON-RPC ---------------- */

  async start(): Promise<void> {
    await this.ensure()
    if (this.plugin === 'deepseek') {
      const st = await window.api.agent.deepseekKeyStatus().catch(() => null)
      this.account = st?.configured ? t('API Key {0}', st.masked ?? '') : undefined
      this.host.capabilities()
      // 没有 Key 也能建会话（读取模型列表），发消息时才需要
      if (st && !st.configured) this.host.note(t('还没有配置 DeepSeek API Key，点击登录填写'), 'action')
    }
    // 先建好会话：拿到模型、思考强度、命令列表
    try {
      await this.ensureSession()
      if (this.isKimi) this.account = t('Kimi 账号')
      if (this.isAntigravity) this.account = t('Google 账号')
      this.host.capabilities()
    } catch (e) {
      const msg = (e as Error).message
      if (this.isKimi && /auth/i.test(msg)) this.host.note(t('请先登录 Kimi 账号'), 'action')
      else if (this.isAntigravity && /auth|credential|login|sign in/i.test(msg)) this.host.note(t('请先登录 Gemini：使用 Google 账号'), 'action')
      else this.host.note(msg, 'error')
    }
  }

  private ensure(): Promise<void> {
    if (this.runId != null) return Promise.resolve()
    if (this.starting) return this.starting
    this.starting = (async () => {
      const id = await window.api.agent.start({ plugin: this.plugin, cwd: this.host.cwd ?? undefined })
      this.runId = id
      listen(id, { event: (m) => this.onMessage(m), exit: (c, s) => this.onExit(id, c, s) })
      const r = await this.request(
        'initialize',
        {
          protocolVersion: 1,
          // 不提供文件系统和终端：agent 自己读写文件、运行命令
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
          clientInfo: { name: 'infinite-studio', title: 'Infinite Studio', version: '0.1.0' }
        },
        120_000
      )
      this.caps = r?.agentCapabilities ?? {}
    })().finally(() => {
      this.starting = null
    })
    return this.starting
  }

  /** 连回 IDE 的 MCP 桥接：插件提供的 AI 工具（PDF、演示文稿、思维导图……）。拿不到时不带 */
  private mcp: Promise<Record<string, unknown>[]> | null = null
  private mcpServers(): Promise<Record<string, unknown>[]> {
    if (!this.mcp) this.mcp = window.api.agent.mcpServers().catch(() => [])
    return this.mcp
  }

  private write(msg: Record<string, unknown>): void {
    if (this.runId != null) window.api.agent.write(this.runId, { jsonrpc: '2.0', ...msg })
  }

  private request(method: string, params: unknown, timeout = 120_000): Promise<Any> {
    const id = ++this.seq
    return new Promise((resolve, reject) => {
      const timer = timeout ? setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(t('{0} 超时', method)))
      }, timeout) : undefined
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
    for (const p of this.pending.values()) p.reject(new Error(t('进程已结束')))
    this.pending.clear()
    this.sid = null
  }

  private onExit(id: number, code: number, stderr: string): void {
    if (this.runId !== id) return
    this.runId = null
    this.sid = null
    const tail = lastLines(stderr, 6)
    const reported = this.pending.size > 0
    for (const p of this.pending.values()) p.reject(new Error(tail || t('进程已退出')))
    this.pending.clear()
    if (this.disposed) return
    if (this.host.busy() && !reported) this.host.crashed(tail || t('{0} 进程退出（{1}）', this.def.name, code))
  }

  /* ---------------- 会话 ---------------- */

  private async ensureSession(): Promise<string> {
    await this.ensure()
    if (this.sid) return this.sid
    if (this.creating) return this.creating
    this.creating = (async () => {
      const r = await this.request('session/new', { cwd: this.host.cwd ?? '', mcpServers: await this.mcpServers() }, 120_000)
      const sid = String(r?.sessionId ?? '')
      if (!sid) throw new Error(t('无法创建会话'))
      this.sid = sid
      this.tools.clear()
      this.onSessionState(r)
      this.host.session(sid)
      await this.applyPrefs()
      return sid
    })().finally(() => {
      this.creating = null
    })
    return this.creating
  }

  /** session/new、load、resume 的返回：配置项、模式、模型 */
  private onSessionState(r: Any): void {
    if (Array.isArray(r?.configOptions)) this.applyConfig(r.configOptions)
    else if (r?.models && Array.isArray(r.models.availableModels)) {
      this.legacyModels = true
      this.models = r.models.availableModels.map((m: Any) => ({ id: String(m.modelId), label: String(m.name ?? m.modelId), description: m.description ?? undefined }))
      this.activeModel = r.models.currentModelId ?? undefined
      this.host.capabilities()
    }
    if (this.agentModes && r?.modes && Array.isArray(r.modes.availableModes)) {
      this.availableModes = r.modes.availableModes.map((m: Any) => String(m.id))
      const cur = r.modes.currentModeId
      if (cur && cur !== this.mode && !this.availableModes.includes(this.mode)) {
        this.mode = cur
        this.host.setMode(cur)
      }
    }
  }

  private applyConfig(list: Any[]): void {
    this.config = list.filter((o) => o && o.type === 'select').map((o) => ({ id: String(o.id), category: o.category ?? undefined, current: String(o.currentValue ?? ''), options: flattenOptions(o.options) }))
    const model = this.option('model')
    const effort = this.option('thought_level')
    if (model) {
      this.legacyModels = false
      const efforts = effort ? effort.options.map((o) => o.value) : []
      this.models = model.options.map((o) => ({ id: o.value, label: o.name, description: o.description, efforts }))
      this.activeModel = model.current || undefined
    }
    this.host.capabilities()
  }

  private option(category: 'model' | 'thought_level' | 'mode'): ConfigSelect | undefined {
    const ids: Record<string, string[]> = { model: ['model'], thought_level: ['reasoning_effort', 'thinking', 'effort'], mode: ['mode'] }
    return this.config.find((o) => o.category === category) ?? this.config.find((o) => ids[category].includes(o.id))
  }

  /** 把界面上选过的模型、思考强度、模式应用到当前会话 */
  private async applyPrefs(): Promise<void> {
    if (!this.sid) return
    const sid = this.sid
    try {
      if (this.model && this.model !== this.activeModel) {
        const m = this.option('model')
        if (m?.options.some((o) => o.value === this.model)) await this.setConfig(m.id, this.model)
        else if (this.legacyModels && this.models.some((x) => x.id === this.model)) {
          await this.request('session/set_model', { sessionId: sid, modelId: this.model })
          this.activeModel = this.model
          this.host.capabilities()
        }
      }
      const e = this.option('thought_level')
      if (this.effort && e && e.current !== this.effort && e.options.some((o) => o.value === this.effort)) await this.setConfig(e.id, this.effort)
      if (this.agentModes && this.mode && this.availableModes.includes(this.mode)) await this.request('session/set_mode', { sessionId: sid, modeId: this.mode })
    } catch (err) {
      this.host.note(t('应用设置失败：{0}', (err as Error).message), 'error')
    }
  }

  private async setConfig(configId: string, value: string): Promise<void> {
    if (!this.sid) return
    const r = await this.request('session/set_config_option', { sessionId: this.sid, configId, value })
    if (Array.isArray(r?.configOptions)) this.applyConfig(r.configOptions)
  }

  private closeSession(): void {
    const sid = this.sid
    this.sid = null
    if (sid && this.caps?.sessionCapabilities?.close && this.runId != null) this.request('session/close', { sessionId: sid }, 30_000).catch(() => {})
  }

  /* ---------------- 界面调用 ---------------- */

  async send(input: UserInput): Promise<void> {
    const sid = await this.ensureSession()
    const prompt = await this.buildPrompt(input)
    if (!this.host.busy()) this.host.turnStarted()
    this.last = null
    this.promptActive = true
    try {
      const r = await this.request('session/prompt', { sessionId: sid, prompt }, NO_TIMEOUT)
      const reason = String(r?.stopReason ?? 'end_turn')
      if (!this.host.busy()) return
      if (reason === 'cancelled') this.host.turnEnded({ ok: false, interrupted: true })
      else if (reason === 'refusal') this.host.turnEnded({ ok: false, error: t('模型拒绝了这个请求') })
      else {
        if (reason === 'max_tokens') this.host.note(t('回答达到了最大长度，已截断'))
        else if (reason === 'max_turn_requests') this.host.note(t('本轮的模型调用次数达到上限，已停止'))
        this.host.turnEnded({ ok: true })
      }
    } catch (e) {
      if (this.host.busy()) this.host.turnEnded({ ok: false, error: (e as Error).message })
    } finally {
      this.promptActive = false
      this.finishThought()
    }
    if (this.plugin === 'deepseek') void this.refreshTitle(sid)
  }

  /** DeepSeek 不推送标题：一轮结束后从会话列表里取 */
  private async refreshTitle(sid: string): Promise<void> {
    try {
      const list = await this.listSessions()
      const s = list.find((x) => x.id === sid)
      if (s?.title && this.sid === sid) this.host.session(sid, s.title)
    } catch {
      /* ignore */
    }
  }

  private async buildPrompt(input: UserInput): Promise<Any[]> {
    const blocks: Any[] = []
    const ctx = input.context
    // 和 Claude Code 的 VS Code 扩展一样，把编辑器上下文作为单独的文本块放在前面
    if (ctx.selection) {
      const s = ctx.selection
      blocks.push({ type: 'text', text: `<ide_selection>The user selected lines ${s.startLine} to ${s.endLine} from ${rel(s.path)}:\n${s.text}\n\nThis may or may not be related to the current task.</ide_selection>` })
    } else if (ctx.file) {
      blocks.push({ type: 'text', text: `<ide_opened_file>The user opened the file ${rel(ctx.file)} in the IDE. This may or may not be related to the current task.</ide_opened_file>` })
    }
    blocks.push({ type: 'text', text: input.text })
    if (input.images.length) {
      if (this.caps?.promptCapabilities?.image) {
        for (const img of input.images) {
          const m = img.dataUrl.match(/^data:([^;]+);base64,(.*)$/)
          if (m) blocks.push({ type: 'image', mimeType: m[1], data: m[2] })
        }
      } else this.host.note(t('{0} 当前的模型不支持图片，已忽略附带的图片', this.def.name))
    }
    // @文件 → resource_link
    const seen = new Set<string>()
    for (const m of input.text.matchAll(/(?:^|\s)@(?:"([^"]+)"|(\S+))/g)) {
      const p = (m[1] ?? m[2]).replace(/#L\d+(?:-\d+)?$/, '')
      if (seen.has(p) || !/[./\\]/.test(p)) continue
      seen.add(p)
      const abs = resolvePath(p)
      blocks.push({ type: 'resource_link', uri: fileUri(abs), name: basenameOf(abs) })
    }
    return blocks
  }

  interrupt(): void {
    if (!this.sid || !this.promptActive) {
      if (this.host.busy()) this.host.turnEnded({ ok: false, interrupted: true })
      return
    }
    this.write({ method: 'session/cancel', params: { sessionId: this.sid } })
  }

  setMode(id: string): void {
    this.mode = id
    if (this.agentModes && this.sid && this.availableModes.includes(id)) {
      this.request('session/set_mode', { sessionId: this.sid, modeId: id }).catch((e) => this.host.note(t('切换模式失败：{0}', (e as Error).message), 'error'))
    }
  }

  setModel(id: string, effort?: string): void {
    this.model = id || undefined
    this.effort = effort
    void this.applyPrefs()
  }

  async listSessions(): Promise<SessionInfo[]> {
    await this.ensure()
    if (!this.caps?.sessionCapabilities?.list) return []
    const raw: Any[] = []
    let cursor: string | undefined
    for (let page = 0; page < 5; page++) {
      const r = await this.request('session/list', { cwd: this.host.cwd ?? '', ...(cursor ? { cursor } : {}) }, 30_000)
      raw.push(...(Array.isArray(r?.sessions) ? r.sessions : []))
      cursor = r?.nextCursor ?? undefined
      if (!cursor || raw.length >= 200) break
    }
    // DeepSeek 的列表没有标题和时间：从本地日志补上
    const meta = this.plugin === 'deepseek' ? await window.api.agent.deepseekSessionMeta(raw.map((s) => String(s.sessionId ?? ''))).catch(() => ({}) as Record<string, { title: string; updatedAt: number }>) : null
    const out: SessionInfo[] = []
    for (const s of raw) {
      const id = String(s.sessionId ?? '')
      const m = meta?.[id]
      const title = String(m?.title ?? s.title ?? '').replace(/\s+/g, ' ').trim()
      if (!id || !title) continue
      if (typeof s.cwd === 'string') this.sessionCwd.set(id, s.cwd)
      const at = m?.updatedAt ?? (typeof s.updatedAt === 'number' ? s.updatedAt : Date.parse(String(s.updatedAt ?? '')))
      out.push({ id, title: title.slice(0, 120), updatedAt: Number.isFinite(at) ? (at < 1e12 ? at * 1000 : at) : 0 })
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt)
  }

  async resume(id: string): Promise<void> {
    await this.ensure()
    if (this.promptActive && this.sid) this.write({ method: 'session/cancel', params: { sessionId: this.sid } })
    this.closeSession()
    this.tools.clear()
    this.last = null
    const cwd = this.sessionCwd.get(id) ?? this.host.cwd ?? ''
    this.replay = true
    try {
      if (this.caps?.loadSession) {
        // Kimi：session/load 期间以 session/update 回放整段历史
        this.sid = id
        const r = await this.request('session/load', { sessionId: id, cwd, mcpServers: await this.mcpServers() }, 120_000)
        this.flushUser()
        this.onSessionState(r)
      } else {
        // DeepSeek：先回放本地日志，再续接会话
        const updates = await window.api.agent.transcript(this.plugin, this.host.cwd, id)
        for (const u of updates) this.onUpdate(u)
        this.flushUser()
        this.finishThought()
        const r = await this.request('session/resume', { sessionId: id, cwd, mcpServers: await this.mcpServers() }, 120_000)
        this.sid = id
        this.onSessionState(r)
      }
    } catch (e) {
      this.sid = null
      throw e
    } finally {
      this.replay = false
      this.last = null
    }
    await this.applyPrefs()
  }

  reset(): void {
    if (this.promptActive && this.sid) this.write({ method: 'session/cancel', params: { sessionId: this.sid } })
    this.closeSession()
    this.tools.clear()
    this.last = null
    this.promptActive = false
  }

  dispose(): void {
    this.disposed = true
    this.stopProcess()
  }

  /* ---------------- 登录 ---------------- */

  get loginMethods(): LoginMethod[] {
    if (this.isAntigravity) return [{ id: 'google', label: t('使用 Google 账号登录'), hint: t('在浏览器中完成登录；个人 Google 账号（免费、Pro、Ultra）都可以使用') }]
    if (this.isKimi) return [{ id: 'kimi', label: t('使用 Kimi 账号登录'), hint: t('在浏览器中确认设备码，Kimi 会员或 Kimi Code 套餐') }]
    return [
      {
        id: 'apiKey',
        label: t('使用 DeepSeek API Key'),
        hint: t('在 platform.deepseek.com 创建，按用量计费；保存在 ~/.dsh/.credentials.yaml'),
        input: { label: 'DeepSeek API Key', placeholder: 'sk-…', secret: true }
      }
    ]
  }

  async login(method: string, ui: LoginUi): Promise<void> {
    if (this.isAntigravity) return this.antigravityLogin(ui)
    if (!this.isKimi) {
      const key = ui.input?.trim()
      if (!key) throw new Error(t('请输入 API Key'))
      await window.api.agent.setDeepseekKey(key)
      const st = await window.api.agent.deepseekKeyStatus().catch(() => null)
      this.account = t('API Key {0}', st?.masked ?? '')
      // 凭据文件会被正在运行的进程自动重新读取；还没有会话时顺便建好
      await this.ensureSession().catch(() => {})
      this.host.capabilities()
      return
    }
    let loginId: number | null = null
    const early: LoginEvent[] = []
    let handle: (ev: LoginEvent) => void = (ev) => early.push(ev)
    const off = window.api.agent.onLogin((id, ev) => {
      if (loginId === null || id === loginId) handle(ev)
    })
    try {
      loginId = await window.api.agent.kimiLogin()
      const id = loginId
      await new Promise<void>((resolve, reject) => {
        handle = (ev) => {
          // kimi login 会自己打开浏览器
          if (ev.type === 'url') ui.url(ev.url, false)
          else if (ev.type === 'code') ui.code(ev.code)
          else if (ev.type === 'exit') {
            if (ev.ok) resolve()
            else reject(new Error(ev.message || t('登录失败')))
          }
        }
        early.splice(0).forEach(handle)
        ui.onCancel(() => {
          window.api.agent.loginCancel(id)
          reject(new Error(t('已取消登录')))
        })
      })
    } finally {
      off()
    }
    // 新的凭据要重启进程才生效
    this.stopProcess()
    await this.ensureSession()
    this.account = t('Kimi 账号')
  }

  /** Antigravity 登录：authenticate 一直等到浏览器里登录完成（agy 自己打开浏览器），凭据存进系统钥匙串 */
  private async antigravityLogin(ui: LoginUi): Promise<void> {
    await this.ensure()
    // 浏览器里登录完，agy 有时迟迟不回 authenticate（界面就一直停在登录卡片上）。
    // 用户点“我已完成登录”时不再等它：凭据已经在钥匙串里，重启进程建会话能成功就算登录好了
    let manual = false
    await new Promise<void>((resolve, reject) => {
      ui.onCancel(() => {
        this.stopProcess()
        reject(new Error(t('已取消登录')))
      })
      ui.waiting?.(t('已在浏览器中打开 Google 登录页，请在网页上完成登录，完成后这里会自动继续。'), () => {
        manual = true
        resolve()
      })
      this.request('authenticate', { methodId: 'oauth-personal' }, 10 * 60_000).then(
        () => resolve(),
        (e) => {
          if (!manual) reject(e)
        }
      )
    })
    // 已建的会话还拿着旧凭据：重启进程
    this.stopProcess()
    try {
      await this.ensureSession()
    } catch (e) {
      if (manual) throw new Error(t('还没有检测到登录：请先在浏览器里完成 Google 登录，再点重试'))
      throw e
    }
    this.account = t('Google 账号')
    this.host.capabilities()
  }

  async logout(): Promise<void> {
    if (this.isAntigravity) throw new Error(t('Google 账号的登录由 Gemini 命令行工具管理：在终端里运行 agy，输入 /logout 退出登录'))
    if (!this.isKimi) {
      const st = await window.api.agent.deepseekKeyStatus().catch(() => null)
      if (st?.source === 'env') throw new Error(t('API Key 来自环境变量 DEEPSEEK_API_KEY 或 ~/.dsh/.env，请在那里删除'))
      await window.api.agent.setDeepseekKey(null)
      this.account = undefined
      this.host.capabilities()
      return
    }
    await this.ensure()
    await this.request('logout', {}, 30_000)
    this.stopProcess()
    this.account = undefined
    this.models = []
    this.commands = []
    this.host.capabilities()
  }

  /* ---------------- 消息 ---------------- */

  private onMessage(m: Any): void {
    if (!m || typeof m !== 'object') return
    if (m.id !== undefined && m.id !== null && m.method === undefined) {
      const p = this.pending.get(m.id)
      if (!p) return
      this.pending.delete(m.id)
      if (m.error) p.reject(new Error(rpcError(m.error)))
      else p.resolve(m.result)
      return
    }
    if (m.id !== undefined && m.id !== null && typeof m.method === 'string') {
      void this.onAgentRequest(m.id, m.method, m.params ?? {})
      return
    }
    if (m.method === 'session/update') {
      const p = m.params ?? {}
      if (p.sessionId && this.sid && p.sessionId !== this.sid) return
      this.onUpdate(p.update ?? {})
    }
  }

  private nextId(kind: string): string {
    return `${kind}-${++this.blockSeq}`
  }

  private finishThought(): void {
    if (this.last?.kind === 'thought') this.host.thinking(this.last.id, '', { done: true })
  }

  /** 回放时用户消息可能分几段到达：攒齐了再显示 */
  private flushUser(): void {
    const u = this.userBuf
    this.userBuf = null
    if (u && u.text.trim()) this.host.userMessage(stripContext(u.text), { id: u.id, time: u.time })
  }

  private onUpdate(u: Any): void {
    const kind = String(u?.sessionUpdate ?? '')
    if (kind !== 'user_message_chunk') this.flushUser()
    switch (kind) {
      case 'user_message_chunk': {
        if (!this.replay) return
        const text = contentText(u.content)
        const msg = u.messageId ?? undefined
        if (this.userBuf && (!msg || this.userBuf.id === msg) && this.last?.kind === 'user') this.userBuf.text += text
        else {
          this.flushUser()
          this.userBuf = { id: msg, text, time: typeof u.time === 'number' ? u.time : undefined }
        }
        this.last = { kind: 'user', id: '' }
        return
      }
      case 'agent_message_chunk': {
        const text = contentText(u.content)
        if (!text) return
        const msg = u.messageId ?? undefined
        if (this.last?.kind !== 'text' || (msg && this.last.msg && msg !== this.last.msg)) {
          this.finishThought()
          this.last = { kind: 'text', id: this.nextId('t'), msg }
        }
        this.host.text(this.last.id, text, true)
        return
      }
      case 'agent_thought_chunk': {
        const text = contentText(u.content)
        if (!text) return
        const msg = u.messageId ?? undefined
        if (this.last?.kind !== 'thought' || (msg && this.last.msg && msg !== this.last.msg)) {
          this.finishThought()
          this.last = { kind: 'thought', id: this.nextId('r'), msg }
        }
        this.host.thinking(this.last.id, text, { append: true })
        return
      }
      case 'tool_call':
      case 'tool_call_update':
        this.finishThought()
        this.onTool(u, kind === 'tool_call')
        return
      case 'plan': {
        const entries: Any[] = Array.isArray(u.entries) ? u.entries : []
        this.host.todos(entries.map((e) => ({ content: String(e.content ?? ''), status: todoStatus(e.status) })))
        return
      }
      case 'available_commands_update': {
        const list: Any[] = Array.isArray(u.availableCommands) ? u.availableCommands : []
        this.commands = list.map((c) => ({ name: String(c.name), description: String(c.description ?? ''), hint: c.input?.hint ?? undefined }))
        this.host.capabilities()
        return
      }
      case 'current_mode_update':
        if (this.agentModes && u.currentModeId) {
          this.mode = String(u.currentModeId)
          this.host.setMode(this.mode)
        }
        return
      case 'config_option_update':
        if (Array.isArray(u.configOptions)) this.applyConfig(u.configOptions)
        return
      case 'session_info_update':
        if (u.title) this.host.session(this.sid, String(u.title))
        return
      case 'usage_update': {
        const used = Number(u.used ?? 0)
        const size = Number(u.size ?? 0) || null
        const cost = u.cost && String(u.cost.currency ?? '').toUpperCase() === 'USD' ? Number(u.cost.amount) : undefined
        if (used) this.host.usage(used, size, cost)
        return
      }
      case '_error':
        // 主进程转换历史日志时生成：那一轮出错了
        if (u.text) this.host.note(String(u.text), 'error')
        return
    }
  }

  private onTool(u: Any, created: boolean): void {
    const id = String(u.toolCallId ?? '')
    if (!id) return
    let st = this.tools.get(id)
    if (!st) {
      st = { title: '', input: {}, view: { icon: 'other', verb: '', summary: '' } }
      this.tools.set(id, st)
    }
    if (u.title) st.title = String(u.title)
    if (u.kind) st.kind = String(u.kind)
    if (u.rawInput !== undefined && u.rawInput !== null) st.input = u.rawInput
    const loc = Array.isArray(u.locations) ? u.locations[0] : undefined
    if (loc?.path) st.path = String(loc.path)
    if (created || u.title || u.kind || u.rawInput !== undefined) {
      const d = describeAcp(st)
      st.name = d.name
      st.view = d.view
    }
    const status = toolStatus(u.status)
    const patch: Partial<ToolView> = { ...st.view }
    if (status) patch.status = status
    else if (created) patch.status = 'running'

    const content: Any[] = Array.isArray(u.content) ? u.content : []
    const diffs = content.filter((c) => c?.type === 'diff' && c.path)
    if (diffs.length) patch.diff = acpDiff(diffs[0])
    // 运行中的文本内容是参数（Kimi 会把参数 JSON 放在这里），结束后才是输出
    if (status === 'done' || status === 'error') {
      const text = content
        .filter((c) => c?.type === 'content')
        .map((c) => contentText(c.content))
        .filter(Boolean)
        .join('\n')
      Object.assign(patch, describeOutput(st.name, text, status === 'error', !!patch.diff || !!this.host.getTool(id)?.diff))
    }
    if (st.name === 'TodoWrite') {
      const todos = todosFrom(st.input)
      if (todos.length) this.host.todos(todos)
    }
    this.host.tool(id, patch)
    this.last = { kind: 'tool', id }
  }

  /* ---------------- 授权 ---------------- */

  private async onAgentRequest(id: number | string, method: string, p: Any): Promise<void> {
    if (method !== 'session/request_permission') {
      this.replyError(id, t('Infinite Studio 不支持 {0}', method))
      return
    }
    const options: Any[] = Array.isArray(p.options) ? p.options : []
    const pick = (kinds: string[]) => options.find((o) => kinds.includes(o.kind))
    // DeepSeek / Antigravity 的“自动批准”模式：由界面直接同意
    if (this.uiModes && this.mode === 'auto') {
      const allow = pick(['allow_always', 'allow_once'])
      if (allow) return this.reply(id, { outcome: { outcome: 'selected', optionId: allow.optionId } })
    }
    try {
      const tc = p.toolCall ?? {}
      const known = tc.toolCallId ? this.tools.get(String(tc.toolCallId)) : undefined
      const st: ToolState = {
        title: String(tc.title ?? known?.title ?? ''),
        kind: tc.kind ?? known?.kind,
        input: tc.rawInput ?? known?.input ?? {},
        path: known?.path,
        view: known?.view ?? { icon: 'other', verb: '', summary: '' }
      }
      const isQuestion = st.title === 'AskUserQuestion'
      const d = describeAcp(st)
      const body = Array.isArray(tc.content) ? tc.content : []
      const question = body.map((c: Any) => (c?.type === 'content' ? contentText(c.content) : '')).filter(Boolean).join('\n')
      const diffItem = body.find((c: Any) => c?.type === 'diff' && c.path)
      const name = this.def.name
      let title: string
      let code: string | undefined
      let diff: DiffInfo | undefined
      if (isQuestion) title = question || t('{0} 有一个问题', name)
      else if (d.name === 'Bash') {
        title = t('{0} 想要运行这条命令', name)
        code = String(st.input?.command ?? '')
      } else if (d.name === 'Edit' || d.name === 'Write' || st.kind === 'edit') {
        const path = d.view.path ?? st.path
        title = path ? t('{0} 想要修改 {1}', name, rel(path)) : t('{0} 想要修改文件', name)
        diff = diffItem ? acpDiff(diffItem) : await proposedDiff(d.name, st.input, path)
      } else title = t('{0} 想要{1}', name, [d.view.verb, d.view.summary].filter(Boolean).join(' ') || st.title || t('使用工具'))
      const opts: PermissionOption[] = options.map((o) => ({ id: String(o.optionId), label: isQuestion ? String(o.name) : optionLabel(o) }))
      if (!opts.length) return this.reply(id, { outcome: { outcome: 'cancelled' } })
      const a = await this.host.permission({ title, code, diff, detail: isQuestion ? undefined : st.title && st.title !== d.view.verb ? st.title : undefined, options: opts }, String(id))
      this.reply(id, { outcome: { outcome: 'selected', optionId: a.option } })
    } catch {
      // 授权被撤回 / 视图关闭 / 轮次结束
      this.reply(id, { outcome: { outcome: 'cancelled' } })
    }
  }
}

/* ---------------- 工具描述 ---------------- */

/** 两边的工具名 → Claude Code 的工具名（参数名一致：file_path、old_string、command…） */
const TOOL_NAMES: Record<string, string> = {
  read: 'Read',
  read_image: 'Read',
  readfile: 'Read',
  write: 'Write',
  writefile: 'Write',
  edit: 'Edit',
  str_replace_editor: 'Edit',
  multiedit: 'MultiEdit',
  bash: 'Bash',
  pwsh: 'Bash',
  shell: 'Bash',
  terminal: 'Bash',
  glob: 'Glob',
  grep: 'Grep',
  web_fetch: 'WebFetch',
  webfetch: 'WebFetch',
  fetchurl: 'WebFetch',
  web_search: 'WebSearch',
  websearch: 'WebSearch',
  searchweb: 'WebSearch',
  todo_write: 'TodoWrite',
  todowrite: 'TodoWrite',
  subagent: 'Task',
  subagent_fork: 'Task',
  agent: 'Task',
  task: 'Task',
  skill: 'Skill',
  askuserquestion: 'AskUserQuestion',
  ask_user_question: 'AskUserQuestion',
  exitplanmode: 'ExitPlanMode',
  enterplanmode: 'EnterPlanMode',
  // Gemini（Antigravity CLI，沿用 Gemini CLI 的工具名）
  read_file: 'Read',
  read_many_files: 'Read',
  write_file: 'Write',
  replace: 'Edit',
  run_shell_command: 'Bash',
  search_file_content: 'Grep',
  grep_search: 'Grep',
  google_web_search: 'WebSearch',
  write_todos: 'TodoWrite'
}

const KIND_ICON: Record<string, ToolView['icon']> = { read: 'read', edit: 'edit', delete: 'edit', move: 'edit', search: 'search', execute: 'bash', fetch: 'web', switch_mode: 'plan', think: 'other', other: 'other' }

/** 按工具名、kind 和参数推断出工具，交给 Claude 的 describe 生成展示 */
function describeAcp(st: ToolState): { name?: string; view: Omit<ToolView, 'status'> } {
  const i = st.input && typeof st.input === 'object' ? st.input : {}
  let name = TOOL_NAMES[st.title.toLowerCase()]
  if (!name) {
    // Kimi 的标题可能是工具的描述：按 kind 和参数推断
    if ('old_string' in i || 'edits' in i) name = Array.isArray(i.edits) ? 'MultiEdit' : 'Edit'
    else if (st.kind === 'edit' && 'content' in i && i.file_path) name = 'Write'
    else if (st.kind === 'read' && i.file_path) name = 'Read'
    else if (st.kind === 'execute' && i.command) name = 'Bash'
    else if (i.todos) name = 'TodoWrite'
    else if ((st.kind === 'search' || st.kind === 'read') && i.pattern) name = 'include' in i || 'output_mode' in i || 'glob' in i ? 'Grep' : 'Glob'
    else if (st.kind === 'fetch' && i.url) name = 'WebFetch'
    else if (st.kind === 'fetch' && i.query) name = 'WebSearch'
  }
  if (name) {
    const view = describe(name, i)
    if (name === 'Bash' && !view.summary) view.summary = st.title
    if (name === 'Read' && st.title.toLowerCase() === 'read_image') view.verb = t('查看图片')
    if (!view.path && st.path) view.path = st.path
    return { name, view }
  }
  const brief = Object.keys(i).length ? clip(JSON.stringify(i, null, 2), 2000) : undefined
  const path = st.path ?? (typeof i.file_path === 'string' ? i.file_path : typeof i.path === 'string' ? i.path : undefined)
  return { view: { icon: KIND_ICON[st.kind ?? 'other'] ?? 'other', verb: st.title || t('工具'), summary: path ? rel(path) : '', path, input: brief } }
}

function describeOutput(name: string | undefined, output: string, isError: boolean, hasDiff: boolean): Partial<ToolView> {
  if (isError) return { output: output || undefined, expanded: false }
  switch (name) {
    case 'Read': {
      const n = output ? output.split('\n').length : 0
      return { output: undefined, outputHint: n ? t('{0} 行', n) : undefined }
    }
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
      return hasDiff ? { output: undefined } : { output: output ? clip(output, 2000) : undefined }
    case 'Glob': {
      const n = output ? output.split('\n').filter(Boolean).length : 0
      return { output: output ? clip(output, 20_000) : undefined, outputHint: t('{0} 个文件', n) }
    }
    case 'TodoWrite':
    case 'ExitPlanMode':
      return { output: undefined }
    case 'Task':
      return { markdown: output || undefined, output: undefined, expanded: false }
    case 'Bash':
      return { output: output ? clip(output, 60_000) : undefined, outputHint: output ? undefined : t('无输出') }
    default:
      return { output: output ? clip(output, 20_000) : undefined }
  }
}

function acpDiff(c: Any): DiffInfo {
  const original = typeof c.oldText === 'string' ? c.oldText : ''
  const modified = String(c.newText ?? '')
  const hunks = hunksFrom(lineDiff(original, modified), 3)
  return { path: String(c.path), hunks, ...countChanges(hunks), load: async () => ({ original, modified }) }
}

/** 授权前的修改预览：读取现在的文件，算出修改后的内容 */
async function proposedDiff(name: string | undefined, i: Any, path: string | undefined): Promise<DiffInfo | undefined> {
  const file = String(i?.file_path ?? path ?? '')
  if (!file) return undefined
  const original = await readText(file).catch(() => '')
  let modified = original
  if (name === 'Write') modified = String(i.content ?? '')
  else {
    const edits: Any[] = Array.isArray(i?.edits) ? i.edits : [i]
    for (const e of edits) {
      const from = String(e?.old_string ?? '')
      const to = String(e?.new_string ?? '')
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
  return { path: file, hunks, ...countChanges(hunks), load: async () => ({ original, modified }) }
}

function optionLabel(o: Any): string {
  switch (o.kind) {
    case 'allow_once':
      return t('是')
    case 'allow_always':
      return t('是，并且不再询问')
    case 'reject_once':
      return t('否')
    case 'reject_always':
      return t('否，并且不再询问')
    default:
      return String(o.name ?? o.optionId)
  }
}

/* ---------------- 小工具 ---------------- */

function flattenOptions(list: Any): ConfigSelect['options'] {
  const out: ConfigSelect['options'] = []
  for (const o of Array.isArray(list) ? list : []) {
    if (Array.isArray(o?.options)) out.push(...flattenOptions(o.options))
    else if (o && o.value !== undefined) out.push({ value: String(o.value), name: String(o.name ?? o.value), description: o.description ?? undefined })
  }
  return out
}

function contentText(c: Any): string {
  if (!c) return ''
  if (c.type === 'text') return String(c.text ?? '')
  if (c.type === 'resource_link') return `@${c.name ?? c.uri}`
  if (c.type === 'resource') return String(c.resource?.text ?? '')
  return ''
}

function toolStatus(s: unknown): ToolView['status'] | undefined {
  if (s === 'completed') return 'done'
  if (s === 'failed') return 'error'
  if (s === 'pending' || s === 'in_progress') return 'running'
  return undefined
}

function todoStatus(s: unknown): Todo['status'] {
  return s === 'completed' ? 'completed' : s === 'in_progress' ? 'in_progress' : 'pending'
}

function todosFrom(i: Any): Todo[] {
  const list: Any[] = Array.isArray(i?.todos) ? i.todos : []
  return list.map((x) => ({ content: String(x.content ?? x.title ?? x.text ?? ''), status: todoStatus(x.status), activeForm: x.activeForm ?? undefined })).filter((x) => x.content)
}

function rpcError(e: Any): string {
  const msg = readable(String(e?.message ?? t('请求失败')))
  const detail = readable(typeof e?.data === 'string' ? e.data : typeof e?.data?.message === 'string' ? e.data.message : '')
  return detail && !msg.includes(detail) ? `${msg}: ${detail}` : msg
}

/** 错误信息本身是 JSON（Gemini 会把接口返回的 JSON 一层层包在 message 里）：取出最里面那句话 */
function readable(s: string): string {
  let cur = s
  for (let i = 0; i < 5; i++) {
    const text = cur.trim()
    if (!text.startsWith('{')) break
    let obj: Any
    try {
      obj = JSON.parse(text)
    } catch {
      break
    }
    const next = obj?.error?.message ?? obj?.message
    if (typeof next !== 'string' || !next) break
    cur = next
  }
  return cur
}

function fileUri(p: string): string {
  const s = p.replace(/\\/g, '/')
  return encodeURI(s.startsWith('/') ? `file://${s}` : `file:///${s}`)
}

function lastLines(s: string, n: number): string {
  return s.trim().split('\n').slice(-n).join('\n')
}

/** 回放时去掉自动附带的编辑器上下文 */
function stripContext(s: string): string {
  return s.replace(/<(ide_opened_file|ide_selection|system-reminder)>[\s\S]*?<\/\1>/g, '').trim()
}
