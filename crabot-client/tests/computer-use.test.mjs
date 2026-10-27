import test from 'node:test'
import assert from 'node:assert/strict'
import { ComputerUseClient, ComputerUseSetupStatusSchema, HttpClient } from '../dist/index.js'

const status = { enabled: true, standard: true, host: { platform: 'darwin', hostname: 'fixture-host', session: 'active' },
  permissions: { accessibility: 'granted', screen_recording: 'missing' }, capture: { status: 'unverified' }, runtime: { state: 'uninitialized' } }
test('computer-use schema rejects malformed permission/runtime facts and preserves optional checks', () => {
  assert.equal(ComputerUseSetupStatusSchema.safeParse({ ...status, permissions: {} }).success, false)
  assert.equal(ComputerUseSetupStatusSchema.safeParse({ ...status, runtime: { state: 'connected-means-granted' } }).success, false)
  const value = ComputerUseSetupStatusSchema.parse({ ...status, runtime: { state: 'quarantined', checks: [{ name: 'fixture', status: 'skip' }] } })
  assert.equal(value.runtime.state, 'quarantined')
  assert.equal(value.capture.status, 'unverified')
})
test('status is read-only; only explicit actions POST and cancellation keeps the exact setup ID', async () => {
  const calls = []
  const client = new ComputerUseClient(new HttpClient({ endpoint: 'http://127.0.0.1:3000/api', fetch: async (url, options) => {
    calls.push({ url, options }); return new Response(JSON.stringify(status))
  } }))
  assert.equal(calls.length, 0)
  await client.status()
  assert.equal(calls.length, 1); assert.equal(calls[0].options.method, 'GET'); assert.equal(calls[0].options.body, undefined)
  await client.start(); await client.reveal(); await client.cancel('exact-operation', { keepalive: true })
  assert.deepEqual(calls.slice(1).map(call => [call.options.method, JSON.parse(call.options.body)]), [
    ['POST', { action: 'start' }], ['POST', { action: 'reveal_app' }], ['DELETE', { setup_id: 'exact-operation' }],
  ])
  assert.equal(calls[3].options.keepalive, true)
  assert.throws(() => client.cancel(''))
  assert.equal(calls.length, 4)
})
