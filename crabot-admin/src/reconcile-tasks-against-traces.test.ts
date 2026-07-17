import { describe, it, expect } from 'vitest'
import { reconcileTasksAgainstTraces, type TraceIndexLite } from './reconcile-tasks-against-traces.js'
import type { Task, TaskStatus } from './types.js'
import type { TaskId, ModuleId, SessionId, FriendId } from 'crabot-shared'

const FIXED_NOW = new Date('2026-06-09T20:00:00.000Z')

function makeTask(overrides: { id: string; status: TaskStatus; updated_at?: string; title?: string }): Task {
  return {
    id: overrides.id as TaskId,
    title: overrides.title ?? 'test task',
    priority: 'normal',
    status: overrides.status,
    source: {
      origin: 'human',
      channel_id: 'telegram-001' as ModuleId,
      session_id: 'sess-A' as SessionId,
      friend_id: 'friend-A' as FriendId,
      trigger_type: 'message',
    },
    created_at: '2026-06-09T18:00:00.000Z',
    updated_at: overrides.updated_at ?? '2026-06-09T18:00:00.000Z',
    messages: [],
    tags: [],
  } as Task
}

function mockFetchTraces(map: Record<string, TraceIndexLite[]>) {
  return async (taskId: string) => map[taskId] ?? []
}

describe('reconcileTasksAgainstTraces', () => {
  it('task=waiting_human + 所有 trace=completed → 修成 completed', async () => {
    const tasks = [makeTask({ id: 't-1', status: 'waiting_human', updated_at: '2026-06-09T18:00:00.000Z' })]
    const patches = await reconcileTasksAgainstTraces({
      tasks,
      fetchTracesByTaskId: mockFetchTraces({
        't-1': [
          { trace_id: 'tr-1', status: 'completed' },
          { trace_id: 'tr-2', status: 'completed' },
        ],
      }),
      now: FIXED_NOW,
    })
    expect(patches).toHaveLength(1)
    expect(patches[0].taskId).toBe('t-1')
    expect(patches[0].oldStatus).toBe('waiting_human')
    expect(patches[0].newStatus).toBe('completed')
  })

  it('task=executing + 最后 worker=failed → 修成 failed', async () => {
    const tasks = [makeTask({ id: 't-2', status: 'executing', updated_at: '2026-06-09T18:00:00.000Z' })]
    const patches = await reconcileTasksAgainstTraces({
      tasks,
      fetchTracesByTaskId: mockFetchTraces({
        't-2': [
          { trace_id: 'tr-1', status: 'completed' },
          { trace_id: 'tr-2', status: 'failed' },
        ],
      }),
      now: FIXED_NOW,
    })
    expect(patches).toHaveLength(1)
    expect(patches[0].newStatus).toBe('failed')
  })

  it('最后启动的 worker completed 时忽略旧 worker failed', async () => {
    const tasks = [makeTask({ id: 't-latest-completed', status: 'executing', updated_at: '2026-06-09T18:00:00.000Z' })]
    const patches = await reconcileTasksAgainstTraces({
      tasks,
      fetchTracesByTaskId: mockFetchTraces({
        't-latest-completed': [
          { trace_id: 'worker-old', status: 'failed' },
          { trace_id: 'worker-new', status: 'completed' },
        ],
      }),
      now: FIXED_NOW,
    })

    expect(patches).toHaveLength(1)
    expect(patches[0].newStatus).toBe('completed')
  })

  it('任一 trace 仍 running → 不修', async () => {
    const tasks = [makeTask({ id: 't-3', status: 'waiting_human', updated_at: '2026-06-09T18:00:00.000Z' })]
    const patches = await reconcileTasksAgainstTraces({
      tasks,
      fetchTracesByTaskId: mockFetchTraces({
        't-3': [
          { trace_id: 'tr-1', status: 'completed' },
          { trace_id: 'tr-2', status: 'running' },
        ],
      }),
      now: FIXED_NOW,
    })
    expect(patches).toHaveLength(0)
  })

  it('早期 worker running 且后续有超过 100 条终态 worker 时不收口', async () => {
    const tasks = [makeTask({ id: 't-running-oldest', status: 'executing', updated_at: '2026-06-09T18:00:00.000Z' })]
    const terminalWorkers = Array.from({ length: 101 }, (_, index) => ({
      trace_id: `worker-${index}`,
      status: 'completed' as const,
    }))
    const patches = await reconcileTasksAgainstTraces({
      tasks,
      fetchTracesByTaskId: mockFetchTraces({
        't-running-oldest': [
          { trace_id: 'worker-running', status: 'running' },
          ...terminalWorkers,
        ],
      }),
      now: FIXED_NOW,
    })

    expect(patches).toHaveLength(0)
  })

  it('task 距上次更新 < minStaleAgeMs → 跳过（防误判刚 spawn）', async () => {
    const recentTask = makeTask({
      id: 't-4',
      status: 'executing',
      updated_at: new Date(FIXED_NOW.getTime() - 30_000).toISOString(), // 30s 前
    })
    const patches = await reconcileTasksAgainstTraces({
      tasks: [recentTask],
      fetchTracesByTaskId: mockFetchTraces({
        't-4': [{ trace_id: 'tr-1', status: 'completed' }],
      }),
      now: FIXED_NOW,
      minStaleAgeMs: 60_000,
    })
    expect(patches).toHaveLength(0)
  })

  it('task 无关联 trace → 跳过（留给其他清扫路径）', async () => {
    const tasks = [makeTask({ id: 't-5', status: 'pending', updated_at: '2026-06-09T18:00:00.000Z' })]
    const patches = await reconcileTasksAgainstTraces({
      tasks,
      fetchTracesByTaskId: mockFetchTraces({ 't-5': [] }),
      now: FIXED_NOW,
    })
    expect(patches).toHaveLength(0)
  })

  it('task 已终态 → 不对账（completed / failed / cancelled）', async () => {
    const tasks = [
      makeTask({ id: 't-6', status: 'completed', updated_at: '2026-06-09T18:00:00.000Z' }),
      makeTask({ id: 't-7', status: 'failed', updated_at: '2026-06-09T18:00:00.000Z' }),
      makeTask({ id: 't-8', status: 'cancelled', updated_at: '2026-06-09T18:00:00.000Z' }),
    ]
    const patches = await reconcileTasksAgainstTraces({
      tasks,
      fetchTracesByTaskId: mockFetchTraces({
        't-6': [{ trace_id: 'tr-1', status: 'completed' }],
        't-7': [{ trace_id: 'tr-2', status: 'failed' }],
        't-8': [{ trace_id: 'tr-3', status: 'completed' }],
      }),
      now: FIXED_NOW,
    })
    expect(patches).toHaveLength(0)
  })

  it('fetchTracesByTaskId 抛错 → 跳过该 task（下轮重试）', async () => {
    const tasks = [makeTask({ id: 't-9', status: 'waiting_human', updated_at: '2026-06-09T18:00:00.000Z' })]
    const patches = await reconcileTasksAgainstTraces({
      tasks,
      fetchTracesByTaskId: async () => {
        throw new Error('agent RPC failed')
      },
      now: FIXED_NOW,
    })
    expect(patches).toHaveLength(0)
  })

  it('混合场景：多个 task 各自不同状态，正确分桶', async () => {
    const tasks = [
      makeTask({ id: 't-drift-completed', status: 'waiting_human', updated_at: '2026-06-09T18:00:00.000Z' }),
      makeTask({ id: 't-drift-failed', status: 'executing', updated_at: '2026-06-09T18:00:00.000Z' }),
      makeTask({ id: 't-still-running', status: 'executing', updated_at: '2026-06-09T18:00:00.000Z' }),
      makeTask({ id: 't-too-fresh', status: 'executing', updated_at: new Date(FIXED_NOW.getTime() - 10_000).toISOString() }),
      makeTask({ id: 't-already-done', status: 'completed', updated_at: '2026-06-09T18:00:00.000Z' }),
    ]
    const patches = await reconcileTasksAgainstTraces({
      tasks,
      fetchTracesByTaskId: mockFetchTraces({
        't-drift-completed': [{ trace_id: 'tr-a', status: 'completed' }],
        't-drift-failed': [{ trace_id: 'tr-b', status: 'failed' }],
        't-still-running': [{ trace_id: 'tr-c', status: 'running' }],
        't-too-fresh': [{ trace_id: 'tr-d', status: 'completed' }],
        't-already-done': [{ trace_id: 'tr-e', status: 'completed' }],
      }),
      now: FIXED_NOW,
      minStaleAgeMs: 60_000,
    })
    expect(patches).toHaveLength(2)
    const byId = new Map(patches.map(p => [p.taskId, p.newStatus]))
    expect(byId.get('t-drift-completed')).toBe('completed')
    expect(byId.get('t-drift-failed')).toBe('failed')
  })
})
