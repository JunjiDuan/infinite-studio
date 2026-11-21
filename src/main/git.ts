import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { ipcMain, shell } from 'electron'
import type { GitBranch, GitChange, GitCommit, GitFile, GitLog, GitOp, GitStatus } from '../shared/types'
import { tm } from './i18n'

/** 在 root 下运行 git，返回 stdout */
function git(root: string, args: string[], opts: { timeout?: number } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['-c', 'core.quotepath=false', '-c', 'log.showSignature=false', '-c', 'color.ui=false', ...args],
      {
        cwd: root,
        maxBuffer: 64 * 1024 * 1024,
        windowsHide: true,
        timeout: opts.timeout ?? 0,
        // 路径按字面匹配（文件名里有 * ? [ 时不当通配符）；网络操作不在后台等终端输入
        env: { ...process.env, GIT_LITERAL_PATHSPECS: '1', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' }
      },
      (err, stdout, stderr) => {
        if (err) reject(Object.assign(err, { stderr: String(stderr) }))
        else resolve(stdout)
      }
    )
  })
}

/** 把 git 的错误整理成一句话给界面显示 */
function gitError(e: unknown): Error {
  const err = e as NodeJS.ErrnoException & { stderr?: string }
  const msg = (err.stderr ?? '').trim() || err.message || String(e)
  // 去掉 hint: 开头的提示行，保留真正的错误
  const lines = msg.split(/\r?\n/).filter((l) => l.trim() && !/^hint:/i.test(l))
  return new Error(lines.slice(-6).join('\n') || msg)
}

const FS = '\x1f'
const RS = '\x1e'

/** 路径太多时分批，避免 Windows 命令行超长 */
async function inChunks(root: string, base: string[], paths: string[]): Promise<void> {
  for (let i = 0; i < paths.length; i += 80) await git(root, [...base, '--', ...paths.slice(i, i + 80)])
}

function checkPaths(paths: unknown): string[] {
  if (!Array.isArray(paths) || !paths.every((p) => typeof p === 'string' && p && !p.startsWith('-'))) throw new Error('invalid paths')
  return paths as string[]
}

async function hasCommits(root: string): Promise<boolean> {
  try {
    await git(root, ['rev-parse', '--verify', '-q', 'HEAD'])
    return true
  } catch {
    return false
  }
}

/** 解析 git status --porcelain=v2 -z --branch */
function parseStatus(out: string): Omit<Extract<GitStatus, { ok: true }>, 'ok' | 'hasCommits'> {
  const res = { branch: null as string | null, detached: false, upstream: null as string | null, ahead: 0, behind: 0, staged: [] as GitFile[], changes: [] as GitFile[], conflicts: [] as GitFile[] }
  const parts = out.split('\0')
  for (let i = 0; i < parts.length; i++) {
    const line = parts[i]
    if (!line) continue
    const kind = line[0]
    if (kind === '#') {
      const [, key, ...rest] = line.split(' ')
      const val = rest.join(' ')
      if (key === 'branch.head') {
        if (val === '(detached)') res.detached = true
        else res.branch = val
      } else if (key === 'branch.upstream') res.upstream = val
      else if (key === 'branch.ab') {
        const m = /\+(\d+) -(\d+)/.exec(val)
        if (m) {
          res.ahead = Number(m[1])
          res.behind = Number(m[2])
        }
      }
    } else if (kind === '1' || kind === '2') {
      const f = line.split(' ')
      const xy = f[1]
      // 1 XY sub mH mI mW hH hI path；2 XY sub mH mI mW hH hI Xscore path\0origPath
      const p = f.slice(kind === '1' ? 8 : 9).join(' ')
      const from = kind === '2' ? parts[++i] : undefined
      if (xy[0] !== '.') res.staged.push({ path: p, status: xy[0], from: xy[0] === 'R' || xy[0] === 'C' ? from : undefined })
      if (xy[1] !== '.') res.changes.push({ path: p, status: xy[1] })
    } else if (kind === 'u') {
      res.conflicts.push({ path: line.split(' ').slice(10).join(' '), status: '!' })
    } else if (kind === '?') {
      res.changes.push({ path: line.slice(2), status: 'U' })
    }
  }
  const byPath = (a: GitFile, b: GitFile) => a.path.localeCompare(b.path)
  res.staged.sort(byPath)
  res.changes.sort(byPath)
  res.conflicts.sort(byPath)
  return res
}

async function currentRemote(root: string): Promise<string | null> {
  const out = await git(root, ['remote'])
  const remotes = out.split(/\r?\n/).filter(Boolean)
  return remotes.includes('origin') ? 'origin' : (remotes[0] ?? null)
}

async function runOp(root: string, op: GitOp): Promise<void> {
  const NET = { timeout: 5 * 60_000 }
  switch (op) {
    case 'fetch':
      await git(root, ['fetch', '--all', '--prune'], NET)
      return
    case 'pull':
      await git(root, ['pull'], NET)
      return
    case 'push': {
      const st = parseStatus(await git(root, ['status', '--porcelain=v2', '-z', '--branch', '--untracked-files=no']))
      if (st.upstream) await git(root, ['push'], NET)
      else {
        if (!st.branch) throw new Error(tm('当前不在任何分支上'))
        const remote = await currentRemote(root)
        if (!remote) throw new Error(tm('仓库没有配置远程仓库'))
        await git(root, ['push', '-u', remote, st.branch], NET)
      }
      return
    }
    case 'sync':
      await git(root, ['pull'], NET)
      await runOp(root, 'push')
      return
    case 'undoCommit':
      await git(root, ['reset', '--soft', 'HEAD~1'])
      return
    case 'stash':
      await git(root, ['stash', 'push', '--include-untracked'])
      return
    case 'stashPop':
      await git(root, ['stash', 'pop'])
      return
  }
}

export function registerGitIpc(): void {
  ipcMain.handle('git:log', async (_e, root: string, limit: number): Promise<GitLog> => {
    // 目录不存在时 execFile 也报 ENOENT，先排除掉，免得误报“没装 git”
    if (!existsSync(root)) return { ok: false, reason: 'error', message: tm('找不到文件夹 {0}', root) }
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
    if (!/^[0-9a-f]{7,40}$/i.test(hash)) throw new Error(tm('无效的提交'))
    const out = await git(root, ['show', '--name-status', '--format=', '-M', '--first-parent', hash])
    return out
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [status, ...paths] = line.split('\t')
        return { status: status[0], path: paths[paths.length - 1], from: paths.length > 1 ? paths[0] : undefined }
      })
  })

  ipcMain.handle('git:status', async (_e, root: string): Promise<GitStatus> => {
    if (!existsSync(root)) return { ok: false, reason: 'error', message: tm('找不到文件夹 {0}', root) }
    try {
      const out = await git(root, ['--no-optional-locks', 'status', '--porcelain=v2', '-z', '--branch', '--untracked-files=all'])
      return { ok: true, hasCommits: await hasCommits(root), ...parseStatus(out) }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { ok: false, reason: 'no-git' }
      const msg = String((e as { stderr?: string }).stderr ?? '')
      if (/not a git repository/i.test(msg)) return { ok: false, reason: 'not-repo' }
      return { ok: false, reason: 'error', message: msg.trim() || String(e) }
    }
  })

  ipcMain.handle('git:init', async (_e, root: string) => {
    try {
      await git(root, ['init'])
    } catch (e) {
      throw gitError(e)
    }
  })

  ipcMain.handle('git:stage', async (_e, root: string, paths: string[] | null) => {
    try {
      if (paths === null) await git(root, ['add', '-A'])
      else await inChunks(root, ['add', '-A'], checkPaths(paths))
    } catch (e) {
      throw gitError(e)
    }
  })

  ipcMain.handle('git:unstage', async (_e, root: string, paths: string[] | null) => {
    try {
      const head = await hasCommits(root)
      if (paths === null) {
        if (head) await git(root, ['reset', '-q'])
        else await git(root, ['rm', '-r', '-q', '--cached', '.'])
      } else if (head) await inChunks(root, ['reset', '-q', 'HEAD'], checkPaths(paths))
      else await inChunks(root, ['rm', '-r', '-q', '--cached'], checkPaths(paths))
    } catch (e) {
      throw gitError(e)
    }
  })

  /** 放弃工作区的修改；未跟踪的文件移到回收站（可以找回） */
  ipcMain.handle('git:discard', async (_e, root: string, tracked: string[], untracked: string[]) => {
    try {
      if (tracked.length) await inChunks(root, ['checkout', '-q'], checkPaths(tracked))
      for (const p of checkPaths(untracked)) {
        const full = path.resolve(root, p)
        if (!full.startsWith(path.resolve(root))) continue
        await shell.trashItem(full)
      }
    } catch (e) {
      throw gitError(e)
    }
  })

  ipcMain.handle('git:commit', async (_e, root: string, message: string, opts: { amend?: boolean } = {}) => {
    const args = ['commit', '--quiet']
    if (opts.amend) args.push('--amend')
    if (message.trim()) args.push('-m', message)
    else if (opts.amend) args.push('--no-edit')
    else throw new Error(tm('请输入提交信息'))
    try {
      await git(root, args)
    } catch (e) {
      throw gitError(e)
    }
  })

  ipcMain.handle('git:run', async (_e, root: string, op: GitOp) => {
    try {
      await runOp(root, op)
    } catch (e) {
      throw gitError(e)
    }
  })

  /** 某个版本里的文件内容：ref 为 'HEAD'、提交 hash、hash^，或 ':'（暂存区）。不存在时返回空字符串 */
  ipcMain.handle('git:show', async (_e, root: string, ref: string, file: string): Promise<string> => {
    if (!/^(HEAD|:|[0-9a-f]{7,40}\^?)$/i.test(ref) || file.startsWith('-')) throw new Error('invalid ref')
    try {
      return await git(root, ['show', ref === ':' ? `:${file}` : `${ref}:${file}`])
    } catch {
      return ''
    }
  })

  ipcMain.handle('git:lastMessage', async (_e, root: string): Promise<string> => {
    try {
      return (await git(root, ['log', '-1', '--format=%B'])).trim()
    } catch {
      return ''
    }
  })

  ipcMain.handle('git:branches', async (_e, root: string): Promise<GitBranch[]> => {
    try {
      const out = await git(root, ['for-each-ref', '--sort=-committerdate', '--format=%(refname)%09%(HEAD)', 'refs/heads', 'refs/remotes'])
      return out
        .split(/\r?\n/)
        .filter(Boolean)
        .map((l) => {
          const [ref, head] = l.split('\t')
          const remote = ref.startsWith('refs/remotes/')
          return { name: ref.replace(/^refs\/(heads|remotes)\//, ''), current: head === '*', remote }
        })
        .filter((b) => !(b.remote && b.name.endsWith('/HEAD')))
    } catch (e) {
      throw gitError(e)
    }
  })

  ipcMain.handle('git:checkout', async (_e, root: string, name: string, opts: { create?: boolean; remote?: boolean } = {}) => {
    if (!name || name.startsWith('-') || /[\s~^:?*[\\]/.test(name)) throw new Error(tm('无效的分支名'))
    try {
      if (opts.create) await git(root, ['checkout', '-q', '-b', name])
      else if (opts.remote) {
        // 远程分支：有同名本地分支就切过去，没有就新建跟踪分支
        const local = name.slice(name.indexOf('/') + 1)
        const exists = await git(root, ['rev-parse', '--verify', '-q', `refs/heads/${local}`]).then(
          () => true,
          () => false
        )
        if (exists) await git(root, ['checkout', '-q', local])
        else await git(root, ['checkout', '-q', '--track', name])
      } else await git(root, ['checkout', '-q', name])
    } catch (e) {
      throw gitError(e)
    }
  })
}
