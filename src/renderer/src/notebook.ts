import type { JupyterEvent } from '../../shared/types'
import { renderMarkdown } from './agent/markdown'
import { basename, h, parentDir, toast } from './dom'
import { openFile, openView, pathKey, registerPreviewer, revealView, samePath, type ViewSpec } from './editor'
import { t } from './i18n'
import { icons } from './icons'
import { monaco } from './monaco'
import { openNotebookExport } from './notebookExport'
import { newTerminal } from './panel'
import { emit, on, state } from './store'
import { FONTS } from './theme'

/**
 * Jupyter Notebook（.ipynb）编辑器：
 * - 代码 / Markdown / Raw 单元格，每个代码单元格是一个 Monaco 编辑器（滚动到附近时才创建）
 * - 输出：文本流、错误（ANSI 颜色）、图片、HTML（放在禁止脚本的沙箱 iframe 里）、Markdown、JSON
 * - 运行：主进程经 Python 的 jupyter_client 启动内核（见 main/jupyter.ts），第一次运行单元格时才启动
 * - 保存格式和 Jupyter 一致（nbformat 4，键排序，缩进 1），未知字段原样保留
 */

type Json = Record<string, unknown>
type CellType = 'code' | 'markdown' | 'raw'

interface Output extends Json {
  output_type: string
}

interface Cell {
  type: CellType
  /** 原始的单元格对象：保存时在它的基础上更新，其他字段原样保留 */
  raw: Json
  model: monaco.editor.ITextModel
  outputs: Output[]
  execCount: number | null
  el: HTMLElement
  inputEl: HTMLElement
  editorHost: HTMLElement
  mdEl: HTMLElement
  outputsEl: HTMLElement
  countEl: HTMLElement
  runBtn: HTMLButtonElement
  typeBtn: HTMLButtonElement
  editor: monaco.editor.IStandaloneCodeEditor | null
  editing: boolean
  state: 'idle' | 'queued' | 'running'
  /** clear_output(wait=True)：下一条输出到来时再清空 */
  clearPending: boolean
  renderQueued: boolean
  blobs: string[]
  subs: monaco.IDisposable[]
}

type KernelStatus = 'off' | 'starting' | 'idle' | 'busy' | 'restarting' | 'dead'

interface Nb {
  spec: ViewSpec
  el: HTMLElement
  body: HTMLElement
  cellsEl: HTMLElement
  banner: HTMLElement
  statusEl: HTMLElement
  kernelEl: HTMLElement
  /** 文件里除 cells 以外的顶层字段 */
  doc: Json
  cells: Cell[]
  selected: Cell | null
  lang: string
  version: number
  savedVersion: number
  /** 最近一次从磁盘读到或写入的文本：区分自己保存引起的文件变化 */
  diskText: string
  kernel: Kernel
  observer: IntersectionObserver
  resize: ResizeObserver
  deleted: { cell: Cell; index: number }[]
  /** 命令模式下连按两次 D 删除 */
  lastD: number
  seq: number
  loaded: boolean
  reloadTimer?: ReturnType<typeof setTimeout>
}

const notebooks = new Set<Nb>()
const cellOwner = new WeakMap<monaco.editor.ITextModel, Nb>()
let cellSeq = 0

/* ---------------- 工具 ---------------- */

export function joinText(v: unknown): string {
  if (Array.isArray(v)) return v.join('')
  return typeof v === 'string' ? v : ''
}

/** Jupyter 的多行文本：每行一个字符串，除最后一行外都带换行 */
function splitLines(s: string): string[] {
  if (!s) return []
  const out = s.split(/(?<=\n)/)
  return out
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys)
  if (v && typeof v === 'object') {
    const o: Json = {}
    for (const k of Object.keys(v as Json).sort()) o[k] = sortKeys((v as Json)[k])
    return o
  }
  return v
}

function newCellId(): string {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 8)
}

/** 内核里用的语言名 → Monaco 语言 ID */
function monacoLang(name: string): string {
  const n = name.toLowerCase()
  const alias: Record<string, string> = { 'c++': 'cpp', 'c#': 'csharp', 'f#': 'fsharp', bash: 'shell', sh: 'shell', ipython: 'python', ipython3: 'python' }
  const id = alias[n] ?? n
  return monaco.languages.getLanguages().some((l) => l.id === id) ? id : 'plaintext'
}

function cellLang(nb: Nb, type: CellType): string {
  return type === 'code' ? nb.lang : type === 'markdown' ? 'markdown' : 'plaintext'
}

/** 码点偏移（Jupyter 协议）↔ UTF-16 偏移（JS 字符串） */
function toCodePoints(s: string, utf16: number): number {
  return [...s.slice(0, utf16)].length
}
function toUtf16(s: string, cp: number): number {
  let i = 0
  let n = 0
  while (n < cp && i < s.length) {
    i += (s.codePointAt(i) ?? 0) > 0xffff ? 2 : 1
    n++
  }
  return i
}

/** 处理回车符：同一行里 \r 之后的内容覆盖之前的（进度条）。行尾的 \r 保留，等下一段输出来覆盖 */
export function applyCR(s: string): string {
  if (!s.includes('\r')) return s
  return s
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => {
      if (!line.includes('\r')) return line
      const parts = line.split('\r')
      const lastPart = parts[parts.length - 1]
      return lastPart === '' ? (parts[parts.length - 2] ?? '') + '\r' : lastPart
    })
    .join('\n')
}

export function sanitizeB64(s: string): string {
  return s.replace(/\s+/g, '')
}

export const IMG_MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp' }

export function resolveLocal(dir: string, rel: string): string {
  if (/^([a-zA-Z]:[\\/]|[\\/])/.test(rel)) return rel
  const sep = dir.includes('\\') ? '\\' : '/'
  const parts = dir.split(/[\\/]/)
  for (const seg of rel.split(/[\\/]/)) {
    if (seg === '..') parts.pop()
    else if (seg && seg !== '.') parts.push(seg)
  }
  return parts.join(sep)
}

/* ---------------- ANSI 颜色 ---------------- */

const ANSI_NAMES = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white']

function xterm256(n: number): string {
  if (n < 16) return `var(--ansi-${n >= 8 ? 'bright-' : ''}${ANSI_NAMES[n % 8]})`
  if (n >= 232) {
    const v = 8 + (n - 232) * 10
    return `rgb(${v},${v},${v})`
  }
  const i = n - 16
  const c = (x: number) => (x ? 55 + x * 40 : 0)
  return `rgb(${c(Math.floor(i / 36))},${c(Math.floor(i / 6) % 6)},${c(i % 6)})`
}

/** 把带 ANSI 转义的文本转成节点（只处理颜色和粗体，其他控制序列丢掉） */
export function ansi(text: string): DocumentFragment {
  const frag = document.createDocumentFragment()
  let fg: string | null = null
  let bg: string | null = null
  let bold = false
  let italic = false
  let underline = false
  let dim = false
  const re = /\x1b\[([\d;]*)m|\x1b\[[\d;?]*[A-Za-z]|\x1b\][^\x07]*(?:\x07|\x1b\\)/g
  let last = 0
  const push = (s: string) => {
    if (!s) return
    if (!fg && !bg && !bold && !italic && !underline && !dim) return void frag.append(s)
    const span = h('span', {}, s)
    if (fg) span.style.color = fg
    if (bg) span.style.background = bg
    if (bold) span.style.fontWeight = '600'
    if (italic) span.style.fontStyle = 'italic'
    if (underline) span.style.textDecoration = 'underline'
    if (dim) span.style.opacity = '0.7'
    frag.append(span)
  }
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    push(text.slice(last, m.index))
    last = re.lastIndex
    if (m[1] === undefined) continue
    const codes = m[1] === '' ? [0] : m[1].split(';').map((x) => Number(x) || 0)
    for (let i = 0; i < codes.length; i++) {
      const c = codes[i]
      if (c === 0) [fg, bg, bold, italic, underline, dim] = [null, null, false, false, false, false]
      else if (c === 1) bold = true
      else if (c === 2) dim = true
      else if (c === 3) italic = true
      else if (c === 4) underline = true
      else if (c === 22) bold = dim = false
      else if (c === 23) italic = false
      else if (c === 24) underline = false
      else if (c >= 30 && c <= 37) fg = `var(--ansi-${ANSI_NAMES[c - 30]})`
      else if (c >= 90 && c <= 97) fg = `var(--ansi-bright-${ANSI_NAMES[c - 90]})`
      else if (c >= 40 && c <= 47) bg = `var(--ansi-${ANSI_NAMES[c - 40]})`
      else if (c >= 100 && c <= 107) bg = `var(--ansi-bright-${ANSI_NAMES[c - 100]})`
      else if (c === 39) fg = null
      else if (c === 49) bg = null
      else if ((c === 38 || c === 48) && codes[i + 1] === 5) {
        const col = xterm256(codes[i + 2] ?? 0)
        if (c === 38) fg = col
        else bg = col
        i += 2
      } else if ((c === 38 || c === 48) && codes[i + 1] === 2) {
        const col = `rgb(${codes[i + 2] ?? 0},${codes[i + 3] ?? 0},${codes[i + 4] ?? 0})`
        if (c === 38) fg = col
        else bg = col
        i += 4
      }
    }
  }
  push(text.slice(last))
  return frag
}

/* ---------------- 内核 ---------------- */

interface ExecHandler {
  output(type: string, content: Json): void
  reply(content: Json): void
  input(content: Json): void
  done(): void
}

const kernelsBySession = new Map<number, Kernel>()

class Kernel {
  session: number | null = null
  status: KernelStatus = 'off'
  python = ''
  private starting: Promise<boolean> | null = null
  private readyWait: { resolve: (ok: boolean) => void } | null = null
  private nextId = 1
  /** 客户端编号 → 等待内核消息 ID */
  private byClient = new Map<number, (msgId: string) => void>()
  private execs = new Map<string, { h: ExecHandler; replied: boolean; idle: boolean }>()
  private completes = new Map<string, (content: Json | null) => void>()

  constructor(private nb: Nb) {}

  get ready(): boolean {
    return this.session !== null && (this.status === 'idle' || this.status === 'busy')
  }

  private setStatus(s: KernelStatus): void {
    this.status = s
    renderStatus(this.nb)
  }

  ensure(): Promise<boolean> {
    if (this.session !== null && this.status !== 'dead') return Promise.resolve(true)
    if (this.starting) return this.starting
    this.starting = this.start().finally(() => (this.starting = null))
    return this.starting
  }

  private async start(): Promise<boolean> {
    hideBanner(this.nb)
    if (this.session !== null) this.shutdown()
    this.setStatus('starting')
    const meta = (this.nb.doc.metadata ?? {}) as Json
    const spec = (meta.kernelspec ?? {}) as Json
    const r = await window.api.jupyter.start({ file: this.nb.spec.path!, kernel: String(spec.name ?? 'python3'), root: state.root })
    if (!r.ok) {
      this.setStatus('off')
      showBanner(this.nb, t('无法启动内核'), r.detail ?? '')
      return false
    }
    if (!notebooks.has(this.nb)) {
      window.api.jupyter.stop(r.session)
      return false
    }
    this.session = r.session
    this.python = r.python
    kernelsBySession.set(r.session, this)
    return new Promise<boolean>((resolve) => (this.readyWait = { resolve }))
  }

  private resolveReady(ok: boolean): void {
    this.readyWait?.resolve(ok)
    this.readyWait = null
  }

  handle(ev: JupyterEvent): void {
    switch (ev.type) {
      case 'ready': {
        const li = (ev.info.language_info ?? {}) as Json
        if (li.name) {
          const meta = (this.nb.doc.metadata ??= {}) as Json
          // 记下内核报告的语言信息（和 Jupyter 一样写进 metadata）；只在有变化时标记为已修改
          const prev = JSON.stringify(meta.language_info ?? null)
          if (prev !== JSON.stringify(li)) {
            meta.language_info = li
            if (prev !== 'null') touch(this.nb)
          }
          setLanguage(this.nb, monacoLang(String(li.name)))
        }
        if (ev.fallback) toast(t('找不到内核“{0}”，已改用 {1}', ev.fallback, ev.kernel))
        this.setStatus('idle')
        this.resolveReady(true)
        return
      }
      case 'sent': {
        const cb = this.byClient.get(ev.id)
        this.byClient.delete(ev.id)
        cb?.(ev.msg_id)
        return
      }
      case 'iopub': {
        if (ev.msg_type === 'status') {
          const s = String(ev.content.execution_state)
          if (s === 'busy' || s === 'idle') {
            if (this.status !== 'restarting') this.setStatus(s)
            const ex = ev.parent ? this.execs.get(ev.parent) : undefined
            if (ex && s === 'idle') {
              ex.idle = true
              if (ex.replied) this.finish(ev.parent!)
            } else if (ex && s === 'busy') ex.h.output('status:busy', {})
          }
          return
        }
        const ex = ev.parent ? this.execs.get(ev.parent) : undefined
        ex?.h.output(ev.msg_type, ev.content)
        return
      }
      case 'shell': {
        if (!ev.parent) return
        const c = this.completes.get(ev.parent)
        if (c) {
          this.completes.delete(ev.parent)
          c(ev.content)
          return
        }
        const ex = this.execs.get(ev.parent)
        if (!ex) return
        ex.h.reply(ev.content)
        ex.replied = true
        if (ex.idle || ev.content.status === 'aborted') this.finish(ev.parent)
        return
      }
      case 'stdin': {
        const ex = ev.parent ? this.execs.get(ev.parent) : undefined
        if (ev.msg_type === 'input_request') ex?.h.input(ev.content)
        return
      }
      case 'restarted':
        this.failAll()
        this.setStatus('idle')
        toast(t('内核已重启'))
        return
      case 'dead':
        this.failAll()
        this.setStatus('dead')
        showBanner(this.nb, t('内核已停止运行'), t('可能是内存不足或代码导致解释器崩溃。点“重启”重新启动内核。'))
        return
      case 'fatal':
        this.failAll()
        this.setStatus('off')
        if (ev.reason === 'missing') {
          showBanner(this.nb, t('运行 Notebook 需要安装 ipykernel'), t('当前 Python：{0}', this.python), ev.install)
        } else {
          showBanner(this.nb, ev.reason === 'nokernel' ? t('找不到内核') : t('内核启动失败'), ev.detail)
        }
        this.resolveReady(false)
        return
      case 'log':
        console.warn('[jupyter]', ev.text)
        return
    }
  }

  onExit(code: number, stderr: string): void {
    if (this.session !== null) kernelsBySession.delete(this.session)
    this.session = null
    this.failAll()
    const wasStarting = !!this.readyWait
    this.resolveReady(false)
    if (this.status !== 'off') {
      this.setStatus('off')
      if (code !== 0 && (wasStarting || stderr)) showBanner(this.nb, t('内核进程已退出（代码 {0}）', code), stderr.trim().split(/\r?\n/).slice(-8).join('\n'))
    }
  }

  private finish(msgId: string): void {
    const ex = this.execs.get(msgId)
    if (!ex) return
    this.execs.delete(msgId)
    ex.h.done()
  }

  private failAll(): void {
    const all = [...this.execs.values()]
    this.execs.clear()
    for (const ex of all) ex.h.done()
    for (const c of this.completes.values()) c(null)
    this.completes.clear()
    for (const [, cb] of this.byClient) cb('')
    this.byClient.clear()
  }

  private request(cmd: { cmd: 'execute'; code: string } | { cmd: 'complete'; code: string; pos: number }): Promise<string> {
    const id = this.nextId++
    return new Promise((resolve) => {
      this.byClient.set(id, resolve)
      window.api.jupyter.send(this.session!, { ...cmd, id })
    })
  }

  async execute(code: string, h: ExecHandler): Promise<void> {
    if (!(await this.ensure()) || this.session === null) return h.done()
    const entry = { h, replied: false, idle: false }
    const id = this.nextId++
    // 先登记再发送：桥接按顺序转发，“已发出”一定先于这个请求的任何输出
    this.byClient.set(id, (msgId) => {
      if (msgId) this.execs.set(msgId, entry)
      else h.done()
    })
    window.api.jupyter.send(this.session, { cmd: 'execute', id, code })
  }

  async complete(code: string, pos: number): Promise<Json | null> {
    if (!this.ready || this.session === null) return null
    const msgId = await this.request({ cmd: 'complete', code, pos })
    if (!msgId) return null
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.completes.delete(msgId)
        resolve(null)
      }, 2000)
      this.completes.set(msgId, (c) => {
        clearTimeout(timer)
        resolve(c)
      })
    })
  }

  input(value: string): void {
    if (this.session !== null) window.api.jupyter.send(this.session, { cmd: 'input', value })
  }

  interrupt(): void {
    if (this.session !== null) window.api.jupyter.send(this.session, { cmd: 'interrupt' })
  }

  async restart(): Promise<void> {
    if (this.session === null || this.status === 'dead') {
      if (this.session !== null) this.shutdown()
      await this.ensure()
      return
    }
    this.setStatus('restarting')
    this.failAll()
    window.api.jupyter.send(this.session, { cmd: 'restart' })
  }

  shutdown(): void {
    if (this.session === null) return
    kernelsBySession.delete(this.session)
    window.api.jupyter.stop(this.session)
    this.session = null
    this.failAll()
    this.resolveReady(false)
    this.setStatus('off')
  }
}

/* ---------------- 补全（由内核提供） ---------------- */

const providerLangs = new Set<string>()
const KIND: Record<string, monaco.languages.CompletionItemKind> = {
  function: monaco.languages.CompletionItemKind.Function,
  class: monaco.languages.CompletionItemKind.Class,
  module: monaco.languages.CompletionItemKind.Module,
  instance: monaco.languages.CompletionItemKind.Variable,
  statement: monaco.languages.CompletionItemKind.Variable,
  keyword: monaco.languages.CompletionItemKind.Keyword,
  param: monaco.languages.CompletionItemKind.Variable,
  path: monaco.languages.CompletionItemKind.File,
  property: monaco.languages.CompletionItemKind.Property,
  magic: monaco.languages.CompletionItemKind.Event
}

function ensureCompletion(lang: string): void {
  if (lang === 'plaintext' || providerLangs.has(lang)) return
  providerLangs.add(lang)
  monaco.languages.registerCompletionItemProvider(lang, {
    triggerCharacters: ['.'],
    async provideCompletionItems(model, position, _ctx, token) {
      const nb = cellOwner.get(model)
      if (!nb || !nb.kernel.ready) return { suggestions: [] }
      const code = model.getValue()
      const r = await nb.kernel.complete(code, toCodePoints(code, model.getOffsetAt(position)))
      if (!r || token.isCancellationRequested || r.status !== 'ok') return { suggestions: [] }
      const matches = (r.matches as string[] | undefined) ?? []
      const start = model.getPositionAt(toUtf16(code, Number(r.cursor_start)))
      const end = model.getPositionAt(toUtf16(code, Number(r.cursor_end)))
      const range = new monaco.Range(start.lineNumber, start.column, end.lineNumber, end.column)
      const types = ((r.metadata as Json | undefined)?._jupyter_types_experimental as { type?: string }[] | undefined) ?? []
      return {
        suggestions: matches.map((m, i) => ({
          label: m,
          insertText: m,
          kind: KIND[types[i]?.type ?? ''] ?? monaco.languages.CompletionItemKind.Text,
          range,
          sortText: String(i).padStart(5, '0')
        }))
      }
    }
  })
}

/* ---------------- 打开 / 读写 ---------------- */

function findNb(path: string): Nb | undefined {
  for (const nb of notebooks) if (nb.spec.path && samePath(nb.spec.path, path)) return nb
  return undefined
}

export function openNotebook(path: string): void {
  const existing = findNb(path)
  if (existing && revealView(existing.el)) return

  const statusEl = h('span', { class: 'nb-status' })
  const kernelEl = h('span', { class: 'nb-kernel' })
  const banner = h('div', { class: 'nb-banner', hidden: true })
  const cellsEl = h('div', { class: 'nb-cells' })
  const body = h('div', { class: 'nb-body', tabindex: '-1' }, cellsEl)
  const el = h('div', { class: 'doc-preview notebook' })

  const nb: Nb = {
    spec: null as unknown as ViewSpec,
    el,
    body,
    cellsEl,
    banner,
    statusEl,
    kernelEl,
    doc: {},
    cells: [],
    selected: null,
    lang: 'python',
    version: 0,
    savedVersion: 0,
    diskText: '',
    kernel: null as unknown as Kernel,
    observer: new IntersectionObserver((entries) => onVisible(nb, entries), { root: body, rootMargin: '600px 0px' }),
    resize: new ResizeObserver(() => layoutAll(nb)),
    deleted: [],
    lastD: 0,
    seq: 0,
    loaded: false
  }
  nb.kernel = new Kernel(nb)

  const btn = (label: string, icon: string, title: string, run: () => void, cls = '') =>
    h('button', { class: `btn small nb-tool ${cls}`, title, onClick: run }, h('span', { class: 'nb-tool-icon', html: icon }), h('span', {}, label))
  const iconBtn = (icon: string, title: string, run: () => void) => h('button', { class: 'icon-btn small', title, 'aria-label': title, html: icon, onClick: run })

  const bar = h(
    'div',
    { class: 'dp-bar nb-bar' },
    h(
      'div',
      { class: 'nb-tools' },
      btn(t('全部运行'), icons.play, t('运行全部单元格'), () => void runAll(nb)),
      iconBtn(icons.stop, t('中断内核'), () => nb.kernel.interrupt()),
      iconBtn(icons.dbgRestart, t('重启内核'), () => void restartKernel(nb)),
      iconBtn(icons.discard, t('清除全部输出'), () => clearAllOutputs(nb)),
      h('span', { class: 'nb-sep' }),
      btn(t('代码'), icons.plus, t('在下方插入代码单元格 (B)'), () => insertCell(nb, 'code', nb.selected ? nb.cells.indexOf(nb.selected) + 1 : nb.cells.length, true)),
      btn('Markdown', icons.plus, t('在下方插入 Markdown 单元格'), () => insertCell(nb, 'markdown', nb.selected ? nb.cells.indexOf(nb.selected) + 1 : nb.cells.length, true))
    ),
    h('div', { class: 'dp-info nb-info' }, kernelEl, statusEl),
    h(
      'div',
      { class: 'dp-actions' },
      btn(t('导出'), icons.arrowDown, t('导出为 HTML、PDF、Markdown 或脚本'), () => {
        if (!nb.loaded) return
        openNotebookExport({ path: nb.spec.path!, data: JSON.parse(serialize(nb)) as Json, lang: nb.lang })
      }),
      iconBtn(icons.file, t('以文本方式打开'), () => {
        if (nb.version !== nb.savedVersion) return toast(t('请先保存 Notebook，再以文本方式打开'))
        void openFile(nb.spec.path!, { raw: true })
      }),
      iconBtn(icons.folder, t('在文件夹中显示'), () => void window.api.fs.reveal(nb.spec.path!))
    )
  )
  el.append(bar, banner, body)

  body.addEventListener('keydown', (e) => onCommandKey(nb, e))
  // 点空白处：退出编辑，进入命令模式
  body.addEventListener('mousedown', (e) => {
    if (e.target === body || e.target === cellsEl) {
      e.preventDefault()
      body.focus()
    }
  })
  // Markdown 里的链接：外部网址交给系统浏览器
  body.addEventListener('click', (e) => {
    const a = (e.target as Element | null)?.closest?.('.nb-md a[href], .nb-outputs a[href]') as HTMLAnchorElement | null
    if (!a) return
    const href = a.getAttribute('href') ?? ''
    if (/^https?:\/\//i.test(href) || /^mailto:/i.test(href)) {
      e.preventDefault()
      window.open(href)
    }
  })
  nb.resize.observe(cellsEl)

  nb.spec = {
    key: 'notebook:' + pathKey(path),
    title: basename(path),
    icon: icons.list,
    kind: 'preview',
    el,
    path,
    dirty: () => nb.version !== nb.savedVersion,
    save: () => save(nb),
    onShow: () => requestAnimationFrame(() => layoutAll(nb)),
    onClose: () => {
      nb.seq++
      clearTimeout(nb.reloadTimer)
      nb.kernel.shutdown()
      for (const c of nb.cells) disposeCell(c)
      for (const d of nb.deleted) disposeCell(d.cell)
      nb.observer.disconnect()
      nb.resize.disconnect()
      notebooks.delete(nb)
    }
  }
  notebooks.add(nb)
  renderStatus(nb)
  openView(nb.spec)
  void load(nb)
}

async function load(nb: Nb): Promise<void> {
  const seq = ++nb.seq
  if (!nb.loaded) nb.body.replaceChildren(h('div', { class: 'dp-loading' }, t('正在加载…')))
  const r = await window.api.fs.readFile(nb.spec.path!)
  if (seq !== nb.seq) return
  if (!r.ok) {
    message(nb, r.reason === 'missing' ? t('文件不存在') : r.reason === 'too-large' ? t('文件超过 5 MB，暂不支持打开') : t('无法读取文件'), nb.spec.path!)
    return
  }
  let data: Json
  try {
    data = r.content.trim() ? (JSON.parse(r.content) as Json) : emptyNotebook()
  } catch (e) {
    message(nb, t('无法解析这个 Notebook'), String((e as Error).message ?? e), true)
    return
  }
  if (!Array.isArray(data.cells) || Number(data.nbformat ?? 4) < 4) {
    message(nb, t('只支持 nbformat 4 格式的 Notebook'), t('可以在 Jupyter 里打开并另存一次，升级到新格式。'), true)
    return
  }
  apply(nb, data, r.content)
}

function emptyNotebook(): Json {
  return {
    cells: [{ cell_type: 'code', execution_count: null, id: newCellId(), metadata: {}, outputs: [], source: [] }],
    metadata: { kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' }, language_info: { name: 'python' } },
    nbformat: 4,
    nbformat_minor: 5
  }
}

function message(nb: Nb, title: string, detail: string, withText = false): void {
  nb.loaded = false
  nb.body.replaceChildren(
    h(
      'div',
      { class: 'dp-message' },
      h('div', { class: 'dp-message-icon', html: icons.list }),
      h('div', { class: 'dp-message-title' }, title),
      h('div', { class: 'dp-message-detail' }, detail),
      withText ? h('div', { class: 'dp-message-actions' }, h('button', { class: 'btn small primary', onClick: () => void openFile(nb.spec.path!, { raw: true }) }, t('以文本方式打开'))) : null
    )
  )
}

/** 把解析好的 Notebook 显示出来（首次打开或从磁盘重新加载） */
function apply(nb: Nb, data: Json, text: string): void {
  const selIndex = nb.selected ? nb.cells.indexOf(nb.selected) : -1
  const scroll = nb.body.scrollTop
  for (const c of nb.cells) disposeCell(c)
  nb.cells = []
  nb.selected = null
  const { cells, ...doc } = data
  nb.doc = doc
  const meta = (doc.metadata ?? {}) as Json
  const li = (meta.language_info ?? {}) as Json
  const ks = (meta.kernelspec ?? {}) as Json
  nb.lang = monacoLang(String(li.name ?? ks.language ?? 'python'))
  for (const raw of cells as Json[]) nb.cells.push(createCell(nb, raw))
  nb.diskText = text
  nb.version = nb.savedVersion = 0
  nb.loaded = true
  nb.body.replaceChildren(nb.cellsEl)
  layoutCells(nb)
  renderStatus(nb)
  const sel = nb.cells[Math.min(Math.max(selIndex, 0), nb.cells.length - 1)]
  if (sel) select(nb, sel, false)
  nb.body.scrollTop = scroll
  emit('tabs')
}

function serialize(nb: Nb): string {
  const minor = Number(nb.doc.nbformat_minor ?? 5)
  const cells = nb.cells.map((c) => {
    const o: Json = { ...c.raw, cell_type: c.type, metadata: c.raw.metadata ?? {}, source: splitLines(c.model.getValue(monaco.editor.EndOfLinePreference.LF)) }
    if (c.type === 'code') {
      o.outputs = c.outputs.map((x) => {
        const { transient: _t, ...rest } = x
        // 和 nbformat 一样：多行文本存成按行拆开的数组（JSON 类型除外），减少版本管理里的差异
        if (typeof rest.text === 'string') rest.text = splitLines(rest.text)
        if (rest.data && typeof rest.data === 'object') {
          const data: Json = {}
          for (const [k, v] of Object.entries(rest.data as Json)) data[k] = typeof v === 'string' && k !== 'application/json' && !k.endsWith('+json') ? splitLines(v) : v
          rest.data = data
        }
        return rest
      })
      o.execution_count = c.execCount
    } else {
      delete o.outputs
      delete o.execution_count
    }
    if (minor >= 5 && typeof o.id !== 'string') o.id = c.raw.id = newCellId()
    return o
  })
  const doc = { ...nb.doc, cells, nbformat: 4, nbformat_minor: Number.isFinite(minor) ? minor : 5 }
  return JSON.stringify(sortKeys(doc), null, 1) + '\n'
}

async function save(nb: Nb): Promise<boolean> {
  if (!nb.loaded) return false
  const text = serialize(nb)
  const version = nb.version
  try {
    await window.api.fs.writeFile(nb.spec.path!, text)
    nb.diskText = text
    nb.savedVersion = version
    emit('tabs')
    return true
  } catch (e) {
    toast(t('保存失败：') + String(e))
    return false
  }
}

let tabsQueued = false
function touch(nb: Nb): void {
  nb.version++
  if (tabsQueued) return
  tabsQueued = true
  queueMicrotask(() => {
    tabsQueued = false
    emit('tabs')
  })
}

/* ---------------- 内核状态 / 提示条 ---------------- */

const STATUS_LABEL: Record<KernelStatus, string> = {
  off: t('未连接'),
  starting: t('正在启动…'),
  idle: t('空闲'),
  busy: t('运行中'),
  restarting: t('正在重启…'),
  dead: t('已停止')
}

function renderStatus(nb: Nb): void {
  const meta = (nb.doc.metadata ?? {}) as Json
  const ks = (meta.kernelspec ?? {}) as Json
  const li = (meta.language_info ?? {}) as Json
  const name = String(ks.display_name ?? (li.name ? `${li.name}` : 'Python 3'))
  nb.kernelEl.textContent = name
  nb.kernelEl.title = nb.kernel?.python || ''
  const s = nb.kernel?.status ?? 'off'
  nb.statusEl.textContent = STATUS_LABEL[s]
  nb.statusEl.dataset.state = s
}

function showBanner(nb: Nb, title: string, detail: string, install?: string): void {
  const close = h('button', { class: 'icon-btn small', title: t('关闭'), 'aria-label': t('关闭'), html: icons.close, onClick: () => hideBanner(nb) })
  const actions = h('div', { class: 'nb-banner-actions' })
  if (install) {
    actions.append(
      h(
        'button',
        {
          class: 'btn small primary',
          onClick: () => {
            void newTerminal(parentDir(nb.spec.path!), { title: 'pip install ipykernel', run: install })
            hideBanner(nb)
            toast(t('安装完成后，再运行一次单元格即可'))
          }
        },
        t('在终端中安装')
      ),
      h('code', { class: 'nb-banner-cmd' }, install)
    )
  }
  nb.banner.replaceChildren(
    h('div', { class: 'nb-banner-icon', html: icons.warn }),
    h('div', { class: 'nb-banner-text' }, h('div', { class: 'nb-banner-title' }, title), detail ? h('pre', { class: 'nb-banner-detail' }, detail) : null, actions),
    close
  )
  nb.banner.hidden = false
}

function hideBanner(nb: Nb): void {
  nb.banner.hidden = true
}

/* ---------------- 单元格 ---------------- */

function createCell(nb: Nb, raw: Json): Cell {
  const type = (raw.cell_type === 'markdown' || raw.cell_type === 'raw' ? raw.cell_type : 'code') as CellType
  const model = monaco.editor.createModel(joinText(raw.source), cellLang(nb, type), monaco.Uri.parse(`nbcell://notebook/${++cellSeq}`))
  cellOwner.set(model, nb)
  const countEl = h('div', { class: 'nb-count' })
  const runBtn = h('button', { class: 'icon-btn small nb-run', title: t('运行单元格 (Ctrl Enter)'), 'aria-label': t('运行单元格'), html: icons.play }) as HTMLButtonElement
  const typeBtn = h('button', { class: 'nb-cell-btn nb-type', title: t('切换单元格类型') }) as HTMLButtonElement
  const editorHost = h('div', { class: 'nb-editor' })
  const mdEl = h('div', { class: 'nb-md' })
  const inputEl = h('div', { class: 'nb-input' }, editorHost, mdEl)
  const outputsEl = h('div', { class: 'nb-outputs' })
  const el = h('div', { class: 'nb-cell', tabindex: '-1' })
  const c: Cell = {
    type,
    raw,
    model,
    outputs: type === 'code' && Array.isArray(raw.outputs) ? (raw.outputs as Output[]) : [],
    execCount: type === 'code' && typeof raw.execution_count === 'number' ? raw.execution_count : null,
    el,
    inputEl,
    editorHost,
    mdEl,
    outputsEl,
    countEl,
    runBtn,
    typeBtn,
    editor: null,
    editing: false,
    state: 'idle',
    clearPending: false,
    renderQueued: false,
    blobs: [],
    subs: []
  }
  const cellBtn = (icon: string, title: string, run: () => void) =>
    h('button', { class: 'nb-cell-btn', title, 'aria-label': title, html: icon, onClick: (e: MouseEvent) => (e.stopPropagation(), run()) })
  el.append(
    h('div', { class: 'nb-gutter' }, runBtn, countEl),
    h('div', { class: 'nb-main' }, inputEl, outputsEl),
    h(
      'div',
      { class: 'nb-cell-tools' },
      typeBtn,
      cellBtn(icons.arrowUp, t('上移'), () => moveCell(nb, c, -1)),
      cellBtn(icons.arrowDown, t('下移'), () => moveCell(nb, c, 1)),
      cellBtn(icons.trash, t('删除单元格 (D D)'), () => deleteCell(nb, c))
    )
  )
  runBtn.addEventListener('click', (e) => {
    e.stopPropagation()
    if (c.state !== 'idle') nb.kernel.interrupt()
    else void runCell(nb, c, 'stay')
  })
  typeBtn.addEventListener('click', (e) => {
    e.stopPropagation()
    setType(nb, c, c.type === 'code' ? 'markdown' : 'code')
  })
  el.addEventListener('mousedown', (e) => {
    if ((e.target as Element).closest('.nb-editor, button, input, iframe')) return
    select(nb, c, false)
    // 点在输出等处：焦点放到单元格上（命令模式），不抢文字选择
    if (!(e.target as Element).closest('.nb-outputs, .nb-md')) {
      e.preventDefault()
      el.focus({ preventScroll: true })
    }
  })
  mdEl.addEventListener('dblclick', () => editCell(nb, c))
  c.subs.push(model.onDidChangeContent(() => touch(nb)))
  syncCell(nb, c)
  renderInput(nb, c)
  renderOutputs(nb, c)
  nb.observer.observe(el)
  return c
}

function disposeCell(c: Cell): void {
  for (const s of c.subs) s.dispose()
  c.subs = []
  c.editor?.dispose()
  c.editor = null
  c.model.dispose()
  for (const b of c.blobs) URL.revokeObjectURL(b)
  c.blobs = []
}

/** 单元格的样式、执行计数、类型按钮 */
function syncCell(nb: Nb, c: Cell): void {
  c.el.className = `nb-cell ${c.type}` + (c === nb.selected ? ' selected' : '') + (c.editing ? ' editing' : '') + (c.state !== 'idle' ? ` ${c.state}` : '')
  c.typeBtn.textContent = c.type === 'code' ? (nb.lang === 'plaintext' ? t('代码') : nb.lang) : c.type === 'markdown' ? 'Markdown' : 'Raw'
  if (c.type === 'code') {
    c.countEl.textContent = c.state !== 'idle' ? '[*]' : `[${c.execCount ?? ' '}]`
    c.runBtn.innerHTML = c.state !== 'idle' ? icons.stop : icons.play
    c.runBtn.title = c.state !== 'idle' ? t('中断') : t('运行单元格 (Ctrl Enter)')
  } else {
    c.countEl.textContent = ''
    c.runBtn.innerHTML = icons.play
    c.runBtn.title = c.type === 'markdown' ? t('渲染 Markdown (Ctrl Enter)') : ''
  }
  c.runBtn.hidden = c.type === 'raw'
}

/** 输入区：代码单元格和正在编辑的 Markdown 用编辑器，其余显示渲染结果 */
function renderInput(nb: Nb, c: Cell): void {
  const showMd = c.type === 'markdown' && !c.editing
  c.editorHost.hidden = showMd
  c.mdEl.hidden = !showMd
  if (showMd) {
    for (const b of c.blobs) URL.revokeObjectURL(b)
    c.blobs = []
    const text = c.model.getValue()
    c.mdEl.replaceChildren(text.trim() ? renderMarkdown(text, { image: (src, alt) => mdImage(nb, c, src, alt) }) : h('div', { class: 'nb-md-empty' }, t('双击编辑 Markdown')))
    return
  }
  if (!c.editor) placeholder(nb, c)
}

function mdImage(nb: Nb, c: Cell, src: string, alt: string): Node {
  if (src.startsWith('attachment:')) {
    const att = ((c.raw.attachments ?? {}) as Record<string, Record<string, string>>)[decodeURIComponent(src.slice(11))]
    const mime = att && Object.keys(att).find((k) => k.startsWith('image/'))
    if (att && mime) return h('img', { class: 'nb-img', alt, src: mime === 'image/svg+xml' ? `data:${mime};charset=utf-8,${encodeURIComponent(joinText(att[mime]))}` : `data:${mime};base64,${sanitizeB64(joinText(att[mime]))}` })
    return document.createTextNode(alt)
  }
  if (/^data:image\//i.test(src)) return h('img', { class: 'nb-img', alt, src })
  // 远程图片受内容安全策略限制，显示成链接
  if (/^https?:\/\//i.test(src)) return h('a', { href: src, target: '_blank', rel: 'noreferrer', title: src }, alt || src)
  const path = resolveLocal(parentDir(nb.spec.path!), decodeURIComponent(src.replace(/[?#].*$/, '')))
  const ext = path.split('.').pop()?.toLowerCase() ?? ''
  const img = h('img', { class: 'nb-img', alt })
  void window.api.fs.readBinary(path).then((r) => {
    if (!r.ok) return img.replaceWith(document.createTextNode(alt))
    const url = URL.createObjectURL(new Blob([r.data as BlobPart], { type: IMG_MIME[ext] ?? 'application/octet-stream' }))
    c.blobs.push(url)
    img.src = url
  })
  return img
}

function editorFont(): { fontFamily: string; fontSize: number; lineHeight: number } {
  const { space } = state.settings
  const size = Math.max(11, space.size - 1)
  return { fontFamily: FONTS[space.font].css, fontSize: size, lineHeight: Math.round(size * 1.6) }
}

/** 编辑器还没创建时，先用着色后的静态代码占位（高度一致，避免滚动跳动） */
function placeholder(nb: Nb, c: Cell): void {
  const f = editorFont()
  const text = c.model.getValue()
  const pre = h('pre', { class: 'nb-static', style: { fontFamily: f.fontFamily, fontSize: f.fontSize + 'px', lineHeight: f.lineHeight + 'px' } }, text || ' ')
  c.editorHost.replaceChildren(pre)
  const lang = cellLang(nb, c.type)
  if (lang !== 'plaintext' && text.length < 50_000)
    void monaco.editor.colorize(text, lang, { tabSize: 4 }).then((html) => {
      if (!c.editor && pre.isConnected) pre.innerHTML = html
    })
}

function onVisible(nb: Nb, entries: IntersectionObserverEntry[]): void {
  for (const e of entries) {
    if (!e.isIntersecting) continue
    const c = nb.cells.find((x) => x.el === e.target)
    if (c && !c.editor && !c.editorHost.hidden) createEditor(nb, c)
  }
}

function createEditor(nb: Nb, c: Cell): monaco.editor.IStandaloneCodeEditor {
  if (c.editor) return c.editor
  c.editorHost.replaceChildren()
  const f = editorFont()
  const ed = monaco.editor.create(c.editorHost, {
    model: c.model,
    ...f,
    automaticLayout: false,
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    lineNumbers: 'off',
    lineDecorationsWidth: 6,
    glyphMargin: false,
    folding: false,
    renderLineHighlight: 'none',
    overviewRulerLanes: 0,
    overviewRulerBorder: false,
    hideCursorInOverviewRuler: true,
    stickyScroll: { enabled: false },
    wordWrap: c.type === 'code' ? 'off' : 'on',
    padding: { top: 8, bottom: 8 },
    scrollbar: { vertical: 'hidden', horizontal: 'auto', alwaysConsumeMouseWheel: false, horizontalScrollbarSize: 8, useShadows: false },
    fixedOverflowWidgets: true,
    tabSize: 4,
    ariaLabel: t('单元格编辑器')
  })
  c.editor = ed
  const fit = () => {
    const height = Math.max(ed.getContentHeight(), f.lineHeight + 16)
    c.editorHost.style.height = height + 'px'
    const width = c.editorHost.clientWidth
    if (width) ed.layout({ width, height })
  }
  c.subs.push(
    ed.onDidContentSizeChange(fit),
    ed.onDidFocusEditorText(() => {
      if (!c.editing) {
        c.editing = true
        syncCell(nb, c)
      }
      select(nb, c, false)
    }),
    ed.onDidBlurEditorText(() => {
      // 焦点离开单元格（不是去了补全列表等浮层）：Markdown 回到渲染状态
      setTimeout(() => {
        if (ed.hasTextFocus() || !c.editing) return
        c.editing = false
        syncCell(nb, c)
        if (c.type === 'markdown') renderInput(nb, c)
      })
    })
  )
  const ctx = 'editorTextFocus && !suggestWidgetVisible && !parameterHintsVisible'
  const action = (id: string, keys: number[], context: string, run: () => void) =>
    c.subs.push(ed.addAction({ id: `nb.${id}`, label: id, keybindings: keys, keybindingContext: context, run }))
  action('runNext', [monaco.KeyMod.Shift | monaco.KeyCode.Enter], ctx, () => void runCell(nb, c, 'next'))
  action('runStay', [monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter], 'editorTextFocus', () => void runCell(nb, c, 'stay'))
  action('runInsert', [monaco.KeyMod.Alt | monaco.KeyCode.Enter], 'editorTextFocus', () => void runCell(nb, c, 'insert'))
  action('commandMode', [monaco.KeyCode.Escape], `${ctx} && !findWidgetVisible && !editorHasMultipleSelections && !inSnippetMode`, () => {
    c.el.focus({ preventScroll: true })
  })
  action('up', [monaco.KeyCode.UpArrow], ctx, () => {
    const p = ed.getPosition()
    const i = nb.cells.indexOf(c)
    if (p && p.lineNumber === 1 && i > 0) editCell(nb, nb.cells[i - 1], 'end')
    else ed.trigger('nb', 'cursorUp', null)
  })
  action('down', [monaco.KeyCode.DownArrow], ctx, () => {
    const p = ed.getPosition()
    const i = nb.cells.indexOf(c)
    if (p && p.lineNumber === c.model.getLineCount() && i < nb.cells.length - 1) editCell(nb, nb.cells[i + 1], 'start')
    else ed.trigger('nb', 'cursorDown', null)
  })
  ensureCompletion(c.model.getLanguageId())
  fit()
  return ed
}

function layoutAll(nb: Nb): void {
  for (const c of nb.cells) {
    const ed = c.editor
    if (!ed || c.editorHost.hidden) continue
    const width = c.editorHost.clientWidth
    if (width) ed.layout({ width, height: c.editorHost.clientHeight })
  }
}

/** 按 nb.cells 的顺序排列单元格和它们之间的“插入”条 */
function layoutCells(nb: Nb): void {
  const nodes: Node[] = [insertBar(nb, 0)]
  nb.cells.forEach((c, i) => nodes.push(c.el, insertBar(nb, i + 1)))
  nb.cellsEl.replaceChildren(...nodes)
}

function insertBar(nb: Nb, index: number): HTMLElement {
  const add = (type: CellType, label: string) =>
    h('button', { class: 'nb-insert-btn', onClick: () => insertCell(nb, type, index, true) }, h('span', { html: icons.plus }), label)
  return h('div', { class: 'nb-insert' + (index === nb.cells.length ? ' last' : '') }, add('code', t('代码')), add('markdown', 'Markdown'))
}

function select(nb: Nb, c: Cell, scroll = true): void {
  if (nb.selected === c) return
  const prev = nb.selected
  nb.selected = c
  if (prev && nb.cells.includes(prev)) syncCell(nb, prev)
  syncCell(nb, c)
  if (scroll) c.el.scrollIntoView({ block: 'nearest' })
}

/** 进入编辑：Markdown 显示编辑器；where 指定光标放在开头还是结尾 */
function editCell(nb: Nb, c: Cell, where?: 'start' | 'end'): void {
  select(nb, c)
  if (c.type === 'markdown' && !c.editing) {
    c.editing = true
    syncCell(nb, c)
    renderInput(nb, c)
  }
  const ed = createEditor(nb, c)
  if (where === 'start') ed.setPosition({ lineNumber: 1, column: 1 })
  else if (where === 'end') {
    const line = c.model.getLineCount()
    ed.setPosition({ lineNumber: line, column: c.model.getLineMaxColumn(line) })
  }
  requestAnimationFrame(() => {
    layoutAll(nb)
    ed.focus()
    c.el.scrollIntoView({ block: 'nearest' })
  })
}

function insertCell(nb: Nb, type: CellType, index: number, edit: boolean): Cell {
  const raw: Json = { cell_type: type, metadata: {}, source: [] }
  if (Number(nb.doc.nbformat_minor ?? 5) >= 5) raw.id = newCellId()
  if (type === 'code') Object.assign(raw, { outputs: [], execution_count: null })
  const c = createCell(nb, raw)
  nb.cells.splice(index, 0, c)
  layoutCells(nb)
  touch(nb)
  if (edit) editCell(nb, c)
  else select(nb, c)
  return c
}

function deleteCell(nb: Nb, c: Cell): void {
  const i = nb.cells.indexOf(c)
  if (i < 0) return
  if (c.state !== 'idle') return toast(t('单元格正在运行，先中断再删除'))
  nb.cells.splice(i, 1)
  nb.observer.unobserve(c.el)
  nb.deleted.push({ cell: c, index: i })
  if (nb.deleted.length > 20) disposeCell(nb.deleted.shift()!.cell)
  if (!nb.cells.length) insertCell(nb, 'code', 0, false)
  else {
    layoutCells(nb)
    nb.selected = null
    select(nb, nb.cells[Math.min(i, nb.cells.length - 1)])
  }
  nb.selected?.el.focus({ preventScroll: true })
  touch(nb)
  toast(t('已删除单元格，按 Z 撤销'))
}

function undoDelete(nb: Nb): void {
  const d = nb.deleted.pop()
  if (!d) return
  nb.cells.splice(Math.min(d.index, nb.cells.length), 0, d.cell)
  nb.observer.observe(d.cell.el)
  layoutCells(nb)
  select(nb, d.cell)
  d.cell.el.focus({ preventScroll: true })
  touch(nb)
}

function moveCell(nb: Nb, c: Cell, dir: 1 | -1): void {
  const i = nb.cells.indexOf(c)
  const j = i + dir
  if (i < 0 || j < 0 || j >= nb.cells.length) return
  ;[nb.cells[i], nb.cells[j]] = [nb.cells[j], nb.cells[i]]
  layoutCells(nb)
  c.el.scrollIntoView({ block: 'nearest' })
  touch(nb)
}

function setType(nb: Nb, c: Cell, type: CellType): void {
  if (c.type === type) return
  if (c.state !== 'idle') return
  c.type = type
  c.raw.cell_type = type
  if (type !== 'code') {
    c.outputs = []
    c.execCount = null
  }
  monaco.editor.setModelLanguage(c.model, cellLang(nb, type))
  ensureCompletion(c.model.getLanguageId())
  c.editor?.updateOptions({ wordWrap: type === 'code' ? 'off' : 'on' })
  c.editing = type === 'markdown' ? !!c.editor?.hasTextFocus() : c.editing
  syncCell(nb, c)
  renderInput(nb, c)
  renderOutputs(nb, c)
  if (!c.editor && !c.editorHost.hidden) createEditor(nb, c)
  touch(nb)
}

function setLanguage(nb: Nb, lang: string): void {
  if (nb.lang === lang) return
  nb.lang = lang
  for (const c of nb.cells) {
    if (c.type !== 'code') continue
    monaco.editor.setModelLanguage(c.model, lang)
    syncCell(nb, c)
  }
  ensureCompletion(lang)
}

/* ---------------- 运行 ---------------- */

async function runCell(nb: Nb, c: Cell, then: 'stay' | 'next' | 'insert'): Promise<void> {
  const i = nb.cells.indexOf(c)
  if (c.type === 'markdown') {
    c.editing = false
    syncCell(nb, c)
    renderInput(nb, c)
  }
  if (then === 'next') {
    const next = nb.cells[i + 1]
    if (next) {
      if (next.type === 'markdown' || !next.editor) {
        select(nb, next)
        next.el.focus({ preventScroll: true })
      } else editCell(nb, next, 'start')
    } else insertCell(nb, 'code', i + 1, true)
  } else if (then === 'insert') insertCell(nb, 'code', i + 1, true)
  else if (c.type === 'markdown') c.el.focus({ preventScroll: true })
  if (c.type === 'code') await execute(nb, c)
}

async function execute(nb: Nb, c: Cell): Promise<void> {
  if (c.state !== 'idle') return
  const code = c.model.getValue()
  c.outputs = []
  c.clearPending = false
  c.state = 'queued'
  syncCell(nb, c)
  renderOutputs(nb, c)
  touch(nb)
  if (!code.trim()) {
    c.state = 'idle'
    syncCell(nb, c)
    return
  }
  await nb.kernel.execute(code, {
    output: (type, content) => {
      if (type === 'status:busy') {
        c.state = 'running'
        syncCell(nb, c)
        return
      }
      addOutput(nb, c, type, content)
    },
    reply: (content) => {
      if (typeof content.execution_count === 'number') c.execCount = content.execution_count
      // ? 帮助等通过 payload 返回的内容
      for (const p of (content.payload as Json[] | undefined) ?? []) {
        const data = p.data as Json | undefined
        if (p.source === 'page' && data) addOutput(nb, c, 'display_data', { data, metadata: {} })
      }
      if (content.status === 'aborted') c.execCount = null
      touch(nb)
    },
    input: (content) => showInput(nb, c, content),
    done: () => {
      c.state = 'idle'
      c.outputsEl.querySelector('.nb-stdin')?.remove()
      syncCell(nb, c)
    }
  })
}

function addOutput(nb: Nb, c: Cell, type: string, content: Json): void {
  if (type === 'clear_output') {
    if (content.wait) c.clearPending = true
    else c.outputs = []
    queueRender(nb, c)
    touch(nb)
    return
  }
  if (type === 'execute_input') return
  if (c.clearPending) {
    c.outputs = []
    c.clearPending = false
  }
  if (type === 'stream') {
    const name = String(content.name ?? 'stdout')
    const last = c.outputs[c.outputs.length - 1]
    if (last?.output_type === 'stream' && last.name === name) last.text = applyCR(joinText(last.text) + String(content.text ?? ''))
    else c.outputs.push({ output_type: 'stream', name, text: applyCR(String(content.text ?? '')) })
  } else if (type === 'execute_result' || type === 'display_data') {
    const o: Output = { output_type: type, data: content.data ?? {}, metadata: content.metadata ?? {} }
    if (type === 'execute_result') o.execution_count = content.execution_count ?? null
    if (content.transient) o.transient = content.transient
    c.outputs.push(o)
  } else if (type === 'update_display_data') {
    const id = (content.transient as Json | undefined)?.display_id
    if (id === undefined) return
    for (const cell of nb.cells)
      for (const o of cell.outputs) {
        if ((o.transient as Json | undefined)?.display_id !== id) continue
        o.data = content.data ?? {}
        o.metadata = content.metadata ?? {}
        queueRender(nb, cell)
      }
  } else if (type === 'error') {
    c.outputs.push({ output_type: 'error', ename: content.ename ?? '', evalue: content.evalue ?? '', traceback: content.traceback ?? [] })
  } else return
  queueRender(nb, c)
  touch(nb)
}

/** 合并同一帧里的多条输出（循环里频繁 print 时不至于每条都重绘） */
function queueRender(nb: Nb, c: Cell): void {
  if (c.renderQueued) return
  c.renderQueued = true
  // 窗口在后台时浏览器会暂停 requestAnimationFrame，用定时器兜底，保证输出照常更新
  const flush = () => {
    if (!c.renderQueued) return
    c.renderQueued = false
    clearTimeout(timer)
    renderOutputs(nb, c)
  }
  const timer = setTimeout(flush, 50)
  requestAnimationFrame(flush)
}

function showInput(nb: Nb, c: Cell, content: Json): void {
  const password = !!content.password
  const prompt = String(content.prompt ?? '')
  const input = h('input', { class: 'dp-input nb-stdin-input', type: password ? 'password' : 'text', 'aria-label': prompt || t('输入') })
  const row = h('div', { class: 'nb-stdin' }, h('span', { class: 'nb-stdin-prompt' }, prompt), input)
  input.addEventListener('keydown', (e) => {
    e.stopPropagation()
    if (e.key !== 'Enter') return
    const value = input.value
    row.remove()
    nb.kernel.input(value)
    addOutput(nb, c, 'stream', { name: 'stdout', text: prompt + (password ? '········' : value) + '\n' })
  })
  c.outputsEl.append(row)
  c.outputsEl.hidden = false
  input.focus()
}

async function runAll(nb: Nb, from = 0): Promise<void> {
  if (!(await nb.kernel.ensure())) return
  for (const c of nb.cells.slice(from)) {
    if (c.type === 'markdown' && c.editing) {
      c.editing = false
      syncCell(nb, c)
      renderInput(nb, c)
    }
    if (c.type === 'code') void execute(nb, c)
  }
}

async function restartKernel(nb: Nb): Promise<void> {
  if (nb.kernel.session === null && nb.kernel.status === 'off') return void nb.kernel.ensure()
  await nb.kernel.restart()
}

function clearAllOutputs(nb: Nb): void {
  let changed = false
  for (const c of nb.cells) {
    if (c.type !== 'code' || (!c.outputs.length && c.execCount === null)) continue
    c.outputs = []
    c.execCount = null
    syncCell(nb, c)
    renderOutputs(nb, c)
    changed = true
  }
  if (changed) touch(nb)
}

/* ---------------- 命令模式快捷键 ---------------- */

function onCommandKey(nb: Nb, e: KeyboardEvent): void {
  const target = e.target as Element
  if (target.closest('.monaco-editor, input, textarea, select, iframe')) return
  if (!nb.loaded) return
  const c = nb.selected ?? nb.cells[0]
  if (!c) return
  const i = nb.cells.indexOf(c)
  const k = e.key
  const ctrl = e.ctrlKey || e.metaKey
  let handled = true
  if (k === 'Enter' && e.shiftKey) void runCell(nb, c, 'next')
  else if (k === 'Enter' && ctrl) void runCell(nb, c, 'stay')
  else if (k === 'Enter' && e.altKey) void runCell(nb, c, 'insert')
  else if (k === 'Enter') editCell(nb, c)
  else if (ctrl || e.altKey) handled = false
  else if (k === 'ArrowUp' || k === 'k') {
    const p = nb.cells[i - 1]
    if (p) (select(nb, p), p.el.focus({ preventScroll: true }))
  } else if (k === 'ArrowDown' || k === 'j') {
    const n = nb.cells[i + 1]
    if (n) (select(nb, n), n.el.focus({ preventScroll: true }))
  } else if (k === 'a') insertCell(nb, 'code', i, false).el.focus({ preventScroll: true })
  else if (k === 'b') insertCell(nb, 'code', i + 1, false).el.focus({ preventScroll: true })
  else if (k === 'm') setType(nb, c, 'markdown')
  else if (k === 'y') setType(nb, c, 'code')
  else if (k === 'r') setType(nb, c, 'raw')
  else if (k === 'z') undoDelete(nb)
  else if (k === 'd') {
    if (performance.now() - nb.lastD < 600) {
      nb.lastD = 0
      deleteCell(nb, c)
    } else nb.lastD = performance.now()
  } else handled = false
  if (handled) {
    e.preventDefault()
    e.stopPropagation()
  }
}

/* ---------------- 输出渲染 ---------------- */

const MAX_TEXT = 200_000

function textBlock(text: string, cls: string): HTMLElement {
  let s = text.replace(/\r/g, '')
  let note: HTMLElement | null = null
  if (s.length > MAX_TEXT) {
    const cut = s.length - MAX_TEXT
    s = s.slice(cut)
    s = s.slice(s.indexOf('\n') + 1)
    note = h('div', { class: 'nb-truncated' }, t('输出过长，只显示最后 {0} KB', Math.round(MAX_TEXT / 1024)))
  }
  const pre = h('pre', { class: cls })
  pre.append(ansi(s))
  return note ? h('div', {}, note, pre) : pre
}

function renderOutputs(nb: Nb, c: Cell): void {
  const stdin = c.outputsEl.querySelector('.nb-stdin')
  const nodes: Node[] = []
  if (c.type === 'code')
    for (const o of c.outputs) {
      try {
        const n = renderOutput(nb, o)
        if (n) nodes.push(h('div', { class: 'nb-output' }, n))
      } catch (e) {
        nodes.push(textBlock(String(e), 'nb-error'))
      }
    }
  c.outputsEl.replaceChildren(...nodes)
  if (stdin) c.outputsEl.append(stdin)
  c.outputsEl.hidden = !c.outputsEl.childElementCount
}

function renderOutput(nb: Nb, o: Output): Node | null {
  switch (o.output_type) {
    case 'stream':
      return textBlock(joinText(o.text), o.name === 'stderr' ? 'nb-stream stderr' : 'nb-stream')
    case 'error': {
      const tb = Array.isArray(o.traceback) && o.traceback.length ? (o.traceback as string[]).join('\n') : `${o.ename}: ${o.evalue}`
      return textBlock(tb, 'nb-error')
    }
    case 'execute_result':
    case 'display_data':
      return renderMime(nb, (o.data ?? {}) as Json, (o.metadata ?? {}) as Json)
    default:
      return null
  }
}

export const MIME_ORDER = ['text/html', 'image/svg+xml', 'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'text/markdown', 'text/latex', 'application/json', 'text/plain']

function renderMime(nb: Nb, data: Json, meta: Json): Node | null {
  const mime = MIME_ORDER.find((m) => m in data)
  if (!mime) {
    const other = Object.keys(data)[0]
    return other ? h('div', { class: 'nb-unsupported' }, t('无法显示的输出类型：{0}', other)) : null
  }
  const v = data[mime]
  const m = (meta[mime] ?? {}) as Json
  const size = (img: HTMLElement) => {
    if (typeof m.width === 'number') img.style.width = m.width + 'px'
    if (typeof m.height === 'number') img.style.height = m.height + 'px'
    return img
  }
  switch (mime) {
    case 'text/html':
      return htmlFrame(joinText(v))
    case 'image/svg+xml':
      return size(h('img', { class: 'nb-img', alt: '', src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(joinText(v))}` }))
    case 'image/png':
    case 'image/jpeg':
    case 'image/gif':
    case 'image/webp':
      return size(h('img', { class: 'nb-img', alt: '', src: `data:${mime};base64,${sanitizeB64(joinText(v))}` }))
    case 'text/markdown':
      return h('div', { class: 'nb-md' }, renderMarkdown(joinText(v), { image: (src, alt) => (/^data:image\//i.test(src) ? h('img', { class: 'nb-img', alt, src }) : document.createTextNode(alt)) }))
    case 'application/json':
      return h('pre', { class: 'nb-stream' }, JSON.stringify(v, null, 2))
    default:
      return textBlock(joinText(v), 'nb-stream')
  }
}

/** iframe 里的样式：跟随当前主题，表格的样式接近 Jupyter */
function frameCss(): string {
  const cs = getComputedStyle(document.documentElement)
  const v = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback
  const text = v('--text', '#ddd')
  const muted = v('--muted', '#999')
  const line = v('--line', '#333')
  const sel = v('--sel', '#222')
  const code = v('--font-code', 'monospace')
  // 和页面的配色方案一致，iframe 才是透明的（不一致时浏览器会给它画上不透明的底色）
  const scheme = document.documentElement.style.colorScheme || 'normal'
  return `
:root{color-scheme:${scheme}}
html,body{margin:0;padding:0;background:transparent;color:${text};font:13px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;overflow-y:hidden}
body{display:flow-root;padding:2px 0}
a{color:${v('--accent', '#6E9BFF')}}
pre,code{font-family:${code};font-size:12.5px}
table{border-collapse:collapse;border-spacing:0;font-size:12.5px;font-variant-numeric:tabular-nums;margin:2px 0}
th,td{padding:4px 10px;text-align:right;border:none;border-bottom:1px solid ${line};white-space:nowrap}
thead th{font-weight:600;border-bottom:1px solid ${muted}}
tbody tr:nth-child(odd){background:${sel}}
tbody tr:hover{background:color-mix(in srgb, ${text} 8%, transparent)}
tbody th{font-weight:600}
img{max-width:100%}
`
}

function htmlFrame(html: string): HTMLElement {
  const frame = h('iframe', { class: 'nb-html', sandbox: 'allow-same-origin', referrerpolicy: 'no-referrer', title: t('HTML 输出') }) as HTMLIFrameElement
  frame.srcdoc = `<!doctype html><html><head><meta charset="utf-8"><style>${frameCss()}</style></head><body>${html}</body></html>`
  let ro: ResizeObserver | null = null
  const fit = () => {
    const d = frame.contentDocument
    if (!d?.body) return
    const root = d.documentElement
    const extra = root.scrollWidth > root.clientWidth + 1 ? 14 : 0
    const height = Math.ceil(d.body.getBoundingClientRect().height) + extra
    frame.style.height = Math.max(height, 18) + 'px'
  }
  frame.addEventListener('load', () => {
    const d = frame.contentDocument
    if (!d) return
    fit()
    ro?.disconnect()
    ro = new ResizeObserver(fit)
    ro.observe(d.body)
    ro.observe(frame)
    // 链接不在 iframe 里跳转：外部网址交给系统浏览器
    d.addEventListener('click', (e) => {
      const a = (e.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null
      if (!a) return
      e.preventDefault()
      const href = a.getAttribute('href') ?? ''
      if (/^https?:\/\//i.test(href)) window.open(href)
    })
  })
  return frame
}

/* ---------------- 接入 ---------------- */

export function initNotebook(): void {
  registerPreviewer((path) => {
    if (!/\.ipynb$/i.test(path)) return false
    openNotebook(path)
    return true
  })
  window.api.jupyter.onEvent((session, ev) => kernelsBySession.get(session)?.handle(ev))
  window.api.jupyter.onExit((session, code, stderr) => kernelsBySession.get(session)?.onExit(code, stderr))
  // 磁盘上的文件变了：没改过的直接重新加载，改过的只提示
  window.api.fs.onChanged((paths) => {
    for (const nb of notebooks) {
      if (!nb.spec.path || !paths.some((x) => samePath(x, nb.spec.path!))) continue
      clearTimeout(nb.reloadTimer)
      nb.reloadTimer = setTimeout(() => void reloadFromDisk(nb), 300)
    }
  })
  // 字体、字号变化
  on('space', () => {
    const f = editorFont()
    for (const nb of notebooks) for (const c of nb.cells) c.editor?.updateOptions(f)
  })
}

async function reloadFromDisk(nb: Nb): Promise<void> {
  const r = await window.api.fs.readFile(nb.spec.path!)
  if (!r.ok || r.content === nb.diskText) return
  if (nb.version !== nb.savedVersion) {
    toast(t('“{0}” 在磁盘上被修改了，保存会覆盖它', basename(nb.spec.path!)))
    return
  }
  try {
    const data = JSON.parse(r.content) as Json
    if (!Array.isArray(data.cells)) return
    apply(nb, data, r.content)
  } catch {
    /* 外部程序可能写到一半，等下一次变化 */
  }
}
