import type { FontId, Space, ThemeId } from '../../shared/types'
import { h, toast } from './dom'
import { icons } from './icons'
import { monaco } from './monaco'
import { MAX_SIZE, MIN_SIZE, emit, on, persist, saveSettings, setSpace, state } from './store'
import { ACCENTS, FONTS, THEMES, readableAccent } from './theme'
import { viewTransition } from './motion'
import { refreshAgentContext } from './chat'
import { getLocale, saveLocale, t, type Locale } from './i18n'
import { anyDirty } from './editor'

/** 设置页的两大类 */
export type SettingsPane = 'system' | 'appearance' | 'language'
const PANES: [SettingsPane, string, string, string?][] = [
  ['system', t('系统设置'), t('编辑器、AI 助手、窗口与数据')],
  ['appearance', t('个性化与主题'), t('主题与字体')],
  ['language', t('多语言设置'), t('界面显示语言')]
]

const SHORTCUTS: [string, string][] = [
  [t('命令面板'), 'Ctrl K'],
  [t('在文件中搜索'), 'Ctrl Shift F'],
  [t('源代码管理'), 'Ctrl Shift G'],
  [t('显示 / 隐藏侧栏'), 'Ctrl B'],
  [t('显示 / 隐藏终端'), 'Ctrl `'],
  [t('专注模式'), 'Ctrl .'],
  [t('保存'), 'Ctrl S'],
  [t('关闭标签'), 'Ctrl W'],
  [t('切换标签'), 'Ctrl Tab'],
  [t('移动标签'), 'Ctrl Shift PgUp / PgDn'],
  [t('向右拆分编辑器'), 'Ctrl \\'],
  [t('自动换行'), 'Alt Z'],
  [t('个性化与主题'), 'Ctrl ,']
]

const LANGS: [Locale, string, string][] = [
  ['zh', '简体中文', 'Chinese (Simplified)'],
  ['en', 'English', '英语']
]

/** 切换界面语言：记下设置后重新加载窗口 */
export async function switchLocale(l: Locale): Promise<void> {
  if (l === getLocale()) return
  if (anyDirty() && !confirm(t('有未保存的修改。切换语言需要重新加载窗口，未保存的修改会丢失。仍然切换吗？'))) return
  saveLocale(l)
  state.settings.locale = l
  await saveSettings().catch(() => {})
  window.api.win.reload()
}

let page: HTMLElement | null = null
let host: HTMLElement
let preview: monaco.editor.IStandaloneCodeEditor | null = null
let previewFrame: HTMLElement
let sizeInput: HTMLInputElement
let sizeLabel: HTMLElement
let customColor: HTMLInputElement
let wrapInput: HTMLInputElement
let ctxInput: HTMLInputElement
let navEl: HTMLElement
let navInk: HTMLElement
let sysInfo: { recents: HTMLElement; sizes: HTMLElement }
let pane: SettingsPane = 'appearance'
let onClose: () => void = () => {}

export function initSettings(container: HTMLElement, closed: () => void): void {
  host = container
  onClose = closed
  on('space', sync)
  on('root', () => page && sync())
}

export function isSettingsOpen(): boolean {
  return page !== null && !page.hidden
}

let closeTimer: ReturnType<typeof setTimeout> | undefined

export function openSettings(which: SettingsPane = pane): void {
  if (!page) build()
  showPane(which)
  clearTimeout(closeTimer)
  page!.classList.remove('leaving')
  page!.hidden = false
  sync()
  requestAnimationFrame(() => preview?.layout())
  ;(page!.querySelector('[aria-pressed="true"]') as HTMLElement | null)?.focus()
}

/** 切换设置分类：内容区换页，左侧指示条滑到对应按钮 */
function showPane(which: SettingsPane): void {
  pane = which
  if (!page) return
  page.querySelectorAll<HTMLElement>('.set-pane').forEach((el) => (el.hidden = el.dataset.pane !== which))
  let target: HTMLElement | null = null
  navEl.querySelectorAll<HTMLElement>('.set-nav-btn').forEach((b) => {
    const on = b.dataset.pane === which
    b.classList.toggle('on', on)
    b.setAttribute('aria-current', on ? 'page' : 'false')
    if (on) target = b
  })
  const panes = page.querySelector<HTMLElement>('.set-panes')
  if (panes) panes.scrollTop = 0
  page.scrollTop = 0
  requestAnimationFrame(() => {
    const t = target as HTMLElement | null
    if (!t) return
    navInk.style.transform = `translateY(${t.offsetTop}px)`
    navInk.style.height = `${t.offsetHeight}px`
    navInk.classList.add('show')
    if (which === 'appearance') preview?.layout()
  })
}

export function closeSettings(): void {
  if (!page || page.hidden || page.classList.contains('leaving')) return
  const el = page
  el.classList.add('leaving')
  closeTimer = setTimeout(() => {
    el.hidden = true
    el.classList.remove('leaving')
  }, 180)
  onClose()
}

function section(title: string, ...body: (Node | null)[]): HTMLElement {
  const id = 'sec-' + Math.random().toString(36).slice(2, 8)
  return h('section', { class: 'set-section', 'aria-labelledby': id }, h('h2', { id }, title), ...body)
}

function option<K extends keyof Space>(key: K, value: Space[K], cls: string, ...children: (Node | string)[]): HTMLButtonElement {
  return h(
    'button',
    {
      class: 'opt ' + cls,
      'data-k': key,
      'data-v': String(value),
      'aria-pressed': 'false',
      onClick: (e: MouseEvent) => {
        const patch = { [key]: value } as Partial<Space>
        // 换主题：新配色从点击处圆形扩散开
        if (key === 'theme' && state.settings.space.theme !== value) viewTransition(() => setSpace(patch), { reveal: { x: e.clientX, y: e.clientY } })
        else setSpace(patch)
      }
    },
    ...children
  )
}

function build(): void {
  const themes = h(
    'div',
    { class: 'grid3 grid4' },
    ...(Object.keys(THEMES) as ThemeId[]).map((id) => {
      const p = THEMES[id]
      return option(
        'theme',
        id,
        'theme-card',
        h(
          'span',
          { class: 'theme-swatch', style: { background: p.bg } },
          h('span', { style: { width: '60%', background: p.text } }),
          h('span', { style: { width: '40%', background: p.muted } }),
          h('span', { class: 'acc', style: { width: '25%' } })
        ),
        h('span', { class: 'opt-label' }, p.label)
      )
    })
  )

  customColor = h('input', {
    type: 'color',
    class: 'color-input',
    'aria-label': t('自定义强调色'),
    title: t('自定义颜色'),
    onInput: () => setSpace({ accent: customColor.value.toUpperCase() })
  })
  const accents = h(
    'div',
    { class: 'swatches' },
    ...ACCENTS.map((a) => {
      const b = option('accent', a.hex, 'swatch', h('span', { class: 'swatch-dot', 'data-hex': a.hex }))
      b.setAttribute('aria-label', t('强调色：') + a.name)
      b.title = a.name
      return b
    }),
    h('label', { class: 'custom-color' }, customColor, h('span', {}, t('自定义')))
  )

  const fonts = h(
    'div',
    { class: 'grid3' },
    ...(Object.keys(FONTS) as FontId[]).map((id) =>
      option('font', id, 'font-card', h('span', { class: 'font-sample', style: { fontFamily: FONTS[id].css } }, '0O 1lI {}'), h('span', { class: 'opt-sub' }, FONTS[id].name))
    )
  )

  sizeLabel = h('span', { class: 'size-value' })
  sizeInput = h('input', {
    id: 'font-size',
    type: 'range',
    min: String(MIN_SIZE),
    max: String(MAX_SIZE),
    step: '1',
    onInput: () => setSpace({ size: Number(sizeInput.value) })
  })

  const bar = (w: string, cls = '') => h('span', { class: 'bar ' + cls, style: { width: w } })

  wrapInput = h('input', {
    type: 'checkbox',
    id: 'word-wrap',
    onChange: () => {
      state.settings.wordWrap = wrapInput.checked
      persist()
      emit('layout')
    }
  })

  const left = h(
    'div',
    { class: 'set-left' },
    h('div', { class: 'set-intro' }, h('h1', {}, t('个性化与主题')), h('p', {}, t('选择主题、强调色和代码字体，修改立即生效。'))),
    section(t('主题'), themes),
    section(t('强调色'), accents),
    section(t('代码字体'), fonts, h('div', { class: 'size-row' }, h('label', { for: 'font-size' }, t('字号')), sizeInput, sizeLabel))
  )

  previewFrame = h('div', { class: 'preview-frame' })
  const previewEditorEl = h('div', { class: 'preview-editor' })
  previewFrame.append(
    h('div', { class: 'pv-top' }, h('span', { class: 'logo tiny', html: icons.logo }), h('span', {}, '~/.infinite/theme.ts')),
    h('div', { class: 'pv-body' }, h('span', { class: 'pv-rail' }), h('span', { class: 'pv-side' }, bar('60%'), bar('55%', 'faint'), bar('70%', 'acc'), bar('50%', 'faint'), bar('45%'), bar('65%', 'faint')), previewEditorEl),
    h('div', { class: 'pv-status' }, h('span', {}, 'main'), h('span', { class: 'grow' }))
  )

  const right = h(
    'div',
    { class: 'set-right' },
    h('div', { class: 'pv-head' }, h('h2', {}, t('实时预览'))),
    previewFrame
  )

  // ---- 系统设置 ----
  ctxInput = h('input', {
    type: 'checkbox',
    id: 'agent-context',
    onChange: () => {
      state.settings.agentContext = ctxInput.checked
      persist()
      refreshAgentContext()
    }
  })
  sysInfo = { recents: h('span', { class: 'muted' }), sizes: h('span', { class: 'muted' }) }
  const resetSizes = () => {
    state.settings.sidebarWidth = undefined
    state.settings.panelHeight = undefined
    state.settings.chatWidth = undefined
    persist()
    emit('layout')
    toast(t('已恢复默认尺寸，终端和对话面板下次打开时生效'))
    sync()
  }
  const system = h(
    'div',
    { class: 'set-left' },
    h('div', { class: 'set-intro' }, h('h1', {}, t('系统设置')), h('p', {}, t('编辑器行为、AI 助手、窗口和本地数据。修改立即生效。'))),
    section(t('编辑器'), h('label', { class: 'check-row', for: 'word-wrap' }, wrapInput, h('span', {}, t('自动换行')), h('span', { class: 'muted' }, 'Alt Z'))),
    section(t('AI 助手'), h('label', { class: 'check-row', for: 'agent-context' }, ctxInput, h('span', {}, t('发送消息时附带当前文件和选中内容')))),
    section(t('窗口'), h('div', { class: 'sys-row' }, h('span', {}, t('侧栏、终端和对话面板的尺寸')), sysInfo.sizes, h('span', { class: 'grow' }), h('button', { class: 'btn small', onClick: resetSizes }, t('恢复默认')))),
    section(
      t('数据'),
      h(
        'div',
        { class: 'sys-row' },
        h('span', {}, t('最近打开的文件夹')),
        sysInfo.recents,
        h('span', { class: 'grow' }),
        h('button', {
          class: 'btn small',
          onClick: () => {
            state.settings.recentFolders = []
            persist()
            emit('root')
            sync()
            toast(t('已清除最近打开记录'))
          }
        }, t('清除'))
      ),
    ),
    section(t('快捷键'), h('div', { class: 'sys-keys' }, ...SHORTCUTS.map(([k, v]) => h('div', {}, h('span', {}, k), h('kbd', {}, v)))))
  )

  // ---- 多语言设置 ----
  const language = h(
    'div',
    { class: 'set-left' },
    h('div', { class: 'set-intro' }, h('h1', {}, t('多语言设置')), h('p', {}, t('选择界面显示语言。切换后窗口会重新加载。'))),
    section(
      getLocale() === 'zh' ? '语言 · Language' : 'Language · 语言',
      h(
        'div',
        { class: 'grid3 lang-grid' },
        ...LANGS.map(([id, label, sub]) =>
          h(
            'button',
            { class: 'opt lang-opt', 'data-locale': id, 'aria-pressed': String(getLocale() === id), onClick: () => void switchLocale(id) },
            h('span', { class: 'opt-label' }, label),
            h('span', { class: 'opt-sub' }, sub)
          )
        )
      )
    )
  )

  // ---- 左侧导航 ----
  navInk = h('span', { class: 'set-nav-ink', 'aria-hidden': 'true' })
  navEl = h(
    'nav',
    { class: 'set-nav', 'aria-label': t('设置分类') },
    h(
      'div',
      { class: 'set-nav-head' },
      h('button', { class: 'set-back', 'aria-label': t('返回编辑器 (Esc)'), title: t('返回 Esc'), onClick: () => closeSettings() }, h('span', { class: 'ic', html: icons.arrowLeft }), h('span', {}, t('返回')))
    ),
    h('div', { class: 'set-nav-title' }, t('设置')),
    navInk,
    ...PANES.map(([id, label, sub, icon]) =>
      h(
        'button',
        { class: 'set-nav-btn', 'data-pane': id, onClick: () => showPane(id) },
        h('span', { class: 'set-nav-label' }, label, icon ? h('span', { class: 'ic', html: icon }) : null),
        h('span', { class: 'set-nav-sub' }, sub)
      )
    ),
  )

  page = h(
    'div',
    { class: 'settings-page', role: 'region', 'aria-label': t('设置') },
    h(
      'div',
      { class: 'set-shell' },
      navEl,
      h(
        'div',
        { class: 'set-panes' },
        h('div', { class: 'set-pane', 'data-pane': 'system', hidden: true }, h('div', { class: 'set-inner single' }, system)),
        h('div', { class: 'set-pane', 'data-pane': 'appearance', hidden: true }, h('div', { class: 'set-inner' }, left, right)),
        h('div', { class: 'set-pane', 'data-pane': 'language', hidden: true }, h('div', { class: 'set-inner single' }, language))
      )
    )
  )
  page.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation()
      closeSettings()
    }
  })
  host.append(page)

  preview = monaco.editor.create(previewEditorEl, {
    value: '',
    language: 'typescript',
    readOnly: true,
    domReadOnly: true,
    minimap: { enabled: false },
    lineNumbers: 'off',
    folding: false,
    glyphMargin: false,
    scrollBeyondLastLine: false,
    renderLineHighlight: 'none',
    overviewRulerLanes: 0,
    scrollbar: { vertical: 'hidden', horizontal: 'hidden', handleMouseWheel: false },
    contextmenu: false,
    colorDecorators: false,
    automaticLayout: true,
    padding: { top: 16 }
  })
}

function previewCode(s: Space): string {
  return [
    t('// 你的界面，你的规则'),
    'export const theme = defineTheme({',
    `  theme: '${s.theme}',`,
    `  accent: '${s.accent}',`,
    `  font: '${FONTS[s.font].name}',`,
    `  size: ${s.size},`,
    '})'
  ].join('\n')
}

function sync(): void {
  if (!page) return
  const s = state.settings.space
  page.querySelectorAll<HTMLElement>('.opt[data-k]').forEach((el) => {
    const k = el.dataset.k as keyof Space
    el.setAttribute('aria-pressed', String(String(s[k]) === el.dataset.v))
  })
  page.querySelectorAll<HTMLElement>('.swatch-dot').forEach((el) => {
    el.style.background = readableAccent(el.dataset.hex!, THEMES[s.theme].bg)
  })
  sizeInput.value = String(s.size)
  sizeLabel.textContent = `${s.size}px`
  customColor.value = s.accent.toLowerCase()
  wrapInput.checked = state.settings.wordWrap
  ctxInput.checked = state.settings.agentContext !== false
  const nRecent = state.settings.recentFolders.length
  sysInfo.recents.textContent = nRecent ? t('{0} 个', nRecent) : t('无')
  sysInfo.sizes.textContent = [
    state.settings.sidebarWidth ? t('侧栏 {0}px', state.settings.sidebarWidth) : '',
    state.settings.panelHeight ? t('终端 {0}px', state.settings.panelHeight) : '',
    state.settings.chatWidth ? t('对话 {0}px', state.settings.chatWidth) : ''
  ]
    .filter(Boolean)
    .join(' · ') || t('均为默认')
  const isCustom = !ACCENTS.some((a) => a.hex === s.accent)
  customColor.parentElement!.classList.toggle('on', isCustom)

  if (preview) {
    preview.setValue(previewCode(s))
    preview.updateOptions({ fontFamily: FONTS[s.font].css, fontSize: s.size, lineHeight: Math.round(s.size * 1.8) })
  }
}
