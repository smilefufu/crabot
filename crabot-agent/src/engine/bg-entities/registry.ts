/**
 * BgEntityRegistry — disk-backed registry for background entities.
 * Atomic writes via tmp-file + rename; in-process AsyncMutex for serialization.
 *
 * Spec: crabot-docs/superpowers/specs/2026-05-01-long-running-agent-design.md §6.1
 * Plan: crabot-docs/superpowers/plans/2026-05-01-long-running-agent-plan-2.md  Task 3
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { getBgEntitiesRegistryPath } from '../../core/data-paths'
import { exitcodeFileForLog, readProcStartTime } from './bg-shell'
import {
  BG_ENTITY_GC_AFTER_DAYS,
  type BgAgentRegistryRecord,
  type BgEntityRecord,
  type BgEntityStatus,
  type BgEntityType,
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

// ---------------------------------------------------------------------------
// PID starttime helper：复用 bg-shell 的健壮版（带 ps-parse 失败兜底），避免重复实现，
// 也避免本文件旧拷贝在某些 locale 下 `new Date(...).toISOString()` 在 execFile 回调里
// 同步抛、绕过 isShellAlive 的 `.catch` 而未捕获崩溃。
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export class BgEntityRegistry {
  private readonly mutex = new AsyncMutex()

  constructor(private readonly registryPath: string = getBgEntitiesRegistryPath()) {}

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

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

  async update(entity_id: string, patch: Partial<BgEntityRecord>): Promise<void> {
    await this.mutex.run(async () => {
      const file = await this.readFile()
      const existing = file.entities[entity_id]
      if (!existing) return

      // Do not allow downgrading from a terminal state that was set intentionally
      // (e.g. kill tool sets 'killed'; exit handler must not overwrite with 'failed').
      const TERMINAL_PRIORITY: ReadonlyArray<BgEntityStatus> = ['killed', 'stalled']
      if (
        TERMINAL_PRIORITY.includes(existing.status) &&
        patch.status !== undefined &&
        !TERMINAL_PRIORITY.includes(patch.status as BgEntityStatus)
      ) {
        return
      }

      const updated: RegistryFile = {
        entities: {
          ...file.entities,
          [entity_id]: { ...existing, ...patch } as BgEntityRecord,
        },
      }
      await this.writeAtomic(updated)
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

    for (const rec of Object.values(file.entities)) {
      if (rec.status !== 'running') continue

      if (rec.type === 'shell') {
        const reaped = await this.reapShellIfDead(rec)
        if (reaped) {
          // 带上终态返回，便于调用方据此发准确的退出通知。
          deadShells.push({ ...rec, status: reaped.status, exit_code: reaped.exit_code, ended_at: new Date().toISOString() })
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
  ): Promise<{ status: 'completed' | 'failed'; exit_code: number } | null> {
    if (await this.isShellAlive(rec)) return null
    const sentinelEc = await this.readSentinelExitCode(rec)
    const status: 'completed' | 'failed' = sentinelEc === 0 ? 'completed' : 'failed'
    const exit_code = sentinelEc ?? -1
    await this.update(rec.entity_id, {
      status,
      exit_code,
      ended_at: new Date().toISOString(),
    } as Partial<BgShellRegistryRecord>)
    return { status, exit_code }
  }

  async gcDeadEntities(now: Date): Promise<{ removed: string[] }> {
    const removed: string[] = []
    const cutoffMs = now.getTime() - BG_ENTITY_GC_AFTER_DAYS * 24 * 60 * 60 * 1000

    await this.mutex.run(async () => {
      const file = await this.readFile()
      const entries: Record<string, BgEntityRecord> = { ...file.entities }

      for (const [id, rec] of Object.entries(entries)) {
        if (rec.status === 'running') continue

        const lastActivityMs = new Date(rec.last_activity_at).getTime()
        const endedMs = rec.ended_at ? new Date(rec.ended_at).getTime() : 0
        const latestMs = Math.max(lastActivityMs, endedMs)

        if (latestMs < cutoffMs) {
          delete entries[id]
          removed.push(id)
        }
      }

      // 跳过无操作时的写盘——既减少不必要的 IO，也避免在没有 registry.json 的
      // 干净环境（测试 / 全新 worker 启动）触发 ENOENT 噪声
      if (removed.length > 0) {
        await this.writeAtomic({ entities: entries })
      }
    })

    return { removed }
  }

  async countActiveByOwner(friend_id: string): Promise<number> {
    const running = await this.list({ owner_friend_id: friend_id, status: ['running'] })
    return running.length
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private async readFile(): Promise<RegistryFile> {
    try {
      const raw = await fs.readFile(this.registryPath, 'utf8')
      return JSON.parse(raw) as RegistryFile
    } catch {
      return { entities: {} }
    }
  }

  private async writeAtomic(file: RegistryFile): Promise<void> {
    await fs.mkdir(path.dirname(this.registryPath), { recursive: true })

    const tmp = `${this.registryPath}.tmp.${process.pid}.${Date.now()}`
    await fs.writeFile(tmp, JSON.stringify(file, null, 2), 'utf8')
    await fs.rename(tmp, this.registryPath)
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
