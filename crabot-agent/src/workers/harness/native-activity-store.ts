import { randomUUID } from 'crypto'
import { promises as fs } from 'fs'
import { dirname, join } from 'path'
import { AsyncMutex } from '../async-mutex.js'
import type { IncarnationId, NormalizedTraceEvent, WorkerImplId } from '../types.js'
import type { ManagerKey } from './ledger-types.js'
import type { HarnessEvent } from './worker-events.js'

export interface NativeActivityCursor {
  readonly incarnation_id: IncarnationId
  readonly impl: WorkerImplId
  readonly seq: number
  readonly offset: number
}

export interface PendingActivityNotification {
  readonly notification_id: string
  readonly worker_id: string
  readonly manager_key: ManagerKey
  readonly incarnation_id: IncarnationId
  readonly impl: WorkerImplId
  readonly seq: number
  readonly activity_from: string
  readonly activity_through: string
  readonly preview: string
  readonly event: HarnessEvent
  readonly event_written: boolean
  readonly consumed_at?: string
}

/**
 * A Harness-owned copy of the adapter's normalized, redacted activity projection. It is a
 * handoff fallback only; the native session remains the preferred source of truth.
 */
export interface PersistedNativeActivity {
  readonly incarnation_id: IncarnationId
  readonly impl: WorkerImplId
  readonly seq: number
  readonly ts: string
  readonly kind: NormalizedTraceEvent['kind']
  readonly role?: NormalizedTraceEvent['role']
  readonly summary: string
  readonly source_offset?: number
}

interface ActivityState {
  readonly version: 1
  readonly cursors: NativeActivityCursor[]
  readonly activities: PersistedNativeActivity[]
  readonly notifications: PendingActivityNotification[]
}

async function writeAtomic(path: string, contents: string): Promise<void> {
  const temp = join(dirname(path), `.${randomUUID()}.tmp`)
  await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 })
  try {
    await fs.writeFile(temp, contents, { encoding: 'utf8', mode: 0o600 })
    await fs.rename(temp, path)
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => undefined)
    throw error
  }
}

/**
 * Durable native-trace high-water marks and activity delivery responsibilities.
 * The native session remains preferred; this store retains its normalized, redacted observations
 * for Manager notification recovery and handoff when the source becomes unreadable.
 */
export class NativeActivityStore {
  private readonly mutexes = new Map<string, AsyncMutex>()

  constructor(private readonly workersDir: string) {}

  async cursor(workerId: string, incarnationId: IncarnationId): Promise<number> {
    return this.mutex(workerId).run(async () =>
      (await this.read(workerId)).cursors.find((item) => item.incarnation_id === incarnationId)?.offset ?? 0,
    )
  }

  async activities(workerId: string, incarnationId: IncarnationId): Promise<PersistedNativeActivity[]> {
    return this.mutex(workerId).run(async () =>
      (await this.read(workerId)).activities.filter((item) => item.incarnation_id === incarnationId),
    )
  }

  async record(params: Omit<PendingActivityNotification, 'notification_id' | 'event_written' | 'consumed_at'>): Promise<PendingActivityNotification> {
    return this.mutex(params.worker_id).run(async () => {
      const state = await this.read(params.worker_id)
      const notification: PendingActivityNotification = {
        ...params,
        notification_id: randomUUID(),
        event_written: false,
      }
      await this.write(params.worker_id, {
        ...state,
        notifications: [...state.notifications, notification],
      })
      return notification
    })
  }

  async commitObservation(params: {
    readonly worker_id: string
    readonly cursor: NativeActivityCursor
    readonly activity?: ReadonlyArray<NormalizedTraceEvent>
    readonly notification?: Omit<PendingActivityNotification, 'notification_id' | 'event_written' | 'consumed_at'>
  }): Promise<PendingActivityNotification | undefined> {
    return this.mutex(params.worker_id).run(async () => {
      const state = await this.read(params.worker_id)
      const cursors = state.cursors.filter((item) => item.incarnation_id !== params.cursor.incarnation_id)
      cursors.push(params.cursor)
      const activities = mergeActivities(state.activities, params.cursor, params.activity ?? [])
      if (!params.notification) {
        await this.write(params.worker_id, { ...state, cursors, activities })
        return undefined
      }
      const notification: PendingActivityNotification = {
        ...params.notification,
        notification_id: randomUUID(),
        event_written: false,
      }
      await this.write(params.worker_id, {
        ...state,
        cursors,
        activities,
        notifications: [...state.notifications, notification],
      })
      return notification
    })
  }

  async pending(workerId: string): Promise<PendingActivityNotification[]> {
    return this.mutex(workerId).run(async () =>
      (await this.read(workerId)).notifications.filter((item) => item.consumed_at === undefined),
    )
  }

  async markEventWritten(workerId: string, notificationId: string): Promise<void> {
    await this.patchNotification(workerId, notificationId, (item) => ({ ...item, event_written: true }))
  }

  async markConsumed(workerId: string, notificationId: string, consumedAt: string): Promise<void> {
    await this.patchNotification(workerId, notificationId, (item) => ({ ...item, consumed_at: consumedAt }))
  }

  private async patchNotification(
    workerId: string,
    notificationId: string,
    update: (item: PendingActivityNotification) => PendingActivityNotification,
  ): Promise<void> {
    await this.mutex(workerId).run(async () => {
      const state = await this.read(workerId)
      const notifications = state.notifications.map((item) => item.notification_id === notificationId ? update(item) : item)
      await this.write(workerId, { ...state, notifications })
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
    return join(this.workersDir, workerId, 'native-activity.json')
  }

  private async read(workerId: string): Promise<ActivityState> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.path(workerId), 'utf8')) as Partial<ActivityState>
      if (parsed.version !== 1 || !Array.isArray(parsed.cursors) || !Array.isArray(parsed.notifications)) {
        throw new Error('invalid native activity state')
      }
      return {
        version: 1,
        cursors: parsed.cursors as NativeActivityCursor[],
        activities: Array.isArray(parsed.activities) ? parsed.activities as PersistedNativeActivity[] : [],
        notifications: parsed.notifications as PendingActivityNotification[],
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { version: 1, cursors: [], activities: [], notifications: [] }
      }
      throw error
    }
  }

  private async write(workerId: string, state: ActivityState): Promise<void> {
    await writeAtomic(this.path(workerId), JSON.stringify(state, null, 2) + '\n')
  }
}

function mergeActivities(
  existing: readonly PersistedNativeActivity[],
  cursor: NativeActivityCursor,
  events: ReadonlyArray<NormalizedTraceEvent>,
): PersistedNativeActivity[] {
  const next = [...existing]
  const known = new Set(existing.map(activityKey))
  for (const event of events) {
    if (event.source === 'harness' || !event.summary.trim()) continue
    const item: PersistedNativeActivity = {
      incarnation_id: cursor.incarnation_id,
      impl: cursor.impl,
      seq: cursor.seq,
      ts: event.ts,
      kind: event.kind,
      ...(event.role ? { role: event.role } : {}),
      summary: event.summary,
      ...(event.source_offset === undefined ? {} : { source_offset: event.source_offset }),
    }
    const key = activityKey(item)
    if (known.has(key)) continue
    known.add(key)
    next.push(item)
  }
  return next
}

function activityKey(item: PersistedNativeActivity): string {
  return item.source_offset === undefined
    ? `${item.incarnation_id}:${item.ts}:${item.kind}:${item.role ?? ''}:${item.summary}`
    : `${item.incarnation_id}:offset:${item.source_offset}`
}
