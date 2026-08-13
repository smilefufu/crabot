/**
 * P6-A §3.4/§11.8-12：delivery journal 的 crash-recoverable 事务语义。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { ChatDeliveryJournalStore } from './chat-delivery-journal.js'

describe('ChatDeliveryJournalStore', () => {
  let dir: string
  let store: ChatDeliveryJournalStore

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'crabot-delivery-journal-'))
    store = new ChatDeliveryJournalStore(dir)
  })

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('prepared → committing → committed 状态机 + 幂等读', async () => {
    await store.prepare({
      delivery_id: 'd-1',
      request_ids: ['req-1'],
      payload_sha256: 'a'.repeat(64),
      session_id: 'admin-chat',
      planned_media: [],
      finalized_content: { type: 'text', text: 'ok' },
    })
    await store.transition('d-1', 'committing')
    await store.transition('d-1', 'committed', { platform_message_id: 'msg-1', sent_at: '2026-08-01T00:00:00.000Z' })
    const record = await store.read('d-1')
    expect(record?.state).toBe('committed')
    expect(record?.platform_message_id).toBe('msg-1')
    // committed 不进 pending 列表
    expect(await store.pendingJournals()).toEqual([])
  })

  it('pendingJournals 只含 prepared/committing（重启 reconcile 对象）', async () => {
    await store.prepare({ delivery_id: 'd-p', request_ids: [], payload_sha256: 'b'.repeat(64), session_id: 'admin-chat', planned_media: [], finalized_content: { type: 'text', text: 'p' } })
    await store.prepare({ delivery_id: 'd-c', request_ids: [], payload_sha256: 'c'.repeat(64), session_id: 'admin-chat', planned_media: [], finalized_content: { type: 'text', text: 'c' } })
    await store.transition('d-c', 'committing')
    await store.prepare({ delivery_id: 'd-done', request_ids: [], payload_sha256: 'd'.repeat(64), session_id: 'admin-chat', planned_media: [], finalized_content: { type: 'text', text: 'x' } })
    await store.transition('d-done', 'committed', { platform_message_id: 'm', sent_at: '2026-08-01T00:00:00.000Z' })
    const pending = await store.pendingJournals()
    expect(pending.map((r) => r.delivery_id).sort()).toEqual(['d-c', 'd-p'])
  })

  it('rolled_back 不再 pending', async () => {
    await store.prepare({ delivery_id: 'd-rb', request_ids: [], payload_sha256: 'e'.repeat(64), session_id: 'admin-chat', planned_media: [], finalized_content: { type: 'text', text: 'x' } })
    await store.transition('d-rb', 'committing')
    await store.transition('d-rb', 'rolled_back')
    expect((await store.pendingJournals()).map((r) => r.delivery_id)).toEqual([])
  })

  it('withMutex 串行化同 delivery 的并发进入', async () => {
    const order: string[] = []
    await Promise.all([
      store.withMutex('d-m', async () => { order.push('a-in'); await new Promise((r) => setTimeout(r, 30)); order.push('a-out') }),
      store.withMutex('d-m', async () => { order.push('b-in'); await new Promise((r) => setTimeout(r, 5)); order.push('b-out') }),
    ])
    expect(order).toEqual(['a-in', 'a-out', 'b-in', 'b-out'])
  })
})
