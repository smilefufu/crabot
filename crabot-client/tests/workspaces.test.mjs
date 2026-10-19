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
