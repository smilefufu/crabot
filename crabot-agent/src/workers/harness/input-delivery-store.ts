import { promises as fs } from 'fs'
import { AsyncMutex } from '../async-mutex'
import type { ManagerKey } from './ledger-types'
import { normalizeReceiptPreview, readReceiptFile, receiptFilePath, writeReceiptFile } from './receipt-store-io'

export type InputDeliveryFailureCode =
  | 'target_unavailable'
  | 'task_cancelled'
  | 'continuation_failed'
  | 'input_surface_timeout'
  | 'submission_unconfirmed_timeout'
  | 'delivery_attempt_failed'
  | 'abandoned_by_control_input'
  | 'confirmation_lost_after_restart'

export type InputDeliveryFailure = {
  reason_code: InputDeliveryFailureCode
  reason: string
  certainty: 'not_delivered' | 'unknown'
}

export interface WorkerInputDeliveryReceipt {
  delivery_id: string
  worker_id: string
  manager_key: ManagerKey
  raw: boolean
  text_preview: string
  created_at: string
  updated_at: string
  deadline_at: string
  state: 'pending' | 'delivered' | 'failed'
  phase?: 'queued' | 'attempting' | 'waiting_for_safe_input' | 'pending_in_ui' | 'continuing'
  failure?: InputDeliveryFailure
  manager_notification: {
    status: 'not_required' | 'pending' | 'consumed'
    consumed_at?: string
  }
}

export type SendToWorkerResult =
  | { status: 'delivered'; delivery_id: string; worker_id: string }
  | {
      status: 'pending'
      delivery_id: string
      worker_id: string
      pending_reason: 'waiting_for_safe_input' | 'submission_unconfirmed'
      deadline_at: string
    }
  | {
      status: 'failed'
      delivery_id: string
      worker_id: string
      reason_code: InputDeliveryFailureCode
      reason: string
      certainty: 'not_delivered' | 'unknown'
    }

const FILENAME = 'input-deliveries.json'

export class InputDeliveryStore {
  private readonly mutexes = new Map<string, AsyncMutex>()

  constructor(private readonly workersDir: string) {}

  async create(receipt: WorkerInputDeliveryReceipt): Promise<WorkerInputDeliveryReceipt> {
    if (receipt.state !== 'pending' || receipt.manager_notification.status !== 'not_required') {
      throw new Error('new input delivery receipt must be pending with notification not_required')
    }
    const normalized: WorkerInputDeliveryReceipt = {
      ...receipt,
      text_preview: normalizeReceiptPreview(receipt.text_preview),
    }
    return this.mutate(receipt.worker_id, (receipts) => {
      if (receipts.some((item) => item.delivery_id === receipt.delivery_id)) {
        throw new Error(`duplicate delivery_id: ${receipt.delivery_id}`)
      }
      receipts.push(normalized)
      return normalized
    })
  }

  async get(workerId: string, deliveryId: string): Promise<WorkerInputDeliveryReceipt | undefined> {
    return this.getMutex(workerId).run(async () => {
      const receipts = await this.read(workerId)
      return receipts.find((receipt) => receipt.delivery_id === deliveryId)
    })
  }

  async list(workerId: string): Promise<WorkerInputDeliveryReceipt[]> {
    return this.getMutex(workerId).run(() => this.read(workerId))
  }

  async listPendingNotifications(): Promise<WorkerInputDeliveryReceipt[]> {
    const result: WorkerInputDeliveryReceipt[] = []
    for (const workerId of await this.workerIds()) {
      result.push(...(await this.list(workerId)).filter((receipt) =>
        receipt.state !== 'pending' && receipt.manager_notification.status === 'pending'))
    }
    return result
  }

  async listPendingDeliveries(): Promise<WorkerInputDeliveryReceipt[]> {
    const result: WorkerInputDeliveryReceipt[] = []
    for (const workerId of await this.workerIds()) {
      result.push(...(await this.list(workerId)).filter((receipt) => receipt.state === 'pending'))
    }
    return result
  }

  async updatePendingPhase(
    workerId: string,
    deliveryId: string,
    phase: NonNullable<WorkerInputDeliveryReceipt['phase']>,
    updatedAt: string,
  ): Promise<WorkerInputDeliveryReceipt> {
    return this.mutateReceipt(workerId, deliveryId, (receipt) => {
      if (receipt.state !== 'pending') return receipt
      return { ...receipt, phase, updated_at: updatedAt }
    })
  }

  async readForToolResult(workerId: string, deliveryId: string, updatedAt: string): Promise<WorkerInputDeliveryReceipt> {
    return this.getMutex(workerId).run(async () => {
      const receipts = await this.read(workerId)
      const index = receipts.findIndex((receipt) => receipt.delivery_id === deliveryId)
      if (index < 0) throw new Error(`delivery receipt not found: ${deliveryId}`)
      const receipt = receipts[index]
      if (receipt.state !== 'pending' || receipt.manager_notification.status !== 'not_required') return receipt
      const next: WorkerInputDeliveryReceipt = {
        ...receipt,
        updated_at: updatedAt,
        manager_notification: { status: 'pending' },
      }
      receipts[index] = next
      await writeReceiptFile(this.path(workerId), receipts)
      return next
    })
  }

  async settleDelivered(workerId: string, deliveryId: string, updatedAt: string): Promise<WorkerInputDeliveryReceipt> {
    return this.mutateReceipt(workerId, deliveryId, (receipt) => {
      this.assertPending(receipt)
      return { ...receipt, state: 'delivered', updated_at: updatedAt }
    })
  }

  async settleFailed(
    workerId: string,
    deliveryId: string,
    failure: InputDeliveryFailure,
    updatedAt: string,
  ): Promise<WorkerInputDeliveryReceipt> {
    return this.mutateReceipt(workerId, deliveryId, (receipt) => {
      this.assertPending(receipt)
      return {
        ...receipt,
        state: 'failed',
        failure,
        updated_at: updatedAt,
        manager_notification: { status: 'pending' },
      }
    })
  }

  async markNotificationConsumed(
    workerId: string,
    deliveryId: string,
    consumedAt: string,
  ): Promise<WorkerInputDeliveryReceipt> {
    return this.mutateReceipt(workerId, deliveryId, (receipt) => {
      if (receipt.state === 'pending' || receipt.manager_notification.status !== 'pending') {
        throw new Error(`delivery ${deliveryId} has no pending terminal notification`)
      }
      return {
        ...receipt,
        updated_at: consumedAt,
        manager_notification: { status: 'consumed', consumed_at: consumedAt },
      }
    })
  }

  private assertPending(receipt: WorkerInputDeliveryReceipt): void {
    if (receipt.state !== 'pending') {
      throw new Error(`delivery ${receipt.delivery_id} is already terminal (${receipt.state})`)
    }
  }

  private async mutateReceipt(
    workerId: string,
    deliveryId: string,
    mutator: (receipt: WorkerInputDeliveryReceipt) => WorkerInputDeliveryReceipt,
  ): Promise<WorkerInputDeliveryReceipt> {
    return this.mutate(workerId, (receipts) => {
      const index = receipts.findIndex((receipt) => receipt.delivery_id === deliveryId)
      if (index < 0) throw new Error(`delivery receipt not found: ${deliveryId}`)
      const next = mutator(receipts[index])
      receipts[index] = next
      return next
    })
  }

  private async mutate<T>(
    workerId: string,
    mutator: (receipts: WorkerInputDeliveryReceipt[]) => T,
  ): Promise<T> {
    return this.getMutex(workerId).run(async () => {
      const receipts = await this.read(workerId)
      const result = mutator(receipts)
      await writeReceiptFile(this.path(workerId), receipts)
      return result
    })
  }

  private read(workerId: string): Promise<WorkerInputDeliveryReceipt[]> {
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
