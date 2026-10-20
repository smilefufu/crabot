import { sha256CanonicalJson } from 'crabot-shared'
import type { Incarnation, LedgerWorker, ManagerKey } from './ledger-types.js'
import { captureWorkspaceRelocationWorkers } from './workspace-relocation-scope.js'

interface LegacyExecutionEntry {
  readonly worker_id: string
  readonly incarnation_id: string
  readonly evidence_sha256: string
}
export interface LegacyWorkspaceExecutions {
  readonly schema_version: 1
  readonly captured_at: string
  readonly entries: ReadonlyArray<LegacyExecutionEntry>
}
const invalid = () => Object.assign(new Error('旧执行兼容边界无法核验，已保留维护保护。'), { code: 'WORKSPACE_MAINTENANCE' })
const key = (workerId: string, incarnationId: string) => JSON.stringify([workerId, incarnationId])
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 4096 && !value.includes('\0')
const time = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value
const reasons = new Set(['completed', 'failed', 'killed', 'superseded', 'crashed'])
const haltReasons = new Set(['turn_end', 'worker_finalized', 'crashed'])

function endedEvidence(worker: LedgerWorker, incarnation: Incarnation, capturedAt: string): boolean {
  if (!['codex', 'claude-code'].includes(incarnation.impl) || incarnation.impl === 'legacy' || incarnation.state !== 'exited'
    || !time(incarnation.started_at) || !time(incarnation.ended_at) || !reasons.has(incarnation.ended_reason ?? '')
    || incarnation.ended_at < incarnation.started_at || incarnation.ended_at > capturedAt
    || worker.task.halt?.halt_reason === 'unknown' || worker.task.halt?.stop_unverified) return false
  const evidence = incarnation.stop_evidence
  if (evidence === undefined) return true // The old lifecycle fact is retained; no new stop_evidence is invented.
  const stoppedTime = (value: unknown) => time(value) && value >= incarnation.started_at && value <= capturedAt
  return !!evidence?.halt && haltReasons.has(evidence.halt.halt_reason)
    && !evidence.halt.stop_unverified && stoppedTime(evidence.halt.halted_at) && !evidence.background_unverified
    && Array.isArray(evidence.background) && evidence.background.length <= 32768
    && evidence.background.every(item => text(item?.entity_id) && stoppedTime(item.ended_at))
    && new Set(evidence.background.map(item => item.entity_id)).size === evidence.background.length
    && (evidence.execution_stopped_at === undefined || stoppedTime(evidence.execution_stopped_at) && evidence.execution_stopped_at >= incarnation.ended_at
      && evidence.background.every(item => item.ended_at! <= evidence.execution_stopped_at!))
}
function evidenceDigest(managerKey: ManagerKey, worker: LedgerWorker, incarnation: Incarnation): string {
  return sha256CanonicalJson({ worker_id: worker.worker_id, manager_key: managerKey, task_id: worker.task.id,
    ...(worker.workspace_id === undefined ? {} : { workspace_id: worker.workspace_id }),
    incarnation: { incarnation_id: incarnation.incarnation_id, impl: incarnation.impl, seq: incarnation.seq,
      workspace: incarnation.workspace, started_at: incarnation.started_at,
      ...(incarnation.forked_from === undefined ? {} : { forked_from: incarnation.forked_from }),
      ...(incarnation.query_id === undefined ? {} : { query_id: incarnation.query_id }) },
    state: incarnation.state, ended_at: incarnation.ended_at, ended_reason: incarnation.ended_reason,
    ...(incarnation.impl === 'legacy' ? {} : { session_ref: incarnation.session_ref,
      ...(incarnation.stop_evidence === undefined ? {} : { stop_evidence: incarnation.stop_evidence }) }) })
}

/** Upgrade metadata only: this cannot attest that a current native carrier has exited. */
export function captureLegacyWorkspaceExecutions(
  entries: ReadonlyArray<{ managerKey: ManagerKey; worker: LedgerWorker }>, capturedAt: string,
): LegacyWorkspaceExecutions {
  if (!time(capturedAt)) throw invalid()
  captureWorkspaceRelocationWorkers(entries) // Keep the complete scope's identity checks, including excluded members.
  const result: LegacyExecutionEntry[] = []
  for (const { managerKey, worker } of entries) for (const incarnation of worker.incarnations) {
    if (!endedEvidence(worker, incarnation, capturedAt)) continue
    if (!text(worker.worker_id) || !text(incarnation.incarnation_id)) throw invalid()
    result.push(Object.freeze({ worker_id: worker.worker_id, incarnation_id: incarnation.incarnation_id!,
      evidence_sha256: evidenceDigest(managerKey, worker, incarnation) }))
    if (result.length > 32768) throw invalid()
  }
  result.sort((a, b) => key(a.worker_id, a.incarnation_id) < key(b.worker_id, b.incarnation_id) ? -1 : 1)
  return Object.freeze({ schema_version: 1, captured_at: capturedAt, entries: Object.freeze(result) })
}

/** Read only the original boundary. Current observations cannot enroll another execution. */
export function createLegacyWorkspaceExecutionMatcher(raw: unknown): (managerKey: ManagerKey, worker: LedgerWorker, incarnationId: string) => boolean {
  const value = raw as LegacyWorkspaceExecutions
  if (!value || Object.keys(value).sort().join(',') !== 'captured_at,entries,schema_version' || value.schema_version !== 1
    || !time(value.captured_at) || !Array.isArray(value.entries) || value.entries.length > 32768) throw invalid()
  const capturedAt = value.captured_at, fixed = new Map<string, string>()
  for (const entry of value.entries) {
    if (!entry || Object.keys(entry).sort().join(',') !== 'evidence_sha256,incarnation_id,worker_id'
      || !text(entry.worker_id) || !text(entry.incarnation_id) || !/^[a-f0-9]{64}$/.test(entry.evidence_sha256)
      || fixed.has(key(entry.worker_id, entry.incarnation_id))) throw invalid()
    fixed.set(key(entry.worker_id, entry.incarnation_id), entry.evidence_sha256)
  }
  return (managerKey, worker, incarnationId) => {
    const digest = fixed.get(key(worker.worker_id, incarnationId))
    if (!digest) return false
    const incarnation = worker.incarnations.find(item => item.incarnation_id === incarnationId)
    return !!incarnation && endedEvidence(worker, incarnation, capturedAt) && worker.manager_key === managerKey && evidenceDigest(managerKey, worker, incarnation) === digest
  }
}
