import { app, BrowserWindow, dialog, ipcMain, shell, type WebContents } from 'electron'
import { promises as fs, watch, type FSWatcher } from 'node:fs'
import path from 'node:path'
import type { BinaryResult, DirEntry, ReadResult, TextEncodingInfo } from '../shared/types'
import { tm } from './i18n'
import { decodeText, encodeText } from './textCodec'

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

/** 两个路径是否指向磁盘上的同一个文件 */
async function sameFile(a: string, b: string): Promise<boolean> {
  try {
    const [x, y] = await Promise.all([fs.stat(a, { bigint: true }), fs.stat(b, { bigint: true })])
    return x.dev === y.dev && x.ino === y.ino
  } catch {
    return false
  }
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

const watchers = new Map<number, { watcher: FSWatcher; timer?: ReturnType<typeof setTimeout>; pending: Set<string>; onDestroyed: () => void }>()

function stopWatch(wc: WebContents): void {
  const w = watchers.get(wc.id)
  if (!w) return
  clearTimeout(w.timer)
  w.watcher.close()
  watchers.delete(wc.id)
  // 每次换文件夹都会重新监听：把上一次挂的 destroyed 回调摘掉，免得越积越多
  if (!wc.isDestroyed()) wc.off('destroyed', w.onDestroyed)
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
  const entry = { watcher, pending: new Set<string>(), timer: undefined as ReturnType<typeof setTimeout> | undefined, onDestroyed: () => stopWatch(wc) }
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
  wc.once('destroyed', entry.onDestroyed)
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
      // 识别 UTF-8 / UTF-8 BOM / GBK，保存时按原编码写回
      const d = decodeText(buf)
      return { ok: true, content: d.text, encoding: d.encoding, bom: d.bom, ...(d.lossy ? { lossy: true } : {}) }
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

  ipcMain.handle('fs:writeFile', async (_e, file: string, content: string, enc?: TextEncodingInfo) => {
    // 先编码再写：GBK 表示不了的字符会在这里报错，原文件保持不变
    await fs.writeFile(file, encodeText(String(content), { encoding: enc?.encoding, bom: !!enc?.bom }))
  })

  ipcMain.handle('fs:writeBinary', async (_e, file: string, data: Uint8Array) => {
    await fs.writeFile(file, Buffer.from(data))
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
    // 目标已存在时只允许它就是源文件本身（不区分大小写的文件系统上只改大小写）；
    // 区分大小写的文件系统上 a 和 A 是两个文件，rename 会直接覆盖掉 A
    if (to !== from && (await exists(to)) && !(await sameFile(from, to))) throw new Error(tm('已存在同名文件：{0}', newName))
    await fs.rename(from, to)
    return to
  })

  // 文件在磁盘上的身份（卷号 + 文件号），不存在时为 null。
  // 改名 / 移动不会改变它：外部程序（资源管理器、终端、AI 助手）改了名，界面靠它认出新路径
  ipcMain.handle('fs:fileIds', async (_e, paths: string[]): Promise<(string | null)[]> =>
    Promise.all(
      (Array.isArray(paths) ? paths : []).slice(0, 500).map(async (p) => {
        try {
          const s = await fs.stat(String(p), { bigint: true })
          return s.isFile() ? `${s.dev}:${s.ino}` : null
        } catch {
          return null
        }
      })
    )
  )

  // 另存为 / 导出：系统保存对话框，返回选中的路径（取消为 null）
  ipcMain.handle('fs:saveDialog', async (e, opts: { defaultPath?: string; title?: string; filters?: { name: string; extensions: string[] }[] }) => {
    const w = senderWindow(e)
    const o: Electron.SaveDialogOptions = {
      title: opts?.title ? String(opts.title) : undefined,
      defaultPath: opts?.defaultPath ? String(opts.defaultPath) : undefined,
      filters: Array.isArray(opts?.filters) ? opts.filters : undefined
    }
    const r = w ? await dialog.showSaveDialog(w, o) : await dialog.showSaveDialog(o)
    return r.canceled || !r.filePath ? null : r.filePath
  })

  // 把一份完整的 HTML 排版成 PDF（Notebook 导出用）：隐藏窗口里加载，用 Chromium 的打印引擎输出
  ipcMain.handle('fs:htmlToPdf', async (_e, html: string, out: string, opts?: { landscape?: boolean }) => {
    const tmp = path.join(app.getPath('temp'), `infinite-studio-export-${process.pid}-${Date.now()}.html`)
    await fs.writeFile(tmp, String(html), 'utf8')
    // 不执行页面脚本、不给 Node：导出的内容来自 Notebook 输出，不可信
    const win = new BrowserWindow({ show: false, width: 1000, height: 1400, webPreferences: { sandbox: true, javascript: false, contextIsolation: true, nodeIntegration: false } })
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    win.webContents.on('will-navigate', (ev) => ev.preventDefault())
    try {
      await win.loadFile(tmp)
      // 等图片解码完（data: 图片很快，远程图片最多等几秒）
      await new Promise((r) => setTimeout(r, 300))
      const pdf = await win.webContents.printToPDF({ printBackground: true, pageSize: 'A4', landscape: !!opts?.landscape, margins: { top: 0.6, bottom: 0.6, left: 0.6, right: 0.6 },generateDocumentOutline: true })
      await fs.writeFile(out, pdf)
    } finally {
      win.destroy()
      await fs.rm(tmp, { force: true }).catch(() => undefined)
    }
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
