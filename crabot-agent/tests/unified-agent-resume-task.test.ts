/**
 * UnifiedAgent.handleResumeTask 单元测试
 *
 * I1: resumed worker 从 task.source 重建 task_origin，确保消息投递回原会话
 * M2: resume_error（catch）路径调用 finalizeUnresumedCheckpoint 清理 checkpoint 文件
 */

import { describe, it, expect, vi } from 'vitest'
import { UnifiedAgent } from '../src/unified-agent.js'
import { AGENT_VERSION } from '../src/constants.js'
import { AgentLoopSubstrate } from '../src/orchestration/agent-loop-substrate.js'

async function waitFor(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 50; i++) {
    if (condition()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('condition was not met within 500ms')
}

/** 构造最小可调用的 handleResumeTask 宿主对象（原型绕过） */
function buildAgent(deps: {
  getResumableCheckpoint?: ReturnType<typeof vi.fn>
  findLatestResumeCheckpointByTaskId?: ReturnType<typeof vi.fn>
  finalizeUnresumedCheckpoint?: ReturnType<typeof vi.fn>
  consumeResumableCheckpoint?: ReturnType<typeof vi.fn>
  isResumableOk?: boolean
  rpcCallResult?: unknown
  assembleScheduledTaskContextResult?: unknown
  executeAgentLoopInBackground?: ReturnType<typeof vi.fn>
  agentLoopSubstrate?: { executeAgentLoopInBackground: (...args: never[]) => void }
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
    findLatestResumeCheckpointByTaskId: deps.findLatestResumeCheckpointByTaskId ?? vi.fn(),
    finalizeUnresumedCheckpoint,
    consumeResumableCheckpoint,
  }

  // rpcClient stub
  const defaultGetTaskResult = deps.rpcCallResult ?? {
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
  let rpcCall: ReturnType<typeof vi.fn>
  if (deps.rpcCallError) {
    rpcCall = vi.fn().mockRejectedValue(deps.rpcCallError)
    agent.rpcClient = { call: rpcCall }
  } else {
    rpcCall = vi.fn().mockImplementation((_port: number, method: string) => {
      if (method === 'get_task') return Promise.resolve(defaultGetTaskResult)
      return Promise.resolve({ ok: true })
    })
    agent.rpcClient = {
      call: rpcCall,
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

  // agentLoopSubstrate stub
  const executeAgentLoopInBackground = deps.executeAgentLoopInBackground ?? vi.fn()
  agent.agentLoopSubstrate = deps.agentLoopSubstrate ?? { executeAgentLoopInBackground }

  // getAdminPort
  agent.getAdminPort = vi.fn().mockResolvedValue(18000)

  return {
    agent: agent as {
      handleResumeTask: (p: { task_id: string }) => Promise<{ resumed: boolean; reason?: string }>
      handleResumeTaskWithSupplement: (p: { task_id: string; supplement_text: string }) => Promise<{ resumed: boolean; reason?: string }>
      reviveTerminalSupplementTask: (
        taskId: string,
        text: string,
        channelId: string,
        sessionId: string
      ) => Promise<{ outcome: 'revived'; traceId?: string } | { outcome: 'fallback'; reason?: string }>
    },
    executeAgentLoopInBackground,
    rpcCall,
    consumeResumableCheckpoint,
    finalizeUnresumedCheckpoint,
    traceStore: agent.traceStore as {
      getResumableCheckpoint: ReturnType<typeof vi.fn>
      findLatestResumeCheckpointByTaskId: ReturnType<typeof vi.fn>
      finalizeUnresumedCheckpoint: ReturnType<typeof vi.fn>
      consumeResumableCheckpoint: ReturnType<typeof vi.fn>
    },
  }
}

describe('UnifiedAgent.handleResumeTask — I1: task_origin 从 task.source 重建', () => {
  it('returns not_configured instead of claiming resumed when worker handler is not ready', async () => {
    const { agent, executeAgentLoopInBackground, finalizeUnresumedCheckpoint } = buildAgent({})

    const result = await agent.handleResumeTask({ task_id: 'task-1' })

    expect(result).toEqual({ resumed: false, reason: 'not_configured' })
    expect(executeAgentLoopInBackground).not.toHaveBeenCalled()
    expect(finalizeUnresumedCheckpoint).not.toHaveBeenCalled()
  })

  it('human 来源：task_origin.channel_id/session_id/friend_id 与 task.source 一致', async () => {
    const { agent, executeAgentLoopInBackground } = buildAgent({})
    ;(agent as unknown as { agentHandler: { hasActiveTask: () => boolean } }).agentHandler = { hasActiveTask: () => false }

    const result = await agent.handleResumeTask({ task_id: 'task-1' })

    expect(result.resumed).toBe(true)
    expect(executeAgentLoopInBackground).toHaveBeenCalledOnce()

    const [payload] = executeAgentLoopInBackground.mock.calls[0] as [{
      context: { task_origin?: { channel_id: string; session_id: string; friend_id?: string } }
    }]
    const workerContext = payload.context
    expect(workerContext.task_origin?.channel_id).toBe('wechat-x')
    expect(workerContext.task_origin?.session_id).toBe('sess-y')
    expect(workerContext.task_origin?.friend_id).toBe('friend-z')
  })

  it('restart resume human task: executes worker loop with source.trigger_type=message, never scheduled', async () => {
    const { agent, executeAgentLoopInBackground } = buildAgent({})
    ;(agent as unknown as { agentHandler: { hasActiveTask: () => boolean } }).agentHandler = { hasActiveTask: () => false }

    const result = await agent.handleResumeTask({ task_id: 'task-1' })

    expect(result.resumed).toBe(true)
    expect(executeAgentLoopInBackground).toHaveBeenCalledOnce()
    const [payload] = executeAgentLoopInBackground.mock.calls[0] as [{
      task: { source?: { trigger_type?: string } }
      context: { task_origin?: { channel_id: string; session_id: string; friend_id?: string } }
      resumeFrom?: { initialMessages?: unknown[] }
    }]
    expect(payload.task.source?.trigger_type).toBe('message')
    expect(payload.context.task_origin).toEqual({
      channel_id: 'wechat-x',
      session_id: 'sess-y',
      friend_id: 'friend-z',
    })
    expect(payload.resumeFrom?.initialMessages).toHaveLength(1)
  })

  it('system 来源（无 channel_id）：task_origin 为 undefined，用 system session 兜底', async () => {
    const { agent, executeAgentLoopInBackground } = buildAgent({
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
    ;(agent as unknown as { agentHandler: { hasActiveTask: () => boolean } }).agentHandler = { hasActiveTask: () => false }

    const result = await agent.handleResumeTask({ task_id: 'task-2' })

    expect(result.resumed).toBe(true)
    const [payload] = executeAgentLoopInBackground.mock.calls[0] as [{ context: { task_origin?: unknown } }]
    expect(payload.context.task_origin).toBeUndefined()
  })

  it('source 字段缺失时：task_origin 为 undefined', async () => {
    const { agent, executeAgentLoopInBackground } = buildAgent({
      rpcCallResult: {
        task: {
          id: 'task-3',
          title: '无 source 任务',
          priority: 'normal',
          // source 字段缺失
        },
      },
    })
    ;(agent as unknown as { agentHandler: { hasActiveTask: () => boolean } }).agentHandler = { hasActiveTask: () => false }

    const result = await agent.handleResumeTask({ task_id: 'task-3' })

    expect(result.resumed).toBe(true)
    const [payload] = executeAgentLoopInBackground.mock.calls[0] as [{ context: { task_origin?: unknown } }]
    expect(payload.context.task_origin).toBeUndefined()
  })

  it('成功 resume 后不 finalize 旧 trace（改由 handleExecuteTask 的 reactivate 复用续写，一个 task 一条连续 trace）', async () => {
    const { agent, consumeResumableCheckpoint } = buildAgent({})
    ;(agent as unknown as { agentHandler: { hasActiveTask: () => boolean } }).agentHandler = { hasActiveTask: () => false }

    const result = await agent.handleResumeTask({ task_id: 'task-1' })

    expect(result.resumed).toBe(true)
    // 旧行为：consumeResumableCheckpoint finalize 旧 trace + 另起新 trace = 一个 task 两条 trace。
    // 新行为：不 consume；旧 trace 由 reactivateResumableTrace 复用续写，一个 task 一条连续 trace。
    expect(consumeResumableCheckpoint).not.toHaveBeenCalled()
  })

  it('background worker loop reject 时：把 resumed task 标记为 failed，不 consume checkpoint', async () => {
    const executeTaskFn = vi.fn().mockRejectedValue(new Error('worker crashed after resume'))
    const substrate = new AgentLoopSubstrate(executeTaskFn as never)
    const { agent, rpcCall, consumeResumableCheckpoint } = buildAgent({
      agentLoopSubstrate: substrate,
    })
    ;(agent as unknown as { agentHandler: { hasActiveTask: () => boolean } }).agentHandler = { hasActiveTask: () => false }

    const result = await agent.handleResumeTask({ task_id: 'task-1' })

    expect(result.resumed).toBe(true)
    await waitFor(() => rpcCall.mock.calls.some((call: unknown[]) => call[1] === 'update_task_status'))
    expect(rpcCall).toHaveBeenCalledWith(
      18000,
      'update_task_status',
      {
        task_id: 'task-1',
        status: 'failed',
        error: 'worker crashed after resume',
      },
      'test-agent',
    )
    expect(consumeResumableCheckpoint).not.toHaveBeenCalled()
  })

  it('restart resume 不携带历史 trace id，继续由 resumable checkpoint 复用 running trace', async () => {
    const { agent, executeAgentLoopInBackground } = buildAgent({
      getResumableCheckpoint: vi.fn().mockReturnValue({
        traceId: 'trace-running',
        checkpoint: {
          agent_version: AGENT_VERSION,
          messages: [{ id: 'm1', role: 'user', content: 'hi', timestamp: 1 }],
          worker_state: { todo_items: [] },
          system_prompt: 'SP',
        },
      }),
    })
    ;(agent as unknown as { agentHandler: { hasActiveTask: () => boolean } }).agentHandler = { hasActiveTask: () => false }

    const result = await agent.handleResumeTask({ task_id: 'task-1' })

    expect(result.resumed).toBe(true)
    const [payload] = executeAgentLoopInBackground.mock.calls[0] as [{
      resumeFrom?: { terminalSupplementText?: string; resumeTraceId?: string }
    }]
    expect(payload.resumeFrom?.terminalSupplementText).toBeUndefined()
    expect(payload.resumeFrom?.resumeTraceId).toBeUndefined()
  })

  it('restart resume 从 checkpoint worker_state 传递 humanInputEpoch 和 lastDeliveredInfoEpoch', async () => {
    const { agent, executeAgentLoopInBackground } = buildAgent({
      getResumableCheckpoint: vi.fn().mockReturnValue({
        traceId: 'trace-running',
        checkpoint: {
          agent_version: AGENT_VERSION,
          messages: [{ id: 'm1', role: 'user', content: 'hi', timestamp: 1 }],
          worker_state: { todo_items: [], human_input_epoch: 1, last_delivered_info_epoch: 0 },
          system_prompt: 'SP',
        },
      }),
    })
    ;(agent as unknown as { agentHandler: { hasActiveTask: () => boolean } }).agentHandler = { hasActiveTask: () => false }

    const result = await agent.handleResumeTask({ task_id: 'task-1' })

    expect(result.resumed).toBe(true)
    const [payload] = executeAgentLoopInBackground.mock.calls[0] as [{
      resumeFrom?: { humanInputEpoch?: number; lastDeliveredInfoEpoch?: number }
    }]
    expect(payload.resumeFrom?.humanInputEpoch).toBe(1)
    expect(payload.resumeFrom?.lastDeliveredInfoEpoch).toBe(0)
  })

  it('restart resume scheduled task: preserves scheduled source instead of forcing message', async () => {
    const { agent, executeAgentLoopInBackground } = buildAgent({
      rpcCallResult: {
        task: {
          id: 'task-scheduled',
          title: '系统巡检',
          priority: 'normal',
          source: { origin: 'system', trigger_type: 'scheduled' },
        },
      },
    })
    ;(agent as unknown as { agentHandler: { hasActiveTask: () => boolean } }).agentHandler = { hasActiveTask: () => false }

    const result = await agent.handleResumeTask({ task_id: 'task-scheduled' })

    expect(result.resumed).toBe(true)
    const [payload] = executeAgentLoopInBackground.mock.calls[0] as [{ task: { source?: { trigger_type?: string } } }]
    expect(payload.task.source?.trigger_type).toBe('scheduled')
  })
})

describe('UnifiedAgent.handleResumeTaskWithSupplement', () => {
  it('schedules background execution with terminalSupplementText in resumeFrom', async () => {
    const { agent, executeAgentLoopInBackground } = buildAgent({
      findLatestResumeCheckpointByTaskId: vi.fn().mockReturnValue({
        traceId: 'trace-completed',
        checkpoint: {
          agent_version: AGENT_VERSION,
          messages: [{ id: 'm-history', role: 'user', content: 'history', timestamp: 1 }],
          worker_state: { todo_items: [] },
          system_prompt: 'SP-history',
        },
      }),
      getResumableCheckpoint: vi.fn().mockReturnValue(undefined),
    })
    ;(agent as unknown as { agentHandler: { hasActiveTask: () => boolean } }).agentHandler = { hasActiveTask: () => false }

    const result = await agent.handleResumeTaskWithSupplement({
      task_id: 'task-1',
      supplement_text: '继续刚才失败的任务',
    })

    expect(result.resumed).toBe(true)
    expect(executeAgentLoopInBackground).toHaveBeenCalledOnce()

    const [payload] = executeAgentLoopInBackground.mock.calls[0] as [{
      resumeFrom?: { terminalSupplementText?: string; resumeTraceId?: string }
    }]
    expect(payload.resumeFrom?.terminalSupplementText).toBe('继续刚才失败的任务')
    expect(payload.resumeFrom?.resumeTraceId).toBe('trace-completed')
  })

  it('terminal supplement revive human task: executes worker loop as message with terminal supplement resume data', async () => {
    const { agent, executeAgentLoopInBackground } = buildAgent({
      findLatestResumeCheckpointByTaskId: vi.fn().mockReturnValue({
        traceId: 'trace-completed',
        checkpoint: {
          agent_version: AGENT_VERSION,
          messages: [{ id: 'm-history', role: 'user', content: 'history', timestamp: 1 }],
          worker_state: { todo_items: [], human_input_epoch: 31, last_delivered_info_epoch: 23 },
          system_prompt: 'SP-history',
        },
      }),
      getResumableCheckpoint: vi.fn().mockReturnValue(undefined),
    })
    ;(agent as unknown as { agentHandler: { hasActiveTask: () => boolean } }).agentHandler = { hasActiveTask: () => false }

    const result = await agent.handleResumeTaskWithSupplement({
      task_id: 'task-1',
      supplement_text: '继续刚才失败的任务',
    })

    expect(result.resumed).toBe(true)
    const [payload] = executeAgentLoopInBackground.mock.calls[0] as [{
      task: { source?: { trigger_type?: string } }
      resumeFrom?: {
        terminalSupplementText?: string
        resumeTraceId?: string
        humanInputEpoch?: number
        lastDeliveredInfoEpoch?: number
      }
    }]
    expect(payload.task.source?.trigger_type).toBe('message')
    expect(payload.resumeFrom?.terminalSupplementText).toBe('继续刚才失败的任务')
    expect(payload.resumeFrom?.resumeTraceId).toBe('trace-completed')
    expect(payload.resumeFrom?.humanInputEpoch).toBe(31)
    expect(payload.resumeFrom?.lastDeliveredInfoEpoch).toBe(23)
  })
})

describe('UnifiedAgent.reviveTerminalSupplementTask', () => {
  function buildReviveAgent(deps: {
    rpcCallError?: Error
    resumeResult?: { resumed: boolean; reason?: string }
    cleanupError?: Error
    hasCheckpoint?: boolean
    checkpointVersion?: string
    hasActiveTask?: boolean
  } = {}) {
    const agent = Object.create(UnifiedAgent.prototype) as Record<string, unknown>
    agent.config = { moduleId: 'test-agent' }
    agent.getAdminPort = vi.fn().mockResolvedValue(18000)
    agent.rpcClient = {
      call: vi.fn().mockImplementation((_port: number, method: string) => {
        if (method === 'revive_task_for_supplement' && deps.rpcCallError) {
          return Promise.reject(deps.rpcCallError)
        }
        if (method === 'update_task_status' && deps.cleanupError) {
          return Promise.reject(deps.cleanupError)
        }
        return Promise.resolve({ ok: true })
      }),
    }
    agent.handleResumeTaskWithSupplement = vi.fn().mockResolvedValue(deps.resumeResult ?? { resumed: true })

    // 预检查依赖：agentHandler.hasActiveTask + 历史 worker trace checkpoint。
    agent.agentHandler = { hasActiveTask: vi.fn().mockReturnValue(deps.hasActiveTask ?? false) }
    const checkpoint = {
      agent_version: deps.checkpointVersion ?? AGENT_VERSION,
      messages: [{ id: 'm1', role: 'user', content: 'hi', timestamp: 1 }],
      worker_state: { todo_items: [] },
      system_prompt: 'SP',
    }
    const finalizeUnresumedCheckpoint = vi.fn()
    agent.traceStore = {
      getResumableCheckpoint: vi.fn().mockReturnValue(undefined),
      findLatestResumeCheckpointByTaskId: vi
        .fn()
        .mockReturnValue((deps.hasCheckpoint ?? true) ? { traceId: 'trace-completed', checkpoint } : undefined),
      finalizeUnresumedCheckpoint,
    }

    return agent as {
      getAdminPort: ReturnType<typeof vi.fn>
      rpcClient: { call: ReturnType<typeof vi.fn> }
      handleResumeTaskWithSupplement: ReturnType<typeof vi.fn>
      agentHandler: { hasActiveTask: ReturnType<typeof vi.fn> }
      traceStore: {
        getResumableCheckpoint: ReturnType<typeof vi.fn>
        findLatestResumeCheckpointByTaskId: ReturnType<typeof vi.fn>
        finalizeUnresumedCheckpoint: ReturnType<typeof vi.fn>
      }
      reviveTerminalSupplementTask: (
        taskId: string,
        text: string,
        channelId: string,
        sessionId: string
      ) => Promise<{ outcome: 'revived'; traceId?: string } | { outcome: 'fallback'; reason?: string }>
    }
  }

  it('revives task through Admin and resumes it in-process', async () => {
    const agent = buildReviveAgent()

    const result = await agent.reviveTerminalSupplementTask('task-1', '继续刚才失败的任务', 'wechat-x', 'sess-y')

    expect(result).toEqual({ outcome: 'revived' })
    expect(agent.getAdminPort).toHaveBeenCalledOnce()
    expect(agent.rpcClient.call).toHaveBeenCalledWith(
      18000,
      'revive_task_for_supplement',
      {
        task_id: 'task-1',
        channel_id: 'wechat-x',
        session_id: 'sess-y',
        supplement_text: '继续刚才失败的任务',
      },
      'test-agent'
    )
    expect(agent.handleResumeTaskWithSupplement).toHaveBeenCalledWith({
      task_id: 'task-1',
      supplement_text: '继续刚才失败的任务',
    })
  })

  // 回归：checkpoint 不可用时，绝不能先把已完成任务翻成 executing 再兜底标 failed。
  // 预检查必须拦在 admin 改状态之前 → 直接降级 fallback（executor 走 new_task），
  // 原 task 保持原终态。Spec: 2026-06-29-dispatcher-recent-task-supplement-design §Revive/Resume §3。
  it('degrades to fallback WITHOUT touching admin when no checkpoint is available', async () => {
    const agent = buildReviveAgent({ hasCheckpoint: false })

    const result = await agent.reviveTerminalSupplementTask('task-missing', '继续', 'wechat-x', 'sess-y')

    expect(result).toEqual({ outcome: 'fallback', reason: 'no_checkpoint' })
    // 关键：admin 完全没被触碰——既没 revive、也没标 failed
    expect(agent.rpcClient.call).not.toHaveBeenCalled()
    expect(agent.handleResumeTaskWithSupplement).not.toHaveBeenCalled()
  })

  // 回归：历史 trace checkpoint 版本不匹配时只降级，不碰 admin，也不清 running checkpoint 文件。
  it('degrades to fallback on historical checkpoint version mismatch, without touching admin or running checkpoint files', async () => {
    const agent = buildReviveAgent({ checkpointVersion: 'v-ancient' })

    const result = await agent.reviveTerminalSupplementTask('task-old', '继续', 'wechat-x', 'sess-y')

    expect(result).toEqual({ outcome: 'fallback', reason: 'version_mismatch' })
    expect(agent.rpcClient.call).not.toHaveBeenCalled()
    expect(agent.traceStore.finalizeUnresumedCheckpoint).not.toHaveBeenCalled()
  })

  // 极窄竞态：预检查通过、admin 已翻 executing，resume 却仍失败 → 才允许兜底标 failed。
  it('marks task failed only when resume rejects AFTER a passing pre-check (race)', async () => {
    const agent = buildReviveAgent({ resumeResult: { resumed: false, reason: 'no_checkpoint' } })

    const result = await agent.reviveTerminalSupplementTask('task-race', '继续', 'wechat-x', 'sess-y')

    expect(result).toEqual({ outcome: 'fallback', reason: 'no_checkpoint' })
    expect(agent.rpcClient.call).toHaveBeenCalledWith(
      18000,
      'update_task_status',
      {
        task_id: 'task-race',
        status: 'failed',
        error: 'Revived terminal supplement task could not be resumed: no_checkpoint',
      },
      'test-agent'
    )
  })

  it('returns fallback when Admin revive RPC throws', async () => {
    const agent = buildReviveAgent({
      rpcCallError: new Error('admin unavailable'),
    })

    const result = await agent.reviveTerminalSupplementTask('task-err', '继续', 'wechat-x', 'sess-y')

    expect(result).toEqual({ outcome: 'fallback', reason: 'admin unavailable' })
    expect(agent.handleResumeTaskWithSupplement).not.toHaveBeenCalled()
    expect(agent.rpcClient.call).toHaveBeenCalledTimes(1)
  })
})

describe('UnifiedAgent.handleResumeTask — M2: resume_error 清理 checkpoint', () => {
  it('rpcClient.call 抛错时：finalizeUnresumedCheckpoint 被调用，returned {resumed:false,reason:"resume_error"}', async () => {
    const { agent, finalizeUnresumedCheckpoint } = buildAgent({
      rpcCallError: new Error('network error'),
    })
    ;(agent as unknown as { agentHandler: { hasActiveTask: () => boolean } }).agentHandler = { hasActiveTask: () => false }

    const result = await agent.handleResumeTask({ task_id: 'task-err' })

    expect(result.resumed).toBe(false)
    expect(result.reason).toBe('resume_error')
    expect(finalizeUnresumedCheckpoint).toHaveBeenCalledWith('task-err')
  })

  it('assembleScheduledTaskContext 抛错时：finalizeUnresumedCheckpoint 被调用', async () => {
    const { agent, finalizeUnresumedCheckpoint } = buildAgent({
      assembleError: new Error('context assembly failed'),
    })
    ;(agent as unknown as { agentHandler: { hasActiveTask: () => boolean } }).agentHandler = { hasActiveTask: () => false }

    const result = await agent.handleResumeTask({ task_id: 'task-assemble-err' })

    expect(result.resumed).toBe(false)
    expect(result.reason).toBe('resume_error')
    expect(finalizeUnresumedCheckpoint).toHaveBeenCalledWith('task-assemble-err')
  })
})
