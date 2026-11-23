/**
 * 插件市场（生产力工具、语言包）：从 GitHub 插件仓库安装的插件。
 * 插件的编辑器页面放在 iframe 里（studio-plugin://<id>/ 协议，和 IDE 不同源），只能通过 postMessage 和 IDE 通信。
 */
import { PLUGIN_API, type PluginCategory, type PluginManifest, type PluginPermission, type RemotePlugin } from '../../shared/plugins'
import type { TextEncodingInfo } from '../../shared/types'
import type { Command } from './commands'
import { basename, h, toast } from './dom'
import { activeTab, closeView, isUnder, normPath, openFile, openView, pathKey, registerPreviewer, revealView, samePath, updateView, type ViewSpec } from './editor'
import { getLocale, t } from './i18n'
import { icons } from './icons'
import { newTerminal } from './panel'
import { emit, on, persist, state } from './store'
import { resolve } from './theme'

let remote: RemotePlugin[] = []
let installed: PluginManifest[] = []
let loading = false
let error: string | null = null
const progress = new Map<string, number | 'busy'>()
const listeners = new Set<() => void>()
const notify = (): void => listeners.forEach((fn) => fn())

/** 插件列表、安装状态变化时调用（插件面板重绘、多语言设置里的语言列表） */
export function onMarketChange(fn: () => void): void {
  listeners.add(fn)
}

/** 切换界面语言（由设置页提供，语言包卡片上的“使用此语言”用） */
let localeSwitcher: ((code: string) => void) | null = null
export function setLocaleSwitcher(fn: (code: string) => void): void {
  localeSwitcher = fn
}

/** 打开网页面板的选择弹窗（由 webPanel.ts 提供，插件卡片上的“打开”用） */
let webPanelOpener: ((m: PluginManifest, anchor: HTMLElement) => void) | null = null
export function setWebPanelOpener(fn: (m: PluginManifest, anchor: HTMLElement) => void): void {
  webPanelOpener = fn
}

/** 已安装、已启用、声明了网页面板的插件 */
export function webPanelPlugins(): PluginManifest[] {
  return installed.filter((m) => m.webPanel && marketEnabled(m.id) && !tooNew(m))
}

/** 已安装、已启用的语言包 */
export function localePacks(): PluginManifest[] {
  return installed.filter((m) => m.category === 'locale' && m.locale && marketEnabled(m.id) && !tooNew(m))
}

export function marketEnabled(id: string): boolean {
  return state.settings.plugins?.[id] !== false
}

function setEnabled(id: string, on: boolean): void {
  state.settings.plugins = { ...state.settings.plugins, [id]: on }
  persist()
  notify()
}

function cmpVer(a: string, b: string): number {
  const p = (v: string) => v.replace(/^v/, '').split(/[.+-]/).map((x) => parseInt(x, 10) || 0)
  const x = p(a)
  const y = p(b)
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0)
  return 0
}

async function loadInstalled(): Promise<void> {
  installed = await window.api.market.installed().catch(() => [])
}

/** 只重新读取已安装的插件（不联网） */
export async function reloadInstalled(): Promise<void> {
  await loadInstalled()
  notify()
}

/** 重新读取已安装的插件和插件仓库的列表 */
export async function refreshMarket(force = false): Promise<void> {
  if (loading) return
  loading = true
  notify()
  await loadInstalled()
  const r = await window.api.market.registry(force)
  if (r.ok) {
    remote = r.value
    error = null
  } else error = r.error
  loading = false
  notify()
}

async function install(id: string, name: string): Promise<void> {
  progress.set(id, 'busy')
  notify()
  const r = await window.api.market.install(id)
  progress.delete(id)
  if (r.ok) {
    await loadInstalled()
    toast(t('{0} 已安装完成', name))
  } else toast(t('安装 {0} 失败：{1}', name, r.error))
  notify()
}

async function uninstall(m: PluginManifest): Promise<void> {
  if (!confirm(t('确定卸载 {0}？', m.name))) return
  for (const ed of [...editors]) if (ed.manifest.id === m.id) ed.close()
  const r = await window.api.market.uninstall(m.id)
  if (!r.ok) toast(r.error)
  await loadInstalled()
  notify()
}

/* ---------------- 插件面板里的卡片 ---------------- */

interface Entry {
  id: string
  remote?: RemotePlugin
  local?: PluginManifest
}

function entries(): Entry[] {
  const map = new Map<string, Entry>()
  for (const r of remote) map.set(r.id, { id: r.id, remote: r })
  for (const m of installed) map.set(m.id, { ...map.get(m.id), id: m.id, local: m })
  return [...map.values()].sort((a, b) => cmpName(info(a).name, info(b).name))
}

/* 按名称首字母 A–Z 排序：英文取首字母，中文取拼音首字母（例如“思维导图”算 S） */
const collator = new Intl.Collator('zh-Hans-CN', { sensitivity: 'base', numeric: true })
/** 各拼音首字母下排在最前的汉字（Unicode 排序规则下的分界） */
const PINYIN_BOUNDS = '阿八嚓哒妸发旮哈讥咔垃痳拏噢妑七呥仨他屲夕丫帀'
const PINYIN_LETTERS = 'ABCDEFGHJKLMNOPQRSTWXYZ'

function initial(name: string): string {
  const ch = [...name.trim()][0] ?? ''
  if (/[a-z]/i.test(ch)) return ch.toUpperCase()
  if (!/\p{Script=Han}/u.test(ch)) return '~' // 数字、符号排在最后
  let r = 'A'
  for (let i = 0; i < PINYIN_BOUNDS.length; i++) {
    if (collator.compare(ch, PINYIN_BOUNDS[i]) >= 0) r = PINYIN_LETTERS[i]
    else break
  }
  return r
}

function cmpName(a: string, b: string): number {
  const x = initial(a)
  const y = initial(b)
  return x < y ? -1 : x > y ? 1 : collator.compare(a, b)
}

function info(e: Entry): { name: string; publisher: string; description: string; homepage?: string; category: PluginCategory } {
  return (e.local ?? e.remote)!
}

/** 卡片放在哪个分类：语言包放“语言”，大模型（网页大模型助手等）放“大模型”，其余都是“生产力工具” */
function entryCategory(e: Entry): PluginCategory {
  const c = info(e).category
  return c === 'locale' || c === 'llm' ? c : 'productivity'
}

/** 插件声明的额外权限（联网等），显示在卡片上 */
function permHint(e: Entry): HTMLElement | null {
  const perms = e.remote?.permissions ?? e.local?.permissions ?? []
  const names = perms.map((p) => PERM_NAMES[p]?.()).filter(Boolean)
  return names.length ? h('p', { class: 'plg-hint muted' }, t('需要权限：{0}', names.join(t('、')))) : null
}

const PERM_NAMES: Record<string, () => string> = {
  network: () => t('联网'),
  eval: () => t('动态执行代码'),
  'workspace-write': () => t('修改工作区文件'),
  'clipboard-read': () => t('读取剪贴板'),
  terminal: () => t('在终端运行命令'),
  webPanel: () => t('在分栏里显示网页')
}

/** 插件要求的接口版本比这个 IDE 新 */
function tooNew(x: { minApi?: number } | undefined): boolean {
  return !!x && (x.minApi ?? 1) > PLUGIN_API
}

function matches(e: Entry, q: string): boolean {
  if (!q) return true
  const i = info(e)
  return [i.name, i.publisher, e.id, i.description].some((v) => v.toLowerCase().includes(q))
}

function card(e: Entry): HTMLElement {
  const i = info(e)
  const on = marketEnabled(e.id)
  const p = progress.get(e.id)
  const needIde = tooNew(e.remote) || tooNew(e.local)
  const update = !needIde && e.local && e.remote && cmpVer(e.remote.version, e.local.version) > 0 ? e.remote : null

  const badge = p
    ? h('span', { class: 'plg-badge' }, p === 'busy' ? t('正在安装…') : `${Math.round(p * 100)}%`)
    : e.local
      ? h('span', { class: 'plg-badge ok', title: `v${e.local.version}` }, e.local.locale && on && getLocale() === e.local.locale.code ? t('当前语言') : `v${e.local.version}`)
      : h('span', { class: 'plg-badge warn' }, t('未安装'))

  const actions: HTMLElement[] = []
  const lang = e.local?.locale
  const current = !!lang && on && getLocale() === lang.code
  if (!p) {
    if (lang && on && !current && !needIde && localeSwitcher) {
      const code = lang.code
      actions.push(h('button', { class: 'btn small primary', onClick: () => localeSwitcher?.(code) }, t('使用此语言')))
    }
    if (e.local && on && e.local.webPanel && !needIde && webPanelOpener) {
      const m = e.local
      const b: HTMLElement = h('button', { class: 'btn small primary', onClick: () => webPanelOpener?.(m, b) }, t('打开'))
      actions.push(b)
    }
    if (e.local && on && e.local.newFile) {
      const m = e.local
      actions.push(h('button', { class: 'btn small primary', onClick: () => void newPluginFile(m) }, t('新建{0}', m.newFile!.label)))
    }
    if (update) actions.push(h('button', { class: 'btn small primary', title: t('更新到 v{0}', update.version), onClick: () => void install(e.id, i.name) }, t('更新')))
    if (!e.local && e.remote && !needIde) actions.push(h('button', { class: 'btn small primary', title: e.remote.size ? `${(e.remote.size / 1024 / 1024).toFixed(1)} MB` : undefined, onClick: () => void install(e.id, i.name) }, t('安装')))
    if (e.local) {
      const m = e.local
      actions.push(h('button', { class: 'btn small', onClick: () => void uninstall(m) }, t('卸载')))
    }
  }
  if (i.homepage && /^https:\/\//.test(i.homepage)) actions.push(h('button', { class: 'btn small', onClick: () => window.open(i.homepage) }, t('文档')))

  const icon = e.local?.icon ? h('img', { src: `studio-plugin://${e.id}/${encodeURI(e.local.icon)}`, width: '22', height: '22', alt: '' }) : h('span', { html: icons.plugin })

  return h(
    'div',
    { class: 'plg-card' + (on ? '' : ' off'), 'data-plugin': e.id },
    h(
      'div',
      { class: 'plg-top' },
      h('span', { class: 'plg-icon' }, icon),
      h('div', { class: 'plg-meta' }, h('div', { class: 'plg-name' }, h('span', { class: 'plg-title', title: i.name }, i.name), badge), h('div', { class: 'plg-pub' }, i.publisher)),
      e.local
        ? h('button', {
            class: 'plg-switch' + (on ? ' on' : ''),
            role: 'switch',
            'aria-checked': String(on),
            'aria-label': `${on ? t('停用') : t('启用')} ${i.name}`,
            title: on ? t('已启用，点击停用') : t('已停用，点击启用'),
            onClick: () => setEnabled(e.id, !on)
          })
        : null
    ),
    h('p', { class: 'plg-desc' }, i.description),
    permHint(e),
    needIde ? h('p', { class: 'plg-hint muted' }, t('这个插件需要更新 Infinite Studio 才能使用')) : null,
    update ? h('p', { class: 'plg-hint muted' }, t('有新版本 v{0}', update.version)) : null,
    h('div', { class: 'plg-actions' }, ...actions)
  )
}

/** 生产力工具 / 语言 / 大模型分类里的市场插件；q 为小写的搜索词 */
export function marketCards(q: string, cat: PluginCategory = 'productivity'): { items: HTMLElement[]; count: number } {
  const list = entries().filter((e) => entryCategory(e) === cat && matches(e, q))
  const items = list.map(card)
  // “大模型”分类里主要是内置插件，取列表的提示只放在市场自己的分类里
  if (!q && cat !== 'llm') {
    if (loading && !remote.length) items.push(h('div', { class: 'plg-empty muted' }, t('正在获取插件列表…')))
    else if (error) {
      items.push(
        h(
          'div',
          { class: 'plg-empty muted' },
          h('div', {}, t('无法连接到插件仓库')),
          h('button', { class: 'btn small', style: { marginTop: '8px' }, title: error, onClick: () => void refreshMarket(true) }, t('重试'))
        )
      )
    }
  }
  return { items, count: list.length }
}

/* ---------------- 新建文件 ---------------- */

async function newPluginFile(m: PluginManifest): Promise<void> {
  const nf = m.newFile
  if (!nf) return
  if (!state.root) return toast(t('请先打开一个文件夹'))
  const stem = t('未命名')
  for (let i = 1; i < 100; i++) {
    const name = i === 1 ? `${stem}${nf.extension}` : `${stem}-${i}${nf.extension}`
    try {
      const p = await window.api.fs.createFile(state.root, name)
      if (nf.template) await window.api.fs.writeFile(p, nf.template)
      await openFile(p)
      return
    } catch {
      /* 重名，换下一个 */
    }
  }
  toast(t('新建失败'))
}

export function marketCommands(): Command[] {
  const out: Command[] = []
  for (const m of installed) {
    if (!marketEnabled(m.id) || !m.newFile) continue
    out.push({ id: `market.${m.id}.new`, title: t('{0}：新建{1}', m.name, m.newFile.label), run: () => void newPluginFile(m) })
  }
  // 当前文件在文本编辑器里打开着（例如点过“以文本方式打开”）：可以切回插件视图
  const tab = activeTab()
  if (tab) {
    const m = editorFor(tab.path)
    if (m) out.push({ id: `market.${m.id}.open`, title: t('{0}：打开当前文件', m.name), run: () => openPluginEditor(m, tab.path) })
  }
  // 正在显示的插件编辑器注册的命令
  for (const ed of editors) {
    if (!ed.commands.size || !ed.spec.el.isConnected || !ed.spec.el.offsetParent) continue
    for (const [id, title] of ed.commands) {
      out.push({ id: `market.${ed.manifest.id}.cmd.${id}`, title: `${ed.manifest.name}：${title}`, run: () => post(ed, { type: 'command', id }) })
    }
  }
  return out
}

/* ---------------- 插件编辑器（iframe） ---------------- */

interface PluginEditor {
  manifest: PluginManifest
  path: string
  frame: HTMLIFrameElement
  spec: ViewSpec
  dirty: boolean
  ready: boolean
  /** 上次读到 / 写入的内容的指纹，用来忽略自己保存引起的文件变化 */
  stamp: string
  /** 文本文件原来的编码，保存时按它写回 */
  enc?: TextEncodingInfo
  pending: Map<number, (v: unknown) => void>
  seq: number
  /** 插件要求监视的文件：pathKey → 插件给的原路径，变化时发 assetChanged */
  watch?: Map<string, string>
  /** 插件注册的命令（命令面板）：id → 标题 */
  commands: Map<string, string>
  close: () => void
}

const editors = new Set<PluginEditor>()

function editorFor(path: string): PluginManifest | undefined {
  const lower = path.toLowerCase()
  return installed.find((m) => marketEnabled(m.id) && !tooNew(m) && m.editor?.extensions.some((ext) => lower.endsWith(ext)))
}

function themePayload(): Record<string, unknown> {
  const r = resolve(state.settings.space)
  return { light: r.light, bg: r.bg, panel: r.panel, line: r.line, sel: r.sel, text: r.text, muted: r.muted, accent: r.accent, font: r.fontCss }
}

function post(ed: PluginEditor, msg: Record<string, unknown>, transfer: Transferable[] = []): void {
  ed.frame.contentWindow?.postMessage({ studio: 1, ...msg }, `studio-plugin://${ed.manifest.id}`, transfer)
}

function fingerprint(c: string | Uint8Array): string {
  if (typeof c === 'string') return `s${c.length}:${c.slice(0, 64)}:${c.slice(-64)}`
  let hsh = 0
  for (let i = 0; i < c.length; i += Math.max(1, c.length >> 12)) hsh = (hsh * 31 + c[i]) | 0
  return `b${c.length}:${hsh}`
}

async function readContent(ed: PluginEditor): Promise<string | ArrayBuffer | null> {
  if (ed.manifest.editor?.binary) {
    const r = await window.api.fs.readBinary(ed.path)
    if (!r.ok) return null
    ed.stamp = fingerprint(r.data)
    return r.data.buffer.slice(r.data.byteOffset, r.data.byteOffset + r.data.byteLength) as ArrayBuffer
  }
  const r = await window.api.fs.readFile(ed.path)
  if (!r.ok) return null
  ed.stamp = fingerprint(r.content)
  ed.enc = { encoding: r.encoding, bom: r.bom }
  return r.content
}

async function sendLoad(ed: PluginEditor): Promise<void> {
  const content = await readContent(ed)
  if (content == null) return toast(t('无法读取 {0}', basename(ed.path)))
  post(ed, loadMessage(ed, content), typeof content === 'string' ? [] : [content])
}

/** load 消息：内容 + 接口版本和能调用的方法（SDK 据此实现 studio.api / studio.has） */
function loadMessage(ed: PluginEditor, content: string | ArrayBuffer): Record<string, unknown> {
  return {
    type: 'load',
    content,
    fileName: basename(ed.path),
    path: ed.path,
    relPath: toPluginPath(ed.path, ed.path),
    theme: themePayload(),
    // 插件页面只有中文 / 英文两套文本（studio.t(zh, en)）：其他界面语言给英文，实际语言放在 language 里
    locale: getLocale() === 'zh' ? 'zh' : 'en',
    language: getLocale(),
    api: PLUGIN_API,
    methods: METHODS,
    permissions: ed.manifest.permissions ?? []
  }
}

function request(ed: PluginEditor, type: string, timeout = 15000): Promise<unknown> {
  const id = ++ed.seq
  return new Promise((res, rej) => {
    const timer = setTimeout(() => {
      ed.pending.delete(id)
      rej(new Error(t('插件没有响应')))
    }, timeout)
    ed.pending.set(id, (v) => {
      clearTimeout(timer)
      res(v)
    })
    post(ed, { type, id })
  })
}

async function saveEditor(ed: PluginEditor): Promise<boolean> {
  if (!ed.ready) return false
  try {
    const content = await request(ed, 'getContent')
    if (typeof content === 'string') {
      await window.api.fs.writeFile(ed.path, content, ed.enc)
      ed.stamp = fingerprint(content)
    } else if (content instanceof ArrayBuffer || ArrayBuffer.isView(content)) {
      const bytes = content instanceof ArrayBuffer ? new Uint8Array(content) : new Uint8Array(content.buffer, content.byteOffset, content.byteLength)
      await window.api.fs.writeBinary(ed.path, bytes)
      ed.stamp = fingerprint(bytes)
    } else throw new Error(t('插件返回的内容无效'))
    ed.dirty = false
    post(ed, { type: 'saved' })
    emit('tabs')
    emit('saved')
    return true
  } catch (e) {
    toast(t('保存失败：') + String((e as Error)?.message ?? e))
    return false
  }
}

/** 插件页面里按下的快捷键（编辑器自己没处理的）转给 IDE */
function forwardKey(ed: PluginEditor, k: Record<string, unknown>): void {
  const init: KeyboardEventInit = {
    key: String(k.key ?? ''),
    code: String(k.code ?? ''),
    ctrlKey: !!k.ctrlKey,
    shiftKey: !!k.shiftKey,
    altKey: !!k.altKey,
    metaKey: !!k.metaKey,
    bubbles: true,
    cancelable: true
  }
  ed.frame.dispatchEvent(new KeyboardEvent('keydown', init))
}

async function onMessage(ed: PluginEditor, m: Record<string, unknown>): Promise<void> {
  switch (m.type) {
    case 'ready':
      ed.ready = true
      await sendLoad(ed)
      break
    case 'dirty':
      if (ed.dirty !== !!m.dirty) {
        ed.dirty = !!m.dirty
        emit('tabs')
      }
      break
    case 'response': {
      const fn = ed.pending.get(Number(m.id))
      ed.pending.delete(Number(m.id))
      fn?.(m.value)
      break
    }
    case 'save':
      await saveEditor(ed)
      break
    case 'export': {
      const data = m.data
      const payload = typeof data === 'string' ? data : data instanceof ArrayBuffer ? new Uint8Array(data) : ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : null
      const saved = payload == null ? null : await window.api.market.exportFile(String(m.name ?? 'export'), payload).catch(() => null)
      if (saved) toast(t('已导出到 {0}', saved))
      post(ed, { type: 'response', id: m.id, value: saved })
      break
    }
    case 'toast':
      toast(String(m.text ?? '').slice(0, 300))
      break
    case 'openExternal':
      if (typeof m.url === 'string' && /^https:\/\//.test(m.url)) window.open(m.url)
      break
    case 'key':
      forwardKey(ed, m)
      break
    case 'openText':
      // 用 IDE 的文本编辑器打开当前文件（插件视图保留）
      void openFile(ed.path, { raw: true })
      break
    case 'openLink': {
      const p = typeof m.href === 'string' ? resolveRelative(ed.path, m.href) : null
      if (p) void openFile(p)
      else toast(t('只能打开工作区里的文件'))
      break
    }
    case 'readAsset': {
      const p = typeof m.href === 'string' ? resolveRelative(ed.path, m.href) : null
      // 任何类型的文件都可以读（只限工作区内），MIME 按扩展名猜
      const mime = p ? (ASSET_MIME[(p.match(/\.[^.\\/]+$/)?.[0] ?? '').toLowerCase()] ?? 'application/octet-stream') : ''
      let value: { data: ArrayBuffer; mime: string } | null = null
      if (p) {
        const r = await window.api.fs.readBinary(p).catch(() => null)
        if (r?.ok && r.data.byteLength <= 100 * 1024 * 1024) value = { data: u8ToBuffer(r.data), mime }
      }
      post(ed, { type: 'response', id: m.id, value }, value ? [value.data] : [])
      break
    }
    case 'watch': {
      // 插件用到的相对文件（网页引用的 CSS / JS 等）：它们变了就通知插件
      setWatch(ed, Array.isArray(m.hrefs) ? m.hrefs.slice(0, 5000) : [], true)
      break
    }
    case 'call': {
      // 插件接口 v2：失败时返回 error，插件那边的 Promise 会 reject
      const method = String(m.method ?? '')
      try {
        const [value, transfer] = await call(ed, method, Array.isArray(m.args) ? m.args : [])
        post(ed, { type: 'response', id: m.id, value }, transfer)
      } catch (e) {
        post(ed, { type: 'response', id: m.id, error: String((e as Error)?.message ?? e) })
      }
      break
    }
    default:
      // 新版 SDK 用到了这个 IDE 不认识的请求：回一个错误，免得插件一直等
      if (m.id != null) post(ed, { type: 'response', id: m.id, error: `unsupported request: ${String(m.type)}` })
  }
}

/** 插件能读取的文件（Markdown 里的图片、网页引用的样式 / 脚本 / 字体 / 媒体） */
const ASSET_MIME: Record<string, string> = {
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.cjs': 'text/javascript',
  '.json': 'application/json',
  '.map': 'application/json',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.xml': 'application/xml',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.md': 'text/markdown',
  '.wasm': 'application/wasm',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.eot': 'application/vnd.ms-fontobject',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.flac': 'audio/flac',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.ogv': 'video/ogg',
  '.vtt': 'text/vtt',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.avif': 'image/avif'
}

/**
 * 插件页面给的相对链接（相对于当前文件）→ 绝对路径。
 * 只允许落在工作区里（没打开工作区时为当前文件所在目录），不接受绝对路径和 URL。
 */
function resolveRelative(file: string, href: string, url = true): string | null {
  let rel = href
  if (url) {
    rel = rel.replace(/[?#].*$/, '')
    try {
      rel = decodeURIComponent(rel)
    } catch {
      return null
    }
  }
  if (!rel || /^[a-z][a-z0-9+.-]*:/i.test(rel) || rel.includes('\0')) return null
  const sep = window.api.platform === 'win32' ? '\\' : '/'
  const base = pluginBase(file)
  // 以 / 开头：相对于工作区根目录（没打开工作区时为当前文件所在目录）
  const fromRoot = /^[\\/]/.test(rel)
  const parts = (fromRoot ? base : file).split(/[\\/]/).filter((s, i) => s || i === 0)
  if (!fromRoot) parts.pop()
  const head = parts.shift() ?? ''
  for (const seg of rel.split(/[\\/]+/)) {
    if (!seg || seg === '.') continue
    if (seg === '..') {
      if (!parts.length) return null
      parts.pop()
    } else parts.push(seg)
  }
  // 只剩盘符 / 根时补上分隔符（"C:" → "C:\"）
  const out = normPath(parts.length ? [head, ...parts].join(sep) : head + sep)
  return isUnder(out, base) ? out : null
}

/** 插件能访问的范围：工作区；没打开工作区（或文件不在工作区里）时为当前文件所在目录 */
function pluginBase(file: string): string {
  return state.root && isUnder(file, state.root) ? state.root : dirOf(file)
}

/** 所在目录；在磁盘根目录时保留分隔符（"C:" 在 Windows 上表示 C 盘的当前目录，不是根目录） */
function dirOf(p: string): string {
  const d = p.replace(/[\\/][^\\/]*$/, '')
  if (/^[a-zA-Z]:$/.test(d)) return d + '\\'
  return d || '/'
}

/** 绝对路径 → 插件看到的路径（以 / 开头，相对于插件能访问的范围） */
function toPluginPath(file: string, p: string): string {
  const base = pluginBase(file).replace(/[\\/]+$/, '')
  return '/' + p.slice(base.length).replace(/^[\\/]+/, '').replace(/\\/g, '/')
}

/* ---------------- 插件接口 v2：studio.call(method, ...args) ---------------- */

type Transfer = Transferable[]
class CallError extends Error {}

function u8ToBuffer(u: Uint8Array): ArrayBuffer {
  return u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer
}
function toBytes(data: unknown): Uint8Array | string {
  if (typeof data === 'string') return data
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
  throw new CallError('data must be a string or ArrayBuffer')
}
function hasPerm(ed: PluginEditor, p: PluginPermission): boolean {
  return !!ed.manifest.permissions?.includes(p)
}
function needPerm(ed: PluginEditor, p: PluginPermission): void {
  if (!hasPerm(ed, p)) throw new CallError(`permission "${p}" is not declared in manifest.json`)
}
function argPath(ed: PluginEditor, v: unknown): string {
  if (typeof v !== 'string') throw new CallError('path must be a string')
  const p = resolveRelative(ed.path, v, false)
  if (!p) throw new CallError(`path is outside the workspace: ${v}`)
  return p
}
/** 写入类操作：没有 workspace-write 权限时只能写当前文件 */
function writablePath(ed: PluginEditor, v: unknown): string {
  const p = argPath(ed, v)
  if (!samePath(p, ed.path)) needPerm(ed, 'workspace-write')
  return p
}

/** 每个插件本次会话是否已同意在终端运行命令 */
const terminalOk = new Set<string>()

/** v2 能调用的方法（load 消息里告诉插件，SDK 的 studio.has() 据此判断） */
const METHODS = [
  'info',
  'fs.read',
  'fs.write',
  'fs.stat',
  'fs.exists',
  'fs.list',
  'fs.files',
  'fs.mkdir',
  'fs.delete',
  'fs.move',
  'fs.watch',
  'dialog.open',
  'dialog.save',
  'clipboard.readText',
  'clipboard.writeText',
  'net.fetch',
  'editor.open',
  'editor.openText',
  'editor.setTitle',
  'editor.save',
  'editor.reload',
  'ui.toast',
  'ui.confirm',
  'ui.openExternal',
  'terminal.run',
  'commands.register',
  'commands.unregister'
]

async function call(ed: PluginEditor, method: string, a: unknown[]): Promise<[unknown, Transfer]> {
  const opt = (i: number): Record<string, unknown> => (a[i] && typeof a[i] === 'object' ? (a[i] as Record<string, unknown>) : {})
  switch (method) {
    case 'info':
      return [
        {
          api: PLUGIN_API,
          methods: METHODS,
          permissions: ed.manifest.permissions ?? [],
          platform: window.api.platform,
          locale: getLocale() === 'zh' ? 'zh' : 'en',
          language: getLocale(),
          file: { path: toPluginPath(ed.path, ed.path), name: basename(ed.path) },
          workspace: state.root && isUnder(ed.path, state.root) ? { name: basename(state.root) } : null
        },
        []
      ]

    /* ----- 文件（工作区内；路径相对于当前文件，以 / 开头时相对于工作区根目录） ----- */
    case 'fs.read': {
      const p = argPath(ed, a[0])
      const st = await window.api.market.stat(p)
      if (!st || st.type !== 'file') throw new CallError(`not found: ${String(a[0])}`)
      if (st.size > 100 * 1024 * 1024) throw new CallError('file too large (> 100 MB)')
      const r = await window.api.fs.readBinary(p)
      if (!r.ok) throw new CallError(`cannot read: ${String(a[0])}`)
      if (opt(1).encoding === 'utf8' || opt(1).encoding === 'utf-8') return [new TextDecoder().decode(r.data), []]
      const buf = u8ToBuffer(r.data)
      return [buf, [buf]]
    }
    case 'fs.write': {
      const p = writablePath(ed, a[0])
      const data = toBytes(a[1])
      await window.api.market.mkdirp(dirOf(p))
      if (typeof data === 'string') await window.api.fs.writeFile(p, data)
      else await window.api.fs.writeBinary(p, data)
      return [true, []]
    }
    case 'fs.stat':
      return [await window.api.market.stat(argPath(ed, a[0])), []]
    case 'fs.exists':
      return [!!(await window.api.market.stat(argPath(ed, a[0]))), []]
    case 'fs.list': {
      const p = argPath(ed, a[0] ?? '.')
      const items = await window.api.fs.readDir(p)
      return [items.map((x) => ({ name: x.name, type: x.isDir ? 'dir' : 'file', path: toPluginPath(ed.path, x.path) })), []]
    }
    case 'fs.files': {
      // 工作区里的所有文件（跳过 node_modules、.git 等），以 / 开头
      const all = await window.api.fs.listFiles(pluginBase(ed.path))
      const ext = typeof opt(0).extension === 'string' ? String(opt(0).extension).toLowerCase() : ''
      return [all.filter((p) => !ext || p.toLowerCase().endsWith(ext)).map((p) => toPluginPath(ed.path, p)), []]
    }
    case 'fs.mkdir':
      needPerm(ed, 'workspace-write')
      await window.api.market.mkdirp(argPath(ed, a[0]))
      return [true, []]
    case 'fs.delete': {
      const p = writablePath(ed, a[0])
      if (samePath(p, pluginBase(ed.path))) throw new CallError('cannot delete the workspace root')
      await window.api.fs.trash(p)
      return [true, []]
    }
    case 'fs.move': {
      needPerm(ed, 'workspace-write')
      await window.api.market.move(argPath(ed, a[0]), argPath(ed, a[1]))
      return [true, []]
    }
    case 'fs.watch': {
      const list = Array.isArray(a[0]) ? a[0].slice(0, 5000) : []
      setWatch(ed, list, false)
      return [true, []]
    }

    /* ----- 对话框 ----- */
    case 'dialog.open': {
      const o = opt(0)
      const paths = await window.api.market.openFiles({
        title: typeof o.title === 'string' ? o.title : undefined,
        extensions: Array.isArray(o.extensions) ? o.extensions.map(String) : undefined,
        multiple: !!o.multiple
      })
      const out: { name: string; data: string | ArrayBuffer }[] = []
      const transfer: Transfer = []
      for (const p of paths.slice(0, 50)) {
        const bytes = await window.api.market.readExternal(p)
        if (o.encoding === 'utf8' || o.encoding === 'utf-8') out.push({ name: basename(p), data: new TextDecoder().decode(bytes) })
        else {
          const buf = u8ToBuffer(bytes)
          transfer.push(buf)
          out.push({ name: basename(p), data: buf })
        }
      }
      return [out, transfer]
    }
    case 'dialog.save': {
      const saved = await window.api.market.exportFile(String(a[0] ?? 'export'), toBytes(a[1]))
      if (saved) toast(t('已导出到 {0}', saved))
      return [saved, []]
    }

    /* ----- 剪贴板 ----- */
    case 'clipboard.writeText':
      await window.api.market.clipboard(ed.manifest.id, 'write', String(a[0] ?? ''))
      return [true, []]
    case 'clipboard.readText':
      needPerm(ed, 'clipboard-read')
      return [await window.api.market.clipboard(ed.manifest.id, 'read'), []]

    /* ----- 网络（主进程发请求，不受跨域限制） ----- */
    case 'net.fetch': {
      needPerm(ed, 'network')
      const o = opt(1)
      const headers: Record<string, string> = {}
      if (o.headers && typeof o.headers === 'object') for (const [k, v] of Object.entries(o.headers)) headers[k] = String(v)
      const r = await window.api.market.fetch(ed.manifest.id, String(a[0] ?? ''), {
        method: typeof o.method === 'string' ? o.method : undefined,
        headers,
        body: o.body == null ? undefined : toBytes(o.body),
        timeout: typeof o.timeout === 'number' ? o.timeout : undefined
      })
      const body = u8ToBuffer(r.body)
      return [{ ...r, body }, [body]]
    }

    /* ----- 编辑器 ----- */
    case 'editor.open': {
      const p = argPath(ed, a[0])
      const o = opt(1)
      await openFile(p, { line: typeof o.line === 'number' ? o.line : undefined, col: typeof o.col === 'number' ? o.col : undefined, raw: !!o.text })
      return [true, []]
    }
    case 'editor.openText':
      void openFile(ed.path, { raw: true })
      return [true, []]
    case 'editor.setTitle':
      updateView(ed.spec.el, { title: String(a[0] ?? '').slice(0, 120) || basename(ed.path) })
      return [true, []]
    case 'editor.save':
      return [await saveEditor(ed), []]
    case 'editor.reload':
      await sendLoad(ed)
      return [true, []]

    /* ----- 界面 ----- */
    case 'ui.toast':
      toast(String(a[0] ?? '').slice(0, 300))
      return [true, []]
    case 'ui.confirm':
      return [window.confirm(`${ed.manifest.name}\n\n${String(a[0] ?? '').slice(0, 2000)}`), []]
    case 'ui.openExternal': {
      const url = String(a[0] ?? '')
      if (!/^https?:\/\//i.test(url) && !/^mailto:/i.test(url)) throw new CallError('only http(s) and mailto: links')
      window.open(url)
      return [true, []]
    }

    /* ----- 终端 ----- */
    case 'terminal.run': {
      needPerm(ed, 'terminal')
      const cmd = String(a[0] ?? '').trim()
      if (!cmd) throw new CallError('command is empty')
      const o = opt(1)
      if (!terminalOk.has(ed.manifest.id)) {
        if (!window.confirm(t('插件“{0}”要在终端里运行命令：\n\n{1}\n\n允许吗？（本次运行 IDE 期间不再询问）', ed.manifest.name, cmd.slice(0, 500)))) throw new CallError('denied by user')
        terminalOk.add(ed.manifest.id)
      }
      const cwd = typeof o.cwd === 'string' ? argPath(ed, o.cwd) : pluginBase(ed.path)
      await newTerminal(cwd, { title: typeof o.title === 'string' ? o.title.slice(0, 60) : ed.manifest.name, run: cmd })
      return [true, []]
    }

    /* ----- 命令面板（插件编辑器打开时出现） ----- */
    case 'commands.register': {
      const id = String(a[0] ?? '')
      const title = String(a[1] ?? '').slice(0, 120)
      if (!/^[\w.-]{1,64}$/.test(id) || !title) throw new CallError('invalid command id or title')
      ed.commands.set(id, title)
      return [true, []]
    }
    case 'commands.unregister':
      ed.commands.delete(String(a[0] ?? ''))
      return [true, []]
  }
  throw new CallError(`unsupported method: ${method}`)
}

/** 记住要监视的文件：变化时把插件给的原路径发回去 */
function setWatch(ed: PluginEditor, list: unknown[], url: boolean): void {
  ed.watch = new Map()
  for (const x of list) {
    if (typeof x !== 'string') continue
    const p = resolveRelative(ed.path, x, url)
    if (p) ed.watch.set(pathKey(p), x)
  }
}

function openPluginEditor(manifest: PluginManifest, path: string): void {
  for (const ed of editors) if (samePath(ed.path, path) && revealView(ed.spec.el)) return

  const frame = document.createElement('iframe')
  frame.className = 'plg-frame'
  frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-modals allow-downloads')
  frame.setAttribute('allow', 'clipboard-read; clipboard-write')
  frame.src = `studio-plugin://${manifest.id}/${manifest.editor!.entry.split('/').map(encodeURIComponent).join('/')}`
  const el = h('div', { class: 'doc-preview plg-editor' }, frame)

  const ed: PluginEditor = {
    manifest,
    path,
    frame,
    spec: null as unknown as ViewSpec,
    dirty: false,
    ready: false,
    stamp: '',
    pending: new Map(),
    seq: 0,
    commands: new Map(),
    close: () => undefined
  }
  const onMsg = (e: MessageEvent): void => {
    if (e.source !== frame.contentWindow || e.origin !== `studio-plugin://${manifest.id}`) return
    const m = e.data as Record<string, unknown> | null
    if (m && typeof m === 'object' && m.studio === 1) void onMessage(ed, m)
  }
  window.addEventListener('message', onMsg)

  ed.spec = {
    key: `market:${manifest.id}:${pathKey(path)}`,
    title: basename(path),
    icon: icons.plugin,
    kind: 'preview',
    el,
    path,
    dirty: () => ed.dirty,
    save: () => saveEditor(ed),
    onShow: () => {
      requestAnimationFrame(() => frame.focus())
      if (ed.ready) post(ed, { type: 'show' })
    },
    onClose: () => {
      window.removeEventListener('message', onMsg)
      editors.delete(ed)
    },
    // 文件改名 / 移动后，保存要写到新路径（否则会在旧位置重新建出一个文件）
    onRename: (p) => {
      ed.path = p
    }
  }
  ed.close = () => {
    ed.dirty = false
    closeView(el)
  }
  editors.add(ed)
  openView(ed.spec)
}

/** 启动时调用：读取已安装的插件，注册自定义编辑器 */
export async function initMarket(): Promise<void> {
  await loadInstalled()
  registerPreviewer((path) => {
    const m = editorFor(path)
    if (!m) return false
    openPluginEditor(m, path)
    return true
  })
  window.api.market.onProgress((id, got, total) => {
    if (!progress.has(id)) return
    progress.set(id, total ? Math.min(1, got / total) : 'busy')
    notify()
  })
  on('space', () => {
    const theme = themePayload()
    for (const ed of editors) post(ed, { type: 'theme', theme })
  })
  // 磁盘上的文件被别的程序改了：没修改过的重新加载，修改过的只提示
  window.api.fs.onChanged((paths) => {
    for (const ed of editors) {
      if (ed.ready && ed.watch?.size) {
        const hit = paths.map((p) => ed.watch!.get(pathKey(p))).filter((x): x is string => !!x)
        if (hit.length) post(ed, { type: 'assetChanged', paths: [...new Set(hit)] })
      }
      if (!ed.ready || !paths.some((p) => samePath(p, ed.path))) continue
      void (async () => {
        const before = ed.stamp
        const content = await readContent(ed)
        if (content == null || ed.stamp === before) return
        if (ed.dirty) return toast(t('“{0}” 在磁盘上被修改了，保存会覆盖它', basename(ed.path)))
        post(ed, loadMessage(ed, content), typeof content === 'string' ? [] : [content])
      })()
    }
  })
}
