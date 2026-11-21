// 打包完成后，把当前版本的安装包复制到根目录 installer/
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const { version } = require(path.join(root, 'package.json'))
const name = `InfiniteStudio-Setup-${version}.exe`
const src = path.join(root, 'release', name)
const dir = path.join(root, 'installer')

if (!fs.existsSync(src)) {
  console.error(`找不到安装包：${src}`)
  process.exit(1)
}
fs.mkdirSync(dir, { recursive: true })
fs.copyFileSync(src, path.join(dir, name))
console.log(`安装包已复制到 installer/${name}`)
