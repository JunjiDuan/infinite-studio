import type { AiMessage } from '../../../shared/ai'
import { monaco } from '../monaco'
import { h, toast } from '../dom'
import { t } from '../i18n'
import { getEditor, onEditor } from '../editor'
import { extractCode, modelLabel, streamChat } from './client'
import { editContext, withRules } from './context'

/**
 * Ctrl I 内联编辑 + 诊断旁的“用 AI 修复”。
 *
 * 选中一段代码（或把光标放在某行）按 Ctrl I，在代码上方输入要做的修改；生成的代码直接写进编辑器，
 * 新增的行标绿，删掉的行以红色显示在原位置（不占真实行），Ctrl Enter 接受、Esc 拒绝（恢复原文）。
 * 结果不满意时可以在输入框里继续提要求，会基于原文重新生成。
 *
 * AI 修复走同一套流程：选区是出问题的几行，指令是语言服务给出的错误信息，自动开始生成。
 */

type Editor = monaco.editor.IStandaloneCodeEditor
type Model = monaco.editor.ITextModel

/** replace：改写选中的行；insert：在空行处写新代码；after：在当前行后面插入新代码（当前行保持不变） */
type Mode = 'replace' | 'insert' | 'after'

interface Session {
  editor: Editor
  model: Model
  mode: Mode
  /** 改写前的原文（整行，不含最后的换行） */
  original: string
  /** 跟踪区域在文档里的位置（用户在别处编辑时会跟着移动） */
  track: monaco.editor.IEditorDecorationsCollection
  /** 新增行的高亮 */
  marks: monaco.editor.IEditorDecorationsCollection
  phase: 'prompt' | 'running' | 'review'
  /** 区域里现在是不是生成的代码（需要拒绝时恢复原文） */
  applied: boolean
  history: AiMessage[]
  cancel?: () => void
  widgetZone: string | null
  delZones: string[]
  overlay: monaco.editor.IOverlayWidget
  ui: {
    root: HTMLElement
    input: HTMLInputElement
    status: HTMLElement
    actions: HTMLElement
  }
  subs: monaco.IDisposable[]
}

const sessions = new WeakMap<Editor, Session>()
const reviewKeys = new WeakMap<Editor, monaco.editor.IContextKey<boolean>>()

/* ---------------- 行差异（最长公共子序列） ---------------- */

interface Hunk {
  /** 原文里被删掉的行 [aStart, aEnd) */
  aStart: number
  aEnd: number
  /** 新代码里新增的行 [bStart, bEnd) */
  bStart: number
  bEnd: number
}

function diffLines(a: string[], b: string[]): Hunk[] {
  let pre = 0
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++
  let suf = 0
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++
  const A = a.slice(pre, a.length - suf)
  const B = b.slice(pre, b.length - suf)
  const n = A.length
  const m = B.length
  if (!n && !m) return []
  // 太大时不细分：整块算一处修改
  if (!n || !m || n * m > 4_000_000) return [{ aStart: pre, aEnd: pre + n, bStart: pre, bEnd: pre + m }]
  const w = m + 1
  const L = new Uint32Array((n + 1) * w)
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      L[i * w + j] = A[i] === B[j] ? L[(i + 1) * w + j + 1] + 1 : Math.max(L[(i + 1) * w + j], L[i * w + j + 1])
    }
  }
  const hunks: Hunk[] = []
  let i = 0
  let j = 0
  let cur: Hunk | null = null
  const flush = () => {
    if (cur) hunks.push(cur)
    cur = null
  }
  while (i < n || j < m) {
    if (i < n && j < m && A[i] === B[j]) {
      flush()
      i++
      j++
    } else if (j < m && (i === n || L[i * w + j + 1] >= L[(i + 1) * w + j])) {
      cur ??= { aStart: pre + i, aEnd: pre + i, bStart: pre + j, bEnd: pre + j }
      cur.bEnd = pre + ++j
    } else {
      cur ??= { aStart: pre + i, aEnd: pre + i, bStart: pre + j, bEnd: pre + j }
      cur.aEnd = pre + ++i
    }
  }
  flush()
  return hunks
}

/* ---------------- 提示词 ---------------- */

const SYSTEM = [
  'You are an expert programmer embedded in a code editor.',
  'The user marks a region of a file and describes a change. Rewrite the region accordingly.',
  'Reply with the complete new code for the region in a single fenced code block and nothing else: no explanation before or after.',
  'Keep the indentation and style of the surrounding code, and never reproduce code that lies outside the region.',
  'If the region is empty, write the code that should be inserted there.'
].join(' ')

const START = '<<<REGION START>>>'
const END = '<<<REGION END>>>'

/** 文件内容（太长时只取区域附近），区域用标记行包起来 */
function buildPrompt(s: Session, instruction: string, related = ''): string {
  const { model } = s
  const r = regionRange(s)!
  const lines = model.getLinesContent()
  // after 模式：区域是当前行之后的空位置
  const regionStart = s.mode === 'after' ? r.endLineNumber : r.startLineNumber - 1
  const regionEnd = r.endLineNumber
  const region = s.mode === 'after' ? [] : lines.slice(regionStart, regionEnd)
  const from = Math.max(0, regionStart - 400)
  const to = Math.min(lines.length, regionEnd + 200)
  const lang = model.getLanguageId()
  const path = model.uri.scheme === 'file' ? model.uri.fsPath : 'notebook cell'
  return [
    `File: ${path} (${lang})`,
    '',
    `The file is shown below${from > 0 || to < lines.length ? ' (partially)' : ''}. The region to rewrite is between the lines ${START} and ${END}${region.length ? '' : ' (it is currently empty)'}.`,
    '',
    '```' + lang,
    ...lines.slice(from, regionStart),
    START,
    ...region,
    END,
    ...lines.slice(regionEnd, to),
    '```',
    '',
    ...(related ? ['Related code from elsewhere in the project (for reference only; do not reproduce it):', '', related, ''] : []),
    `Instruction: ${instruction}`
  ].join('\n')
}

/* ---------------- 区域 ---------------- */

function regionRange(s: Session): monaco.Range | null {
  const r = s.track.getRange(0)
  if (!r) return null
  return new monaco.Range(r.startLineNumber, 1, r.endLineNumber, s.model.getLineMaxColumn(r.endLineNumber))
}

function setRegion(s: Session, startLine: number, endLine: number): void {
  s.track.set([
    {
      range: new monaco.Range(startLine, 1, endLine, s.model.getLineMaxColumn(endLine)),
      options: { stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges }
    }
  ])
}

/** 把区域整体替换成 text，返回新区域的行范围 */
function writeRegion(s: Session, text: string): [number, number] | null {
  const r = regionRange(s)
  if (!r) return null
  s.editor.pushUndoStop()
  s.editor.executeEdits('ai-inline-edit', [{ range: r, text, forceMoveMarkers: true }])
  s.editor.pushUndoStop()
  const start = r.startLineNumber
  const end = start + text.split('\n').length - 1
  setRegion(s, start, end)
  return [start, end]
}

/* ---------------- 显示 ---------------- */

function clearDiff(s: Session): void {
  s.marks.clear()
  if (s.delZones.length) {
    s.editor.changeViewZones((acc) => s.delZones.forEach((id) => acc.removeZone(id)))
    s.delZones = []
  }
}

function showDiff(s: Session, before: string[], after: string[], startLine: number): { added: number; removed: number } {
  clearDiff(s)
  const hunks = diffLines(before, after)
  const font = s.editor.getOption(monaco.editor.EditorOption.fontInfo)
  const lineHeight = s.editor.getOption(monaco.editor.EditorOption.lineHeight)
  const decos: monaco.editor.IModelDeltaDecoration[] = []
  let added = 0
  let removed = 0
  s.editor.changeViewZones((acc) => {
    for (const hk of hunks) {
      if (hk.bEnd > hk.bStart) {
        added += hk.bEnd - hk.bStart
        decos.push({
          range: new monaco.Range(startLine + hk.bStart, 1, startLine + hk.bEnd - 1, 1),
          options: { isWholeLine: true, className: 'ai-add-line', linesDecorationsClassName: 'ai-add-gutter' }
        })
      }
      if (hk.aEnd > hk.aStart) {
        const del = before.slice(hk.aStart, hk.aEnd)
        removed += del.length
        const dom = h(
          'div',
          { class: 'ai-del-zone', style: { fontFamily: font.fontFamily, fontSize: `${font.fontSize}px`, lineHeight: `${lineHeight}px` } },
          ...del.map((l) => h('div', { class: 'ai-del-line' }, l || ' '))
        )
        s.delZones.push(acc.addZone({ afterLineNumber: startLine + hk.bStart - 1, heightInLines: del.length, domNode: dom, ordinal: 2 }))
      }
    }
  })
  s.marks.set(decos)
  return { added, removed }
}

function layoutOverlay(s: Session): void {
  const li = s.editor.getLayoutInfo()
  const left = li.contentLeft
  s.ui.root.style.left = `${left}px`
  s.ui.root.style.width = `${Math.max(240, Math.min(780, li.width - left - li.verticalScrollbarWidth - 24))}px`
}

function setStatus(s: Session, text: string, kind: '' | 'error' = ''): void {
  s.ui.status.textContent = text
  s.ui.status.dataset.kind = kind
}

function button(label: string, title: string, run: () => void, primary = false): HTMLButtonElement {
  return h(
    'button',
    {
      class: 'ai-edit-btn' + (primary ? ' primary' : ''),
      title,
      onMousedown: (e: MouseEvent) => e.preventDefault(),
      onClick: run
    },
    label
  )
}

function renderActions(s: Session): void {
  const a = s.ui.actions
  if (s.phase === 'running') {
    a.replaceChildren(button(t('停止'), t('停止生成 Esc'), () => stop(s)))
  } else if (s.phase === 'review') {
    a.replaceChildren(button(t('拒绝'), t('恢复原来的代码 Esc'), () => reject(s)), button(t('接受'), t('保留修改 Ctrl Enter'), () => accept(s), true))
  } else {
    a.replaceChildren(button('×', t('关闭 Esc'), () => reject(s)))
  }
  s.ui.input.disabled = s.phase === 'running'
  s.ui.input.placeholder =
    s.phase === 'review' ? t('继续提要求，例如“改成异步”，或 Ctrl Enter 接受') : s.mode === 'replace' ? t('描述要做的修改，例如“加上错误处理”') : t('描述要生成的代码，例如“写一个防抖函数”')
  reviewKeys.get(s.editor)?.set(s.phase === 'review')
}

/* ---------------- 流程 ---------------- */

function startSession(editor: Editor, mode: Mode, startLine: number, endLine: number): Session | null {
  const model = editor.getModel()
  if (!model) return null
  sessions.get(editor) && reject(sessions.get(editor)!)

  const input = h('input', { class: 'ai-edit-input', spellcheck: 'false', 'aria-label': t('AI 内联编辑指令') })
  const status = h('span', { class: 'ai-edit-status' })
  const actions = h('span', { class: 'ai-edit-actions' })
  const root = h(
    'div',
    { class: 'ai-edit-widget' },
    h('span', { class: 'ai-edit-mark', 'aria-hidden': 'true' }, '✦'),
    input,
    status,
    h('span', { class: 'ai-edit-model', title: t('在设置里更换模型') }, modelLabel('edit')),
    actions
  )
  const overlay: monaco.editor.IOverlayWidget = {
    getId: () => 'ai.inlineEdit.widget',
    getDomNode: () => root,
    getPosition: () => null
  }

  const s: Session = {
    editor,
    model,
    mode,
    original: model.getValueInRange(new monaco.Range(startLine, 1, endLine, model.getLineMaxColumn(endLine))),
    track: editor.createDecorationsCollection(),
    marks: editor.createDecorationsCollection(),
    phase: 'prompt',
    applied: false,
    history: [],
    widgetZone: null,
    delZones: [],
    overlay,
    ui: { root, input, status, actions },
    subs: []
  }
  setRegion(s, startLine, endLine)
  sessions.set(editor, s)

  // 输入框里的按键不交给编辑器处理
  root.addEventListener('keydown', (e) => {
    const ctrl = e.ctrlKey || e.metaKey
    if (e.key === 'Enter' && ctrl && s.phase === 'review') accept(s)
    else if (e.key === 'Enter' && !ctrl && !e.isComposing && e.target === input) {
      const text = input.value.trim()
      if (text) void run(s, text)
    } else if (e.key === 'Escape') {
      if (s.phase === 'running') stop(s)
      else reject(s)
    } else if (!(ctrl && ['s', 'k', 'p', ',', '.', 'b', '`'].includes(e.key.toLowerCase()))) {
      // 全局快捷键（保存、命令面板等）照常；其他按键留在输入框里
      e.stopPropagation()
      return
    } else return
    e.preventDefault()
    e.stopPropagation()
  })
  root.addEventListener('mousedown', (e) => e.stopPropagation())

  editor.addOverlayWidget(overlay)
  editor.changeViewZones((acc) => {
    s.widgetZone = acc.addZone({
      afterLineNumber: startLine - 1,
      heightInPx: 46,
      domNode: h('div'),
      ordinal: 1,
      onDomNodeTop: (top) => (root.style.top = `${top + 4}px`)
    })
  })
  layoutOverlay(s)
  s.subs.push(
    editor.onDidLayoutChange(() => layoutOverlay(s)),
    // 换了文件：保留已经写进去的修改（可以撤销），收起界面
    editor.onDidChangeModel(() => finish(s)),
    model.onWillDispose(() => finish(s))
  )
  renderActions(s)
  editor.revealLineInCenterIfOutsideViewport(startLine)
  requestAnimationFrame(() => input.focus())
  return s
}

async function run(s: Session, instruction: string): Promise<void> {
  if (s.phase === 'running') return
  // 继续修改：先恢复原文，再带上之前的对话重新生成
  if (s.applied) restoreOriginal(s)
  s.phase = 'running'
  s.ui.input.value = instruction
  renderActions(s)
  setStatus(s, s.history.length ? t('正在生成…') : t('正在收集上下文…'))
  // 收集上下文期间按 Esc / 停止：不再发请求
  let stopped = false
  s.cancel = () => (stopped = true)
  const halted = (): boolean => {
    if (sessions.get(s.editor) !== s) return true
    if (!stopped) return false
    s.cancel = undefined
    s.phase = s.history.length ? 'review' : 'prompt'
    if (s.history.length) applyLast(s)
    renderActions(s)
    setStatus(s, t('已停止'))
    return true
  }
  let content: string
  if (s.history.length) {
    content = `Further change: ${instruction}\nReply again with the complete new code for the region (relative to the original shown before) in one fenced code block.`
  } else {
    const r = regionRange(s)
    const related = r ? await editContext(s.model, r.startLineNumber, r.endLineNumber, instruction).catch(() => '') : ''
    if (halted()) return
    content = buildPrompt(s, instruction, related)
  }
  const system = await withRules(SYSTEM)
  if (halted()) return
  const messages: AiMessage[] = [...s.history, { role: 'user', content }]
  setStatus(s, t('正在生成…'))
  let reply = ''
  const req = streamChat({ system, messages }, (text) => {
    reply += text
    const n = extractCode(reply).split('\n').length
    setStatus(s, t('正在生成… {0} 行', n))
  })
  s.cancel = req.cancel
  const r = await req.done
  s.cancel = undefined
  if (sessions.get(s.editor) !== s) return
  if (!r.ok) {
    s.phase = s.history.length ? 'review' : 'prompt'
    if (s.history.length) applyLast(s)
    renderActions(s)
    setStatus(s, r.cancelled ? t('已停止') : r.error, r.cancelled ? '' : 'error')
    s.ui.input.focus()
    return
  }
  let code = extractCode(r.text).replace(/\r\n/g, '\n').replace(/\n+$/, '')
  if (s.mode === 'after') code = s.original + '\n' + code
  s.history = [...messages, { role: 'assistant', content: r.text }]
  applyCode(s, code)
}

/** 最近一次生成的代码（继续修改失败时恢复显示） */
const lastCode = new WeakMap<Session, string>()

function applyLast(s: Session): void {
  const code = lastCode.get(s)
  if (code !== undefined) applyCode(s, code)
}

function applyCode(s: Session, code: string): void {
  lastCode.set(s, code)
  const range = writeRegion(s, code)
  if (!range) return finish(s)
  s.applied = true
  s.phase = 'review'
  const stat = showDiff(s, s.original.split('\n'), code.split('\n'), range[0])
  renderActions(s)
  s.ui.input.value = ''
  setStatus(s, stat.added || stat.removed ? `+${stat.added} −${stat.removed}` : t('没有修改'))
  s.editor.revealLinesInCenterIfOutsideViewport(range[0], range[1])
  s.ui.input.focus()
}

function restoreOriginal(s: Session): void {
  clearDiff(s)
  if (s.applied && !s.model.isDisposed()) writeRegion(s, s.original)
  s.applied = false
}

function stop(s: Session): void {
  s.cancel?.()
}

function accept(s: Session): void {
  finish(s)
  s.editor.focus()
}

function reject(s: Session): void {
  s.cancel?.()
  restoreOriginal(s)
  finish(s)
  s.editor.focus()
}

/** 收起界面（区域里的内容保持现状） */
function finish(s: Session): void {
  if (sessions.get(s.editor) !== s) return
  sessions.delete(s.editor)
  s.cancel?.()
  s.subs.forEach((d) => d.dispose())
  clearDiff(s)
  s.track.clear()
  if (s.widgetZone) s.editor.changeViewZones((acc) => acc.removeZone(s.widgetZone!))
  s.editor.removeOverlayWidget(s.overlay)
  reviewKeys.get(s.editor)?.set(false)
}

/* ---------------- 入口 ---------------- */

/** Ctrl I：选中的行（或当前行）上方打开指令框 */
export function inlineEdit(editor: Editor | null = getEditor()): void {
  const model = editor?.getModel()
  if (!editor || !model || editor.getOption(monaco.editor.EditorOption.readOnly)) return
  const sel = editor.getSelection()
  if (!sel) return
  if (!sel.isEmpty()) {
    // 选区结束在某行开头时不算那一行
    const end = sel.endColumn === 1 && sel.endLineNumber > sel.startLineNumber ? sel.endLineNumber - 1 : sel.endLineNumber
    startSession(editor, 'replace', sel.startLineNumber, end)
    return
  }
  const line = sel.positionLineNumber
  startSession(editor, model.getLineContent(line).trim() ? 'after' : 'insert', line, line)
}

/** 用 AI 修复一组诊断（同一个文件里相邻的几处问题） */
export function fixMarkers(editor: Editor, markers: monaco.editor.IMarkerData[]): void {
  const model = editor.getModel()
  if (!model || !markers.length) return
  const first = Math.min(...markers.map((m) => m.startLineNumber))
  const last = Math.max(...markers.map((m) => m.endLineNumber))
  const start = Math.max(1, first - 2)
  const end = Math.min(model.getLineCount(), last + 2)
  const s = startSession(editor, 'replace', start, end)
  if (!s) return
  const problems = markers
    .slice(0, 8)
    .map((m) => `- Line ${m.startLineNumber} (\`${model.getLineContent(m.startLineNumber).trim().slice(0, 160)}\`): ${m.source ? `[${m.source}] ` : ''}${m.message}`)
    .join('\n')
  const instruction = `Fix the following problem(s) reported by the language server, changing as little as possible:\n${problems}`
  void run(s, instruction).then(() => {
    // 输入框里显示简短的说明，而不是完整的英文指令
    if (sessions.get(editor) === s && s.phase === 'review') s.ui.input.placeholder = t('继续提要求，或 Ctrl Enter 接受修复')
  })
  s.ui.input.value = t('修复：{0}', markers[0].message.split('\n')[0])
}

/**
 * 在指定的几行上开一个内联编辑并直接开始生成（终端报错修复、调试助手用）。
 * label 是输入框里显示的简短说明；instruction 是发给模型的完整要求。
 */
export function fixRegion(editor: Editor, startLine: number, endLine: number, instruction: string, label: string): void {
  const model = editor.getModel()
  if (!model) return
  const start = Math.max(1, Math.min(startLine, model.getLineCount()))
  const end = Math.max(start, Math.min(endLine, model.getLineCount()))
  const s = startSession(editor, 'replace', start, end)
  if (!s) return
  void run(s, instruction).then(() => {
    if (sessions.get(editor) === s && s.phase === 'review') s.ui.input.placeholder = t('继续提要求，或 Ctrl Enter 接受修复')
  })
  s.ui.input.value = label
}

/** 编辑器里是否有正在进行的内联编辑（下一处编辑预测要让开） */
export function hasInlineEdit(editor: Editor): boolean {
  return sessions.has(editor)
}

const FIX_COMMAND = 'infinite.ai.fixMarkers'

function markersAt(model: Model, line: number): monaco.editor.IMarker[] {
  return monaco.editor
    .getModelMarkers({ resource: model.uri })
    .filter((m) => m.severity >= monaco.MarkerSeverity.Warning && m.startLineNumber <= line && m.endLineNumber >= line)
}

export function initInlineEdit(): void {
  // 快速修复菜单（Alt Enter）里的“用 AI 修复”
  monaco.languages.registerCodeActionProvider('*', {
    provideCodeActions(model, _range, context) {
      const markers = context.markers.filter((m) => m.severity >= monaco.MarkerSeverity.Warning)
      if (!markers.length || (model.uri.scheme !== 'file' && model.uri.scheme !== 'nbcell')) return { actions: [], dispose() {} }
      return {
        actions: [
          {
            title: t('用 AI 修复'),
            kind: 'quickfix',
            diagnostics: markers,
            command: { id: FIX_COMMAND, title: t('用 AI 修复'), arguments: [model.uri.toString(), markers] }
          }
        ],
        dispose() {}
      }
    }
  })
  monaco.editor.registerCommand(FIX_COMMAND, (_acc, uri: string, markers: monaco.editor.IMarkerData[]) => {
    const editor = getEditor()
    if (editor?.getModel()?.uri.toString() !== uri) return toast(t('请先切换到这个文件'))
    fixMarkers(editor, markers)
  })

  onEditor((editor) => {
    const key = editor.createContextKey<boolean>('aiInlineEditReview', false)
    reviewKeys.set(editor, key)
    editor.addAction({
      id: 'infinite.ai.inlineEdit',
      label: t('AI 内联编辑'),
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyI],
      contextMenuGroupId: '0_ai',
      contextMenuOrder: 1,
      run: (ed) => inlineEdit(ed as Editor)
    })
    editor.addAction({
      id: 'infinite.ai.fixHere',
      label: t('用 AI 修复此处的问题'),
      contextMenuGroupId: '0_ai',
      contextMenuOrder: 2,
      run: (ed) => {
        const m = ed.getModel()
        const pos = ed.getPosition()
        if (!m || !pos) return
        const list = markersAt(m, pos.lineNumber)
        if (!list.length) return toast(t('光标所在行没有错误或警告'))
        fixMarkers(ed as Editor, list)
      }
    })
    // Ctrl . 是专注模式，快速修复（含“用 AI 修复”）改用 Alt Enter
    editor.addCommand(monaco.KeyMod.Alt | monaco.KeyCode.Enter, () => editor.trigger('keyboard', 'editor.action.quickFix', null))
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => {
      const s = sessions.get(editor)
      if (s) accept(s)
    }, 'aiInlineEditReview')
    editor.addCommand(monaco.KeyCode.Escape, () => {
      const s = sessions.get(editor)
      if (s) reject(s)
    }, 'aiInlineEditReview')
  })
}
