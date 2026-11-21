// 生成自绘安装程序 installer/InfiniteStudio-Setup-<version>.exe
//
// 前提：electron-builder --dir 已经生成 release/win-unpacked。
// 步骤：打包应用文件为 payload.lzma → 生成 .ico → 用 Windows 自带的 .NET Framework csc 编译
//       卸载程序和安装程序（build/setup/Setup.cs + Setup.xaml），安装程序内嵌 payload 和卸载程序。
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const pkg = require(path.join(root, 'package.json'))
const version = pkg.version
const unpacked = path.join(root, 'release', 'win-unpacked')
const work = path.join(root, 'release', '.setup')
const src = path.join(root, 'build', 'setup')
const outName = `InfiniteStudio-Setup-${version}.exe`

if (process.platform !== 'win32') {
  console.error('安装程序只能在 Windows 上生成')
  process.exit(1)
}
if (!fs.existsSync(path.join(unpacked, 'Infinite Studio.exe'))) {
  console.error(`找不到 ${unpacked}，请先运行 electron-builder --dir`)
  process.exit(1)
}

const winDir = process.env.WINDIR || 'C:\\Windows'
const fw = path.join(winDir, 'Microsoft.NET', 'Framework64', 'v4.0.30319')
const csc = path.join(fw, 'csc.exe')
if (!fs.existsSync(csc)) {
  console.error('找不到 .NET Framework 4 的 csc.exe')
  process.exit(1)
}

fs.rmSync(work, { recursive: true, force: true })
fs.mkdirSync(work, { recursive: true })

/* 1. 应用文件 → payload.lzma
 *    先写成简单的归档 payload.bin（不用 tar/zip：没有路径长度和文件名编码的限制），再用 xz 压成 LZMA。
 *    格式（小端）："ISPK" + 版本 1（1 字节）+ 文件总字节数（int64），然后逐项：
 *      类型（1 字节：1 文件 / 2 目录 / 0 结束）+ 路径长度（uint16）+ UTF-8 路径（/ 分隔），
 *      文件再跟 大小（int64）+ 内容。安装程序（build/setup/Setup.cs + Lzma.cs）边解压边读。 */
function findXz() {
  const candidates = []
  if (process.env.XZ) candidates.push(process.env.XZ)
  try {
    const out = execFileSync('where.exe', ['xz'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    candidates.push(...out.split(/\r?\n/).filter(Boolean))
  } catch {}
  for (const base of [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], path.join(process.env.LOCALAPPDATA || '', 'Programs')]) {
    if (!base) continue
    candidates.push(path.join(base, 'Git', 'mingw64', 'bin', 'xz.exe'), path.join(base, 'Git', 'usr', 'bin', 'xz.exe'))
  }
  return candidates.find((c) => fs.existsSync(c))
}
const xz = findXz()
if (!xz) {
  console.error('找不到 xz.exe（Git for Windows 自带）。安装 Git for Windows，或用环境变量 XZ 指定 xz.exe 的路径')
  process.exit(1)
}

const entries = []
function walk(d, rel) {
  for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const p = path.join(d, e.name)
    const r = rel ? `${rel}/${e.name}` : e.name
    if (e.isDirectory()) {
      entries.push({ type: 2, rel: r })
      walk(p, r)
    } else entries.push({ type: 1, rel: r, abs: p, size: fs.statSync(p).size })
  }
}
walk(unpacked, '')
const totalBytes = entries.reduce((n, e) => n + (e.size || 0), 0)
const sizeKB = Math.ceil(totalBytes / 1024)

const raw = path.join(work, 'payload.bin')
const payload = path.join(work, 'payload.lzma')
console.log('打包应用文件…')
{
  const fd = fs.openSync(raw, 'w')
  const head = Buffer.alloc(13)
  head.write('ISPK', 0, 'ascii')
  head.writeUInt8(1, 4)
  head.writeBigInt64LE(BigInt(totalBytes), 5)
  fs.writeSync(fd, head)
  const chunk = Buffer.alloc(1 << 20)
  for (const e of entries) {
    const name = Buffer.from(e.rel, 'utf8')
    const h = Buffer.alloc(3 + (e.type === 1 ? 8 : 0))
    h.writeUInt8(e.type, 0)
    h.writeUInt16LE(name.length, 1)
    fs.writeSync(fd, h.subarray(0, 3))
    fs.writeSync(fd, name)
    if (e.type !== 1) continue
    h.writeBigInt64LE(BigInt(e.size), 3)
    fs.writeSync(fd, h.subarray(3))
    const src = fs.openSync(e.abs, 'r')
    let n
    while ((n = fs.readSync(src, chunk, 0, chunk.length, null)) > 0) fs.writeSync(fd, chunk, 0, n)
    fs.closeSync(src)
  }
  fs.writeSync(fd, Buffer.from([0]))
  fs.closeSync(fd)
}
console.log('LZMA 压缩（几分钟）…')
{
  const out = fs.openSync(payload, 'w')
  execFileSync(xz, ['--format=lzma', '-9', '-c', raw], { stdio: ['ignore', out, 'inherit'] })
  fs.closeSync(out)
}
fs.rmSync(raw)
console.log(`payload.lzma ${(fs.statSync(payload).size / 1048576).toFixed(1)} MB（解压后 ${(sizeKB / 1024).toFixed(0)} MB）`)

/* 2. build/icon.png → app.ico（PNG 压缩的图标项：256 / 64 / 48 / 32 / 16） */
const ico = path.join(work, 'app.ico')
const sizes = [256, 64, 48, 32, 16]
const ps = `
Add-Type -AssemblyName System.Drawing
$src = [System.Drawing.Image]::FromFile('${path.join(root, 'build', 'icon.png').replace(/'/g, "''")}')
foreach ($s in @(${sizes.join(',')})) {
  $bmp = New-Object System.Drawing.Bitmap $s, $s
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.DrawImage($src, 0, 0, $s, $s)
  $bmp.Save('${work.replace(/'/g, "''")}\\icon-' + $s + '.png', [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
}
$src.Dispose()
`
execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { stdio: 'inherit' })
const images = sizes.map((s) => fs.readFileSync(path.join(work, `icon-${s}.png`)))
const header = Buffer.alloc(6 + 16 * sizes.length)
header.writeUInt16LE(0, 0)
header.writeUInt16LE(1, 2)
header.writeUInt16LE(sizes.length, 4)
let offset = header.length
sizes.forEach((s, i) => {
  const e = 6 + i * 16
  header.writeUInt8(s >= 256 ? 0 : s, e)
  header.writeUInt8(s >= 256 ? 0 : s, e + 1)
  header.writeUInt8(0, e + 2)
  header.writeUInt8(0, e + 3)
  header.writeUInt16LE(1, e + 4)
  header.writeUInt16LE(32, e + 6)
  header.writeUInt32LE(images[i].length, e + 8)
  header.writeUInt32LE(offset, e + 12)
  offset += images[i].length
})
fs.writeFileSync(ico, Buffer.concat([header, ...images]))

/* 3. 版本等常量 */
const year = new Date().getFullYear()
const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')
fs.writeFileSync(
  path.join(work, 'BuildInfo.cs'),
  `// 由 scripts/build-installer.cjs 生成
static class BuildInfo
{
    public const string Version = "${esc(version)}";
    public const string Publisher = "${esc(pkg.author || 'Infinite Studio')}";
    public const string Copyright = "${esc(pkg.build?.copyright || `Copyright © ${year} ${pkg.author}`)}";
    public const string Homepage = "${esc(pkg.homepage || '')}";
    public const string AppId = "${esc(pkg.build?.appId || 'studio.infinite.ide')}";
    public const long SizeKB = ${sizeKB};
}
`
)

/* 4. 编译 */
const refs = [
  path.join(fw, 'WPF', 'PresentationFramework.dll'),
  path.join(fw, 'WPF', 'PresentationCore.dll'),
  path.join(fw, 'WPF', 'WindowsBase.dll'),
  path.join(fw, 'System.Xaml.dll')
].map((r) => `/reference:${r}`)

function compile(out, extra) {
  const args = [
    '/nologo',
    '/target:winexe',
    '/platform:anycpu',
    '/optimize+',
    '/codepage:65001',
    `/win32icon:${ico}`,
    `/win32manifest:${path.join(src, 'app.manifest')}`,
    `/out:${out}`,
    ...refs,
    `/resource:${path.join(src, 'Setup.xaml')},Setup.xaml`,
    ...extra,
    path.join(src, 'Setup.cs'),
    path.join(work, 'BuildInfo.cs')
  ]
  execFileSync(csc, args, { stdio: 'inherit' })
}

console.log('编译卸载程序…')
const uninstaller = path.join(work, 'uninstall.exe')
compile(uninstaller, [])

console.log('编译安装程序…')
const setup = path.join(work, outName)
compile(setup, [
  '/define:SETUP',
  `/resource:${uninstaller},uninstall.exe`,
  `/resource:${payload},payload.lzma`,
  path.join(src, 'Lzma.cs')
])

/* 5. 放到 release/ 和 installer/ */
const releaseOut = path.join(root, 'release', outName)
fs.copyFileSync(setup, releaseOut)
const instDir = path.join(root, 'installer')
fs.mkdirSync(instDir, { recursive: true })
fs.copyFileSync(setup, path.join(instDir, outName))
fs.rmSync(work, { recursive: true, force: true })
console.log(`安装程序：installer/${outName}（${(fs.statSync(releaseOut).size / 1048576).toFixed(1)} MB）`)
