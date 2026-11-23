/**
 * 网页面板：插件 manifest.webPanel 声明的网站（例如网页版 Claude / ChatGPT / DeepSeek）显示在编辑器右侧的分栏里。
 *
 * 网页本身由主进程的 WebContentsView 显示（独立的登录状态、沙箱、拿不到 IDE 的接口），叠在分栏里的占位元素上。
 * 这里负责：
 * - 编辑器右上角的按钮和网站选择弹窗
 * - 分栏里的工具条（切换网站、后退、前进、刷新、新对话、更多）
 * - 把占位元素的位置同步给主进程。原生视图永远盖在页面上面，所以菜单、命令面板、设置页、拖动中的标签等
 *   挡到它时，先截一张图换上，再把视图藏起来；浮层消失后换回来
 * - Alt K / 文件右键“发送到…”：把选中的代码或文件内容粘贴进网页的输入框
 */
import { hostMatches, type PluginManifest, type WebSite } from '../../shared/plugins'
import type { WebPanelKey, WebPanelState } from '../../shared/types'
import { setAssistantTargets, setExtraAgentIcons } from './chat'
import type { Command } from './commands'
import { basename, h, relative, toast } from './dom'
import { activate, activateViewGroup, closeView, fileSelection, findTab, getEditor, isUnder, openView, recentFile, revealView, type FileSelection } from './editor'
import { t } from './i18n'
import { icons } from './icons'
import { showMenu, type MenuItem } from './menu'
import { languageFor } from './monaco'
import { onMarketChange, setWebPanelOpener, webPanelPlugins } from './market'
import { on, state } from './store'

/** 隐藏超过这么久的面板先释放掉（每个网页要占几百 MB 内存），再显示时重新打开原来的网址 */
const SUSPEND_MS = 30 * 60 * 1000
/** 一次最多发送的字符数 */
const MAX_SEND = 400_000

const panels = new Set<WebPanel>()
const byId = new Map<number, WebPanel>()

/* ---------------- 本机记住的选择（每个用户自己的偏好，丢了也没关系） ---------------- */

function load(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}
function save(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* 存不了就算了 */
  }
}
const lastKey = (plugin: string): string => `webpanel.last.${plugin}`
const zoomKey = (plugin: string, site: string): string => `webpanel.zoom.${plugin}.${site}`

/* ---------------- 图标 ---------------- */

/** 网站图标：插件包里的图片（用 <img> 加载，图片里的脚本不会执行） */
function siteIcon(m: PluginManifest, s: WebSite, size: number): string {
  if (!s.icon) return icons.globe
  const src = `studio-plugin://${m.id}/${s.icon.split('/').map(encodeURIComponent).join('/')}`
  return `<img class="wp-site-img" src="${src}" width="${size}" height="${size}" alt="" draggable="false">`
}

/** 网址的主机名（不是 http(s) 时为空） */
function urlHost(url: string): string {
  try {
    const u = new URL(url)
    return /^https?:$/.test(u.protocol) ? u.hostname.toLowerCase() : ''
  } catch {
    return ''
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

/* ---------------- 面板 ---------------- */

class WebPanel {
  readonly key: string
  readonly el: HTMLElement
  private readonly host: HTMLElement
  private readonly shot: HTMLImageElement
  private readonly cover: HTMLElement
  private readonly progress: HTMLElement
  private readonly titleEl: HTMLElement
  private readonly backBtn: HTMLButtonElement
  private readonly fwdBtn: HTMLButtonElement
  private readonly reloadBtn: HTMLButtonElement
  private readonly moreBtn: HTMLButtonElement
  private readonly ro: ResizeObserver

  id: number | null = null
  st: WebPanelState
  private creating = false
  private createError: string | null = null
  /** 第一次加载完成过（之前显示“正在打开”） */
  private loaded = false
  /** 被浮层挡住，正显示截图 */
  private frozen = false
  private freezing = false
  /** 上次发给主进程的位置；'none' 表示已隐藏 */
  private sent = ''
  private hiddenSince = 0
  /** 释放后再打开时回到的网址 */
  private resumeUrl = ''
  private disposed = false
  used = Date.now()

  constructor(
    readonly plugin: PluginManifest,
    readonly site: WebSite
  ) {
    this.key = `webpanel:${plugin.id}:${site.id}`
    this.st = { url: site.url, title: '', loading: true, canGoBack: false, canGoForward: false, error: null, crashed: false, zoom: Number(load(zoomKey(plugin.id, site.id))) || 0 }

    const btn = (icon: string, label: string, onClick: () => void): HTMLButtonElement =>
      h('button', { class: 'icon-btn small', title: label, 'aria-label': label, html: icon, onClick })
    const siteBtn: HTMLButtonElement = h(
      'button',
      {
        class: 'wp-site',
        title: t('切换网站'),
        'aria-haspopup': 'menu',
        onClick: () => openPicker(plugin, siteBtn, 'below')
      },
      h('span', { class: 'wp-site-ic', html: siteIcon(plugin, site, 16) }),
      h('span', { class: 'wp-site-name' }, site.name),
      h('span', { class: 'wp-site-chev', html: icons.chevronDown })
    )
    this.titleEl = h('span', { class: 'wp-title muted' })
    this.backBtn = btn(icons.arrowLeft, t('后退 (Alt ←)'), () => this.nav('back'))
    this.fwdBtn = btn(icons.arrowRight, t('前进 (Alt →)'), () => this.nav('forward'))
    this.reloadBtn = btn(icons.refresh, t('重新加载 (Ctrl R)'), () => this.nav(this.st.loading ? 'stop' : 'reload'))
    this.moreBtn = btn(icons.more, t('更多'), () => this.moreMenu())
    this.progress = h('div', { class: 'wp-progress' })
    this.shot = h('img', { class: 'wp-shot', alt: '', draggable: 'false', hidden: true })
    this.cover = h('div', { class: 'wp-cover' })
    this.host = h('div', { class: 'wp-body' }, this.shot, this.cover)

    this.el = h(
      'div',
      { class: 'webpanel', 'data-plugin': plugin.id, 'data-site': site.id },
      h(
        'div',
        { class: 'wp-head' },
        siteBtn,
        this.titleEl,
        this.backBtn,
        this.fwdBtn,
        this.reloadBtn,
        btn(icons.newChat, t('新对话'), () => this.nav('home')),
        this.moreBtn,
        this.progress
      ),
      this.host
    )
    this.ro = new ResizeObserver(() => burst(120))
    this.ro.observe(this.host)
    panels.add(this)
    this.render()
  }

  /* ----- 主进程里的视图 ----- */

  private ensure(): void {
    if (this.id != null || this.creating || this.createError || this.disposed) return
    this.creating = true
    this.render()
    window.api.webPanel
      .create({ plugin: this.plugin.id, site: this.site.id, url: this.resumeUrl || undefined, zoom: this.st.zoom })
      .then((id) => {
        this.creating = false
        if (this.disposed) return window.api.webPanel.destroy(id)
        this.id = id
        byId.set(id, this)
        this.sent = ''
        burst(200)
      })
      .catch((e: unknown) => {
        this.creating = false
        this.createError = String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
        this.render()
      })
  }

  /** 释放主进程里的视图（关闭标签，或隐藏太久） */
  private release(): void {
    if (this.id == null) return
    byId.delete(this.id)
    window.api.webPanel.destroy(this.id)
    this.id = null
    this.sent = ''
    this.frozen = false
    this.shot.hidden = true
  }

  dispose(): void {
    this.disposed = true
    this.release()
    this.ro.disconnect()
    panels.delete(this)
    renderIconState()
  }

  /* ----- 位置同步 ----- */

  /** 占位元素在屏幕上的位置；不在显示时为 null */
  rect(): DOMRect | null {
    if (!this.host.isConnected || !this.host.offsetParent) return null
    const r = this.host.getBoundingClientRect()
    return r.width >= 2 && r.height >= 2 ? r : null
  }

  sync(overlays: DOMRect[]): void {
    if (this.disposed) return
    const r = this.rect()
    if (!r) return this.hide()
    this.hiddenSince = 0
    if (this.id == null) return this.ensure()
    if (occluded(this.host, r, overlays)) void this.freeze()
    else this.thaw(r)
  }

  private hide(): void {
    if (!this.hiddenSince) this.hiddenSince = Date.now()
    this.send(null)
    this.frozen = false
    if (this.id != null && Date.now() - this.hiddenSince > SUSPEND_MS) {
      this.resumeUrl = this.st.url
      this.loaded = false
      this.release()
      this.render()
    }
  }

  private send(r: DOMRect | null): void {
    if (this.id == null) return
    const key = r ? `${Math.round(r.left)},${Math.round(r.top)},${Math.round(r.width)},${Math.round(r.height)}` : 'none'
    if (key === this.sent) return
    this.sent = key
    window.api.webPanel.layout(this.id, r ? { x: r.left, y: r.top, width: r.width, height: r.height } : null)
  }

  /** 被挡住：先截图换上，再隐藏视图 */
  private async freeze(): Promise<void> {
    if (this.frozen || this.freezing || this.id == null) return
    if (this.sent === 'none' || !this.sent) {
      this.frozen = true
      return
    }
    this.freezing = true
    const id = this.id
    const url = await window.api.webPanel.capture(id).catch(() => null)
    this.freezing = false
    if (this.id !== id || this.disposed) return
    if (url) {
      this.shot.src = url
      this.shot.hidden = false
    }
    this.frozen = true
    this.send(null)
    // 截图期间浮层可能已经关了
    burst(60)
  }

  private thaw(r: DOMRect): void {
    if (this.freezing) return
    this.send(r)
    if (this.frozen) {
      this.frozen = false
      // 视图显示出来以后再拿掉截图，免得中间闪一下
      setTimeout(() => {
        if (!this.frozen) this.shot.hidden = true
      }, 80)
    }
  }

  visible(): boolean {
    return !this.disposed && this.rect() !== null
  }

  /* ----- 状态 ----- */

  onState(st: WebPanelState): void {
    if (st.zoom !== this.st.zoom) save(zoomKey(this.plugin.id, this.site.id), String(st.zoom))
    this.st = st
    if (!st.loading) this.loaded = true
    this.render()
  }

  private render(): void {
    const st = this.st
    this.backBtn.disabled = !st.canGoBack
    this.fwdBtn.disabled = !st.canGoForward
    this.reloadBtn.innerHTML = st.loading && this.loaded ? icons.close : icons.refresh
    const reloadLabel = st.loading && this.loaded ? t('停止加载') : t('重新加载 (Ctrl R)')
    this.reloadBtn.title = reloadLabel
    this.reloadBtn.setAttribute('aria-label', reloadLabel)
    this.progress.classList.toggle('on', st.loading && this.id != null)
    // 跳到了网站以外的页面（第三方登录、单点登录）：标题处显示那个网站的域名，让人知道密码输在哪里
    const host = urlHost(st.url)
    const foreign = !!host && !hostMatches(host, '*.' + urlHost(this.site.url))
    const title = foreign ? host : st.title && st.title !== this.site.name ? st.title : ''
    this.titleEl.textContent = title
    this.titleEl.classList.toggle('wp-foreign', foreign)
    this.titleEl.title = st.url ? `${st.title ? st.title + '\n' : ''}${st.url}` : ''

    // 视图不显示时（还没打开、加载失败、崩溃、已释放）下面的说明露出来
    const retry = (): void => {
      this.createError = null
      if (this.id == null) this.ensure()
      else this.nav('reload')
    }
    let body: (Node | string)[]
    if (this.createError) {
      body = [h('div', { class: 'wp-cover-title' }, t('无法打开 {0}', this.site.name)), h('div', { class: 'wp-cover-text' }, this.createError), h('button', { class: 'btn small primary', onClick: retry }, t('重试'))]
    } else if (st.crashed) {
      body = [h('div', { class: 'wp-cover-title' }, t('页面崩溃了')), h('button', { class: 'btn small primary', onClick: retry }, t('重新加载'))]
    } else if (st.error) {
      body = [
        h('div', { class: 'wp-cover-title' }, t('无法打开 {0}', this.site.name)),
        h('div', { class: 'wp-cover-text' }, st.error),
        h(
          'div',
          { class: 'wp-cover-actions' },
          h('button', { class: 'btn small primary', onClick: retry }, t('重试')),
          h('button', { class: 'btn small', onClick: () => this.id != null && window.api.webPanel.external(this.id) }, t('在浏览器中打开'))
        )
      ]
    } else {
      body = [
        h('span', { class: 'wp-cover-ic', html: siteIcon(this.plugin, this.site, 32) }),
        h('div', { class: 'wp-spinner' }),
        h('div', { class: 'wp-cover-text' }, t('正在打开 {0}…', this.site.name))
      ]
    }
    this.cover.replaceChildren(...body)
    // 网页显示出来以后它在下面看不见，藏起来免得加载动画一直在转
    this.cover.hidden = this.id != null && this.loaded && !st.error && !st.crashed && !this.createError
  }

  /* ----- 操作 ----- */

  nav(action: 'back' | 'forward' | 'reload' | 'stop' | 'home'): void {
    if (this.id == null) return this.ensure()
    window.api.webPanel.nav(this.id, action)
  }

  private zoom(level: number): void {
    if (this.id != null) window.api.webPanel.zoom(this.id, level)
  }

  private moreMenu(): void {
    const r = this.moreBtn.getBoundingClientRect()
    const pct = Math.round(Math.pow(1.2, this.st.zoom) * 100)
    const live = this.id != null
    const items: MenuItem[] = [
      { label: t('放大'), key: 'Ctrl =', disabled: !live, run: () => this.zoom(this.st.zoom + 0.5) },
      { label: t('缩小'), key: 'Ctrl -', disabled: !live, run: () => this.zoom(this.st.zoom - 0.5) },
      { label: t('实际大小（现在 {0}%）', pct), key: 'Ctrl 0', disabled: !live || this.st.zoom === 0, run: () => this.zoom(0) },
      'sep',
      { label: t('在浏览器中打开'), icon: icons.external, disabled: !live, run: () => this.id != null && window.api.webPanel.external(this.id) },
      {
        label: t('复制网址'),
        disabled: !this.st.url,
        run: () => {
          void navigator.clipboard.writeText(this.st.url).then(() => toast(t('已复制网址')))
        }
      },
      'sep',
      { label: t('开发者工具'), key: 'Ctrl Shift I', disabled: !live, run: () => this.id != null && window.api.webPanel.devtools(this.id) },
      { label: t('退出登录并清除 {0} 的数据…', this.site.name), danger: true, disabled: !live, run: () => void this.clearData() }
    ]
    showMenu(Math.max(8, r.right - 240), r.bottom + 4, items, { owner: this.moreBtn })
  }

  private async clearData(): Promise<void> {
    if (this.id == null) return
    if (!confirm(t('清除 {0} 在本机保存的登录状态、缓存和网站数据？\n\n清除后需要重新登录。', this.site.name))) return
    this.loaded = false
    this.render()
    await window.api.webPanel.clearData(this.id).catch(() => undefined)
    toast(t('已清除 {0} 的数据', this.site.name))
  }

  /** 把焦点移到网页上 */
  focus(): boolean {
    if (!revealView(this.el)) return false
    this.used = Date.now()
    if (this.id != null) {
      const id = this.id
      // 等标签切换完、视图显示出来再给焦点
      setTimeout(() => window.api.webPanel.focus(id), 60)
    }
    return true
  }

  /** 把文本粘贴进网页的输入框 */
  async insert(text: string): Promise<void> {
    if (!revealView(this.el)) return
    this.used = Date.now()
    syncAll()
    for (let i = 0; i < 100 && this.id == null; i++) {
      if (this.createError) return toast(t('无法打开 {0}', this.site.name))
      await new Promise((r) => setTimeout(r, 100))
    }
    if (this.id == null) return
    const r = await window.api.webPanel.insert(this.id, text).catch(() => 'noinput' as const)
    if (r === 'noinput') toast(t('没找到 {0} 的输入框，内容已复制到剪贴板，可以直接粘贴', this.site.name))
  }

  onShow(): void {
    this.used = Date.now()
    burst(400)
  }
}

/* ---------------- 遮挡检测 ---------------- */

/** 页面上浮在最上层的元素（菜单、弹窗、命令面板、拖动中的标签等）：都直接挂在 body 下 */
function overlayRects(): DOMRect[] {
  const app = document.getElementById('app')
  const out: DOMRect[] = []
  for (const el of Array.from(document.body.children) as HTMLElement[]) {
    if (el === app || el.id === 'toast' || el.tagName === 'SCRIPT' || el.tagName === 'STYLE' || el.hidden) continue
    const r = el.getBoundingClientRect()
    if (r.width < 1 || r.height < 1) continue
    const cs = getComputedStyle(el)
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') continue
    out.push(r)
  }
  const toastEl = document.getElementById('toast')
  if (toastEl?.classList.contains('show')) out.push(toastEl.getBoundingClientRect())
  return out
}

const intersects = (a: DOMRect, b: DOMRect): boolean => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom

/**
 * 占位元素有没有被挡住：浮层的矩形和它相交，或者在它上面取几个点、最上层的元素不是它自己
 * （设置页、拖放落点这类盖在编辑区上的元素）
 */
function occluded(host: HTMLElement, r: DOMRect, overlays: DOMRect[]): boolean {
  if (overlays.some((o) => intersects(o, r))) return true
  for (const fx of [0.08, 0.5, 0.92]) {
    for (const fy of [0.06, 0.5, 0.94]) {
      const el = document.elementFromPoint(r.left + r.width * fx, r.top + r.height * fy)
      if (el && !host.contains(el)) return true
    }
  }
  return false
}

/** 网页面板在右边时，提示条移到左边剩下区域的正中，不和网页重叠 */
function placeToast(minLeft: number): void {
  const el = document.getElementById('toast')
  if (!el) return
  const w = el.offsetWidth
  const left = Number.isFinite(minLeft) && minLeft >= w + 48 ? `${Math.round(minLeft / 2)}px` : ''
  if (el.style.left !== left) el.style.left = left
}

function syncAll(): void {
  let minLeft = Infinity
  for (const p of panels) {
    const r = p.rect()
    if (r) minLeft = Math.min(minLeft, r.left)
  }
  placeToast(minLeft)
  const overlays = overlayRects()
  for (const p of panels) p.sync(overlays)
  renderIconState()
}

/** 接下来一段时间每帧都同步一次（标签切换、浮层出现时的动画期间位置在变） */
let burstUntil = 0
let bursting = false
function burst(ms: number): void {
  if (!panels.size) return
  burstUntil = Math.max(burstUntil, performance.now() + ms)
  if (bursting) return
  bursting = true
  const loop = (): void => {
    syncAll()
    if (performance.now() < burstUntil && panels.size) requestAnimationFrame(loop)
    else bursting = false
  }
  requestAnimationFrame(loop)
}

/** 浮层出现 / 消失：body 下的元素增减，以及这些元素的样式变化（例如提示条显示） */
function watchOverlays(): void {
  const attrs = new MutationObserver(() => burst(250))
  const observe = (el: Element): void => {
    if (el.id !== 'app') attrs.observe(el, { attributes: true, attributeFilter: ['class', 'style', 'hidden'] })
  }
  Array.from(document.body.children).forEach(observe)
  new MutationObserver((records) => {
    for (const r of records) r.addedNodes.forEach((n) => n instanceof Element && observe(n))
    burst(300)
  }).observe(document.body, { childList: true })
}

/* ---------------- 打开 ---------------- */

function panelFor(m: PluginManifest, s: WebSite): WebPanel | undefined {
  for (const p of panels) if (p.plugin.id === m.id && p.site.id === s.id) return p
  return undefined
}

function openSite(m: PluginManifest, s: WebSite): void {
  save(lastKey(m.id), s.id)
  const existing = panelFor(m, s)
  if (existing) {
    existing.focus()
    return
  }
  const p = new WebPanel(m, s)
  openView(
    {
      key: p.key,
      title: s.name,
      icon: siteIcon(m, s, 14),
      kind: 'webpanel',
      el: p.el,
      onShow: () => p.onShow(),
      onClose: () => p.dispose()
    },
    { side: true }
  )
  p.focus()
}

/* ---------------- 选择网站的弹窗 ---------------- */

let pop: { el: HTMLElement; close: () => void } | null = null

function openPicker(m: PluginManifest, anchor: HTMLElement, place: 'auto' | 'below' = 'auto'): void {
  const sites = m.webPanel?.sites ?? []
  if (!sites.length) return
  if (pop) {
    const same = pop.el.dataset.anchor === anchorId(anchor)
    pop.close()
    if (same) return
  }
  const last = load(lastKey(m.id))
  const buttons: HTMLButtonElement[] = []
  const el = h(
    'div',
    { class: 'wp-pop', role: 'menu', 'aria-label': m.webPanel?.title ?? m.name },
    h('div', { class: 'wp-pop-head' }, m.webPanel?.title ?? m.name),
    ...sites.map((s, i) => {
      const open = !!panelFor(m, s)
      const b = h(
        'button',
        {
          class: 'wp-pop-item' + (s.id === last ? ' on' : ''),
          role: 'menuitem',
          onClick: () => {
            close()
            openSite(m, s)
          }
        },
        h('span', { class: 'wp-pop-ic', html: siteIcon(m, s, 20) }),
        h('span', { class: 'wp-pop-text' }, h('span', { class: 'wp-pop-name' }, s.name), h('span', { class: 'wp-pop-host' }, s.description || hostOf(s.url))),
        open ? h('span', { class: 'wp-pop-badge' }, t('已打开')) : i < 9 ? h('kbd', { class: 'wp-pop-kbd' }, String(i + 1)) : null
      )
      buttons.push(b)
      return b
    }),
    h('div', { class: 'wp-pop-foot' }, t('登录状态保存在本机，每个网站分开保存'))
  )
  el.dataset.anchor = anchorId(anchor)
  document.body.append(el)
  const r = anchor.getBoundingClientRect()
  const pr = el.getBoundingClientRect()
  // 右上角的按钮：弹窗右边和按钮对齐，往下展开
  const left = place === 'below' ? r.left : r.right - pr.width
  el.style.left = Math.max(8, Math.min(left, window.innerWidth - pr.width - 8)) + 'px'
  el.style.top = Math.min(r.bottom + 6, window.innerHeight - pr.height - 8) + 'px'
  ;(buttons.find((b) => b.classList.contains('on')) ?? buttons[0])?.focus()
  anchor.setAttribute('aria-expanded', 'true')

  const away = (e: Event): void => {
    if (e.type === 'blur' || !el.contains(e.target as Node)) {
      // 再点一下按钮是关闭（mousedown 先关掉，click 不再打开）
      if (e.type === 'mousedown' && anchor.contains(e.target as Node)) {
        suppress = anchor
        setTimeout(() => suppress === anchor && (suppress = null), 400)
      }
      close()
    }
  }
  function close(): void {
    el.remove()
    anchor.removeAttribute('aria-expanded')
    window.removeEventListener('mousedown', away, true)
    window.removeEventListener('blur', away)
    if (pop?.el === el) pop = null
  }
  el.addEventListener('keydown', (e) => {
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement)
    if (e.key === 'ArrowDown') buttons[(i + 1) % buttons.length]?.focus()
    else if (e.key === 'ArrowUp') buttons[(i - 1 + buttons.length) % buttons.length]?.focus()
    else if (/^[1-9]$/.test(e.key) && buttons[Number(e.key) - 1]) buttons[Number(e.key) - 1].click()
    else if (e.key === 'Escape') {
      close()
      anchor.focus()
    } else return
    e.preventDefault()
    e.stopPropagation()
  })
  setTimeout(() => {
    window.addEventListener('mousedown', away, true)
    window.addEventListener('blur', away)
  })
  pop = { el, close }
}

let suppress: HTMLElement | null = null
let anchorSeq = 0
const anchorIds = new WeakMap<HTMLElement, string>()
function anchorId(el: HTMLElement): string {
  let id = anchorIds.get(el)
  if (!id) anchorIds.set(el, (id = String(++anchorSeq)))
  return id
}

/* ---------------- 右上角按钮 ---------------- */

function toolbarIcons(): HTMLElement[] {
  return webPanelPlugins().map((m) => {
    const title = m.webPanel?.title ?? m.name
    const b: HTMLButtonElement = h('button', {
      class: 'agent-icon wp-icon',
      'data-plugin': m.id,
      title,
      'aria-label': title,
      'aria-haspopup': 'menu',
      html: icons.globe,
      onClick: () => {
        if (suppress === b) {
          suppress = null
          return
        }
        openPicker(m, b)
      }
    })
    return b
  })
}

/** 按钮高亮：这个插件有面板正在显示 */
function renderIconState(): void {
  document.querySelectorAll<HTMLElement>('.wp-icon[data-plugin]').forEach((b) => {
    const on = [...panels].some((p) => p.plugin.id === b.dataset.plugin && p.visible())
    if (b.classList.contains('on') !== on) b.classList.toggle('on', on)
  })
}

/* ---------------- 发送代码 ---------------- */

function displayPath(p: string): string {
  return state.root && isUnder(p, state.root) ? relative(state.root, p) : basename(p)
}

/** 代码块：内容里有 ``` 时用更长的围栏 */
function fence(code: string, path: string): string {
  const lang = findTab(path)?.model.getLanguageId() ?? languageFor(path)
  const longest = Math.max(2, ...[...code.matchAll(/`{3,}/g)].map((m) => m[0].length))
  const f = '`'.repeat(longest + 1)
  return `${f}${lang && lang !== 'plaintext' ? lang : ''}\n${code.replace(/\n$/, '')}\n${f}\n`
}

async function mentionText(sel: FileSelection | null, file: string | null): Promise<string | null> {
  if (sel) {
    const name = displayPath(sel.path)
    const head = sel.startLine === sel.endLine ? t('`{0}` 第 {1} 行：', name, sel.startLine) : t('`{0}` 第 {1}-{2} 行：', name, sel.startLine, sel.endLine)
    return `${head}\n${fence(sel.text, sel.path)}`
  }
  if (!file) return null
  let content = findTab(file)?.model.getValue()
  if (content == null) {
    const r = await window.api.fs.readFile(file).catch(() => null)
    if (!r?.ok) {
      toast(t('无法读取 {0}', basename(file)))
      return null
    }
    content = r.content
  }
  return `${t('`{0}`：', displayPath(file))}\n${fence(content, file)}`
}

async function sendTo(p: WebPanel, sel: FileSelection | null, file: string | null): Promise<void> {
  const text = await mentionText(sel, file)
  if (text == null) return
  if (text.length > MAX_SEND) return toast(t('内容太大（超过 {0} 个字符），没有发送。可以只选中需要的部分', MAX_SEND.toLocaleString()))
  await p.insert(text)
}

/** 最近用过的网页面板 */
function recentPanel(): WebPanel | null {
  let best: WebPanel | null = null
  for (const p of panels) if (!best || p.used > best.used) best = p
  return best
}

/* ---------------- 对外：命令、文件右键菜单 ---------------- */

export function webPanelCommands(): Command[] {
  const out: Command[] = []
  for (const m of webPanelPlugins()) {
    const title = m.webPanel?.title ?? m.name
    for (const s of m.webPanel?.sites ?? []) out.push({ id: `webpanel.${m.id}.${s.id}`, title: t('{0}：打开 {1}', title, s.name), run: () => openSite(m, s) })
  }
  const p = recentPanel()
  const f = recentFile()
  if (p && f) out.push({ id: 'webpanel.send', title: t('发送当前文件 / 选中内容到 {0}', p.site.name), key: 'Alt K', run: () => sendFromEditor(p) })
  return out
}

function sendFromEditor(p: WebPanel): void {
  const sel = fileSelection()
  const f = recentFile()
  void sendTo(p, sel, sel ? sel.path : (f?.path ?? null))
}

export function webPanelTreeItems(path: string): MenuItem[] {
  const items: MenuItem[] = [...panels].map((p) => ({ label: t('发送到 {0}', p.site.name), run: () => void sendTo(p, null, path) }))
  return items.length ? [...items, 'sep'] : []
}

/* ---------------- 初始化 ---------------- */

export function initWebPanel(): void {
  setWebPanelOpener((m, anchor) => openPicker(m, anchor, 'below'))
  setExtraAgentIcons(toolbarIcons)
  setAssistantTargets(() =>
    [...panels].map((p) => ({
      usedAt: () => p.used,
      focus: () => p.focus(),
      mention: (sel, file) => void sendTo(p, sel, file)
    }))
  )

  window.api.webPanel.onState((id, st) => byId.get(id)?.onState(st))
  window.api.webPanel.onFocus((id) => {
    const p = byId.get(id)
    if (!p) return
    p.used = Date.now()
    // 点进网页时，它所在的组成为活动组（Ctrl W 关的是它，而不是左边的文件）
    activateViewGroup(p.el)
  })
  window.api.webPanel.onKey((id, key) => onKey(byId.get(id) ?? null, key))

  // 插件停用或卸载：关掉它的面板
  onMarketChange(() => {
    const live = new Set(webPanelPlugins().map((m) => m.id))
    for (const p of [...panels]) if (!live.has(p.plugin.id)) closeView(p.el)
  })

  on('tabs', () => burst(400))
  on('layout', () => burst(400))
  window.addEventListener('resize', () => burst(200))
  watchOverlays()
  // 兜底：没有事件的变化（例如设置页打开）也能在 200ms 内跟上
  setInterval(() => panels.size && syncAll(), 200)
}

/** 网页里按下的 IDE 快捷键 */
function onKey(p: WebPanel | null, key: WebPanelKey): void {
  // Ctrl Esc：从网页回到编辑器
  if ((key.ctrlKey || key.metaKey) && key.key === 'Escape') {
    const f = recentFile()
    if (f) activate(f.path)
    else getEditor()?.focus()
    return
  }
  if (p) activateViewGroup(p.el)
  const target = p?.el ?? document.body
  target.dispatchEvent(new KeyboardEvent('keydown', { ...key, bubbles: true, cancelable: true }))
}
