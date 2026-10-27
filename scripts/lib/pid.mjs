import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

const PID_FILE = 'mm.pid'

export function writePid(dataDir, pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Invalid process ID')
  writeFileSync(join(dataDir, PID_FILE), String(pid))
}

export function readPid(dataDir) {
  const p = join(dataDir, PID_FILE)
  if (!existsSync(p)) return null
  const raw = readFileSync(p, 'utf-8').trim()
  const n = /^\d+$/.test(raw) ? Number(raw) : NaN
  return Number.isSafeInteger(n) && n > 0 ? n : null
}

export function clearPid(dataDir) {
  try { unlinkSync(join(dataDir, PID_FILE)) } catch { /* ok */ }
}

export function isPidAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return e.code === 'EPERM' // EPERM = 进程存在但我没权限发信号；视为活
  }
}

/**
 * 单实例检查。返回：
 *   { ok: true }           没在跑（含 stale pid 自动清理）
 *   { ok: false, runningPid }  在跑
 */
export function checkSingleInstance(dataDir) {
  const pid = readPid(dataDir)
  if (pid === null) return { ok: true }
  if (isPidAlive(pid)) return { ok: false, runningPid: pid }
  clearPid(dataDir)
  return { ok: true }
}
