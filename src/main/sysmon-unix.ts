import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { SysDisk, SysGpu, SysNet } from '../shared/types'

/**
 * macOS / Linux 上的显卡、磁盘、网络、进程数和内存细节。
 *
 * - Linux：读 /proc 和 /sys；NVIDIA 显卡用 nvidia-smi，AMD 显卡读 amdgpu 的 sysfs。
 * - macOS：不需要管理员权限的系统命令（ioreg、netstat、vm_stat、df、ps、sysctl）。
 *
 * 磁盘和网络给的是累计计数，这里和上一次采样相减算出每秒速率。
 * 读不到的项一律给 null，界面上就不显示那一行。
 */

export interface UnixSample {
  cpu: { processes: number | null; threads: number | null; temp: number | null }
  mem: {
    /** 覆盖 os.freemem()：macOS 上它只算完全空闲的页，看起来内存永远是满的 */
    free: number | null
    committed: number | null
    commitLimit: number | null
    cached: number | null
    /** 交换空间已用百分比 */
    swap: number | null
  }
  gpus: SysGpu[]
  disks: SysDisk[]
  nets: SysNet[]
}

const isMac = process.platform === 'darwin'

function run(cmd: string, args: string[], timeout = 3000): Promise<string> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' }, (err, out) => resolve(err ? '' : out))
  })
}

async function read(file: string): Promise<string> {
  try {
    return await fs.readFile(file, 'utf8')
  } catch {
    return ''
  }
}

async function readNum(file: string): Promise<number | null> {
  const s = (await read(file)).trim()
  const n = Number(s)
  return s && isFinite(n) ? n : null
}

async function ls(dir: string): Promise<string[]> {
  try {
    return await fs.readdir(dir)
  } catch {
    return []
  }
}

async function capacity(mount: string): Promise<{ total: number; free: number } | null> {
  try {
    const s = await fs.statfs(mount)
    const total = s.blocks * s.bsize
    return total > 0 ? { total, free: s.bavail * s.bsize } : null
  } catch {
    return null
  }
}

/* ---------------- 累计计数 → 速率 ---------------- */

const prevCounters = new Map<string, { t: number; v: number }>()

/** 和上一次的计数相减，换算成每秒；第一次或计数回绕时为 null */
function perSec(key: string, v: number, now: number): number | null {
  const p = prevCounters.get(key)
  prevCounters.set(key, { t: now, v })
  if (!p || now <= p.t || v < p.v) return null
  return ((v - p.v) * 1000) / (now - p.t)
}

/** 每次采样后清掉这一轮没出现的计数（拔掉的 U 盘、断开的网卡） */
function pruneCounters(seen: Set<string>): void {
  for (const k of prevCounters.keys()) if (!seen.has(k)) prevCounters.delete(k)
}

/** 隔一段时间才需要刷新的数据 */
function cached<T>(ms: number, fn: () => Promise<T>): () => Promise<T> {
  let at = 0
  let value: Promise<T> | null = null
  return () => {
    if (!value || Date.now() - at > ms) {
      at = Date.now()
      value = fn()
    }
    return value
  }
}

/* ================================================================
 * Linux
 * ================================================================ */

async function linuxProcs(): Promise<{ processes: number | null; threads: number | null }> {
  const entries = await ls('/proc')
  const processes = entries.filter((e) => /^\d+$/.test(e)).length || null
  // /proc/loadavg 第四列是 “正在运行/全部” 的调度实体（线程）数
  const m = /\s\d+\/(\d+)\s/.exec(await read('/proc/loadavg'))
  return { processes, threads: m ? Number(m[1]) : null }
}

/** CPU 封装温度：优先 coretemp / k10temp，其次常见的 SoC 温区 */
const linuxCpuTempFile = cached(60_000, async (): Promise<string | null> => {
  const prefer = ['coretemp', 'k10temp', 'zenpower', 'cpu_thermal', 'soc_thermal', 'acpitz']
  let best: { rank: number; file: string } | null = null
  for (const h of await ls('/sys/class/hwmon')) {
    const dir = path.join('/sys/class/hwmon', h)
    const rank = prefer.indexOf((await read(path.join(dir, 'name'))).trim())
    if (rank < 0 || (best && best.rank <= rank)) continue
    // k10temp 的 temp1 是 Tctl，coretemp 的 temp1 是 Package，正好都是要的
    if ((await readNum(path.join(dir, 'temp1_input'))) != null) best = { rank, file: path.join(dir, 'temp1_input') }
  }
  if (best) return best.file
  for (const z of await ls('/sys/class/thermal')) {
    if (!z.startsWith('thermal_zone')) continue
    const type = (await read(`/sys/class/thermal/${z}/type`)).trim()
    if (/x86_pkg_temp|cpu|soc/i.test(type)) return `/sys/class/thermal/${z}/temp`
  }
  return null
})

async function linuxCpuTemp(): Promise<number | null> {
  const f = await linuxCpuTempFile()
  const v = f ? await readNum(f) : null
  return v != null && v > 0 ? v / 1000 : null
}

async function linuxMem(): Promise<UnixSample['mem']> {
  const kv = new Map<string, number>()
  for (const line of (await read('/proc/meminfo')).split('\n')) {
    const m = /^(\w+(?:\(\w+\))?):\s+(\d+)/.exec(line)
    if (m) kv.set(m[1], Number(m[2]) * 1024)
  }
  const g = (k: string): number | null => kv.get(k) ?? null
  const swapTotal = g('SwapTotal')
  const swapFree = g('SwapFree')
  const cachedBytes = g('Cached')
  return {
    free: g('MemAvailable'),
    committed: g('Committed_AS'),
    commitLimit: g('CommitLimit'),
    cached: cachedBytes != null ? cachedBytes + (g('Buffers') ?? 0) : null,
    swap: swapTotal && swapFree != null ? ((swapTotal - swapFree) / swapTotal) * 100 : null
  }
}

/** 整块磁盘（不是分区）：/sys/block 下排除虚拟设备 */
async function linuxBlockDevices(): Promise<string[]> {
  return (await ls('/sys/block')).filter((d) => !/^(loop|ram|zram|fd|sr|nbd)/.test(d))
}

/** 分区或 device-mapper 设备所在的整块磁盘 */
async function linuxParentDisk(dev: string, disks: Set<string>, depth = 0): Promise<string | null> {
  if (disks.has(dev) && !dev.startsWith('dm-')) return dev
  if (depth > 4) return null
  // LVM / LUKS：dm-N 的 slaves 是它下面的分区
  const slaves = await ls(`/sys/class/block/${dev}/slaves`)
  if (slaves.length) return linuxParentDisk(slaves[0], disks, depth + 1)
  try {
    // /sys/class/block/nvme0n1p2 → …/nvme0n1/nvme0n1p2
    const real = await fs.realpath(`/sys/class/block/${dev}`)
    const parent = path.basename(path.dirname(real))
    return disks.has(parent) ? parent : null
  } catch {
    return null
  }
}

const linuxVolumes = cached(5000, async (): Promise<Map<string, { mount: string; total: number; free: number }[]>> => {
  const disks = new Set(await linuxBlockDevices())
  const byDisk = new Map<string, { mount: string; total: number; free: number }[]>()
  const seenDev = new Set<string>()
  for (const line of (await read('/proc/mounts')).split('\n')) {
    const [src, mnt] = line.split(' ')
    if (!src?.startsWith('/dev/') || !mnt) continue
    let dev: string
    try {
      dev = path.basename(await fs.realpath(src))
    } catch {
      continue
    }
    // 同一个分区挂了好几次（bind mount、btrfs 子卷）只算一次
    if (seenDev.has(dev)) continue
    seenDev.add(dev)
    const disk = await linuxParentDisk(dev, disks)
    const cap = disk ? await capacity(mnt.replace(/\\040/g, ' ')) : null
    if (!disk || !cap) continue
    const list = byDisk.get(disk) ?? []
    list.push({ mount: mnt.replace(/\\040/g, ' '), ...cap })
    byDisk.set(disk, list)
  }
  return byDisk
})

const linuxDiskNames = cached(60_000, async (): Promise<Map<string, string>> => {
  const map = new Map<string, string>()
  for (const d of await linuxBlockDevices()) {
    const model = (await read(`/sys/block/${d}/device/model`)).trim()
    map.set(d, model ? `${d} (${model})` : d)
  }
  return map
})

async function linuxDisks(now: number, seen: Set<string>): Promise<SysDisk[]> {
  const disks = new Set(await linuxBlockDevices())
  const [vols, names] = await Promise.all([linuxVolumes(), linuxDiskNames()])
  const out: SysDisk[] = []
  for (const line of (await read('/proc/diskstats')).split('\n')) {
    const f = line.trim().split(/\s+/)
    const name = f[2]
    if (!name || !disks.has(name)) continue
    // 字段：读完成 读合并 读扇区 读耗时 写完成 写合并 写扇区 写耗时 进行中 IO 耗时(ms) …；扇区固定 512 字节
    const readBytes = Number(f[5]) * 512
    const writeBytes = Number(f[9]) * 512
    const ioMs = Number(f[12])
    // 没挂载也没有读写过的设备（空读卡器等）不显示
    if (!vols.has(name) && readBytes === 0 && writeBytes === 0) continue
    for (const k of ['r', 'w', 'a']) seen.add(`disk:${k}:${name}`)
    const active = perSec(`disk:a:${name}`, ioMs, now)
    out.push({
      name: names.get(name) ?? name,
      active: active != null ? Math.min(100, active / 10) : null,
      read: perSec(`disk:r:${name}`, readBytes, now),
      write: perSec(`disk:w:${name}`, writeBytes, now),
      volumes: vols.get(name) ?? []
    })
  }
  return out
}

async function linuxNets(now: number, seen: Set<string>): Promise<SysNet[]> {
  const out: SysNet[] = []
  for (const line of (await read('/proc/net/dev')).split('\n')) {
    const m = /^\s*([^:\s]+):\s*(.*)$/.exec(line)
    if (!m || m[1] === 'lo') continue
    const name = m[1]
    const f = m[2].trim().split(/\s+/).map(Number)
    const rxBytes = f[0]
    const txBytes = f[8]
    const dir = `/sys/class/net/${name}`
    const physical = (await ls(`${dir}/device`)).length > 0
    const up = (await read(`${dir}/operstate`)).trim() === 'up'
    seen.add(`net:r:${name}`)
    seen.add(`net:t:${name}`)
    const rx = perSec(`net:r:${name}`, rxBytes, now) ?? 0
    const tx = perSec(`net:t:${name}`, txBytes, now) ?? 0
    // docker0、veth、虚拟网桥等没有物理设备，没流量时不显示
    if (!up || (!physical && rx === 0 && tx === 0)) continue
    const speed = await readNum(`${dir}/speed`)
    out.push({ name, rx, tx, bandwidth: speed != null && speed > 0 ? speed * 1e6 : 0 })
  }
  return out
}

let nvidiaMissing = false

async function nvidiaGpus(): Promise<SysGpu[]> {
  if (nvidiaMissing) return []
  const out = await run('nvidia-smi', [
    '--query-gpu=uuid,name,utilization.gpu,memory.used,memory.total,temperature.gpu,utilization.encoder,utilization.decoder',
    '--format=csv,noheader,nounits'
  ])
  if (!out.trim()) {
    nvidiaMissing = true
    return []
  }
  const num = (s: string | undefined): number | null => {
    const n = Number(s?.trim())
    return s && isFinite(n) ? n : null
  }
  return out
    .trim()
    .split('\n')
    .map((line): SysGpu => {
      const f = line.split(',')
      const engines: Record<string, number> = {}
      const util = num(f[2])
      if (util != null) engines['3D'] = util
      const enc = num(f[6])
      const dec = num(f[7])
      if (enc != null) engines.VideoEncode = enc
      if (dec != null) engines.VideoDecode = dec
      const used = num(f[3])
      const total = num(f[4])
      return {
        id: f[0].trim(),
        name: f[1].trim(),
        npu: false,
        util,
        engines,
        dedicatedUsed: used != null ? used * 1024 * 1024 : null,
        dedicatedTotal: total != null ? total * 1024 * 1024 : 0,
        sharedUsed: null,
        sharedTotal: 0,
        temp: num(f[5])
      }
    })
}

/** AMD（amdgpu 驱动）在 sysfs 里直接给出占用和显存 */
async function amdGpus(): Promise<SysGpu[]> {
  const out: SysGpu[] = []
  for (const card of await ls('/sys/class/drm')) {
    if (!/^card\d+$/.test(card)) continue
    const dev = `/sys/class/drm/${card}/device`
    if ((await read(`${dev}/vendor`)).trim() !== '0x1002') continue
    const busy = await readNum(`${dev}/gpu_busy_percent`)
    const vramUsed = await readNum(`${dev}/mem_info_vram_used`)
    const vramTotal = await readNum(`${dev}/mem_info_vram_total`)
    const gttUsed = await readNum(`${dev}/mem_info_gtt_used`)
    const gttTotal = await readNum(`${dev}/mem_info_gtt_total`)
    let temp: number | null = null
    for (const h of await ls(`${dev}/hwmon`)) {
      const v = await readNum(`${dev}/hwmon/${h}/temp1_input`)
      if (v != null) temp = v / 1000
    }
    const product = (await read(`${dev}/product_name`)).trim()
    out.push({
      id: card,
      name: product || 'AMD Radeon',
      npu: false,
      util: busy,
      engines: busy != null ? { '3D': busy } : {},
      dedicatedUsed: vramUsed,
      dedicatedTotal: vramTotal ?? 0,
      sharedUsed: gttUsed,
      sharedTotal: gttTotal ?? 0,
      temp
    })
  }
  return out
}

async function linuxSample(): Promise<UnixSample> {
  const now = Date.now()
  const seen = new Set<string>()
  const [procs, temp, mem, disks, nets, nv, amd] = await Promise.all([
    linuxProcs(),
    linuxCpuTemp(),
    linuxMem(),
    linuxDisks(now, seen),
    linuxNets(now, seen),
    nvidiaGpus(),
    amdGpus()
  ])
  pruneCounters(seen)
  return { cpu: { ...procs, temp }, mem, gpus: [...nv, ...amd], disks, nets }
}

/* ================================================================
 * macOS
 * ================================================================ */

type Plist = string | number | boolean | Plist[] | { [k: string]: Plist }

/** 解析 ioreg -a / diskutil -plist 输出的 XML plist（只处理用得到的标签） */
export function parsePlist(xml: string): Plist | null {
  const re = /<(\/?)(\w+)\s*(\/?)>|([^<]+)/g
  const stack: { node: Plist[] | Record<string, Plist>; key: string | null }[] = []
  let root: Plist | null = null
  let text = ''
  let leaf: string | null = null
  const put = (v: Plist): void => {
    const top = stack[stack.length - 1]
    if (!top) {
      root = v
      return
    }
    if (Array.isArray(top.node)) top.node.push(v)
    else if (top.key != null) {
      top.node[top.key] = v
      top.key = null
    }
  }
  let m: RegExpExecArray | null
  while ((m = re.exec(xml))) {
    if (m[4] != null) {
      if (leaf) text += m[4]
      continue
    }
    const [, close, tag, selfClose] = m
    if (tag === 'plist' || tag === 'xml') continue
    if (selfClose) {
      if (tag === 'true' || tag === 'false') put(tag === 'true')
      else if (tag === 'dict') put({})
      else if (tag === 'array') put([])
      else if (tag === 'string' || tag === 'data') put('')
      continue
    }
    if (!close) {
      if (tag === 'dict' || tag === 'array') stack.push({ node: tag === 'dict' ? {} : [], key: null })
      else {
        leaf = tag
        text = ''
      }
      continue
    }
    if (tag === 'dict' || tag === 'array') {
      const done = stack.pop()
      if (done) put(done.node)
      continue
    }
    const v = text
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&amp;/g, '&')
    leaf = null
    if (tag === 'key') {
      const top = stack[stack.length - 1]
      if (top && !Array.isArray(top.node)) top.key = v
    } else if (tag === 'integer' || tag === 'real') put(Number(v))
    else if (tag === 'data') {
      // 显卡型号等以 data 形式给出：base64 编码的 C 字符串
      try {
        put(Buffer.from(v.replace(/\s+/g, ''), 'base64').toString('utf8').replace(/\0+$/, ''))
      } catch {
        put('')
      }
    } else put(v)
  }
  return root
}

const asDict = (v: Plist | undefined): Record<string, Plist> | null => (v && typeof v === 'object' && !Array.isArray(v) ? v : null)
const asNum = (v: Plist | undefined): number | null => (typeof v === 'number' && isFinite(v) ? v : null)
const asStr = (v: Plist | undefined): string => (typeof v === 'string' ? v : '')

async function ioreg(cls: string, depth: number): Promise<Record<string, Plist>[]> {
  const p = parsePlist(await run('ioreg', ['-a', '-r', '-d', String(depth), '-w', '0', '-c', cls]))
  return Array.isArray(p) ? (p.map(asDict).filter(Boolean) as Record<string, Plist>[]) : []
}

async function macProcs(): Promise<number | null> {
  const out = await run('ps', ['-A', '-o', 'pid='])
  const n = out.split('\n').filter((l) => l.trim()).length
  return n || null
}

async function macMem(): Promise<UnixSample['mem']> {
  const [vm, swap] = await Promise.all([run('vm_stat', []), run('sysctl', ['-n', 'vm.swapusage'])])
  const pageSize = Number(/page size of (\d+) bytes/.exec(vm)?.[1] ?? 4096)
  const pages = (label: string): number | null => {
    const m = new RegExp(`^${label}:\\s+(\\d+)`, 'm').exec(vm)
    return m ? Number(m[1]) * pageSize : null
  }
  // 和“活动监视器”的“已使用内存”一致：App 内存 + 联动内存 + 已压缩
  const anon = pages('Anonymous pages')
  const purgeable = pages('Pages purgeable') ?? 0
  const wired = pages('Pages wired down')
  const compressed = pages('Pages occupied by compressor') ?? 0
  const app = anon != null ? anon - purgeable : pages('Pages active')
  const used = app != null && wired != null ? app + wired + compressed : null
  const sw = /total = ([\d.]+)M\s+used = ([\d.]+)M/.exec(swap)
  const swapTotal = sw ? Number(sw[1]) : 0
  return {
    free: used != null ? Math.max(0, os.totalmem() - used) : null,
    committed: null,
    commitLimit: null,
    cached: pages('File-backed pages'),
    swap: swapTotal > 0 ? (Number(sw![2]) / swapTotal) * 100 : null
  }
}

/** APFS 容器（disk3）→ 所在的物理磁盘（disk0） */
const macApfsStores = cached(60_000, async (): Promise<Map<string, string>> => {
  const map = new Map<string, string>()
  const root = asDict(parsePlist(await run('diskutil', ['apfs', 'list', '-plist'], 5000)) ?? undefined)
  const containers = root?.Containers
  if (!Array.isArray(containers)) return map
  for (const c of containers) {
    const d = asDict(c)
    const ref = asStr(d?.ContainerReference)
    const stores = d?.PhysicalStores
    const first = Array.isArray(stores) ? asStr(asDict(stores[0])?.DeviceIdentifier) : ''
    if (ref && first) map.set(ref, first.replace(/s\d+$/, ''))
  }
  return map
})

const macVolumes = cached(5000, async (): Promise<Map<string, { mount: string; total: number; free: number }[]>> => {
  const stores = await macApfsStores()
  const byDisk = new Map<string, { mount: string; total: number; free: number }[]>()
  const lines = (await run('df', ['-k', '-l'])).split('\n').slice(1)
  for (const line of lines) {
    const m = /^\/dev\/(disk\d+)\S*\s+(\d+)\s+\d+\s+(\d+)\s+\d+%\s+(?:\d+\s+\d+\s+\d+%\s+)?(.+)$/.exec(line)
    if (!m) continue
    const mount = m[4].trim()
    // 系统卷宗的各个辅助卷和 “/” 共享同一个容器，重复显示没有意义
    if (mount.startsWith('/System/Volumes/') || mount.startsWith('/Library/Developer/CoreSimulator')) continue
    const disk = stores.get(m[1]) ?? m[1]
    const list = byDisk.get(disk) ?? []
    list.push({ mount, total: Number(m[2]) * 1024, free: Number(m[3]) * 1024 })
    byDisk.set(disk, list)
  }
  return byDisk
})

async function macDisks(now: number, seen: Set<string>): Promise<SysDisk[]> {
  const [drivers, vols] = await Promise.all([ioreg('IOBlockStorageDriver', 2), macVolumes()])
  const out: SysDisk[] = []
  for (const d of drivers) {
    const stats = asDict(d.Statistics)
    const children = Array.isArray(d.IORegistryEntryChildren) ? d.IORegistryEntryChildren.map(asDict) : []
    const media = children.find((c) => c && asStr(c['BSD Name']))
    const bsd = asStr(media?.['BSD Name'])
    if (!stats || !bsd) continue
    // 磁盘映像、APFS 合成盘之类不是真正的硬件
    if (media?.['Whole'] === false) continue
    const readBytes = asNum(stats['Bytes (Read)']) ?? 0
    const writeBytes = asNum(stats['Bytes (Write)']) ?? 0
    const busyNs = (asNum(stats['Total Time (Read)']) ?? 0) + (asNum(stats['Total Time (Write)']) ?? 0)
    for (const k of ['r', 'w', 'a']) seen.add(`disk:${k}:${bsd}`)
    const active = perSec(`disk:a:${bsd}`, busyNs, now)
    const model = asStr(media?.['IOMediaName'] ?? media?.['IORegistryEntryName']).replace(/\s*Media$/, '')
    out.push({
      name: model ? `${bsd} (${model})` : bsd,
      active: active != null ? Math.min(100, active / 1e7) : null,
      read: perSec(`disk:r:${bsd}`, readBytes, now),
      write: perSec(`disk:w:${bsd}`, writeBytes, now),
      volumes: vols.get(bsd) ?? []
    })
  }
  return out
}

async function macNets(now: number, seen: Set<string>): Promise<SysNet[]> {
  const out: SysNet[] = []
  const lines = (await run('netstat', ['-ib', '-n'])).split('\n')
  const head = lines[0]?.trim().split(/\s+/) ?? []
  const iIn = head.indexOf('Ibytes')
  const iOut = head.indexOf('Obytes')
  if (iIn < 0 || iOut < 0) return out
  for (const line of lines.slice(1)) {
    const f = line.trim().split(/\s+/)
    // 每块网卡的第一行是链路层统计（Network 列为 <Link#N>）
    if (!f[2]?.startsWith('<Link#')) continue
    const name = f[0].replace(/\*$/, '')
    if (/^(lo|utun|awdl|llw|gif|stf|anpi|ap|bridge|XHC)\d*/.test(name)) continue
    // 没有 MAC 地址的行少一列，按列名取会错位
    const shift = /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/i.test(f[3] ?? '') ? 0 : -1
    const rxBytes = Number(f[iIn + shift])
    const txBytes = Number(f[iOut + shift])
    if (!isFinite(rxBytes) || !isFinite(txBytes) || (rxBytes === 0 && txBytes === 0)) continue
    seen.add(`net:r:${name}`)
    seen.add(`net:t:${name}`)
    out.push({ name, rx: perSec(`net:r:${name}`, rxBytes, now) ?? 0, tx: perSec(`net:t:${name}`, txBytes, now) ?? 0, bandwidth: 0 })
  }
  return out
}

async function macGpus(): Promise<SysGpu[]> {
  const out: SysGpu[] = []
  const accels = await ioreg('IOAccelerator', 1)
  accels.forEach((a, i) => {
    const perf = asDict(a.PerformanceStatistics)
    if (!perf) return
    const util = asNum(perf['Device Utilization %']) ?? asNum(perf['GPU Activity(%)'])
    const renderer = asNum(perf['Renderer Utilization %'])
    const engines: Record<string, number> = {}
    if (renderer != null) engines['3D'] = renderer
    else if (util != null) engines['3D'] = util
    const vramUsed = asNum(perf['vramUsedBytes'])
    const vramFree = asNum(perf['vramFreeBytes'])
    const sysUsed = asNum(perf['In use system memory'])
    const appleSilicon = os.arch() === 'arm64'
    const name = asStr(a.model) || (appleSilicon ? `${os.cpus()[0]?.model ?? 'Apple'} GPU` : asStr(a.IOClass) || 'GPU')
    out.push({
      id: `${asStr(a.IOClass)}:${i}`,
      name,
      npu: false,
      util,
      engines,
      dedicatedUsed: vramUsed,
      dedicatedTotal: vramUsed != null && vramFree != null ? vramUsed + vramFree : 0,
      // Apple 芯片是统一内存，显卡用的就是系统内存
      sharedUsed: sysUsed,
      sharedTotal: sysUsed != null ? os.totalmem() : 0,
      temp: null
    })
  })
  return out
}

async function macSample(): Promise<UnixSample> {
  const now = Date.now()
  const seen = new Set<string>()
  const [processes, mem, disks, nets, gpus] = await Promise.all([macProcs(), macMem(), macDisks(now, seen), macNets(now, seen), macGpus()])
  pruneCounters(seen)
  // 温度要 sudo powermetrics 才读得到，这里不做
  return { cpu: { processes, threads: null, temp: null }, mem, gpus, disks, nets }
}

/* ---------------- 入口 ---------------- */

let busy = false
let last: UnixSample | null = null

/**
 * 取一份采样。上一次还没跑完（命令卡住）时直接返回上一次的结果，
 * 不让采样进程越堆越多。
 */
export async function unixSample(): Promise<UnixSample | null> {
  if (process.platform !== 'linux' && !isMac) return null
  if (busy) return last
  busy = true
  try {
    last = await (isMac ? macSample() : linuxSample())
  } catch {
    /* 下次再试 */
  } finally {
    busy = false
  }
  return last
}

export function resetUnixSample(): void {
  prevCounters.clear()
  last = null
}
