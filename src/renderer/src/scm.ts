import type { GitChange, GitCommit, GitFile, GitOp, GitStatus } from '../../shared/types'
import { basename, h, toast } from './dom'
import { closeView, openFile, openView } from './editor'
import { fmtDate, t } from './i18n'
import { icons } from './icons'
import { showMenu, type MenuItem } from './menu'
import { languageFor, monaco } from './monaco'
import { state } from './store'

/* ================================================================
 * 源代码管理（仿 VS Code）：
 *   上半部分“更改”：提交信息、提交按钮、暂存的更改 / 更改 / 合并冲突
 *   下半部分“图形”：所有分支的提交历史图
 * ================================================================ */

const LIMIT = 500
const ROW = 24
const LANE = 12
const PAD = 9
const COLORS = ['var(--accent)', '#4f9cf0', '#3fb27f', '#c678dd', '#e0a040', '#e06c75', '#56b6c2']
const color = (lane: number) => COLORS[lane % COLORS.length]

/* ---------------- 提交图布局 ---------------- */

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
    if (col < 0) {
      col = lanes.indexOf(null)
      if (col < 0) col = lanes.push(null) - 1
    }
    const before = lanes.slice()
    before.forEach((x, i) => {
      if (x !== null && x === c.hash) segs.push({ x1: i, y1: 0, x2: col, y2: 0.5, lane: i })
    })
    for (let i = 0; i < lanes.length; i++) if (lanes[i] === c.hash) lanes[i] = null

    const [first, ...rest] = c.parents
    if (first) {
      const k = lanes.indexOf(first)
      if (k >= 0 && k !== col) segs.push({ x1: col, y1: 0.5, x2: k, y2: 1, lane: k })
      else {
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
    before.forEach((x, i) => {
      if (x !== null && x !== c.hash && lanes[i] === x) segs.push({ x1: i, y1: 0, x2: i, y2: 1, lane: i })
    })
    while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop()
    const after = lanes.flatMap((l, i) => (l === null ? [] : [i]))
    rows.push({ commit: c, col, segs, width: Math.max(before.length, lanes.length, col + 1), after })
  }
  return rows
}

const NS = 'http://www.w3.org/2000/svg'
const graphW = (width: number) => PAD * 2 + Math.max(0, width - 1) * LANE

function graphSvg(row: Row, width: number, head: boolean): SVGSVGElement {
  const svg = document.createElementNS(NS, 'svg')
  svg.setAttribute('width', String(graphW(width)))
  svg.setAttribute('height', String(ROW))
  svg.setAttribute('class', 'scm-graph')
  svg.setAttribute('aria-hidden', 'true')
  const x = (lane: number) => PAD + lane * LANE
  for (const s of row.segs) {
    const p = document.createElementNS(NS, 'path')
    const x1 = x(s.x1)
    const x2 = x(s.x2)
    const y1 = s.y1 * ROW
    const y2 = s.y2 * ROW
    const d = x1 === x2 ? `M${x1} ${y1}V${y2}` : `M${x1} ${y1}C${x1} ${(y1 + y2) / 2} ${x2} ${(y1 + y2) / 2} ${x2} ${y2}`
    p.setAttribute('d', d)
    p.setAttribute('stroke', color(s.lane))
    p.setAttribute('stroke-width', '2')
    p.setAttribute('fill', 'none')
    svg.append(p)
  }
  const cx = String(x(row.col))
  const c = color(row.col)
  if (head) {
    // 当前 HEAD：外圈 + 实心点，和 VS Code 图形视图一样醒目
    const ring = document.createElementNS(NS, 'circle')
    ring.setAttribute('cx', cx)
    ring.setAttribute('cy', String(ROW / 2))
    ring.setAttribute('r', '5.5')
    ring.setAttribute('fill', 'var(--bg)')
    ring.setAttribute('stroke', c)
    ring.setAttribute('stroke-width', '2')
    svg.append(ring)
  }
  const dot = document.createElementNS(NS, 'circle')
  dot.setAttribute('cx', cx)
  dot.setAttribute('cy', String(ROW / 2))
  const merge = row.commit.parents.length > 1
  dot.setAttribute('r', head ? '2.5' : merge ? '3' : '3.5')
  dot.setAttribute('fill', merge && !head ? 'var(--panel)' : c)
  dot.setAttribute('stroke', c)
  dot.setAttribute('stroke-width', merge && !head ? '2' : '0')
  svg.append(dot)
  return svg
}

/** 展开详情区域左侧的竖线，让图在详情下面不断开 */
function continuationSvg(row: Row, width: number): SVGSVGElement {
  const svg = document.createElementNS(NS, 'svg')
  const w = graphW(width)
  svg.setAttribute('class', 'scm-cont')
  svg.setAttribute('width', String(w))
  svg.setAttribute('viewBox', `0 0 ${w} 10`)
  svg.setAttribute('preserveAspectRatio', 'none')
  svg.setAttribute('aria-hidden', 'true')
  for (const lane of row.after) {
    const p = document.createElementNS(NS, 'path')
    p.setAttribute('d', `M${PAD + lane * LANE} 0V10`)
    p.setAttribute('stroke', color(lane))
    p.setAttribute('stroke-width', '2')
    p.setAttribute('vector-effect', 'non-scaling-stroke')
    svg.append(p)
  }
  return svg
}

function ago(ms: number): string {
  const s = Math.max(0, (Date.now() - ms) / 1000)
  if (s < 60) return t('刚刚')
  if (s < 3600) return t('{0} 分钟前', Math.floor(s / 60))
  if (s < 86400) return t('{0} 小时前', Math.floor(s / 3600))
  if (s < 86400 * 30) return t('{0} 天前', Math.floor(s / 86400))
  return fmtDate(ms, { year: 'numeric', month: '2-digit', day: '2-digit' })
}

function refBadge(ref: string): HTMLElement {
  let label = ref
  let kind = 'branch'
  let icon = icons.branch
  if (ref.startsWith('HEAD -> ')) {
    label = ref.slice(8)
    kind = 'head'
    icon = icons.target
  } else if (ref === 'HEAD') kind = 'head'
  else if (ref.startsWith('tag: ')) {
    label = ref.slice(5)
    kind = 'tag'
  } else if (ref.includes('/')) {
    kind = 'remote'
    icon = icons.cloudUp
  }
  return h('span', { class: `scm-ref ${kind}`, title: ref }, h('span', { class: 'ic', html: icon }), h('span', { class: 'scm-ref-label' }, label))
}

/* ---------------- 文件类型小标记（类似 VS Code 的文件图标） ---------------- */

const BADGES: Record<string, [string, string]> = {
  ts: ['TS', '#4f9cf0'],
  tsx: ['TS', '#4f9cf0'],
  mts: ['TS', '#4f9cf0'],
  cts: ['TS', '#4f9cf0'],
  js: ['JS', '#e5c15c'],
  jsx: ['JS', '#e5c15c'],
  mjs: ['JS', '#e5c15c'],
  cjs: ['JS', '#e5c15c'],
  json: ['{}', '#e5c15c'],
  css: ['#', '#6e9bff'],
  scss: ['#', '#d36fa6'],
  less: ['#', '#6e9bff'],
  html: ['<>', '#e8784a'],
  vue: ['V', '#3fb27f'],
  md: ['M↓', '#8e8d93'],
  py: ['py', '#4f9cf0'],
  go: ['go', '#5fc4c0'],
  rs: ['rs', '#e8784a'],
  java: ['J', '#e06c75'],
  c: ['C', '#6e9bff'],
  h: ['h', '#c99bff'],
  cpp: ['C+', '#6e9bff'],
  cs: ['C#', '#3fb27f'],
  sh: ['$', '#3fb27f'],
  yml: ['!', '#e06c75'],
  yaml: ['!', '#e06c75'],
  svg: ['◇', '#e5c15c'],
  png: ['▣', '#c99bff'],
  jpg: ['▣', '#c99bff'],
  nsh: ['N', '#8e8d93'],
  lock: ['🔒', '#8e8d93']
}

function fileBadge(path: string): HTMLElement {
  const name = basename(path).toLowerCase()
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : ''
  const b = BADGES[ext]
  if (!b) return h('span', { class: 'scm-ficon', html: icons.file })
  return h('span', { class: 'scm-ficon', style: { color: b[1] } }, b[0])
}

const STATUS: Record<string, string> = {
  A: '新增',
  M: '已修改',
  D: '已删除',
  R: '已重命名',
  C: '已复制',
  T: '类型变更',
  U: '未跟踪',
  '!': '冲突'
}

/* ---------------- 状态 ---------------- */

let viewEl: HTMLElement
let progressEl: HTMLElement
let changesSec: HTMLElement
let changesBody: HTMLElement
let graphSec: HTMLElement
let graphBody: HTMLElement
let graphInfo: HTMLElement
let msgInput: HTMLTextAreaElement
let commitBtn: HTMLButtonElement
let commitMore: HTMLButtonElement
let commitLabel: HTMLElement
let sash: HTMLElement
let promptHost: HTMLElement

let status: Extract<GitStatus, { ok: true }> | null = null
let statusRoot: string | null = null
let loadedRoot: string | null = null
let logLoading = false
let logPending = false
let statusSeq = 0
let busy = 0
const expandedCommits = new Set<string>()
const changeCache = new Map<string, GitChange[]>()
const collapsedGroups = new Set<string>()
/** 每个仓库各自的提交信息草稿 */
const drafts = new Map<string, string>()
let countListener: ((n: number) => void) | null = null
let changesHeight: number | null = null

export function onScmCount(fn: (n: number) => void): void {
  countListener = fn
}

function setCount(): void {
  const n = status ? status.staged.length + status.changes.length + status.conflicts.length : 0
  countListener?.(n)
}

/** git 报错的信息去掉 IPC 的前缀 */
function errMsg(e: unknown): string {
  return String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}

/** 跑一个 git 操作：期间顶部显示进度条，结束后刷新 */
async function withBusy<T>(fn: () => Promise<T>, okMsg?: string): Promise<T | undefined> {
  busy++
  progressEl.classList.add('on')
  try {
    const r = await fn()
    if (okMsg) toast(okMsg)
    return r
  } catch (e) {
    toast(errMsg(e))
    return undefined
  } finally {
    busy--
    if (!busy) progressEl.classList.remove('on')
    void refreshScm(true)
  }
}

/* ---------------- 视图骨架 ---------------- */

function sectionHead(title: string, sec: () => HTMLElement, ...actions: HTMLElement[]): HTMLElement {
  return h(
    'div',
    {
      class: 'scm-sec-head',
      role: 'button',
      tabindex: '0',
      onClick: (e: MouseEvent) => {
        if ((e.target as HTMLElement).closest('.scm-sec-actions')) return
        toggleSection(sec())
      },
      onKeydown: (e: KeyboardEvent) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          toggleSection(sec())
        }
      }
    },
    h('span', { class: 'chev', html: icons.chevron }),
    h('span', { class: 'scm-sec-title' }, title),
    h('span', { class: 'grow' }),
    h('span', { class: 'scm-sec-actions' }, ...actions)
  )
}

function toggleSection(sec: HTMLElement): void {
  sec.classList.toggle('collapsed')
  sec.querySelector('.scm-sec-head')?.setAttribute('aria-expanded', String(!sec.classList.contains('collapsed')))
  layoutSections()
}

function iconBtn(label: string, icon: string, run: (e: MouseEvent) => void, cls = ''): HTMLButtonElement {
  return h('button', {
    class: 'icon-btn tiny ' + cls,
    'aria-label': label,
    title: label,
    html: icon,
    onClick: (e: MouseEvent) => {
      e.stopPropagation()
      run(e)
    }
  })
}

export function createScmView(): HTMLElement {
  progressEl = h('div', { class: 'scm-progress', 'aria-hidden': 'true' })
  promptHost = h('div', { class: 'scm-prompt-host' })

  msgInput = h('textarea', {
    class: 'scm-msg',
    rows: '1',
    spellcheck: 'false',
    'aria-label': t('提交信息'),
    onInput: () => {
      if (state.root) drafts.set(state.root, msgInput.value)
      autoGrow()
      renderCommitButton()
    },
    onKeydown: (e: KeyboardEvent) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault()
        void primaryAction()
      }
    }
  })
  commitLabel = h('span', { class: 'scm-commit-label' })
  commitBtn = h('button', { class: 'scm-commit-main', onClick: () => void primaryAction() }, commitLabel)
  commitMore = h('button', {
    class: 'scm-commit-more',
    'aria-label': t('更多提交操作'),
    title: t('更多提交操作'),
    html: icons.chevronDown,
    onClick: () => openCommitMenu()
  })

  changesBody = h('div', { class: 'scm-sec-body' })
  changesSec = h(
    'section',
    { class: 'scm-sec scm-changes-sec' },
    sectionHead(
      t('更改'),
      () => changesSec,
      iconBtn(t('提交##git'), icons.check, () => void commit()),
      iconBtn(t('刷新'), icons.refresh, () => void refreshScm(true)),
      iconBtn(t('更多操作'), icons.more, (e) => openMoreMenu(e))
    ),
    h(
      'div',
      { class: 'scm-sec-scroll' },
      h('div', { class: 'scm-input-box' }, h('div', { class: 'scm-msg-wrap' }, msgInput), h('div', { class: 'scm-commit' }, commitBtn, commitMore)),
      changesBody
    )
  )

  sash = h('div', { class: 'scm-sash', role: 'separator', 'aria-orientation': 'horizontal', title: t('拖动调整高度') })
  installSash()

  graphInfo = h('span', { class: 'scm-graph-info' })
  graphBody = h('div', { class: 'scm-list', role: 'list', 'aria-label': t('提交历史') })
  graphSec = h(
    'section',
    { class: 'scm-sec scm-graph-sec' },
    sectionHead(
      t('图形'),
      () => graphSec,
      iconBtn(t('提取'), icons.fetch, () => void withBusy(() => window.api.git.run(state.root!, 'fetch'))),
      iconBtn(t('拉取'), icons.pull, () => void runOp('pull')),
      iconBtn(t('推送'), icons.push, () => void runOp('push')),
      iconBtn(t('刷新'), icons.refresh, () => void refreshScm(true))
    ),
    graphInfo,
    graphBody
  )

  viewEl = h(
    'div',
    { class: 'side-view scm-view', 'data-view': 'scm' },
    progressEl,
    h('div', { class: 'side-head' }, h('span', { class: 'side-title' }, t('源代码管理')), h('div', { class: 'side-actions' }, iconBtn(t('更多操作'), icons.more, (e) => openMoreMenu(e)))),
    promptHost,
    changesSec,
    sash,
    graphSec
  )
  new ResizeObserver(() => layoutSections()).observe(viewEl)
  return viewEl
}

function autoGrow(): void {
  msgInput.style.height = 'auto'
  msgInput.style.height = Math.min(msgInput.scrollHeight, 180) + 'px'
}

/** 两个分区的高度：“更改”按内容高度，最多占一半多；图形占剩下的 */
function layoutSections(): void {
  const changesOpen = !changesSec.classList.contains('collapsed')
  const graphOpen = !graphSec.classList.contains('collapsed')
  sash.hidden = !(changesOpen && graphOpen)
  changesSec.style.flex = ''
  changesSec.style.height = ''
  if (changesOpen && graphOpen && changesHeight != null) {
    changesSec.style.flex = '0 0 auto'
    changesSec.style.height = changesHeight + 'px'
  }
  viewEl.classList.toggle('graph-collapsed', !graphOpen)
}

function installSash(): void {
  sash.addEventListener('mousedown', (e) => {
    e.preventDefault()
    const startY = e.clientY
    const startH = changesSec.getBoundingClientRect().height
    const total = viewEl.getBoundingClientRect().height
    sash.classList.add('on')
    document.body.classList.add('resizing-v')
    const move = (ev: MouseEvent) => {
      changesHeight = Math.round(Math.max(80, Math.min(total - 120, startH + ev.clientY - startY)))
      layoutSections()
    }
    const up = () => {
      sash.classList.remove('on')
      document.body.classList.remove('resizing-v')
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  })
  sash.addEventListener('dblclick', () => {
    changesHeight = null
    layoutSections()
  })
}

/* ---------------- 刷新 ---------------- */

/** 打开文件夹 / 切换到这个视图 / .git 有变化时调用；force 时重新读取提交历史 */
export async function refreshScm(force = false): Promise<void> {
  await Promise.all([refreshStatus(), refreshLog(force)])
}

/** 工作区文件变化时只刷新改动列表（很快） */
let statusTimer: ReturnType<typeof setTimeout> | undefined
export function scheduleScmStatus(): void {
  clearTimeout(statusTimer)
  statusTimer = setTimeout(() => void refreshStatus(), 350)
}

async function refreshStatus(): Promise<void> {
  const root = state.root
  const seq = ++statusSeq
  if (!root) {
    status = null
    statusRoot = null
    renderChanges()
    setCount()
    return
  }
  if (statusRoot !== root) {
    statusRoot = root
    status = null
    msgInput.value = drafts.get(root) ?? ''
    autoGrow()
  }
  const res = await window.api.git.status(root).catch((e) => ({ ok: false as const, reason: 'error' as const, message: errMsg(e) }))
  if (seq !== statusSeq || state.root !== root) return
  status = res.ok ? res : null
  renderChanges(res.ok ? undefined : res)
  setCount()
}

async function refreshLog(force: boolean): Promise<void> {
  const root = state.root
  if (!root) {
    loadedRoot = null
    graphBody.replaceChildren()
    graphInfo.replaceChildren()
    return
  }
  if (!force && loadedRoot === root) return
  if (logLoading) {
    logPending = true
    return
  }
  logLoading = true
  if (loadedRoot !== root) {
    expandedCommits.clear()
    changeCache.clear()
    graphBody.replaceChildren()
    graphInfo.replaceChildren(h('span', { class: 'muted' }, t('正在读取提交历史…')))
  }
  try {
    const res = await window.api.git.log(root, LIMIT)
    if (state.root !== root) return
    loadedRoot = root
    if (!res.ok) {
      graphBody.replaceChildren()
      graphInfo.replaceChildren()
      return
    }
    if (!res.commits.length) {
      graphBody.replaceChildren()
      graphInfo.replaceChildren(h('span', { class: 'muted' }, t('还没有任何提交')))
      return
    }
    graphInfo.replaceChildren()
    if (res.commits.length >= LIMIT) graphInfo.append(h('span', { class: 'muted' }, t('最近 {0} 个提交', LIMIT)))
    renderRows(layoutGraph(res.commits))
  } finally {
    logLoading = false
    if (logPending) {
      logPending = false
      void refreshLog(true)
    }
  }
}

/* ---------------- “更改”分区 ---------------- */

function renderChanges(err?: Extract<GitStatus, { ok: false }>): void {
  const root = state.root
  const box = changesSec.querySelector<HTMLElement>('.scm-input-box')!
  if (!root || err || !status) {
    box.hidden = true
    if (!root) changesBody.replaceChildren()
    else if (err?.reason === 'not-repo') {
      changesBody.replaceChildren(
        h(
          'div',
          { class: 'scm-empty-box' },
          h('p', {}, t('当前文件夹不是 Git 仓库。')),
          h('button', { class: 'scm-wide-btn', onClick: () => void withBusy(() => window.api.git.init(root), t('已初始化仓库')) }, h('span', { class: 'ic', html: icons.git }), t('初始化仓库'))
        )
      )
    } else if (err?.reason === 'no-git') changesBody.replaceChildren(h('p', { class: 'scm-empty' }, t('没有找到 git，请先安装 Git 并加入 PATH')))
    else if (err) changesBody.replaceChildren(h('p', { class: 'scm-empty' }, t('读取仓库状态失败')), h('p', { class: 'scm-empty small' }, err.message ?? ''))
    renderCommitButton()
    return
  }
  box.hidden = false
  const s = status
  msgInput.placeholder = s.branch ? t('消息（Ctrl+Enter 在“{0}”提交）', s.branch) : t('消息（Ctrl+Enter 提交）')
  const groups: HTMLElement[] = []
  if (s.conflicts.length) groups.push(group('conflicts', t('合并更改'), s.conflicts, 'conflict'))
  if (s.staged.length) groups.push(group('staged', t('暂存的更改'), s.staged, 'staged'))
  if (s.changes.length || !s.staged.length) groups.push(group('changes', t('更改'), s.changes, 'changes'))
  changesBody.replaceChildren(...groups)
  renderCommitButton()
}

type Kind = 'staged' | 'changes' | 'conflict'

function group(id: string, title: string, files: GitFile[], kind: Kind): HTMLElement {
  const collapsed = collapsedGroups.has(id)
  const actions: HTMLElement[] = []
  if (kind === 'staged') actions.push(iconBtn(t('取消暂存所有更改'), icons.minus, () => void unstage(null)))
  if (kind === 'changes' && files.length) {
    actions.push(iconBtn(t('放弃所有更改'), icons.discard, () => void discard(files)))
    actions.push(iconBtn(t('暂存所有更改'), icons.plus, () => void stage(null)))
  }
  if (kind === 'conflict') actions.push(iconBtn(t('暂存所有冲突文件（标记为已解决）'), icons.plus, () => void stage(files.map((f) => f.path))))
  const list = h('div', { class: 'scm-files', role: 'list' }, ...files.map((f) => fileRow(f, kind)))
  const el = h(
    'div',
    { class: 'scm-group' + (collapsed ? ' collapsed' : '') },
    h(
      'div',
      {
        class: 'scm-group-head',
        role: 'button',
        tabindex: '0',
        'aria-expanded': String(!collapsed),
        onClick: (e: MouseEvent) => {
          if ((e.target as HTMLElement).closest('.scm-row-actions')) return
          if (collapsedGroups.has(id)) collapsedGroups.delete(id)
          else collapsedGroups.add(id)
          el.classList.toggle('collapsed')
        }
      },
      h('span', { class: 'chev', html: icons.chevron }),
      h('span', { class: 'scm-group-title' }, title),
      h('span', { class: 'grow' }),
      h('span', { class: 'scm-row-actions' }, ...actions),
      h('span', { class: 'scm-count' }, String(files.length))
    ),
    list
  )
  if (!files.length) list.append(h('div', { class: 'scm-none muted' }, t('没有更改')))
  return el
}

function fileRow(f: GitFile, kind: Kind): HTMLElement {
  const dir = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : ''
  const actions: HTMLElement[] = [iconBtn(t('打开文件'), icons.openFile, () => void openWorking(f))]
  if (kind === 'staged') actions.push(iconBtn(t('取消暂存更改'), icons.minus, () => void unstage([f.path])))
  else {
    if (kind === 'changes') actions.push(iconBtn(t('放弃更改'), icons.discard, () => void discard([f])))
    actions.push(iconBtn(kind === 'conflict' ? t('标记为已解决') : t('暂存更改'), icons.plus, () => void stage([f.path])))
  }
  const label = t(STATUS[f.status] ?? f.status)
  return h(
    'div',
    {
      class: `scm-file-row st-${f.status === '!' ? 'X' : f.status}`,
      role: 'listitem',
      tabindex: '0',
      title: `${f.from ? f.from + ' → ' : ''}${f.path} · ${label}`,
      onClick: (e: MouseEvent) => {
        if ((e.target as HTMLElement).closest('.scm-row-actions')) return
        void openChange(f, kind)
      },
      onKeydown: (e: KeyboardEvent) => {
        if (e.key === 'Enter') void openChange(f, kind)
      },
      onContextmenu: (e: MouseEvent) => {
        e.preventDefault()
        fileMenu(e, f, kind)
      }
    },
    fileBadge(f.path),
    h('span', { class: 'scm-file' + (f.status === 'D' ? ' deleted' : '') }, basename(f.path)),
    dir ? h('span', { class: 'scm-dir' }, dir) : null,
    h('span', { class: 'grow' }),
    h('span', { class: 'scm-row-actions' }, ...actions),
    h('span', { class: 'scm-letter', title: label }, f.status)
  )
}

function fileMenu(e: MouseEvent, f: GitFile, kind: Kind): void {
  const root = state.root!
  const items: MenuItem[] = [
    { label: t('打开更改'), run: () => void openChange(f, kind) },
    { label: t('打开文件'), disabled: f.status === 'D', run: () => void openWorking(f) },
    'sep'
  ]
  if (kind === 'staged') items.push({ label: t('取消暂存更改'), run: () => void unstage([f.path]) })
  else items.push({ label: kind === 'conflict' ? t('标记为已解决') : t('暂存更改'), run: () => void stage([f.path]) })
  if (kind === 'changes') items.push({ label: t('放弃更改'), danger: true, run: () => void discard([f]) })
  items.push('sep', { label: t('在资源管理器中显示'), run: () => void window.api.fs.reveal(joinPath(root, f.path)) }, {
    label: t('复制路径'),
    run: () => void navigator.clipboard.writeText(joinPath(root, f.path)).then(() => toast(t('已复制路径')))
  })
  showMenu(e.clientX, e.clientY, items)
}

/* ---------------- 操作 ---------------- */

async function stage(paths: string[] | null): Promise<void> {
  if (!state.root) return
  await withBusy(() => window.api.git.stage(state.root!, paths))
}

async function unstage(paths: string[] | null): Promise<void> {
  if (!state.root) return
  await withBusy(() => window.api.git.unstage(state.root!, paths))
}

async function discard(files: GitFile[]): Promise<void> {
  if (!state.root || !files.length) return
  const untracked = files.filter((f) => f.status === 'U').map((f) => f.path)
  const tracked = files.filter((f) => f.status !== 'U').map((f) => f.path)
  const msg =
    files.length === 1
      ? untracked.length
        ? t('确定要删除未跟踪的文件“{0}”吗？文件会被移到回收站。', basename(files[0].path))
        : t('确定要放弃“{0}”中的更改吗？此操作无法撤销。', basename(files[0].path))
      : t('确定要放弃 {0} 个文件中的所有更改吗？\n已跟踪文件的修改无法撤销；未跟踪的文件会被移到回收站。', files.length)
  if (!confirm(msg)) return
  await withBusy(() => window.api.git.discard(state.root!, tracked, untracked))
}

function canCommit(): boolean {
  return !!status && (status.staged.length > 0 || status.changes.length > 0)
}

async function commit(opts: { amend?: boolean; push?: 'push' | 'sync' } = {}): Promise<void> {
  const root = state.root
  if (!root || !status) return
  const message = msgInput.value.trim()
  if (status.conflicts.length) return toast(t('请先解决合并冲突'))
  if (!opts.amend && !canCommit()) return toast(t('没有可提交的更改'))
  if (!message && !opts.amend) {
    msgInput.focus()
    return toast(t('请输入提交信息'))
  }
  // 和 VS Code 的“智能提交”一样：没有暂存的更改时，问一下是否全部暂存后提交
  if (!status.staged.length && status.changes.length && !opts.amend) {
    if (!confirm(t('没有暂存的更改。要暂存所有更改并直接提交吗？'))) return
    const ok = await withBusy(async () => {
      await window.api.git.stage(root, null)
      return true
    })
    if (!ok) return
  }
  const ok = await withBusy(async () => {
    await window.api.git.commit(root, message, { amend: opts.amend })
    return true
  })
  if (!ok) return
  msgInput.value = ''
  drafts.delete(root)
  autoGrow()
  if (opts.push) await runOp(opts.push)
}

async function amendWithLast(): Promise<void> {
  if (!state.root) return
  if (!msgInput.value.trim()) {
    msgInput.value = await window.api.git.lastMessage(state.root)
    autoGrow()
  }
  await commit({ amend: true })
}

const OP_DONE: Record<GitOp, string> = {
  push: '已推送',
  pull: '已拉取',
  fetch: '已提取',
  sync: '已同步',
  undoCommit: '已撤销上次提交',
  stash: '已储藏更改',
  stashPop: '已弹出储藏'
}

async function runOp(op: GitOp): Promise<void> {
  if (!state.root) return
  if (op === 'undoCommit' && !confirm(t('撤销上次提交？提交里的更改会保留在暂存区。'))) return
  await withBusy(() => window.api.git.run(state.root!, op), t(OP_DONE[op]))
}

/** 提交按钮：有更改时“提交”；没有更改但和远程不同步时“同步更改”；没有上游分支时“发布分支” */
function primaryKind(): 'commit' | 'sync' | 'publish' {
  const s = status
  if (!s || canCommit() || msgInput.value.trim()) return 'commit'
  if (s.branch && !s.upstream && s.hasCommits) return 'publish'
  if (s.upstream && (s.ahead || s.behind)) return 'sync'
  return 'commit'
}

function renderCommitButton(): void {
  if (!commitBtn) return
  const kind = primaryKind()
  const s = status
  commitBtn.dataset.kind = kind
  if (kind === 'sync' && s) {
    commitLabel.replaceChildren(h('span', { class: 'ic', html: icons.sync }), t('同步更改'))
    if (s.behind) commitLabel.append(h('span', { class: 'scm-ab' }, `${s.behind}↓`))
    if (s.ahead) commitLabel.append(h('span', { class: 'scm-ab' }, `${s.ahead}↑`))
    commitBtn.title = t('拉取并推送：落后 {0}，领先 {1}', s.behind, s.ahead)
  } else if (kind === 'publish') {
    commitLabel.replaceChildren(h('span', { class: 'ic', html: icons.cloudUp }), t('发布分支'))
    commitBtn.title = t('把“{0}”推送到远程仓库', s?.branch ?? '')
  } else {
    commitLabel.replaceChildren(h('span', { class: 'ic', html: icons.check }), t('提交##git'))
    commitBtn.title = s?.branch ? t('在“{0}”上提交 (Ctrl Enter)', s.branch) : t('提交 (Ctrl Enter)')
  }
  commitBtn.disabled = kind === 'commit' && !canCommit()
}

async function primaryAction(): Promise<void> {
  const kind = primaryKind()
  if (kind === 'sync') await runOp('sync')
  else if (kind === 'publish') await runOp('push')
  else await commit()
}

function openCommitMenu(): void {
  const r = commitMore.getBoundingClientRect()
  const off = !canCommit()
  showMenu(r.left, r.bottom + 4, [
    { label: t('提交##git'), key: 'Ctrl Enter', disabled: off, run: () => void commit() },
    { label: t('提交并推送'), disabled: off, run: () => void commit({ push: 'push' }) },
    { label: t('提交并同步'), disabled: off, run: () => void commit({ push: 'sync' }) },
    'sep',
    { label: t('提交（修改上次提交）'), disabled: !status?.hasCommits, run: () => void amendWithLast() }
  ])
}

function openMoreMenu(e: MouseEvent): void {
  if (!state.root || !status) return
  const s = status
  const ahead = s.ahead ? ` ↑${s.ahead}` : ''
  const behind = s.behind ? ` ↓${s.behind}` : ''
  showMenu(e.clientX, e.clientY, [
    { label: t('拉取') + behind, run: () => void runOp('pull') },
    { label: t('推送') + ahead, run: () => void runOp('push') },
    { label: t('同步'), disabled: !s.upstream, run: () => void runOp('sync') },
    { label: t('提取'), run: () => void runOp('fetch') },
    'sep',
    { label: t('提交##git'), disabled: !canCommit(), run: () => void commit() },
    { label: t('提交（修改上次提交）'), disabled: !s.hasCommits, run: () => void amendWithLast() },
    { label: t('撤销上次提交'), disabled: !s.hasCommits, run: () => void runOp('undoCommit') },
    'sep',
    { label: t('切换分支…'), run: () => void branchMenu(e) },
    { label: t('新建分支…'), run: () => askBranchName() },
    'sep',
    { label: t('储藏所有更改'), disabled: !canCommit(), run: () => void runOp('stash') },
    { label: t('弹出最近的储藏'), run: () => void runOp('stashPop') },
    'sep',
    { label: t('暂存所有更改'), disabled: !s.changes.length, run: () => void stage(null) },
    { label: t('取消暂存所有更改'), disabled: !s.staged.length, run: () => void unstage(null) }
  ])
}

async function branchMenu(e: MouseEvent): Promise<void> {
  const root = state.root
  if (!root) return
  const list = await window.api.git.branches(root).catch((err) => {
    toast(errMsg(err))
    return null
  })
  if (!list) return
  const local = list.filter((b) => !b.remote)
  const remote = list.filter((b) => b.remote && !local.some((l) => b.name.endsWith('/' + l.name)))
  const items: MenuItem[] = [{ label: t('新建分支…'), run: () => askBranchName() }, 'sep']
  for (const b of local.slice(0, 20))
    items.push({ label: b.name, key: b.current ? t('当前') : undefined, disabled: b.current, run: () => void checkout(b.name, {}) })
  if (remote.length) {
    items.push('sep')
    for (const b of remote.slice(0, 12)) items.push({ label: b.name, key: t('远程'), run: () => void checkout(b.name, { remote: true }) })
  }
  showMenu(e.clientX, e.clientY, items)
}

async function checkout(name: string, opts: { create?: boolean; remote?: boolean }): Promise<void> {
  if (!state.root) return
  await withBusy(() => window.api.git.checkout(state.root!, name, opts), t('已切换到 {0}', name))
}

/** 在视图顶部弹出一个输入框（Electron 不支持 window.prompt） */
function askBranchName(): void {
  const input = h('input', { class: 'text-input scm-prompt-input', placeholder: t('新分支名称，Enter 创建，Esc 取消'), spellcheck: 'false' })
  const close = () => promptHost.replaceChildren()
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') close()
    else if (e.key === 'Enter') {
      const name = input.value.trim()
      if (!name) return
      close()
      void checkout(name, { create: true })
    }
  })
  input.addEventListener('blur', () => setTimeout(close, 100))
  promptHost.replaceChildren(h('div', { class: 'scm-prompt' }, input))
  input.focus()
}

/* ---------------- 对比视图 ---------------- */

/**
 * git 输出的是 / 分隔、相对打开的文件夹的路径，按 root 的写法拼成完整路径。
 * 打开的是仓库的子文件夹时，提交里文件夹外面的文件以 ../ 开头，这里把 .. 消掉。
 */
function joinPath(root: string, rel: string): string {
  const sep = root.includes('\\') ? '\\' : '/'
  const parts = root.replace(/[\\/]+$/, '').split(/[\\/]/)
  for (const seg of rel.split('/')) {
    if (!seg || seg === '.') continue
    if (seg === '..') {
      if (parts.length > 1) parts.pop()
    } else parts.push(seg)
  }
  return parts.join(sep) || sep
}

async function readWorking(root: string, rel: string): Promise<string> {
  const r = await window.api.fs.readFile(joinPath(root, rel))
  return r.ok ? r.content : ''
}

const diffViews = new Map<string, HTMLElement>()

/** 在编辑区打开左右对比（只读）。同一个对比再次打开时先关掉旧的，内容总是最新的 */
async function openDiff(key: string, title: string, rel: string, load: () => Promise<[string, string]>, labels: [string, string]): Promise<void> {
  const root = state.root
  if (!root) return
  let sides: [string, string]
  try {
    sides = await load()
  } catch (e) {
    return toast(errMsg(e))
  }
  const old = diffViews.get(key)
  if (old) closeView(old)
  const lang = languageFor(rel)
  const original = monaco.editor.createModel(sides[0], lang)
  const modified = monaco.editor.createModel(sides[1], lang)
  const host = h('div', { class: 'diffview-editor' })
  let editor: monaco.editor.IStandaloneDiffEditor | null = null
  const el: HTMLElement = h(
    'div',
    { class: 'diffview' },
    h(
      'div',
      { class: 'diffview-bar' },
      h('span', { class: 'diffview-title' }, rel),
      h('span', { class: 'muted small' }, `${labels[0]} ↔ ${labels[1]}`),
      h('span', { class: 'grow' }),
      h('button', { class: 'btn small', onClick: () => void openFile(joinPath(root, rel)) }, t('打开文件'))
    ),
    host
  )
  diffViews.set(key, el)
  openView({
    title,
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
      const sub = editor.onDidUpdateDiff(() => {
        sub.dispose()
        const first = editor?.getLineChanges()?.[0]
        if (first) editor?.getModifiedEditor().revealLineInCenter(Math.max(1, first.modifiedStartLineNumber))
      })
    },
    onClose: () => {
      if (diffViews.get(key) === el) diffViews.delete(key)
      editor?.dispose()
      original.dispose()
      modified.dispose()
    }
  })
}

async function openWorking(f: GitFile): Promise<void> {
  if (!state.root || f.status === 'D') return
  await openFile(joinPath(state.root, f.path))
}

/** 点击改动的文件：暂存的对比 HEAD ↔ 暂存区，未暂存的对比 暂存区 ↔ 工作区（和 VS Code 一致） */
async function openChange(f: GitFile, kind: Kind): Promise<void> {
  const root = state.root
  if (!root) return
  if (kind === 'conflict' || f.status === 'U') return openWorking(f)
  const name = basename(f.path)
  if (kind === 'staged') {
    await openDiff(
      `staged:${f.path}`,
      t('{0}（已暂存）', name),
      f.path,
      async () => [f.status === 'A' ? '' : await window.api.git.show(root, 'HEAD', f.from ?? f.path), f.status === 'D' ? '' : await window.api.git.show(root, ':', f.path)],
      ['HEAD', t('暂存区')]
    )
  } else {
    await openDiff(
      `work:${f.path}`,
      t('{0}（工作树）', name),
      f.path,
      async () => [await window.api.git.show(root, ':', f.path), f.status === 'D' ? '' : await readWorking(root, f.path)],
      [t('暂存区'), t('工作树')]
    )
  }
}

/** 提交历史里的文件：对比父提交 ↔ 这个提交 */
async function openCommitChange(c: GitCommit, ch: GitChange): Promise<void> {
  const root = state.root
  if (!root) return
  const short = c.hash.slice(0, 7)
  await openDiff(
    `commit:${c.hash}:${ch.path}`,
    `${basename(ch.path)} (${short})`,
    ch.path,
    async () => [
      ch.status === 'A' || !c.parents.length ? '' : await window.api.git.show(root, c.hash + '^', ch.from ?? ch.path),
      ch.status === 'D' ? '' : await window.api.git.show(root, c.hash, ch.path)
    ],
    [c.parents.length ? short + '^' : t('空'), short]
  )
}

/* ---------------- “图形”分区 ---------------- */

function renderRows(rows: Row[]): void {
  const width = rows.reduce((m, r) => Math.max(m, r.width), 1)
  const gw = Math.min(width, 8)
  graphBody.replaceChildren(
    ...rows.map((row) => {
      const c = row.commit
      const w = Math.max(gw, row.width)
      const isHead = c.refs.some((r) => r === 'HEAD' || r.startsWith('HEAD -> '))
      const files = h('div', { class: 'scm-files' })
      const open = expandedCommits.has(c.hash)
      const changes = h(
        'div',
        { class: 'scm-commit-files', hidden: !open, style: { paddingLeft: `${graphW(w)}px` } },
        continuationSvg(row, w),
        h('div', { class: 'scm-meta' }, `${c.author} · ${ago(c.time)} · ${c.hash.slice(0, 7)}`),
        files
      )
      const item = h(
        'div',
        { class: 'scm-item', role: 'listitem' },
        h(
          'button',
          {
            class: 'scm-row' + (open ? ' open' : '') + (isHead ? ' head' : ''),
            title: `${c.subject}\n\n${c.author} <${c.email}>\n${fmtDate(c.time)}\n${c.hash}`,
            'aria-expanded': String(open),
            onClick: (e: MouseEvent) => void toggleCommit(c, e.currentTarget as HTMLElement, changes, files),
            onContextmenu: (e: MouseEvent) => {
              e.preventDefault()
              commitMenu(e, c)
            }
          },
          graphSvg(row, w, isHead),
          h(
            'span',
            { class: 'scm-text' },
            h('span', { class: 'scm-subject' }, c.subject || t('(无提交说明)')),
            h('span', { class: 'scm-refs' }, ...c.refs.map(refBadge))
          )
        ),
        changes
      )
      if (open) void fillChanges(c, files)
      return item
    })
  )
}

function commitMenu(e: MouseEvent, c: GitCommit): void {
  showMenu(e.clientX, e.clientY, [
    { label: t('复制提交 ID'), run: () => void navigator.clipboard.writeText(c.hash).then(() => toast(t('已复制'))) },
    { label: t('复制提交信息'), run: () => void navigator.clipboard.writeText(c.subject).then(() => toast(t('已复制'))) },
    'sep',
    { label: t('签出此提交（分离 HEAD）'), run: () => void checkout(c.hash, {}) }
  ])
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

async function fillChanges(c: GitCommit, box: HTMLElement): Promise<void> {
  const root = state.root
  if (!root) return
  let list = changeCache.get(c.hash)
  if (!list) {
    box.replaceChildren(h('div', { class: 'scm-change muted' }, t('读取中…')))
    try {
      list = await window.api.git.changes(root, c.hash)
      changeCache.set(c.hash, list)
    } catch {
      box.replaceChildren(h('div', { class: 'scm-change muted' }, t('读取改动失败')))
      return
    }
  }
  if (!list.length) {
    box.replaceChildren(h('div', { class: 'scm-change muted' }, c.parents.length > 1 ? t('合并提交，没有额外改动') : t('没有文件改动')))
    return
  }
  box.replaceChildren(
    ...list.map((ch) => {
      const dir = ch.path.includes('/') ? ch.path.slice(0, ch.path.lastIndexOf('/')) : ''
      return h(
        'button',
        {
          class: `scm-change st-${ch.status}`,
          title: (ch.from ? `${ch.from} → ` : '') + ch.path + ' · ' + t(STATUS[ch.status] ?? ch.status),
          onClick: () => void openCommitChange(c, ch)
        },
        fileBadge(ch.path),
        h('span', { class: 'scm-file' + (ch.status === 'D' ? ' deleted' : '') }, basename(ch.path)),
        dir ? h('span', { class: 'scm-dir' }, dir) : null,
        h('span', { class: 'grow' }),
        h('span', { class: 'scm-letter' }, ch.status)
      )
    })
  )
}

