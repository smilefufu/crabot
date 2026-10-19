import type { WorkspaceExecution } from 'crabot-shared'
import type { LedgerWorker } from './ledger-types.js'
import type { WorkerExecutionObservation } from '../types.js'

function resourceState(observation: WorkerExecutionObservation): WorkspaceExecution['status'] {
  if (observation.reasons.some(reason => reason === 'mainline_running' || reason === 'fork_running')
    || observation.active_subagents.some(child => child.status === 'running')
    || observation.active_background.some(entity => entity.status === 'running')) return 'running'
  if (observation.unavailable_reasons.some(reason => reason !== 'notification_state_unavailable')
    || observation.active_subagents.some(child => child.status === 'unknown')
    || observation.active_background.some(entity => entity.status === 'stalled')
    || observation.reasons.some(reason => reason === 'subagent_running' || reason === 'background_running')) return 'unknown'
  return 'idle'
}

/** Workspace resource projection only. Candidate quotas, pending delivery and migration stop proofs have different semantics. */
export async function projectWorkspaceExecution(
  workers: readonly LedgerWorker[],
  read: (workerId: string) => Promise<WorkerExecutionObservation>,
): Promise<Record<string, WorkspaceExecution>> {
  const bound = workers.filter(worker => worker.workspace_id !== undefined)
  const states = new Map<string, Array<WorkspaceExecution['status']>>()
  for (let offset = 0; offset < bound.length; offset += 4) {
    await Promise.all(bound.slice(offset, offset + 4).map(async worker => {
      let status: WorkspaceExecution['status'] = 'unknown'
      try { status = resourceState(await read(worker.worker_id)) } catch { /* Missing evidence stays unknown. */ }
      const group = states.get(worker.workspace_id!) ?? []
      group.push(status); states.set(worker.workspace_id!, group)
    }))
  }
  const observed_at = new Date().toISOString()
  return Object.fromEntries([...states].map(([id, group]) => {
    const running = group.filter(status => status === 'running').length, unknown = group.includes('unknown')
    let status: WorkspaceExecution['status'] = 'idle'
    if (running) status = 'running'
    else if (unknown) status = 'unknown'
    return [id, { status, observed_at, worker_count: group.length, ...(unknown ? {} : { running_worker_count: running }) }]
  }))
}
