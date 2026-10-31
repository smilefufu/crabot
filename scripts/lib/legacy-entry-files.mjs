// Raw known-entry mechanics only. Installation identity, deployment scope,
// data binding and permission to fence/restore belong to the separate callers.
import { promises as fs, realpathSync } from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import identity from './process-identity.cjs'
export const legacyEntryFiles = ['cli.mjs', 'crabot.cmd', 'scripts/start.mjs', 'scripts/supervisor.mjs', 'crabot-core/dist/main.js']
export const hashEntry = bytes => createHash('sha256').update(bytes).digest('hex')
export function failEntryFence() {
  throw Object.assign(new Error('旧入口接管状态无法安全继续；原记录已保留，不覆盖未知入口或放行旧核心。'), { code: 'CRABOT_LEGACY_ENTRY_FENCE' })
}
export function entryFenceBytes(file, scope = 'desktop') {
  if (!['desktop', 'system'].includes(scope)) failEntryFence()
  if (scope === 'system') return Buffer.from(file.endsWith('.cmd')
    ? '@echo off\r\necho Crabot shared deployment maintenance is pending. Contact the administrator. 1>&2\r\nexit /b 1\r\n'
    : '#!/usr/bin/env node\nthrow Object.assign(new Error("Crabot共享部署正在维护，请管理员使用新版Crabot检查恢复。"), { code: "CRABOT_LEGACY_SYSTEM_ENTRY_FENCE" })\n')
  return Buffer.from(file.endsWith('.cmd')
    ? '@echo off\r\necho Crabot takeover is pending. Open the desktop app to recover. 1>&2\r\nexit /b 1\r\n'
    : '#!/usr/bin/env node\nthrow Object.assign(new Error("Crabot takeover is pending. Open the desktop app to recover."), { code: "CRABOT_LEGACY_ENTRY_FENCE" })\n')
}
// The original command can hand off only after a paired installation has
// cleared its maintenance guard. Old Core/supervisor guards never forward.
export function pairedCliFenceBytes(file, external = false) {
  const prefix = external ? '%~dp0.desktop-takeover\\desktop-target\\' : '%~dp0'
  const relative = external ? './.desktop-takeover/desktop-target/' : './'
  if (file === 'crabot.cmd') return Buffer.from([
    '@echo off', 'setlocal DisableDelayedExpansion',
    `if not exist "${prefix}desktop-installation.json" goto pending`,
    `if not exist "${prefix}current-release.json" goto pending`,
    'if exist "%~dp0data\\desktop-maintenance.json" goto pending',
    `if not exist "${prefix}bin\\crabot.exe" goto pending`,
    `"${prefix}bin\\crabot.exe" %*`, 'exit /b %errorlevel%', ':pending',
    'echo Crabot takeover is pending. Open the desktop app to recover. 1>&2', 'exit /b 1', '',
  ].join('\r\n'))
  if (file !== 'cli.mjs') return null
  return Buffer.from(`#!/usr/bin/env node
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
const relative = name => fileURLToPath(new URL(name, import.meta.url))
const command = relative('${relative}bin/' + (process.platform === 'win32' ? 'crabot.exe' : 'crabot'))
if (!existsSync(relative('${relative}desktop-installation.json')) || !existsSync(relative('${relative}current-release.json'))
  || existsSync(relative('./data/desktop-maintenance.json')) || !existsSync(command)) {
  throw Object.assign(new Error('Crabot takeover is pending. Open the desktop app to recover.'), { code: 'CRABOT_LEGACY_ENTRY_FENCE' })
}
const result = spawnSync(command, process.argv.slice(2), { stdio: 'inherit', env: process.env })
if (result.error) throw result.error
if (result.signal) process.kill(process.pid, result.signal)
else process.exit(result.status ?? 1)
`)
}
export async function readEntry(file, limit = 1024 * 1024) {
  const stat = await fs.lstat(file)
  if (!stat.isFile() || stat.size > limit || realpathSync(file) !== file) failEntryFence()
  return { bytes: await fs.readFile(file), mode: stat.mode & 0o777 }
}
export async function syncEntryDirectory(directory) {
  if (process.platform === 'win32') return
  const handle = await fs.open(directory, 'r')
  try { await handle.sync() } finally { await handle.close() }
}
export async function replaceEntry(file, bytes, mode) {
  const temporary = file + '.takeover-' + randomUUID()
  try {
    if (process.platform === 'win32') { identity.writePrivateFile(temporary, ''); await fs.writeFile(temporary, bytes, { flush: true }) }
    else {
      const handle = await fs.open(temporary, 'wx', mode)
      try { await handle.writeFile(bytes); await handle.chmod(mode); await handle.sync() }
      finally { await handle.close() }
    }
    await fs.rename(temporary, file)
    await syncEntryDirectory(path.dirname(file))
  } finally { await fs.rm(temporary, { force: true }) }
}
