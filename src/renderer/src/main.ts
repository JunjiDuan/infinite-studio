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
import { basename, h, toast } from './dom'
import { showMenu, type MenuItem } from './menu'
import { ideConnected, initIde, sendAtMention } from './ide'
import {
  activeTab,
  anyDirty,
  applyEditorOptions,
  closeAll,
  closeTab,
  cycleTab,
  findTab,
  focusNextGroup,
  getEditor,
  hasItems,
  initEditor,
  openFile,
  problemCount,
  recentFile,
  reloadFromDisk,
  renderEditorTabs,
  saveActive,
  saveAll,
  setTrailing,
  splitRight,
  tabs
} from './editor'
import { accountBtn, initAccount, openLoginDialog } from './account'
import { agentIcons, initChat, insertAtMention, onTabsChanged, toggleChatFocus } from './chat'
import { createPluginsView, pluginCommands, pluginTreeItems, refreshPlugins, render as renderPlugins } from './plugins'
import { icons } from './icons'
import { defineTheme, languageName, monaco } from './monaco'
import { closePalette, invalidateFiles, isPaletteOpen, openPalette } from './palette'
import { closeSettings, initSettings, isSettingsOpen, openSettings } from './settingsView'
import { PRESETS, type SideView, emit, isFocus, isRailVisible, isSidebarVisible, loadSettings, on, persist, setSpace, state } from './store'
import { THEMES, applyCssVars } from './theme'
import { debugRequest, initLsp, isProbe, lspStatus, refreshProbe, restartLsp, setLspRoot } from './lsp'
import { createPanel, newTerminal, togglePanel } from './panel'
import { initPreview, zoomPreviewAt } from './preview'
import { createScmView, refreshScm } from './scm'
import { createSearchView, focusSearch, resetSearch } from './search'
import { addTreeMenuItems, beginCreate, createTree, invalidatePaths, render as renderTree, setTreeRoot } from './tree'

/* ---------------- 界面骨架 ---------------- */

const themeDots = h('div', { class: 'theme-dots', role: 'group', 'aria-label': '切换主题' })

/* ---------------- 菜单栏（文件 / 编辑） ---------------- */

type MenuDef = { id: string; label: string; items: () => MenuItem[] }

const hasEditor = (): boolean => !!getEditor()?.getModel()

const MENUS: MenuDef[] = [
  {
    id: 'file',
    label: '文件',
    items: () => [
      { label: '新建文件', disabled: !state.root, run: () => showFilesThen(() => void beginCreate('file')) },
      { label: '新建文件夹', disabled: !state.root, run: () => showFilesThen(() => void beginCreate('dir')) },
      'sep',
      { label: '打开文件夹…', key: 'Ctrl O', run: () => void pickFolder() },
      { label: '关闭文件夹', disabled: !state.root, run: closeFolder },
      'sep',
      { label: '保存', key: 'Ctrl S', disabled: !activeTab(), run: () => void saveActive() },
      { label: '全部保存', disabled: !anyDirty(), run: () => void saveAll() },
      'sep',
      { label: '关闭标签', key: 'Ctrl W', disabled: !activeTab(), run: () => closeTab() },
      'sep',
      { label: '个性化设置', key: 'Ctrl ,', run: openSettings },
      'sep',
      { label: '退出', run: requestClose }
    ]
  },
  {
    id: 'edit',
    label: '编辑',
    items: () => {
      const off = !hasEditor()
      return [
        { label: '撤销', key: 'Ctrl Z', disabled: off, run: () => runEditorAction('undo') },
        { label: '重做', key: 'Ctrl Y', disabled: off, run: () => runEditorAction('redo') },
        'sep',
        { label: '剪切', key: 'Ctrl X', disabled: off, run: () => runEditorAction('editor.action.clipboardCutAction') },
        { label: '复制', key: 'Ctrl C', disabled: off, run: () => runEditorAction('editor.action.clipboardCopyAction') },
        { label: '粘贴', key: 'Ctrl V', disabled: off, run: () => void pasteToEditor() },
        'sep',
        { label: '全选', key: 'Ctrl A', disabled: off, run: () => runEditorAction('editor.action.selectAll') },
        'sep',
        { label: '查找', key: 'Ctrl F', disabled: off, run: () => runEditorAction('actions.find') },
        { label: '替换', key: 'Ctrl H', disabled: off, run: () => runEditorAction('editor.action.startFindReplaceAction') },
        'sep',
        { label: '在文件中查找', key: 'Ctrl Shift F', disabled: !state.root, run: () => showSideView('search') },
        'sep',
        { label: '切换行注释', key: 'Ctrl /', disabled: off, run: () => runEditorAction('editor.action.commentLine') },
        { label: '格式化文档', key: 'Shift Alt F', disabled: off, run: () => runEditorAction('editor.action.formatDocument') }
      ]
    }
  }
]

async function pasteToEditor(): Promise<void> {
  const ed = getEditor()
  if (!ed?.getModel()) return
  const text = await navigator.clipboard.readText().catch(() => '')
  ed.focus()
  if (text) ed.trigger('menu', 'paste', { text })
}

function createMenubar(): HTMLElement {
  const btns = new Map<string, HTMLElement>()
  let openId: string | null = null
  // 点开着的菜单的按钮：mousedown 先触发“点外面关闭”，这里记住刚关掉的是哪个，避免又被打开
  let justClosed: string | null = null

  const open = (id: string): void => {
    const def = MENUS.find((m) => m.id === id)!
    const btn = btns.get(id)!
    const r = btn.getBoundingClientRect()
    openId = id
    btn.classList.add('on')
    showMenu(r.left, r.bottom + 4, def.items(), {
      onClose: () => {
        btn.classList.remove('on')
        if (openId === id) openId = null
        justClosed = id
        setTimeout(() => (justClosed = null))
      },
      onStep: (d) => {
        const i = MENUS.findIndex((m) => m.id === id)
        open(MENUS[(i + d + MENUS.length) % MENUS.length].id)
      }
    })
  }

  return h(
    'nav',
    { class: 'menubar', role: 'menubar', 'aria-label': '菜单栏' },
    ...MENUS.map((m) => {
      const b = h(
        'button',
        {
          class: 'menubar-btn',
          role: 'menuitem',
          'aria-haspopup': 'menu',
          onMousedown: (e: MouseEvent) => {
            if (e.button !== 0) return
            e.preventDefault() // 不抢编辑器焦点
            if (justClosed === m.id) return
            open(m.id)
          },
          onMouseenter: () => {
            if (openId && openId !== m.id) open(m.id)
          },
          onKeydown: (e: KeyboardEvent) => {
            if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') {
              e.preventDefault()
              open(m.id)
            }
          }
        },
        m.label
      )
      btns.set(m.id, b)
      return b
    })
  )
}

const titlebar = h(
  'header',
  { class: 'titlebar' },
  h('div', { class: 'tb-left' }, h('span', { class: 'logo', html: icons.logo, title: 'Infinite Studio · 无界工作室' }), createMenubar()),
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
const railScm = h('button', { class: 'rail-btn', 'aria-label': '源代码管理 (Ctrl Shift G)', title: '源代码管理 Ctrl Shift G', html: icons.git, onClick: () => showSideView('scm', true) })
const railPlugins = h('button', { class: 'rail-btn', 'aria-label': '插件', title: '插件', html: icons.plugin, onClick: () => showSideView('plugins', true) })
const rail = h(
  'nav',
  { class: 'rail', 'aria-label': '活动栏' },
  railFiles,
  railSearch,
  railScm,
  h('button', { class: 'rail-btn', 'aria-label': '终端 (Ctrl `)', title: '终端 Ctrl `', html: icons.terminal, onClick: () => togglePanel() }),
  h('button', { class: 'rail-btn', 'aria-label': '专注模式 (Ctrl .)', title: '专注模式 Ctrl .', html: icons.focus, onClick: () => toggleFocus() }),
  h('span', { class: 'grow' }),
  accountBtn,
  railPlugins,
  h('button', { class: 'rail-btn', 'aria-label': '设置 (Ctrl ,)', title: '设置 Ctrl ,', html: icons.gear, onClick: () => toggleSettings() })
)

const sidebar = h('aside', { class: 'sidebar', 'aria-label': '侧栏' }, createTree(), createSearchView(), createScmView(), createPluginsView())
const sideSash = h('div', { class: 'side-sash', role: 'separator', 'aria-orientation': 'vertical', 'aria-label': '拖动调整侧栏宽度，拖到最窄会隐藏', title: '拖动调整宽度 · 双击恢复默认' })
const emptyHint = h('div', { class: 'empty-hint' })
const welcome = h('div', { class: 'welcome' })
const editorWrap = h('div', { class: 'editor-wrap' }, emptyHint)
const editorArea = h('main', { class: 'editor-area' }, editorWrap, createPanel())

const stBranch = h('span', { class: 'st-item' })
const stProblems = h('span', { class: 'st-item' })
const stCursor = h('span', { class: 'st-item' })
const stEol = h('span', { class: 'st-item' })
const stLang = h('span', { class: 'st-item' })
const stLsp = h('button', { class: 'st-item st-lsp', title: '点击重启语言服务', onClick: () => void restartLsp() })
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
  stLsp,
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

const body = h('div', { class: 'body' }, rail, sidebar, sideSash, editorArea, welcome)
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

function renderTabs(): void {
  renderEditorTabs()
  emptyHint.hidden = hasItems()
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
  const ls = t ? lspStatus(t.model.getLanguageId()) : null
  stLsp.hidden = !ls || ls.status === 'stopped'
  if (ls) {
    const label = { starting: '语言服务启动中', ready: '语言服务', failed: '语言服务未运行', stopped: '' }[ls.status]
    stLsp.dataset.status = ls.status
    stLsp.title = `${ls.name} 语言服务 · 点击重启`
    stLsp.replaceChildren(h('span', { class: 'dot' }), label)
  }
  stSpace.replaceChildren(h('span', { class: 'dot' }), `空间 · ${state.settings.space.name}`)
}

function applyLayout(): void {
  const welcomeMode = !state.root && !hasItems()
  app.classList.toggle('focus', isFocus() && !welcomeMode)
  app.classList.toggle('no-rail', !isRailVisible() && !welcomeMode)
  app.classList.toggle('no-side', !isSidebarVisible())
  app.classList.toggle('welcome-mode', welcomeMode)
  app.classList.toggle('panel-open', state.panelOpen)
  sidebar.dataset.view = state.sideView
  railFiles.classList.toggle('on', isSidebarVisible() && state.sideView === 'files')
  railSearch.classList.toggle('on', isSidebarVisible() && state.sideView === 'search')
  railScm.classList.toggle('on', isSidebarVisible() && state.sideView === 'scm')
  railPlugins.classList.toggle('on', isSidebarVisible() && state.sideView === 'plugins')
  sidebar.style.width = `${state.settings.sidebarWidth ?? SIDE_DEFAULT}px`
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
  await setLspRoot(path)
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
  for (const p of paths) {
    if (findTab(p)) void reloadFromDisk(p)
    else {
      // 为“查看定义”临时建的模型，文件变了就丢掉，下次重新读
      const shadow = monaco.editor.getModel(monaco.Uri.file(p))
      // 正在后台检查（IDE 桥接）的文件重新读入，其余的丢掉
      if (shadow && isProbe(shadow)) void refreshProbe(p)
      else if (shadow && !tabs.some((t) => t.model === shadow)) shadow.dispose()
    }
  }
  if (state.root && paths.some((p) => /[\\/]\.git[\\/]HEAD$/.test(p))) {
    void window.api.fs.gitBranch(state.root).then((b) => {
      state.branch = b
      renderStatus()
    })
  }
  if (state.root && paths.some((p) => /[\\/]\.git[\\/]/.test(p))) {
    if (isSidebarVisible() && state.sideView === 'scm') void refreshScm(true)
    else scmStale = true
  }
})

/** 源代码管理视图隐藏期间 .git 有变化，下次显示时再刷新 */
let scmStale = false

async function pickFolder(): Promise<void> {
  const p = await window.api.fs.openFolderDialog()
  if (p) await openFolder(p)
}

function closeFolder(): void {
  if (!closeAll()) return
  state.root = null
  state.branch = null
  void setLspRoot(null)
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
function showSideView(view: SideView, toggle = false): void {
  if (!state.root && view !== 'plugins') {
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
  if (view === 'plugins' && isSidebarVisible()) void refreshPlugins()
  if (view === 'scm' && isSidebarVisible()) {
    void refreshScm(scmStale)
    scmStale = false
  }
}

/* ---------------- 侧栏宽度 ---------------- */

const SIDE_DEFAULT = 240
const SIDE_MIN = 170

/** 能否通过拖动把侧栏拉出来（没打开文件夹时只有插件视图可以） */
const canShowSidebar = (): boolean => !!state.root || state.sideView === 'plugins'

// 拖动分隔条调整侧栏宽度；拖得比最小宽度的一半还窄就隐藏，隐藏后从左边缘往右拖又能拉出来
sideSash.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return
  e.preventDefault()
  const startX = e.clientX
  const startW = isSidebarVisible() ? sidebar.offsetWidth : 0
  const max = () => Math.max(SIDE_MIN, Math.min(800, body.clientWidth - 320))
  sideSash.classList.add('on')
  document.body.classList.add('resizing-h')
  const move = (ev: MouseEvent) => {
    const w = startW + ev.clientX - startX
    const show = w >= SIDE_MIN / 2 && canShowSidebar()
    if (show) {
      state.settings.sidebarWidth = Math.round(Math.min(max(), Math.max(SIDE_MIN, w)))
      sidebar.style.width = `${state.settings.sidebarWidth}px`
    }
    if (show !== isSidebarVisible()) {
      if (show && isFocus()) state.focusOverride = false
      state.sidebarOverride = show
      emit('layout')
    }
  }
  const up = () => {
    sideSash.classList.remove('on')
    document.body.classList.remove('resizing-h')
    window.removeEventListener('mousemove', move)
    window.removeEventListener('mouseup', up)
    persist()
    if (isSidebarVisible() && state.sideView === 'scm') void refreshScm()
  }
  window.addEventListener('mousemove', move)
  window.addEventListener('mouseup', up)
})
sideSash.addEventListener('dblclick', () => {
  state.settings.sidebarWidth = undefined
  persist()
  emit('layout')
})

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
  { id: 'view.scm', title: '源代码管理：提交历史', key: 'Ctrl Shift G', run: () => showSideView('scm') },
  { id: 'view.focus', title: '专注模式', key: 'Ctrl .', run: toggleFocus },
  { id: 'term.toggle', title: '显示 / 隐藏终端', key: 'Ctrl `', run: togglePanel },
  { id: 'term.new', title: '新建终端', key: 'Ctrl Shift `', run: () => newTerminal() },
  { id: 'view.settings', title: '打开个性化设置', key: 'Ctrl ,', run: openSettings },
  { id: 'account.login', title: '登录 GitHub', run: () => void openLoginDialog() },
  { id: 'view.wrap', title: '切换自动换行', key: 'Alt Z', run: toggleWrap },
  { id: 'editor.split', title: '向右拆分编辑器', key: 'Ctrl \\', run: () => splitRight() },
  { id: 'editor.nextGroup', title: '聚焦右侧编辑器组', key: 'Ctrl Alt →', run: () => focusNextGroup(1) },
  { id: 'editor.prevGroup', title: '聚焦左侧编辑器组', key: 'Ctrl Alt ←', run: () => focusNextGroup(-1) },
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
  { id: 'editor.format', title: '格式化文档', key: 'Shift Alt F', run: () => runEditorAction('editor.action.formatDocument') },
  { id: 'editor.definition', title: '转到定义', key: 'F12', run: () => runEditorAction('editor.action.revealDefinition') },
  { id: 'editor.references', title: '查找所有引用', key: 'Shift F12', run: () => runEditorAction('editor.action.referenceSearch.trigger') },
  { id: 'editor.rename', title: '重命名符号', key: 'F2', run: () => runEditorAction('editor.action.rename') },
  { id: 'editor.outline', title: '转到文件中的符号', key: 'Ctrl Shift O', run: () => runEditorAction('editor.action.quickOutline') },
  { id: 'lsp.restart', title: '重启语言服务', run: restartLsp },
  { id: 'window.devtools', title: '开发者工具', key: 'Ctrl Shift I', run: () => toast('按 Ctrl Shift I 打开开发者工具') }
])

function runEditorAction(id: string): void {
  const ed = getEditor()
  if (!ed?.getModel()) return
  ed.focus()
  // 用 trigger 而不是 getAction：后者会按上下文过滤，语言服务注册的功能可能被误判为不可用
  ed.trigger('palette', id, null)
}

function toggleWrap(): void {
  state.settings.wordWrap = !state.settings.wordWrap
  persist()
  emit('layout')
  toast(state.settings.wordWrap ? '自动换行：开' : '自动换行：关')
}

addTreeMenuItems(({ path }) => pluginTreeItems(path))
registerCommands(() => pluginCommands(() => showSideView('plugins')))
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
    } else if (ctrl && e.altKey && !e.shiftKey && k === 'k') void mentionToTerminalClaude()
    else if (ctrl && !e.shiftKey && k === 'k') openPalette()
    else if (ctrl && !e.shiftKey && k === 'p') openPalette()
    else if (ctrl && e.shiftKey && k === 'p') openPalette('>')
    else if (ctrl && e.shiftKey && k === 'f') showSideView('search')
    else if (ctrl && e.shiftKey && k === 'g') showSideView('scm')
    else if (ctrl && k === 's') void saveActive()
    else if (ctrl && k === 'o') void pickFolder()
    else if (ctrl && k === 'w') closeTab()
    else if (ctrl && k === 'b') toggleSidebar()
    else if (ctrl && k === '.') toggleFocus()
    else if (ctrl && k === ',') toggleSettings()
    else if (ctrl && (k === '=' || k === '+')) zoomPreviewAt(e.target, 1) || changeSize(1)
    else if (ctrl && k === '-') zoomPreviewAt(e.target, -1) || changeSize(-1)
    else if (ctrl && k === '0' && zoomPreviewAt(e.target, 0)) {
      /* 预览已处理 */
    }
    else if (ctrl && k === 'tab') cycleTab(e.shiftKey ? -1 : 1)
    else if (ctrl && !e.shiftKey && k === '\\') splitRight()
    else if (ctrl && e.altKey && k === 'arrowright') focusNextGroup(1)
    else if (ctrl && e.altKey && k === 'arrowleft') focusNextGroup(-1)
    else if (e.altKey && k === 'z') toggleWrap()
    else if (e.altKey && !ctrl && k === 'k') insertAtMention()
    else if (ctrl && !e.shiftKey && k === 'escape') {
      if (!toggleChatFocus()) getEditor()?.focus()
    } else handled = false
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
  renderPlugins()
  onTabsChanged()
  renderTabs()
  renderTree()
  renderStatus()
  applyLayout()
})
on('cursor', renderStatus)
on('lsp', renderStatus)
on('markers', renderStatus)
on('saved', renderStatus)
on('root', () => {
  if (isSidebarVisible() && state.sideView === 'scm') void refreshScm()
  renderStatus()
  renderWelcome()
  applyLayout()
  closePalette()
})

/** Ctrl Alt K：把当前文件 / 选中行作为 @引用发给终端里运行的 claude（和 VS Code 扩展一样） */
async function mentionToTerminalClaude(): Promise<void> {
  if (!recentFile()) return toast('没有打开的文件')
  if (!ideConnected()) return toast('终端里没有连接到编辑器的 Claude Code；在内置终端里运行 claude 即可自动连接')
  if (!(await sendAtMention())) toast('发送失败：终端里的 Claude Code 已断开')
}

/* ---------------- 启动 ---------------- */

async function boot(): Promise<void> {
  await loadSettings()
  initEditor(editorWrap)
  initPreview()
  setTrailing(agentIcons)
  initLsp()
  initIde()
  void initAccount()
  initChat()
  void refreshPlugins()
  initSettings(body, () => getEditor()?.focus())
  applySpace()
  renderTabs()
  renderEmptyHint()
  renderWelcome()
  applyLayout()
  const last = state.settings.recentFolders[0]
  if (last) await openFolder(last)
  document.fonts.ready.then(() => monaco.editor.remeasureFonts())
}

void boot()

// 调试入口：开发模式或 localStorage.debug = '1' 时，在控制台可用 window.__infinite
if (import.meta.env.DEV || localStorage.getItem('debug') === '1') {
  ;(window as unknown as Record<string, unknown>).__infinite = {
    monaco,
    getEditor,
    state,
    openFile,
    lsp: debugRequest
  }
}
