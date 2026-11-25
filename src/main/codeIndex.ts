import { ipcMain } from 'electron'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { AiIndexStatus, AiSnippet } from '../shared/ai'
import { IGNORED } from './fsService'

/**
 * 项目代码索引：给行内补全、内联编辑和 AI 对话的工具检索“和这里相关的代码”。
 *
 * - 源代码文件按函数 / 类等顶层声明切成几十行的小块（声明识别用正则，覆盖常见语言，不依赖原生模块）
 * - 标识符按驼峰 / 下划线拆词，建倒排索引，检索用 BM25，声明名命中的块加分
 * - 第一次检索时在后台建立；之后每次检索距上次扫描超过 20 秒就在后台按修改时间增量更新
 *
 * 只在内存里，每个窗口打开的文件夹各一份，最多保留 3 个文件夹。
 */

const EXTS = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'vue', 'svelte', 'py', 'pyi', 'java', 'kt', 'kts', 'scala', 'groovy', 'c', 'h', 'cc', 'cpp', 'cxx', 'hpp', 'hh',
  'cs', 'go', 'rs', 'swift', 'm', 'mm', 'rb', 'php', 'lua', 'dart', 'r', 'jl', 'ex', 'exs', 'erl', 'hs', 'ml', 'fs', 'sql', 'sh', 'ps1', 'css', 'scss', 'less', 'html'
])
const MAX_FILES = 20_000
const MAX_FILE_BYTES = 512 * 1024
const RESCAN_MS = 20_000
const CHUNK_MIN = 12
const CHUNK_MAX = 80
const WINDOW = 60
const OVERLAP = 10

const STOP = new Set(
  (
    'the and for not with this that from return const let var function class interface type enum import export default async await new ' +
    'public private protected static void int string bool boolean true false null undefined none self def elif else if then end while do ' +
    'try catch finally throw throws case switch break continue package using namespace struct impl pub mut use mod fn func go val in of is as'
  ).split(' ')
)

/** 声明行：函数、类、方法……（缩进不超过 4 个空格或 1 个 Tab，避免把函数体里的语句当成边界） */
const DECL =
  /^(?: {0,4}|\t?)(?:export\s+)?(?:default\s+)?(?:pub(?:\([^)]*\))?\s+)?(?:(?:public|private|protected|internal|static|final|abstract|override|virtual|async|unsafe|extern|inline|sealed|partial|open|suspend)\s+)*(?:function\*?|class|interface|type|enum|def|fn|func|struct|impl|trait|module|namespace|record|object|protocol|extension|union|macro_rules!|(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*[:=]\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::[^=]*)?=>|[A-Za-z_][\w<>,\s*&[\]]*\s+[A-Za-z_]\w*\s*\([^;]*$)/
const NAME = /(?:function\*?|class|interface|type|enum|def|fn|func|struct|impl|trait|module|namespace|record|object|protocol|const|let|var)\s+([A-Za-z_$][\w$]*)|([A-Za-z_]\w*)\s*\(/

interface Chunk {
  file: string
  start: number
  end: number
  symbol?: string
  /** 词 → 出现次数 */
  tf: Map<string, number>
  len: number
}

interface FileEntry {
  mtime: number
  size: number
  chunks: number[]
}

/** 标识符拆成小写的词：getUserName → get, user, name, getusername */
export function terms(text: string): string[] {
  const out: string[] = []
  for (const m of text.matchAll(/[A-Za-z_$][\w$]*/g)) {
    const id = m[0]
    if (id.length < 2 || id.length > 64) continue
    const lower = id.toLowerCase()
    const parts = id
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
      .split(/[\s_$]+/)
      .map((p) => p.toLowerCase())
      .filter((p) => p.length >= 2 && !STOP.has(p))
    if (!STOP.has(lower)) out.push(lower)
    if (parts.length > 1) out.push(...parts)
  }
  return out
}

/** 控制语句（if (…) {、for (…) 等）长得像函数调用 / 声明，不算边界 */
const CONTROL = /^\s*(?:\}\s*)?(?:if|else|for|foreach|while|switch|catch|return|do|try|case|throw|await|yield|new|delete|typeof|with|using|lock|elif|except)\b/

function isDecl(line: string): boolean {
  return DECL.test(line) && !CONTROL.test(line)
}

function symbolOf(line: string): string | undefined {
  const m = line.match(NAME)
  return m ? (m[1] ?? m[2]) : undefined
}

/** 一个文件切成块：[开始行, 结束行]（0 起始，含） */
function split(lines: string[]): [number, number][] {
  const bounds: number[] = [0]
  for (let i = 1; i < lines.length; i++) if (isDecl(lines[i])) bounds.push(i)
  bounds.push(lines.length)
  // 合并太小的段
  const segs: [number, number][] = []
  let s = bounds[0]
  for (let k = 1; k < bounds.length; k++) {
    const e = bounds[k]
    if (e - s >= CHUNK_MIN || k === bounds.length - 1) {
      segs.push([s, e - 1])
      s = e
    }
  }
  // 拆开太大的段
  const out: [number, number][] = []
  for (const [a, b] of segs) {
    if (b - a + 1 <= CHUNK_MAX) out.push([a, b])
    else for (let i = a; i <= b; i += WINDOW - OVERLAP) out.push([i, Math.min(b, i + WINDOW - 1)])
  }
  return out.filter(([a, b]) => b >= a && lines.slice(a, b + 1).some((l) => l.trim()))
}

class CodeIndex {
  files = new Map<string, FileEntry>()
  chunks: (Chunk | null)[] = []
  postings = new Map<string, Set<number>>()
  totalLen = 0
  liveChunks = 0
  building = false
  scanned = 0
  updatedAt = 0
  private job: Promise<void> | null = null

  constructor(readonly root: string) {}

  status(): AiIndexStatus {
    return { root: this.root, files: this.files.size, chunks: this.liveChunks, building: this.building, updatedAt: this.updatedAt }
  }

  /** 后台扫描（同一时间只跑一次） */
  refresh(force = false): Promise<void> {
    if (this.job) return this.job
    if (!force && Date.now() - this.scanned < RESCAN_MS) return Promise.resolve()
    this.building = true
    this.job = this.scan()
      .catch((e) => console.warn('代码索引更新失败', e))
      .finally(() => {
        this.building = false
        this.scanned = Date.now()
        this.job = null
      })
    return this.job
  }

  private async scan(): Promise<void> {
    const seen = new Set<string>()
    const queue = [this.root]
    let n = 0
    while (queue.length && seen.size < MAX_FILES) {
      const dir = queue.shift()!
      let items
      try {
        items = await fs.readdir(dir, { withFileTypes: true })
      } catch {
        continue
      }
      for (const d of items) {
        if (IGNORED.has(d.name) || (d.name.startsWith('.') && d.isDirectory())) continue
        const p = path.join(dir, d.name)
        if (d.isDirectory()) queue.push(p)
        else if (d.isFile() && EXTS.has(path.extname(d.name).slice(1).toLowerCase())) {
          seen.add(p)
          await this.update(p)
          // 每处理一批文件让出一次事件循环，别卡住主进程
          if (++n % 100 === 0) await new Promise((r) => setImmediate(r))
          if (seen.size >= MAX_FILES) break
        }
      }
    }
    for (const p of [...this.files.keys()]) if (!seen.has(p)) this.remove(p)
    this.updatedAt = Date.now()
  }

  private async update(file: string): Promise<void> {
    let st
    try {
      st = await fs.stat(file)
    } catch {
      return this.remove(file)
    }
    const old = this.files.get(file)
    if (old && old.mtime === st.mtimeMs && old.size === st.size) return
    if (st.size > MAX_FILE_BYTES) return this.remove(file)
    let text: string
    try {
      text = await fs.readFile(file, 'utf8')
    } catch {
      return this.remove(file)
    }
    // 压缩过的单行代码、二进制：跳过
    if (text.includes('\u0000') || (text.length > 20_000 && text.split('\n', 50).length < 5)) return this.remove(file)
    this.remove(file)
    const lines = text.split(/\r?\n/)
    const ids: number[] = []
    for (const [a, b] of split(lines)) {
      const body = lines.slice(a, b + 1)
      const tf = new Map<string, number>()
      const words = terms(body.join('\n'))
      for (const w of words) tf.set(w, (tf.get(w) ?? 0) + 1)
      // 路径里的词也算进去（搜“auth”时 auth/ 目录下的代码更相关）
      for (const w of terms(path.relative(this.root, file).replace(/\.[^.]+$/, ''))) tf.set(w, (tf.get(w) ?? 0) + 1)
      const decl = body.find(isDecl)
      const chunk: Chunk = { file, start: a + 1, end: b + 1, symbol: decl ? symbolOf(decl.trim()) : undefined, tf, len: words.length || 1 }
      const id = this.chunks.length
      this.chunks.push(chunk)
      ids.push(id)
      this.totalLen += chunk.len
      this.liveChunks++
      for (const w of tf.keys()) {
        let set = this.postings.get(w)
        if (!set) this.postings.set(w, (set = new Set()))
        set.add(id)
      }
    }
    this.files.set(file, { mtime: st.mtimeMs, size: st.size, chunks: ids })
  }

  private remove(file: string): void {
    const e = this.files.get(file)
    if (!e) return
    for (const id of e.chunks) {
      const c = this.chunks[id]
      if (!c) continue
      for (const w of c.tf.keys()) {
        const set = this.postings.get(w)
        set?.delete(id)
        if (set && !set.size) this.postings.delete(w)
      }
      this.totalLen -= c.len
      this.liveChunks--
      this.chunks[id] = null
    }
    this.files.delete(file)
    // 删掉的块太多时整理一次，免得数组无限变长
    if (this.chunks.length > 4 * this.liveChunks + 1000) this.compact()
  }

  private compact(): void {
    const map = new Map<number, number>()
    const next: Chunk[] = []
    this.chunks.forEach((c, i) => {
      if (c) {
        map.set(i, next.length)
        next.push(c)
      }
    })
    this.chunks = next
    for (const e of this.files.values()) e.chunks = e.chunks.map((i) => map.get(i)!).filter((i) => i !== undefined)
    const posts = new Map<string, Set<number>>()
    for (const [w, set] of this.postings) posts.set(w, new Set([...set].map((i) => map.get(i)!).filter((i) => i !== undefined)))
    this.postings = posts
  }

  async search(query: string, k: number, exclude?: { path: string; start: number; end: number }): Promise<AiSnippet[]> {
    const q = [...new Set(terms(query))].slice(0, 60)
    if (!q.length || !this.liveChunks) return []
    const N = this.liveChunks
    const avg = this.totalLen / N
    const scores = new Map<number, number>()
    for (const w of q) {
      const set = this.postings.get(w)
      if (!set?.size) continue
      // 太常见的词（出现在一半以上的块里）几乎没有区分度
      if (set.size > N * 0.5 && N > 50) continue
      const idf = Math.log(1 + (N - set.size + 0.5) / (set.size + 0.5))
      for (const id of set) {
        const c = this.chunks[id]!
        const f = c.tf.get(w)!
        let s = (idf * f * 2.2) / (f + 1.2 * (0.25 + 0.75 * (c.len / avg)))
        if (c.symbol && c.symbol.toLowerCase() === w) s *= 2
        scores.set(id, (scores.get(id) ?? 0) + s)
      }
    }
    const ex = exclude ? path.resolve(exclude.path).toLowerCase() : null
    const ranked = [...scores.entries()]
      .filter(([id]) => {
        const c = this.chunks[id]!
        return !(ex && path.resolve(c.file).toLowerCase() === ex && c.end >= exclude!.start && c.start <= exclude!.end)
      })
      .sort((a, b) => b[1] - a[1])
    const out: AiSnippet[] = []
    const perFile = new Map<string, number>()
    for (const [id, score] of ranked) {
      if (out.length >= k) break
      const c = this.chunks[id]!
      // 同一个文件最多取 2 块，结果更分散
      const n = perFile.get(c.file) ?? 0
      if (n >= 2) continue
      perFile.set(c.file, n + 1)
      let text = ''
      try {
        text = (await fs.readFile(c.file, 'utf8'))
          .split(/\r?\n/)
          .slice(c.start - 1, c.end)
          .join('\n')
      } catch {
        continue
      }
      out.push({ path: c.file, startLine: c.start, endLine: c.end, symbol: c.symbol, text, score: Math.round(score * 100) / 100 })
    }
    return out
  }
}

const indexes = new Map<string, CodeIndex>()

function indexFor(root: string): CodeIndex {
  const key = path.resolve(root).toLowerCase()
  let idx = indexes.get(key)
  if (idx) {
    // 最近用过的放到最后
    indexes.delete(key)
    indexes.set(key, idx)
    return idx
  }
  idx = new CodeIndex(path.resolve(root))
  indexes.set(key, idx)
  while (indexes.size > 3) indexes.delete(indexes.keys().next().value!)
  return idx
}

async function validRoot(root: unknown): Promise<string | null> {
  if (typeof root !== 'string' || !path.isAbsolute(root)) return null
  try {
    return (await fs.stat(root)).isDirectory() ? root : null
  } catch {
    return null
  }
}

export function registerCodeIndexIpc(): void {
  ipcMain.handle('ai:indexSearch', async (_e, root: unknown, query: unknown, opts: { k?: number; exclude?: { path: string; start: number; end: number }; wait?: boolean } = {}) => {
    const r = await validRoot(root)
    if (!r || typeof query !== 'string') return []
    const idx = indexFor(r)
    const first = !idx.updatedAt
    const job = idx.refresh()
    // 第一次建立索引要一会儿：补全不等（返回空），AI 工具可以选择等
    if (first) {
      if (!opts?.wait) return []
      await job
    }
    const k = Math.max(1, Math.min(30, Number(opts?.k) || 6))
    const ex = opts?.exclude && typeof opts.exclude.path === 'string' ? { path: opts.exclude.path, start: Number(opts.exclude.start) || 0, end: Number(opts.exclude.end) || 0 } : undefined
    return idx.search(query.slice(0, 4000), k, ex)
  })
  ipcMain.handle('ai:indexStatus', async (_e, root: unknown): Promise<AiIndexStatus | null> => {
    const r = await validRoot(root)
    if (!r) return null
    const key = path.resolve(r).toLowerCase()
    return indexes.get(key)?.status() ?? { root: r, files: 0, chunks: 0, building: false, updatedAt: 0 }
  })
  ipcMain.handle('ai:indexRebuild', async (_e, root: unknown): Promise<AiIndexStatus | null> => {
    const r = await validRoot(root)
    if (!r) return null
    indexes.delete(path.resolve(r).toLowerCase())
    const idx = indexFor(r)
    void idx.refresh(true)
    return idx.status()
  })
}
