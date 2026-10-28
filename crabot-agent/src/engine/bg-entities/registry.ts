/**
 * BgEntityRegistry — disk-backed registry for background entities.
 * Atomic writes via tmp-file + rename; in-process AsyncMutex for serialization.
 *
 * Spec: crabot-docs/superpowers/specs/2026-05-01-long-running-agent-design.md §6.1
 * Plan: crabot-docs/superpowers/plans/2026-05-01-long-running-agent-plan-2.md  Task 3
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { sha256CanonicalJson, type WorkerProcessIdentity } from 'crabot-shared'
import { captureHeadlessNativeProcesses } from '../../workers/headless-native-processes.js'
import { ExecutionAdmissions } from '../../core/execution-admissions.js'
import { getBgEntitiesRegistryPath } from '../../core/data-paths'
import {
  exitcodeFileForLog,
  readProcStartTime,
  stdoutFileForLog,
  stderrFileForLog,
  stdoutFifoForLog,
  stderrFifoForLog,
} from './bg-shell'
import {
  BG_ENTITY_GC_AFTER_DAYS,
  type BgAgentRegistryRecord,
  type BgEntityRecord,
  type BgEntityStatus,
  type BgEntityType,
  type BgExitNotificationStatus,
  type BgShellRegistryRecord,
  type RegistryFile,
} from './types'

// ---------------------------------------------------------------------------
// Minimal in-process mutex — serialises all registry mutations
// ---------------------------------------------------------------------------

class AsyncMutex {
  private queue: Promise<void> = Promise.resolve()

  async run<T>(fn: () => Promise<T>): Promise<T> {
    let release!: () => void
    const next = new Promise<void>((resolve) => {
      release = resolve
    })
    const previous = this.queue
    this.queue = previous.then(() => next)
    await previous
    try {
      return await fn()
    } finally {
      release()
    }
  }
}

function hasPendingExitNotification(record: BgEntityRecord): boolean {
  return record.exit_notification?.status === 'pending'
}

/** Worker delegate_task identities belong to Worker observability retention, not the 7d entity GC. */
function isWorkerOwnedBuiltinAgent(record: BgEntityRecord): boolean {
  return record.type === 'agent'
    && record.owner.worker_id !== undefined
    && record.spawned_by_task_id === record.owner.worker_id
}

// ---------------------------------------------------------------------------
// PID starttime helper：复用 bg-shell 的健壮版（带 ps-parse 失败兜底），避免重复实现，
// 也避免本文件旧拷贝在某些 locale 下 `new Date(...).toISOString()` 在 execFile 回调里
// 同步抛、绕过 isShellAlive 的 `.catch` 而未捕获崩溃。
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

interface ShellProcessBinding {
  readonly fingerprint: string
  readonly pid: number
  child?: Parameters<typeof captureHeadlessNativeProcesses>[0]
  exited: boolean
  removed: boolean
}

export class BgEntityRegistry {
  private readonly mutex = new AsyncMutex()
  private readonly executionAdmissions = new ExecutionAdmissions()
  private readonly shellProcesses = new Map<string, ShellProcessBinding>()

  constructor(private readonly registryPath: string = getBgEntitiesRegistryPath()) {}

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /** Counts startup/registration only; normal exit updates remain available during maintenance. */
  runExecutionAdmission<T>(start: () => Promise<T>): Promise<T> {
    return this.executionAdmissions.run(start)
  }

  quiesceExecutionAdmissions(): Promise<void> {
    return this.executionAdmissions.closeAndDrain()
  }

  /** Current real child only; stable registration is bound before startup admission settles. */
  trackShellProcess(record: BgShellRegistryRecord, child: Parameters<typeof captureHeadlessNativeProcesses>[0]): void {
    if (child.pid !== record.pid || this.shellProcesses.has(record.entity_id)) {
      throw Object.assign(new Error('后台Shell载体不能更换。'), { code: 'WORKSPACE_MAINTENANCE' })
    }
    const binding: ShellProcessBinding = { fingerprint: this.shellFingerprint(record), pid: record.pid, child, exited: false, removed: false }
    this.shellProcesses.set(record.entity_id, binding)
    const settle = () => {
      try {
        if (!('carrier_exited' in captureHeadlessNativeProcesses(child, true))) return
        binding.exited = true
        binding.child = undefined // Release exit listeners and their Worker closures, retaining only the observed fact.
        if (binding.removed && this.shellProcesses.get(record.entity_id) === binding) this.shellProcesses.delete(record.entity_id)
      } catch { /* Keep an unverifiable carrier; never promote it to an exit fact. */ }
    }
    if (child.exitCode !== null || child.signalCode !== null) settle()
    else child.once('exit', settle)
  }

  private shellFingerprint(record: BgShellRegistryRecord): string {
    const { status, exit_code, ended_at, last_activity_at, exit_notification, ...stable } = record
    return sha256CanonicalJson(stable)
  }

  /** Observed snapshots only; module exit and the whole closing window remain separate. */
  async captureWorkspaceShellProcesses(): Promise<ReadonlyArray<WorkerProcessIdentity>> {
    const failure = () => Object.assign(new Error('后台Shell原生范围无法核实，已保留维护保护。'), { code: 'WORKSPACE_MAINTENANCE' })
    try {
      await this.quiesceExecutionAdmissions()
      const read = async () => {
        const file = await this.readFile()
        if (!file || !file.entities || typeof file.entities !== 'object' || Array.isArray(file.entities)) throw failure()
        const entries = Object.entries(file.entities), records = entries.map(([, record]) => record)
        if (entries.length > 32768 || entries.some(([id, record]) => !record || !id || record.entity_id !== id
          || record.type !== 'shell' && record.type !== 'agent')) throw failure()
        return records.filter((record): record is BgShellRegistryRecord => record.type === 'shell').sort((a, b) => a.entity_id < b.entity_id ? -1 : a.entity_id > b.entity_id ? 1 : 0)
      }
      const records = await read(), fingerprint = (items: BgShellRegistryRecord[]) => sha256CanonicalJson(items.map(record => this.shellFingerprint(record)))
      const original = fingerprint(records), bindings = new Map(this.shellProcesses), processes: WorkerProcessIdentity[] = []
      for (const record of records) {
        if (!Number.isInteger(record.pid) || record.pid < 1 || record.pid > 2147483647) throw failure()
        const current = bindings.get(record.entity_id)
        if (current) {
          if (current.fingerprint !== this.shellFingerprint(record) || current.pid !== record.pid) throw failure()
          if (!current.exited) {
            if (!current.child || current.child.pid !== record.pid) throw failure()
            const observed = captureHeadlessNativeProcesses(current.child, true)
            if (!('carrier_exited' in observed)) processes.push(...observed)
          }
        } else {
          const native = require(path.join(__dirname, '../../../../scripts/lib/process-identity.cjs'))
          if (native.isProcessExited(record.pid) !== true) throw failure()
        }
      }
      const registered = new Set(records.map(record => record.entity_id))
      for (const [id, binding] of bindings) {
        if (!registered.has(id) && !binding.exited
          && (!binding.child || !('carrier_exited' in captureHeadlessNativeProcesses(binding.child, true)))) throw failure()
      }
      if (fingerprint(await read()) !== original || this.shellProcesses.size !== bindings.size
        || [...bindings].some(([id, binding]) => this.shellProcesses.get(id) !== binding)) throw failure()
      const observed = new Map<string, WorkerProcessIdentity>()
      for (const item of processes) {
        const key = JSON.stringify([item.pid, item.started, item.owner])
        if (!observed.has(key)) observed.set(key, item)
      }
      return Object.freeze([...observed.values()].sort((a, b) => a.pid - b.pid || (a.started < b.started ? -1 : a.started > b.started ? 1 : 0)))
    } catch (error) { throw Object.assign(failure(), { cause: error }) }
  }

  async register(record: BgEntityRecord): Promise<void> {
    await this.mutex.run(async () => {
      const file = await this.readFile()
      const updated: RegistryFile = {
        entities: {
          ...file.entities,
          [record.entity_id]: record,
        },
      }
      await this.writeAtomic(updated)
    })
  }

  async update(entity_id: string, patch: Partial<BgEntityRecord>): Promise<BgEntityRecord | null> {
    return this.mutex.run(async () => {
      const file = await this.readFile()
      const existing = file.entities[entity_id]
      if (!existing) return null

      if (isWorkerOwnedBuiltinAgent(existing) && existing.status !== 'running' &&
        (patch.status !== undefined || ('stop_requested_at' in patch))) return existing

      // Do not allow downgrading from a terminal state that was set intentionally
      // (e.g. kill tool sets 'killed'; exit handler must not overwrite with 'failed').
      const TERMINAL_PRIORITY: ReadonlyArray<BgEntityStatus> = ['killed', 'stalled']
      if (
        TERMINAL_PRIORITY.includes(existing.status) &&
        patch.status !== undefined &&
        !TERMINAL_PRIORITY.includes(patch.status as BgEntityStatus)
      ) {
        return existing
      }

      const next = { ...existing, ...patch } as BgEntityRecord
      if (next.type === 'agent' && isWorkerOwnedBuiltinAgent(next) && existing.status === 'running' && next.status !== 'running') {
        if (next.stop_requested_at) next.status = 'killed'
        else if (!next.exit_notification) {
          next.exit_notification = { status: 'pending', updated_at: next.ended_at ?? new Date().toISOString(), attempts: 0 }
        }
      }
      if (
        next.type === 'shell' &&
        next.owner.worker_id &&
        next.status !== 'running' &&
        next.exit_notification === undefined
      ) {
        const updatedAt = typeof next.ended_at === 'string' ? next.ended_at : new Date().toISOString()
        next.exit_notification = { status: 'pending', updated_at: updatedAt, attempts: 0 }
      }

      await this.writeAtomic({
        entities: {
          ...file.entities,
          [entity_id]: next,
        },
      })
      return next
    })
  }

  async beginExitNotificationAttempt(entityId: string): Promise<void> {
    await this.updateExitNotification(entityId, (state, now) => {
      if (state.status !== 'pending') return state
      const { last_error: _lastError, ...rest } = state
      return { ...rest, status: 'pending', attempts: state.attempts + 1, updated_at: now }
    })
  }

  async recordExitNotificationFailure(entityId: string, error: string): Promise<void> {
    await this.updateExitNotification(entityId, (state, now) => state.status !== 'pending' ? state : ({
      ...state,
      updated_at: now,
      last_error: error,
    }))
  }

  async settleExitNotification(
    entityId: string,
    status: Exclude<BgExitNotificationStatus, 'pending'>,
    reason?: string,
  ): Promise<void> {
    await this.updateExitNotification(entityId, (state, now) => {
      if (state.status !== 'pending') return state
      const { last_error: _lastError, dead_letter_reason: _deadLetterReason, ...rest } = state
      return {
        ...rest,
        status,
        updated_at: now,
        ...(status === 'dead_letter' && reason ? { dead_letter_reason: reason } : {}),
      }
    })
  }

  async get(entity_id: string): Promise<BgEntityRecord | null> {
    const file = await this.readFile()
    return file.entities[entity_id] ?? null
  }

  async list(filter?: {
    owner_friend_id?: string
    status?: ReadonlyArray<BgEntityStatus>
    type?: BgEntityType
    spawned_by_task_id?: string
  }): Promise<BgEntityRecord[]> {
    const file = await this.readFile()
    let records = Object.values(file.entities)

    if (filter?.owner_friend_id !== undefined) {
      const ownerId = filter.owner_friend_id
      records = records.filter((r) => r.owner.friend_id === ownerId)
    }

    if (filter?.status !== undefined) {
      const statuses = filter.status
      records = records.filter((r) => statuses.includes(r.status))
    }

    if (filter?.type !== undefined) {
      const type = filter.type
      records = records.filter((r) => r.type === type)
    }

    if (filter?.spawned_by_task_id !== undefined) {
      const taskId = filter.spawned_by_task_id
      records = records.filter((r) => r.spawned_by_task_id === taskId)
    }

    return records
  }

  async recoverPersistent(): Promise<{
    alive: BgEntityRecord[]
    deadShells: BgShellRegistryRecord[]
    stalledAgents: BgAgentRegistryRecord[]
  }> {
    const file = await this.readFile()
    const alive: BgEntityRecord[] = []
    const deadShells: BgShellRegistryRecord[] = []
    const stalledAgents: BgAgentRegistryRecord[] = []

    const deadShellIds = new Set<string>()
    const addDeadShell = (record: BgShellRegistryRecord): void => {
      if (deadShellIds.has(record.entity_id)) return
      deadShellIds.add(record.entity_id)
      deadShells.push(record)
    }

    for (const rec of Object.values(file.entities)) {
      if (
        rec.type === 'shell' &&
        rec.status !== 'running' &&
        rec.owner.worker_id &&
        rec.exit_notification?.status === 'pending'
      ) {
        addDeadShell(rec)
        continue
      }
      if (rec.status !== 'running') continue

      if (rec.type === 'shell') {
        const reaped = await this.reapShellIfDead(rec)
        if (reaped) {
          const updated = await this.get(rec.entity_id)
          if (updated?.type === 'shell') addDeadShell(updated)
        } else {
          alive.push(rec)
        }
      } else {
        // Agent loops run inside the worker process — after any restart they are gone
        stalledAgents.push(rec)
        await this.update(rec.entity_id, {
          status: 'stalled',
          ended_at: new Date().toISOString(),
        })
      }
    }

    return { alive, deadShells, stalledAgents }
  }

  /**
   * 检查一个 running shell 是否已退出；若是，读 exitcode sentinel 定真实成败、更新 registry 为终态，
   * 返回 `{status, exit_code}`；仍存活返回 null。
   *
   * 供 recoverPersistent（启动对账已死的 shell）与 ReadoptReaper（运行期轮询跨重启认领回来、仍存活
   * 的 shell）共用。sentinel 不存在（强杀 / 没走到写盘）→ 回退 failed/-1。
   */
  async reapShellIfDead(
    rec: BgShellRegistryRecord,
  ): Promise<{ status: 'completed' | 'failed' | 'killed'; exit_code: number } | null> {
    if (await this.isShellAlive(rec)) return null
    const sentinelEc = await this.readSentinelExitCode(rec)
    const status: 'completed' | 'failed' = sentinelEc === 0 ? 'completed' : 'failed'
    const exit_code = sentinelEc ?? -1
    const updated = await this.update(rec.entity_id, {
      status,
      exit_code,
      ended_at: new Date().toISOString(),
    } as Partial<BgShellRegistryRecord>)
    if (updated?.type === 'shell') {
      const settledStatus = updated.status === 'killed' ? 'killed' : updated.status === 'completed' ? 'completed' : 'failed'
      return { status: settledStatus, exit_code: updated.exit_code ?? exit_code }
    }
    return { status, exit_code }
  }

  async gcDeadEntities(now: Date): Promise<{ removed: string[] }> {
    const cutoffMs = now.getTime() - BG_ENTITY_GC_AFTER_DAYS * 24 * 60 * 60 * 1000
    const removed = await this.deleteEntriesWhere((rec) => {
      if (rec.status === 'running' || hasPendingExitNotification(rec)) return false
      // Worker-owned builtin child identities remain addressable while their Worker is retained;
      // the unified Worker retention transaction removes them with that Worker later.
      if (isWorkerOwnedBuiltinAgent(rec)) return false
      const lastActivityMs = new Date(rec.last_activity_at).getTime()
      const endedMs = rec.ended_at ? new Date(rec.ended_at).getTime() : 0
      return Math.max(lastActivityMs, endedMs) < cutoffMs
    })
    return { removed }
  }

  /**
   * task 完成时清理它名下所有**终态** shell（记录 + 日志 + sentinel 文件）；running 的留存。
   * D1 后所有后台 shell 都落账，靠这条在 task 结束即回收，避免 registry / 磁盘日志无限增长
   * （7d gcDeadEntities 只作跨 task / 孤儿兜底）。
   */
  async removeTerminalShellsByTask(taskId: string): Promise<string[]> {
    return this.deleteEntriesWhere(
      (rec) => rec.type === 'shell' &&
        rec.spawned_by_task_id === taskId &&
        rec.status !== 'running' &&
        !hasPendingExitNotification(rec),
    )
  }

  /**
   * 删除所有满足 predicate 的实体（记录 + shell 的日志/sentinel 文件），返回被删 id 列表。
   * gcDeadEntities / removeTerminalShellsByTask 共用——只读盘一次、互斥下原子写一次。
   */
  private async deleteEntriesWhere(predicate: (rec: BgEntityRecord) => boolean): Promise<string[]> {
    const removed: string[] = []
    await this.mutex.run(async () => {
      const file = await this.readFile()
      const entries: Record<string, BgEntityRecord> = { ...file.entities }
      for (const [id, rec] of Object.entries(entries)) {
        if (!predicate(rec)) continue
        if (rec.type === 'shell') await this.unlinkShellFiles(rec)
        delete entries[id]
        removed.push(id)
      }
      // 跳过无操作时的写盘——既减少 IO，也避免在没有 registry.json 的干净环境触发 ENOENT 噪声
      if (removed.length > 0) {
        await this.writeAtomic({ entities: entries })
        for (const id of removed) {
          const binding = this.shellProcesses.get(id)
          if (!binding) continue
          binding.removed = true
          if (binding.exited) this.shellProcesses.delete(id)
        }
      }
    })
    return removed
  }

  /** 删除一个 shell 的磁盘日志 + sidecar/sentinel；不存在则忽略。 */
  private async unlinkShellFiles(rec: BgShellRegistryRecord): Promise<void> {
    const logFile = rec.log_file
    await Promise.all(
      [
        logFile,
        exitcodeFileForLog(logFile),
        stdoutFileForLog(logFile),
        stderrFileForLog(logFile),
        stdoutFifoForLog(logFile),
        stderrFifoForLog(logFile),
      ].map((f) =>
        fs.unlink(f).catch(() => {
          /* 文件不存在 / 已删 — 忽略 */
        }),
      ),
    )
  }

  async countActiveByOwner(friend_id: string): Promise<number> {
    const running = await this.list({ owner_friend_id: friend_id, status: ['running'] })
    return running.length
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private async updateExitNotification(
    entityId: string,
    mutate: (
      state: NonNullable<BgShellRegistryRecord['exit_notification']>,
      now: string,
    ) => NonNullable<BgShellRegistryRecord['exit_notification']>,
  ): Promise<void> {
    await this.mutex.run(async () => {
      const file = await this.readFile()
      const existing = file.entities[entityId]
      if (!existing || existing.exit_notification === undefined) return
      const next: BgEntityRecord = {
        ...existing,
        exit_notification: mutate(existing.exit_notification, new Date().toISOString()),
      }
      await this.writeAtomic({
        entities: {
          ...file.entities,
          [entityId]: next,
        },
      })
    })
  }

  private async readFile(): Promise<RegistryFile> {
    try {
      const raw = await fs.readFile(this.registryPath, 'utf8')
      return JSON.parse(raw) as RegistryFile
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { entities: {} }
      throw error
    }
  }

  private async writeAtomic(file: RegistryFile): Promise<void> {
    await fs.mkdir(path.dirname(this.registryPath), { recursive: true })

    const tmp = `${this.registryPath}.tmp.${process.pid}.${Date.now()}`
    await fs.writeFile(tmp, JSON.stringify(file, null, 2), 'utf8')
    for (let attempt = 0; ; attempt++) {
      try { await fs.rename(tmp, this.registryPath); return }
      catch (error) {
        if (process.platform !== 'win32' || (error as NodeJS.ErrnoException).code !== 'EPERM' || attempt >= 5) throw error
        await new Promise(resolve => setTimeout(resolve, 50 * (attempt + 1)))
      }
    }
  }

  /**
   * 读 shell 的 exitcode sentinel（`<entity>.exitcode`）。返回解析出的退出码；
   * 文件缺失 / 内容非法 → null（进程被强杀或没走到写盘那步）。
   */
  private async readSentinelExitCode(rec: BgShellRegistryRecord): Promise<number | null> {
    try {
      const raw = await fs.readFile(exitcodeFileForLog(rec.log_file), 'utf8')
      const ec = Number.parseInt(raw.trim(), 10)
      return Number.isNaN(ec) ? null : ec
    } catch {
      return null
    }
  }

  private async isShellAlive(rec: BgShellRegistryRecord): Promise<boolean> {
    // Step 1: check process exists via kill -0
    try {
      process.kill(rec.pid, 0)
    } catch {
      return false
    }

    // Step 2: anti-PID-reuse guard — compare recorded starttime vs current
    const currentStart = await readProcStartTime(rec.pid).catch(() => null)
    if (!currentStart) return false

    const recordedMs = new Date(rec.process_started_at).getTime()
    const currentMs = new Date(currentStart).getTime()
    return Math.abs(recordedMs - currentMs) < 5000
  }
}
