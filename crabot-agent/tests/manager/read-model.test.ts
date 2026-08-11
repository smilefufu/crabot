/**
 * task 读模型纯逻辑(P5 Task 3)—— `src/manager/read-model.ts`。
 *
 * 钉住的语义不变量:
 * ① 过滤:status 单值/数组、manager_key、time_range 三者可组合,且 total_items
 *    统计的是**过滤后**的总数;
 * ② time_range 边界 = base-protocol §5.7:`start` 闭(含)、`end` 开(不含);
 * ③ 排序:`updated_at desc`,同 updated_at 时按 `worker_id` 升序兜底 —— 与输入顺序无关;
 * ④ 分页越界返回空 items 而不报错;page/page_size 非法值归一,page_size 上限 100;
 * ⑤ 纯函数:不修改入参数组、items 是 `LedgerWorker`(不泄漏 managerKey);
 * ⑥ `buildWorkerDetail` 逐字段透传台账条目(含化身链),返回体只有 `worker`(§8.3)。
 */
import { describe, it, expect } from 'vitest'

import {
  filterAndPageWorkers,
  buildWorkerDetail,
  type LedgerWorkerEntry,
} from '../../src/manager/read-model.js'
import {
  type ManagerKey,
  type LedgerWorker,
  type TaskStatus,
} from '../../src/workers/harness/ledger-types.js'

const ALICE = `test::alice` as ManagerKey
const BOB = `test::bob` as ManagerKey
const GROUP = `telegram::g-1` as ManagerKey

function mkWorker(
  workerId: string,
  managerKey: ManagerKey,
  opts: {
    status?: TaskStatus
    createdAt?: string
    updatedAt?: string
  } = {}
): LedgerWorker {
  return {
    worker_id: workerId,
    manager_key: managerKey,
    task: {
      id: `task-${workerId}`,
      title: `title-${workerId}`,
      status: opts.status ?? 'running',
      created_at: opts.createdAt ?? '2026-07-01T00:00:00.000Z',
    },
    origin: {
      trigger_type: 'message',
    },
    report_to: { channel_id: 'telegram', session_id: 's-1' },
    incarnations: [],
    updated_at: opts.updatedAt ?? '2026-07-01T00:00:00.000Z',
  }
}

function entry(
  managerKey: ManagerKey,
  workerId: string,
  opts?: Parameters<typeof mkWorker>[2]
): LedgerWorkerEntry {
  return { managerKey, worker: mkWorker(workerId, managerKey, opts) }
}

describe('filterAndPageWorkers', () => {
  it('空输入返回空 items 且分页字段完整', () => {
    const result = filterAndPageWorkers([], {})
    expect(result.items).toEqual([])
    expect(result.pagination).toEqual({
      page: 1,
      page_size: 20,
      total_items: 0,
      total_pages: 0,
    })
  })

  it('items 是 LedgerWorker 本身,不泄漏 managerKey 包装', () => {
    const e = entry(ALICE, 'w-1')
    const result = filterAndPageWorkers([e], {})
    expect(result.items).toEqual([e.worker])
    expect(result.items[0]).not.toHaveProperty('managerKey')
    expect(result.items[0]).not.toHaveProperty('worker')
    expect(result.items[0]?.manager_key).toBe(ALICE)
  })

  it('不修改入参数组(纯函数)', () => {
    const all = [
      entry(ALICE, 'w-old', { updatedAt: '2026-07-01T00:00:00.000Z' }),
      entry(ALICE, 'w-new', { updatedAt: '2026-07-09T00:00:00.000Z' }),
    ]
    const snapshot = all.map((e) => e.worker.worker_id)
    filterAndPageWorkers(all, {})
    expect(all.map((e) => e.worker.worker_id)).toEqual(snapshot)
  })

  describe('status 过滤', () => {
    const all = [
      entry(ALICE, 'w-running', { status: 'running' }),
      entry(ALICE, 'w-queued', { status: 'queued' }),
      entry(ALICE, 'w-failed', { status: 'failed' }),
      entry(ALICE, 'w-completed', { status: 'completed' }),
    ]

    it('单值形态', () => {
      const result = filterAndPageWorkers(all, { status: 'queued' })
      expect(result.items.map((w) => w.worker_id)).toEqual(['w-queued'])
      expect(result.pagination.total_items).toBe(1)
    })

    it('数组形态', () => {
      const result = filterAndPageWorkers(all, { status: ['queued', 'failed'] })
      expect(result.items.map((w) => w.worker_id).sort()).toEqual(['w-failed', 'w-queued'])
      expect(result.pagination.total_items).toBe(2)
    })

    it('空数组表示"不匹配任何状态",返回空', () => {
      const result = filterAndPageWorkers(all, { status: [] })
      expect(result.items).toEqual([])
      expect(result.pagination.total_items).toBe(0)
    })

    it('不传 status 时全量返回', () => {
      expect(filterAndPageWorkers(all, {}).pagination.total_items).toBe(4)
    })
  })

  describe('manager_key 过滤', () => {
    const all = [
      entry(ALICE, 'w-a1'),
      entry(ALICE, 'w-a2'),
      entry(BOB, 'w-b1'),
      entry(GROUP, 'w-g1'),
    ]

    it('私聊对话对象', () => {
      const result = filterAndPageWorkers(all, { manager_key: ALICE })
      expect(result.items.map((w) => w.worker_id).sort()).toEqual(['w-a1', 'w-a2'])
    })

    it('群聊对话对象', () => {
      const result = filterAndPageWorkers(all, { manager_key: GROUP })
      expect(result.items.map((w) => w.worker_id)).toEqual(['w-g1'])
    })

    it('无匹配返回空而不报错', () => {
      const result = filterAndPageWorkers(all, {
        manager_key: `test::nobody` as ManagerKey,
      })
      expect(result.items).toEqual([])
      expect(result.pagination.total_items).toBe(0)
    })
  })

  describe('time_range 边界(base-protocol §5.7:start 闭、end 开;比较 task.created_at)', () => {
    const all = [
      entry(ALICE, 'w-before', { createdAt: '2026-07-01T23:59:59.999Z' }),
      entry(ALICE, 'w-on-start', { createdAt: '2026-07-02T00:00:00.000Z' }),
      entry(ALICE, 'w-inside', { createdAt: '2026-07-03T00:00:00.000Z' }),
      entry(ALICE, 'w-on-end', { createdAt: '2026-07-04T00:00:00.000Z' }),
      entry(ALICE, 'w-after', { createdAt: '2026-07-05T00:00:00.000Z' }),
    ]

    it('start 是闭区间:等于 start 的条目被包含', () => {
      const result = filterAndPageWorkers(all, {
        time_range: { start: '2026-07-02T00:00:00.000Z' },
      })
      expect(result.items.map((w) => w.worker_id).sort()).toEqual([
        'w-after',
        'w-inside',
        'w-on-end',
        'w-on-start',
      ])
    })

    it('end 是开区间:等于 end 的条目被排除', () => {
      const result = filterAndPageWorkers(all, {
        time_range: { end: '2026-07-04T00:00:00.000Z' },
      })
      expect(result.items.map((w) => w.worker_id).sort()).toEqual([
        'w-before',
        'w-inside',
        'w-on-start',
      ])
    })

    it('start + end = [start, end)', () => {
      const result = filterAndPageWorkers(all, {
        time_range: { start: '2026-07-02T00:00:00.000Z', end: '2026-07-04T00:00:00.000Z' },
      })
      expect(result.items.map((w) => w.worker_id).sort()).toEqual(['w-inside', 'w-on-start'])
    })

    it('过滤的是 task.created_at 而非 updated_at', () => {
      const only = [
        entry(ALICE, 'w-x', {
          createdAt: '2026-07-01T00:00:00.000Z',
          updatedAt: '2026-07-09T00:00:00.000Z',
        }),
      ]
      // 窗口只覆盖 updated_at,不覆盖 created_at → 不命中
      expect(
        filterAndPageWorkers(only, {
          time_range: { start: '2026-07-08T00:00:00.000Z' },
        }).items
      ).toEqual([])
      // 窗口覆盖 created_at → 命中
      expect(
        filterAndPageWorkers(only, {
          time_range: { start: '2026-07-01T00:00:00.000Z', end: '2026-07-02T00:00:00.000Z' },
        }).items.map((w) => w.worker_id)
      ).toEqual(['w-x'])
    })

    it('空的 time_range({} / 两端都缺)不过滤任何条目', () => {
      expect(filterAndPageWorkers(all, { time_range: {} }).pagination.total_items).toBe(5)
    })

    it('created_at 缺失的脏条目在 time_range 生效时被排除,不生效时保留', () => {
      const dirty = entry(ALICE, 'w-dirty')
      delete (dirty.worker.task as { created_at?: string }).created_at
      const input = [dirty, entry(ALICE, 'w-ok', { createdAt: '2026-07-03T00:00:00.000Z' })]

      expect(
        filterAndPageWorkers(input, {
          time_range: { start: '2026-07-01T00:00:00.000Z' },
        }).items.map((w) => w.worker_id)
      ).toEqual(['w-ok'])
      expect(filterAndPageWorkers(input, {}).pagination.total_items).toBe(2)
    })
  })

  describe('排序:updated_at desc,同值按 worker_id 升序', () => {
    it('按 updated_at 倒序', () => {
      const all = [
        entry(ALICE, 'w-mid', { updatedAt: '2026-07-05T00:00:00.000Z' }),
        entry(ALICE, 'w-new', { updatedAt: '2026-07-09T00:00:00.000Z' }),
        entry(ALICE, 'w-old', { updatedAt: '2026-07-01T00:00:00.000Z' }),
      ]
      expect(filterAndPageWorkers(all, {}).items.map((w) => w.worker_id)).toEqual([
        'w-new',
        'w-mid',
        'w-old',
      ])
    })

    it('同 updated_at 时次序确定,且与输入顺序无关', () => {
      const same = '2026-07-05T00:00:00.000Z'
      const forward = [
        entry(ALICE, 'w-a', { updatedAt: same }),
        entry(BOB, 'w-b', { updatedAt: same }),
        entry(ALICE, 'w-c', { updatedAt: same }),
      ]
      const reversed = [...forward].reverse()
      const expected = ['w-a', 'w-b', 'w-c']

      expect(filterAndPageWorkers(forward, {}).items.map((w) => w.worker_id)).toEqual(expected)
      expect(filterAndPageWorkers(reversed, {}).items.map((w) => w.worker_id)).toEqual(expected)
    })

    it('updated_at 缺失的脏条目排在最后,不影响其余次序', () => {
      const dirty = entry(ALICE, 'w-dirty')
      delete (dirty.worker as { updated_at?: string }).updated_at
      const all = [
        dirty,
        entry(ALICE, 'w-new', { updatedAt: '2026-07-09T00:00:00.000Z' }),
        entry(ALICE, 'w-old', { updatedAt: '2026-07-01T00:00:00.000Z' }),
      ]
      expect(filterAndPageWorkers(all, {}).items.map((w) => w.worker_id)).toEqual([
        'w-new',
        'w-old',
        'w-dirty',
      ])
    })
  })

  describe('分页', () => {
    // updated_at 递减 → 排序后即 w-1..w-5
    const all = [1, 2, 3, 4, 5].map((n) =>
      entry(ALICE, `w-${n}`, { updatedAt: `2026-07-0${9 - n}T00:00:00.000Z` })
    )

    it('首页', () => {
      const result = filterAndPageWorkers(all, { pagination: { page: 1, page_size: 2 } })
      expect(result.items.map((w) => w.worker_id)).toEqual(['w-1', 'w-2'])
      expect(result.pagination).toEqual({
        page: 1,
        page_size: 2,
        total_items: 5,
        total_pages: 3,
      })
    })

    it('末页(不足一页)', () => {
      const result = filterAndPageWorkers(all, { pagination: { page: 3, page_size: 2 } })
      expect(result.items.map((w) => w.worker_id)).toEqual(['w-5'])
      expect(result.pagination.total_pages).toBe(3)
    })

    it('越界页返回空数组而不报错,page 原样回显', () => {
      const result = filterAndPageWorkers(all, { pagination: { page: 99, page_size: 2 } })
      expect(result.items).toEqual([])
      expect(result.pagination).toEqual({
        page: 99,
        page_size: 2,
        total_items: 5,
        total_pages: 3,
      })
    })

    it('total_items 反映过滤后的总数,而非全量', () => {
      const mixed = [
        entry(ALICE, 'w-1', { status: 'running' }),
        entry(ALICE, 'w-2', { status: 'failed' }),
        entry(ALICE, 'w-3', { status: 'failed' }),
      ]
      const result = filterAndPageWorkers(mixed, {
        status: 'failed',
        pagination: { page: 1, page_size: 1 },
      })
      expect(result.pagination.total_items).toBe(2)
      expect(result.pagination.total_pages).toBe(2)
      expect(result.items).toHaveLength(1)
    })

    it('page_size 上限 100', () => {
      const result = filterAndPageWorkers(all, { pagination: { page: 1, page_size: 500 } })
      expect(result.pagination.page_size).toBe(100)
      expect(result.items).toHaveLength(5)
    })

    it('非法的 page / page_size 归一为默认值', () => {
      const zeroed = filterAndPageWorkers(all, {
        pagination: { page: 0, page_size: 0 },
      })
      expect(zeroed.pagination.page).toBe(1)
      expect(zeroed.pagination.page_size).toBe(20)
      expect(zeroed.items).toHaveLength(5)

      const negative = filterAndPageWorkers(all, {
        pagination: { page: -3, page_size: -1 },
      })
      expect(negative.pagination.page).toBe(1)
      expect(negative.pagination.page_size).toBe(20)
    })

    it('缺失 pagination 时用默认 page=1 / page_size=20', () => {
      const result = filterAndPageWorkers(all, {})
      expect(result.pagination.page).toBe(1)
      expect(result.pagination.page_size).toBe(20)
    })
  })

  it('三种过滤条件可组合', () => {
    const all = [
      entry(ALICE, 'w-hit', { status: 'failed', createdAt: '2026-07-03T00:00:00.000Z' }),
      entry(ALICE, 'w-status-miss', { status: 'running', createdAt: '2026-07-03T00:00:00.000Z' }),
      entry(BOB, 'w-dialog-miss', { status: 'failed', createdAt: '2026-07-03T00:00:00.000Z' }),
      entry(ALICE, 'w-time-miss', { status: 'failed', createdAt: '2026-07-09T00:00:00.000Z' }),
    ]
    const result = filterAndPageWorkers(all, {
      status: ['failed', 'cancelled'],
      manager_key: ALICE,
      time_range: { start: '2026-07-01T00:00:00.000Z', end: '2026-07-04T00:00:00.000Z' },
    })
    expect(result.items.map((w) => w.worker_id)).toEqual(['w-hit'])
  })
})

describe('buildWorkerDetail', () => {
  it('返回体只有 worker 一个字段(§8.3)，worker 内保留 owner manager_key', () => {
    const found = entry(ALICE, 'w-1')
    const detail = buildWorkerDetail(found)
    expect(Object.keys(detail)).toEqual(['worker'])
    expect(detail).not.toHaveProperty('manager_key')
    expect(detail).not.toHaveProperty('managerKey')
    expect(detail.worker.manager_key).toBe(ALICE)
  })

  it('台账条目逐字段透传(含全部可选字段与化身链)', () => {
    const worker: LedgerWorker = {
      worker_id: 'w-full',
      manager_key: ALICE,
      task: {
        id: 'task-1',
        title: '标题',
        status: 'completed',
        priority: 'high',
        goal: '目标',
        outcome: '结果',
        created_at: '2026-07-01T00:00:00.000Z',
        completed_at: '2026-07-02T00:00:00.000Z',
        error: 'boom',
      },
      origin: {
        spawned_by_episode: 'trace-1',
        creator_friend_id: 'friend-1',
        trigger_type: 'scheduled',
      },
      report_to: { channel_id: 'telegram', session_id: 's-1' },
      incarnations: [
        {
          seq: 1,
          impl: 'claude-code',
          state: 'exited',
          workspace: '/ws/w-full',
          session_ref: 'sess-1',
          tmux_session: 'crabot-w-full-1',
          started_at: '2026-07-01T00:00:00.000Z',
          ended_at: '2026-07-01T01:00:00.000Z',
          ended_reason: 'completed',
        },
        {
          seq: 2,
          impl: 'builtin',
          state: 'running',
          workspace: '/ws/w-full',
          session_ref: 'node-2',
          started_at: '2026-07-02T00:00:00.000Z',
          forked_from: 1,
        },
      ],
      updated_at: '2026-07-02T00:00:00.000Z',
    }

    const detail = buildWorkerDetail({ managerKey: ALICE, worker })
    expect(detail.worker).toEqual(worker)
    expect(detail.worker.incarnations).toHaveLength(2)
    expect(detail.worker.incarnations[1].forked_from).toBe(1)
  })
})
