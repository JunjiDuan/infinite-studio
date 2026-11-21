import { relative } from '../dom'
import { state } from '../store'
import { resolvePath } from './markdown'
import { t } from '../i18n'

export function errText(e: unknown): string {
  return String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}

/** 相对工作区的显示路径 */
export function rel(p: unknown): string {
  const s = String(p ?? '')
  return state.root ? relative(state.root, s) : s.replace(/\\/g, '/')
}

export function clip(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '\n…' : s
}

/** 读取文本文件；不存在时返回空串 */
export async function readText(p: string): Promise<string> {
  const r = await window.api.fs.readFile(resolvePath(p))
  if (r.ok) return r.content
  if (r.reason === 'missing') return ''
  throw new Error(r.reason === 'binary' ? t('二进制文件') : r.reason === 'too-large' ? t('文件太大') : t('无法读取'))
}

export function basenameOf(p: string): string {
  return p.split(/[\\/]/).pop() ?? p
}

/** 一条或多条 Markdown 待办 */
export function todoMarkdown(items: { content: string; status: string }[]): string {
  return items.map((t) => `- [${t.status === 'completed' ? 'x' : ' '}] ${t.status === 'in_progress' || t.status === 'inProgress' ? `**${t.content}**` : t.content}`).join('\n')
}

let seq = 0
export function uid(prefix = 'x'): string {
  return `${prefix}${Date.now().toString(36)}${(seq++).toString(36)}`
}
