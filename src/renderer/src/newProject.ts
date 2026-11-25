import type { NewProjectOptions, ProjectCreated, ProjectKind, ProjectProbe, ProjectTool } from '../../shared/types'
import { h, parentDir, toast } from './dom'
import { icons } from './icons'
import { t } from './i18n'
import { newTerminal } from './panel'
import { glyph } from './plugins'
import { persist, state } from './store'

/* ---------------- 新建项目对话框（左边选模板，右边填选项，和 IntelliJ 的 New Project 一样） ---------------- */

type OpenHere = (r: ProjectCreated) => Promise<void>

const nodeGlyph =
  '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 2.5l8.5 4.9v9.2L12 21.5l-8.5-4.9V7.4z"/><path d="M12 8v8M9 10.5l3-2.5 3 2.5"/></svg>'

const KINDS: { id: ProjectKind; label: () => string; icon: () => string }[] = [
  { id: 'empty', label: () => t('空项目'), icon: () => icons.folder },
  { id: 'java', label: () => 'Java', icon: () => glyph('java', 18) },
  { id: 'python', label: () => 'Python', icon: () => glyph('python', 18) },
  { id: 'cpp', label: () => 'C / C++', icon: () => glyph('cpp', 18) },
  { id: 'node', label: () => 'Node.js', icon: () => nodeGlyph }
]

const TOOL_NAMES: Record<string, () => string> = {
  jdk: () => 'JDK',
  maven: () => 'Maven',
  gradle: () => 'Gradle',
  python: () => 'Python',
  cc: () => t('C/C++ 编译器'),
  cmake: () => 'CMake',
  node: () => 'Node.js',
  git: () => 'Git'
}

let dialogEl: HTMLElement | null = null
let lastFocus: HTMLElement | null = null
let busy = false
/** 每种模板的工具检测结果（检测要启动解释器 / 编译器，对话框开着期间只测一次） */
const probes = new Map<ProjectKind, Promise<ProjectProbe>>()

function closeDialog(): void {
  if (!dialogEl || busy) return
  dialogEl.remove()
  dialogEl = null
  lastFocus?.focus?.()
  lastFocus = null
  probes.clear()
}

function probe(kind: ProjectKind, fresh = false): Promise<ProjectProbe> {
  let p = fresh ? undefined : probes.get(kind)
  if (!p) {
    p = window.api.project.probe(kind).catch(() => ({ tools: [] }))
    probes.set(kind, p)
  }
  return p
}

/** 分段选择（单选按钮组） */
function seg<V extends string>(label: string, options: [V, string][], get: () => V, set: (v: V) => void): HTMLElement {
  const group = h('div', { class: 'np-seg', role: 'radiogroup', 'aria-label': label })
  const paint = () => {
    for (const b of group.children) {
      const on = (b as HTMLElement).dataset.v === get()
      b.classList.toggle('on', on)
      b.setAttribute('aria-checked', String(on))
    }
  }
  for (const [v, text] of options)
    group.append(
      h('button', { type: 'button', role: 'radio', 'data-v': v, onClick: () => (set(v), paint()) }, text)
    )
  paint()
  return group
}

function check(label: string, get: () => boolean, set: (v: boolean) => void): HTMLElement {
  const input = h('input', { type: 'checkbox', onChange: () => set(input.checked) })
  input.checked = get()
  return h('label', { class: 'check-row np-check' }, input, h('span', {}, label))
}

const row = (label: string, ...control: (Node | null)[]): HTMLElement => h('div', { class: 'np-row' }, h('span', { class: 'np-label' }, label), h('div', { class: 'np-control' }, ...control))

export async function openNewProject(openHere: OpenHere): Promise<void> {
  if (dialogEl) return
  lastFocus = document.activeElement as HTMLElement | null

  const saved = state.settings.newProject ?? {}
  const recent = state.settings.recentFolders[0]
  const location = saved.location || (recent ? parentDir(recent) : await window.api.project.home())
  const o: NewProjectOptions = {
    kind: saved.kind ?? 'empty',
    name: await window.api.project.freeName(location, 'untitled'),
    location,
    git: true,
    sample: true,
    java: { build: 'none', package: 'com.example' },
    python: { venv: true },
    cpp: { lang: 'cpp', cmake: false },
    node: { ts: false }
  }

  /* ---------- 名称 / 位置 / 目标路径 ---------- */

  let targetOk = false
  let targetSeq = 0
  const nameInput = h('input', { class: 'text-input', value: o.name, spellcheck: 'false', 'aria-label': t('名称') })
  const locInput = h('input', { class: 'text-input', value: o.location, spellcheck: 'false', 'aria-label': t('位置') })
  const pathLine = h('p', { class: 'np-path' })
  const createBtn = h('button', { class: 'btn primary', onClick: () => void doCreate() }, t('创建'))
  const cancelBtn = h('button', { class: 'btn', onClick: closeDialog }, t('取消'))

  const checkTarget = async (): Promise<void> => {
    const seq = ++targetSeq
    o.name = nameInput.value.trim()
    o.location = locInput.value.trim()
    const r = await window.api.project.target(o.location, o.name)
    if (seq !== targetSeq) return
    targetOk = r.state !== 'invalid'
    pathLine.classList.toggle('err', !targetOk)
    pathLine.textContent = targetOk ? t('将创建于 {0}', r.path) : (r.message ?? '')
    createBtn.disabled = !targetOk || busy
  }
  let targetTimer: ReturnType<typeof setTimeout> | undefined
  const onPathInput = () => {
    targetOk = false
    createBtn.disabled = true
    clearTimeout(targetTimer)
    targetTimer = setTimeout(() => void checkTarget(), 150)
  }
  nameInput.addEventListener('input', onPathInput)
  locInput.addEventListener('input', onPathInput)
  const onEnter = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && !createBtn.disabled) void doCreate()
  }
  nameInput.addEventListener('keydown', onEnter)
  locInput.addEventListener('keydown', onEnter)

  const browseBtn = h('button', {
    class: 'btn',
    type: 'button',
    onClick: async () => {
      const p = await window.api.project.pickLocation(locInput.value.trim() || undefined)
      if (!p) return
      locInput.value = p
      onPathInput()
    }
  }, t('浏览…'))

  /* ---------- 随模板变化的选项和工具检测 ---------- */

  const optsEl = h('div', { class: 'np-opts' })
  const toolsEl = h('div', { class: 'np-tools', 'aria-live': 'polite' })
  let toolSeq = 0

  const relevant = (tool: ProjectTool): boolean => {
    if (tool.id === 'git') return o.git
    if (tool.id === 'maven') return o.java!.build === 'maven'
    if (tool.id === 'gradle') return o.java!.build === 'gradle'
    if (tool.id === 'cmake') return o.cpp!.cmake
    return true
  }

  const renderTools = async (fresh = false): Promise<void> => {
    const seq = ++toolSeq
    const kind = o.kind
    if (kind === 'empty' && !o.git) return void toolsEl.replaceChildren()
    toolsEl.replaceChildren(h('p', { class: 'np-tool muted' }, t('正在检测工具链…')))
    const p = await probe(kind, fresh)
    if (seq !== toolSeq) return
    const items = p.tools.filter(relevant)
    const missing = items.some((x) => !x.ok)
    toolsEl.replaceChildren(
      ...items.map((tool) => {
        const name = (TOOL_NAMES[tool.id] ?? (() => tool.id))()
        if (tool.ok) return h('p', { class: 'np-tool ok' }, h('span', { class: 'ic', html: icons.check }), tool.detail || name)
        const msg = tool.optional ? t('未检测到 {0}，不会初始化仓库', name) : t('未检测到 {0}：项目照样可以创建，装好后才能构建运行', name)
        return h(
          'p',
          { class: 'np-tool warn' },
          h('span', { class: 'ic', html: icons.warn }),
          h('span', {}, msg),
          tool.install
            ? h('button', {
                class: 'link-btn',
                type: 'button',
                title: tool.install,
                onClick: () => {
                  void newTerminal(undefined, { title: t('安装 {0}', name), run: tool.install })
                  toast(t('正在终端中安装 {0}，装好后点“重新检测”', name))
                }
              }, t('安装'))
            : null
        )
      }),
      ...(missing ? [h('button', { class: 'link-btn np-recheck', type: 'button', onClick: () => void renderTools(true) }, t('重新检测'))] : [])
    )
  }

  const renderOpts = (): void => {
    const rows: (HTMLElement | null)[] = []
    if (o.kind === 'java') {
      rows.push(
        row(t('构建系统'), seg(t('构建系统'), [['none', t('无')], ['maven', 'Maven'], ['gradle', 'Gradle']], () => o.java!.build, (v) => ((o.java!.build = v), void renderTools()))),
        row(
          t('包名'),
          h('input', {
            class: 'text-input',
            value: o.java!.package,
            placeholder: 'com.example',
            spellcheck: 'false',
            'aria-label': t('包名'),
            onInput: (e: Event) => (o.java!.package = (e.target as HTMLInputElement).value.trim())
          })
        )
      )
    } else if (o.kind === 'python') {
      rows.push(check(t('创建虚拟环境（.venv）'), () => o.python!.venv, (v) => (o.python!.venv = v)))
    } else if (o.kind === 'cpp') {
      rows.push(
        row(t('语言'), seg(t('语言'), [['cpp', 'C++'], ['c', 'C']], () => o.cpp!.lang, (v) => (o.cpp!.lang = v))),
        check(t('使用 CMake'), () => o.cpp!.cmake, (v) => ((o.cpp!.cmake = v), void renderTools()))
      )
    } else if (o.kind === 'node') {
      rows.push(row(t('语言'), seg(t('语言'), [['js', 'JavaScript'], ['ts', 'TypeScript']], () => (o.node!.ts ? 'ts' : 'js'), (v) => (o.node!.ts = v === 'ts'))))
    }
    const common = h(
      'div',
      { class: 'np-checks' },
      check(t('初始化 Git 仓库'), () => o.git, (v) => ((o.git = v), void renderTools())),
      o.kind === 'empty' ? null : check(t('生成示例代码'), () => o.sample, (v) => (o.sample = v))
    )
    optsEl.replaceChildren(...rows.filter((x): x is HTMLElement => !!x), common)
    void renderTools()
  }

  const kindBtns = KINDS.map((k) =>
    h(
      'button',
      {
        class: 'np-kind',
        type: 'button',
        role: 'tab',
        'data-kind': k.id,
        onClick: () => selectKind(k.id)
      },
      h('span', { class: 'ic', html: k.icon() }),
      h('span', {}, k.label())
    )
  )
  const selectKind = (kind: ProjectKind): void => {
    o.kind = kind
    for (const b of kindBtns) {
      const on = b.dataset.kind === kind
      b.classList.toggle('on', on)
      b.setAttribute('aria-selected', String(on))
    }
    renderOpts()
  }
  const kindList = h(
    'div',
    {
      class: 'np-kinds',
      role: 'tablist',
      'aria-orientation': 'vertical',
      onKeydown: (e: KeyboardEvent) => {
        if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
        e.preventDefault()
        const i = KINDS.findIndex((k) => k.id === o.kind)
        const next = KINDS[(i + (e.key === 'ArrowDown' ? 1 : KINDS.length - 1)) % KINDS.length]
        selectKind(next.id)
        kindBtns.find((b) => b.dataset.kind === next.id)?.focus()
      }
    },
    ...kindBtns
  )

  /* ---------- 创建 ---------- */

  const status = h('p', { class: 'np-status', 'aria-live': 'polite' })
  const body = h(
    'div',
    { class: 'np-body' },
    kindList,
    h(
      'div',
      { class: 'np-form' },
      row(t('名称'), nameInput),
      row(t('位置'), locInput, browseBtn),
      pathLine,
      optsEl,
      toolsEl
    )
  )
  const actions = h('div', { class: 'help-actions' }, status, cancelBtn, createBtn)

  const setBusy = (on: boolean, msg = ''): void => {
    busy = on
    status.textContent = msg
    status.classList.remove('err')
    for (const el of [nameInput, locInput, browseBtn, cancelBtn]) el.disabled = on
    createBtn.disabled = on || !targetOk
  }

  async function doCreate(): Promise<void> {
    if (busy) return
    await checkTarget()
    if (!targetOk) return
    setBusy(true, o.kind === 'python' && o.python!.venv ? t('正在创建项目和虚拟环境…') : t('正在创建项目…'))
    let r: ProjectCreated
    try {
      r = await window.api.project.create({ ...o })
    } catch (e) {
      setBusy(false)
      status.textContent = String((e as Error).message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
      status.classList.add('err')
      return
    }
    busy = false
    state.settings.newProject = { location: o.location, kind: o.kind }
    persist()
    for (const w of r.warnings) toast(w)
    if (!state.root) {
      closeDialog()
      await openHere(r)
      return
    }
    showWhere(r)
  }

  /** 当前窗口已经开着项目：问在此窗口还是新窗口打开 */
  function showWhere(r: ProjectCreated): void {
    const here = h('button', { class: 'btn primary', onClick: () => (closeDialog(), void openHere(r)) }, t('此窗口'))
    const other = h(
      'button',
      {
        class: 'btn',
        onClick: () => {
          closeDialog()
          window.api.win.newWindow({ folder: r.path, file: r.open, run: r.post })
        }
      },
      t('新窗口')
    )
    card.classList.add('np-done')
    title.textContent = t('项目已创建')
    body.replaceChildren(h('div', { class: 'np-where' }, h('p', {}, t('在哪里打开 {0}？', o.name)), h('p', { class: 'np-path' }, r.path)))
    actions.replaceChildren(other, here)
    here.focus()
  }

  const title = h('h2', {}, t('新建项目'))
  const card = h(
    'div',
    { class: 'help-card np-card', role: 'dialog', 'aria-modal': 'true', 'aria-label': t('新建项目') },
    h('div', { class: 'help-head' }, title, h('button', { class: 'icon-btn small help-close', 'aria-label': t('关闭'), title: t('关闭'), html: icons.close, onClick: closeDialog })),
    body,
    actions
  )
  dialogEl = h(
    'div',
    {
      class: 'palette-backdrop help-backdrop',
      onMousedown: (e: MouseEvent) => {
        if (e.target === dialogEl) closeDialog()
      },
      onKeydown: (e: KeyboardEvent) => {
        if (e.key === 'Escape') {
          e.stopPropagation()
          closeDialog()
        }
      }
    },
    card
  )
  document.body.append(dialogEl)
  selectKind(o.kind)
  void checkTarget()
  nameInput.focus()
  nameInput.select()
}
