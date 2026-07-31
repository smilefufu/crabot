/**
 * 入站链路测试网 ④：`processAdminChatMessage` + `handleProcessMessage` 路由
 * （P7 / PR A Task 4）。
 *
 * 计划：`crabot-docs/superpowers/plans/2026-07-31-mw-p7-a-inbound-test-net.md`
 * 被测单元：`unified-agent.ts:1522-1607`（RPC 入口路由）、`:1617-1918`（admin chat 处理）
 *
 * ## 本文件的核心：admin chat 的"三不"（变异靶 M12）
 *
 * Master Chat 是 admin REST 串行串发的伪 channel（spec 2026-06-10 §4），
 * 与 IM 入站是**两套语义**。三条边界必须钉死，否则 cutover 时很容易被"统一入站"顺手抹平：
 *
 * | 不 | 为什么 | 断言落点 |
 * |---|---|---|
 * | 不进 lane | admin 侧前端 fetch 等响应才发下一条，天然单线；进 lane 会让 RPC 响应与处理解耦 | 两个 `SessionLaneRegistry` 零命中（既没建过 lane，两个 batch handler 也没被调过） |
 * | 不进 attention | 注意力调度是群聊"该不该插话"的机制；master 直连对话每条都必须处理 | `attentionScheduler.getCurrentIntervalMs('admin-chat') === undefined`——连 session state 都不该建（比 `getBufferSize === 0` 强：后者在 enqueue 过又被 flush 掉时同样是 0） |
 * | 无 reaction | admin-web 没有 channel 侧 platform message，无处可打（`:1778` 注释） | 全程零 `add_reaction` RPC |
 *
 * ## `handleProcessMessage` 的 `channel` 分支：已证实为死代码，不写测试
 *
 * 两重证据（`p7a-task1-report.md` §2.4）：
 * 1. 全仓（含 4 个 channel 仓）grep RPC `process_message`，唯一生产调用方
 *    `crabot-admin/src/chat-manager.ts:220`，固定传 `source_type:'admin_chat'`；
 * 2. `setPendingRequest` 全仓无调用方 → `:1588` 的取代检查恒真 → 该分支即使被调用
 *    也永远返回 `{decision_types: []}`。
 *
 * 按 plan："不给死代码写测试——那会让它看起来是活的，cutover 时反而不敢删。"
 * 本文件只覆盖**活的**那条路由（`admin_chat` + `callback_info`）与静默丢弃分支。
 *
 * ## 明确不写成断言的现状（`p7a-task1-report.md` §6 O3）
 *
 * `!sdkEnvWorker` 早退**不发** `chat_callback`（另外两条早退都发），前端静默卡住。
 * 那是已登记的 bug 不是契约，所以该用例只钉"trace 记失败 + 不进 dispatcher"，
 * 不去断言"没有回执"——将来修 bug 补上回执时本用例不该被误挂。
 *
 * ## 手法
 *
 * 沿用测试网 ①②③：真实构造函数（`roles: []`）+ 只换外部边界桩 + 只 mock 模块级
 * `dispatch`（`executeDispatchActions` 用真件）+ 真实 `traceStore`（tmp `DATA_DIR`）
 * + 单一 `calls` 序列做顺序断言 + 零 `setTimeout` / 零 fake timer。
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
import { makeAgentConfig, makeMessage, useTmpDataDir, type DataDirGuard } from './harness.js'

// dispatch 是模块级 import，没有实例注入口——本文件唯一 mock 掉的生产模块。
vi.mock('../../src/dispatcher/dispatcher.js', () => ({ dispatch: vi.fn() }))
import { dispatch } from '../../src/dispatcher/dispatcher.js'

const dispatchMock = vi.mocked(dispatch)

// ============================================================================
// fixtures
// ============================================================================

const ADMIN_PORT = 18200
const ADMIN_CHAT_SESSION = 'admin-chat'
const REQUEST_ID = 'req-42'

/** master 身份解析出来的工具面：file_io 开、remote_exec 关（用来做正反对照）。 */
const MASTER_TOOL_ACCESS: ToolAccessConfig = {
  memory: true,
  messaging: true,
  task: true,
  mcp_skill: true,
  file_io: true,
  browser: true,
  shell: true,
  remote_exec: false,
  desktop: false,
}

const MASTER_PERMS: ResolvedPermissions = {
  tool_access: MASTER_TOOL_ACCESS,
  cli_access: {} as ResolvedPermissions['cli_access'],
  storage: null,
  memory_scopes: ['master-scope'],
}

/** admin chat 固定用的 master 记忆档位（`unified-agent.ts:1677-1682`）。 */
const MASTER_MEM_PERMS: MemoryPermissions = {
  write_visibility: 'private',
  write_scopes: [],
  read_min_visibility: 'private',
  read_accessible_scopes: undefined,
}

const HISTORY_MESSAGE = makeMessage({
  id: 'hist-a1',
  type: 'private',
  channelId: 'admin-web',
  sessionId: ADMIN_CHAT_SESSION,
  text: '上一轮我说的那个报表',
  timestamp: '2026-07-30T10:00:00.000Z',
})

const SCENE_PROFILE = {
  label: 'Master 直连',
  content: 'master 喜欢直接给结论',
  source: { scene: { type: 'friend' as const, friend_id: 'master' } },
}

const ACTIVE_TASK: TaskSummary = {
  task_id: 'task-admin-active',
  title: '在跑的任务',
  status: 'executing',
  priority: 'normal',
}

const SCHEDULED_TASK: TaskSummary = {
  task_id: 'task-admin-scheduled',
  title: '定时任务',
  status: 'executing',
  priority: 'normal',
  trigger_type: 'scheduled',
}

/**
 * admin chat 的入参消息：session 里带的是**别的**渠道/会话，
 * 用来证明处理端固定用 `admin-web` / `admin-chat`，不看消息自带的 session。
 */
function amsg(p: { id: string; text?: string; replyTo?: string; friendId?: string } = { id: 'a-1' }): ChannelMessage {
  return makeMessage({
    ...p,
    type: 'private',
    channelId: 'wechat',
    sessionId: 'some-other-session',
    ...(p.friendId !== undefined ? { friendId: p.friendId } : {}),
  })
}

const CALLBACK_INFO = { source_module_id: 'admin', request_id: REQUEST_ID }

interface AssembleCall {
  params: {
    channel_id: string
    session_id: string
    sender_id: string
    message: string
    friend_id: string
    session_type: string
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
  handleProcessMessage(params: {
    message: ChannelMessage
    source_type?: 'channel' | 'admin_chat'
    callback_info?: { source_module_id: string; request_id: string }
  }): Promise<{ decision_types: string[]; task_ids?: string[] }>
  processDirectBatch(batch: unknown): Promise<void>
  processGroupLaneBatch(batch: unknown): Promise<void>
  directLaneRegistry: { getOrCreate(key: string): unknown; size(): number }
  groupLaneRegistry: { getOrCreate(key: string): unknown; size(): number }
  sessionManager: {
    getSession(sessionId: string): { message_count: number } | undefined
  }
  traceStore: {
    getTraces(limit?: number): { traces: AgentTrace[] }
    startTrace(params: { trigger: { type: string } }): { trace_id: string }
  }
  contextAssembler: unknown
  agentHandler: unknown
  sdkEnvWorker: unknown
  attentionScheduler: {
    stopAll(): void
    getCurrentIntervalMs(sessionId: string): number | undefined
    getBufferSize(sessionId: string): number
  }
  rpcClient: {
    call: (port: number, method: string, params: unknown, from?: string) => Promise<unknown>
    resolve: (filter: unknown, from?: string) => Promise<unknown[]>
  }
}

describe('processAdminChatMessage —— admin chat 入站（P7/PR A 测试网 ④）', () => {
  let dataDir: DataDirGuard
  let agent: UnifiedAgent
  let internals: Internals

  /** 唯一的顺序事实来源。 */
  let calls: string[]
  let rpcCalls: Array<{ port: number; method: string; params: Record<string, unknown> }>
  let assembleCalls: AssembleCall[]
  let spawnCalls: SpawnCall[]
  let deliverCalls: Array<{ taskId: string; messages: ReadonlyArray<ChannelMessage> }>
  /** "不进 lane" 的两处观测点：registry 有没有被建过 lane、两个 batch handler 有没有被跑过。 */
  let laneKeysCreated: string[]
  let laneBatchRuns: string[]
  /** `handleProcessMessage` 的 channel 分支出口（死代码），录来做反向断言。 */
  let executeTriggerCalls: number
  let capturedCtx: DispatchContext | undefined
  let capturedDeps: DispatchDeps | undefined

  // 可按测试改写的响应
  let permsResponse: ResolvedPermissions | null | 'throw'
  let supplementCandidates: TaskSummary[]
  let activeTasks: TaskSummary[]
  let recentMessages: ChannelMessage[]
  let hasActiveTaskResult: boolean
  /** worker loop 的放行闸：默认立即完成；M10 用它把 worker 挂住。 */
  let workerGate: Promise<void> | undefined
  let workerSettled: boolean

  function boot(opts: { configured?: boolean; withHandler?: boolean; withSdkEnv?: boolean } = {}): void {
    agent = new UnifiedAgent(
      makeAgentConfig({
        configured: opts.configured !== false,
        moduleId: 'admin-chat-agent',
        port: 19995,
      }),
    )
    internals = agent as unknown as Internals

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
        case 'chat_callback':
          calls.push(`chat_callback:${(params as { reply_type: string }).reply_type}`)
          return { received: true }
        case 'add_reaction':
          calls.push('add_reaction')
          return {}
        case 'get_message':
          calls.push('get_message')
          return {
            platform_message_id: (params as { platform_message_id: string }).platform_message_id,
            sender: { platform_user_id: 'master', platform_display_name: 'Master' },
            content: { type: 'text', text: '这是被引用的原文' },
            features: {},
            platform_timestamp: '2026-07-20T00:00:00.000Z',
          }
        default:
          return {}
      }
    }

    const realStartTrace = internals.traceStore.startTrace.bind(internals.traceStore)
    internals.traceStore.startTrace = (params) => {
      calls.push(`start_trace:${params.trigger.type}`)
      return realStartTrace(params)
    }

    // 「不进 lane」观测点。构造函数存的是 `(batch) => this.processXxxBatch(batch)`
    // （调用时才解引用），所以实例上换成录制器不破坏生产接线。
    for (const [name, registry] of [
      ['direct', internals.directLaneRegistry],
      ['group', internals.groupLaneRegistry],
    ] as const) {
      const realGetOrCreate = registry.getOrCreate.bind(registry)
      registry.getOrCreate = (key: string) => {
        laneKeysCreated.push(`${name}:${key}`)
        return realGetOrCreate(key)
      }
    }
    internals.processDirectBatch = async () => {
      laneBatchRuns.push('direct')
    }
    internals.processGroupLaneBatch = async () => {
      laneBatchRuns.push('group')
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
        executeTriggerMessage: async () => {
          executeTriggerCalls += 1
          return { outcome: 'completed', finalText: '', sentMessage: true }
        },
        registerTriggerAndActivate: async (params: SpawnCall) => {
          calls.push('register_trigger')
          spawnCalls.push(params)
          return {
            taskId: 'task-admin-new',
            registered: true,
            task: {},
            context: {},
            taskTitle: '新建的 master 任务',
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

  function setDispatchActions(actions: DispatchAction[]): void {
    dispatchMock.mockImplementation(async (ctx, deps) => {
      calls.push('dispatch')
      capturedCtx = ctx
      capturedDeps = deps
      return { actions }
    })
  }

  /** 走真实 RPC 入口（`handleProcessMessage`），不直接调私有方法。 */
  function runAdminChat(
    message: ChannelMessage = amsg({ id: 'a-1' }),
  ): Promise<{ decision_types: string[]; task_ids?: string[] }> {
    return internals.handleProcessMessage({
      message,
      source_type: 'admin_chat',
      callback_info: CALLBACK_INFO,
    })
  }

  function dispatchTrace(): AgentTrace {
    const t = internals.traceStore.getTraces(50).traces.find((x) => x.trigger.type === 'message')
    if (!t) throw new Error('dispatch trace not found')
    return t
  }

  function callbacksOf(replyType: string): Array<Record<string, unknown>> {
    return rpcCalls.filter((c) => c.method === 'chat_callback' && c.params.reply_type === replyType).map((c) => c.params)
  }

  /** 三不：不进 lane、不进 attention、无 reaction。 */
  function expectThreeNots(): void {
    expect(laneKeysCreated).toEqual([])
    expect(laneBatchRuns).toEqual([])
    expect(internals.directLaneRegistry.size()).toBe(0)
    expect(internals.groupLaneRegistry.size()).toBe(0)
    expect(internals.attentionScheduler.getCurrentIntervalMs(ADMIN_CHAT_SESSION)).toBeUndefined()
    expect(internals.attentionScheduler.getBufferSize(ADMIN_CHAT_SESSION)).toBe(0)
    expect(rpcCalls.find((c) => c.method === 'add_reaction')).toBeUndefined()
    expect(calls).not.toContain('add_reaction')
  }

  beforeEach(async () => {
    calls = []
    rpcCalls = []
    assembleCalls = []
    spawnCalls = []
    deliverCalls = []
    laneKeysCreated = []
    laneBatchRuns = []
    executeTriggerCalls = 0
    capturedCtx = undefined
    capturedDeps = undefined
    permsResponse = MASTER_PERMS
    supplementCandidates = [ACTIVE_TASK]
    activeTasks = [ACTIVE_TASK]
    recentMessages = [HISTORY_MESSAGE]
    hasActiveTaskResult = true
    workerGate = undefined
    workerSettled = false
    dispatchMock.mockReset()
    setDispatchActions([{ kind: 'new_task' }])
    dataDir = await useTmpDataDir('inbound-pacm-')
  })

  afterEach(async () => {
    internals?.attentionScheduler.stopAll()
    vi.restoreAllMocks()
    await dataDir.restore()
  })

  // ==========================================================================
  // RPC 入口路由（handleProcessMessage）
  // ==========================================================================

  describe('RPC 入口路由（handleProcessMessage）', () => {
    it('带回执信息的 admin_chat 消息走 master 对话路径，固定落在 admin-web / admin-chat', async () => {
      boot()
      await runAdminChat(amsg({ id: 'a-1', text: '帮我看下季度报表' }))

      // 处理端不看消息自带的 session（入参故意给了 wechat / some-other-session）
      const trace = dispatchTrace()
      expect(trace.trigger.source).toBe('admin-web')
      expect(trace.trigger.summary).toBe('帮我看下季度报表')
      expect(spawnCalls[0].channelId).toBe('admin-web')
      expect(spawnCalls[0].sessionId).toBe(ADMIN_CHAT_SESSION)
      expect(spawnCalls[0].isGroup).toBe(false)
      // 会话活跃度推进的是固定的 admin-chat 会话
      expect(internals.sessionManager.getSession(ADMIN_CHAT_SESSION)?.message_count).toBe(1)
      expect(internals.sessionManager.getSession('some-other-session')).toBeUndefined()
    })

    it('admin_chat 但缺回执信息：静默丢弃，不建 trace、不碰 worker', async () => {
      boot()
      const result = await internals.handleProcessMessage({
        message: amsg({ id: 'a-1' }),
        source_type: 'admin_chat',
      })

      expect(result).toEqual({ decision_types: [] })
      expect(calls).toEqual([])
      expect(internals.traceStore.getTraces(50).traces).toHaveLength(0)
      expect(dispatchMock).not.toHaveBeenCalled()
      expect(executeTriggerCalls).toBe(0)
      expect(rpcCalls).toEqual([])
    })
  })

  // ==========================================================================
  // 三不语义（变异靶 M12）
  // ==========================================================================

  describe('admin chat 的"三不"语义（变异靶 M12）', () => {
    it('不进 lane：一轮 master 对话全程不碰任何会话 lane（admin REST 天然单线）', async () => {
      boot()
      setDispatchActions([{ kind: 'new_task', immediate_reply: '收到' }])
      await runAdminChat()

      expect(laneKeysCreated).toEqual([])
      expect(laneBatchRuns).toEqual([])
      expect(internals.directLaneRegistry.size()).toBe(0)
      expect(internals.groupLaneRegistry.size()).toBe(0)
      // 反向锚点：这轮确实处理了（不是因为早退才没碰 lane）
      expect(spawnCalls).toHaveLength(1)
    })

    it('不进注意力调度：admin-chat 连注意力状态都不该被建出来', async () => {
      boot()
      setDispatchActions([{ kind: 'stay_silent' }])
      await runAdminChat()

      // 建了 state 就意味着 master 的话可能被"注意力渐远"推迟甚至跳过
      expect(internals.attentionScheduler.getCurrentIntervalMs(ADMIN_CHAT_SESSION)).toBeUndefined()
      expect(internals.attentionScheduler.getBufferSize(ADMIN_CHAT_SESSION)).toBe(0)
      expect(dispatchMock).toHaveBeenCalledTimes(1)
    })

    it('不打"已读"回应：admin-web 没有 channel 侧消息可回应', async () => {
      boot()
      setDispatchActions([{ kind: 'new_task', immediate_reply: '收到' }])
      await runAdminChat()

      expect(rpcCalls.find((c) => c.method === 'add_reaction')).toBeUndefined()
      expect(calls).not.toContain('add_reaction')
      // 反向锚点：回执确实走了 chat_callback 这条通道
      expect(callbacksOf('direct_reply')).toHaveLength(1)
    })

    it('三不在 new_task / supplement / stay_silent 三条路径上同样成立', async () => {
      boot()

      setDispatchActions([{ kind: 'new_task', immediate_reply: '收到' }])
      await runAdminChat(amsg({ id: 'a-1' }))
      expectThreeNots()

      setDispatchActions([{ kind: 'supplement', target_task_id: 'task-admin-active' }])
      await runAdminChat(amsg({ id: 'a-2' }))
      expectThreeNots()

      setDispatchActions([{ kind: 'stay_silent' }])
      await runAdminChat(amsg({ id: 'a-3' }))
      expectThreeNots()

      // 三轮都真的跑到了 dispatcher
      expect(dispatchMock).toHaveBeenCalledTimes(3)
      expect(spawnCalls).toHaveLength(1)
      expect(deliverCalls).toHaveLength(1)
    })
  })

  // ==========================================================================
  // master 身份与记忆档位
  // ==========================================================================

  describe('master 身份与记忆档位', () => {
    it('按 master 身份解析权限，结果决定这轮 worker 的工具面', async () => {
      boot()
      await runAdminChat()

      const resolveCall = rpcCalls.find((c) => c.method === 'resolve_principal_permissions')
      expect(resolveCall!.port).toBe(ADMIN_PORT)
      expect(resolveCall!.params).toMatchObject({
        sender_friend_id: 'master',
        session_id: ADMIN_CHAT_SESSION,
        session_type: 'private',
      })

      expect(spawnCalls[0].resolvedPermissions.tool_access.file_io).toBe(true)
      expect(spawnCalls[0].resolvedPermissions.tool_access.remote_exec).toBe(false)
      expect(
        agent.getToolPermissionConfig([
          { name: 'write_file', description: '', inputSchema: {}, category: 'file_io' },
        ]),
      ).toEqual({ mode: 'bypass' })
      expect(
        agent.getToolPermissionConfig([
          { name: 'ssh_exec', description: '', inputSchema: {}, category: 'remote_exec' },
        ]),
      ).toEqual({ mode: 'denyList', toolNames: ['ssh_exec'] })
    })

    it('dispatcher 看到的是 master 本人（permission=master），不是普通好友', async () => {
      boot()
      await runAdminChat()

      expect(capturedCtx!.senderFriend.id).toBe('master')
      expect(capturedCtx!.senderFriend.permission).toBe('master')
      expect(capturedCtx!.sessionType).toBe('admin_chat')
      expect(capturedCtx!.channelId).toBe('admin-web')
      expect(capturedCtx!.sessionId).toBe(ADMIN_CHAT_SESSION)
      expect(spawnCalls[0].senderFriend.permission).toBe('master')
    })

    it('记忆档位是 master 私有档：私有可见性 + 不做 scope 过滤，且不随身份解析结果变化', async () => {
      boot()
      permsResponse = { ...MASTER_PERMS, memory_scopes: ['某个群 scope'] }
      await runAdminChat()

      // master 直连对话读写的是自己的私有记忆，既不是 public 也不受群 scope 限制
      expect(assembleCalls[0].memPerms).toEqual(MASTER_MEM_PERMS)
      expect(spawnCalls[0].memoryPermissions).toEqual(MASTER_MEM_PERMS)
      expect(spawnCalls[0].memoryPermissions.write_visibility).not.toBe('public')
      expect(spawnCalls[0].memoryPermissions.read_accessible_scopes).toBeUndefined()
    })

    it('身份解析失败时不覆盖会话身份，仍 fail-closed（只剩 messaging）', async () => {
      boot()
      permsResponse = 'throw'
      await runAdminChat()

      expect(
        agent.getToolPermissionConfig([
          { name: 'bash', description: '', inputSchema: {}, category: 'shell' },
          { name: 'send_message', description: '', inputSchema: {}, category: 'messaging' },
        ]),
      ).toEqual({ mode: 'denyList', toolNames: ['bash'] })
      // 解析失败不阻断这一轮：master 的话仍然被处理
      expect(spawnCalls).toHaveLength(1)
    })
  })

  // ==========================================================================
  // 上下文装配与引用预取
  // ==========================================================================

  describe('上下文装配与引用预取', () => {
    it('装配请求按 admin-web / admin-chat / private 语义发出，master 身份进装配', async () => {
      boot()
      await runAdminChat(amsg({ id: 'a-1', text: '继续昨天那个' }))

      expect(assembleCalls[0].params).toEqual({
        channel_id: 'admin-web',
        session_id: ADMIN_CHAT_SESSION,
        sender_id: 'master',
        message: '继续昨天那个',
        friend_id: 'f-1',
        session_type: 'private',
      })
      expect(assembleCalls[0].friend?.permission).toBe('master')
      // context_assembly span 挂在本轮 dispatch trace 上
      const span = dispatchTrace().spans.find((s) => s.type === 'context_assembly')
      expect(span?.status).toBe('completed')
      expect(span?.details).toMatchObject({ context_type: 'front', channel_id: 'admin-web', session_id: ADMIN_CHAT_SESSION })
    })

    it('装配结果进 dispatcher 与 worker，触发消息不被重复渲染成历史', async () => {
      boot()
      const trigger = amsg({ id: 'a-1', text: '看下这个' })
      recentMessages = [HISTORY_MESSAGE, trigger]
      await runAdminChat(trigger)

      expect(capturedCtx!.recentMessages.map((m) => m.platform_message_id)).toEqual(['hist-a1', 'a-1'])
      expect(capturedCtx!.activeTasks.map((t) => t.task_id)).toEqual(['task-admin-active'])
      expect(capturedCtx!.sceneProfile).toEqual(SCENE_PROFILE)
      // worker 侧：触发消息只在 messages 里出现一次，不在历史里重复
      expect(spawnCalls[0].messages.map((m) => m.platform_message_id)).toEqual(['a-1'])
      expect(spawnCalls[0].frontContext.recent_messages.map((m) => m.platform_message_id)).toEqual(['hist-a1'])
      expect(spawnCalls[0].sceneProfile).toEqual(SCENE_PROFILE)
      expect(spawnCalls[0].activeTasks.map((t) => t.task_id)).toEqual(['task-admin-active'])
    })

    it('dispatcher 拿到的预取依赖真的能把引用原文取回来（走 admin 伪 channel 端口）', async () => {
      boot()
      let prefetched: ReadonlyMap<string, QuotedMessageEntry> | undefined
      dispatchMock.mockImplementation(async (ctx, deps) => {
        calls.push('dispatch')
        capturedDeps = deps
        if (deps.quotedPrefetchDeps) {
          prefetched = await prefetchQuotedMessages(
            ctx.messages,
            ctx.recentMessages,
            ctx.channelId,
            ctx.sessionId,
            'private',
            deps.quotedPrefetchDeps,
            () => 'master',
          )
        }
        return { actions: [{ kind: 'stay_silent' }] }
      })

      await runAdminChat(amsg({ id: 'a-1', text: '这条怎么说', replyTo: 'quoted-origin-a1' }))

      expect(prefetched?.get('quoted-origin-a1')?.msg.content.text).toBe('这是被引用的原文')
      const fetch = rpcCalls.find((c) => c.method === 'get_message')
      expect(fetch!.port).toBe(ADMIN_PORT)
      expect(fetch!.params).toMatchObject({ session_id: ADMIN_CHAT_SESSION, platform_message_id: 'quoted-origin-a1' })
      expect(capturedDeps!.timezone).toBeTruthy()
    })
  })

  // ==========================================================================
  // 回执通道与顺序
  // ==========================================================================

  describe('回执通道与顺序', () => {
    it('一轮新建任务的固定顺序：决策 → 预回复回执 → 注册任务 → 任务卡回执 → 起 worker', async () => {
      boot()
      setDispatchActions([{ kind: 'new_task', immediate_reply: '收到，我看一下' }])

      await runAdminChat()

      expect(calls).toEqual([
        'start_trace:message',
        'resolve_permissions',
        'assemble_front_context',
        'dispatch',
        'chat_callback:direct_reply',
        'register_trigger',
        'chat_callback:task_created',
        'start_trace:task',
        'worker_loop',
      ])
    })

    it('预回复走 chat_callback 并合成 ack 元数据进 worker 上下文（admin-web 没有真实 platform_message_id）', async () => {
      boot()
      setDispatchActions([{ kind: 'new_task', immediate_reply: '收到，我看一下' }])

      await runAdminChat()

      const direct = callbacksOf('direct_reply')
      expect(direct).toHaveLength(1)
      expect(direct[0]).toMatchObject({ request_id: REQUEST_ID, content: '收到，我看一下' })

      const history = spawnCalls[0].frontContext.recent_messages
      const ack = history[history.length - 1]
      expect(ack.content.text).toBe('收到，我看一下')
      expect(ack.sender.platform_user_id).toBe('self')
      expect(ack.platform_message_id).toMatch(/^dispatcher-ack-/)
      // ack 必须挂在 admin chat 会话上
      expect(ack.session.channel_id).toBe('admin-web')
      expect(ack.session.session_id).toBe(ADMIN_CHAT_SESSION)
      expect(ack.session.type).toBe('private')
    })

    it('没有预回复时不发 direct_reply 回执，也不往 worker 上下文里塞 ack', async () => {
      boot()
      setDispatchActions([{ kind: 'new_task' }])

      await runAdminChat()

      expect(callbacksOf('direct_reply')).toHaveLength(0)
      expect(spawnCalls[0].frontContext.recent_messages.map((m) => m.platform_message_id)).toEqual(['hist-a1'])
    })

    it('任务注册后立刻回一张任务卡（带 task_id 与标题），前端据此显示任务状态', async () => {
      boot()
      await runAdminChat()

      const created = callbacksOf('task_created')
      expect(created).toHaveLength(1)
      expect(created[0]).toEqual({
        request_id: REQUEST_ID,
        reply_type: 'task_created',
        content: '已创建任务：新建的 master 任务',
        task_id: 'task-admin-new',
      })
      // 本轮 dispatch trace 关联到新建的任务
      expect(dispatchTrace().related_task_id).toBe('task-admin-new')
    })
  })

  // ==========================================================================
  // 返回值（RPC 响应）
  // ==========================================================================

  describe('返回值（RPC 响应）', () => {
    it('新建任务 → decision_types 报 create_task', async () => {
      boot()
      setDispatchActions([{ kind: 'new_task' }, { kind: 'new_task' }])

      const result = await runAdminChat()

      expect(result.decision_types).toEqual(['create_task', 'create_task'])
      expect(result.task_ids).toBeUndefined()
    })

    it('往在跑的任务补充 → 回报目标任务 id，不报 create_task', async () => {
      boot()
      setDispatchActions([{ kind: 'supplement', target_task_id: 'task-admin-active' }])

      const result = await runAdminChat()

      expect(result.decision_types).toEqual([])
      expect(result.task_ids).toEqual(['task-admin-active'])
      expect(deliverCalls).toHaveLength(1)
    })

    it('dispatcher 一个动作都不给 → 空返回，trace 记 silent', async () => {
      boot()
      setDispatchActions([])

      const result = await runAdminChat()

      expect(result).toEqual({ decision_types: [], task_ids: undefined })
      expect(dispatchTrace().status).toBe('completed')
      expect(dispatchTrace().outcome?.summary).toBe('silent')
      expect(spawnCalls).toHaveLength(0)
    })
  })

  // ==========================================================================
  // supplement 分支
  // ==========================================================================

  describe('补充投递（supplement）', () => {
    it('投递前先回一条带 task_id 的回执，再把消息交给目标任务', async () => {
      boot()
      setDispatchActions([{ kind: 'supplement', target_task_id: 'task-admin-active' }])

      await runAdminChat(amsg({ id: 'a-1', text: '再补一句：只要中文' }))

      const cb = callbacksOf('direct_reply')
      expect(cb).toHaveLength(1)
      expect(cb[0]).toMatchObject({ content: '收到，正在调整。', task_id: 'task-admin-active' })
      expect(calls.indexOf('chat_callback:direct_reply')).toBeLessThan(calls.indexOf('deliver_human_response'))

      expect(deliverCalls[0].taskId).toBe('task-admin-active')
      // 投递的是 master 身份的合成消息，内容是本轮原文
      const delivered = deliverCalls[0].messages[0]
      expect(delivered.content.text).toBe('再补一句：只要中文')
      expect(delivered.sender.platform_user_id).toBe('master')
      expect(delivered.session.channel_id).toBe('admin-web')
      expect(delivered.session.session_id).toBe(ADMIN_CHAT_SESSION)
      expect(spawnCalls).toHaveLength(0)
    })

    it('目标任务已经不在跑 → 回落成新建任务，不静默丢掉这句话', async () => {
      boot()
      hasActiveTaskResult = false
      setDispatchActions([{ kind: 'supplement', target_task_id: 'task-admin-active' }])

      await runAdminChat()

      expect(deliverCalls).toHaveLength(0)
      expect(spawnCalls).toHaveLength(1)
    })

    it('定时任务不接受补充 → 同样回落成新建任务', async () => {
      boot()
      activeTasks = [SCHEDULED_TASK]
      supplementCandidates = [SCHEDULED_TASK]
      setDispatchActions([{ kind: 'supplement', target_task_id: 'task-admin-scheduled' }])

      await runAdminChat()

      expect(deliverCalls).toHaveLength(0)
      expect(spawnCalls).toHaveLength(1)
    })
  })

  // ==========================================================================
  // worker 不阻塞 RPC（变异靶 M10 在 admin chat 路径）
  // ==========================================================================

  describe('worker 不阻塞 RPC 响应（变异靶 M10）', () => {
    it('worker 还在跑时 RPC 就已返回（长任务不该撑爆 process_message 超时）', async () => {
      boot()
      let release: () => void = () => {}
      workerGate = new Promise<void>((resolve) => {
        release = resolve
      })

      const result = await runAdminChat()

      // 到这里 handleProcessMessage 已经返回——改成同步等 worker 时这一行永远到不了
      expect(calls).toContain('worker_loop')
      expect(workerSettled).toBe(false)
      expect(result.decision_types).toEqual(['create_task'])
      expect(dispatchTrace().status).toBe('completed')
      expect(dispatchTrace().outcome?.summary).toBe('dispatched (1 actions)')

      release()
      await new Promise((resolve) => process.nextTick(resolve))
      expect(workerSettled).toBe(true)
    }, 5000)
  })

  // ==========================================================================
  // 早退与异常
  // ==========================================================================

  describe('早退与异常', () => {
    it('未配置 LLM：回一条提示、trace 记失败，不进 dispatcher', async () => {
      boot({ configured: false })

      const result = await runAdminChat()

      expect(result).toEqual({ decision_types: [] })
      expect(callbacksOf('direct_reply')[0]).toMatchObject({
        request_id: REQUEST_ID,
        content: 'Crabot 尚未配置 LLM 模型。请在全局设置中完成配置后重试。',
      })
      expect(dispatchTrace().status).toBe('failed')
      expect(dispatchTrace().outcome?.summary).toBe('Agent not configured')
      expect(dispatchMock).not.toHaveBeenCalled()
      expectThreeNots()
    })

    it('没有 worker handler：回"系统暂时不可用"、trace 记失败', async () => {
      boot({ withHandler: false })
      internals.agentHandler = undefined

      const result = await runAdminChat()

      expect(result).toEqual({ decision_types: [] })
      expect(callbacksOf('direct_reply')[0]).toMatchObject({ content: '系统暂时不可用' })
      expect(dispatchTrace().status).toBe('failed')
      expect(dispatchTrace().outcome?.summary).toBe('No worker handler configured')
      expect(dispatchMock).not.toHaveBeenCalled()
    })

    it('没有 worker LLM 环境：早退发生在解析身份与装配上下文之前（不做白工）', async () => {
      boot({ withSdkEnv: false })
      internals.sdkEnvWorker = undefined

      const result = await runAdminChat()

      // 注：这条早退当前**不发** chat_callback（另外两条都发），前端会静默卡住——
      //     那是已登记的 bug（p7a-task1-report.md §6 O3）不是契约，所以这里不断言"没有回执"，
      //     将来补上回执时本用例不该被误挂。
      expect(result).toEqual({ decision_types: [] })
      expect(dispatchTrace().status).toBe('failed')
      expect(dispatchTrace().outcome?.summary).toBe('sdkEnvWorker missing')
      expect(dispatchMock).not.toHaveBeenCalled()
      // 与私聊/群聊不同：admin chat 的这条早退在 resolve/assemble **之前**
      // （`unified-agent.ts:1671` vs 私聊 `:857`），所以既不解析身份也不装配上下文
      expect(calls).toEqual(['start_trace:message'])
      expect(assembleCalls).toEqual([])
    })

    it('处理中抛错：trace 记失败并把错误抛回 RPC 调用方（与 channel 入站的吞错不同）', async () => {
      boot()
      dispatchMock.mockImplementation(async () => {
        calls.push('dispatch')
        throw new Error('dispatch boom')
      })

      await expect(runAdminChat()).rejects.toThrow('dispatch boom')

      expect(dispatchTrace().status).toBe('failed')
      expect(dispatchTrace().outcome?.error).toBe('dispatch boom')
      expect(spawnCalls).toHaveLength(0)
      expectThreeNots()
    })
  })
})
