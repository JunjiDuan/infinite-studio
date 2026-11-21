import { spawn, type ChildProcess } from 'node:child_process'
import path from 'node:path'
import { childEnv } from '../plugins'
import { CAPABILITIES, Shim, type DapRequest } from './shim'

/* ---------------- GDB/MI 输出解析 ---------------- */

type MiValue = string | MiTuple | MiValue[]
interface MiTuple {
  [k: string]: MiValue
}

/** 解析 MI 的 result 列表：a="1",b={c="2"},d=[...] */
export function parseMi(s: string): MiTuple {
  let i = 0
  const cstring = (): string => {
    // gdb 把非 ASCII 字节输出成 \ooo 八进制，先收集字节再按 UTF-8 解码
    const bytes: number[] = []
    i++ // "
    while (i < s.length && s[i] !== '"') {
      const ch = s[i]
      if (ch === '\\') {
        const n = s[i + 1]
        if (/[0-7]/.test(n)) {
          const oct = /^[0-7]{1,3}/.exec(s.slice(i + 1))![0]
          bytes.push(parseInt(oct, 8))
          i += 1 + oct.length
          continue
        }
        const map: Record<string, string> = { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\', e: '\x1b', a: '\x07', b: '\b', f: '\f', v: '\v' }
        bytes.push(...Buffer.from(map[n] ?? n, 'utf8'))
        i += 2
        continue
      }
      bytes.push(...Buffer.from(ch, 'utf8'))
      i++
    }
    i++ // "
    return Buffer.from(bytes).toString('utf8')
  }
  const value = (): MiValue => {
    const c = s[i]
    if (c === '"') return cstring()
    if (c === '{') {
      i++
      const t: MiTuple = {}
      while (i < s.length && s[i] !== '}') {
        const [k, v] = result()
        t[k] = v
        if (s[i] === ',') i++
      }
      i++
      return t
    }
    if (c === '[') {
      i++
      const arr: MiValue[] = []
      while (i < s.length && s[i] !== ']') {
        // 列表里可能是值，也可能是 name=value（只保留值）
        if (s[i] === '"' || s[i] === '{' || s[i] === '[') arr.push(value())
        else arr.push(result()[1])
        if (s[i] === ',') i++
      }
      i++
      return arr
    }
    // 不应出现：跳过到下一个分隔符
    const m = /^[^,}\]]*/.exec(s.slice(i))![0]
    i += m.length
    return m
  }
  const result = (): [string, MiValue] => {
    const eq = s.indexOf('=', i)
    const k = s.slice(i, eq)
    i = eq + 1
    return [k, value()]
  }
  const out: MiTuple = {}
  while (i < s.length) {
    if (s.indexOf('=', i) < 0) break
    const [k, v] = result()
    out[k] = v
    if (s[i] === ',') i++
    else break
  }
  return out
}

const str = (v: MiValue | undefined): string => (typeof v === 'string' ? v : '')
const tuple = (v: MiValue | undefined): MiTuple => (v && typeof v === 'object' && !Array.isArray(v) ? v : {})
const list = (v: MiValue | undefined): MiValue[] => (Array.isArray(v) ? v : [])

/** MI 记录在一行里的位置：程序输出没换行时，记录会接在程序输出后面 */
const RECORD = /(\d*)([\^*=])(done|running|connected|error|exit|stopped|[a-z]+(?:-[a-z]+)+)(,|$)/
const STREAM = /^([~@&])"/

interface Pending {
  resolve: (r: MiTuple) => void
  reject: (e: Error) => void
}

type Ref = { kind: 'locals'; thread: number; frame: number } | { kind: 'var'; name: string }

/** gdb/MI → DAP */
export class GdbAdapter extends Shim {
  private proc: ChildProcess
  private buf = ''
  private token = 1
  private pending = new Map<number, Pending>()
  private bps = new Map<string, string[]>()
  private varobjs: string[] = []
  private exitCode: number | undefined
  private lastThread = 1
  private stepping = false

  constructor(gdb: string) {
    super()
    this.proc = spawn(gdb, ['-q', '-nx', '--interpreter=mi2'], { env: childEnv(), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    this.proc.stdout!.setEncoding('utf8')
    this.proc.stdout!.on('data', (d: string) => this.onData(d))
    this.proc.stderr!.on('data', (d: Buffer) => this.output(d.toString('utf8'), 'stderr'))
    this.proc.stdin!.on('error', () => {})
    this.proc.on('error', (e) => {
      this.output(String(e) + '\n', 'stderr')
      this.finish()
      this.onExit(-1)
    })
    this.proc.on('exit', (code) => {
      for (const p of this.pending.values()) p.reject(new Error('gdb exited'))
      this.pending.clear()
      this.finish(this.exitCode)
      this.onExit(code ?? 0)
    })
  }

  kill(): void {
    if (this.proc.exitCode === null) this.proc.kill()
  }

  private mi(cmd: string): Promise<MiTuple> {
    const t = this.token++
    return new Promise((resolve, reject) => {
      if (!this.proc.stdin?.writable) return reject(new Error('gdb is not running'))
      this.pending.set(t, { resolve, reject })
      this.proc.stdin.write(`${t}${cmd}\n`)
    })
  }

  private onData(d: string): void {
    this.buf += d
    let nl: number
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl).replace(/\r$/, '')
      this.buf = this.buf.slice(nl + 1)
      this.onLine(line)
    }
  }

  private onLine(line: string): void {
    if (/^\(gdb\)\s*$/.test(line)) return
    const sm = STREAM.exec(line)
    if (sm) {
      // @ 是程序输出（远程目标）；~ 是 gdb 的控制台输出，& 是日志，都不显示
      if (sm[1] === '@') this.output(parseMi(`x=${line.slice(1)}`).x as string)
      return
    }
    const m = RECORD.exec(line)
    if (!m) {
      this.output(line + '\n')
      return
    }
    if (m.index > 0) this.output(line.slice(0, m.index))
    const rest = line.slice(m.index + m[0].length)
    const [, token, sym, cls] = m
    const data = parseMi(rest)
    if (sym === '^') {
      const p = this.pending.get(Number(token))
      if (!p) return
      this.pending.delete(Number(token))
      if (cls === 'error') p.reject(new Error(str(data.msg) || 'gdb error'))
      else p.resolve(data)
    } else if (sym === '*') {
      if (cls === 'stopped') void this.onStopped(data)
    } else if (sym === '=') {
      if (cls === 'thread-group-exited' && data['exit-code'] !== undefined) this.exitCode = parseInt(str(data['exit-code']), 8) || 0
    }
  }

  private async onStopped(r: MiTuple): Promise<void> {
    const reason = str(r.reason)
    if (reason.startsWith('exited')) {
      const code = reason === 'exited-normally' ? 0 : parseInt(str(r['exit-code']), 8) || this.exitCode || 0
      this.finish(code)
      void this.mi('-gdb-exit').catch(() => {})
      return
    }
    const thread = Number(str(r['thread-id'])) || this.lastThread
    this.lastThread = thread
    const frame = tuple(r.frame)
    // 单步走进了没有源码的地方（例如 main 返回后进入 C 运行库）：直接继续
    if (this.stepping && reason === 'end-stepping-range' && !str(frame.fullname)) {
      void this.mi('-exec-continue').catch(() => {})
      return
    }
    this.stepping = false
    const map: Record<string, string> = {
      'breakpoint-hit': 'breakpoint',
      'end-stepping-range': 'step',
      'function-finished': 'step',
      'signal-received': 'exception',
      'watchpoint-trigger': 'data breakpoint'
    }
    const dapReason = map[reason] ?? 'pause'
    const description = reason === 'signal-received' ? `${str(r['signal-name'])} ${str(r['signal-meaning'])}`.trim() : undefined
    this.event('stopped', { reason: dapReason, threadId: thread, allThreadsStopped: true, description, text: description })
  }

  private async resume(cmd: string, stepping: boolean): Promise<void> {
    await this.dropVarobjs()
    this.stepping = stepping
    await this.mi(cmd)
  }

  private async dropVarobjs(): Promise<void> {
    const objs = this.varobjs
    this.varobjs = []
    this.clearRefs()
    await Promise.all(objs.map((o) => this.mi(`-var-delete ${o}`).catch(() => {})))
  }

  protected after(req: DapRequest): void {
    if (req.command === 'launch') this.event('initialized')
  }

  protected async handle(req: DapRequest): Promise<unknown> {
    const a = req.arguments ?? {}
    switch (req.command) {
      case 'initialize':
        return CAPABILITIES
      case 'launch': {
        await this.mi('-gdb-set mi-async on').catch(() => {})
        await this.mi('-gdb-set confirm off').catch(() => {})
        await this.mi('-gdb-set print object on').catch(() => {})
        await this.mi('-enable-pretty-printing').catch(() => {})
        await this.mi(`-environment-cd ${q(a.cwd)}`)
        await this.mi(`-file-exec-and-symbols ${q(a.program)}`)
        return {}
      }
      case 'setBreakpoints': {
        const file: string = a.source?.path
        const key = process.platform === 'win32' ? file.toLowerCase() : file
        const old = this.bps.get(key) ?? []
        if (old.length) await this.mi(`-break-delete ${old.join(' ')}`).catch(() => {})
        const ids: string[] = []
        const out = []
        for (const bp of (a.breakpoints ?? []) as { line: number; condition?: string }[]) {
          try {
            const cond = bp.condition ? `-c ${q(bp.condition)} ` : ''
            const r = await this.mi(`-break-insert -f ${cond}${q(`${file.replace(/\\/g, '/')}:${bp.line}`)}`)
            const b = tuple(r.bkpt)
            ids.push(str(b.number))
            out.push({ id: Number(str(b.number)), verified: true, line: Number(str(b.line)) || bp.line })
          } catch (e) {
            out.push({ verified: false, line: bp.line, message: (e as Error).message })
          }
        }
        this.bps.set(key, ids)
        return { breakpoints: out }
      }
      case 'setExceptionBreakpoints':
        return {}
      case 'configurationDone':
        await this.mi('-exec-run')
        return {}
      case 'threads': {
        const r = await this.mi('-thread-info').catch(() => ({}) as MiTuple)
        const threads = list(r.threads).map((t) => {
          const x = tuple(t)
          return { id: Number(str(x.id)), name: str(x.name) || str(x['target-id']) || `Thread ${str(x.id)}` }
        })
        return { threads: threads.length ? threads : [{ id: 1, name: 'main' }] }
      }
      case 'stackTrace': {
        const thread = a.threadId ?? this.lastThread
        const r = await this.mi(`-stack-list-frames --thread ${thread}`)
        const frames = list(r.stack).map((f) => {
          const x = tuple(f)
          const level = Number(str(x.level))
          const full = str(x.fullname)
          return {
            id: thread * 10000 + level,
            name: str(x.func) || str(x.addr),
            line: Number(str(x.line)) || 0,
            column: full ? 1 : 0,
            source: full ? { path: full, name: path.basename(full) } : undefined,
            presentationHint: full ? 'normal' : 'subtle'
          }
        })
        return { stackFrames: frames, totalFrames: frames.length }
      }
      case 'scopes': {
        const thread = Math.floor(a.frameId / 10000)
        const frame = a.frameId % 10000
        return { scopes: [{ name: 'Locals', presentationHint: 'locals', variablesReference: this.ref({ kind: 'locals', thread, frame } satisfies Ref), expensive: false }] }
      }
      case 'variables': {
        const r = this.deref<Ref>(a.variablesReference)
        if (!r) return { variables: [] }
        if (r.kind === 'locals') {
          const names = await this.mi(`-stack-list-variables --thread ${r.thread} --frame ${r.frame} --no-values`)
          const vars = []
          for (const v of list(names.variables)) {
            const name = str(tuple(v).name)
            try {
              const o = await this.mi(`-var-create --thread ${r.thread} --frame ${r.frame} - * ${q(name)}`)
              this.varobjs.push(str(o.name))
              vars.push(this.toVariable(name, o))
            } catch (e) {
              vars.push({ name, value: (e as Error).message, variablesReference: 0 })
            }
          }
          return { variables: vars }
        }
        return { variables: await this.children(r.name) }
      }
      case 'evaluate': {
        const where = a.frameId !== undefined ? `--thread ${Math.floor(a.frameId / 10000)} --frame ${a.frameId % 10000} ` : ''
        const expr = String(a.expression ?? '')
        const r = await this.mi(`-data-evaluate-expression ${where}${q(expr)}`)
        return { result: str(r.value), variablesReference: 0 }
      }
      case 'continue':
        await this.resume('-exec-continue', false)
        return { allThreadsContinued: true }
      case 'next':
        await this.resume(`-exec-next --thread ${a.threadId ?? this.lastThread}`, true)
        return {}
      case 'stepIn':
        await this.resume(`-exec-step --thread ${a.threadId ?? this.lastThread}`, true)
        return {}
      case 'stepOut':
        try {
          await this.resume(`-exec-finish --thread ${a.threadId ?? this.lastThread}`, true)
        } catch {
          // 最外层的函数没法“跳出”：当作继续运行
          await this.resume('-exec-continue', false)
        }
        return {}
      case 'pause':
        await this.mi('-exec-interrupt --all')
        return {}
      case 'terminate':
      case 'disconnect':
        await Promise.race([this.mi('-gdb-exit').catch(() => {}), new Promise((r) => setTimeout(r, 1000))])
        this.kill()
        return {}
      default:
        throw new Error(`unsupported request: ${req.command}`)
    }
  }

  private toVariable(name: string, o: MiTuple): { name: string; value: string; type?: string; variablesReference: number } {
    const n = Number(str(o.numchild)) || 0
    return {
      name,
      value: str(o.value),
      type: str(o.type) || undefined,
      variablesReference: n > 0 ? this.ref({ kind: 'var', name: str(o.name) } satisfies Ref) : 0
    }
  }

  private async children(obj: string): Promise<{ name: string; value: string; variablesReference: number }[]> {
    const r = await this.mi(`-var-list-children --all-values ${obj} 0 200`)
    const out = []
    for (const c of list(r.children)) {
      const x = tuple(c)
      const exp = str(x.exp)
      // C++ 类的 public / private / protected 是虚拟的分组，直接展开
      if (!str(x.type) && /^(public|private|protected)$/.test(exp)) {
        out.push(...(await this.children(str(x.name))))
        continue
      }
      out.push(this.toVariable(/^\d+$/.test(exp) ? `[${exp}]` : exp, x))
    }
    return out
  }
}

/** MI 的 C 字符串参数 */
function q(s: string): string {
  return `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}
