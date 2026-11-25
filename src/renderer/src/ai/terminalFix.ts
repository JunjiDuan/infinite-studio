import { basename, h } from '../dom'
import { t } from '../i18n'
import { getEditor, isUnder, normPath, openFile } from '../editor'
import { onTerminalData, onTerminalInput, terminalTail, type TermInfo } from '../panel'
import { state } from '../store'
import { aiSettings } from './client'
import { contextBlock, openAnswer } from './answerView'
import { fixRegion } from './inlineEdit'
import { relPath } from './context'

/**
 * 终端报错一键解释 / 修复：
 * 终端输出安静下来后，看新输出里有没有编译错误、异常堆栈、测试失败等；有就在终端右上角显示一个按钮。
 * 点击后在编辑器旁边打开 AI 解释（可以追问），并列出报错里提到的项目文件，点一下就在那几行上开始 AI 修复。
 */

const QUIET_MS = 700
const ERROR_PATTERNS: RegExp[] = [
  /Traceback \(most recent call last\)/,
  /^\s*(?:[\w.$]+\.)?\w*(?:Error|Exception)(?::|\s+in\s)/m,
  /\berror(?:\[[A-Z]?\d+\])?:\s/i,
  /\berror (?:TS|CS|C|LNK)\d+\b/,
  /npm ERR!|ERR_PNPM_|error Command failed/,
  /panicked at /,
  /Exception in thread "/,
  /BUILD FAILURE|BUILD FAILED|FAILURE: Build failed/,
  /Segmentation fault|core dumped/,
  /command not found|is not recognized as (?:an internal or external command|the name of a cmdlet)/,
  /^\s*(?:FAIL|FAILED)\b/m,
  /\b[1-9]\d* (?:failed|failing)\b/,
  /^fatal: /m,
  /Unhandled(?:PromiseRejection| exception)/
]

interface Watch {
  pending: string
  timer?: ReturnType<typeof setTimeout>
  btn?: HTMLElement
  hideTimer?: ReturnType<typeof setTimeout>
}

const watches = new Map<number, Watch>()

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Za-z0-9]/g, '')

function hasError(text: string): boolean {
  return ERROR_PATTERNS.some((re) => re.test(text))
}

function hideButton(w: Watch): void {
  clearTimeout(w.hideTimer)
  w.btn?.remove()
  w.btn = undefined
}

function showButton(info: TermInfo, w: Watch): void {
  hideButton(w)
  const btn = h(
    'div',
    { class: 'ai-term-fix', role: 'group', 'aria-label': t('AI 解释并修复') },
    h('button', { class: 'ai-term-fix-main', title: t('用 AI 分析终端里的报错'), onClick: () => (hideButton(w), explain(info)) }, h('span', { class: 'ai-edit-mark' }, '✦'), t('AI 解释并修复')),
    h('button', { class: 'ai-term-fix-x', 'aria-label': t('关闭'), title: t('关闭'), onClick: () => hideButton(w) }, '×')
  )
  info.el.append(btn)
  w.btn = btn
  w.hideTimer = setTimeout(() => hideButton(w), 90_000)
}

/* ---------------- 报错里提到的文件 ---------------- */

interface FileRef {
  path: string
  line: number
}

const REF_PATTERNS: RegExp[] = [
  /File "([^"]+)", line (\d+)/g,
  /((?:[A-Za-z]:)?[\w.\-/\\@~]+\.[A-Za-z]{1,6})\((\d+),\d+\)/g,
  /((?:[A-Za-z]:)?[\w.\-/\\@~]+\.[A-Za-z]{1,6}):(\d+)(?::\d+)?/g,
  /at [^(]*\(((?:[A-Za-z]:)?[^():]+\.[A-Za-z]{1,6}):(\d+):\d+\)/g
]

function joinRoot(p: string): string {
  if (/^([A-Za-z]:[\\/]|\/)/.test(p)) return normPath(p)
  const root = state.root ?? ''
  const sep = root.includes('\\') ? '\\' : '/'
  return normPath(root.replace(/[\\/]+$/, '') + sep + p.replace(/^\.[\\/]/, '').replace(/[\\/]/g, sep))
}

async function fileRefs(text: string): Promise<FileRef[]> {
  const root = state.root
  if (!root) return []
  const seen = new Set<string>()
  const cands: FileRef[] = []
  for (const re of REF_PATTERNS) {
    for (const m of text.matchAll(re)) {
      const raw = m[1]
      if (/^https?:/.test(raw) || /node_modules|site-packages|dist-packages|[\\/]lib[\\/]python|<frozen|\.cargo[\\/]registry/.test(raw)) continue
      const path = joinRoot(raw)
      const line = Number(m[2])
      const key = `${path.toLowerCase()}:${line}`
      if (!line || seen.has(key) || !isUnder(path, root)) continue
      seen.add(key)
      cands.push({ path, line })
    }
  }
  // 最内层（最后出现）的位置通常最接近出错点：倒过来，每个文件只留一处
  const out: FileRef[] = []
  const files = new Set<string>()
  for (const c of cands.reverse()) {
    if (files.has(c.path.toLowerCase())) continue
    const r = await window.api.fs.readFile(c.path).catch(() => null)
    if (!r?.ok) continue
    files.add(c.path.toLowerCase())
    out.push(c)
    if (out.length >= 4) break
  }
  return out
}

/* ---------------- 解释与修复 ---------------- */

const SYSTEM = [
  'You are an expert developer helping inside an IDE. The user ran a command in the terminal and it failed.',
  'Explain concisely, in the language the user writes in (default: the language of the IDE UI, Simplified Chinese if unsure):',
  '1. What went wrong (one or two sentences).',
  '2. The root cause.',
  '3. How to fix it: show the corrected code or the command to run. When the fix is in a project file, name it as `path:line`.',
  'Keep it short and practical. Do not repeat the whole log.'
].join('\n')

async function fix(ref: FileRef, output: string, analysis: string): Promise<void> {
  const tab = await openFile(ref.path, { line: ref.line })
  if (!tab) return
  const editor = getEditor()
  if (editor.getModel() !== tab.model) return
  const instruction = [
    'Running the program / build failed with this terminal output:',
    '```',
    output.split('\n').slice(-80).join('\n'),
    '```',
    analysis ? `Analysis of the error:\n${analysis.slice(0, 3000)}` : '',
    `The error points at line ${ref.line} of this file. Fix the code in the region so the error no longer occurs, changing as little as possible.`
  ]
    .filter(Boolean)
    .join('\n\n')
  fixRegion(editor, ref.line - 4, ref.line + 4, instruction, t('修复终端报错：{0}:{1}', basename(ref.path), ref.line))
}

async function explain(info: TermInfo): Promise<void> {
  const output = terminalTail(info.term, 150)
  const refs = await fileRefs(output)
  const prompt = [
    `Terminal: ${info.title}`,
    state.root ? `Project folder: ${state.root}` : '',
    '',
    'Terminal output (most recent last):',
    '```',
    output,
    '```',
    refs.length ? `\nProject files mentioned in the output: ${refs.map((r) => `${relPath(r.path)}:${r.line}`).join(', ')}` : ''
  ].join('\n')
  openAnswer({
    key: 'ai-terminal',
    title: t('AI：终端报错'),
    system: SYSTEM,
    prompt,
    context: contextBlock(t('终端输出（{0}）', info.title), output.split('\n').slice(-60).join('\n')),
    actions: (answer) =>
      refs.map((r) =>
        h('button', { class: 'btn small primary', title: t('打开文件并用 AI 修复这几行'), onClick: () => void fix(r, output, answer) }, '✦ ' + t('修复 {0}:{1}', relPath(r.path), r.line))
      ),
    placeholder: t('继续追问，例如“为什么会这样”')
  })
}

export function initTerminalFix(): void {
  onTerminalData((info, data) => {
    if (!aiSettings().terminalFix) return
    let w = watches.get(info.id)
    if (!w) watches.set(info.id, (w = { pending: '' }))
    w.pending = (w.pending + stripAnsi(data)).slice(-20_000)
    clearTimeout(w.timer)
    const cur = w
    w.timer = setTimeout(() => {
      const text = cur.pending
      cur.pending = ''
      if (hasError(text)) showButton(info, cur)
    }, QUIET_MS)
  })
  // 用户回车执行新命令：之前的提示作废
  onTerminalInput((id, data) => {
    const w = watches.get(id)
    if (w && /[\r\n]/.test(data)) {
      hideButton(w)
      w.pending = ''
    }
  })
}
