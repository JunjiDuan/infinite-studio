import type { AiMessage } from '../../../shared/ai'
import { h, toast } from '../dom'
import { t } from '../i18n'
import { closeView, openView } from '../editor'
import { renderMarkdown } from '../agent/markdown'
import { modelLabel, streamChat } from './client'
import { withRules } from './context'

/**
 * 编辑器里的“AI 回答”标签页：流式显示 Markdown 回答，可以继续追问。
 * 终端报错解释、代码审查、调试助手共用。
 */

export interface AnswerOptions {
  /** 同一个 key 只开一个标签（再次打开时替换内容） */
  key: string
  title: string
  icon?: string
  system: string
  /** 第一条消息（完整上下文） */
  prompt: string
  /** 标签页顶部显示的上下文（终端输出、diff 统计等），可以折叠 */
  context?: HTMLElement
  /** 每次回答完成后显示在回答下面的按钮 */
  actions?: (answer: string) => HTMLElement[]
  placeholder?: string
}

interface Live {
  root: HTMLElement
  cancel?: () => void
}

const live = new Map<string, Live>()

export function openAnswer(o: AnswerOptions): void {
  live.get(o.key)?.cancel?.()
  const list = h('div', { class: 'ai-answer-list' })
  const input = h('textarea', { class: 'ai-answer-input', rows: '1', spellcheck: 'false', placeholder: o.placeholder ?? t('继续追问…'), 'aria-label': t('继续追问') })
  const stopBtn = h('button', { class: 'btn small', hidden: true, onClick: () => state.cancel?.() }, t('停止'))
  const sendBtn = h('button', { class: 'btn small primary', onClick: () => ask() }, t('发送'))
  const root = h(
    'div',
    { class: 'ai-answer' },
    h('div', { class: 'ai-answer-head' }, h('span', { class: 'ai-edit-mark' }, '✦'), h('span', { class: 'ai-answer-title' }, o.title), h('span', { class: 'grow' }), h('span', { class: 'ai-answer-model muted' }, modelLabel('edit'))),
    o.context ?? null,
    list,
    h('div', { class: 'ai-answer-foot' }, input, stopBtn, sendBtn)
  )
  const state: Live = { root }
  live.set(o.key, state)
  const history: AiMessage[] = []
  let busy = false

  const turn = async (content: string, shown: string | null) => {
    busy = true
    sendBtn.hidden = true
    stopBtn.hidden = false
    input.disabled = true
    if (shown) list.append(h('div', { class: 'ai-answer-q' }, shown))
    const body = h('div', { class: 'ai-answer-a md' }, h('span', { class: 'muted' }, t('正在思考…')))
    const box = h('div', { class: 'ai-answer-turn' }, body)
    list.append(box)
    history.push({ role: 'user', content })
    let text = ''
    let frame = 0
    const paint = () => {
      frame = 0
      body.replaceChildren(renderMarkdown(text))
    }
    const system = await withRules(o.system)
    const req = streamChat({ system, messages: [...history] }, (d) => {
      text += d
      if (!frame) frame = requestAnimationFrame(paint)
    })
    state.cancel = req.cancel
    const r = await req.done
    state.cancel = undefined
    if (frame) cancelAnimationFrame(frame)
    busy = false
    sendBtn.hidden = false
    stopBtn.hidden = true
    input.disabled = false
    if (!r.ok) {
      history.pop()
      if (text) paint()
      body.append(h('p', { class: r.cancelled ? 'muted' : 'ai-answer-err' }, r.cancelled ? t('已停止') : r.error))
      return
    }
    text = r.text
    paint()
    history.push({ role: 'assistant', content: text })
    const acts = o.actions?.(text) ?? []
    box.append(
      h(
        'div',
        { class: 'ai-answer-acts' },
        ...acts,
        h('button', {
          class: 'btn small',
          onClick: () => {
            void navigator.clipboard.writeText(text)
            toast(t('已复制'))
          }
        }, t('复制'))
      )
    )
    input.focus()
  }

  const ask = () => {
    const q = input.value.trim()
    if (!q || busy) return
    input.value = ''
    void turn(q, q)
  }
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault()
      ask()
    }
  })
  input.addEventListener('input', () => {
    input.style.height = 'auto'
    input.style.height = `${Math.min(160, input.scrollHeight)}px`
  })

  // 同 key 的旧标签先关掉，保证显示的是新内容
  const old = document.querySelector<HTMLElement>(`.ai-answer[data-key="${CSS.escape(o.key)}"]`)
  if (old) closeView(old)
  root.dataset.key = o.key
  openView({
    key: o.key,
    title: o.title,
    icon: o.icon,
    el: root,
    onClose: () => {
      state.cancel?.()
      if (live.get(o.key) === state) live.delete(o.key)
    }
  }, { side: true })
  void turn(o.prompt, null)
}

/** 可折叠的上下文块（例如“终端输出”） */
export function contextBlock(label: string, text: string, open = false): HTMLElement {
  return h('details', { class: 'ai-answer-ctx', open }, h('summary', {}, label), h('pre', {}, text))
}
