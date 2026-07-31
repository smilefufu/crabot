/**
 * 入站链路测试网 ②：`processDirectBatch`（P7 / PR A Task 2）。
 *
 * 计划：`crabot-docs/superpowers/plans/2026-07-31-mw-p7-a-inbound-test-net.md`
 * 侦察：`.superpowers/sdd/p7-recon.md` §A.2 —— "processDirectBatch 在 dispatcher 之前做的 8 件事"
 *
 * ## 覆盖的 8 个动作（含顺序）
 *
 * | 动作 | 生产位置 |
 * |---|---|
 * | `sessionManager.updateLastMessageTime` | `unified-agent.ts:786` |
 * | `traceStore.startTrace(trigger.type='message')` | `:789-799` |
 * | `resolvePrincipalPermissions` → `ResolvedPermissions` | `:807` |
 * | memory 权限档位（按 friend 的 memory_scopes） | `:809-816` |
 * | `contextAssembler.assembleFrontContext` | `:831-845` |
 * | `buildQuotedPrefetchDeps()`（引用预取） | `:887` |
 * | `sendErrorToUser` / `sendImmediateReply` | `:865-882` |
 * | `reactToTriggerMessage` | `:913` |
 *
 * ## 手法（沿用 Task 1 的结论）
 *
 * - **真实构造函数**（`roles: []`，不建 AgentHandler / 不起 LSP），只在实例上换掉
 *   `agentHandler` / `contextAssembler` / `sdkEnvWorker` / `rpcClient` 这几个外部边界；
 * - **只 mock 模块级 `dispatch`**（LLM 入口，无实例注入口），
 *   **`executeDispatchActions` 用真件**——M8（reaction）/ M11（预回复 vs spawn 顺序）/
 *   supplement 三分支的语义恰恰长在执行器里，把执行器也 mock 掉就只剩参数透传可断言；
 * - **`traceStore` 用真实的**（tmp `DATA_DIR`）：trace/span 是这条链路的可观测事实来源，
 *   顺序、早退分支、supplement 走的哪条路都从 span 上读；
 * - **顺序断言只用一条 `calls: string[]` 序列**，不用各自的 `toHaveBeenCalled`；
 * - 全链路无 `setTimeout`，不引 fake timer（会和 TraceStore / manager 栈的内部 timer 打架）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

import { UnifiedAgent } from '../../src/unified-agent.js'
import { prefetchQuotedMessages } from '../../src/agent/quoted-message-prefetcher.js'
import type { QuotedMessageEntry } from '../../src/prompt-manager.js'
import type {
  AgentTrace,
  ChannelMessage,
  Friend,
  MemoryPermissions,
  ResolvedPermissions,
  TaskSummary,
  ToolAccessConfig,
} from '../../src/types.js'
import type { DispatchAction, DispatchContext } from '../../src/dispatcher/dispatcher-types.js'
import type { DispatchDeps } from '../../src/dispatcher/dispatcher.js'
import { makeAgentConfig, makeFriend, makeMessage, useTmpDataDir, type DataDirGuard } from './harness.js'

// dispatch 是模块级 import，没有实例注入口——这是本文件唯一 mock 掉的生产模块。
vi.mock('../../src/dispatcher/dispatcher.js', () => ({ dispatch: vi.fn() }))
import { dispatch } from '../../src/dispatcher/dispatcher.js'

const dispatchMock = vi.mocked(dispatch)

// ============================================================================
// fixtures
// ============================================================================

const ADMIN_PORT = 18000
const WECHAT_PORT = 18001

/** 该 friend 解析出的权限身份：shell 开、file_io 关，memory_scopes 是两个私聊专属 scope。 */
const FRIEND_TOOL_ACCESS: ToolAccessConfig = {
  memory: true,
  messaging: true,
  task: true,
  mcp_skill: true,
  file_io: false,
  browser: false,
  shell: true,
  remote_exec: false,
  desktop: false,
}

const FRIEND_PERMS: ResolvedPermissions = {
  tool_access: FRIEND_TOOL_ACCESS,
  cli_access: {} as ResolvedPermissions['cli_access'],
  storage: null,
  memory_scopes: ['friend-scope-a', 'friend-scope-b'],
}

/** 上下文装配吐出的历史消息（不属于当前触发批次）。 */
const HISTORY_MESSAGE = makeMessage({
  id: 'hist-1',
  type: 'private',
  text: '昨天说的那个 PDF',
  timestamp: '2026-07-30T10:00:00.000Z',
})

const SCENE_PROFILE = {
  label: '私聊场景',
  content: '这个人喜欢直接给结论',
  source: { scene: { type: 'friend' as const, friend_id: 'f-1' } },
}

const ACTIVE_TASK: TaskSummary = {
  task_id: 'task-active-1',
  title: '在跑的任务',
  status: 'executing',
  priority: 'normal',
}

/** 已终止的 supplement 候选——只可能来自 assembleFrontContext.supplement_candidates。 */
const TERMINAL_CANDIDATE: TaskSummary = {
  task_id: 'task-terminal-1',
  title: '刚做完的任务',
  status: 'completed',
  priority: 'normal',
  candidate_kind: 'recent_terminal',
  completed_at: '2026-07-31T00:00:00.000Z',
}

interface AssembleCall {
  params: {
    channel_id: string
    session_id: string
    sender_id: string
    message: string
    friend_id: string
    session_type: string
    crab_self_handle?: string
  }
  friend: Friend | undefined
  memPerms: MemoryPermissions
}

interface SpawnCall {
  messages: ReadonlyArray<ChannelMessage>
  activeTasks: ReadonlyArray<TaskSummary>
  isGroup: boolean
  senderFriend: Friend
  memoryPermissions: MemoryPermissions
  resolvedPermissions: ResolvedPermissions
  channelId: string
  sessionId: string
  frontContext: { recent_messages: ChannelMessage[]; scene_profile?: unknown }
  sceneProfile?: unknown
}

interface Internals {
  processDirectBatch(batch: ReadonlyArray<{ message: ChannelMessage; friend: Friend }>): Promise<void>
  sessionManager: {
    updateLastMessageTime(sessionId: string): void
    getSession(sessionId: string): { message_count: number; last_message_time: number } | undefined
  }
  traceStore: {
    getTraces(limit?: number): { traces: AgentTrace[] }
    startTrace(params: { trigger: { type: string } }): { trace_id: string }
  }
  contextAssembler: unknown
  agentHandler: unknown
  sdkEnvWorker: unknown
  channelPorts: Map<string, number>
  crabSelfHandles: Map<string, string>
  attentionScheduler: { stopAll(): void }
  rpcClient: {
    call: (port: number, method: string, params: unknown, from?: string) => Promise<unknown>
    resolve: (filter: unknown, from?: string) => Promise<unknown[]>
  }
}

describe('processDirectBatch —— 私聊 lane handler（P7/PR A 测试网 ②）', () => {
  let dataDir: DataDirGuard
  let agent: UnifiedAgent
  let internals: Internals

  /** 唯一的顺序事实来源。 */
  let calls: string[]
  let rpcCalls: Array<{ port: number; method: string; params: Record<string, unknown> }>
  let assembleCalls: AssembleCall[]
  let spawnCalls: SpawnCall[]
  let deliverCalls: Array<{ taskId: string; messages: ReadonlyArray<ChannelMessage> }>
  let capturedCtx: DispatchContext | undefined
  let capturedDeps: DispatchDeps | undefined

  // 可按测试改写的响应
  let permsResponse: ResolvedPermissions | 'throw'
  let sessionScopes: string[]
  let supplementCandidates: TaskSummary[]
  let activeTasks: TaskSummary[]
  let recentMessages: ChannelMessage[]
  let hasActiveTaskResult: boolean
  /** worker loop 的放行闸：默认立即完成；M10 用它把 worker 挂住。 */
  let workerGate: Promise<void> | undefined
  let workerSettled: boolean

  function boot(opts: { withHandler?: boolean; withSdkEnv?: boolean } = {}): void {
    agent = new UnifiedAgent(makeAgentConfig({ configured: true, moduleId: 'direct-batch-agent', port: 19997 }))
    internals = agent as unknown as Internals

    internals.channelPorts.set('wechat', WECHAT_PORT)
    internals.crabSelfHandles.set('wechat', '@crabot_wx')

    internals.rpcClient.resolve = async () => [
      { module_id: 'admin', module_type: 'admin', host: 'localhost', port: ADMIN_PORT, status: 'running' },
    ]
    internals.rpcClient.call = async (port, method, params) => {
      rpcCalls.push({ port, method, params: params as Record<string, unknown> })
      switch (method) {
        case 'resolve_principal_permissions':
          calls.push('resolve_permissions')
          if (permsResponse === 'throw') throw new Error('admin unreachable')
          return { resolved: permsResponse, sources: {} }
        case 'get_session_config':
          calls.push('get_session_config')
          return { config: { memory_scopes: sessionScopes } }
        case 'send_message':
          calls.push('send_message')
          return { platform_message_id: 'ack-1', sent_at: '2026-07-31T00:00:05.000Z' }
        case 'add_reaction':
          calls.push('add_reaction')
          return {}
        case 'get_message':
          calls.push('get_message')
          return {
            platform_message_id: (params as { platform_message_id: string }).platform_message_id,
            sender: { platform_user_id: 'u-1', platform_display_name: '张三' },
            content: { type: 'text', text: '这是跨窗口引用的原文' },
            features: {},
            platform_timestamp: '2026-07-20T00:00:00.000Z',
          }
        case 'revive_task_for_supplement':
          calls.push('revive_task_for_supplement')
          return {}
        default:
          return {}
      }
    }

    // trace 起点：按 trigger 类型区分 dispatch trace 与 task trace。
    const realStartTrace = internals.traceStore.startTrace.bind(internals.traceStore)
    internals.traceStore.startTrace = (params) => {
      calls.push(`start_trace:${params.trigger.type}`)
      return realStartTrace(params)
    }

    const realUpdate = internals.sessionManager.updateLastMessageTime.bind(internals.sessionManager)
    internals.sessionManager.updateLastMessageTime = (sessionId: string) => {
      calls.push('update_last_message_time')
      realUpdate(sessionId)
    }

    internals.contextAssembler = {
      assembleFrontContext: async (
        params: AssembleCall['params'],
        friend: Friend | undefined,
        memPerms: MemoryPermissions,
      ) => {
        calls.push('assemble_front_context')
        assembleCalls.push({ params, friend, memPerms })
        return {
          sender_friend: friend,
          recent_messages: recentMessages,
          short_term_memories: [],
          active_tasks: activeTasks,
          available_tools: [],
          scene_profile: SCENE_PROFILE,
          crab_self_handle: '@crabot_wx',
          time_windows: { recent_messages_window_hours: 24, short_term_memory_window_hours: 24 },
          supplement_candidates: supplementCandidates,
        }
      },
    }

    if (opts.withHandler !== false) {
      internals.agentHandler = {
        hasActiveTask: () => hasActiveTaskResult,
        deliverHumanResponse: (taskId: string, messages: ReadonlyArray<ChannelMessage>) => {
          calls.push('deliver_human_response')
          deliverCalls.push({ taskId, messages })
        },
        getTaskPrincipal: () => undefined,
        updateTaskPermissions: () => {},
        getInflightSnapshot: () => [],
        registerTriggerAndActivate: async (params: SpawnCall) => {
          calls.push('register_trigger')
          spawnCalls.push(params)
          return {
            taskId: 'task-new-1',
            registered: true,
            task: {},
            context: {},
            taskTitle: '新任务标题',
          }
        },
        runTriggerWorkerLoop: async () => {
          calls.push('worker_loop')
          if (workerGate) await workerGate
          workerSettled = true
          return { outcome: 'completed', finalText: '搞定', sentMessage: true }
        },
      }
    }

    if (opts.withSdkEnv !== false) {
      internals.sdkEnvWorker = {
        modelId: 'worker-model',
        format: 'anthropic',
        env: { LLM_BASE_URL: 'https://example.invalid', LLM_API_KEY: 'k' },
      }
    }
  }

  /** 设定 dispatcher 的输出；同时录 ctx/deps 供引用预取等断言使用。 */
  function setDispatchActions(actions: DispatchAction[]): void {
    dispatchMock.mockImplementation(async (ctx, deps) => {
      calls.push('dispatch')
      capturedCtx = ctx
      capturedDeps = deps
      return { actions }
    })
  }

  function batchOf(messages: ChannelMessage[], friend = makeFriend('f-1')) {
    return messages.map((message) => ({ message, friend }))
  }

  function dispatchTrace(): AgentTrace {
    const t = internals.traceStore.getTraces(50).traces.find((x) => x.trigger.type === 'message')
    if (!t) throw new Error('dispatch trace not found')
    return t
  }

  function actionSpanDetails(): Record<string, unknown> {
    const span = dispatchTrace().spans.find((s) => s.type === 'dispatch_action')
    if (!span) throw new Error('dispatch_action span not found')
    return (span.details ?? {}) as Record<string, unknown>
  }

  beforeEach(async () => {
    calls = []
    rpcCalls = []
    assembleCalls = []
    spawnCalls = []
    deliverCalls = []
    capturedCtx = undefined
    capturedDeps = undefined
    permsResponse = FRIEND_PERMS
    sessionScopes = ['session-scope-1']
    supplementCandidates = [ACTIVE_TASK]
    activeTasks = [ACTIVE_TASK]
    recentMessages = [HISTORY_MESSAGE]
    hasActiveTaskResult = true
    workerGate = undefined
    workerSettled = false
    dispatchMock.mockReset()
    setDispatchActions([{ kind: 'new_task' }])
    dataDir = await useTmpDataDir('inbound-pdb-')
  })

  afterEach(async () => {
    internals?.attentionScheduler.stopAll()
    vi.restoreAllMocks()
    await dataDir.restore()
  })

  // ==========================================================================
  // 动作 1 / 2：会话状态与 trace 起点
  // ==========================================================================

  describe('会话状态与 trace 起点', () => {
    it('整批只推进一次会话活跃时间（每条消息各推一次会把 TTL 语义算错）', async () => {
      boot()
      await internals.processDirectBatch(
        batchOf([
          makeMessage({ id: 'm-1', type: 'private', text: '第一条' }),
          makeMessage({ id: 'm-2', type: 'private', text: '第二条' }),
        ]),
      )

      const session = internals.sessionManager.getSession('sess-1')
      expect(session).toBeDefined()
      expect(session!.message_count).toBe(1)
      expect(calls.filter((c) => c === 'update_last_message_time')).toHaveLength(1)
    })

    it('trace 记的是 message 触发、批内每条消息都进 summary、source 是来源 channel（变异靶 M2）', async () => {
      boot()
      await internals.processDirectBatch(
        batchOf([
          makeMessage({ id: 'm-1', type: 'private', text: '第一条' }),
          makeMessage({ id: 'm-2', type: 'private', text: '第二条' }),
        ]),
      )

      const trace = dispatchTrace()
      expect(trace.trigger.type).toBe('message')
      expect(trace.trigger.source).toBe('wechat')
      expect(trace.trigger.summary).toBe('[private×2] 第一条 | 第二条')
      expect(trace.module_id).toBe('direct-batch-agent')
    })

    it('空 batch 直接返回：不动会话、不建 trace', async () => {
      boot()
      await internals.processDirectBatch([])

      expect(calls).toEqual([])
      expect(internals.traceStore.getTraces(50).traces).toHaveLength(0)
    })
  })

  // ==========================================================================
  // 动作 3：权限身份解析（M4）
  // ==========================================================================

  describe('权限身份解析（变异靶 M4）', () => {
    it('解析出的身份决定这轮之后 worker 能用哪些工具', async () => {
      boot()
      await internals.processDirectBatch(batchOf([makeMessage({ id: 'm-1', type: 'private' })]))

      // 语义落点①：worker 拿到的执行身份
      expect(spawnCalls).toHaveLength(1)
      expect(spawnCalls[0].resolvedPermissions?.tool_access.shell).toBe(true)
      expect(spawnCalls[0].resolvedPermissions?.tool_access.file_io).toBe(false)

      // 语义落点②：会话级权限被记住——后续按此身份授权工具（shell 放行、file_io 拦）
      expect(
        agent.getToolPermissionConfig([
          { name: 'bash', description: '', inputSchema: {}, category: 'shell' },
        ]),
      ).toEqual({ mode: 'bypass' })
      expect(
        agent.getToolPermissionConfig([
          { name: 'write_file', description: '', inputSchema: {}, category: 'file_io' },
        ]),
      ).toEqual({ mode: 'denyList', toolNames: ['write_file'] })

      // 解析请求打的是 admin，带的是这条私聊会话的身份三元组
      const resolveCall = rpcCalls.find((c) => c.method === 'resolve_principal_permissions')
      expect(resolveCall).toBeDefined()
      expect(resolveCall!.port).toBe(ADMIN_PORT)
      expect(resolveCall!.params).toMatchObject({
        sender_friend_id: 'f-1',
        session_id: 'sess-1',
        session_type: 'private',
      })
    })

    it('解析失败时 fail-closed（只剩 messaging），不是放开也不是沿用上一轮', async () => {
      boot()
      permsResponse = 'throw'
      await internals.processDirectBatch(batchOf([makeMessage({ id: 'm-1', type: 'private' })]))

      expect(
        agent.getToolPermissionConfig([
          { name: 'bash', description: '', inputSchema: {}, category: 'shell' },
          { name: 'send_message', description: '', inputSchema: {}, category: 'messaging' },
        ]),
      ).toEqual({ mode: 'denyList', toolNames: ['bash'] })
    })
  })

  // ==========================================================================
  // 动作 4：memory 权限档位（M5）
  // ==========================================================================

  describe('memory 权限档位（变异靶 M5）', () => {
    it('按该 friend 解析出的 memory_scopes 授权读写，不是 public/全局', async () => {
      boot()
      await internals.processDirectBatch(batchOf([makeMessage({ id: 'm-1', type: 'private' })]))

      const expected: MemoryPermissions = {
        write_visibility: 'internal',
        write_scopes: ['friend-scope-a', 'friend-scope-b'],
        read_min_visibility: 'internal',
        read_accessible_scopes: ['friend-scope-a', 'friend-scope-b'],
      }
      // 语义落点：worker 这轮能读到 / 写进的记忆范围
      expect(spawnCalls[0].memoryPermissions).toEqual(expected)
      // 上下文装配用的是同一档位（读侧不得比写侧宽）
      expect(assembleCalls[0].memPerms).toEqual(expected)
      // 反向钉死：不能退化成"公开可见 + 无 scope 限制"
      expect(spawnCalls[0].memoryPermissions.write_visibility).not.toBe('public')
      expect(spawnCalls[0].memoryPermissions.write_scopes).not.toEqual([])
    })

    it('身份解析失败时档位回落到该 session 配置的 scopes（仍不是公开）', async () => {
      boot()
      permsResponse = 'throw'
      sessionScopes = ['session-scope-1']
      await internals.processDirectBatch(batchOf([makeMessage({ id: 'm-1', type: 'private' })]))

      expect(spawnCalls[0].memoryPermissions).toEqual({
        write_visibility: 'internal',
        write_scopes: ['session-scope-1'],
        read_min_visibility: 'internal',
        read_accessible_scopes: ['session-scope-1'],
      })
      expect(calls).toContain('get_session_config')
    })
  })

  // ==========================================================================
  // 动作 5：前置上下文装配（M6）
  // ==========================================================================

  describe('前置上下文装配（变异靶 M6）', () => {
    it('装配结果进入 dispatcher 的决策上下文（历史消息 / 场景画像 / 候选任务）', async () => {
      boot()
      setDispatchActions([{ kind: 'stay_silent' }])
      await internals.processDirectBatch(batchOf([makeMessage({ id: 'm-1', type: 'private', text: '继续弄那个' })]))

      expect(capturedCtx).toBeDefined()
      expect(capturedCtx!.recentMessages.map((m) => m.platform_message_id)).toEqual(['hist-1'])
      expect(capturedCtx!.activeTasks.map((t) => t.task_id)).toEqual(['task-active-1'])
      expect(capturedCtx!.sceneProfile).toEqual(SCENE_PROFILE)
      expect(capturedCtx!.crabSelfHandle).toBe('@crabot_wx')
      expect(capturedCtx!.sessionType).toBe('private')
      // 装配请求描述的是这次的会话与发言人
      expect(assembleCalls[0].params).toMatchObject({
        channel_id: 'wechat',
        session_id: 'sess-1',
        sender_id: 'u-1',
        friend_id: 'f-1',
        session_type: 'private',
        message: '继续弄那个',
        crab_self_handle: '@crabot_wx',
      })
    })

    it('装配出的历史进 worker，且触发批次不被重复渲染成历史', async () => {
      boot()
      const trigger = makeMessage({ id: 'm-1', type: 'private' })
      // 上下文里同时含有历史消息和这条触发消息的副本（真实 message-store 就是这样）
      recentMessages = [HISTORY_MESSAGE, trigger]
      await internals.processDirectBatch(batchOf([trigger]))

      expect(spawnCalls[0].frontContext.recent_messages.map((m) => m.platform_message_id)).toEqual(['hist-1'])
      expect(spawnCalls[0].activeTasks.map((t) => t.task_id)).toEqual(['task-active-1'])
      expect(spawnCalls[0].sceneProfile).toEqual(SCENE_PROFILE)
    })

    it('只有装配结果里的候选任务才认得出"已终止任务"，从而走复活而不是往活任务里投递', async () => {
      boot()
      supplementCandidates = [TERMINAL_CANDIDATE]
      setDispatchActions([{ kind: 'supplement', target_task_id: 'task-terminal-1' }])

      await internals.processDirectBatch(batchOf([makeMessage({ id: 'm-1', type: 'private', text: '补一句' })]))

      // 走的是终止任务复活路径
      expect(calls).toContain('revive_task_for_supplement')
      expect(actionSpanDetails().outcome).toBe('terminal_task_revived')
      expect(actionSpanDetails().target_task_status).toBe('completed')
      // 而不是把补充消息塞进某个"活着的"任务
      expect(deliverCalls).toHaveLength(0)
      // dispatch trace 归到目标任务名下（UI 按任务聚合靠它）
      expect(dispatchTrace().related_task_id).toBe('task-terminal-1')
    })
  })

  // ==========================================================================
  // 动作 6：引用消息预取（M7）
  // ==========================================================================

  describe('引用消息预取（变异靶 M7）', () => {
    it('dispatcher 拿到的预取依赖真的能把跨窗口引用的原文取回来', async () => {
      boot()
      let prefetched: ReadonlyMap<string, QuotedMessageEntry> | undefined
      dispatchMock.mockImplementation(async (ctx, deps) => {
        calls.push('dispatch')
        capturedDeps = deps
        // 用真实 prefetcher 跑一遍：验证的是"这组依赖可用"，不是"某个字段被传进来了"
        if (deps.quotedPrefetchDeps) {
          prefetched = await prefetchQuotedMessages(
            ctx.messages,
            ctx.recentMessages,
            ctx.channelId,
            ctx.sessionId,
            'private',
            deps.quotedPrefetchDeps,
            () => 'friend',
          )
        }
        return { actions: [{ kind: 'stay_silent' }] }
      })

      await internals.processDirectBatch(
        batchOf([makeMessage({ id: 'm-1', type: 'private', text: '这个怎么办', replyTo: 'quoted-origin-1' })]),
      )

      expect(prefetched?.get('quoted-origin-1')?.msg.content.text).toBe('这是跨窗口引用的原文')
      const fetch = rpcCalls.find((c) => c.method === 'get_message')
      expect(fetch).toBeDefined()
      expect(fetch!.port).toBe(WECHAT_PORT)
      expect(fetch!.params).toMatchObject({ session_id: 'sess-1', platform_message_id: 'quoted-origin-1' })
      // 时区也一并传给 dispatcher（消息时间戳本地化）
      expect(capturedDeps!.timezone).toBeTruthy()
    })
  })

  // ==========================================================================
  // 动作 7 / 8：预回复、spawn 顺序与 reaction（M11 / M8 / M2）
  // ==========================================================================

  describe('预回复 / spawn / reaction 的顺序（变异靶 M11、M8）', () => {
    it('8 件事按固定顺序发生：预回复必须在 worker 起来之前发出去', async () => {
      boot()
      setDispatchActions([{ kind: 'new_task', immediate_reply: '收到，我看一下' }])

      await internals.processDirectBatch(batchOf([makeMessage({ id: 'm-1', type: 'private' })]))

      expect(calls).toEqual([
        'update_last_message_time',
        'start_trace:message',
        'resolve_permissions',
        'assemble_front_context',
        'dispatch',
        'send_message',
        'register_trigger',
        'start_trace:task',
        'worker_loop',
        'add_reaction',
      ])
    })

    it('预回复的落地元数据进 worker 的上下文（worker 因此知道自己已经 ack 过）', async () => {
      boot()
      setDispatchActions([{ kind: 'new_task', immediate_reply: '收到，我看一下' }])

      await internals.processDirectBatch(batchOf([makeMessage({ id: 'm-1', type: 'private' })]))

      const sent = rpcCalls.find((c) => c.method === 'send_message')
      expect(sent!.port).toBe(WECHAT_PORT)
      expect(sent!.params).toMatchObject({
        session_id: 'sess-1',
        content: { type: 'text', text: '收到，我看一下' },
      })

      const history = spawnCalls[0].frontContext.recent_messages
      const ack = history[history.length - 1]
      expect(ack.platform_message_id).toBe('ack-1')
      expect(ack.content.text).toBe('收到，我看一下')
      // sender=self → prompt 渲染时会被认成 assistant 自己发的
      expect(ack.sender.platform_user_id).toBe('self')
    })

    it('接住消息后给批内最后一条打"已读"回应（变异靶 M2 / M8）', async () => {
      boot()
      await internals.processDirectBatch(
        batchOf([
          makeMessage({ id: 'm-1', type: 'private', text: '第一条' }),
          makeMessage({ id: 'm-2', type: 'private', text: '第二条' }),
        ]),
      )

      const reaction = rpcCalls.find((c) => c.method === 'add_reaction')
      expect(reaction).toBeDefined()
      expect(reaction!.port).toBe(WECHAT_PORT)
      expect(reaction!.params).toEqual({
        session_id: 'sess-1',
        platform_message_id: 'm-2',
        kind: 'acknowledged',
      })
    })

    it('决定不回应时不打"已读"、不起 worker（reaction 不是无条件发的）', async () => {
      boot()
      setDispatchActions([{ kind: 'stay_silent', reason: '闲聊' }])

      await internals.processDirectBatch(batchOf([makeMessage({ id: 'm-1', type: 'private' })]))

      expect(rpcCalls.find((c) => c.method === 'add_reaction')).toBeUndefined()
      expect(spawnCalls).toHaveLength(0)
      expect(deliverCalls).toHaveLength(0)
      expect(actionSpanDetails().outcome).toBe('silent_discard')
      expect(dispatchTrace().status).toBe('completed')
    })

    it('dispatcher 一个动作都没给时 trace 记 silent', async () => {
      boot()
      setDispatchActions([])

      await internals.processDirectBatch(batchOf([makeMessage({ id: 'm-1', type: 'private' })]))

      expect(dispatchTrace().outcome?.summary).toBe('silent')
      expect(rpcCalls.find((c) => c.method === 'add_reaction')).toBeUndefined()
    })

    it('整批消息都交给 dispatcher 和 worker，发起人取批内最后一条（变异靶 M2）', async () => {
      boot()
      const older = makeFriend('f-1')
      const newer = makeFriend('f-2')
      const batch = [
        { message: makeMessage({ id: 'm-1', type: 'private', text: '第一条' }), friend: older },
        { message: makeMessage({ id: 'm-2', type: 'private', text: '第二条' }), friend: newer },
      ]

      await internals.processDirectBatch(batch)

      expect(capturedCtx!.messages.map((m) => m.platform_message_id)).toEqual(['m-1', 'm-2'])
      expect(capturedCtx!.senderFriend.id).toBe('f-2')
      expect(capturedDeps!.laneBatchSize).toBe(2)
      expect(spawnCalls[0].messages.map((m) => m.platform_message_id)).toEqual(['m-1', 'm-2'])
      expect(spawnCalls[0].senderFriend.id).toBe('f-2')
      // 上下文装配按最后一条发言人的视角取
      expect(assembleCalls[0].params.friend_id).toBe('f-2')
      expect(assembleCalls[0].params.message).toBe('第一条\n第二条')
    })

    it('supplement 投递把整批消息交给目标任务（变异靶 M2）', async () => {
      boot()
      setDispatchActions([{ kind: 'supplement', target_task_id: 'task-active-1' }])

      await internals.processDirectBatch(
        batchOf([
          makeMessage({ id: 'm-1', type: 'private', text: '第一条' }),
          makeMessage({ id: 'm-2', type: 'private', text: '第二条' }),
        ]),
      )

      expect(deliverCalls).toHaveLength(1)
      expect(deliverCalls[0].taskId).toBe('task-active-1')
      expect(deliverCalls[0].messages.map((m) => m.platform_message_id)).toEqual(['m-1', 'm-2'])
      expect(spawnCalls).toHaveLength(0)
    })
  })

  // ==========================================================================
  // worker 不阻塞入站（M10）
  // ==========================================================================

  describe('worker 不阻塞入站 lane（变异靶 M10）', () => {
    it('worker 还在跑时本批就已处理完，lane 可以接下一批', async () => {
      boot()
      let release: () => void = () => {}
      workerGate = new Promise<void>((resolve) => {
        release = resolve
      })

      await internals.processDirectBatch(batchOf([makeMessage({ id: 'm-1', type: 'private' })]))

      // 到这里 processDirectBatch 已经返回——若改成同步等 worker，这一行永远到不了
      expect(calls).toContain('worker_loop')
      expect(workerSettled).toBe(false)
      expect(dispatchTrace().status).toBe('completed')
      expect(dispatchTrace().outcome?.summary).toBe('dispatched (1 actions)')

      release()
      await new Promise((resolve) => process.nextTick(resolve))
      expect(workerSettled).toBe(true)
    }, 5000)
  })

  // ==========================================================================
  // 早退分支
  // ==========================================================================

  describe('早退分支', () => {
    it('没有 worker handler：trace 记失败，后续 7 件事一件都不做', async () => {
      boot({ withHandler: false })
      internals.agentHandler = undefined

      await internals.processDirectBatch(batchOf([makeMessage({ id: 'm-1', type: 'private' })]))

      const trace = dispatchTrace()
      expect(trace.status).toBe('failed')
      expect(trace.outcome?.summary).toBe('No worker handler configured')
      expect(calls).toEqual(['update_last_message_time', 'start_trace:message'])
      expect(dispatchMock).not.toHaveBeenCalled()
    })

    it('没有 worker LLM 环境：早退发生在上下文装配之后（顺序敏感）', async () => {
      boot({ withSdkEnv: false })
      internals.sdkEnvWorker = undefined

      await internals.processDirectBatch(batchOf([makeMessage({ id: 'm-1', type: 'private' })]))

      const trace = dispatchTrace()
      expect(trace.status).toBe('failed')
      expect(trace.outcome?.summary).toBe('sdkEnvWorker missing')
      expect(calls).toEqual([
        'update_last_message_time',
        'start_trace:message',
        'resolve_permissions',
        'assemble_front_context',
      ])
      expect(dispatchMock).not.toHaveBeenCalled()
    })

    it('dispatcher 抛错：trace 记 failed，不起 worker', async () => {
      boot()
      dispatchMock.mockImplementation(async () => {
        calls.push('dispatch')
        throw new Error('dispatch boom')
      })

      await internals.processDirectBatch(batchOf([makeMessage({ id: 'm-1', type: 'private' })]))

      const trace = dispatchTrace()
      expect(trace.status).toBe('failed')
      expect(trace.outcome?.error).toBe('dispatch boom')
      expect(spawnCalls).toHaveLength(0)
    })
  })
})
