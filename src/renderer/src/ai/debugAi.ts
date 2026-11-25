import { basename, h, toast } from '../dom'
import { t } from '../i18n'
import { debugSnapshot, setDebugAiHandler, type DebugSnapshot } from '../debug'
import { getEditor, openFile } from '../editor'
import { contextBlock, openAnswer } from './answerView'
import { fixRegion } from './inlineEdit'
import { relPath } from './context'

/**
 * 调试时的 AI：程序停在断点 / 异常处时，把调用堆栈、当前代码和变量交给模型，回答“为什么这个值不对”之类的问题。
 */

const SYSTEM = [
  'You are an expert debugger helping a developer inside an IDE. The program is paused in the debugger.',
  'You get the stop reason, the call stack, the source around the current line (marked with ">"), the variables in scope, and recent console output.',
  'Answer the question using these concrete values: point out which variable holds an unexpected value, trace back where it likely came from, and name the line(s) responsible as `path:line`.',
  'If the cause is a bug, propose the fix as a short code snippet. If more information is needed, say exactly which expression to evaluate or where to set the next breakpoint.',
  'Be concise. Write in the language of the IDE UI (Simplified Chinese if unsure).'
].join(' ')

function describe(s: DebugSnapshot): string {
  const vars = s.scopes
    .map(
      (sc) =>
        `[${sc.name}]\n` +
        (sc.vars.length
          ? sc.vars
              .map((v) => `${v.name}${v.type ? ` (${v.type})` : ''} = ${v.value}` + (v.children?.length ? '\n' + v.children.map((c) => `    .${c.name}${c.type ? ` (${c.type})` : ''} = ${c.value}`).join('\n') : ''))
              .join('\n')
          : '(none)')
    )
    .join('\n\n')
  return [
    `Language: ${s.language}; program: ${relPath(s.program)}`,
    `Stop reason: ${s.stopReason || 'unknown'}`,
    '',
    'Call stack (innermost first; * = selected frame):',
    s.frames.map((f, i) => `${i === s.frameIndex ? '*' : ' '} ${f.name}  ${f.path ? `${relPath(f.path)}:${f.line}` : ''}`).join('\n'),
    '',
    s.current ? `Source of the selected frame, ${relPath(s.current.path)}:\n\`\`\`\n${s.current.source}\n\`\`\`` : '(source not available)',
    '',
    'Variables:',
    vars,
    s.console.trim() ? `\nRecent debug console output:\n\`\`\`\n${s.console.trim()}\n\`\`\`` : ''
  ].join('\n')
}

export async function askDebugAi(question?: string): Promise<void> {
  const snap = await debugSnapshot()
  if (!snap) return toast(t('程序暂停时才能问 AI'))
  const q = question?.trim() || (snap.stopReason === 'exception' ? t('程序为什么抛出这个异常？怎么修复？') : t('程序为什么停在这里？当前变量的值有没有不对的地方？'))
  const ctx = describe(snap)
  const cur = snap.current
  openAnswer({
    key: 'ai-debug',
    title: t('AI 调试助手'),
    system: SYSTEM,
    prompt: `${ctx}\n\nQuestion: ${q}`,
    context: h('div', {}, h('div', { class: 'ai-answer-q' }, q), contextBlock(t('调试状态（调用堆栈、变量）'), ctx)),
    actions: (answer) =>
      cur
        ? [
            h(
              'button',
              {
                class: 'btn small primary',
                title: t('打开文件并用 AI 修复这几行'),
                onClick: async () => {
                  const tab = await openFile(cur.path, { line: cur.line })
                  const ed = getEditor()
                  if (!tab || ed.getModel() !== tab.model) return
                  fixRegion(
                    ed,
                    cur.line - 4,
                    cur.line + 4,
                    `While debugging, the program paused here (${snap.stopReason || 'breakpoint'}). Debug state:\n${ctx.slice(0, 8000)}\n\nAnalysis:\n${answer.slice(0, 3000)}\n\nFix the bug in this region according to the analysis, changing as little as possible.`,
                    t('按调试分析修复：{0}:{1}', basename(cur.path), cur.line)
                  )
                }
              },
              '✦ ' + t('修复 {0}:{1}', relPath(cur.path), cur.line)
            )
          ]
        : [],
    placeholder: t('继续追问，例如“x 为什么是 None”')
  })
}

export function initDebugAi(): void {
  setDebugAiHandler(() => void askDebugAi())
}
