/**
 * 入站链路测试网 ③：`processGroupLaneBatch`（P7 / PR A Task 3）。
 *
 * 计划：`crabot-docs/superpowers/plans/2026-07-31-mw-p7-a-inbound-test-net.md`
 * 侦察：`.superpowers/sdd/p7-recon.md` §A.2 / §A.3
 *
 * ## 与私聊（测试网 ②）的关系
 *
 * 私聊那 8 件事在群聊路径上同样成立，但**不是同一段代码**（`unified-agent.ts:971-1190`
 * 是与 `:779-962` 平行的另一份实现），所以这里逐条**在群聊路径上重新钉一遍**，
 * 而不是复用私聊的断言。群聊多出来的三件事单独成节：
 *
 * | 群聊特有 | 生产位置 |
 * |---|---|
 * | barrier：@bot 时暂停本群在跑的 worker，处理完解除 | `:1012-1015` / `:1179` / `:1186` |
 * | memory scopes 的**第二档 fallback**（空 scopes → `[sessionId]`，防跨群泄漏） | `:1019-1022` |
 * | 退避反馈：`attentionScheduler.reportResult(sessionId, hasReply)` | `:1110-1111` / `:1180` |
 *
 * ## M9 断的是"退避档位"，不是"reportResult 被调用了"
 *
 * `AttentionScheduler` 的 `currentIntervalMs` 就是群聊打扰频率的调节旋钮
 * （`attention-scheduler.ts:81-103`：回复 → 拉回 `min_ms`；没回复 → ×5 封顶 `max_ms`），
 * 且它有现成的读口 `getCurrentIntervalMs`。所以退避相关的用例走**真实事件入口**
 * （`channel.message_authorized` → 真实 AttentionScheduler → 真实群聊 lane →
 * `processGroupLaneBatch`），处理完直接读这个档位。
 * 注意：`reportResult` 在没有 session state 时是 no-op，直接调 handler 是读不出档位的——
 * 这也是这几条必须走事件入口的原因。
 *
 * ## 明确不写成断言的现状（`p7a-task1-report.md` §6 O1）
 *
 * 两条早退与 catch 分支**都不调** `reportResult`，退避档位在故障期间不更新。
 * 那是已登记的 bug（O1），不是契约，所以这里只钉"barrier 一定被解除"，
 * 不去断言故障路径的退避行为。
 *
 * ## 确定性
 *
 * 零 `setTimeout`、零 fake timer：@mention 消息在 `AttentionScheduler.enqueue` 里同步
 * `flushNow`；`SessionLane.enqueue` 在第一个 await 之前同步调 handler。
 * 事件入口返回后用 `settleGroupLane()` 等 in-flight 的那次 handler，避免竞态。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

import { UnifiedAgent } from '../../src/unified-agent.js'
import { prefetchQuotedMessages } from '../../src/agent/quoted-message-prefetcher.js'
import type { QuotedMessageEntry } from '../../src/prompt-manager.js'
import type { BufferedMessage } from '../../src/orchestration/attention-scheduler.js'
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
import type { Event } from 'crabot-shared'
import { authorizedEvent, makeAgentConfig, makeFriend, makeMessage, useTmpDataDir, type DataDirGuard } from './harness.js'

// dispatch 是模块级 import，没有实例注入口——本文件唯一 mock 掉的生产模块。
vi.mock('../../src/dispatcher/dispatcher.js', () => ({ dispatch: vi.fn() }))
import { dispatch } from '../../src/dispatcher/dispatcher.js'

const dispatchMock = vi.mocked(dispatch)

// ============================================================================
// fixtures
// ============================================================================

const ADMIN_PORT = 18100
const WECHAT_PORT = 18101
const GROUP_SESSION = 'sess-group-1'

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

/** 群聊解析出的身份：shell 开、file_io 关，memory_scopes 是该群专属 scope。 */
const GROUP_PERMS: ResolvedPermissions = {
  tool_access: FRIEND_TOOL_ACCESS,
  cli_access: {} as ResolvedPermissions['cli_access'],
  storage: null,
  memory_scopes: ['group-scope-a', 'group-scope-b'],
}

const HISTORY_MESSAGE = makeMessage({
  id: 'hist-g1',
  type: 'group',
  sessionId: GROUP_SESSION,
  text: '昨天群里说的那个方案',
  timestamp: '2026-07-30T10:00:00.000Z',
})

const SCENE_PROFILE = {
  label: '技术群',
  content: '这个群喜欢直给结论',
  source: { scene: { type: 'group_session' as const, channel_id: 'wechat', session_id: GROUP_SESSION } },
}

const ACTIVE_TASK: TaskSummary = {
  task_id: 'task-group-active',
  title: '群里在跑的任务',
  status: 'executing',
  priority: 'normal',
}

const TERMINAL_CANDIDATE: TaskSummary = {
  task_id: 'task-group-terminal',
  title: '群里刚做完的任务',
  status: 'completed',
  priority: 'normal',
  candidate_kind: 'recent_terminal',
  completed_at: '2026-07-31T00:00:00.000Z',
}

function gmsg(p: {
  id: string
  text?: string
  mention?: boolean
  senderId?: string
  senderName?: string
  friendId?: string
  replyTo?: string
}): ChannelMessage {
  return makeMessage({ ...p, type: 'group', sessionId: GROUP_SESSION })
}

interface AssembleCall {
  params: {
    channel_id: string
    session_id: string
    sender_id: string
    message: string
    friend_id: string
    session_type: string
    crab_display_name?: string
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

type GroupBatch = ReadonlyArray<{ messages: BufferedMessage[]; sessionId: string }>

interface Internals {
  onEvent(event: Event): Promise<void>
  processGroupLaneBatch(batch: GroupBatch): Promise<void>
  traceStore: {
    getTraces(limit?: number): { traces: AgentTrace[] }
    startTrace(params: { trigger: { type: string } }): { trace_id: string }
  }
  contextAssembler: unknown
  agentHandler: unknown
  sdkEnvWorker: unknown
  channelPorts: Map<string, number>
  crabDisplayNames: Map<string, string>
  crabSelfHandles: Map<string, string>
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

describe('processGroupLaneBatch —— 群聊 lane handler（P7/PR A 测试网 ③）', () => {
  let dataDir: DataDirGuard
  let agent: UnifiedAgent
  let internals: Internals

  /** 唯一的顺序事实来源。 */
  let calls: string[]
  let rpcCalls: Array<{ port: number; method: string; params: Record<string, unknown> }>
  let assembleCalls: AssembleCall[]
  let spawnCalls: SpawnCall[]
  let deliverCalls: Array<{ taskId: string; messages: ReadonlyArray<ChannelMessage> }>
  let barrierArmed: Array<{ taskId: string; timeoutMs: number }>
  let barrierCleared: string[]
  let originQueries: Array<{ channelId: string; sessionId: string }>
  let capturedCtx: DispatchContext | undefined
  let capturedDeps: DispatchDeps | undefined
  /** 事件入口驱动时 in-flight 的群聊 handler。 */
  let inflight: Promise<void>[]

  // 可按测试改写的响应
  let permsResponse: ResolvedPermissions | null | 'throw'
  let sessionScopes: string[]
  let supplementCandidates: TaskSummary[]
  let activeTasks: TaskSummary[]
  let recentMessages: ChannelMessage[]
  let hasActiveTaskResult: boolean
  /** getActiveTasksByOrigin 的返回；barrier arm 失败（已 park）的 task 放 parkedTasks。 */
  let originTasks: string[]
  let parkedTasks: string[]
  /** worker loop 的放行闸：默认立即完成；M10 用它把 worker 挂住。 */
  let workerGate: Promise<void> | undefined
  let workerSettled: boolean

  function boot(
    opts: {
      withHandler?: boolean
      withSdkEnv?: boolean
      attentionMinMs?: number
      attentionMaxMs?: number
    } = {},
  ): void {
    agent = new UnifiedAgent(
      makeAgentConfig({
        configured: true,
        moduleId: 'group-batch-agent',
        port: 19996,
        ...(opts.attentionMinMs !== undefined ? { attentionMinMs: opts.attentionMinMs } : {}),
        ...(opts.attentionMaxMs !== undefined ? { attentionMaxMs: opts.attentionMaxMs } : {}),
      }),
    )
    internals = agent as unknown as Internals

    internals.channelPorts.set('wechat', WECHAT_PORT)
    internals.crabDisplayNames.set('wechat', '小蟹')
    internals.crabSelfHandles.set('wechat', '@crabot_wx')

    // 事件入口驱动时，lane 是同步 kick 的但 handler 内部有 await；
    // 这里把 in-flight promise 记下来，测试用 settleGroupLane() 等它落地。
    // 构造函数的接线是 `(batch) => this.processGroupLaneBatch(batch)`（调用时才解引用），
    // 所以实例上包一层不破坏任何生产装配。
    const realGroupBatch = (
      Object.getPrototypeOf(agent) as { processGroupLaneBatch: (b: GroupBatch) => Promise<void> }
    ).processGroupLaneBatch.bind(agent)
    internals.processGroupLaneBatch = (batch: GroupBatch) => {
      const p = realGroupBatch(batch)
      inflight.push(p)
      return p
    }

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
          return { platform_message_id: 'ack-g1', sent_at: '2026-07-31T00:00:05.000Z' }
        case 'add_reaction':
          calls.push('add_reaction')
          return {}
        case 'get_message':
          calls.push('get_message')
          return {
            platform_message_id: (params as { platform_message_id: string }).platform_message_id,
            sender: { platform_user_id: 'u-9', platform_display_name: '王五' },
            content: { type: 'text', text: '这是群里被引用的原文' },
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

    const realStartTrace = internals.traceStore.startTrace.bind(internals.traceStore)
    internals.traceStore.startTrace = (params) => {
      calls.push(`start_trace:${params.trigger.type}`)
      return realStartTrace(params)
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
        getActiveTasksByOrigin: (channelId: string, sessionId: string) => {
          calls.push('get_active_tasks_by_origin')
          originQueries.push({ channelId, sessionId })
          return [...originTasks]
        },
        setBarrierForTask: (taskId: string, timeoutMs: number) => {
          calls.push('set_barrier')
          // 已 park（ask_human）的 task arm 失败——生产语义见 unified-agent.ts:1343-1345
          if (parkedTasks.includes(taskId)) return false
          barrierArmed.push({ taskId, timeoutMs })
          return true
        },
        clearBarrierForTask: (taskId: string) => {
          calls.push('clear_barrier')
          barrierCleared.push(taskId)
        },
        registerTriggerAndActivate: async (params: SpawnCall) => {
          calls.push('register_trigger')
          spawnCalls.push(params)
          return {
            taskId: 'task-group-new',
            registered: true,
            task: {},
            context: {},
            taskTitle: '新群任务',
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

  /** 一个 attention 批次 = 一条 lane item。 */
  function attentionBatch(messages: ChannelMessage[], friend = makeFriend('f-1')) {
    return { messages: messages.map((message) => ({ message, friend })), sessionId: GROUP_SESSION }
  }

  /** 直接喂 handler：batch 形状完全可控（laneBatchSize / 跨 batch 合并）。 */
  function runGroup(messages: ChannelMessage[], friend = makeFriend('f-1')): Promise<void> {
    return internals.processGroupLaneBatch([attentionBatch(messages, friend)])
  }

  /** 走真实事件入口：@mention 消息在 AttentionScheduler 里同步 flushNow。 */
  async function deliverMention(message: ChannelMessage, friend = makeFriend('f-1')): Promise<void> {
    await internals.onEvent(authorizedEvent({ message, friend, crab_display_name: '小蟹', crab_self_handle: '@crabot_wx' }))
    await settleGroupLane()
  }

  async function settleGroupLane(): Promise<void> {
    while (inflight.length > 0) {
      const batch = inflight.splice(0)
      await Promise.all(batch)
    }
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
    barrierArmed = []
    barrierCleared = []
    originQueries = []
    inflight = []
    capturedCtx = undefined
    capturedDeps = undefined
    permsResponse = GROUP_PERMS
    sessionScopes = ['session-scope-1']
    supplementCandidates = [ACTIVE_TASK]
    activeTasks = [ACTIVE_TASK]
    recentMessages = [HISTORY_MESSAGE]
    hasActiveTaskResult = true
    originTasks = []
    parkedTasks = []
    workerGate = undefined
    workerSettled = false
    dispatchMock.mockReset()
    setDispatchActions([{ kind: 'new_task' }])
    dataDir = await useTmpDataDir('inbound-pglb-')
  })

  afterEach(async () => {
    internals?.attentionScheduler.stopAll()
    vi.restoreAllMocks()
    await dataDir.restore()
  })

  // ==========================================================================
  // 批合并与 trace 起点（变异靶 M2）
  // ==========================================================================

  describe('批合并与 trace 起点（变异靶 M2）', () => {
    it('trace 记 message 触发、批内每条都进 summary、source 是来源 channel', async () => {
      boot()
      await runGroup([
        gmsg({ id: 'g-1', text: '第一条', senderName: '张三' }),
        gmsg({ id: 'g-2', text: '第二条', senderName: '李四' }),
      ])

      const trace = dispatchTrace()
      expect(trace.trigger.type).toBe('message')
      expect(trace.trigger.source).toBe('wechat')
      expect(trace.trigger.summary).toBe('[group×2] 张三: 第一条 | 李四: 第二条')
      expect(trace.module_id).toBe('group-batch-agent')
    })

    it('lane 攒下的多个 attention 批次合并成一轮处理，不丢任何一批', async () => {
      boot()
      const friend = makeFriend('f-1')
      await internals.processGroupLaneBatch([
        attentionBatch([gmsg({ id: 'g-1', text: '第一批' })], friend),
        attentionBatch([gmsg({ id: 'g-2', text: '第二批甲' }), gmsg({ id: 'g-3', text: '第二批乙' })], friend),
      ])

      expect(capturedCtx!.messages.map((m) => m.platform_message_id)).toEqual(['g-1', 'g-2', 'g-3'])
      expect(spawnCalls[0].messages.map((m) => m.platform_message_id)).toEqual(['g-1', 'g-2', 'g-3'])
      // dispatcher 靠 laneBatchSize 知道这轮攒了几批（提示语用）
      expect(capturedDeps!.laneBatchSize).toBe(2)
      // 只起一轮 dispatch / 一个 trace
      expect(dispatchMock).toHaveBeenCalledTimes(1)
      expect(internals.traceStore.getTraces(50).traces.filter((t) => t.trigger.type === 'message')).toHaveLength(1)
    })

    it('整批交给 dispatcher 和 worker，发起人取批内最后一条', async () => {
      boot()
      const older = makeFriend('f-1')
      const newer = makeFriend('f-2')
      await internals.processGroupLaneBatch([
        {
          messages: [
            { message: gmsg({ id: 'g-1', text: '第一条', senderId: 'u-1', friendId: 'f-1' }), friend: older },
            { message: gmsg({ id: 'g-2', text: '第二条', senderId: 'u-2', friendId: 'f-2' }), friend: newer },
          ],
          sessionId: GROUP_SESSION,
        },
      ])

      expect(capturedCtx!.messages.map((m) => m.platform_message_id)).toEqual(['g-1', 'g-2'])
      expect(capturedCtx!.senderFriend.id).toBe('f-2')
      expect(spawnCalls[0].messages.map((m) => m.platform_message_id)).toEqual(['g-1', 'g-2'])
      expect(spawnCalls[0].senderFriend.id).toBe('f-2')
      // 上下文装配按最后一条发言人的视角取，message 汇总整批
      expect(assembleCalls[0].params.sender_id).toBe('u-2')
      expect(assembleCalls[0].params.friend_id).toBe('f-2')
      expect(assembleCalls[0].params.message).toBe('第一条\n第二条')
    })

    it('supplement 投递把整批消息交给目标任务（漏消息 = 静默吃掉群友输入）', async () => {
      boot()
      setDispatchActions([{ kind: 'supplement', target_task_id: 'task-group-active' }])

      await runGroup([gmsg({ id: 'g-1', text: '第一条' }), gmsg({ id: 'g-2', text: '第二条' })])

      expect(deliverCalls).toHaveLength(1)
      expect(deliverCalls[0].taskId).toBe('task-group-active')
      expect(deliverCalls[0].messages.map((m) => m.platform_message_id)).toEqual(['g-1', 'g-2'])
      expect(spawnCalls).toHaveLength(0)
    })

    it('给批内最后一条打"已读"回应（群里只回应最新那条，不是第一条）', async () => {
      boot()
      await runGroup([gmsg({ id: 'g-1', text: '第一条' }), gmsg({ id: 'g-2', text: '第二条' })])

      const reaction = rpcCalls.find((c) => c.method === 'add_reaction')
      expect(reaction).toBeDefined()
      expect(reaction!.port).toBe(WECHAT_PORT)
      expect(reaction!.params).toEqual({
        session_id: GROUP_SESSION,
        platform_message_id: 'g-2',
        kind: 'acknowledged',
      })
    })

    it('空 batch / 批内无消息：不建 trace、不解析权限', async () => {
      boot()
      await internals.processGroupLaneBatch([])
      await internals.processGroupLaneBatch([{ messages: [], sessionId: GROUP_SESSION }])

      expect(calls).toEqual([])
      expect(internals.traceStore.getTraces(50).traces).toHaveLength(0)
    })
  })

  // ==========================================================================
  // 群聊特有 ①：barrier
  // ==========================================================================

  describe('barrier：@bot 时暂停本群在跑的 worker（群聊特有）', () => {
    it('@bot 消息在 dispatcher 决策之前就暂停本群在跑的 worker，处理完解除', async () => {
      boot()
      originTasks = ['task-a', 'task-b']

      await runGroup([gmsg({ id: 'g-1', text: '@小蟹 帮我看下', mention: true })])

      // 只暂停"本群本渠道"发起的任务——别的群的 worker 不受影响
      expect(originQueries).toEqual([{ channelId: 'wechat', sessionId: GROUP_SESSION }])
      expect(barrierArmed.map((b) => b.taskId)).toEqual(['task-a', 'task-b'])
      // 暂停必须自带兜底超时：即使这轮崩了，worker 也不会被永久挂住
      for (const armed of barrierArmed) {
        expect(armed.timeoutMs).toBeGreaterThan(0)
        expect(armed.timeoutMs).toBeLessThanOrEqual(60_000)
      }
      // 顺序：先暂停再决策（否则 worker 可能在决策期间继续往群里发言）
      expect(calls.indexOf('set_barrier')).toBeLessThan(calls.indexOf('dispatch'))
      // 处理完必须解除
      expect(barrierCleared).toEqual(['task-a', 'task-b'])
      expect(calls.lastIndexOf('clear_barrier')).toBeGreaterThan(calls.indexOf('dispatch'))
    })

    it('非 @bot 的普通群消息完全不打断在跑的 worker', async () => {
      boot()
      originTasks = ['task-a']

      await runGroup([gmsg({ id: 'g-1', text: '你们中午吃啥' })])

      expect(barrierArmed).toEqual([])
      expect(barrierCleared).toEqual([])
      expect(calls).not.toContain('get_active_tasks_by_origin')
      // 但这条消息本身照常进 dispatcher 决策
      expect(dispatchMock).toHaveBeenCalledTimes(1)
    })

    it('批内只要有一条 @bot 就暂停（混合批次不按第一条判定）', async () => {
      boot()
      originTasks = ['task-a']

      await runGroup([
        gmsg({ id: 'g-1', text: '你们中午吃啥' }),
        gmsg({ id: 'g-2', text: '@小蟹 你说呢', mention: true }),
      ])

      expect(barrierArmed.map((b) => b.taskId)).toEqual(['task-a'])
    })

    it('已 park 的任务（暂停未生效）不会在收尾时被误唤醒', async () => {
      boot()
      originTasks = ['task-live', 'task-parked']
      parkedTasks = ['task-parked']

      await runGroup([gmsg({ id: 'g-1', text: '@小蟹 在吗', mention: true })])

      expect(barrierArmed.map((b) => b.taskId)).toEqual(['task-live'])
      // 关键语义：ask_human 挂起的 task 不能被这轮的 clear 顺手唤醒
      expect(barrierCleared).toEqual(['task-live'])
      expect(barrierCleared).not.toContain('task-parked')
    })

    it('处理过程中抛错：暂停仍然被解除，不把 worker 悬在那里', async () => {
      boot()
      originTasks = ['task-a']
      dispatchMock.mockImplementation(async () => {
        calls.push('dispatch')
        throw new Error('dispatch boom')
      })

      await runGroup([gmsg({ id: 'g-1', text: '@小蟹 炸了', mention: true })])

      expect(barrierArmed.map((b) => b.taskId)).toEqual(['task-a'])
      expect(barrierCleared).toEqual(['task-a'])
      expect(dispatchTrace().status).toBe('failed')
      expect(dispatchTrace().outcome?.error).toBe('dispatch boom')
      expect(spawnCalls).toHaveLength(0)
    })
  })

  // ==========================================================================
  // 权限身份解析（变异靶 M4）
  // ==========================================================================

  describe('权限身份解析（变异靶 M4）', () => {
    it('按群聊语义解析发起人身份，结果决定这轮 worker 能用哪些工具', async () => {
      boot()
      await runGroup([gmsg({ id: 'g-1', text: '帮我跑个脚本' })])

      expect(spawnCalls[0].resolvedPermissions?.tool_access.shell).toBe(true)
      expect(spawnCalls[0].resolvedPermissions?.tool_access.file_io).toBe(false)
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

      const resolveCall = rpcCalls.find((c) => c.method === 'resolve_principal_permissions')
      expect(resolveCall!.port).toBe(ADMIN_PORT)
      expect(resolveCall!.params).toMatchObject({
        sender_friend_id: 'f-1',
        session_id: GROUP_SESSION,
        session_type: 'group',
      })
    })

    it('解析失败时 fail-closed（只剩 messaging），不是放开也不是沿用上一轮', async () => {
      boot()
      permsResponse = 'throw'
      await runGroup([gmsg({ id: 'g-1' })])

      expect(
        agent.getToolPermissionConfig([
          { name: 'bash', description: '', inputSchema: {}, category: 'shell' },
          { name: 'send_message', description: '', inputSchema: {}, category: 'messaging' },
        ]),
      ).toEqual({ mode: 'denyList', toolNames: ['bash'] })
    })
  })

  // ==========================================================================
  // 群聊特有 ②：memory 档位的两档 fallback（变异靶 M5）
  // ==========================================================================

  describe('memory 权限档位 —— 群聊两档 fallback（变异靶 M5）', () => {
    it('第一档：按解析出的 memory_scopes 授权读写，不是 public/全局', async () => {
      boot()
      await runGroup([gmsg({ id: 'g-1' })])

      const expected: MemoryPermissions = {
        write_visibility: 'internal',
        write_scopes: ['group-scope-a', 'group-scope-b'],
        read_min_visibility: 'internal',
        read_accessible_scopes: ['group-scope-a', 'group-scope-b'],
      }
      expect(spawnCalls[0].memoryPermissions).toEqual(expected)
      expect(assembleCalls[0].memPerms).toEqual(expected)
      expect(spawnCalls[0].memoryPermissions.write_visibility).not.toBe('public')
      expect(spawnCalls[0].memoryPermissions.write_scopes).not.toEqual([])
    })

    it('第二档（群聊专有）：解析成功但 scopes 为空时收敛到本群 session，不允许空 scope 越界', async () => {
      boot()
      permsResponse = { ...GROUP_PERMS, memory_scopes: [] }
      await runGroup([gmsg({ id: 'g-1' })])

      // 空 scope 会让记忆读写落到"无限定"档位，等于跨群泄漏；必须收敛到本群
      expect(spawnCalls[0].memoryPermissions).toEqual({
        write_visibility: 'internal',
        write_scopes: [GROUP_SESSION],
        read_min_visibility: 'internal',
        read_accessible_scopes: [GROUP_SESSION],
      })
      expect(assembleCalls[0].memPerms.read_accessible_scopes).toEqual([GROUP_SESSION])
      // 这一档没有去问 admin 要 session 配置——它是就地收敛，不是第三档
      expect(calls).not.toContain('get_session_config')
      // 同一份收敛结果也进了会话级身份（后续 supplement 热刷新按它走）
      expect(spawnCalls[0].resolvedPermissions.memory_scopes).toEqual([GROUP_SESSION])
    })

    it('第三档：身份解析失败时回落到该 session 配置的 scopes（仍不是公开）', async () => {
      boot()
      permsResponse = 'throw'
      sessionScopes = ['session-scope-1']
      await runGroup([gmsg({ id: 'g-1' })])

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
  // 前置上下文装配（变异靶 M6）
  // ==========================================================================

  describe('前置上下文装配（变异靶 M6）', () => {
    it('装配结果进入 dispatcher 的群聊决策上下文（历史 / 群画像 / 自称 / 候选任务）', async () => {
      boot()
      setDispatchActions([{ kind: 'stay_silent' }])
      await runGroup([gmsg({ id: 'g-1', text: '这事儿接着弄' })])

      expect(capturedCtx!.sessionType).toBe('group')
      expect(capturedCtx!.recentMessages.map((m) => m.platform_message_id)).toEqual(['hist-g1'])
      expect(capturedCtx!.activeTasks.map((t) => t.task_id)).toEqual(['task-group-active'])
      expect(capturedCtx!.sceneProfile).toEqual(SCENE_PROFILE)
      // 多 bot 群里靠它判断哪一段 @ 是发给自己的
      expect(capturedCtx!.crabSelfHandle).toBe('@crabot_wx')
      expect(capturedCtx!.channelId).toBe('wechat')
      expect(capturedCtx!.sessionId).toBe(GROUP_SESSION)
    })

    it('装配请求带的是群聊语义（session_type=group + 本渠道群昵称/自称）', async () => {
      boot()
      await runGroup([gmsg({ id: 'g-1', text: '继续' })])

      expect(assembleCalls[0].params).toMatchObject({
        channel_id: 'wechat',
        session_id: GROUP_SESSION,
        session_type: 'group',
        crab_display_name: '小蟹',
        crab_self_handle: '@crabot_wx',
        message: '继续',
      })
    })

    it('装配出的历史进 worker 且触发批次不被重复渲染成历史，worker 按群聊模式跑', async () => {
      boot()
      const trigger = gmsg({ id: 'g-1', text: '看下这个' })
      recentMessages = [HISTORY_MESSAGE, trigger]
      await runGroup([trigger])

      expect(spawnCalls[0].isGroup).toBe(true)
      expect(spawnCalls[0].frontContext.recent_messages.map((m) => m.platform_message_id)).toEqual(['hist-g1'])
      expect(spawnCalls[0].activeTasks.map((t) => t.task_id)).toEqual(['task-group-active'])
      expect(spawnCalls[0].sceneProfile).toEqual(SCENE_PROFILE)
      expect(spawnCalls[0].channelId).toBe('wechat')
      expect(spawnCalls[0].sessionId).toBe(GROUP_SESSION)
    })

    it('只有装配结果里的候选任务才认得出"已终止任务"，从而走复活而不是往活任务投递', async () => {
      boot()
      supplementCandidates = [TERMINAL_CANDIDATE]
      setDispatchActions([{ kind: 'supplement', target_task_id: 'task-group-terminal' }])

      await runGroup([gmsg({ id: 'g-1', text: '再补一句' })])

      expect(calls).toContain('revive_task_for_supplement')
      expect(actionSpanDetails().outcome).toBe('terminal_task_revived')
      expect(deliverCalls).toHaveLength(0)
      expect(dispatchTrace().related_task_id).toBe('task-group-terminal')
    })
  })

  // ==========================================================================
  // 引用消息预取（变异靶 M7）
  // ==========================================================================

  describe('引用消息预取（变异靶 M7）', () => {
    it('dispatcher 拿到的预取依赖真的能把群里跨窗口引用的原文取回来', async () => {
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
            'group',
            deps.quotedPrefetchDeps,
            () => 'friend',
          )
        }
        return { actions: [{ kind: 'stay_silent' }] }
      })

      await runGroup([gmsg({ id: 'g-1', text: '这个怎么说', replyTo: 'quoted-origin-g1' })])

      expect(prefetched?.get('quoted-origin-g1')?.msg.content.text).toBe('这是群里被引用的原文')
      const fetch = rpcCalls.find((c) => c.method === 'get_message')
      expect(fetch!.port).toBe(WECHAT_PORT)
      expect(fetch!.params).toMatchObject({ session_id: GROUP_SESSION, platform_message_id: 'quoted-origin-g1' })
      expect(capturedDeps!.timezone).toBeTruthy()
    })
  })

  // ==========================================================================
  // 预回复 / spawn / reaction 的顺序（变异靶 M11、M8）
  // ==========================================================================

  describe('预回复 / spawn / reaction 的顺序（变异靶 M11、M8）', () => {
    it('群聊一轮的固定顺序：暂停 worker → 决策 → 预回复 → 起 worker → 解除暂停 → 打已读', async () => {
      boot()
      originTasks = ['task-a']
      setDispatchActions([{ kind: 'new_task', immediate_reply: '收到，我看一下' }])

      await runGroup([gmsg({ id: 'g-1', text: '@小蟹 帮个忙', mention: true })])

      expect(calls).toEqual([
        'start_trace:message',
        'get_active_tasks_by_origin',
        'set_barrier',
        'resolve_permissions',
        'assemble_front_context',
        'dispatch',
        'send_message',
        'register_trigger',
        'start_trace:task',
        'worker_loop',
        'add_reaction',
        'clear_barrier',
      ])
    })

    it('预回复的落地元数据进 worker 的上下文（worker 因此知道自己已经在群里 ack 过）', async () => {
      boot()
      setDispatchActions([{ kind: 'new_task', immediate_reply: '收到，我看一下' }])

      await runGroup([gmsg({ id: 'g-1' })])

      const sent = rpcCalls.find((c) => c.method === 'send_message')
      expect(sent!.port).toBe(WECHAT_PORT)
      expect(sent!.params).toMatchObject({
        session_id: GROUP_SESSION,
        content: { type: 'text', text: '收到，我看一下' },
      })

      const history = spawnCalls[0].frontContext.recent_messages
      const ack = history[history.length - 1]
      expect(ack.platform_message_id).toBe('ack-g1')
      expect(ack.content.text).toBe('收到，我看一下')
      expect(ack.sender.platform_user_id).toBe('self')
      // 群聊 ack 必须挂在本群会话上，不能落到别的 session
      expect(ack.session.session_id).toBe(GROUP_SESSION)
      expect(ack.session.type).toBe('group')
    })

    it('dispatcher 一个动作都没给时 trace 记 silent、不打已读', async () => {
      boot()
      setDispatchActions([])

      await runGroup([gmsg({ id: 'g-1' })])

      expect(dispatchTrace().outcome?.summary).toBe('silent')
      expect(rpcCalls.find((c) => c.method === 'add_reaction')).toBeUndefined()
    })
  })

  // ==========================================================================
  // worker 不阻塞入站（变异靶 M10）
  // ==========================================================================

  describe('worker 不阻塞群聊 lane（变异靶 M10）', () => {
    it('worker 还在跑时本批就已处理完，barrier 已解除、lane 可以接下一批', async () => {
      boot()
      originTasks = ['task-a']
      let release: () => void = () => {}
      workerGate = new Promise<void>((resolve) => {
        release = resolve
      })

      await runGroup([gmsg({ id: 'g-1', text: '@小蟹 慢慢来', mention: true })])

      // 到这里 processGroupLaneBatch 已经返回——若改成同步等 worker，这一行永远到不了
      expect(calls).toContain('worker_loop')
      expect(workerSettled).toBe(false)
      expect(barrierCleared).toEqual(['task-a'])
      expect(dispatchTrace().status).toBe('completed')
      expect(dispatchTrace().outcome?.summary).toBe('dispatched (1 actions)')

      release()
      await new Promise((resolve) => process.nextTick(resolve))
      expect(workerSettled).toBe(true)
    }, 5000)
  })

  // ==========================================================================
  // 群聊特有 ③：退避反馈（变异靶 M9 —— 本 task 的核心）
  // ==========================================================================

  describe('退避反馈：群聊打扰频率（变异靶 M9）', () => {
    it('判定这轮不该出声时，下次巡检间隔按 ×5 拉长（注意力渐远）', async () => {
      boot({ attentionMinMs: 1000 })
      setDispatchActions([{ kind: 'stay_silent', reason: '群友互相聊天' }])

      expect(internals.attentionScheduler.getCurrentIntervalMs(GROUP_SESSION)).toBeUndefined()
      await deliverMention(gmsg({ id: 'g-1', text: '@小蟹 你觉得呢', mention: true }))

      // 退避档位（= 下次巡检最快间隔）被拉长
      expect(internals.attentionScheduler.getCurrentIntervalMs(GROUP_SESSION)).toBe(5000)
      // 且这轮确实没有任何出声动作
      expect(rpcCalls.find((c) => c.method === 'add_reaction')).toBeUndefined()
      expect(rpcCalls.find((c) => c.method === 'send_message')).toBeUndefined()
      expect(spawnCalls).toHaveLength(0)
      expect(deliverCalls).toHaveLength(0)
      expect(dispatchTrace().status).toBe('completed')
      expect(actionSpanDetails().outcome).toBe('silent_discard')
    })

    it('连续判定不出声时退避逐级累积（第二轮再 ×5）', async () => {
      boot({ attentionMinMs: 1000 })
      setDispatchActions([{ kind: 'stay_silent' }])

      await deliverMention(gmsg({ id: 'g-1', mention: true }))
      expect(internals.attentionScheduler.getCurrentIntervalMs(GROUP_SESSION)).toBe(5000)

      await deliverMention(gmsg({ id: 'g-2', mention: true }))
      expect(internals.attentionScheduler.getCurrentIntervalMs(GROUP_SESSION)).toBe(25000)
    })

    it('退避拉长有上限，不会一路退到永不理人', async () => {
      boot({ attentionMinMs: 1000, attentionMaxMs: 3000 })
      setDispatchActions([{ kind: 'stay_silent' }])

      await deliverMention(gmsg({ id: 'g-1', mention: true }))

      expect(internals.attentionScheduler.getCurrentIntervalMs(GROUP_SESSION)).toBe(3000)
    })

    it('这轮出声后注意力被拉回：退避档位从拉长状态回到最小间隔', async () => {
      boot({ attentionMinMs: 1000 })

      setDispatchActions([{ kind: 'stay_silent' }])
      await deliverMention(gmsg({ id: 'g-1', mention: true }))
      expect(internals.attentionScheduler.getCurrentIntervalMs(GROUP_SESSION)).toBe(5000)

      setDispatchActions([{ kind: 'new_task' }])
      await deliverMention(gmsg({ id: 'g-2', mention: true }))

      expect(spawnCalls).toHaveLength(1)
      expect(internals.attentionScheduler.getCurrentIntervalMs(GROUP_SESSION)).toBe(1000)
    })

    it('往在跑的任务投递补充也算"出声"（注意力同样拉回）', async () => {
      boot({ attentionMinMs: 1000 })

      setDispatchActions([{ kind: 'stay_silent' }])
      await deliverMention(gmsg({ id: 'g-1', mention: true }))
      expect(internals.attentionScheduler.getCurrentIntervalMs(GROUP_SESSION)).toBe(5000)

      setDispatchActions([{ kind: 'supplement', target_task_id: 'task-group-active' }])
      await deliverMention(gmsg({ id: 'g-2', mention: true }))

      expect(deliverCalls).toHaveLength(1)
      expect(internals.attentionScheduler.getCurrentIntervalMs(GROUP_SESSION)).toBe(1000)
    })

    it('批内混着沉默与出声动作时按"有出声"算，不按第一条动作算', async () => {
      boot({ attentionMinMs: 1000 })

      setDispatchActions([{ kind: 'stay_silent' }])
      await deliverMention(gmsg({ id: 'g-1', mention: true }))
      expect(internals.attentionScheduler.getCurrentIntervalMs(GROUP_SESSION)).toBe(5000)

      setDispatchActions([{ kind: 'stay_silent' }, { kind: 'new_task' }])
      await deliverMention(gmsg({ id: 'g-2', mention: true }))

      expect(internals.attentionScheduler.getCurrentIntervalMs(GROUP_SESSION)).toBe(1000)
    })

    it('真实事件入口：@bot 群消息走完整条链（注意力 → 群 lane → dispatcher → worker）', async () => {
      boot({ attentionMinMs: 1000 })

      await deliverMention(gmsg({ id: 'g-1', text: '@小蟹 建个任务', mention: true }))

      // 缓冲已被取空，消息确实是经注意力调度落到群聊处理路径的
      expect(internals.attentionScheduler.getBufferSize(GROUP_SESSION)).toBe(0)
      expect(dispatchTrace().trigger.summary).toBe('[group×1] 张三: @小蟹 建个任务')
      expect(spawnCalls[0].isGroup).toBe(true)
      expect(internals.attentionScheduler.getCurrentIntervalMs(GROUP_SESSION)).toBe(1000)
    })
  })

  // ==========================================================================
  // 早退分支
  // ==========================================================================

  describe('早退分支', () => {
    it('没有 worker handler：trace 记失败，barrier 都不去碰', async () => {
      boot({ withHandler: false })
      internals.agentHandler = undefined
      originTasks = ['task-a']

      await runGroup([gmsg({ id: 'g-1', mention: true })])

      const trace = dispatchTrace()
      expect(trace.status).toBe('failed')
      expect(trace.outcome?.summary).toBe('No worker handler configured')
      expect(calls).toEqual(['start_trace:message'])
      expect(dispatchMock).not.toHaveBeenCalled()
    })

    it('没有 worker LLM 环境：早退发生在上下文装配之后，且已 arm 的 barrier 不会泄漏', async () => {
      boot({ withSdkEnv: false })
      internals.sdkEnvWorker = undefined
      originTasks = ['task-a']

      await runGroup([gmsg({ id: 'g-1', mention: true })])

      const trace = dispatchTrace()
      expect(trace.status).toBe('failed')
      expect(trace.outcome?.summary).toBe('sdkEnvWorker missing')
      // 注：这条早退当前既不解除 barrier 也不更新退避档位（见 p7a-task1-report.md §6 O1
      //     与本报告 O7）——那是已登记的 bug 不是契约。所以这里把 clear_barrier 过滤掉，
      //     只钉"早退发生在装配之后"这一条真语义；将来修 bug 补上解除，本用例不该被误挂。
      expect(calls.filter((c) => c !== 'clear_barrier')).toEqual([
        'start_trace:message',
        'get_active_tasks_by_origin',
        'set_barrier',
        'resolve_permissions',
        'assemble_front_context',
      ])
      expect(dispatchMock).not.toHaveBeenCalled()
    })
  })
})
