import { renderMarkdown } from './agent/markdown'
import { basename, h, parentDir, toast } from './dom'
import { t } from './i18n'
import { icons } from './icons'
import { monaco } from './monaco'
import { ansi, applyCR, IMG_MIME, joinText, MIME_ORDER, resolveLocal, sanitizeB64 } from './notebook'

/**
 * Notebook 导出：HTML（单个文件，图片内嵌）、PDF、Markdown、脚本（# %% 分段，VS Code / Jupytext 都认）。
 * 不依赖 Python / nbconvert，导出的是编辑器里当前的内容（包括还没保存的修改）。
 *
 * 可以选择：包含代码、包含输出、显示执行序号、HTML/PDF 的配色；
 * 并且和 nbconvert 一样认单元格标签：remove-cell 整个去掉，remove-input / hide-input 去掉代码，
 * remove-output / hide-output 去掉输出（metadata.jupyter.source_hidden / outputs_hidden 同理）。
 */

type Json = Record<string, unknown>
type Format = 'html' | 'pdf' | 'md' | 'script'
type Theme = 'light' | 'dark' | 'auto'

interface Options {
  format: Format
  code: boolean
  outputs: boolean
  prompts: boolean
  theme: Theme
  /** 脚本：Markdown 单元格写成注释 */
  mdComments: boolean
  title: string
}

export interface ExportSource {
  /** .ipynb 的路径（默认文件名、相对图片都以它为准） */
  path: string
  /** 完整的 Notebook JSON（当前编辑器里的内容） */
  data: Json
  /** Monaco 语言 ID（python / r / julia…） */
  lang: string
}

const STORE_KEY = 'nbExport'

function loadOptions(): Omit<Options, 'title'> {
  const d = { format: 'html' as Format, code: true, outputs: true, prompts: true, theme: 'light' as Theme, mdComments: true }
  try {
    const s = JSON.parse(localStorage.getItem(STORE_KEY) ?? '{}') as Partial<Options>
    return { ...d, ...s }
  } catch {
    return d
  }
}

function saveOptions(o: Options): void {
  const { title: _t, ...rest } = o
  localStorage.setItem(STORE_KEY, JSON.stringify(rest))
}

/* ---------------- 单元格可见性（标签） ---------------- */

interface Cell {
  type: string
  source: string
  raw: Json
  outputs: Json[]
  count: number | null
  hideInput: boolean
  hideOutput: boolean
}

function cellsOf(data: Json): Cell[] {
  const out: Cell[] = []
  for (const raw of (Array.isArray(data.cells) ? data.cells : []) as Json[]) {
    const meta = (raw.metadata ?? {}) as Json
    const tags = new Set(((Array.isArray(meta.tags) ? meta.tags : []) as unknown[]).map((x) => String(x).toLowerCase().replace(/_/g, '-')))
    if (tags.has('remove-cell')) continue
    const jup = (meta.jupyter ?? {}) as Json
    out.push({
      type: String(raw.cell_type ?? 'code'),
      source: joinText(raw.source),
      raw,
      outputs: (Array.isArray(raw.outputs) ? raw.outputs : []) as Json[],
      count: typeof raw.execution_count === 'number' ? raw.execution_count : null,
      hideInput: tags.has('remove-input') || tags.has('hide-input') || jup.source_hidden === true,
      hideOutput: tags.has('remove-output') || tags.has('hide-output') || jup.outputs_hidden === true
    })
  }
  return out
}

/* ---------------- 文件名 / 语言 ---------------- */

const SCRIPT_EXT: Record<string, string> = {
  python: 'py', r: 'r', julia: 'jl', javascript: 'js', typescript: 'ts', shell: 'sh', ruby: 'rb', scala: 'scala', java: 'java', csharp: 'cs', fsharp: 'fsx',
  cpp: 'cpp', c: 'c', go: 'go', rust: 'rs', kotlin: 'kt', swift: 'swift', lua: 'lua', sql: 'sql', powershell: 'ps1', perl: 'pl', php: 'php'
}

function commentPrefix(lang: string): string {
  if (['javascript', 'typescript', 'java', 'csharp', 'fsharp', 'cpp', 'c', 'go', 'rust', 'kotlin', 'swift', 'scala', 'php'].includes(lang)) return '//'
  if (['sql', 'lua', 'haskell'].includes(lang)) return '--'
  return '#'
}

function scriptExt(src: ExportSource): string {
  const li = ((src.data.metadata ?? {}) as Json).language_info as Json | undefined
  const ext = typeof li?.file_extension === 'string' ? li.file_extension.replace(/^\./, '') : ''
  return ext || SCRIPT_EXT[src.lang] || 'txt'
}

function extOf(o: Options, src: ExportSource): string {
  return o.format === 'script' ? scriptExt(src) : o.format
}

/* ---------------- 代码高亮（不依赖当前 IDE 主题，导出页自己的配色） ---------------- */

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

function tokenClass(type: string): string {
  if (!type) return ''
  if (type.includes('comment')) return 'c'
  if (type.includes('string') || type.includes('regexp')) return 's'
  if (type.includes('number') || type.includes('constant')) return 'n'
  if (type.includes('keyword')) return 'k'
  if (type.includes('type') || type.includes('class')) return 'y'
  if (type.includes('predefined') || type.includes('builtin') || type.includes('function')) return 'f'
  if (type.includes('annotation') || type.includes('decorator') || type.includes('tag') || type.includes('attribute')) return 'd'
  if (type.includes('operator')) return 'o'
  return ''
}

function highlight(code: string, lang: string): string {
  if (!code || lang === 'plaintext' || code.length > 200_000) return esc(code)
  let lines: monaco.Token[][]
  try {
    lines = monaco.editor.tokenize(code, lang)
  } catch {
    return esc(code)
  }
  const src = code.split(/\r?\n/)
  return src
    .map((line, i) => {
      const toks = lines[i] ?? []
      if (!toks.length) return esc(line)
      let out = ''
      toks.forEach((tk, j) => {
        const end = j + 1 < toks.length ? toks[j + 1].offset : line.length
        const text = line.slice(tk.offset, end)
        const cls = tokenClass(tk.type)
        out += cls ? `<span class="${cls}">${esc(text)}</span>` : esc(text)
      })
      return out
    })
    .join('\n')
}

function langId(name: string): string {
  const l = name.toLowerCase()
  const alias: Record<string, string> = { py: 'python', js: 'javascript', ts: 'typescript', sh: 'shell', bash: 'shell', rs: 'rust', rb: 'ruby', cs: 'csharp', 'c++': 'cpp', yml: 'yaml', md: 'markdown' }
  const id = alias[l] ?? l
  return monaco.languages.getLanguages().some((x) => x.id === id) ? id : 'plaintext'
}

/* ---------------- 图片 ---------------- */

function bytesToB64(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}

/** Markdown 里的图片地址 → 可以内嵌的 data: 地址；网络图片原样保留；找不到返回 null */
async function imageUrl(src: string, cell: Cell, nbPath: string): Promise<string | null> {
  if (/^(data:image\/|https?:\/\/)/i.test(src)) return src
  if (src.startsWith('attachment:')) {
    const att = ((cell.raw.attachments ?? {}) as Record<string, Record<string, string>>)[decodeURIComponent(src.slice(11))]
    const mime = att && Object.keys(att).find((k) => k.startsWith('image/'))
    if (!att || !mime) return null
    return mime === 'image/svg+xml' ? `data:${mime};charset=utf-8,${encodeURIComponent(joinText(att[mime]))}` : `data:${mime};base64,${sanitizeB64(joinText(att[mime]))}`
  }
  const p = resolveLocal(parentDir(nbPath), decodeURIComponent(src.replace(/[?#].*$/, '')))
  const ext = p.split('.').pop()?.toLowerCase() ?? ''
  const r = await window.api.fs.readBinary(p)
  if (!r.ok || r.size > 20 * 1024 * 1024) return null
  return `data:${IMG_MIME[ext] ?? 'application/octet-stream'};base64,${bytesToB64(r.data)}`
}

/* ---------------- HTML ---------------- */

/** Markdown → 静态 HTML：图片内嵌，去掉对话界面用的复制按钮和“打开文件”链接，标题级别还原 */
async function markdownHtml(text: string, cell: Cell, nbPath: string): Promise<string> {
  const pending: Promise<void>[] = []
  const root = renderMarkdown(text, {
    image: (src, alt) => {
      const img = h('img', { alt })
      pending.push(
        imageUrl(src, cell, nbPath).then((u) => {
          if (u) img.setAttribute('src', u)
          else img.replaceWith(document.createTextNode(alt))
        })
      )
      return img
    }
  })
  // 代码块：换成导出页自己的高亮（对话里的高亮跟随 IDE 主题，还带复制按钮）
  for (const block of [...root.querySelectorAll<HTMLElement>('.md-code')]) {
    const lang = block.querySelector('.md-code-head span')?.textContent ?? ''
    const code = block.querySelector('pre code')?.textContent ?? ''
    const pre = document.createElement('pre')
    pre.className = 'code'
    pre.innerHTML = `<code>${highlight(code, langId(lang))}</code>`
    block.replaceWith(pre)
  }
  // 对话里标题降了两级（h1 → h3），这里还原
  for (const el of [...root.querySelectorAll<HTMLElement>('.md-h')]) {
    const level = Math.max(1, Number(el.tagName.slice(1)) - 2)
    const n = document.createElement(`h${level}`)
    n.append(...el.childNodes)
    el.replaceWith(n)
  }
  // “打开文件”链接：行内代码还原成 code，普通链接用相对路径
  for (const a of [...root.querySelectorAll<HTMLAnchorElement>('a.md-file')]) {
    if (a.classList.contains('md-ic')) {
      const c = document.createElement('code')
      c.textContent = a.textContent
      a.replaceWith(c)
    } else {
      const target = (a.title || '').replace(/:\d+$/, '')
      const n = document.createElement('a')
      n.href = encodeURI(target.replace(/\\/g, '/'))
      n.textContent = a.textContent
      a.replaceWith(n)
    }
  }
  await Promise.all(pending)
  root.className = 'md'
  return root.innerHTML
}

function ansiHtml(text: string): string {
  const box = document.createElement('div')
  box.append(ansi(applyCR(text)))
  return box.innerHTML
}

async function outputHtml(o: Json, nbPath: string, cell: Cell, prompts: boolean): Promise<string> {
  const type = String(o.output_type)
  if (type === 'stream') return `<pre class="stream${o.name === 'stderr' ? ' stderr' : ''}">${ansiHtml(joinText(o.text))}</pre>`
  if (type === 'error') {
    const tb = Array.isArray(o.traceback) && o.traceback.length ? (o.traceback as string[]).join('\n') : `${o.ename}: ${o.evalue}`
    return `<pre class="error">${ansiHtml(tb)}</pre>`
  }
  if (type !== 'execute_result' && type !== 'display_data') return ''
  const data = (o.data ?? {}) as Json
  const meta = (o.metadata ?? {}) as Json
  const mime = MIME_ORDER.find((m) => m in data)
  if (!mime) return ''
  const v = data[mime]
  const m = (meta[mime] ?? {}) as Json
  const size = [typeof m.width === 'number' ? `width="${m.width}"` : '', typeof m.height === 'number' ? `height="${m.height}"` : ''].join(' ')
  let body: string
  switch (mime) {
    case 'text/html':
      // 和 Jupyter 导出一致：HTML 输出原样放进页面（表格、图表）
      body = `<div class="html">${joinText(v)}</div>`
      break
    case 'image/svg+xml':
      body = `<img ${size} alt="" src="data:image/svg+xml;charset=utf-8,${encodeURIComponent(joinText(v))}">`
      break
    case 'image/png':
    case 'image/jpeg':
    case 'image/gif':
    case 'image/webp':
      body = `<img ${size} alt="" src="data:${mime};base64,${sanitizeB64(joinText(v))}">`
      break
    case 'text/markdown':
      body = `<div class="md">${await markdownHtml(joinText(v), cell, nbPath)}</div>`
      break
    case 'application/json':
      body = `<pre class="stream">${esc(JSON.stringify(v, null, 2))}</pre>`
      break
    default:
      body = `<pre class="stream">${ansiHtml(joinText(v))}</pre>`
  }
  const prompt = prompts && type === 'execute_result' && cell.count != null ? `<div class="prompt out">Out [${cell.count}]:</div>` : prompts ? '<div class="prompt"></div>' : ''
  return prompt ? `<div class="row">${prompt}<div class="body">${body}</div></div>` : body
}

async function buildHtml(src: ExportSource, o: Options, forPdf: boolean): Promise<string> {
  const parts: string[] = []
  for (const c of cellsOf(src.data)) {
    if (c.type === 'markdown') {
      if (c.source.trim()) parts.push(`<section class="cell markdown"><div class="md">${await markdownHtml(c.source, c, src.path)}</div></section>`)
      continue
    }
    if (c.type === 'raw') {
      if (o.code && c.source.trim()) parts.push(`<section class="cell raw"><pre class="code">${esc(c.source)}</pre></section>`)
      continue
    }
    const showCode = o.code && !c.hideInput && c.source.trim() !== ''
    const outs = o.outputs && !c.hideOutput ? (await Promise.all(c.outputs.map((x) => outputHtml(x, src.path, c, o.prompts)))).filter(Boolean) : []
    if (!showCode && !outs.length) continue
    const input = showCode
      ? o.prompts
        ? `<div class="row"><div class="prompt in">In [${c.count ?? ' '}]:</div><div class="body"><pre class="code input"><code>${highlight(c.source, src.lang)}</code></pre></div></div>`
        : `<pre class="code input"><code>${highlight(c.source, src.lang)}</code></pre>`
      : ''
    parts.push(`<section class="cell code">${input}${outs.length ? `<div class="outputs">${outs.join('')}</div>` : ''}</section>`)
  }
  const theme = forPdf && o.theme === 'auto' ? 'light' : o.theme
  return `<!doctype html>
<html lang="${document.documentElement.lang || 'en'}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="Infinite Studio">
<title>${esc(o.title)}</title>
<style>${exportCss(theme)}</style>
</head>
<body>
<main class="notebook${o.prompts ? ' with-prompts' : ''}">
${o.title ? `<header class="doc-title"><h1>${esc(o.title)}</h1></header>` : ''}
${parts.join('\n')}
</main>
</body>
</html>
`
}

const LIGHT = `--bg:#ffffff;--fg:#1f2328;--muted:#656d76;--line:#d8dee4;--code-bg:#f6f8fa;--accent:#0969da;--err-bg:#fff5f5;--stderr-bg:#fff8e6;
--k:#cf222e;--s:#0a3069;--c:#6e7781;--n:#0550ae;--y:#953800;--f:#8250df;--d:#116329;--o:#1f2328;
--ansi-black:#24292f;--ansi-red:#cf222e;--ansi-green:#116329;--ansi-yellow:#9a6700;--ansi-blue:#0969da;--ansi-magenta:#8250df;--ansi-cyan:#1b7c83;--ansi-white:#6e7781;
--ansi-bright-black:#57606a;--ansi-bright-red:#a40e26;--ansi-bright-green:#1a7f37;--ansi-bright-yellow:#633c01;--ansi-bright-blue:#218bff;--ansi-bright-magenta:#a475f9;--ansi-bright-cyan:#3192aa;--ansi-bright-white:#8c959f;`

const DARK = `--bg:#16151b;--fg:#e6e3ec;--muted:#9a95a6;--line:#2c2a35;--code-bg:#201e27;--accent:#8ab4ff;--err-bg:#2a1a1e;--stderr-bg:#2a2418;
--k:#ff7b72;--s:#a5d6ff;--c:#8b949e;--n:#79c0ff;--y:#ffa657;--f:#d2a8ff;--d:#7ee787;--o:#e6e3ec;
--ansi-black:#484f58;--ansi-red:#ff7b72;--ansi-green:#3fb950;--ansi-yellow:#d29922;--ansi-blue:#58a6ff;--ansi-magenta:#bc8cff;--ansi-cyan:#39c5cf;--ansi-white:#b1bac4;
--ansi-bright-black:#6e7681;--ansi-bright-red:#ffa198;--ansi-bright-green:#56d364;--ansi-bright-yellow:#e3b341;--ansi-bright-blue:#79c0ff;--ansi-bright-magenta:#d2a8ff;--ansi-bright-cyan:#56d4dd;--ansi-bright-white:#f0f6fc;`

function exportCss(theme: Theme): string {
  const vars = theme === 'dark' ? `:root{${DARK}color-scheme:dark}` : theme === 'light' ? `:root{${LIGHT}color-scheme:light}` : `:root{${LIGHT}color-scheme:light dark}@media (prefers-color-scheme:dark){:root{${DARK}}}`
  return `${vars}
*{box-sizing:border-box}
html{background:var(--bg);color:var(--fg)}
body{margin:0;font:15px/1.6 system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;-webkit-print-color-adjust:exact;print-color-adjust:exact}
main{max-width:980px;margin:0 auto;padding:40px 32px 64px}
.doc-title h1{margin:0 0 28px;font-size:28px;line-height:1.25;font-weight:650;letter-spacing:-.01em}
.cell{margin:0 0 18px}
.row{display:flex;gap:12px;align-items:flex-start}
.row>.body{flex:1;min-width:0}
.prompt{flex:0 0 72px;text-align:right;font:12px/1.5 ui-monospace,"Cascadia Code",Consolas,monospace;color:var(--muted);padding-top:9px;white-space:nowrap}
.prompt.out{padding-top:4px}
.with-prompts .cell.markdown,.with-prompts .cell.raw{padding-left:84px}
pre,code{font-family:ui-monospace,"Cascadia Code","JetBrains Mono",Consolas,monospace;font-size:13px}
pre{margin:0;white-space:pre-wrap;word-break:break-word;tab-size:4}
pre.code{background:var(--code-bg);border:1px solid var(--line);border-radius:8px;padding:10px 14px;line-height:1.5;overflow-x:auto}
.outputs{margin-top:8px;display:flex;flex-direction:column;gap:6px}
pre.stream{padding:2px 0;line-height:1.45}
pre.stream.stderr{background:var(--stderr-bg);padding:6px 10px;border-radius:6px}
pre.error{background:var(--err-bg);padding:8px 12px;border-radius:6px;line-height:1.45}
.outputs img{max-width:100%;height:auto}
.html{overflow-x:auto}
.k{color:var(--k)}.s{color:var(--s)}.c{color:var(--c);font-style:italic}.n{color:var(--n)}.y{color:var(--y)}.f{color:var(--f)}.d{color:var(--d)}.o{color:var(--o)}
.md{overflow-wrap:break-word}
.md>:first-child{margin-top:0}.md>:last-child{margin-bottom:0}
.md h1,.md h2,.md h3,.md h4,.md h5,.md h6{line-height:1.3;margin:1.3em 0 .5em;font-weight:620}
.md h1{font-size:1.75em;padding-bottom:.25em;border-bottom:1px solid var(--line)}
.md h2{font-size:1.4em;padding-bottom:.2em;border-bottom:1px solid var(--line)}
.md h3{font-size:1.18em}.md h4{font-size:1em}
.md p,.md ul,.md ol,.md blockquote,.md pre,.md table{margin:0 0 .8em}
.md ul,.md ol{padding-left:1.6em}
.md li.md-task{list-style:none;margin-left:-1.3em}
.md li.md-task input{margin-right:.5em}
.md blockquote{margin-left:0;padding:0 1em;color:var(--muted);border-left:3px solid var(--line)}
.md code{background:var(--code-bg);border-radius:4px;padding:.1em .35em;font-size:.88em}
.md pre code{background:none;padding:0;font-size:13px}
.md a{color:var(--accent);text-decoration:none}.md a:hover{text-decoration:underline}
.md img{max-width:100%}
.md hr{border:0;border-top:1px solid var(--line);margin:1.5em 0}
table{border-collapse:collapse;border-spacing:0;font-size:13px;font-variant-numeric:tabular-nums;margin:2px 0}
th,td{padding:5px 12px;border-bottom:1px solid var(--line);text-align:left}
.html th,.html td{text-align:right;white-space:nowrap}
thead th{font-weight:600;border-bottom:1px solid var(--muted)}
.html tbody tr:nth-child(odd){background:var(--code-bg)}
@media print{
  main{max-width:none;padding:0}
  pre.code,pre.error,img,tr{break-inside:avoid}
  h1,h2,h3{break-after:avoid}
}
@media (max-width:640px){main{padding:24px 16px}.prompt{display:none}.with-prompts .cell.markdown,.with-prompts .cell.raw{padding-left:0}}
`
}

/* ---------------- Markdown ---------------- */

const stripAnsi = (s: string): string => s.replace(/\x1b\[[\d;?]*[A-Za-z]|\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')

function fence(text: string, lang = ''): string {
  const longest = Math.max(2, ...[...text.matchAll(/`{3,}/g)].map((m) => m[0].length))
  const f = '`'.repeat(longest + 1)
  return `${f}${lang}\n${text.replace(/\n$/, '')}\n${f}`
}

function outputMd(o: Json): string {
  const type = String(o.output_type)
  if (type === 'stream') return fence(stripAnsi(applyCR(joinText(o.text))))
  if (type === 'error') return fence(stripAnsi(Array.isArray(o.traceback) && o.traceback.length ? (o.traceback as string[]).join('\n') : `${o.ename}: ${o.evalue}`))
  if (type !== 'execute_result' && type !== 'display_data') return ''
  const data = (o.data ?? {}) as Json
  for (const mime of MIME_ORDER) {
    if (!(mime in data)) continue
    const v = data[mime]
    if (mime === 'text/html') return joinText(v).trim()
    if (mime === 'image/svg+xml') return `![](data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(joinText(v))))})`
    if (mime.startsWith('image/')) return `![](data:${mime};base64,${sanitizeB64(joinText(v))})`
    if (mime === 'text/markdown') return joinText(v).trim()
    if (mime === 'text/latex') return joinText(v).trim()
    if (mime === 'application/json') return fence(JSON.stringify(v, null, 2), 'json')
    return fence(stripAnsi(joinText(v)))
  }
  return ''
}

/** 附件 attachment:xxx 换成 data: 地址（Markdown 文件里没有附件这个概念） */
function inlineAttachments(c: Cell): string {
  const atts = (c.raw.attachments ?? {}) as Record<string, Record<string, string>>
  return c.source.replace(/\(attachment:([^)\s]+)/g, (all, name: string) => {
    const att = atts[decodeURIComponent(name)]
    const mime = att && Object.keys(att).find((k) => k.startsWith('image/'))
    return att && mime ? `(data:${mime};base64,${sanitizeB64(joinText(att[mime]))}` : all
  })
}

function buildMarkdown(src: ExportSource, o: Options): string {
  const parts: string[] = o.title ? [`# ${o.title}`] : []
  for (const c of cellsOf(src.data)) {
    if (c.type === 'markdown') {
      if (c.source.trim()) parts.push(inlineAttachments(c).trim())
    } else if (c.type === 'raw') {
      if (o.code && c.source.trim()) parts.push(c.source.trim())
    } else {
      if (o.code && !c.hideInput && c.source.trim()) parts.push(fence(c.source, src.lang === 'plaintext' ? '' : src.lang))
      if (o.outputs && !c.hideOutput) for (const x of c.outputs) {
        const s = outputMd(x)
        if (s) parts.push(s)
      }
    }
  }
  return parts.join('\n\n') + '\n'
}

/* ---------------- 脚本 ---------------- */

function buildScript(src: ExportSource, o: Options): string {
  const cm = commentPrefix(src.lang)
  const parts: string[] = []
  for (const c of cellsOf(src.data)) {
    if (c.type === 'code') {
      if (!c.hideInput && c.source.trim()) parts.push(`${cm} %%\n${c.source.replace(/\n+$/, '')}`)
    } else if (c.type === 'markdown' && o.mdComments && c.source.trim()) {
      parts.push(`${cm} %% [markdown]\n${c.source.trim().split('\n').map((l) => (l ? `${cm} ${l}` : cm)).join('\n')}`)
    }
  }
  return parts.join('\n\n') + '\n'
}

/* ---------------- 执行导出 ---------------- */

const FILTERS: Record<Format, (ext: string) => { name: string; extensions: string[] }> = {
  html: () => ({ name: 'HTML', extensions: ['html'] }),
  pdf: () => ({ name: 'PDF', extensions: ['pdf'] }),
  md: () => ({ name: 'Markdown', extensions: ['md'] }),
  script: (ext) => ({ name: t('脚本'), extensions: [ext] })
}

async function runExport(src: ExportSource, o: Options): Promise<string | null> {
  const ext = extOf(o, src)
  const base = basename(src.path).replace(/\.ipynb$/i, '')
  const out = await window.api.fs.saveDialog({ title: t('导出 Notebook'), defaultPath: `${parentDir(src.path)}${src.path.includes('\\') ? '\\' : '/'}${base}.${ext}`, filters: [FILTERS[o.format](ext)] })
  if (!out) return null
  if (o.format === 'pdf') await window.api.fs.htmlToPdf(await buildHtml(src, o, true), out)
  else if (o.format === 'html') await window.api.fs.writeFile(out, await buildHtml(src, o, false))
  else if (o.format === 'md') await window.api.fs.writeFile(out, buildMarkdown(src, o))
  else await window.api.fs.writeFile(out, buildScript(src, o))
  return out
}

/* ---------------- 对话框 ---------------- */

let dialogEl: HTMLElement | null = null

export function openNotebookExport(src: ExportSource): void {
  if (dialogEl) return
  const lastFocus = document.activeElement as HTMLElement | null
  // Notebook 第一个单元格已经是一级标题时不再加标题，免得重复
  const first = cellsOf(src.data)[0]
  const hasH1 = first?.type === 'markdown' && /^\s*#\s/.test(first.source)
  const o: Options = { ...loadOptions(), title: hasH1 ? '' : basename(src.path).replace(/\.ipynb$/i, '') }
  let busy = false

  const close = () => {
    if (!dialogEl || busy) return
    dialogEl.remove()
    dialogEl = null
    lastFocus?.focus?.()
  }

  const seg = <V extends string>(label: string, options: [V, string][], get: () => V, set: (v: V) => void): HTMLElement => {
    const group = h('div', { class: 'np-seg', role: 'radiogroup', 'aria-label': label })
    const paint = () => {
      for (const b of group.children) {
        const on = (b as HTMLElement).dataset.v === get()
        b.classList.toggle('on', on)
        b.setAttribute('aria-checked', String(on))
      }
    }
    for (const [v, text] of options) group.append(h('button', { type: 'button', role: 'radio', 'data-v': v, onClick: () => (set(v), paint(), refresh()) }, text))
    paint()
    return group
  }
  const check = (label: string, get: () => boolean, set: (v: boolean) => void): { el: HTMLElement; input: HTMLInputElement } => {
    const input = h('input', { type: 'checkbox', onChange: () => (set(input.checked), refresh()) }) as HTMLInputElement
    input.checked = get()
    return { el: h('label', { class: 'check-row np-check' }, input, h('span', {}, label)), input }
  }
  const row = (label: string, ...control: (Node | null)[]): HTMLElement => h('div', { class: 'np-row' }, h('span', { class: 'np-label' }, label), h('div', { class: 'np-control' }, ...control))

  const titleInput = h('input', { class: 'text-input', value: o.title, spellcheck: 'false', onInput: () => (o.title = titleInput.value.trim()) }) as HTMLInputElement
  const cCode = check(t('代码'), () => o.code, (v) => (o.code = v))
  const cOut = check(t('输出'), () => o.outputs, (v) => (o.outputs = v))
  const cPrompt = check(t('执行序号 In [n]'), () => o.prompts, (v) => (o.prompts = v))
  const cMd = check(t('Markdown 单元格写成注释'), () => o.mdComments, (v) => (o.mdComments = v))
  const themeRow = row(t('配色'), seg(t('配色'), [['light', t('浅色')], ['dark', t('深色')], ['auto', t('跟随系统')]], () => o.theme, (v) => (o.theme = v)))
  const titleRow = row(t('标题'), titleInput)
  const contentRow = row(t('包含'), h('div', { class: 'np-checks' }, cCode.el, cOut.el, cPrompt.el))
  const scriptRow = row(t('包含'), h('div', { class: 'np-checks' }, cMd.el))
  const hint = h('p', { class: 'np-path' })
  const status = h('span', { class: 'help-status' })

  const refresh = () => {
    const script = o.format === 'script'
    const visual = o.format === 'html' || o.format === 'pdf'
    contentRow.hidden = script
    scriptRow.hidden = !script
    themeRow.hidden = !visual
    titleRow.hidden = script
    cPrompt.input.disabled = !visual
    cPrompt.el.style.opacity = visual ? '' : '0.5'
    const ext = extOf(o, src)
    hint.textContent =
      o.format === 'html'
        ? t('单个 .html 文件，图片内嵌，可以直接发给别人用浏览器打开。')
        : o.format === 'pdf'
          ? t('A4 页面。依赖脚本的交互式图表（如 Plotly）在 PDF 里不会显示，静态图片和表格正常。')
          : o.format === 'md'
            ? t('代码放在代码块里，图片以 data: 地址内嵌。')
            : t('导出为 .{0}，单元格之间用 “%%” 分隔，VS Code 和 Jupytext 都能按单元格运行。', ext)
  }

  const go = h('button', { class: 'btn primary', onClick: () => void doExport() }, t('导出…')) as HTMLButtonElement
  const doExport = async () => {
    if (busy) return
    if (o.format !== 'script' && !o.code && !o.outputs) return void (status.textContent = t('代码和输出至少要包含一项'))
    saveOptions(o)
    busy = true
    go.disabled = true
    status.className = 'help-status'
    status.textContent = o.format === 'pdf' ? t('正在生成 PDF…') : t('正在导出…')
    try {
      const out = await runExport(src, o)
      busy = false
      if (!out) {
        status.textContent = ''
        go.disabled = false
        return
      }
      close()
      toast(t('已导出：{0}', basename(out)))
    } catch (e) {
      busy = false
      go.disabled = false
      status.className = 'help-status err'
      status.textContent = t('导出失败：') + String((e as Error)?.message ?? e)
    }
  }

  const body = h(
    'div',
    { class: 'np-form nbx-form' },
    row(t('格式'), seg(t('格式'), [['html', 'HTML'], ['pdf', 'PDF'], ['md', 'Markdown'], ['script', t('脚本')]], () => o.format, (v) => (o.format = v))),
    hint,
    titleRow,
    contentRow,
    scriptRow,
    themeRow,
    h('p', { class: 'np-path nbx-tags' }, t('单元格标签：remove-cell 不导出整个单元格，remove-input / hide-input 只隐藏代码，remove-output / hide-output 只隐藏输出。'))
  )
  const card = h(
    'div',
    { class: 'help-card nbx-card', role: 'dialog', 'aria-modal': 'true', 'aria-label': t('导出 Notebook') },
    h('div', { class: 'help-head' }, h('h2', {}, t('导出 Notebook')), h('button', { class: 'icon-btn small help-close', 'aria-label': t('关闭'), title: t('关闭'), html: icons.close, onClick: close })),
    body,
    h('div', { class: 'help-actions' }, status, h('button', { class: 'btn', onClick: close }, t('取消')), go)
  )
  dialogEl = h(
    'div',
    {
      class: 'palette-backdrop help-backdrop',
      onMousedown: (e: MouseEvent) => {
        if (e.target === dialogEl) close()
      },
      onKeydown: (e: KeyboardEvent) => {
        if (e.key === 'Escape') {
          e.stopPropagation()
          close()
        } else if (e.key === 'Enter' && (e.target as HTMLElement).tagName === 'INPUT' && (e.target as HTMLInputElement).type === 'text') void doExport()
      }
    },
    card
  )
  refresh()
  document.body.append(dialogEl)
  go.focus()
}
