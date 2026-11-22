/**
 * 插件市场（生产力工具）：从 GitHub 插件仓库安装的插件。
 * 插件的编辑器页面放在 iframe 里（studio-plugin://<id>/ 协议，和 IDE 不同源），只能通过 postMessage 和 IDE 通信。
 */
import type { PluginManifest, RemotePlugin } from '../../shared/plugins'
import type { Command } from './commands'
import { basename, h, toast } from './dom'
import { activeTab, closeView, isUnder, normPath, openFile, openView, pathKey, registerPreviewer, revealView, samePath, type ViewSpec } from './editor'
import { getLocale, t } from './i18n'
import { icons } from './icons'
import { emit, on, persist, state } from './store'
import { resolve } from './theme'

let remote: RemotePlugin[] = []
let installed: PluginManifest[] = []
let loading = false
let error: string | null = null
const progress = new Map<string, number | 'busy'>()
let notify: () => void = () => undefined

/** 插件列表、安装状态变化时调用（插件面板重绘） */
export function onMarketChange(fn: () => void): void {
  notify = fn
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

function info(e: Entry): { name: string; publisher: string; description: string; homepage?: string } {
  return (e.local ?? e.remote)!
}

/** 插件声明的额外权限（联网等），显示在卡片上 */
function permHint(e: Entry): HTMLElement | null {
  const perms = e.remote?.permissions ?? e.local?.permissions ?? []
  const names = perms.map((p) => (p === 'network' ? t('联网') : p === 'eval' ? t('动态执行代码') : '')).filter(Boolean)
  return names.length ? h('p', { class: 'plg-hint muted', title: t('插件页面可以加载网络资源，用于显示网页内容') }, t('需要权限：{0}', names.join(t('、')))) : null
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
  const update = e.local && e.remote && cmpVer(e.remote.version, e.local.version) > 0 ? e.remote : null

  const badge = p
    ? h('span', { class: 'plg-badge' }, p === 'busy' ? t('正在安装…') : `${Math.round(p * 100)}%`)
    : e.local
      ? h('span', { class: 'plg-badge ok' }, `v${e.local.version}`)
      : h('span', { class: 'plg-badge warn' }, t('未安装'))

  const actions: HTMLElement[] = []
  if (!p) {
    if (e.local && on && e.local.newFile) {
      const m = e.local
      actions.push(h('button', { class: 'btn small primary', onClick: () => void newPluginFile(m) }, t('新建{0}', m.newFile!.label)))
    }
    if (update) actions.push(h('button', { class: 'btn small primary', title: t('更新到 v{0}', update.version), onClick: () => void install(e.id, i.name) }, t('更新')))
    if (!e.local && e.remote) actions.push(h('button', { class: 'btn small primary', title: e.remote.size ? `${(e.remote.size / 1024 / 1024).toFixed(1)} MB` : undefined, onClick: () => void install(e.id, i.name) }, t('安装')))
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
    update ? h('p', { class: 'plg-hint muted' }, t('有新版本 v{0}', update.version)) : null,
    h('div', { class: 'plg-actions' }, ...actions)
  )
}

/** 生产力工具分类里的内容；q 为小写的搜索词 */
export function marketCards(q: string): { items: HTMLElement[]; count: number } {
  const list = entries().filter((e) => matches(e, q))
  const items = list.map(card)
  if (!q) {
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
  pending: Map<number, (v: unknown) => void>
  seq: number
  /** 插件要求监视的相对文件（pathKey），变化时发 assetChanged */
  watch?: Set<string>
  close: () => void
}

const editors = new Set<PluginEditor>()

function editorFor(path: string): PluginManifest | undefined {
  const lower = path.toLowerCase()
  return installed.find((m) => marketEnabled(m.id) && m.editor?.extensions.some((ext) => lower.endsWith(ext)))
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
  return r.content
}

async function sendLoad(ed: PluginEditor): Promise<void> {
  const content = await readContent(ed)
  if (content == null) return toast(t('无法读取 {0}', basename(ed.path)))
  post(ed, { type: 'load', content, fileName: basename(ed.path), path: ed.path, theme: themePayload(), locale: getLocale() }, typeof content === 'string' ? [] : [content])
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
      await window.api.fs.writeFile(ed.path, content)
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
      const mime = p ? ASSET_MIME[(p.match(/\.[^.\\/]+$/)?.[0] ?? '').toLowerCase()] : undefined
      let value: { data: ArrayBuffer; mime: string } | null = null
      if (p && mime) {
        const r = await window.api.fs.readBinary(p).catch(() => null)
        if (r?.ok && r.data.byteLength <= 20 * 1024 * 1024) value = { data: r.data.buffer.slice(r.data.byteOffset, r.data.byteOffset + r.data.byteLength) as ArrayBuffer, mime }
      }
      post(ed, { type: 'response', id: m.id, value }, value ? [value.data] : [])
      break
    }
    case 'watch': {
      // 插件用到的相对文件（网页引用的 CSS / JS 等）：它们变了就通知插件
      const list = Array.isArray(m.hrefs) ? m.hrefs.slice(0, 2000) : []
      ed.watch = new Set(list.map((x) => (typeof x === 'string' ? resolveRelative(ed.path, x) : null)).filter((x): x is string => !!x).map(pathKey))
      break
    }
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
function resolveRelative(file: string, href: string): string | null {
  let rel = href.replace(/[?#].*$/, '')
  try {
    rel = decodeURIComponent(rel)
  } catch {
    return null
  }
  if (!rel || /^[a-z][a-z0-9+.-]*:/i.test(rel) || /^[\\/]/.test(rel) || rel.includes('\0')) return null
  const sep = window.api.platform === 'win32' ? '\\' : '/'
  const parts = file.split(/[\\/]/)
  parts.pop()
  const head = parts.shift() ?? ''
  for (const seg of rel.split(/[\\/]+/)) {
    if (!seg || seg === '.') continue
    if (seg === '..') {
      if (!parts.length) return null
      parts.pop()
    } else parts.push(seg)
  }
  const out = normPath([head, ...parts].join(sep))
  const dir = file.replace(/[\\/][^\\/]*$/, '')
  const base = state.root && isUnder(file, state.root) ? state.root : dir
  return isUnder(out, base) ? out : null
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
    onShow: () => requestAnimationFrame(() => frame.focus()),
    onClose: () => {
      window.removeEventListener('message', onMsg)
      editors.delete(ed)
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
      if (ed.ready && ed.watch?.size && paths.some((p) => ed.watch!.has(pathKey(p)))) post(ed, { type: 'assetChanged' })
      if (!ed.ready || !paths.some((p) => samePath(p, ed.path))) continue
      void (async () => {
        const before = ed.stamp
        const content = await readContent(ed)
        if (content == null || ed.stamp === before) return
        if (ed.dirty) return toast(t('“{0}” 在磁盘上被修改了，保存会覆盖它', basename(ed.path)))
        post(ed, { type: 'load', content, fileName: basename(ed.path), path: ed.path, theme: themePayload(), locale: getLocale() }, typeof content === 'string' ? [] : [content])
      })()
    }
  })
}
