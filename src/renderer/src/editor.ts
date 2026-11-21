import { languageFor, monaco } from './monaco'
import { basename, toast } from './dom'
import { emit, isFocus, state } from './store'
import { FONTS } from './theme'

export interface Tab {
  path: string
  model: monaco.editor.ITextModel
  savedVersion: number
  view: monaco.editor.ICodeEditorViewState | null
  /** 监听模型内容变化（后台标签被重命名等操作修改时，也要刷新未保存标记） */
  sub?: monaco.IDisposable
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

export const tabs: Tab[] = []
let active: Tab | null = null
let editor: monaco.editor.IStandaloneCodeEditor

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
  return editor
}

export function activeTab(): Tab | null {
  return active
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

export function initEditor(container: HTMLElement): void {
  editor = monaco.editor.create(container, {
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
  })
  editor.onDidChangeCursorPosition(() => emit('cursor'))
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

export function applyEditorOptions(): void {
  if (!editor) return
  const { space, wordWrap } = state.settings
  const focus = isFocus()
  editor.updateOptions({
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
  requestAnimationFrame(() => editor.render(true))
}

function setActive(t: Tab | null): void {
  if (active && active !== t) active.view = editor.saveViewState()
  active = t
  editor.setModel(t ? t.model : null)
  if (t?.view) editor.restoreViewState(t.view)
  if (t) editor.focus()
  document.title = t ? `${basename(t.path)} — Infinite Studio` : 'Infinite Studio · 无界工作室'
  emit('tabs')
  emit('cursor')
}

function revealAt(o: OpenOptions): void {
  if (!o.line) return
  const col = o.col ?? 1
  const range = new monaco.Range(o.line, col, o.line, col + (o.len ?? 0))
  editor.setSelection(range)
  editor.revealRangeInCenterIfOutsideViewport(range, monaco.editor.ScrollType.Immediate)
  editor.focus()
}

export async function openFile(rawPath: string, o: OpenOptions = {}): Promise<Tab | null> {
  const path = normPath(rawPath)
  const activate = o.activate !== false
  const existing = findTab(path)
  if (existing) {
    if (activate) {
      setActive(existing)
      revealAt(o)
    }
    return existing
  }
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
    const again = findTab(path)
    if (again) return openFile(path, o)
    model = monaco.editor.getModel(uri) ?? monaco.editor.createModel(r.content, languageFor(path), uri)
  }
  const tab: Tab = { path, model, savedVersion: model.getAlternativeVersionId(), view: null }
  track(tab)
  const idx = active ? tabs.indexOf(active) + 1 : tabs.length
  tabs.splice(idx, 0, tab)
  fire('opened', tab)
  if (activate) {
    setActive(tab)
    revealAt(o)
  } else {
    emit('tabs')
  }
  return tab
}

export function activate(path: string): void {
  const t = findTab(path)
  if (t) setActive(t)
}

function removeTab(t: Tab): void {
  const i = tabs.indexOf(t)
  if (i < 0) return
  tabs.splice(i, 1)
  t.sub?.dispose()
  fire('closed', t)
  if (active === t) {
    active = null
    setActive(tabs[i] ?? tabs[i - 1] ?? null)
  } else {
    emit('tabs')
  }
  t.model.dispose()
}

export function closeTab(path?: string): void {
  const t = path ? findTab(path) : active
  if (!t) return
  if (isDirty(t) && !confirm(`“${basename(t.path)}” 有未保存的修改，仍然关闭吗？`)) return
  removeTab(t)
}

/** 关闭某个路径（或其下所有文件）的标签，不再询问 */
export function closeUnder(path: string): void {
  for (const t of tabs.filter((x) => isUnder(x.path, path))) removeTab(t)
}

export function closeAll(): boolean {
  if (anyDirty() && !confirm('有未保存的修改，仍然关闭全部文件吗？')) return false
  for (const t of [...tabs]) removeTab(t)
  setActive(null)
  return true
}

export function cycleTab(dir: 1 | -1): void {
  if (tabs.length < 2 || !active) return
  const i = (tabs.indexOf(active) + dir + tabs.length) % tabs.length
  setActive(tabs[i])
}

async function saveTab(t: Tab, quiet = false): Promise<boolean> {
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
  if (active) await saveTab(active)
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
    const wasActive = active === t
    const view = wasActive ? editor.saveViewState() : t.view
    fire('closed', t)
    const model = monaco.editor.createModel(old.getValue(), languageFor(newPath), monaco.Uri.file(newPath))
    t.path = newPath
    t.model = model
    t.savedVersion = dirty ? -1 : model.getAlternativeVersionId()
    t.view = view
    track(t)
    fire('opened', t)
    if (wasActive) {
      active = null
      setActive(t)
    }
    old.dispose()
  }
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
