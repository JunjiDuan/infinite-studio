import '@fontsource/inter/400.css'
import '@fontsource/inter/500.css'
import '@fontsource/inter/600.css'
import '@fontsource/jetbrains-mono/400.css'
import '@fontsource/jetbrains-mono/700.css'
import '@fontsource/ibm-plex-mono/400.css'
import '@fontsource/ibm-plex-mono/600.css'
import '@fontsource/space-mono/400.css'
import '@fontsource/space-mono/700.css'
import './styles.css'

import type { ThemeId } from '../../shared/types'
import { registerCommands } from './commands'
import { basename, h, relative, toast } from './dom'
import {
  activate,
  activeTab,
  anyDirty,
  applyEditorOptions,
  closeAll,
  closeTab,
  cycleTab,
  findTab,
  getEditor,
  initEditor,
  isDirty,
  problemCount,
  reloadFromDisk,
  saveActive,
  saveAll,
  tabs
} from './editor'
import { icons } from './icons'
import { defineTheme, languageName, monaco } from './monaco'
import { closePalette, invalidateFiles, isPaletteOpen, openPalette } from './palette'
import { closeSettings, initSettings, isSettingsOpen, openSettings } from './settingsView'
import { PRESETS, emit, isFocus, isRailVisible, isSidebarVisible, loadSettings, on, persist, setSpace, state } from './store'
import { THEMES, applyCssVars } from './theme'
import { createPanel, newTerminal, togglePanel } from './panel'
import { createSearchView, focusSearch, resetSearch } from './search'
import { addTreeMenuItems, beginCreate, createTree, invalidatePaths, render as renderTree, setTreeRoot } from './tree'

/* ---------------- 界面骨架 ---------------- */

const crumbs = h('nav', { class: 'crumbs', 'aria-label': '当前路径' })
const themeDots = h('div', { class: 'theme-dots', role: 'group', 'aria-label': '切换主题' })

const titlebar = h(
  'header',
  { class: 'titlebar' },
  h('div', { class: 'tb-left' }, h('span', { class: 'logo', html: icons.logo, title: 'Infinite Studio · 无界工作室' }), crumbs),
  h(
    'button',
    { class: 'tb-search', 'aria-label': '打开命令面板', onClick: () => openPalette() },
    h('span', { class: 'ic', html: icons.search }),
    h('span', { class: 'grow' }, '搜索文件，或输入命令'),
    h('kbd', {}, 'Ctrl K')
  ),
  h(
    'div',
    { class: 'tb-right' },
    themeDots,
    h('button', { class: 'win-btn', 'aria-label': '最小化', html: icons.minimize, onClick: () => window.api.win.minimize() }),
    h('button', { class: 'win-btn', 'aria-label': '最大化', html: icons.maximize, onClick: () => window.api.win.toggleMaximize() }),
    h('button', { class: 'win-btn close', 'aria-label': '关闭', html: icons.winClose, onClick: () => requestClose() })
  )
)

const railFiles = h('button', { class: 'rail-btn', 'aria-label': '文件 (Ctrl B)', title: '文件 Ctrl B', html: icons.files, onClick: () => showSideView('files', true) })
const railSearch = h('button', { class: 'rail-btn', 'aria-label': '在文件中搜索 (Ctrl Shift F)', title: '搜索 Ctrl Shift F', html: icons.search, onClick: () => showSideView('search', true) })
const rail = h(
  'nav',
  { class: 'rail', 'aria-label': '活动栏' },
  railFiles,
  railSearch,
  h('button', { class: 'rail-btn', 'aria-label': '终端 (Ctrl `)', title: '终端 Ctrl `', html: icons.terminal, onClick: () => togglePanel() }),
  h('button', { class: 'rail-btn', 'aria-label': '专注模式 (Ctrl .)', title: '专注模式 Ctrl .', html: icons.focus, onClick: () => toggleFocus() }),
  h('span', { class: 'grow' }),
  h('button', { class: 'rail-btn', 'aria-label': '个性化设置 (Ctrl ,)', title: '个性化 Ctrl ,', html: icons.sliders, onClick: () => toggleSettings() })
)

const sidebar = h('aside', { class: 'sidebar', 'aria-label': '侧栏' }, createTree(), createSearchView())
const tabBar = h('div', { class: 'tabs', role: 'tablist', 'aria-label': '打开的文件' })
const editorHost = h('div', { class: 'editor-host' })
const emptyHint = h('div', { class: 'empty-hint' })
const welcome = h('div', { class: 'welcome' })
const editorArea = h('main', { class: 'editor-area' }, tabBar, h('div', { class: 'editor-wrap' }, editorHost, emptyHint), createPanel())

const stBranch = h('span', { class: 'st-item' })
const stProblems = h('span', { class: 'st-item' })
const stCursor = h('span', { class: 'st-item' })
const stEol = h('span', { class: 'st-item' })
const stLang = h('span', { class: 'st-item' })
const stSpace = h('button', { class: 'st-item st-space', onClick: () => toggleSettings() })
const statusbar = h(
  'footer',
  { class: 'statusbar' },
  stBranch,
  stProblems,
  h('span', { class: 'grow' }),
  stCursor,
  h('span', { class: 'st-item' }, 'UTF-8'),
  stEol,
  stLang,
  h('button', { class: 'st-item st-link', onClick: () => togglePanel() }, '终端 Ctrl `'),
  h('button', { class: 'st-item st-link', onClick: () => toggleFocus() }, '专注 Ctrl .'),
  stSpace
)

const focusPill = h(
  'div',
  { class: 'focus-pill' },
  h('span', { class: 'pill-label' }, h('span', { class: 'dot' }), '专注模式'),
  h('button', { onClick: () => openPalette() }, 'Ctrl K 命令'),
  h('button', { class: 'pill-exit', onClick: () => toggleFocus() }, '退出 Esc')
)

const body = h('div', { class: 'body' }, rail, sidebar, editorArea, welcome)
const app = h('div', { id: 'app' }, titlebar, body, statusbar, focusPill)
document.body.append(app)

/* ---------------- 渲染函数 ---------------- */

function renderThemeDots(): void {
  const cur = state.settings.space.theme
  themeDots.replaceChildren(
    ...(Object.keys(THEMES) as ThemeId[]).map((id) =>
      h(
        'button',
        { class: 'theme-dot' + (id === cur ? ' on' : ''), 'aria-label': THEMES[id].label, 'aria-pressed': String(id === cur), title: THEMES[id].label, onClick: () => setSpace({ theme: id }) },
        h('span', { style: { background: THEMES[id].swatch } })
      )
    )
  )
}

function renderCrumbs(): void {
  const t = activeTab()
  const parts: string[] = []
  if (state.root) {
    parts.push(basename(state.root))
    if (t) parts.push(...relative(state.root, t.path).split('/'))
  } else if (t) {
    parts.push(basename(t.path))
  } else {
    parts.push('Infinite Studio', '无界工作室')
  }
  const nodes: Node[] = []
  parts.forEach((p, i) => {
    if (i) nodes.push(h('span', { class: 'sep' }, '/'))
    nodes.push(h('span', { class: i === parts.length - 1 ? 'cur' : '' }, p))
  })
  crumbs.replaceChildren(...nodes)
}

function renderTabs(): void {
  const cur = activeTab()
  tabBar.replaceChildren(
    ...tabs.map((t) => {
      const dirty = isDirty(t)
      return h(
        'div',
        {
          class: 'tab' + (t === cur ? ' on' : '') + (dirty ? ' dirty' : ''),
          role: 'tab',
          tabindex: '0',
          'aria-selected': String(t === cur),
          title: t.path,
          onClick: () => activate(t.path),
          onAuxclick: (e: MouseEvent) => e.button === 1 && closeTab(t.path),
          onKeydown: (e: KeyboardEvent) => e.key === 'Enter' && activate(t.path)
        },
        h('span', { class: 'tab-name' }, basename(t.path)),
        h(
          'button',
          {
            class: 'tab-close',
            'aria-label': `关闭 ${basename(t.path)}`,
            html: icons.close,
            onClick: (e: MouseEvent) => {
              e.stopPropagation()
              closeTab(t.path)
            }
          },
          h('span', { class: 'tab-dot', title: '未保存' })
        )
      )
    })
  )
  tabBar.hidden = tabs.length === 0
  emptyHint.hidden = tabs.length > 0
  editorHost.style.visibility = tabs.length ? 'visible' : 'hidden'
}

function renderEmptyHint(): void {
  emptyHint.replaceChildren(
    h('span', { class: 'logo big', html: icons.logoLarge }),
    h(
      'div',
      { class: 'hint-keys' },
      h('div', {}, h('span', {}, '搜索文件或命令'), h('kbd', {}, 'Ctrl K')),
      h('div', {}, h('span', {}, '在文件中搜索'), h('kbd', {}, 'Ctrl Shift F')),
      h('div', {}, h('span', {}, '显示 / 隐藏侧栏'), h('kbd', {}, 'Ctrl B')),
      h('div', {}, h('span', {}, '专注模式'), h('kbd', {}, 'Ctrl .')),
      h('div', {}, h('span', {}, '个性化'), h('kbd', {}, 'Ctrl ,'))
    )
  )
}

function renderWelcome(): void {
  const recents = state.settings.recentFolders
  welcome.replaceChildren(
    h(
      'div',
      { class: 'welcome-inner' },
      h('span', { class: 'logo big', html: icons.logoLarge }),
      h('h1', {}, '无界工作室'),
      h('p', { class: 'en' }, 'Infinite Studio'),
      h(
        'div',
        { class: 'welcome-actions' },
        h('button', { class: 'btn primary', onClick: () => pickFolder() }, '打开文件夹', h('kbd', {}, 'Ctrl O')),
        h('button', { class: 'btn', onClick: () => openSettings() }, '个性化你的空间')
      ),
      recents.length
        ? h(
            'div',
            { class: 'recents' },
            h('h2', {}, '最近打开'),
            ...recents.map((p) =>
              h('button', { class: 'recent', title: p, onClick: () => openFolder(p) }, h('span', { class: 'ic', html: icons.folder }), h('span', { class: 'r-name' }, basename(p)), h('span', { class: 'r-path' }, p))
            )
          )
        : null
    )
  )
}

function renderStatus(): void {
  const t = activeTab()
  stBranch.replaceChildren(...(state.branch ? [h('span', { class: 'ic', html: icons.gitSmall }), state.branch] : []))
  stBranch.hidden = !state.branch
  const n = problemCount()
  stProblems.textContent = state.root ? `${n} 个问题` : ''
  stProblems.hidden = !state.root
  const pos = getEditor()?.getPosition()
  stCursor.textContent = t && pos ? `行 ${pos.lineNumber}，列 ${pos.column}` : ''
  stCursor.hidden = !t
  stEol.textContent = t ? (t.model.getEOL() === '\r\n' ? 'CRLF' : 'LF') : ''
  stEol.hidden = !t
  stLang.textContent = t ? languageName(t.model.getLanguageId()) : ''
  stLang.hidden = !t
  stSpace.replaceChildren(h('span', { class: 'dot' }), `空间 · ${state.settings.space.name}`)
}

function applyLayout(): void {
  const welcomeMode = !state.root && tabs.length === 0
  app.classList.toggle('focus', isFocus() && !welcomeMode)
  app.classList.toggle('no-rail', !isRailVisible() && !welcomeMode)
  app.classList.toggle('no-side', !isSidebarVisible())
  app.classList.toggle('welcome-mode', welcomeMode)
  app.classList.toggle('panel-open', state.panelOpen)
  sidebar.dataset.view = state.sideView
  railFiles.classList.toggle('on', isSidebarVisible() && state.sideView === 'files')
  railSearch.classList.toggle('on', isSidebarVisible() && state.sideView === 'search')
  applyEditorOptions()
}

function applySpace(): void {
  const t = applyCssVars(state.settings.space)
  defineTheme(t)
  renderThemeDots()
  renderStatus()
  document.fonts.load(`${state.settings.space.size}px ${t.fontCss}`).then(() => monaco.editor.remeasureFonts())
}

/* ---------------- 动作 ---------------- */

async function openFolder(path: string): Promise<void> {
  try {
    await window.api.fs.readDir(path)
  } catch {
    toast('文件夹不存在或无法访问')
    state.settings.recentFolders = state.settings.recentFolders.filter((p) => p !== path)
    persist()
    renderWelcome()
    return
  }
  if (state.root !== path && !closeAll()) return
  state.root = path
  state.sidebarOverride = null
  state.settings.recentFolders = [path, ...state.settings.recentFolders.filter((p) => p !== path)].slice(0, 8)
  persist()
  invalidateFiles()
  state.branch = await window.api.fs.gitBranch(path)
  const bound = state.settings.bindings[path]
  if (bound) setSpace({ ...bound })
  await setTreeRoot(path)
  resetSearch()
  void window.api.fs.watch(path)
  emit('root')
}

// 磁盘上的变化：刷新目录树、命令面板的文件列表、已打开且没改过的文件
window.api.fs.onChanged((paths) => {
  void invalidatePaths(paths)
  invalidateFiles()
  for (const p of paths) if (findTab(p)) void reloadFromDisk(p)
  if (state.root && paths.some((p) => /[\\/]\.git[\\/]HEAD$/.test(p))) {
    void window.api.fs.gitBranch(state.root).then((b) => {
      state.branch = b
      renderStatus()
    })
  }
})

async function pickFolder(): Promise<void> {
  const p = await window.api.fs.openFolderDialog()
  if (p) await openFolder(p)
}

function closeFolder(): void {
  if (!closeAll()) return
  state.root = null
  state.branch = null
  void setTreeRoot(null)
  void window.api.fs.watch(null)
  emit('root')
}

function toggleSidebar(): void {
  if (!state.root) return
  if (isFocus()) state.focusOverride = false
  state.sidebarOverride = !isSidebarVisible()
  emit('layout')
}

/**
 * 切到侧栏的某个视图。toggle 为 true 时，再点一次当前视图会收起侧栏（活动栏按钮的行为）。
 */
function showSideView(view: 'files' | 'search', toggle = false): void {
  if (!state.root) {
    if (view === 'search') toast('先打开一个文件夹')
    return
  }
  if (toggle && isSidebarVisible() && state.sideView === view) {
    state.sidebarOverride = false
  } else {
    if (isFocus()) state.focusOverride = false
    state.sideView = view
    state.sidebarOverride = true
  }
  emit('layout')
  if (view === 'search' && isSidebarVisible()) focusSearch()
}

/** 先确保文件栏可见，再执行（比如从命令面板新建文件） */
function showFilesThen(fn: () => void): void {
  showSideView('files')
  fn()
}

function toggleFocus(): void {
  state.focusOverride = !isFocus()
  emit('layout')
  getEditor()?.focus()
}

function toggleSettings(): void {
  if (isSettingsOpen()) closeSettings()
  else openSettings()
}

function changeSize(d: number): void {
  setSpace({ size: state.settings.space.size + d })
}

let closing = false
function requestClose(): void {
  if (anyDirty() && !confirm('有未保存的修改，确定退出吗？')) return
  closing = true
  window.api.win.close()
}

window.addEventListener('beforeunload', (e) => {
  if (closing || !anyDirty()) return
  e.preventDefault()
  e.returnValue = false
  setTimeout(requestClose, 0)
})

/* ---------------- 命令 ---------------- */

registerCommands(() => [
  { id: 'folder.open', title: '打开文件夹…', key: 'Ctrl O', run: pickFolder },
  ...(state.root ? [{ id: 'folder.close', title: '关闭文件夹', run: closeFolder }] : []),
  ...(state.root
    ? [
        { id: 'file.new', title: '新建文件', run: () => showFilesThen(() => beginCreate('file')) },
        { id: 'dir.new', title: '新建文件夹', run: () => showFilesThen(() => beginCreate('dir')) }
      ]
    : []),
  { id: 'file.save', title: '保存', key: 'Ctrl S', run: saveActive },
  { id: 'file.saveAll', title: '全部保存', run: saveAll },
  { id: 'file.close', title: '关闭当前标签', key: 'Ctrl W', run: () => closeTab() },
  { id: 'view.sidebar', title: '显示 / 隐藏侧栏', key: 'Ctrl B', run: toggleSidebar },
  { id: 'view.search', title: '在文件中搜索', key: 'Ctrl Shift F', run: () => showSideView('search') },
  { id: 'view.focus', title: '专注模式', key: 'Ctrl .', run: toggleFocus },
  { id: 'term.toggle', title: '显示 / 隐藏终端', key: 'Ctrl `', run: togglePanel },
  { id: 'term.new', title: '新建终端', key: 'Ctrl Shift `', run: () => newTerminal() },
  { id: 'view.settings', title: '打开个性化设置', key: 'Ctrl ,', run: openSettings },
  { id: 'view.wrap', title: '切换自动换行', key: 'Alt Z', run: toggleWrap },
  { id: 'font.bigger', title: '增大字号', key: 'Ctrl =', run: () => changeSize(1) },
  { id: 'font.smaller', title: '减小字号', key: 'Ctrl -', run: () => changeSize(-1) },
  ...(Object.keys(THEMES) as ThemeId[]).map((id) => ({
    id: 'theme.' + id,
    title: `切换主题：${THEMES[id].label}`,
    hint: state.settings.space.theme === id ? '当前' : '',
    run: () => setSpace({ theme: id })
  })),
  ...[...PRESETS, ...state.settings.savedSpaces].map((s) => ({
    id: 'space.' + s.name,
    title: `切换空间：${s.name}`,
    hint: state.settings.space.name === s.name ? '当前' : '',
    run: () => setSpace({ ...s })
  })),
  { id: 'window.devtools', title: '开发者工具', key: 'F12', run: () => toast('按 F12 打开开发者工具') }
])

function toggleWrap(): void {
  state.settings.wordWrap = !state.settings.wordWrap
  persist()
  emit('layout')
  toast(state.settings.wordWrap ? '自动换行：开' : '自动换行：关')
}

addTreeMenuItems(({ dir }) => [{ label: '在终端中打开', run: () => void newTerminal(dir) }, 'sep'])

/* ---------------- 快捷键 ---------------- */

// 捕获阶段处理全局快捷键，优先于 Monaco
window.addEventListener(
  'keydown',
  (e) => {
    const ctrl = e.ctrlKey || e.metaKey
    const k = e.key.toLowerCase()
    const backquote = e.code === 'Backquote'
    // 终端里只拦截少数全局快捷键，其余（Ctrl B / W / S 等）留给 shell
    const inTerm = !!(e.target as Element | null)?.closest?.('.xterm')
    if (inTerm && !(ctrl && (backquote || k === 'k' || k === 'p' || k === ',' || k === '.' || (e.shiftKey && k === 'f')))) return
    let handled = true
    if (ctrl && backquote) {
      if (e.shiftKey) void newTerminal()
      else togglePanel()
    } else if (ctrl && !e.shiftKey && k === 'k') openPalette()
    else if (ctrl && !e.shiftKey && k === 'p') openPalette()
    else if (ctrl && e.shiftKey && k === 'p') openPalette('>')
    else if (ctrl && e.shiftKey && k === 'f') showSideView('search')
    else if (ctrl && k === 's') void saveActive()
    else if (ctrl && k === 'o') void pickFolder()
    else if (ctrl && k === 'w') closeTab()
    else if (ctrl && k === 'b') toggleSidebar()
    else if (ctrl && k === '.') toggleFocus()
    else if (ctrl && k === ',') toggleSettings()
    else if (ctrl && (k === '=' || k === '+')) changeSize(1)
    else if (ctrl && k === '-') changeSize(-1)
    else if (ctrl && k === 'tab') cycleTab(e.shiftKey ? -1 : 1)
    else if (e.altKey && k === 'z') toggleWrap()
    else handled = false
    if (handled) {
      e.preventDefault()
      e.stopPropagation()
    }
  },
  true
)

// 冒泡阶段：Monaco 没处理的 Esc 用来退出专注 / 设置
window.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || e.defaultPrevented || isPaletteOpen()) return
  if (isSettingsOpen()) closeSettings()
  else if (isFocus()) toggleFocus()
})

/* ---------------- 订阅 ---------------- */

on('space', applySpace)
on('layout', applyLayout)
on('tabs', () => {
  renderTabs()
  renderCrumbs()
  renderTree()
  renderStatus()
  applyLayout()
})
on('cursor', renderStatus)
on('markers', renderStatus)
on('saved', renderStatus)
on('root', () => {
  renderCrumbs()
  renderStatus()
  renderWelcome()
  applyLayout()
  closePalette()
})

/* ---------------- 启动 ---------------- */

async function boot(): Promise<void> {
  await loadSettings()
  initEditor(editorHost)
  initSettings(body, () => getEditor()?.focus())
  applySpace()
  renderTabs()
  renderCrumbs()
  renderEmptyHint()
  renderWelcome()
  applyLayout()
  const last = state.settings.recentFolders[0]
  if (last) await openFolder(last)
  document.fonts.ready.then(() => monaco.editor.remeasureFonts())
}

void boot()
