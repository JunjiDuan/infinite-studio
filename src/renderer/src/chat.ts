import { ACP_ARGS, AGENT_MODES, type DailyUsage, type RateLimits, type SessionInfo } from '../../shared/agents'
import { PLUGINS, type PluginDef } from '../../shared/plugins'
import { initBus } from './agent/bus'
import { ClaudeDriver } from './agent/claude'
import { AcpDriver } from './agent/acp'
import { CodexDriver } from './agent/codex'
import { diffStat, openDiffTab, renderDiff } from './agent/diff'
import { fileLink, renderMarkdown } from './agent/markdown'
import type {
  ChatHost,
  DiffInfo,
  Driver,
  ImageAttachment,
  LoginMethod,
  LoginUi,
  PermissionAnswer,
  PermissionRequest,
  PromptContext,
  Question,
  Todo,
  ToolView,
  TurnEnd,
  UserInput
} from './agent/types'
import { basenameOf, clip, errText, rel } from './agent/util'
import { h, relative, toast } from './dom'
import { fileSelection, type FileSelection, onSelection, openFile, openView, recentFile, recentFiles, revealView, tabs, updateView } from './editor'
import { icons } from './icons'
import { setAgentSender } from './market'
import { showMenu } from './menu'
import { glyph, launchInTerminal, onPluginsChange, usable } from './plugins'
import { persist, state } from './store'
import { t } from './i18n'

/**
 * AI 对话视图：照着官方 VS Code 扩展（Claude Code / Codex）的交互来做。
 * 每个视图是编辑区里的一个标签，可以和代码并排、拖到别的组。
 */

/* ---------------- 数据 ---------------- */

type Block =
  | { kind: 'text'; el: HTMLElement; text: string }
  | { kind: 'think'; el: HTMLElement; text: string; done: boolean; start: number; end?: number }
  | { kind: 'tool'; el: HTMLElement; view: ToolView; open?: boolean }

type PromptItem =
  | { kind: 'perm'; key: string; req: PermissionRequest; resolve: (a: PermissionAnswer) => void; reject: (e: Error) => void; choosing?: string }
  | {
      kind: 'ask'
      key: string
      questions: Question[]
      resolve: (a: Record<string, string[]> | null) => void
      reject: (e: Error) => void
      index: number
      answers: Record<string, string[]>
      other: Record<string, string>
    }

interface PopItem {
  label: string
  hint?: string
  checked?: boolean
  header?: boolean
  run?: () => void
}

interface CompletionItem {
  label: string
  detail?: string
  apply: () => void
}

const views = new Set<ChatView>()
let lastActive: ChatView | null = null
/** 上次用对话面板的时间（和网页面板比谁最近用过） */
let chatUsedAt = 0

function markActive(v: ChatView): void {
  lastActive = v
  chatUsedAt = Date.now()
}

/**
 * 别的 AI 面板（网页大模型助手）：和对话面板一起参与 Alt K（引用当前文件 / 选中行）和 Ctrl Esc（切换焦点），
 * 最近用过的那个优先
 */
export interface AssistantTarget {
  usedAt(): number
  /** 把焦点移过去；成功返回 true */
  focus(): boolean
  mention(sel: FileSelection | null, file: string | null): void
}

let assistantTargets: () => AssistantTarget[] = () => []
export function setAssistantTargets(fn: () => AssistantTarget[]): void {
  assistantTargets = fn
}

/** 比最近用过的对话面板更近的其他 AI 面板 */
function recentTarget(): AssistantTarget | null {
  let best: AssistantTarget | null = null
  let at = lastActive && views.has(lastActive) ? chatUsedAt : 0
  for (const x of assistantTargets()) {
    if (x.usedAt() > at) {
      best = x
      at = x.usedAt()
    }
  }
  return best
}

/** 编辑器右上角 AI 助手按钮后面追加的按钮（网页大模型助手） */
let extraIcons: () => HTMLElement[] = () => []
export function setExtraAgentIcons(fn: () => HTMLElement[]): void {
  extraIcons = fn
  renderAgentIcons()
}

export const agentIcons = h('div', { class: 'agent-icons', role: 'toolbar', 'aria-label': t('AI 助手') })

const VERBS = [t('思考中'), t('琢磨中'), t('推敲中'), t('酝酿中'), t('构思中'), t('梳理中'), t('斟酌中'), t('打磨中'), t('编织中'), t('演算中'), t('整理中'), t('探索中')]

/* ---------------- 文件列表（@ 引用用） ---------------- */

let fileCache: { root: string; files: string[]; at: number } | null = null

async function projectFiles(): Promise<string[]> {
  const root = state.root
  if (!root) return []
  if (fileCache && fileCache.root === root && Date.now() - fileCache.at < 30_000) return fileCache.files
  const files = await window.api.fs.listFiles(root).catch(() => [] as string[])
  fileCache = { root, files, at: Date.now() }
  return files
}

/** 子序列模糊匹配，分数越高越靠前 */
function fuzzy(q: string, s: string): number {
  if (!q) return 1
  const ql = q.toLowerCase()
  const sl = s.toLowerCase()
  const base = sl.slice(sl.lastIndexOf('/') + 1)
  if (base.startsWith(ql)) return 1000 - base.length
  if (base.includes(ql)) return 800 - base.length
  if (sl.includes(ql)) return 600 - sl.length
  let i = 0
  let score = 0
  let streak = 0
  for (let k = 0; k < sl.length && i < ql.length; k++) {
    if (sl[k] === ql[i]) {
      i++
      streak++
      score += streak * 2
    } else streak = 0
  }
  return i === ql.length ? score - sl.length * 0.1 : -1
}

function readImage(file: File): Promise<ImageAttachment | null> {
  return new Promise((resolve) => {
    if (!/^image\/(png|jpeg|gif|webp)$/.test(file.type)) return resolve(null)
    if (file.size > 20 * 1024 * 1024) {
      toast(t('图片超过 20 MB'))
      return resolve(null)
    }
    const r = new FileReader()
    r.onload = () => resolve({ name: file.name || t('图片'), mime: file.type, dataUrl: String(r.result) })
    r.onerror = () => resolve(null)
    r.readAsDataURL(file)
  })
}

function relTime(ms: number): string {
  const d = (Date.now() - ms) / 1000
  if (d < 60) return t('刚刚')
  if (d < 3600) return t('{0} 分钟前', Math.floor(d / 60))
  if (d < 86400) return t('{0} 小时前', Math.floor(d / 3600))
  if (d < 86400 * 30) return t('{0} 天前', Math.floor(d / 86400))
  return new Date(ms).toLocaleDateString()
}

/* ---------------- 用量 ---------------- */

/** 每个插件最近一次拿到的订阅额度（多个对话窗口共用，存本地以便重开后还能看到） */
const rateCache = new Map<string, RateLimits>()

function loadRate(plugin: string): RateLimits | null {
  if (!rateCache.has(plugin)) {
    try {
      const r = JSON.parse(localStorage.getItem('rateLimits:' + plugin) ?? 'null')
      if (r && Array.isArray(r.windows)) rateCache.set(plugin, r)
    } catch {
      /* ignore */
    }
  }
  return rateCache.get(plugin) ?? null
}

function saveRate(plugin: string, r: RateLimits): void {
  rateCache.set(plugin, r)
  try {
    localStorage.setItem('rateLimits:' + plugin, JSON.stringify(r))
  } catch {
    /* ignore */
  }
}

/** 1234 → 1.2K，1234567 → 1.23M */
function fmtTokens(n: number): string {
  if (n >= 1e9) return (n / 1e9).toFixed(n >= 1e10 ? 1 : 2) + 'B'
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 1 : 2) + 'M'
  if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + 'K'
  return String(Math.round(n))
}

function untilText(ms: number): string {
  const d = ms - Date.now()
  if (d <= 0) return t('已重置')
  const m = Math.ceil(d / 60_000)
  if (m < 60) return t('{0} 分钟后重置', m)
  const hrs = Math.floor(m / 60)
  if (hrs < 24) return t('{0} 小时 {1} 分后重置', hrs, m % 60)
  return t('{0} 天 {1} 小时后重置', Math.floor(hrs / 24), hrs % 24)
}

const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

function dayGroup(ms: number): string {
  const start = new Date()
  start.setHours(0, 0, 0, 0)
  const t0 = start.getTime()
  if (ms >= t0) return t('今天')
  if (ms >= t0 - 86400_000) return t('昨天')
  if (ms >= t0 - 7 * 86400_000) return t('最近 7 天')
  if (ms >= t0 - 30 * 86400_000) return t('最近 30 天')
  return t('更早')
}

/* ---------------- 弹出菜单（模式、模型） ---------------- */

let openPop: { el: HTMLElement; close: () => void } | null = null

function popover(anchor: HTMLElement, items: PopItem[], cls = ''): void {
  openPop?.close()
  const buttons: HTMLButtonElement[] = []
  const el = h(
    'div',
    { class: 'chat-pop ' + cls, role: 'menu' },
    ...items.map((it) => {
      if (it.header) return h('div', { class: 'chat-pop-head' }, it.label)
      const b = h(
        'button',
        {
          class: 'chat-pop-item' + (it.checked ? ' on' : ''),
          role: 'menuitemradio',
          'aria-checked': String(!!it.checked),
          onClick: () => {
            close()
            it.run?.()
          }
        },
        h('span', { class: 'chat-pop-check', html: it.checked ? icons.check : '' }),
        h('span', { class: 'chat-pop-text' }, h('span', { class: 'chat-pop-label' }, it.label), it.hint ? h('span', { class: 'chat-pop-hint' }, it.hint) : null)
      )
      buttons.push(b)
      return b
    })
  )
  document.body.append(el)
  const r = anchor.getBoundingClientRect()
  const pr = el.getBoundingClientRect()
  el.style.left = Math.max(8, Math.min(r.left, window.innerWidth - pr.width - 8)) + 'px'
  const above = r.top - pr.height - 6
  el.style.top = (above > 8 ? above : Math.min(r.bottom + 6, window.innerHeight - pr.height - 8)) + 'px'
  ;(buttons.find((b) => b.classList.contains('on')) ?? buttons[0])?.focus()
  const away = (e: Event) => {
    if (!el.contains(e.target as Node)) close()
  }
  function close(): void {
    el.remove()
    window.removeEventListener('mousedown', away, true)
    if (openPop?.el === el) openPop = null
  }
  el.addEventListener('keydown', (e) => {
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement)
    if (e.key === 'ArrowDown') buttons[(i + 1) % buttons.length]?.focus()
    else if (e.key === 'ArrowUp') buttons[(i - 1 + buttons.length) % buttons.length]?.focus()
    else if (e.key === 'Escape') {
      close()
      anchor.focus()
    } else return
    e.preventDefault()
    e.stopPropagation()
  })
  setTimeout(() => window.addEventListener('mousedown', away, true))
  openPop = { el, close }
}

/* ---------------- 对话视图 ---------------- */

class ChatView implements ChatHost {
  readonly def: PluginDef
  readonly el: HTMLElement
  readonly driver: Driver
  replaying = false

  private titleEl: HTMLElement
  private bodyEl: HTMLElement
  private listEl: HTMLElement
  private historyEl: HTMLElement
  private todosEl: HTMLElement
  private queueEl: HTMLElement
  private statusEl: HTMLElement
  private promptEl: HTMLElement
  private boxEl: HTMLElement
  private popupEl: HTMLElement
  private attachEl: HTMLElement
  private input: HTMLTextAreaElement
  private modeBtn: HTMLButtonElement
  private modelBtn: HTMLButtonElement
  private usageEl: HTMLElement
  /** 最近一次可见时的滚动位置，以及当时是否停在底部（视图被移走 / 隐藏后浏览器会把 scrollTop 清零） */
  private savedScroll = 0
  private pinned = true
  private sizeObserver: ResizeObserver
  private limitsBtn: HTMLElement
  private usagePanel: HTMLElement
  private usageMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1)
  /** 热力图里选中的日期 YYYY-MM-DD */
  private usageDay = ymd(new Date())
  private daily: DailyUsage | null = null
  private sendBtn: HTMLButtonElement
  private fileInput: HTMLInputElement

  private isBusy = false
  private turnEl: HTMLElement | null = null
  private blocks = new Map<string, Block>()
  private dirty = new Set<Block>()
  private frame = 0
  private queue: UserInput[] = []
  private images: ImageAttachment[] = []
  private prompts: PromptItem[] = []
  private sent: string[] = []
  private sentIdx = -1
  private mode: string
  private model?: string
  private effort?: string
  private started = 0
  private ticker: ReturnType<typeof setInterval> | undefined
  private statusOverride: string | null = null
  private title = ''
  private todoList: Todo[] = []
  private todosOpen = false
  private completion: { items: CompletionItem[]; index: number } | null = null
  private completionSeq = 0
  private startError: string | null = null
  private ready = false

  constructor(def: PluginDef) {
    this.def = def
    const modes = AGENT_MODES[def.id] ?? []
    const savedMode = state.settings.agentModes?.[def.id]
    this.mode = modes.some((m) => m.id === savedMode) ? savedMode! : (modes[0]?.id ?? '')
    const prefs = state.settings.agentPrefs?.[def.id] ?? {}
    this.model = prefs.model
    this.effort = prefs.effort
    const opts = { mode: this.mode, model: this.model, effort: this.effort }
    this.driver = def.id === 'codex' ? new CodexDriver(this, opts) : ACP_ARGS[def.id] ? new AcpDriver(this, def, opts) : new ClaudeDriver(this, opts)

    /* ----- 头部 ----- */
    this.titleEl = h('button', { class: 'chat-title', title: t('历史对话'), onClick: () => this.toggleHistory() }, t('新对话'))
    this.limitsBtn = h('button', { class: 'chat-limits', 'aria-label': t('用量'), title: t('用量与 token 统计'), onClick: () => this.toggleUsage() })
    const head = h(
      'div',
      { class: 'chat-head' },
      h('span', { class: 'chat-head-icon', html: glyph(def.id, 14) }),
      this.titleEl,
      h('span', { class: 'grow' }),
      this.limitsBtn,
      h('button', { class: 'icon-btn small', 'aria-label': t('历史对话'), title: t('历史对话'), html: icons.history, onClick: () => this.toggleHistory() }),
      h('button', { class: 'icon-btn small', 'aria-label': t('新对话'), title: t('新对话 (Ctrl N)'), html: icons.plus, onClick: () => this.reset() }),
      h('button', { class: 'icon-btn small', 'aria-label': t('更多'), title: t('更多'), html: icons.more, onClick: (e: MouseEvent) => this.moreMenu(e.currentTarget as HTMLElement) })
    )
    this.historyEl = h('div', { class: 'chat-history', hidden: true })
    this.usagePanel = h('div', { class: 'chat-history chat-usage-panel', hidden: true, onKeydown: (e: KeyboardEvent) => e.key === 'Escape' && (this.usagePanel.hidden = true) })

    /* ----- 消息 ----- */
    this.listEl = h('div', { class: 'chat-list' })
    this.bodyEl = h('div', { class: 'chat-body', onContextmenu: (e: MouseEvent) => this.copyMenu(e), onScroll: () => this.rememberScroll() }, this.listEl)
    // 关闭其它窗口、切换标签、从设置返回时，视图会被重新挂载或从隐藏变为显示：恢复到之前的位置
    this.sizeObserver = new ResizeObserver(() => this.restoreScroll())
    this.sizeObserver.observe(this.bodyEl)

    /* ----- 输入区 ----- */
    this.todosEl = h('div', { class: 'chat-todos', hidden: true })
    this.queueEl = h('div', { class: 'chat-queue', hidden: true })
    this.statusEl = h('div', { class: 'chat-status', hidden: true })
    this.promptEl = h('div', { class: 'chat-prompt', hidden: true })
    this.popupEl = h('div', { class: 'chat-complete', hidden: true, role: 'listbox' })
    this.attachEl = h('div', { class: 'chat-attach' })
    this.input = h('textarea', {
      class: 'chat-input',
      rows: '1',
      spellcheck: 'false',
      placeholder: def.id === 'codex' ? t('让 Codex 做点什么（@ 引用文件，/ 命令）') : def.id === 'claude' ? t('向 Claude 提问或布置任务（@ 引用文件，/ 命令）') : t('向 {0} 提问或布置任务（@ 引用文件，/ 命令）', def.name),
      onInput: () => {
        this.autoGrow()
        this.updateCompletion()
      },
      onKeydown: (e: KeyboardEvent) => this.onInputKey(e),
      onPaste: (e: ClipboardEvent) => this.onPaste(e),
      onBlur: () => setTimeout(() => this.closeCompletion(), 150),
      onClick: () => this.updateCompletion()
    })
    this.fileInput = h('input', {
      type: 'file',
      accept: 'image/png,image/jpeg,image/gif,image/webp',
      multiple: true,
      hidden: true,
      onChange: async () => {
        for (const f of Array.from(this.fileInput.files ?? [])) await this.addImage(f)
        this.fileInput.value = ''
      }
    })
    this.modeBtn = h('button', { class: 'chat-mode', onClick: () => this.modeMenu() })
    this.modelBtn = h('button', { class: 'chat-model', onClick: () => this.modelMenu() })
    this.usageEl = h('span', { class: 'chat-usage', hidden: true })
    this.sendBtn = h('button', { class: 'chat-send', onClick: () => (this.isBusy && !this.input.value.trim() ? this.interrupt() : this.submit()) })
    this.boxEl = h(
      'div',
      {
        class: 'chat-box',
        onDragover: (e: DragEvent) => {
          if (e.dataTransfer?.types.includes('Files') || e.dataTransfer?.types.includes('text/plain')) {
            e.preventDefault()
            this.boxEl.classList.add('drop')
          }
        },
        onDragleave: () => this.boxEl.classList.remove('drop'),
        onDrop: (e: DragEvent) => this.onDrop(e),
        // 编辑器标签拖进来：作为 @引用插入
        'onTab-drop': (e: CustomEvent<{ path: string }>) => {
          this.insertMention(e.detail.path)
          this.input.focus()
        }
      },
      this.popupEl,
      this.attachEl,
      this.input,
      h(
        'div',
        { class: 'chat-tools' },
        this.modeBtn,
        h('button', { class: 'chat-tool', title: t('引用文件 (@)'), 'aria-label': t('引用文件'), html: icons.at, onClick: () => this.insertTrigger('@') }),
        h('button', { class: 'chat-tool', title: t('命令 (/)'), 'aria-label': t('命令'), html: icons.slash, onClick: () => this.insertTrigger('/') }),
        h('button', { class: 'chat-tool', title: t('添加图片'), 'aria-label': t('添加图片'), html: icons.image, onClick: () => this.fileInput.click() }),
        h('span', { class: 'grow' }),
        this.usageEl,
        this.modelBtn,
        this.sendBtn
      ),
      this.fileInput
    )

    this.el = h(
      'div',
      { class: 'chat', 'data-plugin': def.id, onKeydown: (e: KeyboardEvent) => this.onViewKey(e), onFocusin: () => markActive(this) },
      head,
      this.historyEl,
      this.usagePanel,
      this.bodyEl,
      h('div', { class: 'chat-foot' }, this.todosEl, this.queueEl, this.statusEl, this.promptEl, this.boxEl)
    )
    this.renderEmpty()
    this.renderLimits()
    this.renderMode()
    this.renderModel()
    this.renderSend()
    this.updateContext()
    views.add(this)
    markActive(this)

    this.driver
      .start()
      .then(() => {
        this.ready = true
        this.capabilities()
      })
      .catch((e) => {
        this.startError = errText(e)
        this.renderEmpty()
      })
  }

  /* ================= ChatHost ================= */

  get cwd(): string | null {
    return state.root
  }

  busy(): boolean {
    return this.isBusy
  }

  userMessage(text: string, opts: { images?: number; id?: string; prev?: string; time?: number } = {}): void {
    this.clearEmpty()
    const bubble = h(
      'div',
      { class: 'msg user' },
      h('div', { class: 'msg-user-text' }, text),
      opts.images ? h('div', { class: 'msg-user-imgs' }, h('span', { html: icons.image }), t('{0} 张图片', opts.images)) : null
    )
    bubble.dataset.text = text
    if (opts.id) bubble.dataset.id = opts.id
    if (opts.prev) bubble.dataset.prev = opts.prev
    const actions = h(
      'div',
      { class: 'msg-actions' },
      h('button', {
        class: 'icon-btn tiny',
        title: t('复制'),
        'aria-label': t('复制'),
        html: icons.copy,
        onClick: () => {
          void navigator.clipboard.writeText(text)
          toast(t('已复制'))
        }
      }),
      this.driver.canRewind
        ? h('button', { class: 'icon-btn tiny rewind', title: t('回退到这里'), 'aria-label': t('回退到这里'), html: icons.rewind, onClick: (e: MouseEvent) => this.rewindMenu(bubble, e.currentTarget as HTMLElement) })
        : null
    )
    const wrap = h('div', { class: 'msg-user-wrap' }, bubble, actions)
    this.listEl.append(wrap)
    this.turnEl = null
  }

  ackUser(id: string, prev?: string): void {
    // 回显按发送顺序到达：给最后一条已确认消息之后的第一条补上 id
    const all = [...this.listEl.querySelectorAll<HTMLElement>('.msg.user')]
    let k = all.length - 1
    while (k >= 0 && !all[k].dataset.id) k--
    const target = all[k + 1]
    if (!target) return
    target.dataset.id = id
    if (prev) target.dataset.prev = prev
  }

  text(id: string, text: string, append = false): void {
    let b = this.blocks.get(id)
    if (!b) {
      b = { kind: 'text', el: h('div', { class: 'msg-text' }), text: '' }
      this.addBlock(id, b)
    }
    if (b.kind !== 'text') return
    b.text = append ? b.text + text : text
    this.schedule(b)
  }

  thinking(id: string, text: string, opts: { append?: boolean; done?: boolean } = {}): void {
    let b = this.blocks.get(id)
    if (!b) {
      b = { kind: 'think', el: h('div', { class: 'msg-think' }), text: '', done: false, start: Date.now() }
      this.addBlock(id, b)
    }
    if (b.kind !== 'think') return
    b.text = opts.append ? b.text + text : text || b.text
    if (opts.done && !b.done) {
      b.done = true
      b.end = Date.now()
    }
    this.schedule(b)
  }

  tool(id: string, patch: Partial<ToolView>): void {
    let b = this.blocks.get(id)
    if (!b) {
      b = { kind: 'tool', el: h('div', { class: 'msg-tool' }), view: { icon: 'other', verb: '', summary: '', status: 'running' } }
      this.addBlock(id, b)
    }
    if (b.kind !== 'tool') return
    Object.assign(b.view, patch)
    this.schedule(b)
  }

  getTool(id: string): ToolView | undefined {
    const b = this.blocks.get(id)
    return b?.kind === 'tool' ? b.view : undefined
  }

  todos(items: Todo[]): void {
    this.todoList = items
    this.renderTodos()
  }

  note(text: string, kind: 'info' | 'error' | 'action' = 'info'): void {
    this.clearEmpty()
    const el = h('div', { class: 'msg-note' + (kind !== 'info' ? ' err' : '') }, h('span', { class: 'msg-note-text' }, text))
    if (kind === 'action') {
      if (AUTH_ERROR.test(text)) el.append(h('button', { class: 'btn small primary', onClick: () => this.showLogin() }, t('登录')))
      el.append(h('button', { class: 'btn small', onClick: () => void launchInTerminal(this.def) }, t('在终端中打开')))
    }
    const stick = this.nearBottom()
    ;(this.turnEl ?? this.listEl).append(el)
    if (stick) this.scrollToEnd()
  }

  /* ---------------- 登录 ---------------- */

  private loginCard: { el: HTMLElement; cancel?: () => void } | null = null

  /** 在对话里显示登录卡片：选择登录方式 → 浏览器授权（必要时粘贴授权码）→ 完成 */
  showLogin(): void {
    this.clearEmpty()
    this.loginCard?.cancel?.()
    this.loginCard?.el.remove()
    const body = h('div', { class: 'login-body' })
    const el = h('div', { class: 'login-card' }, h('div', { class: 'login-title' }, t('登录 {0}', this.def.name)), body)
    const card: { el: HTMLElement; cancel?: () => void } = { el }
    this.loginCard = card
    const close = () => {
      card.cancel?.()
      el.remove()
      if (this.loginCard === card) this.loginCard = null
    }

    const choose = () => {
      card.cancel = undefined
      body.replaceChildren(
        ...this.driver.loginMethods.map((m) =>
          h(
            'button',
            { class: 'login-method', onClick: () => (m.input ? askInput(m) : void start(m)) },
            h('span', { class: 'login-method-name' }, m.label),
            h('span', { class: 'login-method-hint' }, m.hint)
          )
        ),
        h('div', { class: 'login-actions' }, h('button', { class: 'btn small', onClick: close }, t('取消')))
      )
    }

    const askInput = (m: LoginMethod) => {
      const spec = m.input!
      const inp = h('input', { class: 'text-input', type: spec.secret ? 'password' : 'text', placeholder: spec.placeholder, spellcheck: 'false', autocomplete: 'off' }) as HTMLInputElement
      const go = () => {
        if (inp.value.trim()) void start(m, inp.value.trim())
      }
      inp.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') go()
      })
      body.replaceChildren(
        h('label', { class: 'login-label' }, spec.label),
        inp,
        h('div', { class: 'login-actions' }, h('button', { class: 'btn small primary', onClick: go }, t('登录')), h('button', { class: 'btn small', onClick: choose }, t('返回')))
      )
      inp.focus()
    }

    const start = async (m: LoginMethod, input?: string) => {
      const status = h('div', { class: 'login-status' }, t('正在开始登录…'))
      const extra = h('div', { class: 'login-extra' })
      let cancelFn: (() => void) | null = null
      let cancelled = false
      const cancel = () => {
        cancelled = true
        cancelFn?.()
      }
      card.cancel = cancel
      body.replaceChildren(
        status,
        extra,
        h(
          'div',
          { class: 'login-actions' },
          h(
            'button',
            {
              class: 'btn small',
              onClick: () => {
                cancel()
                choose()
              }
            },
            t('取消')
          )
        )
      )
      const ui: LoginUi = {
        input,
        url: (url, open) => {
          if (open) window.open(url)
          status.textContent = t('已在浏览器中打开登录页，请在网页上完成登录，完成后这里会自动继续。')
          extra.append(
            h(
              'div',
              { class: 'login-row' },
              h('button', { class: 'btn small', onClick: () => window.open(url) }, t('重新打开登录页')),
              h(
                'button',
                {
                  class: 'btn small',
                  onClick: () => {
                    void navigator.clipboard.writeText(url)
                    toast(t('已复制登录链接'))
                  }
                },
                t('复制链接')
              )
            )
          )
        },
        code: (code) => {
          extra.prepend(h('div', { class: 'login-row' }, h('span', { class: 'login-label' }, t('在网页上输入这个代码：')), h('code', { class: 'login-code' }, code)))
        },
        askCode: (submit) => {
          const inp = h('input', { class: 'text-input', placeholder: t('如果网页上显示了授权码，粘贴到这里'), spellcheck: 'false', autocomplete: 'off' }) as HTMLInputElement
          const go = () => {
            const v = inp.value.trim()
            if (!v) return
            submit(v)
            inp.value = ''
            status.textContent = t('正在验证授权码…')
          }
          inp.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') go()
          })
          extra.append(h('div', { class: 'login-row login-paste' }, inp, h('button', { class: 'btn small', onClick: go }, t('提交'))))
        },
        onCancel: (fn) => {
          cancelFn = fn
          if (cancelled) fn()
        }
      }
      try {
        await this.driver.login(m.id, ui)
        if (cancelled) return
        el.remove()
        if (this.loginCard === card) this.loginCard = null
        this.note(this.driver.account ? t('已登录：{0}', this.driver.account) : t('登录成功'))
        this.capabilities()
      } catch (e) {
        if (cancelled) return
        card.cancel = undefined
        body.replaceChildren(
          h('div', { class: 'login-status err' }, errText(e)),
          h(
            'div',
            { class: 'login-actions' },
            h('button', { class: 'btn small primary', onClick: () => void start(m, input) }, t('重试')),
            h('button', { class: 'btn small', onClick: choose }, t('换一种方式')),
            h('button', { class: 'btn small', onClick: () => void launchInTerminal(this.def) }, t('在终端中登录'))
          )
        )
      }
    }

    choose()
    this.listEl.append(el)
    this.scrollToEnd(true)
  }

  private async logout(): Promise<void> {
    if (!confirm(t('退出 {0} 的登录？', this.def.name))) return
    try {
      await this.driver.logout()
      this.note(t('已退出登录'))
    } catch (e) {
      this.note(t('退出登录失败：') + errText(e), 'error')
    }
  }

  permission(req: PermissionRequest, key = String(Math.random())): Promise<PermissionAnswer> {
    return new Promise((resolve, reject) => {
      this.prompts.push({ kind: 'perm', key, req, resolve, reject })
      this.renderPrompt()
      this.notifyAttention()
    })
  }

  ask(questions: Question[], key = String(Math.random())): Promise<Record<string, string[]> | null> {
    return new Promise((resolve, reject) => {
      this.prompts.push({ kind: 'ask', key, questions, resolve, reject, index: 0, answers: {}, other: {} })
      this.renderPrompt()
      this.notifyAttention()
    })
  }

  cancelPermission(key: string): void {
    const i = this.prompts.findIndex((p) => p.key === key)
    if (i < 0) return
    const [p] = this.prompts.splice(i, 1)
    p.reject(new Error(t('已撤回')))
    this.renderPrompt()
  }

  turnStarted(): void {
    if (this.isBusy) return
    this.isBusy = true
    this.started = Date.now()
    this.statusOverride = null
    clearInterval(this.ticker)
    this.ticker = setInterval(() => this.renderStatus(), 1000)
    this.renderStatus()
    this.renderSend()
  }

  turnEnded(info: TurnEnd): void {
    if (!this.isBusy) return
    this.isBusy = false
    clearInterval(this.ticker)
    this.statusOverride = null
    this.finishRunning(info.ok ? 'done' : 'error')
    for (const p of this.prompts.splice(0)) p.reject(new Error(t('已结束')))
    this.renderPrompt()
    if (info.interrupted) this.note(t('已中断'))
    else if (info.error) this.note(info.error, AUTH_ERROR.test(info.error) || /credit|subscription/i.test(info.error) ? 'action' : 'error')
    this.turnEl = null
    this.renderStatus()
    this.renderSend()
    if (this.def.id === 'claude' && !this.titleFromSession) void this.refreshTitle()
    if (this.queue.length) {
      const next = this.queue.shift()!
      this.renderQueue()
      void this.dispatch(next)
    }
  }

  status(text: string | null): void {
    this.statusOverride = text
    this.renderStatus()
  }

  usage(used: number, window: number | null, costUsd?: number): void {
    if (!window) {
      this.usageEl.hidden = true
      return
    }
    const pct = Math.min(100, Math.round((used / window) * 100))
    this.usageEl.hidden = false
    this.usageEl.className = 'chat-usage' + (pct >= 80 ? ' warn' : '')
    this.usageEl.style.setProperty('--pct', String(pct))
    this.usageEl.replaceChildren(h('span', { class: 'chat-usage-ring' }), `${pct}%`)
    this.usageEl.title = t('上下文已使用 {0} / {1} tokens{2}{3}', used.toLocaleString(), window.toLocaleString(), costUsd != null ? t(' · 本次 ${0}', costUsd.toFixed(4)) : '', pct >= 70 ? t('\n快满时可以用 /compact 压缩对话') : '')
  }

  rateLimits(r: RateLimits): void {
    saveRate(this.def.id, r)
    for (const v of views) {
      if (v.def.id !== this.def.id) continue
      v.renderLimits()
      if (!v.usagePanel.hidden) v.renderUsage()
    }
  }

  /** 标题栏上的用量按钮：有额度数据时显示最紧张的那个窗口 */
  private renderLimits(): void {
    const r = loadRate(this.def.id)
    const live = r?.windows.filter((w) => !w.resetsAt || w.resetsAt > Date.now()) ?? []
    const top = live.reduce<(typeof live)[number] | null>((a, w) => (!a || w.usedPercent > a.usedPercent ? w : a), null)
    this.limitsBtn.className = 'chat-limits' + (top && top.usedPercent >= 80 ? ' warn' : '')
    if (!top) {
      this.limitsBtn.replaceChildren(h('span', { class: 'chat-limits-icon', html: icons.gauge }))
      this.limitsBtn.title = t('用量与 token 统计')
      return
    }
    const pct = Math.round(top.usedPercent)
    this.limitsBtn.style.setProperty('--pct', String(pct))
    this.limitsBtn.replaceChildren(h('span', { class: 'chat-limits-bar' }), `${top.label} ${pct}%`)
    this.limitsBtn.title = live.map((w) => t('{0}：已用 {1}%{2}', w.label, Math.round(w.usedPercent), w.resetsAt ? ' · ' + untilText(w.resetsAt) : '')).join('\n') + t('\n点击查看 token 统计')
  }

  private toggleUsage(): void {
    if (!this.usagePanel.hidden) {
      this.usagePanel.hidden = true
      return
    }
    this.historyEl.hidden = true
    this.usagePanel.hidden = false
    this.usageMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1)
    this.usageDay = ymd(new Date())
    this.renderUsage()
    void this.driver.readRateLimits?.()
    void window.api.agent.dailyUsage(this.def.id).then(
      (d) => {
        this.daily = d
        if (!this.usagePanel.hidden) this.renderUsage()
      },
      () => {
        this.daily = {}
        if (!this.usagePanel.hidden) this.renderUsage()
      }
    )
  }

  private renderUsage(): void {
    const close = h('button', { class: 'icon-btn small', 'aria-label': t('关闭'), html: icons.close, onClick: () => (this.usagePanel.hidden = true) })

    /* ----- 订阅额度 ----- */
    const r = loadRate(this.def.id)
    const limits = h('div', { class: 'usage-limits' })
    if (r?.windows.length) {
      for (const w of r.windows) {
        const reset = !!w.resetsAt && w.resetsAt <= Date.now()
        const used = reset ? 0 : Math.round(w.usedPercent)
        limits.append(
          h(
            'div',
            { class: 'usage-limit' + (used >= 80 ? ' warn' : '') },
            h('div', { class: 'usage-limit-row' }, h('span', { class: 'usage-limit-label' }, w.label), h('span', { class: 'usage-limit-pct' }, t('已用 {0}% · 剩余 {1}%', used, 100 - used))),
            h('div', { class: 'usage-bar' }, h('span', { style: `width:${used}%` })),
            w.resetsAt ? h('div', { class: 'usage-limit-reset', title: new Date(w.resetsAt).toLocaleString() }, reset ? t('已重置，等待下次更新') : untilText(w.resetsAt)) : null
          )
        )
      }
      limits.append(h('div', { class: 'usage-note' }, t('更新于 {0}', relTime(r.updatedAt))))
    } else {
      limits.append(
        h(
          'div',
          { class: 'usage-note' },
          this.def.id === 'claude'
            ? t('Claude Code 每轮对话结束后会返回订阅额度，发一条消息后这里就会显示。使用 API Key（Console）登录时按量计费，没有额度。')
            : t('暂时没有额度信息。使用 API Key 登录时按量计费，没有额度。')
        )
      )
    }

    /* ----- 月度热力图 ----- */
    const m = this.usageMonth
    const year = m.getFullYear()
    const month = m.getMonth()
    const now = new Date()
    const isThisMonth = year === now.getFullYear() && month === now.getMonth()
    const shift = (n: number) => {
      this.usageMonth = new Date(year, month + n, 1)
      this.usageDay = ''
      this.renderUsage()
    }
    const nav = h(
      'div',
      { class: 'usage-month' },
      h('button', { class: 'icon-btn small', 'aria-label': t('上个月'), title: t('上个月'), html: icons.chevronLeft, onClick: () => shift(-1) }),
      h('span', { class: 'usage-month-title' }, t('{0} 年 {1} 月', year, month + 1)),
      h('button', { class: 'icon-btn small', 'aria-label': t('下个月'), title: t('下个月'), html: icons.chevron, disabled: isThisMonth, onClick: () => shift(1) })
    )

    let body: HTMLElement
    if (!this.daily) {
      body = h('div', { class: 'usage-note' }, h('span', { class: 'spinner' }), t(' 正在统计本地会话记录…'))
    } else {
      const days = new Date(year, month + 1, 0).getDate()
      const vals: number[] = []
      for (let d = 1; d <= days; d++) vals.push(this.daily[ymd(new Date(year, month, d))]?.total ?? 0)
      const max = Math.max(0, ...vals)
      const sum = vals.reduce((a, b) => a + b, 0)
      const active = vals.filter((v) => v > 0).length
      const elapsed = isThisMonth ? now.getDate() : days
      const peak = vals.indexOf(max)

      const inMonth = this.usageDay.startsWith(`${year}-${String(month + 1).padStart(2, '0')}-`)
      const selKey = inMonth ? this.usageDay : isThisMonth ? ymd(now) : max ? ymd(new Date(year, month, peak + 1)) : ''
      const grid = h('div', { class: 'usage-grid' }, ...[t('一'), t('二'), t('三'), t('四'), t('五'), t('六'), t('日')].map((w) => h('span', { class: 'usage-wd' }, w)))
      const lead = (new Date(year, month, 1).getDay() + 6) % 7
      for (let i = 0; i < lead; i++) grid.append(h('span', { class: 'usage-cell blank' }))
      for (let d = 1; d <= days; d++) {
        const u = this.daily[ymd(new Date(year, month, d))]
        const v = u?.total ?? 0
        const lv = v <= 0 ? 0 : Math.min(4, Math.ceil((v / max) * 4))
        const future = isThisMonth && d > now.getDate()
        const tip = u
          ? t('{0} 月 {1} 日：{2} tokens\n输入 {3}\n输出 {4}\n缓存读取 {5}{6}', month + 1, d, v.toLocaleString(), u.input.toLocaleString(), u.output.toLocaleString(), u.cacheRead.toLocaleString(), u.cacheWrite ? t('\n缓存写入 {0}', u.cacheWrite.toLocaleString()) : '')
          : t('{0} 月 {1} 日：没有使用', month + 1, d)
        const key = ymd(new Date(year, month, d))
        grid.append(
          h(
            'button',
            {
              class: `usage-cell l${lv}` + (isThisMonth && d === now.getDate() ? ' today' : '') + (future ? ' future' : '') + (key === selKey ? ' on' : ''),
              title: tip,
              disabled: future,
              'aria-pressed': String(key === selKey),
              onClick: () => {
                this.usageDay = key
                this.renderUsage()
              }
            },
            String(d)
          )
        )
      }
      const stat = (k: string, v: string) => h('div', { class: 'usage-stat' }, h('span', { class: 'usage-stat-v' }, v), h('span', { class: 'usage-stat-k' }, k))
      body = h(
        'div',
        {},
        h(
          'div',
          { class: 'usage-stats' },
          stat(t('本月合计'), fmtTokens(sum)),
          stat(t('日均'), fmtTokens(elapsed ? sum / elapsed : 0)),
          stat(max ? t('最高 · {0} 日', peak + 1) : t('最高'), max ? fmtTokens(max) : '—'),
          stat(t('活跃天数'), t('{0} 天', active))
        ),
        grid,
        this.dayDetail(selKey),
        h('div', { class: 'usage-legend' }, t('少'), ...[0, 1, 2, 3, 4].map((l) => h('span', { class: `usage-cell l${l}` })), t('多'), h('span', { class: 'grow' }), t('含缓存读写 · 统计自本机会话记录'))
      )
    }

    this.usagePanel.replaceChildren(
      h('div', { class: 'chat-history-head usage-head' }, h('span', { class: 'usage-title' }, t('{0} 用量', this.def.name)), h('span', { class: 'grow' }), close),
      h('div', { class: 'usage-scroll' }, h('div', { class: 'usage-section' }, t('订阅额度')), limits, h('div', { class: 'usage-section' }, t('Token 消耗')), nav, body)
    )
  }

  /** 热力图下方：选中那天的 token 明细 */
  private dayDetail(key: string): HTMLElement | null {
    if (!key || !this.daily) return null
    const [y, mo, d] = key.split('-').map(Number)
    const date = new Date(y, mo - 1, d)
    const title = t('{0} 月 {1} 日 · 星期{2}', mo, d, t('日,一,二,三,四,五,六').split(',')[date.getDay()])
    const u = this.daily[key]
    if (!u || !u.total) return h('div', { class: 'usage-day' }, h('div', { class: 'usage-day-head' }, h('span', { class: 'usage-day-date' }, title), h('span', { class: 'usage-day-total muted' }, t('没有使用'))))
    const rows: [string, number, string][] = [
      [t('输入'), u.input, 'in'],
      [t('输出'), u.output, 'out'],
      [t('缓存读取'), u.cacheRead, 'cr'],
      [t('缓存写入'), u.cacheWrite, 'cw']
    ]
    return h(
      'div',
      { class: 'usage-day' },
      h(
        'div',
        { class: 'usage-day-head' },
        h('span', { class: 'usage-day-date' }, title),
        h('span', { class: 'usage-day-total', title: `${u.total.toLocaleString()} tokens` }, `${fmtTokens(u.total)} tokens`)
      ),
      h('div', { class: 'usage-day-bar' }, ...rows.filter((r) => r[1] > 0).map(([k, v, c]) => h('span', { class: c, style: `flex:${v}`, title: `${k} ${v.toLocaleString()}` }))),
      h(
        'div',
        { class: 'usage-day-rows' },
        ...rows
          .filter(([k, v]) => v > 0 || k !== t('缓存写入'))
          .map(([k, v, c]) =>
            h(
              'div',
              { class: 'usage-day-row' },
              h('span', { class: 'usage-day-dot ' + c }),
              h('span', { class: 'usage-day-k' }, k),
              h('span', { class: 'usage-day-v' }, v.toLocaleString()),
              h('span', { class: 'usage-day-p' }, `${((v / u.total) * 100).toFixed(1)}%`)
            )
          )
      )
    )
  }

  /* ----- 复制 ----- */

  /** 消息列表里选中的文字 */
  private chatSelection(): string {
    const sel = window.getSelection()
    if (!sel || sel.isCollapsed || !sel.rangeCount) return ''
    if (!this.listEl.contains(sel.getRangeAt(0).commonAncestorContainer)) return ''
    return sel.toString()
  }

  /** 一条消息的原文：用户消息取输入内容，助手回复取各段 markdown 原文 */
  private messageText(target: Element | null): string {
    const user = target?.closest<HTMLElement>('.msg.user')
    if (user) return user.dataset.text ?? user.innerText
    const turn = target?.closest<HTMLElement>('.msg.assistant')
    if (!turn) return ''
    const parts: string[] = []
    for (const b of this.blocks.values()) if (b.kind === 'text' && turn.contains(b.el) && b.text.trim()) parts.push(b.text.trim())
    return parts.join('\n\n') || turn.innerText
  }

  private selectAllMessages(): void {
    const sel = window.getSelection()
    if (!sel) return
    const range = document.createRange()
    range.selectNodeContents(this.listEl)
    sel.removeAllRanges()
    sel.addRange(range)
  }

  private copyMenu(e: MouseEvent): void {
    const target = e.target as Element
    if (target.closest('input, textarea')) return
    e.preventDefault()
    const sel = this.chatSelection()
    const msg = this.messageText(target)
    const copy = (text: string) => {
      void navigator.clipboard.writeText(text)
      toast(t('已复制'))
    }
    showMenu(e.clientX, e.clientY, [
      { label: t('复制'), key: 'Ctrl C', disabled: !sel, run: () => copy(sel) },
      { label: t('复制这条消息'), disabled: !msg, run: () => copy(msg) },
      'sep',
      { label: t('全选'), key: 'Ctrl A', run: () => this.selectAllMessages() }
    ])
  }

  private titleFromSession = false

  session(id: string | null, title?: string): void {
    if (title) {
      this.titleFromSession = true
      this.setTitle(title)
    }
    void id
  }

  setMode(id: string): void {
    this.mode = id
    this.renderMode()
  }

  capabilities(): void {
    this.renderModel()
    if (!this.listEl.querySelector('.msg')) this.renderEmpty()
  }

  crashed(message: string): void {
    this.note(message, 'action')
    this.turnEnded({ ok: false })
  }

  /* ================= 视图 ================= */

  focus(): void {
    markActive(this)
    requestAnimationFrame(() => {
      if (this.promptEl.hidden) this.input.focus()
      else this.promptEl.querySelector<HTMLElement>('button, textarea, input')?.focus()
    })
    this.updateContext()
  }

  dispose(): void {
    clearInterval(this.ticker)
    this.sizeObserver.disconnect()
    for (const p of this.prompts.splice(0)) p.reject(new Error(t('视图已关闭')))
    this.driver.dispose()
    views.delete(this)
    if (lastActive === this) lastActive = null
  }

  private setTitle(raw: string): void {
    this.title = raw.replace(/\s+/g, ' ').trim()
    this.titleEl.textContent = this.title || t('新对话')
    this.titleEl.title = this.title ? t('{0}\n点击查看历史对话', this.title) : t('历史对话')
    updateView(this.el, { title: this.title ? clip(this.title, 24).replace(/\n…$/, '…') : this.def.name })
  }

  private async refreshTitle(): Promise<void> {
    const id = this.driver.sessionId
    if (!id) return
    try {
      const list = await this.driver.listSessions()
      const s = list.find((x) => x.id === id)
      if (s?.title) this.setTitle(s.title)
    } catch {
      /* ignore */
    }
  }

  private notifyAttention(): void {
    if (!document.hasFocus()) document.title = t('● {0} 需要你确认', this.def.name)
    const restore = () => {
      document.title = document.title.replace(/^● .*?需要你确认$/, 'Infinite Studio')
      window.removeEventListener('focus', restore)
    }
    window.addEventListener('focus', restore)
  }

  private nearBottom(): boolean {
    // 不可见时量不到尺寸，按最后一次可见时的状态算
    if (!this.visible()) return this.pinned
    return this.bodyEl.scrollHeight - this.bodyEl.scrollTop - this.bodyEl.clientHeight < 80
  }

  private visible(): boolean {
    return this.bodyEl.isConnected && this.bodyEl.clientHeight > 0
  }

  private rememberScroll(): void {
    if (!this.visible()) return
    this.savedScroll = this.bodyEl.scrollTop
    this.pinned = this.nearBottom()
  }

  private restoreScroll(): void {
    if (!this.visible()) return
    if (this.pinned) this.bodyEl.scrollTop = this.bodyEl.scrollHeight
    else if (this.bodyEl.scrollTop === 0 && this.savedScroll > 0) this.bodyEl.scrollTop = this.savedScroll
  }

  private scrollToEnd(force = false): void {
    if (force || this.nearBottom()) this.bodyEl.scrollTop = this.bodyEl.scrollHeight
  }

  private clearEmpty(): void {
    this.listEl.querySelector('.chat-empty')?.remove()
  }

  private renderEmpty(): void {
    if (this.listEl.querySelector('.msg, .msg-user-wrap, .login-card, .msg-note')) return
    const isCodex = this.def.id === 'codex'
    const tips = ACP_ARGS[this.def.id]
      ? [
          ['@', t('引用文件；在编辑器里选中代码后提问会自动附带')],
          [
            '/',
            this.def.id === 'kimi'
              ? t('打开命令菜单：/compact、/init…')
              : t('打开命令菜单：/model、/resume、/login…')
          ],
          [t('模式'), (AGENT_MODES[this.def.id] ?? []).map((m) => t(m.label)).join(' / ')],
          [t('历史'), t('点击标题查看并续接之前的对话')],
          ['Esc', t('中断；Ctrl N 新对话；Alt K 从编辑器插入引用')]
        ]
      : isCodex
      ? [
          ['@', t('引用文件；在编辑器里选中代码后提问会自动附带')],
          ['/review', t('审查当前未提交的修改')],
          ['/compact', t('对话太长时压缩上下文')],
          [t('模式'), t('对话（只读）/ Agent / Agent（完全访问）')],
          [t('图片'), t('可以直接粘贴或拖入截图')]
        ]
      : [
          ['@', t('引用文件；在编辑器里选中代码后提问会自动附带')],
          ['/', t('打开命令菜单：/compact、/init、/review…')],
          ['Shift Tab', t('切换模式：编辑前询问 / 自动编辑 / 计划模式')],
          [t('图片'), t('可以直接粘贴或拖入截图')],
          ['Esc', t('中断；Ctrl N 新对话；Alt K 从编辑器插入引用')]
        ]
    const where = state.root ? t('在 {0} 中工作', basenameOf(state.root)) : t('还没有打开文件夹，将在用户主目录中工作')
    this.listEl.replaceChildren(
      h(
        'div',
        { class: 'chat-empty' },
        h('span', { class: 'chat-empty-icon', html: glyph(this.def.id, 30) }),
        h('div', { class: 'chat-empty-title' }, this.def.name),
        h('p', { class: 'chat-empty-sub' }, where + (this.driver.account ? ` · ${this.driver.account}` : '')),
        this.startError
          ? h('div', { class: 'chat-empty-error' }, h('span', {}, this.startError), h('button', { class: 'btn small', onClick: () => void launchInTerminal(this.def) }, t('在终端中打开')))
          : null,
        h('div', { class: 'chat-tips' }, ...tips.map(([k, v]) => h('div', { class: 'chat-tip' }, h('kbd', {}, k), h('span', {}, v))))
      )
    )
  }

  /* ----- 块 ----- */

  private ensureTurn(): HTMLElement {
    if (!this.turnEl) {
      this.clearEmpty()
      this.turnEl = h('div', { class: 'msg assistant' })
      this.listEl.append(this.turnEl)
    }
    return this.turnEl
  }

  private addBlock(id: string, b: Block): void {
    this.blocks.set(id, b)
    const stick = this.nearBottom()
    this.ensureTurn().append(b.el)
    this.paint(b)
    if (stick) this.scrollToEnd()
  }

  private schedule(b: Block): void {
    this.dirty.add(b)
    if (this.frame) return
    this.frame = requestAnimationFrame(() => {
      this.frame = 0
      const stick = this.nearBottom()
      const sel = window.getSelection()
      const held: Block[] = []
      for (const x of this.dirty) {
        // 正在选中这一块的文字：先不重绘，否则选区会丢
        if (sel && !sel.isCollapsed && sel.rangeCount && sel.getRangeAt(0).intersectsNode(x.el)) held.push(x)
        else this.paint(x)
      }
      this.dirty.clear()
      if (held.length) setTimeout(() => held.forEach((x) => this.schedule(x)), 400)
      if (stick) this.scrollToEnd()
    })
  }

  private paint(b: Block): void {
    if (b.kind === 'text') this.paintText(b)
    else if (b.kind === 'think') this.paintThink(b)
    else this.paintTool(b)
  }

  private paintText(b: Extract<Block, { kind: 'text' }>): void {
    const copy = h('button', {
      class: 'icon-btn tiny msg-copy',
      title: t('复制'),
      'aria-label': t('复制'),
      html: icons.copy,
      onClick: () => {
        void navigator.clipboard.writeText(b.text)
        toast(t('已复制'))
      }
    })
    b.el.replaceChildren(renderMarkdown(b.text), copy)
  }

  private paintThink(b: Extract<Block, { kind: 'think' }>): void {
    const open = b.el.querySelector('details')?.open ?? false
    const secs = Math.max(1, Math.round(((b.end ?? Date.now()) - b.start) / 1000))
    const label = b.done ? (this.replaying || !b.end ? t('思考过程') : t('已思考 {0} 秒', secs)) : t('思考中…')
    b.el.className = 'msg-think' + (b.done ? '' : ' live')
    b.el.replaceChildren(
      h(
        'details',
        { open },
        h('summary', {}, h('span', { class: 'think-icon', html: icons.spark }), h('span', {}, label), h('span', { class: 'chev', html: icons.chevron })),
        b.text.trim() ? h('div', { class: 'think-body' }, renderMarkdown(b.text)) : null
      )
    )
  }

  private paintTool(b: Extract<Block, { kind: 'tool' }>): void {
    const v = b.view
    const hasBody = !!(v.diff?.hunks.length || v.input || v.output || v.markdown || v.steps?.length)
    const open = hasBody && (b.open ?? !!v.expanded)
    b.el.className = `msg-tool ${v.status}${open ? ' open' : ''}`
    const sum = v.path && v.summary ? fileLink(v.summary, v.path, v.line, 'tool-sum link') : h('span', { class: 'tool-sum' }, v.summary)
    const head = h(
      'div',
      {
        class: 'tool-head' + (hasBody ? ' toggle' : ''),
        role: hasBody ? 'button' : undefined,
        tabindex: hasBody ? '0' : undefined,
        'aria-expanded': hasBody ? String(open) : undefined,
        onClick: (e: MouseEvent) => {
          if (!hasBody || (e.target as HTMLElement).closest('a,button')) return
          b.open = !open
          this.paintTool(b)
        },
        onKeydown: (e: KeyboardEvent) => {
          if (hasBody && (e.key === 'Enter' || e.key === ' ')) {
            e.preventDefault()
            b.open = !open
            this.paintTool(b)
          }
        }
      },
      h('span', { class: 'tool-dot' }),
      h('span', { class: 'tool-verb' }, v.verb),
      sum,
      v.diff && (v.diff.added || v.diff.removed) ? diffStat(v.diff) : null,
      v.outputHint ? h('span', { class: 'tool-hint' }, v.outputHint) : null,
      v.status === 'denied' ? h('span', { class: 'tool-hint' }, t('已拒绝')) : null,
      hasBody ? h('span', { class: 'chev', html: icons.chevron }) : null
    )
    const body: HTMLElement[] = []
    if (open) {
      if (v.diff?.hunks.length) body.push(this.diffBox(v.diff))
      if (v.markdown) body.push(h('div', { class: 'tool-md' }, renderMarkdown(v.markdown)))
      if (v.steps?.length) body.push(h('div', { class: 'tool-steps' }, ...v.steps.slice(-30).map((s) => h('div', { class: 'tool-step' }, s))))
      if (v.input && v.icon !== 'edit' && v.icon !== 'write') body.push(h('div', { class: 'tool-io' }, h('span', { class: 'tool-io-k' }, 'IN'), h('pre', {}, clip(v.input, 4000))))
      if (v.output) body.push(h('div', { class: 'tool-io' }, h('span', { class: 'tool-io-k' }, 'OUT'), h('pre', {}, clip(v.output, 8000))))
    }
    b.el.replaceChildren(head, ...(body.length ? [h('div', { class: 'tool-body' }, ...body)] : []))
  }

  private diffBox(d: DiffInfo, actions?: { accept?: () => void; reject?: () => void }): HTMLElement {
    return h(
      'div',
      { class: 'diff-box' },
      renderDiff(d, 300),
      d.load ? h('button', { class: 'diff-open', title: t('在编辑器里并排对比'), onClick: () => void openDiffTab(d, actions) }, h('span', { html: icons.split }), t('打开对比')) : null
    )
  }

  private finishRunning(status: 'done' | 'error'): void {
    for (const b of this.blocks.values()) {
      if (b.kind === 'tool' && b.view.status === 'running') {
        b.view.status = status === 'error' ? 'error' : 'done'
        this.schedule(b)
      } else if (b.kind === 'think' && !b.done) {
        b.done = true
        b.end = Date.now()
        this.schedule(b)
      }
    }
  }

  /* ----- 状态行、待办、队列 ----- */

  private renderStatus(): void {
    const show = this.isBusy || !!this.statusOverride
    this.statusEl.hidden = !show
    if (!show) return
    const secs = Math.floor((Date.now() - this.started) / 1000)
    const verb = VERBS[Math.floor(secs / 6 + this.started / 1000) % VERBS.length]
    const text = this.statusOverride ?? `${verb}…`
    this.statusEl.replaceChildren(h('span', { class: 'spinner' }), h('span', { class: 'chat-status-text' }, text))
    if (this.isBusy) this.statusEl.append(h('span', { class: 'chat-status-meta' }, t('{0} 秒 · Esc 中断', secs)))
  }

  private renderTodos(): void {
    const list = this.todoList
    if (!list.length || list.every((t) => t.status === 'completed')) {
      this.todosEl.hidden = true
      return
    }
    this.todosEl.hidden = false
    const done = list.filter((t) => t.status === 'completed').length
    const cur = list.find((t) => t.status === 'in_progress')
    const head = h(
      'button',
      { class: 'chat-todos-head', onClick: () => ((this.todosOpen = !this.todosOpen), this.renderTodos()) },
      h('span', { class: 'ic', html: icons.list }),
      h('span', { class: 'chat-todos-cur' }, cur ? (cur.activeForm ?? cur.content) : t('待办')),
      h('span', { class: 'chat-todos-count' }, `${done}/${list.length}`),
      h('span', { class: 'chev' + (this.todosOpen ? ' open' : ''), html: icons.chevron })
    )
    this.todosEl.replaceChildren(head)
    if (this.todosOpen)
      this.todosEl.append(
        h(
            'div',
            { class: 'chat-todos-list' },
          ...list.map((t) => h('div', { class: 'chat-todo ' + t.status }, h('span', { class: 'chat-todo-box', html: t.status === 'completed' ? icons.check : '' }), h('span', {}, t.content)))
        )
      )
  }

  private renderQueue(): void {
    this.queueEl.hidden = !this.queue.length
    this.queueEl.replaceChildren(
      ...this.queue.map((q, i) =>
        h(
          'div',
          { class: 'chat-queued' },
          h('span', { class: 'chat-queued-k' }, t('排队中')),
          h('span', { class: 'chat-queued-text' }, q.text || t('{0} 张图片', q.images.length)),
          this.def.id === 'codex' && this.isBusy
            ? h('button', { class: 'btn tiny', title: t('立即发给正在运行的任务'), onClick: () => void this.steerQueued(i) }, t('立即发送'))
            : null,
          h('button', {
            class: 'icon-btn tiny',
            title: t('移除'),
            'aria-label': t('移除'),
            html: icons.close,
            onClick: () => {
              this.queue.splice(i, 1)
              this.renderQueue()
            }
          })
        )
      )
    )
  }

  private async steerQueued(i: number): Promise<void> {
    const q = this.queue[i]
    const d = this.driver as CodexDriver
    if (!q || typeof d.steer !== 'function') return
    if (await d.steer(q.text)) {
      this.queue.splice(i, 1)
      this.renderQueue()
      this.userMessage(q.text)
    } else toast(t('当前任务不接受补充，已保留在队列中'))
  }

  /* ----- 模式、模型 ----- */

  private renderMode(): void {
    const m = AGENT_MODES[this.def.id]?.find((x) => x.id === this.mode)
    this.modeBtn.dataset.mode = this.mode
    this.modeBtn.replaceChildren(h('span', { class: 'ic', html: modeIcon(this.mode) }), h('span', {}, m ? t(m.label) : this.mode))
    this.modeBtn.title = `${m ? t(m.hint) : ''}${this.def.id === 'claude' ? t('\nShift Tab 切换') : ''}`
  }

  private chooseMode(id: string): void {
    this.mode = id
    state.settings.agentModes = { ...state.settings.agentModes, [this.def.id]: id }
    persist()
    this.driver.setMode(id)
    this.renderMode()
  }

  private modeMenu(): void {
    popover(
      this.modeBtn,
      (AGENT_MODES[this.def.id] ?? []).map((m) => ({ label: t(m.label), hint: t(m.hint), checked: m.id === this.mode, run: () => this.chooseMode(m.id) })),
      'modes'
    )
  }

  private cycleMode(): void {
    const modes = AGENT_MODES[this.def.id] ?? []
    // 和 VS Code 扩展一样，Shift Tab 只在常用的三种模式间循环
    const ring = this.def.id === 'claude' ? modes.filter((m) => m.id !== 'bypassPermissions' || this.mode === 'bypassPermissions') : modes
    const i = ring.findIndex((m) => m.id === this.mode)
    this.chooseMode(ring[(i + 1) % ring.length].id)
  }

  private currentModel(): { label: string; efforts: string[] } {
    const models = this.driver.models
    const want = this.model ?? this.driver.activeModel
    const m = models.find((x) => x.id === want) ?? (want ? undefined : models.find((x) => x.isDefault))
    return { label: m?.label ?? want ?? t('默认模型'), efforts: m?.efforts ?? [] }
  }

  private renderModel(): void {
    const { label } = this.currentModel()
    this.modelBtn.replaceChildren(h('span', {}, label.replace(/\s*\(recommended\)/i, '')))
    if (this.effort) this.modelBtn.append(h('span', { class: 'chat-model-effort' }, effortLabel(this.effort)))
    this.modelBtn.append(h('span', { class: 'chev', html: icons.chevronDown }))
    this.modelBtn.title = t('切换模型和思考强度')
  }

  private chooseModel(model: string | undefined, effort: string | undefined): void {
    this.model = model
    this.effort = effort
    state.settings.agentPrefs = { ...state.settings.agentPrefs, [this.def.id]: { model, effort } }
    persist()
    this.driver.setModel(model ?? (this.def.id === 'claude' ? 'default' : ''), effort)
    this.renderModel()
  }

  private modelMenu(): void {
    const models = this.driver.models
    const items: PopItem[] = [{ label: t('模型'), header: true }]
    if (!models.length) items.push({ label: this.ready ? t('没有可用的模型列表') : t('正在读取模型列表…'), hint: t('仍会使用命令行配置的默认模型') })
    const cur = this.model ?? this.driver.activeModel ?? models.find((m) => m.isDefault)?.id
    for (const m of models) {
      items.push({
        label: m.label,
        hint: m.description,
        checked: m.id === cur,
        run: () => {
          const keep = this.effort && m.efforts?.includes(this.effort) ? this.effort : undefined
          this.chooseModel(m.isDefault && this.def.id === 'claude' ? undefined : m.id, keep)
        }
      })
    }
    const { efforts } = this.currentModel()
    if (efforts.length) {
      items.push({ label: t('思考强度'), header: true })
      items.push({ label: t('默认'), checked: !this.effort, run: () => this.chooseModel(this.model, undefined) })
      for (const e of efforts) items.push({ label: effortLabel(e), hint: effortHint(e), checked: this.effort === e, run: () => this.chooseModel(this.model, e) })
    }
    popover(this.modelBtn, items, 'models')
  }

  /* ----- 历史 ----- */

  private toggleHistory(): void {
    if (!this.historyEl.hidden) {
      this.historyEl.hidden = true
      return
    }
    this.historyEl.hidden = false
    const search = h('input', { class: 'chat-history-search', placeholder: t('搜索历史对话'), spellcheck: 'false' })
    const list = h('div', { class: 'chat-history-list' }, h('div', { class: 'chat-history-empty' }, h('span', { class: 'spinner' }), t('正在读取…')))
    this.historyEl.replaceChildren(
      h('div', { class: 'chat-history-head' }, search, h('button', { class: 'icon-btn small', 'aria-label': t('关闭'), html: icons.close, onClick: () => (this.historyEl.hidden = true) })),
      list
    )
    search.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        this.historyEl.hidden = true
        this.input.focus()
      } else if (e.key === 'ArrowDown') {
        list.querySelector<HTMLElement>('.chat-history-item')?.focus()
        e.preventDefault()
      }
    })
    list.addEventListener('keydown', (e) => {
      const items = [...list.querySelectorAll<HTMLElement>('.chat-history-item')]
      const i = items.indexOf(document.activeElement as HTMLElement)
      if (e.key === 'ArrowDown') items[Math.min(items.length - 1, i + 1)]?.focus()
      else if (e.key === 'ArrowUp') (i <= 0 ? search : items[i - 1]).focus()
      else if (e.key === 'Escape') this.historyEl.hidden = true
      else return
      e.preventDefault()
    })
    setTimeout(() => search.focus())
    let all: SessionInfo[] = []
    const render = () => {
      const q = search.value.trim().toLowerCase()
      const rows = all.filter((s) => !q || s.title.toLowerCase().includes(q))
      if (!rows.length) {
        list.replaceChildren(h('div', { class: 'chat-history-empty' }, all.length ? t('没有匹配的对话') : t('这个文件夹里还没有对话')))
        return
      }
      const out: HTMLElement[] = []
      let group = ''
      for (const s of rows.slice(0, 200)) {
        const g = dayGroup(s.updatedAt)
        if (g !== group) out.push(h('div', { class: 'chat-history-group' }, (group = g)))
        out.push(
          h(
            'button',
            { class: 'chat-history-item' + (s.id === this.driver.sessionId ? ' on' : ''), onClick: () => void this.resumeSession(s) },
            h('span', { class: 'chat-history-title' }, s.title),
            h('span', { class: 'chat-history-time' }, relTime(s.updatedAt))
          )
        )
      }
      list.replaceChildren(...out)
    }
    search.addEventListener('input', render)
    this.driver
      .listSessions()
      .then((s) => {
        all = s
        render()
      })
      .catch((e) => list.replaceChildren(h('div', { class: 'chat-history-empty' }, t('读取失败：') + errText(e))))
  }

  private async resumeSession(s: SessionInfo): Promise<void> {
    this.historyEl.hidden = true
    if (s.id === this.driver.sessionId) return
    if (this.isBusy && !confirm(t('{0} 还在运行，切换对话会中断它。继续吗？', this.def.name))) return
    if (this.isBusy) this.driver.interrupt()
    this.clearConversation()
    this.setTitle(s.title)
    this.titleFromSession = true
    const loading = h('div', { class: 'chat-history-empty' }, h('span', { class: 'spinner' }), t('正在载入对话…'))
    this.listEl.replaceChildren(loading)
    this.replaying = true
    try {
      await this.driver.resume(s.id)
    } catch (e) {
      this.note(t('载入失败：') + errText(e), 'error')
    } finally {
      this.replaying = false
      loading.remove()
      this.finishRunning('done')
      this.turnEl = null
    }
    this.renderEmpty()
    requestAnimationFrame(() => this.scrollToEnd(true))
    this.input.focus()
  }

  private clearConversation(): void {
    for (const p of this.prompts.splice(0)) p.reject(new Error(t('已重置')))
    this.renderPrompt()
    this.isBusy = false
    clearInterval(this.ticker)
    this.statusOverride = null
    this.blocks.clear()
    this.dirty.clear()
    this.turnEl = null
    this.queue = []
    this.todoList = []
    this.renderQueue()
    this.renderTodos()
    this.renderStatus()
    this.renderSend()
    this.usageEl.hidden = true
    this.listEl.replaceChildren()
  }

  reset(): void {
    this.driver.reset()
    this.clearConversation()
    this.titleFromSession = false
    this.setTitle('')
    this.historyEl.hidden = true
    this.renderEmpty()
    this.input.focus()
  }

  private moreMenu(anchor: HTMLElement): void {
    const items: PopItem[] = [
      { label: t('新对话标签'), hint: t('在新标签里开始另一个对话'), run: () => openChat(this.def.id, { fresh: true }) },
      { label: this.driver.account ? t('切换账号') : t('登录'), hint: this.driver.account ?? t('登录 {0}', this.def.name), run: () => this.showLogin() },
      ...(this.driver.account ? [{ label: t('退出登录'), hint: this.driver.account, run: () => void this.logout() }] : []),
      { label: t('在终端中运行 {0}', this.def.name), hint: t('原生命令行界面，可使用全部 / 命令'), run: () => void launchInTerminal(this.def) },
      {
        label: t('附带当前文件和选中内容'),
        hint: t('发送消息时自动告诉助手你正在看的文件'),
        checked: state.settings.agentContext !== false,
        run: () => {
          state.settings.agentContext = state.settings.agentContext === false
          persist()
          views.forEach((v) => v.updateContext())
        }
      }
    ]
    const id = this.driver.sessionId
    if (id)
      items.push({
        label: t('复制会话 ID'),
        hint: id,
        run: () => {
          void navigator.clipboard.writeText(id)
          toast(t('已复制'))
        }
      })
    popover(anchor, items)
  }

  /* ----- 回退（Claude 检查点） ----- */

  private rewindMenu(bubble: HTMLElement, anchor: HTMLElement): void {
    const id = bubble.dataset.id
    if (!id) return toast(t('这条消息还没有确认，稍后再试'))
    if (this.isBusy) return toast(t('请先停止当前任务'))
    const prev = bubble.dataset.prev
    popover(anchor, [
      { label: t('回退到这里'), header: true },
      { label: t('恢复代码和对话'), hint: t('撤销这条消息之后的文件修改，并从这里重新开始对话'), run: () => void this.rewind(bubble, id, prev, { code: true, conversation: true }) },
      { label: t('只回退对话'), hint: t('保留文件修改，从这里重新开始对话'), run: () => void this.rewind(bubble, id, prev, { code: false, conversation: true }) },
      { label: t('只恢复代码'), hint: t('撤销这条消息之后的文件修改，对话保持不变'), run: () => void this.rewind(bubble, id, prev, { code: true, conversation: false }) }
    ])
  }

  private async rewind(bubble: HTMLElement, id: string, prev: string | undefined, what: { code: boolean; conversation: boolean }): Promise<void> {
    if (!this.driver.rewind) return
    try {
      await this.driver.rewind(id, prev, what)
    } catch (e) {
      this.note(t('回退失败：') + errText(e), 'error')
      return
    }
    if (what.conversation) {
      const wrap = bubble.closest('.msg-user-wrap')
      let n: Element | null = wrap
      while (n) {
        const next: Element | null = n.nextElementSibling
        n.remove()
        n = next
      }
      for (const [k, b] of this.blocks) if (!b.el.isConnected) this.blocks.delete(k)
      this.turnEl = null
      this.input.value = bubble.dataset.text ?? ''
      this.autoGrow()
      this.input.focus()
      this.renderEmpty()
    }
  }

  /* ----- 授权、提问 ----- */

  private renderPrompt(): void {
    const p = this.prompts[0]
    this.promptEl.hidden = !p
    this.boxEl.hidden = !!p
    if (!p) {
      this.promptEl.replaceChildren()
      return
    }
    if (p.kind === 'perm') this.renderPerm(p)
    else this.renderAsk(p)
    requestAnimationFrame(() => {
      this.promptEl.querySelector<HTMLElement>('textarea, .prompt-opt.primary, .prompt-opt, input')?.focus()
      this.scrollToEnd()
    })
  }

  private resolvePrompt(p: PromptItem, value: unknown): void {
    const i = this.prompts.indexOf(p)
    if (i < 0) return
    this.prompts.splice(i, 1)
    if (p.kind === 'perm') p.resolve(value as PermissionAnswer)
    else p.resolve(value as Record<string, string[]> | null)
    this.renderPrompt()
    if (!this.prompts.length) this.input.focus()
  }

  private renderPerm(p: Extract<PromptItem, { kind: 'perm' }>): void {
    const r = p.req
    const more = this.prompts.length > 1 ? h('span', { class: 'prompt-more' }, t('还有 {0} 个', this.prompts.length - 1)) : null
    const children: (HTMLElement | null)[] = [h('div', { class: 'prompt-title' }, h('span', { class: 'prompt-icon', html: icons.shield }), h('span', {}, r.title), more)]
    if (r.detail) children.push(h('div', { class: 'prompt-detail' }, r.detail))
    if (r.code) children.push(h('pre', { class: 'prompt-code' }, clip(r.code, 3000)))
    if (r.diff?.hunks.length) {
      const yes = r.options[0]?.id
      const no = r.options.find((o) => o.feedback)?.id ?? r.options[r.options.length - 1]?.id
      children.push(this.diffBox(r.diff, { accept: () => this.resolvePrompt(p, { option: yes }), reject: () => this.resolvePrompt(p, { option: no }) }))
    }
    if (r.markdown) children.push(h('div', { class: 'prompt-md' }, renderMarkdown(r.markdown)))
    if (p.choosing) {
      const opt = r.options.find((o) => o.id === p.choosing)
      const ta = h('textarea', { class: 'prompt-feedback', rows: '2', placeholder: t('告诉它应该怎么做（可留空，Enter 发送）') })
      const go = () => this.resolvePrompt(p, { option: p.choosing!, feedback: ta.value.trim() || undefined })
      ta.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
          e.preventDefault()
          go()
        } else if (e.key === 'Escape') {
          e.preventDefault()
          e.stopPropagation()
          p.choosing = undefined
          this.renderPrompt()
        }
      })
      children.push(
        h('div', { class: 'prompt-fb-label' }, opt?.label ?? ''),
        ta,
        h(
          'div',
          { class: 'prompt-options row' },
          h('button', { class: 'btn small', onClick: () => ((p.choosing = undefined), this.renderPrompt()) }, t('返回')),
          h('button', { class: 'btn small primary', onClick: go }, t('发送'))
        )
      )
    } else {
      children.push(
        h(
          'div',
          { class: 'prompt-options' },
          ...r.options.map((o, i) =>
            h(
              'button',
              {
                class: 'prompt-opt' + (i === 0 ? ' primary' : ''),
                onClick: () => {
                  if (o.feedback) {
                    p.choosing = o.id
                    this.renderPrompt()
                  } else this.resolvePrompt(p, { option: o.id })
                }
              },
              h('kbd', {}, String(i + 1)),
              h('span', {}, o.label)
            )
          )
        ),
        h('div', { class: 'prompt-hint' }, t('按数字键选择 · Esc 拒绝'))
      )
    }
    this.promptEl.replaceChildren(h('div', { class: 'prompt-card' }, ...children))
  }

  private renderAsk(p: Extract<PromptItem, { kind: 'ask' }>): void {
    const qs = p.questions
    const q = qs[p.index]
    const sel = (p.answers[q.id] ??= [])
    const tabsEl =
      qs.length > 1
        ? h(
            'div',
            { class: 'ask-tabs' },
            ...qs.map((x, i) =>
              h(
                'button',
                { class: 'ask-tab' + (i === p.index ? ' on' : '') + (p.answers[x.id]?.length || p.other[x.id] ? ' done' : ''), onClick: () => ((p.index = i), this.renderPrompt()) },
                x.header || t('问题 {0}', i + 1)
              )
            )
          )
        : null
    const toggle = (label: string) => {
      const i = sel.indexOf(label)
      if (q.multiSelect) {
        if (i >= 0) sel.splice(i, 1)
        else sel.push(label)
        this.renderPrompt()
      } else {
        p.answers[q.id] = [label]
        p.other[q.id] = ''
        next()
      }
    }
    const answered = (x: Question) => !!(p.answers[x.id]?.length || p.other[x.id]?.trim())
    const finish = () => {
      const out: Record<string, string[]> = {}
      for (const x of qs) {
        const a = [...(p.answers[x.id] ?? [])]
        const o = p.other[x.id]?.trim()
        if (o) a.push(o)
        out[x.id] = a
      }
      this.resolvePrompt(p, out)
    }
    const next = () => {
      const i = qs.findIndex((x, k) => k > p.index && !answered(x))
      const j = i >= 0 ? i : qs.findIndex((x) => !answered(x))
      if (j < 0) return finish()
      p.index = j
      this.renderPrompt()
    }
    const other = q.allowOther
      ? h('input', {
          class: 'ask-other',
          placeholder: q.options.length ? t('其他（自己填写）') : t('输入你的回答'),
          value: p.other[q.id] ?? '',
          onInput: (e: Event) => (p.other[q.id] = (e.target as HTMLInputElement).value),
          onKeydown: (e: KeyboardEvent) => {
            if (e.key === 'Enter' && !e.isComposing) {
              e.preventDefault()
              if (!q.multiSelect) p.answers[q.id] = []
              next()
            }
          }
        })
      : null
    this.promptEl.replaceChildren(
      h(
        'div',
        { class: 'prompt-card ask' },
        h('div', { class: 'prompt-title' }, h('span', { class: 'prompt-icon', html: icons.question }), h('span', {}, t('{0} 有问题想问你', this.def.name))),
        tabsEl,
        h('div', { class: 'ask-q' }, q.question),
        q.multiSelect ? h('div', { class: 'prompt-detail' }, t('可多选')) : null,
        h(
          'div',
          { class: 'ask-opts' },
          ...q.options.map((o, i) =>
            h(
              'button',
              { class: 'prompt-opt ask-opt' + (sel.includes(o.label) ? ' on' : ''), onClick: () => toggle(o.label) },
              h('kbd', {}, String(i + 1)),
              h('span', { class: 'ask-opt-text' }, h('span', {}, o.label), o.description ? h('span', { class: 'ask-opt-desc' }, o.description) : null)
            )
          )
        ),
        other,
        h(
          'div',
          { class: 'prompt-options row' },
          h('button', { class: 'btn small', onClick: () => this.resolvePrompt(p, null) }, t('跳过')),
          h('span', { class: 'grow' }),
          h('button', { class: 'btn small primary', onClick: () => (qs.every(answered) ? finish() : next()) }, qs.every(answered) || qs.length === 1 ? t('提交') : t('下一题'))
        )
      )
    )
  }

  /* ----- 输入 ----- */

  private autoGrow(): void {
    this.input.style.height = 'auto'
    this.input.style.height = Math.min(this.input.scrollHeight, 260) + 'px'
  }

  private renderSend(): void {
    const stop = this.isBusy && !this.input.value.trim()
    this.sendBtn.innerHTML = stop ? icons.stop : icons.send
    this.sendBtn.classList.toggle('stop', stop)
    this.sendBtn.setAttribute('aria-label', stop ? t('停止 (Esc)') : this.isBusy ? t('加入队列') : t('发送 (Enter)'))
    this.sendBtn.title = stop ? t('停止 Esc') : this.isBusy ? t('加入队列，当前任务结束后发送') : t('发送 Enter')
  }

  /** 发送时附带的上下文 */
  private context(): PromptContext {
    if (state.settings.agentContext === false) return {}
    // 和 VS Code 的 Codex 扩展一样带上最近使用的 5 个打开文件
    const openTabs = this.def.id === 'codex' ? recentFiles(5).map((t) => t.path) : undefined
    const sel = fileSelection()
    if (sel) return { selection: { ...sel, text: clip(sel.text, 20_000) }, openTabs }
    const f = recentFile()
    return f ? { file: f.path, openTabs } : { openTabs }
  }

  updateContext(): void {
    const on = state.settings.agentContext !== false
    const sel = fileSelection()
    const f = recentFile()
    const chips: HTMLElement[] = []
    this.images.forEach((img, i) =>
      chips.push(
        h(
          'span',
          { class: 'chat-img', title: img.name },
          h('img', { src: img.dataUrl, alt: img.name }),
          h('button', {
            class: 'chat-img-x',
            'aria-label': t('移除图片'),
            html: icons.close,
            onClick: () => {
              this.images.splice(i, 1)
              this.updateContext()
            }
          })
        )
      )
    )
    if (sel || f) {
      const path = sel?.path ?? f!.path
      const label = sel ? `${basenameOf(path)}:${sel.startLine}${sel.endLine !== sel.startLine ? '-' + sel.endLine : ''}` : basenameOf(path)
      chips.push(
        h(
          'span',
          { class: 'chat-ctx' + (on ? '' : ' off'), title: on ? t('将附带{0}：{1}', sel ? t('选中的 {0} 行', sel.endLine - sel.startLine + 1) : t('当前文件'), rel(path)) : t('不附带当前文件') },
          h('button', {
            class: 'chat-ctx-eye',
            'aria-label': on ? t('不附带') : t('附带'),
            html: on ? icons.eye : icons.eyeOff,
            onClick: () => {
              state.settings.agentContext = !on
              persist()
              views.forEach((v) => v.updateContext())
            }
          }),
          h('button', { class: 'chat-ctx-name', onClick: () => void openFile(path, sel ? { line: sel.startLine, col: 1 } : {}) }, label),
          sel ? h('span', { class: 'chat-ctx-sel' }, t('{0} 行', sel.endLine - sel.startLine + 1)) : null
        )
      )
    }
    this.attachEl.replaceChildren(...chips)
    this.attachEl.hidden = !chips.length
  }

  private async addImage(f: File): Promise<void> {
    const img = await readImage(f)
    if (!img) return
    if (this.images.length >= 10) return toast(t('最多 10 张图片'))
    this.images.push(img)
    this.updateContext()
  }

  private onPaste(e: ClipboardEvent): void {
    const files = Array.from(e.clipboardData?.files ?? []).filter((f) => f.type.startsWith('image/'))
    if (!files.length) return
    e.preventDefault()
    files.forEach((f) => void this.addImage(f))
  }

  private onDrop(e: DragEvent): void {
    this.boxEl.classList.remove('drop')
    const dt = e.dataTransfer
    if (!dt) return
    const files = Array.from(dt.files).filter((f) => f.type.startsWith('image/'))
    if (files.length) {
      e.preventDefault()
      files.forEach((f) => void this.addImage(f))
      return
    }
    const text = dt.getData('text/plain')
    if (text && /^([A-Za-z]:[\\/]|\/)/.test(text.trim())) {
      e.preventDefault()
      this.insertMention(text.trim())
    }
  }

  insertMention(pathOrToken: string, lines?: { start: number; end: number }): void {
    const r = state.root ? relative(state.root, pathOrToken) : pathOrToken.replace(/\\/g, '/')
    const ref = (/\s/.test(r) ? `"${r}"` : r) + (lines ? `#L${lines.start}${lines.end !== lines.start ? '-' + lines.end : ''}` : '')
    this.insertText(`@${ref} `)
  }

  /** 插入一段文字（插件页面“发送给 AI”）：单独成段 */
  insertBlock(text: string): void {
    const cur = this.input.value
    const pos = this.input.selectionStart ?? cur.length
    const before = cur.slice(0, pos)
    const pad = before && !/\n\s*$/.test(before) ? (/\s$/.test(before) ? '\n' : '\n\n') : ''
    this.insertText(pad + text.replace(/\s+$/, '') + '\n')
  }

  private insertText(token: string): void {
    const pos = this.input.selectionStart ?? this.input.value.length
    const before = this.input.value.slice(0, pos)
    const pad = before && !/\s$/.test(before) ? ' ' : ''
    this.input.value = before + pad + token + this.input.value.slice(this.input.selectionEnd ?? pos)
    const caret = (before + pad + token).length
    this.input.focus()
    this.input.setSelectionRange(caret, caret)
    this.autoGrow()
    this.renderSend()
  }

  private insertTrigger(ch: '@' | '/'): void {
    if (ch === '/') {
      if (!this.input.value.startsWith('/')) this.input.value = '/' + this.input.value
      this.input.focus()
      this.input.setSelectionRange(1, 1)
    } else this.insertText('@')
    this.updateCompletion()
  }

  /* ----- @ / 补全 ----- */

  private async updateCompletion(): Promise<void> {
    const seq = ++this.completionSeq
    const v = this.input.value
    const pos = this.input.selectionStart ?? v.length
    const before = v.slice(0, pos)
    const slash = v.match(/^\/(\S*)$/) && pos <= v.length ? v.slice(1, pos) : null
    const at = before.match(/(?:^|\s)@("?[^\s"@]*)$/)
    if (slash !== null && !/\s/.test(v)) {
      const q = slash.toLowerCase()
      const cmds = [...this.localCommands(), ...this.driver.commands]
      const seen = new Set<string>()
      const list = cmds
        .filter((c) => !seen.has(c.name) && seen.add(c.name))
        .map((c) => ({ c, s: !q ? 1 : c.name.toLowerCase().startsWith(q) ? 3 : c.name.toLowerCase().includes(q) ? 2 : c.description.toLowerCase().includes(q) ? 1 : 0 }))
        .filter((x) => x.s > 0)
        .sort((a, b) => b.s - a.s)
        .slice(0, 60)
      this.showCompletion(
        list.map(({ c }) => ({
          label: '/' + c.name,
          detail: (c.hint ? c.hint + '  ' : '') + c.description,
          apply: () => {
            this.input.value = '/' + c.name + ' '
            this.input.setSelectionRange(this.input.value.length, this.input.value.length)
            this.autoGrow()
            this.closeCompletion()
            this.renderSend()
          }
        }))
      )
      return
    }
    if (at) {
      const q = at[1].replace(/^"/, '')
      const start = pos - at[1].length - 1
      const root = state.root
      const open = tabs.map((t) => t.path)
      const files = await projectFiles()
      if (seq !== this.completionSeq) return
      const relOf = (p: string) => (root ? relative(root, p) : p.replace(/\\/g, '/'))
      const pool = q ? files : [...new Set([...open, ...files])]
      const scored = pool
        .map((p) => ({ p, r: relOf(p), s: fuzzy(q, relOf(p)) + (open.includes(p) ? 50 : 0) }))
        .filter((x) => x.s > 0)
        .sort((a, b) => b.s - a.s)
        .slice(0, 40)
      this.showCompletion(
        scored.map(({ p, r }) => ({
          label: basenameOf(r),
          detail: r,
          apply: () => {
            const token = '@' + (/\s/.test(r) ? `"${r}"` : r) + ' '
            const end = this.input.selectionStart ?? pos
            this.input.value = this.input.value.slice(0, start) + token + this.input.value.slice(end)
            const caret = start + token.length
            this.input.setSelectionRange(caret, caret)
            this.autoGrow()
            this.closeCompletion()
            this.renderSend()
            void p
          }
        }))
      )
      return
    }
    this.closeCompletion()
  }

  private localCommands(): { name: string; description: string; hint?: string }[] {
    return [
      { name: 'clear', description: t('开始新对话') },
      { name: 'model', description: t('切换模型和思考强度') },
      { name: 'resume', description: t('打开历史对话') }
    ]
  }

  private showCompletion(items: CompletionItem[]): void {
    if (!items.length) return this.closeCompletion()
    this.completion = { items, index: 0 }
    this.renderCompletion()
  }

  private renderCompletion(): void {
    const c = this.completion
    if (!c) return
    this.popupEl.hidden = false
    this.popupEl.replaceChildren(
      ...c.items.map((it, i) =>
        h(
          'div',
          {
            class: 'chat-complete-item' + (i === c.index ? ' on' : ''),
            role: 'option',
            onMousedown: (e: MouseEvent) => {
              e.preventDefault()
              it.apply()
            },
            onMousemove: () => {
              if (c.index !== i) {
                c.index = i
                this.renderCompletion()
              }
            }
          },
          h('span', { class: 'chat-complete-label' }, it.label),
          it.detail ? h('span', { class: 'chat-complete-detail' }, it.detail) : null
        )
      )
    )
    this.popupEl.children[c.index]?.scrollIntoView({ block: 'nearest' })
  }

  private closeCompletion(): void {
    this.completion = null
    this.popupEl.hidden = true
    this.popupEl.replaceChildren()
  }

  private onInputKey(e: KeyboardEvent): void {
    const c = this.completion
    if (c) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        c.index = (c.index + (e.key === 'ArrowDown' ? 1 : -1) + c.items.length) % c.items.length
        this.renderCompletion()
        return
      }
      if ((e.key === 'Enter' || e.key === 'Tab') && !e.shiftKey && !e.isComposing) {
        e.preventDefault()
        c.items[c.index]?.apply()
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        this.closeCompletion()
        return
      }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault()
      if (this.def.id === 'codex' && (e.ctrlKey || e.metaKey) && this.isBusy) void this.steerNow()
      else this.submit()
      return
    }
    if (e.key === 'Tab' && e.shiftKey) {
      e.preventDefault()
      this.cycleMode()
      return
    }
    if (e.key === 'ArrowUp' && this.sent.length && (this.input.value === '' || this.sentIdx >= 0) && this.input.selectionStart === 0) {
      e.preventDefault()
      this.sentIdx = Math.min(this.sent.length - 1, this.sentIdx + 1)
      this.input.value = this.sent[this.sent.length - 1 - this.sentIdx]
      this.autoGrow()
      return
    }
    if (e.key === 'ArrowDown' && this.sentIdx >= 0 && this.input.selectionStart === this.input.value.length) {
      e.preventDefault()
      this.sentIdx--
      this.input.value = this.sentIdx >= 0 ? this.sent[this.sent.length - 1 - this.sentIdx] : ''
      this.autoGrow()
      return
    }
    queueMicrotask(() => this.renderSend())
  }

  private async steerNow(): Promise<void> {
    const text = this.input.value.trim()
    if (!text) return
    const d = this.driver as CodexDriver
    if (await d.steer(text)) {
      this.input.value = ''
      this.autoGrow()
      this.userMessage(text)
    } else this.submit()
  }

  /** 视图级快捷键（焦点在对话里的任何地方） */
  private onViewKey(e: KeyboardEvent): void {
    const ctrl = e.ctrlKey || e.metaKey
    if (ctrl && !e.shiftKey && !e.altKey && !(e.target as HTMLElement).matches('textarea, input')) {
      const k = e.key.toLowerCase()
      if (k === 'c') {
        const sel = this.chatSelection()
        if (sel) {
          e.preventDefault()
          void navigator.clipboard.writeText(sel)
          return
        }
      } else if (k === 'a' && this.bodyEl.contains(e.target as Node)) {
        e.preventDefault()
        this.selectAllMessages()
        return
      }
    }
    if (ctrl && !e.shiftKey && e.key.toLowerCase() === 'n') {
      e.preventDefault()
      this.reset()
      return
    }
    const p = this.prompts[0]
    const inField = (e.target as HTMLElement).matches('textarea, input')
    if (p?.kind === 'perm' && !p.choosing && !inField) {
      const n = parseInt(e.key, 10)
      if (n >= 1 && n <= p.req.options.length) {
        e.preventDefault()
        const o = p.req.options[n - 1]
        if (o.feedback) {
          p.choosing = o.id
          this.renderPrompt()
        } else this.resolvePrompt(p, { option: o.id })
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        const no = p.req.options.find((o) => o.feedback) ?? p.req.options[p.req.options.length - 1]
        this.resolvePrompt(p, { option: no.id })
        return
      }
    }
    if (p?.kind === 'ask' && !inField) {
      const n = parseInt(e.key, 10)
      const q = p.questions[p.index]
      if (n >= 1 && n <= q.options.length) {
        e.preventDefault()
        this.promptEl.querySelectorAll<HTMLButtonElement>('.ask-opt')[n - 1]?.click()
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        this.resolvePrompt(p, null)
        return
      }
    }
    if (e.key === 'Escape' && !e.defaultPrevented) {
      if (!this.historyEl.hidden) {
        this.historyEl.hidden = true
        e.preventDefault()
      } else if (this.isBusy) {
        e.preventDefault()
        this.interrupt()
      }
    }
  }

  private interrupt(): void {
    if (!this.isBusy) return
    this.status(t('正在中断…'))
    this.driver.interrupt()
  }

  submit(): void {
    const text = this.input.value.trim()
    if (!text && !this.images.length) return
    if (/^\/(clear|new)\s*$/.test(text)) {
      this.input.value = ''
      this.autoGrow()
      return this.reset()
    }
    if (/^\/(login|logout)\s*$/.test(text)) {
      this.input.value = ''
      this.autoGrow()
      return text.startsWith('/login') ? this.showLogin() : void this.logout()
    }
    if (/^\/model\s*$/.test(text)) {
      this.input.value = ''
      this.autoGrow()
      return this.modelMenu()
    }
    if (/^\/(resume|history)\s*$/.test(text)) {
      this.input.value = ''
      this.autoGrow()
      if (this.historyEl.hidden) this.toggleHistory()
      return
    }
    const input: UserInput = { text, images: [...this.images], context: this.context() }
    this.input.value = ''
    this.images = []
    this.autoGrow()
    this.updateContext()
    this.closeCompletion()
    if (text) {
      this.sent = [...this.sent.filter((s) => s !== text), text].slice(-50)
      this.sentIdx = -1
    }
    if (this.isBusy || this.prompts.length) {
      this.queue.push(input)
      this.renderQueue()
      this.renderSend()
      return
    }
    void this.dispatch(input)
  }

  private async dispatch(input: UserInput): Promise<void> {
    this.historyEl.hidden = true
    this.userMessage(input.text, { images: input.images.length })
    if (!this.title) this.setTitle(input.text.split('\n')[0])
    this.turnStarted()
    this.scrollToEnd(true)
    try {
      await this.driver.send(input)
    } catch (e) {
      this.note(errText(e), 'action')
      this.turnEnded({ ok: false })
    }
  }
}

/** 需要登录的错误 */
const AUTH_ERROR = /login|log in|sign in|logged out|not authenticated|unauthori[sz]ed|auth|api key|401|403|登录|未授权/i

/* ---------------- 小工具 ---------------- */

function modeIcon(mode: string): string {
  switch (mode) {
    case 'acceptEdits':
    case 'agent':
    case 'auto':
      return icons.edit
    case 'plan':
    case 'chat':
      return icons.plan
    case 'bypassPermissions':
    case 'full':
    case 'yolo':
      return icons.warn
    default:
      return icons.shield
  }
}

function effortLabel(e: string): string {
  return { minimal: t('最低'), low: t('低'), medium: t('中'), high: t('高'), xhigh: t('超高'), max: t('最高'), none: t('关闭'), off: t('关闭'), on: t('开启') }[e] ?? e
}

function effortHint(e: string): string {
  return (
    {
      minimal: t('几乎不思考，最快'),
      low: t('更快，适合简单任务'),
      medium: t('平衡速度和质量'),
      high: t('更深入的思考'),
      xhigh: t('复杂问题，花更多时间'),
      max: t('最难的问题，最慢'),
      off: t('不思考，直接回答'),
      on: t('先思考再回答')
    }[e] ?? ''
  )
}

/* ---------------- 打开对话 ---------------- */

function latestView(id: string): ChatView | undefined {
  return [...views].reverse().find((v) => v.def.id === id)
}

/** 打开某个插件的对话：已有就切过去，没有就在右侧新开一个标签 */
export function openChat(id: string, opts: { fresh?: boolean } = {}): ChatView | null {
  const existing = opts.fresh ? undefined : latestView(id)
  if (existing && revealView(existing.el)) {
    existing.focus()
    return existing
  }
  const def = PLUGINS.find((p) => p.id === id)
  if (!def) return null
  const v = new ChatView(def)
  openView(
    {
      title: def.name,
      icon: glyph(id, 14),
      kind: id,
      el: v.el,
      onShow: () => v.focus(),
      onClose: () => {
        if (v.busy() && !confirm(t('{0} 还在运行，关闭会中止它。确定关闭吗？', def.name))) return false
        v.dispose()
      }
    },
    { side: true }
  )
  v.focus()
  return v
}

/** 在对话输入框里插入 @路径 */
export function mentionInChat(id: string, path: string): void {
  openChat(id)?.insertMention(path)
}

/** Alt K：把编辑器里的当前文件 / 选中行作为 @引用插入最近使用的对话 */
export function insertAtMention(): void {
  const sel = fileSelection()
  const f = recentFile()
  if (!sel && !f) return toast(t('没有打开的文件'))
  const ext = recentTarget()
  if (ext) return ext.mention(sel, sel ? sel.path : f!.path)
  const target = lastActive && views.has(lastActive) ? lastActive : null
  const id = target?.def.id ?? PLUGINS.find(usable)?.id
  if (!id) return toast(t('没有可用的 AI 助手，请先在插件页启用'))
  const v = target && revealView(target.el) ? target : openChat(id)
  if (!v) return
  if (sel) v.insertMention(sel.path, { start: sel.startLine, end: sel.endLine })
  else v.insertMention(f!.path)
  v.focus()
}

/** Ctrl Esc：在编辑器和对话输入框之间切换焦点 */
export function toggleChatFocus(): boolean {
  const inChat = !!(document.activeElement as HTMLElement | null)?.closest?.('.chat')
  if (inChat) return false
  const ext = recentTarget()
  if (ext) return ext.focus()
  const v = lastActive && views.has(lastActive) ? lastActive : null
  if (!v || !revealView(v.el)) return false
  v.focus()
  return true
}

export function renderAgentIcons(): void {
  agentIcons.replaceChildren(
    ...PLUGINS.filter(usable).map((def) =>
      h('button', {
        class: 'agent-icon',
        'data-plugin': def.id,
        'aria-label': t('打开 {0} 对话', def.name),
        title: `${def.name}`,
        html: glyph(def.id, 16),
        onClick: () => openChat(def.id)
      })
    ),
    ...extraIcons()
  )
}

/** 系统设置里切换“附带当前文件”后，刷新所有对话输入框上的上下文提示 */
export function refreshAgentContext(): void {
  views.forEach((v) => v.updateContext())
}

/** 插件页面里的“发送给 AI”：放进最近使用的对话的输入框（不发送）；file 为要一起引用的文件 */
function sendFromPlugin(text: string, file: string | null): boolean {
  const target = lastActive && views.has(lastActive) ? lastActive : null
  const id = target?.def.id ?? PLUGINS.find(usable)?.id
  if (!id) return false
  const v = target && revealView(target.el) ? target : openChat(id)
  if (!v) return false
  if (file) v.insertMention(file)
  if (text.trim()) v.insertBlock(text)
  v.focus()
  return true
}

export function initChat(): void {
  initBus()
  setAgentSender(sendFromPlugin)
  onSelection(() => views.forEach((v) => v.updateContext()))
  onPluginsChange(renderAgentIcons)
  renderAgentIcons()
}

/** 标签变化时更新附带的上下文 */
export function onTabsChanged(): void {
  for (const v of views) v.updateContext()
}

