/** LSP / DAP 都用 Content-Length 分帧 */
export class Framer {
  private buf = Buffer.alloc(0)
  constructor(private onMessage: (msg: unknown) => void) {}
  push(chunk: Buffer): void {
    this.buf = Buffer.concat([this.buf, chunk])
    for (;;) {
      const sep = this.buf.indexOf('\r\n\r\n')
      if (sep < 0) return
      const m = /Content-Length:\s*(\d+)/i.exec(this.buf.subarray(0, sep).toString('ascii'))
      if (!m) {
        // 头部损坏：丢掉这一段，避免死循环
        this.buf = this.buf.subarray(sep + 4)
        continue
      }
      const len = Number(m[1])
      if (this.buf.length < sep + 4 + len) return
      const body = this.buf.subarray(sep + 4, sep + 4 + len).toString('utf8')
      this.buf = this.buf.subarray(sep + 4 + len)
      try {
        this.onMessage(JSON.parse(body))
      } catch (e) {
        console.warn('消息解析失败', e)
      }
    }
  }
}

/** 编码一条消息 */
export function frame(msg: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(msg), 'utf8')
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body])
}
