import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { ipcMain } from 'electron'
import type { GitChange, GitCommit, GitLog } from '../shared/types'

/** 在 root 下运行 git，返回 stdout */
function git(root: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', ['-c', 'core.quotepath=false', '-c', 'log.showSignature=false', ...args], { cwd: root, maxBuffer: 32 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      if (err) reject(Object.assign(err, { stderr: String(stderr) }))
      else resolve(stdout)
    })
  })
}

const FS = '\x1f'
const RS = '\x1e'

export function registerGitIpc(): void {
  ipcMain.handle('git:log', async (_e, root: string, limit: number): Promise<GitLog> => {
    // 目录不存在时 execFile 也报 ENOENT，先排除掉，免得误报“没装 git”
    if (!existsSync(root)) return { ok: false, reason: 'error', message: `找不到文件夹 ${root}` }
    try {
      await git(root, ['rev-parse', '--is-inside-work-tree'])
    } catch (e) {
      const msg = String((e as { stderr?: string }).stderr ?? '')
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { ok: false, reason: 'no-git' }
      return { ok: false, reason: 'not-repo', message: msg.trim() }
    }
    try {
      const n = Math.max(1, Math.min(5000, limit | 0))
      const out = await git(root, ['log', '--all', '--date-order', `-n${n}`, `--format=%H${FS}%P${FS}%an${FS}%ae${FS}%at${FS}%D${FS}%s${RS}`])
      const commits: GitCommit[] = out
        .split(RS)
        .map((r) => r.replace(/^\s+/, ''))
        .filter(Boolean)
        .map((r) => {
          const [hash, parents, author, email, time, refs, subject] = r.split(FS)
          return {
            hash,
            parents: parents ? parents.split(' ') : [],
            author,
            email,
            time: Number(time) * 1000,
            refs: refs ? refs.split(', ').filter(Boolean) : [],
            subject: subject ?? ''
          }
        })
      return { ok: true, commits }
    } catch (e) {
      // 空仓库（还没有提交）时 git log 会报错
      const msg = String((e as { stderr?: string }).stderr ?? '')
      if (/does not have any commits|bad default revision/i.test(msg)) return { ok: true, commits: [] }
      return { ok: false, reason: 'error', message: msg.trim() || String(e) }
    }
  })

  ipcMain.handle('git:changes', async (_e, root: string, hash: string): Promise<GitChange[]> => {
    if (!/^[0-9a-f]{7,40}$/i.test(hash)) throw new Error('无效的提交')
    const out = await git(root, ['show', '--name-status', '--format=', '-M', '--first-parent', hash])
    return out
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [status, ...paths] = line.split('\t')
        return { status: status[0], path: paths[paths.length - 1], from: paths.length > 1 ? paths[0] : undefined }
      })
  })
}
