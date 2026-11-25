import { monaco } from '../monaco'
import { h, toast } from '../dom'
import { t } from '../i18n'
import { aiSettings, modelLabel, nextRequestId, onAiChange, updateAiSettings } from './client'
import { completionContext } from './context'

/**
 * 行内补全（灰色提示文字，Tab 接受）。
 * 停止输入一小段时间后，把光标前后的代码发给设置里选的服务；Monaco 在继续输入时会取消上一次请求，
 * 这里同时通知主进程中止网络请求。最近的结果按光标前后的文本缓存。
 */

const DEBOUNCE_MS = 300

/* ---------------- 接受率统计与自适应触发 ---------------- */

/** 光标所在位置的类别：普通代码 / 注释 / 字符串 */
type Where = 'code' | 'comment' | 'string'
type Outcome = 'accepted' | 'rejected' | 'reverted'
interface StatEvent {
  where: Where
  outcome: Outcome
}

const STATS_KEY = 'infinite.ai.completionStats'
let events: StatEvent[] = (() => {
  try {
    const raw = JSON.parse(localStorage.getItem(STATS_KEY) ?? '[]') as StatEvent[]
    return Array.isArray(raw) ? raw.filter((e) => e && typeof e.where === 'string' && typeof e.outcome === 'string').slice(-200) : []
  } catch {
    return []
  }
})()
let saveTimer: ReturnType<typeof setTimeout> | undefined
function saveStats(): void {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => localStorage.setItem(STATS_KEY, JSON.stringify(events)), 1000)
  statusListeners.forEach((fn) => fn())
}
function record(where: Where, outcome: Outcome): StatEvent {
  const e = { where, outcome }
  events.push(e)
  if (events.length > 200) events = events.slice(-200)
  saveStats()
  return e
}

/** 某类位置最近的接受率（接受后很快被删掉的不算接受） */
function rate(where: Where | null, n = 40): { shown: number; accepted: number; reverted: number; rate: number } {
  const list = events.filter((e) => !where || e.where === where).slice(-n)
  const accepted = list.filter((e) => e.outcome === 'accepted').length
  const reverted = list.filter((e) => e.outcome === 'reverted').length
  const shown = list.length
  return { shown, accepted, reverted, rate: shown ? accepted / shown : 0 }
}

/** 设置页显示的统计 */
export function completionStats(): { shown: number; accepted: number; reverted: number; rate: number; debounce: number } {
  return { ...rate(null, 200), debounce: debounceFor('code') }
}

export function resetCompletionStats(): void {
  events = []
  localStorage.removeItem(STATS_KEY)
  statusListeners.forEach((fn) => fn())
}

export function onCompletionStats(fn: () => void): () => void {
  statusListeners.add(fn)
  return () => statusListeners.delete(fn)
}

/** 自适应的防抖时间：接受率低时等久一点再请求（少打扰、省额度），高时更积极 */
function debounceFor(where: Where): number {
  if (!aiSettings().adaptive) return DEBOUNCE_MS
  const r = rate(where)
  let ms = DEBOUNCE_MS
  if (r.shown >= 10) ms = r.rate < 0.1 ? 750 : r.rate < 0.2 ? 500 : r.rate > 0.45 ? 180 : DEBOUNCE_MS
  return where === 'comment' ? ms * 2 : ms
}

/** 自动触发是否应该跳过这类位置：字符串里不自动补全；注释里接受率一直很低时也不再自动补全 */
function skipAuto(where: Where): boolean {
  if (where === 'string') return true
  if (where === 'comment' && aiSettings().adaptive) {
    const r = rate('comment')
    return r.shown >= 12 && r.rate < 0.05
  }
  return false
}

/** 用 Monarch 对光标前几十行重新分词，看光标处的记号是不是注释 / 字符串 */
function whereAt(model: monaco.editor.ITextModel, pos: monaco.Position): Where {
  try {
    const from = Math.max(1, pos.lineNumber - 30)
    const text = model.getValueInRange(new monaco.Range(from, 1, pos.lineNumber, pos.column))
    const lines = monaco.editor.tokenize(text, model.getLanguageId())
    const last = lines[lines.length - 1]
    if (!last?.length) return 'code'
    const off = Math.max(0, pos.column - 2)
    let tok = last[0]
    for (const tk of last) if (tk.offset <= off) tok = tk
    if (/comment/.test(tok.type)) return 'comment'
    if (/string/.test(tok.type) && !/string\.(escape|key)/.test(tok.type)) return 'string'
  } catch {
    /* 没有分词规则的语言 */
  }
  return 'code'
}

interface Item extends monaco.languages.InlineCompletion {
  meta: { model: monaco.editor.ITextModel; range: monaco.IRange; text: string; where: Where; shown: boolean }
}

/** 接受的建议：几秒后看看还在不在（被删掉算“没用上”） */
function watchAccepted(item: Item, ev: StatEvent): void {
  const { model, range, text } = item.meta
  if (model.isDisposed()) return
  const decos = model.deltaDecorations([], [
    { range: new monaco.Range(range.startLineNumber, range.startColumn, range.startLineNumber, range.startColumn), options: { stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges } }
  ])
  setTimeout(() => {
    if (model.isDisposed()) return
    const at = model.getDecorationRange(decos[0])
    model.deltaDecorations(decos, [])
    const first = text.split('\n')[0].trim().slice(0, 40)
    if (!at || !first) return
    const end = Math.min(model.getLineCount(), at.startLineNumber + text.split('\n').length + 2)
    const now = model.getValueInRange(new monaco.Range(at.startLineNumber, 1, end, model.getLineMaxColumn(end)))
    if (!now.includes(first)) {
      ev.outcome = 'reverted'
      saveStats()
    }
  }, 8000)
}
const PREFIX_CHARS = 6000
const SUFFIX_CHARS = 2000
const MAX_LINES = 40

type Status = 'idle' | 'busy' | 'error'
let status: Status = 'idle'
let lastError = ''
const statusListeners = new Set<() => void>()
function setStatus(s: Status, err = ''): void {
  status = s
  if (err) lastError = err
  statusListeners.forEach((fn) => fn())
}

/** 最近的补全结果：key 是光标前后的文本片段 */
const cache = new Map<string, string>()
function remember(key: string, text: string): void {
  cache.delete(key)
  cache.set(key, text)
  if (cache.size > 60) cache.delete(cache.keys().next().value!)
}

/** 同一个错误（没填 Key 等）一分钟内只提示一次，避免每次输入都弹 */
let lastToast = { msg: '', at: 0 }
function reportError(msg: string): void {
  setStatus('error', msg)
  const now = Date.now()
  if (msg === lastToast.msg && now - lastToast.at < 60_000) return
  lastToast = { msg, at: now }
  toast(t('行内补全：') + msg)
}

const sleep = (ms: number, token: monaco.CancellationToken) =>
  new Promise<boolean>((resolve) => {
    if (ms <= 0) return resolve(!token.isCancellationRequested)
    const timer = setTimeout(() => {
      sub.dispose()
      resolve(!token.isCancellationRequested)
    }, ms)
    const sub = token.onCancellationRequested(() => {
      clearTimeout(timer)
      sub.dispose()
      resolve(false)
    })
  })

/**
 * 整理模型的输出：去掉末尾空行；去掉和光标后面已有代码重复的部分（模型常把后面的代码再写一遍）。
 * after 是当前行光标后的文本，rest 是之后各行。
 */
function clean(text: string, after: string, rest: string[]): string {
  let s = text.replace(/\r\n/g, '\n').replace(/\s+$/, '')
  if (!s.trim()) return ''
  // 当前行光标后只有右括号之类：模型把它们也写出来了就去掉
  const tail = after.trim()
  if (tail && s.endsWith(tail)) s = s.slice(0, -tail.length).replace(/[ \t]+$/, '')
  let lines = s.split('\n')
  // 末尾几行和光标后面的几行一样：去掉
  const next = rest.filter((l) => l.trim()).slice(0, 5).map((l) => l.trim())
  for (let k = Math.min(lines.length - 1, next.length); k > 0; k--) {
    const end = lines.slice(-k).map((l) => l.trim())
    if (end.every((l, i) => l === next[i])) {
      lines = lines.slice(0, -k)
      break
    }
  }
  if (lines.length > MAX_LINES) lines = lines.slice(0, MAX_LINES)
  s = lines.join('\n').replace(/\s+$/, '')
  return s.trim() ? s : ''
}

const provider: monaco.languages.InlineCompletionsProvider<monaco.languages.InlineCompletions<Item>> = {
  async provideInlineCompletions(model, pos, ctx, token) {
    const cfg = aiSettings().completion
    if (!cfg.enabled) return
    const scheme = model.uri.scheme
    if (scheme !== 'file' && scheme !== 'nbcell') return
    if (model.getValueLength() > 3_000_000) return

    const explicit = ctx.triggerKind === monaco.languages.InlineCompletionTriggerKind.Explicit
    const line = model.getLineContent(pos.lineNumber)
    const after = line.slice(pos.column - 1)
    // 光标后面还有正文时不自动补全（只剩右括号、引号、分号时可以）
    const closersOnly = /^[\s)\]}>"'`;,]*$/.test(after)
    if (!explicit && !closersOnly) return
    const where = whereAt(model, pos)
    if (!explicit && skipAuto(where)) return

    const offset = model.getOffsetAt(pos)
    const total = model.getValueLength()
    const start = model.getPositionAt(Math.max(0, offset - PREFIX_CHARS))
    const end = model.getPositionAt(Math.min(total, offset + SUFFIX_CHARS))
    const prefix = model.getValueInRange(new monaco.Range(start.lineNumber, start.column, pos.lineNumber, pos.column))
    const suffix = model.getValueInRange(new monaco.Range(pos.lineNumber, pos.column, end.lineNumber, end.column))
    // 刚输入空格 / 空行时不急着请求
    if (!explicit && !prefix.trim()) return

    const key = `${cfg.provider}|${cfg.model ?? ''}|${prefix.slice(-400)}\u0000${suffix.slice(0, 160)}`
    let text = cache.get(key)
    if (text === undefined) {
      // 等待防抖的同时收集上下文（其他文件的相关代码）
      const ctxJob = completionContext(model, pos).catch(() => '')
      if (!(await sleep(explicit ? 0 : debounceFor(where), token))) return
      const context = await ctxJob
      if (token.isCancellationRequested) return
      const id = nextRequestId()
      const sub = token.onCancellationRequested(() => window.api.ai.cancel(id))
      setStatus('busy')
      const r = await window.api.ai
        .complete(id, {
          provider: cfg.provider,
          model: cfg.model,
          prefix,
          suffix,
          language: model.getLanguageId(),
          path: model.uri.scheme === 'file' ? model.uri.fsPath : 'notebook cell',
          context: context || undefined
        })
        .catch((e) => ({ ok: false as const, error: String((e as Error)?.message ?? e) }))
      sub.dispose()
      if (!r.ok) {
        if ('cancelled' in r && r.cancelled) setStatus('idle')
        else reportError(r.error)
        return
      }
      setStatus('idle')
      text = clean(r.text, after, suffix.split('\n').slice(1))
      remember(key, text)
    }
    if (!text || token.isCancellationRequested) return
    // 光标后面还有字符时，多行建议要求替换到行尾：只保留第一行，保证显示正确
    if (after.length && text.includes('\n')) text = text.split('\n')[0]
    if (!text.trim()) return
    const range = new monaco.Range(pos.lineNumber, pos.column, pos.lineNumber, pos.column)
    return { items: [{ insertText: text, range, meta: { model, range, text, where, shown: false } }] }
  },
  handleItemDidShow(_list, item) {
    item.meta.shown = true
  },
  handleEndOfLifetime(_list, item, reason) {
    if (!item.meta.shown) return
    const K = monaco.languages.InlineCompletionEndOfLifeReasonKind
    if (reason.kind === K.Accepted) watchAccepted(item, record(item.meta.where, 'accepted'))
    else if (reason.kind === K.Rejected) record(item.meta.where, 'rejected')
    // 继续输入且和建议一致时（Ignored、没有 userTypingDisagreed）不计
    else if (reason.userTypingDisagreed) record(item.meta.where, 'rejected')
  },
  disposeInlineCompletions() {
    /* 没有需要释放的资源 */
  }
}

export function initInlineCompletion(): void {
  monaco.languages.registerInlineCompletionsProvider('*', provider)
  // Monaco 的行内补全在建议被接受 / 作废时，内部的 timeout() 会以 CancellationError 拒绝且没人接，属于正常取消，不当作错误
  window.addEventListener('unhandledrejection', (e) => {
    if ((e.reason as Error | undefined)?.name === 'Canceled') e.preventDefault()
  })
}

/** 状态栏上的开关：显示行内补全是否开启 / 正在请求 / 出错，点击切换 */
export function createAiStatusItem(): HTMLElement {
  const el = h('button', {
    class: 'st-item st-ai',
    onClick: () => {
      const on = !aiSettings().completion.enabled
      updateAiSettings((s) => (s.completion.enabled = on))
      if (on) setStatus('idle')
      toast(on ? t('已开启 AI 行内补全') : t('已关闭 AI 行内补全'))
    }
  })
  const render = () => {
    const on = aiSettings().completion.enabled
    el.dataset.state = !on ? 'off' : status
    el.replaceChildren(h('span', { class: 'st-ai-mark' }, '✦'), 'AI')
    const head = on ? t('AI 行内补全：已开启（{0}）', modelLabel('completion')) : t('AI 行内补全：已关闭')
    const tail = on && status === 'error' && lastError ? '\n' + lastError : ''
    const st = rate(null, 200)
    const stat = st.shown >= 5 ? '\n' + t('最近接受率 {0}%（{1} 次建议）', Math.round(st.rate * 100), st.shown) : ''
    el.title = `${head}${tail}${stat}\n${t('点击开启 / 关闭 · Ctrl I 内联编辑')}`
  }
  statusListeners.add(render)
  onAiChange(render)
  render()
  return el
}
