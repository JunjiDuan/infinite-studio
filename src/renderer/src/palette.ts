import { allCommands, type Command } from './commands'
import { basename, h, relative } from './dom'
import { openFile } from './editor'
import { state } from './store'
import { reveal } from './tree'

interface Match {
  score: number
  hits: number[]
}

/** 子序列模糊匹配：连续命中、词首命中加分，短文本优先 */
export function fuzzy(query: string, text: string): Match | null {
  const q = query.toLowerCase().replace(/\s+/g, '')
  if (!q) return { score: 0, hits: [] }
  const t = text.toLowerCase()
  const hits: number[] = []
  let from = 0
  let score = 0
  let prev = -2
  for (const ch of q) {
    const i = t.indexOf(ch, from)
    if (i < 0) return null
    hits.push(i)
    score += i === prev + 1 ? 5 : 1
    if (i === 0 || '/\\._- ：'.includes(t[i - 1])) score += 3
    prev = i
    from = i + 1
  }
  return { score: score - text.length * 0.02, hits }
}

function highlight(text: string, hits: number[]): Node[] {
  const set = new Set(hits)
  const out: Node[] = []
  let buf = ''
  let mark = false
  const flush = () => {
    if (!buf) return
    out.push(mark ? h('mark', {}, buf) : document.createTextNode(buf))
    buf = ''
  }
  for (let i = 0; i < text.length; i++) {
    const m = set.has(i)
    if (m !== mark) {
      flush()
      mark = m
    }
    buf += text[i]
  }
  flush()
  return out
}

interface Item {
  kind: 'cmd' | 'file'
  label: Node[]
  hint: string
  key?: string
  run: () => void
}

let files: string[] = []
let filesRoot: string | null = null
let backdrop: HTMLElement | null = null

async function ensureFiles(): Promise<void> {
  if (!state.root) {
    files = []
    filesRoot = null
    return
  }
  if (filesRoot === state.root) return
  filesRoot = state.root
  files = await window.api.fs.listFiles(state.root)
}

export function invalidateFiles(): void {
  filesRoot = null
}

export function isPaletteOpen(): boolean {
  return backdrop !== null
}

export function closePalette(): void {
  backdrop?.remove()
  backdrop = null
}

export async function openPalette(initial = ''): Promise<void> {
  if (backdrop) {
    closePalette()
    return
  }
  const prevFocus = document.activeElement as HTMLElement | null
  const input = h('input', {
    class: 'palette-input',
    'aria-label': '搜索文件或命令',
    placeholder: state.root ? '搜索文件，或输入 > 只搜命令' : '输入命令',
    spellcheck: 'false',
    value: initial
  })
  const list = h('div', { class: 'palette-list', role: 'listbox' })
  const panel = h(
    'div',
    { class: 'palette', role: 'dialog', 'aria-label': '命令面板' },
    h('div', { class: 'palette-head' }, h('span', { class: 'palette-caret' }, '>'), input, h('kbd', {}, 'Esc')),
    list,
    h(
      'div',
      { class: 'palette-foot' },
      h('span', {}, '↑ ↓ 选择'),
      h('span', {}, 'Enter 执行'),
      h('span', { class: 'grow' }),
      h('span', {}, '> 只搜命令')
    )
  )
  backdrop = h('div', { class: 'palette-backdrop', onMousedown: (e: MouseEvent) => e.target === backdrop && done() }, panel)
  document.body.append(backdrop)
  input.focus()
  input.setSelectionRange(input.value.length, input.value.length)

  let items: Item[] = []
  let sel = 0

  const done = (restore = true) => {
    closePalette()
    if (restore) prevFocus?.focus()
  }

  const compute = () => {
    const raw = input.value
    const cmdOnly = raw.startsWith('>')
    const q = cmdOnly ? raw.slice(1).trim() : raw.trim()
    const cmds = allCommands()
      .map((c) => ({ c, m: fuzzy(q, c.title) }))
      .filter((x): x is { c: Command; m: Match } => !!x.m)
      .sort((a, b) => b.m.score - a.m.score)
      .slice(0, q ? 8 : 12)
    const cmdItems: Item[] = cmds.map(({ c, m }) => ({
      kind: 'cmd',
      label: highlight(c.title, m.hits),
      hint: c.hint ?? '',
      key: c.key,
      run: () => {
        done()
        void c.run()
      }
    }))
    let fileItems: Item[] = []
    if (!cmdOnly && state.root && q) {
      const root = state.root
      fileItems = files
        .map((p) => {
          const rel = relative(root, p)
          const m = fuzzy(q, rel)
          if (!m) return null
          const base = fuzzy(q, basename(p))
          return { p, rel, m, score: m.score + (base ? 10 + base.score : 0) }
        })
        .filter((x): x is NonNullable<typeof x> => !!x)
        .sort((a, b) => b.score - a.score)
        .slice(0, 30)
        .map((x) => ({
          kind: 'file' as const,
          label: highlight(x.rel, x.m.hits),
          hint: '',
          run: () => {
            done(false)
            void openFile(x.p).then(() => reveal(x.p))
          }
        }))
    }
    // 有输入时文件在前，空输入时只列命令
    items = q && !cmdOnly ? [...fileItems, ...cmdItems] : cmdItems
    sel = 0
    renderList(fileItems.length, cmdItems.length, q !== '' && !cmdOnly)
  }

  const renderList = (nFiles: number, nCmds: number, filesFirst: boolean) => {
    const rows: HTMLElement[] = []
    const group = (title: string) => rows.push(h('div', { class: 'palette-group' }, title))
    items.forEach((it, i) => {
      if (filesFirst && i === 0 && nFiles) group('文件')
      if ((filesFirst && i === nFiles && nCmds) || (!filesFirst && i === 0)) group('命令')
      rows.push(
        h(
          'div',
          {
            class: 'palette-item' + (i === sel ? ' sel' : ''),
            role: 'option',
            'aria-selected': String(i === sel),
            onMousemove: () => select(i),
            onClick: () => it.run()
          },
          h('span', { class: 'dot' }),
          h('span', { class: 'label' + (it.kind === 'file' ? ' mono' : '') }, ...it.label),
          it.hint ? h('span', { class: 'hint' }, it.hint) : null,
          it.key ? h('kbd', {}, it.key) : null
        )
      )
    })
    if (!items.length) rows.push(h('div', { class: 'palette-empty' }, '没有匹配的结果'))
    list.replaceChildren(...rows)
  }

  const select = (i: number) => {
    if (i === sel) return
    sel = i
    list.querySelectorAll('.palette-item').forEach((el, j) => {
      el.classList.toggle('sel', j === sel)
      el.setAttribute('aria-selected', String(j === sel))
    })
    list.querySelectorAll('.palette-item')[sel]?.scrollIntoView({ block: 'nearest' })
  }

  input.addEventListener('input', compute)
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      select(Math.min(items.length - 1, sel + 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      select(Math.max(0, sel - 1))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      items[sel]?.run()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      done()
    }
  })

  compute()
  await ensureFiles()
  if (backdrop) compute()
}
