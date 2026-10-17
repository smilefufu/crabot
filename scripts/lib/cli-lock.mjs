// OS-owned lock: crash closes the handle; the persistent metadata file is never renamed/unlinked.
import { mkdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import native from './process-identity.cjs'

const handles = new Map()
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

export async function acquireCliLock(dataDir, command, waitMs = 5000) {
  mkdirSync(dataDir, { recursive: true })
  const path = resolve(dataDir, 'cli.lock')
  const deadline = Date.now() + waitMs
  const token = randomUUID()
  const owner = native.inspectProcess(process.pid)
  for (;;) {
    if (!handles.has(path)) {
      const handle = native.tryFileLock(path, JSON.stringify({ pid: process.pid, command, started_at: new Date().toISOString(), owner, token }))
      if (handle) { handles.set(path, { handle, token }); return path }
    }
    if (Date.now() >= deadline) throw new Error('another crabot CLI operation is in progress — wait for it to finish, then retry')
    await sleep(Math.min(100, Math.max(1, deadline - Date.now())))
  }
}

export function releaseCliLock(path) {
  const lock = handles.get(path)
  if (!lock) return
  native.releaseFileLock(lock.handle)
  handles.delete(path)
}

export function cliLockToken(path) { return handles.get(path)?.token }

export function hasInheritedCliLock(dataDir, token = process.env.CRABOT_CLI_LOCK_HELD) {
  if (!token || token === '1') return false
  try {
    const path = resolve(dataDir, 'cli.lock')
    const raw = readFileSync(path, 'utf8'), record = JSON.parse(raw)
    if (record.token !== token || !native.sameProcess(record.owner, native.inspectProcess(record.pid))) return false
    // Persistent metadata is not proof the owner still holds its OS handle.
    const available = native.tryFileLock(path, raw)
    if (available) { native.releaseFileLock(available); return false }
    return true
  } catch { return false }
}
