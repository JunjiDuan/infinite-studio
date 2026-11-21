import type { SearchOptions, SearchResult } from '../../shared/types'
import { basename, h, parentDir, relative, toast } from './dom'
import { getEditor, isDirty, openFile, samePath, tabs } from './editor'
import { icons } from './icons'
import { state } from './store'
import { t } from './i18n'

const opts: SearchOptions = { caseSensitive: false, wholeWord: false, regex: false }
const collapsed = new Set<string>()
let input: HTMLInputElement
let replaceInput: HTMLInputElement
let replaceRow: HTMLElement
let replaceToggle: HTMLButtonElement
let summaryEl: HTMLElement
let resultsEl: HTMLElement
let replaceAllBtn: HTMLButtonElement
let reqId = 0
let timer: ReturnType<typeof setTimeout> | undefined
let last: SearchResult | null = null

function toggleBtn(key: keyof SearchOptions, label: string, title: string): HTMLButtonElement {
  const b: HTMLButtonElement = h(
    'button',
    {
      class: 'search-toggle',
      'aria-label': title,
      title,
      'aria-pressed': 'false',
      onClick: () => {
        opts[key] = !opts[key]
        b.setAttribute('aria-pressed', String(opts[key]))
        schedule(0)
      }
    },
    label
  )
  return b
}

export function createSearchView(): HTMLElement {
  input = h('input', {
    class: 'search-input',
    placeholder: t('搜索'),
    'aria-label': t('在文件中搜索'),
    spellcheck: 'false',
    onInput: () => schedule(),
    onKeydown: (e: KeyboardEvent) => {
      if (e.key === 'Enter') schedule(0)
    }
  })
  replaceInput = h('input', {
    class: 'search-input',
    placeholder: t('替换为'),
    'aria-label': t('替换为'),
    spellcheck: 'false',
    onKeydown: (e: KeyboardEvent) => {
      if (e.key === 'Enter' && e.ctrlKey && e.altKey) void replaceAll()
    }
  })
  replaceAllBtn = h('button', { class: 'icon-btn small', 'aria-label': t('全部替换 (Ctrl Alt Enter)'), title: t('全部替换 Ctrl Alt Enter'), html: icons.replaceAll, onClick: () => void replaceAll() })
  replaceRow = h('div', { class: 'search-row replace', hidden: true }, h('div', { class: 'search-box' }, replaceInput), replaceAllBtn)
  replaceToggle = h('button', {
    class: 'icon-btn small replace-toggle',
    'aria-label': t('显示替换'),
    'aria-expanded': 'false',
    html: icons.chevron,
    onClick: () => {
      replaceRow.hidden = !replaceRow.hidden
      replaceToggle.setAttribute('aria-expanded', String(!replaceRow.hidden))
      if (!replaceRow.hidden) replaceInput.focus()
    }
  })
  summaryEl = h('div', { class: 'search-summary', role: 'status', 'aria-live': 'polite' })
  resultsEl = h('div', { class: 'search-results', role: 'tree', 'aria-label': t('搜索结果') })

  return h(
    'div',
    { class: 'side-view', 'data-view': 'search' },
    h(
      'div',
      { class: 'side-head' },
      h('span', { class: 'side-title' }, t('搜索')),
      h(
        'div',
        { class: 'side-actions' },
        h('button', { class: 'icon-btn small', 'aria-label': t('全部折叠'), title: t('全部折叠'), html: icons.collapse, onClick: collapseAll }),
        h('button', { class: 'icon-btn small', 'aria-label': t('清空'), title: t('清空'), html: icons.close, onClick: clear })
      )
    ),
    h(
      'div',
      { class: 'search-form' },
      replaceToggle,
      h(
        'div',
        { class: 'search-fields' },
        h(
          'div',
          { class: 'search-row' },
          h('div', { class: 'search-box' }, input, toggleBtn('caseSensitive', 'Aa', t('区分大小写')), toggleBtn('wholeWord', 'ab', t('全字匹配')), toggleBtn('regex', '.*', t('使用正则表达式')))
        ),
        replaceRow
      )
    ),
    summaryEl,
    resultsEl
  )
}

/** 打开搜索并聚焦；编辑器里选中了单行文字时自动带入 */
export function focusSearch(): void {
  const ed = getEditor()
  const sel = ed?.getSelection()
  const model = ed?.getModel()
  if (sel && model && !sel.isEmpty() && sel.startLineNumber === sel.endLineNumber) {
    input.value = model.getValueInRange(sel)
    schedule(0)
  }
  input.focus()
  input.select()
}

function schedule(delay = 250): void {
  clearTimeout(timer)
  timer = setTimeout(run, delay)
}

function clear(): void {
  input.value = ''
  replaceInput.value = ''
  reqId++
  last = null
  summaryEl.textContent = ''
  resultsEl.replaceChildren()
  input.focus()
}

function collapseAll(): void {
  if (!last) return
  for (const f of last.files) collapsed.add(f.path)
  render()
}

/** 打开新文件夹时清掉旧结果 */
export function resetSearch(): void {
  reqId++
  last = null
  collapsed.clear()
  if (summaryEl) {
    summaryEl.textContent = ''
    resultsEl.replaceChildren()
  }
}

async function run(): Promise<void> {
  const root = state.root
  const q = input.value
  if (!root || !q) {
    reqId++
    last = null
    summaryEl.textContent = root ? '' : t('先打开一个文件夹')
    resultsEl.replaceChildren()
    return
  }
  const id = ++reqId
  summaryEl.textContent = t('搜索中…')
  const r = await window.api.search.run(id, root, q, { ...opts })
  if (id !== reqId || !r) return
  last = r
  render()
}

function render(): void {
  const r = last
  if (!r || !state.root) return
  const root = state.root
  if (r.error) {
    summaryEl.textContent = r.error
    resultsEl.replaceChildren()
    return
  }
  summaryEl.textContent = r.total ? t('{0} 个文件中有 {1} 个结果{2}', r.files.length, r.total, r.truncated ? t('（结果过多，只显示前 5000 个）') : '') : t('没有结果')
  const rows: HTMLElement[] = []
  for (const f of r.files) {
    const open = !collapsed.has(f.path)
    const rel = relative(root, parentDir(f.path))
    rows.push(
      h(
        'button',
        {
          class: 'sr-file' + (open ? ' open' : ''),
          'aria-expanded': String(open),
          title: f.path,
          onClick: () => {
            if (collapsed.has(f.path)) collapsed.delete(f.path)
            else collapsed.add(f.path)
            render()
          }
        },
        h('span', { class: 'chev', html: icons.chevron }),
        h('span', { class: 'sr-name' }, basename(f.path)),
        h('span', { class: 'sr-dir' }, rel === relative(root, root) ? '' : rel),
        h('span', { class: 'sr-count' }, String(f.matches.length))
      )
    )
    if (!open) continue
    for (const m of f.matches) {
      rows.push(
        h(
          'button',
          {
            class: 'sr-match',
            title: t('第 {0} 行', m.line),
            onClick: () => void openFile(f.path, { line: m.line, col: m.col, len: m.len })
          },
          m.preview.slice(0, m.at),
          h('mark', {}, m.preview.slice(m.at, m.at + m.len)),
          m.preview.slice(m.at + m.len)
        )
      )
    }
  }
  resultsEl.replaceChildren(...rows)
}

async function replaceAll(): Promise<void> {
  const r = last
  if (!r || !r.total || !input.value) return
  const dirty = new Set(tabs.filter(isDirty).map((t) => t.path))
  const targets = r.files.map((f) => f.path).filter((p) => ![...dirty].some((d) => samePath(d, p)))
  const skipped = r.files.length - targets.length
  if (!targets.length) {
    toast(t('匹配的文件都有未保存的修改，先保存再替换'))
    return
  }
  const what = replaceInput.value ? `“${replaceInput.value}”` : t('空')
  const skipNote = skipped ? t('\n\n有 {0} 个文件存在未保存的修改，会被跳过。', skipped) : ''
  if (!confirm(t('把 {0} 个文件中的匹配项替换为{1}吗？{2}', targets.length, what, skipNote))) return
  try {
    const res = await window.api.search.replace(input.value, { ...opts }, replaceInput.value, targets)
    toast(t('已在 {0} 个文件中替换 {1} 处', res.files, res.replaced))
  } catch (e) {
    toast(t('替换失败：') + String(e))
  }
  schedule(0)
}
