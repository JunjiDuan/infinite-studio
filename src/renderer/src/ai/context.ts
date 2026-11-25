import type { AiSnippet } from '../../../shared/ai'
import { relative } from '../dom'
import { recentFiles, normPath, samePath } from '../editor'
import { monaco } from '../monaco'
import { lspRequestFor } from '../lsp'
import { state } from '../store'
import { aiSettings } from './client'

/**
 * 给模型的上下文：让行内补全、内联编辑知道“当前文件以外”的事。
 *
 * - 项目规则：.infinite/rules.md、AGENTS.md 等，写进所有请求的系统提示
 * - 打开的标签页：和光标附近最相似的代码片段（标识符集合的 Jaccard 相似度，滑动窗口）
 * - 语言服务：光标附近用到的导入符号，跳到定义取签名
 * - 项目索引：主进程的 BM25 索引里检索到的相关代码
 *
 * 补全对延迟敏感：全部并行，有总时限，超时的来源直接放弃。
 */

type Model = monaco.editor.ITextModel

export interface CtxSnippet {
  path: string
  startLine: number
  endLine: number
  text: string
  source: 'tab' | 'lsp' | 'index'
}

/* ---------------- 项目规则 ---------------- */

const RULE_FILES = ['.infinite/rules.md', 'AGENTS.md', 'CLAUDE.md', '.github/copilot-instructions.md', '.cursorrules']
const RULES_MAX = 6000
let rulesCache: { root: string; at: number; text: string; files: string[] } | null = null

function join(root: string, rel: string): string {
  const sep = root.includes('\\') ? '\\' : '/'
  return root.replace(/[\\/]+$/, '') + sep + rel.replace(/\//g, sep)
}

/** 项目规则文件的内容（几秒内重复调用直接用缓存） */
export async function projectRules(force = false): Promise<{ text: string; files: string[] }> {
  const root = state.root
  if (!root) return { text: '', files: [] }
  if (!force && rulesCache && rulesCache.root === root && Date.now() - rulesCache.at < 5000) return rulesCache
  const parts: string[] = []
  const files: string[] = []
  let total = 0
  for (const rel of RULE_FILES) {
    const r = await window.api.fs.readFile(join(root, rel)).catch(() => null)
    if (!r?.ok || !r.content.trim()) continue
    const body = r.content.trim().slice(0, RULES_MAX - total)
    if (!body) break
    parts.push(`## ${rel}\n${body}`)
    files.push(rel)
    total += body.length
    if (total >= RULES_MAX) break
  }
  rulesCache = { root, at: Date.now(), text: parts.join('\n\n'), files }
  return rulesCache
}

/** 把项目规则接到系统提示后面（设置里关掉或没有规则文件时原样返回） */
export async function withRules(system: string): Promise<string> {
  if (!aiSettings().context.rules) return system
  const r = await projectRules()
  return r.text ? `${system}\n\nThe project has its own rules and conventions. Follow them unless the user's instruction says otherwise:\n\n${r.text}` : system
}

/* ---------------- 打开的标签页里的相似片段 ---------------- */

const WORD = /[A-Za-z_$][\w$]{2,}/g

function wordSet(text: string): Set<string> {
  return new Set(text.match(WORD) ?? [])
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0
  let inter = 0
  for (const w of a) if (b.has(w)) inter++
  return inter / (a.size + b.size - inter)
}

/** 和光标前 20 行最相似的片段：每个其他标签页取最好的一个窗口，按相似度取前几个 */
export function similarFromTabs(model: Model, pos: monaco.IPosition, max = 3): CtxSnippet[] {
  const from = Math.max(1, pos.lineNumber - 20)
  const query = wordSet(model.getValueInRange(new monaco.Range(from, 1, pos.lineNumber, pos.column)))
  if (query.size < 3) return []
  const out: (CtxSnippet & { score: number })[] = []
  for (const tab of recentFiles(12)) {
    const m = tab.model
    if (m === model || m.isDisposed() || m.getValueLength() > 1_000_000) continue
    const lines = m.getLinesContent()
    let best: { score: number; start: number } | null = null
    const W = 20
    for (let i = 0; i < lines.length; i += 10) {
      const score = jaccard(query, wordSet(lines.slice(i, i + W).join('\n')))
      if (!best || score > best.score) best = { score, start: i }
    }
    if (best && best.score > 0.12) {
      const end = Math.min(lines.length, best.start + W)
      out.push({ path: tab.path, startLine: best.start + 1, endLine: end, text: lines.slice(best.start, end).join('\n'), source: 'tab', score: best.score })
    }
  }
  return out.sort((a, b) => b.score - a.score).slice(0, max)
}

/* ---------------- 语言服务：导入符号的定义 ---------------- */

/** 文件里导入的名字 → 它在导入语句里的位置（跳转定义从这里发起） */
function importedNames(model: Model): Map<string, monaco.IPosition> {
  const out = new Map<string, monaco.IPosition>()
  const n = Math.min(model.getLineCount(), 300)
  const add = (name: string, line: number, text: string) => {
    if (!/^[A-Za-z_$][\w$]*$/.test(name) || out.has(name)) return
    const col = text.search(new RegExp(`\\b${name.replace(/\$/g, '\\$')}\\b`))
    if (col >= 0) out.set(name, { lineNumber: line, column: col + 1 })
  }
  for (let i = 1; i <= n; i++) {
    const text = model.getLineContent(i)
    let m: RegExpMatchArray | null
    if ((m = text.match(/^\s*import\s+(?:type\s+)?(.+?)\s+from\s+['"]/))) {
      // import A, { b, c as d } from '...'
      for (const part of m[1].replace(/[{}*]/g, ',').split(',')) {
        const name = part.trim().split(/\s+as\s+/).pop()?.trim()
        if (name && name !== 'type') add(name.replace(/^type\s+/, ''), i, text)
      }
    } else if ((m = text.match(/^\s*from\s+[\w.]+\s+import\s+\(?([^)#]+)/))) {
      for (const part of m[1].split(',')) add(part.trim().split(/\s+as\s+/).pop()!.trim(), i, text)
    } else if ((m = text.match(/^\s*(?:import|using)\s+(?:static\s+)?([\w.]+)\s*;/))) {
      add(m[1].split('.').pop()!, i, text)
    } else if ((m = text.match(/^\s*use\s+[\w:]+::\{?([^};]+)\}?\s*;/))) {
      for (const part of m[1].split(',')) add(part.trim().split(/\s+as\s+/).pop()!.split('::').pop()!.trim(), i, text)
    } else if ((m = text.match(/^\s*#include\s+"([^"]+)"/))) {
      // C/C++ 的头文件：不按名字处理
    }
  }
  return out
}

const defCache = new Map<string, { at: number; snip: CtxSnippet | null }>()

async function readLines(path: string): Promise<string[] | null> {
  const m = monaco.editor.getModels().find((x) => x.uri.scheme === 'file' && samePath(x.uri.fsPath, path))
  if (m) return m.getLinesContent()
  const r = await window.api.fs.readFile(path).catch(() => null)
  return r?.ok ? r.content.split(/\r?\n/) : null
}

/** 定义处开始的一小段（签名 + 开头几行，最多 14 行，遇到空行就停） */
function definitionSnippet(lines: string[], line0: number): { start: number; end: number; text: string } {
  // 往上带上紧挨着的注释 / 装饰器
  let start = line0
  while (start > 0 && start > line0 - 6 && /^\s*(\/\/|\*|\/\*|#|@|\/\/\/)/.test(lines[start - 1])) start--
  let end = line0
  while (end < lines.length - 1 && end - line0 < 14 && lines[end + 1].trim()) end++
  return { start: start + 1, end: end + 1, text: lines.slice(start, end + 1).join('\n') }
}

async function definitionOf(model: Model, name: string, at: monaco.IPosition): Promise<CtxSnippet | null> {
  const key = `${model.uri.toString()}|${name}`
  const hit = defCache.get(key)
  if (hit && Date.now() - hit.at < 120_000) return hit.snip
  const r = await lspRequestFor(model, 'textDocument/definition', { textDocument: { uri: model.uri.toString() }, position: { line: at.lineNumber - 1, character: at.column - 1 } }, 1500)
  const loc = Array.isArray(r) ? r[0] : r
  let snip: CtxSnippet | null = null
  if (loc) {
    const uri: string = loc.targetUri ?? loc.uri
    const range = loc.targetSelectionRange ?? loc.targetRange ?? loc.range
    if (uri && range && uri.startsWith('file:')) {
      const path = normPath(monaco.Uri.parse(uri).fsPath)
      const lines = await readLines(path)
      // 跳到自己（导入语句本身）的结果没有意义
      if (lines && !(samePath(path, model.uri.fsPath) && range.start.line + 1 === at.lineNumber)) {
        const d = definitionSnippet(lines, range.start.line)
        snip = { path, startLine: d.start, endLine: d.end, text: d.text, source: 'lsp' }
      }
    }
  }
  defCache.set(key, { at: Date.now(), snip })
  if (defCache.size > 300) defCache.delete(defCache.keys().next().value!)
  return snip
}

/** 光标前最近 40 行里用到的导入符号（最近用到的优先），取它们的定义 */
export async function lspDefinitions(model: Model, pos: monaco.IPosition, max = 4): Promise<CtxSnippet[]> {
  if (model.uri.scheme !== 'file') return []
  const imports = importedNames(model)
  if (!imports.size) return []
  const from = Math.max(1, pos.lineNumber - 40)
  const recent = model.getValueInRange(new monaco.Range(from, 1, pos.lineNumber, pos.column))
  const used: string[] = []
  const words = recent.match(/[A-Za-z_$][\w$]*/g) ?? []
  for (let i = words.length - 1; i >= 0 && used.length < max; i--) if (imports.has(words[i]) && !used.includes(words[i])) used.push(words[i])
  const defs = await Promise.all(used.map((n) => definitionOf(model, n, imports.get(n)!)))
  return defs.filter((d): d is CtxSnippet => !!d)
}

/* ---------------- 项目索引 ---------------- */

export async function indexSnippets(query: string, k: number, exclude?: { path: string; start: number; end: number }, wait = false): Promise<CtxSnippet[]> {
  const root = state.root
  if (!root || !query.trim()) return []
  const list: AiSnippet[] = await window.api.ai.indexSearch(root, query, { k, exclude, wait }).catch(() => [])
  return list.map((s) => ({ path: s.path, startLine: s.startLine, endLine: s.endLine, text: s.text, source: 'index' as const }))
}

/* ---------------- 组合 ---------------- */

/** 有时限地等一个来源，超时当作没有 */
function within<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([p.catch(() => fallback), new Promise<T>((r) => setTimeout(() => r(fallback), ms))])
}

function overlaps(a: CtxSnippet, b: CtxSnippet): boolean {
  return samePath(a.path, b.path) && a.startLine <= b.endLine && b.startLine <= a.endLine
}

/** 合并去重，按顺序装进字数预算 */
function pack(groups: CtxSnippet[][], budget: number): CtxSnippet[] {
  const out: CtxSnippet[] = []
  let used = 0
  for (const g of groups) {
    for (const s of g) {
      if (out.some((o) => overlaps(o, s))) continue
      const cost = s.text.length + 80
      if (used + cost > budget) continue
      out.push(s)
      used += cost
    }
  }
  return out
}

const LINE_COMMENT: Record<string, string> = { python: '#', shell: '#', ruby: '#', r: '#', yaml: '#', perl: '#', powershell: '#', sql: '--', lua: '--', haskell: '--' }

/** 补全用：每行加上注释符号，FIM 模型也不会把它当成要续写的代码 */
export function formatAsComments(list: CtxSnippet[], languageId: string): string {
  const c = LINE_COMMENT[languageId] ?? '//'
  return list
    .map((s) => [`${c} ${relPath(s.path)}:${s.startLine}-${s.endLine}${s.source === 'lsp' ? ' (definition)' : ''}`, ...s.text.split('\n').map((l) => `${c} ${l}`)].join('\n'))
    .join('\n\n')
}

/** 对话用：每段放进带路径的代码块 */
export function formatAsBlocks(list: CtxSnippet[]): string {
  return list.map((s) => `${relPath(s.path)}:${s.startLine}-${s.endLine}${s.source === 'lsp' ? ' (definition of a symbol used here)' : ''}\n\`\`\`\n${s.text}\n\`\`\``).join('\n\n')
}

export function relPath(p: string): string {
  return state.root ? relative(state.root, p) : p
}

/** 光标附近的标识符（检索项目索引用） */
function nearbyQuery(model: Model, pos: monaco.IPosition, before = 12, after = 3): string {
  const from = Math.max(1, pos.lineNumber - before)
  const to = Math.min(model.getLineCount(), pos.lineNumber + after)
  return model.getValueInRange(new monaco.Range(from, 1, to, model.getLineMaxColumn(to)))
}

/** 行内补全的上下文（注释形式）；budgetMs 内拿不到的来源放弃 */
export async function completionContext(model: Model, pos: monaco.IPosition, budgetMs = 220): Promise<string> {
  const cfg = aiSettings().context
  const path = model.uri.scheme === 'file' ? normPath(model.uri.fsPath) : ''
  const [tabs, defs, idx] = await Promise.all([
    cfg.openTabs ? Promise.resolve(similarFromTabs(model, pos)) : Promise.resolve([]),
    cfg.lsp ? within(lspDefinitions(model, pos), budgetMs, [] as CtxSnippet[]) : Promise.resolve([]),
    cfg.index && path ? within(indexSnippets(nearbyQuery(model, pos), 4, { path, start: pos.lineNumber - 60, end: pos.lineNumber + 60 }), budgetMs, [] as CtxSnippet[]) : Promise.resolve([])
  ])
  const list = pack([defs, tabs, idx], 5000)
  return list.length ? formatAsComments(list, model.getLanguageId()) : ''
}

/** 内联编辑 / AI 修复的相关代码（代码块形式） */
export async function editContext(model: Model, startLine: number, endLine: number, instruction: string): Promise<string> {
  const cfg = aiSettings().context
  const path = model.uri.scheme === 'file' ? normPath(model.uri.fsPath) : ''
  const pos = { lineNumber: endLine, column: model.getLineMaxColumn(endLine) }
  const region = model.getValueInRange(new monaco.Range(startLine, 1, endLine, model.getLineMaxColumn(endLine)))
  const [defs, tabs, idx] = await Promise.all([
    cfg.lsp ? within(lspDefinitions(model, pos, 6), 2500, [] as CtxSnippet[]) : Promise.resolve([]),
    cfg.openTabs ? Promise.resolve(similarFromTabs(model, pos, 2)) : Promise.resolve([]),
    cfg.index && path ? within(indexSnippets(`${instruction}\n${region}`, 5, { path, start: startLine - 400, end: endLine + 200 }), 2500, [] as CtxSnippet[]) : Promise.resolve([])
  ])
  const list = pack([defs, idx, tabs], 14_000)
  return list.length ? formatAsBlocks(list) : ''
}
