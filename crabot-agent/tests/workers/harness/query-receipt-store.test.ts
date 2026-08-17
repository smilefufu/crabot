import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  QueryReceiptStore,
  type WorkerQueryReceipt,
} from '../../../src/workers/harness/query-receipt-store'
import type { ManagerKey } from '../../../src/workers/harness/ledger-types'

let root: string
const workerId = 'w-query-receipt'

function receipt(overrides: Partial<WorkerQueryReceipt> = {}): WorkerQueryReceipt {
  return {
    query_id: 'query-1',
    worker_id: workerId,
    manager_key: 'wechat::session-1' as ManagerKey,
    question_preview: '现在进行到哪一步？',
    created_at: '2026-08-17T01:00:00.000Z',
    updated_at: '2026-08-17T01:00:00.000Z',
    establishment_deadline_at: '2026-08-17T01:00:30.000Z',
    state: 'starting',
    manager_notification: { status: 'not_required' },
    ...overrides,
  }
}

beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'query-receipt-store-'))
})

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

describe('QueryReceiptStore', () => {
  it('starting → running → completed，并把 query 终态通知保持到 consumed', async () => {
    const store = new QueryReceiptStore(root)
    await store.create(receipt())

    const running = await store.markRunning(workerId, 'query-1', 2, '2026-08-17T01:00:01.000Z')
    expect(running).toMatchObject({ state: 'running', fork_seq: 2 })

    const completed = await store.settleCompleted(workerId, 'query-1', '2026-08-17T01:00:02.000Z')
    expect(completed).toMatchObject({
      state: 'completed',
      manager_notification: { status: 'pending' },
    })

    const consumed = await store.markNotificationConsumed(workerId, 'query-1', '2026-08-17T01:00:03.000Z')
    expect(consumed.manager_notification.status).toBe('consumed')
  })

  it('建立失败保留 query_id 与准确失败阶段，且不能再转 running', async () => {
    const store = new QueryReceiptStore(root)
    await store.create(receipt())

    const failed = await store.settleFailed(workerId, 'query-1', {
      reason_code: 'fork_capability_unavailable',
      reason: 'codex app-server fork unavailable',
      phase: 'establishment',
      certainty: 'not_started',
    }, '2026-08-17T01:00:01.000Z')

    expect(failed).toMatchObject({
      query_id: 'query-1',
      state: 'failed',
      manager_notification: { status: 'pending' },
    })
    await expect(store.markRunning(workerId, 'query-1', 2, '2026-08-17T01:00:02.000Z'))
      .rejects.toThrow('terminal')
  })

  it('拒绝 running 之前完成，也拒绝 completed 与 failed 互相翻转', async () => {
    const store = new QueryReceiptStore(root)
    await store.create(receipt())

    await expect(store.settleCompleted(workerId, 'query-1', '2026-08-17T01:00:01.000Z'))
      .rejects.toThrow('running')

    await store.markRunning(workerId, 'query-1', 2, '2026-08-17T01:00:02.000Z')
    await store.settleCompleted(workerId, 'query-1', '2026-08-17T01:00:03.000Z')
    await expect(store.settleFailed(workerId, 'query-1', {
      reason_code: 'query_execution_failed',
      reason: 'late error',
      phase: 'execution',
      certainty: 'failed',
    }, '2026-08-17T01:00:04.000Z')).rejects.toThrow('terminal')
  })

  it('只持久化 200 字符问题预览', async () => {
    const store = new QueryReceiptStore(root)
    const question = `question-${'y'.repeat(400)}`
    await store.create(receipt({ question_preview: question }))

    const raw = await fs.readFile(join(root, workerId, 'query-receipts.json'), 'utf8')
    expect(raw).not.toContain(question)
    expect((await store.get(workerId, 'query-1'))?.question_preview).toBe(question.slice(0, 200))
  })
})
