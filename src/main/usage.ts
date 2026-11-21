import { createReadStream, promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import type { DailyUsage, DayUsage } from '../shared/agents'

/**
 * 按天汇总本地会话记录里的 token 消耗（只读本机文件，不联网）。
 *
 * - Claude Code：~/.claude/projects/**\/*.jsonl，每条 assistant 消息带 message.usage；
 *   同一条消息的多个内容块会各写一行、usage 相同，按 message.id 去重。
 * - Codex：~/.codex/sessions/**\/*.jsonl（以及 archived_sessions），token_count 事件里的
 *   total_token_usage 是会话累计值，取相邻两次的差。
 *
 * 每个文件按 (大小, 修改时间) 缓存解析结果，只重新读有变化的文件。
 */

/** [日期, 输入(不含缓存), 输出, 缓存读, 缓存写] */
type Entry = [string, number, number, number, number]

interface FileCache {
  size: number
  mtime: number
  /** Claude：消息 id → 记录（用于跨文件去重）；Codex：序号 → 记录 */
  entries: Map<string, Entry>
}

const caches: Record<string, Map<string, FileCache>> = { claude: new Map(), codex: new Map() }
const pending: Record<string, Promise<DailyUsage> | null> = { claude: null, codex: null }

function localDate(ts: unknown): string | null {
  if (typeof ts !== 'string' && typeof ts !== 'number') return null
  const d = new Date(ts)
  if (isNaN(d.getTime())) return null
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

const num = (v: unknown) => (typeof v === 'number' && isFinite(v) && v > 0 ? v : 0)

async function walk(dir: string, out: string[], depth = 0): Promise<void> {
  if (depth > 6) return
  const items = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
  for (const it of items) {
    const p = path.join(dir, it.name)
    if (it.isDirectory()) await walk(p, out, depth + 1)
    else if (it.isFile() && it.name.endsWith('.jsonl')) out.push(p)
  }
}

async function eachLine(file: string, fn: (line: string) => void): Promise<void> {
  const rl = readline.createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity })
  for await (const line of rl) fn(line)
}

async function parseClaude(file: string): Promise<Map<string, Entry>> {
  const out = new Map<string, Entry>()
  let n = 0
  await eachLine(file, (line) => {
    if (!line.includes('"usage"') || !line.includes('"assistant"')) return
    let o: Record<string, any>
    try {
      o = JSON.parse(line)
    } catch {
      return
    }
    if (o.type !== 'assistant') return
    const m = o.message
    const u = m?.usage
    if (!u || m.model === '<synthetic>') return
    const date = localDate(o.timestamp)
    if (!date) return
    const id = (typeof m.id === 'string' ? m.id : '') + ':' + (typeof o.requestId === 'string' ? o.requestId : '')
    const key = id === ':' ? `${file}#${n++}` : id
    out.set(key, [date, num(u.input_tokens), num(u.output_tokens), num(u.cache_read_input_tokens), num(u.cache_creation_input_tokens)])
  })
  return out
}

async function parseCodex(file: string): Promise<Map<string, Entry>> {
  const out = new Map<string, Entry>()
  let prev = { input: 0, cached: 0, output: 0, total: 0 }
  let n = 0
  await eachLine(file, (line) => {
    if (!line.includes('"token_count"')) return
    let o: Record<string, any>
    try {
      o = JSON.parse(line)
    } catch {
      return
    }
    const info = o.payload?.type === 'token_count' ? o.payload.info : null
    const t = info?.total_token_usage
    if (!t) return
    const date = localDate(o.timestamp)
    if (!date) return
    const cur = { input: num(t.input_tokens), cached: num(t.cached_input_tokens), output: num(t.output_tokens), total: num(t.total_tokens) }
    let d: typeof cur
    if (cur.total >= prev.total) {
      d = { input: cur.input - prev.input, cached: cur.cached - prev.cached, output: cur.output - prev.output, total: cur.total - prev.total }
    } else {
      // 累计值变小（新线程等）：退回用这一次的用量
      const l = info.last_token_usage ?? {}
      d = { input: num(l.input_tokens), cached: num(l.cached_input_tokens), output: num(l.output_tokens), total: num(l.total_tokens) }
    }
    prev = cur
    if (d.total <= 0) return
    const cached = Math.max(0, d.cached)
    out.set(String(n++), [date, Math.max(0, d.input - cached), Math.max(0, d.output), cached, 0])
  })
  return out
}

async function collect(plugin: 'claude' | 'codex'): Promise<DailyUsage> {
  const home = os.homedir()
  const roots =
    plugin === 'claude'
      ? [path.join(process.env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'), 'projects')]
      : [path.join(process.env.CODEX_HOME || path.join(home, '.codex'), 'sessions'), path.join(process.env.CODEX_HOME || path.join(home, '.codex'), 'archived_sessions')]
  const files: string[] = []
  for (const r of roots) await walk(r, files)

  const cache = caches[plugin]
  const live = new Set(files)
  for (const f of cache.keys()) if (!live.has(f)) cache.delete(f)

  // 并发解析变化过的文件
  const queue = [...files]
  const worker = async () => {
    for (let f = queue.shift(); f; f = queue.shift()) {
      const st = await fs.stat(f).catch(() => null)
      if (!st) continue
      const c = cache.get(f)
      if (c && c.size === st.size && c.mtime === st.mtimeMs) continue
      try {
        const entries = plugin === 'claude' ? await parseClaude(f) : await parseCodex(f)
        cache.set(f, { size: st.size, mtime: st.mtimeMs, entries })
      } catch {
        /* 读不了的文件跳过 */
      }
    }
  }
  await Promise.all(Array.from({ length: 8 }, worker))

  const days: DailyUsage = {}
  const seen = new Set<string>()
  for (const c of cache.values()) {
    for (const [key, [date, input, output, cr, cw]] of c.entries) {
      // Claude 续接 / 分叉的会话会复制之前的消息，按消息 id 只算一次
      if (plugin === 'claude') {
        if (seen.has(key)) continue
        seen.add(key)
      }
      const d: DayUsage = (days[date] ??= { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 })
      d.input += input
      d.output += output
      d.cacheRead += cr
      d.cacheWrite += cw
      d.total += input + output + cr + cw
    }
  }
  return days
}

export function dailyUsage(plugin: string): Promise<DailyUsage> {
  if (plugin !== 'claude' && plugin !== 'codex') return Promise.resolve({})
  // 同时多次请求时共用一次扫描
  return (pending[plugin] ??= collect(plugin).finally(() => {
    pending[plugin] = null
  }))
}
