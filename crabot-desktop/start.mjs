import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// Actual OS argv contains the absolute source application entry; Admin never
// interprets a relative Electron entry using its own unrelated working directory.
const executable = createRequire(import.meta.url)('electron')
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
const child = spawn(executable, [dirname(fileURLToPath(import.meta.url)), ...process.argv.slice(2)], { env, stdio: 'inherit' })
child.on('error', () => { console.error('Electron 启动失败，请重新准备桌面开发依赖。'); process.exitCode = 1 })
child.on('exit', code => { process.exitCode = code ?? 1 })
