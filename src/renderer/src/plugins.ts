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
import { marketCards, marketCommands, onMarketChange, refreshMarket } from './market'

const status = new Map<string, PluginStatus | 'checking'>()
const terminals = new Map<string, TermHandle>()
const listeners = new Set<() => void>()
let listEl: HTMLElement
let query = ''
/** 用户手动展开过的分类；默认全部收起 */
const expandedCats = new Set<PluginCategory>()

const CATEGORIES: [PluginCategory, string][] = [
  ['llm', '大模型'],
  ['language', '编程语言'],
  ['productivity', '生产力工具'],
  ['locale', '多语言支持']
]
let refreshing: Promise<void> | null = null
onMarketChange(() => changed())

const isWin = window.api.platform === 'win32'

export function isEnabled(id: string): boolean {
  return state.settings.plugins?.[id] !== false
}

/** 大模型插件：已启用且命令行工具已安装 */
function runnable(def: PluginDef): boolean {
  const s = status.get(def.id)
  return def.category === 'llm' && isEnabled(def.id) && typeof s === 'object' && s.installed
}

/** 可以打开对话面板的大模型插件（已启用、已安装、有对话驱动） */
export function usable(def: PluginDef): boolean {
  return !!def.chat && runnable(def)
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
export function refreshPlugins(force = false): Promise<void> {
  void refreshMarket(force)
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
  const term = await newTerminal(state.root ?? undefined, { title: def.name, run: def.launchArgs ? `${s.launch} ${def.launchArgs}` : s.launch })
  if (term) terminals.set(def.id, term)
}

function installCommand(def: PluginDef): string {
  if (def.category === 'language') return pluginStatus(def.id)?.installScript ?? ''
  if (def.installScript) return isWin ? def.installScript.win : def.installScript.unix
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
  codex: '<path fill="currentColor" fill-rule="evenodd" clip-rule="evenodd" d="M8.086.457a6.105 6.105 0 013.046-.415c1.333.153 2.521.72 3.564 1.7a.117.117 0 00.107.029c1.408-.346 2.762-.224 4.061.366l.063.03.154.076c1.357.703 2.33 1.77 2.918 3.198.278.679.418 1.388.421 2.126a5.655 5.655 0 01-.18 1.631.167.167 0 00.04.155 5.982 5.982 0 011.578 2.891c.385 1.901-.01 3.615-1.183 5.14l-.182.22a6.063 6.063 0 01-2.934 1.851.162.162 0 00-.108.102c-.255.736-.511 1.364-.987 1.992-1.199 1.582-2.962 2.462-4.948 2.451-1.583-.008-2.986-.587-4.21-1.736a.145.145 0 00-.14-.032c-.518.167-1.04.191-1.604.185a5.924 5.924 0 01-2.595-.622 6.058 6.058 0 01-2.146-1.781c-.203-.269-.404-.522-.551-.821a7.74 7.74 0 01-.495-1.283 6.11 6.11 0 01-.017-3.064.166.166 0 00.008-.074.115.115 0 00-.037-.064 5.958 5.958 0 01-1.38-2.202 5.196 5.196 0 01-.333-1.589 6.915 6.915 0 01.188-2.132c.45-1.484 1.309-2.648 2.577-3.493.282-.188.55-.334.802-.438.286-.12.573-.22.861-.304a.129.129 0 00.087-.087A6.016 6.016 0 015.635 2.31C6.315 1.464 7.132.846 8.086.457zm-.804 7.85a.848.848 0 00-1.473.842l1.694 2.965-1.688 2.848a.849.849 0 001.46.864l1.94-3.272a.849.849 0 00.007-.854l-1.94-3.393zm5.446 6.24a.849.849 0 000 1.695h4.848a.849.849 0 000-1.696h-4.848z"/>',
  deepseek: '<path fill="#4D6BFE" d="M23.748 4.482c-.254-.124-.364.113-.512.234-.051.039-.094.09-.137.136-.372.397-.806.657-1.373.626-.829-.046-1.537.214-2.163.848-.133-.782-.575-1.248-1.247-1.548-.352-.156-.708-.311-.955-.65-.172-.241-.219-.51-.305-.774-.055-.16-.11-.323-.293-.35-.2-.031-.278.136-.356.276-.313.572-.434 1.202-.422 1.84.027 1.436.633 2.58 1.838 3.393.137.093.172.187.129.323-.082.28-.18.552-.266.833-.055.179-.137.217-.329.14a5.526 5.526 0 01-1.736-1.18c-.857-.828-1.631-1.742-2.597-2.458a11.365 11.365 0 00-.689-.471c-.985-.957.13-1.743.388-1.836.27-.098.093-.432-.779-.428-.872.004-1.67.295-2.687.684a3.055 3.055 0 01-.465.137 9.597 9.597 0 00-2.883-.102c-1.885.21-3.39 1.102-4.497 2.623C.082 8.606-.231 10.684.152 12.85c.403 2.284 1.569 4.175 3.36 5.653 1.858 1.533 3.997 2.284 6.438 2.14 1.482-.085 3.133-.284 4.994-1.86.47.234.962.327 1.78.397.63.059 1.236-.03 1.705-.128.735-.156.684-.837.419-.961-2.155-1.004-1.682-.595-2.113-.926 1.096-1.296 2.746-2.642 3.392-7.003.05-.347.007-.565 0-.845-.004-.17.035-.237.23-.256a4.173 4.173 0 001.545-.475c1.396-.763 1.96-2.015 2.093-3.517.02-.23-.004-.467-.247-.588zM11.581 18c-2.089-1.642-3.102-2.183-3.52-2.16-.392.024-.321.471-.235.763.09.288.207.486.371.739.114.167.192.416-.113.603-.673.416-1.842-.14-1.897-.167-1.361-.802-2.5-1.86-3.301-3.307-.774-1.393-1.224-2.887-1.298-4.482-.02-.386.093-.522.477-.592a4.696 4.696 0 011.529-.039c2.132.312 3.946 1.265 5.468 2.774.868.86 1.525 1.887 2.202 2.891.72 1.066 1.494 2.082 2.48 2.914.348.292.625.514.891.677-.802.09-2.14.11-3.054-.614zm1-6.44a.306.306 0 01.415-.287.302.302 0 01.2.288.306.306 0 01-.31.307.303.303 0 01-.304-.308zm3.11 1.596c-.2.081-.399.151-.59.16a1.245 1.245 0 01-.798-.254c-.274-.23-.47-.358-.552-.758a1.73 1.73 0 01.016-.588c.07-.327-.008-.537-.239-.727-.187-.156-.426-.199-.688-.199a.559.559 0 01-.254-.078c-.11-.054-.2-.19-.114-.358.028-.054.16-.186.192-.21.356-.202.767-.136 1.146.016.352.144.618.408 1.001.782.391.451.462.576.685.914.176.265.336.537.445.848.067.195-.019.354-.25.452z"/>',
  gemini:
    '<defs><linearGradient id="gemini-g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#4796E3"/><stop offset=".55" stop-color="#9177C7"/><stop offset="1" stop-color="#CA6673"/></linearGradient></defs><path fill="url(#gemini-g)" d="M11.04 19.32Q12 21.51 12 24q0-2.49.93-4.68.96-2.19 2.58-3.81t3.81-2.55Q21.51 12 24 12q-2.49 0-4.68-.93a12.3 12.3 0 0 1-3.81-2.58 12.3 12.3 0 0 1-2.58-3.81Q12 2.49 12 0q0 2.49-.96 4.68-.93 2.19-2.55 3.81a12.3 12.3 0 0 1-3.81 2.58Q2.49 12 0 12q2.49 0 4.68.96 2.19.93 3.81 2.55t2.55 3.81"/>',
  // Antigravity：渐变拱形（示意图形）
  antigravity:
    '<defs><linearGradient id="agy-g" x1="0" y1="1" x2="1" y2="0"><stop offset="0" stop-color="#4796E3"/><stop offset=".5" stop-color="#34A853"/><stop offset="1" stop-color="#FBBC04"/></linearGradient></defs><path fill="url(#agy-g)" d="M12 2.5c-2.1 0-3.7 1.6-4.9 4.6L2.6 19.2c-.5 1.3.4 2.3 1.6 2.3 1.4 0 2.2-1 3-2.8l2.1-4.6c.7-1.5 1.5-2.2 2.7-2.2s2 .7 2.7 2.2l2.1 4.6c.8 1.8 1.6 2.8 3 2.8 1.2 0 2.1-1 1.6-2.3L16.9 7.1C15.7 4.1 14.1 2.5 12 2.5z"/>',
  kimi: '<path fill="#1783FF" d="M21.846 0a1.923 1.923 0 110 3.846H20.15a.226.226 0 01-.227-.226V1.923C19.923.861 20.784 0 21.846 0z"/><path fill="currentColor" d="M11.065 11.199l7.257-7.2c.137-.136.06-.41-.116-.41H14.3a.164.164 0 00-.117.051l-7.82 7.756c-.122.12-.302.013-.302-.179V3.82c0-.127-.083-.23-.185-.23H3.186c-.103 0-.186.103-.186.23V19.77c0 .128.083.23.186.23h2.69c.103 0 .186-.102.186-.23v-3.25c0-.069.025-.135.069-.178l2.424-2.406a.158.158 0 01.205-.023l6.484 4.772a7.677 7.677 0 003.453 1.283c.108.012.2-.095.2-.23v-3.06c0-.117-.07-.212-.164-.227a5.028 5.028 0 01-2.027-.807l-5.613-4.064c-.117-.078-.132-.279-.028-.381z"/>'
}

/** 插件图标：大模型插件用官方标志，语言插件是简单的示意图形 */
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
    if (def.chat) actions.push(h('button', { class: 'btn small primary', onClick: () => void openChat(def.id) }, t('打开对话')))
    actions.push(h('button', { class: 'btn small' + (def.chat ? '' : ' primary'), title: t('原生命令行界面，可用于登录和 / 命令'), onClick: () => void launchInTerminal(def) }, t('在终端中运行')))
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
      h('div', { class: 'plg-meta' }, h('div', { class: 'plg-name' }, h('span', { class: 'plg-title', title: def.name }, def.name), badge), h('div', { class: 'plg-pub' }, def.publisher)),
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
      h('div', { class: 'plg-meta' }, h('div', { class: 'plg-name' }, h('span', { class: 'plg-title', title: def.name }, def.name), badge), h('div', { class: 'plg-pub' }, def.publisher)),
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
  const items = PLUGINS.filter((p) => p.category === cat && matches(p, q))
  const market = cat === 'productivity' || cat === 'locale' || cat === 'llm' ? marketCards(q, cat) : { items: [], count: 0 }
  const count = items.length + market.count
  // 搜索时隐藏没有匹配项的分类
  if (q && !count) return null
  // 搜索时强制展开，方便看到结果
  const collapsed = !q && !expandedCats.has(cat)
  const body = h('div', { class: 'plg-cat-body' }, ...items.map(card), ...market.items)
  if (!body.childElementCount) body.append(h('div', { class: 'plg-empty muted' }, t('暂无插件')))
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
      h('span', { class: 'scm-count' }, String(count))
    ),
    body
  )
  return el
}

function toggleCat(cat: PluginCategory, el: HTMLElement): void {
  const collapsed = !el.classList.contains('collapsed')
  if (collapsed) expandedCats.delete(cat)
  else expandedCats.add(cat)
  el.classList.toggle('collapsed', collapsed)
  el.querySelector('.plg-cat-head')?.setAttribute('aria-expanded', String(!collapsed))
}

/** 展开并滚动到某个分类（例如从多语言设置跳到“语言”） */
export function revealCategory(cat: PluginCategory): void {
  expandedCats.add(cat)
  render()
  requestAnimationFrame(() => listEl?.querySelector(`.plg-cat[data-cat="${cat}"]`)?.scrollIntoView({ block: 'start', behavior: 'smooth' }))
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
        h('button', { class: 'icon-btn small', 'aria-label': t('重新检测'), title: t('重新检测'), html: icons.refresh, onClick: () => void refreshPlugins(true) })
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
    if (!runnable(def)) continue
    if (!def.chat) {
      cmds.push({ id: `plugins.${def.id}.terminal`, title: t('{0}：在终端中运行', def.name), run: () => void launchInTerminal(def) })
      continue
    }
    cmds.push({ id: `plugins.${def.id}.chat`, title: t('{0}：打开对话', def.name), run: () => void openChat(def.id) })
    cmds.push({ id: `plugins.${def.id}.new`, title: t('{0}：新建对话标签', def.name), run: () => void openChat(def.id, { fresh: true }) })
    cmds.push({ id: `plugins.${def.id}.terminal`, title: t('{0}：在终端中运行', def.name), run: () => void launchInTerminal(def) })
    const tab = activeTab()
    if (tab) cmds.push({ id: `plugins.${def.id}.mention`, title: t('{0}：引用当前文件', def.name), run: () => mentionInChat(def.id, tab.path) })
  }
  return [...cmds, ...marketCommands()]
}

export function pluginTreeItems(path: string): MenuItem[] {
  const items: MenuItem[] = PLUGINS.filter(usable).map((def) => ({ label: t('在 {0} 中引用', def.name), run: () => mentionInChat(def.id, path) }))
  return items.length ? [...items, 'sep'] : []
}
