import { app, ipcMain } from 'electron'
import os from 'node:os'
import type { AppInfo, UpdateResult } from '../shared/types'

const REPO = 'JunjiDuan/infinite-studio'
const RELEASES_URL = `https://github.com/${REPO}/releases`

/** 1.2.3 / v1.2.3-beta → [1,2,3]；比较只看主次修订号 */
function parseVersion(v: string): number[] {
  return v
    .replace(/^v/i, '')
    .split(/[-+]/)[0]
    .split('.')
    .map((x) => parseInt(x, 10) || 0)
}

function newer(a: string, b: string): boolean {
  const x = parseVersion(a)
  const y = parseVersion(b)
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0)
    if (d) return d > 0
  }
  return false
}

export function registerAppInfoIpc(): void {
  ipcMain.handle(
    'app:info',
    (): AppInfo => ({
      name: app.getName(),
      version: app.getVersion(),
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      v8: process.versions.v8,
      os: `${os.type()} ${os.release()} ${os.arch()}`,
      homepage: `https://github.com/${REPO}`
    })
  )

  // 只请求 GitHub 公开的 Releases 接口，不附带任何账户或设备信息
  ipcMain.handle('app:checkUpdate', async (): Promise<UpdateResult> => {
    const current = app.getVersion()
    try {
      const r = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
        headers: { 'User-Agent': 'InfiniteStudio', Accept: 'application/vnd.github+json' },
        signal: AbortSignal.timeout(10000)
      })
      if (r.status === 404) return { status: 'none', current, url: RELEASES_URL }
      if (!r.ok) return { status: 'error', current, message: `HTTP ${r.status}` }
      const j = (await r.json()) as { tag_name?: string; html_url?: string; name?: string; body?: string; published_at?: string }
      const latest = String(j.tag_name ?? '').replace(/^v/i, '')
      if (!latest) return { status: 'none', current, url: RELEASES_URL }
      return {
        status: newer(latest, current) ? 'available' : 'latest',
        current,
        latest,
        url: j.html_url || RELEASES_URL,
        notes: typeof j.body === 'string' ? j.body.slice(0, 4000) : undefined,
        date: j.published_at
      }
    } catch (err) {
      return { status: 'error', current, message: String((err as Error)?.message ?? err) }
    }
  })
}
