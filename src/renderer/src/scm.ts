import type { GitChange, GitCommit } from '../../shared/types'
import { basename, h } from './dom'
import { openFile } from './editor'
import { icons } from './icons'
import { state } from './store'

/* ---------------- 源代码管理：Git 提交历史图 ---------------- */

const LIMIT = 500
const ROW = 26
const LANE = 12
const PAD = 8
const COLORS = ['var(--accent)', '#4f9cf0', '#3fb27f', '#c678dd', '#e0a040', '#e06c75', '#56b6c2']
const color = (lane: number) => COLORS[lane % COLORS.length]

/** 一行图里的线段：从 (x1, y1) 到 (x2, y2)，x 是车道号，y 取 0 顶 / 0.5 中 / 1 底 */
type Seg = { x1: number; y1: number; x2: number; y2: number; lane: number }
/** after：这一行下面仍然延续的车道（展开提交详情时，在详情区域里把这些线接上） */
type Row = { commit: GitCommit; col: number; segs: Seg[]; width: number; after: number[] }

/**
 * 经典的车道分配：lanes[i] 是第 i 条车道接下来等待的提交。
 * 每个提交占用等待它的车道（没有就开新车道），第一个父提交沿用这条车道，其余父提交另开或汇入已有车道。
 */
export function layoutGraph(commits: GitCommit[]): Row[] {
  const lanes: (string | null)[] = []
  const rows: Row[] = []
  for (const c of commits) {
    const segs: Seg[] = []
    let col = lanes.indexOf(c.hash)
    const expected = col >= 0
    if (!expected) {
      col = lanes.indexOf(null)
      if (col < 0) col = lanes.push(null) - 1
    }
    const before = lanes.slice()
    // 上半段：等待这个提交的车道都汇到它；其余车道直通
    before.forEach((h, i) => {
      if (h === null) return
      if (h === c.hash) segs.push({ x1: i, y1: 0, x2: col, y2: 0.5, lane: i })
    })
    for (let i = 0; i < lanes.length; i++) if (lanes[i] === c.hash) lanes[i] = null

    // 下半段：父提交
    const [first, ...rest] = c.parents
    if (first) {
      const k = lanes.indexOf(first)
      if (k >= 0 && k !== col) {
        // 第一父提交已经有车道在等，汇过去，本车道结束
        segs.push({ x1: col, y1: 0.5, x2: k, y2: 1, lane: k })
      } else {
        lanes[col] = first
        segs.push({ x1: col, y1: 0.5, x2: col, y2: 1, lane: col })
      }
    }
    for (const p of rest) {
      let k = lanes.indexOf(p)
      if (k < 0) {
        k = lanes.indexOf(null)
        if (k < 0) k = lanes.push(null) - 1
        lanes[k] = p
      }
      segs.push({ x1: col, y1: 0.5, x2: k, y2: 1, lane: k })
    }
    // 直通的车道
    before.forEach((h, i) => {
      if (h !== null && h !== c.hash && lanes[i] === h) segs.push({ x1: i, y1: 0, x2: i, y2: 1, lane: i })
    })
    while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop()
    const after = lanes.flatMap((l, i) => (l === null ? [] : [i]))
    rows.push({ commit: c, col, segs, width: Math.max(before.length, lanes.length, col + 1), after })
  }
  return rows
}

function graphSvg(row: Row, width: number): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg'
  const svg = document.createElementNS(ns, 'svg')
  const w = PAD * 2 + Math.max(0, width - 1) * LANE
  svg.setAttribute('width', String(w))
  svg.setAttribute('height', String(ROW))
  svg.setAttribute('class', 'scm-graph')
  svg.setAttribute('aria-hidden', 'true')
  const x = (lane: number) => PAD + lane * LANE
  for (const s of row.segs) {
    const p = document.createElementNS(ns, 'path')
    const x1 = x(s.x1)
    const x2 = x(s.x2)
    const y1 = s.y1 * ROW
    const y2 = s.y2 * ROW
    // 斜着走的线用曲线，竖线直接画
    const d = x1 === x2 ? `M${x1} ${y1}V${y2}` : `M${x1} ${y1}C${x1} ${(y1 + y2) / 2} ${x2} ${(y1 + y2) / 2} ${x2} ${y2}`
    p.setAttribute('d', d)
    p.setAttribute('stroke', color(s.lane))
    p.setAttribute('stroke-width', '1.5')
    p.setAttribute('fill', 'none')
    svg.append(p)
  }
  const dot = document.createElementNS(ns, 'circle')
  dot.setAttribute('cx', String(x(row.col)))
  dot.setAttribute('cy', String(ROW / 2))
  const merge = row.commit.parents.length > 1
  dot.setAttribute('r', merge ? '3' : '3.5')
  dot.setAttribute('fill', merge ? 'var(--bg)' : color(row.col))
  dot.setAttribute('stroke', color(row.col))
  dot.setAttribute('stroke-width', '1.5')
  svg.append(dot)
  return svg
}

/** 展开详情区域左侧的竖线，让图在详情下面不断开 */
function continuationSvg(row: Row, width: number): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg'
  const svg = document.createElementNS(ns, 'svg')
  const w = PAD * 2 + Math.max(0, width - 1) * LANE
  svg.setAttribute('class', 'scm-cont')
  svg.setAttribute('width', String(w))
  svg.setAttribute('viewBox', `0 0 ${w} 10`)
  svg.setAttribute('preserveAspectRatio', 'none')
  svg.setAttribute('aria-hidden', 'true')
  for (const lane of row.after) {
    const p = document.createElementNS(ns, 'path')
    p.setAttribute('d', `M${PAD + lane * LANE} 0V10`)
    p.setAttribute('stroke', color(lane))
    p.setAttribute('stroke-width', '1.5')
    p.setAttribute('vector-effect', 'non-scaling-stroke')
    svg.append(p)
  }
  return svg
}

function ago(t: number): string {
  const s = Math.max(0, (Date.now() - t) / 1000)
  if (s < 60) return '刚刚'
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`
  if (s < 86400 * 30) return `${Math.floor(s / 86400)} 天前`
  const d = new Date(t)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function refBadge(ref: string): HTMLElement {
  let label = ref
  let kind = 'branch'
  if (ref.startsWith('HEAD -> ')) {
    label = ref.slice(8)
    kind = 'head'
  } else if (ref === 'HEAD') kind = 'head'
  else if (ref.startsWith('tag: ')) {
    label = ref.slice(5)
    kind = 'tag'
  } else if (ref.includes('/')) kind = 'remote'
  return h('span', { class: `scm-ref ${kind}`, title: ref }, label)
}

/* ---------------- 视图 ---------------- */

let listEl: HTMLElement
let infoEl: HTMLElement
let loadedRoot: string | null = null
let loading = false
let pending = false
const expandedCommits = new Set<string>()
const changeCache = new Map<string, GitChange[]>()

export function createScmView(): HTMLElement {
  listEl = h('div', { class: 'scm-list', role: 'list', 'aria-label': '提交历史' })
  infoEl = h('div', { class: 'scm-info' })
  return h(
    'div',
    { class: 'side-view', 'data-view': 'scm' },
    h(
      'div',
      { class: 'side-head' },
      h('span', { class: 'side-title' }, '源代码管理'),
      h(
        'div',
        { class: 'side-actions' },
        h('button', { class: 'icon-btn small', 'aria-label': '刷新提交历史', title: '刷新', html: icons.refresh, onClick: () => void refreshScm(true) })
      )
    ),
    infoEl,
    listEl
  )
}

/** 打开文件夹 / 切换到这个视图 / .git 有变化时调用；force 时忽略缓存 */
export async function refreshScm(force = false): Promise<void> {
  const root = state.root
  if (!root) {
    loadedRoot = null
    listEl.replaceChildren()
    infoEl.replaceChildren()
    return
  }
  if (!force && loadedRoot === root) return
  if (loading) {
    pending = true
    return
  }
  loading = true
  if (loadedRoot !== root) {
    expandedCommits.clear()
    changeCache.clear()
    listEl.replaceChildren()
    infoEl.replaceChildren(h('span', { class: 'muted' }, '正在读取提交历史…'))
  }
  try {
    const res = await window.api.git.log(root, LIMIT)
    if (state.root !== root) return
    loadedRoot = root
    if (!res.ok) {
      listEl.replaceChildren()
      const msg = { 'no-git': '没有找到 git，请先安装 Git 并加入 PATH', 'not-repo': '当前文件夹不是 Git 仓库', error: '读取提交历史失败' }[res.reason]
      infoEl.replaceChildren(h('p', { class: 'scm-empty' }, msg))
      if (res.reason === 'error' && res.message) infoEl.append(h('p', { class: 'scm-empty small' }, res.message))
      return
    }
    if (!res.commits.length) {
      listEl.replaceChildren()
      infoEl.replaceChildren(h('p', { class: 'scm-empty' }, '还没有任何提交'))
      return
    }
    infoEl.replaceChildren(
      h('span', { class: 'muted' }, headLabel(res.commits)),
      h('span', { class: 'muted' }, res.commits.length >= LIMIT ? `最近 ${LIMIT} 个提交` : `${res.commits.length} 个提交`)
    )
    renderRows(layoutGraph(res.commits))
  } finally {
    loading = false
    if (pending) {
      pending = false
      void refreshScm(true)
    }
  }
}

function headLabel(commits: GitCommit[]): string {
  for (const c of commits) {
    for (const r of c.refs) {
      if (r.startsWith('HEAD -> ')) return `当前分支 ${r.slice(8)}`
      if (r === 'HEAD') return `分离的 HEAD · ${c.hash.slice(0, 7)}`
    }
  }
  return ''
}

function renderRows(rows: Row[]): void {
  const width = rows.reduce((m, r) => Math.max(m, r.width), 1)
  const graphW = Math.min(width, 8)
  listEl.replaceChildren(
    ...rows.map((row) => {
      const c = row.commit
      const files = h('div', { class: 'scm-files' })
      const gw = Math.max(graphW, row.width)
      const changes = h(
        'div',
        { class: 'scm-changes', hidden: !expandedCommits.has(c.hash), style: { paddingLeft: `${PAD * 2 + Math.max(0, gw - 1) * LANE}px` } },
        continuationSvg(row, gw),
        h('div', { class: 'scm-meta' }, `${c.author} · ${ago(c.time)} · ${c.hash.slice(0, 7)}`),
        files
      )
      const item = h(
        'div',
        { class: 'scm-item', role: 'listitem' },
        h(
          'button',
          {
            class: 'scm-row' + (expandedCommits.has(c.hash) ? ' open' : ''),
            title: `${c.subject}\n\n${c.author} <${c.email}>\n${new Date(c.time).toLocaleString()}\n${c.hash}`,
            'aria-expanded': String(expandedCommits.has(c.hash)),
            onClick: (e: MouseEvent) => void toggleCommit(c, e.currentTarget as HTMLElement, changes, files)
          },
          graphSvg(row, gw),
          h('span', { class: 'scm-text' }, h('span', { class: 'scm-line1' }, ...c.refs.map(refBadge), h('span', { class: 'scm-subject' }, c.subject || '(无提交说明)')))
        ),
        changes
      )
      if (expandedCommits.has(c.hash)) void fillChanges(c, files)
      return item
    })
  )
}

async function toggleCommit(c: GitCommit, btn: HTMLElement, box: HTMLElement, files: HTMLElement): Promise<void> {
  const open = !expandedCommits.has(c.hash)
  if (open) expandedCommits.add(c.hash)
  else expandedCommits.delete(c.hash)
  btn.classList.toggle('open', open)
  btn.setAttribute('aria-expanded', String(open))
  box.hidden = !open
  if (open) await fillChanges(c, files)
}

/** git 输出的是 / 分隔的相对路径，按 root 的写法拼成完整路径 */
function joinPath(root: string, rel: string): string {
  const sep = root.includes('\\') ? '\\' : '/'
  return root.replace(/[\\/]+$/, '') + sep + rel.split('/').join(sep)
}

const STATUS: Record<string, string> = { A: '新增', M: '修改', D: '删除', R: '重命名', C: '复制', T: '类型变更' }

async function fillChanges(c: GitCommit, box: HTMLElement): Promise<void> {
  const root = state.root
  if (!root) return
  let list = changeCache.get(c.hash)
  if (!list) {
    box.replaceChildren(h('div', { class: 'scm-change muted' }, '读取中…'))
    try {
      list = await window.api.git.changes(root, c.hash)
      changeCache.set(c.hash, list)
    } catch {
      box.replaceChildren(h('div', { class: 'scm-change muted' }, '读取改动失败'))
      return
    }
  }
  if (!list.length) {
    box.replaceChildren(h('div', { class: 'scm-change muted' }, c.parents.length > 1 ? '合并提交，没有额外改动' : '没有文件改动'))
    return
  }
  box.replaceChildren(
    ...list.map((ch) => {
      const dir = ch.path.includes('/') ? ch.path.slice(0, ch.path.lastIndexOf('/')) : ''
      return h(
        'button',
        {
          class: 'scm-change',
          title: (ch.from ? `${ch.from} → ` : '') + ch.path + (ch.status === 'D' ? '（已删除）' : ''),
          disabled: ch.status === 'D',
          // openFile 自己会提示“文件不存在”等错误
          onClick: () => void openFile(joinPath(root, ch.path))
        },
        h('span', { class: `scm-status s-${ch.status}`, title: STATUS[ch.status] ?? ch.status }, ch.status),
        h('span', { class: 'scm-file' }, basename(ch.path)),
        dir ? h('span', { class: 'scm-dir' }, dir) : null
      )
    })
  )
}
