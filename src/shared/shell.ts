/**
 * 拼接在内置终端里执行的命令。
 * Windows 上内置终端是 PowerShell（pwsh 或 Windows PowerShell 5），其余平台是 POSIX shell。
 */

export type ShellKind = 'pwsh' | 'posix'

export function shellKind(platform: string): ShellKind {
  return platform === 'win32' ? 'pwsh' : 'posix'
}

export function quote(kind: ShellKind, s: string): string {
  if (kind === 'pwsh') return `'${s.replace(/'/g, "''")}'`
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`
}

/** 执行一个程序：PowerShell 里带引号的路径要用 & 调用 */
export function invoke(kind: ShellKind, exe: string, args: string[] = []): string {
  const parts = [quote(kind, exe), ...args.map((a) => quote(kind, a))]
  return kind === 'pwsh' ? `& ${parts.join(' ')}` : parts.join(' ')
}

/** 前一步成功才执行下一步（Windows PowerShell 5 不支持 &&） */
export function andThen(kind: ShellKind, steps: string[]): string {
  if (steps.length <= 1) return steps[0] ?? ''
  if (kind === 'posix') return steps.join(' && ')
  const [first, ...rest] = steps
  return `${first}; if ($?) { ${andThen(kind, rest)} }`
}

/** 带环境变量执行 */
export function withEnv(kind: ShellKind, env: Record<string, string>, command: string): string {
  const keys = Object.keys(env).filter((k) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k))
  if (!keys.length) return command
  if (kind === 'pwsh') return keys.map((k) => `$env:${k}=${quote(kind, env[k])}; `).join('') + command
  return 'env ' + keys.map((k) => `${k}=${quote(kind, env[k])}`).join(' ') + ' ' + command
}
