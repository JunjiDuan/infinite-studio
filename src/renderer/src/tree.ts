import type { DirEntry } from '../../shared/types'
import { activeTab, openFile } from './editor'
import { basename, h, parentDir } from './dom'
import { icons } from './icons'
import { state } from './store'

const cache = new Map<string, DirEntry[]>()
const expanded = new Set<string>()
let listEl: HTMLElement
let titleEl: HTMLElement

export function createTree(): HTMLElement {
  titleEl = h('span', { class: 'side-title' })
  listEl = h('div', { class: 'tree', role: 'tree', 'aria-label': '项目文件' })
  return h(
    'aside',
    { class: 'sidebar', 'aria-label': '文件栏' },
    h('div', { class: 'side-head' }, titleEl, h('button', { class: 'icon-btn small', 'aria-label': '刷新文件列表', title: '刷新', html: icons.refresh, onClick: () => refreshTree() })),
    listEl
  )
}

async function load(dir: string): Promise<DirEntry[]> {
  if (!cache.has(dir)) {
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
  cache.clear()
  await load(state.root)
  for (const d of expanded) await load(d)
  render()
}

/** 展开到某个文件所在目录并高亮 */
export async function reveal(path: string): Promise<void> {
  const root = state.root
  if (!root || !path.toLowerCase().startsWith(root.toLowerCase())) return
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
  render()
  listEl.querySelector('.tree-row.active')?.scrollIntoView({ block: 'nearest' })
}

async function toggle(dir: string): Promise<void> {
  if (expanded.has(dir)) expanded.delete(dir)
  else {
    expanded.add(dir)
    await load(dir)
  }
  render()
}

export function render(): void {
  if (!state.root || !listEl) return
  const activePath = activeTab()?.path
  const rows: HTMLElement[] = []
  const walk = (dir: string, depth: number) => {
    for (const e of cache.get(dir) ?? []) {
      const open = e.isDir && expanded.has(e.path)
      const row = h(
        'button',
        {
          class: 'tree-row' + (e.isDir ? ' dir' : '') + (open ? ' open' : '') + (e.path === activePath ? ' active' : ''),
          role: 'treeitem',
          'aria-expanded': e.isDir ? String(open) : null,
          title: e.path,
          style: { paddingLeft: `${10 + depth * 14}px` },
          onClick: () => (e.isDir ? toggle(e.path) : openFile(e.path))
        },
        e.isDir ? h('span', { class: 'chev', html: icons.chevron }) : h('span', { class: 'chev' }),
        h('span', { class: 'name' }, e.name)
      )
      rows.push(row)
      if (open) walk(e.path, depth + 1)
    }
  }
  walk(state.root, 0)
  if (rows.length === 0) rows.push(h('div', { class: 'tree-empty' }, '空文件夹'))
  listEl.replaceChildren(...rows)
}
