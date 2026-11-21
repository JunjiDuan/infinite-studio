// 生成自绘安装程序 installer/InfiniteStudio-Setup-<version>.exe
//
// 前提：electron-builder --dir 已经生成 release/win-unpacked。
// 步骤：打包应用文件为 payload.zip → 生成 .ico → 用 Windows 自带的 .NET Framework csc 编译
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

/* 1. 应用文件 → payload.zip（Windows 自带的 bsdtar 支持写 zip） */
function dirSize(d) {
  let n = 0
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name)
    n += e.isDirectory() ? dirSize(p) : fs.statSync(p).size
  }
  return n
}
const sizeKB = Math.ceil(dirSize(unpacked) / 1024)
const payload = path.join(work, 'payload.zip')
console.log('打包应用文件…')
execFileSync(path.join(winDir, 'System32', 'tar.exe'), ['-a', '-c', '-f', payload, '-C', unpacked, '.'], { stdio: 'inherit' })
console.log(`payload.zip ${(fs.statSync(payload).size / 1048576).toFixed(1)} MB（解压后 ${(sizeKB / 1024).toFixed(0)} MB）`)

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
  path.join(fw, 'System.Xaml.dll'),
  path.join(fw, 'System.IO.Compression.dll')
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
compile(setup, ['/define:SETUP', `/resource:${uninstaller},uninstall.exe`, `/resource:${payload},payload.zip`])

/* 5. 放到 release/ 和 installer/ */
const releaseOut = path.join(root, 'release', outName)
fs.copyFileSync(setup, releaseOut)
const instDir = path.join(root, 'installer')
fs.mkdirSync(instDir, { recursive: true })
fs.copyFileSync(setup, path.join(instDir, outName))
fs.rmSync(work, { recursive: true, force: true })
console.log(`安装程序：installer/${outName}（${(fs.statSync(releaseOut).size / 1048576).toFixed(1)} MB）`)
