import { basename, h, toast } from '../dom'
import { closeView, openFile, openView } from '../editor'
import { languageFor, monaco } from '../monaco'
import type { DiffInfo } from './types'

/** 一段差异：lines 每行以 ' ' / '-' / '+' 开头 */
export interface Hunk {
  oldStart: number
  newStart: number
  lines: string[]
}

function splitLines(s: string): string[] {
  if (!s) return []
  const a = s.split(/\r?\n/)
  if (a[a.length - 1] === '') a.pop()
  return a
}

/** 按行比较，返回带前缀的行。太大时退化为整段替换 */
export function lineDiff(a: string, b: string): string[] {
  const A = splitLines(a)
  const B = splitLines(b)
  // 去掉相同的头尾，缩小 LCS 规模
  let pre = 0
  while (pre < A.length && pre < B.length && A[pre] === B[pre]) pre++
  let suf = 0
  while (suf < A.length - pre && suf < B.length - pre && A[A.length - 1 - suf] === B[B.length - 1 - suf]) suf++
  const a2 = A.slice(pre, A.length - suf)
  const b2 = B.slice(pre, B.length - suf)
  const mid: string[] = []
  if (a2.length * b2.length > 4_000_000) {
    for (const x of a2) mid.push('-' + x)
    for (const x of b2) mid.push('+' + x)
  } else {
    const n = a2.length
    const m = b2.length
    const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a2[i] === b2[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    let i = 0
    let j = 0
    while (i < n && j < m) {
      if (a2[i] === b2[j]) {
        mid.push(' ' + a2[i])
        i++
        j++
      } else if (dp[i + 1][j] >= dp[i][j + 1]) mid.push('-' + a2[i++])
      else mid.push('+' + b2[j++])
    }
    while (i < n) mid.push('-' + a2[i++])
    while (j < m) mid.push('+' + b2[j++])
  }
  return [...A.slice(0, pre).map((x) => ' ' + x), ...mid, ...A.slice(A.length - suf).map((x) => ' ' + x)]
}

/** 把完整的逐行差异切成带上下文的若干段：先标记要保留的行，再连续分组 */
export function hunksFrom(lines: string[], context = 3, oldStart = 1, newStart = 1): Hunk[] {
  const keep = new Uint8Array(lines.length)
  for (let i = 0; i < lines.length; i++) {
    if (lines[i][0] === ' ') continue
    for (let k = Math.max(0, i - context); k <= Math.min(lines.length - 1, i + context); k++) keep[k] = 1
  }
  const hunks: Hunk[] = []
  let oldNo = oldStart
  let newNo = newStart
  let cur: Hunk | null = null
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i][0]
    if (keep[i]) {
      if (!cur) {
        cur = { oldStart: oldNo, newStart: newNo, lines: [] }
        hunks.push(cur)
      }
      cur.lines.push(lines[i])
    } else cur = null
    if (t !== '+') oldNo++
    if (t !== '-') newNo++
  }
  return hunks
}

export function countChanges(hunks: Hunk[]): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const hk of hunks)
    for (const l of hk.lines) {
      if (l[0] === '+') added++
      else if (l[0] === '-') removed++
    }
  return { added, removed }
}

/** 解析 unified diff（Codex 的 FileUpdateChange.diff） */
export function parseUnified(diff: string): Hunk[] {
  const hunks: Hunk[] = []
  let cur: Hunk | null = null
  for (const line of diff.split(/\r?\n/)) {
    const m = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/)
    if (m) {
      cur = { oldStart: +m[1], newStart: +m[2], lines: [] }
      hunks.push(cur)
      continue
    }
    if (!cur) continue
    if (line.startsWith('\\')) continue
    if (line[0] === ' ' || line[0] === '+' || line[0] === '-') cur.lines.push(line)
    else if (line === '') cur.lines.push(' ')
  }
  // 没有 @@ 头：整段都是新增（新文件）
  if (!hunks.length && diff.trim() && !/^(---|\+\+\+|diff )/m.test(diff)) {
    hunks.push({ oldStart: 0, newStart: 1, lines: splitLines(diff).map((l) => '+' + l) })
  }
  return hunks
}

/** 把差异应用到原文；reverse 为 true 时从修改后的内容还原原文 */
export function applyHunks(text: string, hunks: Hunk[], reverse = false): string {
  const src = splitLines(text)
  const out: string[] = []
  let pos = 0
  for (const hk of hunks) {
    const start = Math.max(0, (reverse ? hk.newStart : hk.oldStart) - 1)
    while (pos < start && pos < src.length) out.push(src[pos++])
    for (const l of hk.lines) {
      const t = l[0]
      const body = l.slice(1)
      const del = reverse ? '+' : '-'
      const add = reverse ? '-' : '+'
      if (t === ' ') {
        out.push(src[pos] ?? body)
        pos++
      } else if (t === del) pos++
      else if (t === add) out.push(body)
    }
  }
  while (pos < src.length) out.push(src[pos++])
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  return out.join(eol) + (text === '' || /\n$/.test(text) ? eol : '')
}

/** 内联显示的差异 */
export function renderDiff(d: DiffInfo, maxLines = 400): HTMLElement {
  const rows: HTMLElement[] = []
  let shown = 0
  for (let i = 0; i < d.hunks.length; i++) {
    const hk = d.hunks[i]
    if (i > 0) rows.push(h('div', { class: 'diff-sep' }, '⋯'))
    let o = hk.oldStart
    let n = hk.newStart
    for (const l of hk.lines) {
      if (shown++ >= maxLines) break
      const t = l[0]
      const cls = t === '+' ? 'add' : t === '-' ? 'del' : 'ctx'
      const no = t === '+' ? String(n) : String(o)
      rows.push(h('div', { class: 'diff-row ' + cls }, h('span', { class: 'diff-no' }, no), h('span', { class: 'diff-sign' }, t === ' ' ? '' : t), h('span', { class: 'diff-code' }, l.slice(1) || ' ')))
      if (t !== '+') o++
      if (t !== '-') n++
    }
  }
  const total = d.hunks.reduce((s, x) => s + x.lines.length, 0)
  if (total > maxLines) rows.push(h('div', { class: 'diff-sep' }, `还有 ${total - maxLines} 行未显示`))
  return h('div', { class: 'diff' }, ...rows)
}

export function diffStat(d: { added: number; removed: number }): HTMLElement {
  return h('span', { class: 'diff-stat' }, d.added ? h('span', { class: 'add' }, '+' + d.added) : null, d.removed ? h('span', { class: 'del' }, '-' + d.removed) : null)
}

/* ---------------- 完整对比视图 ---------------- */

export interface DiffTabActions {
  accept?: () => void
  reject?: () => void
}

/** 在编辑区打开左右对比视图（类似 VS Code 扩展的“查看建议的修改”），返回关闭函数 */
export async function openDiffTab(d: DiffInfo, actions: DiffTabActions = {}): Promise<(() => void) | null> {
  if (!d.load) return null
  let sides: { original: string; modified: string }
  try {
    sides = await d.load()
  } catch (e) {
    toast('无法读取文件：' + String((e as Error)?.message ?? e))
    return null
  }
  const lang = languageFor(d.path)
  const original = monaco.editor.createModel(sides.original, lang)
  const modified = monaco.editor.createModel(sides.modified, lang)
  const host = h('div', { class: 'diffview-editor' })
  const pending = !!(actions.accept || actions.reject)
  let editor: monaco.editor.IStandaloneDiffEditor | null = null
  const close = () => closeView(el)
  const choose = (fn?: () => void) => {
    fn?.()
    close()
  }
  const el: HTMLElement = h(
    'div',
    { class: 'diffview' },
    h(
      'div',
      { class: 'diffview-bar' },
      h('span', { class: 'diffview-title' }, d.path),
      diffStat(d),
      h('span', { class: 'grow' }),
      h('button', { class: 'btn small', onClick: () => void openFile(d.path) }, '打开文件'),
      pending ? h('button', { class: 'btn small', onClick: () => choose(actions.reject) }, '拒绝') : null,
      pending ? h('button', { class: 'btn small primary', onClick: () => choose(actions.accept) }, '接受') : null
    ),
    host
  )
  openView({
    title: `${basename(d.path)}（对比）`,
    kind: 'diff',
    el,
    onShow: () => {
      if (editor) return
      editor = monaco.editor.createDiffEditor(host, {
        automaticLayout: true,
        readOnly: true,
        originalEditable: false,
        renderSideBySide: true,
        minimap: { enabled: false },
        scrollBeyondLastLine: false
      })
      editor.setModel({ original, modified })
    },
    onClose: () => {
      editor?.dispose()
      original.dispose()
      modified.dispose()
    }
  })
  return close
}
