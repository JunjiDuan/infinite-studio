// 有些宿主（例如 VS Code 扩展的终端）会注入 ELECTRON_RUN_AS_NODE=1，
// 导致 Electron 以纯 Node 模式启动而直接崩溃。这里清掉它再调用 electron-vite。
const { spawn } = require('node:child_process')
const path = require('node:path')

delete process.env.ELECTRON_RUN_AS_NODE
const cli = path.join(__dirname, '..', 'node_modules', 'electron-vite', 'bin', 'electron-vite.js')
const child = spawn(process.execPath, [cli, ...process.argv.slice(2)], { stdio: 'inherit', env: process.env })
child.on('exit', (code) => process.exit(code ?? 0))
