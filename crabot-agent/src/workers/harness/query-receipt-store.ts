import { promises as fs } from 'fs'
import { AsyncMutex } from '../async-mutex'
import type { ManagerKey } from './ledger-types'
import { normalizeReceiptPreview, readReceiptFile, receiptFilePath, writeReceiptFile } from './receipt-store-io'

export type QueryFailureCode =
  | 'fork_capability_unavailable'
  | 'fork_create_failed'
  | 'query_submit_failed'
  | 'fork_record_failed'
  | 'fork_establishment_timeout'
  | 'fork_establishment_lost_after_restart'
  | 'query_execution_failed'
  | 'query_execution_lost_after_restart'

export type QueryFailure = {
  reason_code: QueryFailureCode
  reason: string
  phase: 'establishment' | 'execution'
  certainty: 'not_started' | 'failed' | 'unknown'
}

export interface WorkerQueryReceipt {
  query_id: string
  worker_id: string
  manager_key: ManagerKey
  question_preview: string
  created_at: string
  updated_at: string
  establishment_deadline_at: string
  state: 'starting' | 'running' | 'completed' | 'failed'
  fork_seq?: number
  failure?: QueryFailure
  manager_notification: {
    status: 'not_required' | 'pending' | 'consumed'
    consumed_at?: string
  }
}

export interface QueryWorkerStartedResult {
  status: 'started'
  query_id: string
  worker_id: string
  fork_seq: number
}

const FILENAME = 'query-receipts.json'

export class QueryReceiptStore {
  private readonly mutexes = new Map<string, AsyncMutex>()

  constructor(private readonly workersDir: string) {}

  async create(receipt: WorkerQueryReceipt): Promise<WorkerQueryReceipt> {
    if (receipt.state !== 'starting' || receipt.manager_notification.status !== 'not_required') {
      throw new Error('new query receipt must be starting with notification not_required')
    }
    const normalized: WorkerQueryReceipt = {
      ...receipt,
      question_preview: normalizeReceiptPreview(receipt.question_preview),
    }
    return this.mutate(receipt.worker_id, (receipts) => {
      if (receipts.some((item) => item.query_id === receipt.query_id)) {
        throw new Error(`duplicate query_id: ${receipt.query_id}`)
      }
      receipts.push(normalized)
      return normalized
    })
  }

  async get(workerId: string, queryId: string): Promise<WorkerQueryReceipt | undefined> {
    return this.getMutex(workerId).run(async () => {
      const receipts = await this.read(workerId)
      return receipts.find((receipt) => receipt.query_id === queryId)
    })
  }

  async list(workerId: string): Promise<WorkerQueryReceipt[]> {
    return this.getMutex(workerId).run(() => this.read(workerId))
  }

  async listPendingNotifications(): Promise<WorkerQueryReceipt[]> {
    const result: WorkerQueryReceipt[] = []
    for (const workerId of await this.workerIds()) {
      result.push(...(await this.list(workerId)).filter((receipt) =>
        (receipt.state === 'completed' || receipt.state === 'failed') &&
        receipt.manager_notification.status === 'pending'))
    }
    return result
  }

  async listInFlight(): Promise<WorkerQueryReceipt[]> {
    const result: WorkerQueryReceipt[] = []
    for (const workerId of await this.workerIds()) {
      result.push(...(await this.list(workerId)).filter((receipt) =>
        receipt.state === 'starting' || receipt.state === 'running'))
    }
    return result
  }

  async markRunning(
    workerId: string,
    queryId: string,
    forkSeq: number,
    updatedAt: string,
  ): Promise<WorkerQueryReceipt> {
    return this.mutateReceipt(workerId, queryId, (receipt) => {
      this.assertNotTerminal(receipt)
      if (receipt.state !== 'starting') throw new Error(`query ${queryId} is not starting`)
      return { ...receipt, state: 'running', fork_seq: forkSeq, updated_at: updatedAt }
    })
  }

  async settleCompleted(workerId: string, queryId: string, updatedAt: string): Promise<WorkerQueryReceipt> {
    return this.mutateReceipt(workerId, queryId, (receipt) => {
      this.assertNotTerminal(receipt)
      if (receipt.state !== 'running') throw new Error(`query ${queryId} must be running before completion`)
      return {
        ...receipt,
        state: 'completed',
        updated_at: updatedAt,
        manager_notification: { status: 'pending' },
      }
    })
  }

  async settleFailed(
    workerId: string,
    queryId: string,
    failure: QueryFailure,
    updatedAt: string,
  ): Promise<WorkerQueryReceipt> {
    return this.mutateReceipt(workerId, queryId, (receipt) => {
      this.assertNotTerminal(receipt)
      return {
        ...receipt,
        state: 'failed',
        failure,
        updated_at: updatedAt,
        manager_notification: { status: 'pending' },
      }
    })
  }

  async markNotificationConsumed(workerId: string, queryId: string, consumedAt: string): Promise<WorkerQueryReceipt> {
    return this.mutateReceipt(workerId, queryId, (receipt) => {
      if (receipt.state === 'starting' || receipt.state === 'running') {
        throw new Error(`query ${queryId} is not terminal`)
      }
      if (receipt.manager_notification.status !== 'pending') {
        throw new Error(`query ${queryId} has no pending terminal notification`)
      }
      return {
        ...receipt,
        updated_at: consumedAt,
        manager_notification: { status: 'consumed', consumed_at: consumedAt },
      }
    })
  }

  private assertNotTerminal(receipt: WorkerQueryReceipt): void {
    if (receipt.state === 'completed' || receipt.state === 'failed') {
      throw new Error(`query ${receipt.query_id} is already terminal (${receipt.state})`)
    }
  }

  private async mutateReceipt(
    workerId: string,
    queryId: string,
    mutator: (receipt: WorkerQueryReceipt) => WorkerQueryReceipt,
  ): Promise<WorkerQueryReceipt> {
    return this.mutate(workerId, (receipts) => {
      const index = receipts.findIndex((receipt) => receipt.query_id === queryId)
      if (index < 0) throw new Error(`query receipt not found: ${queryId}`)
      const next = mutator(receipts[index])
      receipts[index] = next
      return next
    })
  }

  private async mutate<T>(workerId: string, mutator: (receipts: WorkerQueryReceipt[]) => T): Promise<T> {
    return this.getMutex(workerId).run(async () => {
      const receipts = await this.read(workerId)
      const result = mutator(receipts)
      await writeReceiptFile(this.path(workerId), receipts)
      return result
    })
  }

  private read(workerId: string): Promise<WorkerQueryReceipt[]> {
    return readReceiptFile(this.path(workerId))
  }

  private path(workerId: string): string {
    return receiptFilePath(this.workersDir, workerId, FILENAME)
  }

  private getMutex(workerId: string): AsyncMutex {
    let mutex = this.mutexes.get(workerId)
    if (!mutex) {
      mutex = new AsyncMutex()
      this.mutexes.set(workerId, mutex)
    }
    return mutex
  }

  private async workerIds(): Promise<string[]> {
    try {
      return (await fs.readdir(this.workersDir, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
  }
}
