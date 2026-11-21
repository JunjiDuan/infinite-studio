/** 调试适配器：收发 DAP 消息 */
export interface Adapter {
  send(msg: unknown): void
  kill(): void
  onMessage: (msg: unknown) => void
  onExit: (code: number) => void
}

export interface DapRequest {
  seq: number
  type: 'request'
  command: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  arguments?: any
}

/**
 * 在主进程里实现的 DAP 适配器（把命令行调试器翻译成 DAP）。
 * 子类实现 handle()：返回响应体，抛错表示失败。
 */
export abstract class Shim implements Adapter {
  onMessage: (msg: unknown) => void = () => {}
  onExit: (code: number) => void = () => {}
  private seq = 1
  protected ended = false
  /** 变量引用 → 子类自己的数据；每次程序继续运行时清空 */
  private refs = new Map<number, unknown>()
  private nextRef = 1

  send(raw: unknown): void {
    const msg = raw as DapRequest
    if (msg?.type !== 'request') return
    this.handle(msg).then(
      (body) => {
        this.reply(msg, body ?? {})
        this.after(msg)
      },
      (e) => this.fail(msg, String((e as Error)?.message ?? e))
    )
  }

  protected abstract handle(req: DapRequest): Promise<unknown>
  /** 响应发出之后的动作（例如 launch 之后发 initialized 事件） */
  protected after(_req: DapRequest): void {}
  abstract kill(): void

  protected event(event: string, body?: unknown): void {
    this.onMessage({ seq: this.seq++, type: 'event', event, body })
  }

  protected output(text: string, category: 'stdout' | 'stderr' | 'console' = 'stdout'): void {
    if (text) this.event('output', { category, output: text })
  }

  private reply(req: DapRequest, body: unknown): void {
    this.onMessage({ seq: this.seq++, type: 'response', request_seq: req.seq, success: true, command: req.command, body })
  }

  private fail(req: DapRequest, message: string): void {
    this.onMessage({ seq: this.seq++, type: 'response', request_seq: req.seq, success: false, command: req.command, message, body: { error: { id: 1, format: message } } })
  }

  protected ref(data: unknown): number {
    const id = this.nextRef++
    this.refs.set(id, data)
    return id
  }

  protected deref<T>(id: number): T | undefined {
    return this.refs.get(id) as T | undefined
  }

  protected clearRefs(): void {
    this.refs.clear()
  }

  /** 程序结束：只发一次 */
  protected finish(exitCode?: number): void {
    if (this.ended) return
    this.ended = true
    if (exitCode !== undefined) this.event('exited', { exitCode })
    this.event('terminated')
  }
}

export const CAPABILITIES = {
  supportsConfigurationDoneRequest: true,
  supportsEvaluateForHovers: true,
  supportsTerminateRequest: true
}
