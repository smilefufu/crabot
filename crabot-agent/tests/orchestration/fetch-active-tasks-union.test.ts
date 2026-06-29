import { afterEach, describe, it, expect, vi } from 'vitest'
import { ContextAssembler } from '../../src/orchestration/context-assembler.js'
import type { TaskSummary } from '../../src/types.js'

function buildAssembler(opts: {
  adminItems: Array<{ id: string; title: string; status: string; source?: { trigger_type?: string; channel_id?: string; session_id?: string } }>
  recentItems?: Array<{ id: string; title: string; status: string; completed_at?: string; error?: string; source?: { trigger_type?: string; channel_id?: string; session_id?: string } }>
  agentInflight?: Array<{ task_id: string; title: string; trigger_type: 'message' | 'scheduled'; source_channel_id?: string; source_session_id?: string }>
}) {
  const rpcClient = {
    call: vi.fn().mockImplementation((_port, method, args) => {
      if (method !== 'list_tasks') return Promise.reject(new Error(`unexpected call: ${String(method)}`))
      const statuses = args?.filter?.status ?? []
      const items = statuses.includes('completed') || statuses.includes('failed')
        ? opts.recentItems ?? []
        : opts.adminItems
      return Promise.resolve({
        items: items.map(t => ({
          id: t.id,
          title: t.title,
          status: t.status,
          type: 'task',
          priority: 'normal',
          source: t.source ?? { trigger_type: 'message', channel_id: 'ch', session_id: 'sess' },
          messages: [],
          completed_at: 'completed_at' in t ? t.completed_at : undefined,
          error: 'error' in t ? t.error : undefined,
        })),
      })
    }),
  }
  const assembler = new (ContextAssembler as never)({
    rpcClient,
    moduleId: 'test-agent',
    config: {
      front_context_recent_messages_window_hours: 6,
      front_context_recent_messages_max_cap: 50,
      front_context_short_term_memory_window_hours: 12,
      front_context_short_term_memory_max_cap: 30,
      worker_recent_messages_window_hours: 4,
      worker_recent_messages_max_cap: 50,
      worker_short_term_memory_window_hours: 12,
      worker_short_term_memory_max_cap: 30,
      worker_long_term_memory_limit: 20,
      front_agent_timeout: 30,
      session_state_ttl: 300,
      worker_config_refresh_interval: 60,
      front_agent_queue_max_length: 10,
      front_agent_queue_timeout: 60,
    },
    getAdminPort: vi.fn().mockResolvedValue(19001),
    getMemoryPort: vi.fn().mockResolvedValue(19002),
    getInflightTriggerTasks: vi.fn().mockReturnValue(opts.agentInflight ?? []),
    getLiveSnapshot: vi.fn(),
  } as never)
  return assembler
}

describe('fetchActiveTasks union agent in-flight', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('TaskSummary can represent a recent terminal supplement candidate', () => {
    const candidate: TaskSummary = {
      task_id: 'task-done' as never,
      title: 'done task',
      status: 'completed',
      priority: 'normal',
      candidate_kind: 'recent_terminal',
      completed_at: '2026-06-29T10:00:00.000Z',
      error: undefined,
      source_channel_id: 'ch',
      source_session_id: 'sess',
    }
    expect(candidate.candidate_kind).toBe('recent_terminal')
  })

  it('admin 与 agent in-flight 按 task_id 去重 union', async () => {
    const assembler = buildAssembler({
      adminItems: [{ id: 'task-A', title: 'admin A', status: 'executing' }],
      agentInflight: [
        { task_id: 'task-A', title: 'in-flight A', trigger_type: 'message' },
        { task_id: 'task-B', title: 'in-flight only B', trigger_type: 'message' },
      ],
    })
    const tasks = await (assembler as unknown as { fetchActiveTasks: (channelId: string, sessionId: string) => Promise<TaskSummary[]> })
      .fetchActiveTasks('ch', 'sess')
    const ids = tasks.map(t => t.task_id)
    expect(ids).toContain('task-A')
    expect(ids).toContain('task-B')
    expect(ids).toHaveLength(2)
  })

  it('过滤 trigger_type=scheduled 的 task', async () => {
    const assembler = buildAssembler({
      adminItems: [
        { id: 'task-sched', title: 's', status: 'executing', source: { trigger_type: 'scheduled' } },
        { id: 'task-msg', title: 'm', status: 'executing', source: { trigger_type: 'message' } },
      ],
    })
    const tasks = await (assembler as unknown as { fetchActiveTasks: (channelId: string, sessionId: string) => Promise<TaskSummary[]> })
      .fetchActiveTasks('ch', 'sess')
    const ids = tasks.map(t => t.task_id)
    expect(ids).toContain('task-msg')
    expect(ids).not.toContain('task-sched')
  })

  it('adds recent completed and failed tasks from same channel/session ordered by completed_at desc', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-29T09:00:00.000Z'))

    const assembler = buildAssembler({
      adminItems: [{ id: 'task-active', title: 'active', status: 'executing' }],
      recentItems: [
        { id: 'task-old', title: 'old', status: 'completed', completed_at: '2026-06-28T09:00:00.000Z' },
        { id: 'task-new', title: 'new', status: 'completed', completed_at: '2026-06-29T09:00:00.000Z' },
        { id: 'task-failed', title: 'failed', status: 'failed', completed_at: '2026-06-29T08:00:00.000Z', error: 'TypeError: terminated' },
      ],
    })
    const tasks = await (assembler as unknown as { fetchActiveTasks: (channelId: string, sessionId: string) => Promise<TaskSummary[]> })
      .fetchActiveTasks('ch', 'sess')
    expect(tasks.map(t => t.task_id)).toEqual(['task-active', 'task-new', 'task-failed', 'task-old'])
    expect(tasks.find(t => t.task_id === 'task-new')?.candidate_kind).toBe('recent_terminal')
    expect(tasks.find(t => t.task_id === 'task-failed')?.error).toBe('TypeError: terminated')
  })

  it('excludes cancelled and self-healing failed tasks from recent terminal candidates', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-29T09:00:00.000Z'))

    const assembler = buildAssembler({
      adminItems: [],
      recentItems: [
        { id: 'task-cancel', title: 'cancel', status: 'cancelled', completed_at: '2026-06-29T09:00:00.000Z' },
        { id: 'task-recovery', title: 'recovery', status: 'failed', completed_at: '2026-06-29T08:00:00.000Z', error: 'agent_restarted_during_execution' },
        { id: 'task-ok', title: 'ok', status: 'failed', completed_at: '2026-06-29T07:00:00.000Z', error: 'UND_ERR_SOCKET' },
      ],
    })
    const tasks = await (assembler as unknown as { fetchActiveTasks: (channelId: string, sessionId: string) => Promise<TaskSummary[]> })
      .fetchActiveTasks('ch', 'sess')
    expect(tasks.map(t => t.task_id)).toEqual(['task-ok'])
  })

  it('admin 拉取失败时仍返回 agent in-flight 数据', async () => {
    const rpcClient = { call: vi.fn().mockRejectedValue(new Error('admin down')) }
    const assembler = new (ContextAssembler as never)({
      rpcClient, moduleId: 'a',
      config: {
        front_context_recent_messages_window_hours: 6,
        front_context_recent_messages_max_cap: 50,
        front_context_short_term_memory_window_hours: 12,
        front_context_short_term_memory_max_cap: 30,
        worker_recent_messages_window_hours: 4,
        worker_recent_messages_max_cap: 50,
        worker_short_term_memory_window_hours: 12,
        worker_short_term_memory_max_cap: 30,
        worker_long_term_memory_limit: 20,
        front_agent_timeout: 30,
        session_state_ttl: 300,
        worker_config_refresh_interval: 60,
        front_agent_queue_max_length: 10,
        front_agent_queue_timeout: 60,
      },
      getAdminPort: vi.fn().mockResolvedValue(19001),
      getMemoryPort: vi.fn().mockResolvedValue(19002),
      getInflightTriggerTasks: vi.fn().mockReturnValue([
        { task_id: 'task-X', title: 'inflight', trigger_type: 'message' },
      ]),
      getLiveSnapshot: vi.fn(),
    } as never)
    const tasks = await (assembler as unknown as { fetchActiveTasks: (channelId: string, sessionId: string) => Promise<TaskSummary[]> })
      .fetchActiveTasks('ch', 'sess')
    expect(tasks.map(t => t.task_id)).toEqual(['task-X'])
  })
})
