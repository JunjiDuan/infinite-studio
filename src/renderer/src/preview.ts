import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist'
import type { CellObject } from 'xlsx'
import { basename, h, toast } from './dom'
import { icons } from './icons'
import { openView, pathKey, registerPreviewer, revealView, samePath, type ViewSpec } from './editor'
import { t } from './i18n'

/**
 * 文档预览：PDF、Word（.docx）、Excel（.xlsx/.xls/.ods）、PowerPoint（.pptx，大纲方式）、图片、音视频。
 * 都是只读视图，以标签形式出现在编辑器组里；磁盘上的文件变化时自动刷新。
 * 渲染库按需动态加载，不影响启动速度。
 */

type Kind = 'pdf' | 'docx' | 'sheet' | 'pptx' | 'image' | 'audio' | 'video' | 'external'

const EXT: Record<string, Kind> = {
  pdf: 'pdf',
  docx: 'docx',
  docm: 'docx',
  dotx: 'docx',
  xlsx: 'sheet',
  xlsm: 'sheet',
  xlsb: 'sheet',
  xls: 'sheet',
  ods: 'sheet',
  numbers: 'sheet',
  pptx: 'pptx',
  pptm: 'pptx',
  ppsx: 'pptx',
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  webp: 'image',
  bmp: 'image',
  ico: 'image',
  avif: 'image',
  apng: 'image',
  mp3: 'audio',
  wav: 'audio',
  ogg: 'audio',
  oga: 'audio',
  flac: 'audio',
  m4a: 'audio',
  aac: 'audio',
  opus: 'audio',
  mp4: 'video',
  m4v: 'video',
  webm: 'video',
  ogv: 'video',
  mov: 'video',
  // 识别得出、但没法在应用内渲染的常见格式：给出“用默认应用打开”
  doc: 'external',
  dot: 'external',
  ppt: 'external',
  pps: 'external',
  odt: 'external',
  odp: 'external',
  pages: 'external',
  key: 'external',
  epub: 'external',
  zip: 'external',
  '7z': 'external',
  rar: 'external',
  psd: 'external',
  ai: 'external',
  sketch: 'external',
  fig: 'external'
}

const MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  avif: 'image/avif',
  apng: 'image/apng',
  svg: 'image/svg+xml',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  flac: 'audio/flac',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  opus: 'audio/ogg',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  webm: 'video/webm',
  ogv: 'video/ogg',
  mov: 'video/quicktime'
}

const LEGACY_HINT: Record<string, string> = {
  doc: t('旧版 Word（.doc）格式暂不支持预览，另存为 .docx 后即可在这里查看。'),
  dot: t('旧版 Word 模板（.dot）格式暂不支持预览。'),
  ppt: t('旧版 PowerPoint（.ppt）格式暂不支持预览，另存为 .pptx 后即可在这里查看。'),
  pps: t('旧版 PowerPoint（.pps）格式暂不支持预览。')
}

const KIND_LABEL: Record<Kind, string> = {
  pdf: 'PDF',
  docx: 'Word',
  sheet: t('表格'),
  pptx: t('演示文稿'),
  image: t('图片'),
  audio: t('音频'),
  video: t('视频'),
  external: t('文件')
}

function ext(path: string): string {
  const name = basename(path)
  const i = name.lastIndexOf('.')
  return i > 0 ? name.slice(i + 1).toLowerCase() : ''
}

/** 该路径应该用哪种预览打开；返回 null 表示按文本打开 */
export function previewKind(path: string): Kind | null {
  return EXT[ext(path)] ?? null
}

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

/* ---------------- 预览标签 ---------------- */

interface Zoomer {
  zoom(dir: 1 | -1): void
  reset(): void
}

interface Preview {
  spec: ViewSpec
  kind: Kind
  el: HTMLElement
  /** 工具栏左侧：文件信息 */
  info: HTMLElement
  /** 工具栏中间：各渲染器自己的控件（页码、缩放等） */
  controls: HTMLElement
  body: HTMLElement
  /** 当前渲染的清理函数 */
  cleanup: (() => void) | null
  zoomer: Zoomer | null
  /** 每次加载递增，丢弃过期的异步结果 */
  seq: number
  reloadTimer?: ReturnType<typeof setTimeout>
}

const previews = new Set<Preview>()

function findPreview(path: string): Preview | undefined {
  for (const p of previews) if (p.spec.path && samePath(p.spec.path, path)) return p
  return undefined
}

function kindIcon(kind: Kind): string {
  return kind === 'image' || kind === 'video' ? icons.image : icons.files
}

export function openPreview(path: string, kind: Kind): void {
  const existing = findPreview(path)
  if (existing && revealView(existing.el)) return

  const info = h('div', { class: 'dp-info' })
  const controls = h('div', { class: 'dp-controls' })
  const body = h('div', { class: 'dp-body', tabindex: '-1' })
  const el = h('div', { class: `doc-preview kind-${kind}` })
  const p: Preview = {
    spec: null as unknown as ViewSpec,
    kind,
    el,
    info,
    controls,
    body,
    cleanup: null,
    zoomer: null,
    seq: 0
  }
  const actions = h(
    'div',
    { class: 'dp-actions' },
    h('button', { class: 'icon-btn small', title: t('重新加载'), 'aria-label': t('重新加载'), html: icons.refresh, onClick: () => void load(p) }),
    h('button', { class: 'icon-btn small', title: t('在文件夹中显示'), 'aria-label': t('在文件夹中显示'), html: icons.folder, onClick: () => void window.api.fs.reveal(p.spec.path!) }),
    h('button', { class: 'btn small', title: t('用系统默认应用打开'), onClick: () => void openExternal(p.spec.path!) }, t('默认应用打开'))
  )
  el.append(h('div', { class: 'dp-bar' }, info, controls, actions), body)

  // Ctrl + 滚轮缩放
  body.addEventListener(
    'wheel',
    (e) => {
      if (!(e.ctrlKey || e.metaKey) || !p.zoomer) return
      e.preventDefault()
      p.zoomer.zoom(e.deltaY < 0 ? 1 : -1)
    },
    { passive: false }
  )
  // 文档里的链接：外部网址交给系统浏览器，页内锚点自己滚动，其余忽略（窗口本身不允许跳转）
  body.addEventListener('click', (e) => {
    const a = (e.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null
    if (!a) return
    e.preventDefault()
    const href = a.getAttribute('href') ?? ''
    if (/^https?:\/\//i.test(href) || /^mailto:/i.test(href)) window.open(href)
    else if (href.startsWith('#') && href.length > 1) body.querySelector(`[id="${CSS.escape(href.slice(1))}"], a[name="${CSS.escape(href.slice(1))}"]`)?.scrollIntoView()
  })

  p.spec = {
    key: 'preview:' + pathKey(path),
    title: basename(path),
    icon: kindIcon(kind),
    kind: 'preview',
    el,
    path,
    onClose: () => {
      p.seq++
      clearTimeout(p.reloadTimer)
      p.cleanup?.()
      p.cleanup = null
      previews.delete(p)
    }
  }
  previews.add(p)
  openView(p.spec)
  void load(p)
}

async function openExternal(path: string): Promise<void> {
  const err = await window.api.fs.openPath(path)
  if (err) toast(t('无法打开：') + err)
}

function setInfo(p: Preview, ...parts: (string | null | undefined)[]): void {
  p.info.textContent = [KIND_LABEL[p.kind], ...parts].filter(Boolean).join(' · ')
}

function message(p: Preview, title: string, detail?: string, withOpen = true): void {
  p.body.replaceChildren(
    h(
      'div',
      { class: 'dp-message' },
      h('div', { class: 'dp-message-icon', html: kindIcon(p.kind) }),
      h('div', { class: 'dp-message-title' }, title),
      detail ? h('div', { class: 'dp-message-detail' }, detail) : null,
      withOpen
        ? h(
            'div',
            { class: 'dp-message-actions' },
            h('button', { class: 'btn small primary', onClick: () => void openExternal(p.spec.path!) }, t('用默认应用打开')),
            h('button', { class: 'btn small', onClick: () => void window.api.fs.reveal(p.spec.path!) }, t('在文件夹中显示'))
          )
        : null
    )
  )
}

async function load(p: Preview): Promise<void> {
  const seq = ++p.seq
  const path = p.spec.path!
  const keepScroll = p.body.scrollTop
  const keepLeft = p.body.scrollLeft
  const stale = () => seq !== p.seq

  if (p.kind === 'external') {
    p.cleanup?.()
    p.cleanup = null
    p.zoomer = null
    p.controls.replaceChildren()
    setInfo(p, ext(path).toUpperCase() || null)
    const hint = LEGACY_HINT[ext(path)]
    message(p, hint ? t('暂不支持预览这种格式') : t('无法在编辑器中显示此文件'), hint ?? t('这是二进制文件，可以用系统默认应用打开它。'))
    return
  }

  if (!p.body.childElementCount) p.body.replaceChildren(h('div', { class: 'dp-loading' }, t('正在加载…')))
  const r = await window.api.fs.readBinary(path)
  if (stale()) return
  if (!r.ok) {
    p.cleanup?.()
    p.cleanup = null
    p.zoomer = null
    p.controls.replaceChildren()
    if (r.reason === 'too-large') message(p, t('文件太大，无法在编辑器中预览'), t('大小 {0}，超过 300 MB 上限。', fmtSize(r.size ?? 0)))
    else if (r.reason === 'missing') message(p, t('文件不存在'), path, false)
    else message(p, t('无法读取文件'), r.message)
    return
  }

  const host = h('div', { class: 'dp-content' })
  const controls = h('div', { class: 'dp-controls-inner' })
  const ctx: RenderCtx = { p, host, controls, data: r.data, size: r.size, stale, zoomer: null }
  try {
    const cleanup = await RENDERERS[p.kind](ctx)
    if (stale()) {
      cleanup?.()
      return
    }
    p.cleanup?.()
    p.cleanup = cleanup ?? null
    p.zoomer = ctx.zoomer
    p.controls.replaceChildren(controls)
    p.body.replaceChildren(host)
    ctx.after?.()
    p.body.scrollTop = keepScroll
    p.body.scrollLeft = keepLeft
  } catch (err) {
    if (stale()) return
    console.error('预览失败', path, err)
    p.cleanup?.()
    p.cleanup = null
    p.zoomer = null
    p.controls.replaceChildren()
    message(p, t('无法预览这个文件'), String((err as Error)?.message ?? err))
  }
}

/* ---------------- 渲染器 ---------------- */

interface RenderCtx {
  p: Preview
  /** 渲染结果放这里；渲染完成后才替换进页面，避免刷新时闪烁 */
  host: HTMLElement
  controls: HTMLElement
  data: Uint8Array
  size: number
  stale: () => boolean
  zoomer: Zoomer | null
  /** host 挂进页面之后调用（需要知道尺寸的初始化放这里） */
  after?: () => void
}

type Renderer = (ctx: RenderCtx) => Promise<(() => void) | void>

const RENDERERS: Record<Exclude<Kind, 'external'>, Renderer> = {
  pdf: renderPdf,
  docx: renderDocx,
  sheet: renderSheet,
  pptx: renderPptx,
  image: renderImage,
  audio: renderMedia,
  video: renderMedia
}

/** 缩放控件：− 100% + */
function zoomControls(ctx: RenderCtx, get: () => number, set: (v: number) => void, steps = ZOOM_STEPS, extra?: HTMLElement): HTMLElement {
  const label = h('button', { class: 'dp-zoom-label', title: t('重置缩放 (Ctrl 0)') })
  const refresh = () => (label.textContent = `${Math.round(get() * 100)}%`)
  const step = (dir: 1 | -1) => {
    const cur = get()
    const next = dir > 0 ? steps.find((s) => s > cur + 0.001) : [...steps].reverse().find((s) => s < cur - 0.001)
    if (next) {
      set(next)
      refresh()
    }
  }
  const reset = () => {
    set(1)
    refresh()
  }
  label.addEventListener('click', reset)
  ctx.zoomer = { zoom: step, reset }
  refresh()
  return h(
    'div',
    { class: 'dp-zoom' },
    h('button', { class: 'icon-btn small', title: t('缩小 (Ctrl −)'), 'aria-label': t('缩小'), onClick: () => step(-1) }, '−'),
    label,
    h('button', { class: 'icon-btn small', title: t('放大 (Ctrl +)'), 'aria-label': t('放大'), onClick: () => step(1) }, '+'),
    extra ?? null
  )
}

const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5]

/* ---------- PDF（pdf.js） ---------- */

/** pdf.js 的 CMap / 字体 / wasm 资源，由构建配置复制到 pdfjs/ 目录 */
const pdfAsset = (dir: string) => new URL(`pdfjs/${dir}/`, document.baseURI).href
/** pdf.js 里 scale = 1 对应 72 DPI，屏幕上的“100%”是 96 DPI */
const CSS_UNITS = 96 / 72

async function renderPdf(ctx: RenderCtx): Promise<() => void> {
  const pdfjs = await import('pdfjs-dist')
  pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl
  const task = pdfjs.getDocument({
    // pdf.js 会转移这块内存，传副本以便出错时还能重试
    data: ctx.data.slice(),
    cMapUrl: pdfAsset('cmaps'),
    cMapPacked: true,
    standardFontDataUrl: pdfAsset('standard_fonts'),
    wasmUrl: pdfAsset('wasm'),
    iccUrl: pdfAsset('iccs'),
    enableXfa: false
  })
  // 加密文档：在预览区里要密码（Electron 不支持 window.prompt）
  task.onPassword = (submit: (pw: string) => void, reason: number) => {
    if (ctx.stale()) return void task.destroy()
    const input = h('input', { class: 'dp-input', type: 'password', placeholder: t('输入密码'), 'aria-label': t('PDF 密码') })
    const go = () => submit(input.value)
    input.addEventListener('keydown', (e) => e.key === 'Enter' && go())
    ctx.p.body.replaceChildren(
      h(
        'div',
        { class: 'dp-message' },
        h('div', { class: 'dp-message-title' }, reason === pdfjs.PasswordResponses.INCORRECT_PASSWORD ? t('密码不正确，请重试') : t('这个 PDF 受密码保护')),
        h('div', { class: 'dp-message-actions' }, input, h('button', { class: 'btn small primary', onClick: go }, t('打开')))
      )
    )
    input.focus()
  }
  let doc: PDFDocumentProxy
  try {
    doc = await task.promise
  } catch (err) {
    void task.destroy()
    throw err
  }
  const n = doc.numPages
  const first = await doc.getPage(1)
  const base = first.getViewport({ scale: 1 })

  /** gen 在每次释放时递增，用来丢弃已经过期的异步渲染 */
  const pages: { el: HTMLElement; w: number; h: number; rendered: boolean; gen: number; task: RenderTask | null; cancelText?: () => void }[] = []
  for (let i = 0; i < n; i++) {
    const el = h('div', { class: 'dp-page', 'data-page': String(i + 1) })
    pages.push({ el, w: base.width, h: base.height, rendered: false, gen: 0, task: null })
  }
  ctx.host.classList.add('dp-pages')
  ctx.host.append(...pages.map((x) => x.el))

  let scale = 1
  let fitMode = true
  const fitScale = () => {
    const avail = ctx.p.body.clientWidth - 48
    return Math.max(0.25, Math.min(3, avail / base.width / CSS_UNITS))
  }
  const sizePages = () => {
    for (const pg of pages) {
      pg.el.style.width = `${Math.floor(pg.w * scale * CSS_UNITS)}px`
      pg.el.style.height = `${Math.floor(pg.h * scale * CSS_UNITS)}px`
    }
  }

  const unrender = (pg: (typeof pages)[number]) => {
    pg.task?.cancel()
    pg.task = null
    pg.cancelText?.()
    pg.cancelText = undefined
    pg.gen++
    pg.rendered = false
    pg.el.replaceChildren()
  }

  const renderPage = async (i: number) => {
    const pg = pages[i]
    if (pg.rendered) return
    pg.rendered = true
    const gen = pg.gen
    const page = await doc.getPage(i + 1)
    if (gen !== pg.gen) return
    const raw = page.getViewport({ scale: 1 })
    if (raw.width !== pg.w || raw.height !== pg.h) {
      pg.w = raw.width
      pg.h = raw.height
      pg.el.style.width = `${Math.floor(pg.w * scale * CSS_UNITS)}px`
      pg.el.style.height = `${Math.floor(pg.h * scale * CSS_UNITS)}px`
    }
    const vp = page.getViewport({ scale: scale * CSS_UNITS })
    const dpr = window.devicePixelRatio || 1
    const canvas = h('canvas', { class: 'dp-canvas' })
    canvas.width = Math.floor(vp.width * dpr)
    canvas.height = Math.floor(vp.height * dpr)
    canvas.style.width = `${Math.floor(vp.width)}px`
    canvas.style.height = `${Math.floor(vp.height)}px`
    const text = h('div', { class: 'textLayer' })
    pg.el.style.setProperty('--total-scale-factor', String(vp.scale))
    pg.el.style.setProperty('--scale-round-x', '1px')
    pg.el.style.setProperty('--scale-round-y', '1px')
    pg.el.replaceChildren(canvas, text)
    const t = page.render({ canvas, viewport: vp, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined })
    pg.task = t
    try {
      await t.promise
    } catch (err) {
      if ((err as Error)?.name !== 'RenderingCancelledException') console.warn('PDF 页面渲染失败', err)
      return
    } finally {
      if (pg.task === t) pg.task = null
    }
    if (gen !== pg.gen) return
    // 文字层：可以选中、复制
    const layer = new pdfjs.TextLayer({ textContentSource: page.streamTextContent(), container: text, viewport: vp })
    pg.cancelText = () => layer.cancel()
    layer.render().catch(() => {})
  }

  // 只渲染视口附近的页面；离开很远的页面释放画布，大文档也不会占满内存
  const visible = new Set<number>()
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        const i = Number((e.target as HTMLElement).dataset.page) - 1
        if (e.isIntersecting) {
          visible.add(i)
          void renderPage(i)
        } else {
          visible.delete(i)
          unrender(pages[i])
        }
      }
    },
    { root: ctx.p.body, rootMargin: '1200px 0px' }
  )

  // 页码
  const pageInput = h('input', { class: 'dp-input dp-page-input', value: '1', 'aria-label': t('页码') })
  const currentPage = () => {
    const body = ctx.p.body
    const mid = body.scrollTop + body.clientHeight / 3
    let lo = 0
    for (let i = 0; i < pages.length; i++) {
      if (pages[i].el.offsetTop <= mid) lo = i
      else break
    }
    return lo
  }
  const goto = (i: number) => {
    const pg = pages[Math.max(0, Math.min(n - 1, i))]
    ctx.p.body.scrollTop = pg.el.offsetTop - 12
  }
  pageInput.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return
    const v = parseInt(pageInput.value, 10)
    if (v) goto(v - 1)
    pageInput.blur()
  })
  const onScroll = () => {
    if (document.activeElement !== pageInput) pageInput.value = String(currentPage() + 1)
  }
  ctx.p.body.addEventListener('scroll', onScroll, { passive: true })

  const applyScale = (v: number) => {
    // 缩放后保持当前页、页内相对位置不变
    const body = ctx.p.body
    const i = currentPage()
    const pg = pages[i].el
    const frac = pg.offsetHeight ? (body.scrollTop - pg.offsetTop) / pg.offsetHeight : 0
    scale = v
    for (const x of pages) unrender(x)
    sizePages()
    body.scrollTop = pg.offsetTop + frac * pg.offsetHeight
    for (const j of visible) void renderPage(j)
  }

  const fitBtn = h('button', { class: 'btn small dp-fit', title: t('按视图宽度缩放') }, t('适合宽度'))
  const zoom = zoomControls(
    ctx,
    () => scale,
    (v) => {
      fitMode = false
      fitBtn.classList.remove('on')
      applyScale(v)
    },
    ZOOM_STEPS,
    fitBtn
  )
  const zoomLabel = zoom.querySelector('.dp-zoom-label')!
  const fit = () => {
    fitMode = true
    fitBtn.classList.add('on')
    applyScale(fitScale())
    zoomLabel.textContent = `${Math.round(scale * 100)}%`
  }
  fitBtn.addEventListener('click', fit)
  ctx.controls.append(h('div', { class: 'dp-pager' }, pageInput, h('span', { class: 'dp-muted' }, `/ ${n}`)), zoom)

  // 视图宽度变化时（拖动分隔条、开关侧栏），“适合宽度”模式跟着调整
  let lastWidth = 0
  let resizeTimer: ReturnType<typeof setTimeout> | undefined
  const ro = new ResizeObserver(() => {
    const w = ctx.p.body.clientWidth
    if (!w || w === lastWidth) return
    lastWidth = w
    if (!fitMode) return
    clearTimeout(resizeTimer)
    resizeTimer = setTimeout(fit, 120)
  })

  setInfo(ctx.p, t('{0} 页', n), fmtSize(ctx.size))
  ctx.after = () => {
    lastWidth = ctx.p.body.clientWidth
    scale = fitScale()
    fitBtn.classList.add('on')
    zoomLabel.textContent = `${Math.round(scale * 100)}%`
    sizePages()
    for (const pg of pages) io.observe(pg.el)
    ro.observe(ctx.p.body)
  }

  return () => {
    io.disconnect()
    ro.disconnect()
    clearTimeout(resizeTimer)
    ctx.p.body.removeEventListener('scroll', onScroll)
    for (const pg of pages) unrender(pg)
    void task.destroy()
  }
}

/* ---------- Word（docx-preview） ---------- */

async function renderDocx(ctx: RenderCtx): Promise<() => void> {
  const { renderAsync } = await import('docx-preview')
  const styles = h('div', { class: 'dp-docx-styles' })
  const doc = h('div', { class: 'dp-docx' })
  await renderAsync(ctx.data, doc, styles, {
    className: 'docx',
    inWrapper: true,
    breakPages: true,
    ignoreLastRenderedPageBreak: true,
    experimental: true,
    renderHeaders: true,
    renderFooters: true,
    renderFootnotes: true,
    renderEndnotes: true,
    renderChanges: false,
    renderComments: false,
    // altChunk 会把内嵌的 HTML 放进 iframe，不渲染
    renderAltChunks: false,
    useBase64URL: false
  })
  ctx.host.append(styles, doc)
  let zoom = 1
  ctx.controls.append(
    zoomControls(
      ctx,
      () => zoom,
      (v) => {
        zoom = v
        doc.style.zoom = String(v)
      }
    )
  )
  const pages = doc.querySelectorAll('section.docx').length
  setInfo(ctx.p, pages ? t('{0} 页', pages) : null, fmtSize(ctx.size))
  return () => revokeBlobs(ctx.host)
}

/** 释放渲染库为图片、字体创建的 blob: 地址 */
function revokeBlobs(root: HTMLElement): void {
  for (const img of root.querySelectorAll<HTMLImageElement>('img[src^="blob:"]')) URL.revokeObjectURL(img.src)
  for (const style of root.querySelectorAll('style')) for (const m of style.textContent?.matchAll(/url\(["']?(blob:[^"')]+)/g) ?? []) URL.revokeObjectURL(m[1])
}

/* ---------- Excel（SheetJS） ---------- */

const MAX_ROWS = 2000
const MAX_COLS = 200

async function renderSheet(ctx: RenderCtx): Promise<void> {
  const XLSX = await import('xlsx')
  const wb = XLSX.read(ctx.data, { type: 'array', dense: true, cellDates: true, cellStyles: false, cellHTML: false })
  const names = wb.SheetNames
  if (!names.length) throw new Error(t('工作簿里没有工作表'))

  const tableHost = h('div', { class: 'dp-sheet-scroll' })
  const note = h('div', { class: 'dp-sheet-note', hidden: true })
  const tabs = h('div', { class: 'dp-sheet-tabs', role: 'tablist' })
  ctx.host.classList.add('dp-sheet')
  ctx.host.append(tableHost, note, tabs)

  let zoom = 1
  ctx.controls.append(
    zoomControls(
      ctx,
      () => zoom,
      (v) => {
        zoom = v
        tableHost.style.setProperty('--sheet-zoom', String(v))
      }
    )
  )

  const show = (name: string) => {
    for (const b of tabs.children) b.setAttribute('aria-selected', String((b as HTMLElement).dataset.name === name))
    const ws = wb.Sheets[name]
    const ref = ws?.['!ref']
    if (!ws || !ref) {
      tableHost.replaceChildren(h('div', { class: 'dp-loading' }, t('（空工作表）')))
      note.hidden = true
      return
    }
    const range = XLSX.utils.decode_range(ref)
    const rows = Math.min(range.e.r - range.s.r + 1, MAX_ROWS)
    const cols = Math.min(range.e.c - range.s.c + 1, MAX_COLS)
    const data = ws['!data'] as CellObject[][] | undefined
    const cellAt = (r: number, c: number) => (data ? data[r]?.[c] : (ws[XLSX.utils.encode_cell({ r, c })] as CellObject | undefined))

    // 合并单元格：左上角设置跨度，其余被覆盖的格子跳过
    const span = new Map<string, { rs: number; cs: number }>()
    const covered = new Set<string>()
    for (const m of ws['!merges'] ?? []) {
      span.set(`${m.s.r},${m.s.c}`, { rs: m.e.r - m.s.r + 1, cs: m.e.c - m.s.c + 1 })
      for (let r = m.s.r; r <= m.e.r; r++) for (let c = m.s.c; c <= m.e.c; c++) if (r !== m.s.r || c !== m.s.c) covered.add(`${r},${c}`)
    }

    const table = document.createElement('table')
    table.className = 'dp-table'
    const head = document.createElement('tr')
    head.append(h('th', { class: 'dp-corner' }))
    for (let c = range.s.c; c < range.s.c + cols; c++) head.append(h('th', {}, XLSX.utils.encode_col(c)))
    const thead = document.createElement('thead')
    thead.append(head)
    const tbody = document.createElement('tbody')
    for (let r = range.s.r; r < range.s.r + rows; r++) {
      const tr = document.createElement('tr')
      tr.append(h('th', {}, String(r + 1)))
      for (let c = range.s.c; c < range.s.c + cols; c++) {
        const key = `${r},${c}`
        if (covered.has(key)) continue
        const td = document.createElement('td')
        const cell = cellAt(r, c)
        if (cell) {
          let text = ''
          try {
            text = XLSX.utils.format_cell(cell)
          } catch {
            text = cell.v == null ? '' : String(cell.v)
          }
          td.textContent = text
          if (cell.t === 'n' || cell.t === 'd') td.className = 'num'
          else if (cell.t === 'b') td.className = 'bool'
          else if (cell.t === 'e') td.className = 'err'
          if (cell.f) td.title = '=' + cell.f
        }
        const s = span.get(key)
        if (s) {
          if (s.rs > 1) td.rowSpan = s.rs
          if (s.cs > 1) td.colSpan = s.cs
        }
        tr.append(td)
      }
      tbody.append(tr)
    }
    table.append(thead, tbody)
    tableHost.replaceChildren(table)
    tableHost.scrollTop = tableHost.scrollLeft = 0
    const totalRows = range.e.r - range.s.r + 1
    const totalCols = range.e.c - range.s.c + 1
    const truncated = totalRows > rows || totalCols > cols
    note.hidden = !truncated
    note.textContent = truncated ? t('只显示前 {0} 行 × {1} 列（共 {2} 行 × {3} 列），完整内容请用默认应用打开。', rows, cols, totalRows, totalCols) : ''
    setInfo(ctx.p, t('{0} 个工作表', names.length), t('{0} 行 × {1} 列', totalRows, totalCols), fmtSize(ctx.size))
  }

  for (const name of names) {
    const hidden = wb.Workbook?.Sheets?.find((s) => s.name === name)?.Hidden
    tabs.append(
      h(
        'button',
        { class: 'dp-sheet-tab' + (hidden ? ' hidden-sheet' : ''), role: 'tab', 'data-name': name, title: hidden ? t('{0}（隐藏）', name) : name, onClick: () => show(name) },
        name
      )
    )
  }
  const firstVisible = names.find((n) => !wb.Workbook?.Sheets?.find((s) => s.name === n)?.Hidden) ?? names[0]
  show(firstVisible)
}

/* ---------- PowerPoint（JSZip 解析，大纲方式） ---------- */

const NS_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'

async function renderPptx(ctx: RenderCtx): Promise<() => void> {
  const JSZip = (await import('jszip')).default
  const zip = await JSZip.loadAsync(ctx.data)
  const xml = async (path: string): Promise<Document | null> => {
    const f = zip.file(path)
    return f ? new DOMParser().parseFromString(await f.async('text'), 'application/xml') : null
  }
  const resolve = (baseDir: string, target: string) => {
    if (target.startsWith('/')) return target.slice(1)
    const parts = (baseDir + target).split('/')
    const out: string[] = []
    for (const s of parts) {
      if (s === '..') out.pop()
      else if (s && s !== '.') out.push(s)
    }
    return out.join('/')
  }
  const rels = async (dir: string, name: string) => {
    const doc = await xml(`${dir}_rels/${name}.rels`)
    const map = new Map<string, { target: string; type: string }>()
    for (const r of doc?.getElementsByTagName('Relationship') ?? []) {
      if (r.getAttribute('TargetMode') === 'External') continue
      map.set(r.getAttribute('Id') ?? '', { target: resolve(dir, r.getAttribute('Target') ?? ''), type: r.getAttribute('Type') ?? '' })
    }
    return map
  }
  const byTag = (el: Element | Document, tag: string) => [...el.getElementsByTagNameNS('*', tag)]
  const textOf = (p: Element) => byTag(p, 't').map((t) => t.textContent ?? '').join('')

  // 幻灯片顺序以 presentation.xml 为准
  const pres = await xml('ppt/presentation.xml')
  if (!pres) throw new Error(t('不是有效的 PowerPoint 文件'))
  const presRels = await rels('ppt/', 'presentation.xml')
  const slidePaths = byTag(pres, 'sldId')
    .map((s) => presRels.get(s.getAttributeNS(NS_REL, 'id') ?? '')?.target)
    .filter((x): x is string => !!x && !!zip.file(x))

  const blobs: string[] = []
  const imageUrl = async (path: string) => {
    const mime = MIME[ext(path)]
    const f = zip.file(path)
    // EMF / WMF 等浏览器显示不了的格式跳过
    if (!mime || !f) return null
    const url = URL.createObjectURL(new Blob([(await f.async('uint8array')) as BlobPart], { type: mime }))
    blobs.push(url)
    return url
  }

  ctx.host.classList.add('dp-slides')
  ctx.host.append(h('div', { class: 'dp-banner' }, t('演示文稿以大纲方式预览（文字、图片、表格和备注）；版式、动画请用默认应用查看。')))

  for (let i = 0; i < slidePaths.length; i++) {
    if (ctx.stale()) break
    const path = slidePaths[i]
    const dir = path.slice(0, path.lastIndexOf('/') + 1)
    const name = path.slice(dir.length)
    const doc = await xml(path)
    if (!doc) continue
    const srels = await rels(dir, name)
    const card = h('section', { class: 'dp-slide' }, h('div', { class: 'dp-slide-no' }, String(i + 1)))
    const content = h('div', { class: 'dp-slide-content' })
    const media = h('div', { class: 'dp-slide-media' })
    let hasTitle = false

    // 按文档顺序遍历形状：文本框、图片、表格
    const walker = doc.createTreeWalker(doc.documentElement, NodeFilter.SHOW_ELEMENT)
    for (let n = walker.nextNode() as Element | null; n; n = walker.nextNode() as Element | null) {
      if (n.localName === 'sp') {
        const ph = byTag(n, 'ph')[0]?.getAttribute('type')
        const isTitle = ph === 'title' || ph === 'ctrTitle'
        const paras = byTag(n, 'p').filter((p) => p.namespaceURI?.includes('drawingml'))
        const lines = paras.map((p) => ({ text: textOf(p), lvl: Number(byTag(p, 'pPr')[0]?.getAttribute('lvl') ?? 0) })).filter((l) => l.text.trim())
        if (!lines.length) continue
        if (isTitle && !hasTitle) {
          hasTitle = true
          content.prepend(h('h3', { class: 'dp-slide-title' }, lines.map((l) => l.text).join(' ')))
        } else {
          const ul = h('ul', { class: 'dp-slide-text' })
          for (const l of lines) ul.append(h('li', { style: { marginLeft: `${l.lvl * 18}px` } }, l.text))
          content.append(ul)
        }
      } else if (n.localName === 'pic') {
        const id = byTag(n, 'blip')[0]?.getAttributeNS(NS_REL, 'embed')
        const target = id ? srels.get(id)?.target : undefined
        const url = target ? await imageUrl(target) : null
        if (url) media.append(h('img', { src: url, alt: byTag(n, 'cNvPr')[0]?.getAttribute('descr') ?? '', loading: 'lazy' }))
      } else if (n.localName === 'tbl') {
        const table = h('table', { class: 'dp-table dp-slide-table' })
        for (const tr of byTag(n, 'tr')) {
          const row = h('tr')
          for (const tc of byTag(tr, 'tc')) {
            if (tc.getAttribute('hMerge') || tc.getAttribute('vMerge')) continue
            const td = h('td', {}, byTag(tc, 'p').map(textOf).join('\n'))
            const gs = Number(tc.getAttribute('gridSpan') ?? 1)
            const rs = Number(tc.getAttribute('rowSpan') ?? 1)
            if (gs > 1) td.colSpan = gs
            if (rs > 1) td.rowSpan = rs
            row.append(td)
          }
          table.append(row)
        }
        content.append(table)
      }
    }
    if (media.childElementCount) content.append(media)
    if (!content.childElementCount) content.append(h('div', { class: 'dp-muted' }, t('（这一页没有文字内容）')))
    card.append(content)

    // 演讲者备注
    for (const r of srels.values()) {
      if (!r.type.endsWith('/notesSlide')) continue
      const notes = await xml(r.target)
      if (!notes) continue
      const text = byTag(notes, 'sp')
        .filter((sp) => byTag(sp, 'ph')[0]?.getAttribute('type') === 'body')
        .flatMap((sp) => byTag(sp, 'p').map(textOf))
        .filter((t) => t.trim())
      if (text.length) card.append(h('div', { class: 'dp-slide-notes' }, h('div', { class: 'dp-muted' }, t('备注')), ...text.map((t) => h('p', {}, t))))
    }
    ctx.host.append(card)
  }

  let zoom = 1
  ctx.controls.append(
    zoomControls(
      ctx,
      () => zoom,
      (v) => {
        zoom = v
        ctx.host.style.zoom = String(v)
      }
    )
  )
  setInfo(ctx.p, t('{0} 张幻灯片', slidePaths.length), fmtSize(ctx.size))
  return () => blobs.forEach((u) => URL.revokeObjectURL(u))
}

/* ---------- 图片 ---------- */

async function renderImage(ctx: RenderCtx): Promise<() => void> {
  const url = URL.createObjectURL(new Blob([ctx.data as BlobPart], { type: MIME[ext(ctx.p.spec.path!)] ?? '' }))
  const img = h('img', { class: 'dp-image', src: url, alt: basename(ctx.p.spec.path!), draggable: 'false' })
  try {
    await img.decode()
  } catch {
    URL.revokeObjectURL(url)
    throw new Error(t('图片无法解码，可能已损坏或格式不受支持'))
  }
  const w = img.naturalWidth
  const hgt = img.naturalHeight
  // 0 表示“适合窗口”（大图缩小、小图原样）
  let zoom = 0
  const apply = () => {
    img.classList.toggle('fit', zoom === 0)
    img.style.width = zoom ? `${Math.round(w * zoom)}px` : ''
    img.style.height = zoom ? `${Math.round(hgt * zoom)}px` : ''
  }
  const stage = h('div', { class: 'dp-image-stage' }, img)
  ctx.host.classList.add('dp-image-wrap')
  ctx.host.append(stage)
  const fitBtn = h('button', { class: 'btn small', title: t('适合窗口 / 原始大小') }, t('适合窗口'))
  const zoomEl = zoomControls(
    ctx,
    () => zoom || Math.min(1, ctx.p.body.clientWidth / w, ctx.p.body.clientHeight / hgt),
    (v) => {
      zoom = v
      fitBtn.textContent = t('适合窗口')
      apply()
    },
    ZOOM_STEPS.concat([6, 8, 10]),
    fitBtn
  )
  const label = zoomEl.querySelector('.dp-zoom-label')!
  fitBtn.addEventListener('click', () => {
    zoom = 0
    apply()
    label.textContent = `${Math.round(Math.min(1, ctx.p.body.clientWidth / w, ctx.p.body.clientHeight / hgt) * 100)}%`
  })
  // 单击图片在“适合窗口”和 100% 之间切换
  img.addEventListener('click', () => {
    zoom = zoom ? 0 : 1
    apply()
    label.textContent = `${Math.round((zoom || Math.min(1, ctx.p.body.clientWidth / w, ctx.p.body.clientHeight / hgt)) * 100)}%`
  })
  ctx.controls.append(zoomEl)
  ctx.after = () => {
    apply()
    label.textContent = `${Math.round(Math.min(1, ctx.p.body.clientWidth / w, ctx.p.body.clientHeight / hgt) * 100)}%`
  }
  setInfo(ctx.p, `${w} × ${hgt}`, fmtSize(ctx.size))
  return () => URL.revokeObjectURL(url)
}

/* ---------- 音频 / 视频 ---------- */

async function renderMedia(ctx: RenderCtx): Promise<() => void> {
  const kind = ctx.p.kind as 'audio' | 'video'
  const url = URL.createObjectURL(new Blob([ctx.data as BlobPart], { type: MIME[ext(ctx.p.spec.path!)] ?? '' }))
  const el = h(kind, { class: `dp-${kind}-el`, src: url, controls: true, preload: 'metadata' }) as HTMLMediaElement
  await new Promise<void>((resolve, reject) => {
    el.addEventListener('loadedmetadata', () => resolve(), { once: true })
    el.addEventListener('error', () => reject(new Error(t('无法播放：格式或编码不受支持'))), { once: true })
  }).catch((err) => {
    URL.revokeObjectURL(url)
    throw err
  })
  const dur = el.duration
  const time = Number.isFinite(dur) ? `${Math.floor(dur / 60)}:${String(Math.floor(dur % 60)).padStart(2, '0')}` : null
  const dims = kind === 'video' && (el as HTMLVideoElement).videoWidth ? `${(el as HTMLVideoElement).videoWidth} × ${(el as HTMLVideoElement).videoHeight}` : null
  ctx.host.classList.add('dp-media')
  ctx.host.append(el)
  setInfo(ctx.p, time, dims, fmtSize(ctx.size))
  return () => {
    el.pause()
    el.removeAttribute('src')
    el.load()
    URL.revokeObjectURL(url)
  }
}

/* ---------------- 接入 ---------------- */

/** 焦点在预览里时，Ctrl + / Ctrl − / Ctrl 0 缩放预览而不是改编辑器字号 */
export function zoomPreviewAt(target: EventTarget | null, dir: 1 | -1 | 0): boolean {
  const el = (target as Element | null)?.closest?.('.doc-preview')
  if (!el) return false
  for (const p of previews) {
    if (p.el !== el || !p.zoomer) continue
    if (dir === 0) p.zoomer.reset()
    else p.zoomer.zoom(dir)
    return true
  }
  return false
}

export function initPreview(): void {
  registerPreviewer((path, force) => {
    const kind = previewKind(path) ?? (force ? 'external' : null)
    if (!kind) return false
    openPreview(path, kind)
    return true
  })
  // 磁盘上的文件变了：刷新对应的预览（合并短时间内的多次变化）
  window.api.fs.onChanged((paths) => {
    for (const p of previews) {
      if (!p.spec.path || !paths.some((x) => samePath(x, p.spec.path!))) continue
      clearTimeout(p.reloadTimer)
      p.reloadTimer = setTimeout(() => void load(p), 300)
    }
  })
}
