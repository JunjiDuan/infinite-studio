import { app, ipcMain, type WebContents } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { DebugStart } from '../shared/types'
import { childEnv } from './plugins'
import { Framer, frame } from './framing'
import { tm } from './i18n'
import { GdbAdapter } from './dap/gdb'
import { JdbAdapter } from './dap/jdb'
import type { Adapter } from './dap/shim'
import { buildRoot, ccArgs, cppTarget, detectLanguage, cachedToolchains, exec, javacArgs, javaTarget } from './toolchains'

/**
 * 调试会话：页面用 DAP（Debug Adapter Protocol）和适配器对话，主进程只负责转发。
 * - Python：debugpy 自带的 DAP 适配器（单独进程）
 * - C/C++：gdb（经 MI 接口，在本进程里翻译成 DAP；gdb 自带的 DAP 模式需要带 Python 的 gdb，很多发行版没有），
 *          没有 gdb 时用 lldb-dap
 * - Java：jdb（在本进程里把文本命令翻译成 DAP）
 */


/** 独立进程的 DAP 适配器 */
class ProcessAdapter implements Adapter {
  onMessage: (m: unknown) => void = () => {}
  onExit: (code: number) => void = () => {}
  private proc: ChildProcess
  private stderr = ''
  constructor(cmd: string, args: string[], cwd: string) {
    this.proc = spawn(cmd, args, { cwd, env: childEnv(), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    const framer = new Framer((m) => this.onMessage(m))
    this.proc.stdout!.on('data', (d: Buffer) => framer.push(d))
    this.proc.stderr!.on('data', (d: Buffer) => {
      this.stderr = (this.stderr + d.toString('utf8')).slice(-4000)
    })
    this.proc.stdin!.on('error', () => {})
    this.proc.on('error', (e) => {
      this.onMessage({ type: 'event', event: 'output', body: { category: 'stderr', output: String(e) + '\n' } })
      this.onExit(-1)
    })
    this.proc.on('exit', (code) => {
      if (code && this.stderr) this.onMessage({ type: 'event', event: 'output', body: { category: 'stderr', output: this.stderr } })
      this.onExit(code ?? -1)
    })
  }
  send(msg: unknown): void {
    if (this.proc.stdin?.writable) this.proc.stdin.write(frame(msg))
  }
  kill(): void {
    if (this.proc.exitCode === null) this.proc.kill()
  }
}

interface Session {
  adapter: Adapter
  wc: WebContents
  onDestroyed: () => void
}

const sessions = new Map<number, Session>()
let nextId = 1

/** 调试前编译（C/C++、Java） */
async function compile(file: string, args: string[], cwd: string): Promise<{ ok: boolean; output: string }> {
  const r = await exec(file, args, { cwd, timeout: 120000 })
  return { ok: r.ok, output: r.out }
}

/**
 * 调试构建时额外链接的一小段代码：把 stdout 设为无缓冲。
 * 调试时程序的输出接在管道上，默认是全缓冲，不这样做的话 printf 的内容要等到程序结束才出现。
 */
const UNBUFFERED = `#include <stdio.h>
__attribute__((constructor)) static void infinite_studio_unbuffered(void) { setvbuf(stdout, NULL, _IONBF, 0); setvbuf(stderr, NULL, _IONBF, 0); }
`

async function prepare(pluginId: string, file: string): Promise<{ adapter: Adapter; adapterId: string; launch: Record<string, unknown> } | { error: string; output?: string }> {
  await detectLanguage(pluginId)
  const tc = cachedToolchains()
  if (pluginId === 'python') {
    const py = tc.python
    if (!py) return { error: tm('没有找到 Python 解释器，请先在插件页安装 Python 插件') }
    if (!py.debugpy) return { error: tm('没有安装 debugpy，请在插件页点击 Python 插件的“安装”') }
    const cwd = path.dirname(file)
    return {
      adapter: new ProcessAdapter(py.exe, ['-m', 'debugpy.adapter'], cwd),
      adapterId: 'python',
      launch: { name: path.basename(file), type: 'python', request: 'launch', program: file, cwd, python: py.exe, console: 'integratedTerminal', justMyCode: true }
    }
  }
  if (pluginId === 'cpp') {
    const x = tc.cpp
    if (!x) return { error: tm('没有找到 C/C++ 编译器，请先在插件页安装 C/C++ 插件') }
    if (!x.gdb && !x.lldbDap) return { error: tm('没有找到调试器（gdb），请先在插件页安装 C/C++ 插件') }
    const t = cppTarget(file)
    await fs.mkdir(path.dirname(t.exe), { recursive: true })
    const helper = path.join(buildRoot(), 'cpp', 'unbuffered.c')
    await fs.writeFile(helper, UNBUFFERED, 'utf8')
    // 辅助文件总是按 C 编译（g++ 遇到 .c 会当 C++，这段代码两种都能编过）
    const r = await compile(t.isC ? x.cc : x.cxx, ccArgs(file, t.exe, [helper]), path.dirname(file))
    if (!r.ok) return { error: tm('编译失败'), output: r.output }
    const cwd = path.dirname(file)
    if (x.gdb) return { adapter: new GdbAdapter(x.gdb), adapterId: 'gdb', launch: { program: t.exe, cwd } }
    return { adapter: new ProcessAdapter(x.lldbDap!, [], cwd), adapterId: 'lldb-dap', launch: { program: t.exe, cwd, name: path.basename(file), type: 'lldb-dap', request: 'launch' } }
  }
  if (pluginId === 'java') {
    const j = tc.java
    if (!j) return { error: tm('没有找到 JDK，请先在插件页安装 Java 插件') }
    const t = await javaTarget(file)
    await fs.mkdir(t.outDir, { recursive: true })
    const r = await compile(j.javac, javacArgs(file, t), t.srcRoot)
    if (!r.ok) return { error: tm('编译失败'), output: r.output }
    return { adapter: new JdbAdapter(j.jdb), adapterId: 'jdb', launch: { mainClass: t.mainClass, classpath: t.outDir, sourcepath: t.srcRoot, cwd: t.srcRoot } }
  }
  return { error: tm('未知插件：{0}', pluginId) }
}

function kill(id: number): void {
  const s = sessions.get(id)
  if (!s) return
  sessions.delete(id)
  if (!s.wc.isDestroyed()) s.wc.off('destroyed', s.onDestroyed)
  s.adapter.kill()
}

export function registerDebugIpc(): void {
  ipcMain.handle('debug:start', async (e, pluginId: string, file: string): Promise<DebugStart> => {
    try {
      const r = await prepare(pluginId, file)
      if ('error' in r) return { ok: false, error: r.error, output: r.output }
      const id = nextId++
      const wc = e.sender
      const onDestroyed = () => kill(id)
      sessions.set(id, { adapter: r.adapter, wc, onDestroyed })
      r.adapter.onMessage = (m) => {
        if (!wc.isDestroyed()) wc.send('debug:message', id, m)
      }
      r.adapter.onExit = (code) => {
        if (!sessions.has(id)) return
        sessions.delete(id)
        if (wc.isDestroyed()) return
        wc.off('destroyed', onDestroyed)
        wc.send('debug:exit', id, code)
      }
      wc.once('destroyed', onDestroyed)
      return { ok: true, id, adapterId: r.adapterId, launch: r.launch }
    } catch (err) {
      return { ok: false, error: String((err as Error)?.message ?? err) }
    }
  })
  ipcMain.on('debug:send', (_e, id: number, msg: unknown) => sessions.get(id)?.adapter.send(msg))
  // 页面已经发过 disconnect；1.5 秒后还在就强制结束
  ipcMain.on('debug:stop', (_e, id: number) => setTimeout(() => kill(id), 1500))
  app.on('before-quit', () => {
    for (const id of [...sessions.keys()]) kill(id)
  })
}
