#!/usr/bin/env node

import './_preflight.mjs'

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { detectMode } from './upgrade-lib/mode.mjs'
import { resolveCliDataDir } from './lib/instance.mjs'
import { runScript } from './upgrade-lib/runner.mjs'
import { runMigrations } from './upgrade-lib/migrate.mjs'
import { runSourceUpgrade, syncPythonDeps } from './upgrade-lib/source.mjs'
import {
  getCurrentVersion,
  getLatestVersion,
  detectPlatform,
  downloadRelease,
  extractRelease,
  writeVersionFile,
} from './upgrade-lib/release.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const CRABOT_HOME = resolve(__dirname, '..')
const CLI = join(CRABOT_HOME, 'cli.mjs')
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

function node(args) {
  execFileSync(process.execPath, [CLI, ...args], { cwd: CRABOT_HOME, stdio: 'inherit' })
}

function stamp() {
  return new Date().toISOString()
}

async function main() {
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
  let releaseArtifact = null
  let targetVersion = null
  try {
    if (mode === 'source') {
      console.log('[ui-upgrade] (prepare) git pull --ff-only')
      execFileSync('git', ['pull', '--ff-only'], { cwd: CRABOT_HOME, stdio: 'inherit' })
      console.log('[ui-upgrade] (prepare) build：install + build 所有模块')
      await runSourceUpgrade(CRABOT_HOME, logger)
    } else {
      const current = getCurrentVersion(CRABOT_HOME)
      const { tag } = await getLatestVersion()
      targetVersion = tag
      if (current === tag) {
        console.log(`[ui-upgrade] already up to date (${current})`)
        writeStatus({ phase: 'done', to_version: current, finished_at: stamp() })
        return
      }
      const platform = detectPlatform()
      const url = `https://github.com/smilefufu/crabot/releases/download/${tag}/crabot-${tag}-${platform}.tar.gz`
      console.log(`[ui-upgrade] (prepare) download ${url}`)
      releaseArtifact = await downloadRelease({ url, sha256Url: `${url}.sha256`, logger })
    }
  } catch (err) {
    const msg = err?.message || String(err)
    console.error('[ui-upgrade] prepare FAILED（服务未停，无影响）:', msg)
    writeStatus({ phase: 'failed', error: `准备阶段失败，服务未停：${msg}`, finished_at: stamp() })
    process.exit(1)
  }

  // ========== 切换阶段（停机，尽量短：只做 stop + 落盘类操作 + start）==========
  try {
    writeStatus({ phase: 'restarting' })
    console.log('[ui-upgrade] (switch) stop')
    node(['stop'])

    if (mode === 'release' && releaseArtifact) {
      console.log('[ui-upgrade] (switch) extract release')
      await extractRelease({ ...releaseArtifact, crabotHome: CRABOT_HOME, logger })
      console.log('[ui-upgrade] (switch) sync python deps')
      await syncPythonDeps(CRABOT_HOME, logger)
    }

    console.log('[ui-upgrade] (switch) run migrations')
    const result = await runMigrations(CRABOT_HOME, DATA_DIR, runScript, logger)
    if (!result.ok) {
      throw new Error(`migration failed in ${result.failedModule} at ${result.failedAt} (backup: ${result.backupPath ?? 'none'})`)
    }

    if (mode === 'release' && targetVersion) {
      await writeVersionFile(CRABOT_HOME, targetVersion)
    }

    console.log('[ui-upgrade] (switch) start -d')
    node(['start', '-d'])

    writeStatus({ phase: 'done', to_version: readVersion(mode), finished_at: stamp() })
    console.log(`[ui-upgrade] done at=${stamp()}`)
  } catch (err) {
    const msg = err?.message || String(err)
    console.error('[ui-upgrade] switch FAILED:', msg)
    writeStatus({ phase: 'failed', error: `切换阶段失败（已停机，需人工恢复）：${msg}`, finished_at: stamp() })
    process.exit(1)
  }
}

main().catch((err) => {
  const msg = err?.message || String(err)
  writeStatus({ phase: 'failed', error: msg, finished_at: stamp() })
  process.exit(1)
})
