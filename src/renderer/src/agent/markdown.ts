import { h, toast } from '../dom'
import { openFile } from '../editor'
import { icons } from '../icons'
import { monaco } from '../monaco'
import { state } from '../store'
import { t } from '../i18n'

/**
 * 对话里用的 Markdown 渲染。全部用 DOM 构造，不拼接外部 HTML；
 * 代码高亮用 Monaco 的 colorize（它自己转义文本）。
 */

const LANG_ALIAS: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  py: 'python',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  ps1: 'powershell',
  pwsh: 'powershell',
  yml: 'yaml',
  md: 'markdown',
  rs: 'rust',
  rb: 'ruby',
  cs: 'csharp',
  'c++': 'cpp',
  kt: 'kotlin',
  diff: 'diff'
}

function langId(lang: string): string {
  const l = lang.toLowerCase()
  const id = LANG_ALIAS[l] ?? l
  return monaco.languages.getLanguages().some((x) => x.id === id) ? id : 'plaintext'
}

export function codeBlock(code: string, lang = ''): HTMLElement {
  const codeEl = h('code', {}, code)
  const id = langId(lang)
  if (id !== 'plaintext' && code.length < 60_000) {
    monaco.editor
      .colorize(code, id, { tabSize: 2 })
      .then((html) => {
        codeEl.innerHTML = html
      })
      .catch(() => {})
  }
  const copy = h('button', {
    class: 'md-copy',
    title: t('复制'),
    'aria-label': t('复制代码'),
    html: icons.copy,
    onClick: () => {
      void navigator.clipboard.writeText(code)
      toast(t('已复制'))
    }
  })
  return h('div', { class: 'md-code' }, h('div', { class: 'md-code-head' }, h('span', {}, lang || 'text'), copy), h('pre', {}, codeEl))
}

/* ---------------- 文件路径 ---------------- */

const PATH_RE = /^(?:[A-Za-z]:[\\/]|\.{0,2}[\\/])?(?:[\w@.$-]+[\\/])*[\w@$-][\w@.$-]*\.[A-Za-z0-9]{1,8}(?:(?::|#L)(\d+)(?:[-:,]\d+)?)?$/

/** 看起来像文件路径就返回 { path, line } */
export function asFileRef(s: string): { path: string; line?: number } | null {
  const t = s.trim()
  if (t.length > 260 || /^\w+:\/\//.test(t) || /\s/.test(t)) return null
  const m = t.match(PATH_RE)
  if (!m) return null
  // 排除版本号、域名之类：至少有目录分隔符，或者扩展名是常见源码类型
  const bare = t.replace(/(?::|#L)\d+.*$/, '')
  if (!/[\\/]/.test(bare) && !/\.(ts|tsx|js|jsx|mjs|cjs|json|md|css|scss|html|vue|svelte|py|rs|go|java|kt|c|cc|cpp|h|hpp|cs|rb|php|swift|sh|ps1|yml|yaml|toml|xml|sql|txt|lock)$/i.test(bare)) return null
  return { path: bare, line: m[1] ? +m[1] : undefined }
}

export function resolvePath(p: string): string {
  if (/^[A-Za-z]:[\\/]/.test(p) || p.startsWith('/') || p.startsWith('\\\\')) return p
  const root = state.root
  if (!root) return p
  const sep = root.includes('\\') ? '\\' : '/'
  return root.replace(/[\\/]$/, '') + sep + p.replace(/^\.[\\/]/, '').replace(/[\\/]/g, sep)
}

export function fileLink(label: string, p: string, line?: number, cls = 'md-file'): HTMLElement {
  return h(
    'a',
    {
      class: cls,
      href: '#',
      title: line ? `${p}:${line}` : p,
      onClick: (e: Event) => {
        e.preventDefault()
        void openFile(resolvePath(p), line ? { line, col: 1 } : {})
      }
    },
    label
  )
}

/* ---------------- 行内 ---------------- */

const INLINE = /(`+)([\s\S]*?[^`])\1(?!`)|\*\*([^*]+?)\*\*|__([^_]+?)__|~~([^~]+?)~~|(?<![\w*])\*(?!\s)([^*\n]+?)\*(?![\w*])|(?<![\w_])_(?!\s)([^_\n]+?)_(?![\w_])|\[([^\]\n]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/g

/** 图片 ![alt](src)：只在调用方提供了解析函数时识别（对话里不显示图片） */
const IMAGE = /!\[([^\]\n]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/
type ImageHook = (src: string, alt: string) => Node
let imageHook: ImageHook | null = null

export function inline(s: string): Node[] {
  const out: Node[] = []
  let last = 0
  let m: RegExpExecArray | null
  // 每次调用用自己的正则：粗体、链接等会递归调用 inline，共用一个 /g 正则会互相改写 lastIndex，导致死循环
  const re = new RegExp(imageHook ? `${INLINE.source}|${IMAGE.source}` : INLINE.source, 'g')
  while ((m = re.exec(s))) {
    if (m.index > last) out.push(document.createTextNode(s.slice(last, m.index)))
    if (m[0].length === 0) {
      re.lastIndex++
      continue
    }
    last = re.lastIndex
    if (m[2] !== undefined) {
      const code = m[2].trim() ? m[2].replace(/^ (.*) $/, '$1') : m[2]
      const ref = asFileRef(code)
      out.push(ref ? fileLink(code, ref.path, ref.line, 'md-ic md-file') : h('code', { class: 'md-ic' }, code))
    } else if (m[3] !== undefined || m[4] !== undefined) out.push(h('strong', {}, ...inline(m[3] ?? m[4])))
    else if (m[5] !== undefined) out.push(h('del', {}, ...inline(m[5])))
    else if (m[6] !== undefined || m[7] !== undefined) out.push(h('em', {}, ...inline(m[6] ?? m[7])))
    else if (m[8] !== undefined) {
      const href = m[9]
      if (/^https?:\/\//.test(href)) out.push(h('a', { href, target: '_blank', rel: 'noreferrer', title: href }, ...inline(m[8])))
      else {
        const ref = asFileRef(decodeURIComponent(href)) ?? { path: decodeURIComponent(href).replace(/#L?(\d+).*$/, '') }
        const line = href.match(/#L?(\d+)/)?.[1]
        out.push(fileLink(m[8], ref.path, ref.line ?? (line ? +line : undefined)))
      }
    } else if (m[10] !== undefined) out.push(h('a', { href: m[10], target: '_blank', rel: 'noreferrer' }, m[10]))
    else if (m[12] !== undefined && imageHook) out.push(imageHook(m[12], m[11] ?? ''))
  }
  if (last < s.length) out.push(document.createTextNode(s.slice(last)))
  return out
}

/* ---------------- 块级 ---------------- */

function isTableSep(line: string): boolean {
  return /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line)
}

function cells(line: string): string[] {
  let t = line.trim()
  if (t.startsWith('|')) t = t.slice(1)
  if (t.endsWith('|')) t = t.slice(0, -1)
  return t.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'))
}

const LIST_RE = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/

/** opts.image：解析图片地址（Notebook 用它显示附件和本地图片） */
export function renderMarkdown(text: string, opts: { image?: ImageHook } = {}): HTMLElement {
  if (!opts.image) return renderBlocks(text)
  const prev = imageHook
  imageHook = opts.image
  try {
    return renderBlocks(text)
  } finally {
    imageHook = prev
  }
}

function renderBlocks(text: string): HTMLElement {
  const root = h('div', { class: 'md' })
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  let i = 0
  let para: string[] = []
  const flush = () => {
    if (para.length) root.append(h('p', {}, ...inline(para.join('\n'))))
    para = []
  }
  while (i < lines.length) {
    const line = lines[i]
    const fence = line.match(/^(\s*)(`{3,}|~{3,})\s*([\w+#.-]*)/)
    if (fence) {
      flush()
      const marker = fence[2]
      const body: string[] = []
      i++
      while (i < lines.length && !lines[i].trimStart().startsWith(marker)) body.push(lines[i++].slice(fence[1].length))
      i++
      root.append(codeBlock(body.join('\n'), fence[3]))
      continue
    }
    const hm = line.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/)
    if (hm) {
      flush()
      root.append(h(`h${Math.min(6, hm[1].length + 2)}` as 'h3', { class: 'md-h' }, ...inline(hm[2])))
      i++
      continue
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flush()
      root.append(h('hr'))
      i++
      continue
    }
    if (/^\s*>/.test(line)) {
      flush()
      const body: string[] = []
      while (i < lines.length && /^\s*>/.test(lines[i])) body.push(lines[i++].replace(/^\s*>\s?/, ''))
      root.append(h('blockquote', {}, renderMarkdown(body.join('\n'))))
      continue
    }
    if (line.includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      flush()
      const head = cells(line)
      const align = cells(lines[i + 1]).map((c) => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : ''))
      i += 2
      const rows: string[][] = []
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(cells(lines[i++]))
      root.append(
        h(
          'div',
          { class: 'md-table' },
          h(
            'table',
            {},
            h('thead', {}, h('tr', {}, ...head.map((c, k) => h('th', { style: align[k] ? { textAlign: align[k] } : undefined }, ...inline(c))))),
            h('tbody', {}, ...rows.map((r) => h('tr', {}, ...head.map((_, k) => h('td', { style: align[k] ? { textAlign: align[k] } : undefined }, ...inline(r[k] ?? ''))))))
          )
        )
      )
      continue
    }
    if (LIST_RE.test(line)) {
      flush()
      const block: string[] = []
      while (i < lines.length && (LIST_RE.test(lines[i]) || (/^\s+\S/.test(lines[i]) && block.length) || (lines[i] === '' && i + 1 < lines.length && (LIST_RE.test(lines[i + 1]) || /^\s+\S/.test(lines[i + 1]))))) block.push(lines[i++])
      root.append(renderList(block))
      continue
    }
    if (!line.trim()) {
      flush()
      i++
      continue
    }
    para.push(line)
    i++
  }
  flush()
  return root
}

function renderList(block: string[]): HTMLElement {
  const first = block[0].match(LIST_RE)!
  const baseIndent = first[1].length
  const ordered = /\d/.test(first[2])
  const list = ordered ? h('ol', { start: String(parseInt(first[2], 10) || 1) }) : h('ul')
  let item: { el: HTMLElement; lines: string[]; sub: string[] } | null = null
  const finish = () => {
    if (!item) return
    const txt = item.lines.join('\n')
    const task = txt.match(/^\[([ xX])\]\s+([\s\S]*)$/)
    if (task) {
      item.el.classList.add('md-task')
      item.el.append(h('input', { type: 'checkbox', disabled: true, checked: task[1] !== ' ' }), ...inline(task[2]))
    } else item.el.append(...inline(txt))
    if (item.sub.length) item.el.append(renderMarkdown(item.sub.map((l) => l.slice(Math.min(l.length - l.trimStart().length, baseIndent + 2))).join('\n')))
    list.append(item.el)
    item = null
  }
  for (const line of block) {
    const m = line.match(LIST_RE)
    if (m && m[1].length <= baseIndent + 1) {
      finish()
      item = { el: h('li'), lines: [m[3]], sub: [] }
    } else if (item) {
      if (item.sub.length || (m && m[1].length > baseIndent + 1)) item.sub.push(line)
      else if (line.trim()) item.lines.push(line.trim())
    }
  }
  finish()
  return list
}
