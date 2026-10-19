#!/usr/bin/env node
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'
import { homedir } from 'node:os'
import { detectMode } from './upgrade-lib/mode.mjs'
import { detectMode as detectInstallScope } from './lib/mode.mjs'
import { resolveCliDataDir } from './lib/instance.mjs'
import { acquireCliLock, releaseCliLock } from './lib/cli-lock.mjs'
import { runScript } from './upgrade-lib/runner.mjs'
import { runMigrations } from './upgrade-lib/migrate.mjs'
import { assertStopped } from './upgrade-lib/scoped-data.mjs'
import { prepareUpgrade, installPreparedUpgrade } from './upgrade-lib/prepared-upgrade.mjs'
import { preflightRestart } from './upgrade-lib/preflight.mjs'
import { getCurrentVersion, getLatestVersion, writeVersionFile, downloadRelease, getReleaseUrls } from './upgrade-lib/release.mjs'

import { locateCliInstallation } from './lib/cli-installation.mjs'
import { inspectInstance } from './lib/instance-runtime.mjs'
import { openDesktopUpdate } from './lib/desktop-update-entry.mjs'

const CRABOT_HOME = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DATA_DIR = resolveCliDataDir({ homeDir: resolve(homedir(), '.crabot') })
const assumeYes = process.argv.includes('-y') || process.argv.includes('--yes')
async function confirm() {
  if (assumeYes) return true
  const prompt = createInterface({ input: process.stdin, output: process.stdout })
  try { return /^y(es)?$/i.test((await new Promise(resolve => prompt.question('Prepare upgrade? [y/N] ', resolve))).trim()) }
  finally { prompt.close() }
}
async function main() {
  if (detectInstallScope('/etc/crabot') === 'system' && process.getuid?.() !== 0) throw new Error('System install: ask the administrator to run sudo crabot upgrade')
  if (await openDesktopUpdate(CRABOT_HOME)) {
    console.log('[crabot] 已请求桌面应用打开更新界面，请在应用中确认安装。')
    return
  }
  const standalone = locateCliInstallation(CRABOT_HOME)
  if (standalone?.scope === 'system') {
    const { runSystemUpgradeCli } = await import('./lib/system-upgrade-cli.mjs')
    process.exitCode = await runSystemUpgradeCli({ root: CRABOT_HOME, yes: assumeYes, logger: console })
    return
  }
  if (standalone) {
    if (inspectInstance(DATA_DIR).state !== 'stopped') throw new Error('实例尚未核验停止，请先运行 crabot stop。')
    if (!await confirm()) return
    const { tag } = await getLatestVersion()
    const artifact = await downloadRelease({ ...getReleaseUrls(tag), logger: console })
    const { applyDownloadedCliUpgrade } = await import('./lib/standalone-cli-release.mjs')
    await applyDownloadedCliUpgrade({ root: CRABOT_HOME, dataDir: DATA_DIR, artifact, logger: console })
    return
  }
  const mode = detectMode(CRABOT_HOME)
  if (!await confirm()) return
  const version = mode === 'release' ? (await getLatestVersion()).tag : undefined
  if (mode === 'release' && getCurrentVersion(CRABOT_HOME) === version) {
    try {
      const current = await preflightRestart(CRABOT_HOME, DATA_DIR)
      if (!current.modules.length && ['ready', 'not_applicable'].includes(current.shared.status)) {
        console.log(`[upgrade] already up to date (${version})`)
        return
      }
    } catch (error) { console.warn(`[upgrade] installed target needs repair: ${error.message}`) }
  }
  const prepared = await prepareUpgrade(CRABOT_HOME, DATA_DIR, { mode, version })
  console.log(`[upgrade] preparation ${prepared.reused ? 'reused' : 'complete'}; product ${prepared.payload_bytes} bytes; data backup ${prepared.preview.backup_bytes ?? 'legacy transaction: inspect original plan'} bytes`)
  // CLI retains its explicit stop contract; preparation never stops the instance.
  try { await assertStopped(DATA_DIR) }
  catch (error) {
    if (!error.message.startsWith('Stop Crabot')) throw error
    console.log('[upgrade] instance remains running. Explicitly stop it, then run crabot upgrade again to switch the verified prepared target.')
    return
  }
  const lock = await acquireCliLock(DATA_DIR, 'upgrade')
  try {
    await installPreparedUpgrade(prepared, CRABOT_HOME, DATA_DIR)
    const result = await runMigrations(CRABOT_HOME, DATA_DIR, runScript, console, { lockHeld: true })
    if (!result.ok) throw new Error(`Migration failed: ${result.failedModule}/${result.failedAt}; scoped backup: ${result.backupPath}`)
    if (mode === 'release') await writeVersionFile(CRABOT_HOME, version)
    console.log(`[upgrade] upgraded to ${prepared.identity.target}; run crabot start when ready`)
  } finally { releaseCliLock(lock) }
}
main().catch(error => { console.error('[upgrade]', error.message); process.exitCode = 1 })
