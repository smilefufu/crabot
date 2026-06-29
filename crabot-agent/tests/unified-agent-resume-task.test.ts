/**
 * UnifiedAgent.handleResumeTask 单元测试
 *
 * I1: resumed worker 从 task.source 重建 task_origin，确保消息投递回原会话
 * M2: resume_error（catch）路径调用 finalizeUnresumedCheckpoint 清理 checkpoint 文件
 */

import { describe, it, expect, vi } from 'vitest'
import { UnifiedAgent } from '../src/unified-agent.js'
import { AGENT_VERSION } from '../src/constants.js'

/** 构造最小可调用的 handleResumeTask 宿主对象（原型绕过） */
function buildAgent(deps: {
  getResumableCheckpoint?: ReturnType<typeof vi.fn>
  finalizeUnresumedCheckpoint?: ReturnType<typeof vi.fn>
  consumeResumableCheckpoint?: ReturnType<typeof vi.fn>
  isResumableOk?: boolean
  rpcCallResult?: unknown
  assembleScheduledTaskContextResult?: unknown
  executeScheduledTaskInBackground?: ReturnType<typeof vi.fn>
  rpcCallError?: Error
  assembleError?: Error
}) {
  const agent = Object.create(UnifiedAgent.prototype) as Record<string, unknown>
  agent.config = { moduleId: 'test-agent' }

  // traceStore stub
  const getResumableCheckpoint = deps.getResumableCheckpoint ?? vi.fn().mockReturnValue({
    checkpoint: {
      agent_version: AGENT_VERSION,
      messages: [{ id: 'm1', role: 'user', content: 'hi', timestamp: 1 }],
      worker_state: { todo_items: [] },
      system_prompt: 'SP',
    },
  })
  const finalizeUnresumedCheckpoint = deps.finalizeUnresumedCheckpoint ?? vi.fn()
  const consumeResumableCheckpoint = deps.consumeResumableCheckpoint ?? vi.fn()

  agent.traceStore = {
    getResumableCheckpoint,
    finalizeUnresumedCheckpoint,
    consumeResumableCheckpoint,
  }

  // rpcClient stub
  if (deps.rpcCallError) {
    agent.rpcClient = { call: vi.fn().mockRejectedValue(deps.rpcCallError) }
  } else {
    agent.rpcClient = {
      call: vi.fn().mockResolvedValue(
        deps.rpcCallResult ?? {
          task: {
            id: 'task-1',
            title: '测试任务',
            description: '描述',
            priority: 'normal',
            source: {
              origin: 'human',
              channel_id: 'wechat-x',
              session_id: 'sess-y',
              friend_id: 'friend-z',
              trigger_type: 'message',
            },
          },
        }
      ),
    }
  }

  // contextAssembler stub
  if (deps.assembleError) {
    agent.contextAssembler = {
      assembleScheduledTaskContext: vi.fn().mockRejectedValue(deps.assembleError),
    }
  } else {
    agent.contextAssembler = {
      assembleScheduledTaskContext: vi.fn().mockResolvedValue(
        deps.assembleScheduledTaskContextResult ?? {
          short_term_memories: [],
          long_term_memories: [],
          available_tools: [],
          admin_endpoint: { module_id: 'admin', port: 18000, host: 'localhost' },
          memory_endpoint: { module_id: 'memory', port: 18001, host: 'localhost' },
          channel_endpoints: [],
          time_windows: { recent_messages_window_hours: 24, short_term_memory_window_hours: 72 },
        }
      ),
    }
  }

  // scheduledTaskRunner stub
  const executeScheduledTaskInBackground = deps.executeScheduledTaskInBackground ?? vi.fn()
  agent.scheduledTaskRunner = { executeScheduledTaskInBackground }

  // getAdminPort
  agent.getAdminPort = vi.fn().mockResolvedValue(18000)

  return {
    agent: agent as { handleResumeTask: (p: { task_id: string }) => Promise<{ resumed: boolean; reason?: string }> },
    executeScheduledTaskInBackground,
    consumeResumableCheckpoint,
    finalizeUnresumedCheckpoint,
    traceStore: agent.traceStore as {
      getResumableCheckpoint: ReturnType<typeof vi.fn>
      finalizeUnresumedCheckpoint: ReturnType<typeof vi.fn>
      consumeResumableCheckpoint: ReturnType<typeof vi.fn>
    },
  }
}

describe('UnifiedAgent.handleResumeTask — I1: task_origin 从 task.source 重建', () => {
  it('human 来源：task_origin.channel_id/session_id/friend_id 与 task.source 一致', async () => {
    const { agent, executeScheduledTaskInBackground } = buildAgent({})

    const result = await agent.handleResumeTask({ task_id: 'task-1' })

    expect(result.resumed).toBe(true)
    expect(executeScheduledTaskInBackground).toHaveBeenCalledOnce()

    const [, workerContext] = executeScheduledTaskInBackground.mock.calls[0] as [unknown, { task_origin?: { channel_id: string; session_id: string; friend_id?: string } }]
    expect(workerContext.task_origin?.channel_id).toBe('wechat-x')
    expect(workerContext.task_origin?.session_id).toBe('sess-y')
    expect(workerContext.task_origin?.friend_id).toBe('friend-z')
  })

  it('system 来源（无 channel_id）：task_origin 为 undefined，用 system session 兜底', async () => {
    const { agent, executeScheduledTaskInBackground } = buildAgent({
      rpcCallResult: {
        task: {
          id: 'task-2',
          title: '系统任务',
          priority: 'normal',
          source: {
            origin: 'system',
            trigger_type: 'scheduled',
            // 无 channel_id / session_id
          },
        },
      },
    })

    const result = await agent.handleResumeTask({ task_id: 'task-2' })

    expect(result.resumed).toBe(true)
    const [, workerContext] = executeScheduledTaskInBackground.mock.calls[0] as [unknown, { task_origin?: unknown }]
    expect(workerContext.task_origin).toBeUndefined()
  })

  it('source 字段缺失时：task_origin 为 undefined', async () => {
    const { agent, executeScheduledTaskInBackground } = buildAgent({
      rpcCallResult: {
        task: {
          id: 'task-3',
          title: '无 source 任务',
          priority: 'normal',
          // source 字段缺失
        },
      },
    })

    const result = await agent.handleResumeTask({ task_id: 'task-3' })

    expect(result.resumed).toBe(true)
    const [, workerContext] = executeScheduledTaskInBackground.mock.calls[0] as [unknown, { task_origin?: unknown }]
    expect(workerContext.task_origin).toBeUndefined()
  })

  it('成功 resume 后不 finalize 旧 trace（改由 handleExecuteTask 的 reactivate 复用续写，一个 task 一条连续 trace）', async () => {
    const { agent, consumeResumableCheckpoint } = buildAgent({})

    const result = await agent.handleResumeTask({ task_id: 'task-1' })

    expect(result.resumed).toBe(true)
    // 旧行为：consumeResumableCheckpoint finalize 旧 trace + 另起新 trace = 一个 task 两条 trace。
    // 新行为：不 consume；旧 trace 由 reactivateResumableTrace 复用续写，一个 task 一条连续 trace。
    expect(consumeResumableCheckpoint).not.toHaveBeenCalled()
  })
})

describe('UnifiedAgent.handleResumeTask — M2: resume_error 清理 checkpoint', () => {
  it('rpcClient.call 抛错时：finalizeUnresumedCheckpoint 被调用，returned {resumed:false,reason:"resume_error"}', async () => {
    const { agent, finalizeUnresumedCheckpoint } = buildAgent({
      rpcCallError: new Error('network error'),
    })

    const result = await agent.handleResumeTask({ task_id: 'task-err' })

    expect(result.resumed).toBe(false)
    expect(result.reason).toBe('resume_error')
    expect(finalizeUnresumedCheckpoint).toHaveBeenCalledWith('task-err')
  })

  it('assembleScheduledTaskContext 抛错时：finalizeUnresumedCheckpoint 被调用', async () => {
    const { agent, finalizeUnresumedCheckpoint } = buildAgent({
      assembleError: new Error('context assembly failed'),
    })

    const result = await agent.handleResumeTask({ task_id: 'task-assemble-err' })

    expect(result.resumed).toBe(false)
    expect(result.reason).toBe('resume_error')
    expect(finalizeUnresumedCheckpoint).toHaveBeenCalledWith('task-assemble-err')
  })
})
