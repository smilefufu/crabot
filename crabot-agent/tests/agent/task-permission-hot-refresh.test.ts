/**
 * 任务权限热刷新回归测试
 *
 * Spec: 2026-07-20-task-permission-hot-refresh-design.md
 *
 * 覆盖：
 * 1. AgentHandler：taskState 权限持有者初始化 / updateTaskPermissions 热替换 /
 *    getTaskPrincipal 原发起人身份 / per-task 隔离 / runEngine getResolvedPermissions 接线
 * 2. UnifiedAgent.refreshTaskPermissions（supplement 触发点）：原身份重新解析 + fail-soft
 * 3. UnifiedAgent resumeTaskInternal（resume 触发点）：新解析覆盖 checkpoint 快照 + 失败回退
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { AgentHandler } from '../../src/agent/agent-handler.js'
import type { ExecuteTriggerMessageParams } from '../../src/agent/agent-handler.js'
import { UnifiedAgent } from '../../src/unified-agent.js'
import { AGENT_VERSION } from '../../src/constants.js'
import type { Friend, FrontAgentContext, ResolvedPermissions } from '../../src/types.js'

// Mock the engine so tests don't actually run the worker loop
vi.mock('../../src/engine/index.js', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>
  return {
    ...actual,
    runEngine: vi.fn(),
  }
})
import { runEngine } from '../../src/engine/index.js'

const FULL_TOOL_ACCESS = {
  memory: true, messaging: true, task: true,
  mcp_skill: true, file_io: true, browser: true,
  shell: true, remote_exec: true, desktop: true,
}
const NONE_CLI_ACCESS = {
  provider: 'none' as const, agent: 'none' as const, mcp: 'none' as const,
  skill: 'none' as const, schedule: 'none' as const, channel: 'none' as const,
  friend: 'none' as const, permission: 'none' as const, config: 'none' as const,
  undo: 'none' as const,
}

const OLD_PERMS: ResolvedPermissions = {
  tool_access: { ...FULL_TOOL_ACCESS },
  cli_access: { ...NONE_CLI_ACCESS },
  storage: null,
  memory_scopes: ['s1'],
}
const FRESH_PERMS: ResolvedPermissions = {
  tool_access: { ...FULL_TOOL_ACCESS },
  cli_access: { ...NONE_CLI_ACCESS, provider: 'read' },
  storage: null,
  memory_scopes: ['s1'],
}

function makeFriend(id: string): Friend {
  return {
    id,
    display_name: id,
    permission: 'normal',
    channel_identities: [],
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  }
}

function makeSdkEnv() {
  return {
    modelId: 'test-model',
    format: 'anthropic' as const,
    env: {
      ANTHROPIC_BASE_URL: 'http://localhost:4000',
      ANTHROPIC_API_KEY: 'test-key',
    },
  }
}

function makeFrontContext(): FrontAgentContext {
  return {
    sender_friend: makeFriend('f1'),
    recent_messages: [],
    short_term_memories: [],
    active_tasks: [],
    available_tools: [],
    time_windows: {
      recent_messages_window_hours: 4,
      short_term_memory_window_hours: 12,
    },
  } as unknown as FrontAgentContext
}

function makeParams(sessionId = 's1'): ExecuteTriggerMessageParams {
  return {
    messages: [{
      platform_message_id: 'm-1',
      session: { session_id: sessionId, channel_id: 'c1', type: 'private' },
      sender: { friend_id: 'f1', platform_user_id: 'u1', platform_display_name: 'tester' },
      content: { type: 'text', text: 'hello' },
      features: { is_mention_crab: false },
      platform_timestamp: '2026-07-20T00:00:00Z',
    }],
    activeTasks: [],
    isGroup: false,
    senderFriend: makeFriend('f1'),
    triggerArrivedAtMs: Date.now(),
    memoryPermissions: {
      write_visibility: 'internal',
      write_scopes: [sessionId],
      read_min_visibility: 'internal',
      read_accessible_scopes: [sessionId],
    } as never,
    resolvedPermissions: OLD_PERMS,
    channelId: 'c1',
    sessionId,
    frontContext: makeFrontContext(),
  }
}

function makeHandler(): AgentHandler {
  return new AgentHandler(
    makeSdkEnv(),
    { systemPrompt: 'test agent' },
    {
      deps: {
        rpcClient: { call: vi.fn().mockResolvedValue({}) } as never,
        moduleId: 'test-agent',
        resolveChannelPort: async () => 3003,
        getMemoryPort: async () => 3002,
        getAdminPort: async () => 0,
      },
    },
  )
}

type HandlerInternals = {
  activeTasks: Map<string, {
    resolvedPermissions?: ResolvedPermissions
    resumeWorkerContext?: { resolved_permissions?: ResolvedPermissions }
  }>
}

function internalsOf(handler: AgentHandler): HandlerInternals {
  return handler as unknown as HandlerInternals
}

/** 启动一个 runEngine 永不返回的 in-flight worker loop，返回 taskId 与 engine options */
async function startPendingLoop(handler: AgentHandler, sessionId = 's1') {
  ;(runEngine as ReturnType<typeof vi.fn>).mockImplementation(
    () => new Promise(() => { /* never resolves: keep task in-flight */ }),
  )
  const params = makeParams(sessionId)
  const pre = await handler.registerTriggerAndActivate(params)
  void handler.runTriggerWorkerLoop(params, pre).catch(() => {})
  await vi.waitFor(() => {
    expect(runEngine as ReturnType<typeof vi.fn>).toHaveBeenCalled()
  })
  const engineOptions = (runEngine as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0].options as {
    getResolvedPermissions?: () => ResolvedPermissions | undefined
  }
  return { taskId: pre.taskId, engineOptions }
}

describe('AgentHandler 任务权限持有者', () => {
  const handler = makeHandler()

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('loop 启动后持有者初始化为 context 权限，engine 收到 getResolvedPermissions', async () => {
    const h = makeHandler()
    const { engineOptions } = await startPendingLoop(h)
    expect(engineOptions.getResolvedPermissions).toBeTypeOf('function')
    expect(engineOptions.getResolvedPermissions!()).toEqual(OLD_PERMS)
    h.dispose()
  })

  it('updateTaskPermissions 热替换持有者 + resumeWorkerContext 快照，engine getter 立即读到新值', async () => {
    const h = makeHandler()
    const { taskId, engineOptions } = await startPendingLoop(h)

    h.updateTaskPermissions(taskId, FRESH_PERMS)

    expect(engineOptions.getResolvedPermissions!()).toEqual(FRESH_PERMS)
    const ts = internalsOf(h).activeTasks.get(taskId)
    expect(ts?.resolvedPermissions).toEqual(FRESH_PERMS)
    expect(ts?.resumeWorkerContext?.resolved_permissions).toEqual(FRESH_PERMS)
    h.dispose()
  })

  it('getTaskPrincipal 返回任务原发起人身份（用于按原身份重新解析）', async () => {
    const h = makeHandler()
    const { taskId } = await startPendingLoop(h)

    const principal = h.getTaskPrincipal(taskId)
    expect(principal).toEqual({
      senderFriend: expect.objectContaining({ id: 'f1' }),
      sessionId: 's1',
      sessionType: 'private',
    })
    expect(h.getTaskPrincipal('task-not-exist')).toBeNull()
    h.dispose()
  })

  it('per-task 隔离：刷新 A 任务不影响 B 任务', async () => {
    const h = makeHandler()
    const a = await startPendingLoop(h, 'sa')
    const b = await startPendingLoop(h, 'sb')

    h.updateTaskPermissions(a.taskId, FRESH_PERMS)

    expect(internalsOf(h).activeTasks.get(a.taskId)?.resolvedPermissions).toEqual(FRESH_PERMS)
    expect(internalsOf(h).activeTasks.get(b.taskId)?.resolvedPermissions).toEqual(OLD_PERMS)
    h.dispose()
  })

  it('对不存在的任务调用 updateTaskPermissions 静默 no-op', () => {
    const h = makeHandler()
    expect(() => h.updateTaskPermissions('nope', FRESH_PERMS)).not.toThrow()
    h.dispose()
  })

  it('scheduled 任务（带 target_session、无 sender_friend）不返回 principal（review #38 回归）', () => {
    const h = makeHandler()
    internalsOf(h).activeTasks.set('sched-1', {
      resolvedPermissions: OLD_PERMS,
      resumeWorkerContext: {
        resolved_permissions: OLD_PERMS,
        // 带 target_session 的 scheduled 任务也有 task_origin —— 只判 session 会误判
        task_origin: { channel_id: 'c1', session_id: 'group-s1', session_type: 'group' },
      },
      triggerType: 'scheduled',
    } as never)

    expect(h.getTaskPrincipal('sched-1')).toBeNull()
    h.dispose()
  })
})

// ---------------------------------------------------------------------------
// UnifiedAgent 触发点（Object.create 轻量 harness，同 resolve-principal.test.ts）
// ---------------------------------------------------------------------------

type RefreshFn = (taskId: string) => Promise<void>
type ResumeFn = (params: { task_id: string }) => Promise<{ resumed: boolean; reason?: string }>

function buildAgentStub(rpcCall: ReturnType<typeof vi.fn>) {
  const agent = Object.create(UnifiedAgent.prototype) as Record<string, unknown>
  agent.config = { moduleId: 'test-agent' }
  agent.rpcClient = { call: rpcCall }
  agent.getAdminPort = async () => 19001
  return agent
}

describe('UnifiedAgent.refreshTaskPermissions（supplement 触发点）', () => {
  it('用任务原发起人身份重新解析并热替换', async () => {
    const rpcCall = vi.fn().mockResolvedValue({ resolved: FRESH_PERMS, sources: {} })
    const agent = buildAgentStub(rpcCall)
    const updateTaskPermissions = vi.fn()
    agent.agentHandler = {
      getTaskPrincipal: () => ({
        senderFriend: makeFriend('original-sender'),
        sessionId: 'group-s1',
        sessionType: 'group',
      }),
      updateTaskPermissions,
    }

    await (agent as { refreshTaskPermissions: RefreshFn }).refreshTaskPermissions('task-1')

    expect(rpcCall).toHaveBeenCalledWith(
      19001,
      'resolve_principal_permissions',
      { sender_friend_id: 'original-sender', session_id: 'group-s1', session_type: 'group' },
      'test-agent',
    )
    expect(updateTaskPermissions).toHaveBeenCalledWith('task-1', FRESH_PERMS)
  })

  it('解析失败（admin 不可达）→ 保留当前权限，不抛错', async () => {
    const rpcCall = vi.fn().mockRejectedValue(new Error('admin down'))
    const agent = buildAgentStub(rpcCall)
    const updateTaskPermissions = vi.fn()
    agent.agentHandler = {
      getTaskPrincipal: () => ({ senderFriend: makeFriend('f1'), sessionId: 's1', sessionType: 'private' }),
      updateTaskPermissions,
    }

    await expect(
      (agent as { refreshTaskPermissions: RefreshFn }).refreshTaskPermissions('task-1'),
    ).resolves.toBeUndefined()
    expect(updateTaskPermissions).not.toHaveBeenCalled()
  })

  it('非消息触发任务（无 principal）→ 不发起解析', async () => {
    const rpcCall = vi.fn()
    const agent = buildAgentStub(rpcCall)
    agent.agentHandler = {
      getTaskPrincipal: () => null,
      updateTaskPermissions: vi.fn(),
    }

    await (agent as { refreshTaskPermissions: RefreshFn }).refreshTaskPermissions('task-1')
    expect(rpcCall).not.toHaveBeenCalled()
  })
})

describe('UnifiedAgent resumeTaskInternal（resume 触发点）', () => {
  function buildResumeAgent(rpcCall: ReturnType<typeof vi.fn>) {
    const agent = buildAgentStub(rpcCall)
    agent.agentHandler = { hasActiveTask: () => false }
    agent.getCheckpointForResume = () => ({
      traceId: 'trace-1',
      checkpoint: {
        agent_version: AGENT_VERSION,
        system_prompt: '',
        messages: [{ role: 'user', content: 'hi' }],
        worker_state: {
          todo_items: [],
          goal_revision_unlocked: false,
          human_input_epoch: 0,
          last_delivered_info_epoch: 0,
        },
        worker_context: {
          task_origin: { channel_id: 'c1', session_id: 's1', session_type: 'group' },
          sender_friend: makeFriend('original-sender'),
          resolved_permissions: OLD_PERMS,
        },
      },
    })
    agent.contextAssembler = { assembleScheduledTaskContext: async () => ({}) }
    const executeAgentLoopInBackground = vi.fn()
    agent.agentLoopSubstrate = { executeAgentLoopInBackground }
    return { agent, executeAgentLoopInBackground }
  }

  const GET_TASK_RESULT = {
    task: {
      id: 'task-1',
      title: 't',
      priority: 'normal',
      source: { trigger_type: 'message', channel_id: 'c1', session_id: 's1' },
    },
  }

  it('resume 用原发起人身份重新解析，覆盖 checkpoint 冻结快照', async () => {
    const rpcCall = vi.fn().mockImplementation(async (_port: unknown, method: string) => {
      if (method === 'get_task') return GET_TASK_RESULT
      if (method === 'resolve_principal_permissions') return { resolved: FRESH_PERMS, sources: {} }
      return {}
    })
    const { agent, executeAgentLoopInBackground } = buildResumeAgent(rpcCall)

    const result = await (agent as { resumeTaskInternal: ResumeFn }).resumeTaskInternal({ task_id: 'task-1' })

    expect(result.resumed).toBe(true)
    const payload = executeAgentLoopInBackground.mock.calls[0][0] as {
      context: { resolved_permissions?: ResolvedPermissions }
    }
    expect(payload.context.resolved_permissions).toEqual(FRESH_PERMS)
    // 解析用原发起人身份
    expect(rpcCall).toHaveBeenCalledWith(
      19001,
      'resolve_principal_permissions',
      { sender_friend_id: 'original-sender', session_id: 's1', session_type: 'group' },
      'test-agent',
    )
  })

  it('resume 时解析失败 → 回退 checkpoint 快照', async () => {
    const rpcCall = vi.fn().mockImplementation(async (_port: unknown, method: string) => {
      if (method === 'get_task') return GET_TASK_RESULT
      if (method === 'resolve_principal_permissions') throw new Error('admin down')
      return {}
    })
    const { agent, executeAgentLoopInBackground } = buildResumeAgent(rpcCall)

    const result = await (agent as { resumeTaskInternal: ResumeFn }).resumeTaskInternal({ task_id: 'task-1' })

    expect(result.resumed).toBe(true)
    const payload = executeAgentLoopInBackground.mock.calls[0][0] as {
      context: { resolved_permissions?: ResolvedPermissions }
    }
    expect(payload.context.resolved_permissions).toEqual(OLD_PERMS)
  })

  it('scheduled 任务（带 target_session）resume 不重新解析，保留 creator 下发的 checkpoint 权限（review #38 回归）', async () => {
    const rpcCall = vi.fn().mockImplementation(async (_port: unknown, method: string) => {
      if (method === 'get_task') {
        return {
          task: {
            id: 'task-1',
            title: 't',
            priority: 'normal',
            source: { trigger_type: 'scheduled', channel_id: 'c1', session_id: 's1' },
          },
        }
      }
      return {}
    })
    const { agent, executeAgentLoopInBackground } = buildResumeAgent(rpcCall)

    const result = await (agent as { resumeTaskInternal: ResumeFn }).resumeTaskInternal({ task_id: 'task-1' })

    expect(result.resumed).toBe(true)
    const payload = executeAgentLoopInBackground.mock.calls[0][0] as {
      context: { resolved_permissions?: ResolvedPermissions }
    }
    expect(payload.context.resolved_permissions).toEqual(OLD_PERMS)
    // 不得发起匿名会话重解析
    expect(
      rpcCall.mock.calls.some((c) => c[1] === 'resolve_principal_permissions'),
    ).toBe(false)
  })
})
