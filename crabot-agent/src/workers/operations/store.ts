/**
 * Worker operation store + controller（P6-B plan §9 Agent 侧）。
 *
 * - operation 先落 accepted/running 再执行；terminal state 与脱敏 detail 原子更新；
 * - Agent 重启把 running 标 interrupted（不 adopt）；
 * - 同 impl 的 mutating operation 互斥由 controller 保证。
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { CLIWorkerImplId } from '../types.js'

export type WorkerOperationKind = 'install' | 'setup' | 'verify' | 'cancel'
export type WorkerOperationState = 'accepted' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted'

export interface WorkerOperationRecord {
  operation_id: string
  kind: WorkerOperationKind
  impl: CLIWorkerImplId
  state: WorkerOperationState
  /** 脱敏 detail（不得含 credential/endpoint/terminal bytes）。 */
  detail?: string
  created_at: string
  updated_at: string
}

export class WorkerOperationStore {
  private readonly filePath: string
  private records: Map<string, WorkerOperationRecord> = new Map()
  private loaded = false

  constructor(agentDataDir: string) {
    this.filePath = path.join(agentDataDir, 'worker-impls', 'operations.json')
  }

  async load(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    let raw: string
    try {
      raw = await fs.readFile(this.filePath, 'utf-8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    const parsed = JSON.parse(raw) as WorkerOperationRecord[]
    if (!Array.isArray(parsed)) throw new Error('[WorkerOperationStore] corrupt operations.json')
    for (const record of parsed) this.records.set(record.operation_id, record)
    // 启动收口：running/accepted → interrupted（Agent 不 adopt 旧 operation）。
    let dirty = false
    for (const record of this.records.values()) {
      if (record.state === 'running' || record.state === 'accepted') {
        record.state = 'interrupted'
        record.updated_at = new Date().toISOString()
        dirty = true
      }
    }
    if (dirty) await this.persist()
  }

  get(id: string): WorkerOperationRecord | undefined {
    return this.records.get(id)
  }

  list(): WorkerOperationRecord[] {
    return [...this.records.values()]
  }

  /** 同 impl 是否有未终态 operation（互斥判据）。 */
  hasActiveFor(impl: CLIWorkerImplId): boolean {
    for (const record of this.records.values()) {
      if (record.impl === impl && (record.state === 'accepted' || record.state === 'running')) return true
    }
    return false
  }

  private static readonly MAX_RECORDS = 200

  async upsert(record: WorkerOperationRecord): Promise<void> {
    this.records.set(record.operation_id, { ...record, updated_at: new Date().toISOString() })
    // 有界：超出上限时最老的终态记录先删（accepted/running 永不裁）。
    if (this.records.size > WorkerOperationStore.MAX_RECORDS) {
      const terminal = [...this.records.values()]
        .filter((r) => r.state !== 'accepted' && r.state !== 'running')
        .sort((a, b) => a.updated_at.localeCompare(b.updated_at))
      while (this.records.size > WorkerOperationStore.MAX_RECORDS && terminal.length > 0) {
        const oldest = terminal.shift()!
        this.records.delete(oldest.operation_id)
      }
    }
    await this.persist()
  }

  private async persist(): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 })
    const tmpPath = `${this.filePath}.tmp-${process.pid}`
    await fs.writeFile(tmpPath, JSON.stringify([...this.records.values()]), { mode: 0o600 })
    await fs.rename(tmpPath, this.filePath)
  }
}
