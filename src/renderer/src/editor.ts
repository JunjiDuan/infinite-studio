import { languageFor, monaco } from './monaco'
import { basename, h, toast } from './dom'
import { icons } from './icons'
import { showMenu } from './menu'
import { emit, isFocus, state } from './store'
import { FONTS } from './theme'
import { DUR, EASE, SPRING, after, animate, fullMotion } from './motion'

/**
 * 编辑器分成若干“组”，左右排列，组之间的分隔条可以拖动。
 * 每个组有自己的标签栏和 Monaco 实例；同一个文件在多个组里打开时共用一个模型。
 * 标签可以是文件，也可以是自定义视图（比如 AI 对话）。
 */

/** 一个打开的文件（不管在几个组里显示，都只有一份） */
export interface Tab {
  path: string
  model: monaco.editor.ITextModel
  savedVersion: number
  /** 监听模型内容变化（后台标签被重命名等操作修改时，也要刷新未保存标记） */
  sub?: monaco.IDisposable
}

/** 自定义视图标签 */
export interface ViewSpec {
  /** 同一个 key 只开一个；不传则每次新开 */
  key?: string
  title: string
  /** SVG 图标（本地写死的内容） */
  icon?: string
  /** 标签上的颜色类名 */
  kind?: string
  el: HTMLElement
  /** 关闭前调用，返回 false 取消关闭 */
  onClose?: () => boolean | void
  /** 切换到这个标签时调用 */
  onShow?: () => void
  /** 对应磁盘上的文件（文档预览等）：文件被删除时关闭标签，改名时跟着改 */
  path?: string
}

/**
 * 文档预览（PDF、Office、图片等）。返回 true 表示已由预览接管，不再按文本打开；
 * force 为 true 时表示文本方式打不开（二进制），由预览给出“用默认应用打开”的页面。
 */
type Previewer = (path: string, force: boolean) => boolean
let previewer: Previewer | null = null
export function registerPreviewer(fn: Previewer): void {
  previewer = fn
}

type Item = { type: 'file'; doc: Tab; view: monaco.editor.ICodeEditorViewState | null } | { type: 'view'; spec: ViewSpec }

interface Group {
  id: number
  items: Item[]
  active: Item | null
  el: HTMLElement
  tabsEl: HTMLElement
  actionsEl: HTMLElement
  host: HTMLElement
  viewHost: HTMLElement
  dropEl: HTMLElement
  /** 空组的关闭按钮 */
  closeEl: HTMLElement
  editor: monaco.editor.IStandaloneCodeEditor
  /** flex-grow，相对宽度 */
  size: number
  /** 标签元素按 Item 复用（这样才能做进出场、重排和指示条动画） */
  tabEls: Map<Item, HTMLElement>
  /** 活动标签下方滑动的指示条 */
  ink: HTMLElement
  inkL: number
  inkW: number
  inkOn: boolean
  /** 上次渲染时的顺序和活动项：没变就只同步样式，不做测量 */
  lastOrder: Item[]
  lastActive: Item | null
  /** 正在播放关闭动画 */
  closing?: boolean
}

let tabsEmitQueued = false
function queueTabsEmit(): void {
  if (tabsEmitQueued) return
  tabsEmitQueued = true
  queueMicrotask(() => {
    tabsEmitQueued = false
    emit('tabs')
  })
}

function track(t: Tab): void {
  t.sub?.dispose()
  t.sub = t.model.onDidChangeContent(queueTabsEmit)
}

export interface OpenOptions {
  /** 默认 true；false 时只在后台打开（不切换当前标签） */
  activate?: boolean
  /** 1 起始的行列，打开后选中 [col, col+len) */
  line?: number
  col?: number
  len?: number
}

/** 所有打开的文件 */
export const tabs: Tab[] = []
const groups: Group[] = []
let activeGroup: Group
let groupsEl: HTMLElement
let nextGroupId = 1
/** 最近一次处于活动状态的文件（对话面板“引用当前文件”用） */
let lastFile: Tab | null = null
/** 最近显示文件的那个编辑器（取选中内容用） */
let lastFileEditor: monaco.editor.IStandaloneCodeEditor | null = null
const selectionListeners: (() => void)[] = []
/** 编辑器里的选中内容变化（对话面板显示“已选中 N 行”用） */
export function onSelection(fn: () => void): void {
  selectionListeners.push(fn)
}

export interface FileSelection {
  path: string
  startLine: number
  endLine: number
  text: string
}

/** 最近活动文件里的选中内容；没有选中返回 null */
export function fileSelection(): FileSelection | null {
  const doc = recentFile()
  const ed = lastFileEditor
  if (!doc || !ed || ed.getModel() !== doc.model) return null
  const sel = ed.getSelection()
  if (!sel || sel.isEmpty()) return null
  const text = doc.model.getValueInRange(sel)
  if (!text.trim()) return null
  let end = sel.endLineNumber
  if (sel.endColumn === 1 && end > sel.startLineNumber) end--
  return { path: doc.path, startLine: sel.startLineNumber, endLine: end, text }
}

/** 最近活动过的文件，新的在前 */
let recentOrder: Tab[] = []
function touchRecent(t: Tab): void {
  recentOrder = [t, ...recentOrder.filter((x) => x !== t)].slice(0, 20)
}

/** 最近活动过、仍然打开着的文件（新的在前；Codex 的“打开的标签页”上下文用） */
export function recentFiles(limit: number): Tab[] {
  return recentOrder.filter((t) => tabs.includes(t)).slice(0, limit)
}

/** 最近活动文件的光标 / 选区（选区为空时也返回，IDE 桥接推送 selection_changed 用） */
export function editorSelection(): { path: string; selection: monaco.Selection; text: string } | null {
  const doc = recentFile()
  const ed = lastFileEditor
  if (!doc || !ed || ed.getModel() !== doc.model) return null
  const selection = ed.getSelection()
  if (!selection) return null
  return { path: doc.path, selection, text: selection.isEmpty() ? '' : doc.model.getValueInRange(selection) }
}

/** 组标签栏右侧的附加按钮（例如 AI 助手图标），放在最右边的组里 */
let trailing: HTMLElement | null = null

type TabListener = (t: Tab) => void
const listeners = { opened: [] as TabListener[], closed: [] as TabListener[], saved: [] as TabListener[] }
export function onTab(kind: keyof typeof listeners, fn: TabListener): void {
  listeners[kind].push(fn)
}
const fire = (kind: keyof typeof listeners, t: Tab) => listeners[kind].forEach((fn) => fn(t))

const isWin = window.api.platform === 'win32'
/** 统一路径写法：Windows 盘符大写 */
export function normPath(p: string): string {
  return isWin ? p.replace(/^[a-z]:/, (m) => m.toUpperCase()) : p
}
/** 用作 Map / 视图 key 的路径（Windows 不区分大小写） */
export function pathKey(p: string): string {
  return isWin ? p.toLowerCase() : p
}
export function samePath(a: string, b: string): boolean {
  return isWin ? a.toLowerCase() === b.toLowerCase() : a === b
}
/** p 是否等于 dir 或位于 dir 之下 */
export function isUnder(p: string, dir: string): boolean {
  if (samePath(p, dir)) return true
  const d = dir.replace(/[\\/]+$/, '')
  const head = p.slice(0, d.length + 1)
  return samePath(head.slice(0, d.length), d) && /[\\/]/.test(head.slice(d.length))
}

export function getEditor(): monaco.editor.IStandaloneCodeEditor {
  return activeGroup?.editor
}

/** 活动组里当前显示的文件；如果显示的是对话等视图，返回 null */
export function activeTab(): Tab | null {
  const it = activeGroup?.active
  return it?.type === 'file' ? it.doc : null
}

/** 最近一次活动的文件（即使现在焦点在对话标签上） */
export function recentFile(): Tab | null {
  return lastFile && tabs.includes(lastFile) ? lastFile : null
}

export function findTab(path: string): Tab | undefined {
  return tabs.find((t) => samePath(t.path, path))
}

export function isDirty(t: Tab): boolean {
  return t.model.getAlternativeVersionId() !== t.savedVersion
}

export function anyDirty(): boolean {
  return tabs.some(isDirty)
}

/** 编辑区里是否有任何标签（文件或视图） */
export function hasItems(): boolean {
  return groups.some((g) => g.items.length > 0)
}

export function setTrailing(el: HTMLElement): void {
  trailing = el
  placeTrailing()
}

function placeTrailing(): void {
  if (!trailing) return
  const last = groups[groups.length - 1]
  if (last && trailing.parentElement !== last.actionsEl) last.actionsEl.append(trailing)
}

/* ---------------- 组 ---------------- */

const editorOptions: monaco.editor.IStandaloneEditorConstructionOptions = {
  model: null,
  automaticLayout: true,
  minimap: { enabled: false },
  fontLigatures: true,
  scrollBeyondLastLine: false,
  smoothScrolling: true,
  cursorBlinking: 'smooth',
  cursorSmoothCaretAnimation: 'on',
  bracketPairColorization: { enabled: false },
  guides: { indentation: true, bracketPairs: false },
  overviewRulerLanes: 0,
  hideCursorInOverviewRuler: true,
  overviewRulerBorder: false,
  renderLineHighlight: 'line',
  lineNumbersMinChars: 4,
  stickyScroll: { enabled: false },
  fixedOverflowWidgets: true,
  scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10, useShadows: false },
  unicodeHighlight: { ambiguousCharacters: false }
}

function createGroup(index: number, size = 1): Group {
  const tabsEl = h('div', { class: 'tabs', role: 'tablist', 'aria-label': '打开的标签' })
  const actionsEl = h('div', { class: 'group-actions' })
  const host = h('div', { class: 'editor-host', style: { visibility: 'hidden' } })
  const viewHost = h('div', { class: 'view-host', hidden: true })
  const dropEl = h('div', { class: 'drop-zone', hidden: true })
  const el = h(
    'section',
    { class: 'group' },
    h('div', { class: 'tab-row' }, tabsEl, actionsEl),
    h('div', { class: 'group-body' }, host, viewHost, dropEl)
  )
  const editor = monaco.editor.create(host, editorOptions)
  const closeEl = h('button', {
    class: 'icon-btn small',
    'aria-label': '关闭编辑器组',
    title: '关闭编辑器组',
    hidden: true,
    html: icons.close,
    onClick: () => removeGroup(g)
  })
  const ink = h('span', { class: 'tab-ink', 'aria-hidden': 'true' })
  tabsEl.append(ink)
  const g: Group = {
    id: nextGroupId++,
    items: [],
    active: null,
    el,
    tabsEl,
    actionsEl,
    host,
    viewHost,
    dropEl,
    closeEl,
    editor,
    size,
    tabEls: new Map(),
    ink,
    inkL: 0,
    inkW: 0,
    inkOn: false,
    lastOrder: [],
    lastActive: null
  }
  // 标签宽度变化（字体加载、改名、从隐藏恢复）时把指示条贴回去
  new ResizeObserver(() => placeInk(g, false)).observe(tabsEl)

  actionsEl.append(
    h('button', {
      class: 'icon-btn small',
      'aria-label': '向右拆分编辑器 (Ctrl \\)',
      title: '向右拆分 Ctrl \\',
      html: icons.split,
      onClick: () => splitRight(g)
    }),
    closeEl
  )

  editor.onDidChangeCursorPosition(() => {
    if (g === activeGroup) emit('cursor')
  })
  editor.onDidChangeCursorSelection(() => {
    if (g.active?.type !== 'file') return
    lastFileEditor = editor
    selectionListeners.forEach((fn) => fn())
  })
  editor.onDidFocusEditorText(() => focusGroup(g))
  el.addEventListener('mousedown', () => focusGroup(g), true)

  groups.splice(index, 0, g)
  layoutGroups()
  applyOptions(g)
  // 新组从 0 宽“长”出来，旁边的组被平滑挤开
  if (groups.length > 1 && groupsEl.isConnected) {
    animate(el, [{ flexGrow: 0, minWidth: '0px', opacity: 0 }, { flexGrow: size, minWidth: '160px', opacity: 1 }], { spring: 'soft' })
    const sash = el.previousElementSibling ?? el.nextElementSibling
    if (sash?.classList.contains('group-sash')) animate(sash, [{ opacity: 0 }, { opacity: 1 }], { duration: DUR.md, delay: 80 })
  }
  return g
}

function removeGroup(g: Group): void {
  const i = groups.indexOf(g)
  if (i < 0 || groups.length === 1) return
  groups.splice(i, 1)
  if (activeGroup === g) focusGroup(groups[Math.min(i, groups.length - 1)])
  groupsEl.classList.toggle('multi', groups.length > 1)
  placeTrailing()
  renderAll()
  // 收起动画：宽度缩到 0、淡出，旁边的组跟着补位，结束后再真正移除
  g.closing = true
  g.el.classList.add('closing')
  const sash = g.el.previousElementSibling?.classList.contains('group-sash') ? g.el.previousElementSibling : g.el.nextElementSibling
  const a = animate(g.el, [{ flexGrow: g.size, minWidth: '160px', opacity: 1 }, { flexGrow: 0, minWidth: '0px', opacity: 0 }], { duration: DUR.md, easing: EASE.inOut, fill: 'forwards' })
  if (sash?.classList.contains('group-sash')) animate(sash, [{ opacity: 1 }, { opacity: 0 }], { duration: DUR.sm, fill: 'forwards' })
  after(a, () => {
    g.editor.dispose()
    if (g.el.parentElement === groupsEl) layoutGroups()
  })
}

/** 按顺序排列组，组之间插入可拖动的分隔条 */
function layoutGroups(): void {
  const children: HTMLElement[] = []
  groups.forEach((g, i) => {
    if (i > 0) children.push(makeSash(groups[i - 1], g))
    g.el.style.flexGrow = String(g.size)
    children.push(g.el)
  })
  groupsEl.replaceChildren(...children)
  groupsEl.classList.toggle('multi', groups.length > 1)
  placeTrailing()
  renderAll()
}

function makeSash(a: Group, b: Group): HTMLElement {
  const sash = h('div', { class: 'group-sash', role: 'separator', 'aria-orientation': 'vertical', 'aria-label': '拖动调整编辑器宽度' })
  sash.addEventListener('mousedown', (e) => {
    e.preventDefault()
    const startX = e.clientX
    const wa = a.el.getBoundingClientRect().width
    const wb = b.el.getBoundingClientRect().width
    const total = a.size + b.size
    const min = 160
    document.body.classList.add('resizing-h')
    sash.classList.add('on')
    const move = (ev: MouseEvent) => {
      const dx = Math.max(min - wa, Math.min(wb - min, ev.clientX - startX))
      a.size = (total * (wa + dx)) / (wa + wb)
      b.size = total - a.size
      a.el.style.flexGrow = String(a.size)
      b.el.style.flexGrow = String(b.size)
    }
    const up = () => {
      document.body.classList.remove('resizing-h')
      sash.classList.remove('on')
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  })
  // 双击分隔条：两边等宽
  sash.addEventListener('dblclick', () => {
    const avg = (a.size + b.size) / 2
    a.size = b.size = avg
    a.el.style.flexGrow = b.el.style.flexGrow = String(avg)
  })
  return sash
}

function focusGroup(g: Group): void {
  if (activeGroup === g) return
  activeGroup = g
  for (const x of groups) x.el.classList.toggle('active', x === g)
  if (g.active?.type === 'file') {
    lastFile = g.active.doc
    lastFileEditor = g.editor
    touchRecent(lastFile)
  }
  updateTitle()
  emit('tabs')
  emit('cursor')
}

function updateTitle(): void {
  const it = activeGroup?.active
  const name = it ? (it.type === 'file' ? basename(it.doc.path) : it.spec.title) : null
  document.title = name ? `${name} — Infinite Studio` : 'Infinite Studio · 无界工作室'
}

/* ---------------- 初始化与选项 ---------------- */

export function initEditor(container: HTMLElement): void {
  groupsEl = h('div', { class: 'groups' })
  container.prepend(groupsEl)
  activeGroup = createGroup(0)
  activeGroup.el.classList.add('active')
  monaco.editor.onDidChangeMarkers(() => emit('markers'))

  // 跳转到定义等操作要打开别的文件时，由我们接管成“打开标签”
  monaco.editor.registerEditorOpener({
    openCodeEditor(_source, resource, sel) {
      if (resource.scheme !== 'file') return false
      const pos = sel && 'startLineNumber' in sel ? { line: sel.startLineNumber, col: sel.startColumn } : sel ? { line: sel.lineNumber, col: sel.column } : {}
      void openFile(normPath(resource.fsPath), pos)
      return true
    }
  })
  applyEditorOptions()
}

function applyOptions(g: Group): void {
  const { space, wordWrap } = state.settings
  const focus = isFocus()
  g.editor.updateOptions({
    fontFamily: FONTS[space.font].css,
    fontSize: space.size,
    lineHeight: Math.round(space.size * 1.7),
    lineNumbers: focus ? 'off' : 'on',
    folding: !focus,
    glyphMargin: false,
    padding: focus ? { top: 72, bottom: 160 } : { top: 16, bottom: 16 },
    wordWrap: focus || wordWrap ? 'on' : 'off',
    scrollbar: { vertical: focus ? 'hidden' : 'auto', verticalScrollbarSize: 10, horizontalScrollbarSize: 10, useShadows: false }
  })
  // 内边距变化后强制重绘，避免光标残影
  requestAnimationFrame(() => g.editor.render(true))
}

export function applyEditorOptions(): void {
  groups.forEach(applyOptions)
}

/* ---------------- 标签切换 ---------------- */

function show(g: Group, it: Item | null, focus = true): void {
  const prev = g.active
  if (prev?.type === 'file' && prev !== it) prev.view = g.editor.saveViewState()
  g.active = it
  if (it?.type === 'file') {
    g.viewHost.hidden = true
    g.host.style.visibility = 'visible'
    if (g.editor.getModel() !== it.doc.model) g.editor.setModel(it.doc.model)
    if (it.view) g.editor.restoreViewState(it.view)
    lastFile = it.doc
    lastFileEditor = g.editor
    touchRecent(it.doc)
    if (focus) g.editor.focus()
  } else if (it?.type === 'view') {
    g.editor.setModel(null)
    g.host.style.visibility = 'hidden'
    g.viewHost.hidden = false
    if (it.spec.el.parentElement !== g.viewHost) g.viewHost.replaceChildren(it.spec.el)
    it.spec.onShow?.()
  } else {
    g.editor.setModel(null)
    g.host.style.visibility = 'hidden'
    g.viewHost.hidden = true
    g.viewHost.replaceChildren()
  }
  if (focus) focusGroup(g)
  if (g === activeGroup) updateTitle()
  if (it && it !== prev) revealContent(g, it)
  emit('tabs')
  emit('cursor')
}

/** 切换标签时内容区的过渡：新内容从下方 6px 淡入 */
function revealContent(g: Group, it: Item): void {
  const target = it.type === 'file' ? g.host : g.viewHost
  animate(target, [{ opacity: 0, transform: 'translateY(6px) scale(0.995)' }, { opacity: 1, transform: 'none' }], { duration: DUR.md, easing: EASE.out })
}

function revealAt(o: OpenOptions): void {
  if (!o.line) return
  const editor = activeGroup.editor
  const col = o.col ?? 1
  const range = new monaco.Range(o.line, col, o.line, col + (o.len ?? 0))
  editor.setSelection(range)
  editor.revealRangeInCenterIfOutsideViewport(range, monaco.editor.ScrollType.Immediate)
  editor.focus()
}

function fileItem(g: Group, doc: Tab): Item | undefined {
  return g.items.find((x) => x.type === 'file' && x.doc === doc)
}

function insertItem(g: Group, it: Item, index?: number): void {
  const i = index ?? (g.active ? g.items.indexOf(g.active) + 1 : g.items.length)
  g.items.splice(Math.max(0, Math.min(i, g.items.length)), 0, it)
}

export async function openFile(rawPath: string, o: OpenOptions = {}): Promise<Tab | null> {
  const path = normPath(rawPath)
  const activate = o.activate !== false
  const g = activeGroup
  let doc = findTab(path)
  if (!doc && activate && previewer?.(path, false)) return null
  if (!doc) {
    const uri = monaco.Uri.file(path)
    // 模型可能已被语言服务预先创建（比如“查看定义”时），直接复用
    let model = monaco.editor.getModel(uri)
    if (!model) {
      const r = await window.api.fs.readFile(path)
      if (!r.ok) {
        if (r.reason === 'binary' && activate && previewer?.(path, true)) return null
        toast(
          r.reason === 'binary' ? '这是二进制文件，暂不支持打开' : r.reason === 'too-large' ? '文件超过 5 MB，暂不支持打开' : r.reason === 'missing' ? '文件不存在' : '无法读取文件'
        )
        return null
      }
      // 读文件期间可能已被别处打开
      if (findTab(path)) return openFile(path, o)
      model = monaco.editor.getModel(uri) ?? monaco.editor.createModel(r.content, languageFor(path), uri)
    }
    doc = { path, model, savedVersion: model.getAlternativeVersionId() }
    track(doc)
    tabs.push(doc)
    fire('opened', doc)
  }
  let it = groups.map((x) => fileItem(x, doc)).find(Boolean)
  // 后台打开（例如语言服务跨文件重命名）：任意组里有就行，没有就加到活动组但不切换
  if (!activate) {
    if (!it) g.items.push({ type: 'file', doc, view: null })
    emit('tabs')
    return doc
  }
  it = fileItem(g, doc)
  if (!it) {
    it = { type: 'file', doc, view: null }
    insertItem(g, it)
  }
  show(g, it)
  revealAt(o)
  return doc
}

/** 打开自定义视图标签。side 为 true 时放到右侧的组（没有就拆出一个） */
export function openView(spec: ViewSpec, opts: { side?: boolean } = {}): void {
  if (spec.key) {
    for (const g of groups) {
      const it = g.items.find((x) => x.type === 'view' && x.spec.key === spec.key)
      if (it) return show(g, it)
    }
  }
  let g = activeGroup
  if (opts.side) {
    const i = groups.indexOf(activeGroup)
    g = groups[i + 1] ?? createGroup(i + 1, activeGroup.items.length ? 0.7 : 1)
  }
  const it: Item = { type: 'view', spec }
  insertItem(g, it)
  show(g, it)
}

/** 找到某个视图所在的组并切换过去 */
export function revealView(el: HTMLElement): boolean {
  for (const g of groups) {
    const it = g.items.find((x) => x.type === 'view' && x.spec.el === el)
    if (it) {
      show(g, it)
      return true
    }
  }
  return false
}

/** 关闭某个视图标签（会调用它的 onClose） */
export function closeView(el: HTMLElement): void {
  for (const g of groups) {
    const it = g.items.find((x) => x.type === 'view' && x.spec.el === el)
    if (it) return closeItem(g, it)
  }
}

export function updateView(el: HTMLElement, patch: Partial<Pick<ViewSpec, 'title'>>): void {
  for (const g of groups) for (const it of g.items) if (it.type === 'view' && it.spec.el === el) Object.assign(it.spec, patch)
  emit('tabs')
}

export function activate(path: string): void {
  const doc = findTab(path)
  if (!doc) return
  const g = groups.find((x) => x.active?.type === 'file' && x.active.doc === doc) ?? activeGroup
  let it = fileItem(g, doc)
  if (!it) {
    it = { type: 'file', doc, view: null }
    insertItem(g, it)
  }
  show(g, it)
}

/* ---------------- 关闭 ---------------- */

function refs(doc: Tab): number {
  return groups.reduce((n, g) => n + g.items.filter((x) => x.type === 'file' && x.doc === doc).length, 0)
}

/** 从组里拿掉一个标签；文件不再有任何标签时释放模型 */
function detach(g: Group, it: Item, opts: { keepGroup?: boolean; focus?: boolean } = {}): void {
  const i = g.items.indexOf(it)
  if (i < 0) return
  g.items.splice(i, 1)
  if (g.active === it) {
    if (it.type === 'file') it.view = g.editor.saveViewState()
    show(g, g.items[i] ?? g.items[i - 1] ?? null, opts.focus ?? g === activeGroup)
  } else {
    emit('tabs')
  }
  if (it.type === 'file' && refs(it.doc) === 0) dropDoc(it.doc)
  if (!g.items.length && !opts.keepGroup && groups.length > 1) removeGroup(g)
}

function dropDoc(doc: Tab): void {
  const i = tabs.indexOf(doc)
  if (i < 0) return
  tabs.splice(i, 1)
  doc.sub?.dispose()
  fire('closed', doc)
  if (lastFile === doc) lastFile = null
  doc.model.dispose()
}

function closeItem(g: Group, it: Item): void {
  if (it.type === 'file' && refs(it.doc) === 1 && isDirty(it.doc) && !confirm(`“${basename(it.doc.path)}” 有未保存的修改，仍然关闭吗？`)) return
  if (it.type === 'view' && it.spec.onClose?.() === false) return
  detach(g, it)
}

/** 不传 path：关闭活动组的当前标签；传 path：在所有组里关闭这个文件 */
export function closeTab(path?: string): void {
  if (!path) {
    const it = activeGroup.active
    if (it) closeItem(activeGroup, it)
    else if (groups.length > 1) removeGroup(activeGroup)
    return
  }
  const doc = findTab(path)
  if (!doc) return
  if (isDirty(doc) && !confirm(`“${basename(doc.path)}” 有未保存的修改，仍然关闭吗？`)) return
  closeDoc(doc)
}

function closeDoc(doc: Tab): void {
  for (const g of [...groups]) {
    const it = fileItem(g, doc)
    if (it) detach(g, it)
  }
  dropDoc(doc)
}

/** 关闭某个路径（或其下所有文件）的标签，不再询问 */
export function closeUnder(path: string): void {
  for (const t of tabs.filter((x) => isUnder(x.path, path))) closeDoc(t)
  for (const g of [...groups]) for (const it of [...g.items]) if (it.type === 'view' && it.spec.path && isUnder(it.spec.path, path)) closeItem(g, it)
}

/** 关闭所有文件标签（对话等视图保留） */
export function closeAll(): boolean {
  if (anyDirty() && !confirm('有未保存的修改，仍然关闭全部文件吗？')) return false
  for (const t of [...tabs]) closeDoc(t)
  return true
}

function closeOthers(g: Group, keep: Item): void {
  for (const it of g.items.filter((x) => x !== keep)) closeItem(g, it)
}

export function cycleTab(dir: 1 | -1): void {
  const g = activeGroup
  if (g.items.length < 2 || !g.active) return
  const i = (g.items.indexOf(g.active) + dir + g.items.length) % g.items.length
  show(g, g.items[i])
}

/** 在相邻的组之间切换焦点 */
export function focusNextGroup(dir: 1 | -1): void {
  const i = groups.indexOf(activeGroup) + dir
  const g = groups[i]
  if (!g) return
  focusGroup(g)
  if (g.active?.type === 'file') g.editor.focus()
}

/* ---------------- 拆分与拖放 ---------------- */

/** 把当前标签复制到右侧新组（视图标签则移动过去） */
export function splitRight(g: Group = activeGroup): void {
  const it = g.active
  // 空组没东西可拆，不再凭空生成新的空组
  if (!it) return
  const i = groups.indexOf(g)
  const ng = createGroup(i + 1, g.size)
  if (it?.type === 'file') {
    const copy: Item = { type: 'file', doc: it.doc, view: g.editor.saveViewState() }
    ng.items.push(copy)
    show(ng, copy)
  } else if (it?.type === 'view') {
    detach(g, it, { keepGroup: true, focus: false })
    ng.items.push(it)
    show(ng, it)
  } else {
    focusGroup(ng)
  }
}

function moveItem(from: Group, it: Item, to: Group, index?: number): void {
  if (from === to) {
    const i = from.items.indexOf(it)
    from.items.splice(i, 1)
    const j = index === undefined ? from.items.length : index > i ? index - 1 : index
    from.items.splice(j, 0, it)
    show(to, it)
    return
  }
  // 目标组里已经有这个文件：直接切过去
  if (it.type === 'file') {
    const existing = fileItem(to, it.doc)
    if (existing) {
      if (refs(it.doc) > 1) detach(from, it)
      else {
        from.items.splice(from.items.indexOf(it), 1)
        if (from.active === it) show(from, from.items[0] ?? null, false)
        if (!from.items.length && groups.length > 1) removeGroup(from)
      }
      show(to, existing)
      return
    }
    it.view = from.active === it ? from.editor.saveViewState() : it.view
  }
  const i = from.items.indexOf(it)
  from.items.splice(i, 1)
  if (from.active === it) show(from, from.items[i] ?? from.items[i - 1] ?? null, false)
  insertItem(to, it, index ?? to.items.length)
  show(to, it)
  if (!from.items.length && groups.length > 1) removeGroup(from)
}

/** 键盘移动当前标签（Ctrl Shift PageUp / PageDown），带重排动画 */
export function moveActiveTab(dir: 1 | -1): void {
  const g = activeGroup
  const it = g.active
  if (!it || g.items.length < 2) return
  const i = g.items.indexOf(it)
  const j = i + dir
  if (j < 0 || j >= g.items.length) return
  g.items.splice(i, 1)
  g.items.splice(j, 0, it)
  emit('tabs')
}

/* ---------------- 标签拖动：同组换位 / 跨组移动 / 拖到边缘拆分 ---------------- */

/**
 * 不用 HTML5 拖放（浏览器生成的半透明截图没法做动画），改为指针事件自己实现：
 * 1. 按下后移动超过 5px 才开始拖动；被拖的标签“浮起”成一个跟随指针的幽灵标签，原位置留空
 * 2. 在标签栏里：幽灵锁定在标签栏这一行，其余标签实时让位（transform 平移，弹簧过渡）
 * 3. 拖出标签栏：幽灵变成可自由移动的卡片，原位置的空隙合拢；
 *    经过其他组的标签栏时在插入点撑开空隙，经过编辑区时显示左 / 中 / 右三种落点
 * 4. 松手：幽灵飞到最终位置后消失；拆分时被“吸入”落点区域；Esc 或拖到无效位置则飞回原处
 */

type DropTarget =
  | { kind: 'tabs'; g: Group; index: number }
  | { kind: 'body'; g: Group; zone: 'left' | 'right' | 'center' }
  | { kind: 'chat'; el: HTMLElement }
  | null

interface Slot {
  el: HTMLElement
  left: number
  width: number
}

interface TabDrag {
  from: Group
  item: Item
  src: HTMLElement
  srcIdx: number
  ghost: HTMLElement
  card: HTMLElement
  w: number
  h: number
  grabX: number
  grabY: number
  px: number
  py: number
  gx: number
  gy: number
  vx: number
  tilt: number
  target: DropTarget
  /** 各组标签的原始位置（内容坐标；拖动期间只用 transform 平移，不改布局） */
  slots: Map<Group, Slot[]>
  raf: number
  last: number
  chatEl: HTMLElement | null
}

let tabDrag: TabDrag | null = null
/** 刚放下、正等待幽灵标签飞到位的项：渲染时先隐藏，不播进场动画 */
let landing: Item | null = null
let suppressClickUntil = 0

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v))

/** 指针按下：先“预备”，移动超过阈值才真正开始拖动 */
function armDrag(g: Group, it: Item, el: HTMLElement, e: PointerEvent): void {
  if (e.button !== 0 || tabDrag || (e.target as Element).closest('.tab-close')) return
  const sx = e.clientX
  const sy = e.clientY
  const move = (ev: PointerEvent) => {
    if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 5) return
    cleanup()
    beginDrag(g, it, el, sx, sy, ev)
  }
  const cleanup = () => {
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', cleanup)
    window.removeEventListener('pointercancel', cleanup)
  }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', cleanup)
  window.addEventListener('pointercancel', cleanup)
}

function beginDrag(g: Group, it: Item, el: HTMLElement, sx: number, sy: number, ev: PointerEvent): void {
  if (!el.isConnected) return
  if (g.active !== it) show(g, it, false)
  const r = el.getBoundingClientRect()
  const card = el.cloneNode(true) as HTMLElement
  card.classList.add('on')
  card.classList.remove('drag-src', 'leaving')
  card.removeAttribute('tabindex')
  card.style.width = r.width + 'px'
  const ghost = h('div', { class: 'tab-ghost', 'aria-hidden': 'true' }, card)
  ghost.style.transform = `translate(${r.left}px, ${r.top}px)`
  document.body.append(ghost)
  el.classList.add('drag-src')
  document.body.classList.add('dragging-tab')
  for (const x of groups) x.tabsEl.classList.add('sorting')
  // 浮起：放大一点、加阴影（CSS 过渡）
  requestAnimationFrame(() => ghost.classList.add('lifted'))

  tabDrag = {
    from: g,
    item: it,
    src: el,
    srcIdx: g.items.indexOf(it),
    ghost,
    card,
    w: r.width,
    h: r.height,
    grabX: sx - r.left,
    grabY: sy - r.top,
    px: ev.clientX,
    py: ev.clientY,
    gx: r.left,
    gy: r.top,
    vx: 0,
    tilt: 0,
    target: null,
    slots: new Map(),
    raf: 0,
    last: performance.now(),
    chatEl: null
  }
  window.addEventListener('pointermove', onDragMove)
  window.addEventListener('pointerup', onDragUp)
  window.addEventListener('pointercancel', onDragCancel)
  window.addEventListener('keydown', onDragKey, true)
  updateTarget()
  tabDrag.raf = requestAnimationFrame(tick)
}

function onDragMove(e: PointerEvent): void {
  if (!tabDrag) return
  tabDrag.px = e.clientX
  tabDrag.py = e.clientY
  updateTarget()
}

function onDragUp(): void {
  endDrag(false)
}
function onDragCancel(): void {
  endDrag(true)
}
function onDragKey(e: KeyboardEvent): void {
  if (e.key !== 'Escape') return
  e.preventDefault()
  e.stopPropagation()
  endDrag(true)
}

/** 某组标签的原始位置；源组里不含被拖的标签 */
function slotsOf(d: TabDrag, g: Group): Slot[] {
  let s = d.slots.get(g)
  if (!s) {
    s = g.items
      .map((x) => g.tabEls.get(x))
      .filter((el): el is HTMLElement => !!el && el !== d.src)
      .map((el) => ({ el, left: el.offsetLeft, width: el.offsetWidth }))
    d.slots.set(g, s)
  }
  return s
}

/** 指针在内容坐标系里的“幽灵中心” → 插入位置（在去掉被拖标签后的列表里） */
function insertIndex(d: TabDrag, g: Group): number {
  const r = g.tabsEl.getBoundingClientRect()
  const cx = d.px - d.grabX + d.w / 2 - r.left + g.tabsEl.scrollLeft
  let n = 0
  for (const s of slotsOf(d, g)) {
    // 源组里排在被拖标签后面的，合拢后的位置要左移一个标签宽
    const left = g === d.from && s.left > d.src.offsetLeft ? s.left - d.w : s.left
    if (left + s.width / 2 < cx) n++
  }
  return n
}

function hitTest(d: TabDrag): DropTarget {
  const { px: x, py: y } = d
  const live = groups.filter((g) => !g.closing)
  for (const g of live) {
    const r = (g.tabsEl.parentElement as HTMLElement).getBoundingClientRect()
    // 已经在这一行里时上下多给一点容差，避免轻微抖动就“脱出”
    const tol = d.target?.kind === 'tabs' && d.target.g === g ? 22 : 0
    if (x >= r.left && x <= r.right && y >= r.top - tol && y <= r.bottom + tol) return { kind: 'tabs', g, index: insertIndex(d, g) }
  }
  if (d.item.type === 'file') {
    for (const box of document.querySelectorAll<HTMLElement>('.chat-box')) {
      const r = box.getBoundingClientRect()
      if (r.width && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return { kind: 'chat', el: box }
    }
  }
  for (const g of live) {
    const body = g.dropEl.parentElement as HTMLElement
    const r = body.getBoundingClientRect()
    if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
      const fx = (x - r.left) / r.width
      return { kind: 'body', g, zone: fx < 0.25 ? 'left' : fx > 0.75 ? 'right' : 'center' }
    }
  }
  return null
}

function updateTarget(): void {
  const d = tabDrag
  if (!d) return
  const t = hitTest(d)
  d.target = t
  // 落点区域
  for (const g of groups) {
    const on = t?.kind === 'body' && t.g === g
    if (on) {
      g.dropEl.hidden = false
      g.dropEl.dataset.zone = t.zone
    } else g.dropEl.hidden = true
  }
  // 对话输入框：拖进去作为 @引用
  const chat = t?.kind === 'chat' ? t.el : null
  if (d.chatEl !== chat) {
    d.chatEl?.classList.remove('drop')
    chat?.classList.add('drop')
    d.chatEl = chat
  }
  d.ghost.classList.toggle('free', t?.kind !== 'tabs')
  applyShifts(d)
}

/** 根据当前落点，给各组标签设置让位的平移量 */
function applyShifts(d: TabDrag): void {
  const t = d.target
  for (const g of groups) {
    const isFrom = g === d.from
    const isTarget = t?.kind === 'tabs' && t.g === g
    if (!isFrom && !isTarget && !d.slots.has(g)) continue
    const list = slotsOf(d, g)
    const srcLeft = isFrom ? d.src.offsetLeft : 0
    // 源组：拖到别处时空隙合拢；拖到无效区域时保持原位，提示“会回到这里”
    const away = isFrom && t !== null && !(isTarget && t.kind === 'tabs')
    for (let k = 0; k < list.length; k++) {
      const s = list[k]
      let dx = 0
      const after = isFrom && s.left > srcLeft
      if (isTarget && t?.kind === 'tabs') {
        if (after) dx -= d.w
        if (k >= t.index) dx += d.w
      } else if (away && after) dx -= d.w
      const v = dx ? `translateX(${dx}px)` : ''
      if (s.el.style.transform !== v) s.el.style.transform = v
    }
  }
}

/** 幽灵标签的目标位置：在标签栏里锁定在这一行，否则自由跟随指针 */
function ghostGoal(d: TabDrag): { x: number; y: number } {
  const t = d.target
  if (t?.kind === 'tabs') {
    const r = t.g.tabsEl.getBoundingClientRect()
    return { x: clamp(d.px - d.grabX, r.left - 8, r.right - d.w + 8), y: r.top }
  }
  return { x: d.px - d.grabX, y: d.py - d.grabY }
}

function tick(now: number): void {
  const d = tabDrag
  if (!d) return
  const dt = Math.min(48, now - d.last) || 16.67
  d.last = now
  const goal = ghostGoal(d)
  const smooth = fullMotion()
  // 与帧率无关的指数平滑：带一点“拖尾”的跟手感
  const k = smooth ? 1 - Math.pow(1 - 0.42, dt / 16.67) : 1
  const nx = d.gx + (goal.x - d.gx) * k
  d.vx = ((nx - d.gx) / dt) * 16.67
  d.gx = nx
  d.gy += (goal.y - d.gy) * k
  // 横向速度带来轻微倾斜，像被拎着的卡片
  const free = d.target?.kind !== 'tabs'
  const tiltGoal = smooth ? clamp(d.vx * (free ? 0.5 : 0.25), free ? -8 : -3, free ? 8 : 3) : 0
  d.tilt += (tiltGoal - d.tilt) * (smooth ? 0.18 : 1)
  d.ghost.style.transform = `translate(${d.gx}px, ${d.gy}px) rotate(${d.tilt.toFixed(2)}deg)`

  // 贴近标签栏两端时自动滚动
  const t = d.target
  if (t?.kind === 'tabs') {
    const el = t.g.tabsEl
    const r = el.getBoundingClientRect()
    const edge = 40
    let v = 0
    if (d.px < r.left + edge) v = -Math.ceil((r.left + edge - d.px) / 4)
    else if (d.px > r.right - edge) v = Math.ceil((d.px - (r.right - edge)) / 4)
    if (v && el.scrollWidth > el.clientWidth) {
      const before = el.scrollLeft
      el.scrollLeft += v
      if (el.scrollLeft !== before) updateTarget()
    }
  }
  d.raf = requestAnimationFrame(tick)
}

/** 幽灵标签飞到某个元素的位置后消失，元素随即显示 */
function landGhost(d: TabDrag, el: HTMLElement | null): void {
  const ghost = d.ghost
  const from = ghost.style.transform
  ghost.classList.remove('free', 'lifted')
  const done = () => {
    ghost.remove()
    if (el) {
      el.classList.remove('drag-src')
      // 落定时轻轻“按下去”一下
      animate(el, [{ transform: 'translateY(-3px)' }, { transform: 'none' }], { spring: 'bouncy' })
    }
    if (landing === d.item) landing = null
  }
  if (!el || !el.isConnected) {
    after(animate(ghost, [{ transform: from, opacity: 1 }, { transform: from + ' scale(0.9)', opacity: 0 }], { duration: DUR.sm, fill: 'forwards' }), done)
    return
  }
  // 量最终落点前停掉它身上残留的位移动画，保证量到的是真实位置
  for (const an of el.getAnimations()) an.cancel()
  el.style.transform = ''
  const r = el.getBoundingClientRect()
  const to = `translate(${r.left}px, ${r.top}px) rotate(0deg)`
  ghost.style.transform = to
  after(animate(ghost, [{ transform: from }, { transform: to }], { spring: 'snappy' }), done)
}

/** 幽灵被“吸入”某个区域（拆分落点、对话输入框） */
function absorbGhost(d: TabDrag, into: HTMLElement): void {
  const ghost = d.ghost
  const from = ghost.style.transform
  const r = into.getBoundingClientRect()
  const to = `translate(${r.left + r.width / 2 - d.w / 2}px, ${r.top + r.height / 2 - d.h / 2}px) scale(0.55)`
  ghost.classList.remove('lifted')
  after(animate(ghost, [{ transform: from, opacity: 1 }, { transform: to, opacity: 0 }], { duration: DUR.md, easing: EASE.in, fill: 'forwards' }), () => ghost.remove())
}

/**
 * 让位平移回到 0。animated 为 true（取消拖动）时平滑回位；
 * 否则只关掉过渡，平移量留给接下来的重新渲染去清（它会先测量当前视觉位置再做 FLIP，画面不跳）。
 */
function resetShifts(d: TabDrag, animated: boolean): void {
  for (const g of groups) {
    if (animated) {
      for (const s of d.slots.get(g) ?? []) s.el.style.transform = ''
      setTimeout(() => !tabDrag && g.tabsEl.classList.remove('sorting'), SPRING.snappy.duration)
    } else g.tabsEl.classList.remove('sorting')
  }
}

/** 提交之后：没被重新渲染到的标签（极少见）直接清掉平移 */
function clearShifts(d: TabDrag): void {
  for (const list of d.slots.values()) for (const s of list) if (s.el.style.transform) s.el.style.transform = ''
}

function endDrag(cancel: boolean): void {
  const d = tabDrag
  if (!d) return
  tabDrag = null
  cancelAnimationFrame(d.raf)
  window.removeEventListener('pointermove', onDragMove)
  window.removeEventListener('pointerup', onDragUp)
  window.removeEventListener('pointercancel', onDragCancel)
  window.removeEventListener('keydown', onDragKey, true)
  document.body.classList.remove('dragging-tab')
  d.chatEl?.classList.remove('drop')
  suppressClickUntil = performance.now() + 80
  const zoneEl = d.target?.kind === 'body' ? d.target.g.dropEl : null
  for (const g of groups) if (g.dropEl !== zoneEl) g.dropEl.hidden = true
  if (zoneEl) {
    // 落点区域闪一下再消失
    zoneEl.classList.add('accept')
    after(animate(zoneEl, [{ opacity: 1 }, { opacity: 0 }], { duration: DUR.md, delay: 60, fill: 'forwards' }), () => {
      zoneEl.classList.remove('accept')
      zoneEl.hidden = true
    })
  }

  const { from, item } = d
  const t = cancel ? null : d.target
  const goHome = () => {
    resetShifts(d, true)
    landGhost(d, d.src)
  }
  // 源组可能已经没了（极少见）
  if (!groups.includes(from) || !from.items.includes(item)) {
    resetShifts(d, false)
    clearShifts(d)
    d.src.classList.remove('drag-src')
    d.ghost.remove()
    return
  }

  if (!t) return goHome()
  try {
    commitDrop(d, t)
  } finally {
    clearShifts(d)
  }
}

function commitDrop(d: TabDrag, t: Exclude<DropTarget, null>): void {
  const { from, item } = d
  const goHome = () => {
    resetShifts(d, true)
    landGhost(d, d.src)
  }

  if (t.kind === 'chat') {
    resetShifts(d, true)
    d.src.classList.remove('drag-src')
    absorbGhost(d, t.el)
    if (item.type === 'file') t.el.dispatchEvent(new CustomEvent('tab-drop', { detail: { path: item.doc.path } }))
    return
  }

  if (t.kind === 'tabs') {
    if (t.g === from) {
      if (t.index === d.srcIdx) return goHome()
      resetShifts(d, false)
      landing = item
      from.items.splice(d.srcIdx, 1)
      from.items.splice(t.index, 0, item)
      show(from, item)
      landGhost(d, from.tabEls.get(item) ?? null)
      return
    }
    resetShifts(d, false)
    landing = item
    moveItem(from, item, t.g, t.index)
    const el = t.g.tabEls.get(item) ?? (t.g.active ? t.g.tabEls.get(t.g.active) : undefined) ?? null
    landGhost(d, el)
    return
  }

  // 拖到编辑区
  if (t.zone === 'center') {
    if (t.g === from) {
      resetShifts(d, true)
      landGhost(d, d.src)
      return
    }
    resetShifts(d, false)
    landing = item
    moveItem(from, item, t.g)
    landGhost(d, t.g.tabEls.get(item) ?? (t.g.active ? t.g.tabEls.get(t.g.active) : undefined) ?? null)
    return
  }
  if (t.g === from && from.items.length === 1) return goHome()
  resetShifts(d, false)
  absorbGhost(d, t.g.dropEl)
  const ng = createGroup(groups.indexOf(t.g) + (t.zone === 'right' ? 1 : 0), t.g.size / 2)
  t.g.size /= 2
  layoutGroups()
  moveItem(from, item, ng)
}

/* ---------------- 标签栏渲染 ---------------- */

const flipAnims = new WeakMap<Element, Animation>()
const inkAnims = new WeakMap<Group, Animation>()

function createTabEl(g: Group, it: Item): HTMLElement {
  const isFile = it.type === 'file'
  const close = h(
    'button',
    {
      class: 'tab-close',
      html: icons.close,
      onClick: (e: MouseEvent) => {
        e.stopPropagation()
        closeItem(g, it)
      }
    },
    h('span', { class: 'tab-dot', title: '未保存' })
  )
  const el = h(
    'div',
    {
      class: 'tab' + (!isFile && it.spec.kind ? ` kind-${it.spec.kind}` : ''),
      role: 'tab',
      tabindex: '0',
      onClick: () => performance.now() > suppressClickUntil && show(g, it),
      onAuxclick: (e: MouseEvent) => e.button === 1 && closeItem(g, it),
      onKeydown: (e: KeyboardEvent) => e.key === 'Enter' && show(g, it),
      onPointerdown: (e: PointerEvent) => armDrag(g, it, el, e),
      onContextmenu: (e: MouseEvent) => {
        e.preventDefault()
        showMenu(e.clientX, e.clientY, [
          { label: '关闭', key: 'Ctrl W', run: () => closeItem(g, it) },
          { label: '关闭其他', disabled: g.items.length < 2, run: () => closeOthers(g, it) },
          'sep',
          { label: '向左移动', key: 'Ctrl Shift PgUp', disabled: g.items.indexOf(it) <= 0, run: () => (show(g, it), moveActiveTab(-1)) },
          { label: '向右移动', key: 'Ctrl Shift PgDn', disabled: g.items.indexOf(it) >= g.items.length - 1, run: () => (show(g, it), moveActiveTab(1)) },
          'sep',
          { label: '向右拆分', key: 'Ctrl \\', run: () => (show(g, it), splitRight(g)) }
        ])
      }
    },
    !isFile && it.spec.icon ? h('span', { class: 'tab-icon', html: it.spec.icon }) : null,
    h('span', { class: 'tab-name' }),
    close
  )
  return el
}

/** 同步标签的状态样式；标题变了返回 true（宽度可能变化） */
function syncTab(g: Group, it: Item, el: HTMLElement): boolean {
  const isFile = it.type === 'file'
  const title = isFile ? basename(it.doc.path) : it.spec.title
  const on = it === g.active
  el.classList.toggle('on', on)
  el.classList.toggle('dirty', isFile && isDirty(it.doc))
  el.setAttribute('aria-selected', String(on))
  const tip = isFile ? it.doc.path : (it.spec.path ?? it.spec.title)
  if (el.title !== tip) el.title = tip
  const name = el.querySelector('.tab-name')!
  if (name.textContent === title) return false
  name.textContent = title
  el.querySelector('.tab-close')!.setAttribute('aria-label', `关闭 ${title}`)
  return true
}

/** 把指示条移到目标位置。距离较远时先“拉长”覆盖两端，再收缩到目标（像液体一样流过去） */
function moveInk(g: Group, target: { l: number; w: number } | null, anim: boolean): void {
  const ink = g.ink
  if (!target) {
    if (g.inkOn) ink.classList.remove('show')
    g.inkOn = false
    return
  }
  let fromL = g.inkL
  let fromW = g.inkW
  const running = inkAnims.get(g)
  if (running && running.playState === 'running') {
    const cs = getComputedStyle(ink)
    fromL = new DOMMatrixReadOnly(cs.transform === 'none' ? undefined : cs.transform).m41
    fromW = parseFloat(cs.width) || fromW
  }
  running?.cancel()
  inkAnims.delete(g)
  const wasOn = g.inkOn
  ink.style.transform = `translateX(${target.l}px)`
  ink.style.width = target.w + 'px'
  ink.classList.add('show')
  g.inkOn = true
  g.inkL = target.l
  g.inkW = target.w
  if (!wasOn) {
    animate(ink, [{ transform: `translateX(${target.l}px) scaleX(0.2)` }, { transform: `translateX(${target.l}px)` }], { spring: 'bouncy' })
    return
  }
  if (!anim || !fullMotion() || (Math.abs(fromL - target.l) < 0.5 && Math.abs(fromW - target.w) < 0.5)) return
  const spanL = Math.min(fromL, target.l)
  const spanR = Math.max(fromL + fromW, target.l + target.w)
  const stretch = 110
  const settle = Math.round(SPRING.snappy.duration * 0.85)
  const a = ink.animate(
    [
      { transform: `translateX(${fromL}px)`, width: fromW + 'px', easing: 'cubic-bezier(0.4, 0, 0.7, 0.4)' },
      { transform: `translateX(${spanL}px)`, width: spanR - spanL + 'px', offset: stretch / (stretch + settle), easing: SPRING.snappy.easing },
      { transform: `translateX(${target.l}px)`, width: target.w + 'px' }
    ],
    { duration: stretch + settle }
  )
  inkAnims.set(g, a)
}

/** 按当前布局重新放置指示条（ResizeObserver、改名后） */
function placeInk(g: Group, anim: boolean): void {
  const el = g.active ? g.tabEls.get(g.active) : undefined
  if (!el?.isConnected || g.tabsEl.offsetParent === null || el.classList.contains('drag-src')) {
    if (!el) moveInk(g, null, false)
    return
  }
  moveInk(g, { l: el.offsetLeft, w: el.offsetWidth }, anim)
}

/** 活动标签被挡住时平滑滚动到可见 */
function revealTab(g: Group, l: number, w: number): void {
  const s = g.tabsEl
  const pad = 24
  if (l < s.scrollLeft + pad) s.scrollTo({ left: Math.max(0, l - pad), behavior: fullMotion() ? 'smooth' : 'auto' })
  else if (l + w > s.scrollLeft + s.clientWidth - pad) s.scrollTo({ left: l + w - s.clientWidth + pad, behavior: fullMotion() ? 'smooth' : 'auto' })
}

function renderGroup(g: Group): void {
  g.el.classList.toggle('empty', g.items.length === 0)
  g.closeEl.hidden = g.items.length > 0 || groups.length < 2

  // 顺序和活动项都没变（最常见：输入时刷新“未保存”标记）：只同步样式，不碰布局
  const same = g.active === g.lastActive && g.items.length === g.lastOrder.length && g.items.every((x, i) => x === g.lastOrder[i])
  if (same) {
    let resized = false
    for (const it of g.items) {
      const el = g.tabEls.get(it)
      if (el && syncTab(g, it, el)) resized = true
    }
    if (resized) placeInk(g, true)
    return
  }
  const prevActive = g.lastActive
  g.lastOrder = [...g.items]
  g.lastActive = g.active
  const motion = fullMotion() && g.tabsEl.offsetParent !== null

  // 1. 记下现有标签的位置（含正在进行的位移），并停掉上一轮的重排动画
  const first = new Map<HTMLElement, DOMRect>()
  if (motion) {
    for (const el of g.tabEls.values()) if (!el.classList.contains('leaving')) first.set(el, el.getBoundingClientRect())
    for (const el of first.keys()) {
      flipAnims.get(el)?.cancel()
      flipAnims.delete(el)
    }
  }

  // 2. 离开的标签：已经被拖走的直接移除，其余播放收起动画
  const live = new Set(g.items)
  const leavingNow: HTMLElement[] = []
  for (const [it, el] of [...g.tabEls]) {
    if (live.has(it)) continue
    g.tabEls.delete(it)
    if (!motion || el.classList.contains('drag-src')) el.remove()
    else {
      el.classList.add('leaving')
      leavingNow.push(el)
    }
  }
  const entering: HTMLElement[] = []
  const desired = g.items.map((it) => {
    let el = g.tabEls.get(it)
    if (!el) {
      el = createTabEl(g, it)
      g.tabEls.set(it, el)
      if (it === landing) el.classList.add('drag-src')
      else if (motion) entering.push(el)
    }
    syncTab(g, it, el)
    el.style.transform = ''
    return el
  })

  // 3. 排列 DOM：离开中的标签留在原位（挂在它前面那个仍存在的标签后面）
  const desiredSet = new Set(desired)
  const anchors: [HTMLElement, HTMLElement | null][] = []
  let prev: HTMLElement | null = null
  for (const c of Array.from(g.tabsEl.children) as HTMLElement[]) {
    if (c.classList.contains('leaving')) anchors.push([c, prev])
    else if (desiredSet.has(c)) prev = c
  }
  const order: HTMLElement[] = anchors.filter(([, a]) => a === null).map(([l]) => l)
  for (const el of desired) {
    order.push(el)
    for (const [l, a] of anchors) if (a === el) order.push(l)
  }
  let ref: ChildNode | null = g.tabsEl.firstChild
  for (const el of order) {
    if (ref === el) {
      ref = el.nextSibling
      continue
    }
    g.tabsEl.insertBefore(el, ref)
  }

  // 4. 在最终布局下（不算离开中的标签）测量指示条的目标位置
  const activeEl = g.active ? g.tabEls.get(g.active) : undefined
  let inkTarget: { l: number; w: number } | null = null
  if (activeEl && g.tabsEl.offsetParent !== null) {
    const leaving = anchors.map(([l]) => l)
    for (const l of leaving) l.style.display = 'none'
    inkTarget = { l: activeEl.offsetLeft, w: activeEl.offsetWidth }
    for (const l of leaving) l.style.display = ''
  }

  // 5. 进场：宽度从 0 长出来，内容从下方浮起；离场：宽度收到 0
  for (const el of leavingNow) {
    const cs = getComputedStyle(el)
    const a = animate(
      el,
      [
        { width: el.offsetWidth + 'px', paddingLeft: cs.paddingLeft, paddingRight: cs.paddingRight, opacity: 1 },
        { width: '0px', paddingLeft: '0px', paddingRight: '0px', opacity: 0 }
      ],
      { duration: DUR.sm + 40, easing: EASE.inOut, fill: 'forwards' }
    )
    after(a, () => {
      el.remove()
      placeInk(g, true)
    })
  }
  for (const el of entering) {
    const cs = getComputedStyle(el)
    el.classList.add('entering')
    const a = animate(
      el,
      [
        { width: '0px', paddingLeft: '0px', paddingRight: '0px', opacity: 0 },
        { width: el.offsetWidth + 'px', paddingLeft: cs.paddingLeft, paddingRight: cs.paddingRight, opacity: 1 }
      ],
      { spring: 'soft' }
    )
    // 连续打开多个标签时，前面的标签还在“长”，测到的位置会偏；长完后再校准一次指示条
    after(a, () => {
      el.classList.remove('entering')
      placeInk(g, true)
    })
    Array.from(el.children).forEach((c, i) => animate(c, [{ opacity: 0, transform: 'translateY(9px)' }, { opacity: 1, transform: 'none' }], { duration: DUR.md, delay: 50 + i * 30 }))
  }

  // 6. FLIP：位置变了的标签从旧位置滑到新位置
  if (motion) {
    for (const [el, a] of first) {
      // 被拖的标签由幽灵负责飞过去，不能再给它做 FLIP（否则幽灵会量到旧位置）
      if (!el.isConnected || el.classList.contains('leaving') || el.classList.contains('drag-src')) continue
      const b = el.getBoundingClientRect()
      const dx = a.left - b.left
      if (Math.abs(dx) < 0.5) continue
      const an = animate(el, [{ transform: `translateX(${dx}px)` }, { transform: 'none' }], { spring: 'snappy' })
      if (an) flipAnims.set(el, an)
    }
  }

  // 7. 指示条和滚动
  if (activeEl?.classList.contains('drag-src')) {
    // 幽灵还在飞，指示条直接就位、等它落下
    moveInk(g, inkTarget, false)
  } else moveInk(g, inkTarget, prevActive !== null)
  if (inkTarget && g.active !== prevActive) revealTab(g, inkTarget.l, inkTarget.w)
}


function renderAll(): void {
  groups.forEach(renderGroup)
}

/** 由外部在 'tabs' 事件里调用，刷新所有组的标签栏 */
export function renderEditorTabs(): void {
  renderAll()
}

/* ---------------- 保存 ---------------- */

export async function saveTab(t: Tab, quiet = false): Promise<boolean> {
  const content = t.model.getValue(monaco.editor.EndOfLinePreference.TextDefined)
  try {
    await window.api.fs.writeFile(t.path, content)
    t.savedVersion = t.model.getAlternativeVersionId()
    fire('saved', t)
    emit('tabs')
    if (!quiet) toast('已保存')
    return true
  } catch (e) {
    toast('保存失败：' + String(e))
    return false
  }
}

export async function saveActive(): Promise<void> {
  const t = activeTab()
  if (t) await saveTab(t)
}

export async function saveAll(): Promise<void> {
  const dirty = tabs.filter(isDirty)
  let n = 0
  for (const t of dirty) if (await saveTab(t, true)) n++
  toast(n ? `已保存 ${n} 个文件` : '没有需要保存的文件')
}

/**
 * 文件或文件夹改名后，把受影响的标签换到新路径。
 * Monaco 模型的 URI 不能改，所以用旧内容建新模型，保留未保存状态。
 */
export function renamePath(from: string, to: string): void {
  for (const t of tabs.filter((x) => isUnder(x.path, from))) {
    const newPath = normPath(to + t.path.slice(from.length))
    const dirty = isDirty(t)
    const old = t.model
    const showing = groups.filter((g) => g.active?.type === 'file' && g.active.doc === t)
    for (const g of showing) if (g.active?.type === 'file') g.active.view = g.editor.saveViewState()
    fire('closed', t)
    const model = monaco.editor.createModel(old.getValue(), languageFor(newPath), monaco.Uri.file(newPath))
    t.path = newPath
    t.model = model
    t.savedVersion = dirty ? -1 : model.getAlternativeVersionId()
    track(t)
    fire('opened', t)
    for (const g of showing) {
      g.editor.setModel(model)
      if (g.active?.type === 'file' && g.active.view) g.editor.restoreViewState(g.active.view)
    }
    old.dispose()
  }
  // 文档预览标签只需换路径和标题
  for (const g of groups)
    for (const it of g.items) {
      const spec = it.type === 'view' ? it.spec : null
      if (!spec?.path || !isUnder(spec.path, from)) continue
      spec.path = normPath(to + spec.path.slice(from.length))
      spec.title = basename(spec.path)
      if (spec.key) spec.key = 'preview:' + pathKey(spec.path)
    }
  updateTitle()
  emit('tabs')
}

/**
 * 磁盘上的文件变了：没改过的标签直接重新加载（保留撤销栈和光标），
 * 改过的只提示，不覆盖用户的修改。
 */
export async function reloadFromDisk(path: string): Promise<void> {
  const t = findTab(path)
  if (!t) return
  const r = await window.api.fs.readFile(t.path)
  if (!r.ok) {
    if (r.reason === 'missing') toast(`“${basename(t.path)}” 已在磁盘上被删除`)
    return
  }
  const current = t.model.getValue(monaco.editor.EndOfLinePreference.TextDefined)
  if (r.content === current) return
  if (isDirty(t)) {
    toast(`“${basename(t.path)}” 在磁盘上被修改了，保存会覆盖它`)
    return
  }
  t.model.pushEditOperations([], [{ range: t.model.getFullModelRange(), text: r.content }], () => null)
  t.savedVersion = t.model.getAlternativeVersionId()
  emit('tabs')
}

export function problemCount(): number {
  return monaco.editor.getModelMarkers({}).filter((m) => m.severity === monaco.MarkerSeverity.Error).length
}
