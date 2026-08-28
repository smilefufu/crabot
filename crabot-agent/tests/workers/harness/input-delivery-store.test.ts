import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  InputDeliveryStore,
  type WorkerInputDeliveryReceipt,
} from '../../../src/workers/harness/input-delivery-store'
import type { ManagerKey } from '../../../src/workers/harness/ledger-types'

let root: string
let nowMs: number
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
  nowMs = Date.parse('2026-08-17T00:00:00.000Z')
  vi.spyOn(Date, 'now').mockImplementation(() => nowMs)
})

afterEach(async () => {
  vi.restoreAllMocks()
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
      transitioned: true,
      receipt: {
        state: 'failed',
        manager_notification: { status: 'pending' },
      },
    })
    const lateDelivered = await store.settleDelivered(workerId, 'delivery-1', '2026-08-17T01:02:00.000Z')
    expect(lateDelivered).toEqual({ receipt: failed.receipt, transitioned: false })
  })

  it('同步工具读取失败终态时消费通知，不把 pending 暴露给 Manager', async () => {
    const store = new InputDeliveryStore(root)
    await store.create(receipt())

    await store.settleFailed(workerId, 'delivery-1', {
      reason_code: 'delivery_attempt_failed',
      reason: 'tmux command failed',
      certainty: 'unknown',
    }, '2026-08-17T01:00:01.000Z')

    const terminal = await store.readForToolResult(workerId, 'delivery-1', '2026-08-17T01:00:02.000Z')
    expect(terminal.manager_notification).toEqual({
      status: 'consumed',
      consumed_at: '2026-08-17T01:00:02.000Z',
    })

    const consumed = await store.markNotificationConsumed(workerId, 'delivery-1', '2026-08-17T01:00:03.000Z')
    expect(consumed).toEqual(terminal)
  })

  it('同步 delivered 在工具读取终态时不制造重复通知', async () => {
    const store = new InputDeliveryStore(root)
    await store.create(receipt())
    const settled = await store.settleDelivered(workerId, 'delivery-1', '2026-08-17T01:00:01.000Z')
    expect(settled).toMatchObject({ transitioned: true, receipt: { state: 'delivered' } })
    const path = join(root, workerId, 'input-deliveries.json')
    const before = await fs.stat(path)

    const delivered = await store.readForToolResult(workerId, 'delivery-1', '2026-08-17T01:00:02.000Z')
    expect(delivered.manager_notification.status).toBe('not_required')
    expect((await fs.stat(path)).ino).toBe(before.ino)
  })

  it('deadline 后迟到的 accepted 结算 unknown，后续 accepted 不能翻转终态', async () => {
    const store = new InputDeliveryStore(root)
    await store.create(receipt())
    nowMs = Date.parse('2026-08-17T01:06:00.000Z')

    const lateAccepted = await store.settleDelivered(workerId, 'delivery-1', '2026-08-17T01:06:00.000Z')
    expect(lateAccepted).toMatchObject({
      transitioned: true,
      receipt: {
        state: 'failed',
        failure: {
          reason_code: 'submission_unconfirmed_timeout',
          certainty: 'unknown',
        },
        manager_notification: { status: 'pending' },
      },
    })

    const duplicateAccepted = await store.settleDelivered(workerId, 'delivery-1', '2026-08-17T01:06:01.000Z')
    expect(duplicateAccepted).toEqual({ receipt: lateAccepted.receipt, transitioned: false })
    expect(await store.get(workerId, 'delivery-1')).toEqual(lateAccepted.receipt)
  })
})
