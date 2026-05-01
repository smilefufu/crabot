/**
 * BgEntityRegistry — disk-backed registry for background entities.
 * Atomic writes via tmp-file + rename; in-process AsyncMutex for serialization.
 *
 * Spec: crabot-docs/superpowers/specs/2026-05-01-long-running-agent-design.md §6.1
 * Plan: crabot-docs/superpowers/plans/2026-05-01-long-running-agent-plan-2.md  Task 3
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { getBgEntitiesRegistryPath } from '../../core/data-paths'
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
// PID starttime helper (cross-platform via `ps -o lstart=`)
// ---------------------------------------------------------------------------

async function readProcStartTime(pid: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('ps', ['-o', 'lstart=', '-p', String(pid)], (err, stdout) => {
      if (err) {
        reject(err)
      } else {
        resolve(new Date(stdout.trim()).toISOString())
      }
    })
  })
}

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
        const isAlive = await this.isShellAlive(rec)
        if (isAlive) {
          alive.push(rec)
        } else {
          deadShells.push(rec)
          await this.update(rec.entity_id, {
            status: 'failed',
            exit_code: -1,
            ended_at: new Date().toISOString(),
          })
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

      await this.writeAtomic({ entities: entries })
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
