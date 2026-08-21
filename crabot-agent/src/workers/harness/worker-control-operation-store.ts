import { randomUUID } from 'crypto'
import { promises as fs } from 'fs'
import { dirname, join } from 'path'
import { AsyncMutex } from '../async-mutex.js'
import type { IncarnationId, WorkerImplId } from '../types.js'
import type { ManagerKey } from './ledger-types.js'

export type WorkerControlOperationKind = 'ui_response' | 'interrupt' | 'stop'
export type WorkerControlOperationStatus = 'accepted' | 'executing' | 'verifying' | 'succeeded' | 'failed' | 'unknown'

export interface WorkerControlOperation {
  readonly operation_id: string
  readonly worker_id: string
  readonly manager_key: ManagerKey
  readonly incarnation_id: IncarnationId
  readonly impl: WorkerImplId
  readonly seq: number
  readonly kind: WorkerControlOperationKind
  readonly status: WorkerControlOperationStatus
  readonly created_at: string
  readonly settled_at?: string
  readonly detail?: string
}

interface ControlOperationFile {
  readonly version: 1
  readonly operations: WorkerControlOperation[]
  readonly notifications: ControlOperationNotification[]
  /** Harness-private recovery marker; it is intentionally not part of the Manager operation view. */
  readonly handoff_supersede_operations: string[]
}

/** The immutable operation body is the notification payload; this is its durable delivery state. */
interface ControlOperationNotification {
  readonly operation_id: string
  readonly event_written: boolean
  readonly consumed_at?: string
}

export interface PendingControlOperationNotification {
  readonly operation: WorkerControlOperation
  readonly event_written: boolean
}

async function writeAtomic(path: string, contents: string): Promise<void> {
  const temporary = join(dirname(path), `.${randomUUID()}.tmp`)
  await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 })
  try {
    await fs.writeFile(temporary, contents, { encoding: 'utf8', mode: 0o600 })
    await fs.rename(temporary, path)
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => undefined)
    throw error
  }
}

/** Durable operation state. A Manager tool result only acknowledges admission; settlement is separate. */
export class WorkerControlOperationStore {
  private readonly mutexes = new Map<string, AsyncMutex>()

  constructor(private readonly workersDir: string) {}

  async create(
    params: Omit<WorkerControlOperation, 'operation_id' | 'status'>,
    options?: { readonly handoffSupersede?: boolean },
  ): Promise<WorkerControlOperation> {
    return this.mutex(params.worker_id).run(async () => {
      const file = await this.read(params.worker_id)
      const operation: WorkerControlOperation = { ...params, operation_id: randomUUID(), status: 'accepted' }
      await this.write(params.worker_id, {
        ...file,
        operations: [...file.operations, operation],
        handoff_supersede_operations: options?.handoffSupersede
          ? [...file.handoff_supersede_operations, operation.operation_id]
          : file.handoff_supersede_operations,
      })
      return operation
    })
  }

  async isHandoffSupersede(workerId: string, operationId: string): Promise<boolean> {
    return this.mutex(workerId).run(async () =>
      (await this.read(workerId)).handoff_supersede_operations.includes(operationId),
    )
  }

  async get(workerId: string, operationId: string): Promise<WorkerControlOperation | undefined> {
    return this.mutex(workerId).run(async () => (await this.read(workerId)).operations.find((item) => item.operation_id === operationId))
  }

  async active(workerId: string): Promise<WorkerControlOperation[]> {
    return this.mutex(workerId).run(async () =>
      (await this.read(workerId)).operations.filter((item) => !isSettled(item.status)),
    )
  }

  async pendingNotifications(workerId: string): Promise<PendingControlOperationNotification[]> {
    return this.mutex(workerId).run(async () => {
      const file = await this.read(workerId)
      return file.notifications
        .filter((notification) => notification.consumed_at === undefined)
        .flatMap((notification) => {
          const operation = file.operations.find((item) => item.operation_id === notification.operation_id)
          return operation ? [{ operation, event_written: notification.event_written }] : []
        })
    })
  }

  async markEventWritten(workerId: string, operationId: string): Promise<void> {
    await this.patchNotification(workerId, operationId, (notification) => ({ ...notification, event_written: true }))
  }

  async markNotificationConsumed(workerId: string, operationId: string, consumedAt: string): Promise<void> {
    await this.patchNotification(workerId, operationId, (notification) => ({ ...notification, consumed_at: consumedAt }))
  }

  async transition(
    workerId: string,
    operationId: string,
    status: WorkerControlOperationStatus,
    now: string,
    detail?: string,
  ): Promise<WorkerControlOperation> {
    return this.mutex(workerId).run(async () => {
      const file = await this.read(workerId)
      const index = file.operations.findIndex((item) => item.operation_id === operationId)
      if (index < 0) throw new Error(`worker control operation not found: ${operationId}`)
      const current = file.operations[index]
      if (isSettled(current.status)) return current
      const next: WorkerControlOperation = {
        ...current,
        status,
        ...(isSettled(status) ? { settled_at: now } : {}),
        ...(detail ? { detail } : {}),
      }
      const operations = [...file.operations]
      operations[index] = next
      const notifications = isSettled(status)
        ? ensureNotification(file.notifications, operationId)
        : file.notifications
      await this.write(workerId, {
        version: 1,
        operations,
        notifications,
        handoff_supersede_operations: file.handoff_supersede_operations,
      })
      return next
    })
  }

  private async patchNotification(
    workerId: string,
    operationId: string,
    update: (notification: ControlOperationNotification) => ControlOperationNotification,
  ): Promise<void> {
    await this.mutex(workerId).run(async () => {
      const file = await this.read(workerId)
      const index = file.notifications.findIndex((notification) => notification.operation_id === operationId)
      if (index < 0) throw new Error(`worker control operation notification not found: ${operationId}`)
      const notifications = [...file.notifications]
      notifications[index] = update(notifications[index])
      await this.write(workerId, { ...file, notifications })
    })
  }

  private mutex(workerId: string): AsyncMutex {
    let mutex = this.mutexes.get(workerId)
    if (!mutex) {
      mutex = new AsyncMutex()
      this.mutexes.set(workerId, mutex)
    }
    return mutex
  }

  private path(workerId: string): string {
    return join(this.workersDir, workerId, 'control-operations.json')
  }

  private async read(workerId: string): Promise<ControlOperationFile> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.path(workerId), 'utf8')) as Partial<ControlOperationFile>
      if (parsed.version !== 1 || !Array.isArray(parsed.operations)) throw new Error('invalid worker control operation file')
      return {
        version: 1,
        operations: parsed.operations as WorkerControlOperation[],
        notifications: Array.isArray(parsed.notifications) ? parsed.notifications as ControlOperationNotification[] : [],
        handoff_supersede_operations: Array.isArray(parsed.handoff_supersede_operations)
          ? parsed.handoff_supersede_operations.filter((item): item is string => typeof item === 'string')
          : [],
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { version: 1, operations: [], notifications: [], handoff_supersede_operations: [] }
      }
      throw error
    }
  }

  private async write(workerId: string, file: ControlOperationFile): Promise<void> {
    await writeAtomic(this.path(workerId), JSON.stringify(file, null, 2) + '\n')
  }
}

export function isSettled(status: WorkerControlOperationStatus): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'unknown'
}

function ensureNotification(
  notifications: readonly ControlOperationNotification[],
  operationId: string,
): ControlOperationNotification[] {
  if (notifications.some((notification) => notification.operation_id === operationId)) return [...notifications]
  return [...notifications, { operation_id: operationId, event_written: false }]
}
