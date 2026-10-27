import test from 'node:test'
import assert from 'node:assert/strict'
import { HttpClient, WorkspaceClient, WorkspaceSummarySchema, WorkspaceExecutionInventorySchema } from '../dist/index.js'
const id = '12345678-1234-4123-8123-123456789abc'
const record = { workspace_id: id, kind: 'project', name: '项目', description: '', root: '/projects/demo', source: 'managed', created_at: '2026-10-19T00:00:00.000Z' }
function fixture(body, status = 200) {
  const calls = [], client = new WorkspaceClient(new HttpClient({ endpoint: 'http://localhost:3000/api', fetch: async (url, options) => {
    calls.push({ url, options }); return new Response(JSON.stringify(body), { status })
  } }))
  return { calls, client }
}
test('workspace identity, CAS and creation request are checked before HTTP; one mutation is never retried', async () => {
  const f = fixture({ revision: 2, workspace: record })
  await f.client.create({ workspace_id: id, name: ' 项目 ' })
  assert.equal(f.calls[0].url, 'http://localhost:3000/api/workspaces')
  assert.deepEqual(JSON.parse(f.calls[0].options.body), { workspace_id: id, name: '项目' })
  assert.throws(() => f.client.get('../escape'))
  assert.throws(() => f.client.update(id, { expected_revision: 0, name: 'x', description: '' }))
  assert.throws(() => f.client.update(id, { expected_revision: 2, name: 'x', description: '', root: '/moved' }))
  const conflict = fixture({ code: 'WORKSPACE_REVISION_CONFLICT', message: '保留草稿' }, 409)
  await assert.rejects(conflict.client.update(id, { expected_revision: 1, name: '草稿', description: '' }), { kind: 'conflict', message: '保留草稿' })
  assert.equal(conflict.calls.length, 1)
})
test('unknown execution and pending usage retain missing evidence; malformed counts and workspace identity are rejected', async () => {
  const item = { workspace: record, directory_status: 'ready', execution: { status: 'unknown' }, usage: { status: 'pending', file_count: 0, skipped_entries: 0 } }
  const parsed = WorkspaceSummarySchema.parse(item)
  assert.equal(parsed.execution.worker_count, undefined); assert.equal(parsed.usage.logical_bytes, undefined)
  for (const invalid of [{ ...item, workspace: { ...record, kind: 'default' } },
    { ...item, usage: { ...item.usage, logical_bytes: -1 } }, { ...item, execution: { status: 'idle', worker_count: 1.5 } }]) {
    const f = fixture({ revision: 1, item: invalid })
    await assert.rejects(f.client.get(id), { kind: 'validation' })
  }
})

test('workspace runtime inventory preserves incomplete evidence and validates counts, identities and observation times', () => {
  assert.deepEqual(WorkspaceExecutionInventorySchema.parse({ ready: false, items: {} }), { ready: false, items: {} })
  assert.equal(WorkspaceExecutionInventorySchema.parse({ ready: true, items: { default: { status: 'unknown', worker_count: 1 } } }).items.default.running_worker_count, undefined)
  assert.equal(WorkspaceExecutionInventorySchema.safeParse({ ready: true, items: { arbitrary: { status: 'idle' } } }).success, false)
  assert.equal(WorkspaceExecutionInventorySchema.safeParse({ ready: true, items: { default: { status: 'idle', observed_at: 'not-a-time' } } }).success, false)
})

test('aggregate usage has a checked HTTP contract and never retries a failed refresh', async () => {
  const usage = { status: 'partial', measured_at: '2026-10-19T00:00:00.000Z', logical_bytes: 17, file_count: 1, skipped_entries: 1 }
  const f = fixture(usage)
  assert.deepEqual(await f.client.totalUsage(), usage)
  assert.equal(f.calls[0].url, 'http://localhost:3000/api/workspaces/usage')
  await f.client.refreshTotalUsage()
  assert.equal(f.calls[1].url, 'http://localhost:3000/api/workspaces/usage/refresh')
  assert.equal(f.calls[1].options.method, 'POST'); assert.equal(f.calls[1].options.body, '{}')
  await assert.rejects(fixture({ ...usage, logical_bytes: -1 }).client.totalUsage(), { kind: 'validation' })
  const denied = fixture({ code: 'WORKSPACE_UNAVAILABLE', message: '维护中' }, 503)
  await assert.rejects(denied.client.refreshTotalUsage(), { message: '维护中' })
  assert.equal(denied.calls.length, 1)
})

test('maintenance is a checked read-only status and never coerces malformed evidence to false', async () => {
  const f = fixture({ maintenance: true })
  assert.deepEqual(await f.client.maintenance(), { maintenance: true })
  assert.equal(f.calls[0].url, 'http://localhost:3000/api/workspaces/maintenance')
  assert.equal(f.calls[0].options.method, 'GET')
  assert.equal(f.calls[0].options.body, undefined)
  for (const body of [{}, { maintenance: null }, { maintenance: 'false' }]) {
    await assert.rejects(fixture(body).client.maintenance(), { kind: 'validation' })
  }
})


test('relocation preview accepts only a target and checks the non-authoritative response without retry', async () => {
  const preview = { revision: 2, source: '/workspaces', target: '/moved', mode: 'rename', workspaces: [record], retained_workspaces: [],
    usage: { status: 'complete', logical_bytes: 1, file_count: 1, skipped_entries: 0 }, available_bytes: '9007199254740993', issues: [], execution: { ready: false, items: {} } }
  const f = fixture(preview)
  assert.deepEqual(await f.client.previewRelocation({ target: '/moved' }), preview)
  assert.equal(f.calls[0].url, 'http://localhost:3000/api/workspaces/relocation/preview')
  assert.equal(f.calls[0].options.method, 'POST'); assert.equal(f.calls[0].options.body, '{"target":"/moved"}')
  for (const input of [{ target: 'relative' }, { target: '/moved', source: '/' }, { target: '/moved', protectedRoots: [] }]) {
    assert.throws(() => f.client.previewRelocation(input)); assert.equal(f.calls.length, 1)
  }
  for (const invalid of [{ ...preview, mode: 'unchanged' }, { ...preview, usage: undefined }, { ...preview, available_bytes: 1 }, { ...preview, available_bytes: '-1' }, { ...preview, issues: [{ path: 'x', reason: 'ignore' }] }]) {
    await assert.rejects(fixture(invalid).client.previewRelocation({ target: '/moved' }), { kind: 'validation' })
  }
})

test('initial confirmation keeps one stable job id, strict receipt and header-only identity without retrying unknown network outcomes', async () => {
  const request = { intent_id: id, target: '/projects/new', expected_revision: 4, confirmed: true }
  const f = fixture({ intent_id: id, accepted: true }, 202)
  assert.deepEqual(await f.client.startRelocation(request), { intent_id: id, accepted: true })
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].url, 'http://localhost:3000/api/workspaces/relocation/start')
  assert.deepEqual(JSON.parse(f.calls[0].options.body), request)
  for (const bad of [{ ...request, confirmed: false }, { ...request, expected_revision: 0 }, { ...request, authorization: 'body-only' }, { ...request, source: '/forged' }]) {
    assert.throws(() => f.client.startRelocation(bad))
  }
  assert.equal(f.calls.length, 1)
  for (const bad of [{ intent_id: '22345678-1234-4123-8123-123456789abc', accepted: true }, { intent_id: id, accepted: true, unchanged: true, source: '/projects/new' }, { source: 'relative', unchanged: true }]) {
    await assert.rejects(fixture(bad).client.startRelocation(request), { kind: 'validation' })
  }
  assert.deepEqual(await fixture({ source: '/projects/new', unchanged: true }).client.startRelocation(request), { source: '/projects/new', unchanged: true })
  let attempts = 0
  const client = new WorkspaceClient(new HttpClient({ endpoint: 'http://localhost:3000/api', token: () => 'private-human-token', fetch: async (_url, options) => {
    attempts++; assert.equal(new Headers(options.headers).get('Authorization'), 'Bearer private-human-token')
    assert.equal(JSON.stringify(options.body).includes('private-human-token'), false)
    throw new TypeError('connection closed after handoff')
  } }))
  await assert.rejects(client.startRelocation(request), { kind: 'unreachable' }); assert.equal(attempts, 1)
  assert.equal(request.intent_id, id)
})

test('status keeps historical commit distinct from full completion, validates a fixed job and never starts an action', async () => {
  const job = { intent_id: id, state: 'committed', stage: 'finished', source: '/projects/old', target: '/projects/new' }, f = fixture({ available: true, job })
  assert.deepEqual(await f.client.currentRelocation(), { available: true, job })
  assert.deepEqual(await f.client.relocationStatus(id), { available: true, job })
  assert.deepEqual(f.calls.map(call => [call.url, call.options.method]), [
    ['http://localhost:3000/api/workspaces/relocation/current', 'GET'], ['http://localhost:3000/api/workspaces/relocation/jobs/' + id, 'GET'],
  ])
  assert.throws(() => f.client.relocationStatus('../private'))
  assert.throws(() => f.client.relocationStatus(undefined))
  assert.deepEqual(await fixture({ available: false, job: null }).client.currentRelocation(), { available: false, job: null })
  for (const body of [{ available: false, job }, { available: true, job: { ...job, state: 'completed', stage: 'unknown' } },
    { available: true, job: { ...job, intent_id: '22345678-1234-4123-8123-123456789abc' } }]) {
    await assert.rejects(fixture(body).client.relocationStatus(id), { kind: 'validation' })
  }
})


for (const action of [null, 'restore_source', 'finish_commit']) test('recovery is explicit, strictly correlated and never retried after losing admission: ' + (action ?? 'archived'), async () => {
  const recovery_id = '87654321-4321-4321-8321-cba987654321'
  const offer = action ? { intent_id: id, checkpoint_sha256: 'a'.repeat(64), action }
    : { intent_id: id, completion_sha256: 'a'.repeat(64), finalizing_sha256: 'b'.repeat(64) }
  const request = action ? { intent_id: id, recovery_id, checkpoint_sha256: offer.checkpoint_sha256, confirmed: true } : { ...offer, recovery_id, confirmed: true }
  const preview = fixture({ available: true, recovery: offer })
  assert.deepEqual(await preview.client.previewRelocationRecovery(id), { available: true, recovery: offer })
  assert.equal(preview.calls[0].options.method, 'GET'); assert.equal(preview.calls[0].options.body, undefined)
  assert.equal(preview.calls[0].url, 'http://localhost:3000/api/workspaces/relocation/jobs/' + id + '/recovery')
  const f = fixture({ intent_id: id, recovery_id, accepted: true }, 202)
  assert.deepEqual(await f.client.startRelocationRecovery(request), { intent_id: id, recovery_id, accepted: true })
  for (const bad of [{ ...request, confirmed: false }, { ...request, path: '/forged' }, { ...request, action: 'finish_commit' },
    { ...request, completion_sha256: 'A'.repeat(64) }, { ...request, checkpoint_sha256: 'A'.repeat(64) }, { ...request, recovery_id: recovery_id.toUpperCase() }]) {
    assert.throws(() => f.client.startRelocationRecovery(bad))
  }
  assert.equal(f.calls.length, 1)
  for (const bad of [{ intent_id: recovery_id, recovery_id, accepted: true }, { intent_id: id, recovery_id: id, accepted: true }, { intent_id: id, recovery_id, accepted: true, extra: true }]) {
    await assert.rejects(fixture(bad, 202).client.startRelocationRecovery(request), { kind: 'validation' })
  }
  await assert.rejects(fixture({ available: false, recovery: offer }).client.previewRelocationRecovery(id), { kind: 'validation' })
  await assert.rejects(fixture({ available: true, recovery: { ...offer, intent_id: recovery_id } }).client.previewRelocationRecovery(id), { kind: 'validation' })
  let attempts = 0
  const diagnostics = []
  const client = new WorkspaceClient(new HttpClient({ endpoint: 'http://localhost:3000/api', token: () => 'private-human', diagnose: event => diagnostics.push(event), fetch: async (_url, options) => {
    attempts++; assert.equal(new Headers(options.headers).get('Authorization'), 'Bearer private-human')
    assert.deepEqual(JSON.parse(options.body), request); throw new Error('lost reply')
  } }))
  await assert.rejects(client.startRelocationRecovery(request), { kind: 'unreachable' })
  assert.equal(attempts, 1); assert.ok(!JSON.stringify(diagnostics).includes('private-human')); assert.ok(!JSON.stringify(diagnostics).includes(recovery_id))
})

test('source restoration status preserves its outcome without claiming a target move', async () => {
  const job = { intent_id: id, state: 'needs_attention', stage: 'restoring', source: '/old', target: '/planned', outcome: 'source_restored' }
  assert.deepEqual(await fixture({ available: true, job }).client.relocationStatus(id), { available: true, job })
  await assert.rejects(fixture({ available: true, job: { ...job, outcome: 'moved' } }).client.relocationStatus(id), { kind: 'validation' })
})
