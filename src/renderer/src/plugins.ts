import { PLUGINS, type PluginDef, type PluginStatus } from '../../shared/plugins'
import { mentionInChat, openChat } from './chat'
import type { Command } from './commands'
import { h, toast } from './dom'
import { activeTab } from './editor'
import { icons } from './icons'
import type { MenuItem } from './menu'
import { newTerminal, type TermHandle } from './panel'
import { persist, state } from './store'

const status = new Map<string, PluginStatus | 'checking'>()
const terminals = new Map<string, TermHandle>()
const listeners = new Set<() => void>()
let listEl: HTMLElement
let refreshing: Promise<void> | null = null

const isWin = window.api.platform === 'win32'

export function isEnabled(id: string): boolean {
  return state.settings.plugins?.[id] !== false
}

/** 已启用且命令行工具已安装 */
export function usable(def: PluginDef): boolean {
  const s = status.get(def.id)
  return isEnabled(def.id) && typeof s === 'object' && s.installed
}

/** 插件状态（启用、安装）变化时通知 */
export function onPluginsChange(fn: () => void): void {
  listeners.add(fn)
}

function changed(): void {
  render()
  listeners.forEach((fn) => fn())
}

function setEnabled(id: string, on: boolean): void {
  state.settings.plugins = { ...state.settings.plugins, [id]: on }
  persist()
  changed()
}

/** 重新检测所有插件的命令行工具 */
export function refreshPlugins(): Promise<void> {
  if (refreshing) return refreshing
  for (const p of PLUGINS) if (!status.has(p.id)) status.set(p.id, 'checking')
  render()
  refreshing = Promise.all(
    PLUGINS.map(async (p) => {
      try {
        status.set(p.id, await window.api.plugins.detect(p.id))
      } catch {
        status.set(p.id, { installed: false })
      }
    })
  ).then(() => {
    refreshing = null
    changed()
  })
  return refreshing
}

/* ---------------- 动作 ---------------- */

/** 在终端里运行原生命令行界面（登录、/命令等对话面板不支持的操作） */
export async function launchInTerminal(def: PluginDef): Promise<void> {
  const existing = terminals.get(def.id)
  if (existing?.alive()) return existing.focus()
  const s = status.get(def.id)
  if (typeof s !== 'object' || !s.installed || !s.launch) {
    toast(`${def.name} 尚未安装`)
    return
  }
  const t = await newTerminal(state.root ?? undefined, { title: def.name, run: s.launch })
  if (t) terminals.set(def.id, t)
}

async function install(def: PluginDef): Promise<void> {
  const npm = isWin ? 'npm.cmd' : 'npm'
  const t = await newTerminal(undefined, { title: `安装 ${def.name}`, run: `${npm} install -g ${def.npmPackage}` })
  if (!t) return
  toast(`正在安装 ${def.name}，完成后点击“重新检测”`)
  await t.ready
  void refreshPlugins()
}

/* ---------------- 视图 ---------------- */

const glyphs: Record<string, string> = {
  claude: '<path d="M12 3v18M3 12h18M5.6 5.6l12.8 12.8M18.4 5.6L5.6 18.4"/>',
  codex: '<path d="M5 8l4 4-4 4M12 16h7"/>'
}

/** 插件图标（不是官方标志，只是简单的示意图形） */
export function glyph(id: string, size = 22): string {
  const body = glyphs[id]
  if (!body) return icons.plugin
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`
}

function card(def: PluginDef): HTMLElement {
  const s = status.get(def.id)
  const on = isEnabled(def.id)
  const checking = s === 'checking' || s === undefined
  const installed = typeof s === 'object' && s.installed

  const badge = checking
    ? h('span', { class: 'plg-badge' }, '检测中…')
    : installed
      ? h('span', { class: 'plg-badge ok' }, s.version ? `v${s.version}` : '已安装')
      : h('span', { class: 'plg-badge warn' }, '未安装')

  const toggle = h('button', {
    class: 'plg-switch' + (on ? ' on' : ''),
    role: 'switch',
    'aria-checked': String(on),
    'aria-label': `${on ? '停用' : '启用'} ${def.name}`,
    title: on ? '已启用，点击停用' : '已停用，点击启用',
    onClick: () => setEnabled(def.id, !on)
  })

  const actions: HTMLElement[] = []
  if (installed && on) {
    actions.push(h('button', { class: 'btn small primary', onClick: () => void openChat(def.id) }, '打开对话'))
    actions.push(h('button', { class: 'btn small', title: '原生命令行界面，可用于登录和 / 命令', onClick: () => void launchInTerminal(def) }, '在终端中运行'))
  } else if (!checking && !installed) {
    actions.push(h('button', { class: 'btn small primary', title: `npm install -g ${def.npmPackage}`, onClick: () => void install(def) }, '安装'))
  }
  actions.push(h('button', { class: 'btn small', onClick: () => window.open(def.homepage) }, '文档'))

  return h(
    'div',
    { class: 'plg-card' + (on ? '' : ' off'), 'data-plugin': def.id },
    h(
      'div',
      { class: 'plg-top' },
      h('span', { class: 'plg-icon', html: glyph(def.id) }),
      h('div', { class: 'plg-meta' }, h('div', { class: 'plg-name' }, def.name, badge), h('div', { class: 'plg-pub' }, def.publisher)),
      toggle
    ),
    h('p', { class: 'plg-desc' }, def.description),
    h('div', { class: 'plg-actions' }, ...actions)
  )
}

export function render(): void {
  if (!listEl) return
  listEl.replaceChildren(...PLUGINS.map(card))
}

export function createPluginsView(): HTMLElement {
  listEl = h('div', { class: 'plg-list' })
  render()
  return h(
    'div',
    { class: 'side-view', 'data-view': 'plugins' },
    h(
      'div',
      { class: 'side-head' },
      h('span', { class: 'side-title' }, '插件'),
      h(
        'div',
        { class: 'side-actions' },
        h('button', { class: 'icon-btn small', 'aria-label': '重新检测', title: '重新检测', html: icons.refresh, onClick: () => void refreshPlugins() })
      )
    ),
    listEl
  )
}

/* ---------------- 对外贡献：命令、右键菜单 ---------------- */

export function pluginCommands(openManager: () => void): Command[] {
  const cmds: Command[] = [{ id: 'plugins.manage', title: '管理插件', run: openManager }]
  for (const def of PLUGINS) {
    if (!usable(def)) continue
    cmds.push({ id: `plugins.${def.id}.chat`, title: `${def.name}：打开对话`, run: () => void openChat(def.id) })
    cmds.push({ id: `plugins.${def.id}.new`, title: `${def.name}：新建对话标签`, run: () => void openChat(def.id, { fresh: true }) })
    cmds.push({ id: `plugins.${def.id}.terminal`, title: `${def.name}：在终端中运行`, run: () => void launchInTerminal(def) })
    const tab = activeTab()
    if (tab) cmds.push({ id: `plugins.${def.id}.mention`, title: `${def.name}：引用当前文件`, run: () => mentionInChat(def.id, tab.path) })
  }
  return cmds
}

export function pluginTreeItems(path: string): MenuItem[] {
  const items: MenuItem[] = PLUGINS.filter(usable).map((def) => ({ label: `在 ${def.name} 中引用`, run: () => mentionInChat(def.id, path) }))
  return items.length ? [...items, 'sep'] : []
}
