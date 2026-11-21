import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { defineConfig } from 'electron-vite'
import type { Plugin } from 'vite'

/**
 * pdf.js 运行时按需加载的资源：CMap（中日韩等非嵌入字体必需）、标准字体、wasm 图像解码器、ICC 色彩配置。
 * 构建时原样复制到 out/renderer/pdfjs/，开发时由 dev server 直接提供。
 */
const PDFJS_DIRS = ['cmaps', 'standard_fonts', 'wasm', 'iccs']
const PDFJS_ROOT = path.resolve(__dirname, 'node_modules/pdfjs-dist')

function pdfjsAssets(): Plugin {
  return {
    name: 'pdfjs-assets',
    configureServer(server) {
      server.middlewares.use('/pdfjs/', (req, res, next) => {
        const rel = decodeURIComponent((req.url ?? '').split('?')[0]).replace(/^\/+/, '')
        const file = path.join(PDFJS_ROOT, rel)
        const dir = rel.split('/')[0]
        if (!PDFJS_DIRS.includes(dir) || !file.startsWith(PDFJS_ROOT) || !existsSync(file) || !statSync(file).isFile()) return next()
        if (file.endsWith('.wasm')) res.setHeader('Content-Type', 'application/wasm')
        createReadStream(file).pipe(res)
      })
    },
    generateBundle() {
      for (const dir of PDFJS_DIRS) {
        const abs = path.join(PDFJS_ROOT, dir)
        if (!existsSync(abs)) continue
        for (const name of readdirSync(abs)) {
          const file = path.join(abs, name)
          if (statSync(file).isFile()) this.emitFile({ type: 'asset', fileName: `pdfjs/${dir}/${name}`, source: readFileSync(file) })
        }
      }
    }
  }
}

export default defineConfig({
  main: {},
  preload: {},
  renderer: {
    plugins: [pdfjsAssets()],
    build: {
      chunkSizeWarningLimit: 8000
    }
  }
})
