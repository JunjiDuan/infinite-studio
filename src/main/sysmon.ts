import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { app, ipcMain, type WebContents } from 'electron'
import type { SysDisk, SysGpu, SysNet, SysProc, SysSample } from '../shared/types'
import nativeSource from './sysmon.cs?raw'
import { resetUnixSample, unixSample } from './sysmon-unix'

/**
 * 系统监视器。
 *
 * - 处理器每个核心的占用、内存总量、本 IDE 的进程：Node / Electron 自带接口。
 * - Windows 上的显卡、NPU、显存、温度、磁盘、网络、提交内存等：一个常驻的 PowerShell 进程
 *   加载 sysmon.cs（首次运行时编译并缓存成 dll），每秒输出一行 JSON。
 * - macOS / Linux 上的同类信息：见 sysmon-unix.ts。
 *
 * 只在有窗口打开着监视器视图时采样，最后一个视图关掉几秒后停掉采样进程。
 */

const INTERVAL = 1000
/** 视图关掉后多久停掉采样进程（来回切换视图时不必重启） */
const IDLE_STOP = 5000

interface NativeGpu {
  id: string
  name: string
  npu: boolean
  dedicatedTotal: number
  sharedTotal: number
  dedicatedUsed: number
  sharedUsed: number
  temp?: number
  engines: Record<string, number>
}

interface NativeSample {
  cpu: { utility: number; perf: number; processes: number; threads: number; handles: number; temp: number }
  mem: { committed: number; commitLimit: number; standby: number; modified: number; paged: number; nonpaged: number; pagefile: number }
  gpus: NativeGpu[]
  disks: { name: string; active: number; read: number; write: number }[]
  nets: SysNet[]
}

const subscribers = new Map<number, { wc: WebContents; count: number }>()
/** 已经挂过 destroyed 监听的页面，避免反复订阅时重复挂 */
const hooked = new WeakSet<WebContents>()
let timer: ReturnType<typeof setInterval> | null = null
let stopTimer: ReturnType<typeof setTimeout> | null = null
let native: ChildProcess | null = null
let nativeLast: NativeSample | null = null
let nativeFailures = 0
let prevCpu: os.CpuInfo[] | null = null
let volumeCache: { at: number; map: Map<string, { total: number; free: number }> } = { at: 0, map: new Map() }

/** 性能计数器读不到时是 -1 */
const val = (v: number | undefined | null): number | null => (typeof v === 'number' && isFinite(v) && v >= 0 ? v : null)

function psQuote(s: string): string {
  return "'" + s.replace(/'/g, "''") + "'"
}

async function startNative(): Promise<void> {
  if (process.platform !== 'win32' || native || nativeFailures >= 3) return
  const dir = path.join(app.getPath('userData'), 'sysmon')
  const hash = createHash('sha1').update(nativeSource).digest('hex').slice(0, 10)
  const src = path.join(dir, `sysmon-${hash}.cs`)
  const dll = path.join(dir, `sysmon-${hash}.dll`)
  try {
    await fs.mkdir(dir, { recursive: true })
    if (!existsSync(src)) await fs.writeFile(src, nativeSource, 'utf8')
  } catch {
    nativeFailures = 3
    return
  }
  // 有缓存的 dll 直接加载；没有就编译出来；dll 写不进去（被另一个实例占用等）就只在内存里编译
  const script = [
    "$ErrorActionPreference='Stop'",
    `$src=${psQuote(src)}; $dll=${psQuote(dll)}`,
    'if (Test-Path $dll) { try { Add-Type -Path $dll } catch { Remove-Item $dll -ErrorAction SilentlyContinue; Add-Type -Path $src } }',
    'else { try { Add-Type -Path $src -OutputAssembly $dll; Add-Type -Path $dll } catch { Add-Type -Path $src } }',
    `[InfiniteSysMon]::Run(${INTERVAL})`
  ].join('\n')
  if (subscribers.size === 0) return
  const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'ignore']
  })
  native = p
  let buf = ''
  p.stdout!.setEncoding('utf8')
  p.stdout!.on('data', (d: string) => {
    buf += d
    let i: number
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim()
      buf = buf.slice(i + 1)
      if (!line.startsWith('{')) continue
      try {
        nativeLast = JSON.parse(line) as NativeSample
        nativeFailures = 0
      } catch {
        /* 半行或损坏的输出，丢掉 */
      }
    }
  })
  p.on('error', () => undefined)
  p.on('exit', () => {
    if (native !== p) return
    native = null
    // 意外退出（不是我们停的）：还有人在看就重试几次
    if (subscribers.size > 0) {
      nativeFailures++
      setTimeout(() => void startNative(), 1000)
    }
  })
}

function stopNative(): void {
  const p = native
  native = null
  nativeLast = null
  if (!p) return
  try {
    p.stdin?.end()
  } catch {
    /* 已经退出 */
  }
  setTimeout(() => p.kill(), 500)
}

function cpuUsage(): { usage: number; cores: number[] } {
  const now = os.cpus()
  const prev = prevCpu
  prevCpu = now
  if (!prev || prev.length !== now.length) return { usage: 0, cores: now.map(() => 0) }
  const cores = now.map((c, i) => {
    const p = prev[i].times
    const t = c.times
    const idle = t.idle - p.idle
    const total = t.user - p.user + (t.nice - p.nice) + (t.sys - p.sys) + (t.irq - p.irq) + idle
    return total > 0 ? Math.max(0, Math.min(100, (1 - idle / total) * 100)) : 0
  })
  return { usage: cores.reduce((a, b) => a + b, 0) / (cores.length || 1), cores }
}

/** 磁盘里每个分区的容量（几秒刷新一次就够） */
async function volumes(letters: string[]): Promise<Map<string, { total: number; free: number }>> {
  if (Date.now() - volumeCache.at < 5000 && letters.every((l) => volumeCache.map.has(l))) return volumeCache.map
  const map = new Map<string, { total: number; free: number }>()
  await Promise.all(
    letters.map(async (l) => {
      try {
        const s = await fs.statfs(l + '\\')
        map.set(l, { total: s.blocks * s.bsize, free: s.bavail * s.bsize })
      } catch {
        /* 光驱、断开的网络盘 */
      }
    })
  )
  volumeCache = { at: Date.now(), map }
  return map
}

function appProcesses(logical: number): SysSample['app'] {
  const procs: SysProc[] = app.getAppMetrics().map((m) => ({
    type: m.type,
    name: m.name || m.serviceName || m.type,
    pid: m.pid,
    // Chromium 的占用以单个核心为 100%，换算成占整机的比例
    cpu: (m.cpu?.percentCPUUsage ?? 0) / logical,
    mem: (m.memory?.workingSetSize ?? 0) * 1024
  }))
  procs.sort((a, b) => b.mem - a.mem)
  return { cpu: procs.reduce((a, p) => a + p.cpu, 0), mem: procs.reduce((a, p) => a + p.mem, 0), procs }
}

function gpuFromNative(g: NativeGpu): SysGpu {
  const engines: Record<string, number> = {}
  for (const [k, v] of Object.entries(g.engines ?? {})) if (typeof v === 'number') engines[k] = Math.max(0, Math.min(100, v))
  const vals = Object.values(engines)
  return {
    id: g.id,
    name: g.name || (g.npu ? 'NPU' : 'GPU'),
    npu: g.npu,
    util: vals.length ? Math.max(...vals) : null,
    engines,
    dedicatedUsed: val(g.dedicatedUsed),
    dedicatedTotal: g.dedicatedTotal || 0,
    sharedUsed: val(g.sharedUsed),
    sharedTotal: g.sharedTotal || 0,
    temp: val(g.temp)
  }
}

async function sample(): Promise<SysSample> {
  const cpus = os.cpus()
  const logical = cpus.length || 1
  const baseMHz = cpus[0]?.speed ?? 0
  const { usage, cores } = cpuUsage()
  const n = nativeLast
  const u = process.platform === 'win32' ? null : await unixSample()

  const disks: SysDisk[] = u ? u.disks : []
  if (n?.disks) {
    const letters = n.disks.flatMap((d) => d.name.match(/[A-Z]:/gi) ?? [])
    const vols = await volumes(letters)
    for (const d of n.disks) {
      const mine = d.name.match(/[A-Z]:/gi) ?? []
      disks.push({
        name: d.name,
        active: val(d.active),
        read: val(d.read),
        write: val(d.write),
        volumes: mine.flatMap((m) => {
          const v = vols.get(m)
          return v ? [{ mount: m.toUpperCase(), ...v }] : []
        })
      })
    }
  }

  const utility = val(n?.cpu.utility)
  const perf = val(n?.cpu.perf)
  return {
    t: Date.now(),
    os: { platform: process.platform, release: os.release(), arch: os.arch(), host: os.hostname(), uptime: os.uptime() },
    cpu: {
      model: (cpus[0]?.model ?? '').replace(/\s+/g, ' ').trim(),
      logical,
      baseMHz,
      curMHz: perf != null && baseMHz ? (baseMHz * perf) / 100 : null,
      // 任务管理器用的是“处理器效用”（考虑了睿频），读不到时退回按时间片算的平均占用
      usage: utility != null ? Math.min(100, utility) : usage,
      cores,
      processes: val(n?.cpu.processes ?? u?.cpu.processes),
      threads: val(n?.cpu.threads ?? u?.cpu.threads),
      handles: val(n?.cpu.handles),
      temp: val(n?.cpu.temp ?? u?.cpu.temp),
      load: process.platform === 'win32' ? null : os.loadavg()
    },
    mem: {
      total: os.totalmem(),
      free: val(u?.mem.free) ?? os.freemem(),
      committed: val(n?.mem.committed ?? u?.mem.committed),
      commitLimit: val(n?.mem.commitLimit ?? u?.mem.commitLimit),
      standby: val(n?.mem.standby ?? u?.mem.cached),
      modified: val(n?.mem.modified),
      paged: val(n?.mem.paged),
      nonpaged: val(n?.mem.nonpaged),
      pagefile: val(n?.mem.pagefile ?? u?.mem.swap)
    },
    gpus: u ? u.gpus : (n?.gpus ?? []).map(gpuFromNative),
    disks,
    // 同一块网卡会出现多个虚拟实例，只留有带宽的
    nets: u ? u.nets : (n?.nets ?? []).filter((x) => x.bandwidth > 0 || x.rx > 0 || x.tx > 0),
    app: appProcesses(logical)
  }
}

async function tick(): Promise<void> {
  if (subscribers.size === 0) return
  const s = await sample()
  for (const { wc } of subscribers.values()) if (!wc.isDestroyed()) wc.send('sysmon:sample', s)
}

function ensureRunning(): void {
  if (stopTimer) {
    clearTimeout(stopTimer)
    stopTimer = null
  }
  void startNative()
  if (!timer) {
    prevCpu = os.cpus()
    timer = setInterval(() => void tick(), INTERVAL)
    // 第一份数据尽快给出来，不用等一整秒
    setTimeout(() => void tick(), 250)
  }
}

function scheduleStop(): void {
  if (subscribers.size > 0 || stopTimer) return
  stopTimer = setTimeout(() => {
    stopTimer = null
    if (subscribers.size > 0) return
    if (timer) clearInterval(timer)
    timer = null
    stopNative()
    resetUnixSample()
  }, IDLE_STOP)
}

function unsubscribe(id: number, all = false): void {
  const s = subscribers.get(id)
  if (!s) return
  s.count--
  if (all || s.count <= 0) subscribers.delete(id)
  scheduleStop()
}

export function registerSysmonIpc(): void {
  ipcMain.on('sysmon:subscribe', (e) => {
    const wc = e.sender
    const s = subscribers.get(wc.id)
    if (s) s.count++
    else subscribers.set(wc.id, { wc, count: 1 })
    if (!hooked.has(wc)) {
      hooked.add(wc)
      wc.once('destroyed', () => unsubscribe(wc.id, true))
    }
    ensureRunning()
  })
  ipcMain.on('sysmon:unsubscribe', (e) => unsubscribe(e.sender.id))
  app.on('will-quit', () => stopNative())
}
