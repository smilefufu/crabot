#!/usr/bin/env node
import { dirname, resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync, readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { developmentEnvironment } from './lib/development-environment.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const [major, minor] = process.versions.node.split('.').map(Number)
if (major < 22 || major === 22 && minor < 14) { console.error('开发入口需要Node >=22.14，请更新开发工具链后重试。'); process.exit(1) }
const command = process.argv[2] ?? 'start'
const commands = new Set(['start', 'build', 'stop', 'restart', 'status', 'vite', 'desktop'])
if (!commands.has(command) || process.argv.length > 3) {
  console.error('用法：pnpm dev [start|build|stop|restart|status|vite|desktop]'); process.exit(1)
}
const devEnv = developmentEnvironment(root)
for (const key of Object.keys(process.env)) if (!Object.hasOwn(devEnv, key)) delete process.env[key]
Object.assign(process.env, devEnv)

async function prepare(desktop = false, lockHeld = false) {
  // Check an already prepared tree before replacing even its native helper.
  if (existsSync(join(root, 'crabot-native/build/Release/crabot-native.node'))) {
    const { assertDevelopmentBuildAllowed } = await import('./lib/development.mjs')
    await assertDevelopmentBuildAllowed(root)
  }
  // Native helper is required for read-only ownership checks before source builds.
  const { developmentBuildState } = await import('./lib/development-build.mjs')
  const native = developmentBuildState(join(root, 'crabot-native'), [readFileSync(join(root, 'scripts/build-native.mjs'), 'utf8')])
  if (!native.ready || !existsSync(join(root, 'crabot-native/build/Release/crabot-native.node'))) {
    const { runBounded } = await import('./lib/run-bounded.mjs')
    await runBounded(process.execPath, [join(root, 'scripts/build-native.mjs')], { env: process.env })
    native.commit()
  }
  const { acquireStartupLock, releaseCliLock, cliLockToken } = await import('./lib/cli-lock.mjs')
  if (lockHeld && !cliLockToken(join(process.env.DATA_DIR, 'cli.lock'))) throw new Error('开发准备需要持有本实例操作锁。')
  const { ensureDevelopmentDataRoot } = await import('./lib/development.mjs')
  await ensureDevelopmentDataRoot(root)
  const lock = lockHeld ? undefined : await acquireStartupLock(process.env.DATA_DIR, 'dev-build')
  try {
    const { assertDevelopmentBuildAllowed } = await import('./lib/development.mjs')
    await assertDevelopmentBuildAllowed(root)
    const { runSourceUpgrade } = await import('./upgrade-lib/source.mjs')
    await runSourceUpgrade(root, console, { incremental: true, desktop })
  } finally { if (lock) releaseCliLock(lock) }
}
async function main() {
  if (command === 'build') { await prepare(); return }
  const dev = await import('./lib/development.mjs')
  if (command === 'status') { console.log(JSON.stringify(await dev.readDevelopmentStatus(root), null, 2)); return }
  if (command === 'stop') { await dev.stopDevelopment(root); return }
  if (command === 'restart') {
    const { acquireCliLock, releaseCliLock } = await import('./lib/cli-lock.mjs')
    const lock = await acquireCliLock(process.env.DATA_DIR, 'dev-restart')
    try {
      await dev.stopDevelopment(root, { lockHeld: true }); await prepare(false, true)
      await dev.startDevelopment(root, { foreground: true, lockHeld: true, cleanup: code => process.exit(code) })
    } finally { releaseCliLock(lock) }
    return
  }
  if (command === 'vite') {
    if ((await dev.inspectDevelopment(root)).state !== 'running') throw new Error('请先运行pnpm dev，Vite只连接本开发后端。')
    const response = await fetch('http://127.0.0.1:5173', { signal: AbortSignal.timeout(3000) }).catch(() => null)
    if (!response?.ok) throw new Error('开发实例的Vite尚未就绪，请查看pnpm dev status显示的日志。')
    console.log('开发前端：http://127.0.0.1:5173'); return
  }
  if (command === 'desktop') {
    const state = await dev.inspectDevelopment(root)
    if (state.state === 'stopped') { await prepare(true); await dev.startDevelopment(root) }
    else if (!existsSync(join(root, 'crabot-desktop/dist/main.js'))) throw new Error('请先停止开发实例，再执行pnpm dev desktop以准备GUI。')
    const child = spawn(process.execPath, [join(root, 'crabot-desktop/start.mjs')], { stdio: 'inherit', env: process.env })
    const stop = () => { void dev.stopDevelopment(root).then(() => child.kill('SIGTERM')).catch(error => console.error('[dev] ' + error.message)) }
    process.once('SIGINT', stop); process.once('SIGTERM', stop)
    try { const [code] = await once(child, 'exit'); process.exitCode = code ?? 1 }
    finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop) }
    return
  }
  await prepare()
  console.log('开发数据：' + process.env.DATA_DIR + '\nAdmin：http://127.0.0.1:13000；HMR：http://127.0.0.1:5173')
  await dev.startDevelopment(root, { foreground: true, cleanup: code => process.exit(code) })
}
await main().catch(error => { console.error('[dev] ' + error.message); process.exitCode = 1 })
