import { app, ipcMain, type WebContents } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, promises as fs } from 'node:fs'
import path from 'node:path'
import type { JupyterCommand, JupyterEvent, JupyterStart, JupyterStartOpts } from '../shared/types'
import { invoke } from '../shared/shell'
import { childEnv } from './plugins'
import { cachedToolchains, detectLanguage, sh } from './toolchains'
import { tm } from './i18n'

/**
 * Jupyter 内核：主进程启动一个 Python 小脚本（桥接），它用 jupyter_client 启动并连接内核，
 * 通过标准输入输出和这里交换一行一个的 JSON。这样不需要在 Node 里装 ZeroMQ，也不用开 Jupyter 服务器。
 * 内核用的 Python 就是桥接脚本的 Python：优先 Notebook 所在目录（向上直到工作区根）里的虚拟环境，其次系统的 Python。
 */

const isWin = process.platform === 'win32'

const BRIDGE = String.raw`
import sys, json, threading, queue, time

def emit(o):
    sys.stdout.write(json.dumps(o, default=str, ensure_ascii=True) + "\n")
    sys.stdout.flush()

try:
    import zmq
    from jupyter_client.manager import KernelManager
    from jupyter_client.kernelspec import NoSuchKernel
except Exception as e:
    emit({"type": "fatal", "reason": "missing", "detail": repr(e)})
    sys.exit(3)

kernel_name, cwd = sys.argv[1], sys.argv[2]
cmds = queue.Queue()

def reader():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            cmds.put(json.loads(line))
        except Exception:
            pass
    cmds.put({"cmd": "shutdown"})

threading.Thread(target=reader, daemon=True).start()

def start(name):
    km = KernelManager(kernel_name=name)
    km.start_kernel(cwd=cwd)
    kc = km.client()
    kc.start_channels()
    try:
        kc.wait_for_ready(timeout=60)
    except Exception:
        kc.stop_channels()
        km.shutdown_kernel(now=True)
        raise
    return km, kc

fallback = None
try:
    try:
        km, kc = start(kernel_name)
    except NoSuchKernel:
        if kernel_name == "python3":
            raise
        fallback = kernel_name
        kernel_name = "python3"
        km, kc = start(kernel_name)
except NoSuchKernel as e:
    emit({"type": "fatal", "reason": "nokernel", "detail": str(e)})
    sys.exit(4)
except Exception as e:
    emit({"type": "fatal", "reason": "start", "detail": repr(e)})
    sys.exit(5)

def ready():
    info = {}
    try:
        info = kc.kernel_info(reply=True, timeout=15)["content"]
    except Exception:
        pass
    emit({"type": "ready", "info": info, "kernel": kernel_name, "fallback": fallback})

ready()

channels = [(kc.iopub_channel, "iopub"), (kc.shell_channel, "shell"), (kc.stdin_channel, "stdin")]
poller = zmq.Poller()
for ch, _ in channels:
    poller.register(ch.socket, zmq.POLLIN)

def forward(kind, m):
    emit({
        "type": kind,
        "parent": (m.get("parent_header") or {}).get("msg_id"),
        "msg_type": m["header"]["msg_type"],
        "content": m.get("content") or {},
    })

def drain():
    for ch, kind in channels:
        while ch.msg_ready():
            try:
                forward(kind, ch.get_msg(timeout=0))
            except Exception:
                break

def shutdown():
    try:
        kc.stop_channels()
    except Exception:
        pass
    try:
        km.shutdown_kernel(now=False)
    except Exception:
        try:
            km.shutdown_kernel(now=True)
        except Exception:
            pass
    sys.exit(0)

dead = False
last_check = time.time()
while True:
    while True:
        try:
            c = cmds.get_nowait()
        except queue.Empty:
            break
        op = c.get("cmd")
        try:
            if op == "execute":
                mid = kc.execute(c["code"], allow_stdin=True, store_history=True, stop_on_error=True)
                emit({"type": "sent", "id": c["id"], "msg_id": mid})
            elif op == "complete":
                mid = kc.complete(c["code"], c["pos"])
                emit({"type": "sent", "id": c["id"], "msg_id": mid})
            elif op == "input":
                kc.input(c.get("value", ""))
            elif op == "interrupt":
                km.interrupt_kernel()
            elif op == "restart":
                drain()
                km.restart_kernel(now=True)
                kc.wait_for_ready(timeout=60)
                dead = False
                drain()
                emit({"type": "restarted"})
                ready()
            elif op == "shutdown":
                shutdown()
        except SystemExit:
            raise
        except Exception as e:
            emit({"type": "log", "text": op + ": " + repr(e)})
    try:
        if poller.poll(50):
            drain()
    except zmq.ZMQError:
        time.sleep(0.05)
    if time.time() - last_check > 1.5:
        last_check = time.time()
        alive = km.is_alive()
        if not alive and not dead:
            dead = True
            emit({"type": "dead"})
`

interface Kernel {
  proc: ChildProcess
  wc: WebContents
  killTimer?: ReturnType<typeof setTimeout>
}

const kernels = new Map<number, Kernel>()
let nextId = 1

async function bridgeFile(): Promise<string> {
  const file = path.join(app.getPath('userData'), 'jupyter_bridge.py')
  const cur = await fs.readFile(file, 'utf8').catch(() => null)
  if (cur !== BRIDGE) {
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, BRIDGE, 'utf8')
  }
  return file
}

/** 从 Notebook 所在目录向上找虚拟环境，最多到工作区根目录（没有工作区时最多 4 层） */
function findVenv(dir: string, root?: string | null): string | null {
  const names = ['.venv', 'venv', 'env', '.env']
  const exe = isWin ? path.join('Scripts', 'python.exe') : path.join('bin', 'python')
  const stop = root ? path.resolve(root).toLowerCase() : null
  let cur = path.resolve(dir)
  for (let depth = 0; depth < 12; depth++) {
    for (const n of names) {
      const p = path.join(cur, n, exe)
      if (existsSync(p)) return p
    }
    const up = path.dirname(cur)
    if (up === cur || (stop && cur.toLowerCase() === stop) || (!stop && depth >= 3)) break
    cur = up
  }
  // conda 环境：激活后有 CONDA_PREFIX
  const conda = process.env.CONDA_PREFIX
  if (conda) {
    const p = isWin ? path.join(conda, 'python.exe') : path.join(conda, 'bin', 'python')
    if (existsSync(p)) return p
  }
  return null
}

function stop(id: number): void {
  const k = kernels.get(id)
  if (!k) return
  kernels.delete(id)
  // 先让桥接脚本正常关掉内核（直接杀掉桥接会留下孤儿内核进程），过一会儿还没退出再强制结束
  try {
    if (k.proc.stdin?.writable) {
      k.proc.stdin.write(JSON.stringify({ cmd: 'shutdown' }) + '\n')
      k.proc.stdin.end()
    }
  } catch {
    /* 进程可能已退出 */
  }
  k.killTimer = setTimeout(() => {
    if (k.proc.exitCode === null) k.proc.kill()
  }, 5000)
}

export function registerJupyterIpc(): void {
  ipcMain.handle('jupyter:start', async (e, opts: JupyterStartOpts): Promise<JupyterStart> => {
    const wc = e.sender
    const cwd = path.dirname(opts.file)
    let python = findVenv(cwd, opts.root)
    if (!python) {
      await detectLanguage('python')
      python = cachedToolchains().python?.exe ?? null
    }
    if (!python) return { ok: false, reason: 'no-python', detail: tm('没有找到 Python 解释器，请先在插件页安装 Python 插件') }

    const script = await bridgeFile()
    const id = nextId++
    const proc = spawn(python, ['-u', script, opts.kernel || 'python3', cwd], {
      cwd,
      env: childEnv({ PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' }),
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    })
    const k: Kernel = { proc, wc }
    kernels.set(id, k)
    const send = (ev: JupyterEvent) => {
      if (!wc.isDestroyed()) wc.send('jupyter:event', id, ev)
    }

    let buf = ''
    proc.stdout!.setEncoding('utf8')
    proc.stdout!.on('data', (d: string) => {
      buf += d
      let i: number
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim()
        buf = buf.slice(i + 1)
        if (!line) continue
        try {
          const ev = JSON.parse(line) as JupyterEvent
          if (ev.type === 'fatal' && ev.reason === 'missing') ev.install = invoke(sh, python!, ['-m', 'pip', 'install', 'ipykernel'])
          send(ev)
        } catch {
          send({ type: 'log', text: line })
        }
      }
    })
    let stderr = ''
    proc.stderr!.setEncoding('utf8')
    proc.stderr!.on('data', (d: string) => {
      stderr = (stderr + d).slice(-6000)
    })
    proc.stdin!.on('error', () => {})
    proc.on('error', (err) => {
      stderr += String(err)
    })
    // 窗口关闭或重新加载：关掉它的所有内核
    const onDestroyed = () => stop(id)
    proc.on('exit', (code) => {
      clearTimeout(k.killTimer)
      kernels.delete(id)
      if (wc.isDestroyed()) return
      // 内核结束了就摘掉窗口上的回调，重启很多次内核也不会越积越多
      wc.off('destroyed', onDestroyed)
      wc.send('jupyter:exit', id, code ?? -1, stderr)
    })
    wc.once('destroyed', onDestroyed)
    return { ok: true, session: id, python }
  })

  ipcMain.on('jupyter:send', (_e, id: number, msg: JupyterCommand) => {
    const k = kernels.get(id)
    if (k?.proc.stdin?.writable) k.proc.stdin.write(JSON.stringify(msg) + '\n')
  })

  ipcMain.on('jupyter:stop', (_e, id: number) => stop(id))

  app.on('before-quit', () => {
    for (const id of [...kernels.keys()]) stop(id)
  })
}
