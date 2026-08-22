import { randomUUID } from 'crypto'
import { promises as fs } from 'fs'
import { dirname, join } from 'path'
import { AsyncMutex } from '../async-mutex.js'
import { WORKER_UI_CONTROL_KEYS, type IncarnationId, type WorkerImplId, type WorkerUiActionDescriptor } from '../types.js'
import type { ManagerKey } from './ledger-types.js'

export type WorkerUiActionId = string

/** Unknown UI answers are short-lived because the terminal can change without another hook. */
const SNAPSHOT_TTL_MS = 10 * 60 * 1000

export interface WorkerUiSnapshot {
  readonly snapshot_id: string
  readonly worker_id: string
  readonly manager_key: ManagerKey
  readonly incarnation_id: IncarnationId
  readonly impl: WorkerImplId
  readonly seq: number
  readonly fingerprint: string
  readonly actions: readonly WorkerUiActionDescriptor[]
  readonly created_at: string
  readonly expires_at: string
  readonly status: 'active' | 'consumed' | 'stale'
}

interface SnapshotFile {
  readonly version: 1
  readonly snapshots: WorkerUiSnapshot[]
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

/** A captured unknown UI may be answered once, and only while its incarnation remains current. */
export class WorkerUiSnapshotStore {
  private readonly mutexes = new Map<string, AsyncMutex>()

  constructor(private readonly workersDir: string) {}

  async prepare(
    params: Omit<WorkerUiSnapshot, 'snapshot_id' | 'status' | 'expires_at'>,
    interactionRequired: boolean,
    now: string,
  ): Promise<WorkerUiSnapshot | undefined> {
    return this.mutex(params.worker_id).run(async () => {
      const file = await this.read(params.worker_id)
      const active = file.snapshots.find((snapshot) =>
        snapshot.status === 'active' &&
        snapshot.incarnation_id === params.incarnation_id &&
        !isExpired(snapshot, now),
      )
      if (interactionRequired && active?.fingerprint === params.fingerprint) return active
      const snapshots = file.snapshots.map((snapshot) =>
        snapshot.status === 'active' ? { ...snapshot, status: 'stale' as const } : snapshot,
      )
      if (!interactionRequired) {
        await this.write(params.worker_id, { version: 1, snapshots })
        return undefined
      }
      const snapshot: WorkerUiSnapshot = {
        ...params,
        snapshot_id: randomUUID(),
        expires_at: new Date(Date.parse(now) + SNAPSHOT_TTL_MS).toISOString(),
        status: 'active',
      }
      await this.write(params.worker_id, { version: 1, snapshots: [...snapshots, snapshot] })
      return snapshot
    })
  }

  async consume(workerId: string, snapshotId: string, now: string): Promise<WorkerUiSnapshot> {
    return this.mutex(workerId).run(async () => {
      const file = await this.read(workerId)
      const index = file.snapshots.findIndex((snapshot) => snapshot.snapshot_id === snapshotId)
      if (index < 0) throw new Error('worker UI snapshot not found')
      const current = file.snapshots[index]
      if (current.status !== 'active') throw new Error(`worker UI snapshot is ${current.status}`)
      if (isExpired(current, now)) {
        const snapshots = [...file.snapshots]
        snapshots[index] = { ...current, status: 'stale' }
        await this.write(workerId, { version: 1, snapshots })
        throw new Error('worker UI snapshot is stale')
      }
      const snapshots = [...file.snapshots]
      const consumed: WorkerUiSnapshot = { ...current, status: 'consumed' }
      snapshots[index] = consumed
      await this.write(workerId, { version: 1, snapshots })
      return consumed
    })
  }

  async get(workerId: string, snapshotId: string): Promise<WorkerUiSnapshot | undefined> {
    return this.mutex(workerId).run(async () => {
      const file = await this.read(workerId)
      return file.snapshots.find((snapshot) => snapshot.snapshot_id === snapshotId)
    })
  }

  async staleActive(workerId: string): Promise<void> {
    await this.mutex(workerId).run(async () => {
      const file = await this.read(workerId)
      if (!file.snapshots.some((snapshot) => snapshot.status === 'active')) return
      await this.write(workerId, {
        version: 1,
        snapshots: file.snapshots.map((snapshot) =>
          snapshot.status === 'active' ? { ...snapshot, status: 'stale' as const } : snapshot,
        ),
      })
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
    return join(this.workersDir, workerId, 'ui-snapshots.json')
  }

  private async read(workerId: string): Promise<SnapshotFile> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.path(workerId), 'utf8')) as Partial<SnapshotFile>
      if (
        parsed.version !== 1 ||
        !Array.isArray(parsed.snapshots) ||
        !parsed.snapshots.every(isWorkerUiSnapshot)
      ) throw new Error('invalid worker UI snapshot file')
      return { version: 1, snapshots: parsed.snapshots as WorkerUiSnapshot[] }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, snapshots: [] }
      throw error
    }
  }

  private async write(workerId: string, file: SnapshotFile): Promise<void> {
    await writeAtomic(this.path(workerId), JSON.stringify(file, null, 2) + '\n')
  }
}

const UI_CONTROL_KEY_SET = new Set<string>(WORKER_UI_CONTROL_KEYS)
const ACTION_ID = /^[a-z][a-z0-9_]{0,63}$/

function isWorkerUiSnapshot(value: unknown): value is WorkerUiSnapshot {
  if (!value || typeof value !== 'object') return false
  const snapshot = value as Partial<WorkerUiSnapshot>
  return (
    typeof snapshot.snapshot_id === 'string' &&
    typeof snapshot.worker_id === 'string' &&
    typeof snapshot.manager_key === 'string' &&
    typeof snapshot.incarnation_id === 'string' &&
    (snapshot.impl === 'builtin' || snapshot.impl === 'claude-code' || snapshot.impl === 'codex') &&
    typeof snapshot.seq === 'number' &&
    typeof snapshot.fingerprint === 'string' &&
    Array.isArray(snapshot.actions) &&
    snapshot.actions.length > 0 &&
    snapshot.actions.every(isWorkerUiActionDescriptor) &&
    typeof snapshot.created_at === 'string' &&
    typeof snapshot.expires_at === 'string' &&
    (snapshot.status === 'active' || snapshot.status === 'consumed' || snapshot.status === 'stale')
  )
}

function isWorkerUiActionDescriptor(value: unknown): value is WorkerUiActionDescriptor {
  if (!value || typeof value !== 'object') return false
  const action = value as Partial<WorkerUiActionDescriptor>
  if (typeof action.action_id !== 'string' || !ACTION_ID.test(action.action_id)) return false
  if (action.kind === 'keys') {
    return Array.isArray(action.keys) && action.keys.length > 0 && action.keys.every((key) => UI_CONTROL_KEY_SET.has(key))
  }
  if (action.kind !== 'text') return false
  const maxLength = action.max_length
  if (typeof maxLength !== 'number' || !Number.isInteger(maxLength) || maxLength <= 0 || maxLength > 4_000) return false
  return action.min_length === undefined ||
    (Number.isInteger(action.min_length) && action.min_length >= 0 && action.min_length <= maxLength)
}

function isExpired(snapshot: WorkerUiSnapshot, now: string): boolean {
  const expiresAt = Date.parse(snapshot.expires_at)
  const current = Date.parse(now)
  return !Number.isFinite(expiresAt) || !Number.isFinite(current) || current >= expiresAt
}
