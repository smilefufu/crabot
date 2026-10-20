import { sha256CanonicalJson } from 'crabot-shared'
import type { LedgerWorker, ManagerKey } from './ledger-types.js'

import type { WorkspaceRelocationWorker } from 'crabot-shared'
export type { WorkspaceRelocationWorker } from 'crabot-shared'

function invalid(): never {
  throw Object.assign(new Error('执行器集合或稳定身份无法核验，已保留维护保护。'), { code: 'WORKSPACE_MAINTENANCE' })
}

/** Includes closed, legacy and Agent-native Workers. Call only after all admissions drain. */
export function captureWorkspaceRelocationWorkers(
  entries: ReadonlyArray<{ managerKey: ManagerKey; worker: LedgerWorker }>,
): ReadonlyArray<WorkspaceRelocationWorker> {
  const workers = new Set<string>()
  const result = entries.map(({ managerKey, worker }) => {
    if (!worker.worker_id || workers.has(worker.worker_id) || !managerKey || managerKey !== worker.manager_key) invalid()
    workers.add(worker.worker_id)
    const ids = new Set<string>()
    const incarnations = worker.incarnations.map(item => {
      if (!item.incarnation_id || ids.has(item.incarnation_id)) invalid()
      ids.add(item.incarnation_id)
      return Object.freeze({ incarnation_id: item.incarnation_id, impl: item.impl, seq: item.seq,
        workspace: item.workspace, started_at: item.started_at,
        ...(item.forked_from === undefined ? {} : { forked_from: item.forked_from }),
        ...(item.query_id === undefined ? {} : { query_id: item.query_id }) })
    }).sort((a, b) => a.incarnation_id < b.incarnation_id ? -1 : 1)
    return Object.freeze({ worker_id: worker.worker_id, manager_key: managerKey, task_id: worker.task.id,
      ...(worker.workspace_id === undefined ? {} : { workspace_id: worker.workspace_id }), incarnations: Object.freeze(incarnations) })
  }).sort((a, b) => a.worker_id < b.worker_id ? -1 : 1)
  return Object.freeze(result)
}

/** Mutable state/session observations cannot hide replacement or newly registered executions. */
export function assertWorkspaceRelocationWorkersCurrent(
  expected: ReadonlyArray<WorkspaceRelocationWorker>,
  entries: ReadonlyArray<{ managerKey: ManagerKey; worker: LedgerWorker }>,
): void {
  if (sha256CanonicalJson(expected) !== sha256CanonicalJson(captureWorkspaceRelocationWorkers(entries))) invalid()
}


/** Submission receipts only. None of these states proves an execution exited. */
export interface WorkspaceRelocationStopResult {
  readonly worker_id: string
  readonly incarnation_id: string
  readonly status: 'submitted' | 'unknown' | 'unavailable'
}

/** Supplied only by the authenticated fixed job; prepare persists before any stop. */
export interface WorkspaceRelocationStopJournal {
  prepare(workers: ReadonlyArray<WorkspaceRelocationWorker>): Promise<'dispatch' | 'observe'>
  complete(results: ReadonlyArray<WorkspaceRelocationStopResult>): Promise<void>
}
