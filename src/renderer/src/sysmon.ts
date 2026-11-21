import type { SysGpu, SysSample } from '../../shared/types'
import { h } from './dom'
import { icons } from './icons'
import { t } from './i18n'

/**
 * 侧栏的系统监视器：处理器、内存、显卡、NPU、磁盘、网络，以及本 IDE 自己的进程。
 * 只在视图可见、窗口没最小化时向主进程订阅采样，看不见就停。
 */

const HISTORY = 60
const history = new Map<string, number[]>()
const collapsed = new Set<string>(JSON.parse(localStorage.getItem('sysmon.collapsed') ?? '[]') as string[])

let viewEl: HTMLElement
let bodyEl: HTMLElement
let pauseBtn: HTMLButtonElement
let unsubscribe: (() => void) | null = null
let visible = false
let paused = false
let last: SysSample | null = null
const sections = new Map<string, Section>()

/* ---------------- 格式化 ---------------- */

function bytes(n: number | null | undefined, digits = 1): string {
  if (n == null) return '—'
  const u = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024
    i++
  }
  return `${n.toFixed(i === 0 ? 0 : n >= 100 ? 0 : digits)} ${u[i]}`
}

const rate = (n: number | null | undefined): string => (n == null ? '—' : bytes(n) + '/s')

function bits(n: number): string {
  if (n >= 1e9) return `${+(n / 1e9).toFixed(1)} Gbps`
  if (n >= 1e6) return `${Math.round(n / 1e6)} Mbps`
  return `${Math.round(n / 1e3)} Kbps`
}

function pct(n: number | null | undefined, digits = 0): string {
  if (n == null) return '—'
  // 很小但不为零的占用（24 核机器上的空闲进程）不要显示成 0
  if (n > 0 && n < Math.pow(10, -digits)) return `<${Math.pow(10, -digits)}%`
  return `${n.toFixed(digits)}%`
}

function ghz(mhz: number | null): string {
  return mhz == null || !mhz ? '—' : `${(mhz / 1000).toFixed(2)} GHz`
}

function duration(sec: number): string {
  const d = Math.floor(sec / 86400)
  const hh = Math.floor((sec % 86400) / 3600)
  const mm = Math.floor((sec % 3600) / 60)
  const ss = Math.floor(sec % 60)
  const clock = `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`
  return d ? t('{0} 天 {1}', d, clock) : clock
}

const ENGINE_NAMES: Record<string, string> = {
  '3D': '3D',
  Copy: '复制',
  Compute: '计算',
  Neural: '神经网络',
  VideoDecode: '视频解码',
  VideoEncode: '视频编码',
  VideoProcessing: '视频处理',
  Security: '安全',
  GSC: 'GSC',
  VR: 'VR'
}
const engineName = (k: string): string => (ENGINE_NAMES[k] ? t(ENGINE_NAMES[k]) : k.replace(/_/g, ' '))

/* ---------------- 历史与小图 ---------------- */

function push(key: string, v: number): void {
  let a = history.get(key)
  if (!a) history.set(key, (a = []))
  a.push(v)
  if (a.length > HISTORY) a.shift()
}

const SVG = 'http://www.w3.org/2000/svg'
function svgEl<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string> = {}): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG, tag)
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v)
  return el
}

/**
 * 最近 60 秒的面积图。纵轴固定 0–100%（不随数据缩放，避免小波动看着像暴涨）；
 * 悬停时显示十字线和那一秒的数值。
 */
class Spark {
  el: HTMLElement
  private area = svgEl('path', { class: 'sm-spark-area' })
  private line = svgEl('path', { class: 'sm-spark-line' })
  private cross = h('div', { class: 'sm-spark-cross', hidden: true })
  private tip = h('div', { class: 'sm-spark-tip', hidden: true })
  private hoverX: number | null = null

  constructor(
    private key: string,
    private label: string,
    private fmt: (v: number) => string = (v) => pct(v)
  ) {
    const svg = svgEl('svg', { viewBox: `0 0 ${HISTORY - 1} 100`, preserveAspectRatio: 'none', 'aria-hidden': 'true' })
    for (const y of [25, 50, 75]) svg.append(svgEl('line', { class: 'sm-spark-grid', x1: '0', x2: String(HISTORY - 1), y1: String(y), y2: String(y) }))
    svg.append(this.area, this.line)
    this.el = h('div', { class: 'sm-spark', role: 'img', 'aria-label': label }, svg, this.cross, this.tip)
    this.el.addEventListener('mousemove', (e) => {
      this.hoverX = e.clientX - this.el.getBoundingClientRect().left
      this.renderHover()
    })
    this.el.addEventListener('mouseleave', () => {
      this.hoverX = null
      this.renderHover()
    })
  }

  update(): void {
    const a = history.get(this.key) ?? []
    const off = HISTORY - a.length
    const pts = a.map((v, i) => `${off + i},${(100 - Math.max(0, Math.min(100, v))).toFixed(2)}`)
    if (pts.length < 2) {
      this.line.setAttribute('d', '')
      this.area.setAttribute('d', '')
    } else {
      this.line.setAttribute('d', 'M' + pts.join('L'))
      this.area.setAttribute('d', `M${off},100L${pts.join('L')}L${HISTORY - 1},100Z`)
    }
    const v = a[a.length - 1]
    this.el.setAttribute('aria-label', v == null ? this.label : `${this.label} ${this.fmt(v)}`)
    this.renderHover()
  }

  private renderHover(): void {
    const a = history.get(this.key) ?? []
    const w = this.el.clientWidth
    if (this.hoverX == null || !a.length || !w) {
      this.cross.hidden = this.tip.hidden = true
      return
    }
    const slot = Math.round((this.hoverX / w) * (HISTORY - 1))
    const i = slot - (HISTORY - a.length)
    if (i < 0) {
      this.cross.hidden = this.tip.hidden = true
      return
    }
    const x = (slot / (HISTORY - 1)) * w
    const ago = a.length - 1 - i
    this.cross.hidden = this.tip.hidden = false
    this.cross.style.left = `${x}px`
    this.tip.textContent = `${ago ? t('{0} 秒前', ago) : t('现在')} · ${this.fmt(a[i])}`
    // 提示框靠近哪边就往另一边放，不出界
    this.tip.style.left = x > w / 2 ? '' : `${x + 6}px`
    this.tip.style.right = x > w / 2 ? `${w - x + 6}px` : ''
  }
}

/* ---------------- 小部件 ---------------- */

function meter(value: number | null, label: string): HTMLElement {
  const v = value == null ? 0 : Math.max(0, Math.min(100, value))
  return h(
    'div',
    { class: 'sm-meter', role: 'meter', 'aria-label': label, 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(Math.round(v)) },
    h('div', { class: 'sm-meter-fill', style: { width: `${v}%` } })
  )
}

/** 带标签、数值和进度条的一行（显存、分区容量、引擎占用） */
function barRow(label: string, valueText: string, value: number | null, title?: string): HTMLElement {
  return h(
    'div',
    { class: 'sm-bar-row', title: title ?? null },
    h('div', { class: 'sm-bar-top' }, h('span', { class: 'sm-k' }, label), h('span', { class: 'sm-v' }, valueText)),
    meter(value, label)
  )
}

/** 两列的“名称 数值”表 */
function kv(rows: [string, string | null | false][]): HTMLElement {
  const el = h('dl', { class: 'sm-kv' })
  for (const [k, v] of rows) if (v != null && v !== false) el.append(h('dt', {}, k), h('dd', {}, v))
  return el
}

class Section {
  el: HTMLElement
  head: HTMLElement
  private bigEl = h('span', { class: 'sm-big' })
  private subEl = h('span', { class: 'sm-sub' })
  spark: Spark | null
  /** 小图下方每次重新渲染的内容 */
  detail = h('div', { class: 'sm-detail' })

  constructor(
    public key: string,
    title: string,
    opts: { spark?: Spark | null; icon?: string } = {}
  ) {
    this.spark = opts.spark ?? null
    this.head = h(
      'div',
      {
        class: 'sm-head',
        role: 'button',
        tabindex: '0',
        'aria-expanded': String(!collapsed.has(key)),
        onClick: () => this.toggle(),
        onKeydown: (e: KeyboardEvent) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            this.toggle()
          }
        }
      },
      h('span', { class: 'chev', html: icons.chevron }),
      h('span', { class: 'sm-title', title }, title),
      h('span', { class: 'grow' }),
      this.bigEl
    )
    this.el = h(
      'section',
      { class: 'sm-sec' + (collapsed.has(key) ? ' collapsed' : '') },
      this.head,
      h('div', { class: 'sm-body' }, this.subEl, this.spark?.el ?? null, this.detail)
    )
  }

  toggle(): void {
    const c = this.el.classList.toggle('collapsed')
    this.head.setAttribute('aria-expanded', String(!c))
    if (c) collapsed.add(this.key)
    else collapsed.delete(this.key)
    localStorage.setItem('sysmon.collapsed', JSON.stringify([...collapsed]))
  }

  set(big: string, sub: string, ...detail: (HTMLElement | null)[]): void {
    this.bigEl.textContent = big
    this.subEl.textContent = sub
    this.subEl.hidden = !sub
    this.spark?.update()
    // 折叠时不渲染细节，省点力气
    if (!this.el.classList.contains('collapsed') || !this.detail.childElementCount) this.detail.replaceChildren(...detail.filter((d): d is HTMLElement => !!d))
  }
}

function section(key: string, title: string, sparkLabel?: string, fmt?: (v: number) => string): Section {
  let s = sections.get(key)
  if (!s) {
    s = new Section(key, title, { spark: sparkLabel ? new Spark(key, sparkLabel, fmt) : null })
    sections.set(key, s)
  }
  return s
}

/* ---------------- 各部分 ---------------- */

/** 每个逻辑处理器一个小格子，颜色深浅表示占用 */
let coreGrid: HTMLElement | null = null
let coreCells: HTMLElement[] = []
function cores(values: number[]): HTMLElement {
  if (!coreGrid || coreCells.length !== values.length) {
    coreCells = values.map(() => h('div', { class: 'sm-core' }, h('div', { class: 'sm-core-fill' })))
    coreGrid = h('div', { class: 'sm-cores', role: 'group', 'aria-label': t('每个逻辑处理器的占用') }, ...coreCells)
  }
  values.forEach((v, i) => {
    const c = coreCells[i]
    ;(c.firstChild as HTMLElement).style.height = `${Math.max(0, Math.min(100, v))}%`
    const label = t('CPU {0}：{1}', i, pct(v))
    c.title = label
    c.setAttribute('aria-label', label)
  })
  return coreGrid
}

function renderCpu(s: SysSample): Section {
  const c = s.cpu
  const sec = section('cpu', t('处理器'), t('处理器占用'))
  sec.set(
    pct(c.usage),
    c.model,
    cores(c.cores),
    kv([
      [t('速度'), c.curMHz != null ? `${ghz(c.curMHz)}` : ghz(c.baseMHz)],
      [t('基准速度'), ghz(c.baseMHz)],
      [t('逻辑处理器'), String(c.logical)],
      [t('进程'), c.processes != null ? c.processes.toLocaleString() : null],
      [t('线程'), c.threads != null ? c.threads.toLocaleString() : null],
      [t('句柄'), c.handles != null ? c.handles.toLocaleString() : null],
      [t('温度'), c.temp != null ? `${c.temp.toFixed(0)} °C` : null],
      [t('平均负载'), c.load ? c.load.map((x) => x.toFixed(2)).join(' / ') : null],
      [t('正常运行时间'), duration(s.os.uptime)]
    ])
  )
  return sec
}

function renderMem(s: SysSample): Section {
  const m = s.mem
  const used = m.total - m.free
  const sec = section('mem', t('内存'), t('内存占用'))
  sec.set(
    pct((used / m.total) * 100),
    `${bytes(used)} / ${bytes(m.total)}`,
    kv([
      [t('使用中'), bytes(used)],
      [t('可用'), bytes(m.free)],
      [t('已提交'), m.committed != null && m.commitLimit != null ? `${bytes(m.committed)} / ${bytes(m.commitLimit)}` : null],
      [t('已缓存'), m.standby != null ? bytes(m.standby + (m.modified ?? 0)) : null],
      [t('分页缓冲池'), m.paged != null ? bytes(m.paged) : null],
      [t('非分页缓冲池'), m.nonpaged != null ? bytes(m.nonpaged) : null],
      [s.os.platform === 'win32' ? t('页面文件') : t('交换空间'), m.pagefile != null ? pct(m.pagefile, 1) : null]
    ])
  )
  return sec
}

/** 常用的几类引擎总是显示，其余只在有占用时显示 */
const ALWAYS_ENGINES = ['3D', 'Copy', 'Compute', 'VideoDecode', 'VideoEncode', 'Neural']

function renderGpu(g: SysGpu, index: number, npuIndex: number): Section {
  const key = `gpu:${g.id}`
  const kind = g.npu ? `NPU ${npuIndex}` : `GPU ${index}`
  const sec = section(key, `${kind} · ${g.name}`, t('{0} 占用', kind))
  // 顺序固定（不按占用排序），每秒刷新时各行不会跳来跳去
  const rank = (k: string): number => (ALWAYS_ENGINES.includes(k) ? ALWAYS_ENGINES.indexOf(k) : ALWAYS_ENGINES.length)
  const engines = Object.entries(g.engines)
    .filter(([k, v]) => v >= 0.5 || ALWAYS_ENGINES.includes(k))
    .sort((a, b) => rank(a[0]) - rank(b[0]) || a[0].localeCompare(b[0]))
  const rows: HTMLElement[] = engines.map(([k, v]) => barRow(engineName(k), pct(v, v < 10 && v > 0 ? 1 : 0), v))
  const mem: HTMLElement[] = []
  if (g.dedicatedTotal > 0 && g.dedicatedUsed != null)
    mem.push(barRow(g.npu ? t('专用内存') : t('专用显存'), `${bytes(g.dedicatedUsed)} / ${bytes(g.dedicatedTotal)}`, (g.dedicatedUsed / g.dedicatedTotal) * 100))
  if (g.sharedTotal > 0 && g.sharedUsed != null)
    mem.push(barRow(t('共享内存'), `${bytes(g.sharedUsed)} / ${bytes(g.sharedTotal)}`, (g.sharedUsed / g.sharedTotal) * 100))
  const sub = [
    g.dedicatedTotal > 0 && g.dedicatedUsed != null ? `${bytes(g.dedicatedUsed)} / ${bytes(g.dedicatedTotal)}` : g.sharedUsed != null ? t('共享 {0}', bytes(g.sharedUsed)) : '',
    g.temp != null ? `${g.temp.toFixed(0)} °C` : ''
  ]
    .filter(Boolean)
    .join(' · ')
  sec.set(
    pct(g.util),
    sub,
    rows.length ? h('div', { class: 'sm-group' }, h('div', { class: 'sm-label' }, t('引擎')), h('div', { class: 'sm-engines' }, ...rows)) : null,
    mem.length ? h('div', { class: 'sm-group' }, h('div', { class: 'sm-label' }, g.npu ? t('内存') : t('显存')), ...mem) : null,
    g.temp != null ? kv([[t('温度'), `${g.temp.toFixed(0)} °C`]]) : null
  )
  return sec
}

function renderDisks(s: SysSample): Section | null {
  if (!s.disks.length) return null
  const sec = section('disk', t('磁盘'))
  const maxActive = Math.max(...s.disks.map((d) => d.active ?? 0))
  sec.set(
    pct(maxActive),
    '',
    ...s.disks.map((d) =>
      h(
        'div',
        { class: 'sm-group' },
        h('div', { class: 'sm-label' }, t('磁盘 {0}', d.name)),
        barRow(t('活动时间'), pct(d.active), d.active),
        kv([
          [t('读取'), rate(d.read)],
          [t('写入'), rate(d.write)]
        ]),
        ...d.volumes.map((v) => barRow(v.mount, t('{0} 可用，共 {1}', bytes(v.free), bytes(v.total)), ((v.total - v.free) / v.total) * 100))
      )
    )
  )
  return sec
}

function renderNets(s: SysSample): Section | null {
  if (!s.nets.length) return null
  const sec = section('net', t('网络'))
  const rx = s.nets.reduce((a, n) => a + n.rx, 0)
  const tx = s.nets.reduce((a, n) => a + n.tx, 0)
  sec.set(
    `↓ ${rate(rx)}`,
    '',
    ...s.nets.map((n) =>
      h(
        'div',
        { class: 'sm-group' },
        h('div', { class: 'sm-label', title: n.name }, n.name),
        kv([
          [t('接收'), rate(n.rx)],
          [t('发送'), rate(n.tx)],
          [t('链路速度'), n.bandwidth ? bits(n.bandwidth) : null]
        ])
      )
    ),
    s.nets.length > 1 ? kv([[t('总计发送'), rate(tx)]]) : null
  )
  return sec
}

const PROC_TYPES: Record<string, string> = {
  Browser: '主进程',
  Tab: '窗口',
  GPU: 'GPU 进程',
  Utility: '工具进程',
  Zygote: 'Zygote',
  'Sandbox helper': '沙盒',
  'Pepper Plugin': '插件'
}

function renderApp(s: SysSample): Section {
  const a = s.app
  const sec = section('app', t('本 IDE'))
  const list = h('div', { class: 'sm-procs' })
  for (const p of a.procs) {
    const name = PROC_TYPES[p.type] ? t(PROC_TYPES[p.type]) : p.type
    const extra = p.type === 'Utility' && p.name && p.name !== p.type ? ` · ${p.name}` : ''
    list.append(
      h(
        'div',
        { class: 'sm-proc', title: `PID ${p.pid}` },
        h('span', { class: 'sm-proc-name' }, name + extra),
        h('span', { class: 'sm-proc-cpu' }, pct(p.cpu, 1)),
        h('span', { class: 'sm-proc-mem' }, bytes(p.mem))
      )
    )
  }
  sec.set(
    bytes(a.mem),
    t('{0} 个进程 · 处理器 {1}', a.procs.length, pct(a.cpu, 1)),
    h(
      'div',
      { class: 'sm-group' },
      h('div', { class: 'sm-proc sm-proc-head' }, h('span', { class: 'sm-proc-name' }, t('进程')), h('span', { class: 'sm-proc-cpu' }, t('处理器')), h('span', { class: 'sm-proc-mem' }, t('内存'))),
      list
    )
  )
  return sec
}

/* ---------------- 渲染与订阅 ---------------- */

function onSample(s: SysSample): void {
  last = s
  push('cpu', s.cpu.usage)
  push('mem', ((s.mem.total - s.mem.free) / s.mem.total) * 100)
  for (const g of s.gpus) if (g.util != null) push(`gpu:${g.id}`, g.util)
  if (!paused) render()
}

function render(): void {
  const s = last
  if (!s) {
    bodyEl.replaceChildren(h('div', { class: 'sm-empty muted' }, t('正在读取系统信息…')))
    return
  }
  const order: Section[] = [renderCpu(s), renderMem(s)]
  // 独立显卡（有专用显存的）排在前面，NPU 放在显卡之后
  const gpus = s.gpus.filter((g) => !g.npu).sort((a, b) => b.dedicatedTotal - a.dedicatedTotal)
  const npus = s.gpus.filter((g) => g.npu)
  gpus.forEach((g, i) => order.push(renderGpu(g, i, 0)))
  npus.forEach((g, i) => order.push(renderGpu(g, 0, i)))
  const disk = renderDisks(s)
  if (disk) order.push(disk)
  const net = renderNets(s)
  if (net) order.push(net)
  order.push(renderApp(s))
  const extra: HTMLElement[] = []
  if (!s.gpus.length && s.cpu.processes == null) extra.push(h('div', { class: 'sm-empty muted' }, t('正在读取显卡、磁盘和网络信息…')))
  else if (s.os.platform === 'win32' && !npus.length) extra.push(h('div', { class: 'sm-note muted' }, t('没有检测到 NPU')))

  // 只在结构变化时重排，避免打断悬停和焦点
  const want = [...order.map((o) => o.el), ...extra]
  const cur = [...bodyEl.children]
  if (want.length !== cur.length || want.some((el, i) => el !== cur[i])) bodyEl.replaceChildren(...want)
  // 不再出现的设备（拔掉的外接显卡）丢掉缓存
  const live = new Set(order.map((o) => o.key))
  for (const k of [...sections.keys()]) if (!live.has(k)) sections.delete(k)
}

function sync(): void {
  const want = visible && !document.hidden
  if (want && !unsubscribe) {
    unsubscribe = window.api.sysmon.subscribe(onSample)
    render()
  } else if (!want && unsubscribe) {
    unsubscribe()
    unsubscribe = null
  }
}

/** 侧栏切到/离开监视器视图时由主界面调用 */
export function setSysmonVisible(v: boolean): void {
  if (v === visible) return
  visible = v
  sync()
}

function setPaused(p: boolean): void {
  paused = p
  pauseBtn.innerHTML = p ? icons.play : icons.dbgPause
  pauseBtn.setAttribute('aria-label', p ? t('继续刷新') : t('暂停刷新'))
  pauseBtn.title = p ? t('继续刷新') : t('暂停刷新')
  pauseBtn.classList.toggle('on', p)
  if (!p) render()
}

export function createSysmonView(): HTMLElement {
  pauseBtn = h('button', { class: 'icon-btn small', onClick: () => setPaused(!paused) })
  bodyEl = h('div', { class: 'sm-list' })
  viewEl = h(
    'div',
    { class: 'side-view', 'data-view': 'monitor' },
    h('div', { class: 'side-head' }, h('span', { class: 'side-title' }, t('系统监视器')), h('div', { class: 'side-actions sm-actions' }, pauseBtn)),
    bodyEl
  )
  setPaused(false)
  document.addEventListener('visibilitychange', sync)
  return viewEl
}
