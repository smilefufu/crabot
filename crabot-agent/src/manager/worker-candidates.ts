import path from 'node:path'
import type { ManagerWorkboard } from './workboard-store.js'
import type { LedgerWorker } from '../workers/harness/ledger-types.js'
import { WorkspaceGitInspector } from '../workers/harness/workspace-git-inspector.js'

export const CONTINUATION_CANDIDATE_LIMIT = 3
export type WorkerViewKind = 'executing' | 'candidate' | 'attention' | 'history' | 'retiring'
export type WorkerExecutionFact = 'running' | 'idle' | 'unknown'
type ProjectIdentity = { directory: string; commonDirectory?: string }

export interface WorkerViewFacts {
  readonly projects: ReadonlyMap<string, ProjectIdentity | undefined>
  readonly execution: ReadonlyMap<string, WorkerExecutionFact>
  readonly blocked: ReadonlySet<string>
}

export interface WorkerViewSelection {
  readonly executing: LedgerWorker[]
  readonly candidates: LedgerWorker[]
  readonly attention: LedgerWorker[]
  readonly history: LedgerWorker[]
  readonly excludedIdle: LedgerWorker[]
  readonly projectKeys: string[]
}

export function workerViewKinds(view: WorkerViewSelection): Map<string, WorkerViewKind> {
  const result = new Map<string, WorkerViewKind>()
  for (const [kind, workers] of [
    ['retiring', view.excludedIdle], ['history', view.history], ['executing', view.executing],
    ['candidate', view.candidates], ['attention', view.attention],
  ] as const) {
    for (const worker of workers) result.set(worker.worker_id, kind)
  }
  return result
}

export function workerWorkspace(worker: LedgerWorker): string | undefined {
  return worker.incarnations.filter((incarnation) => incarnation.forked_from === undefined).at(-1)?.workspace
}

export async function resolveWorkerProjects(workers: readonly LedgerWorker[], board: ManagerWorkboard): Promise<Map<string, ProjectIdentity | undefined>> {
  const paths = new Set(board.objectives.flatMap(objective => objective.work_items.flatMap(item => item.project_root ? [item.project_root] : [])))
  for (const worker of workers) {
    const workspace = workerWorkspace(worker)
    if (workspace && worker.task.status !== 'closed') paths.add(workspace)
  }
  const inspector = new WorkspaceGitInspector()
  const projects = new Map<string, ProjectIdentity | undefined>()
  // Bound subprocess fanout for large historical ledgers.
  const pending = [...paths]
  for (let offset = 0; offset < pending.length; offset += 8) {
    await Promise.all(pending.slice(offset, offset + 8).map(async directory => {
      try { projects.set(directory, await inspector.projectIdentity(directory)) }
      catch { projects.set(directory, undefined) }
    }))
  }
  return projects
}

function identityKey(identity: ProjectIdentity): string {
  return identity.commonDirectory ? `git:${identity.commonDirectory}` : `directory:${identity.directory}`
}

function isWithin(parent: string, child: string): boolean {
  const relative = path.relative(parent, child)
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

function compareHalted(a: LedgerWorker, b: LedgerWorker): number {
  const timestamp = (worker: LedgerWorker): number => {
    const value = Date.parse(worker.task.halt?.halted_at ?? '')
    return Number.isFinite(value) ? value : -Infinity
  }
  const left = timestamp(a), right = timestamp(b)
  return left === right ? a.worker_id.localeCompare(b.worker_id) : left > right ? -1 : 1
}

function compareUpdated(a: LedgerWorker, b: LedgerWorker): number {
  return b.updated_at.localeCompare(a.updated_at) || a.worker_id.localeCompare(b.worker_id)
}

/** Pure selection over one scope/fact snapshot; never used as a GC eligibility rule. */
export function selectWorkerView(workers: readonly LedgerWorker[], board: ManagerWorkboard, facts: WorkerViewFacts): WorkerViewSelection {
  const projects = new Map<string, ProjectIdentity>()
  let incomplete = false
  for (const objective of board.objectives) {
    if (objective.work_items.length === 0) incomplete = true
    for (const item of objective.work_items) {
      const identity = item.project_root ? facts.projects.get(item.project_root) : undefined
      if (identity) projects.set(identityKey(identity), identity)
      else incomplete = true
    }
  }
  const executing: LedgerWorker[] = [], attention: LedgerWorker[] = [], history: LedgerWorker[] = []
  const excludedIdle: LedgerWorker[] = [], candidates: LedgerWorker[] = []
  const byProject = new Map<string, LedgerWorker[]>()
  for (const worker of workers) {
    const execution = facts.execution.get(worker.worker_id) ?? 'unknown'
    if (worker.task.status === 'closed') { history.push(worker); continue }
    if (worker.task.status === 'queued' || execution === 'running') {
      executing.push(worker)
      if (facts.blocked.has(worker.worker_id)) attention.push(worker)
      continue
    }
    if (worker.task.status !== 'halted' || execution !== 'idle' || worker.task.halt?.stop_unverified || facts.blocked.has(worker.worker_id)) {
      attention.push(worker); continue
    }
    const workspace = workerWorkspace(worker)
    const identity = workspace ? facts.projects.get(workspace) : undefined
    if (!identity) { attention.push(worker); continue }
    const matches = [...projects].filter(([key, project]) => identity.commonDirectory
      ? key === identityKey(identity)
      : !project.commonDirectory && isWithin(project.directory, identity.directory))
    if (matches.length > 1 || (matches.length === 0 && incomplete)) { attention.push(worker); continue }
    if (matches.length === 0) { excludedIdle.push(worker); continue }
    const key = matches[0][0]
    const items = byProject.get(key) ?? []
    items.push(worker)
    byProject.set(key, items)
  }
  for (const items of byProject.values()) {
    items.sort(compareHalted)
    candidates.push(...items.slice(0, CONTINUATION_CANDIDATE_LIMIT))
    excludedIdle.push(...items.slice(CONTINUATION_CANDIDATE_LIMIT))
  }
  for (const items of [executing, candidates, attention, history]) items.sort(compareUpdated)
  excludedIdle.sort(compareHalted)
  return { executing, candidates, attention, history, excludedIdle, projectKeys: [...projects.keys()].sort() }
}
