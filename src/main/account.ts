import { app, ipcMain, safeStorage, shell } from 'electron'
import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { Account, DeviceCode } from '../shared/types'

/**
 * GitHub OAuth App 的 Client ID（需在 GitHub → Settings → Developer settings → OAuth Apps
 * 注册并勾选 “Enable Device Flow”）。留空时只能用 GitHub CLI 或访问令牌登录。
 * 也可以用环境变量 INFINITE_GITHUB_CLIENT_ID 覆盖。
 */
const GITHUB_CLIENT_ID = ''
const clientId = () => process.env['INFINITE_GITHUB_CLIENT_ID'] || GITHUB_CLIENT_ID

interface Stored {
  account: Account
  /** safeStorage 加密后的 token（base64） */
  token: string
}

const file = () => path.join(app.getPath('userData'), 'account.json')
const UA = { 'User-Agent': 'InfiniteStudio', Accept: 'application/vnd.github+json' }

async function readStored(): Promise<Stored | null> {
  try {
    return JSON.parse(await fs.readFile(file(), 'utf8')) as Stored
  } catch {
    return null
  }
}

/** 头像转成 data URL，页面 CSP 不用放开外链，离线也能显示 */
async function avatarData(url: string): Promise<string | undefined> {
  try {
    const r = await fetch(url + (url.includes('?') ? '&' : '?') + 's=96')
    if (!r.ok) return undefined
    const type = r.headers.get('content-type') ?? 'image/png'
    return `data:${type};base64,${Buffer.from(await r.arrayBuffer()).toString('base64')}`
  } catch {
    return undefined
  }
}

/** 用 token 取用户资料并保存 */
async function signIn(token: string): Promise<Account> {
  token = token.trim()
  if (!token) throw new Error('令牌为空')
  const r = await fetch('https://api.github.com/user', { headers: { ...UA, Authorization: `Bearer ${token}` } })
  if (r.status === 401) throw new Error('令牌无效或已过期')
  if (!r.ok) throw new Error(`GitHub 返回 ${r.status}`)
  const u = (await r.json()) as { login: string; name: string | null; avatar_url: string; html_url: string }
  const account: Account = {
    provider: 'github',
    login: u.login,
    name: u.name ?? u.login,
    url: u.html_url,
    avatar: await avatarData(u.avatar_url)
  }
  if (!safeStorage.isEncryptionAvailable()) throw new Error('系统密钥存储不可用，无法安全保存登录信息')
  const stored: Stored = { account, token: safeStorage.encryptString(token).toString('base64') }
  await fs.mkdir(path.dirname(file()), { recursive: true })
  await fs.writeFile(file(), JSON.stringify(stored), 'utf8')
  return account
}

function ghToken(): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('gh', ['auth', 'token'], { timeout: 8000, windowsHide: true }, (err, stdout) => {
      if (err) {
        const missing = (err as NodeJS.ErrnoException).code === 'ENOENT'
        reject(new Error(missing ? '未找到 GitHub CLI（gh）' : 'GitHub CLI 尚未登录，请先运行 gh auth login'))
      } else resolve(stdout.trim())
    })
  })
}

async function post<T>(url: string, body: Record<string, string>): Promise<T> {
  const r = await fetch(url, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString()
  })
  if (!r.ok) throw new Error(`GitHub 返回 ${r.status}`)
  return (await r.json()) as T
}

/* ---------- Device Flow ---------- */

let pending: { device: string; interval: number; expires: number; cancelled: boolean } | null = null

async function deviceStart(): Promise<DeviceCode> {
  const id = clientId()
  if (!id) throw new Error('未配置 GitHub OAuth Client ID')
  const r = await post<{ device_code: string; user_code: string; verification_uri: string; interval: number; expires_in: number; error_description?: string }>(
    'https://github.com/login/device/code',
    { client_id: id, scope: 'read:user' }
  )
  if (!r.device_code) throw new Error(r.error_description ?? '无法发起登录')
  if (pending) pending.cancelled = true
  pending = { device: r.device_code, interval: r.interval, expires: Date.now() + r.expires_in * 1000, cancelled: false }
  shell.openExternal(r.verification_uri)
  return { userCode: r.user_code, url: r.verification_uri }
}

async function devicePoll(): Promise<Account | null> {
  const p = pending
  if (!p) throw new Error('没有进行中的登录')
  while (!p.cancelled) {
    if (Date.now() > p.expires) throw new Error('验证码已过期，请重试')
    await new Promise((res) => setTimeout(res, p.interval * 1000))
    if (p.cancelled) break
    const r = await post<{ access_token?: string; error?: string; interval?: number; error_description?: string }>(
      'https://github.com/login/oauth/access_token',
      { client_id: clientId(), device_code: p.device, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' }
    )
    if (r.access_token) {
      pending = null
      return signIn(r.access_token)
    }
    if (r.error === 'slow_down') p.interval = r.interval ?? p.interval + 5
    else if (r.error !== 'authorization_pending') throw new Error(r.error_description ?? r.error ?? '登录失败')
  }
  return null
}

export function registerAccountIpc(): void {
  ipcMain.handle('account:get', async () => (await readStored())?.account ?? null)
  ipcMain.handle('account:hasDeviceFlow', () => !!clientId())
  ipcMain.handle('account:loginToken', (_e, token: string) => signIn(token))
  ipcMain.handle('account:loginGh', async () => signIn(await ghToken()))
  ipcMain.handle('account:deviceStart', () => deviceStart())
  ipcMain.handle('account:devicePoll', () => devicePoll())
  ipcMain.handle('account:deviceCancel', () => {
    if (pending) pending.cancelled = true
    pending = null
  })
  ipcMain.handle('account:logout', async () => {
    await fs.rm(file(), { force: true })
  })
}
