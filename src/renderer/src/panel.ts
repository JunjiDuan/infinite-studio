import { Terminal, type ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { h, toast } from './dom'
import { icons } from './icons'
import { emit, on, persist, state } from './store'
import { resolve } from './theme'
import { t } from './i18n'

interface Session {
  id: number | null
  title: string
  term: Terminal
  fit: FitAddon
  el: HTMLElement
}

const sessions: Session[] = []
let active: Session | null = null
let panel: HTMLElement
let tabsEl: HTMLElement
let bodyEl: HTMLElement
let counter = 0

const MIN_H = 120

/** 终端 ANSI 颜色：和主题一样克制，只在亮度上区分深浅色 */
function xtermTheme(): ITheme {
  const t = resolve(state.settings.space)
  const base: ITheme = {
    background: t.bg,
    foreground: t.text,
    cursor: t.accent,
    cursorAccent: t.bg,
    selectionBackground: t.accent + '40',
    scrollbarSliderBackground: t.muted + '30',
    scrollbarSliderHoverBackground: t.muted + '50',
    scrollbarSliderActiveBackground: t.muted + '70'
  }
  return t.light
    ? {
        ...base,
        black: '#3A3833', red: '#B5432F', green: '#3E7A35', yellow: '#8A6A0F', blue: '#2F5FCC', magenta: '#7A45C2', cyan: '#1F7A76', white: '#8E8A82',
        brightBlack: '#6B6760', brightRed: '#C4553F', brightGreen: '#4D8C43', brightYellow: '#9C7A16', brightBlue: '#3F6FDA', brightMagenta: '#8A55D0', brightCyan: '#2A8A85', brightWhite: '#1D1C1A'
      }
    : {
        ...base,
        black: '#2A2A2E', red: '#E5786D', green: '#8FBF7F', yellow: '#D9B867', blue: '#7FA6E8', magenta: '#C49BE0', cyan: '#6FC2BD', white: '#D6D3CC',
        brightBlack: '#6E6D73', brightRed: '#F08E84', brightGreen: '#A5D394', brightYellow: '#E8CB80', brightBlue: '#98BAF2', brightMagenta: '#D4B1EC', brightCyan: '#88D3CE', brightWhite: '#F2F0EB'
      }
}

function termFont(): { fontFamily: string; fontSize: number } {
  const t = resolve(state.settings.space)
  return { fontFamily: t.fontCss, fontSize: Math.max(11, state.settings.space.size - 1) }
}

export function createPanel(): HTMLElement {
  tabsEl = h('div', { class: 'panel-tabs', role: 'tablist', 'aria-label': t('终端') })
  bodyEl = h('div', { class: 'panel-body' })
  const resizer = h('div', { class: 'panel-resizer', role: 'separator', 'aria-orientation': 'horizontal', 'aria-label': t('拖动调整终端高度') })
  panel = h(
    'section',
    { class: 'panel', 'aria-label': t('终端面板') },
    resizer,
    h(
      'div',
      { class: 'panel-head' },
      h('span', { class: 'panel-title' }, t('终端')),
      tabsEl,
      h('span', { class: 'grow' }),
      h('button', { class: 'icon-btn small', 'aria-label': t('新建终端 (Ctrl Shift `)'), title: t('新建终端 Ctrl Shift `'), html: icons.plus, onClick: () => void newTerminal() }),
      h('button', { class: 'icon-btn small', 'aria-label': t('结束当前终端'), title: t('结束终端'), html: icons.trash, onClick: () => active && killSession(active) }),
      h('button', { class: 'icon-btn small', 'aria-label': t('隐藏面板 (Ctrl `)'), title: t('隐藏 Ctrl `'), html: icons.close, onClick: () => setPanelOpen(false) })
    ),
    bodyEl
  )
  panel.style.height = `${state.settings.panelHeight ?? 260}px`
  setupResize(resizer)

  new ResizeObserver(() => fitActive()).observe(bodyEl)
  window.api.term.onData((id, data) => sessions.find((s) => s.id === id)?.term.write(data))
  window.api.term.onExit((id) => {
    const s = sessions.find((x) => x.id === id)
    if (s) removeSession(s)
  })
  on('space', () => {
    for (const s of sessions) {
      s.term.options.theme = xtermTheme()
      Object.assign(s.term.options, termFont())
    }
    fitActive()
  })
  return panel
}

function setupResize(handle: HTMLElement): void {
  handle.addEventListener('mousedown', (e) => {
    e.preventDefault()
    const startY = e.clientY
    const startH = panel.offsetHeight
    const max = () => (panel.parentElement?.clientHeight ?? 600) - 120
    document.body.classList.add('resizing-v')
    const move = (ev: MouseEvent) => {
      panel.style.height = `${Math.round(Math.min(max(), Math.max(MIN_H, startH + startY - ev.clientY)))}px`
    }
    const up = () => {
      document.body.classList.remove('resizing-v')
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      state.settings.panelHeight = panel.offsetHeight
      persist()
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  })
}

function fitActive(): void {
  if (!active || !state.panelOpen || !bodyEl.clientHeight) return
  try {
    active.fit.fit()
  } catch {
    // 面板隐藏时尺寸为 0，忽略
  }
}

function renderTabs(): void {
  tabsEl.replaceChildren(
    ...sessions.map((s) =>
      h(
        'button',
        { class: 'panel-tab' + (s === active ? ' on' : ''), role: 'tab', 'aria-selected': String(s === active), onClick: () => activate(s) },
        s.title
      )
    )
  )
}

function activate(s: Session): void {
  active = s
  for (const x of sessions) x.el.hidden = x !== s
  renderTabs()
  requestAnimationFrame(() => {
    fitActive()
    s.term.focus()
  })
}

function removeSession(s: Session): void {
  const i = sessions.indexOf(s)
  if (i < 0) return
  sessions.splice(i, 1)
  s.term.dispose()
  s.el.remove()
  if (active === s) {
    active = null
    const next = sessions[i] ?? sessions[i - 1]
    if (next) activate(next)
  }
  renderTabs()
  if (!sessions.length) setPanelOpen(false)
}

function killSession(s: Session): void {
  if (s.id !== null) window.api.term.kill(s.id)
  removeSession(s)
}

/** 把 Ctrl C / Ctrl V 变成复制粘贴（有选中内容时），其余按键交给 shell */
function keyHandler(term: Terminal) {
  return (e: KeyboardEvent): boolean => {
    if (e.type !== 'keydown') return true
    const k = e.key.toLowerCase()
    if (e.ctrlKey && k === 'c' && term.hasSelection()) {
      void navigator.clipboard.writeText(term.getSelection())
      term.clearSelection()
      return false
    }
    if (e.ctrlKey && k === 'v') {
      e.preventDefault()
      void navigator.clipboard.readText().then((t) => term.paste(t))
      return false
    }
    return true
  }
}

export interface TermHandle {
  /** 向终端输入文字 */
  write(data: string): void
  /** 显示面板并切到这个终端 */
  focus(): void
  alive(): boolean
  /** 交互式程序界面画完、输出安静下来后 resolve */
  ready: Promise<void>
}

/** 新建终端。opts.run 会在 shell 启动后自动输入执行；opts.title 替换标签名 */
export async function newTerminal(cwd?: string, opts: { title?: string; run?: string } = {}): Promise<TermHandle | null> {
  setPanelOpen(true)
  const el = h('div', { class: 'term-host' })
  bodyEl.append(el)
  const term = new Terminal({
    ...termFont(),
    theme: xtermTheme(),
    cursorBlink: true,
    cursorStyle: 'bar',
    scrollback: 5000,
    allowProposedApi: false,
    lineHeight: 1.2,
    macOptionIsMeta: true
  })
  const fit = new FitAddon()
  term.loadAddon(fit)
  term.open(el)
  term.attachCustomKeyEventHandler(keyHandler(term))
  ++counter
  const s: Session = { id: null, title: opts.title ?? t('终端 {0}', counter), term, fit, el }
  sessions.push(s)
  activate(s)
  try {
    fit.fit()
  } catch {
    /* 尺寸稍后由 ResizeObserver 修正 */
  }
  try {
    const r = await window.api.term.create({ cwd: cwd ?? state.root ?? undefined, cols: term.cols, rows: term.rows })
    s.id = r.id
    if (!opts.title) s.title = `${r.shell} ${counter}`
    renderTabs()
    term.onData((d) => window.api.term.write(r.id, d))
    term.onResize(({ cols, rows }) => window.api.term.resize(r.id, cols, rows))
    window.api.term.resize(r.id, term.cols, term.rows)
    if (opts.run) window.api.term.write(r.id, opts.run + '\r')
  } catch (e) {
    term.write('\x1b[31m' + t('无法启动终端：{0}', String(e)) + '\x1b[0m\r\n')
    toast(t('无法启动终端'))
    return null
  }

  // 就绪判断：启动 2.5 秒之后，输出安静 1.5 秒（交互式 CLI 画完界面）
  const started = Date.now()
  const ready = new Promise<void>((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const arm = () => {
      clearTimeout(timer)
      timer = setTimeout(() => (Date.now() - started > 2500 ? (sub.dispose(), resolve()) : arm()), 1500)
    }
    const sub = term.onWriteParsed(arm)
    arm()
  })

  return {
    write: (d) => {
      if (s.id !== null) window.api.term.write(s.id, d)
    },
    focus: () => {
      setPanelOpen(true)
      activate(s)
    },
    alive: () => sessions.includes(s),
    ready
  }
}

export function isPanelOpen(): boolean {
  return state.panelOpen
}

export function setPanelOpen(open: boolean): void {
  if (state.panelOpen === open) return
  state.panelOpen = open
  emit('layout')
  if (open) requestAnimationFrame(() => {
    fitActive()
    active?.term.focus()
  })
}

/** Ctrl `：没有终端就新建一个；有就显示 / 隐藏 */
export function togglePanel(): void {
  if (!state.panelOpen && !sessions.length) void newTerminal()
  else setPanelOpen(!state.panelOpen)
}

export function killAll(): void {
  for (const s of [...sessions]) killSession(s)
}
