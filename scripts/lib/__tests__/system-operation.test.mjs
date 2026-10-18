import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { SystemRegistry } from '../system-registry.mjs'
import { SystemOperationStore } from '../system-operation.mjs'
import { planSystemBatch } from '../system-batch.mjs'

const options = { skip: process.platform === 'win32' }
async function fixture(t) {
  const parent = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'crabot-system-job-')))
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }))
  const registry = new SystemRegistry({ directory: path.join(parent, 'system'), ownerUid: process.getuid(),
    accountLookup: user => ({ user, uid: user === 'alice' ? 1001 : 1002, gid: 1001, home: '/home/' + user }) })
  await registry.update(() => [], { create: true })
  await registry.register('alice'); await registry.register('bob')
  const store = new SystemOperationStore(registry)
  const plan = await planSystemBatch('start', registry.read(), () => ({ state: 'stopped', generation: null }))
  return { store, registry, plan }
}
test('batch intent is private and fixed; an active job excludes other deployment actions', options, async t => {
  const { store, plan } = await fixture(t)
  await store.prepare(plan)
  assert.equal(fs.statSync(store.file(plan.id)).mode & 0o777, 0o600)
  assert.equal(store.maintenance().phase, 'prepared')
  await assert.rejects(store.prepare({ ...plan, id: '11111111-1111-1111-1111-111111111111' }), { code: 'CRABOT_SYSTEM_BUSY' })
  assert.throws(() => store.file('../outside'))
})
test('completion is durable and cannot be dispatched again', options, async t => {
  const { store, plan } = await fixture(t)
  await store.prepare(plan)
  let calls = 0
  const result = await store.run(plan.id, { apply: async () => { calls++; return { state: 'started' } } })
  assert.equal(calls, 2); assert.equal(result.exit_code, 0); assert.equal(store.maintenance().phase, 'completed')
  assert.equal(store.read(store.file(plan.id), true).progress.results.length, 2)
  await assert.rejects(store.run(plan.id, { apply: () => assert.fail('must never replay') }), { code: 'CRABOT_SYSTEM_OPERATION_INTERRUPTED' })
  store.assertIdle()
})
test('coordinator failure before dispatch retains protected running intent and refuses replay', options, async t => {
  const { store, plan } = await fixture(t)
  await store.prepare(plan)
  const original = store.write.bind(store)
  let writes = 0
  store.write = (...args) => { if (++writes === 4) throw new Error('disk full before dispatch'); return original(...args) }
  await assert.rejects(store.run(plan.id, { apply: () => assert.fail('must not dispatch') }), /disk full/)
  store.write = original
  assert.equal(store.read(store.file(plan.id), true).phase, 'running')
  await assert.rejects(store.run(plan.id, { apply: () => assert.fail() }), { code: 'CRABOT_SYSTEM_OPERATION_INTERRUPTED' })
  assert.throws(() => store.assertIdle(), { code: 'CRABOT_SYSTEM_BUSY' })
})
test('unknown user keeps its protection even when independently safe users finish', options, async t => {
  const { store, plan } = await fixture(t)
  await store.prepare(plan)
  const result = await store.run(plan.id, { apply: entry => entry.user === 'alice'
    ? Promise.reject(Object.assign(new Error('UID helper lost'), { code: 'CRABOT_SYSTEM_USER_UNKNOWN' })) : { state: 'started' } })
  assert.equal(result.exit_code, 1); assert.deepEqual(store.maintenance().unsettled, [1001])
  assert.deepEqual(result.results.map(row => row.state), ['unknown', 'started'])
  assert.throws(() => store.assertIdle(), { code: 'CRABOT_SYSTEM_BUSY' })
})
test('changed administrator binding after preview is rejected before a job is created', options, async t => {
  const { store, registry, plan } = await fixture(t)
  await registry.update(entries => entries.map(entry => ({ ...entry, autostart: true })))
  await assert.rejects(store.prepare(plan), { code: 'CRABOT_SYSTEM_INSTANCE_CHANGED' })
  assert.equal(store.maintenance(), null)
})
