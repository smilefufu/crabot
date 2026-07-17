/**
 * registerTriggerAndActivate + runTriggerWorkerLoop 拆分契约测试
 *
 * 只验证拆分契约——不真的跑 worker loop（需要完整 deps），
 * 用 mock rpcClient 验证 register 段把 admin createTask 跑通 + activeTasks.set。
 *
 * Spec: 2026-05-20-session-lane-dispatcher-design.md §3.3
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { AgentHandler } from '../../src/agent/agent-handler.js'
import type { ExecuteTriggerMessageParams } from '../../src/agent/agent-handler.js'
import type { FrontAgentContext } from '../../src/types.js'

// Mock the engine so tests don't actually run the worker loop
vi.mock('../../src/engine/index.js', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>
  return {
    ...actual,
    runEngine: vi.fn(),
  }
})

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
    sender_friend: {
      id: 'f1',
      display_name: 'tester',
      permission: 'master',
      channel_identities: [],
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    } as never,
    recent_messages: [],
    short_term_memories: [],
    active_tasks: [],
    available_tools: [],
    time_windows: {
      recent_messages_window_hours: 4,
      short_term_memory_window_hours: 12,
    },
  }
}

function makeParams(): ExecuteTriggerMessageParams {
  return {
    messages: [{
      platform_message_id: 'm-1',
      session: { session_id: 's1', channel_id: 'c1', type: 'private' },
      sender: { friend_id: 'f1', platform_user_id: 'u1', platform_display_name: 'tester' },
      content: { type: 'text', text: 'hello' },
      features: { is_mention_crab: false },
      platform_timestamp: '2026-05-20T00:00:00Z',
    }],
    activeTasks: [],
    isGroup: false,
    senderFriend: {
      id: 'f1',
      display_name: 'tester',
      permission: 'master',
      channel_identities: [],
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    } as never,
    triggerArrivedAtMs: Date.now(),
    memoryPermissions: {
      write_visibility: 'internal',
      write_scopes: ['s1'],
      read_min_visibility: 'internal',
      read_accessible_scopes: ['s1'],
    } as never,
    resolvedPermissions: { memory_scopes: ['s1'], cli_access: 'all' } as never,
    channelId: 'c1',
    sessionId: 's1',
    frontContext: makeFrontContext(),
  }
}

describe('registerTriggerAndActivate + runTriggerWorkerLoop 拆分契约', () => {
  let handler: AgentHandler
  let createTaskCalls: Array<{ id: string }> = []

  beforeEach(() => {
    vi.clearAllMocks()
    createTaskCalls = []

    const mockRpcCall = vi.fn().mockImplementation(
      async (_port: unknown, method: string, body: { id: string }) => {
        if (method === 'create_task') {
          createTaskCalls.push({ id: body.id })
          return { ok: true }
        }
        return {}
      },
    )

    handler = new AgentHandler(
      makeSdkEnv(),
      { systemPrompt: 'test agent' },
      {
        deps: {
          rpcClient: { call: mockRpcCall } as never,
          moduleId: 'test-agent',
          resolveChannelPort: async () => 3003,
          getMemoryPort: async () => 3002,
          getAdminPort: async () => 0,
        },
      },
    )
  })

  afterEach(() => {
    handler.dispose()
  })

  it('registerTriggerAndActivate 返回后 hasActiveTask=true（in-flight 表已 set）', async () => {
    const pre = await handler.registerTriggerAndActivate(makeParams())
    expect(handler.hasActiveTask(pre.taskId)).toBe(true)
  })

  it('registerTriggerAndActivate 内部 await admin create_task', async () => {
    const pre = await handler.registerTriggerAndActivate(makeParams())
    expect(createTaskCalls).toEqual([{ id: pre.taskId }])
  })

  it('registerTriggerAndActivate 返回的 taskId 形如 trigger-<uuid>', async () => {
    const pre = await handler.registerTriggerAndActivate(makeParams())
    expect(pre.taskId).toMatch(/^trigger-[0-9a-f-]{36}$/)
  })

  it('图文消息用 text 生成 task title', async () => {
    const params = makeParams()
    params.messages[0].content = {
      type: 'image',
      text: '看下这个图上是什么内容',
      media_url: '/tmp/image.png',
    }

    const pre = await handler.registerTriggerAndActivate(params)

    expect(pre.taskTitle).toBe('看下这个图上是什么内容')
  })

  it('纯图片消息保留非文本 task title', async () => {
    const params = makeParams()
    params.messages[0].content = { type: 'image', text: '' }

    const pre = await handler.registerTriggerAndActivate(params)

    expect(pre.taskTitle).toBe('[非文本]')
  })

  it('admin create_task 失败时 registered=false 但仍返回 taskState（best-effort）', async () => {
    const failingHandler = new AgentHandler(
      makeSdkEnv(),
      { systemPrompt: 'test agent' },
      {
        deps: {
          rpcClient: { call: vi.fn().mockRejectedValue(new Error('admin down')) } as never,
          moduleId: 'test-agent-fail',
          resolveChannelPort: async () => 3003,
          getMemoryPort: async () => 3002,
          getAdminPort: async () => 0,
        },
      },
    )

    try {
      const pre = await failingHandler.registerTriggerAndActivate(makeParams())
      expect(pre.registered).toBe(false)
      expect(failingHandler.hasActiveTask(pre.taskId)).toBe(true)
    } finally {
      failingHandler.dispose()
    }
  })

  it('executeTriggerMessage 薄壳 delegate 到 register + run，不漏 traceContext', async () => {
    const params = makeParams()
    const spyReg = vi.spyOn(handler, 'registerTriggerAndActivate')
    const spyRun = vi.spyOn(handler, 'runTriggerWorkerLoop').mockResolvedValue({
      outcome: 'completed',
      finalText: '',
      sentMessage: false,
      overdueInjected: false,
    } as never)
    const fakeTraceCtx = { someField: 'val' } as never
    await handler.executeTriggerMessage(params, undefined, fakeTraceCtx)
    expect(spyReg).toHaveBeenCalledOnce()
    expect(spyRun).toHaveBeenCalledOnce()
    // run 第 4 个参数是 traceContext
    expect(spyRun.mock.calls[0][3]).toBe(fakeTraceCtx)
    spyReg.mockRestore()
    spyRun.mockRestore()
  })
})
