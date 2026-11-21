import { BrowserWindow, dialog, ipcMain, shell, type WebContents } from 'electron'
import { promises as fs, watch, type FSWatcher } from 'node:fs'
import path from 'node:path'
import type { BinaryResult, DirEntry, ReadResult } from '../shared/types'
import { tm } from './i18n'

export const MAX_FILE_BYTES = 5 * 1024 * 1024
/** 预览（PDF、Office、图片、音视频）一次读入内存的上限 */
const MAX_BINARY_BYTES = 300 * 1024 * 1024
/** “用默认应用打开”不允许直接运行的类型，避免误点就执行了程序或脚本 */
const RUNNABLE = /\.(exe|com|bat|cmd|msi|msp|scr|pif|cpl|ps1|psm1|vbs|vbe|js|jse|wsf|wsh|hta|lnk|reg|jar|app|sh|command)$/i
const MAX_LIST = 20000
export const IGNORED = new Set(['.git', 'node_modules', 'dist', 'out', 'release', 'target', '.next', '.venv', 'venv', '__pycache__', '.idea', '.vs'])

/** 路径中是否包含被忽略的目录 */
export function isIgnored(p: string): boolean {
  return p.split(/[\\/]/).some((seg) => IGNORED.has(seg))
}

function senderWindow(e: Electron.IpcMainInvokeEvent): BrowserWindow | null {
  return BrowserWindow.fromWebContents(e.sender)
}

/** 新名字只能是单个文件名，不能借机写到别的目录 */
function assertName(name: string): void {
  if (!name || name === '.' || name === '..' || /[\\/:*?"<>|]/.test(name)) throw new Error(tm('非法文件名：{0}', name))
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

/* ---------- 文件监听：每个窗口一个递归 watcher ---------- */

const watchers = new Map<number, { watcher: FSWatcher; timer?: ReturnType<typeof setTimeout>; pending: Set<string> }>()

function stopWatch(wc: WebContents): void {
  const w = watchers.get(wc.id)
  if (!w) return
  clearTimeout(w.timer)
  w.watcher.close()
  watchers.delete(wc.id)
}

function startWatch(wc: WebContents, root: string): void {
  stopWatch(wc)
  let watcher: FSWatcher
  try {
    watcher = watch(root, { recursive: true })
  } catch (err) {
    console.warn('无法监听文件夹', root, err)
    return
  }
  const entry = { watcher, pending: new Set<string>(), timer: undefined as ReturnType<typeof setTimeout> | undefined }
  watcher.on('change', (_event, filename) => {
    if (!filename) return
    const rel = filename.toString()
    // .git 里只关心分支 / 提交指针（切分支、提交、拉取）和暂存区（终端里 git add）的变化，用于刷新源代码管理
    if (isIgnored(rel) && !/^\.git[\\/](HEAD|index|MERGE_HEAD|packed-refs|refs[\\/].+)$/.test(rel)) return
    entry.pending.add(path.join(root, rel))
    clearTimeout(entry.timer)
    entry.timer = setTimeout(() => {
      const paths = [...entry.pending]
      entry.pending.clear()
      if (!wc.isDestroyed()) wc.send('fs:changed', paths)
    }, 120)
  })
  watcher.on('error', (err) => console.warn('文件监听出错', err))
  watchers.set(wc.id, entry)
  wc.once('destroyed', () => stopWatch(wc))
}

export function registerFsIpc(): void {
  ipcMain.handle('fs:openFolderDialog', async (e) => {
    const w = senderWindow(e)
    const opts: Electron.OpenDialogOptions = { title: tm('打开文件夹'), properties: ['openDirectory'] }
    const r = w ? await dialog.showOpenDialog(w, opts) : await dialog.showOpenDialog(opts)
    return r.canceled || r.filePaths.length === 0 ? null : r.filePaths[0]
  })

  ipcMain.handle('fs:readDir', async (_e, dir: string): Promise<DirEntry[]> => {
    const items = await fs.readdir(dir, { withFileTypes: true })
    return items
      .filter((d) => d.name !== '.git')
      .map((d) => ({ name: d.name, path: path.join(dir, d.name), isDir: d.isDirectory() }))
      .sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name, 'zh-CN') : a.isDir ? -1 : 1))
  })

  ipcMain.handle('fs:readFile', async (_e, file: string): Promise<ReadResult> => {
    try {
      const stat = await fs.stat(file)
      if (stat.size > MAX_FILE_BYTES) return { ok: false, reason: 'too-large' }
      const buf = await fs.readFile(file)
      if (buf.subarray(0, 8000).includes(0)) return { ok: false, reason: 'binary' }
      let text = buf.toString('utf8')
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
      return { ok: true, content: text }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      return { ok: false, reason: code === 'ENOENT' ? 'missing' : 'error', message: String(err) }
    }
  })

  ipcMain.handle('fs:readBinary', async (_e, file: string): Promise<BinaryResult> => {
    try {
      const stat = await fs.stat(file)
      if (stat.size > MAX_BINARY_BYTES) return { ok: false, reason: 'too-large', size: stat.size }
      const buf = await fs.readFile(file)
      return { ok: true, data: buf, size: stat.size }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      return { ok: false, reason: code === 'ENOENT' ? 'missing' : 'error', message: String(err) }
    }
  })

  ipcMain.handle('fs:openPath', async (_e, p: string): Promise<string> => {
    if (RUNNABLE.test(p)) return tm('出于安全考虑，不直接运行可执行文件或脚本')
    // 返回空字符串表示成功，否则是错误信息
    return shell.openPath(p)
  })

  ipcMain.handle('fs:writeFile', async (_e, file: string, content: string) => {
    await fs.writeFile(file, content, 'utf8')
  })

  ipcMain.handle('fs:listFiles', async (_e, root: string): Promise<string[]> => {
    const out: string[] = []
    const queue = [root]
    while (queue.length && out.length < MAX_LIST) {
      const dir = queue.shift()!
      let items
      try {
        items = await fs.readdir(dir, { withFileTypes: true })
      } catch {
        continue
      }
      for (const d of items) {
        if (IGNORED.has(d.name)) continue
        const p = path.join(dir, d.name)
        if (d.isDirectory()) queue.push(p)
        else if (d.isFile()) out.push(p)
        if (out.length >= MAX_LIST) break
      }
    }
    return out
  })

  ipcMain.handle('fs:gitBranch', async (_e, root: string) => {
    try {
      const head = (await fs.readFile(path.join(root, '.git', 'HEAD'), 'utf8')).trim()
      const m = head.match(/^ref: refs\/heads\/(.+)$/)
      return m ? m[1] : head.slice(0, 7)
    } catch {
      return null
    }
  })

  ipcMain.handle('fs:createFile', async (_e, dir: string, name: string) => {
    assertName(name)
    const p = path.join(dir, name)
    await fs.writeFile(p, '', { flag: 'wx' })
    return p
  })

  ipcMain.handle('fs:createDir', async (_e, dir: string, name: string) => {
    assertName(name)
    const p = path.join(dir, name)
    await fs.mkdir(p)
    return p
  })

  ipcMain.handle('fs:rename', async (_e, from: string, newName: string) => {
    assertName(newName)
    const to = path.join(path.dirname(from), newName)
    // 只改大小写时目标“存在”其实是同一个文件，允许
    if (to.toLowerCase() !== from.toLowerCase() && (await exists(to))) throw new Error(tm('已存在同名文件：{0}', newName))
    await fs.rename(from, to)
    return to
  })

  // 删除一律进回收站，可以找回
  ipcMain.handle('fs:trash', async (_e, p: string) => {
    await shell.trashItem(p)
  })

  ipcMain.handle('fs:reveal', (_e, p: string) => {
    shell.showItemInFolder(p)
  })

  ipcMain.handle('fs:watch', (e, root: string | null) => {
    if (root) startWatch(e.sender, root)
    else stopWatch(e.sender)
  })
}
