// 生成应用图标 build/icon.png（512×512）。用 Electron 离屏渲染 SVG，不依赖额外的图像工具。
// 运行：node scripts/run-electron.cjs scripts/make-icon.cjs
// （更大的尺寸会被屏幕可用高度截断，512 对 Windows 图标已足够）
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const SIZE = 512
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 24 24">
  <rect x="1" y="1" width="22" height="22" rx="5.2" fill="#0E0E10"/>
  <rect x="1.25" y="1.25" width="21.5" height="21.5" rx="5" fill="none" stroke="#26262B" stroke-width="0.5"/>
  <path transform="translate(12 12) scale(0.72) translate(-12 -12)" d="M6.5 8.5c-1.9 0-3 1.4-3 3.5s1.1 3.5 3 3.5c3.5 0 7.5-7 11-7 1.9 0 3 1.4 3 3.5s-1.1 3.5-3 3.5c-3.5 0-7.5-7-11-7z"
        fill="none" stroke="#E7E5E0" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`
const html = `<html><body style="margin:0;background:transparent">${svg}</body></html>`

app.disableHardwareAcceleration()
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: SIZE, height: SIZE, useContentSize: true, show: false, transparent: true, frame: false, webPreferences: { offscreen: true } })
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
  await new Promise((r) => setTimeout(r, 300))
  const image = await win.webContents.capturePage({ x: 0, y: 0, width: SIZE, height: SIZE })
  const out = path.join(__dirname, '..', 'build', 'icon.png')
  fs.mkdirSync(path.dirname(out), { recursive: true })
  fs.writeFileSync(out, image.resize({ width: SIZE, height: SIZE }).toPNG())
  console.log('wrote', out, image.getSize())
  app.quit()
})
