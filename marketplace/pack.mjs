#!/usr/bin/env node
/**
 * 打包插件并更新 registry.json
 *
 *   node marketplace/pack.mjs             打包全部插件到 marketplace/packages/
 *   node marketplace/pack.mjs mindmap     只打包 mindmap
 *
 * 打包后提交并推送 marketplace/ 即完成发布：IDE 从 jsDelivr（备用 raw.githubusercontent）下载插件包。
 * 插件包不放 GitHub Releases —— 那里是 IDE 自己的版本，IDE 的“检查更新”读的是最新 Release。
 *
 * 需要 Node.js 22 或更高版本。
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { crc32, deflateRawSync } from 'node:zlib'

const ROOT = path.dirname(fileURLToPath(import.meta.url))
const REPO = 'JunjiDuan/infinite-studio'
/** marketplace/ 在仓库里的路径 */
const BASE = 'marketplace'
const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/

const ids = process.argv.slice(2).filter((a) => !a.startsWith('--'))

/* ---------------- zip ---------------- */

/** 固定时间戳，保证内容不变时打出来的包一模一样（sha256 不变） */
const DOS_TIME = 0
const DOS_DATE = (2026 - 1980) << 9 | 1 << 5 | 1

function zip(files) {
  const locals = []
  const centrals = []
  let offset = 0
  for (const { name, data } of files) {
    const nameBuf = Buffer.from(name, 'utf8')
    const deflated = deflateRawSync(data, { level: 9 })
    const useDeflate = deflated.length < data.length
    const body = useDeflate ? deflated : data
    const crc = crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6) // UTF-8 文件名
    local.writeUInt16LE(useDeflate ? 8 : 0, 8)
    local.writeUInt16LE(DOS_TIME, 10)
    local.writeUInt16LE(DOS_DATE, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    local.writeUInt16LE(0, 28)
    locals.push(local, nameBuf, body)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(useDeflate ? 8 : 0, 10)
    central.writeUInt16LE(DOS_TIME, 12)
    central.writeUInt16LE(DOS_DATE, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(body.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(nameBuf.length, 28)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, nameBuf)
    offset += 30 + nameBuf.length + body.length
  }
  const cdSize = centrals.reduce((s, b) => s + b.length, 0)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(files.length, 8)
  end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(cdSize, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, ...centrals, end])
}

/* ---------------- 打包 ---------------- */

function walk(dir, base = '') {
  const out = []
  for (const name of readdirSync(dir).sort()) {
    if (name.startsWith('.') || name === 'node_modules') continue
    const full = path.join(dir, name)
    const rel = base ? `${base}/${name}` : name
    if (statSync(full).isDirectory()) out.push(...walk(full, rel))
    else out.push({ name: rel, data: readFileSync(full) })
  }
  return out
}

function fail(msg) {
  console.error(`✖ ${msg}`)
  process.exit(1)
}

function pack(id) {
  const dir = path.join(ROOT, 'plugins', id)
  const manifestFile = path.join(dir, 'manifest.json')
  if (!existsSync(manifestFile)) fail(`plugins/${id}/manifest.json 不存在`)
  const m = JSON.parse(readFileSync(manifestFile, 'utf8'))
  if (m.id !== id || !ID_RE.test(id)) fail(`plugins/${id}: manifest.json 的 id 必须是 "${id}"（小写字母、数字、连字符）`)
  if (!/^\d+\.\d+\.\d+$/.test(m.version)) fail(`${id}: version 必须是 x.y.z 格式`)
  if (m.editor && !existsSync(path.join(dir, m.editor.entry))) fail(`${id}: 找不到编辑器入口 ${m.editor.entry}`)

  const files = walk(dir)
  // SDK 统一从 sdk/ 复制，插件目录里不用放
  if (!files.some((f) => f.name === 'studio.js')) files.push({ name: 'studio.js', data: readFileSync(path.join(ROOT, 'sdk', 'studio.js')) })
  files.sort((a, b) => a.name.localeCompare(b.name))

  const buf = zip(files)
  mkdirSync(path.join(ROOT, 'packages'), { recursive: true })
  const fileName = `${id}-${m.version}.zip`
  const out = path.join(ROOT, 'packages', fileName)
  // 同一个版本号的包发布后不能再变：CDN 会缓存旧文件，用户那边 sha256 对不上就装不了
  if (existsSync(out) && Buffer.compare(readFileSync(out), buf) !== 0) {
    fail(`${id} v${m.version} 的内容变了，请先把 manifest.json 里的 version 改成新版本号`)
  }
  writeFileSync(out, buf)
  const sha256 = createHash('sha256').update(buf).digest('hex')
  console.log(`✔ packages/${fileName}  ${(buf.length / 1024).toFixed(1)} KB  sha256 ${sha256.slice(0, 12)}…`)
  const rel = `${BASE}/packages/${fileName}`
  return {
    entry: {
      id,
      name: m.name,
      version: m.version,
      publisher: m.publisher ?? '',
      description: m.description ?? '',
      category: m.category ?? 'productivity',
      homepage: m.homepage,
      minStudio: m.minStudio,
      // jsDelivr 在国内更快；刚推送时它可能还没有这个文件，IDE 会接着试 raw.githubusercontent
      urls: [`https://cdn.jsdelivr.net/gh/${REPO}@main/${rel}`, `https://raw.githubusercontent.com/${REPO}/main/${rel}`],
      sha256,
      size: buf.length
    }
  }
}

/* ---------------- main ---------------- */

const all = readdirSync(path.join(ROOT, 'plugins')).filter((d) => existsSync(path.join(ROOT, 'plugins', d, 'manifest.json')))
const targets = ids.length ? ids : all
for (const id of targets) if (!all.includes(id)) fail(`没有插件 ${id}（可选：${all.join(', ')}）`)

const registryFile = path.join(ROOT, 'registry.json')
const registry = existsSync(registryFile) ? JSON.parse(readFileSync(registryFile, 'utf8')) : { schema: 1, plugins: [] }
const results = targets.map(pack)

for (const r of results) {
  const i = registry.plugins.findIndex((p) => p.id === r.entry.id)
  if (i >= 0) registry.plugins[i] = r.entry
  else registry.plugins.push(r.entry)
}
registry.plugins.sort((a, b) => a.id.localeCompare(b.id))
registry.updated = new Date().toISOString()
writeFileSync(registryFile, JSON.stringify(registry, null, 2) + '\n')
console.log('✔ registry.json 已更新')

console.log('下一步：提交并推送 marketplace/（registry.json 和 packages/ 都要提交），IDE 里点“重新检测”即可看到。')
