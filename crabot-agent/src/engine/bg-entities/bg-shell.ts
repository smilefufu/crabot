/**
 * spawnPersistentShell — detached child_process spawn with disk log + BgEntityRegistry.
 *
 * Spec: crabot-docs/superpowers/specs/2026-05-01-long-running-agent-design.md §6.1
 * Plan: crabot-docs/superpowers/plans/2026-05-01-long-running-agent-plan-2.md  Task 4
 */

import { spawn, execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { promisify } from 'node:util'
import { getBgEntitiesLogsDir } from '../../core/data-paths.js'
import type { BgEntityOwner, BgShellRegistryRecord } from './types.js'
import type { BgEntityRegistry } from './registry.js'

const execFileAsync = promisify(execFile)

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface SpawnPersistentShellOpts {
  readonly command: string
  readonly owner: BgEntityOwner
  readonly spawned_by_task_id: string
  readonly registry: BgEntityRegistry
}

/**
 * Spawn `command` in a detached bash process, pipe stdout+stderr to a disk
 * log file, register the entity in `registry`, and return immediately.
 *
 * Returns entity_id (format: `shell_<12 hex chars>`).
 */
export async function spawnPersistentShell(opts: SpawnPersistentShellOpts): Promise<string> {
  const entity_id = `shell_${randomBytes(6).toString('hex')}`
  const logsDir = getBgEntitiesLogsDir()

  await fs.promises.mkdir(logsDir, { recursive: true })

  const logFile = path.join(logsDir, `${entity_id}.log`)
  const logFd = await fs.promises.open(logFile, 'a')

  const child = spawn('bash', ['-c', opts.command], {
    detached: true,
    stdio: ['ignore', logFd.fd, logFd.fd],
    env: process.env,
  })

  // Close our copy of the fd — child holds its own reference via stdio inheritance.
  await logFd.close()

  if (!child.pid) {
    throw new Error('[bg-shell] Failed to spawn child process: no pid returned')
  }

  // `registeredPromise` resolves after registry.register() succeeds, ensuring
  // that exit/error handlers don't call registry.update() before the record exists.
  // We create it now (before any awaits) so fast-exiting processes don't miss it.
  let resolveRegistered!: () => void
  const registeredPromise = new Promise<void>((resolve) => {
    resolveRegistered = resolve
  })

  // Attach exit/error listeners synchronously — before any further awaits —
  // so fast-exiting processes (e.g. `exit 0`) are captured.
  child.on('exit', (code) => {
    const exitCode = code ?? -1
    void registeredPromise
      .then(() =>
        opts.registry.update(entity_id, {
          status: exitCode === 0 ? 'completed' : 'failed',
          exit_code: exitCode,
          ended_at: new Date().toISOString(),
        } as Partial<BgShellRegistryRecord>),
      )
      .catch((err: unknown) => {
        console.error(`[bg-shell] exit registry update failed for ${entity_id}:`, err)
      })
  })

  child.on('error', (err) => {
    console.error('[bg-shell] child process error:', err)
    void registeredPromise
      .then(() =>
        opts.registry.update(entity_id, {
          status: 'failed',
          exit_code: -1,
          ended_at: new Date().toISOString(),
        } as Partial<BgShellRegistryRecord>),
      )
      .catch(() => {
        // swallow — nothing we can do
      })
  })

  // Unref so the host process event loop can exit without waiting for the child.
  child.unref()

  const processStartedAt = await readProcStartTime(child.pid)
  const now = new Date().toISOString()

  const record: BgShellRegistryRecord = {
    entity_id,
    type: 'shell',
    status: 'running',
    command: opts.command,
    log_file: logFile,
    pid: child.pid,
    pgid: child.pid, // detached: pgid === pid on Linux/macOS
    process_started_at: processStartedAt,
    owner: opts.owner,
    spawned_by_task_id: opts.spawned_by_task_id,
    spawned_at: now,
    exit_code: null,
    ended_at: null,
    last_activity_at: now,
  }

  await opts.registry.register(record)

  // Unblock the exit/error handlers — they will now apply any pending update.
  resolveRegistered()

  return entity_id
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/**
 * Read the actual start time of `pid` via `ps -o lstart=`.
 * Falls back to `now` if ps fails (e.g. process already exited).
 */
async function readProcStartTime(pid: number): Promise<string> {
  try {
    const { stdout } = await execFileAsync('ps', ['-o', 'lstart=', '-p', String(pid)])
    const trimmed = stdout.trim()
    if (!trimmed) throw new Error('empty ps output')
    return new Date(trimmed).toISOString()
  } catch {
    // Fallback: just spawned, so wall-clock now is accurate enough.
    return new Date().toISOString()
  }
}
