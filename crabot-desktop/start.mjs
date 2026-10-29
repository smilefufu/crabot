import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { developmentEnvironment } from '../scripts/lib/development-environment.mjs'
import { fileURLToPath } from 'node:url'

// Actual OS argv contains the absolute source application entry; Admin never
// interprets a relative Electron entry using its own unrelated working directory.
const executable = createRequire(import.meta.url)('electron')
const env = { ...developmentEnvironment(resolve(dirname(fileURLToPath(import.meta.url)), '..')), CRABOT_DEVELOPMENT_NODE: process.execPath }; delete env.ELECTRON_RUN_AS_NODE
const child = spawn(executable, [dirname(fileURLToPath(import.meta.url)), ...process.argv.slice(2)], { env, stdio: 'inherit' })
child.on('error', () => { console.error('Electron 启动失败，请重新准备桌面开发依赖。'); process.exitCode = 1 })
child.on('exit', code => { process.exitCode = code ?? 1 })

for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => child.kill(signal))
