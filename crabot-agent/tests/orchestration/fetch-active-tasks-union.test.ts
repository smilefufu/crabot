import { describe, it, expect, vi } from 'vitest'
import { ContextAssembler } from '../../src/orchestration/context-assembler.js'
import type { TaskSummary } from '../../src/types.js'

function buildAssembler(opts: {
  adminItems: Array<{ id: string; title: string; status: string; source?: { trigger_type?: string } }>
  agentInflight?: Array<{ task_id: string; title: string; trigger_type: 'message' | 'scheduled' }>
}) {
  const rpcClient = {
    call: vi.fn().mockResolvedValue({ items: opts.adminItems.map(t => ({
      id: t.id, title: t.title, status: t.status, type: 'task', priority: 'normal',
      source: t.source ?? { trigger_type: 'message' }, messages: [],
    })) }),
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
  it('admin 与 agent in-flight 按 task_id 去重 union', async () => {
    const assembler = buildAssembler({
      adminItems: [{ id: 'task-A', title: 'admin A', status: 'executing' }],
      agentInflight: [
        { task_id: 'task-A', title: 'in-flight A', trigger_type: 'message' },
        { task_id: 'task-B', title: 'in-flight only B', trigger_type: 'message' },
      ],
    })
    const tasks = await (assembler as unknown as { fetchActiveTasks: () => Promise<TaskSummary[]> }).fetchActiveTasks()
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
    const tasks = await (assembler as unknown as { fetchActiveTasks: () => Promise<TaskSummary[]> }).fetchActiveTasks()
    const ids = tasks.map(t => t.task_id)
    expect(ids).toContain('task-msg')
    expect(ids).not.toContain('task-sched')
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
    const tasks = await (assembler as unknown as { fetchActiveTasks: () => Promise<TaskSummary[]> }).fetchActiveTasks()
    expect(tasks.map(t => t.task_id)).toEqual(['task-X'])
  })
})
