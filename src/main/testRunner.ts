import { ipcMain } from 'electron'
import { spawn } from 'node:child_process'
import { existsSync, promises as fs } from 'node:fs'
import path from 'node:path'
import { childEnv } from './plugins'

/**
 * AI 对话的 runTests 工具：识别项目的测试命令并运行，返回退出码和输出（太长时保留结尾）。
 * 只运行识别出来的标准命令；filter 只能是测试名之类的简单文本，不能拼出别的 shell 命令。
 */

const isWin = process.platform === 'win32'
const MAX_OUT = 60_000
const TIMEOUT = 10 * 60_000

interface Plan {
  label: string
  cmd: string
  args: string[]
  /** filter 怎么加到参数里 */
  filter?: (f: string) => string[]
}

async function readJson(p: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await fs.readFile(p, 'utf8')) as Record<string, unknown>
  } catch {
    return null
  }
}

async function detect(root: string): Promise<Plan | null> {
  const has = (f: string) => existsSync(path.join(root, f))
  const pkg = await readJson(path.join(root, 'package.json'))
  const test = (pkg?.scripts as Record<string, string> | undefined)?.test
  if (test && !/no test specified/.test(test)) {
    const pm = has('pnpm-lock.yaml') ? 'pnpm' : has('yarn.lock') ? 'yarn' : 'npm'
    return { label: `${pm} test`, cmd: pm + (isWin ? '.cmd' : ''), args: pm === 'npm' ? ['test', '--silent'] : ['test'], filter: (f) => (pm === 'npm' ? ['--', f] : [f]) }
  }
  if (has('Cargo.toml')) return { label: 'cargo test', cmd: 'cargo', args: ['test'], filter: (f) => [f] }
  if (has('go.mod')) return { label: 'go test ./...', cmd: 'go', args: ['test', './...'], filter: (f) => ['-run', f] }
  if (has('pom.xml')) return { label: 'mvn test', cmd: isWin ? 'mvn.cmd' : 'mvn', args: ['-q', 'test'], filter: (f) => [`-Dtest=${f}`] }
  if (has('build.gradle') || has('build.gradle.kts')) {
    const wrapper = has(isWin ? 'gradlew.bat' : 'gradlew')
    return { label: 'gradle test', cmd: wrapper ? path.join(root, isWin ? 'gradlew.bat' : 'gradlew') : isWin ? 'gradle.bat' : 'gradle', args: ['test'], filter: (f) => ['--tests', f] }
  }
  const entries = await fs.readdir(root).catch(() => [] as string[])
  if (entries.some((e) => /\.(sln|csproj|fsproj)$/i.test(e))) return { label: 'dotnet test', cmd: 'dotnet', args: ['test'], filter: (f) => ['--filter', f] }
  const py = ['pytest.ini', 'pyproject.toml', 'setup.cfg', 'tox.ini', 'conftest.py'].some(has) || entries.includes('tests') || entries.some((e) => /^test_.*\.py$/.test(e))
  if (py) return { label: 'python -m pytest', cmd: isWin ? 'python' : 'python3', args: ['-m', 'pytest', '-q'], filter: (f) => ['-k', f] }
  return null
}

function run(plan: Plan, root: string, filter?: string): Promise<{ ok: boolean; exitCode: number | null; command: string; output: string; timedOut?: boolean }> {
  const args = [...plan.args, ...(filter && plan.filter ? plan.filter(filter) : [])]
  const command = [plan.label, ...(filter && plan.filter ? plan.filter(filter) : [])].join(' ')
  return new Promise((resolve) => {
    let out = ''
    const add = (b: Buffer) => {
      out += b.toString('utf8')
      if (out.length > MAX_OUT * 2) out = out.slice(-MAX_OUT)
    }
    // .cmd / .bat 只能经由 shell 启动；参数都经过了检查，不含 shell 元字符
    const viaShell = isWin && /\.(cmd|bat)$/i.test(plan.cmd)
    const file = viaShell && /\s/.test(plan.cmd) ? `"${plan.cmd}"` : plan.cmd
    const child = spawn(file, args, { cwd: root, env: { ...childEnv(), CI: '1', FORCE_COLOR: '0' }, windowsHide: true, shell: viaShell })
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
    }, TIMEOUT)
    child.stdout.on('data', add)
    child.stderr.on('data', add)
    child.on('error', (e) => {
      clearTimeout(timer)
      resolve({ ok: false, exitCode: null, command, output: `Failed to start ${plan.cmd}: ${e.message}` })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      const output = out.length > MAX_OUT ? '… (earlier output truncated)\n' + out.slice(-MAX_OUT) : out
      resolve({ ok: code === 0 && !timedOut, exitCode: code, command, output: output.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ''), timedOut })
    })
  })
}

export function registerTestRunnerIpc(): void {
  ipcMain.handle('ai:runTests', async (_e, root: unknown, filter: unknown) => {
    if (typeof root !== 'string' || !path.isAbsolute(root) || !existsSync(root)) return { ok: false, exitCode: null, command: '', output: 'No project folder is open.' }
    const f = typeof filter === 'string' && filter.trim() ? filter.trim() : undefined
    if (f && !/^[\w.:/\\\-[\]#*]{1,200}$/.test(f)) return { ok: false, exitCode: null, command: '', output: 'Invalid filter: use a test name or path only.' }
    const plan = await detect(root)
    if (!plan) return { ok: false, exitCode: null, command: '', output: 'Could not detect a test command (looked for package.json "test" script, Cargo, Go, Maven, Gradle, .NET and pytest).' }
    return run(plan, root, f)
  })
}
