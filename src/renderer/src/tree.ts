import type { DirEntry } from '../../shared/types'
import { activeTab, closeUnder, isDirty, isUnder, openFile, renamePath, samePath, tabs } from './editor'
import { basename, h, parentDir, relative, toast } from './dom'
import { icons } from './icons'
import { showMenu, type MenuItem } from './menu'
import { persist, state } from './store'
import { t } from './i18n'

const cache = new Map<string, DirEntry[]>()
const expanded = new Set<string>()
/** 刚展开的文件夹：下一次渲染时它的子项依次浮现 */
let justOpened: string | null = null
let listEl: HTMLElement
let titleEl: HTMLElement
let projectHead: HTMLElement
let selected: string | null = null

type Editing = { mode: 'file' | 'dir'; dir: string } | { mode: 'rename'; path: string } | null
let editing: Editing = null

/** 外部可以挂额外的右键菜单项（比如“在终端中打开”） */
type ExtraItems = (target: { path: string; isDir: boolean; dir: string }) => MenuItem[]
const extras: ExtraItems[] = []
export function addTreeMenuItems(fn: ExtraItems): void {
  extras.push(fn)
}

export function createTree(): HTMLElement {
  titleEl = h('span', { class: 'project-name' })
  listEl = h('div', {
    class: 'tree',
    role: 'tree',
    'aria-label': t('项目文件'),
    tabindex: '0',
    onContextmenu: (e: MouseEvent) => {
      if (e.target === listEl && state.root) {
        e.preventDefault()
        selected = null
        render()
        showMenu(e.clientX, e.clientY, menuFor(state.root, true))
      }
    },
    onKeydown: onTreeKey,
    onScroll: () => {
      if (state.root) scrollTops.set(state.root, listEl.scrollTop)
    }
  })
  projectHead = h(
    'div',
    { class: 'project-head open' },
    h(
      'button',
      {
        class: 'project-toggle',
        'aria-expanded': 'true',
        onClick: () => setProjectOpen(!projectHead.classList.contains('open'))
      },
      h('span', { class: 'chev', html: icons.chevron }),
      titleEl
    ),
    h(
      'div',
      { class: 'side-actions' },
      h('button', { class: 'icon-btn small', 'aria-label': t('新建文件'), title: t('新建文件'), html: icons.newFile, onClick: () => beginCreate('file') }),
      h('button', { class: 'icon-btn small', 'aria-label': t('新建文件夹'), title: t('新建文件夹'), html: icons.newFolder, onClick: () => beginCreate('dir') }),
      h('button', { class: 'icon-btn small', 'aria-label': t('刷新文件列表'), title: t('刷新'), html: icons.refresh, onClick: () => refreshTree() }),
      h('button', { class: 'icon-btn small', 'aria-label': t('全部折叠'), title: t('全部折叠'), html: icons.collapse, onClick: collapseAll })
    )
  )
  return h(
    'div',
    { class: 'side-view', 'data-view': 'files' },
    h('div', { class: 'side-head' }, h('span', { class: 'side-title' }, t('资源管理器'))),
    projectHead,
    listEl
  )
}

/** 展开 / 收起项目节（资源管理器里项目名那一行） */
function setProjectOpen(open: boolean): void {
  projectHead.classList.toggle('open', open)
  projectHead.querySelector('.project-toggle')?.setAttribute('aria-expanded', String(open))
  listEl.hidden = !open
}

function sameList(a: DirEntry[] | undefined, b: DirEntry[]): boolean {
  return !!a && a.length === b.length && a.every((x, i) => x.path === b[i].path && x.isDir === b[i].isDir)
}

/** 读取目录；返回内容是否和缓存里的不一样。目录读不了（被删、没权限）时返回 null */
async function load(dir: string, force = false): Promise<boolean | null> {
  if (!force && cache.has(dir)) return false
  let list: DirEntry[]
  try {
    list = await window.api.fs.readDir(dir)
  } catch {
    const had = cache.get(dir)
    cache.set(dir, [])
    return had && had.length ? true : null
  }
  if (sameList(cache.get(dir), list)) return false
  cache.set(dir, list)
  return true
}

/* ---------- 展开状态按项目持久化 ---------- */

const MAX_SAVED_ROOTS = 30

function saveExpanded(): void {
  const root = state.root
  if (!root) return
  const all = { ...(state.settings.treeExpanded ?? {}) }
  delete all[root]
  const list = [...expanded].filter((d) => isUnder(d, root) && !samePath(d, root)).map((d) => relative(root, d)).filter(Boolean)
  // 最近用过的放最后，超出上限时丢掉最早的
  if (list.length) all[root] = list
  const keys = Object.keys(all)
  for (const k of keys.slice(0, Math.max(0, keys.length - MAX_SAVED_ROOTS))) delete all[k]
  state.settings.treeExpanded = all
  persist()
}

/** 恢复上次展开的文件夹；已不存在的跳过 */
async function restoreExpanded(root: string): Promise<void> {
  const saved = state.settings.treeExpanded?.[root]
  if (!saved?.length) return
  const sep = root.includes('\\') ? '\\' : '/'
  const dirs = saved
    .filter((rel) => typeof rel === 'string' && rel && !rel.split(/[\\/]/).includes('..'))
    .map((rel) => root.replace(/[\\/]+$/, '') + sep + rel.split(/[\\/]/).join(sep))
    .sort((a, b) => a.length - b.length)
  let dropped = false
  for (const d of dirs) {
    if (state.root !== root) return
    // 只恢复父目录仍然展开的（父目录被收起时子目录本来就看不到）
    const parent = parentDir(d)
    const atRoot = samePath(parent.replace(/[\\/]+$/, ''), root.replace(/[\\/]+$/, ''))
    const parentKey = atRoot ? root : parent
    if ((!atRoot && !expanded.has(parent)) || !(cache.get(parentKey) ?? []).some((e) => e.isDir && samePath(e.path, d))) {
      dropped = true
      continue
    }
    expanded.add(d)
    if ((await load(d)) === null) {
      expanded.delete(d)
      dropped = true
    }
  }
  if (dropped) saveExpanded()
}

export async function setTreeRoot(root: string | null): Promise<void> {
  cache.clear()
  expanded.clear()
  selected = null
  editing = null
  lastKey = ''
  if (!root) {
    listEl.replaceChildren()
    return
  }
  titleEl.textContent = basename(root).toUpperCase()
  await load(root)
  await restoreExpanded(root)
  if (state.root !== root) return
  render(true)
  const top = scrollTops.get(root)
  if (top) listEl.scrollTop = top
}

/** 每个项目的滚动位置（本次运行内） */
const scrollTops = new Map<string, number>()

export async function refreshTree(): Promise<void> {
  if (!state.root) return
  const dirs = [state.root, ...expanded]
  cache.clear()
  for (const d of dirs) if ((await load(d)) === null) expanded.delete(d)
  render(true)
  saveExpanded()
}

/** 文件监听回调：只重新读取已加载过、且受影响的目录 */
export async function invalidatePaths(paths: string[]): Promise<void> {
  const dirs = new Set<string>()
  for (const p of paths) {
    for (const d of [p, parentDir(p)]) {
      for (const key of cache.keys()) if (samePath(key, d)) dirs.add(key)
    }
  }
  if (!dirs.size) return
  let changed = false
  for (const d of dirs) if ((await load(d, true)) !== false) changed = true
  // 目录内容没变（比如只是文件内容被保存）就不用重画
  if (!changed) return
  // 被删掉的展开目录顺手清掉
  let pruned = false
  for (const d of [...expanded]) {
    if (![...cache.values()].some((list) => list.some((e) => samePath(e.path, d)))) {
      expanded.delete(d)
      cache.delete(d)
      pruned = true
    }
  }
  if (pruned) saveExpanded()
  render()
}

/** 展开到某个文件所在目录并高亮 */
export async function reveal(path: string): Promise<void> {
  const root = state.root
  if (!root || !isUnder(path, root)) return
  const chain: string[] = []
  let d = parentDir(path)
  while (d.length > root.length) {
    chain.unshift(d)
    d = parentDir(d)
  }
  let grew = false
  for (const c of chain) {
    if (!expanded.has(c)) grew = true
    expanded.add(c)
    await load(c)
  }
  selected = path
  render()
  if (grew) saveExpanded()
  listEl.querySelector('.tree-row.active, .tree-row.selected')?.scrollIntoView({ block: 'nearest' })
}

async function toggle(dir: string): Promise<void> {
  if (expanded.has(dir)) expanded.delete(dir)
  else {
    expanded.add(dir)
    await load(dir)
    justOpened = dir
  }
  render()
  justOpened = null
  saveExpanded()
}

function collapseAll(): void {
  expanded.clear()
  render()
  saveExpanded()
}

function entryOf(path: string): DirEntry | undefined {
  for (const list of cache.values()) {
    const e = list.find((x) => samePath(x.path, path))
    if (e) return e
  }
  return undefined
}

/** 新建时放到哪个目录：选中的是文件夹就放里面，是文件就放同级 */
function targetDir(): string | null {
  if (!state.root) return null
  if (!selected) return state.root
  const e = entryOf(selected)
  return e?.isDir ? e.path : parentDir(selected)
}

export async function beginCreate(mode: 'file' | 'dir', dir?: string): Promise<void> {
  const d = dir ?? targetDir()
  if (!d || !state.root) return
  setProjectOpen(true)
  if (!samePath(d, state.root) && !expanded.has(d)) {
    expanded.add(d)
    await load(d)
    saveExpanded()
  }
  editing = { mode, dir: d }
  render()
}

export function beginRename(path?: string): void {
  const p = path ?? selected
  if (!p || (state.root && samePath(p, state.root))) return
  editing = { mode: 'rename', path: p }
  render()
}

export async function trashPath(path?: string): Promise<void> {
  const p = path ?? selected
  if (!p || (state.root && samePath(p, state.root))) return
  const e = entryOf(p)
  const dirtyInside = tabs.some((t) => isUnder(t.path, p) && isDirty(t))
  const what = e?.isDir ? t('文件夹') : t('文件')
  const warn = dirtyInside ? t('\n\n里面有未保存的修改，会一起丢弃。') : ''
  if (!confirm(t('把{0}“{1}”移到回收站吗？{2}', what, basename(p), warn))) return
  try {
    await window.api.fs.trash(p)
    closeUnder(p)
    if (selected && isUnder(selected, p)) selected = null
    await invalidatePaths([p])
    render()
    toast(t('已移到回收站：{0}', basename(p)))
  } catch (err) {
    toast(t('删除失败：') + String(err))
  }
}

function validName(name: string): string | null {
  if (!name) return t('名字不能为空')
  if (name === '.' || name === '..' || /[\\/:*?"<>|]/.test(name)) return t('名字里不能有 \\ / : * ? " < > |')
  return null
}

async function commitEdit(value: string): Promise<void> {
  const ed = editing
  editing = null
  const name = value.trim()
  if (!ed) return
  if (ed.mode === 'rename' && name === basename(ed.path)) return render()
  if (!name) return render()
  const err = validName(name)
  if (err) {
    toast(err)
    return render()
  }
  try {
    if (ed.mode === 'rename') {
      const to = await window.api.fs.rename(ed.path, name)
      renamePath(ed.path, to)
      for (const d of [...expanded]) {
        if (isUnder(d, ed.path)) {
          expanded.delete(d)
          expanded.add(to + d.slice(ed.path.length))
        }
      }
      selected = to
      saveExpanded()
      await invalidatePaths([ed.path, to])
      render()
    } else if (ed.mode === 'file') {
      const p = await window.api.fs.createFile(ed.dir, name)
      selected = p
      await invalidatePaths([p])
      render()
      await openFile(p)
    } else {
      const p = await window.api.fs.createDir(ed.dir, name)
      selected = p
      await invalidatePaths([p])
      render()
    }
  } catch (e) {
    toast(String(e).replace(/^Error: (Error invoking remote method '[^']+': )?(Error: )?/, ''))
    render()
  }
}

function inputRow(depth: number, initial: string, isDir: boolean): HTMLElement {
  const input = h('input', { class: 'tree-input', value: initial, spellcheck: 'false', 'aria-label': t('名称') })
  let done = false
  const finish = (commit: boolean) => {
    if (done) return
    done = true
    if (commit) void commitEdit(input.value)
    else {
      editing = null
      render()
    }
  }
  input.addEventListener('keydown', (e) => {
    e.stopPropagation()
    if (e.key === 'Enter') finish(true)
    else if (e.key === 'Escape') finish(false)
  })
  input.addEventListener('blur', () => finish(true))
  queueMicrotask(() => {
    input.focus()
    // 改名时只选中文件名主体，不选扩展名
    const dot = initial.lastIndexOf('.')
    input.setSelectionRange(0, !isDir && dot > 0 ? dot : initial.length)
  })
  return h(
    'div',
    { class: 'tree-row editing', style: { paddingLeft: `${10 + depth * 14}px` } },
    isDir ? h('span', { class: 'chev', html: icons.chevron }) : h('span', { class: 'chev' }),
    input
  )
}

function menuFor(path: string, isDir: boolean): MenuItem[] {
  const root = state.root!
  const isRoot = samePath(path, root)
  const dir = isDir ? path : parentDir(path)
  const items: MenuItem[] = [
    { label: t('新建文件'), run: () => void beginCreate('file', dir) },
    { label: t('新建文件夹'), run: () => void beginCreate('dir', dir) },
    'sep'
  ]
  for (const fn of extras) items.push(...fn({ path, isDir, dir }))
  items.push(
    { label: t('在资源管理器中显示'), run: () => void window.api.fs.reveal(path) },
    { label: t('复制路径'), run: () => void navigator.clipboard.writeText(path).then(() => toast(t('已复制路径'))) },
    { label: t('复制相对路径'), disabled: isRoot, run: () => void navigator.clipboard.writeText(relative(root, path)).then(() => toast(t('已复制相对路径'))) }
  )
  if (!isRoot) {
    items.push('sep', { label: t('重命名'), key: 'F2', run: () => beginRename(path) }, { label: t('删除'), key: 'Delete', danger: true, run: () => void trashPath(path) })
  }
  return items
}

function onTreeKey(e: KeyboardEvent): void {
  if (editing) return
  if (e.key === 'F2') beginRename()
  else if (e.key === 'Delete') void trashPath()
  else return
  e.preventDefault()
}

/** 上一次整棵重建时的结构签名；结构没变时只更新高亮，不重建 DOM（避免每次按键 / 切标签都整棵重载） */
let lastKey = ''
let lastRoot: string | null = null

function structureKey(): string {
  const parts: string[] = [state.root ?? '']
  const ed = editing
  if (ed) parts.push(ed.mode === 'rename' ? `r:${ed.path}` : `${ed.mode}:${ed.dir}`)
  const walk = (dir: string) => {
    for (const e of cache.get(dir) ?? []) {
      const open = e.isDir && expanded.has(e.path)
      parts.push((e.isDir ? (open ? '+' : 'd') : 'f') + e.path)
      if (open) walk(e.path)
    }
  }
  if (state.root) walk(state.root)
  return parts.join('\n')
}

/** 只同步当前文件 / 选中项的高亮 */
function syncMarks(): void {
  const activePath = activeTab()?.path
  for (const row of listEl.querySelectorAll<HTMLElement>('.tree-row[data-path]')) {
    const p = row.dataset.path!
    const isActive = !!activePath && samePath(p, activePath)
    const isSel = !!selected && samePath(p, selected)
    row.classList.toggle('active', isActive)
    row.classList.toggle('selected', isSel)
    row.setAttribute('aria-selected', String(isSel))
  }
}

/** force：强制整棵重建（换项目、手动刷新） */
export function render(force = false): void {
  if (!state.root || !listEl) return
  const key = structureKey()
  if (!force && !justOpened && key === lastKey && lastRoot === state.root && listEl.childElementCount) {
    syncMarks()
    return
  }
  lastKey = key
  lastRoot = state.root
  const scroll = listEl.scrollTop
  rebuild()
  listEl.scrollTop = scroll
}

function rebuild(): void {
  const root = state.root
  if (!root) return
  const activePath = activeTab()?.path
  const rows: HTMLElement[] = []
  const ed = editing
  let enterIdx = -1
  const walk = (dir: string, depth: number) => {
    const entering = enterIdx >= 0 || (justOpened !== null && samePath(dir, justOpened))
    if (entering && enterIdx < 0) enterIdx = 0
    if (ed && ed.mode !== 'rename' && samePath(ed.dir, dir)) rows.push(inputRow(depth, '', ed.mode === 'dir'))
    for (const e of cache.get(dir) ?? []) {
      const open = e.isDir && expanded.has(e.path)
      if (ed?.mode === 'rename' && samePath(ed.path, e.path)) {
        rows.push(inputRow(depth, e.name, e.isDir))
      } else {
        const isActive = !!activePath && samePath(e.path, activePath)
        const isSel = !!selected && samePath(e.path, selected)
        rows.push(
          h(
            'button',
            {
              class: 'tree-row' + (e.isDir ? ' dir' : '') + (open ? ' open' : '') + (isActive ? ' active' : '') + (isSel ? ' selected' : ''),
              role: 'treeitem',
              'data-path': e.path,
              'aria-expanded': e.isDir ? String(open) : null,
              'aria-selected': String(isSel),
              title: e.path,
              style: { paddingLeft: `${10 + depth * 14}px` },
              onClick: () => {
                selected = e.path
                if (e.isDir) void toggle(e.path)
                else {
                  void openFile(e.path)
                  render()
                }
              },
              onContextmenu: (ev: MouseEvent) => {
                ev.preventDefault()
                selected = e.path
                render()
                showMenu(ev.clientX, ev.clientY, menuFor(e.path, e.isDir))
              }
            },
            e.isDir ? h('span', { class: 'chev', html: icons.chevron }) : h('span', { class: 'chev' }),
            h('span', { class: 'name' }, e.name)
          )
        )
      }
      if (entering && rows.length) {
        const last = rows[rows.length - 1]
        last.classList.add('enter')
        last.style.setProperty('--i', String(enterIdx++))
      }
      if (open) walk(e.path, depth + 1)
    }
    if (justOpened !== null && samePath(dir, justOpened)) enterIdx = -1
  }
  walk(root, 0)
  if (rows.length === 0) rows.push(h('div', { class: 'tree-empty' }, t('空文件夹')))
  listEl.replaceChildren(...rows)
}
