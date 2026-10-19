#!/usr/bin/env node


import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { detectMode } from './upgrade-lib/mode.mjs'
import { detectMode as detectInstallScope } from './lib/mode.mjs'
import { resolveCliDataDir } from './lib/instance.mjs'
import { runScript } from './upgrade-lib/runner.mjs'
import { runMigrations } from './upgrade-lib/migrate.mjs'
import { prepareUpgrade, installPreparedUpgrade } from './upgrade-lib/prepared-upgrade.mjs'
import { acquireCliLock, releaseCliLock, cliLockToken } from './lib/cli-lock.mjs'
import { locateCliInstallation } from './lib/cli-installation.mjs'
import product from './lib/product-runtime.cjs'
import { preflightRestart } from './upgrade-lib/preflight.mjs'
import {
  getCurrentVersion,
  getLatestVersion,
  getReleaseUrls,
  downloadRelease,
  writeVersionFile,
} from './upgrade-lib/release.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const CRABOT_HOME = resolve(__dirname, '..')
const DATA_DIR = resolveCliDataDir({ homeDir: resolve(homedir(), '.crabot') })
const STATUS_DIR = join(DATA_DIR, 'admin')
const STATUS_FILE = join(STATUS_DIR, 'upgrade-status.json')

// 本进程 stdout/stderr 已由 admin 重定向到 data/logs/upgrade.log（见 upgrade-runner.startUpgrade）。
// 这里用 console + 子进程 stdio:'inherit' 即可让 git / pnpm / stop / start 全链路输出落盘。
const logger = {
  info: (m) => console.log(m),
  warn: (m) => console.warn(m),
  error: (m) => console.error(m),
}

// release 安装的版本是 VERSION 文件；source 安装没有 VERSION，版本就是 git 短 sha。
// 否则 source 模式 from/to_version 永远是 null，升级记录看不到「从哪升到哪」。
function readVersion(mode) {
  if (mode === 'source') {
    try {
      return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: CRABOT_HOME, encoding: 'utf-8' }).trim()
    } catch {
      return null
    }
  }
  const p = join(CRABOT_HOME, 'VERSION')
  return existsSync(p) ? readFileSync(p, 'utf-8').trim() : null
}

function writeStatus(patch) {
  mkdirSync(STATUS_DIR, { recursive: true })
  let prev = {}
  if (existsSync(STATUS_FILE)) {
    try { prev = JSON.parse(readFileSync(STATUS_FILE, 'utf-8')) } catch {}
  }
  writeFileSync(STATUS_FILE, JSON.stringify({ ...prev, ...patch }, null, 2))
}

function node(args, lock, root = CRABOT_HOME) {
  const runtime = root === CRABOT_HOME ? null : product.loadProductRuntime(root, { required: true })
  execFileSync(runtime?.executables.node ?? process.execPath, [join(root, 'cli.mjs'), ...args], {
    cwd: CRABOT_HOME, stdio: 'inherit', env: { ...process.env, CRABOT_CLI_LOCK_HELD: cliLockToken(lock) },
  })
}

function stamp() {
  return new Date().toISOString()
}

async function main() {
  if (detectInstallScope('/etc/crabot') === 'system' && process.getuid?.() !== 0) throw new Error('System upgrade requires an administrator; the running instance was not stopped')
  const standalone = locateCliInstallation(CRABOT_HOME)
  if (standalone && standalone.scope !== 'user') throw new Error('共享核心升级请联系管理员，原实例保持运行。')
  const mode = detectMode(CRABOT_HOME) // 'release' | 'source'
  const fromVersion = readVersion(mode)
  console.log(`[ui-upgrade] start mode=${mode} from=${fromVersion} at=${stamp()}`)
  writeStatus({
    phase: 'preparing',
    started_at: stamp(),
    from_version: fromVersion,
    finished_at: undefined,
    error: undefined,
    to_version: undefined,
  })

  // ========== 准备阶段（实例照常运行，最慢、最易失败的步骤都在这里；失败不停服务）==========
  let prepared
  let preparedCli
  let targetVersion
  try {
    targetVersion = mode === 'release' ? (await getLatestVersion()).tag : undefined
    if (mode === 'release' && getCurrentVersion(CRABOT_HOME) === targetVersion) {
      try {
        const current = await preflightRestart(CRABOT_HOME, DATA_DIR)
        if (!current.modules.length && ['ready', 'not_applicable'].includes(current.shared.status)) {
          writeStatus({ phase: 'done', to_version: targetVersion, finished_at: stamp() })
          console.log(`[ui-upgrade] already up to date (${targetVersion})`)
          return
        }
      } catch (error) { logger.warn(`Installed target needs repair: ${error.message}`) }
    }
    if (standalone) {
      const artifact = await downloadRelease({ ...getReleaseUrls(targetVersion), logger })
      const { prepareDownloadedCliUpgrade } = await import('./lib/standalone-cli-release.mjs')
      preparedCli = await prepareDownloadedCliUpgrade({ root: CRABOT_HOME, artifact, logger })
    } else {
      prepared = await prepareUpgrade(CRABOT_HOME, DATA_DIR, { mode, version: targetVersion, logger })
      console.log(`[ui-upgrade] prepared product ${prepared.payload_bytes} bytes; scoped data backup ${prepared.preview.backup_bytes ?? 'legacy pending'}`)
      await preflightRestart(prepared.stage, DATA_DIR)
    }
  } catch (err) {
    const msg = err?.message || String(err)
    console.error('[ui-upgrade] prepare FAILED（服务未停，无影响）:', msg)
    writeStatus({ phase: 'failed', error: `准备阶段失败，服务未停：${msg}`, finished_at: stamp() })
    process.exitCode = 1
    return
  }

  // ========== 切换阶段：同一实例操作锁；此时无需下载、解包、安装依赖或构建 ==========
  let lock
  let switchStarted = false
  try {
    lock = await acquireCliLock(DATA_DIR, 'web-upgrade')
    if (!preparedCli) await preflightRestart(prepared.stage, DATA_DIR)
    writeStatus({ phase: 'restarting' })
    console.log('[ui-upgrade] (switch) stop')
    switchStarted = true
    node(['stop'], lock)
    if (preparedCli) {
      // The target coordinator acquires its own instance lock.
      releaseCliLock(lock); lock = undefined
      const { applyPreparedCliUpgrade } = await import('./lib/standalone-cli-release.mjs')
      await applyPreparedCliUpgrade({ root: CRABOT_HOME, dataDir: DATA_DIR, prepared: preparedCli })
      node(['start', '-d'], lock, preparedCli.coreRoot)
      writeStatus({ phase: 'done', to_version: preparedCli.version, finished_at: stamp() })
      return
    }
    await installPreparedUpgrade(prepared, CRABOT_HOME, DATA_DIR)

    console.log('[ui-upgrade] (switch) run migrations')
    const result = await runMigrations(CRABOT_HOME, DATA_DIR, runScript, logger, { lockHeld: true })
    if (!result.ok) {
      throw new Error(`migration failed in ${result.failedModule} at ${result.failedAt} (backup: ${result.backupPath ?? 'none'})`)
    }

    if (mode === 'release' && targetVersion) {
      await writeVersionFile(CRABOT_HOME, targetVersion)
    }

    console.log('[ui-upgrade] (switch) start -d')
    node(['start', '-d'], lock)

    writeStatus({ phase: 'done', to_version: readVersion(mode), finished_at: stamp() })
    console.log(`[ui-upgrade] done at=${stamp()}`)
  } catch (err) {
    const msg = err?.message || String(err)
    console.error('[ui-upgrade] switch FAILED:', msg)
    writeStatus({ phase: 'failed', error: `${switchStarted ? '停止/切换阶段失败，请检查实例状态' : '切换预检失败，服务未停'}：${msg}`, finished_at: stamp() })
    process.exitCode = 1
    return
  } finally {
    releaseCliLock(lock)
  }

}

main().catch((err) => {
  const msg = err?.message || String(err)
  writeStatus({ phase: 'failed', error: msg, finished_at: stamp() })
  process.exitCode = 1
})
