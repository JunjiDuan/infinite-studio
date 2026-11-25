/**
 * 运行与调试：断点、DAP 客户端、调试侧栏、调试控制台。
 * 调试适配器由主进程启动（见 src/main/debug.ts），这里只说 DAP。
 */
import type { PluginDef } from '../../shared/plugins'
import { invoke, quote, shellKind, withEnv } from '../../shared/shell'
import { basename, h, relative, toast } from './dom'
import { activeTab, normPath, onEditor, onTab, openFile, pathKey, saveAll, setGlyphPredicate } from './editor'
import { icons } from './icons'
import { monaco } from './monaco'
import { refreshLspServers } from './lsp'
import { openPanelView, newTerminal, type TermHandle } from './panel'
import { install, languagePlugin, languageReady, pluginStatus, pluginsSettled, refreshPlugins } from './plugins'
import { emit, on, state } from './store'
import { getLocale, t } from './i18n'

type Model = monaco.editor.ITextModel
// DAP 消息结构多变，统一按 JSON 处理
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any

const sh = shellKind(window.api.platform)

/* ---------------- 断点 ---------------- */

interface FileBps {
  path: string
  lines: number[]
}

const STORE_KEY = 'infinite.breakpoints'
const bps = new Map<string, FileBps>()
/** 模型 → 断点装饰 id（装饰会跟着编辑移动，保存时据此更新行号） */
const decos = new Map<Model, string[]>()
/** 适配器确认失败的断点：pathKey → 行号 */
const unverified = new Map<string, Set<number>>()

function loadBps(): void {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_KEY) ?? '{}') as Record<string, number[]>
    for (const [p, lines] of Object.entries(raw)) if (Array.isArray(lines) && lines.length) bps.set(pathKey(p), { path: p, lines: [...new Set(lines)].sort((a, b) => a - b) })
  } catch {
    /* 忽略损坏的数据 */
  }
}

function saveBps(): void {
  const out: Record<string, number[]> = {}
  for (const b of bps.values()) if (b.lines.length) out[b.path] = b.lines
  localStorage.setItem(STORE_KEY, JSON.stringify(out))
}

function debuggable(m: Model): boolean {
  return m.uri.scheme === 'file' && !!languagePlugin(m.getLanguageId())
}

/** 适配器返回的路径统一成本机写法（Windows 用反斜杠、盘符大写） */
function fixPath(p: string): string {
  return normPath(window.api.platform === 'win32' ? p.replace(/\//g, '\\') : p)
}

function modelPath(m: Model): string {
  return normPath(m.uri.fsPath)
}

function renderDecos(m: Model): void {
  if (m.isDisposed()) return
  const key = pathKey(modelPath(m))
  const lines = bps.get(key)?.lines ?? []
  const bad = unverified.get(key)
  const next: monaco.editor.IModelDeltaDecoration[] = lines.map((line) => ({
    range: new monaco.Range(line, 1, line, 1),
    options: {
      glyphMarginClassName: 'dbg-bp' + (bad?.has(line) ? ' unverified' : ''),
      glyphMarginHoverMessage: { value: bad?.has(line) ? t('断点（未能设置）') : t('断点') },
      stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges
    }
  }))
  decos.set(m, m.deltaDecorations(decos.get(m) ?? [], next))
}

/** 编辑后断点会跟着代码移动：从装饰读回行号 */
function syncFromDecos(m: Model): void {
  const ids = decos.get(m)
  if (!ids || m.isDisposed()) return
  const lines = [...new Set(ids.map((id) => m.getDecorationRange(id)?.startLineNumber).filter((x): x is number => !!x))].sort((a, b) => a - b)
  const p = modelPath(m)
  const key = pathKey(p)
  const old = bps.get(key)?.lines ?? []
  if (old.join(',') === lines.join(',')) return
  if (lines.length) bps.set(key, { path: p, lines })
  else bps.delete(key)
  saveBps()
  renderBpList()
}

function modelFor(path: string): Model | null {
  return monaco.editor.getModel(monaco.Uri.file(path))
}

export function toggleBreakpoint(m: Model, line: number): void {
  if (!debuggable(m)) return
  syncFromDecos(m)
  const p = modelPath(m)
  const key = pathKey(p)
  const cur = bps.get(key)?.lines ?? []
  const lines = cur.includes(line) ? cur.filter((l) => l !== line) : [...cur, line].sort((a, b) => a - b)
  if (lines.length) bps.set(key, { path: p, lines })
  else bps.delete(key)
  unverified.get(key)?.delete(line)
  saveBps()
  renderDecos(m)
  renderBpList()
  void session?.sendBreakpoints(p)
}

function removeBreakpoint(path: string, line: number): void {
  const m = modelFor(path)
  if (m) return toggleBreakpoint(m, line)
  const key = pathKey(path)
  const b = bps.get(key)
  if (!b) return
  b.lines = b.lines.filter((l) => l !== line)
  if (!b.lines.length) bps.delete(key)
  saveBps()
  renderBpList()
  void session?.sendBreakpoints(path)
}

function clearBreakpoints(): void {
  const paths = [...bps.values()].map((b) => b.path)
  bps.clear()
  unverified.clear()
  saveBps()
  for (const m of decos.keys()) renderDecos(m)
  renderBpList()
  for (const p of paths) void session?.sendBreakpoints(p)
}

export function toggleBreakpointAtCursor(editor: monaco.editor.ICodeEditor | undefined): void {
  const m = editor?.getModel()
  const pos = editor?.getPosition()
  if (!m || !pos) return
  if (!debuggable(m)) return toast(t('这种文件不支持断点'))
  toggleBreakpoint(m, pos.lineNumber)
}

/* ---------------- 调试控制台 ---------------- */

const consoleOut = h('div', { class: 'dbg-out', role: 'log', 'aria-live': 'polite' })
const consoleInput = h('input', {
  class: 'dbg-input',
  type: 'text',
  spellcheck: 'false',
  placeholder: t('程序暂停时输入表达式求值'),
  'aria-label': t('调试控制台输入'),
  onKeydown: (e: KeyboardEvent) => void onConsoleKey(e)
})
const consoleEl = h('div', { class: 'dbg-console' }, consoleOut, h('div', { class: 'dbg-input-row' }, h('span', { class: 'dbg-prompt' }, '›'), consoleInput))
const history: string[] = []
let historyAt = -1

function log(text: string, kind: 'stdout' | 'stderr' | 'info' | 'input' | 'result' = 'stdout'): void {
  if (!text) return
  const atBottom = consoleOut.scrollHeight - consoleOut.scrollTop - consoleOut.clientHeight < 24
  const last = consoleOut.lastElementChild as HTMLElement | null
  // 一行一个元素；上一行还没换行时，同类输出接在它后面（程序输出常常一行分几次到达）
  const parts = text.replace(/\r\n/g, '\n').split('\n')
  const ended = parts[parts.length - 1] === ''
  if (ended) parts.pop()
  parts.forEach((part, i) => {
    if (i === 0 && last && last.dataset.kind === kind && last.dataset.open === '1') last.textContent += part
    else consoleOut.append(h('div', { class: 'dbg-line ' + kind, 'data-kind': kind }, part || ' '))
  })
  const tail = consoleOut.lastElementChild as HTMLElement | null
  if (tail) tail.dataset.open = ended ? '0' : '1'
  while (consoleOut.childElementCount > 2000) consoleOut.firstElementChild!.remove()
  if (atBottom) consoleOut.scrollTop = consoleOut.scrollHeight
}

function showConsole(): void {
  openPanelView('debug-console', t('调试控制台'), consoleEl, () => consoleInput.focus())
}

async function onConsoleKey(e: KeyboardEvent): Promise<void> {
  if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
    if (!history.length) return
    e.preventDefault()
    historyAt = Math.max(0, Math.min(history.length, historyAt + (e.key === 'ArrowUp' ? -1 : 1)))
    consoleInput.value = history[historyAt] ?? ''
    return
  }
  if (e.key !== 'Enter') return
  const expr = consoleInput.value.trim()
  if (!expr) return
  consoleInput.value = ''
  history.push(expr)
  historyAt = history.length
  log(expr + '\n', 'input')
  if (!session || session.status !== 'stopped') return log(t('程序暂停时才能求值') + '\n', 'info')
  try {
    const r = await session.request('evaluate', { expression: expr, frameId: session.frameId(), context: 'repl' })
    log((r?.result ?? '') + '\n', 'result')
  } catch (err) {
    log(String((err as Error).message) + '\n', 'stderr')
  }
}

/* ---------------- DAP 会话 ---------------- */

type Status = 'starting' | 'running' | 'stopped' | 'ended'

interface Frame {
  id: number
  name: string
  line: number
  column: number
  source?: { path?: string; name?: string }
}

interface VarNode {
  name: string
  value: string
  type?: string
  ref: number
  /** 展开状态的键（按名字路径），换帧 / 单步后保持展开 */
  key: string
  children?: VarNode[]
}

class Session {
  status: Status = 'starting'
  threadId = 1
  frames: Frame[] = []
  frameIndex = 0
  scopes: VarNode[] = []
  stopReason = ''
  private seq = 1
  private pending = new Map<number, { resolve: (v: Json) => void; reject: (e: Error) => void }>()
  private waiters = new Map<string, (() => void)[]>()
  private caps: Json = {}

  constructor(
    readonly id: number,
    readonly def: PluginDef,
    readonly file: string,
    private readonly adapterId: string,
    private readonly launchArgs: Record<string, unknown>
  ) {}

  request(command: string, args?: unknown): Promise<Json> {
    const seq = this.seq++
    return new Promise((resolve, reject) => {
      this.pending.set(seq, { resolve, reject })
      window.api.debug.send(this.id, { seq, type: 'request', command, arguments: args })
    })
  }

  private waitEvent(name: string): Promise<void> {
    return new Promise((r) => this.waiters.set(name, [...(this.waiters.get(name) ?? []), r]))
  }

  async start(): Promise<void> {
    this.caps =
      (await this.request('initialize', {
        clientID: 'infinite-studio',
        clientName: 'Infinite Studio',
        adapterID: this.adapterId,
        pathFormat: 'path',
        linesStartAt1: true,
        columnsStartAt1: true,
        supportsVariableType: true,
        supportsRunInTerminalRequest: true,
        locale: getLocale() === 'zh' ? 'zh-cn' : 'en-us'
      })) ?? {}
    const initialized = this.waitEvent('initialized')
    // debugpy 在 configurationDone 之后才回复 launch，所以这里不等它
    const launched = this.request('launch', this.launchArgs)
    let failed: Error | null = null
    launched.catch((e: Error) => (failed = e))
    await Promise.race([initialized, launched.then(() => initialized, () => undefined)])
    if (failed) throw failed
    for (const b of bps.values()) await this.sendBreakpoints(b.path)
    await this.request('setExceptionBreakpoints', { filters: this.def.id === 'python' ? ['uncaught'] : [] }).catch(() => {})
    if (this.caps.supportsConfigurationDoneRequest !== false) await this.request('configurationDone').catch(() => {})
    await launched
    if (this.status === 'starting') this.setStatus('running')
  }

  /** 只发给这个会话负责的语言的文件 */
  async sendBreakpoints(path: string): Promise<void> {
    if (this.status === 'ended') return
    const m = modelFor(path)
    const lang = m?.getLanguageId() ?? langOfPath(path)
    if (!lang || !this.def.languages?.includes(lang)) return
    const key = pathKey(path)
    const lines = bps.get(key)?.lines ?? []
    try {
      const r = await this.request('setBreakpoints', { source: { path, name: basename(path) }, breakpoints: lines.map((line) => ({ line })), lines })
      const bad = new Set<number>()
      ;(r?.breakpoints ?? []).forEach((b: Json, i: number) => {
        if (b && b.verified === false) bad.add(lines[i])
      })
      unverified.set(key, bad)
    } catch {
      unverified.set(key, new Set(lines))
    }
    if (m) renderDecos(m)
  }

  frameId(): number | undefined {
    return this.frames[this.frameIndex]?.id
  }

  setStatus(s: Status): void {
    this.status = s
    emit('debug')
    renderDebugView()
  }

  handle(msg: Json): void {
    if (msg.type === 'response') {
      const p = this.pending.get(msg.request_seq)
      if (!p) return
      this.pending.delete(msg.request_seq)
      if (msg.success) p.resolve(msg.body)
      else p.reject(new Error(msg.body?.error?.format ?? msg.message ?? t('调试器返回错误')))
    } else if (msg.type === 'event') {
      const ws = this.waiters.get(msg.event)
      if (ws) {
        this.waiters.delete(msg.event)
        ws.forEach((w) => w())
      }
      void this.onEvent(msg.event, msg.body ?? {})
    } else if (msg.type === 'request') void this.onReverse(msg)
  }

  private async onEvent(event: string, body: Json): Promise<void> {
    switch (event) {
      case 'output':
        if (body.category === 'telemetry') return
        log(body.output ?? '', body.category === 'stderr' ? 'stderr' : body.category === 'console' || body.category === 'important' ? 'info' : 'stdout')
        return
      case 'stopped':
        if (body.threadId) this.threadId = body.threadId
        this.stopReason = body.reason ?? ''
        if (body.reason === 'exception') log(t('异常：{0}', body.text ?? body.description ?? '') + '\n', 'stderr')
        await this.loadStack()
        this.setStatus('stopped')
        return
      case 'continued':
        this.markRunning()
        return
      case 'exited':
        log(t('程序已退出，退出代码 {0}', body.exitCode ?? '?') + '\n', 'info')
        return
      case 'terminated':
        endSession(this)
        return
    }
  }

  /** 适配器反过来请求我们做事：目前只有“在终端里启动程序”（debugpy） */
  private async onReverse(msg: Json): Promise<void> {
    const reply = (success: boolean, body: Json = {}, message?: string) =>
      window.api.debug.send(this.id, { seq: this.seq++, type: 'response', request_seq: msg.seq, command: msg.command, success, body, message })
    if (msg.command !== 'runInTerminal') return reply(false, {}, 'unsupported')
    const a = msg.arguments ?? {}
    const args: string[] = a.args ?? []
    if (!args.length) return reply(false, {}, 'no command')
    const env: Record<string, string> = {}
    for (const [k, v] of Object.entries(a.env ?? {})) if (typeof v === 'string') env[k] = v
    const cmd = withEnv(sh, env, invoke(sh, args[0], args.slice(1)))
    const term = await programTerminal(a.cwd || undefined, t('调试：{0}', basename(this.file)), cmd)
    if (!term) return reply(false, {}, t('无法启动终端'))
    reply(true, {})
  }

  private markRunning(): void {
    this.frames = []
    this.scopes = []
    clearCurrentLine()
    this.setStatus('running')
  }

  async loadStack(): Promise<void> {
    try {
      const r = await this.request('stackTrace', { threadId: this.threadId, startFrame: 0, levels: 50 })
      this.frames = (r?.stackFrames ?? []) as Frame[]
    } catch {
      this.frames = []
    }
    const i = this.frames.findIndex((f) => f.source?.path && f.line > 0)
    await this.selectFrame(i < 0 ? 0 : i)
  }

  async selectFrame(i: number): Promise<void> {
    this.frameIndex = i
    const f = this.frames[i]
    if (f?.source?.path && f.line > 0) {
      await openFile(fixPath(f.source.path), { line: f.line, col: 1 })
      showCurrentLine(fixPath(f.source.path), f.line, i === 0)
    } else clearCurrentLine()
    await this.loadScopes()
    renderDebugView()
  }

  private async loadScopes(): Promise<void> {
    const f = this.frames[this.frameIndex]
    if (!f) {
      this.scopes = []
      return
    }
    try {
      const r = await this.request('scopes', { frameId: f.id })
      this.scopes = ((r?.scopes ?? []) as Json[]).map((s) => ({ name: s.name, value: '', ref: s.variablesReference, key: s.name }))
      // 第一个作用域（局部变量）默认展开；其余按之前的展开状态
      if (this.scopes[0] && !collapsedScopes.has(this.scopes[0].key)) expanded.add(this.scopes[0].key)
      for (const s of this.scopes) if (expanded.has(s.key)) await this.loadChildren(s)
    } catch {
      this.scopes = []
    }
  }

  async loadChildren(n: VarNode): Promise<void> {
    if (!n.ref) return
    try {
      const r = await this.request('variables', { variablesReference: n.ref })
      n.children = ((r?.variables ?? []) as Json[]).map((v) => ({ name: v.name, value: v.value ?? '', type: v.type, ref: v.variablesReference ?? 0, key: n.key + '/' + v.name }))
      for (const c of n.children) if (c.ref && expanded.has(c.key)) await this.loadChildren(c)
    } catch (e) {
      n.children = [{ name: '', value: String((e as Error).message), ref: 0, key: n.key + '/!' }]
    }
  }

  /** 继续 / 单步：发出去就算运行中，停下时会收到 stopped */
  async exec(command: 'continue' | 'next' | 'stepIn' | 'stepOut' | 'pause'): Promise<void> {
    if (command === 'pause') {
      if (this.status !== 'running') return
      await this.request('pause', { threadId: this.threadId }).catch((e: Error) => toast(e.message))
      return
    }
    if (this.status !== 'stopped') return
    this.markRunning()
    await this.request(command, { threadId: this.threadId }).catch((e: Error) => {
      log(e.message + '\n', 'stderr')
    })
  }

  async stop(): Promise<void> {
    if (this.status === 'ended') return
    const done = this.request(this.caps.supportsTerminateRequest && this.def.id === 'python' ? 'terminate' : 'disconnect', { terminateDebuggee: true, restart: false })
    await Promise.race([done.catch(() => {}), new Promise((r) => setTimeout(r, 1500))])
    endSession(this)
  }

  ended(): void {
    for (const p of this.pending.values()) p.reject(new Error(t('调试已结束')))
    this.pending.clear()
  }
}

let session: Session | null = null
const expanded = new Set<string>()
/** 用户手动收起的作用域（默认展开的局部变量也会被记住） */
const collapsedScopes = new Set<string>()

function endSession(s: Session): void {
  if (s.status === 'ended') return
  s.status = 'ended'
  s.ended()
  window.api.debug.stop(s.id)
  if (session === s) session = null
  clearCurrentLine()
  log(t('调试已结束') + '\n', 'info')
  emit('debug')
  renderDebugView()
}

function langOfPath(p: string): string | null {
  const ext = p.toLowerCase().split('.').pop() ?? ''
  if (ext === 'py') return 'python'
  if (ext === 'java') return 'java'
  if (ext === 'c' || ext === 'h') return 'c'
  if (['cpp', 'cc', 'cxx', 'hpp', 'hh', 'hxx'].includes(ext)) return 'cpp'
  if (ext === 'cs') return 'csharp'
  return null
}

/* ---------------- 当前行 ---------------- */

let lineDecos: { model: Model; ids: string[] } | null = null

function showCurrentLine(path: string, line: number, top: boolean): void {
  clearCurrentLine()
  const m = modelFor(path)
  if (!m) return
  const ids = m.deltaDecorations(
    [],
    [
      {
        range: new monaco.Range(line, 1, line, 1),
        options: { isWholeLine: true, className: top ? 'dbg-cur-line' : 'dbg-frame-line', glyphMarginClassName: top ? 'dbg-arrow' : 'dbg-arrow frame', stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges }
      }
    ]
  )
  lineDecos = { model: m, ids }
}

function clearCurrentLine(): void {
  if (lineDecos && !lineDecos.model.isDisposed()) lineDecos.model.deltaDecorations(lineDecos.ids, [])
  lineDecos = null
}

/* ---------------- 运行 / 调试入口 ---------------- */

let runTerm: TermHandle | null = null

/** 运行程序用的终端：复用上一次的（先 Ctrl C 结束还在跑的程序） */
async function programTerminal(cwd: string | undefined, title: string, cmd: string): Promise<TermHandle | null> {
  if (runTerm?.alive()) {
    runTerm.focus()
    runTerm.write('\x03')
    await new Promise((r) => setTimeout(r, 120))
    const cd = cwd ? (sh === 'pwsh' ? `Set-Location -LiteralPath ${quote(sh, cwd)}; ` : `cd ${quote(sh, cwd)} && `) : ''
    runTerm.write(cd + cmd + '\r')
    return runTerm
  }
  runTerm = await newTerminal(cwd, { title, run: cmd })
  return runTerm
}

/** 当前文件对应的、已经装好的语言插件；没装好时提示并打开插件页 */
async function readyPlugin(): Promise<{ def: PluginDef; file: string } | null> {
  const tab = activeTab()
  if (!tab) {
    toast(t('没有打开的文件'))
    return null
  }
  const def = languagePlugin(tab.model.getLanguageId())
  if (!def) {
    toast(t('暂不支持运行这种文件'))
    return null
  }
  await pluginsSettled()
  if (!languageReady(def)) {
    const s = pluginStatus(def.id)
    toast(s && !s.installed ? t('{0} 插件还没装好，正在打开插件页', def.name) : t('{0} 插件已停用', def.name))
    showPlugins?.()
    return null
  }
  await saveAll()
  return { def, file: tab.path }
}

let showPlugins: (() => void) | null = null
let showDebugSide: (() => void) | null = null

/** Ctrl F5：在终端里运行当前文件 */
export async function runActiveFile(): Promise<void> {
  const r = await readyPlugin()
  if (!r) return
  const plan = await window.api.plugins.runPlan(r.def.id, r.file)
  if ('error' in plan) return toast(plan.error)
  await programTerminal(plan.cwd, t('运行'), plan.command)
}

/** F5：没有调试会话时开始调试当前文件；暂停时继续 */
export async function debugOrContinue(): Promise<void> {
  if (session?.status === 'stopped') return session.exec('continue')
  if (session && session.status !== 'ended') return
  const r = await readyPlugin()
  if (!r) return
  await startDebug(r.def, r.file)
}

let lastLaunch: { def: PluginDef; file: string } | null = null

async function startDebug(def: PluginDef, file: string): Promise<void> {
  if (session) await session.stop()
  lastLaunch = { def, file }
  consoleOut.replaceChildren()
  showConsole()
  showDebugSide?.()
  log(t('正在启动调试：{0}', state.root ? relative(state.root, file) : basename(file)) + '\n', 'info')
  starting = true
  emit('debug')
  renderDebugView()
  let r
  try {
    r = await window.api.debug.start(def.id, file)
  } finally {
    starting = false
  }
  if (!r.ok) {
    log(r.error + '\n', 'stderr')
    if (r.output) log(r.output.endsWith('\n') ? r.output : r.output + '\n', 'stderr')
    toast(r.error)
    emit('debug')
    renderDebugView()
    return
  }
  const s = new Session(r.id, def, file, r.adapterId, r.launch)
  session = s
  emit('debug')
  renderDebugView()
  try {
    await s.start()
  } catch (e) {
    log(t('启动调试失败：{0}', (e as Error).message) + '\n', 'stderr')
    if (session === s) await s.stop()
  }
}

let starting = false

export async function stopDebug(): Promise<void> {
  await session?.stop()
}

export async function restartDebug(): Promise<void> {
  const l = session ? { def: session.def, file: session.file } : lastLaunch
  if (!l) return
  await session?.stop()
  await startDebug(l.def, l.file)
}

export function debugStep(cmd: 'next' | 'stepIn' | 'stepOut' | 'pause'): boolean {
  if (!session || session.status === 'ended') return false
  void session.exec(cmd)
  return true
}

export function debugActive(): boolean {
  return !!session && session.status !== 'ended'
}

/** 状态栏 */
export function debugStatus(): { label: string; state: Status | 'starting' } | null {
  if (starting) return { label: t('正在准备调试…'), state: 'starting' }
  if (!session) return null
  const name = basename(session.file)
  if (session.status === 'stopped') return { label: t('已暂停 · {0}', name), state: 'stopped' }
  if (session.status === 'starting') return { label: t('正在启动 · {0}', name), state: 'starting' }
  return { label: t('调试中 · {0}', name), state: 'running' }
}

/* ---------------- 编辑器标题栏上的运行按钮 ---------------- */

export const runButtons = h('div', { class: 'run-btns', hidden: true })

function renderRunButtons(): void {
  const tab = activeTab()
  const def = tab ? languagePlugin(tab.model.getLanguageId()) : undefined
  runButtons.hidden = !def
  if (!def) return
  runButtons.replaceChildren(
    h('button', { class: 'icon-btn small run-btn', 'aria-label': t('运行 (Ctrl F5)'), title: t('运行 {0} · Ctrl F5', basename(tab!.path)), html: icons.play, onClick: () => void runActiveFile() }),
    h('button', { class: 'icon-btn small', 'aria-label': t('调试 (F5)'), title: t('调试 · F5'), html: icons.debugStart, onClick: () => void debugOrContinue() })
  )
}

/* ---------------- 侧栏视图 ---------------- */

let viewEl: HTMLElement
let toolbarEl: HTMLElement
let varsEl: HTMLElement
let stackEl: HTMLElement
let bpListEl: HTMLElement
let stackCount: HTMLElement
let bpCount: HTMLElement

function section(title: string, body: HTMLElement, count?: HTMLElement, actions: HTMLElement[] = []): HTMLElement {
  const el = h(
    'div',
    { class: 'dbg-sec' },
    h(
      'div',
      {
        class: 'dbg-sec-head',
        role: 'button',
        tabindex: '0',
        onClick: (e: MouseEvent) => {
          if ((e.target as HTMLElement).closest('.icon-btn')) return
          el.classList.toggle('collapsed')
        }
      },
      h('span', { class: 'chev', html: icons.chevron }),
      h('span', { class: 'dbg-sec-title' }, title),
      h('span', { class: 'grow' }),
      ...actions,
      count ?? null
    ),
    body
  )
  return el
}

export function createDebugView(onPlugins: () => void, onShow: () => void): HTMLElement {
  showPlugins = onPlugins
  showDebugSide = onShow
  toolbarEl = h('div', { class: 'dbg-toolbar' })
  varsEl = h('div', { class: 'dbg-sec-body dbg-vars' })
  stackEl = h('div', { class: 'dbg-sec-body' })
  bpListEl = h('div', { class: 'dbg-sec-body' })
  stackCount = h('span', { class: 'scm-count' })
  bpCount = h('span', { class: 'scm-count' })
  viewEl = h(
    'div',
    { class: 'side-view', 'data-view': 'debug' },
    h('div', { class: 'side-head' }, h('span', { class: 'side-title' }, t('运行和调试'))),
    toolbarEl,
    h(
      'div',
      { class: 'dbg-secs' },
      section(t('变量'), varsEl),
      section(t('调用堆栈'), stackEl, stackCount),
      section(t('断点'), bpListEl, bpCount, [
        h('button', { class: 'icon-btn small', 'aria-label': t('删除所有断点'), title: t('删除所有断点'), html: icons.trash, onClick: () => clearBreakpoints() })
      ])
    )
  )
  renderDebugView()
  return viewEl
}

function toolBtn(label: string, icon: string, run: () => void, disabled = false, cls = ''): HTMLElement {
  return h('button', { class: 'icon-btn small ' + cls, 'aria-label': label, title: label, html: icon, disabled, onClick: run })
}

function renderToolbar(): void {
  if (!toolbarEl) return
  if (!session) {
    const tab = activeTab()
    const def = tab ? languagePlugin(tab.model.getLanguageId()) : undefined
    const st = def ? pluginStatus(def.id) : null
    const children: HTMLElement[] = []
    if (starting) children.push(h('div', { class: 'dbg-hint muted' }, t('正在准备调试…')))
    else if (def && st && !st.installed) {
      children.push(h('div', { class: 'dbg-hint muted' }, t('运行和调试 {0} 需要先安装 {0} 插件', def.name)))
      children.push(h('button', { class: 'btn small primary', onClick: () => void install(def).then(() => refreshPlugins()) }, t('安装 {0} 插件', def.name)))
    } else {
      children.push(
        h('button', { class: 'btn small primary', disabled: !def, onClick: () => void debugOrContinue() }, h('span', { class: 'ic', html: icons.debugStart }), t('开始调试')),
        h('button', { class: 'btn small', disabled: !def, onClick: () => void runActiveFile() }, h('span', { class: 'ic', html: icons.play }), t('运行'))
      )
      children.push(h('div', { class: 'dbg-hint muted' }, def ? t('F5 调试 · Ctrl F5 运行 · F9 切换断点') : t('打开 Python、Java、C/C++ 或 C# 文件后可以运行和调试')))
    }
    toolbarEl.replaceChildren(h('div', { class: 'dbg-start' }, ...children))
    return
  }
  const s = session
  const stopped = s.status === 'stopped'
  toolbarEl.replaceChildren(
    h(
      'div',
      { class: 'dbg-ctrls' },
      stopped ? toolBtn(t('继续 (F5)'), icons.dbgContinue, () => void s.exec('continue')) : toolBtn(t('暂停 (F6)'), icons.dbgPause, () => void s.exec('pause'), s.status !== 'running' || s.def.id === 'java'),
      toolBtn(t('单步跳过 (F10)'), icons.dbgStepOver, () => void s.exec('next'), !stopped),
      toolBtn(t('单步进入 (F11)'), icons.dbgStepInto, () => void s.exec('stepIn'), !stopped),
      toolBtn(t('单步跳出 (Shift F11)'), icons.dbgStepOut, () => void s.exec('stepOut'), !stopped),
      toolBtn(t('重新启动 (Ctrl Shift F5)'), icons.dbgRestart, () => void restartDebug()),
      toolBtn(t('停止 (Shift F5)'), icons.dbgStop, () => void stopDebug(), false, 'danger'),
      h('span', { class: 'dbg-state ' + s.status }, s.status === 'stopped' ? t('已暂停') : s.status === 'running' ? t('运行中') : t('启动中'))
    )
  )
}

function varRow(n: VarNode, depth: number): HTMLElement[] {
  const open = expanded.has(n.key)
  const isScope = depth === 0
  const row = h(
    'div',
    {
      class: 'dbg-var' + (isScope ? ' scope' : '') + (n.ref ? ' expandable' : '') + (open ? ' open' : ''),
      style: { paddingLeft: `${8 + depth * 12}px` },
      title: n.type ? `${n.name}: ${n.type}` : n.name,
      onClick: () => void toggleVar(n, isScope)
    },
    h('span', { class: 'chev', html: n.ref ? icons.chevron : '' }),
    isScope ? h('span', { class: 'dbg-var-name' }, n.name) : h('span', { class: 'dbg-var-name' }, n.name),
    isScope ? null : h('span', { class: 'dbg-var-eq' }, ' = '),
    isScope ? null : h('span', { class: 'dbg-var-val', title: n.value }, n.value)
  )
  const out: HTMLElement[] = [row]
  if (open && n.children) for (const c of n.children) out.push(...varRow(c, depth + 1))
  return out
}

async function toggleVar(n: VarNode, isScope: boolean): Promise<void> {
  if (!n.ref || !session) return
  if (expanded.has(n.key)) {
    expanded.delete(n.key)
    if (isScope) collapsedScopes.add(n.key)
  } else {
    expanded.add(n.key)
    collapsedScopes.delete(n.key)
    if (!n.children) await session.loadChildren(n)
  }
  renderVars()
}

function renderVars(): void {
  if (!varsEl) return
  if (!session || session.status !== 'stopped') {
    varsEl.replaceChildren(h('div', { class: 'dbg-empty muted' }, session ? t('程序运行中') : t('没有调试会话')))
    return
  }
  const rows = session.scopes.flatMap((s) => varRow(s, 0))
  varsEl.replaceChildren(...(rows.length ? rows : [h('div', { class: 'dbg-empty muted' }, t('没有变量'))]))
}

function renderStack(): void {
  if (!stackEl) return
  const s = session
  const frames = s?.status === 'stopped' ? s.frames : []
  stackCount.textContent = frames.length ? String(frames.length) : ''
  if (!frames.length) {
    stackEl.replaceChildren(h('div', { class: 'dbg-empty muted' }, s ? (s.status === 'stopped' ? t('没有调用堆栈') : t('程序运行中')) : t('没有调试会话')))
    return
  }
  stackEl.replaceChildren(
    ...frames.map((f, i) =>
      h(
        'div',
        { class: 'dbg-frame' + (i === s!.frameIndex ? ' on' : '') + (f.source?.path ? '' : ' nosrc'), onClick: () => void s!.selectFrame(i) },
        h('span', { class: 'dbg-frame-name' }, f.name),
        h('span', { class: 'dbg-frame-loc' }, f.source?.path ? `${f.source.name ?? basename(f.source.path)}:${f.line}` : t('无源码'))
      )
    )
  )
}

function renderBpList(): void {
  if (!bpListEl) return
  const all = [...bps.values()].flatMap((b) => b.lines.map((line) => ({ path: b.path, line })))
  bpCount.textContent = all.length ? String(all.length) : ''
  if (!all.length) {
    bpListEl.replaceChildren(h('div', { class: 'dbg-empty muted' }, t('在行号左侧单击或按 F9 添加断点')))
    return
  }
  bpListEl.replaceChildren(
    ...all.map((b) => {
      const bad = unverified.get(pathKey(b.path))?.has(b.line)
      return h(
        'div',
        { class: 'dbg-bp-row', title: b.path, onClick: () => void openFile(b.path, { line: b.line, col: 1 }) },
        h('span', { class: 'dbg-bp-dot' + (bad ? ' unverified' : '') }),
        h('span', { class: 'dbg-bp-name' }, basename(b.path)),
        h('span', { class: 'dbg-bp-line' }, String(b.line)),
        h('span', { class: 'grow' }),
        h('button', {
          class: 'icon-btn small',
          'aria-label': t('删除断点'),
          title: t('删除断点'),
          html: icons.close,
          onClick: (e: MouseEvent) => {
            e.stopPropagation()
            removeBreakpoint(b.path, b.line)
          }
        })
      )
    })
  )
}

function renderDebugView(): void {
  renderToolbar()
  renderVars()
  renderStack()
  renderBpList()
}

/* ---------------- 悬停求值 ---------------- */

/** 光标下的表达式：标识符，连同前面的 a.b / a->b */
function exprAt(m: Model, pos: monaco.Position): { expr: string; range: monaco.Range } | null {
  const line = m.getLineContent(pos.lineNumber)
  const re = /[A-Za-z_$][\w$]*(?:(?:\.|->)[A-Za-z_$][\w$]*)*/g
  let mm: RegExpExecArray | null
  while ((mm = re.exec(line))) {
    const start = mm.index + 1
    const end = start + mm[0].length
    if (pos.column < start || pos.column > end) continue
    // 只取到光标所在的那一段为止
    const cut = mm[0].slice(0, pos.column - start)
    const tail = /^[\w$]*/.exec(mm[0].slice(cut.length))![0]
    const expr = cut + tail
    return { expr, range: new monaco.Range(pos.lineNumber, start, pos.lineNumber, start + expr.length) }
  }
  return null
}

const KEYWORDS = new Set(['if', 'else', 'for', 'while', 'return', 'def', 'class', 'import', 'from', 'public', 'private', 'static', 'void', 'int', 'char', 'new', 'in', 'and', 'or', 'not', 'true', 'false', 'True', 'False', 'None', 'null', 'const', 'struct', 'include', 'var', 'using', 'namespace', 'string', 'bool', 'foreach', 'async', 'await'])

function registerHover(): void {
  for (const lang of ['python', 'java', 'c', 'cpp', 'csharp']) {
    monaco.languages.registerHoverProvider(lang, {
      async provideHover(m, pos) {
        const s = session
        if (!s || s.status !== 'stopped' || !s.def.languages?.includes(m.getLanguageId())) return null
        const hit = exprAt(m, pos)
        if (!hit || KEYWORDS.has(hit.expr)) return null
        try {
          const r = await s.request('evaluate', { expression: hit.expr, frameId: s.frameId(), context: 'hover' })
          if (!r?.result) return null
          return { range: hit.range, contents: [{ value: '```\n' + hit.expr + ' = ' + r.result + '\n```' }] }
        } catch {
          return null
        }
      }
    })
  }
}

/* ---------------- 初始化 ---------------- */

export function initDebug(): void {
  loadBps()
  setGlyphPredicate(debuggable)
  onEditor((ed) => {
    ed.onMouseDown((e) => {
      if (e.target.type !== monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN) return
      const m = ed.getModel()
      const line = e.target.position?.lineNumber
      if (m && line) toggleBreakpoint(m, line)
    })
  })
  const attach = (m: Model) => {
    if (!debuggable(m)) return
    renderDecos(m)
    m.onDidChangeContent(() => syncFromDecos(m))
    m.onWillDispose(() => {
      syncFromDecos(m)
      decos.delete(m)
    })
  }
  onTab('opened', (tab) => attach(tab.model))
  window.api.debug.onMessage((id, msg) => {
    if (session?.id === id) session.handle(msg)
  })
  window.api.debug.onExit((id) => {
    if (session?.id === id) endSession(session)
  })
  registerHover()
  on('tabs', () => {
    renderRunButtons()
    if (!session) renderToolbar()
  })
  renderRunButtons()
}

/** 插件状态变化后刷新（安装完成等） */
export function onPluginStateChanged(): void {
  void refreshLspServers()
  renderRunButtons()
  renderToolbar()
}

