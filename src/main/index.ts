import { app, BrowserWindow, ipcMain, Menu, shell } from 'electron'
import { existsSync, promises as fs } from 'node:fs'
import path from 'node:path'
import type { Settings } from '../shared/types'
import { registerFsIpc } from './fsService'
import { registerGitIpc } from './git'
import { registerSearchIpc } from './search'
import { registerLspIpc } from './lsp'
import { registerTerminalIpc } from './terminal'
import { registerAccountIpc } from './account'
import { registerAppInfoIpc } from './appInfo'
import { registerPluginIpc } from './plugins'
import { registerMarketIpc, registerPluginScheme } from './market'
import { registerDebugIpc } from './debug'
import { registerJupyterIpc } from './jupyter'
import { registerAgentIpc } from './agents'
import { registerSysmonIpc } from './sysmon'
import { registerIdeIpc, startIdeServer } from './ide'
import { getSavedLocale, setMainLocale } from './i18n'

const settingsFile = () => path.join(app.getPath('userData'), 'settings.json')

function themeBg(theme: string | undefined): string {
  return theme === 'paper' ? '#F7F5F0' : theme === 'ink' ? '#0E0E10' : theme === 'graphite' ? '#1E1F22' : '#16151B'
}

async function readSettings(): Promise<Settings | null> {
  try {
    return JSON.parse(await fs.readFile(settingsFile(), 'utf8')) as Settings
  } catch {
    return null
  }
}

/** prev：重新创建窗口时沿用旧窗口的位置和最大化状态；blank：新窗口不自动打开上次的文件夹 */
async function createWindow(prev?: { bounds: Electron.Rectangle; maximized: boolean }, blank = false): Promise<BrowserWindow> {
  const settings = await readSettings()
  setMainLocale(settings?.locale, app.getLocale())
  // 开发时用仓库里的图标；打包后图标已嵌进 exe
  const devIcon = path.join(app.getAppPath(), 'build', 'icon.png')
  const win = new BrowserWindow({
    width: prev?.bounds.width ?? 1440,
    height: prev?.bounds.height ?? 900,
    x: prev?.bounds.x,
    y: prev?.bounds.y,
    minWidth: 760,
    minHeight: 480,
    frame: false,
    show: false,
    title: 'Infinite Studio',
    icon: !app.isPackaged && existsSync(devIcon) ? devIcon : undefined,
    backgroundColor: themeBg(settings?.space?.theme),
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false
    }
  })

  win.once('ready-to-show', () => {
    if (prev?.maximized) win.maximize()
    win.show()
  })

  // 外部链接用系统浏览器打开，窗口本身禁止跳转
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, url) => {
    if (url !== win.webContents.getURL()) e.preventDefault()
  })

  // 没有菜单栏，自己接管开发者工具和刷新快捷键
  win.webContents.on('before-input-event', (_e, input) => {
    if (input.type !== 'keyDown') return
    // F12 留给“转到定义”
    const devtools = input.control && input.shift && input.key.toLowerCase() === 'i'
    if (devtools) win.webContents.toggleDevTools()
    if (!app.isPackaged && input.control && input.shift && input.key.toLowerCase() === 'r') win.webContents.reload()
  })

  if (!app.isPackaged && process.env['ELECTRON_RENDERER_URL']) {
    await win.loadURL(process.env['ELECTRON_RENDERER_URL'] + (blank ? '?blank=1' : ''))
  } else {
    await win.loadFile(path.join(__dirname, '../renderer/index.html'), blank ? { query: { blank: '1' } } : undefined)
  }
  return win
}

function senderWindow(e: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent): BrowserWindow | null {
  return BrowserWindow.fromWebContents(e.sender)
}

function registerIpc(): void {
  ipcMain.on('win:minimize', (e) => senderWindow(e)?.minimize())
  ipcMain.on('win:toggleMaximize', (e) => {
    const w = senderWindow(e)
    if (!w) return
    if (w.isMaximized()) w.unmaximize()
    else w.maximize()
  })
  ipcMain.on('win:close', (e) => senderWindow(e)?.close())
  // 切换界面语言：新开一个窗口再销毁旧窗口（销毁会清理旧窗口的终端、语言服务、对话进程）
  ipcMain.on('win:reload', (e) => {
    const old = senderWindow(e)
    if (!old) return
    const prev = { bounds: old.getNormalBounds(), maximized: old.isMaximized() }
    void createWindow(prev).then((win) => (win.isVisible() ? old.destroy() : win.once('show', () => old.destroy())))
  })

  // 新开一个空白 IDE 窗口，位置相对当前窗口错开一点
  ipcMain.on('win:new', (e) => {
    const cur = senderWindow(e)
    const b = cur?.getNormalBounds()
    void createWindow(b ? { bounds: { ...b, x: b.x + 28, y: b.y + 28 }, maximized: false } : undefined, true)
  })

  ipcMain.handle('settings:load', () => readSettings())
  // 界面语言要在页面脚本执行前就知道（界面是启动时一次性搭好的），所以用同步消息
  ipcMain.on('app:locale', (e) => (e.returnValue = getSavedLocale()))
  ipcMain.handle('settings:save', async (_e, s: Settings) => {
    await fs.mkdir(path.dirname(settingsFile()), { recursive: true })
    const tmp = settingsFile() + '.tmp'
    await fs.writeFile(tmp, JSON.stringify(s, null, 2), 'utf8')
    await fs.rename(tmp, settingsFile())
    setMainLocale(s?.locale)
  })

  registerFsIpc()
  registerGitIpc()
  registerSearchIpc()
  registerTerminalIpc()
  registerLspIpc()
  registerAccountIpc()
  registerAppInfoIpc()
  registerPluginIpc()
  registerMarketIpc()
  registerDebugIpc()
  registerJupyterIpc()
  registerAgentIpc()
  registerSysmonIpc()
  registerIdeIpc()
}

Menu.setApplicationMenu(null)
registerPluginScheme()

app.whenReady().then(() => {
  app.setAppUserModelId('studio.infinite.ide')
  registerIpc()
  // 先开 IDE 桥接服务：终端创建时要用到它的端口
  void startIdeServer().finally(() => createWindow())
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
