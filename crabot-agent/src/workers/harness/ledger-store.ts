import { promises as fs } from 'fs'
import { join, dirname } from 'path'
import { randomUUID } from 'crypto'
import { AsyncMutex } from '../async-mutex'
import type { ManagerKey, LedgerWorker, WorkerLedger } from './ledger-types'

const FILE_SUFFIX = '.json'

export function encodeSegment(s: string): string {
  return encodeURIComponent(s).replace(/[.!~*'()]/g, ch => '%' + ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0'))
}

export function decodeSegment(s: string): string {
  return decodeURIComponent(s)
}

export function managerKeyToFilename(key: ManagerKey): string {
  return `${encodeSegment(key)}${FILE_SUFFIX}`
}

/** A ManagerKey has a non-empty channel and session; the session may itself contain `::`. */
export function isManagerKey(value: string): value is ManagerKey {
  const separator = value.indexOf('::')
  return separator > 0 && separator + 2 < value.length
}

/** Reject malformed and non-canonical names so an unindexed ledger cannot silently exist. */
export function filenameToManagerKey(filename: string): ManagerKey | undefined {
  if (!filename.endsWith(FILE_SUFFIX)) return undefined
  try {
    const key = decodeSegment(filename.slice(0, -FILE_SUFFIX.length))
    if (!isManagerKey(key)) return undefined
    return managerKeyToFilename(key) === filename ? key : undefined
  } catch {
    return undefined
  }
}

async function writeJsonAtomic(path: string, data: unknown): Promise<void> {
  const tmpPath = join(dirname(path), `.tmp-${randomUUID()}${FILE_SUFFIX}`)
  await fs.writeFile(tmpPath, JSON.stringify(data, null, 2), 'utf-8')
  await fs.rename(tmpPath, path)
}

/** Session-scoped worker ledger store. It never scans the retired friend/group ledger directory. */
export class LedgerStore {
  private readonly ledgersDir: string
  private readonly mutexes = new Map<ManagerKey, AsyncMutex>()
  /** Serializes same-worker upserts across ledgers before either file can be written. */
  private readonly workerMutexes = new Map<string, AsyncMutex>()
  private workerIndex = new Map<string, ManagerKey>()
  private initPromise: Promise<void> | undefined

  constructor(ledgersDir: string) { this.ledgersDir = ledgersDir }

  async init(): Promise<void> {
    if (!this.initPromise) this.initPromise = this.scanAndBuildIndex()
    await this.initPromise
  }

  async getLedger(key: ManagerKey): Promise<WorkerLedger> {
    await this.init()
    return this.readLedgerFileStrict(key)
  }

  async listWorkers(key: ManagerKey): Promise<LedgerWorker[]> {
    return (await this.getLedger(key)).workers
  }

  async findWorker(workerId: string): Promise<{ managerKey: ManagerKey; worker: LedgerWorker } | undefined> {
    await this.init()
    let key = this.workerIndex.get(workerId)
    if (!key) {
      await this.scanAndBuildIndex()
      key = this.workerIndex.get(workerId)
      if (!key) return undefined
    }
    const ledger = await this.readLedgerFileStrict(key)
    const worker = ledger.workers.find(w => w.worker_id === workerId)
    if (!worker) throw new Error(`[LedgerStore] worker index inconsistent for ${workerId}`)
    return { managerKey: key, worker }
  }

  async upsertWorker(
    key: ManagerKey,
    workerId: string,
    mutator: (prev: LedgerWorker | undefined) => LedgerWorker | undefined
  ): Promise<LedgerWorker | undefined> {
    await this.init()
    return this.getWorkerMutex(workerId).run(async () => this.getMutex(key).run(async () => {
      const ledger = await this.readLedgerFileStrict(key)
      const index = ledger.workers.findIndex(w => w.worker_id === workerId)
      const prev = index >= 0 ? ledger.workers[index] : undefined
      const next = mutator(prev)
      if (!next) return undefined
      if (next.worker_id !== workerId) {
        throw new Error(`[LedgerStore] worker_id mismatch: requested ${workerId}, received ${next.worker_id}`)
      }
      this.assertWorkerOwner(key, next)
      if (prev && prev.manager_key !== next.manager_key) {
        throw new Error(`[LedgerStore] manager_key is immutable for worker ${workerId}`)
      }
      const existingOwner = this.workerIndex.get(workerId)
      if (existingOwner && existingOwner !== key) {
        throw new Error(`[LedgerStore] duplicate worker_id ${workerId} belongs to ${existingOwner}`)
      }
      if (index >= 0) ledger.workers[index] = next
      else ledger.workers.push(next)
      await writeJsonAtomic(this.pathFor(key), ledger)
      this.workerIndex.set(workerId, key)
      return next
    }))
  }

  async listAllWorkers(): Promise<Array<{ managerKey: ManagerKey; worker: LedgerWorker }>> {
    await this.init()
    const keys = new Set(this.workerIndex.values())
    const result: Array<{ managerKey: ManagerKey; worker: LedgerWorker }> = []
    for (const key of keys) {
      const ledger = await this.readLedgerFileStrict(key)
      for (const worker of ledger.workers) result.push({ managerKey: key, worker })
    }
    return result
  }

  private getMutex(key: ManagerKey): AsyncMutex {
    let mutex = this.mutexes.get(key)
    if (!mutex) { mutex = new AsyncMutex(); this.mutexes.set(key, mutex) }
    return mutex
  }

  private getWorkerMutex(workerId: string): AsyncMutex {
    let mutex = this.workerMutexes.get(workerId)
    if (!mutex) {
      mutex = new AsyncMutex()
      this.workerMutexes.set(workerId, mutex)
    }
    return mutex
  }

  private pathFor(key: ManagerKey): string {
    if (!isManagerKey(key)) {
      throw new Error(`[LedgerStore] invalid manager_key: ${key}`)
    }
    return join(this.ledgersDir, managerKeyToFilename(key))
  }

  private assertWorkerOwner(key: ManagerKey, worker: LedgerWorker): void {
    if (worker.manager_key !== key) {
      throw new Error(`[LedgerStore] manager_key mismatch: file ${key}, worker ${worker.worker_id} has ${worker.manager_key}`)
    }
  }

  private assertLedger(key: ManagerKey, ledger: WorkerLedger): WorkerLedger {
    if (!ledger || ledger.manager_key !== key || !Array.isArray(ledger.workers)) {
      throw new Error(`[LedgerStore] manager_key mismatch or invalid ledger for ${key}`)
    }
    for (const worker of ledger.workers) this.assertWorkerOwner(key, worker)
    return ledger
  }

  private async readLedgerFileStrict(key: ManagerKey): Promise<WorkerLedger> {
    const filePath = this.pathFor(key)
    let raw: string
    try { raw = await fs.readFile(filePath, 'utf-8') }
    catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { manager_key: key, workers: [] }
      throw err
    }
    try { return this.assertLedger(key, JSON.parse(raw) as WorkerLedger) }
    catch (err) {
      throw new Error(`[LedgerStore] invalid ledger ${filePath}: ${(err as Error).message}`)
    }
  }

  private async scanAndBuildIndex(): Promise<void> {
    await fs.mkdir(this.ledgersDir, { recursive: true })
    const entries = await fs.readdir(this.ledgersDir)
    const index = new Map<string, ManagerKey>()
    for (const entry of entries) {
      const key = filenameToManagerKey(entry)
      if (!key) {
        if (entry.endsWith(FILE_SUFFIX)) {
          throw new Error(`[LedgerStore] invalid or non-canonical ledger filename: ${entry}`)
        }
        continue
      }
      const ledger = await this.readLedgerFileStrict(key)
      for (const worker of ledger.workers) {
        const previous = index.get(worker.worker_id)
        if (previous && previous !== key) throw new Error(`[LedgerStore] duplicate worker_id ${worker.worker_id} in ${previous} and ${key}`)
        index.set(worker.worker_id, key)
      }
    }
    this.workerIndex = index
  }
}
