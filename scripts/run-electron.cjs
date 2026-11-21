// 清掉 ELECTRON_RUN_AS_NODE 后直接用 Electron 运行一个脚本（例如生成图标）
const { spawn } = require('node:child_process')
const electron = require('electron')

delete process.env.ELECTRON_RUN_AS_NODE
const child = spawn(electron, process.argv.slice(2), { stdio: 'inherit', env: process.env })
child.on('exit', (code) => process.exit(code ?? 0))
