import { spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, mkdirSync, openSync } from 'node:fs'
import { join } from 'node:path'
import type { UpgradeStatus, VersionState } from './types.js'

export function readUpgradeStatus(dataDir: string): UpgradeStatus | null {
  const p = join(dataDir, 'upgrade-status.json')
  if (!existsSync(p)) return null
  try {
    return JSON.parse(readFileSync(p, 'utf-8')) as UpgradeStatus
  } catch {
    return null
  }
}

export function canUpgrade(state: VersionState): { ok: boolean; reason?: string } {
  if (state.upgrade_capability === 'system') {
    return { ok: false, reason: 'system mode 由管理员在终端升级' }
  }
  if (!state.upgrade_available) {
    return { ok: false, reason: '已是最新版本' }
  }
  if (state.upgrade_capability === 'source' && (state.source_blockers?.length ?? 0) > 0) {
    return { ok: false, reason: state.source_blockers!.join('；') }
  }
  return { ok: true }
}

/**
 * spawn 前同步落 upgrading 状态。消除两个竞态：
 * 1. 前端轮询读到上一次升级残留的 done 而误判成功（detached 进程异步写 upgrading 有延迟）；
 * 2. 快速双击在 ui-upgrade.mjs 写 status 前并发 spawn 第二个升级进程。
 */
export function writeUpgradeStarting(dataDir: string, fromVersion?: string | null): void {
  mkdirSync(dataDir, { recursive: true })
  const status: UpgradeStatus = {
    phase: 'upgrading',
    started_at: new Date().toISOString(),
    from_version: fromVersion ?? undefined,
  }
  writeFileSync(join(dataDir, 'upgrade-status.json'), JSON.stringify(status, null, 2))
}

/**
 * spawn detached 升级进程（scripts/ui-upgrade.mjs）。
 * 先同步落 upgrading 状态再 spawn；进程脱离 admin 进程组，stop MM 时不被杀。
 */
export function startUpgrade(crabotHome: string, dataDir: string, fromVersion?: string | null): { status: 'started' } {
  writeUpgradeStarting(dataDir, fromVersion)
  // 升级进程日志落文件（dataDir 形如 .../data/admin，logs 是其 sibling）。
  // stdout/stderr 指向 upgrade.log，ui-upgrade.mjs 的 console 与其 inherit 子进程（git/pnpm/stop/start）输出都汇到此文件，
  // 修掉「stdio:ignore 导致升级失败零日志」的问题。
  const logDir = join(dataDir, '..', 'logs')
  mkdirSync(logDir, { recursive: true })
  const logFd = openSync(join(logDir, 'upgrade.log'), 'a')
  const script = join(crabotHome, 'scripts', 'ui-upgrade.mjs')
  const child = spawn(process.execPath, [script], {
    cwd: crabotHome,
    detached: true,
    stdio: ['ignore', logFd, logFd],
    // DATA_DIR 已全局统一为顶层（admin 进程继承到的 DATA_DIR 即顶层），
    // ui-upgrade 直接继承即正确，无需覆盖。
    env: process.env,
  })
  // 必须在 unref 前挂 error 监听：spawn 失败异步 emit 'error'，
  // 任何 await 间隙都会让它漏成 uncaughtException 干掉主进程。
  child.on('error', (err) => {
    console.error('[upgrade] spawn ui-upgrade failed:', err)
  })
  child.unref()
  return { status: 'started' }
}

/** 是否有升级正在进行（用于防重）；10 分钟后视为 stale lock，不再阻塞 */
export function isUpgradeInProgress(dataDir: string): boolean {
  const s = readUpgradeStatus(dataDir)
  if (!s) return false
  if (s.phase !== 'preparing' && s.phase !== 'upgrading' && s.phase !== 'restarting') return false
  const startedMs = new Date(s.started_at).getTime()
  if (!Number.isFinite(startedMs)) return false
  return Date.now() - startedMs < 10 * 60 * 1000
}
