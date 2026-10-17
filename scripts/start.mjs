#!/usr/bin/env node

// Crabot Start — 生产模式启动
// 加载环境变量 → 创建数据目录 → 密码检查 → 启动 Module Manager（前台）

import './_preflight.mjs'

import { existsSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { homedir } from 'node:os'
import net from 'node:net'
import { checkSingleInstance } from './lib/pid.mjs'
import { prepareCoreEnvironment, applyStartupMigrations } from './lib/core-preparation.mjs'
import management from './lib/desktop-management.cjs'
import { hasInstance, resolveCliDataDir } from './lib/instance.mjs'
import { acquireCliLock, releaseCliLock, hasInheritedCliLock } from './lib/cli-lock.mjs'
import { runManagedCore } from './lib/managed-core.mjs'
import { inspectInstance } from './lib/instance-runtime.mjs'
import { launchBackgroundCore } from './lib/background-core.mjs'
import scraplingRuntime from './lib/scrapling-runtime.cjs'
import { runBounded } from './lib/scrapling-prepare.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')
const HOME_CRABOT = resolve(homedir(), '.crabot')

// auto-init：缺 instance.json → 同步调 crabot init（在 const OFFSET 读取前）
if (!hasInstance(HOME_CRABOT) && !management.readDesktopManagement(resolveCliDataDir({ homeDir: HOME_CRABOT }))) {
  console.log('[crabot] first run, auto-running init...')
  const initEntry = resolve(__dirname, 'init.mjs')
  const r = spawnSync(process.execPath, [initEntry], { stdio: 'inherit', env: { ...process.env } })
  if (r.status !== 0) {
    console.error('[crabot] init failed; aborting start')
    process.exit(1)
  }
}

// OFFSET 和 DATA_DIR 都收敛到 resolveCliDataDir：
//   - OFFSET 仍走 env > instance.json > 0（resolveOffset 内部）
//   - DATA_DIR 走 env > ~/.crabot/data{-OFFSET}（不读 instance.data_dir）
// "不读 instance.data_dir" 的契约 + 历史教训见 lib/instance.mjs:resolveCliDataDir。
const DAEMON_MODE = process.argv.includes('-d') || process.argv.includes('--daemon')
process.env.CRABOT_ORPHAN_RECOVERY_INTERACTIVE = !DAEMON_MODE
  && process.stdin.isTTY === true
  && process.stdout.isTTY === true
  ? '1'
  : '0'

// ── 环境变量 ──

const DATA_DIR = resolveCliDataDir({ homeDir: HOME_CRABOT })
const OFFSET = parseInt(process.env.CRABOT_PORT_OFFSET || '0', 10)
const prepared = prepareCoreEnvironment({ root: ROOT, dataDir: DATA_DIR })
Object.assign(process.env, prepared.env)

if (!prepared.runtime && scraplingRuntime.runtimeRequired(DATA_DIR)) {
  try {
    await runBounded(process.execPath, [resolve(ROOT, 'scripts/prepare-scrapling.mjs')])
  } catch (err) {
    console.error('[crabot] Cannot start enabled Scrapling:', err.message)
    process.exit(1)
  }
}

// ── 密码检查 ──
if (!prepared.managed) {
const credModUrl = pathToFileURL(
  resolve(ROOT, 'crabot-admin/dist/credentials.js'),
).href
const { readCredentials, writeCredentials, newCredentialsFromPassword } =
  await import(credModUrl)

const existingCred = await readCredentials(resolve(DATA_DIR, 'admin'))
  // 注意：readCredentials 会自动触发 .env 兜底迁移并删 .env

if (!existingCred) {
  if (DAEMON_MODE) {
    console.error('[crabot] No admin password set. Run `crabot start` (foreground) once to set it interactively.')
    process.exit(1)
  }
  const prompter = createPrompter()
  const password = await prompter.ask('Set admin password: ')
  if (!password || password.length < 4) {
    console.error('[crabot] Password must be at least 4 characters.')
    process.exit(1)
  }
  const confirm = await prompter.ask('Confirm password: ')
  prompter.close()
  if (password !== confirm) {
    console.error('[crabot] Passwords do not match.')
    process.exit(1)
  }
  const newCred = await newCredentialsFromPassword(password, { is_temp: true, changed_via: 'start' })
  await writeCredentials(resolve(DATA_DIR, 'admin'), newCred)
  console.log('[crabot] Password saved.')
  console.log('[crabot] \x1b[33mThis is a temporary password — you will be required to change it on first login.\x1b[0m')
}
}

// ── 启动 Module Manager ──

const mmEntry = resolve(ROOT, 'crabot-core/dist/main.js')
const orphanRecoveryEntry = resolve(ROOT, 'crabot-core/dist/orphan-recovery-preflight.js')
if (!existsSync(mmEntry) || !existsSync(orphanRecoveryEntry)) {
  console.error('[crabot] crabot-core build output not found. Run build first.')
  process.exit(1)
}

// CLI 操作互斥（restart 外层持锁时经 env 跳过）。start 有大量 process.exit 出口，
// 统一由 exit handler 释放；进程意外退出时操作系统关闭锁句柄。
let startupLock
if (!hasInheritedCliLock(DATA_DIR)) {
  try {
    startupLock = await acquireCliLock(DATA_DIR, 'start')
    process.on('exit', () => releaseCliLock(startupLock))
  } catch (error) {
    console.error(`[crabot] ${error.message}`)
    process.exit(1)
  }
}

// 单实例预检
const currentInstance = inspectInstance(DATA_DIR)
if (currentInstance.state === 'running' || currentInstance.state === 'starting') {
  console.error(`[crabot] already running (pid=${currentInstance.record.mm?.pid ?? currentInstance.record.controller.pid}). Run 'crabot stop' first.`)
  process.exit(1)
}
const single = checkSingleInstance(DATA_DIR)
if (!single.ok) {
  console.error(`[crabot] already running (pid=${single.runningPid}). Run 'crabot stop' first.`)
  process.exit(1)
}

// 端口预检（避免拿到 EADDRINUSE 才报错）
async function probePort(port) {
  return await new Promise((res) => {
    const srv = net.createServer()
    srv.once('error', () => res(false))
    srv.once('listening', () => srv.close(() => res(true)))
    srv.listen(port, '127.0.0.1')
  })
}
if (!await probePort(19000 + OFFSET)) {
  console.error(`[crabot] port ${19000 + OFFSET} already in use. Check 'lsof -i :${19000 + OFFSET}'.`)
  process.exit(1)
}

const orphanRecovery = spawnSync(process.execPath, [orphanRecoveryEntry], {
  cwd: resolve(ROOT, 'crabot-core'),
  stdio: 'inherit',
  env: { ...process.env },
})
if (orphanRecovery.status !== 0) {
  console.error('[crabot] startup aborted before Module Manager was launched.')
  process.exit(1)
}

const MM_PORT = 19000 + OFFSET
const WEB_PORT = 3000 + OFFSET
// tmp-page server 用子模块池尾部保留的 slot（MM 的 PORT_RANGE_END 缩到 19098 给它让位）：
// 落在 19000 系列段内，跟 OFFSET 走、每租户独占 [19000,19099]+OFFSET，跨租户不撞、不落 ephemeral。
const TMP_PAGE_PORT = 19099 + OFFSET
process.env.CRABOT_TMP_PAGE_PORT = String(TMP_PAGE_PORT)
console.log(`[crabot] Tmp-page proxy target: 127.0.0.1:${TMP_PAGE_PORT}`)

console.log(`[crabot] Starting Module Manager (port ${MM_PORT})...`)
console.log(`[crabot] Admin Web: http://localhost:${WEB_PORT}`)

// Migration 兜底：start 自动跑缺失的 migration（覆盖 upgrade-time 漏跑场景）
// 用 applyMigration 包装版（chainUpgrade + writeSchemaVersion 原子，不可能漏写
// SCHEMA_VERSION）；不做 backup（启动不备份，upgrade.mjs 主路径才备）。
try { await applyStartupMigrations(ROOT, DATA_DIR, process.env, message => console.log(`[crabot] ${message}`)) }
catch (error) { console.error(`[crabot] ${error.message}`); process.exit(1) }

if (!DAEMON_MODE) {
  await runManagedCore({ root: ROOT, dataDir: DATA_DIR, mmPort: MM_PORT,
    env: process.env, stdio: ['inherit', 'inherit', 'inherit'],
    cleanup: code => process.exit(code), log: message => process.stdout.write(message) })
  // Foreground waiting is presentation, not a lifecycle mutation. Stop/restart can now acquire the lock.
  releaseCliLock(startupLock)
  startupLock = undefined
} else {
  try {
    const { record } = await launchBackgroundCore({ root: ROOT, dataDir: DATA_DIR, env: process.env,
      mmPort: MM_PORT, webPort: WEB_PORT, log: message => console.log(`[crabot] ${message}`) })
    console.log(`[crabot] MM ready (port ${MM_PORT}); Admin Web ready (port ${WEB_PORT}).`)
    console.log(`[crabot] Started. PID ${record.controller.pid}. Run \`crabot status\` to check, \`crabot stop\` to stop.`)
    process.exit(0)
  } catch (error) { console.error(`[crabot] ${error.message}`); process.exit(1) }
}

// ── 辅助函数 ──

function createPrompter() {
  if (process.stdin.isTTY) {
    return {
      ask(prompt) {
        return new Promise((res) => {
          process.stdout.write(prompt)
          process.stdin.setRawMode(true)
          process.stdin.resume()
          let input = ''
          const onData = (ch) => {
            const c = ch.toString()
            if (c === '\n' || c === '\r') {
              process.stdin.setRawMode(false)
              process.stdin.removeListener('data', onData)
              process.stdin.pause()
              process.stdout.write('\n')
              res(input)
            } else if (c === '\x7f' || c === '\b') {
              if (input.length > 0) input = input.slice(0, -1)
            } else if (c === '\x03') {
              process.exit(1)
            } else {
              input += c
            }
          }
          process.stdin.on('data', onData)
        })
      },
      close() {},
    }
  }
  const rl = createInterface({ input: process.stdin })
  const lines = []
  let waiting = null
  let closed = false
  rl.on('line', (line) => {
    if (waiting) { const cb = waiting; waiting = null; cb(line) }
    else lines.push(line)
  })
  rl.on('close', () => {
    closed = true
    if (waiting) { const cb = waiting; waiting = null; cb('') }
  })
  return {
    ask(prompt) {
      process.stdout.write(prompt)
      if (lines.length > 0) return Promise.resolve(lines.shift())
      if (closed) return Promise.resolve('')
      return new Promise((res) => { waiting = res })
    },
    close() { rl.close() },
  }
}
