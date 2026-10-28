// OS-owned lock: crash closes the handle; the persistent metadata file is never renamed/unlinked.
import { mkdirSync, readFileSync, lstatSync } from 'node:fs'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import native from './process-identity.cjs'
import preflight from './preflight-state.cjs'
import workspace from './workspace-maintenance.cjs'

const handles = new Map()
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function acquire(dataDir, command, waitMs, recoveryId, workspaceAdmission = workspace.assertWorkspaceExecutionAllowed, existingOnly = false) {
  workspaceAdmission(dataDir)
  const directoryIdentity = () => {
    const stat = lstatSync(dataDir, { bigint: true })
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('maintenance directory is not an existing ordinary directory')
    return [stat.dev, stat.ino, stat.mode, stat.uid, stat.gid].join(':')
  }
  if (!existingOnly) mkdirSync(dataDir, { recursive: true })
  const original = existingOnly ? directoryIdentity() : undefined
  const assertDirectory = () => {
    if (existingOnly && directoryIdentity() !== original) throw new Error('maintenance directory changed while acquiring its lock')
  }
  const path = resolve(dataDir, 'cli.lock')
  const deadline = Date.now() + waitMs
  const token = randomUUID()
  const owner = native.inspectProcess(process.pid)
  for (;;) {
    assertDirectory(); workspaceAdmission(dataDir)
    let preparationBusy
    if (!handles.has(path)) {
      const handle = native.tryFileLock(path, JSON.stringify({ pid: process.pid, command, started_at: new Date().toISOString(), owner, token }))
      if (handle) {
        try { assertDirectory(); workspaceAdmission(dataDir); preflight.assertSettled(dataDir, recoveryId) }
        catch (error) {
          native.releaseFileLock(handle)
          if (error.code !== 'CRABOT_PREFLIGHT_BUSY') throw error
          preparationBusy = error
        }
        if (!preparationBusy) { handles.set(path, { handle, token }); return path }
      }
    }
    if (Date.now() >= deadline) throw preparationBusy ?? new Error('another crabot CLI operation is in progress — wait for it to finish, then retry')
    await sleep(Math.min(100, Math.max(1, deadline - Date.now())))
  }
}

export function acquireCliLock(dataDir, command, waitMs = 5000) { return acquire(dataDir, command, waitMs) }

// Maintenance on an already verified installation must not initialize missing data.
export function acquireExistingCliLock(dataDir, command, waitMs = 5000) {
  return acquire(dataDir, command, waitMs, undefined, workspace.assertWorkspaceExecutionAllowed, true)
}

// Only explicit startup/recovery can replace a stopped orphan-check receipt.
// This does not authorize retrying schema migrations or other business work.
export async function acquireStartupLock(dataDir, command = 'start', waitMs = 5000) {
  const previous = preflight.read(dataDir)
  return acquire(dataDir, command, waitMs, previous?.id, () => {})
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

// Shared migration helpers use the same native inherited-lock verification.
export const inheritedCliLock = hasInheritedCliLock
