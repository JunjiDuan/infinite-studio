import { monaco } from '../monaco'
import { h } from '../dom'
import { t } from '../i18n'
import { onEditor } from '../editor'
import { aiSettings, streamChat } from './client'
import { withRules } from './context'
import { hasInlineEdit } from './inlineEdit'

/**
 * 下一处编辑预测（Next Edit Suggestion）。
 *
 * 用户改完一处（停顿片刻）后，把最近几次修改和文件内容发给模型，预测“接下来要改哪里、改成什么”：
 * 例如函数改了名，调用处也要改；加了参数，调用处要补上；同样的模式还要在别处重复。
 *
 * 有预测时在目标行旁边显示提示：光标不在那里时按 Tab 跳过去，跳到后显示修改预览（删掉的行划线、新代码标绿），
 * 再按 Tab 应用、Esc 忽略。应用的修改也算一次编辑，会接着预测下一处。
 */

type Editor = monaco.editor.IStandaloneCodeEditor
type Model = monaco.editor.ITextModel

const IDLE_MS = 900
const MAX_MODEL = 300_000
const WINDOW_ALL = 400
const WINDOW_HALF = 160

interface Burst {
  /** 修改前这几行的内容 */
  before: string
  /** 跟踪修改后的区域 */
  deco: string
  /** 修改后的内容（停顿时取） */
  after?: string
  line?: number
}

interface Suggestion {
  model: Model
  /** 跟踪目标区域（用户在别处编辑时跟着移动） */
  track: monaco.editor.IEditorDecorationsCollection
  original: string
  replacement: string
  phase: 'jump' | 'apply'
}

interface State {
  editor: Editor
  prev: string
  prevModel: Model | null
  bursts: Burst[]
  current: Burst | null
  timer?: ReturnType<typeof setTimeout>
  cancel?: () => void
  reqSeq: number
  sug: Suggestion | null
  hint: monaco.editor.IContentWidget | null
  hintEl: HTMLElement
  zone: string | null
  marks: monaco.editor.IEditorDecorationsCollection
  keyJump: monaco.editor.IContextKey<boolean>
  keyApply: monaco.editor.IContextKey<boolean>
  applying: boolean
}

const SYSTEM = [
  'You are the "next edit" engine of a code editor.',
  'You see the edits the user just made and the current file with line numbers.',
  'Predict the single most likely NEXT edit the user will make elsewhere in this file as a direct consequence of the recent edits:',
  'for example updating other uses of a renamed identifier, adding a new parameter at call sites, applying the same change to similar lines, fixing code the edit made inconsistent.',
  'Reply in exactly this format, without code fences or explanation:',
  '@@ <start>-<end>',
  '<the complete new text for lines start..end, which may be more or fewer lines>',
  'Line numbers are 1-based and inclusive and refer to the current file shown. Do not repeat or undo the edit the user just made.',
  'If no further edit is clearly implied, reply with exactly NONE.'
].join('\n')

const states = new WeakMap<Editor, State>()

/* ---------------- 记录修改 ---------------- */

function trackable(model: Model | null): model is Model {
  return !!model && (model.uri.scheme === 'file' || model.uri.scheme === 'nbcell') && model.getValueLength() <= MAX_MODEL
}

function onChange(s: State, e: monaco.editor.IModelContentChangedEvent): void {
  const model = s.editor.getModel()
  if (!trackable(model)) return
  if (s.prevModel !== model || e.isFlush) {
    s.prev = model.getValue(monaco.editor.EndOfLinePreference.LF)
    s.prevModel = model
    return
  }
  // 有预测时用户继续编辑：预测作废
  if (s.sug && !s.applying) clearSuggestion(s)
  s.cancel?.()
  if (!e.isUndoing && !e.isRedoing && e.changes.length) {
    const prevLines = s.prev.split('\n')
    // 修改涉及的行（修改前的行号）
    const first = Math.min(...e.changes.map((c) => c.range.startLineNumber))
    const last = Math.max(...e.changes.map((c) => c.range.endLineNumber))
    const now = Math.min(...e.changes.map((c) => c.range.startLineNumber))
    const cur = s.current
    const curRange = cur ? model.getDecorationRange(cur.deco) : null
    if (cur && curRange && now >= curRange.startLineNumber - 1 && now <= curRange.endLineNumber + 1) {
      // 同一处的连续修改：扩大跟踪区域
      const a = Math.min(curRange.startLineNumber, first)
      const nl = e.changes.reduce((n, c) => n + c.text.split('\n').length - 1, 0)
      const b = Math.max(curRange.endLineNumber, Math.min(model.getLineCount(), last + nl))
      model.deltaDecorations([cur.deco], [])
      cur.deco = model.deltaDecorations([], [{ range: new monaco.Range(a, 1, b, 1), options: { stickiness: monaco.editor.TrackedRangeStickiness.AlwaysGrowsWhenTypingAtEdges } }])[0]
    } else {
      if (cur) finishBurst(s, model)
      const nl = e.changes.reduce((n, c) => n + c.text.split('\n').length - 1, 0)
      const end = Math.min(model.getLineCount(), last + nl)
      s.current = {
        before: prevLines.slice(first - 1, last).join('\n'),
        deco: model.deltaDecorations([], [{ range: new monaco.Range(first, 1, end, 1), options: { stickiness: monaco.editor.TrackedRangeStickiness.AlwaysGrowsWhenTypingAtEdges } }])[0]
      }
    }
  }
  s.prev = model.getValue(monaco.editor.EndOfLinePreference.LF)
  clearTimeout(s.timer)
  if (!aiSettings().nextEdit.enabled) return
  s.timer = setTimeout(() => void predict(s), IDLE_MS)
}

function finishBurst(s: State, model: Model): Burst | null {
  const b = s.current
  if (!b) return null
  s.current = null
  const r = model.getDecorationRange(b.deco)
  model.deltaDecorations([b.deco], [])
  if (!r) return null
  b.after = model.getValueInRange(new monaco.Range(r.startLineNumber, 1, r.endLineNumber, model.getLineMaxColumn(r.endLineNumber)))
  b.line = r.startLineNumber
  // 只改了空白的不算
  if (b.after.replace(/\s+/g, '') === b.before.replace(/\s+/g, '')) return null
  s.bursts = [...s.bursts.slice(-4), b]
  return b
}

/* ---------------- 预测 ---------------- */

function numbered(lines: string[], from: number, to: number): string {
  const w = String(to).length
  const out: string[] = []
  for (let i = from; i <= to; i++) out.push(`${String(i).padStart(w)}| ${lines[i - 1]}`)
  return out.join('\n')
}

async function predict(s: State): Promise<void> {
  const editor = s.editor
  const model = editor.getModel()
  if (!trackable(model) || !aiSettings().nextEdit.enabled || hasInlineEdit(editor) || editor.getOption(monaco.editor.EditorOption.readOnly)) return
  const last = finishBurst(s, model)
  if (!last) return
  const lines = model.getLinesContent()
  const pos = editor.getPosition()!
  const from = lines.length <= WINDOW_ALL ? 1 : Math.max(1, pos.lineNumber - WINDOW_HALF)
  const to = lines.length <= WINDOW_ALL ? lines.length : Math.min(lines.length, pos.lineNumber + WINDOW_HALF)
  const edits = s.bursts
    .slice(-3)
    .map((b, i, arr) => [`Edit ${i + 1}${i === arr.length - 1 ? ' (most recent)' : ''}, now at line ${b.line}:`, '--- before', b.before || '(empty)', '+++ after', b.after || '(empty)'].join('\n'))
    .join('\n\n')
  const path = model.uri.scheme === 'file' ? model.uri.fsPath : 'notebook cell'
  const user = [
    `File: ${path} (${model.getLanguageId()})`,
    '',
    'Recent edits by the user:',
    edits,
    '',
    `Current file${from > 1 || to < lines.length ? ` (lines ${from}-${to})` : ''}, cursor at line ${pos.lineNumber}:`,
    numbered(lines, from, to)
  ].join('\n')
  const seq = ++s.reqSeq
  const version = model.getVersionId()
  const system = await withRules(SYSTEM)
  if (seq !== s.reqSeq) return
  const req = streamChat({ system, messages: [{ role: 'user', content: user }], maxTokens: 1500 }, () => {}, 'nextEdit')
  s.cancel = req.cancel
  const r = await req.done
  if (s.cancel === req.cancel) s.cancel = undefined
  // 期间用户又改了、换了文件：作废
  if (seq !== s.reqSeq || !r.ok || editor.getModel() !== model || model.getVersionId() !== version) return
  const parsed = parse(r.text)
  if (!parsed) return
  let { start, end } = parsed
  if (start < from || start > to || end > to + 1) return
  end = Math.max(start - 1, Math.min(end, lines.length))
  const original = start <= end ? lines.slice(start - 1, end).join('\n') : ''
  const replacement = parsed.text
  if (replacement === original || replacement.replace(/\s+/g, '') === original.replace(/\s+/g, '')) return
  // 预测的就是刚做完的那处修改：没有意义
  if (last.line && start <= last.line + (last.after?.split('\n').length ?? 1) - 1 && end >= last.line && replacement.trim() === last.after?.trim()) return
  showSuggestion(s, model, start, end, original, replacement)
}

function parse(text: string): { start: number; end: number; text: string } | null {
  let body = text.replace(/\r\n/g, '\n').trim()
  if (!body || /^NONE\b/i.test(body)) return null
  // 去掉偶尔加上的代码块
  body = body.replace(/^```[^\n]*\n/, '').replace(/\n?```\s*$/, '')
  // 标题行之后只吃掉换行，保留第一行代码的缩进
  const m = body.match(/^@@[ \t]*(\d+)[ \t]*-[ \t]*(\d+)[ \t]*(?:@@)?[ \t]*(?:\n|$)/)
  if (!m) return null
  const start = Number(m[1])
  const end = Number(m[2])
  if (!start || end < start - 1 || end - start > 200) return null
  let out = body.slice(m[0].length).split('\n')
  // 模型照抄了行号前缀（"  12| "）：每一行都有时才去掉，免得误伤代码
  const numbered = /^\s*\d+\| ?/
  if (out.some((l) => l.trim()) && out.every((l) => !l.trim() || numbered.test(l))) out = out.map((l) => l.replace(numbered, ''))
  return { start, end, text: out.join('\n').replace(/\n+$/, '') }
}

/* ---------------- 显示 ---------------- */

function targetRange(sug: Suggestion): monaco.Range | null {
  return sug.track.getRange(0)
}

function showSuggestion(s: State, model: Model, start: number, end: number, original: string, replacement: string): void {
  clearSuggestion(s)
  const editor = s.editor
  const track = editor.createDecorationsCollection()
  // 纯插入（end < start）：改成替换相邻的一行（start 前一行后面接上新代码；在第 1 行前插入时接在第 1 行前面）
  let a = start
  let b = end
  if (end < start) {
    if (start > 1) {
      a = b = start - 1
      original = model.getLineContent(a)
      replacement = original + '\n' + replacement
    } else {
      a = b = 1
      original = model.getLineContent(1)
      replacement = replacement + '\n' + original
    }
  }
  track.set([{ range: new monaco.Range(a, 1, b, model.getLineMaxColumn(b)), options: { stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges } }])
  s.sug = { model, track, original, replacement, phase: 'jump' }
  const pos = editor.getPosition()
  const r = targetRange(s.sug)!
  // 光标已经在目标附近：直接显示预览
  if (pos && pos.lineNumber >= r.startLineNumber - 1 && pos.lineNumber <= r.endLineNumber + 1) enterApply(s)
  else renderJump(s)
}

function renderJump(s: State): void {
  const sug = s.sug!
  const r = targetRange(sug)
  if (!r) return clearSuggestion(s)
  sug.phase = 'jump'
  s.marks.set([{ range: r, options: { isWholeLine: true, className: 'ai-nes-target', linesDecorationsClassName: 'ai-nes-gutter', overviewRuler: { color: '#6E9BFF', position: monaco.editor.OverviewRulerLane.Center } } }])
  const first = sug.replacement.split('\n').find((l) => l.trim())?.trim() ?? ''
  s.hintEl.replaceChildren(h('span', { class: 'ai-nes-mark' }, '✦'), h('kbd', {}, 'Tab'), h('span', {}, t('跳到建议的修改')), ...(first ? [h('code', {}, first.length > 48 ? first.slice(0, 48) + '…' : first)] : []))
  showHint(s, r.startLineNumber)
  s.keyJump.set(true)
  s.keyApply.set(false)
}

function enterApply(s: State): void {
  const sug = s.sug!
  const r = targetRange(sug)
  if (!r) return clearSuggestion(s)
  sug.phase = 'apply'
  const editor = s.editor
  // 删掉 / 改掉的行划线，新代码以视图区的形式显示在下面
  const font = editor.getOption(monaco.editor.EditorOption.fontInfo)
  const lineHeight = editor.getOption(monaco.editor.EditorOption.lineHeight)
  const origLines = sug.original.split('\n')
  const newLines = sug.replacement.split('\n')
  // 去掉相同的开头 / 结尾，只突出真正变化的行
  let pre = 0
  while (pre < origLines.length && pre < newLines.length && origLines[pre] === newLines[pre]) pre++
  let suf = 0
  while (suf < origLines.length - pre && suf < newLines.length - pre && origLines[origLines.length - 1 - suf] === newLines[newLines.length - 1 - suf]) suf++
  const delFrom = r.startLineNumber + pre
  const delTo = r.endLineNumber - suf
  const added = newLines.slice(pre, newLines.length - suf)
  const decos: monaco.editor.IModelDeltaDecoration[] = []
  if (delTo >= delFrom) decos.push({ range: new monaco.Range(delFrom, 1, delTo, 1), options: { isWholeLine: true, className: 'ai-nes-old', linesDecorationsClassName: 'ai-nes-gutter' } })
  s.marks.set(decos)
  if (added.length) {
    editor.changeViewZones((acc) => {
      if (s.zone) acc.removeZone(s.zone)
      const dom = h(
        'div',
        { class: 'ai-nes-zone', style: { fontFamily: font.fontFamily, fontSize: `${font.fontSize}px`, lineHeight: `${lineHeight}px` } },
        ...added.map((l) => h('div', { class: 'ai-nes-new' }, l || ' '))
      )
      s.zone = acc.addZone({ afterLineNumber: Math.max(delTo, delFrom - 1), heightInLines: added.length, domNode: dom })
    })
  }
  s.hintEl.replaceChildren(h('span', { class: 'ai-nes-mark' }, '✦'), h('kbd', {}, 'Tab'), h('span', {}, t('接受')), h('kbd', {}, 'Esc'), h('span', {}, t('忽略')))
  showHint(s, r.startLineNumber)
  s.keyJump.set(false)
  s.keyApply.set(true)
}

function showHint(s: State, line: number): void {
  const editor = s.editor
  if (s.hint) editor.removeContentWidget(s.hint)
  const model = editor.getModel()
  if (!model) return
  s.hint = {
    getId: () => 'ai.nextEdit.hint',
    getDomNode: () => s.hintEl,
    getPosition: () => ({ position: { lineNumber: line, column: model.getLineMaxColumn(line) }, preference: [monaco.editor.ContentWidgetPositionPreference.EXACT] })
  }
  editor.addContentWidget(s.hint)
}

function clearSuggestion(s: State): void {
  if (s.hint) s.editor.removeContentWidget(s.hint)
  s.hint = null
  s.marks.clear()
  if (s.zone) {
    const id = s.zone
    s.editor.changeViewZones((acc) => acc.removeZone(id))
    s.zone = null
  }
  s.sug?.track.clear()
  s.sug = null
  s.keyJump.set(false)
  s.keyApply.set(false)
}

function jump(s: State): void {
  const sug = s.sug
  const r = sug && targetRange(sug)
  if (!sug || !r) return clearSuggestion(s)
  const model = s.editor.getModel()!
  const line = r.startLineNumber
  const col = model.getLineFirstNonWhitespaceColumn(line) || 1
  s.editor.setPosition({ lineNumber: line, column: col })
  s.editor.revealLineInCenterIfOutsideViewport(line)
  enterApply(s)
}

function apply(s: State): void {
  const sug = s.sug
  const r = sug && targetRange(sug)
  if (!sug || !r) return clearSuggestion(s)
  const model = s.editor.getModel()!
  const range = new monaco.Range(r.startLineNumber, 1, r.endLineNumber, model.getLineMaxColumn(r.endLineNumber))
  const text = sug.replacement
  clearSuggestion(s)
  s.applying = true
  try {
    s.editor.pushUndoStop()
    s.editor.executeEdits('ai-next-edit', [{ range, text, forceMoveMarkers: true }])
    s.editor.pushUndoStop()
  } finally {
    s.applying = false
  }
  // 光标放到修改的末尾
  const endLine = range.startLineNumber + text.split('\n').length - 1
  s.editor.setPosition({ lineNumber: endLine, column: model.getLineMaxColumn(endLine) })
}

/* ---------------- 入口 ---------------- */

export function initNextEdit(): void {
  onEditor((editor) => {
    const s: State = {
      editor,
      prev: '',
      prevModel: null,
      bursts: [],
      current: null,
      reqSeq: 0,
      sug: null,
      hint: null,
      hintEl: h('div', { class: 'ai-nes-hint', role: 'note' }),
      zone: null,
      marks: editor.createDecorationsCollection(),
      keyJump: editor.createContextKey<boolean>('aiNesJump', false),
      keyApply: editor.createContextKey<boolean>('aiNesApply', false),
      applying: false
    }
    states.set(editor, s)
    const reset = () => {
      clearTimeout(s.timer)
      s.cancel?.()
      s.reqSeq++
      clearSuggestion(s)
      s.bursts = []
      s.current = null
      const m = editor.getModel()
      s.prevModel = trackable(m) ? m : null
      s.prev = s.prevModel ? s.prevModel.getValue(monaco.editor.EndOfLinePreference.LF) : ''
    }
    editor.onDidChangeModel(reset)
    editor.onDidChangeModelContent((e) => onChange(s, e))
    s.hintEl.addEventListener('mousedown', (e) => {
      e.preventDefault()
      if (s.sug?.phase === 'jump') jump(s)
      else if (s.sug?.phase === 'apply') apply(s)
    })
    const when = '!inlineSuggestionVisible && !suggestWidgetVisible && !inSnippetMode'
    editor.addCommand(monaco.KeyCode.Tab, () => jump(s), `aiNesJump && ${when}`)
    editor.addCommand(monaco.KeyCode.Tab, () => apply(s), `aiNesApply && ${when}`)
    editor.addCommand(monaco.KeyCode.Escape, () => clearSuggestion(s), 'aiNesJump || aiNesApply')
    reset()
  })
}

/** 设置里关掉时清掉所有编辑器上的预测 */
export function clearAllNextEdits(editors: Editor[]): void {
  for (const e of editors) {
    const s = states.get(e)
    if (s) clearSuggestion(s)
  }
}
