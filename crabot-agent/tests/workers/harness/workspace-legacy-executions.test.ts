import { describe, expect, it } from 'vitest'
import { captureLegacyWorkspaceExecutions, createLegacyWorkspaceExecutionMatcher } from '../../../src/workers/harness/workspace-legacy-executions.js'
import type { LedgerWorker, ManagerKey } from '../../../src/workers/harness/ledger-types.js'
const started = '2026-10-19T00:00:00.000Z', ended = '2026-10-19T00:01:00.000Z', boundary = '2026-10-20T00:00:00.000Z'
function entry(id = 'old') {
  const managerKey: ManagerKey = 'channel::session'
  const worker: LedgerWorker = { worker_id: id, manager_key: managerKey,
    task: { id: 'task-' + id, title: 'PRIVATE TASK BODY', status: 'halted', created_at: started,
      input: { password: 'PRIVATE INPUT' }, halt: { halted_at: ended, halt_reason: 'turn_end' } },
    origin: { trigger_type: 'message' }, report_to: { channel_id: 'channel', session_id: 'session' },
    incarnations: [{ incarnation_id: id + '-inc', impl: 'codex', seq: 1, state: 'exited', workspace: '/fixture/project',
      session_ref: 'PRIVATE SESSION REF', started_at: started, ended_at: ended, ended_reason: 'completed' }], updated_at: ended }
  return { managerKey, worker }
}
describe('one-time legacy execution evidence boundary', () => {
  it('fixes ended mainlines and forks without changing original task state or evidence', () => {
    const old = entry(), second = entry('other')
    old.worker.incarnations.push({ ...old.worker.incarnations[0], incarnation_id: 'old-fork', forked_from: 'old-inc', query_id: 'query', impl: 'claude-code' })
    const source = [second, old], before = structuredClone(source), snapshot = captureLegacyWorkspaceExecutions(source, boundary)
    expect(snapshot.entries.map(item => [item.worker_id, item.incarnation_id])).toEqual([['old', 'old-fork'], ['old', 'old-inc'], ['other', 'other-inc']])
    const matches = createLegacyWorkspaceExecutionMatcher(snapshot)
    expect(matches(old.managerKey, old.worker, 'old-inc')).toBe(true); expect(matches(old.managerKey, old.worker, 'old-fork')).toBe(true)
    expect(snapshot).toMatchObject({ schema_version: 1, captured_at: boundary })
    expect(Object.isFrozen(snapshot)).toBe(true); expect(Object.isFrozen(snapshot.entries[0])).toBe(true)
    expect(source).toEqual(before); expect(JSON.stringify(snapshot)).not.toMatch(/PRIVATE|fixture|password|permissions|stop_evidence/)
  })
  it.each(['running', 'idle', 'missing end', 'missing reason', 'pre_migration', 'bad start', 'bad end', 'end before start', 'future end',
    'task unknown', 'task stop unknown', 'stop unknown', 'stop unverified', 'background unknown', 'background active', 'bad execution end', 'bad background end', 'conflicting background', 'aggregate before background', 'invalid halt reason', 'missing background', 'builtin', 'legacy'])('does not admit %s as legacy exit evidence', change => {
    const f = entry(), inc = f.worker.incarnations[0]
    if (inc.impl === 'legacy') throw new Error('fixture')
    switch (change) {
      case 'running': inc.state = 'running'; break
      case 'idle': inc.state = 'idle'; break
      case 'missing end': delete inc.ended_at; break
      case 'missing reason': delete inc.ended_reason; break
      case 'pre_migration': inc.ended_reason = 'pre_migration'; break
      case 'bad start': inc.started_at = 'invalid'; break
      case 'bad end': inc.ended_at = 'invalid'; break
      case 'end before start': inc.ended_at = '2026-10-18T00:00:00.000Z'; break
      case 'future end': inc.ended_at = '2026-10-21T00:00:00.000Z'; break
      case 'task unknown': f.worker.task.halt!.halt_reason = 'unknown'; break
      case 'task stop unknown': f.worker.task.halt!.stop_unverified = true; break
      case 'builtin': inc.impl = 'builtin'; break
      case 'legacy': f.worker.incarnations = [{ ...inc, impl: 'legacy', session_ref: undefined } as any]; break
      default:
        inc.stop_evidence = { halt: { halted_at: ended, halt_reason: 'turn_end' }, background: [] }
        if (change === 'stop unknown') inc.stop_evidence.halt.halt_reason = 'unknown'
        if (change === 'stop unverified') inc.stop_evidence.halt.stop_unverified = true
        if (change === 'background unknown') inc.stop_evidence.background_unverified = true
        if (change === 'background active') inc.stop_evidence.background.push({ entity_id: 'old-shell' })
        if (change === 'bad execution end') inc.stop_evidence.execution_stopped_at = 'not-a-time'
        if (change === 'bad background end') inc.stop_evidence.background.push({ entity_id: 'old-shell', ended_at: 'not-a-time' })
        if (change === 'conflicting background') inc.stop_evidence.background = [{ entity_id: 'shell', ended_at: ended }, { entity_id: 'shell', ended_at: ended }]
        if (change === 'aggregate before background') { inc.stop_evidence.execution_stopped_at = ended; inc.stop_evidence.background = [{ entity_id: 'shell', ended_at: '2026-10-19T00:02:00.000Z' }] }
        if (change === 'invalid halt reason') inc.stop_evidence.halt.halt_reason = 'invalid' as any
        if (change === 'missing background') delete (inc.stop_evidence as any).background
    }
    expect(captureLegacyWorkspaceExecutions([f], boundary).entries).toEqual([])
  })
  it('accepts original complete stop evidence but not task.closed by itself', () => {
    const f = entry(), inc = f.worker.incarnations[0]
    if (inc.impl === 'legacy') throw new Error('fixture')
    inc.stop_evidence = { execution_stopped_at: ended, halt: { halted_at: ended, halt_reason: 'crashed' }, background: [{ entity_id: 'shell', ended_at: ended }] }
    f.worker.task.status = 'closed'; f.worker.task.closed = { by: 'admin', at: ended }
    expect(captureLegacyWorkspaceExecutions([f], boundary).entries).toHaveLength(1)
    delete inc.ended_at; expect(captureLegacyWorkspaceExecutions([f], boundary).entries).toEqual([])
  })
  it.each(['new Worker', 'new incarnation', 'changed owner', 'changed task', 'changed workspace', 'changed start', 'changed end', 'changed impl', 'changed seq', 'changed fork', 'changed session', 'changed evidence', 'new unknown'])('does not widen the first boundary for %s', change => {
    const f = entry(), snapshot = captureLegacyWorkspaceExecutions([f], boundary), matches = createLegacyWorkspaceExecutionMatcher(snapshot), inc = f.worker.incarnations[0]
    switch (change) {
      case 'new Worker': f.worker.worker_id = 'new'; break
      case 'new incarnation': inc.incarnation_id = 'new'; break
      case 'changed owner': f.managerKey = f.worker.manager_key = 'other::session'; break
      case 'changed task': f.worker.task.id = 'new'; break
      case 'changed workspace': inc.workspace = '/fixture/other'; break
      case 'changed start': inc.started_at = '2026-10-18T00:00:00.000Z'; break
      case 'changed end': inc.ended_at = '2026-10-19T00:02:00.000Z'; break
      case 'changed impl': inc.impl = 'claude-code'; break
      case 'changed seq': inc.seq = 2; break
      case 'changed fork': inc.forked_from = 'other-inc'; break
      case 'changed session': if (inc.impl !== 'legacy') inc.session_ref = 'changed'; break
      case 'changed evidence': if (inc.impl !== 'legacy') inc.stop_evidence = { halt: { halted_at: ended, halt_reason: 'crashed' }, background: [] }; break
      case 'new unknown': inc.state = 'running'; delete inc.ended_at; delete inc.ended_reason; break
    }
    expect(matches(f.managerKey, f.worker, inc.incarnation_id!)).toBe(false); expect(snapshot.entries).toHaveLength(1)
  })
  it('permits unrelated observations and task disposition to advance', () => {
    const f = entry(), matches = createLegacyWorkspaceExecutionMatcher(captureLegacyWorkspaceExecutions([f], boundary))
    f.worker.task.title = 'changed'; f.worker.task.status = 'closed'; f.worker.task.closed = { at: boundary, by: 'admin' }; f.worker.updated_at = boundary
    expect(matches(f.managerKey, f.worker, 'old-inc')).toBe(true)
  })
  it.each(['null', 'future schema', 'extra field', 'bad date', 'duplicate', 'bad digest', 'bad identity', 'extra entry field'])('rejects a damaged boundary: %s', change => {
    const f = entry(); let snapshot: any = structuredClone(captureLegacyWorkspaceExecutions([f], boundary))
    switch (change) {
      case 'null': snapshot = null; break
      case 'future schema': snapshot.schema_version = 2; break
      case 'extra field': snapshot.allow_all = true; break
      case 'bad date': snapshot.captured_at = 'invalid'; break
      case 'duplicate': snapshot.entries.push(snapshot.entries[0]); break
      case 'bad digest': snapshot.entries[0].evidence_sha256 = 'wrong'; break
      case 'bad identity': snapshot.entries[0].incarnation_id = ''; break
      case 'extra entry field': snapshot.entries[0].skip_current_process = true; break
    }
    expect(() => createLegacyWorkspaceExecutionMatcher(snapshot)).toThrow()
  })
  it('snapshots supplied boundary instead of trusting later object mutation', () => {
    const f = entry(), supplied = structuredClone(captureLegacyWorkspaceExecutions([f], boundary)), matches = createLegacyWorkspaceExecutionMatcher(supplied)
    supplied.entries.length = 0; expect(matches(f.managerKey, f.worker, 'old-inc')).toBe(true)
  })
})
