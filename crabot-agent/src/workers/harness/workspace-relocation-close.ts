import { createHash } from 'node:crypto'
import type { WorkspaceRelocationWorker } from 'crabot-shared'
import { LedgerStore } from './ledger-store.js'
import type { ManagerKey, WorkerLedger, RequestAwareWorkerLedgerFile } from './ledger-types.js'
import { assertWorkspaceRelocationWorkersCurrent } from './workspace-relocation-scope.js'
import { applyStatusTransition } from './task-status.js'

interface ClosureInput {
  intentId: string
  closedAt: string
  workers: ReadonlyArray<WorkspaceRelocationWorker>
  ledgers: ReadonlyArray<{ manager_key: ManagerKey; contents: string }>
}
export interface WorkspaceRelocationLedgerClosure {
  readonly manager_key: ManagerKey
  readonly before_sha256: string
  readonly after_sha256: string
  readonly closed_worker_ids: ReadonlyArray<string>
  readonly contents: string
}
const digest = (value: string) => createHash('sha256').update(value).digest('hex')

/** Pure Agent-owned preparation, not authorization or evidence that any execution has stopped. */
export function prepareWorkspaceRelocationWorkerClosure(input: ClosureInput): ReadonlyArray<WorkspaceRelocationLedgerClosure> {
  if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(input.intentId)
    || !Number.isFinite(Date.parse(input.closedAt)) || new Date(input.closedAt).toISOString() !== input.closedAt) {
    throw new Error('Invalid fixed workspace relocation closure')
  }
  const keys = new Set<ManagerKey>()
  const decoded = input.ledgers.map(row => {
    if (keys.has(row.manager_key)) throw new Error('Duplicate workspace relocation Manager ledger')
    keys.add(row.manager_key)
    return { row, ...LedgerStore.parseWorkspaceRelocationLedger(row.manager_key, row.contents) }
  })
  assertWorkspaceRelocationWorkersCurrent(input.workers, decoded.flatMap(item => item.ledger.workers.map(worker => ({ managerKey: item.row.manager_key, worker }))))
  const result = decoded.map(({ row, physical, wrapped }) => {
    const original = wrapped ? (physical as RequestAwareWorkerLedgerFile).ledger : physical as WorkerLedger
    const closed: string[] = []
    const workers = original.workers.map(worker => {
      if (worker.task.status === 'closed') return worker
      closed.push(worker.worker_id)
      return { ...worker, task: applyStatusTransition(worker.task, 'closed', { now: input.closedAt,
        closed: { by: 'migration', note: 'workspace relocation ' + input.intentId } }), updated_at: input.closedAt }
    })
    const contents = closed.length === 0 ? row.contents : JSON.stringify(wrapped
      ? { ...(physical as RequestAwareWorkerLedgerFile), ledger: { ...original, workers } } : { ...original, workers }, null, 2)
    return Object.freeze({ manager_key: row.manager_key, before_sha256: digest(row.contents), after_sha256: digest(contents),
      closed_worker_ids: Object.freeze(closed), contents })
  }).sort((a, b) => a.manager_key < b.manager_key ? -1 : 1)
  return Object.freeze(result)
}
