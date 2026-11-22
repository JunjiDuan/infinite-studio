import { ipcMain } from 'electron'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { SearchFile, SearchMatch, SearchOptions, SearchResult } from '../shared/types'
import { IGNORED } from './fsService'
import { tm } from './i18n'
import { decodeText, encodeText, type DecodedText } from './textCodec'

const MAX_MATCHES = 5000
const MAX_FILE_BYTES = 1024 * 1024

/** 每个窗口只保留最新一次搜索，旧的自动作废 */
const latest = new Map<number, number>()

export function buildRegex(query: string, o: SearchOptions): RegExp {
  const src = o.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(o.wholeWord ? `\\b(?:${src})\\b` : src, o.caseSensitive ? 'g' : 'gi')
}

async function* walk(root: string): AsyncGenerator<string> {
  const queue = [root]
  while (queue.length) {
    const dir = queue.shift()!
    let items
    try {
      items = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const d of items) {
      if (IGNORED.has(d.name)) continue
      const p = path.join(dir, d.name)
      if (d.isDirectory()) queue.push(p)
      else if (d.isFile()) yield p
    }
  }
}

async function readDecoded(file: string): Promise<DecodedText | null> {
  try {
    const stat = await fs.stat(file)
    if (stat.size > MAX_FILE_BYTES) return null
    const buf = await fs.readFile(file)
    if (buf.subarray(0, 8000).includes(0)) return null
    return decodeText(buf)
  } catch {
    return null
  }
}

async function readText(file: string): Promise<string | null> {
  return (await readDecoded(file))?.text ?? null
}

/**
 * 逐行替换，和搜索的匹配方式保持一致（搜索是一行一行匹配的：^ $ 对每一行生效，不会跨行匹配）。
 * 返回替换后的文本和替换次数（空匹配不算，搜索结果里也不显示它们）。
 */
function replaceLines(text: string, re: RegExp, rep: string): { text: string; count: number } {
  let count = 0
  // 奇数位是换行符本身，原样保留（\r\n / \n 不变）
  const parts = text.split(/(\r?\n)/)
  for (let i = 0; i < parts.length; i += 2) {
    const line = parts[i]
    let hit = 0
    for (const m of line.matchAll(re)) if (m[0].length > 0) hit++
    if (!hit) continue
    count += hit
    parts[i] = line.replace(re, rep)
  }
  return { text: parts.join(''), count }
}

/** 截取匹配附近的一段作为预览，去掉行首缩进 */
function preview(line: string, index: number, len: number): { preview: string; at: number } {
  let start = Math.max(0, index - 32)
  while (start < index && /\s/.test(line[start])) start++
  const text = (start > 0 ? '…' : '') + line.slice(start, index + len + 120)
  return { preview: text, at: index - start + (start > 0 ? 1 : 0) }
}

export function registerSearchIpc(): void {
  ipcMain.handle('search:run', async (e, reqId: number, root: string, query: string, opts: SearchOptions): Promise<SearchResult | null> => {
    const wc = e.sender.id
    latest.set(wc, reqId)
    if (!query) return { files: [], total: 0, truncated: false }
    let re: RegExp
    try {
      re = buildRegex(query, opts)
    } catch (err) {
      return { files: [], total: 0, truncated: false, error: tm('正则表达式无效：{0}', (err as Error).message) }
    }
    const files: SearchFile[] = []
    let total = 0
    let scanned = 0
    for await (const file of walk(root)) {
      if (latest.get(wc) !== reqId) return null
      // 让出事件循环，避免大项目搜索时卡住主进程
      if (++scanned % 64 === 0) await new Promise((r) => setImmediate(r))
      const text = await readText(file)
      if (text === null) continue
      const matches: SearchMatch[] = []
      const lines = text.split(/\r?\n/)
      for (let i = 0; i < lines.length && total < MAX_MATCHES; i++) {
        const line = lines[i]
        re.lastIndex = 0
        let m: RegExpExecArray | null
        while ((m = re.exec(line)) !== null) {
          if (m[0].length === 0) {
            re.lastIndex++
            continue
          }
          matches.push({ line: i + 1, col: m.index + 1, len: m[0].length, ...preview(line, m.index, m[0].length) })
          if (++total >= MAX_MATCHES) break
        }
      }
      if (matches.length) files.push({ path: file, matches })
      if (total >= MAX_MATCHES) return { files, total, truncated: true }
    }
    return latest.get(wc) === reqId ? { files, total, truncated: false } : null
  })

  ipcMain.handle('search:replace', async (_e, query: string, opts: SearchOptions, replacement: string, targets: string[]) => {
    const re = buildRegex(query, opts)
    // 非正则模式下替换文本按字面处理，$ 不做分组引用
    const rep = opts.regex ? replacement : replacement.replace(/\$/g, '$$$$')
    let changedFiles = 0
    let replaced = 0
    for (const file of targets) {
      const d = await readDecoded(file)
      // 编码认不出来的文件不改：写回去会把无效字节变成乱码
      if (d === null || d.lossy) continue
      const { text: next, count } = replaceLines(d.text, re, rep)
      if (!count || next === d.text) continue
      // 按原编码写回（GBK 写不了的字符会抛错，这个文件保持不变）
      await fs.writeFile(file, encodeText(next, { encoding: d.encoding, bom: d.bom }))
      changedFiles++
      replaced += count
    }
    return { files: changedFiles, replaced }
  })
}
