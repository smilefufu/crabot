import { promises as fs } from 'fs'
import { join, dirname } from 'path'
import { randomUUID } from 'crypto'
import { canonicalizeJson } from 'crabot-shared'
import { AsyncMutex } from '../async-mutex'
import type { Incarnation, LedgerWorker, LegacyArchivedIncarnation, ManagerKey, WorkerLedger } from './ledger-types'

const FILE_SUFFIX = '.json'
const ATOMIC_TEMP_FILE = /^\.tmp-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/i

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
    return this.getMutex(key).run(() => this.readLedgerFileStrict(key))
  }

  async listWorkers(key: ManagerKey): Promise<LedgerWorker[]> {
    return (await this.getLedger(key)).workers
  }

  async findWorker(workerId: string): Promise<{ managerKey: ManagerKey; worker: LedgerWorker } | undefined> {
    const indexed = await this.findWorkerFromIndex(workerId)
    if (indexed) return indexed
    await this.scanAndBuildIndex()
    return this.findWorkerFromIndex(workerId)
  }

  /**
   * Lookup against the initialized in-memory index without a fallback directory rescan.
   * Intended for controlled startup imports whose writes all go through this same store.
   */
  async findWorkerFromIndex(workerId: string): Promise<{ managerKey: ManagerKey; worker: LedgerWorker } | undefined> {
    await this.init()
    const key = this.workerIndex.get(workerId)
    if (!key) return undefined
    const ledger = await this.getMutex(key).run(() => this.readLedgerFileStrict(key))
    const worker = ledger.workers.find(w => w.worker_id === workerId)
    if (!worker) throw new Error(`[LedgerStore] worker index inconsistent for ${workerId}`)
    return { managerKey: key, worker }
  }

  async importLegacyWorker(key: ManagerKey, worker: LedgerWorker): Promise<LedgerWorker> {
    assertLegacyWorker(worker, true)
    const saved = await this.mutateWorker(key, worker.worker_id, () => worker, true)
    if (!saved) throw new Error('[LedgerStore] legacy import unexpectedly removed worker')
    return saved
  }

  async upsertWorker(
    key: ManagerKey,
    workerId: string,
    mutator: (prev: LedgerWorker | undefined) => LedgerWorker | undefined
  ): Promise<LedgerWorker | undefined> {
    return this.mutateWorker(key, workerId, mutator, false)
  }

  private async mutateWorker(
    key: ManagerKey,
    workerId: string,
    mutator: (prev: LedgerWorker | undefined) => LedgerWorker | undefined,
    importingLegacy: boolean,
  ): Promise<LedgerWorker | undefined> {
    await this.init()
    return this.getWorkerMutex(workerId).run(async () => this.getMutex(key).run(async () => {
      const ledger = await this.readLedgerFileStrict(key)
      const index = ledger.workers.findIndex(w => w.worker_id === workerId)
      const prev = index >= 0 ? ledger.workers[index] : undefined
      const next = mutator(prev)
      if (!next) return undefined
      assertWorkerLegacyShape(next)
      if (prev?.legacy_source) {
        assertLegacyWorker(prev)
        assertLegacyWorker(next)
        const sourceChanged = canonicalizeJson(prev.legacy_source) !== canonicalizeJson(next.legacy_source)
        const firstIncarnationChanged = canonicalizeJson(prev.incarnations[0]) !== canonicalizeJson(next.incarnations[0])
        if (sourceChanged || firstIncarnationChanged) {
          throw new Error(`[LedgerStore] immutable legacy source conflict for ${workerId}`)
        }
      } else if (next.legacy_source && !importingLegacy) {
        throw new Error('[LedgerStore] legacy workers may only be created by importLegacyWorker')
      }
      if (prev && importingLegacy && canonicalizeJson(prev) !== canonicalizeJson(next)) {
        throw new Error(`[LedgerStore] immutable legacy worker conflict for ${workerId}`)
      }
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
      const ledger = await this.getMutex(key).run(() => this.readLedgerFileStrict(key))
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

  private assertLedger(key: ManagerKey, ledger: WorkerLedger): { ledger: WorkerLedger; archivedAmbiguousLegacy: boolean } {
    if (!ledger || ledger.manager_key !== key || !Array.isArray(ledger.workers)) {
      throw new Error(`[LedgerStore] manager_key mismatch or invalid ledger for ${key}`)
    }
    let archivedAmbiguousLegacy = false
    let legacyStatusMigrated = false
    const workers = ledger.workers.map((worker) => {
      const materialized = materializeLegacyIncarnations(worker)
      archivedAmbiguousLegacy ||= materialized.archived
      const migrated = migrateLegacyTaskStatus(materialized.worker)
      legacyStatusMigrated ||= migrated.changed
      return migrated.worker
    })
    for (const worker of workers) {
      this.assertWorkerOwner(key, worker)
      assertWorkerLegacyShape(worker)
    }
    return { ledger: { ...ledger, workers }, archivedAmbiguousLegacy: archivedAmbiguousLegacy || legacyStatusMigrated }
  }

  private async readLedgerFileStrict(key: ManagerKey): Promise<WorkerLedger> {
    const filePath = this.pathFor(key)
    let raw: string
    try { raw = await fs.readFile(filePath, 'utf-8') }
    catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { manager_key: key, workers: [] }
      throw err
    }
    try {
      const normalized = this.assertLedger(key, JSON.parse(raw) as WorkerLedger)
      if (normalized.archivedAmbiguousLegacy) await writeJsonAtomic(filePath, normalized.ledger)
      return normalized.ledger
    }
    catch (err) {
      throw new Error(`[LedgerStore] invalid ledger ${filePath}: ${(err as Error).message}`)
    }
  }

  private async scanAndBuildIndex(): Promise<void> {
    await fs.mkdir(this.ledgersDir, { recursive: true })
    const entries = await fs.readdir(this.ledgersDir)
    const index = new Map<string, ManagerKey>()
    for (const entry of entries) {
      if (ATOMIC_TEMP_FILE.test(entry)) continue
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

function legacyIncarnationId(workerId: string, index: number): string {
  return `legacy:${encodeURIComponent(workerId)}:${index + 1}`
}

/**
 * Historical ledgers stored only adapter-local seq. Materialize IDs from immutable physical order.
 * If a numeric fork has multiple candidates, archive the complete worker rather than guessing a
 * mainline or making every worker under the Manager unreadable.
 */
/**
 * 2026-08-31 状态机修正(base-protocol §5.10)的存量迁移:读取时把旧 6 态归一到
 * queued/running/halted/closed(spec §7——waiting_input→halted、旧终态→closed(by migration))。
 * evidence 从主线化身尽力重建(ended_at 作 halted_at;ended_reason crashed → 'crashed');
 * 推不出的停因记 'unknown' 并 warn,绝不因旧数据阻断启动。已迁移过的原样返回(changed=false)。
 */
function migrateLegacyTaskStatus(worker: LedgerWorker): { worker: LedgerWorker; changed: boolean } {
  const status = worker.task.status
  if (status === 'queued' || status === 'running' || status === 'halted' || status === 'closed') {
    return { worker, changed: false }
  }
  const mainline = worker.incarnations.filter((incarnation) => incarnation.forked_from === undefined).at(-1)
  const haltedAt = mainline?.ended_at ?? worker.updated_at
  if (status === 'waiting_input') {
    const haltReason = mainline?.ended_reason === 'crashed' ? 'crashed' as const : 'turn_end' as const
    return {
      worker: {
        ...worker,
        task: { ...worker.task, status: 'halted', halt: { halted_at: haltedAt, halt_reason: haltReason } },
      },
      changed: true,
    }
  }
  if (status === 'completed' || status === 'failed' || status === 'cancelled') {
    const legacyError = (worker.task as Record<string, unknown>).error
    const note = `migrated from v3 旧值 ${status}${typeof legacyError === 'string' && legacyError ? `；error: ${legacyError}` : ''}`
    return {
      worker: {
        ...worker,
        task: { ...worker.task, status: 'closed', closed: { at: haltedAt, by: 'migration', note } },
      },
      changed: true,
    }
  }
  console.warn(`[LedgerStore] 未知任务状态 '${status}' 归一为 halted(unknown) for ${worker.worker_id}`)
  return {
    worker: {
      ...worker,
      task: { ...worker.task, status: 'halted', halt: { halted_at: haltedAt, halt_reason: 'unknown' } },
    },
    changed: true,
  }
}

function materializeLegacyIncarnations(worker: LedgerWorker): { worker: LedgerWorker; archived: boolean } {  const bySeq = new Map<number, Incarnation[]>()
  const ids = new Set<string>()
  const incarnations = worker.incarnations.map((incarnation, index) => {
    const incarnationId = incarnation.incarnation_id ?? legacyIncarnationId(worker.worker_id, index)
    if (ids.has(incarnationId)) {
      throw new Error(`[LedgerStore] duplicate incarnation_id '${incarnationId}' for ${worker.worker_id}`)
    }
    ids.add(incarnationId)
    const normalized: Incarnation = {
      ...incarnation,
      incarnation_id: incarnationId,
      workspace_instructions: incarnation.workspace_instructions ?? {
        source: 'absent',
        captured_at: incarnation.started_at,
      },
    }
    const sameSeq = bySeq.get(normalized.seq) ?? []
    sameSeq.push(normalized)
    bySeq.set(normalized.seq, sameSeq)
    return normalized
  })

  let ambiguousFork = false
  const normalizedForks = incarnations.map((incarnation) => {
    if (typeof incarnation.forked_from !== 'number') return incarnation
    const candidates = bySeq.get(incarnation.forked_from) ?? []
    if (candidates.length !== 1 || !candidates[0].incarnation_id) {
      ambiguousFork = true
      return incarnation
    }
    return { ...incarnation, forked_from: candidates[0].incarnation_id } as Incarnation
  })

  if (ambiguousFork) {
    const archivedAt = new Date().toISOString()
    const last = incarnations[incarnations.length - 1]
    if (!last) throw new Error(`[LedgerStore] cannot archive empty incarnation history for ${worker.worker_id}`)
    const archiveId = `legacy:${encodeURIComponent(worker.worker_id)}:ambiguous-v3`
    return {
      worker: {
        ...worker,
        task: isTerminalTaskStatus(worker.task.status)
          ? worker.task
          : {
            ...worker.task,
            status: 'halted',
            halt: { halted_at: archivedAt, halt_reason: 'pre_migration' },
          },
        incarnations: [{
          incarnation_id: archiveId,
          seq: 1,
          impl: 'legacy',
          state: 'exited',
          workspace: last.workspace,
          workspace_instructions: last.workspace_instructions ?? { source: 'absent', captured_at: archivedAt },
          started_at: last.started_at,
          ended_at: archivedAt,
          ended_reason: 'pre_migration',
        }],
        legacy_source: {
          kind: 'ambiguous_v3_ledger',
          archived_at: archivedAt,
          reason: 'ambiguous_numeric_forked_from',
          original_incarnations: worker.incarnations as LegacyArchivedIncarnation[],
        },
        updated_at: archivedAt,
      },
      archived: true,
    }
  }

  for (const incarnation of normalizedForks) {
    if (typeof incarnation.forked_from === 'string' && !ids.has(incarnation.forked_from)) {
      throw new Error(`[LedgerStore] forked_from '${incarnation.forked_from}' does not belong to ${worker.worker_id}`)
    }
  }
  return { worker: { ...worker, incarnations: normalizedForks }, archived: false }
}

function isTerminalTaskStatus(status: LedgerWorker['task']['status']): boolean {
  return status === 'closed'
}

function assertWorkerLegacyShape(worker: LedgerWorker): void {
  const hasLegacyIncarnation = worker.incarnations.some((incarnation) => incarnation.impl === 'legacy')
  if (worker.legacy_source || hasLegacyIncarnation) assertLegacyWorker(worker)
  assertRecoveryNotices(worker)
}

function assertRecoveryNotices(worker: LedgerWorker): void {
  const notices = worker.recovery_notices
  if (notices === undefined) return
  if (!Array.isArray(notices)) {
    throw new Error(`[LedgerStore] recovery_notices must be an array for ${worker.worker_id}`)
  }

  const mainlineIds = new Set(
    worker.incarnations
      .filter((incarnation) => incarnation.impl !== 'legacy' && incarnation.forked_from === undefined)
      .map((incarnation) => incarnation.incarnation_id)
      .filter((incarnationId): incarnationId is string => typeof incarnationId === 'string' && incarnationId.length > 0),
  )
  const noticeIds = new Set<string>()
  const incarnationIds = new Set<string>()
  for (const notice of notices) {
    if (!notice || typeof notice.notice_id !== 'string' || notice.notice_id.length === 0) {
      throw new Error(`[LedgerStore] recovery notice has invalid notice_id for ${worker.worker_id}`)
    }
    if (!noticeIds.add(notice.notice_id)) {
      throw new Error(`[LedgerStore] duplicate recovery notice_id '${notice.notice_id}' for ${worker.worker_id}`)
    }
    if (typeof notice.incarnation_id !== 'string' || notice.incarnation_id.length === 0) {
      throw new Error(`[LedgerStore] recovery notice has invalid incarnation_id for ${worker.worker_id}`)
    }
    if (!incarnationIds.add(notice.incarnation_id)) {
      throw new Error(`[LedgerStore] duplicate recovery notice incarnation_id '${notice.incarnation_id}' for ${worker.worker_id}`)
    }
    if (!mainlineIds.has(notice.incarnation_id)) {
      throw new Error(`[LedgerStore] recovery notice must reference an executable mainline incarnation for ${worker.worker_id}`)
    }
    if (notice.status !== 'pending' && notice.status !== 'consumed') {
      throw new Error(`[LedgerStore] recovery notice has invalid status for ${worker.worker_id}`)
    }
    if (typeof notice.created_at !== 'string' || !Number.isFinite(Date.parse(notice.created_at)) ||
      !Number.isInteger(notice.attempts) || notice.attempts < 0) {
      throw new Error(`[LedgerStore] recovery notice has invalid metadata for ${worker.worker_id}`)
    }
    if (notice.retry_after_at !== undefined &&
      (typeof notice.retry_after_at !== 'string' || !Number.isFinite(Date.parse(notice.retry_after_at)))) {
      throw new Error(`[LedgerStore] recovery notice has invalid retry_after_at for ${worker.worker_id}`)
    }
    if (notice.status === 'consumed' &&
      (typeof notice.consumed_at !== 'string' || !Number.isFinite(Date.parse(notice.consumed_at)))) {
      throw new Error(`[LedgerStore] consumed recovery notice has no consumed_at for ${worker.worker_id}`)
    }
    if (notice.status === 'pending' && notice.consumed_at !== undefined) {
      throw new Error(`[LedgerStore] pending recovery notice has consumed_at for ${worker.worker_id}`)
    }
  }
}

function assertLegacyWorker(worker: LedgerWorker, initialImport = false): void {
  const source = worker.legacy_source
  const first = worker.incarnations[0]
  const validSource = source?.kind === 'v2_admin_task'
    ? typeof source.admin_task_id === 'string' && source.admin_task_id.length > 0 &&
      typeof source.imported_at === 'string' && source.imported_at.length > 0 &&
      Array.isArray(source.trace_ids) && source.trace_ids.every((traceId) => typeof traceId === 'string' && traceId.length > 0) &&
      new Set(source.trace_ids).size === source.trace_ids.length
    : source?.kind === 'ambiguous_v3_ledger'
      ? typeof source.archived_at === 'string' && source.archived_at.length > 0 &&
        source.reason === 'ambiguous_numeric_forked_from' &&
        Array.isArray(source.original_incarnations) && source.original_incarnations.length > 0
      : false
  const validFirst = first?.impl === 'legacy' &&
    first.seq === 1 && first.state === 'exited' &&
    typeof first.ended_at === 'string' &&
    first.session_ref === undefined
  const laterLegacy = worker.incarnations.slice(1).some((incarnation) => incarnation.impl === 'legacy')
  if (!validSource || !validFirst || laterLegacy ||
    (initialImport && (source?.kind !== 'v2_admin_task' || worker.incarnations.length !== 1))) {
    throw new Error(
      '[LedgerStore] invalid legacy worker: immutable source and one first legacy incarnation are required',
    )
  }
}
