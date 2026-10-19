import { describe, expect, it } from 'vitest'
import { captureWorkspaceRelocationWorkers, assertWorkspaceRelocationWorkersCurrent } from '../../../src/workers/harness/workspace-relocation-scope.js'
import type { LedgerWorker, ManagerKey } from '../../../src/workers/harness/ledger-types.js'

function entry(id: string, manager: ManagerKey = 'channel::session') {
  const worker: LedgerWorker = { worker_id: id, manager_key: manager, workspace_id: 'project',
    task: { id, title: 'private task', status: 'running', created_at: '2026-10-20T00:00:00.000Z', input: { secret: 'do not copy' } },
    origin: { trigger_type: 'message', creator_friend_id: 'private-friend' }, report_to: { channel_id: 'channel', session_id: 'session' },
    incarnations: [{ incarnation_id: id + '-inc', impl: 'builtin', seq: 1, state: 'running', workspace: '/fixture/project',
      session_ref: 'mutable-native-ref', started_at: '2026-10-20T00:00:00.000Z' }], updated_at: '2026-10-20T00:00:00.000Z' }
  return { managerKey: manager, worker }
}

describe('workspace relocation fixed Worker identities', () => {
  it('retains all Managers, closed/history/native tasks and same-seq cross-implementation forks', () => {
    const closed = entry('closed'), legacy = entry('legacy', 'other::session'), native = entry('native'), active = entry('active')
    closed.worker.task.status = 'closed'
    legacy.worker.workspace_id = undefined
    legacy.worker.incarnations = [{ incarnation_id: 'legacy-inc', impl: 'legacy', seq: 1, state: 'exited', workspace: '/fixture/old',
      started_at: '2026-01-01T00:00:00.000Z', ended_at: '2026-01-01T00:00:01.000Z', ended_reason: 'pre_migration' }]
    native.worker.incarnations = []
    active.worker.incarnations.push({ ...active.worker.incarnations[0], incarnation_id: 'fork-inc', impl: 'codex',
      forked_from: 'active-inc', session_ref: 'fork', seq: 1 })
    const scope = captureWorkspaceRelocationWorkers([native, legacy, active, closed])
    expect(scope.map(item => item.worker_id)).toEqual(['active', 'closed', 'legacy', 'native'])
    expect(scope[0].incarnations.map(item => [item.impl, item.seq])).toEqual([['builtin', 1], ['codex', 1]])
    expect(scope[2].manager_key).toBe('other::session')
    expect(scope[3].incarnations).toEqual([])
    expect(JSON.stringify(scope)).not.toMatch(/private task|do not copy|private-friend|mutable-native-ref/)
    expect(Object.isFrozen(scope)).toBe(true)
    expect(Object.isFrozen(scope[0].incarnations[0])).toBe(true)
  })

  it('permits state, session discovery and unrelated task observations to advance', () => {
    const current = [entry('b'), entry('a')], scope = captureWorkspaceRelocationWorkers(current)
    current.reverse()
    current[0].worker.task.status = 'halted'
    current[0].worker.task.title = 'later observation'
    current[0].worker.incarnations[0].state = 'exited'
    if (current[0].worker.incarnations[0].impl !== 'legacy') current[0].worker.incarnations[0].session_ref = 'discovered-session'
    expect(() => assertWorkspaceRelocationWorkersCurrent(scope, current)).not.toThrow()
  })

  it.each(['new Worker', 'missing Worker', 'new incarnation', 'missing incarnation', 'replaced incarnation', 'changed impl', 'changed seq', 'changed workspace', 'changed start', 'changed project', 'changed Manager', 'changed task', 'changed fork', 'changed query'])('refuses %s in a fixed set', change => {
    const current = [entry('original')], scope = captureWorkspaceRelocationWorkers(current), worker = current[0].worker
    switch (change) {
      case 'new Worker': current.push(entry('new')); break
      case 'missing Worker': current.pop(); break
      case 'new incarnation': worker.incarnations.push({ ...worker.incarnations[0], incarnation_id: 'new' }); break
      case 'missing incarnation': worker.incarnations = []; break
      case 'replaced incarnation': worker.incarnations[0].incarnation_id = 'replacement'; break
      case 'changed impl': worker.incarnations[0].impl = 'codex'; break
      case 'changed seq': worker.incarnations[0].seq = 2; break
      case 'changed workspace': worker.incarnations[0].workspace = '/fixture/replaced'; break
      case 'changed start': worker.incarnations[0].started_at = '2026-10-21T00:00:00.000Z'; break
      case 'changed project': worker.workspace_id = 'another'; break
      case 'changed Manager': current[0].managerKey = worker.manager_key = 'another::session'; break
      case 'changed task': worker.task.id = 'replacement-task'; break
      case 'changed fork': worker.incarnations[0].forked_from = 'other'; break
      case 'changed query': worker.incarnations[0].query_id = 'other-query'; break
    }
    expect(() => assertWorkspaceRelocationWorkersCurrent(scope, current)).toThrow('稳定身份')
  })

  it.each(['duplicate Worker', 'duplicate incarnation', 'missing identity', 'inconsistent Manager'])('rejects %s instead of silently shrinking the set', change => {
    const current = [entry('worker')], worker = current[0].worker
    switch (change) {
      case 'duplicate Worker': current.push(entry('worker')); break
      case 'duplicate incarnation': worker.incarnations.push({ ...worker.incarnations[0] }); break
      case 'missing identity': delete worker.incarnations[0].incarnation_id; break
      case 'inconsistent Manager': current[0].managerKey = 'other::session'; break
    }
    expect(() => captureWorkspaceRelocationWorkers(current)).toThrow('稳定身份')
  })
})
