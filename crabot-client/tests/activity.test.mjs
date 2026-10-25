import test from 'node:test'
import assert from 'node:assert/strict'
import { ActivityClient, HttpClient } from '../dist/index.js'

function fixture({ status = 'idle', inbound = [], worker = {}, managers, transform = value => value, fetchError = false } = {}) {
  const calls = []
  const client = new ActivityClient(new HttpClient({ endpoint: 'http://127.0.0.1:3000/api', fetch: async (url, options) => {
    calls.push({ url, options })
    if (fetchError) throw new Error('secret body must not escape')
    const value = url.includes('/workers?') ? { total_running: 0, total_queued: 0, total_active: 50, total_attention: 25, ...worker }
      : url.endsWith('/inbound-status') ? { manager_key: 'fixture', snapshot_at: new Date().toISOString(), items: inbound }
      : managers ?? { items: [{ manager_key: 'fixture', execution_status: status, active_worker_count: 50, worker_attention_count: 25 }],
        pagination: { page: 1, page_size: 100, total_items: 1, total_pages: 1 } }
    return new Response(JSON.stringify(transform(value, url)))
  } }))
  return { client, calls }
}

test('nonterminal history, candidates and attention do not independently imply current execution', async () => {
  const { client, calls } = fixture()
  assert.equal(await client.read(), 'idle')
  assert.equal(calls.length, 4)
  assert.ok(calls.every(call => call.options.method === 'GET' && call.options.body === undefined))
})
test('current Manager execution, Workers and pending inbound work prevent an idle result', async () => {
  for (const options of [{ status: 'running' }, { worker: { total_running: 1 } }, { worker: { total_queued: 1 } },
    { inbound: [{ platform_message_id: 'pending', status: 'queued' }] }, { inbound: [{ platform_message_id: 'pending', status: 'processing' }] }]) {
    assert.equal(await fixture(options).client.read(), 'active')
  }
})
test('missing facts, unknown execution, read failure and cancellation are never presented as idle', async () => {
  for (const options of [{ status: 'unknown' }, { status: undefined, transform: value => { delete value.items?.[0]?.execution_status; return value } },
    { worker: { total_running: undefined } }, { fetchError: true }]) assert.equal(await fixture(options).client.read(), 'unknown')
  const { client, calls } = fixture(), controller = new AbortController(); controller.abort()
  assert.equal(await client.read({ signal: controller.signal }), 'unknown'); assert.equal(calls.length, 0)
})
test('pagination mismatch, duplicate manager keys and wrong inbound identity fail closed', async () => {
  for (const transform of [value => { if (value.pagination) value.pagination.total_items = 2; return value },
    value => { if (value.pagination) { value.items.push(value.items[0]); value.pagination.total_items = 2 }; return value },
    (value, url) => { if (url.endsWith('/inbound-status')) value.manager_key = 'other'; return value }]) {
    assert.equal(await fixture({ transform }).client.read(), 'unknown')
  }
})
test('an empty confirmed manager registry is valid; a final Worker reread detects intervening work', async () => {
  const empty = { items: [], pagination: { page: 1, page_size: 100, total_items: 0, total_pages: 0 } }
  assert.equal(await fixture({ managers: empty }).client.read(), 'idle')
  let reads = 0
  assert.equal(await fixture({ managers: empty, transform: (value, url) => {
    if (url.includes('/workers?') && ++reads === 2) value.total_running = 1
    return value
  } }).client.read(), 'active')
})
