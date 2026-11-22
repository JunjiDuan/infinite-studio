/**
 * 插件市场：读取仓库 marketplace/registry.json，下载插件包（zip）、校验 sha256、解压安装。
 * 插件页面通过 studio-plugin://<id>/ 协议加载，和 IDE 界面不同源，拿不到 window.api。
 */
import { app, BrowserWindow, dialog, ipcMain, net, protocol } from 'electron'
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { inflateRawSync } from 'node:zlib'
import { MARKET_REPO, type MarketResult, type PluginManifest, type RemotePlugin } from '../shared/plugins'
import { tm } from './i18n'

export const PLUGIN_SCHEME = 'studio-plugin'

const REGISTRY_URLS = [
  // raw 只缓存几分钟，新版本最快能看到；国内访问不稳定时用 jsDelivr 镜像（缓存较久）
  `https://raw.githubusercontent.com/${MARKET_REPO}/main/marketplace/registry.json`,
  `https://cdn.jsdelivr.net/gh/${MARKET_REPO}@main/marketplace/registry.json`
]
const MAX_PACKAGE = 200 * 1024 * 1024
const MAX_UNPACKED = 500 * 1024 * 1024
const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/

const pluginsDir = () => path.join(app.getPath('userData'), 'plugins')
const registryCache = () => path.join(pluginsDir(), '.registry.json')

/* ---------------- 版本 ---------------- */

function parseVer(v: string): number[] {
  return String(v).replace(/^v/, '').split(/[.+-]/).slice(0, 3).map((x) => parseInt(x, 10) || 0)
}

export function compareVersions(a: string, b: string): number {
  const x = parseVer(a)
  const y = parseVer(b)
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0)
  return 0
}

/* ---------------- registry ---------------- */

function validRemote(p: unknown): p is RemotePlugin {
  const r = p as RemotePlugin
  return (
    !!r &&
    typeof r.id === 'string' &&
    ID_RE.test(r.id) &&
    typeof r.name === 'string' &&
    typeof r.version === 'string' &&
    typeof r.sha256 === 'string' &&
    /^[0-9a-f]{64}$/i.test(r.sha256) &&
    Array.isArray(r.urls) &&
    r.urls.every((u) => typeof u === 'string' && /^https:\/\//.test(u))
  )
}

let memo: { at: number; list: RemotePlugin[] } | null = null

/**
 * main 分支最新的提交号。按提交号取文件（raw / jsDelivr）内容永远不变，CDN 缓存不会给出旧列表；
 * 按分支名取时，raw 会缓存几分钟、jsDelivr 会缓存很久，刚发布的插件可能看不到。
 * 拿不到（GitHub API 限流、网络不通）时返回 null，退回按分支名取。
 */
async function latestCommit(): Promise<string | null> {
  try {
    const r = await net.fetch(`https://api.github.com/repos/${MARKET_REPO}/commits/main`, {
      headers: { accept: 'application/vnd.github.sha', 'user-agent': 'InfiniteStudio' },
      signal: AbortSignal.timeout(8000),
      cache: 'no-store'
    })
    if (!r.ok) return null
    const sha = (await r.text()).trim()
    return /^[0-9a-f]{40}$/.test(sha) ? sha : null
  } catch {
    return null
  }
}

/** 分支地址 → 同一文件在某个提交下的地址（raw 的 /main/ 和 jsDelivr 的 @main/） */
function atCommit(url: string, sha: string): string {
  return url.replace(`/${MARKET_REPO}/main/`, `/${MARKET_REPO}/${sha}/`).replace(`/${MARKET_REPO}@main/`, `/${MARKET_REPO}@${sha}/`)
}

async function fetchRegistry(force: boolean): Promise<RemotePlugin[]> {
  if (!force && memo && Date.now() - memo.at < 10 * 60 * 1000) return memo.list
  let lastErr: unknown = null
  const sha = await latestCommit()
  const urls = sha ? [...REGISTRY_URLS.map((u) => atCommit(u, sha)), ...REGISTRY_URLS] : REGISTRY_URLS
  for (const url of urls) {
    try {
      const r = await net.fetch(url + `?t=${Date.now()}`, { signal: AbortSignal.timeout(15000), cache: 'no-store' })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const data = (await r.json()) as { plugins?: unknown[] }
      const list = (data.plugins ?? []).filter(validRemote)
      // 插件包也先按提交号下载：jsDelivr 的 @main 可能还停在旧提交上，新包会 404
      if (sha) for (const p of list) p.urls = [...new Set([...p.urls.map((u) => atCommit(u, sha)), ...p.urls])]
      memo = { at: Date.now(), list }
      await fs.mkdir(pluginsDir(), { recursive: true })
      await fs.writeFile(registryCache(), JSON.stringify(data), 'utf8').catch(() => undefined)
      return list
    } catch (e) {
      lastErr = e
    }
  }
  // 离线时用上次成功获取的列表
  try {
    const data = JSON.parse(await fs.readFile(registryCache(), 'utf8')) as { plugins?: unknown[] }
    return (data.plugins ?? []).filter(validRemote)
  } catch {
    throw new Error(tm('无法连接到插件仓库：{0}', String((lastErr as Error)?.message ?? lastErr)))
  }
}

/* ---------------- 已安装 ---------------- */

function validManifest(m: unknown): m is PluginManifest {
  const x = m as PluginManifest
  if (!x || typeof x.id !== 'string' || !ID_RE.test(x.id) || typeof x.name !== 'string' || typeof x.version !== 'string') return false
  if (x.editor) {
    if (typeof x.editor.entry !== 'string' || !Array.isArray(x.editor.extensions)) return false
    x.editor.extensions = x.editor.extensions.filter((e) => typeof e === 'string' && /^\.[\w.-]+$/.test(e)).map((e) => e.toLowerCase())
  }
  if (x.newFile && (typeof x.newFile.label !== 'string' || typeof x.newFile.extension !== 'string' || !/^\.[\w.-]+$/.test(x.newFile.extension))) delete x.newFile
  x.permissions = Array.isArray(x.permissions) ? x.permissions.filter((p) => p === 'network' || p === 'eval') : []
  x.publisher = String(x.publisher ?? '')
  x.description = String(x.description ?? '')
  x.category = 'productivity'
  return true
}

async function readManifest(dir: string): Promise<PluginManifest | null> {
  try {
    const m = JSON.parse(await fs.readFile(path.join(dir, 'manifest.json'), 'utf8')) as unknown
    return validManifest(m) ? m : null
  } catch {
    return null
  }
}

async function listInstalled(): Promise<PluginManifest[]> {
  const out: PluginManifest[] = []
  const entries = await fs.readdir(pluginsDir(), { withFileTypes: true }).catch(() => [])
  for (const e of entries) {
    if (!e.isDirectory() || !ID_RE.test(e.name)) continue
    const m = await readManifest(path.join(pluginsDir(), e.name))
    if (m && m.id === e.name) out.push(m)
  }
  return out
}

/* ---------------- zip ---------------- */

/** 解压 zip（只支持“存储”和“deflate”，插件打包脚本只产生这两种） */
export function unzip(buf: Buffer): { name: string; data: Buffer }[] {
  let eocd = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error(tm('插件包不是有效的 zip 文件'))
  const count = buf.readUInt16LE(eocd + 10)
  let p = buf.readUInt32LE(eocd + 16)
  const out: { name: string; data: Buffer }[] = []
  let total = 0
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error(tm('插件包不是有效的 zip 文件'))
    const flags = buf.readUInt16LE(p + 8)
    const method = buf.readUInt16LE(p + 10)
    const csize = buf.readUInt32LE(p + 20)
    const usize = buf.readUInt32LE(p + 24)
    const nlen = buf.readUInt16LE(p + 28)
    const elen = buf.readUInt16LE(p + 30)
    const clen = buf.readUInt16LE(p + 32)
    const local = buf.readUInt32LE(p + 42)
    const name = buf.subarray(p + 46, p + 46 + nlen).toString('utf8').replace(/\\/g, '/')
    p += 46 + nlen + elen + clen
    if (flags & 1) throw new Error(tm('插件包不能加密'))
    if (name.endsWith('/')) continue
    total += usize
    if (total > MAX_UNPACKED) throw new Error(tm('插件包解压后太大'))
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28)
    const raw = buf.subarray(start, start + csize)
    const data = method === 0 ? Buffer.from(raw) : method === 8 ? inflateRawSync(raw, { maxOutputLength: usize }) : null
    if (!data) throw new Error(tm('插件包使用了不支持的压缩方式'))
    out.push({ name, data })
  }
  return out
}

/** 文件在包里的相对路径是否安全（不能跳出插件目录） */
function safeRel(name: string): boolean {
  if (!name || name.startsWith('/') || /^[a-zA-Z]:/.test(name)) return false
  return !name.split('/').some((s) => s === '..' || s === '')
}

/* ---------------- 下载安装 ---------------- */

async function download(urls: string[], size: number | undefined, onProgress: (got: number, total: number) => void): Promise<Buffer> {
  let lastErr: unknown = null
  for (const url of urls) {
    try {
      const r = await net.fetch(url, { signal: AbortSignal.timeout(10 * 60 * 1000) })
      if (!r.ok || !r.body) throw new Error(`HTTP ${r.status}`)
      const total = Number(r.headers.get('content-length')) || size || 0
      const reader = r.body.getReader()
      const chunks: Buffer[] = []
      let got = 0
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        got += value.length
        if (got > MAX_PACKAGE) throw new Error(tm('插件包太大'))
        chunks.push(Buffer.from(value))
        onProgress(got, total)
      }
      return Buffer.concat(chunks)
    } catch (e) {
      lastErr = e
    }
  }
  throw new Error(tm('下载失败：{0}', String((lastErr as Error)?.message ?? lastErr)))
}

const installing = new Set<string>()

async function install(id: string, send: (got: number, total: number) => void): Promise<PluginManifest> {
  if (installing.has(id)) throw new Error(tm('正在安装中'))
  installing.add(id)
  try {
    const list = await fetchRegistry(false)
    const r = list.find((p) => p.id === id)
    if (!r) throw new Error(tm('插件仓库里没有 {0}', id))
    if (r.minStudio && compareVersions(app.getVersion(), r.minStudio) < 0) throw new Error(tm('需要 Infinite Studio {0} 或更高版本', r.minStudio))
    const buf = await download(r.urls, r.size, send)
    const sum = createHash('sha256').update(buf).digest('hex')
    if (sum.toLowerCase() !== r.sha256.toLowerCase()) throw new Error(tm('校验失败：插件包和仓库登记的不一致'))

    let files = unzip(buf)
    // 包里多套了一层目录时去掉
    if (!files.some((f) => f.name === 'manifest.json')) {
      const top = files[0]?.name.split('/')[0]
      if (top && files.every((f) => f.name.startsWith(top + '/'))) files = files.map((f) => ({ ...f, name: f.name.slice(top.length + 1) }))
    }
    if (!files.every((f) => safeRel(f.name))) throw new Error(tm('插件包里有不安全的文件路径'))
    const mf = files.find((f) => f.name === 'manifest.json')
    if (!mf) throw new Error(tm('插件包里没有 manifest.json'))
    const manifest = JSON.parse(mf.data.toString('utf8')) as unknown
    if (!validManifest(manifest) || manifest.id !== id) throw new Error(tm('插件包的 manifest.json 无效'))

    const root = pluginsDir()
    const staging = path.join(root, `.staging-${id}-${Date.now()}`)
    const target = path.join(root, id)
    await fs.mkdir(staging, { recursive: true })
    try {
      for (const f of files) {
        const dest = path.join(staging, ...f.name.split('/'))
        await fs.mkdir(path.dirname(dest), { recursive: true })
        await fs.writeFile(dest, f.data)
      }
      await fs.rm(target, { recursive: true, force: true })
      await fs.rename(staging, target)
      permCache.delete(manifest.id)
    } catch (e) {
      await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined)
      throw e
    }
    return manifest
  } finally {
    installing.delete(id)
  }
}

/* ---------------- 插件页面协议 ---------------- */

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wasm': 'application/wasm',
  '.map': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
  '.pfb': 'application/octet-stream',
  '.bcmap': 'application/octet-stream'
}

/**
 * 插件页面只能加载自己包里的资源，不能联网。
 * 页面里可以再嵌一层 iframe（srcdoc / blob / data，例如网页预览），它继承这里的限制。
 * 声明了 network 权限的插件可以加载 http(s) 资源，声明了 eval 的可以用 eval / new Function。
 */
function pluginCsp(perms: readonly string[] = []): string {
  const net = perms.includes('network') ? ' https: http:' : ''
  const evl = perms.includes('eval') ? " 'unsafe-eval'" : ''
  return [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'${evl} blob: data:${net}`,
    `style-src 'self' 'unsafe-inline' data: blob:${net}`,
    `img-src 'self' data: blob:${net}`,
    `font-src 'self' data: blob:${net}`,
    `media-src 'self' data: blob:${net}`,
    `connect-src 'self' data: blob:${net}`,
    "worker-src 'self' blob: data:",
    `frame-src 'self' blob: data:${net}`,
    "object-src 'none'",
    "form-action 'none'"
  ].join('; ')
}

/** 插件 id → 权限（页面请求时按 manifest 计算 CSP；安装 / 卸载后清掉） */
const permCache = new Map<string, string[]>()

async function pluginPerms(id: string): Promise<string[]> {
  let p = permCache.get(id)
  if (!p) {
    p = (await readManifest(path.join(pluginsDir(), id)))?.permissions ?? []
    permCache.set(id, p)
  }
  return p
}

/** 必须在 app ready 之前调用 */
export function registerPluginScheme(): void {
  protocol.registerSchemesAsPrivileged([{ scheme: PLUGIN_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }])
}

function serve(): void {
  protocol.handle(PLUGIN_SCHEME, async (req) => {
    try {
      const url = new URL(req.url)
      const id = url.hostname
      const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html'
      if (!ID_RE.test(id) || !safeRel(rel)) return new Response('Bad request', { status: 400 })
      const base = path.join(pluginsDir(), id)
      const file = path.join(base, ...rel.split('/'))
      if (!file.startsWith(base + path.sep)) return new Response('Forbidden', { status: 403 })
      const data = await fs.readFile(file)
      return new Response(data, {
        headers: {
          'content-type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
          'content-security-policy': pluginCsp(await pluginPerms(id)),
          'cache-control': 'no-cache'
        }
      })
    } catch {
      return new Response('Not found', { status: 404 })
    }
  })
}

/* ---------------- IPC ---------------- */

async function wrap<T>(fn: () => Promise<T>): Promise<MarketResult<T>> {
  try {
    return { ok: true, value: await fn() }
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message ?? e) }
  }
}

export function registerMarketIpc(): void {
  serve()
  ipcMain.handle('market:registry', (_e, force: boolean) => wrap(() => fetchRegistry(!!force)))
  ipcMain.handle('market:installed', () => listInstalled())
  ipcMain.handle('market:install', (e, id: string) =>
    wrap(() =>
      install(String(id), (got, total) => {
        if (!e.sender.isDestroyed()) e.sender.send('market:progress', id, got, total)
      })
    )
  )
  ipcMain.handle('market:uninstall', (_e, id: string) =>
    wrap(async () => {
      if (!ID_RE.test(String(id))) throw new Error(tm('未知插件：{0}', id))
      await fs.rm(path.join(pluginsDir(), id), { recursive: true, force: true })
      permCache.delete(id)
    })
  )
  // 插件页面导出文件（PNG、Markdown 等）：弹出另存为对话框
  ipcMain.handle('market:exportFile', async (e, name: string, data: Uint8Array | string) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const safe = path.basename(String(name || 'export')).replace(/[<>:"|?*]/g, '_')
    const opts = { defaultPath: path.join(app.getPath('documents'), safe) }
    const r = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
    if (r.canceled || !r.filePath) return null
    await fs.writeFile(r.filePath, typeof data === 'string' ? data : Buffer.from(data))
    return r.filePath
  })
}
