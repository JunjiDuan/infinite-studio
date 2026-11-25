import { h, toast } from '../dom'
import { t } from '../i18n'
import { streamChat } from './client'
import { contextBlock, openAnswer } from './answerView'
import { withRules } from './context'

/**
 * 源代码管理里的 AI：根据改动生成提交信息、审查当前改动。
 */

/** 改动的 diff：优先暂存区，没有暂存时用工作区 */
async function changes(root: string): Promise<{ diff: string; staged: boolean }> {
  const staged = await window.api.git.diff(root, true)
  if (staged.trim()) return { diff: staged, staged: true }
  return { diff: await window.api.git.diff(root, false), staged: false }
}

function diffStat(diff: string): { files: number; added: number; removed: number } {
  let files = 0
  let added = 0
  let removed = 0
  for (const l of diff.split('\n')) {
    if (l.startsWith('diff --git')) files++
    else if (l.startsWith('+') && !l.startsWith('+++')) added++
    else if (l.startsWith('-') && !l.startsWith('---')) removed++
  }
  return { files, added, removed }
}

const COMMIT_SYSTEM = [
  'You write git commit messages.',
  'Given a diff and the subjects of recent commits in this repository, write one commit message for the diff.',
  "Match the repository's existing convention (language, prefixes such as \"feat:\" or \"Area:\", capitalization, length).",
  'First line: a concise summary of at most about 72 characters. If the change is non-trivial, add a blank line and a few short bullet points explaining what changed and why.',
  'Reply with the commit message only: no code fences, no quotes, no explanation.'
].join(' ')

/**
 * 生成提交信息，onText 收到流式片段（调用方负责写进输入框）。
 * 返回取消函数和完成时的结果。
 */
export async function generateCommitMessage(root: string, onText: (full: string) => void): Promise<{ done: Promise<{ ok: boolean; text: string; error?: string }>; cancel: () => void } | null> {
  const { diff, staged } = await changes(root)
  if (!diff.trim()) return null
  const log = await window.api.git.log(root, 15).catch(() => null)
  const subjects = log?.ok ? log.commits.slice(0, 15).map((c) => `- ${c.subject}`).join('\n') : ''
  const user = [
    subjects ? `Recent commit subjects (newest first):\n${subjects}\n` : '',
    `Diff of the ${staged ? 'staged' : 'unstaged'} changes:`,
    '```diff',
    diff.slice(0, 120_000),
    '```'
  ].join('\n')
  let full = ''
  const system = await withRules(COMMIT_SYSTEM)
  const req = streamChat({ system, messages: [{ role: 'user', content: user }], maxTokens: 1024 }, (d) => {
    full += d
    onText(clean(full))
  })
  return {
    cancel: req.cancel,
    done: req.done.then((r) => (r.ok ? { ok: true, text: clean(r.text) } : { ok: false, text: clean(full), error: r.cancelled ? undefined : r.error }))
  }
}

function clean(s: string): string {
  return s
    .replace(/^\s*```[^\n]*\n?/, '')
    .replace(/\n?```\s*$/, '')
    .replace(/^["'“]|["'”]$/g, '')
    .trimStart()
}

const REVIEW_SYSTEM = [
  'You are a meticulous senior code reviewer. Review the diff for real problems:',
  'bugs and logic errors, unhandled edge cases, security issues, race conditions, resource leaks, broken error handling, performance traps, and API misuse.',
  'Ignore pure style nits unless they hide a bug.',
  'For each finding give: severity (High / Medium / Low), the location as `path:line` (path relative to the repository, line in the new file), what is wrong, and a concrete fix (a short code snippet when useful).',
  'Order findings by severity. If the change looks correct, say so briefly and mention anything worth testing.',
  'Write in the language of the IDE UI (Simplified Chinese if unsure), keep code identifiers as they are.'
].join(' ')

/** 审查当前改动（暂存区优先），结果在编辑器旁边的标签页里显示 */
export async function reviewChanges(root: string): Promise<boolean> {
  const { diff, staged } = await changes(root)
  if (!diff.trim()) return false
  const st = diffStat(diff)
  openAnswer({
    key: 'ai-review',
    title: t('AI 代码审查'),
    system: REVIEW_SYSTEM,
    prompt: [`Diff of the ${staged ? 'staged' : 'working tree'} changes (${st.files} files, +${st.added} −${st.removed}):`, '```diff', diff.slice(0, 160_000), '```'].join('\n'),
    context: contextBlock(t('{0}：{1} 个文件，+{2} −{3}', staged ? t('暂存的更改') : t('工作区更改'), st.files, st.added, st.removed), diff.slice(0, 20_000)),
    placeholder: t('继续追问，例如“第 2 条怎么改”')
  })
  return true
}

/** 提交信息输入框里的“✦”按钮 */
export function commitAiButton(getRoot: () => string | null, input: HTMLTextAreaElement, onChange: () => void): HTMLButtonElement {
  let cancel: (() => void) | null = null
  const btn: HTMLButtonElement = h('button', {
    class: 'scm-ai-btn',
    title: t('用 AI 生成提交信息'),
    'aria-label': t('用 AI 生成提交信息'),
    onClick: async () => {
      if (cancel) return cancel()
      const root = getRoot()
      if (!root) return
      btn.classList.add('busy')
      btn.title = t('停止生成')
      const before = input.value
      try {
        const job = await generateCommitMessage(root, (full) => {
          input.value = full
          onChange()
        })
        if (!job) {
          toast(t('没有可提交的更改'))
          return
        }
        cancel = job.cancel
        const r = await job.done
        if (!r.ok) {
          if (!r.text) input.value = before
          if (r.error) toast(r.error)
        } else input.value = r.text
        onChange()
      } finally {
        cancel = null
        btn.classList.remove('busy')
        btn.title = t('用 AI 生成提交信息')
      }
    }
  }, '✦')
  return btn
}
