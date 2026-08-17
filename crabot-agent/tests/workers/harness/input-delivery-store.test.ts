import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  InputDeliveryStore,
  type WorkerInputDeliveryReceipt,
} from '../../../src/workers/harness/input-delivery-store'
import type { ManagerKey } from '../../../src/workers/harness/ledger-types'

let root: string
const workerId = 'w-input-receipt'
const managerKey = 'wechat::session-1' as ManagerKey

function receipt(overrides: Partial<WorkerInputDeliveryReceipt> = {}): WorkerInputDeliveryReceipt {
  return {
    delivery_id: 'delivery-1',
    worker_id: workerId,
    manager_key: managerKey,
    raw: false,
    text_preview: '继续处理昨天的任务',
    created_at: '2026-08-17T01:00:00.000Z',
    updated_at: '2026-08-17T01:00:00.000Z',
    deadline_at: '2026-08-17T01:05:00.000Z',
    state: 'pending',
    phase: 'queued',
    manager_notification: { status: 'not_required' },
    ...overrides,
  }
}

beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'input-delivery-store-'))
})

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

describe('InputDeliveryStore', () => {
  it('原子保存 receipt，正文不落盘，preview 最长 200 字符', async () => {
    const store = new InputDeliveryStore(root)
    const fullText = `secret-full-body-${'x'.repeat(400)}`
    const created = await store.create({
      ...receipt(),
      text_preview: fullText,
    })

    expect(created.text_preview).toHaveLength(200)
    const raw = await fs.readFile(join(root, workerId, 'input-deliveries.json'), 'utf8')
    expect(raw).not.toContain(fullText)
    expect((await store.get(workerId, created.delivery_id))?.text_preview).toBe(fullText.slice(0, 200))
  })

  it('pending 只允许结算到一个终态，失败总是挂起 Manager 通知', async () => {
    const store = new InputDeliveryStore(root)
    await store.create(receipt())

    const failed = await store.settleFailed(workerId, 'delivery-1', {
      reason_code: 'delivery_attempt_failed',
      reason: 'tmux command failed',
      certainty: 'unknown',
    }, '2026-08-17T01:01:00.000Z')

    expect(failed).toMatchObject({
      state: 'failed',
      manager_notification: { status: 'pending' },
    })
    await expect(store.settleDelivered(workerId, 'delivery-1', '2026-08-17T01:02:00.000Z'))
      .rejects.toThrow('terminal')
  })

  it('工具返回 pending 前原子挂通知；随后 delivered 保留通知责任直到 consumed', async () => {
    const store = new InputDeliveryStore(root)
    await store.create(receipt())

    const pending = await store.readForToolResult(workerId, 'delivery-1', '2026-08-17T01:00:01.000Z')
    expect(pending.manager_notification.status).toBe('pending')

    const delivered = await store.settleDelivered(workerId, 'delivery-1', '2026-08-17T01:00:02.000Z')
    expect(delivered.manager_notification.status).toBe('pending')

    const consumed = await store.markNotificationConsumed(workerId, 'delivery-1', '2026-08-17T01:00:03.000Z')
    expect(consumed.manager_notification).toEqual({
      status: 'consumed',
      consumed_at: '2026-08-17T01:00:03.000Z',
    })
  })

  it('同步 delivered 在工具读取终态时不制造重复通知', async () => {
    const store = new InputDeliveryStore(root)
    await store.create(receipt())
    await store.settleDelivered(workerId, 'delivery-1', '2026-08-17T01:00:01.000Z')
    const path = join(root, workerId, 'input-deliveries.json')
    const before = await fs.stat(path)

    const delivered = await store.readForToolResult(workerId, 'delivery-1', '2026-08-17T01:00:02.000Z')
    expect(delivered.manager_notification.status).toBe('not_required')
    expect((await fs.stat(path)).ino).toBe(before.ino)
  })
})
