import type { IdeToolResult } from '../../shared/ide'
import { SEVERITIES } from '../../shared/ide'
import { basename, h, toast } from './dom'
import { closeView, editorSelection, findTab, isDirty, normPath, onSelection, openFile, openView, reloadFromDisk, samePath, saveTab } from './editor'
import { isChecked, probeFile, refreshProbe } from './lsp'
import { languageFor, monaco } from './monaco'
import { on, state } from './store'
import { t } from './i18n'

/**
 * IDE 桥接的界面端：执行终端里 claude 调用的工具（openDiff / getDiagnostics / close_tab / closeAllDiffTabs），
 * 推送编辑器选区，并给内置对话面板提供诊断和“改文件前后对比诊断”的钩子。
 * 行为照 VS Code 扩展实现。
 */

type Severity = (typeof SEVERITIES)[number]

export interface FileDiagnostic {
  message: string
  severity: Severity
  /** 0 起始，和 VS Code 的 Range 一致 */
  range: { start: { line: number; character: number }; end: { line: number; character: number } }
  source?: string
  code?: string
}

export interface FileDiagnostics {
  uri: string
  linesInFile?: number
  diagnostics: FileDiagnostic[]
}

/* ---------------- 诊断 ---------------- */

function severityOf(s: monaco.MarkerSeverity): Severity {
  return s === monaco.MarkerSeverity.Error ? 'Error' : s === monaco.MarkerSeverity.Warning ? 'Warning' : s === monaco.MarkerSeverity.Info ? 'Information' : 'Hint'
}

function toDiagnostic(m: monaco.editor.IMarker): FileDiagnostic {
  return {
    message: m.message,
    severity: severityOf(m.severity),
    range: { start: { line: m.startLineNumber - 1, character: m.startColumn - 1 }, end: { line: m.endLineNumber - 1, character: m.endColumn - 1 } },
    source: m.source || undefined,
    code: m.code == null ? undefined : typeof m.code === 'string' ? m.code : m.code.value
  }
}

/** file:// URI 或普通路径 → 规范化的本地路径 */
function toPath(uriOrPath: string): string {
  const s = uriOrPath.trim()
  return normPath(/^file:/i.test(s) ? monaco.Uri.parse(s).fsPath : s)
}

const uriString = (path: string) => monaco.Uri.file(path).toString(true)

/** 和 VS Code 的 languages.getDiagnostics 一样：给 uri 时返回这个文件（即使没有诊断），否则返回所有有诊断的文件 */
export function getDiagnostics(uri?: string): FileDiagnostics[] {
  const all = monaco.editor.getModelMarkers({}).filter((m) => m.resource.scheme === 'file')
  if (uri) {
    const path = toPath(uri)
    const model = monaco.editor.getModels().find((m) => m.uri.scheme === 'file' && samePath(m.uri.fsPath, path))
    return [
      {
        uri: uriString(path),
        linesInFile: model?.getLineCount(),
        diagnostics: all.filter((m) => samePath(normPath(m.resource.fsPath), path)).map(toDiagnostic)
      }
    ]
  }
  const byFile = new Map<string, monaco.editor.IMarker[]>()
  for (const m of all) {
    const k = m.resource.toString()
    byFile.set(k, [...(byFile.get(k) ?? []), m])
  }
  return [...byFile.values()].map((ms) => ({
    uri: ms[0].resource.toString(true),
    linesInFile: monaco.editor.getModel(ms[0].resource)?.getLineCount(),
    diagnostics: ms.map(toDiagnostic)
  }))
}

/** 面板版 getDiagnostics：支持 minSeverity，不给 uri 时去掉过滤后为空的文件 */
export function panelDiagnostics(uri?: string, minSeverity?: string): FileDiagnostics[] {
  const max = SEVERITIES.indexOf((minSeverity as Severity) ?? 'Hint')
  const limit = max < 0 ? SEVERITIES.length - 1 : max
  const list = getDiagnostics(uri).map((f) => ({ ...f, diagnostics: f.diagnostics.filter((d) => SEVERITIES.indexOf(d.severity) <= limit) }))
  return uri ? list : list.filter((f) => f.diagnostics.length > 0)
}

/* ---------------- openDiff：在编辑器里对比，由你接受 / 拒绝 ---------------- */

interface DiffSession {
  tabName: string
  el: HTMLElement
  callId: number | null
  /** 给出答案（只生效一次） */
  finish: (r: IdeToolResult | null) => void
}

const diffs = new Map<string, DiffSession>()

const answer = (status: string, detail: string): IdeToolResult => ({
  content: [
    { type: 'text', text: status },
    { type: 'text', text: detail }
  ]
})

async function readDisk(path: string): Promise<string> {
  const r = await window.api.fs.readFile(path)
  return r.ok ? r.content : ''
}

function openDiff(callId: number, args: Record<string, unknown>): Promise<IdeToolResult> {
  const oldPath = toPath(String(args.old_file_path ?? ''))
  const newPath = toPath(String(args.new_file_path ?? oldPath))
  const contents = typeof args.new_file_contents === 'string' ? args.new_file_contents : ''
  const tabName = String(args.tab_name ?? basename(newPath))

  return new Promise((resolve) => {
    // 同名的旧对比视为拒绝，换成新的
    diffs.get(tabName)?.finish(answer('DIFF_REJECTED', tabName))

    let done = false
    let editor: monaco.editor.IStandaloneDiffEditor | null = null
    let original: monaco.editor.ITextModel | null = null
    let modified: monaco.editor.ITextModel | null = null

    const finish = (r: IdeToolResult | null) => {
      if (done) return
      done = true
      if (diffs.get(tabName) === session) diffs.delete(tabName)
      if (r) resolve(r)
      closeView(el)
    }
    const accept = () => finish(answer('FILE_SAVED', modified?.getValue() ?? contents))
    const reject = () => finish(answer('DIFF_REJECTED', tabName))

    const host = h('div', { class: 'diffview-editor' })
    const el: HTMLElement = h(
      'div',
      { class: 'diffview' },
      h(
        'div',
        { class: 'diffview-bar' },
        h('span', { class: 'diffview-title', title: newPath }, newPath),
        h('span', { class: 'diffview-hint' }, t('Claude 建议的修改 · 右侧可以直接改')),
        h('span', { class: 'grow' }),
        h('button', { class: 'btn small', onClick: () => void openFile(newPath) }, t('打开文件')),
        h('button', { class: 'btn small', title: t('拒绝这次修改'), onClick: reject }, t('拒绝')),
        h('button', { class: 'btn small primary', title: t('接受修改（Ctrl S）'), onClick: accept }, t('接受'))
      ),
      host
    )
    const session: DiffSession = { tabName, el, callId, finish }
    diffs.set(tabName, session)

    void (async () => {
      // 左边是磁盘上的内容（编辑器里有未保存的修改时也以磁盘为准，和 VS Code 一致）
      const before = await readDisk(oldPath)
      if (done) return
      const lang = languageFor(newPath)
      original = monaco.editor.createModel(before, lang)
      modified = monaco.editor.createModel(contents, lang)
      openView({
        key: 'ide-diff:' + tabName,
        title: tabName,
        kind: 'diff',
        el,
        onShow: () => {
          if (editor || !original || !modified) return
          editor = monaco.editor.createDiffEditor(host, {
            automaticLayout: true,
            originalEditable: false,
            readOnly: false,
            renderSideBySide: true,
            minimap: { enabled: false },
            scrollBeyondLastLine: false
          })
          editor.setModel({ original, modified })
          const right = editor.getModifiedEditor()
          right.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, accept)
          // 定位到第一处修改
          const sub = editor.onDidUpdateDiff(() => {
            sub.dispose()
            const first = editor?.getLineChanges()?.[0]
            if (first) right.revealLineInCenter(Math.max(1, first.modifiedStartLineNumber))
          })
          right.focus()
        },
        onClose: () => {
          // 关掉标签页 = 拒绝
          if (!done) {
            done = true
            if (diffs.get(tabName) === session) diffs.delete(tabName)
            resolve(answer('DIFF_REJECTED', tabName))
          }
          editor?.dispose()
          original?.dispose()
          modified?.dispose()
        }
      })
    })()
  })
}

function closeDiffTab(tabName: string): boolean {
  const s = diffs.get(tabName)
  if (!s) return false
  s.finish(answer('DIFF_REJECTED', tabName))
  return true
}

function closeAllDiffs(): number {
  const all = [...diffs.values()]
  for (const s of all) s.finish(answer('DIFF_REJECTED', s.tabName))
  return all.length
}

/* ---------------- 工具调用 ---------------- */

const text = (t: string): IdeToolResult => ({ content: [{ type: 'text', text: t }] })

async function runTool(callId: number, tool: string, args: Record<string, unknown>): Promise<IdeToolResult> {
  switch (tool) {
    case 'openDiff':
      return openDiff(callId, args)
    case 'getDiagnostics':
      return text(JSON.stringify(getDiagnostics(typeof args.uri === 'string' && args.uri ? args.uri : undefined), null, 2))
    case 'close_tab':
      closeDiffTab(String(args.tab_name ?? ''))
      return text('TAB_CLOSED')
    case 'closeAllDiffTabs':
      return text(`CLOSED_${closeAllDiffs()}_DIFF_TABS`)
    default:
      return { error: `Tool ${tool} not found` }
  }
}

/* ---------------- 连接状态、选区、工作区 ---------------- */

let connected = false

export function ideConnected(): boolean {
  return connected
}

function selectionPayload(): Record<string, unknown> | null {
  const s = editorSelection()
  if (!s) return null
  const sel = s.selection
  return {
    text: s.text,
    filePath: s.path,
    fileUrl: monaco.Uri.file(s.path).toString(),
    selection: {
      start: { line: sel.startLineNumber - 1, character: sel.startColumn - 1 },
      end: { line: sel.endLineNumber - 1, character: sel.endColumn - 1 },
      isEmpty: sel.isEmpty()
    }
  }
}

let selTimer: ReturnType<typeof setTimeout> | undefined
let lastSel = ''
function pushSelection(): void {
  clearTimeout(selTimer)
  // 和 VS Code 扩展一样，停下 300ms 再推送
  selTimer = setTimeout(() => {
    if (state.settings.agentContext === false) return
    const p = selectionPayload()
    if (!p) return
    const key = JSON.stringify(p)
    if (key === lastSel) return
    lastSel = key
    window.api.ide.selection(p)
  }, 300)
}

/** Ctrl Alt K：把当前文件 / 选中行作为 @引用发给终端里的 claude；没有连接时返回 false */
export async function sendAtMention(): Promise<boolean> {
  const s = editorSelection()
  if (!s) return false
  const params: Record<string, unknown> = { filePath: s.path }
  if (!s.selection.isEmpty()) {
    const sel = s.selection
    // 选到下一行行首时不算那一行（VS Code 的做法）
    const end = sel.endColumn === 1 && sel.endLineNumber > sel.startLineNumber ? sel.endLineNumber - 1 : sel.endLineNumber
    params.lineStart = sel.startLineNumber - 1
    params.lineEnd = end - 1
  }
  return window.api.ide.atMention(params)
}

export function initIde(): void {
  window.api.ide.onCall((id, tool, args) => {
    runTool(id, tool, args ?? {})
      .then((r) => window.api.ide.result(id, r))
      .catch((e) => window.api.ide.result(id, { error: String((e as Error)?.message ?? e) }))
  })
  window.api.ide.onCancel((id) => {
    // claude 不再等这个结果（例如在终端里回答了授权）：关掉对应的对比标签
    for (const s of diffs.values()) if (s.callId === id) s.finish(null)
  })
  window.api.ide.onStatus((c) => {
    if (c && !connected) toast(t('终端里的 Claude Code 已连接到编辑器'))
    connected = c
    if (c) {
      lastSel = ''
      pushSelection()
    }
  })
  onSelection(pushSelection)
  on('tabs', pushSelection)
  const syncWorkspace = () => window.api.ide.setWorkspace(state.root ? [state.root] : [])
  on('root', syncWorkspace)
  syncWorkspace()
  window.api.ide.register()
}

/* ---------------- 内置面板的钩子：改文件前后对比诊断（照 VS Code 扩展的 DiagnosticTracking） ---------------- */

/** 后台检查的文件：一段时间不用就交还 */
const held = new Map<string, { release: () => void; timer: ReturnType<typeof setTimeout> }>()
const HOLD_MS = 3 * 60_000

async function hold(path: string): Promise<boolean> {
  const key = path.toLowerCase()
  const h0 = held.get(key)
  if (h0) {
    clearTimeout(h0.timer)
    h0.timer = setTimeout(() => drop(key), HOLD_MS)
    return false
  }
  const release = await probeFile(path)
  if (!release) return false
  held.set(key, { release, timer: setTimeout(() => drop(key), HOLD_MS) })
  return true
}

function drop(key: string): void {
  const h0 = held.get(key)
  if (!h0) return
  held.delete(key)
  clearTimeout(h0.timer)
  h0.release()
}

function modelOf(path: string): monaco.editor.ITextModel | null {
  return monaco.editor.getModels().find((m) => m.uri.scheme === 'file' && samePath(m.uri.fsPath, path)) ?? null
}

/** 等这个文件的诊断更新：收到更新后再安静 quiet 毫秒；一直没有更新则在 idle 毫秒后放弃；最多等 cap 毫秒 */
function waitMarkers(path: string, opts: { idle: number; quiet: number; cap: number }): Promise<'update' | 'no-update' | 'cap'> {
  return new Promise((resolve) => {
    let quietTimer: ReturnType<typeof setTimeout> | undefined
    const finish = (r: 'update' | 'no-update' | 'cap') => {
      sub.dispose()
      clearTimeout(quietTimer)
      clearTimeout(idleTimer)
      clearTimeout(capTimer)
      resolve(r)
    }
    const sub = monaco.editor.onDidChangeMarkers((uris) => {
      if (!uris.some((u) => u.scheme === 'file' && samePath(u.fsPath, path))) return
      clearTimeout(idleTimer)
      clearTimeout(quietTimer)
      quietTimer = setTimeout(() => finish('update'), opts.quiet)
    })
    const idleTimer = setTimeout(() => finish('no-update'), opts.idle)
    const capTimer = setTimeout(() => finish('cap'), opts.cap)
  })
}

const baselines = new Map<string, FileDiagnostics[]>()

function hookPath(input: Record<string, unknown>): string | null {
  const p = (input.tool_input as Record<string, unknown> | undefined)?.file_path
  if (typeof p !== 'string' || !p || /^file:/i.test(p)) return null
  return normPath(p)
}

/** PreToolUse（Edit / Write / MultiEdit）：记下修改前的诊断 */
export async function captureBaseline(input: Record<string, unknown>): Promise<Record<string, unknown>> {
  try {
    const path = hookPath(input)
    if (!path) return { continue: true }
    const fresh = await hold(path)
    const model = modelOf(path)
    // 刚交给语言服务的文件，先等第一次诊断出来，否则原有的问题都会被当成“新出现的”
    if (fresh && model && isChecked(model)) await waitMarkers(path, { idle: 3000, quiet: 400, cap: 6000 })
    baselines.set(path.toLowerCase(), getDiagnostics(path))
  } catch {
    /* 诊断只是锦上添花，出错不影响 Claude 改文件 */
  }
  return { continue: true }
}

/** PreToolUse（Edit / Write / Read）：编辑器里有未保存的修改时先保存，Claude 读到的才是最新内容 */
export async function saveIfDirty(input: Record<string, unknown>): Promise<Record<string, unknown>> {
  try {
    const path = hookPath(input)
    const t = path ? findTab(path) : undefined
    if (t && isDirty(t)) await saveTab(t, true)
  } catch {
    /* 忽略 */
  }
  return { continue: true }
}

function sameDiag(a: FileDiagnostic, b: FileDiagnostic, shift: number): boolean {
  return (
    a.message === b.message &&
    a.severity === b.severity &&
    a.source === b.source &&
    a.code === b.code &&
    Math.abs(a.range.start.line - b.range.start.line) <= shift &&
    Math.abs(a.range.end.line - b.range.end.line) <= shift &&
    a.range.start.character === b.range.start.character &&
    a.range.end.character === b.range.end.character
  )
}

/** PostToolUse（Edit / Write / MultiEdit）：等语言服务重新检查，把新出现的诊断作为附加上下文交给 Claude */
export async function findNewDiagnostics(input: Record<string, unknown>): Promise<Record<string, unknown>> {
  try {
    const path = hookPath(input)
    if (!path) return { continue: true }
    const key = path.toLowerCase()
    const before = baselines.get(key) ?? []
    baselines.delete(key)
    await hold(path)
    const model = modelOf(path)
    if (!model || !isChecked(model)) return { continue: true }
    // 不等文件监视：立刻把磁盘上的新内容读进编辑器，语言服务马上开始检查
    const changed = findTab(path) ? (await reloadFromDisk(path), true) : await refreshProbe(path)
    if (changed !== false) await waitMarkers(path, { idle: 2500, quiet: 500, cap: 8000 })
    const after = getDiagnostics(path)
    const fresh: (FileDiagnostic & { filePath: string })[] = []
    for (const f of after) {
      const old = before.find((b) => b.uri === f.uri)
      const shift = old?.linesInFile !== undefined && f.linesInFile !== undefined ? Math.abs(old.linesInFile - f.linesInFile) : 0
      for (const d of f.diagnostics) if (!old?.diagnostics.some((o) => sameDiag(d, o, shift))) fresh.push({ ...d, filePath: path })
    }
    if (!fresh.length) return { continue: true }
    const summary = fresh.map((d) => ({
      filePath: d.filePath,
      line: d.range.start.line + 1,
      column: d.range.start.character + 1,
      message: d.message,
      code: d.code ?? '',
      severity: d.severity
    }))
    return {
      continue: true,
      hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: `<ide_diagnostics>${JSON.stringify(summary, null, 2)}</ide_diagnostics>` }
    }
  } catch {
    return { continue: true }
  }
}
