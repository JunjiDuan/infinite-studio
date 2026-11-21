import { languageFor, monaco } from './monaco'
import { basename, toast } from './dom'
import { emit, isFocus, state } from './store'
import { FONTS } from './theme'

export interface Tab {
  path: string
  model: monaco.editor.ITextModel
  savedVersion: number
  view: monaco.editor.ICodeEditorViewState | null
}

export const tabs: Tab[] = []
let active: Tab | null = null
let editor: monaco.editor.IStandaloneCodeEditor

export function getEditor(): monaco.editor.IStandaloneCodeEditor {
  return editor
}

export function activeTab(): Tab | null {
  return active
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
  editor.onDidChangeModelContent(() => emit('tabs'))
  monaco.editor.onDidChangeMarkers(() => emit('markers'))
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

export async function openFile(path: string): Promise<void> {
  const existing = tabs.find((t) => t.path === path)
  if (existing) return setActive(existing)
  const r = await window.api.fs.readFile(path)
  if (!r.ok) {
    toast(r.reason === 'binary' ? '这是二进制文件，暂不支持打开' : r.reason === 'too-large' ? '文件超过 5 MB，暂不支持打开' : '无法读取文件')
    return
  }
  const uri = monaco.Uri.file(path)
  const model = monaco.editor.getModel(uri) ?? monaco.editor.createModel(r.content, languageFor(path), uri)
  const tab: Tab = { path, model, savedVersion: model.getAlternativeVersionId(), view: null }
  const idx = active ? tabs.indexOf(active) + 1 : tabs.length
  tabs.splice(idx, 0, tab)
  setActive(tab)
}

export function activate(path: string): void {
  const t = tabs.find((x) => x.path === path)
  if (t) setActive(t)
}

export function closeTab(path?: string): void {
  const t = path ? tabs.find((x) => x.path === path) : active
  if (!t) return
  if (isDirty(t) && !confirm(`“${basename(t.path)}” 有未保存的修改，仍然关闭吗？`)) return
  const i = tabs.indexOf(t)
  tabs.splice(i, 1)
  if (active === t) {
    active = null
    setActive(tabs[i] ?? tabs[i - 1] ?? null)
  } else {
    emit('tabs')
  }
  t.model.dispose()
}

export function closeAll(): boolean {
  if (anyDirty() && !confirm('有未保存的修改，仍然关闭全部文件吗？')) return false
  for (const t of tabs.splice(0)) t.model.dispose()
  active = null
  setActive(null)
  return true
}

export function cycleTab(dir: 1 | -1): void {
  if (tabs.length < 2 || !active) return
  const i = (tabs.indexOf(active) + dir + tabs.length) % tabs.length
  setActive(tabs[i])
}

export async function saveActive(): Promise<void> {
  const t = active
  if (!t) return
  const content = t.model.getValue(monaco.editor.EndOfLinePreference.TextDefined)
  try {
    await window.api.fs.writeFile(t.path, content)
    t.savedVersion = t.model.getAlternativeVersionId()
    emit('tabs')
    toast('已保存')
  } catch (e) {
    toast('保存失败：' + String(e))
  }
}

export function problemCount(): number {
  return monaco.editor.getModelMarkers({}).filter((m) => m.severity === monaco.MarkerSeverity.Error).length
}

export function relayout(): void {
  editor?.layout()
}
