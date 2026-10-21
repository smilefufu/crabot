import { describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { prepareWorkspaceRelocationWorkerClosure } from '../../../src/workers/harness/workspace-relocation-close.js'
import { captureWorkspaceRelocationWorkers } from '../../../src/workers/harness/workspace-relocation-scope.js'
import { normalizeLegacyWorkerMetadata } from '../../../src/workers/harness/ledger-store.js'
import type { LedgerWorker, ManagerKey, WorkerLedger } from '../../../src/workers/harness/ledger-types.js'

const intentId = '12345678-1234-4123-8123-123456789abc'
const closedAt = '2026-10-21T01:00:00.000Z', beforeAt = '2026-10-20T00:00:00.000Z'
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
function worker(id: string, status: LedgerWorker['task']['status'] = 'running', key: ManagerKey = 'channel::session'): LedgerWorker {
  return { worker_id: id, manager_key: key, workspace_id: 'default',
    task: { id, title: 'original task', goal: 'unfinished goal', status, created_at: beforeAt, input: { private: 'keep' },
      ...(status === 'halted' ? { halt: { halted_at: beforeAt, halt_reason: 'turn_end' } } : {}),
      ...(status === 'closed' ? { closed: { at: beforeAt, by: 'admin', note: 'original disposition' } } : {}) },
    origin: { trigger_type: 'message', creator_friend_id: 'original-friend', spawned_by_episode: 'original-episode' },
    report_to: { channel_id: 'channel', session_id: 'original-session' },
    incarnations: [{ incarnation_id: id + '-main', impl: 'builtin', seq: 1, state: 'exited', workspace: '/original/workspace',
      started_at: beforeAt, ended_at: beforeAt, ended_reason: 'turn_end', session_ref: 'original-native-session' }],
    recovery_notices: [{ notice_id: 'original-notice', incarnation_id: id + '-main', status: 'pending', created_at: beforeAt, attempts: 1 }], updated_at: beforeAt }
}
function fixture(ledgers: WorkerLedger[], wrapped = false) {
  return { intentId, closedAt, workers: captureWorkspaceRelocationWorkers(ledgers.flatMap(ledger => ledger.workers.map(item => ({ managerKey: ledger.manager_key, worker: normalizeLegacyWorkerMetadata(item) })))),
    ledgers: ledgers.map(ledger => ({ manager_key: ledger.manager_key, contents: JSON.stringify(wrapped ? { schema_version: 1, ledger } : ledger, null, 4) + '\n' })) }
}
function ledger(contents: string): WorkerLedger { const value = JSON.parse(contents); return value.ledger ?? value }

describe('Agent-owned workspace relocation close preparation', () => {
  it('closes the entire fixed set and preserves business, authority and native history', () => {
    const original = [worker('queued', 'queued'), worker('running'), worker('halted', 'halted'), worker('closed', 'closed')]
    const native = worker('native', 'running', 'other::session'); native.incarnations = []; native.recovery_notices = []
    const input = fixture([{ manager_key: 'other::session', workers: [native] }, { manager_key: 'channel::session', workers: original }])
    const before = structuredClone(input), result = prepareWorkspaceRelocationWorkerClosure(input)
    expect(input).toEqual(before)
    expect(result.map(row => row.manager_key)).toEqual(['channel::session', 'other::session'])
    const closed = ledger(result[0].contents).workers
    for (let i = 0; i < 3; i++) {
      expect(closed[i].task.status).toBe('closed')
      expect(closed[i].task.closed).toEqual({ at: closedAt, by: 'migration', note: 'workspace relocation ' + intentId })
      expect(closed[i].task.halt).toBeUndefined()
      expect(closed[i]).toEqual({ ...original[i], task: { ...original[i].task, status: 'closed', halt: undefined, closed: closed[i].task.closed }, updated_at: closedAt })
    }
    expect(closed[3]).toEqual(original[3])
    expect(result[0].closed_worker_ids).toEqual(['queued', 'running', 'halted'])
    expect(result[1].closed_worker_ids).toEqual(['native'])
    expect(result[0].before_sha256).toBe(hash(input.ledgers[1].contents))
    expect(result[0].after_sha256).toBe(hash(result[0].contents))
    expect(prepareWorkspaceRelocationWorkerClosure(input)).toEqual(result)
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result[0].closed_worker_ids)).toBe(true)
  })
  it('preserves an already closed file byte for byte with its original envelope', () => {
    const input = fixture([{ manager_key: 'channel::session', workers: [worker('closed', 'closed')] }], true)
    const [result] = prepareWorkspaceRelocationWorkerClosure(input)
    expect(result.contents).toBe(input.ledgers[0].contents)
    expect(result.before_sha256).toBe(result.after_sha256)
    expect(result.closed_worker_ids).toEqual([])
    expect(JSON.parse(result.contents).schema_version).toBe(1)
  })
  it('preserves envelopes, empty ledgers and unrecognized historical fields', () => {
    const input = fixture([{ manager_key: 'channel::session', workers: [worker('running')] }, { manager_key: 'empty::session', workers: [] }], true)
    const physical = JSON.parse(input.ledgers[0].contents)
    physical.ledger.original_audit = { value: 'preserve' }; physical.ledger.workers[0].task.original_permission_snapshot = { storage: null }
    input.ledgers[0].contents = JSON.stringify(physical)
    const result = prepareWorkspaceRelocationWorkerClosure(input)
    expect(JSON.parse(result[0].contents).ledger.original_audit).toEqual({ value: 'preserve' })
    expect(ledger(result[0].contents).workers[0].task).toMatchObject({ original_permission_snapshot: { storage: null } })
    expect(result[1].contents).toBe(input.ledgers[1].contents)
  })
  it('preserves the exact immutable human request binding and rejects its unwrapped downgrade', () => {
    const item = worker('request')
    item.origin.request = { schema_version: 1, request_id: 'a'.repeat(64), source_sha256: 'b'.repeat(64), execution_scope: 'request' }
    const input = fixture([{ manager_key: 'channel::session', workers: [item] }], true)
    const [result] = prepareWorkspaceRelocationWorkerClosure(input)
    expect(ledger(result.contents).workers[0].origin).toEqual(item.origin)
    expect(JSON.parse(result.contents).schema_version).toBe(1)
    input.ledgers[0].contents = JSON.stringify({ manager_key: 'channel::session', workers: [item] })
    expect(() => prepareWorkspaceRelocationWorkerClosure(input)).toThrow('versioned envelope')
  })
  it('rejects pending legacy status conversion without emitting normal-reader warnings or changing data', () => {
    const input = fixture([{ manager_key: 'channel::session', workers: [worker('old')] }])
    const physical = ledger(input.ledgers[0].contents)
    ;(physical.workers[0].task as { status: string }).status = 'unknown_old_value'
    input.ledgers[0].contents = JSON.stringify(physical)
    const warning = vi.spyOn(console, 'warn')
    try {
      expect(() => prepareWorkspaceRelocationWorkerClosure(input)).toThrow('format migration')
      expect(warning).not.toHaveBeenCalled()
    } finally { warning.mockRestore() }
  })
  it('matches old deterministic incarnation IDs without rewriting physical incarnation history', () => {
    const old = worker('old'); delete old.workspace_id; delete old.recovery_notices; delete (old.incarnations[0] as Partial<typeof old.incarnations[0]>).incarnation_id
    const input = fixture([{ manager_key: 'channel::session', workers: [old] }])
    const [result] = prepareWorkspaceRelocationWorkerClosure(input)
    expect(ledger(result.contents).workers[0].incarnations).toEqual(old.incarnations)
    expect(ledger(result.contents).workers[0].workspace_id).toBeUndefined()
    expect(ledger(result.contents).workers[0].task.status).toBe('closed')
  })
  it.each(['new Worker', 'missing Worker', 'new incarnation', 'project', 'task', 'Manager', 'duplicate ledger', 'duplicate Worker', 'bad envelope', 'legacy status', 'bad JSON', 'bad time', 'bad intent'])('refuses %s before any write material exists', mode => {
    const input = fixture([{ manager_key: 'channel::session', workers: [worker('original')] }])
    const current = ledger(input.ledgers[0].contents), item = current.workers[0]
    if (mode === 'new Worker') current.workers.push(worker('new'))
    if (mode === 'missing Worker') current.workers = []
    if (mode === 'new incarnation') item.incarnations.push({ ...item.incarnations[0], incarnation_id: 'new' })
    if (mode === 'project') item.workspace_id = intentId
    if (mode === 'task') item.task.id = 'another-task'
    if (mode === 'Manager') item.manager_key = 'other::session'
    if (mode === 'duplicate ledger') input.ledgers.push({ ...input.ledgers[0] })
    if (mode === 'duplicate Worker') current.workers.push(structuredClone(item))
    if (mode === 'legacy status') (item.task as { status: string }).status = 'completed'
    input.ledgers[0].contents = JSON.stringify(current)
    if (mode === 'bad envelope') input.ledgers[0].contents = JSON.stringify({ schema_version: 2, ledger: current })
    if (mode === 'bad JSON') input.ledgers[0].contents = '{'
    if (mode === 'bad time') input.closedAt = 'yesterday'
    if (mode === 'bad intent') input.intentId = '../other'
    const before = structuredClone(input)
    expect(() => prepareWorkspaceRelocationWorkerClosure(input)).toThrow()
    expect(input).toEqual(before)
  })
})
