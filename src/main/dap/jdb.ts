import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { childEnv } from '../plugins'
import { CAPABILITIES, Shim, type DapRequest } from './shim'

/**
 * jdb → DAP。jdb 只有文本界面，这里按它的（英文）输出格式解析：
 * 命令一条一条发，输出到下一个提示符（"> " 或 "main[1] "）为止算这条命令的结果；
 * 没有命令在等结果时，断点命中 / 单步完成 / 程序退出之外的输出都是程序自己的输出。
 */

const PROMPT = /^(?:> |[\w$.\-]+\[\d+\] )$/
/** 行首残留的提示符（jdb 的提示符不换行，后面的输出会接在它后面） */
const PROMPT_PREFIX = /^(?:(?:> )|(?:[\w$.\-]+\[\d+\] ))+/
const LOCATION = /"thread=([^"]+)", ([\w$.<>]+)\.([\w$<>]+)\(\), line=([\d,]+)/

interface Cmd {
  text: string
  resolve: (out: string) => void
  reject: (e: Error) => void
}

type Ref = { kind: 'locals'; frame: number } | { kind: 'expr'; expr: string; frame: number }

interface Launch {
  mainClass: string
  classpath: string
  sourcepath: string
  cwd: string
}

export class JdbAdapter extends Shim {
  private proc: ChildProcess | null = null
  private buf = ''
  private queue: Cmd[] = []
  private current: (Cmd & { out: string[]; timer: ReturnType<typeof setTimeout> }) | null = null
  private ready = false
  private readyWaiters: (() => void)[] = []
  private launch: Launch | null = null
  private bps = new Map<string, { spec: string; line: number }[]>()
  /** jdb 当前选中的栈帧（0 起始） */
  private frameSel = 0
  private threadName = 'main'
  private stepping = false
  /** 停下后 jdb 会回显当前源码行，跳过它 */
  private skipSource = false
  private partialTimer: ReturnType<typeof setTimeout> | undefined
  /** 暂存的空行：jdb 在事件前后会输出空行，确认后面是程序输出时才补上 */
  private blanks = 0
  private pendingStop: Record<string, unknown> | null = null
  private quiet = true

  constructor(private jdb: string) {
    super()
  }

  kill(): void {
    if (this.proc && this.proc.exitCode === null) this.proc.kill()
  }

  private start(l: Launch): void {
    const args = [
      // 固定英文输出，并用 UTF-8 和 jdb 交换文本（包括被调试程序的输出）
      '-J-Duser.language=en',
      '-J-Duser.country=US',
      '-J-Dfile.encoding=UTF-8',
      '-J-Dstdout.encoding=UTF-8',
      '-Dfile.encoding=UTF-8',
      '-Dstdout.encoding=UTF-8',
      '-classpath',
      l.classpath,
      '-sourcepath',
      l.sourcepath,
      l.mainClass
    ]
    const proc = spawn(this.jdb, args, { cwd: l.cwd, env: childEnv(), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    this.proc = proc
    proc.stdout!.setEncoding('utf8')
    proc.stdout!.on('data', (d: string) => this.onData(d))
    proc.stderr!.setEncoding('utf8')
    proc.stderr!.on('data', (d: string) => this.output(d, 'stderr'))
    proc.stdin!.on('error', () => {})
    proc.on('error', (e) => {
      this.output(String(e) + '\n', 'stderr')
      this.finish()
      this.onExit(-1)
    })
    proc.on('exit', (code) => {
      this.current?.reject(new Error('jdb exited'))
      for (const c of this.queue) c.reject(new Error('jdb exited'))
      this.queue = []
      this.current = null
      this.finish(0)
      this.onExit(code ?? 0)
    })
  }

  private waitReady(): Promise<void> {
    if (this.ready) return Promise.resolve()
    return new Promise((r) => this.readyWaiters.push(r))
  }

  private cmd(text: string): Promise<string> {
    return new Promise((resolve, reject) => {
      this.queue.push({ text, resolve, reject })
      this.pump()
    })
  }

  private pump(): void {
    if (this.current || !this.ready || this.pendingStop || !this.queue.length || !this.proc?.stdin?.writable) return
    const c = this.queue.shift()!
    // 发命令之前缓冲里只剩上一个提示符：丢掉，等新的提示符
    this.buf = ''
    const timer = setTimeout(() => {
      if (this.current?.text !== c.text) return
      const cur = this.current
      this.current = null
      cur.resolve(cur.out.join('\n'))
      this.pump()
    }, 15000)
    this.current = { ...c, out: [], timer }
    this.proc.stdin.write(c.text + '\n')
  }

  private onData(d: string): void {
    this.buf += d.replace(/\r/g, '')
    let nl: number
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const raw = this.buf.slice(0, nl)
      const line = raw.replace(PROMPT_PREFIX, '')
      this.buf = this.buf.slice(nl + 1)
      // 提示符后面直接换行：jdb 自己的空行
      if (!line && raw) continue
      this.onLine(line)
    }
    // 剩下没换行的部分正好是提示符：上一条命令结束
    if (PROMPT.test(this.buf)) {
      // 停下的事件要等 jdb 把源码行和提示符都输出完再通知，否则紧接着发的命令会和这些输出混在一起
      if (this.pendingStop && !this.current) {
        const ev = this.pendingStop
        this.pendingStop = null
        this.event('stopped', ev)
      }
      if (!this.ready) {
        this.ready = true
        this.readyWaiters.splice(0).forEach((r) => r())
      } else if (this.current) {
        const cur = this.current
        this.current = null
        clearTimeout(cur.timer)
        cur.resolve(cur.out.join('\n'))
      }
      this.pump()
    } else if (!this.current && this.ready && this.buf) {
      // 程序输出了没换行的内容（例如输入提示）：输出安静一会儿后再显示，避免把 jdb 消息拆开
      clearTimeout(this.partialTimer)
      const snapshot = this.buf
      this.partialTimer = setTimeout(() => {
        if (this.buf !== snapshot || this.current) return
        const text = this.buf.replace(PROMPT_PREFIX, '')
        if (!text || PROMPT.test(this.buf) || /^(Breakpoint hit|Step completed|VM Started|Exception occurred|The application)/.test(text)) return
        this.buf = this.buf.slice(0, this.buf.length - text.length)
        this.flushBlanks()
        this.output(text)
      }, 250)
    }
  }

  private flushBlanks(): void {
    if (this.blanks) this.output('\n'.repeat(this.blanks))
    this.blanks = 0
  }

  private onLine(raw: string): void {
    let line = raw
    // 异步事件：不管有没有命令在等，都先处理
    if (/^VM Started: /.test(line)) {
      line = line.slice('VM Started: '.length)
      this.blanks = 0
    }
    if (/^(Breakpoint hit|Step completed): /.test(line)) {
      this.blanks = 0
      const loc = LOCATION.exec(line)
      this.onStopped(line.startsWith('Breakpoint') ? 'breakpoint' : 'step', loc)
      return
    }
    if (/^Exception occurred: /.test(line)) {
      this.blanks = 0
      const ex = /^Exception occurred: (\S+)/.exec(line)?.[1]
      this.onStopped('exception', LOCATION.exec(line), ex)
      return
    }
    if (/^The application exited/.test(line) || /^The application has been disconnected/.test(line)) {
      this.finish(0)
      this.kill()
      return
    }
    if (this.current) {
      this.current.out.push(line)
      return
    }
    if (!this.ready) return
    if (this.skipSource) {
      if (!line.trim()) return
      this.skipSource = false
      if (/^\d+\s/.test(line)) return
    }
    // jdb 自己的提示信息
    if (/^(Set (deferred )?(breakpoint|uncaught) |Deferring breakpoint |It will be set after the class is loaded|Initializing jdb|run |Input stream closed)/.test(line)) return
    if (!line) {
      // 继续运行后、程序真正输出之前的空行是 jdb 的
      if (!this.quiet) this.blanks++
      return
    }
    this.quiet = false
    this.flushBlanks()
    this.output(line + '\n')
  }

  private onStopped(reason: string, loc: RegExpExecArray | null, exception?: string): void {
    this.frameSel = 0
    this.skipSource = true
    if (loc) this.threadName = loc[1]
    const cls = loc?.[2]
    // 单步走到了没有源码的类（例如 main 结束后的 Thread.exit）：直接继续
    if (this.stepping && reason === 'step' && cls && !this.sourceFor(cls, null)) {
      void this.cmd('cont').catch(() => {})
      return
    }
    this.stepping = false
    this.pendingStop = { reason, threadId: 1, allThreadsStopped: true, description: exception, text: exception }
  }

  /** 类名 → 源文件（只认 sourcepath 下的） */
  private sourceFor(cls: string, file: string | null): string | null {
    if (!this.launch) return null
    const outer = cls.replace(/\$.*$/, '')
    const pkgPath = outer.split('.').slice(0, -1)
    const name = file ?? outer.split('.').pop()! + '.java'
    const p = path.join(this.launch.sourcepath, ...pkgPath, name)
    return existsSync(p) ? p : null
  }

  /** 源文件 → 类名（按 package 声明） */
  private classFor(file: string): string {
    let pkg = ''
    try {
      pkg = /^\s*package\s+([\w.]+)\s*;/m.exec(readFileSync(file, 'utf8'))?.[1] ?? ''
    } catch {
      /* 读不到就按默认包 */
    }
    const name = path.basename(file, path.extname(file))
    return pkg ? `${pkg}.${name}` : name
  }

  private async selectFrame(frame: number): Promise<void> {
    const d = frame - this.frameSel
    if (d > 0) await this.cmd(`up ${d}`)
    else if (d < 0) await this.cmd(`down ${-d}`)
    this.frameSel = frame
  }

  private async resume(cmd: string, stepping: boolean): Promise<void> {
    this.clearRefs()
    this.frameSel = 0
    this.stepping = stepping
    this.quiet = true
    this.blanks = 0
    await this.cmd(cmd)
  }

  protected after(req: DapRequest): void {
    if (req.command === 'launch') this.event('initialized')
  }

  protected async handle(req: DapRequest): Promise<unknown> {
    const a = req.arguments ?? {}
    switch (req.command) {
      case 'initialize':
        return CAPABILITIES
      case 'launch':
        this.launch = a as Launch
        this.start(this.launch)
        await this.waitReady()
        return {}
      case 'setBreakpoints': {
        const file: string = a.source?.path
        const cls = this.classFor(file)
        for (const old of this.bps.get(file) ?? []) await this.cmd(`clear ${old.spec}`).catch(() => '')
        const list: { spec: string; line: number }[] = []
        const out = []
        for (const bp of (a.breakpoints ?? []) as { line: number }[]) {
          const spec = `${cls}:${bp.line}`
          const r = await this.cmd(`stop at ${spec}`).catch((e: Error) => e.message)
          const ok = /Set breakpoint|Deferring breakpoint|already set/i.test(r)
          if (ok) list.push({ spec, line: bp.line })
          out.push({ verified: ok, line: bp.line, message: ok ? undefined : r.trim() })
        }
        this.bps.set(file, list)
        return { breakpoints: out }
      }
      case 'setExceptionBreakpoints':
        return {}
      case 'configurationDone':
        await this.cmd('run')
        return {}
      case 'threads':
        return { threads: [{ id: 1, name: this.threadName }] }
      case 'stackTrace': {
        const out = await this.cmd('where')
        const frames = []
        for (const line of out.split('\n')) {
          const m = /\[(\d+)\] ([\w$.<>]+)\.([\w$<>]+) \(([^)]*)\)/.exec(line)
          if (!m) continue
          const [, idx, cls, method, where] = m
          const fm = /^([\w$]+\.java):([\d,]+)$/.exec(where)
          const src = fm ? this.sourceFor(cls, fm[1]) : null
          frames.push({
            id: Number(idx),
            name: `${cls.split('.').pop()}.${method}`,
            line: fm ? Number(fm[2].replace(/,/g, '')) : 0,
            column: src ? 1 : 0,
            source: src ? { path: src, name: path.basename(src) } : undefined,
            presentationHint: src ? 'normal' : 'subtle'
          })
        }
        return { stackFrames: frames, totalFrames: frames.length }
      }
      case 'scopes':
        return { scopes: [{ name: 'Locals', presentationHint: 'locals', variablesReference: this.ref({ kind: 'locals', frame: a.frameId - 1 } satisfies Ref), expensive: false }] }
      case 'variables': {
        const r = this.deref<Ref>(a.variablesReference)
        if (!r) return { variables: [] }
        await this.selectFrame(r.frame)
        if (r.kind === 'locals') {
          const out = await this.cmd('locals')
          const vars = []
          for (const line of out.split('\n')) {
            const m = /^([\w$]+) = (.*)$/.exec(line)
            if (m) vars.push(this.toVariable(m[1], m[1], m[2], r.frame))
          }
          return { variables: vars }
        }
        return { variables: this.parseDump(r.expr, await this.cmd(`dump ${r.expr}`), r.frame) }
      }
      case 'evaluate': {
        const frame = a.frameId ? a.frameId - 1 : 0
        await this.selectFrame(frame)
        const expr = String(a.expression ?? '').trim()
        const out = await this.cmd(`print ${expr}`)
        if (/ParseException|not valid|No (current )?thread|not found|Name unknown/i.test(out)) throw new Error(out.trim().split('\n').pop()!)
        const idx = out.indexOf(' = ')
        const value = idx >= 0 ? out.slice(idx + 3).trim() : out.trim()
        return { result: pretty(value), variablesReference: /^instance of /.test(value) ? this.ref({ kind: 'expr', expr, frame } satisfies Ref) : 0 }
      }
      case 'continue':
        await this.resume('cont', false)
        return { allThreadsContinued: true }
      case 'next':
        await this.resume('next', true)
        return {}
      case 'stepIn':
        await this.resume('step', true)
        return {}
      case 'stepOut':
        await this.resume('step up', true)
        return {}
      case 'pause':
        throw new Error('pause is not supported for Java')
      case 'terminate':
      case 'disconnect':
        if (this.proc?.stdin?.writable) this.proc.stdin.write('exit\n')
        setTimeout(() => this.kill(), 800)
        return {}
      default:
        throw new Error(`unsupported request: ${req.command}`)
    }
  }

  private toVariable(name: string, expr: string, value: string, frame: number): { name: string; value: string; variablesReference: number } {
    const v = value.trim()
    const expandable = /^instance of /.test(v) && !/^instance of java\.lang\.(String|Integer|Long|Double|Float|Short|Byte|Character|Boolean)\(/.test(v)
    return { name, value: pretty(v), variablesReference: expandable ? this.ref({ kind: 'expr', expr, frame } satisfies Ref) : 0 }
  }

  /** dump 的输出：对象是多行 { 字段: 值 }，数组是一行 {a, b, c} */
  private parseDump(expr: string, out: string, frame: number): { name: string; value: string; variablesReference: number }[] {
    const start = out.indexOf('{')
    const end = out.lastIndexOf('}')
    if (start < 0 || end < start) return []
    const body = out.slice(start + 1, end)
    const vars = []
    if (body.includes('\n')) {
      for (const line of body.split('\n')) {
        const m = /^\s*([\w$.]+): (.*)$/.exec(line)
        if (!m) continue
        const field = m[1].split('.').pop()!
        vars.push(this.toVariable(field, `${expr}.${field}`, m[2], frame))
      }
    } else {
      splitTop(body).forEach((v, i) => vars.push(this.toVariable(`[${i}]`, `${expr}[${i}]`, v, frame)))
    }
    return vars.slice(0, 500)
  }
}

/** instance of java.util.ArrayList(id=561) → ArrayList (id=561) */
function pretty(v: string): string {
  const m = /^instance of ([\w$.]+)(\[\d*\])?\s*\(id=(\d+)\)$/.exec(v)
  if (!m) return v
  return `${m[1].split('.').pop()}${m[2] ?? ''} (id=${m[3]})`
}

/** 按顶层逗号切分（字符串和括号里的逗号不算） */
function splitTop(s: string): string[] {
  const out: string[] = []
  let depth = 0
  let inStr = false
  let cur = ''
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (inStr) {
      cur += c
      if (c === '\\') cur += s[++i] ?? ''
      else if (c === '"') inStr = false
      continue
    }
    if (c === '"') inStr = true
    else if (c === '(' || c === '{' || c === '[') depth++
    else if (c === ')' || c === '}' || c === ']') depth--
    if (c === ',' && depth === 0) {
      out.push(cur.trim())
      cur = ''
      continue
    }
    cur += c
  }
  if (cur.trim()) out.push(cur.trim())
  return out
}
