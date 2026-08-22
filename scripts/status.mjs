#!/usr/bin/env node

import './_preflight.mjs'

import { existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { hasInstance, readInstance, resolveCliDataDir } from './lib/instance.mjs'
import { probeMmModules } from './lib/mm-probe.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')
const HOME_DIR = resolve(homedir(), '.crabot')
// OFFSET 和 DATA_DIR 都走 resolveCliDataDir 入口，保证 status 显示与 start/stop 一致
const DATA_DIR = resolveCliDataDir({ homeDir: HOME_DIR })
const OFFSET = parseInt(process.env.CRABOT_PORT_OFFSET || '0', 10)
const ARGS = process.argv.slice(2)
const JSON_OUT = ARGS.includes('--json')

const c = {
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red:   (s) => `\x1b[31m${s}\x1b[0m`,
  bold:  (s) => `\x1b[1m${s}\x1b[0m`,
  dim:   (s) => `\x1b[2m${s}\x1b[0m`,
}

const inst = hasInstance(HOME_DIR) ? readInstance(HOME_DIR) : {
  mode: 'unknown', port_offset: OFFSET, data_dir: DATA_DIR, crabot_home: ROOT,
}

const ENDPOINTS = {
  admin_ui:  { url: `http://localhost:${3000 + OFFSET}`,  label: 'Admin UI' },
  mm:        { url: `http://localhost:${19000 + OFFSET}`, label: 'Module Manager' },
  admin_rpc: { url: `http://localhost:${19001 + OFFSET}`, label: 'Admin RPC' },
}

// 单点判定：MM 活 = 整个实例活；admin_ui/admin_rpc 的死活从 modules 里找 admin-web 推断
const modules = await probeMmModules(19000 + OFFSET)
const running = modules !== null
const adminModule = modules?.find((m) => (m.module_id ?? m.id) === 'admin-web')
const adminAlive = adminModule?.status === 'running'

const health = {
  mm: running,
  admin_ui: adminAlive,
  admin_rpc: adminAlive, // admin-web 进程同时暴露 web (3000+OFF) 和 RPC (19001+OFF)
}

const logsStdout = resolve(DATA_DIR, 'logs/mm.stdout.log')
const logsStderr = resolve(DATA_DIR, 'logs/mm.stderr.log')
const hasLogs = existsSync(logsStdout) || existsSync(logsStderr)

if (JSON_OUT) {
  console.log(JSON.stringify({
    mode: inst.mode,
    port_offset: inst.port_offset ?? OFFSET,
    data_dir: DATA_DIR,
    crabot_home: inst.crabot_home ?? ROOT,
    instance_init: inst.applied_at ?? null,
    running,
    endpoints: Object.fromEntries(
      Object.entries(ENDPOINTS).map(([k, v]) => [k, { url: v.url, healthy: health[k] }])
    ),
    modules,
    logs: hasLogs ? { stdout: logsStdout, stderr: logsStderr } : null,
  }, null, 2))
  process.exit(0)
}

// 人类视图
const dot = (ok) => ok ? c.green('●') : c.red('●')
console.log()
console.log('  ' + c.bold('Crabot Instance'))
console.log('  ' + '─'.repeat(54))
console.log(`  Mode              ${inst.mode}`)
console.log(`  Port Offset       ${inst.port_offset ?? OFFSET}`)
console.log(`  DATA_DIR          ${DATA_DIR}`)
console.log(`  CRABOT_HOME       ${inst.crabot_home ?? ROOT}`)
if (inst.applied_at) console.log(`  Instance Init     ${inst.applied_at}`)
console.log()
console.log('  ' + c.bold('Endpoints'))
console.log('  ' + '─'.repeat(54))
for (const [k, v] of Object.entries(ENDPOINTS)) {
  console.log(`  ${v.label.padEnd(17)} ${v.url.padEnd(25)} ${dot(health[k])}`)
}
console.log()
if (running && modules) {
  console.log('  ' + c.bold(`Modules (${modules.length})`))
  console.log('  ' + '─'.repeat(54))
  for (const m of modules) {
    const status = m.status || 'unknown'
    const pidStr = m.pid ? `pid ${m.pid}` : ''
    console.log(`  ${(m.id ?? m.module_id ?? '?').padEnd(17)} ${status.padEnd(10)} ${pidStr}`)
  }
  console.log()
} else if (!running) {
  console.log('  ' + c.dim('Modules: instance not running'))
  console.log()
}
if (hasLogs) {
  console.log('  ' + c.bold('Logs'))
  console.log('  ' + '─'.repeat(54))
  if (existsSync(logsStdout)) console.log(`  MM stdout         ${logsStdout}`)
  if (existsSync(logsStderr)) console.log(`  MM stderr         ${logsStderr}`)
  console.log('  ' + c.dim('  Tail with: tail -f $LOG_PATH'))
  console.log()
}
