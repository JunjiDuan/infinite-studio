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
import './motion.css'

import type { ThemeId } from '../../shared/types'
import { registerCommands } from './commands'
import { basename, h, toast } from './dom'
import { showMenu, type MenuItem } from './menu'
import { checkForUpdates, openAbout, openPrivacy } from './help'
import { ideConnected, initIde, sendAtMention } from './ide'
import {
  activeTab,
  anyDirty,
  applyEditorOptions,
  canSave,
  closeAll,
  closeTab,
  cycleTab,
  findTab,
  focusNextGroup,
  getEditor,
  hasItems,
  initEditor,
  moveActiveTab,
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
import { initWebPanel, webPanelCommands, webPanelTreeItems } from './webPanel'
import { createPluginsView, onPluginsChange, pluginCommands, pluginTreeItems, refreshPlugins, render as renderPlugins, revealCategory } from './plugins'
import { createDebugView, debugActive, debugOrContinue, debugStatus, debugStep, initDebug, onPluginStateChanged, restartDebug, runActiveFile, runButtons, stopDebug, toggleBreakpointAtCursor } from './debug'
import { icons } from './icons'
import { defineTheme, languageName, monaco } from './monaco'
import { closePalette, invalidateFiles, isPaletteOpen, openPalette } from './palette'
import { closeSettings, initSettings, isSettingsOpen, openSettings, switchLocale } from './settingsView'
import { type SideView, emit, isFocus, isRailVisible, isSidebarVisible, loadSettings, on, persist, setSpace, state } from './store'
import { THEMES, applyCssVars } from './theme'
import { collapse, installRipples, viewTransition } from './motion'
import { createSysmonView, setSysmonVisible } from './sysmon'
import { debugRequest, initLsp, isProbe, lspStatus, refreshProbe, restartLsp, setLspRoot } from './lsp'
import { createPanel, newTerminal, togglePanel } from './panel'
import { initPreview, zoomPreviewAt } from './preview'
import { initNotebook } from './notebook'
import { openNewProject } from './newProject'
import { initMarket } from './market'
import { initAgentTools } from './agentTools'
import { createScmView, onScmCount, refreshScm, scheduleScmStatus } from './scm'
import { createSearchView, focusSearch, resetSearch } from './search'
import { addTreeMenuItems, beginCreate, createTree, invalidatePaths, render as renderTree, setTreeRoot } from './tree'
import { getLocale, t } from './i18n'

/* ---------------- 界面骨架 ---------------- */

const themeDots = h('div', { class: 'theme-dots', role: 'group', 'aria-label': t('切换主题') })

/* ---------------- 菜单栏（文件 / 编辑 / 选择 / 帮助） ---------------- */

type MenuDef = { id: string; label: string; items: () => MenuItem[] }

const hasEditor = (): boolean => !!getEditor()?.getModel()

const MENUS: MenuDef[] = [
  {
    id: 'file',
    label: t('文件'),
    items: () => [
      { label: t('新建文件'), disabled: !state.root, run: () => showFilesThen(() => void beginCreate('file')) },
      { label: t('新建文件夹'), disabled: !state.root, run: () => showFilesThen(() => void beginCreate('dir')) },
      { label: t('新建项目…'), run: newProject },
      { label: t('打开新窗口'), key: 'Ctrl Shift N', run: () => window.api.win.newWindow() },
      'sep',
      { label: t('打开文件夹…'), key: 'Ctrl O', run: () => void pickFolder() },
      { label: t('关闭文件夹'), disabled: !state.root, run: closeFolder },
      'sep',
      { label: t('保存'), key: 'Ctrl S', disabled: !canSave(), run: () => void saveActive() },
      { label: t('全部保存'), disabled: !anyDirty(), run: () => void saveAll() },
      'sep',
      { label: t('关闭标签'), key: 'Ctrl W', disabled: !activeTab(), run: () => closeTab() },
      'sep',
      { label: t('系统设置'), run: () => openSettings('system') },
      { label: t('个性化与主题'), key: 'Ctrl ,', run: () => openSettings('appearance') },
      { label: t('多语言设置'), run: () => openSettings('language') },
      'sep',
      { label: t('退出'), run: requestClose }
    ]
  },
  {
    id: 'edit',
    label: t('编辑'),
    items: () => {
      const off = !hasEditor()
      return [
        { label: t('撤销'), key: 'Ctrl Z', disabled: off, run: () => runEditorAction('undo') },
        { label: t('重做'), key: 'Ctrl Y', disabled: off, run: () => runEditorAction('redo') },
        'sep',
        { label: t('剪切'), key: 'Ctrl X', disabled: off, run: () => runEditorAction('editor.action.clipboardCutAction') },
        { label: t('复制'), key: 'Ctrl C', disabled: off, run: () => runEditorAction('editor.action.clipboardCopyAction') },
        { label: t('粘贴'), key: 'Ctrl V', disabled: off, run: () => void pasteToEditor() },
        'sep',
        { label: t('全选'), key: 'Ctrl A', disabled: off, run: () => runEditorAction('editor.action.selectAll') },
        'sep',
        { label: t('查找'), key: 'Ctrl F', disabled: off, run: () => runEditorAction('actions.find') },
        { label: t('替换'), key: 'Ctrl H', disabled: off, run: () => runEditorAction('editor.action.startFindReplaceAction') },
        'sep',
        { label: t('在文件中查找'), key: 'Ctrl Shift F', disabled: !state.root, run: () => showSideView('search') },
        'sep',
        { label: t('切换行注释'), key: 'Ctrl /', disabled: off, run: () => runEditorAction('editor.action.commentLine') },
        { label: t('格式化文档'), key: 'Shift Alt F', disabled: off, run: () => runEditorAction('editor.action.formatDocument') }
      ]
    }
  },
  {
    id: 'selection',
    label: t('选择'),
    items: () => {
      const off = !hasEditor()
      const act = (label: string, key: string, id: string): MenuItem => ({ label, key, disabled: off, run: () => runEditorAction(id) })
      return [
        act(t('全选'), 'Ctrl A', 'editor.action.selectAll'),
        act(t('扩大选区'), 'Shift Alt →', 'editor.action.smartSelect.expand'),
        act(t('缩小选区'), 'Shift Alt ←', 'editor.action.smartSelect.shrink'),
        'sep',
        act(t('向上复制行'), 'Shift Alt ↑', 'editor.action.copyLinesUpAction'),
        act(t('向下复制行'), 'Shift Alt ↓', 'editor.action.copyLinesDownAction'),
        act(t('向上移动行'), 'Alt ↑', 'editor.action.moveLinesUpAction'),
        act(t('向下移动行'), 'Alt ↓', 'editor.action.moveLinesDownAction'),
        'sep',
        act(t('在上方添加光标'), 'Ctrl Alt ↑', 'editor.action.insertCursorAbove'),
        act(t('在下方添加光标'), 'Ctrl Alt ↓', 'editor.action.insertCursorBelow'),
        act(t('在行尾添加光标'), 'Shift Alt I', 'editor.action.insertCursorAtEndOfEachLineSelected'),
        act(t('添加下一个匹配项'), 'Ctrl D', 'editor.action.addSelectionToNextFindMatch'),
        act(t('选择所有匹配项'), 'Ctrl Shift L', 'editor.action.selectHighlights')
      ]
    }
  },
  {
    id: 'help',
    label: t('帮助'),
    items: () => [
      { label: t('隐私声明'), run: openPrivacy },
      { label: t('检查更新…'), run: () => void checkForUpdates() },
      'sep',
      { label: t('关于'), run: () => void openAbout() }
    ]
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
    // 被收进“更多”的菜单：从“更多”按钮下方展开
    const btn = btns.get(id)!.hidden ? moreBtn : btns.get(id)!
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

  // 宽度不够时，放不下的菜单收进末尾的“更多”按钮（同 VS Code）
  const moreBtn: HTMLElement = h(
    'button',
    {
      class: 'menubar-btn menubar-more',
      role: 'menuitem',
      'aria-haspopup': 'menu',
      'aria-label': t('更多菜单'),
      title: t('更多菜单'),
      hidden: true,
      html: icons.more,
      onMousedown: (e: MouseEvent) => {
        if (e.button !== 0) return
        e.preventDefault()
        if (justClosed === '__more') return
        const r = moreBtn.getBoundingClientRect()
        moreBtn.classList.add('on')
        showMenu(
          r.left,
          r.bottom + 4,
          MENUS.filter((m) => btns.get(m.id)!.hidden).map((m) => ({ label: m.label, run: () => setTimeout(() => open(m.id)) })),
          {
            onClose: () => {
              moreBtn.classList.remove('on')
              justClosed = '__more'
              setTimeout(() => (justClosed = null))
            }
          }
        )
      }
    }
  )

  const fit = (): void => {
    const all = [...btns.values()]
    for (const b of all) b.hidden = false
    moreBtn.hidden = true
    const avail = nav.clientWidth
    if (nav.scrollWidth <= avail) return
    moreBtn.hidden = false
    const room = avail - moreBtn.offsetWidth - 2
    let used = 0
    for (const b of all) {
      used += b.offsetWidth + 2
      if (used > room) b.hidden = true
    }
  }

  const nav = h(
    'nav',
    { class: 'menubar', role: 'menubar', 'aria-label': t('菜单栏') },
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
    }),
    moreBtn
  )
  new ResizeObserver(fit).observe(nav)
  return nav
}

const titlebar = h(
  'header',
  { class: 'titlebar' },
  h('div', { class: 'tb-left' }, h('span', { class: 'logo', html: icons.logo, title: t('Infinite Studio · 无界工作室') }), createMenubar()),
  h(
    'button',
    { class: 'tb-search', 'aria-label': t('打开命令面板'), onClick: () => openPalette() },
    h('span', { class: 'ic', html: icons.search }),
    h('span', { class: 'grow' }, t('搜索文件，或输入命令')),
    h('kbd', {}, 'Ctrl K')
  ),
  h(
    'div',
    { class: 'tb-right' },
    themeDots,
    h('button', { class: 'win-btn', 'aria-label': t('最小化'), html: icons.minimize, onClick: () => window.api.win.minimize() }),
    h('button', { class: 'win-btn', 'aria-label': t('最大化'), html: icons.maximize, onClick: () => window.api.win.toggleMaximize() }),
    h('button', { class: 'win-btn close', 'aria-label': t('关闭'), html: icons.winClose, onClick: () => requestClose() })
  )
)

const railFiles = h('button', { class: 'rail-btn', 'aria-label': t('文件 (Ctrl B)'), title: t('文件 Ctrl B'), html: icons.files, onClick: () => showSideView('files', true) })
const railSearch = h('button', { class: 'rail-btn', 'aria-label': t('在文件中搜索 (Ctrl Shift F)'), title: t('搜索 Ctrl Shift F'), html: icons.search, onClick: () => showSideView('search', true) })
const railScm = h('button', { class: 'rail-btn', 'aria-label': t('源代码管理 (Ctrl Shift G)'), title: t('源代码管理 Ctrl Shift G'), html: icons.git, onClick: () => showSideView('scm', true) })
/** 源代码管理按钮右下角的待提交数量 */
const scmBadge = h('span', { class: 'rail-badge', hidden: true })
railScm.append(scmBadge)
onScmCount((n) => {
  scmBadge.hidden = n === 0
  scmBadge.textContent = n > 99 ? '99+' : String(n)
  railScm.setAttribute('aria-label', n ? t('源代码管理 (Ctrl Shift G)') + ' · ' + n : t('源代码管理 (Ctrl Shift G)'))
})
const railDebug = h('button', { class: 'rail-btn', 'aria-label': t('运行和调试 (Ctrl Shift D)'), title: t('运行和调试 Ctrl Shift D'), html: icons.bug, onClick: () => showSideView('debug', true) })
const railMonitor = h('button', { class: 'rail-btn', 'aria-label': t('系统监视器'), title: t('系统监视器'), html: icons.activity, onClick: () => showSideView('monitor', true) })
const railPlugins = h('button', { class: 'rail-btn', 'aria-label': t('插件'), title: t('插件'), html: icons.plugin, onClick: () => showSideView('plugins', true) })
const railInk = h('span', { class: 'rail-ink', 'aria-hidden': 'true' })
const gearBtn: HTMLButtonElement = h('button', {
  class: 'rail-btn',
  'aria-label': t('设置'),
  'aria-haspopup': 'menu',
  title: t('设置'),
  html: icons.gear,
  onClick: () => openGearMenu()
})

/** 活动栏底部的设置按钮：弹出设置大类菜单（菜单从按钮右侧向上展开） */
function openGearMenu(): void {
  const r = gearBtn.getBoundingClientRect()
  gearBtn.classList.add('on')
  showMenu(
    r.right + 6,
    r.bottom,
    [
      { label: t('命令面板…'), key: 'Ctrl K', run: () => void openPalette() },
      'sep',
      { label: t('多语言设置'), icon: icons.languages, run: () => openSettings('language') },
      'sep',
      { label: t('系统设置'), run: () => openSettings('system') },
      { label: t('个性化与主题'), key: 'Ctrl ,', run: () => openSettings('appearance') },
      'sep',
      { label: t('插件'), run: () => showSideView('plugins') }
    ],
    { onClose: () => gearBtn.classList.remove('on'), anchor: 'bottom', owner: gearBtn }
  )
}
const rail = h(
  'nav',
  { class: 'rail', 'aria-label': t('活动栏') },
  railInk,
  railFiles,
  railSearch,
  railScm,
  railDebug,
  railMonitor,
  h('button', { class: 'rail-btn', 'aria-label': t('终端 (Ctrl `)'), title: t('终端 Ctrl `'), html: icons.terminal, onClick: () => togglePanel() }),
  h('span', { class: 'grow' }),
  accountBtn,
  railPlugins,
  gearBtn
)

const sidebar = h('aside', { class: 'sidebar', 'aria-label': t('侧栏') }, createTree(), createSearchView(), createScmView(), createDebugView(() => showSideView('plugins'), () => showSideView('debug')), createSysmonView(), createPluginsView())
const sideSash = h('div', { class: 'side-sash', role: 'separator', 'aria-orientation': 'vertical', 'aria-label': t('拖动调整侧栏宽度，拖到最窄会隐藏'), title: t('拖动调整宽度 · 双击恢复默认') })
const emptyHint = h('div', { class: 'empty-hint' })
const welcome = h('div', { class: 'welcome' })
const editorWrap = h('div', { class: 'editor-wrap' }, emptyHint)
const panelEl = createPanel()
const editorArea = h('main', { class: 'editor-area' }, editorWrap, panelEl)

const stBranch = h('span', { class: 'st-item' })
const stProblems = h('span', { class: 'st-item' })
const stCursor = h('span', { class: 'st-item' })
const stEol = h('span', { class: 'st-item' })
const stLang = h('span', { class: 'st-item' })
const stLsp = h('button', { class: 'st-item st-lsp', title: t('点击重启语言服务'), onClick: () => void restartLsp() })
const stDebug = h('button', { class: 'st-item st-debug', hidden: true, onClick: () => showSideView('debug') })
const statusbar = h(
  'footer',
  { class: 'statusbar' },
  stBranch,
  stProblems,
  stDebug,
  h('span', { class: 'grow' }),
  stCursor,
  h('span', { class: 'st-item' }, 'UTF-8'),
  stEol,
  stLang,
  stLsp
)

const focusPill = h(
  'div',
  { class: 'focus-pill' },
  h('span', { class: 'pill-label' }, h('span', { class: 'dot' }), t('专注模式')),
  h('button', { onClick: () => openPalette() }, t('Ctrl K 命令')),
  h('button', { class: 'pill-exit', onClick: () => toggleFocus() }, t('退出 Esc'))
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
        {
          class: 'theme-dot' + (id === cur ? ' on' : ''),
          'aria-label': THEMES[id].label,
          'aria-pressed': String(id === cur),
          title: THEMES[id].label,
          onClick: (e: MouseEvent) => switchTheme(id, e)
        },
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
      h('div', {}, h('span', {}, t('搜索文件或命令')), h('kbd', {}, 'Ctrl K')),
      h('div', {}, h('span', {}, t('在文件中搜索')), h('kbd', {}, 'Ctrl Shift F')),
      h('div', {}, h('span', {}, t('显示 / 隐藏侧栏')), h('kbd', {}, 'Ctrl B')),
      h('div', {}, h('span', {}, t('专注模式')), h('kbd', {}, 'Ctrl .')),
      h('div', {}, h('span', {}, t('个性化与主题')), h('kbd', {}, 'Ctrl ,'))
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
      h('h1', {}, t('无界工作室')),
      h('p', { class: 'en' }, 'Infinite Studio'),
      h(
        'div',
        { class: 'welcome-actions' },
        h('button', { class: 'btn primary', onClick: () => pickFolder() }, t('打开文件夹'), h('kbd', {}, 'Ctrl O')),
        h('button', { class: 'btn', onClick: newProject }, t('新建项目')),
        h('button', { class: 'btn', onClick: () => openSettings('appearance') }, t('个性化与主题'))
      ),
      recents.length
        ? h(
            'div',
            { class: 'recents' },
            h('h2', {}, t('最近打开')),
            ...recents.map((p, i) =>
              h('button', { class: 'recent', title: p, style: { '--i': String(i) }, onClick: () => openFolder(p) }, h('span', { class: 'ic', html: icons.folder }), h('span', { class: 'r-name' }, basename(p)), h('span', { class: 'r-path' }, p))
            )
          )
        : null
    )
  )
}

function renderStatus(): void {
  const tab = activeTab()
  stBranch.replaceChildren(...(state.branch ? [h('span', { class: 'ic', html: icons.gitSmall }), state.branch] : []))
  stBranch.hidden = !state.branch
  const n = problemCount()
  stProblems.textContent = state.root ? t('{0} 个问题', n) : ''
  stProblems.hidden = !state.root
  const pos = getEditor()?.getPosition()
  stCursor.textContent = tab && pos ? t('行 {0}，列 {1}', pos.lineNumber, pos.column) : ''
  stCursor.hidden = !tab
  stEol.textContent = tab ? (tab.model.getEOL() === '\r\n' ? 'CRLF' : 'LF') : ''
  stEol.hidden = !tab
  stLang.textContent = tab ? languageName(tab.model.getLanguageId()) : ''
  stLang.hidden = !tab
  const ls = tab ? lspStatus(tab.model.getLanguageId()) : null
  stLsp.hidden = !ls || ls.status === 'stopped'
  if (ls) {
    const label = { starting: t('语言服务启动中'), ready: t('语言服务'), failed: t('语言服务未运行'), stopped: '' }[ls.status]
    stLsp.dataset.status = ls.status
    stLsp.title = t('{0} 语言服务 · 点击重启', ls.name)
    stLsp.replaceChildren(h('span', { class: 'dot' }), label)
  }
  const ds = debugStatus()
  stDebug.hidden = !ds
  if (ds) {
    stDebug.dataset.state = ds.state
    stDebug.replaceChildren(h('span', { class: 'ic', html: icons.bug }), ds.label)
  }
}

/** 上一次布局的状态：只有真正变化时才播放展开 / 收起动画 */
let shown = { side: false, panel: false, focus: false, welcome: true, booted: false }
/** 正在拖动侧栏分隔条：这时显示 / 隐藏不做动画 */
let sashDragging = false

function applyLayout(): void {
  const welcomeMode = !state.root && !hasItems()
  const focus = isFocus() && !welcomeMode
  const side = isSidebarVisible()
  const panel = state.panelOpen
  // 整体模式切换（专注、欢迎页）时不叠加局部动画
  const anim = shown.booted && !sashDragging && focus === shown.focus && welcomeMode === shown.welcome
  sidebar.style.width = `${state.settings.sidebarWidth ?? SIDE_DEFAULT}px`
  sidebar.style.setProperty('--side-w', sidebar.style.width)
  // 收起：要在隐藏之前测量尺寸
  if (anim && shown.side && !side) collapse(sidebar, 'width', false)
  if (anim && shown.panel && !panel) collapse(panelEl, 'height', false)
  app.classList.toggle('focus', focus)
  app.classList.toggle('no-rail', !isRailVisible() && !welcomeMode)
  app.classList.toggle('no-side', !side)
  app.classList.toggle('welcome-mode', welcomeMode)
  app.classList.toggle('panel-open', panel)
  sidebar.dataset.view = state.sideView
  railFiles.classList.toggle('on', side && state.sideView === 'files')
  railSearch.classList.toggle('on', side && state.sideView === 'search')
  railScm.classList.toggle('on', side && state.sideView === 'scm')
  railPlugins.classList.toggle('on', side && state.sideView === 'plugins')
  railDebug.classList.toggle('on', side && state.sideView === 'debug')
  railMonitor.classList.toggle('on', side && state.sideView === 'monitor')
  setSysmonVisible(side && state.sideView === 'monitor')
  if (anim && !shown.side && side) collapse(sidebar, 'width', true)
  if (anim && !shown.panel && panel) collapse(panelEl, 'height', true)
  shown = { side, panel, focus, welcome: welcomeMode, booted: shown.booted }
  placeRailInk()
  applyEditorOptions()
}

/** 活动栏左侧的指示条滑到当前视图的按钮旁边 */
function placeRailInk(): void {
  const on = [railFiles, railSearch, railScm, railDebug, railMonitor, railPlugins].find((b) => b.classList.contains('on'))
  if (!on || !on.offsetParent) {
    railInk.classList.remove('show')
    return
  }
  const y = on.offsetTop
  if (!railInk.classList.contains('show')) {
    // 从隐藏到出现：不滑动，直接在目标位置从短变长
    railInk.style.transition = 'none'
    railInk.style.transform = `translateY(${y + 12}px)`
    railInk.style.height = '16px'
    void railInk.offsetWidth
    railInk.style.transition = ''
  }
  railInk.classList.add('show')
  railInk.style.transform = `translateY(${y}px)`
  railInk.style.height = `${on.offsetHeight}px`
}

/** 切换主题：新主题从点击位置以圆形扩散铺满整个窗口 */
function switchTheme(id: ThemeId, e?: MouseEvent): void {
  if (state.settings.space.theme === id) return
  viewTransition(() => setSpace({ theme: id }), e ? { reveal: { x: e.clientX, y: e.clientY } } : {})
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
    toast(t('文件夹不存在或无法访问'))
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
  if (state.root && paths.some((p) => /[\\/]\.git([\\/]|$)/.test(p))) {
    if (isSidebarVisible() && state.sideView === 'scm') void refreshScm(true)
    else {
      scmStale = true
      scheduleScmStatus()
    }
  } else if (state.root && paths.length) scheduleScmStatus()
})

/** 源代码管理视图隐藏期间 .git 有变化，下次显示时再刷新 */
let scmStale = false

/** 新建项目对话框；项目在此窗口打开时由这里接手 */
function newProject(): void {
  void openNewProject(openCreatedProject)
}

/** 打开刚建好的项目：随后打开示例文件，需要时在终端里装依赖 */
async function openCreatedProject(r: { path: string; open?: string; post?: string }): Promise<void> {
  await openFolder(r.path)
  // 有没保存的文件、用户取消了切换
  if (state.root !== r.path) return
  if (r.open) await openFile(r.open)
  if (r.post) void newTerminal(r.path, { title: t('安装依赖'), run: r.post })
}

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
  if (!state.root && view !== 'plugins' && view !== 'debug' && view !== 'monitor') {
    if (view === 'search') toast(t('先打开一个文件夹'))
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
const canShowSidebar = (): boolean => !!state.root || state.sideView === 'plugins' || state.sideView === 'monitor'

// 拖动分隔条调整侧栏宽度；拖得比最小宽度的一半还窄就隐藏，隐藏后从左边缘往右拖又能拉出来
sideSash.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return
  e.preventDefault()
  const startX = e.clientX
  const startW = isSidebarVisible() ? sidebar.offsetWidth : 0
  const max = () => Math.max(SIDE_MIN, Math.min(800, body.clientWidth - 320))
  sideSash.classList.add('on')
  document.body.classList.add('resizing-h')
  sashDragging = true
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
    sashDragging = false
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
  viewTransition(
    () => {
      state.focusOverride = !isFocus()
      emit('layout')
    },
    { kind: 'focus' }
  )
  getEditor()?.focus()
}

/** Ctrl , 和状态栏的空间按钮：打开 / 关闭“个性化与主题” */
function toggleSettings(): void {
  if (isSettingsOpen()) closeSettings()
  else openSettings('appearance')
}

function changeSize(d: number): void {
  setSpace({ size: state.settings.space.size + d })
}

let closing = false
function requestClose(): void {
  if (anyDirty() && !confirm(t('有未保存的修改，确定退出吗？'))) return
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
  { id: 'folder.open', title: t('打开文件夹…'), key: 'Ctrl O', run: pickFolder },
  { id: 'window.new', title: t('打开新窗口'), key: 'Ctrl Shift N', run: () => window.api.win.newWindow() },
  { id: 'project.new', title: t('新建项目…'), run: newProject },
  ...(state.root ? [{ id: 'folder.close', title: t('关闭文件夹'), run: closeFolder }] : []),
  ...(state.root
    ? [
        { id: 'file.new', title: t('新建文件'), run: () => showFilesThen(() => beginCreate('file')) },
        { id: 'dir.new', title: t('新建文件夹'), run: () => showFilesThen(() => beginCreate('dir')) }
      ]
    : []),
  { id: 'file.save', title: t('保存'), key: 'Ctrl S', run: saveActive },
  { id: 'file.saveAll', title: t('全部保存'), run: saveAll },
  { id: 'file.close', title: t('关闭当前标签'), key: 'Ctrl W', run: () => closeTab() },
  { id: 'view.sidebar', title: t('显示 / 隐藏侧栏'), key: 'Ctrl B', run: toggleSidebar },
  { id: 'view.search', title: t('在文件中搜索'), key: 'Ctrl Shift F', run: () => showSideView('search') },
  { id: 'view.scm', title: t('源代码管理'), key: 'Ctrl Shift G', run: () => showSideView('scm') },
  { id: 'view.focus', title: t('专注模式'), key: 'Ctrl .', run: toggleFocus },
  { id: 'term.toggle', title: t('显示 / 隐藏终端'), key: 'Ctrl `', run: togglePanel },
  { id: 'term.new', title: t('新建终端'), key: 'Ctrl Shift `', run: () => newTerminal() },
  { id: 'view.settings', title: t('打开个性化与主题'), key: 'Ctrl ,', run: () => openSettings('appearance') },
  { id: 'view.locale', title: getLocale() === 'zh' ? 'Switch Language: English' : '切换语言：简体中文', run: () => void switchLocale(getLocale() === 'zh' ? 'en' : 'zh') },
  { id: 'view.systemSettings', title: t('打开系统设置'), run: () => openSettings('system') },
  { id: 'view.languageSettings', title: t('打开多语言设置'), run: () => openSettings('language') },
  { id: 'account.login', title: t('登录 GitHub'), run: () => void openLoginDialog() },
  { id: 'view.wrap', title: t('切换自动换行'), key: 'Alt Z', run: toggleWrap },
  { id: 'editor.split', title: t('向右拆分编辑器'), key: 'Ctrl \\', run: () => splitRight() },
  { id: 'editor.nextGroup', title: t('聚焦右侧编辑器组'), key: 'Ctrl Alt →', run: () => focusNextGroup(1) },
  { id: 'editor.prevGroup', title: t('聚焦左侧编辑器组'), key: 'Ctrl Alt ←', run: () => focusNextGroup(-1) },
  { id: 'font.bigger', title: t('增大字号'), key: 'Ctrl =', run: () => changeSize(1) },
  { id: 'font.smaller', title: t('减小字号'), key: 'Ctrl -', run: () => changeSize(-1) },
  ...(Object.keys(THEMES) as ThemeId[]).map((id) => ({
    id: 'theme.' + id,
    title: t('切换主题：{0}', THEMES[id].label),
    hint: state.settings.space.theme === id ? t('当前') : '',
    run: () => switchTheme(id)
  })),
  { id: 'editor.moveTabLeft', title: t('向左移动标签'), key: 'Ctrl Shift PgUp', run: () => moveActiveTab(-1) },
  { id: 'editor.moveTabRight', title: t('向右移动标签'), key: 'Ctrl Shift PgDn', run: () => moveActiveTab(1) },
  { id: 'editor.format', title: t('格式化文档'), key: 'Shift Alt F', run: () => runEditorAction('editor.action.formatDocument') },
  { id: 'editor.definition', title: t('转到定义'), key: 'F12', run: () => runEditorAction('editor.action.revealDefinition') },
  { id: 'editor.references', title: t('查找所有引用'), key: 'Shift F12', run: () => runEditorAction('editor.action.referenceSearch.trigger') },
  { id: 'editor.rename', title: t('重命名符号'), key: 'F2', run: () => runEditorAction('editor.action.rename') },
  { id: 'editor.outline', title: t('转到文件中的符号'), key: 'Ctrl Shift O', run: () => runEditorAction('editor.action.quickOutline') },
  { id: 'lsp.restart', title: t('重启语言服务'), run: restartLsp },
  { id: 'debug.view', title: t('运行和调试'), key: 'Ctrl Shift D', run: () => showSideView('debug') },
  { id: 'view.monitor', title: t('系统监视器'), run: () => showSideView('monitor') },
  { id: 'debug.run', title: t('运行当前文件'), key: 'Ctrl F5', run: runActiveFile },
  { id: 'debug.start', title: debugActive() ? t('调试：继续') : t('调试当前文件'), key: 'F5', run: debugOrContinue },
  ...(debugActive()
    ? [
        { id: 'debug.stop', title: t('调试：停止'), key: 'Shift F5', run: stopDebug },
        { id: 'debug.restart', title: t('调试：重新启动'), key: 'Ctrl Shift F5', run: restartDebug },
        { id: 'debug.next', title: t('调试：单步跳过'), key: 'F10', run: () => void debugStep('next') },
        { id: 'debug.stepIn', title: t('调试：单步进入'), key: 'F11', run: () => void debugStep('stepIn') },
        { id: 'debug.stepOut', title: t('调试：单步跳出'), key: 'Shift F11', run: () => void debugStep('stepOut') }
      ]
    : []),
  { id: 'debug.toggleBreakpoint', title: t('切换断点'), key: 'F9', run: () => toggleBreakpointAtCursor(getEditor()) },
  { id: 'window.devtools', title: t('开发者工具'), key: 'Ctrl Shift I', run: () => toast(t('按 Ctrl Shift I 打开开发者工具')) }
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
  toast(state.settings.wordWrap ? t('自动换行：开') : t('自动换行：关'))
}

addTreeMenuItems(({ path }) => [...pluginTreeItems(path), ...webPanelTreeItems(path)])
registerCommands(() => pluginCommands(() => showSideView('plugins')))
registerCommands(webPanelCommands)
addTreeMenuItems(({ dir }) => [{ label: t('在终端中打开'), run: () => void newTerminal(dir) }, 'sep'])

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
    else if (ctrl && e.shiftKey && k === 'd') showSideView('debug')
    else if (k === 'f5' && ctrl && e.shiftKey) void restartDebug()
    else if (k === 'f5' && ctrl) void runActiveFile()
    else if (k === 'f5' && e.shiftKey) void stopDebug()
    else if (k === 'f5') void debugOrContinue()
    else if (k === 'f9' && !ctrl && !e.shiftKey) toggleBreakpointAtCursor(getEditor())
    else if (k === 'f10' && !ctrl && debugActive()) debugStep('next')
    else if (k === 'f11' && !ctrl && debugActive()) debugStep(e.shiftKey ? 'stepOut' : 'stepIn')
    else if (k === 'f6' && !ctrl && debugActive()) debugStep('pause')
    else if (ctrl && e.shiftKey && k === 'n') window.api.win.newWindow()
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
    else if (ctrl && e.shiftKey && k === 'pageup') moveActiveTab(-1)
    else if (ctrl && e.shiftKey && k === 'pagedown') moveActiveTab(1)
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
on('debug', renderStatus)
onPluginsChange(onPluginStateChanged)
on('markers', renderStatus)
on('saved', renderStatus)
on('saved', scheduleScmStatus)
on('root', () => {
  if (isSidebarVisible() && state.sideView === 'scm') void refreshScm()
  else {
    scmStale = true
    scheduleScmStatus()
  }
  renderStatus()
  renderWelcome()
  applyLayout()
  closePalette()
})

/** Ctrl Alt K：把当前文件 / 选中行作为 @引用发给终端里运行的 claude（和 VS Code 扩展一样） */
async function mentionToTerminalClaude(): Promise<void> {
  if (!recentFile()) return toast(t('没有打开的文件'))
  if (!ideConnected()) return toast(t('终端里没有连接到编辑器的 Claude Code；在内置终端里运行 claude 即可自动连接'))
  if (!(await sendAtMention())) toast(t('发送失败：终端里的 Claude Code 已断开'))
}

/* ---------------- 启动 ---------------- */

async function boot(): Promise<void> {
  await loadSettings()
  installRipples()
  app.classList.add('booting')
  setTimeout(() => app.classList.remove('booting'), 900)
  initEditor(editorWrap)
  // 插件的自定义编辑器要在 Notebook、文档预览之前注册（PDF 等可以由插件接管）
  await initMarket()
  initAgentTools()
  initNotebook()
  initPreview()
  setTrailing(h('div', { class: 'trail' }, runButtons, agentIcons))
  initLsp()
  initDebug()
  initIde()
  void initAccount()
  initChat()
  initWebPanel()
  void refreshPlugins()
  initSettings(
    body,
    () => getEditor()?.focus(),
    () => {
      closeSettings()
      showSideView('plugins')
      revealCategory('locale')
    }
  )
  applySpace()
  renderTabs()
  renderEmptyHint()
  renderWelcome()
  applyLayout()
  shown.booted = true
  const last = state.settings.recentFolders[0]
  const query = new URLSearchParams(location.search)
  const target = query.get('open')
  // 新建项目后在新窗口打开
  if (target) await openCreatedProject({ path: target, open: query.get('file') ?? undefined, post: query.get('run') ?? undefined })
  else if (last && !query.has('blank')) await openFolder(last)
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
