import { randomUUID } from 'crypto'
import { promises as fs } from 'fs'
import { dirname, join } from 'path'
import { AsyncMutex } from '../async-mutex.js'
import type { IncarnationEndReason, IncarnationId, WorkerContractState, WorkerImplId } from '../types.js'
import type { ManagerKey } from './ledger-types.js'

export type WorkerTurnResolution = 'continued' | 'reported' | 'asked_human' | 'suppressed'

export interface WorkerTurn {
  readonly turn_id: string
  readonly worker_id: string
  readonly manager_key: ManagerKey
  readonly incarnation_id: IncarnationId
  readonly impl: WorkerImplId
  readonly seq: number
  readonly session_ref: string
  readonly activity_from: string
  readonly activity_through: string
  readonly completed_at: string
  readonly completion_source: 'builtin_end_turn' | 'claude_stop' | 'codex_turn_complete'
  readonly disposition:
    | { readonly status: 'pending' }
    | { readonly status: 'resolved'; readonly resolution: WorkerTurnResolution; readonly resolved_at: string; readonly reason?: string }
}

interface TurnFile {
  readonly version: 1
  readonly turns: WorkerTurn[]
}

async function writeAtomic(path: string, contents: string): Promise<void> {
  const tmp = join(dirname(path), `.${randomUUID()}.tmp`)
  await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 })
  try {
    await fs.writeFile(tmp, contents, { encoding: 'utf8', mode: 0o600 })
    await fs.rename(tmp, path)
  } catch (error) {
    await fs.rm(tmp, { force: true }).catch(() => undefined)
    throw error
  }
}

/**
 * Pending turns are a Harness control-plane record, not a worker-authored artifact. A manager
 * must explicitly resolve the record after deciding whether it has reported or escalated it.
 */
export class WorkerTurnStore {
  private readonly mutexes = new Map<string, AsyncMutex>()

  constructor(private readonly workersDir: string) {}

  async create(params: Omit<WorkerTurn, 'turn_id' | 'disposition'>): Promise<WorkerTurn> {
    return this.mutex(params.worker_id).run(async () => {
      const file = await this.read(params.worker_id)
      const turn: WorkerTurn = { ...params, turn_id: randomUUID(), disposition: { status: 'pending' } }
      await this.write(params.worker_id, { version: 1, turns: [...file.turns, turn] })
      return turn
    })
  }

  async get(workerId: string, turnId?: string): Promise<WorkerTurn | undefined> {
    return this.mutex(workerId).run(async () => {
      const turns = (await this.read(workerId)).turns
      if (turnId !== undefined) return turns.find((turn) => turn.turn_id === turnId)
      return turns.filter((turn) => turn.disposition.status === 'pending').at(-1) ?? turns.at(-1)
    })
  }

  async latestForIncarnation(workerId: string, incarnationId: IncarnationId): Promise<WorkerTurn | undefined> {
    return this.mutex(workerId).run(async () =>
      (await this.read(workerId)).turns.filter((turn) => turn.incarnation_id === incarnationId).at(-1),
    )
  }

  async resolve(
    workerId: string,
    turnId: string,
    resolution: WorkerTurnResolution,
    resolvedAt: string,
    reason?: string,
  ): Promise<WorkerTurn> {
    return this.mutex(workerId).run(async () => {
      const file = await this.read(workerId)
      const index = file.turns.findIndex((turn) => turn.turn_id === turnId)
      if (index < 0) throw new Error(`worker turn not found: ${turnId}`)
      const current = file.turns[index]
      if (current.disposition.status === 'resolved') {
        if (current.disposition.resolution === resolution && current.disposition.reason === reason) return current
        throw new Error(`worker turn ${turnId} is already resolved as ${current.disposition.resolution}`)
      }
      const resolved: WorkerTurn = {
        ...current,
        disposition: {
          status: 'resolved',
          resolution,
          resolved_at: resolvedAt,
          ...(reason ? { reason } : {}),
        },
      }
      const turns = [...file.turns]
      turns[index] = resolved
      await this.write(workerId, { version: 1, turns })
      return resolved
    })
  }

  private path(workerId: string): string {
    return join(this.workersDir, workerId, 'turns.json')
  }

  private mutex(workerId: string): AsyncMutex {
    let mutex = this.mutexes.get(workerId)
    if (!mutex) {
      mutex = new AsyncMutex()
      this.mutexes.set(workerId, mutex)
    }
    return mutex
  }

  private async read(workerId: string): Promise<TurnFile> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.path(workerId), 'utf8')) as Partial<TurnFile>
      if (parsed.version !== 1 || !Array.isArray(parsed.turns)) throw new Error('invalid worker turn file')
      return { version: 1, turns: parsed.turns as WorkerTurn[] }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, turns: [] }
      throw error
    }
  }

  private async write(workerId: string, file: TurnFile): Promise<void> {
    await writeAtomic(this.path(workerId), JSON.stringify(file, null, 2) + '\n')
  }
}
