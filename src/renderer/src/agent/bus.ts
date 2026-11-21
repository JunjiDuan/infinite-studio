/** 把主进程推送的对话进程事件按运行 id 分发给对应的驱动 */

export interface RunHandler {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  event(ev: any): void
  exit(code: number, stderr: string): void
}

const handlers = new Map<number, RunHandler>()
/** 驱动还没注册时先到的事件 */
const early = new Map<number, { evs: unknown[]; exit?: [number, string] }>()
/** 已经放弃的运行（进程正在被结束），之后的事件直接丢掉 */
const dead = new Set<number>()
let inited = false

function init(): void {
  if (inited) return
  inited = true
  window.api.agent.onEvent((id, ev) => {
    if (dead.has(id)) return
    const h = handlers.get(id)
    if (h) h.event(ev)
    else {
      const e = early.get(id) ?? { evs: [] }
      e.evs.push(ev)
      early.set(id, e)
    }
  })
  window.api.agent.onExit((id, code, stderr) => {
    if (dead.delete(id)) return
    const h = handlers.get(id)
    handlers.delete(id)
    if (h) h.exit(code, stderr)
    else {
      const e = early.get(id) ?? { evs: [] }
      e.exit = [code, stderr]
      early.set(id, e)
    }
  })
}

export function listen(runId: number, h: RunHandler): void {
  init()
  handlers.set(runId, h)
  const e = early.get(runId)
  if (!e) return
  early.delete(runId)
  for (const ev of e.evs) h.event(ev)
  if (e.exit) {
    handlers.delete(runId)
    h.exit(...e.exit)
  }
}

export function unlisten(runId: number): void {
  handlers.delete(runId)
  early.delete(runId)
  dead.add(runId)
}

export function initBus(): void {
  init()
}
