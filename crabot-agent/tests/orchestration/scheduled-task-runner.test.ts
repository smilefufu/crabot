/**
 * ScheduledTaskRunner 单元测试 — trigger_message 构造 (Task 7)
 *
 * 验证 scheduled 任务被丢给 worker 时，ExecuteTaskParams.context.trigger_messages
 * 包含一条 type=system_event / event_type=scheduled 的 ChannelMessage，描述文本
 * 走 task.description，session 字段按 task.target_session 或 SYSTEM_SESSION 哨兵填。
 */

import { describe, it, expect, vi } from 'vitest'
import { AgentLoopSubstrate } from '../../src/orchestration/agent-loop-substrate.js'
import { ScheduledTaskRunner } from '../../src/orchestration/scheduled-task-runner.js'
import { MemoryWriter } from '../../src/orchestration/memory-writer.js'
import type {
  WorkerAgentContext,
} from '../../src/types.js'

function makeWorkerContext(): WorkerAgentContext {
  return {
    short_term_memories: [],
    long_term_memories: [],
    available_tools: [],
    admin_endpoint: { module_id: 'admin' as any, port: 18000, host: 'localhost' } as any,
    memory_endpoint: { module_id: 'memory' as any, port: 18001, host: 'localhost' } as any,
    channel_endpoints: [],
    time_windows: {
      recent_messages_window_hours: 24,
      short_term_memory_window_hours: 72,
    },
  }
}

/** Common harness: 拦截 update_task_status RPC + 捕获 executeTaskFn 收到的 payload */
function setupRunner(opts?: {
  executeTaskFn?: ReturnType<typeof vi.fn>
  memoryWriter?: Pick<MemoryWriter, 'writeTaskFinished' | 'quickCapture' | 'runMaintenance'>
}) {
  const rpcCall = vi.fn().mockResolvedValue({ data: { status: 'ok' } })
  const rpcClient: any = { call: rpcCall }
  const memoryWriter = opts?.memoryWriter ?? new MemoryWriter(rpcClient, 'agent-1', () => 18000)
  const executeTaskFn = opts?.executeTaskFn ?? vi.fn().mockResolvedValue({
    task_id: 'task-x' as any,
    outcome: 'completed' as const,
  })
  const substrate = new AgentLoopSubstrate(executeTaskFn as never)

  const runner = new ScheduledTaskRunner(
    rpcClient,
    'agent-1',
    memoryWriter,
    () => 18000,
    substrate,
  )

  return { runner, executeTaskFn, rpcCall }
}

/** Wait until executeTaskFn was invoked (run() is async, executeScheduledTaskInBackground returns void) */
async function waitForExecute(executeTaskFn: ReturnType<typeof vi.fn>): Promise<void> {
  for (let i = 0; i < 50; i++) {
    if (executeTaskFn.mock.calls.length > 0) return
    await new Promise(r => setTimeout(r, 10))
  }
  throw new Error('executeTaskFn was not invoked within 500ms')
}

describe('ScheduledTaskRunner trigger_message construction (Task 7)', () => {
  it('with target_session: constructs system_event ChannelMessage with target session', async () => {
    const { runner, executeTaskFn } = setupRunner()
    const workerContext = makeWorkerContext()

    runner.executeScheduledTaskInBackground(
      {
        id: 'task-1',
        title: '每日反思',
        description: '执行 X',
        priority: 'normal',
        task_type: 'reflection',
        target_session: {
          channel_id: 'wechat-x' as any,
          session_id: 'sess-y' as any,
          type: 'group',
        },
      },
      workerContext,
    )

    await waitForExecute(executeTaskFn)

    const payload = executeTaskFn.mock.calls[0][0]
    expect(payload.context.trigger_messages).toBeDefined()
    expect(payload.context.trigger_messages!.length).toBe(1)

    const msg = payload.context.trigger_messages![0]
    expect(msg.content.type).toBe('system_event')
    expect(msg.content.event_type).toBe('scheduled')
    expect(msg.content.text).toBe('执行 X')
    expect(msg.session.channel_id).toBe('wechat-x')
    expect(msg.session.session_id).toBe('sess-y')
    expect(msg.session.type).toBe('group')
    expect(msg.sender.platform_user_id).toBe('crabot')
    expect(msg.sender.platform_display_name).toBe('Crabot')
    expect(msg.features.is_mention_crab).toBe(false)
    expect(msg.platform_message_id).toBe('system:scheduled:task-1')
  })

  it('without target_session: session falls back to SYSTEM_SESSION sentinel', async () => {
    const { runner, executeTaskFn } = setupRunner()
    const workerContext = makeWorkerContext()

    runner.executeScheduledTaskInBackground(
      {
        id: 'task-2',
        title: '系统巡检',
        description: '巡检短期记忆',
        priority: 'normal',
        task_type: 'reflection',
        // no target_session
      },
      workerContext,
    )

    await waitForExecute(executeTaskFn)

    const payload = executeTaskFn.mock.calls[0][0]
    expect(payload.context.trigger_messages).toBeDefined()
    expect(payload.context.trigger_messages!.length).toBe(1)

    const msg = payload.context.trigger_messages![0]
    expect(msg.content.type).toBe('system_event')
    expect(msg.content.event_type).toBe('scheduled')
    expect(msg.content.text).toBe('巡检短期记忆')
    expect(msg.session.channel_id).toBe('system')
    expect(msg.session.session_id).toBe('system')
    expect(msg.session.type).toBe('private')
  })

  it('preserves workerContext fields (task_origin, permissions) when injecting trigger_messages', async () => {
    const { runner, executeTaskFn } = setupRunner()
    const workerContext: WorkerAgentContext = {
      ...makeWorkerContext(),
      task_origin: {
        channel_id: 'wechat-x' as any,
        session_id: 'sess-y' as any,
        session_type: 'group',
      } as any,
    }

    runner.executeScheduledTaskInBackground(
      {
        id: 'task-3',
        title: 'X',
        description: 'Y',
        priority: 'normal',
        target_session: {
          channel_id: 'wechat-x' as any,
          session_id: 'sess-y' as any,
          type: 'group',
        },
      },
      workerContext,
    )

    await waitForExecute(executeTaskFn)

    const payload = executeTaskFn.mock.calls[0][0]
    // task_origin 来自 workerContext，不被覆盖
    expect(payload.context.task_origin?.channel_id).toBe('wechat-x')
    expect(payload.context.task_origin?.session_id).toBe('sess-y')
    // trigger_messages 已被注入
    expect(payload.context.trigger_messages?.length).toBe(1)
  })

  it('handles empty description: text is empty string, not undefined', async () => {
    const { runner, executeTaskFn } = setupRunner()
    runner.executeScheduledTaskInBackground(
      {
        id: 'task-4',
        title: 'X',
        // no description
        priority: 'normal',
      },
      makeWorkerContext(),
    )

    await waitForExecute(executeTaskFn)
    const msg = executeTaskFn.mock.calls[0][0].context.trigger_messages![0]
    expect(msg.content.text).toBe('')
  })
})

describe('ScheduledTaskRunner — M3: resumeFrom 时跳过 planning/executing 状态转换', () => {
  it('resumeFrom 存在时：不向 admin 发送 update_task_status(planning/executing)', async () => {
    const { runner, executeTaskFn, rpcCall } = setupRunner()

    runner.executeScheduledTaskInBackground(
      {
        id: 'task-resume',
        title: 'resume 任务',
        description: '续办',
        priority: 'normal',
      },
      makeWorkerContext(),
      {
        resumeFrom: {
          initialMessages: [{ id: 'm1', role: 'user' as const, content: 'hi', timestamp: 1 }],
          todoItems: [],
          goalRevisionUnlocked: false,
        },
      },
    )

    await waitForExecute(executeTaskFn)

    // rpcCall 只应被 executeTaskFn 内部调用（如有），不应有 update_task_status(planning/executing)
    const statusCalls = rpcCall.mock.calls.filter(
      (c: unknown[]) => c[1] === 'update_task_status'
    )
    const planningOrExecuting = statusCalls.filter(
      (c: unknown[]) => {
        const body = c[2] as { status?: string }
        return body.status === 'planning' || body.status === 'executing'
      }
    )
    expect(planningOrExecuting).toHaveLength(0)
  })

  it('resumeFrom 不存在时：正常发送 planning 和 executing 状态转换', async () => {
    const { runner, executeTaskFn, rpcCall } = setupRunner()

    runner.executeScheduledTaskInBackground(
      {
        id: 'task-normal',
        title: '普通任务',
        description: '描述',
        priority: 'normal',
      },
      makeWorkerContext(),
      // opts 不传（无 resumeFrom）
    )

    await waitForExecute(executeTaskFn)

    const statusCalls = rpcCall.mock.calls.filter(
      (c: unknown[]) => c[1] === 'update_task_status'
    )
    const statuses = statusCalls.map((c: unknown[]) => (c[2] as { status?: string }).status)
    expect(statuses).toContain('planning')
    expect(statuses).toContain('executing')
  })
})

describe('ScheduledTaskRunner — failed worker loop memory boundary', () => {
  it('worker crash only marks scheduled task failed and does not write failure memory', async () => {
    const executeTaskFn = vi.fn().mockRejectedValue(new Error('worker crashed'))
    const memoryWriter = {
      writeTaskFinished: vi.fn().mockResolvedValue(undefined),
      quickCapture: vi.fn().mockResolvedValue(undefined),
      runMaintenance: vi.fn().mockResolvedValue(undefined),
    }
    const { runner, rpcCall } = setupRunner({ executeTaskFn, memoryWriter })

    runner.executeScheduledTaskInBackground(
      {
        id: 'task-crash',
        title: '崩溃任务',
        description: '会崩',
        priority: 'normal',
      },
      makeWorkerContext(),
    )

    await waitForExecute(executeTaskFn)
    for (let i = 0; i < 50; i++) {
      const failedCall = rpcCall.mock.calls.find((c: unknown[]) => {
        const body = c[2] as { task_id?: string; status?: string }
        return c[1] === 'update_task_status' && body.task_id === 'task-crash' && body.status === 'failed'
      })
      if (failedCall) break
      await new Promise(r => setTimeout(r, 10))
    }

    expect(rpcCall).toHaveBeenCalledWith(
      18000,
      'update_task_status',
      expect.objectContaining({
        task_id: 'task-crash',
        status: 'failed',
        error: 'worker crashed',
      }),
      'agent-1',
    )
    expect(memoryWriter.writeTaskFinished).not.toHaveBeenCalled()
    expect(memoryWriter.quickCapture).not.toHaveBeenCalled()
  })
})
