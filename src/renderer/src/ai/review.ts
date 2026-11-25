import { basename, h, toast } from '../dom'
import { t } from '../i18n'
import { closeView, findTab, normPath, openFile, openView, reloadFromDisk } from '../editor'
import type { DiffInfo } from '../agent/types'
import { countChanges, diffStat, hunksFrom, lineDiff, openDiffTab, renderDiff } from '../agent/diff'
import { resolvePath } from '../agent/markdown'
import { relPath } from './context'

/**
 * AI 对话一轮里改了多个文件时的统一审阅：
 * 记下每个文件在这一轮第一次被修改前的内容，回合结束后在对话里给出“审阅改动”卡片；
 * 审阅页逐个文件显示改动（这一轮的累计结果），可以逐个保留 / 撤销，也可以全部撤销。
 */

interface FileChange {
  path: string
  /** 这一轮修改前的内容；拿不到时为 null（不能撤销） */
  original: string | null
  /** 新建的文件（撤销 = 删除） */
  created: boolean
  state: 'pending' | 'kept' | 'reverted'
}

export class TurnChanges {
  readonly files = new Map<string, FileChange>()
  private loading: Promise<void>[] = []

  /** 对话里出现了一次文件修改（同一个文件多次修改只记第一次的原文） */
  add(d: DiffInfo): void {
    const path = normPath(resolvePath(d.path))
    const key = path.toLowerCase()
    if (this.files.has(key)) return
    const entry: FileChange = { path, original: null, created: false, state: 'pending' }
    this.files.set(key, entry)
    if (d.load) {
      this.loading.push(
        d
          .load()
          .then((s) => {
            entry.original = s.original
            entry.created = s.original === '' && d.removed === 0
          })
          .catch(() => undefined)
      )
    }
  }

  get size(): number {
    return this.files.size
  }

  async ready(): Promise<void> {
    await Promise.all(this.loading)
  }
}

async function current(path: string): Promise<string | null> {
  const r = await window.api.fs.readFile(path).catch(() => null)
  return r?.ok ? r.content : null
}

async function revert(c: FileChange): Promise<boolean> {
  if (c.original === null) return false
  try {
    if (c.created) await window.api.fs.trash(c.path)
    else await window.api.fs.writeFile(c.path, c.original)
  } catch (e) {
    toast(t('撤销失败：{0}', String((e as Error)?.message ?? e)))
    return false
  }
  if (findTab(c.path)) await reloadFromDisk(c.path)
  c.state = 'reverted'
  return true
}

/** 对话里的卡片：“本轮修改了 N 个文件 · 审阅改动” */
export async function reviewCard(changes: TurnChanges): Promise<HTMLElement> {
  await changes.ready()
  let added = 0
  let removed = 0
  for (const c of changes.files.values()) {
    if (c.original === null) continue
    const now = (await current(c.path)) ?? ''
    const st = countChanges(hunksFrom(lineDiff(c.original, now), 0))
    added += st.added
    removed += st.removed
  }
  return h(
    'div',
    { class: 'ai-review-card' },
    h('span', { class: 'ai-edit-mark' }, '✦'),
    h('span', {}, t('本轮修改了 {0} 个文件', changes.size)),
    diffStat({ added, removed }),
    h('span', { class: 'grow' }),
    h('button', { class: 'btn small primary', onClick: () => void openReview(changes) }, t('审阅改动'))
  )
}

export async function openReview(changes: TurnChanges): Promise<void> {
  await changes.ready()
  const list = h('div', { class: 'ai-review-list' })
  const summary = h('span', { class: 'muted' })
  const root: HTMLElement = h(
    'div',
    { class: 'ai-review' },
    h(
      'div',
      { class: 'ai-review-head' },
      h('span', { class: 'ai-edit-mark' }, '✦'),
      h('span', { class: 'ai-answer-title' }, t('审阅 AI 的改动')),
      summary,
      h('span', { class: 'grow' }),
      h('button', {
        class: 'btn small',
        onClick: async () => {
          const pending = [...changes.files.values()].filter((c) => c.state === 'pending' && c.original !== null)
          if (!pending.length) return
          if (!confirm(t('撤销这 {0} 个文件在这一轮里的所有改动吗？新建的文件会移到回收站。', pending.length))) return
          for (const c of pending) await revert(c)
          await render()
          toast(t('已撤销 {0} 个文件', pending.length))
        }
      }, t('全部撤销')),
      h('button', {
        class: 'btn small primary',
        onClick: async () => {
          for (const c of changes.files.values()) if (c.state === 'pending') c.state = 'kept'
          await render()
          closeView(root)
        }
      }, t('全部保留'))
    ),
    list
  )

  const fileBox = async (c: FileChange): Promise<HTMLElement> => {
    const now = await current(c.path)
    const before = c.original ?? ''
    const after = now ?? ''
    const hunks = c.original === null ? [] : hunksFrom(lineDiff(before, after), 3)
    const st = countChanges(hunks)
    const d: DiffInfo = { path: c.path, hunks, ...st, load: async () => ({ original: before, modified: after }) }
    const stateLabel = c.state === 'kept' ? t('已保留') : c.state === 'reverted' ? t('已撤销') : now === null ? t('已删除') : c.created ? t('新建') : ''
    const open = c.state === 'pending'
    const head = h(
      'div',
      { class: 'ai-review-file-head' },
      h('a', { class: 'ai-review-path', href: '#', title: c.path, onClick: (e: MouseEvent) => (e.preventDefault(), void openFile(c.path)) }, relPath(c.path)),
      diffStat(st),
      stateLabel ? h('span', { class: 'ai-review-state', 'data-state': c.state }, stateLabel) : null,
      h('span', { class: 'grow' }),
      c.original !== null && now !== null ? h('button', { class: 'btn small', onClick: () => void openDiffTab(d) }, t('对比')) : null,
      c.state === 'pending' && c.original !== null
        ? h('button', {
            class: 'btn small',
            onClick: async () => {
              if (await revert(c)) {
                toast(t('已撤销 {0}', basename(c.path)))
                await render()
              }
            }
          }, t('撤销'))
        : null,
      c.state === 'pending'
        ? h('button', {
            class: 'btn small primary',
            onClick: async () => {
              c.state = 'kept'
              await render()
            }
          }, t('保留'))
        : null
    )
    const body =
      c.original === null
        ? h('p', { class: 'muted ai-review-note' }, t('拿不到修改前的内容，无法显示改动或撤销'))
        : hunks.length
          ? renderDiff(d, 600)
          : h('p', { class: 'muted ai-review-note' }, t('现在和修改前一样'))
    // 审阅过的文件收起改动，点标题行的箭头再展开
    body.hidden = !open
    const toggle = h('button', { class: 'icon-btn tiny ai-review-toggle', 'aria-label': t('显示 / 隐藏改动'), 'aria-expanded': String(open), onClick: () => {
      body.hidden = !body.hidden
      toggle.setAttribute('aria-expanded', String(!body.hidden))
    } }, '▾')
    head.prepend(toggle)
    return h('div', { class: 'ai-review-file' }, head, body)
  }

  const render = async () => {
    const all = [...changes.files.values()]
    const boxes = await Promise.all(all.map(fileBox))
    list.replaceChildren(...boxes)
    const pending = all.filter((c) => c.state === 'pending').length
    summary.textContent = pending ? t('{0} 个文件待审阅', pending) : t('全部审阅完毕')
  }
  await render()
  openView({ title: t('审阅改动（{0}）', changes.size), el: root, icon: undefined })
}
