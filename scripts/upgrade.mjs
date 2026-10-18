#!/usr/bin/env node

import './_preflight.mjs'

import { existsSync, readFileSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'

import { detectMode } from './upgrade-lib/mode.mjs'
import { runScript } from './upgrade-lib/runner.mjs'
import { runMigrations } from './upgrade-lib/migrate.mjs'
import {
  getCurrentVersion,
  getLatestVersion,
  getReleaseUrls,
  downloadAndExtract,
  downloadRelease,
  writeVersionFile,
} from './upgrade-lib/release.mjs'
import { runSourceUpgrade, syncPythonDeps } from './upgrade-lib/source.mjs'
import { verifyReleasePackage } from './lib/release-package.mjs'
import { detectMode as detectInstallScope } from './lib/mode.mjs'
import { resolveCliDataDir } from './lib/instance.mjs'
import { homedir } from 'node:os'
import { locateCliInstallation } from './lib/cli-installation.mjs'
import { applyDownloadedCliUpgrade } from './lib/standalone-cli-release.mjs'
import { inspectInstance } from './lib/instance-runtime.mjs'
import { openDesktopUpdate } from './lib/desktop-update-entry.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const CRABOT_HOME = resolve(__dirname, '..')
const args = process.argv.slice(2)
const ASSUME_YES = args.includes('-y') || args.includes('--yes')

// 同 status.mjs / start.mjs：DATA_DIR 走 env > 默认。
// 契约说明见 lib/instance.mjs:resolveCliDataDir。
const DATA_DIR = resolveCliDataDir({ homeDir: resolve(homedir(), '.crabot') })

const logger = {
  info: (m) => console.log(m),
  warn: (m) => console.warn(m),
  error: (m) => console.error(m),
}

async function ask(question) {
  if (ASSUME_YES) return true
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const answer = await new Promise((res) => rl.question(question, res))
  rl.close()
  return /^y(es)?$/i.test(answer.trim())
}

function isMmRunning() {
  const candidates = [
    join(DATA_DIR, 'admin', 'admin.pid'),
    join(DATA_DIR, 'memory', 'memory.pid'),
  ]
  for (const p of candidates) {
    if (!existsSync(p)) continue
    const pid = parseInt(readFileSync(p, 'utf-8').trim(), 10)
    if (!Number.isFinite(pid)) continue
    try {
      process.kill(pid, 0)
      return true
    } catch {
      // process not alive
    }
  }
  return false
}

async function getGitHeadInfo(crabotHome) {
  const headPath = join(crabotHome, '.git', 'HEAD')
  if (!existsSync(headPath)) return { head: 'unknown', branch: 'unknown' }
  const head = readFileSync(headPath, 'utf-8').trim()
  if (head.startsWith('ref: refs/heads/')) {
    const branch = head.slice('ref: refs/heads/'.length)
    const refPath = join(crabotHome, '.git', 'refs', 'heads', branch)
    const sha = existsSync(refPath) ? readFileSync(refPath, 'utf-8').trim().slice(0, 7) : 'unknown'
    return { head: sha, branch }
  }
  return { head: head.slice(0, 7), branch: 'detached' }
}

function failureExit(failedModule, failedAt, backupPath) {
  console.error('')
  console.error(`[upgrade] FAILED in module ${failedModule} at step ${failedAt}.`)
  if (backupPath) {
    console.error(`  Backup preserved: ${backupPath}`)
  }
  console.error('  SCHEMA_VERSION not updated.')
  console.error('')
  console.error('  To restore:')
  if (backupPath) {
    const orig = backupPath.replace(/\.backup-\d{8}-\d{6}$/, '')
    console.error(`    rm -rf ${orig}`)
    console.error(`    mv ${backupPath} ${orig}`)
  }
  console.error('  Then investigate the error above and re-run: crabot upgrade')
  process.exit(1)
}

async function runReleaseMode() {
  const current = getCurrentVersion(CRABOT_HOME)
  const { tag: latest, publishedAt } = await getLatestVersion()

  if (current?.replace(/^v/, '') === latest.replace(/^v/, '')) {
    try {
      await verifyReleasePackage(CRABOT_HOME, current)
      console.log(`Already up to date (${current}).`)
      return
    } catch (error) {
      if (error.code === 'CRABOT_PREPARATION_CANCELLED') throw error
      logger.warn(`Installed release is incomplete; repairing: ${error.message}`)
    }
  }

  console.log(`Current:  ${current ?? '(unknown — VERSION file missing)'}`)
  console.log(`Latest:   ${latest}${publishedAt ? `  (released ${publishedAt.slice(0, 10)})` : ''}`)
  console.log('')

  if (!(await ask('Upgrade now? [y/N] '))) {
    console.log('Aborted.')
    return
  }

  if (locateCliInstallation(CRABOT_HOME)) {
    const artifact = await downloadRelease({ ...getReleaseUrls(latest), logger })
    await applyDownloadedCliUpgrade({ root: CRABOT_HOME, dataDir: DATA_DIR, artifact, logger })
    return
  }
  await downloadAndExtract({ ...getReleaseUrls(latest), crabotHome: CRABOT_HOME, logger })

  console.log('Syncing Python deps ...')
  await syncPythonDeps(CRABOT_HOME, logger)
  await verifyReleasePackage(CRABOT_HOME, latest)

  console.log('Running data migrations ...')
  const result = await runMigrations(CRABOT_HOME, DATA_DIR, runScript, logger)
  if (!result.ok) {
    failureExit(result.failedModule, result.failedAt, result.backupPath)
  }

  await writeVersionFile(CRABOT_HOME, latest)
  console.log('')
  console.log(`Upgraded to ${latest}.`)
}

async function runSourceMode() {
  const { head, branch } = await getGitHeadInfo(CRABOT_HOME)
  console.log(`Source install detected (HEAD = ${head} on ${branch}).`)
  console.log("Make sure you've run 'git pull' first.")
  if (!(await ask('Continue? [y/N] '))) {
    console.log('Aborted.')
    return
  }

  await runSourceUpgrade(CRABOT_HOME, logger)

  console.log('Running data migrations ...')
  const result = await runMigrations(CRABOT_HOME, DATA_DIR, runScript, logger)
  if (!result.ok) {
    failureExit(result.failedModule, result.failedAt, result.backupPath)
  }

  console.log('')
  console.log('Done.')
}

async function main() {
  // system mode 下普通用户跑 upgrade → 拒绝并提示
  const scope = detectInstallScope('/etc/crabot')
  if (scope === 'system' && process.getuid && process.getuid() !== 0) {
    console.error('[crabot] this is a system-mode install at ' + CRABOT_HOME + ';')
    console.error('[crabot] please ask the administrator to run `sudo crabot upgrade`.')
    process.exit(1)
  }

  if (await openDesktopUpdate(CRABOT_HOME)) {
    console.log('[crabot] 已请求桌面应用打开更新界面，请在应用中确认安装。')
    return
  }

  const standalone = locateCliInstallation(CRABOT_HOME)
  if (standalone?.scope === 'system') {
    const { runSystemUpgradeCli } = await import('./lib/system-upgrade-cli.mjs')
    process.exitCode = await runSystemUpgradeCli({ root: CRABOT_HOME, yes: ASSUME_YES, logger })
    return
  }
  if (standalone && inspectInstance(DATA_DIR).state !== 'stopped') throw new Error('实例尚未核验停止，请先运行 crabot stop。')
  if (isMmRunning()) {
    console.error('[upgrade] Module Manager appears to be running. Run `crabot stop` first.')
    process.exit(1)
  }
  const mode = detectMode(CRABOT_HOME)
  if (mode === 'release') {
    await runReleaseMode()
  } else {
    await runSourceMode()
  }
}

main().catch((err) => {
  console.error('[upgrade] fatal:', err.message || err)
  process.exit(1)
})
