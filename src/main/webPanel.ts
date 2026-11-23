/**
 * 网页面板：把插件 manifest.webPanel 声明的网站（例如网页版 Claude / ChatGPT / DeepSeek）显示在 IDE 窗口里。
 *
 * 这些网站不允许被 iframe 嵌入（X-Frame-Options / frame-ancestors），所以用 WebContentsView：
 * 一个独立的网页，叠在 IDE 页面上方，对齐页面里的占位元素（位置由页面发来，被浮层挡住时页面会让它隐藏）。
 * - 每个网站一个持久的会话分区（persist:webpanel-<插件>-<网站>），登录状态分开保存，和 IDE 隔离
 * - 沙箱、没有 preload、没有 Node：网页拿不到 IDE 的任何接口
 * - 新标签页 / 新窗口：manifest 允许的网址（网站自己、第三方登录）留在面板里，其他链接交给系统浏览器。
 *   同一页面里的 https 跳转都留在面板里（登录、单点登录会经过事先无法列出的网站），页面会在工具条上显示外站的域名
 * - User-Agent 去掉 Electron 和应用名；Google 登录页（accounts.google.com）上再换成 Firefox 的，否则会被当成“不安全的浏览器”拒绝登录
 */
import {
  BrowserWindow,
  clipboard,
  ClipboardItem,
  dialog,
  ipcMain,
  Menu,
  session,
  shell,
  WebContentsView,
  type Input,
  type MenuItemConstructorOptions,
  type Session,
  type WebContents
} from 'electron'
import path from 'node:path'
import { hostMatches, PLUGIN_API, type PluginManifest, type WebSite } from '../shared/plugins'
import type { WebPanelKey, WebPanelRect, WebPanelState } from '../shared/types'
import { tm } from './i18n'
import { pluginsDir, readManifest } from './market'

const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/

interface Panel {
  id: number
  owner: WebContents
  win: BrowserWindow
  view: WebContentsView
  plugin: string
  site: WebSite
  /** 页面给的占位元素位置（CSS 像素）；null 表示不显示 */
  rect: WebPanelRect | null
  /** 第一次加载完之前不显示（免得深色主题下先闪一下白屏） */
  ready: boolean
  error: string | null
  crashed: boolean
  zoom: number
}

const panels = new Map<number, Panel>()
let seq = 0

const partitionOf = (plugin: string, site: string): string => `persist:webpanel-${plugin}-${site}`

/* ---------------- 会话（每个网站一个） ---------------- */

const configured = new Set<string>()
/** 麦克风 / 摄像头：本次运行 IDE 期间用户的选择（按会话分区） */
const mediaChoice = new Map<string, boolean>()

/** 只留下浏览器自己的标识（Mozilla / AppleWebKit / Chrome / Safari），去掉 Electron/x 和应用名/x */
export function cleanUserAgent(ua: string): string {
  return ua
    .split(' ')
    .filter((tok) => !/^[^()\s/]+\/\S+$/.test(tok) || /^(Mozilla|AppleWebKit|Chrome|Safari)\//.test(tok))
    .join(' ')
}

/* ---------------- Google 登录 ---------------- */

/**
 * Google 的登录页即使在去掉 Electron 标识后仍会认出内嵌的 Chromium，提示“此浏览器或应用可能不安全”。
 * 在 accounts.google.com 上换成 Firefox 的 User-Agent（同时去掉 Firefox 不会发的 Sec-CH-UA 请求头）就能正常登录，
 * 登录完跳回网站时再换回原来的。
 */
const GOOGLE_AUTH_HOSTS = ['accounts.google.com']

function isGoogleAuth(url: string): boolean {
  try {
    const u = new URL(url)
    return u.protocol === 'https:' && GOOGLE_AUTH_HOSTS.includes(u.hostname)
  } catch {
    return false
  }
}

/** 当前的 Firefox 版本（Firefox 128 于 2024-07-09 发布，之后每 4 周一个版本） */
function firefoxUserAgent(): string {
  const ver = 128 + Math.max(0, Math.floor((Date.now() - Date.UTC(2024, 6, 9)) / (28 * 86400_000)))
  const plat =
    process.platform === 'win32' ? 'Windows NT 10.0; Win64; x64' : process.platform === 'darwin' ? 'Macintosh; Intel Mac OS X 10.15' : 'X11; Linux x86_64'
  return `Mozilla/5.0 (${plat}; rv:${ver}.0) Gecko/20100101 Firefox/${ver}.0`
}

/** 网页（面板或登录弹窗）跳到 / 离开 Google 登录页时切换 User-Agent，并用新的 User-Agent 重新打开这个网址 */
function switchUaForGoogleAuth(wc: WebContents): void {
  const check = (url: string, isMainFrame: boolean, isSameDocument: boolean): void => {
    if (!isMainFrame || isSameDocument || !/^https:/i.test(url)) return
    const want = isGoogleAuth(url) ? firefoxUserAgent() : wc.session.getUserAgent()
    if (wc.getUserAgent() === want) return
    wc.setUserAgent(want)
    // navigator.userAgent 在这次跳转开始时就定下了：用新的 User-Agent 重新打开，请求头和页面里看到的才一致
    void wc.loadURL(url, { userAgent: want }).catch(() => undefined)
  }
  wc.on('did-start-navigation', (d) => {
    const nav = d as unknown as { url: string; isMainFrame: boolean; isSameDocument: boolean }
    check(nav.url, nav.isMainFrame, nav.isSameDocument)
  })
  wc.on('did-redirect-navigation', (d) => {
    const nav = d as unknown as { url: string; isMainFrame: boolean; isSameDocument: boolean }
    check(nav.url, nav.isMainFrame, nav.isSameDocument)
  })
}

function panelOf(wc: WebContents): Panel | undefined {
  for (const p of panels.values()) if (p.view.webContents === wc) return p
  return undefined
}

function setupSession(part: string): Session {
  const ses = session.fromPartition(part)
  if (configured.has(part)) return ses
  configured.add(part)
  ses.setUserAgent(cleanUserAgent(ses.getUserAgent()))
  // 用 Firefox 的 User-Agent 时（Google 登录页）去掉 Chromium 才有的 Sec-CH-UA 请求头
  ses.webRequest.onBeforeSendHeaders((details, cb) => {
    const h = details.requestHeaders
    const ua = Object.entries(h).find(([k]) => k.toLowerCase() === 'user-agent')?.[1] ?? ''
    if (!/ Firefox\//.test(String(ua))) return cb({ requestHeaders: h })
    const headers: Record<string, string | string[]> = {}
    for (const [k, v] of Object.entries(h)) if (!/^sec-ch-ua/i.test(k)) headers[k] = v
    cb({ requestHeaders: headers })
  })
  ses.setPermissionRequestHandler((wc, permission, cb, details) => {
    // 网页里的“复制”按钮
    if (permission === 'clipboard-sanitized-write') return cb(true)
    if (permission === 'media') {
      const prev = mediaChoice.get(part)
      if (prev !== undefined) return cb(prev)
      const win = panelOf(wc)?.win ?? BrowserWindow.fromWebContents(wc)
      let host = ''
      try {
        host = new URL(details.requestingUrl).hostname
      } catch {
        /* 用空的 */
      }
      const video = (details as { mediaTypes?: string[] }).mediaTypes?.includes('video')
      const opts: Electron.MessageBoxOptions = {
        type: 'question',
        buttons: [tm('允许'), tm('拒绝')],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
        message: video ? tm('{0} 想使用摄像头和麦克风', host) : tm('{0} 想使用麦克风', host),
        detail: tm('本次运行 IDE 期间不再询问')
      }
      void (win ? dialog.showMessageBox(win, opts) : dialog.showMessageBox(opts)).then((r) => {
        const ok = r.response === 0
        mediaChoice.set(part, ok)
        cb(ok)
      })
      return
    }
    // 通知、定位、全屏、读剪贴板等一律拒绝
    cb(false)
  })
  ses.setPermissionCheckHandler((_wc, permission) => permission === 'clipboard-sanitized-write' || (permission === 'media' && mediaChoice.get(part) === true))
  return ses
}

/** 清掉一个网站的登录状态（Cookie、本地存储、IndexedDB 等）和各种缓存 */
async function wipe(ses: Session): Promise<void> {
  await Promise.all([
    ses.clearStorageData(),
    ses.clearCache(),
    ses.clearAuthCache(),
    ses.clearCodeCaches({}),
    ses.clearSharedDictionaryCache()
  ]).catch(() => undefined)
}

/** 卸载插件时：清掉它所有网站的登录状态和缓存 */
export async function clearWebPanelData(m: PluginManifest): Promise<void> {
  for (const p of [...panels.values()]) if (p.plugin === m.id) destroy(p)
  for (const site of m.webPanel?.sites ?? []) await wipe(session.fromPartition(partitionOf(m.id, site.id)))
}

/* ---------------- 网址 ---------------- */

function allowed(site: WebSite, url: string): boolean {
  try {
    const u = new URL(url)
    return u.protocol === 'https:' && site.hosts.some((h) => hostMatches(u.hostname, h))
  } catch {
    return false
  }
}

function openOutside(url: string): void {
  if (/^(https?|mailto):/i.test(url)) void shell.openExternal(url).catch(() => undefined)
}

/* ---------------- 状态 ---------------- */

function stateOf(p: Panel): WebPanelState {
  const wc = p.view.webContents
  return {
    url: wc.getURL(),
    title: wc.getTitle(),
    loading: wc.isLoading(),
    canGoBack: wc.navigationHistory.canGoBack(),
    canGoForward: wc.navigationHistory.canGoForward(),
    error: p.error,
    crashed: p.crashed,
    zoom: p.zoom
  }
}

function sendState(p: Panel): void {
  if (!p.owner.isDestroyed() && !p.view.webContents.isDestroyed()) p.owner.send('webpanel:state', p.id, stateOf(p))
}

function applyLayout(p: Panel): void {
  if (p.view.webContents.isDestroyed()) return
  const r = p.rect
  const show = !!r && p.ready && !p.error && !p.crashed
  if (show && r) {
    // 页面给的是 CSS 像素，视图用窗口坐标（IDE 页面没有缩放时两者相同）
    const z = p.owner.isDestroyed() ? 1 : p.owner.getZoomFactor()
    p.view.setBounds({ x: Math.round(r.x * z), y: Math.round(r.y * z), width: Math.max(0, Math.round(r.width * z)), height: Math.max(0, Math.round(r.height * z)) })
  }
  p.view.setVisible(show)
}

function destroy(p: Panel): void {
  panels.delete(p.id)
  if (!p.win.isDestroyed()) p.win.contentView.removeChildView(p.view)
  if (!p.view.webContents.isDestroyed()) p.view.webContents.close()
}

function setZoom(p: Panel, level: number): void {
  p.zoom = Math.max(-3, Math.min(5, Math.round(level * 2) / 2))
  if (!p.view.webContents.isDestroyed()) p.view.webContents.setZoomLevel(p.zoom)
  sendState(p)
}

/* ---------------- 快捷键 ---------------- */

/** 网页里按下的 IDE 全局快捷键（命令面板、关闭标签、切换标签、终端、运行调试等）交给 IDE；编辑类快捷键留给网页 */
function forwardToIde(i: Input): boolean {
  const ctrl = i.control || i.meta
  const k = i.key.toLowerCase()
  if (/^f(5|6|9|10|11)$/.test(k)) return true
  if (ctrl && i.code === 'Backquote') return true
  if (!ctrl) return i.alt && k === 'k'
  if (i.alt) return k === 'arrowleft' || k === 'arrowright' || k === 'k'
  if (i.shift) return ['p', 'f', 'g', 'd', 'n', 'pageup', 'pagedown', 'tab'].includes(k)
  return ['k', 'p', 's', 'o', 'w', 'b', '.', ',', '\\', 'tab', 'escape'].includes(k)
}

function onInput(p: Panel, e: Electron.Event, i: Input): void {
  if (i.type !== 'keyDown') return
  const wc = p.view.webContents
  const ctrl = i.control || i.meta
  const k = i.key.toLowerCase()
  let handled = true
  if (ctrl && !i.alt && (k === '=' || k === '+')) setZoom(p, p.zoom + 0.5)
  else if (ctrl && !i.alt && k === '-') setZoom(p, p.zoom - 0.5)
  else if (ctrl && !i.alt && k === '0') setZoom(p, 0)
  else if (ctrl && !i.shift && k === 'r') reload(p)
  else if (i.alt && !ctrl && k === 'arrowleft') wc.navigationHistory.goBack()
  else if (i.alt && !ctrl && k === 'arrowright') wc.navigationHistory.goForward()
  else if (ctrl && i.shift && k === 'i') wc.openDevTools({ mode: 'detach' })
  else if (forwardToIde(i)) {
    if (!p.owner.isDestroyed()) {
      const key: WebPanelKey = { key: i.key, code: i.code, ctrlKey: i.control, shiftKey: i.shift, altKey: i.alt, metaKey: i.meta }
      p.owner.focus()
      p.owner.send('webpanel:key', p.id, key)
    }
  } else handled = false
  if (handled) e.preventDefault()
}

function reload(p: Panel): void {
  p.error = null
  p.crashed = false
  const wc = p.view.webContents
  if (wc.getURL()) wc.reload()
  else void wc.loadURL(p.site.url).catch(() => undefined)
  applyLayout(p)
  sendState(p)
}

/* ---------------- 右键菜单 ---------------- */

function contextMenu(p: Panel, params: Electron.ContextMenuParams): void {
  const wc = p.view.webContents
  const items: MenuItemConstructorOptions[] = []
  const sep: MenuItemConstructorOptions = { type: 'separator' }
  for (const s of params.dictionarySuggestions.slice(0, 5)) items.push({ label: s, click: () => wc.replaceMisspelling(s) })
  if (params.misspelledWord) items.push({ label: tm('添加到词典'), click: () => wc.session.addWordToSpellCheckerDictionary(params.misspelledWord) }, sep)
  if (params.linkURL && /^https?:/i.test(params.linkURL)) {
    const url = params.linkURL
    items.push({ label: tm('在浏览器中打开链接'), click: () => openOutside(url) }, { label: tm('复制链接地址'), click: () => void clipboard.writeText(url) }, sep)
  }
  if (params.mediaType === 'image' && params.hasImageContents) items.push({ label: tm('复制图片'), click: () => wc.copyImageAt(params.x, params.y) }, sep)
  const f = params.editFlags
  if (params.isEditable) {
    items.push(
      { label: tm('剪切'), enabled: f.canCut, click: () => wc.cut() },
      { label: tm('复制'), enabled: f.canCopy, click: () => wc.copy() },
      { label: tm('粘贴'), enabled: f.canPaste, click: () => wc.paste() },
      { label: tm('全选'), enabled: f.canSelectAll, click: () => wc.selectAll() },
      sep
    )
  } else if (params.selectionText.trim()) items.push({ label: tm('复制'), click: () => wc.copy() }, sep)
  items.push(
    { label: tm('后退'), enabled: wc.navigationHistory.canGoBack(), click: () => wc.navigationHistory.goBack() },
    { label: tm('前进'), enabled: wc.navigationHistory.canGoForward(), click: () => wc.navigationHistory.goForward() },
    { label: tm('重新加载'), click: () => reload(p) },
    sep,
    { label: tm('检查元素'), click: () => wc.inspectElement(params.x, params.y) }
  )
  // 去掉开头、结尾和连续的分隔线
  const clean = items.filter((it, i, arr) => it.type !== 'separator' || (i > 0 && i < arr.length - 1 && arr[i - 1].type !== 'separator'))
  Menu.buildFromTemplate(clean).popup({ window: p.win })
}

/* ---------------- 弹窗（第三方登录） ---------------- */

/**
 * 登录用的弹窗（例如“用 Google 登录”）：和面板同一个会话，登录完网站自己会关掉它。
 * 有的网站先开一个空白窗口再把外部链接塞进去，第一次跳转就不在允许的网址里时，关掉弹窗改用系统浏览器打开。
 */
function guardPopup(p: Panel, child: BrowserWindow): void {
  child.setMenu(null)
  const cw = child.webContents
  switchUaForGoogleAuth(cw)
  let first = true
  cw.on('did-start-navigation', (d) => {
    const nav = d as unknown as { url: string; isMainFrame: boolean; isSameDocument: boolean }
    if (!nav.isMainFrame || nav.isSameDocument) return
    const wasFirst = first
    first = false
    if (wasFirst && !allowed(p.site, nav.url) && nav.url !== 'about:blank') {
      openOutside(nav.url)
      child.close()
    }
  })
  cw.setWindowOpenHandler(({ url }) => {
    openOutside(url)
    return { action: 'deny' }
  })
}

/* ---------------- 把内容粘贴进网页的输入框 ---------------- */

/** 在隔离环境里执行（网页改不了它用到的函数）：找到输入框，聚焦，光标放到末尾。返回 'empty' / 'filled' / false */
const FOCUS_INPUT = `(function (sels) {
  var visible = function (el) {
    var r = el.getBoundingClientRect()
    return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden'
  }
  for (var i = 0; i < sels.length; i++) {
    var list
    try { list = Array.prototype.slice.call(document.querySelectorAll(sels[i])) } catch (e) { continue }
    var el = null
    for (var j = list.length - 1; j >= 0; j--) {
      var x = list[j]
      if (visible(x) && !x.disabled && !x.readOnly) { el = x; break }
    }
    if (!el) continue
    el.focus()
    var filled
    if (typeof el.value === 'string' && typeof el.setSelectionRange === 'function') {
      var n = el.value.length
      el.setSelectionRange(n, n)
      filled = el.value.trim().length > 0
    } else {
      var r = document.createRange()
      r.selectNodeContents(el)
      r.collapse(false)
      var s = window.getSelection()
      s.removeAllRanges()
      s.addRange(r)
      filled = (el.innerText || '').trim().length > 0
    }
    if (document.activeElement !== el && !el.contains(document.activeElement)) continue
    return filled ? 'filled' : 'empty'
  }
  return false
})`

const GENERIC_INPUTS = ['textarea:not([readonly]):not([disabled])', '[contenteditable="true"]']

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function waitLoaded(wc: WebContents, ms: number): Promise<void> {
  if (!wc.isLoading()) return Promise.resolve()
  return new Promise((res) => {
    const done = (): void => {
      clearTimeout(timer)
      wc.removeListener('did-stop-loading', done)
      res()
    }
    const timer = setTimeout(done, ms)
    wc.once('did-stop-loading', done)
  })
}

/** 剪贴板现在的内容（每种格式的数据都读出来，之后原样写回） */
async function saveClipboard(): Promise<ClipboardItem[]> {
  const out: ClipboardItem[] = []
  try {
    for (const item of await clipboard.read()) {
      const data: Record<string, Blob> = {}
      for (const type of item.types) {
        if (type === 'electron application/bookmark') continue
        const v = await item.getType(type).catch(() => null)
        if (v instanceof Blob) data[type] = v
      }
      if (Object.keys(data).length) out.push(new ClipboardItem(data))
    }
  } catch {
    /* 读不出来就不恢复 */
  }
  return out
}

async function restoreClipboard(saved: ClipboardItem[], ours: string): Promise<void> {
  try {
    // 这期间用户自己复制了别的东西就不动它
    if ((await clipboard.readText()) !== ours) return
    if (saved.length) await clipboard.write(saved)
    else clipboard.clear()
  } catch {
    /* 忽略 */
  }
}

async function insert(p: Panel, text: string): Promise<'ok' | 'noinput'> {
  const wc = p.view.webContents
  await waitLoaded(wc, 15000)
  wc.focus()
  const sels = [...(p.site.input ?? []), ...GENERIC_INPUTS]
  let found: unknown = false
  // 单页应用加载完后输入框可能还要过一会才出现
  for (let i = 0; i < 24 && !found && !wc.isDestroyed(); i++) {
    found = await wc.executeJavaScriptInIsolatedWorld(1001, [{ code: `${FOCUS_INPUT}(${JSON.stringify(sels)})` }]).catch(() => false)
    if (!found) await sleep(250)
  }
  if (!found || wc.isDestroyed()) {
    await clipboard.writeText(text)
    return 'noinput'
  }
  const body = found === 'filled' ? '\n' + text : text
  // 用粘贴而不是模拟输入：几个网站的编辑器对粘贴的多行代码处理得最好（不会把换行当成发送）。
  // 粘贴前把剪贴板里的所有格式都读出来，粘贴完放回去
  const saved = await saveClipboard()
  await clipboard.writeText(body)
  wc.paste()
  setTimeout(() => void restoreClipboard(saved, body), 800)
  return 'ok'
}

/* ---------------- 创建 ---------------- */

const watchedOwners = new WeakSet<WebContents>()

/** IDE 页面关闭或重新加载时，它的面板一起销毁（否则会留下盖在界面上的网页） */
function watchOwner(owner: WebContents): void {
  if (watchedOwners.has(owner)) return
  watchedOwners.add(owner)
  const drop = (): void => {
    for (const p of [...panels.values()]) if (p.owner === owner) destroy(p)
  }
  owner.once('destroyed', drop)
  owner.on('did-navigate', drop)
}

function wire(p: Panel): void {
  const wc = p.view.webContents
  switchUaForGoogleAuth(wc)
  const send = (): void => sendState(p)
  wc.on('did-start-loading', send)
  wc.on('did-stop-loading', () => {
    if (!p.ready) {
      p.ready = true
      applyLayout(p)
    }
    send()
  })
  wc.on('did-navigate', () => {
    p.error = null
    p.crashed = false
    // 缩放按网站记在 Chromium 里，跳转后按面板的设置重新套用
    wc.setZoomLevel(p.zoom)
    applyLayout(p)
    send()
  })
  wc.on('did-navigate-in-page', send)
  wc.on('page-title-updated', send)
  wc.on('did-fail-load', (_e, code, desc, _url, isMainFrame) => {
    // -3：被新的跳转取代（不是错误）
    if (!isMainFrame || code === -3) return
    p.error = desc || `ERR ${code}`
    p.ready = true
    applyLayout(p)
    send()
  })
  wc.on('render-process-gone', (_e, d) => {
    if (d.reason === 'clean-exit') return
    p.crashed = true
    applyLayout(p)
    send()
  })
  wc.on('zoom-changed', (_e, dir) => setZoom(p, p.zoom + (dir === 'in' ? 0.5 : -0.5)))
  wc.on('focus', () => {
    if (!p.owner.isDestroyed()) p.owner.send('webpanel:focus', p.id)
  })
  wc.on('before-input-event', (e, i) => onInput(p, e, i))
  wc.on('context-menu', (_e, params) => contextMenu(p, params))
  // 同一页面里的跳转：https 都留在面板里（例如单点登录跳到公司自己的登录页）；其他协议交给系统
  wc.on('will-navigate', (e) => {
    const url = (e as unknown as { url: string }).url
    if (/^https:/i.test(url)) return
    e.preventDefault()
    openOutside(url)
  })
  wc.setWindowOpenHandler(({ url, disposition }) => {
    // window.open 打开的小窗口（第三方登录）：允许，和面板同一个会话
    if (disposition === 'new-window' && (url === 'about:blank' || allowed(p.site, url))) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          parent: p.win,
          width: 520,
          height: 720,
          autoHideMenuBar: true,
          title: p.site.name,
          webPreferences: { session: wc.session, sandbox: true, contextIsolation: true, nodeIntegration: false }
        }
      }
    }
    // 新标签页打开的链接：网站自己的页面在面板里打开，其他的用系统浏览器
    if (allowed(p.site, url)) void wc.loadURL(url).catch(() => undefined)
    else openOutside(url)
    return { action: 'deny' }
  })
  wc.on('did-create-window', (child) => guardPopup(p, child))
}

function getPanel(e: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent, id: unknown): Panel | null {
  const p = panels.get(Number(id))
  return p && p.owner === e.sender && !p.view.webContents.isDestroyed() ? p : null
}

function validRect(r: unknown): WebPanelRect | null {
  const x = r as WebPanelRect | null
  if (!x || typeof x !== 'object') return null
  const nums = [x.x, x.y, x.width, x.height]
  if (!nums.every((n) => typeof n === 'number' && Number.isFinite(n))) return null
  if (x.width < 1 || x.height < 1) return null
  return { x: x.x, y: x.y, width: x.width, height: x.height }
}

export function registerWebPanelIpc(): void {
  ipcMain.handle('webpanel:create', async (e, opts: { plugin?: unknown; site?: unknown; url?: unknown; zoom?: unknown }) => {
    const owner = e.sender
    const win = BrowserWindow.fromWebContents(owner)
    if (!win) throw new Error('no window')
    const plugin = String(opts?.plugin ?? '')
    const siteId = String(opts?.site ?? '')
    if (!ID_RE.test(plugin)) throw new Error(tm('未知插件：{0}', plugin))
    // 网站列表以磁盘上的 manifest 为准，不信任页面传来的网址
    const m = await readManifest(path.join(pluginsDir(), plugin))
    if (!m || m.id !== plugin || (m.minApi ?? 1) > PLUGIN_API) throw new Error(tm('未知插件：{0}', plugin))
    const site = m.webPanel?.sites.find((s) => s.id === siteId)
    if (!site) throw new Error(tm('插件没有声明这个网站：{0}', siteId))
    const ses = setupSession(partitionOf(plugin, site.id))
    const view = new WebContentsView({
      webPreferences: { session: ses, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, spellcheck: true }
    })
    const zoom = Number(opts?.zoom)
    const p: Panel = {
      id: ++seq,
      owner,
      win,
      view,
      plugin,
      site,
      rect: null,
      ready: false,
      error: null,
      crashed: false,
      zoom: Number.isFinite(zoom) ? Math.max(-3, Math.min(5, zoom)) : 0
    }
    panels.set(p.id, p)
    watchOwner(owner)
    win.contentView.addChildView(view)
    view.setVisible(false)
    wire(p)
    const url = typeof opts?.url === 'string' && allowed(site, opts.url) ? opts.url : site.url
    void view.webContents.loadURL(url).catch(() => undefined)
    return p.id
  })

  ipcMain.on('webpanel:layout', (e, id, rect) => {
    const p = getPanel(e, id)
    if (!p) return
    p.rect = validRect(rect)
    applyLayout(p)
  })

  ipcMain.on('webpanel:focus', (e, id) => {
    const p = getPanel(e, id)
    if (p && p.view.getVisible()) p.view.webContents.focus()
  })

  ipcMain.on('webpanel:nav', (e, id, action) => {
    const p = getPanel(e, id)
    if (!p) return
    const wc = p.view.webContents
    if (action === 'back') wc.navigationHistory.goBack()
    else if (action === 'forward') wc.navigationHistory.goForward()
    else if (action === 'reload') reload(p)
    else if (action === 'stop') wc.stop()
    else if (action === 'home') {
      p.error = null
      p.crashed = false
      void wc.loadURL(p.site.url).catch(() => undefined)
      sendState(p)
    }
  })

  ipcMain.on('webpanel:zoom', (e, id, level) => {
    const p = getPanel(e, id)
    if (p && Number.isFinite(Number(level))) setZoom(p, Number(level))
  })

  ipcMain.handle('webpanel:capture', async (e, id) => {
    const p = getPanel(e, id)
    if (!p || !p.view.getVisible()) return null
    const img = await p.view.webContents.capturePage().catch(() => null)
    if (!img || img.isEmpty()) return null
    return 'data:image/jpeg;base64,' + img.toJPEG(88).toString('base64')
  })

  ipcMain.handle('webpanel:insert', (e, id, text) => {
    const p = getPanel(e, id)
    if (!p) throw new Error('no panel')
    return insert(p, String(text ?? '').slice(0, 2_000_000))
  })

  ipcMain.on('webpanel:external', (e, id) => {
    const p = getPanel(e, id)
    if (p) openOutside(p.view.webContents.getURL() || p.site.url)
  })

  ipcMain.on('webpanel:devtools', (e, id) => {
    getPanel(e, id)?.view.webContents.openDevTools({ mode: 'detach' })
  })

  ipcMain.handle('webpanel:clearData', async (e, id) => {
    const p = getPanel(e, id)
    if (!p) return
    await wipe(p.view.webContents.session)
    p.error = null
    p.crashed = false
    await p.view.webContents.loadURL(p.site.url).catch(() => undefined)
  })

  ipcMain.on('webpanel:destroy', (e, id) => {
    const p = getPanel(e, id)
    if (p) destroy(p)
  })
}
