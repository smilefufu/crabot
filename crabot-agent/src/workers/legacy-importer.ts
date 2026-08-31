import { createHash, randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { dirname, join } from 'node:path'
import { canonicalizeJson, sha256CanonicalJson } from 'crabot-shared'
import type { WorkspaceManager } from './harness/workspace-manager.js'
import { isManagerKey, type LedgerStore } from './harness/ledger-store.js'
import type { LedgerWorker, ManagerKey, TaskPriority, TaskStatus } from './harness/ledger-types.js'
import { WorkerEventLog } from './harness/worker-events.js'
import { readLegacyTraces, type LegacyTrace } from './legacy-source-reader.js'

const VERSION = 1
const SYSTEM_KEY = 'admin-web::system-tasks' as ManagerKey
const LEGACY_STATUSES = new Set([
  'pending',
  'planning',
  'executing',
  'waiting_human',
  'waiting',
  'completed',
  'failed',
  'cancelled',
])

interface ManifestTrace {
  readonly trace_id: string
  readonly canonical_content_sha256: string
}

interface ManifestTask {
  readonly admin_task_id: string
  readonly canonical_content_sha256: string
  readonly traces: ReadonlyArray<ManifestTrace>
}

interface InProgressMarker {
  readonly version: 1
  readonly state: 'in_progress'
  readonly imported_at: string
  readonly fingerprint: string
  readonly manifest: ReadonlyArray<ManifestTask>
}

interface CompletedMarker extends Omit<InProgressMarker, 'state'> {
  readonly state: 'completed'
  readonly source_task_count: number
  readonly imported_count: number
  readonly by_manager_key: Record<string, number>
}

type Marker = InProgressMarker | CompletedMarker

type LegacyTask = Record<string, unknown> & {
  readonly id: string
  readonly title: string
  readonly status: string
  readonly created_at: string
}

export interface LegacyImporterDeps {
  readonly adminDataDir: string
  readonly traceDir: string
  readonly agentDataDir: string
  readonly ledger: LedgerStore
  readonly workspaces: WorkspaceManager
  readonly now: () => string
  /** Test-only crash seam, called after one task and its import event are durable. */
  readonly afterWorkerImported?: (worker: LedgerWorker) => Promise<void> | void
}

export interface LegacyImportReport {
  readonly skipped: boolean
  readonly imported: number
}

export async function importV2LegacyTasks(deps: LegacyImporterDeps): Promise<LegacyImportReport> {
  const markerPath = join(deps.agentDataDir, 'migrations', 'v2-legacy-import-v1.json')
  const marker = await readMarkerFile(markerPath)
  if (marker?.state === 'completed') return { skipped: true, imported: 0 }

  await deps.ledger.init()
  await assertDirectory(deps.adminDataDir)
  const source = await readTasks(join(deps.adminDataDir, 'tasks.json'))
  const traces = source.tasks.length === 0
    ? new Map<string, LegacyTrace[]>()
    : await readLegacyTraces(deps.traceDir)
  const manifest = buildManifest(source.tasks, traces)
  const fingerprint = source.absent ? 'absent' : sha256CanonicalJson(manifest)

  let active: InProgressMarker
  if (marker) {
    assertSameSource(marker, manifest, fingerprint)
    active = marker
  } else {
    const importedAt = deps.now()
    if (!validIso(importedAt)) throw new Error('[legacy-import] now() must return an ISO timestamp')
    active = {
      version: VERSION,
      state: 'in_progress',
      imported_at: importedAt,
      fingerprint,
      manifest,
    }
    assertMarker(active)
    await writeAtomic(markerPath, active)
  }

  let imported = 0
  const counts: Record<string, number> = {}
  for (const task of source.tasks) {
    const selected = traces.get(task.id) ?? []
    const worker = await makeWorker(task, selected, active.imported_at, deps.workspaces)
    const workerDir = join(deps.agentDataDir, 'workers', worker.worker_id)
    await writeSnapshot(join(workerDir, 'legacy-task.json'), task)

    const existing = await deps.ledger.findWorkerFromIndex(worker.worker_id)
    if (!existing) {
      await deps.ledger.importLegacyWorker(worker.manager_key, worker)
      imported++
    } else if (canonicalizeJson(existing.worker) !== canonicalizeJson(worker)) {
      throw new Error(`[legacy-import] immutable worker conflict for ${worker.worker_id}`)
    }

    await appendImportEventOnce(workerDir, worker, selected.length, active.imported_at)
    counts[worker.manager_key] = (counts[worker.manager_key] ?? 0) + 1
    await deps.afterWorkerImported?.(worker)
  }

  const completed: CompletedMarker = {
    ...active,
    state: 'completed',
    source_task_count: source.tasks.length,
    imported_count: source.tasks.length,
    by_manager_key: counts,
  }
  assertMarker(completed)
  await writeAtomic(markerPath, completed)
  return { skipped: false, imported }
}

async function makeWorker(
  task: LegacyTask,
  traces: readonly LegacyTrace[],
  importedAt: string,
  workspaces: WorkspaceManager,
): Promise<LedgerWorker> {
  const workerId = legacyWorkerId(task.id)
  const source = isRecord(task.source) ? task.source : {}
  const target = sourceTarget(source)
  const mapped = mapStatus(task.status)
  const result = isRecord(task.result) ? task.result : {}

  const taskStartedAt = optionalIso(task.started_at, `task ${task.id} started_at`)
  const taskCompletedAt = optionalIso(task.completed_at, `task ${task.id} completed_at`)
  const resultFinishedAt = optionalIso(result.finished_at, `task ${task.id} result.finished_at`)
  const earliestTraceStart = traces.find((trace) => trace.started_at)?.started_at
  const latestTraceEnd = latestTimestamp(traces.map((trace) => trace.ended_at))
  const startedAt = taskStartedAt ?? earliestTraceStart ?? task.created_at
  const endedAt = mapped.preMigration
    ? importedAt
    : taskCompletedAt ?? resultFinishedAt ?? latestTraceEnd ?? importedAt

  const workspace = await resolveWorkspace(workerId, task.id, traces, workspaces)
  const traceOutcome = [...traces].reverse().find((trace) => usableString(trace.outcome?.summary))?.outcome?.summary
  const outcome = usableString(result.outcome_brief) ?? usableString(result.summary) ?? traceOutcome
  const taskType = usableString(task.type)
  const goal = isRecord(task.goal) ? usableString(task.goal.objective) : undefined
  const creatorFriendId = validIdentifier(source.friend_id, { allowDoubleColon: true })

  return {
    worker_id: workerId,
    manager_key: target.managerKey,
    task: {
      id: workerId,
      ...(taskType ? { type: taskType } : {}),
      title: task.title,
      status: mapped.status,
      ...(priority(task.priority) ? { priority: task.priority } : {}),
      ...(isRecord(task.input) ? { input: task.input } : {}),
      ...(strings(task.tags) ? { tags: task.tags } : {}),
      ...(goal ? { goal } : {}),
      created_at: task.created_at,
      ...(mapped.status === 'closed'
        ? {
          closed: {
            at: endedAt,
            by: 'migration' as const,
            note: `migrated from v2 ${task.status}`
              + (outcome ? `；outcome: ${outcome}` : '')
              + (typeof task.error === 'string' ? `；error: ${task.error}` : ''),
          },
        }
        : { halt: { halted_at: endedAt, halt_reason: 'pre_migration' as const } }),
    },
    origin: {
      trigger_type: trigger(source),
      ...(creatorFriendId ? { creator_friend_id: creatorFriendId as never } : {}),
    },
    report_to: target.reportTo,
    incarnations: [{
      // Imported records are written through the current ledger schema. Keep the identity
      // deterministic so a crash after import compares equal on the next migration pass.
      incarnation_id: `legacy:${encodeURIComponent(workerId)}:1`,
      impl: 'legacy',
      seq: 1,
      state: 'exited',
      workspace,
      workspace_instructions: {
        source: 'absent',
        captured_at: startedAt,
      },
      started_at: startedAt,
      ended_at: endedAt,
      ended_reason: mapped.endedReason,
    }],
    legacy_source: {
      kind: 'v2_admin_task',
      admin_task_id: task.id,
      trace_ids: traces.map((trace) => trace.trace_id),
      imported_at: importedAt,
    },
    updated_at: importedAt,
  }
}

function legacyWorkerId(adminTaskId: string): string {
  const digest = createHash('sha256').update(adminTaskId, 'utf8').digest('hex')
  return `w-legacy-${digest.slice(0, 32)}`
}

function sourceTarget(source: Record<string, unknown>): {
  readonly managerKey: ManagerKey
  readonly reportTo: LedgerWorker['report_to']
} {
  const channelId = validIdentifier(source.channel_id, { allowDoubleColon: false })
  const sessionId = validIdentifier(source.session_id, { allowDoubleColon: true })
  if (!channelId || !sessionId) {
    return {
      managerKey: SYSTEM_KEY,
      reportTo: { channel_id: 'admin-web', session_id: 'system-tasks' },
    }
  }
  const managerKey = `${channelId}::${sessionId}` as ManagerKey
  if (!isManagerKey(managerKey)) {
    return {
      managerKey: SYSTEM_KEY,
      reportTo: { channel_id: 'admin-web', session_id: 'system-tasks' },
    }
  }
  return {
    managerKey,
    reportTo: { channel_id: channelId, session_id: sessionId },
  }
}

async function resolveWorkspace(
  workerId: string,
  adminTaskId: string,
  traces: readonly LegacyTrace[],
  workspaces: WorkspaceManager,
): Promise<string> {
  const candidate = [...traces]
    .reverse()
    .find((trace) => usableString(trace.resume_checkpoint?.worker_state?.cwd))
    ?.resume_checkpoint?.worker_state?.cwd
  try {
    return (await workspaces.resolve(workerId, candidate)).root
  } catch (error) {
    console.warn(`[legacy-import] invalid legacy workspace for ${adminTaskId}: ${(error as Error).message}`)
    return (await workspaces.resolve(workerId)).root
  }
}

function buildManifest(tasks: readonly LegacyTask[], traces: Map<string, LegacyTrace[]>): ManifestTask[] {
  return tasks
    .map((task) => ({
      admin_task_id: task.id,
      canonical_content_sha256: sha256CanonicalJson(task),
      traces: (traces.get(task.id) ?? [])
        .map((trace) => ({
          trace_id: trace.trace_id,
          canonical_content_sha256: trace.canonical_content_sha256,
        }))
        .sort((left, right) => left.trace_id.localeCompare(right.trace_id)),
    }))
    .sort((left, right) => left.admin_task_id.localeCompare(right.admin_task_id))
}

function assertSameSource(marker: InProgressMarker, manifest: ManifestTask[], fingerprint: string): void {
  if (
    marker.fingerprint !== fingerprint ||
    canonicalizeJson(marker.manifest) !== canonicalizeJson(manifest)
  ) {
    throw new Error('[legacy-import] source changed while migration is in_progress')
  }
}

function mapStatus(status: string): {
  readonly status: TaskStatus
  readonly endedReason: 'completed' | 'failed' | 'killed' | 'pre_migration'
  readonly preMigration: boolean
} {
  // 2026-08-31 状态机修正：旧终态一律归 closed（旧值记入 closed.note），旧非终态归 halted(pre_migration)。
  if (status === 'completed') return { status: 'closed', endedReason: 'completed', preMigration: false }
  if (status === 'failed') return { status: 'closed', endedReason: 'failed', preMigration: false }
  if (status === 'cancelled') return { status: 'closed', endedReason: 'killed', preMigration: false }
  return { status: 'halted', endedReason: 'pre_migration', preMigration: true }
}

function trigger(source: Record<string, unknown>): 'message' | 'scheduled' | 'system' {
  if (source.trigger_type === 'scheduled') return 'scheduled'
  if (
    source.trigger_type === 'message' ||
    source.trigger_type === 'manual' ||
    source.origin === 'admin_chat'
  ) return 'message'
  return 'system'
}

async function readTasks(path: string): Promise<{
  readonly tasks: LegacyTask[]
  readonly absent: boolean
}> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(path, 'utf8'))
    if (!Array.isArray(parsed)) throw new Error('[legacy-import] tasks.json must be an array')
    const tasks = parsed.map(validateTask)
    const ids = new Set<string>()
    for (const task of tasks) {
      if (ids.has(task.id)) throw new Error(`[legacy-import] duplicate task id: ${task.id}`)
      ids.add(task.id)
    }
    return { tasks, absent: false }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { tasks: [], absent: true }
    throw error
  }
}

function validateTask(value: unknown): LegacyTask {
  if (
    !isRecord(value) ||
    !validIdentifier(value.id, { allowDoubleColon: true }) ||
    !usableString(value.title) ||
    typeof value.status !== 'string' ||
    !LEGACY_STATUSES.has(value.status) ||
    !validIso(value.created_at)
  ) {
    throw new Error('[legacy-import] invalid required task fields')
  }
  // Validate the full source object now so fingerprinting cannot fail after the marker is written.
  sha256CanonicalJson(value)
  return value as LegacyTask
}

async function readMarkerFile(path: string): Promise<Marker | undefined> {
  try {
    const value: unknown = JSON.parse(await fs.readFile(path, 'utf8'))
    assertMarker(value)
    return value
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

function assertMarker(value: unknown): asserts value is Marker {
  if (!isRecord(value) || value.version !== VERSION || !validIso(value.imported_at)) {
    throw new Error('[legacy-import] invalid migration marker')
  }
  const commonKeys = ['fingerprint', 'imported_at', 'manifest', 'state', 'version']
  const expectedKeys = value.state === 'completed'
    ? [...commonKeys, 'by_manager_key', 'imported_count', 'source_task_count']
    : commonKeys
  if (
    (value.state !== 'in_progress' && value.state !== 'completed') ||
    !hasExactKeys(value, expectedKeys) ||
    typeof value.fingerprint !== 'string' ||
    (value.fingerprint !== 'absent' && !isSha256(value.fingerprint)) ||
    !Array.isArray(value.manifest) ||
    !value.manifest.every(validManifestTask)
  ) {
    throw new Error('[legacy-import] invalid migration marker')
  }

  let previousTaskId: string | undefined
  for (const task of value.manifest) {
    if (previousTaskId !== undefined && previousTaskId.localeCompare(task.admin_task_id) >= 0) {
      throw new Error('[legacy-import] invalid migration marker')
    }
    previousTaskId = task.admin_task_id
    let previousTraceId: string | undefined
    for (const trace of task.traces) {
      if (previousTraceId !== undefined && previousTraceId.localeCompare(trace.trace_id) >= 0) {
        throw new Error('[legacy-import] invalid migration marker')
      }
      previousTraceId = trace.trace_id
    }
  }

  const calculated = value.fingerprint === 'absent' && value.manifest.length === 0
    ? 'absent'
    : sha256CanonicalJson(value.manifest)
  if (value.fingerprint !== calculated) throw new Error('[legacy-import] invalid migration marker')
  if (value.state === 'in_progress') return

  if (
    !isNonNegativeInteger(value.source_task_count) ||
    value.source_task_count !== value.manifest.length ||
    !isNonNegativeInteger(value.imported_count) ||
    value.imported_count !== value.manifest.length ||
    !isRecord(value.by_manager_key)
  ) {
    throw new Error('[legacy-import] invalid migration marker')
  }
  let total = 0
  for (const [key, count] of Object.entries(value.by_manager_key)) {
    if (!isManagerKey(key) || !isPositiveInteger(count)) {
      throw new Error('[legacy-import] invalid migration marker')
    }
    total += count
  }
  if (total !== value.imported_count) throw new Error('[legacy-import] invalid migration marker')
}

function validManifestTask(value: unknown): value is ManifestTask {
  return isRecord(value) &&
    hasExactKeys(value, ['admin_task_id', 'canonical_content_sha256', 'traces']) &&
    validIdentifier(value.admin_task_id, { allowDoubleColon: true }) !== undefined &&
    isSha256(value.canonical_content_sha256) &&
    Array.isArray(value.traces) &&
    value.traces.every((trace) =>
      isRecord(trace) &&
      hasExactKeys(trace, ['canonical_content_sha256', 'trace_id']) &&
      validIdentifier(trace.trace_id, { allowDoubleColon: true }) !== undefined &&
      isSha256(trace.canonical_content_sha256),
    )
}

async function writeSnapshot(path: string, task: LegacyTask): Promise<void> {
  try {
    const existing = JSON.parse(await fs.readFile(path, 'utf8')) as unknown
    if (canonicalizeJson(existing) !== canonicalizeJson(task)) {
      throw new Error(`[legacy-import] legacy snapshot conflict: ${path}`)
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    await writeAtomic(path, task)
  }
}

async function appendImportEventOnce(
  workerDir: string,
  worker: LedgerWorker,
  traceCount: number,
  importedAt: string,
): Promise<void> {
  if (worker.legacy_source?.kind !== 'v2_admin_task') {
    throw new Error(`[legacy-import] worker ${worker.worker_id} is not a v2 legacy import`)
  }
  const expected = {
    admin_task_id: worker.legacy_source.admin_task_id,
    trace_count: traceCount,
    imported_at: importedAt,
  }
  const log = new WorkerEventLog(workerDir)
  const events = (await log.readAll()).filter((event) => event.kind === 'legacy_imported')
  if (events.length > 0) {
    const event = events[0]
    if (
      events.length !== 1 ||
      event.worker_id !== worker.worker_id ||
      event.seq !== 1 ||
      event.ts !== importedAt ||
      canonicalizeJson(event.detail) !== canonicalizeJson(expected)
    ) {
      throw new Error(`[legacy-import] legacy import event conflict for ${worker.worker_id}`)
    }
    return
  }
  await log.append({
    ts: importedAt,
    kind: 'legacy_imported',
    worker_id: worker.worker_id,
    seq: 1,
    detail: expected,
  })
}

async function assertDirectory(path: string): Promise<void> {
  const stat = await fs.stat(path).catch((error) => {
    throw new Error(`[legacy-import] Admin data directory unavailable: ${(error as Error).message}`)
  })
  if (!stat.isDirectory()) throw new Error('[legacy-import] Admin data directory is not a directory')
}

async function writeAtomic(path: string, value: unknown): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true })
  const temp = join(dirname(path), `.tmp-${randomUUID()}.json`)
  await fs.writeFile(temp, JSON.stringify(value, null, 2), 'utf8')
  await fs.rename(temp, path)
}

function optionalIso(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined
  if (validIso(value)) return value
  console.warn(`[legacy-import] ignoring invalid ${label}`)
  return undefined
}

function latestTimestamp(values: ReadonlyArray<string | undefined>): string | undefined {
  let latest: string | undefined
  let latestMs = Number.NEGATIVE_INFINITY
  for (const value of values) {
    if (!value) continue
    const timeMs = Date.parse(value)
    if (timeMs > latestMs) {
      latest = value
      latestMs = timeMs
    }
  }
  return latest
}

function validIso(value: unknown): value is string {
  return typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
    Number.isFinite(Date.parse(value))
}

function validIdentifier(
  value: unknown,
  options: { readonly allowDoubleColon: boolean },
): string | undefined {
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim()) return undefined
  if (/[\u0000-\u001f\u007f]/.test(value)) return undefined
  if (!options.allowDoubleColon && value.includes('::')) return undefined
  return value
}

function usableString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index])
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function priority(value: unknown): value is TaskPriority {
  return value === 'low' || value === 'normal' || value === 'high' || value === 'urgent'
}

function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}
