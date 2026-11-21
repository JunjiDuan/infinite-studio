import type { DirEntry } from '../../shared/types'
import { activeTab, closeUnder, isDirty, isUnder, openFile, renamePath, samePath, tabs } from './editor'
import { basename, h, parentDir, relative, toast } from './dom'
import { icons } from './icons'
import { showMenu, type MenuItem } from './menu'
import { state } from './store'

const cache = new Map<string, DirEntry[]>()
const expanded = new Set<string>()
let listEl: HTMLElement
let titleEl: HTMLElement
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
  titleEl = h('span', { class: 'side-title' })
  listEl = h('div', {
    class: 'tree',
    role: 'tree',
    'aria-label': '项目文件',
    tabindex: '0',
    onContextmenu: (e: MouseEvent) => {
      if (e.target === listEl && state.root) {
        e.preventDefault()
        selected = null
        render()
        showMenu(e.clientX, e.clientY, menuFor(state.root, true))
      }
    },
    onKeydown: onTreeKey
  })
  return h(
    'div',
    { class: 'side-view', 'data-view': 'files' },
    h(
      'div',
      { class: 'side-head' },
      titleEl,
      h(
        'div',
        { class: 'side-actions' },
        h('button', { class: 'icon-btn small', 'aria-label': '新建文件', title: '新建文件', html: icons.newFile, onClick: () => beginCreate('file') }),
        h('button', { class: 'icon-btn small', 'aria-label': '新建文件夹', title: '新建文件夹', html: icons.newFolder, onClick: () => beginCreate('dir') }),
        h('button', { class: 'icon-btn small', 'aria-label': '刷新文件列表', title: '刷新', html: icons.refresh, onClick: () => refreshTree() }),
        h('button', { class: 'icon-btn small', 'aria-label': '全部折叠', title: '全部折叠', html: icons.collapse, onClick: collapseAll })
      )
    ),
    listEl
  )
}

async function load(dir: string, force = false): Promise<DirEntry[]> {
  if (force || !cache.has(dir)) {
    try {
      cache.set(dir, await window.api.fs.readDir(dir))
    } catch {
      cache.set(dir, [])
    }
  }
  return cache.get(dir)!
}

export async function setTreeRoot(root: string | null): Promise<void> {
  cache.clear()
  expanded.clear()
  selected = null
  editing = null
  if (!root) {
    listEl.replaceChildren()
    return
  }
  titleEl.textContent = basename(root).toUpperCase()
  await load(root)
  render()
}

export async function refreshTree(): Promise<void> {
  if (!state.root) return
  const dirs = [state.root, ...expanded]
  cache.clear()
  for (const d of dirs) await load(d)
  render()
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
  for (const d of dirs) await load(d, true)
  // 被删掉的展开目录顺手清掉
  for (const d of [...expanded]) if (![...cache.values()].some((list) => list.some((e) => samePath(e.path, d)))) expanded.delete(d)
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
  for (const c of chain) {
    expanded.add(c)
    await load(c)
  }
  selected = path
  render()
  listEl.querySelector('.tree-row.active, .tree-row.selected')?.scrollIntoView({ block: 'nearest' })
}

async function toggle(dir: string): Promise<void> {
  if (expanded.has(dir)) expanded.delete(dir)
  else {
    expanded.add(dir)
    await load(dir)
  }
  render()
}

function collapseAll(): void {
  expanded.clear()
  render()
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
  if (!samePath(d, state.root)) {
    expanded.add(d)
    await load(d)
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
  const what = e?.isDir ? '文件夹' : '文件'
  const warn = dirtyInside ? '\n\n里面有未保存的修改，会一起丢弃。' : ''
  if (!confirm(`把${what}“${basename(p)}”移到回收站吗？${warn}`)) return
  try {
    await window.api.fs.trash(p)
    closeUnder(p)
    if (selected && isUnder(selected, p)) selected = null
    await invalidatePaths([p])
    toast(`已移到回收站：${basename(p)}`)
  } catch (err) {
    toast('删除失败：' + String(err))
  }
}

function validName(name: string): string | null {
  if (!name) return '名字不能为空'
  if (name === '.' || name === '..' || /[\\/:*?"<>|]/.test(name)) return '名字里不能有 \\ / : * ? " < > |'
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
      await invalidatePaths([ed.path, to])
    } else if (ed.mode === 'file') {
      const p = await window.api.fs.createFile(ed.dir, name)
      selected = p
      await invalidatePaths([p])
      await openFile(p)
    } else {
      const p = await window.api.fs.createDir(ed.dir, name)
      selected = p
      await invalidatePaths([p])
    }
  } catch (e) {
    toast(String(e).replace(/^Error: (Error invoking remote method '[^']+': )?(Error: )?/, ''))
    render()
  }
}

function inputRow(depth: number, initial: string, isDir: boolean): HTMLElement {
  const input = h('input', { class: 'tree-input', value: initial, spellcheck: 'false', 'aria-label': '名称' })
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
    { label: '新建文件', run: () => void beginCreate('file', dir) },
    { label: '新建文件夹', run: () => void beginCreate('dir', dir) },
    'sep'
  ]
  for (const fn of extras) items.push(...fn({ path, isDir, dir }))
  items.push(
    { label: '在资源管理器中显示', run: () => void window.api.fs.reveal(path) },
    { label: '复制路径', run: () => void navigator.clipboard.writeText(path).then(() => toast('已复制路径')) },
    { label: '复制相对路径', disabled: isRoot, run: () => void navigator.clipboard.writeText(relative(root, path)).then(() => toast('已复制相对路径')) }
  )
  if (!isRoot) {
    items.push('sep', { label: '重命名', key: 'F2', run: () => beginRename(path) }, { label: '删除', key: 'Delete', danger: true, run: () => void trashPath(path) })
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

export function render(): void {
  if (!state.root || !listEl) return
  const activePath = activeTab()?.path
  const rows: HTMLElement[] = []
  const ed = editing
  const walk = (dir: string, depth: number) => {
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
      if (open) walk(e.path, depth + 1)
    }
  }
  walk(state.root, 0)
  if (rows.length === 0) rows.push(h('div', { class: 'tree-empty' }, '空文件夹'))
  listEl.replaceChildren(...rows)
}
