import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from 'electron'
import { existsSync, promises as fs } from 'node:fs'
import path from 'node:path'
import type { Settings, Space } from '../shared/types'
import { registerFsIpc } from './fsService'
import { registerSearchIpc } from './search'

const settingsFile = () => path.join(app.getPath('userData'), 'settings.json')

function themeBg(theme: string | undefined): string {
  return theme === 'paper' ? '#F7F5F0' : theme === 'dusk' ? '#16151B' : '#0E0E10'
}

async function readSettings(): Promise<Settings | null> {
  try {
    return JSON.parse(await fs.readFile(settingsFile(), 'utf8')) as Settings
  } catch {
    return null
  }
}

async function createWindow(): Promise<void> {
  const settings = await readSettings()
  // 开发时用仓库里的图标；打包后图标已嵌进 exe
  const devIcon = path.join(app.getAppPath(), 'build', 'icon.png')
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
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

  win.once('ready-to-show', () => win.show())

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
    const devtools = input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i')
    if (devtools) win.webContents.toggleDevTools()
    if (!app.isPackaged && input.control && input.shift && input.key.toLowerCase() === 'r') win.webContents.reload()
  })

  if (!app.isPackaged && process.env['ELECTRON_RENDERER_URL']) {
    await win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    await win.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
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

  ipcMain.handle('settings:load', () => readSettings())
  ipcMain.handle('settings:save', async (_e, s: Settings) => {
    await fs.mkdir(path.dirname(settingsFile()), { recursive: true })
    const tmp = settingsFile() + '.tmp'
    await fs.writeFile(tmp, JSON.stringify(s, null, 2), 'utf8')
    await fs.rename(tmp, settingsFile())
  })

  ipcMain.handle('space:export', async (e, space: Space) => {
    const w = senderWindow(e)
    const opts: Electron.SaveDialogOptions = {
      title: '导出空间',
      defaultPath: `${space.name || 'space'}.infinite-space`,
      filters: [{ name: '无界空间', extensions: ['infinite-space'] }]
    }
    const r = w ? await dialog.showSaveDialog(w, opts) : await dialog.showSaveDialog(opts)
    if (r.canceled || !r.filePath) return false
    await fs.writeFile(r.filePath, JSON.stringify({ format: 'infinite-space@1', space }, null, 2), 'utf8')
    return true
  })

  ipcMain.handle('space:import', async (e) => {
    const w = senderWindow(e)
    const opts: Electron.OpenDialogOptions = {
      title: '导入空间',
      properties: ['openFile'],
      filters: [{ name: '无界空间', extensions: ['infinite-space', 'json'] }]
    }
    const r = w ? await dialog.showOpenDialog(w, opts) : await dialog.showOpenDialog(opts)
    if (r.canceled || !r.filePaths[0]) return null
    try {
      const data = JSON.parse(await fs.readFile(r.filePaths[0], 'utf8'))
      return (data.space ?? data) as Space
    } catch {
      return null
    }
  })

  registerFsIpc()
  registerSearchIpc()
}

Menu.setApplicationMenu(null)

app.whenReady().then(() => {
  app.setAppUserModelId('studio.infinite.ide')
  registerIpc()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
