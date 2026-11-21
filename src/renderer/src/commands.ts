export interface Command {
  id: string
  title: string
  hint?: string
  key?: string
  run: () => void | Promise<void>
}

const registry: (() => Command[])[] = []

/** 注册一组命令；用函数返回，便于动态生成（比如“切换空间”列表） */
export function registerCommands(fn: () => Command[]): void {
  registry.push(fn)
}

export function allCommands(): Command[] {
  return registry.flatMap((fn) => fn())
}
