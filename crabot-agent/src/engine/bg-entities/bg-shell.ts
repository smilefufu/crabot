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
import { emitInstantSpan, type BgEntityTraceContext } from './trace.js'

const execFileAsync = promisify(execFile)

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface SpawnPersistentShellOpts {
  readonly command: string
  readonly owner: BgEntityOwner
  readonly spawned_by_task_id: string
  readonly registry: BgEntityRegistry
  readonly traceContext?: BgEntityTraceContext
  /**
   * Async exit hook — 进程 exit 后、registry update 完成后调用。
   * 用于推送 push notification（worker 把它接到 enqueueBgNotification）。
   * 抛错只 log 不影响其他逻辑。
   */
  readonly onExit?: (info: {
    entity_id: string
    command: string
    status: 'completed' | 'failed' | 'killed'
    exit_code: number
    runtime_ms: number
    spawned_at: string
  }) => void
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
    const exitedAt = Date.now()
    const runtimeMs = exitedAt - spawnedAtMs
    void registeredPromise
      .then(async () => {
        const status: 'completed' | 'failed' = exitCode === 0 ? 'completed' : 'failed'
        if (opts.traceContext) {
          emitInstantSpan(opts.traceContext, 'bg_entity_exit', {
            entity_id,
            type: 'shell',
            status,
            exit_code: exitCode,
            runtime_ms: runtimeMs,
          }, status)
        }
        await opts.registry.update(entity_id, {
          status,
          exit_code: exitCode,
          ended_at: new Date(exitedAt).toISOString(),
        } as Partial<BgShellRegistryRecord>)
        // 触发 push notification 给 worker（以便下一次 task 启动时通知 agent）
        // status='killed' 由 Kill 工具直接 update，bg-shell 这里只看 exit code
        if (opts.onExit) {
          try {
            opts.onExit({
              entity_id,
              command: opts.command,
              status,
              exit_code: exitCode,
              runtime_ms: runtimeMs,
              spawned_at: now,
            })
          } catch (err) {
            console.error(`[bg-shell] onExit callback failed for ${entity_id}:`, err)
          }
        }
      })
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

  const spawnedAtMs = Date.now()
  const processStartedAt = await readProcStartTime(child.pid)
  const now = new Date(spawnedAtMs).toISOString()

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

  // Emit spawn span after registration so traceId is valid.
  if (opts.traceContext) {
    emitInstantSpan(opts.traceContext, 'bg_entity_spawn', {
      entity_id,
      type: 'shell',
      mode: 'persistent',
      command: opts.command,
    })
  }

  return entity_id
}

// ---------------------------------------------------------------------------
// TransientShellRegistry — in-memory only, no disk, task-bound lifecycle
// ---------------------------------------------------------------------------

import { spawn as nodeSpawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import type { BgEntityStatus } from './types.js'
import { BG_TRANSIENT_RING_BUFFER_BYTES } from './types.js'

/** 临时 shell 内存状态——不写 disk，task 结束自动 kill */
export interface TransientShellState {
  readonly entity_id: string
  status: BgEntityStatus
  readonly command: string
  readonly spawned_at: string
  readonly owner: BgEntityOwner
  readonly spawned_by_task_id: string
  exit_code: number | null
  ended_at: string | null
  /** 滚动 buffer：超 200KB 时从头截 */
  ringBuffer: string
  readonly child: ChildProcess
}

export interface SpawnTransientShellOpts {
  readonly command: string
  readonly owner: BgEntityOwner
  readonly spawned_by_task_id: string
  readonly traceContext?: BgEntityTraceContext
  /**
   * Async exit hook，与 SpawnPersistentShellOpts.onExit 同款；
   * 用于 worker 推 push notification（transient 在 task 内 exit 的场景）。
   * Phase 1 仅 plumbing，worker 端目前不消费 transient 通知（mid-task 注入靠 humanMessageQueue 待 Phase 2）。
   */
  readonly onExit?: (info: {
    entity_id: string
    command: string
    status: 'completed' | 'failed' | 'killed'
    exit_code: number
    runtime_ms: number
    spawned_at: string
  }) => void
}

export class TransientShellRegistry {
  private shells = new Map<string, TransientShellState>()

  /** spawn + 注册 + 接管 stdout/stderr → ringBuffer。返回 entity_id。 */
  spawn(opts: SpawnTransientShellOpts): string {
    const entity_id = `shell_${randomBytes(6).toString('hex')}`
    const spawnedAtMs = Date.now()
    const now = new Date(spawnedAtMs).toISOString()

    const child = nodeSpawn('bash', ['-c', opts.command], {
      detached: true,
      env: process.env,
    })

    const state: TransientShellState = {
      entity_id,
      status: 'running',
      command: opts.command,
      spawned_at: now,
      owner: opts.owner,
      spawned_by_task_id: opts.spawned_by_task_id,
      exit_code: null,
      ended_at: null,
      ringBuffer: '',
      child,
    }
    this.shells.set(entity_id, state)

    const append = (chunk: Buffer | string) => {
      const text = chunk.toString()
      const combined = state.ringBuffer + text
      if (combined.length > BG_TRANSIENT_RING_BUFFER_BYTES) {
        state.ringBuffer = combined.slice(combined.length - BG_TRANSIENT_RING_BUFFER_BYTES)
      } else {
        state.ringBuffer = combined
      }
    }
    child.stdout?.on('data', append)
    child.stderr?.on('data', append)

    child.on('exit', (code) => {
      if (state.status === 'running') {
        const exitCode = code ?? -1
        const exitStatus: 'completed' | 'failed' = exitCode === 0 ? 'completed' : 'failed'
        const runtimeMs = Date.now() - spawnedAtMs
        state.status = exitStatus
        state.exit_code = exitCode
        state.ended_at = new Date().toISOString()
        if (opts.traceContext) {
          emitInstantSpan(opts.traceContext, 'bg_entity_exit', {
            entity_id,
            type: 'shell',
            status: exitStatus,
            exit_code: exitCode,
            runtime_ms: runtimeMs,
          }, exitStatus)
        }
        if (opts.onExit) {
          try {
            opts.onExit({
              entity_id,
              command: opts.command,
              status: exitStatus,
              exit_code: exitCode,
              runtime_ms: runtimeMs,
              spawned_at: now,
            })
          } catch (err) {
            console.error(`[bg-shell-transient] onExit callback failed for ${entity_id}:`, err)
          }
        }
      }
    })
    child.on('error', () => {
      if (state.status === 'running') {
        state.status = 'failed'
        state.exit_code = -1
        state.ended_at = new Date().toISOString()
        if (opts.traceContext) {
          emitInstantSpan(opts.traceContext, 'bg_entity_exit', {
            entity_id,
            type: 'shell',
            status: 'failed',
            exit_code: -1,
            runtime_ms: Date.now() - spawnedAtMs,
          }, 'failed')
        }
      }
    })

    // Unref so host process event loop can exit without waiting for child.
    child.unref()

    // Emit spawn span.
    if (opts.traceContext) {
      emitInstantSpan(opts.traceContext, 'bg_entity_spawn', {
        entity_id,
        type: 'shell',
        mode: 'transient',
        command: opts.command,
      })
    }

    return entity_id
  }

  get(entity_id: string): TransientShellState | undefined {
    return this.shells.get(entity_id)
  }

  list(filter?: {
    owner_friend_id?: string
    status?: ReadonlyArray<BgEntityStatus>
  }): TransientShellState[] {
    const all = Array.from(this.shells.values())
    return all.filter((s) => {
      if (filter?.owner_friend_id && s.owner.friend_id !== filter.owner_friend_id) return false
      if (filter?.status && !filter.status.includes(s.status)) return false
      return true
    })
  }

  /** 显式 kill 单个 shell（SIGTERM，3s 后 SIGKILL 兜底） */
  kill(entity_id: string): void {
    const state = this.shells.get(entity_id)
    if (!state || state.status !== 'running') return
    state.status = 'killed'
    state.ended_at = new Date().toISOString()
    if (state.child.pid) {
      try {
        process.kill(-state.child.pid, 'SIGTERM')
      } catch {
        /* already dead */
      }
      const pid = state.child.pid
      setTimeout(() => {
        try {
          process.kill(-pid, 'SIGKILL')
        } catch {
          /* already dead */
        }
      }, 3000).unref()
    }
  }

  /** task 结束时调用，kill 该 task 拥有的所有 shell */
  killAllOwnedBy(task_id: string): void {
    for (const state of this.shells.values()) {
      if (state.spawned_by_task_id === task_id && state.status === 'running') {
        this.kill(state.entity_id)
      }
    }
  }

  /** entity 数量（用于 debug / metrics） */
  size(): number {
    return this.shells.size
  }
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
