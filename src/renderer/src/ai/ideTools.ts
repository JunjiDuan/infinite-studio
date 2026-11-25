import { activeTab, editorSelection, isDirty, normPath, recentFiles, samePath, tabs } from '../editor'
import { languageFor, monaco } from '../monaco'
import { lspRequestFor, probeFile } from '../lsp'
import { terminalOutputs } from '../panel'
import { state } from '../store'
import { resolvePath } from '../agent/markdown'
import { indexSnippets, relPath } from './context'

/**
 * 给 AI 对话用的 IDE 工具（MCP 服务 infinite-studio）：编辑器状态、语言服务的跳转 / 引用 / 类型、
 * 项目索引检索、git diff、终端输出、运行测试。定义在 shared/ide.ts 的 PANEL_TOOLS。
 */

// LSP 结构多变，按 JSON 处理
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any

interface ToolResult {
  content: { type: 'text'; text: string }[]
  isError?: boolean
}

const ok = (v: unknown): ToolResult => ({ content: [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v, null, 1) }] })
const err = (msg: string): ToolResult => ({ content: [{ type: 'text', text: msg }], isError: true })

const SYMBOL_KINDS = [
  '', 'File', 'Module', 'Namespace', 'Package', 'Class', 'Method', 'Property', 'Field', 'Constructor', 'Enum', 'Interface', 'Function', 'Variable', 'Constant',
  'String', 'Number', 'Boolean', 'Array', 'Object', 'Key', 'Null', 'EnumMember', 'Struct', 'Event', 'Operator', 'TypeParameter'
]

function absPath(p: unknown): string | null {
  if (typeof p !== 'string' || !p.trim()) return null
  const raw = p.trim().replace(/^file:\/\//, '')
  return normPath(/^file:/.test(p) ? monaco.Uri.parse(p).fsPath : resolvePath(raw))
}

/** 打开（或后台载入）文件交给语言服务，算出位置；release 用完必须调用 */
async function locate(args: Record<string, unknown>): Promise<{ model: monaco.editor.ITextModel; pos: monaco.IPosition; release: () => void } | string> {
  const path = absPath(args.path)
  if (!path) return 'Missing `path`.'
  const release = await probeFile(path)
  if (!release) return `Cannot read ${path}.`
  const model = monaco.editor.getModels().find((m) => m.uri.scheme === 'file' && samePath(m.uri.fsPath, path))
  if (!model) {
    release()
    return `Cannot open ${path}.`
  }
  const line = Math.max(1, Math.min(model.getLineCount(), Math.floor(Number(args.line) || 1)))
  const text = model.getLineContent(line)
  let column = Math.floor(Number(args.column) || 0)
  const symbol = typeof args.symbol === 'string' ? args.symbol.trim() : ''
  if (symbol) {
    const re = new RegExp(`(^|[^\\w$])${symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w$])`)
    const m = re.exec(text)
    if (m) column = m.index + m[1].length + 1
    else if (!column) {
      release()
      return `Symbol "${symbol}" not found on line ${line} of ${relPath(path)}: ${text.trim().slice(0, 200)}`
    }
  }
  if (!column) column = model.getLineFirstNonWhitespaceColumn(line) || 1
  return { model, pos: { lineNumber: line, column }, release }
}

async function lines(path: string): Promise<string[] | null> {
  const m = monaco.editor.getModels().find((x) => x.uri.scheme === 'file' && samePath(x.uri.fsPath, path))
  if (m) return m.getLinesContent()
  const r = await window.api.fs.readFile(path).catch(() => null)
  return r?.ok ? r.content.split(/\r?\n/) : null
}

/** LSP Location / LocationLink 列表 → 路径、行列、该行文字（可带上下几行） */
async function locations(r: Json, context = 0, max = 200): Promise<{ path: string; line: number; column: number; text: string }[]> {
  const list: Json[] = Array.isArray(r) ? r : r ? [r] : []
  const out: { path: string; line: number; column: number; text: string }[] = []
  const cache = new Map<string, string[] | null>()
  for (const l of list.slice(0, max)) {
    const uri: string = l.targetUri ?? l.uri
    const range = l.targetSelectionRange ?? l.targetRange ?? l.range
    if (!uri || !range) continue
    const path = uri.startsWith('file:') ? normPath(monaco.Uri.parse(uri).fsPath) : uri
    if (!cache.has(path)) cache.set(path, uri.startsWith('file:') ? await lines(path) : null)
    const ls = cache.get(path)
    const line = range.start.line + 1
    const text = ls ? ls.slice(Math.max(0, line - 1 - context), line + context).join('\n') : ''
    out.push({ path: relPath(path), line, column: range.start.character + 1, text })
  }
  return out
}

function hoverText(r: Json): string {
  const c = r?.contents
  if (!c) return ''
  const one = (x: Json): string => (typeof x === 'string' ? x : x?.language ? '```' + x.language + '\n' + x.value + '\n```' : (x?.value ?? ''))
  return Array.isArray(c) ? c.map(one).join('\n\n') : one(c)
}

function flattenSymbols(list: Json[], depth = 0, out: string[] = []): string[] {
  for (const s of list) {
    const range = s.range ?? s.location?.range
    const kind = SYMBOL_KINDS[s.kind] ?? ''
    out.push(`${'  '.repeat(depth)}${kind} ${s.name}${s.detail ? ` — ${s.detail}` : ''}  (lines ${range ? `${range.start.line + 1}-${range.end.line + 1}` : '?'})`)
    if (Array.isArray(s.children) && depth < 4) flattenSymbols(s.children, depth + 1, out)
  }
  return out
}

const NO_LSP = 'No language server is available for this file (or it did not answer). Fall back to text search.'

/** 自己的工具；不是 IDE 工具时返回 null */
export async function callIdeTool(name: string, args: Record<string, unknown>): Promise<ToolResult | null> {
  switch (name) {
    case 'getOpenEditors': {
      const act = activeTab()
      const sel = editorSelection()
      const order = recentFiles(50)
      const all = [...order, ...tabs.filter((x) => !order.includes(x))]
      return ok({
        projectFolder: state.root,
        editors: all.map((tab) => ({
          path: tab.path,
          language: tab.model.getLanguageId(),
          lines: tab.model.getLineCount(),
          unsaved: isDirty(tab),
          active: tab === act || undefined,
          ...(sel && samePath(sel.path, tab.path)
            ? {
                cursor: { line: sel.selection.positionLineNumber, column: sel.selection.positionColumn },
                selection: sel.text ? { startLine: sel.selection.startLineNumber, endLine: sel.selection.endLineNumber, text: sel.text.slice(0, 20_000) } : undefined
              }
            : {})
        }))
      })
    }
    case 'goToDefinition':
    case 'findReferences':
    case 'getHover': {
      const at = await locate(args)
      if (typeof at === 'string') return err(at)
      try {
        const params = { textDocument: { uri: at.model.uri.toString() }, position: { line: at.pos.lineNumber - 1, character: at.pos.column - 1 } }
        if (name === 'goToDefinition') {
          const r = await lspRequestFor(at.model, 'textDocument/definition', params, 8000)
          if (r === null) return err(NO_LSP)
          const locs = await locations(r, 6, 20)
          return ok(locs.length ? locs : 'No definition found.')
        }
        if (name === 'findReferences') {
          const r = await lspRequestFor(at.model, 'textDocument/references', { ...params, context: { includeDeclaration: args.includeDeclaration !== false } }, 15000)
          if (r === null) return err(NO_LSP)
          const locs = await locations(r, 0, 300)
          return ok(locs.length ? { count: locs.length, references: locs.map((l) => `${l.path}:${l.line}:${l.column}  ${l.text.trim().slice(0, 200)}`) } : 'No references found.')
        }
        const r = await lspRequestFor(at.model, 'textDocument/hover', params, 8000)
        if (r === null) return err(NO_LSP)
        return ok(hoverText(r) || 'No type information.')
      } finally {
        at.release()
      }
    }
    case 'getDocumentSymbols': {
      const at = await locate({ path: args.path, line: 1 })
      if (typeof at === 'string') return err(at)
      try {
        const r = await lspRequestFor(at.model, 'textDocument/documentSymbol', { textDocument: { uri: at.model.uri.toString() } }, 8000)
        if (r === null) return err(NO_LSP)
        const out = Array.isArray(r) ? flattenSymbols(r) : []
        return ok(out.length ? out.join('\n') : 'No symbols.')
      } finally {
        at.release()
      }
    }
    case 'searchCode': {
      const q = typeof args.query === 'string' ? args.query : ''
      if (!q.trim()) return err('Missing `query`.')
      if (!state.root) return err('No project folder is open.')
      const k = Math.max(1, Math.min(20, Math.floor(Number(args.limit) || 8)))
      const list = await indexSnippets(q, k, undefined, true)
      if (!list.length) return ok('No matching code found in the project index.')
      return ok(list.map((s) => `${relPath(s.path)}:${s.startLine}-${s.endLine}\n\`\`\`${languageFor(s.path)}\n${s.text}\n\`\`\``).join('\n\n'))
    }
    case 'getGitDiff': {
      if (!state.root) return err('No project folder is open.')
      try {
        const d = await window.api.git.diff(state.root, args.staged === true)
        return ok(d.trim() ? d : args.staged ? 'No staged changes.' : 'No unstaged changes to tracked files (untracked files are not shown).')
      } catch (e) {
        return err(String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
      }
    }
    case 'getTerminalOutput': {
      const n = Math.max(10, Math.min(1000, Math.floor(Number(args.maxLines) || 120)))
      const list = terminalOutputs(n)
      if (!list.length) return ok('No terminal is open.')
      return ok(list.map((x) => `=== ${x.title}${x.active ? ' (active)' : ''} ===\n${x.text || '(empty)'}`).join('\n\n'))
    }
    case 'runTests': {
      if (!state.root) return err('No project folder is open.')
      const r = await window.api.ai.runTests(state.root, typeof args.filter === 'string' ? args.filter : undefined)
      const head = r.command ? `$ ${r.command}\nexit code: ${r.exitCode ?? 'n/a'}${r.timedOut ? ' (timed out)' : ''}\n\n` : ''
      return { content: [{ type: 'text', text: head + (r.output || '(no output)') }], isError: !r.ok }
    }
  }
  return null
}

/** IDE 工具在对话里的显示名 */
export const IDE_TOOL_LABELS: Record<string, string> = {
  getOpenEditors: '打开的编辑器',
  goToDefinition: '跳转到定义',
  findReferences: '查找引用',
  getHover: '类型信息',
  getDocumentSymbols: '文件大纲',
  searchCode: '检索代码',
  getGitDiff: 'Git 改动',
  getTerminalOutput: '终端输出',
  runTests: '运行测试'
}
