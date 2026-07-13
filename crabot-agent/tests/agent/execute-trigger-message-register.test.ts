/**
 * executeTriggerMessage 超期时 fire-and-forget 调 admin create_task 注册的单测。
 *
 * Spec: crabot-docs/superpowers/specs/2026-05-18-unified-loop-cleanup-design.md §4.2 / §4.4
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { AgentHandler } from '../../src/agent/agent-handler.js'
import type { ExecuteTriggerMessageParams } from '../../src/agent/agent-handler.js'
import type { FrontAgentContext } from '../../src/types.js'

// Mock the engine so we can control overdueConfig triggering
vi.mock('../../src/engine/index.js', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>
  return {
    ...actual,
    runEngine: vi.fn(),
  }
})

import { runEngine } from '../../src/engine/index.js'
const mockRunEngine = vi.mocked(runEngine)

// Helper: base engine result (end_turn)
function makeEngineResult(overrides?: Partial<{
  outcome: 'completed' | 'failed' | 'max_turns' | 'aborted'
  exitToolCall?: { name: string; input: Record<string, unknown> }
  tool_call_count: number
  wrote_memory_or_scene: boolean
}>) {
  return {
    outcome: (overrides?.outcome ?? 'completed') as 'completed' | 'failed' | 'max_turns' | 'aborted',
    finalText: 'done',
    totalTurns: 1,
    tool_call_count: overrides?.tool_call_count ?? 0,
    wrote_memory_or_scene: overrides?.wrote_memory_or_scene ?? false,
    usage: { inputTokens: 10, outputTokens: 5 },
    finalMessages: [] as readonly never[],
    ...(overrides?.exitToolCall ? { exitToolCall: overrides.exitToolCall } : {}),
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

function makeFriend(id = 'friend-1', displayName = 'Test User'): ExecuteTriggerMessageParams['senderFriend'] {
  return {
    id,
    display_name: displayName,
    permission: 'normal',
    channel_identities: [],
    created_at: '2024-01-01T00:00:00.000Z',
    updated_at: '2024-01-01T00:00:00.000Z',
  }
}

function makeFrontContext(): FrontAgentContext {
  return {
    sender_friend: makeFriend(),
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

function makeTriggerParams(overrides?: Partial<ExecuteTriggerMessageParams>): ExecuteTriggerMessageParams {
  return {
    messages: [{
      content: { type: 'text', text: '帮我查一下进度' },
      session: { session_id: 'sess-1', channel_id: 'ch-1', type: 'private' as const },
      sender: { friend_id: 'friend-1', platform_user_id: 'u1', platform_display_name: 'Test User' },
      platform_message_id: 'msg-1',
      features: { is_mention_crab: false },
      platform_timestamp: new Date().toISOString(),
    }],
    activeTasks: [],
    isGroup: false,
    senderFriend: makeFriend(),
    triggerArrivedAtMs: Date.now(),
    timeoutMs: 30_000,
    overdueReminderEnabled: true,
    memoryPermissions: { write_visibility: 'private', write_scopes: [] },
    resolvedPermissions: {} as ExecuteTriggerMessageParams['resolvedPermissions'],
    channelId: 'ch-test-1',
    sessionId: 'sess-test-1',
    frontContext: makeFrontContext(),
    ...overrides,
  }
}

describe('executeTriggerMessage 超期注册到 admin', () => {
  let handler: AgentHandler
  let mockRpcCall: ReturnType<typeof vi.fn>
  let mockGetAdminPort: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.clearAllMocks()

    mockRpcCall = vi.fn().mockResolvedValue({})
    mockGetAdminPort = vi.fn().mockResolvedValue(3001)

    handler = new AgentHandler(makeSdkEnv(), { systemPrompt: 'You are a test agent.' }, {
      deps: {
        rpcClient: { call: mockRpcCall } as any,
        moduleId: 'agent-test',
        resolveChannelPort: async () => 3003,
        getMemoryPort: async () => 3002,
        getAdminPort: mockGetAdminPort,
      },
    })
  })

  afterEach(() => {
    handler.dispose()
  })

  it('启动入口立即调 admin create_task（不论是否超期）', async () => {
    // Engine resolves immediately
    mockRunEngine.mockImplementation(async (_opts) => {
      return makeEngineResult()
    })

    const params = makeTriggerParams()
    const result = await handler.executeTriggerMessage(params)

    expect(result.outcome).toBe('completed')

    // Startup register must have called create_task at least once
    const createTaskCalls = mockRpcCall.mock.calls.filter(
      (call: unknown[]) => call[1] === 'create_task',
    )
    expect(createTaskCalls.length).toBeGreaterThanOrEqual(1)

    // id must start with 'trigger-'
    const [_port, _method, ctParams] = createTaskCalls[0] as [number, string, Record<string, unknown>]
    expect(typeof ctParams.id).toBe('string')
    expect((ctParams.id as string).startsWith('trigger-')).toBe(true)
  })

  it('startup register 后立刻把 admin task 推到 executing（pending→planning→executing），避免后续 ask_human 因状态机非法 transition 被拒', async () => {
    // Trace 4751612f 复现：trigger 路径从来不切 admin 状态机，
    // admin 上 task 长期停在 pending，导致：
    // ① 历史 trigger task 永远 pending → Front 看到的 active_tasks 累积 phantom
    // ② worker 调 ask_human → admin pending→waiting_human 状态机拒 → setBarrier 跳过 → loop 不阻塞
    mockRunEngine.mockImplementation(async () => makeEngineResult())

    const params = makeTriggerParams()
    await handler.executeTriggerMessage(params)

    // wait for any best-effort RPC chains to settle
    await new Promise(r => setTimeout(r, 20))

    // 收集所有 status transition 调用
    const statusCalls = mockRpcCall.mock.calls.filter(
      (call: unknown[]) => call[1] === 'update_task_status',
    ) as Array<[number, string, Record<string, unknown>, string]>

    const createTaskCalls = mockRpcCall.mock.calls.filter(
      (call: unknown[]) => call[1] === 'create_task',
    ) as Array<[number, string, Record<string, unknown>, string]>
    expect(createTaskCalls.length).toBeGreaterThanOrEqual(1)
    const syntheticTaskId = createTaskCalls[0][2].id as string

    // 至少应该有两次 status transition：planning 和 executing
    const targetedTransitions = statusCalls.filter(c => c[2].task_id === syntheticTaskId)
    const planningCall = targetedTransitions.find(c => c[2].status === 'planning')
    const executingCall = targetedTransitions.find(c => c[2].status === 'executing')

    expect(planningCall).toBeDefined()
    expect(executingCall).toBeDefined()

    // 顺序：create_task → planning → executing
    const allCallsForTask = mockRpcCall.mock.calls.filter(
      (call: unknown[]) => (call[2] as Record<string, unknown>)?.id === syntheticTaskId
        || (call[2] as Record<string, unknown>)?.task_id === syntheticTaskId,
    )
    const createIdx = allCallsForTask.findIndex(c => c[1] === 'create_task')
    const planningIdx = allCallsForTask.findIndex(c =>
      c[1] === 'update_task_status' && (c[2] as Record<string, unknown>).status === 'planning',
    )
    const executingIdx = allCallsForTask.findIndex(c =>
      c[1] === 'update_task_status' && (c[2] as Record<string, unknown>).status === 'executing',
    )
    expect(createIdx).toBeLessThan(planningIdx)
    expect(planningIdx).toBeLessThan(executingIdx)
  })

  it('register 阶段的 planning/executing transition 失败时不阻塞主 loop（best-effort）', async () => {
    // 状态机切换是 best-effort——admin 不可用时只 log 不抛
    mockRunEngine.mockImplementation(async () => makeEngineResult())

    mockRpcCall.mockImplementation(async (_port: number, method: string) => {
      if (method === 'update_task_status') {
        throw new Error('admin RPC unavailable')
      }
      return {}
    })

    const params = makeTriggerParams()
    // 直接 await——不抛即视为不阻塞主 loop；抛了 vitest 自然 fail
    const result = await handler.executeTriggerMessage(params)
    expect(result.outcome).toBe('completed')
  })

  it('dispatchActionText 不再污染 task title，标题始终来自原始消息切片', async () => {
    mockRunEngine.mockImplementation(async (_opts) => makeEngineResult())

    const params = makeTriggerParams({
      dispatchActionText: 'Dispatch LLM 抽象后的任务摘要：用新数据源重做 L2 并做对比',
    } as never)
    await handler.executeTriggerMessage(params)

    const createTaskCalls = mockRpcCall.mock.calls.filter(
      (call: unknown[]) => call[1] === 'create_task',
    )
    expect(createTaskCalls.length).toBeGreaterThanOrEqual(1)

    const [, , ctParams] = createTaskCalls[0] as [number, string, Record<string, unknown>]
    expect(ctParams.title).toBe('帮我查一下进度')
  })

  it('缺省 dispatchActionText 时回退到原始消息切片', async () => {
    mockRunEngine.mockImplementation(async (_opts) => makeEngineResult())

    const params = makeTriggerParams()
    await handler.executeTriggerMessage(params)

    const createTaskCalls = mockRpcCall.mock.calls.filter(
      (call: unknown[]) => call[1] === 'create_task',
    )
    expect(createTaskCalls.length).toBeGreaterThanOrEqual(1)

    const [, , ctParams] = createTaskCalls[0] as [number, string, Record<string, unknown>]
    expect(ctParams.title).toBe('帮我查一下进度')
  })
})
