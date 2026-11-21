import type { FontId, LayoutId, Space, ThemeId } from '../../shared/types'
import { h, toast } from './dom'
import { icons } from './icons'
import { monaco } from './monaco'
import { MAX_SIZE, MIN_SIZE, PRESETS, emit, on, persist, sameLook, sanitizeSpace, setSpace, state } from './store'
import { ACCENTS, FONTS, THEMES, readableAccent } from './theme'

let page: HTMLElement | null = null
let host: HTMLElement
let preview: monaco.editor.IStandaloneCodeEditor | null = null
let previewFrame: HTMLElement
let spacesGrid: HTMLElement
let nameInput: HTMLInputElement
let sizeInput: HTMLInputElement
let sizeLabel: HTMLElement
let customColor: HTMLInputElement
let bindBtn: HTMLButtonElement
let wrapInput: HTMLInputElement
let onClose: () => void = () => {}

export function initSettings(container: HTMLElement, closed: () => void): void {
  host = container
  onClose = closed
  on('space', sync)
  on('saved', () => page && renderSpaces())
  on('root', () => page && sync())
}

export function isSettingsOpen(): boolean {
  return page !== null && !page.hidden
}

export function openSettings(): void {
  if (!page) build()
  page!.hidden = false
  sync()
  requestAnimationFrame(() => preview?.layout())
  ;(page!.querySelector('[aria-pressed="true"]') as HTMLElement | null)?.focus()
}

export function closeSettings(): void {
  if (!page || page.hidden) return
  page.hidden = true
  onClose()
}

function section(title: string, ...body: (Node | null)[]): HTMLElement {
  const id = 'sec-' + Math.random().toString(36).slice(2, 8)
  return h('section', { class: 'set-section', 'aria-labelledby': id }, h('h2', { id }, title), ...body)
}

function option<K extends keyof Space>(key: K, value: Space[K], cls: string, ...children: (Node | string)[]): HTMLButtonElement {
  return h(
    'button',
    { class: 'opt ' + cls, 'data-k': key, 'data-v': String(value), 'aria-pressed': 'false', onClick: () => setSpace({ [key]: value } as Partial<Space>) },
    ...children
  )
}

function build(): void {
  nameInput = h('input', {
    id: 'space-name',
    class: 'text-input',
    maxlength: '40',
    spellcheck: 'false',
    onChange: () => setSpace({ name: nameInput.value.trim() || '我的空间' })
  })

  spacesGrid = h('div', { class: 'grid3' })

  const themes = h(
    'div',
    { class: 'grid3' },
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
    'aria-label': '自定义强调色',
    title: '自定义颜色',
    onInput: () => setSpace({ accent: customColor.value.toUpperCase() })
  })
  const accents = h(
    'div',
    { class: 'swatches' },
    ...ACCENTS.map((a) => {
      const b = option('accent', a.hex, 'swatch', h('span', { class: 'swatch-dot', 'data-hex': a.hex }))
      b.setAttribute('aria-label', '强调色：' + a.name)
      b.title = a.name
      return b
    }),
    h('label', { class: 'custom-color' }, customColor, h('span', {}, '自定义'))
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

  const layoutCard = (id: LayoutId, label: string, schematic: HTMLElement) => option('layout', id, 'layout-card', schematic, h('span', { class: 'opt-label' }, label))
  const bar = (w: string, cls = '') => h('span', { class: 'bar ' + cls, style: { width: w } })
  const layouts = h(
    'div',
    { class: 'grid3' },
    layoutCard('classic', '经典 · 文件栏常驻', h('span', { class: 'schem classic' }, h('span', { class: 'col c-rail' }), h('span', { class: 'col c-side' }), h('span', { class: 'lines' }, bar('70%'), bar('50%', 'acc'), bar('60%')))),
    layoutCard('minimal', '极简 · 只留编辑区', h('span', { class: 'schem minimal' }, h('span', { class: 'lines' }, bar('70%'), bar('50%', 'acc'), bar('60%')))),
    layoutCard('focus', '专注 · 居中单列', h('span', { class: 'schem focus' }, h('span', { class: 'lines center' }, bar('40%', 'faint'), bar('40%', 'acc'), bar('40%', 'faint'))))
  )

  wrapInput = h('input', {
    type: 'checkbox',
    id: 'word-wrap',
    onChange: () => {
      state.settings.wordWrap = wrapInput.checked
      persist()
      emit('layout')
    }
  })

  bindBtn = h('button', { class: 'btn', onClick: toggleBinding })

  const left = h(
    'div',
    { class: 'set-left' },
    h('div', { class: 'set-intro' }, h('h1', {}, '你的空间'), h('p', {}, '主题、强调色、字体和布局打包成一个“空间”。每个项目可以绑定自己的空间，打开项目时自动切换。')),
    section(
      '当前空间',
      h(
        'div',
        { class: 'name-row' },
        h('label', { for: 'space-name', class: 'sr-only' }, '空间名称'),
        nameInput,
        h('button', { class: 'btn primary', onClick: saveAsNew }, '保存为新空间'),
        bindBtn
      ),
      h(
        'div',
        { class: 'link-row' },
        h('button', { class: 'link-btn', onClick: () => window.api.space.export(state.settings.space).then((ok) => ok && toast('已导出')) }, '导出 .infinite-space'),
        h('button', { class: 'link-btn', onClick: importSpace }, '导入空间')
      )
    ),
    section('预设与已保存的空间', spacesGrid),
    section('主题', themes),
    section('强调色 · 整个界面只有这一种颜色', accents),
    section('代码字体', fonts, h('div', { class: 'size-row' }, h('label', { for: 'font-size' }, '字号'), sizeInput, sizeLabel)),
    section('布局', layouts),
    section('编辑器', h('label', { class: 'check-row', for: 'word-wrap' }, wrapInput, h('span', {}, '自动换行'), h('span', { class: 'muted' }, 'Alt Z')))
  )

  previewFrame = h('div', { class: 'preview-frame' })
  const previewEditorEl = h('div', { class: 'preview-editor' })
  previewFrame.append(
    h('div', { class: 'pv-top' }, h('span', { class: 'logo tiny', html: icons.logo }), h('span', {}, '~/.infinite/spaces/space.ts')),
    h('div', { class: 'pv-body' }, h('span', { class: 'pv-rail' }), h('span', { class: 'pv-side' }, bar('60%'), bar('55%', 'faint'), bar('70%', 'acc'), bar('50%', 'faint'), bar('45%'), bar('65%', 'faint')), previewEditorEl),
    h('div', { class: 'pv-status' }, h('span', {}, 'main'), h('span', { class: 'grow' }), h('span', { class: 'pv-space' }))
  )

  const right = h(
    'div',
    { class: 'set-right' },
    h('div', { class: 'pv-head' }, h('h2', {}, '实时预览'), h('span', { class: 'kbd-hint' }, 'Esc 返回编辑器')),
    previewFrame,
    h('p', { class: 'muted small' }, '空间就是一个配置文件，可以分享给别人一键导入。随时用 Ctrl K → “切换空间” 切换。')
  )

  page = h('div', { class: 'settings-page', role: 'region', 'aria-label': '个性化设置' }, h('div', { class: 'set-inner' }, left, right))
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
  renderSpaces()
}

function renderSpaces(): void {
  const cur = state.settings.space
  const card = (s: Space, saved: boolean) => {
    const accent = readableAccent(s.accent, THEMES[s.theme].bg)
    const on = sameLook(s, cur) && s.name === cur.name
    const desc = `${THEMES[s.theme].label.split(' · ')[1]} · ${FONTS[s.font].name} · ${s.size}px`
    const btn = h(
      'button',
      { class: 'opt space-card', 'aria-pressed': String(on), onClick: () => setSpace({ ...s }) },
      h('span', { class: 'space-dots' }, h('span', { style: { background: THEMES[s.theme].bg } }), h('span', { style: { background: accent } })),
      h('span', { class: 'space-text' }, h('span', { class: 'opt-label' }, s.name), h('span', { class: 'opt-sub' }, desc))
    )
    if (!saved) return btn
    const del = h('button', {
      class: 'icon-btn small del',
      'aria-label': `删除空间 ${s.name}`,
      title: '删除',
      html: icons.trash,
      onClick: () => {
        state.settings.savedSpaces = state.settings.savedSpaces.filter((x) => x !== s)
        persist()
        emit('saved')
      }
    })
    return h('div', { class: 'space-wrap' }, btn, del)
  }
  spacesGrid.replaceChildren(...PRESETS.map((s) => card(s, false)), ...state.settings.savedSpaces.map((s) => card(s, true)))
}

function saveAsNew(): void {
  const name = nameInput.value.trim() || '我的空间'
  const space = { ...state.settings.space, name }
  const list = state.settings.savedSpaces.filter((s) => s.name !== name)
  if (PRESETS.some((p) => p.name === name)) {
    toast('不能和预设空间重名')
    return
  }
  state.settings.savedSpaces = [...list, space]
  setSpace({ name })
  emit('saved')
  toast(`已保存空间“${name}”`)
}

function toggleBinding(): void {
  const root = state.root
  if (!root) return
  if (state.settings.bindings[root]) {
    delete state.settings.bindings[root]
    toast('已解除绑定')
  } else {
    state.settings.bindings[root] = { ...state.settings.space }
    toast(`打开这个项目时会自动切换到“${state.settings.space.name}”`)
  }
  persist()
  sync()
}

async function importSpace(): Promise<void> {
  const raw = await window.api.space.import()
  if (!raw) return
  const s = sanitizeSpace(raw)
  state.settings.savedSpaces = [...state.settings.savedSpaces.filter((x) => x.name !== s.name), s]
  setSpace({ ...s })
  emit('saved')
  toast(`已导入空间“${s.name}”`)
}

function previewCode(s: Space): string {
  return [
    '// 你的空间，你的规则',
    'export const space = defineSpace({',
    `  name: '${s.name.replace(/'/g, "\\'")}',`,
    `  theme: '${s.theme}',`,
    `  accent: '${s.accent}',`,
    `  font: '${FONTS[s.font].name}',`,
    `  size: ${s.size},`,
    `  layout: '${s.layout}',`,
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
  if (document.activeElement !== nameInput) nameInput.value = s.name
  sizeInput.value = String(s.size)
  sizeLabel.textContent = `${s.size}px`
  customColor.value = s.accent.toLowerCase()
  wrapInput.checked = state.settings.wordWrap
  const isCustom = !ACCENTS.some((a) => a.hex === s.accent)
  customColor.parentElement!.classList.toggle('on', isCustom)

  bindBtn.disabled = !state.root
  bindBtn.textContent = state.root && state.settings.bindings[state.root] ? '解除项目绑定' : '绑定到当前项目'
  bindBtn.title = state.root ? '' : '先打开一个文件夹'

  previewFrame.dataset.layout = s.layout
  previewFrame.querySelector('.pv-space')!.textContent = s.name
  if (preview) {
    preview.setValue(previewCode(s))
    preview.updateOptions({ fontFamily: FONTS[s.font].css, fontSize: s.size, lineHeight: Math.round(s.size * 1.8) })
  }
  renderSpaces()
}
