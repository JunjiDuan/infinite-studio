import { PLUGINS, type PluginCategory, type PluginDef, type PluginStatus } from '../../shared/plugins'
import { mentionInChat, openChat } from './chat'
import type { Command } from './commands'
import { h, toast } from './dom'
import { activeTab } from './editor'
import { icons } from './icons'
import type { MenuItem } from './menu'
import { newTerminal, type TermHandle } from './panel'
import { persist, state } from './store'
import { t } from './i18n'

const status = new Map<string, PluginStatus | 'checking'>()
const terminals = new Map<string, TermHandle>()
const listeners = new Set<() => void>()
let listEl: HTMLElement
let query = ''
const collapsedCats = new Set<PluginCategory>()

const CATEGORIES: [PluginCategory, string][] = [
  ['llm', '大模型'],
  ['language', '编程语言']
]
let refreshing: Promise<void> | null = null

const isWin = window.api.platform === 'win32'

export function isEnabled(id: string): boolean {
  return state.settings.plugins?.[id] !== false
}

/** 大模型插件：已启用且命令行工具已安装 */
export function usable(def: PluginDef): boolean {
  const s = status.get(def.id)
  return def.category === 'llm' && isEnabled(def.id) && typeof s === 'object' && s.installed
}

/** 负责这种语言的编程语言插件 */
export function languagePlugin(languageId: string): PluginDef | undefined {
  return PLUGINS.find((p) => p.category === 'language' && p.languages?.includes(languageId))
}

/** 插件的检测结果；还没检测完时为 null */
export function pluginStatus(id: string): PluginStatus | null {
  const s = status.get(id)
  return typeof s === 'object' ? s : null
}

/** 编程语言插件已启用且运行、调试需要的组件都装好了 */
export function languageReady(def: PluginDef): boolean {
  return isEnabled(def.id) && !!pluginStatus(def.id)?.installed
}

/** 检测进行中（启动时）则等它完成 */
export function pluginsSettled(): Promise<void> {
  return refreshing ?? Promise.resolve()
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
    toast(t('{0} 尚未安装', def.name))
    return
  }
  const term = await newTerminal(state.root ?? undefined, { title: def.name, run: s.launch })
  if (term) terminals.set(def.id, term)
}

function installCommand(def: PluginDef): string {
  if (def.category === 'language') return pluginStatus(def.id)?.installScript ?? ''
  return `${isWin ? 'npm.cmd' : 'npm'} install -g ${def.npmPackage}`
}

export async function install(def: PluginDef): Promise<void> {
  const cmd = installCommand(def)
  if (!cmd) return
  const term = await newTerminal(undefined, { title: t('安装 {0}', def.name), run: cmd })
  if (!term) return
  toast(t('正在安装 {0}，完成后点击“重新检测”', def.name))
  await term.ready
  void refreshPlugins()
  if (def.category !== 'language') return
  // 包管理器下载时输出会停顿，ready 不代表装完：终端还开着就每 4 秒检测一次，直到装好（最多 15 分钟）
  const until = Date.now() + 15 * 60 * 1000
  const poll = async (): Promise<void> => {
    if (!term.alive() || Date.now() > until) return
    try {
      const s = await window.api.plugins.detect(def.id)
      if (s.installed && !s.installScript) {
        status.set(def.id, s)
        changed()
        toast(t('{0} 已安装完成', def.name))
        return
      }
    } catch {
      /* 下次再试 */
    }
    setTimeout(() => void poll(), 4000)
  }
  setTimeout(() => void poll(), 4000)
}

/* ---------------- 视图 ---------------- */

const glyphs: Record<string, string> = {
  python: '<path d="M12 3c-4 0-4 1.8-4 3v2h4.5M12 21c4 0 4-1.8 4-3v-2h-4.5"/><path d="M8 8H6c-1.7 0-3 1.3-3 4s1.3 4 3 4h2v-2.5c0-1.4 1.1-2.5 2.5-2.5h3c1.4 0 2.5-1.1 2.5-2.5V8"/><path d="M16 16h2c1.7 0 3-1.3 3-4s-1.3-4-3-4h-2"/>',
  java: '<path d="M7 17c3 1.5 7 1.5 10 0M6 20c4 1.5 8 1.5 12 0M10 3c2 2-2 3.5 0 6M14 5c1.5 1.6-1.5 2.7 0 5"/><path d="M5 12h12v1.5a4 4 0 0 1-4 4H9a4 4 0 0 1-4-4z"/><path d="M17 13h1.5a1.5 1.5 0 0 1 0 3H17"/>',
  cpp: '<path d="M10 7a5 5 0 1 0 0 10"/><path d="M12 12h4M14 10v4M17.5 12h4M19.5 10v4"/>'
}

/** AI 助手的官方标志（实心填充图形） */
const brandGlyphs: Record<string, string> = {
  claude: '<path fill="#D97757" d="M4.709 15.955l4.72-2.647.08-.23-.08-.128H9.2l-.79-.048-2.698-.073-2.339-.097-2.266-.122-.571-.121L0 11.784l.055-.352.48-.321.686.06 1.52.103 2.278.158 1.652.097 2.449.255h.389l.055-.157-.134-.098-.103-.097-2.358-1.596-2.552-1.688-1.336-.972-.724-.491-.364-.462-.158-1.008.656-.722.881.06.225.061.893.686 1.908 1.476 2.491 1.833.365.304.145-.103.019-.073-.164-.274-1.355-2.446-1.446-2.49-.644-1.032-.17-.619a2.97 2.97 0 01-.104-.729L6.283.134 6.696 0l.996.134.42.364.62 1.414 1.002 2.229 1.555 3.03.456.898.243.832.091.255h.158V9.01l.128-1.706.237-2.095.23-2.695.08-.76.376-.91.747-.492.584.28.48.685-.067.444-.286 1.851-.559 2.903-.364 1.942h.212l.243-.242.985-1.306 1.652-2.064.73-.82.85-.904.547-.431h1.033l.76 1.129-.34 1.166-1.064 1.347-.881 1.142-1.264 1.7-.79 1.36.073.11.188-.02 2.856-.606 1.543-.28 1.841-.315.833.388.091.395-.328.807-1.969.486-2.309.462-3.439.813-.042.03.049.061 1.549.146.662.036h1.622l3.02.225.79.522.474.638-.079.485-1.215.62-1.64-.389-3.829-.91-1.312-.329h-.182v.11l1.093 1.068 2.006 1.81 2.509 2.33.127.578-.322.455-.34-.049-2.205-1.657-.851-.747-1.926-1.62h-.128v.17l.444.649 2.345 3.521.122 1.08-.17.353-.608.213-.668-.122-1.374-1.925-1.415-2.167-1.143-1.943-.14.08-.674 7.254-.316.37-.729.28-.607-.461-.322-.747.322-1.476.389-1.924.315-1.53.286-1.9.17-.632-.012-.042-.14.018-1.434 1.967-2.18 2.945-1.726 1.845-.414.164-.717-.37.067-.662.401-.589 2.388-3.036 1.44-1.882.93-1.086-.006-.158h-.055L4.132 18.56l-1.13.146-.487-.456.061-.746.231-.243 1.908-1.312-.006.006z"/>',
  codex: '<path fill="currentColor" fill-rule="evenodd" clip-rule="evenodd" d="M8.086.457a6.105 6.105 0 013.046-.415c1.333.153 2.521.72 3.564 1.7a.117.117 0 00.107.029c1.408-.346 2.762-.224 4.061.366l.063.03.154.076c1.357.703 2.33 1.77 2.918 3.198.278.679.418 1.388.421 2.126a5.655 5.655 0 01-.18 1.631.167.167 0 00.04.155 5.982 5.982 0 011.578 2.891c.385 1.901-.01 3.615-1.183 5.14l-.182.22a6.063 6.063 0 01-2.934 1.851.162.162 0 00-.108.102c-.255.736-.511 1.364-.987 1.992-1.199 1.582-2.962 2.462-4.948 2.451-1.583-.008-2.986-.587-4.21-1.736a.145.145 0 00-.14-.032c-.518.167-1.04.191-1.604.185a5.924 5.924 0 01-2.595-.622 6.058 6.058 0 01-2.146-1.781c-.203-.269-.404-.522-.551-.821a7.74 7.74 0 01-.495-1.283 6.11 6.11 0 01-.017-3.064.166.166 0 00.008-.074.115.115 0 00-.037-.064 5.958 5.958 0 01-1.38-2.202 5.196 5.196 0 01-.333-1.589 6.915 6.915 0 01.188-2.132c.45-1.484 1.309-2.648 2.577-3.493.282-.188.55-.334.802-.438.286-.12.573-.22.861-.304a.129.129 0 00.087-.087A6.016 6.016 0 015.635 2.31C6.315 1.464 7.132.846 8.086.457zm-.804 7.85a.848.848 0 00-1.473.842l1.694 2.965-1.688 2.848a.849.849 0 001.46.864l1.94-3.272a.849.849 0 00.007-.854l-1.94-3.393zm5.446 6.24a.849.849 0 000 1.695h4.848a.849.849 0 000-1.696h-4.848z"/>'
}

/** 插件图标：Claude / Codex 用官方标志，语言插件是简单的示意图形 */
export function glyph(id: string, size = 22): string {
  const brand = brandGlyphs[id]
  if (brand) return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true">${brand}</svg>`
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
    ? h('span', { class: 'plg-badge' }, t('检测中…'))
    : installed
      ? h('span', { class: 'plg-badge ok' }, s.version ? `v${s.version}` : t('已安装'))
      : h('span', { class: 'plg-badge warn' }, t('未安装'))

  const toggle = h('button', {
    class: 'plg-switch' + (on ? ' on' : ''),
    role: 'switch',
    'aria-checked': String(on),
    'aria-label': `${on ? t('停用') : t('启用')} ${def.name}`,
    title: on ? t('已启用，点击停用') : t('已停用，点击启用'),
    onClick: () => setEnabled(def.id, !on)
  })

  if (def.category === 'language') return languageCard(def, s, on, checking, installed, badge, toggle)

  const actions: HTMLElement[] = []
  if (installed && on) {
    actions.push(h('button', { class: 'btn small primary', onClick: () => void openChat(def.id) }, t('打开对话')))
    actions.push(h('button', { class: 'btn small', title: t('原生命令行界面，可用于登录和 / 命令'), onClick: () => void launchInTerminal(def) }, t('在终端中运行')))
  } else if (!checking && !installed) {
    actions.push(h('button', { class: 'btn small primary', title: installCommand(def), onClick: () => void install(def) }, t('安装')))
  }
  actions.push(h('button', { class: 'btn small', onClick: () => window.open(def.homepage) }, t('文档')))

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
    h('p', { class: 'plg-desc' }, t(def.description)),
    h('div', { class: 'plg-actions' }, ...actions)
  )
}

/** 编程语言插件的卡片：列出各组件的检测结果 */
function languageCard(def: PluginDef, s: PluginStatus | 'checking' | undefined, on: boolean, checking: boolean, installed: boolean, badge: HTMLElement, toggle: HTMLElement): HTMLElement {
  const st = typeof s === 'object' ? s : null
  const comps = st?.components ?? []
  const actions: HTMLElement[] = []
  if (!checking && st?.installScript) {
    actions.push(
      h(
        'button',
        { class: 'btn small' + (installed ? '' : ' primary'), title: st.installScript, onClick: () => void install(def) },
        installed ? t('安装可选组件') : t('安装')
      )
    )
  }
  if (installed && on) actions.push(h('span', { class: 'plg-hint muted' }, t('Ctrl F5 运行 · F5 调试')))
  actions.push(h('button', { class: 'btn small', onClick: () => window.open(def.homepage) }, t('文档')))
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
    h('p', { class: 'plg-desc' }, t(def.description)),
    comps.length
      ? h(
          'ul',
          { class: 'plg-comps' },
          ...comps.map((c) =>
            h(
              'li',
              { class: c.ok ? 'ok' : c.optional ? 'opt' : 'miss' },
              h('span', { class: 'dot' }),
              h('span', { class: 'plg-comp-name' }, t(c.name)),
              h('span', { class: 'plg-comp-detail' }, c.ok ? (c.detail ?? t('已安装')) : c.optional ? t('未安装（可选）') : t('未安装'))
            )
          )
        )
      : null,
    h('div', { class: 'plg-actions' }, ...actions)
  )
}

function matches(def: PluginDef, q: string): boolean {
  if (!q) return true
  return [def.name, def.publisher, def.id, t(def.description)].some((v) => v.toLowerCase().includes(q))
}

function category(cat: PluginCategory, title: string, q: string): HTMLElement | null {
  const all = PLUGINS.filter((p) => p.category === cat)
  const items = all.filter((p) => matches(p, q))
  // 搜索时隐藏没有匹配项的分类
  if (q && !items.length) return null
  // 搜索时强制展开，方便看到结果
  const collapsed = !q && collapsedCats.has(cat)
  const body = h('div', { class: 'plg-cat-body' }, ...items.map(card))
  if (!items.length) body.append(h('div', { class: 'plg-empty muted' }, t('暂无插件')))
  const el = h(
    'div',
    { class: 'plg-cat' + (collapsed ? ' collapsed' : ''), 'data-cat': cat },
    h(
      'div',
      {
        class: 'plg-cat-head',
        role: 'button',
        tabindex: '0',
        'aria-expanded': String(!collapsed),
        onClick: () => toggleCat(cat, el),
        onKeydown: (e: KeyboardEvent) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            toggleCat(cat, el)
          }
        }
      },
      h('span', { class: 'chev', html: icons.chevron }),
      h('span', { class: 'plg-cat-title' }, t(title)),
      h('span', { class: 'grow' }),
      h('span', { class: 'scm-count' }, String(items.length))
    ),
    body
  )
  return el
}

function toggleCat(cat: PluginCategory, el: HTMLElement): void {
  const collapsed = !el.classList.contains('collapsed')
  if (collapsed) collapsedCats.add(cat)
  else collapsedCats.delete(cat)
  el.classList.toggle('collapsed', collapsed)
  el.querySelector('.plg-cat-head')?.setAttribute('aria-expanded', String(!collapsed))
}

export function render(): void {
  if (!listEl) return
  const q = query.trim().toLowerCase()
  const cats = CATEGORIES.map(([id, title]) => category(id, title, q)).filter((x): x is HTMLElement => !!x)
  if (!cats.length) cats.push(h('div', { class: 'plg-empty muted' }, t('没有匹配的插件')))
  listEl.replaceChildren(...cats)
}

export function createPluginsView(): HTMLElement {
  listEl = h('div', { class: 'plg-list' })
  const input = h('input', {
    class: 'search-input',
    type: 'text',
    placeholder: t('搜索插件'),
    'aria-label': t('搜索插件'),
    spellcheck: 'false',
    onInput: (e: Event) => {
      query = (e.target as HTMLInputElement).value
      render()
    },
    onKeydown: (e: KeyboardEvent) => {
      if (e.key === 'Escape' && query) {
        e.stopPropagation()
        ;(e.target as HTMLInputElement).value = ''
        query = ''
        render()
      }
    }
  })
  render()
  return h(
    'div',
    { class: 'side-view', 'data-view': 'plugins' },
    h(
      'div',
      { class: 'side-head' },
      h('span', { class: 'side-title' }, t('插件')),
      h(
        'div',
        { class: 'side-actions' },
        h('button', { class: 'icon-btn small', 'aria-label': t('重新检测'), title: t('重新检测'), html: icons.refresh, onClick: () => void refreshPlugins() })
      )
    ),
    h('div', { class: 'plg-search' }, h('div', { class: 'search-box' }, h('span', { class: 'plg-search-ic', html: icons.search }), input)),
    listEl
  )
}

/* ---------------- 对外贡献：命令、右键菜单 ---------------- */

export function pluginCommands(openManager: () => void): Command[] {
  const cmds: Command[] = [{ id: 'plugins.manage', title: t('管理插件'), run: openManager }]
  for (const def of PLUGINS) {
    if (!usable(def)) continue
    cmds.push({ id: `plugins.${def.id}.chat`, title: t('{0}：打开对话', def.name), run: () => void openChat(def.id) })
    cmds.push({ id: `plugins.${def.id}.new`, title: t('{0}：新建对话标签', def.name), run: () => void openChat(def.id, { fresh: true }) })
    cmds.push({ id: `plugins.${def.id}.terminal`, title: t('{0}：在终端中运行', def.name), run: () => void launchInTerminal(def) })
    const tab = activeTab()
    if (tab) cmds.push({ id: `plugins.${def.id}.mention`, title: t('{0}：引用当前文件', def.name), run: () => mentionInChat(def.id, tab.path) })
  }
  return cmds
}

export function pluginTreeItems(path: string): MenuItem[] {
  const items: MenuItem[] = PLUGINS.filter(usable).map((def) => ({ label: t('在 {0} 中引用', def.name), run: () => mentionInChat(def.id, path) }))
  return items.length ? [...items, 'sep'] : []
}
