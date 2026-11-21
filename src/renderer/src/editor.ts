import { languageFor, monaco } from './monaco'
import { basename, h, toast } from './dom'
import { icons } from './icons'
import { showMenu } from './menu'
import { emit, isFocus, state } from './store'
import { FONTS } from './theme'

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
  const g: Group = { id: nextGroupId++, items: [], active: null, el, tabsEl, actionsEl, host, viewHost, dropEl, closeEl, editor, size }

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
  setupDrop(g)

  groups.splice(index, 0, g)
  layoutGroups()
  applyOptions(g)
  return g
}

function removeGroup(g: Group): void {
  const i = groups.indexOf(g)
  if (i < 0 || groups.length === 1) return
  groups.splice(i, 1)
  g.editor.dispose()
  g.el.remove()
  if (activeGroup === g) focusGroup(groups[Math.min(i, groups.length - 1)])
  layoutGroups()
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
  emit('tabs')
  emit('cursor')
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
  if (!doc) {
    const uri = monaco.Uri.file(path)
    // 模型可能已被语言服务预先创建（比如“查看定义”时），直接复用
    let model = monaco.editor.getModel(uri)
    if (!model) {
      const r = await window.api.fs.readFile(path)
      if (!r.ok) {
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

let drag: { from: Group; item: Item } | null = null

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

function setupDrop(g: Group): void {
  const zoneOf = (e: DragEvent): 'left' | 'right' | 'center' => {
    const r = g.dropEl.parentElement!.getBoundingClientRect()
    const x = (e.clientX - r.left) / r.width
    return x < 0.25 ? 'left' : x > 0.75 ? 'right' : 'center'
  }
  const body = g.dropEl.parentElement!
  body.addEventListener('dragover', (e) => {
    if (!drag) return
    e.preventDefault()
    g.dropEl.hidden = false
    g.dropEl.dataset.zone = zoneOf(e)
  })
  body.addEventListener('dragleave', (e) => {
    if (!body.contains(e.relatedTarget as Node)) g.dropEl.hidden = true
  })
  body.addEventListener('drop', (e) => {
    g.dropEl.hidden = true
    if (!drag) return
    e.preventDefault()
    const { from, item } = drag
    drag = null
    const zone = zoneOf(e)
    if (zone === 'center') return moveItem(from, item, g)
    // 拖到边缘：新建一个组
    if (from === g && g.items.length === 1) return
    const ng = createGroup(groups.indexOf(g) + (zone === 'right' ? 1 : 0), g.size / 2)
    g.size /= 2
    layoutGroups()
    moveItem(from, item, ng)
  })
  // 拖到标签栏：插到指定位置
  g.tabsEl.addEventListener('dragover', (e) => {
    if (!drag) return
    e.preventDefault()
  })
  g.tabsEl.addEventListener('drop', (e) => {
    if (!drag) return
    e.preventDefault()
    const { from, item } = drag
    drag = null
    const tabEls = [...g.tabsEl.querySelectorAll<HTMLElement>('.tab')]
    let index = tabEls.length
    for (let i = 0; i < tabEls.length; i++) {
      const r = tabEls[i].getBoundingClientRect()
      if (e.clientX < r.left + r.width / 2) {
        index = i
        break
      }
    }
    moveItem(from, item, g, index)
  })
}

/* ---------------- 标签栏渲染 ---------------- */

function renderGroup(g: Group): void {
  g.el.classList.toggle('empty', g.items.length === 0)
  g.closeEl.hidden = g.items.length > 0 || groups.length < 2
  g.tabsEl.replaceChildren(
    ...g.items.map((it) => {
      const isFile = it.type === 'file'
      const title = isFile ? basename(it.doc.path) : it.spec.title
      const dirty = isFile && isDirty(it.doc)
      const on = it === g.active
      const el = h(
        'div',
        {
          class: 'tab' + (on ? ' on' : '') + (dirty ? ' dirty' : '') + (!isFile && it.spec.kind ? ` kind-${it.spec.kind}` : ''),
          role: 'tab',
          tabindex: '0',
          draggable: 'true',
          'aria-selected': String(on),
          title: isFile ? it.doc.path : it.spec.title,
          onClick: () => show(g, it),
          onAuxclick: (e: MouseEvent) => e.button === 1 && closeItem(g, it),
          onKeydown: (e: KeyboardEvent) => e.key === 'Enter' && show(g, it),
          onContextmenu: (e: MouseEvent) => {
            e.preventDefault()
            showMenu(e.clientX, e.clientY, [
              { label: '关闭', key: 'Ctrl W', run: () => closeItem(g, it) },
              { label: '关闭其他', disabled: g.items.length < 2, run: () => closeOthers(g, it) },
              'sep',
              { label: '向右拆分', key: 'Ctrl \\', run: () => (show(g, it), splitRight(g)) }
            ])
          },
          onDragstart: (e: DragEvent) => {
            drag = { from: g, item: it }
            e.dataTransfer!.effectAllowed = 'move'
            e.dataTransfer!.setData('text/plain', title)
            document.body.classList.add('dragging-tab')
          },
          onDragend: () => {
            drag = null
            document.body.classList.remove('dragging-tab')
            for (const x of groups) x.dropEl.hidden = true
          }
        },
        !isFile && it.spec.icon ? h('span', { class: 'tab-icon', html: it.spec.icon }) : null,
        h('span', { class: 'tab-name' }, title),
        h(
          'button',
          {
            class: 'tab-close',
            'aria-label': `关闭 ${title}`,
            html: icons.close,
            onClick: (e: MouseEvent) => {
              e.stopPropagation()
              closeItem(g, it)
            }
          },
          h('span', { class: 'tab-dot', title: '未保存' })
        )
      )
      return el
    })
  )
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
