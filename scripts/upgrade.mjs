#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'

import { detectMode } from './upgrade-lib/mode.mjs'
import { runScript } from './upgrade-lib/runner.mjs'
import { runMigrations, backupDataDir } from './upgrade-lib/migrate.mjs'
import {
  getCurrentVersion,
  getLatestVersion,
  detectPlatform,
  downloadAndExtract,
  writeVersionFile,
} from './upgrade-lib/release.mjs'
import { runSourceUpgrade, syncPythonDeps } from './upgrade-lib/source.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const CRABOT_HOME = resolve(__dirname, '..')
const args = process.argv.slice(2)
const ASSUME_YES = args.includes('-y') || args.includes('--yes')

const OFFSET = parseInt(process.env.CRABOT_PORT_OFFSET || '0', 10)
const DATA_DIR = process.env.DATA_DIR
  || (OFFSET > 0 ? join(CRABOT_HOME, `data-${OFFSET}`) : join(CRABOT_HOME, 'data'))

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

  if (current === latest) {
    console.log(`Already up to date (${current}).`)
    return
  }

  console.log(`Current:  ${current ?? '(unknown — VERSION file missing)'}`)
  console.log(`Latest:   ${latest}${publishedAt ? `  (released ${publishedAt.slice(0, 10)})` : ''}`)
  console.log('')

  if (!(await ask('Upgrade now? [y/N] '))) {
    console.log('Aborted.')
    return
  }

  const platform = detectPlatform()
  const url = `https://github.com/smilefufu/crabot/releases/download/${latest}/crabot-${latest}-${platform}.tar.gz`
  const sha256Url = `${url}.sha256`

  const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15)
  const backupPath = `${CRABOT_HOME}.backup-${ts}`
  console.log(`Backing up to ${backupPath} ...`)
  await backupDataDir(CRABOT_HOME, ts)

  await downloadAndExtract({ url, sha256Url, crabotHome: CRABOT_HOME, logger })

  console.log('Syncing Python deps ...')
  await syncPythonDeps(CRABOT_HOME, logger)

  console.log('Running data migrations ...')
  const result = await runMigrations(CRABOT_HOME, DATA_DIR, runScript, logger)
  if (!result.ok) {
    failureExit(result.failedModule, result.failedAt, result.backupPath)
  }

  await writeVersionFile(CRABOT_HOME, latest)
  console.log('')
  console.log(`Upgraded to ${latest}.`)
  console.log(`Backup: ${backupPath}/  (delete when stable)`)
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
