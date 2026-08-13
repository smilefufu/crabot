/**
 * 入站链路测试网 ④：`processAdminChatMessage` + `handleProcessMessage` 路由。
 *
 * 计划：`crabot-docs/superpowers/plans/2026-08-01-mw-p7-j-cutover.md`
 * 前身：P7 / PR A Task 4（下游是 dispatcher）。**P7 / PR J Task 5 起下游是 manager。**
 *
 * ## 本文件的核心仍然是 admin chat 的"三不"（变异靶 M12）
 *
 * Master Chat 是 admin REST 串行串发的伪 channel（spec 2026-06-10 §4），
 * 与 IM 入站是**两套语义**。三条边界必须钉死，否则 cutover 时很容易被"统一入站"顺手抹平：
 *
 * | 不 | 为什么 | 断言落点 |
 * |---|---|---|
 * | 不进 lane | admin 侧前端 fetch 等响应才发下一条，天然单线 | 两个 `SessionLaneRegistry` 零命中 |
 * | 不进 attention | 注意力调度是群聊"该不该插话"的机制；master 直连每条都必须处理 | `getCurrentIntervalMs('admin-chat') === undefined` |
 * | 无 reaction | admin-web 没有 channel 侧 platform message，无处可打 | 全程零 `add_reaction` RPC |
 *
 * ## cutover 改变了什么
 *
 * - **回执通道**：`chat_callback` 的 `immediate_reply` / `task_created` 两种用途随
 *   dispatcher 一起消失。manager 说话走 `send_message` → `getChannelPort('admin-web')`
 *   → admin 同签名 RPC 回流聊天界面。`chat_callback` 只剩"未配置"这一条早退提示；
 * - **返回值**：v2 的 `decision_types:['create_task']` / `task_ids` 是前置决策器动作分类
 *   的投影，v3 没有等价物 —— 现在只回报"manager 这轮有没有跟人说话"（`direct_reply`），
 *   任务状态改由 `agent.task_status_changed` 事件推给 admin（§9.2）；
 * - **记忆档位**：不再硬编码 master 私有档，改由 `ManagerPrincipalStore` 按 master 身份
 *   解析（与私聊 / 群聊同一条路）。
 *
 * ## `handleProcessMessage` 的 `channel` 分支：已证实为死代码，不写测试
 *
 * 全仓唯一生产调用方 `crabot-admin/src/chat-manager.ts` 固定传 `source_type:'admin_chat'`。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

import type {
  ChannelMessage,
  Friend,
  MemoryPermissions,
  ResolvedPermissions,
  RuntimeSceneProfile,
  ToolAccessConfig,
} from '../../src/types.js'
import { makeAgentConfig, makeMessage, useTmpDataDir, type DataDirGuard } from './harness.js'
import { makeManagerScript, searchMemoryBlock, sendMessageBlock, type ManagerScript } from './manager-script.js'

const hoisted = vi.hoisted(() => ({ managerAdapter: undefined as unknown }))
vi.mock('../../src/agent/agent-handler.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/agent/agent-handler.js')>()
  return { ...actual, adapterFromSdkEnv: () => hoisted.managerAdapter }
})

const { UnifiedAgent } = await import('../../src/unified-agent.js')

// ============================================================================
// fixtures
// ============================================================================

const ADMIN_PORT = 18200
const MEMORY_PORT = 18202
const ADMIN_CHAT_SESSION = 'admin-chat'
const MANAGER_KEY = 'admin-web::admin-chat'
const REQUEST_ID = 'req-42'
const ASSERTION_ID = 'assertion-42'
const ADMIN_CHAT_ASSERTION = [
  Buffer.from('{}').toString('base64url'),
  Buffer.from(JSON.stringify({ assertion_id: ASSERTION_ID })).toString('base64url'),
  'test-signature',
].join('.')

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

const SCENE_PROFILE: RuntimeSceneProfile = {
  label: 'Master 直连',
  content: 'master 喜欢直接给结论',
  source: { scene: { type: 'friend' as const, friend_id: 'master' } },
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

interface ResolvedPrincipalView {
  permissions: ResolvedPermissions | null
  memory: MemoryPermissions
  dialogProfile?: string
  principal: { friend?: Friend; sessionType: 'private' | 'group' }
}

interface Internals {
  handleProcessMessage(params: {
    message: ChannelMessage
    source_type?: 'channel' | 'admin_chat'
    callback_info?: { source_module_id: string; request_id: string }
    admin_chat_assertion?: string
  }): Promise<{ decision_types: string[]; task_ids?: string[] }>
  processDirectBatch(batch: unknown): Promise<void>
  processGroupLaneBatch(batch: unknown): Promise<void>
  buildBuiltinWorkerRuntime(ctx: unknown): { tools: () => ReadonlyArray<{ name: string }> }
  directLaneRegistry: { getOrCreate(key: string): unknown; size(): number }
  groupLaneRegistry: { getOrCreate(key: string): unknown; size(): number }
  contextAssembler: unknown
  managerStack: {
    principals: {
      get(key: string): ResolvedPrincipalView | undefined
      currentMasterAuthorization(key: string): { assertion_id?: string } | undefined
    }
    registry: { routeHumanMessages: (...args: unknown[]) => Promise<unknown> }
  }
  /** fail-loud 的按 key 冷却台账（与私聊 / 群聊两条 lane 共用同一张表）。 */
  failLoudSentAt: Map<string, number>
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

describe('processAdminChatMessage —— admin chat 入站（cutover 后下游是 manager）', () => {
  let dataDir: DataDirGuard
  let agent: InstanceType<typeof UnifiedAgent>
  let internals: Internals
  let script: ManagerScript

  let calls: string[]
  let rpcCalls: Array<{ port: number; method: string; params: Record<string, unknown> }>
  let sceneCalls: Array<{ channelId: string; sessionId: string; sessionType: string; friendId?: string }>
  /** "不进 lane" 的两处观测点。 */
  let laneKeysCreated: string[]
  let laneBatchRuns: string[]

  let permsResponse: ResolvedPermissions | null | 'throw'

  function boot(
    opts: {
      configured?: boolean
      turns?: ReadonlyArray<ReadonlyArray<Record<string, unknown>>>
      consumeResult?: unknown
      consumeError?: Error
    } = {},
  ): void {
    script = makeManagerScript(opts.turns ?? [])
    hoisted.managerAdapter = {
      async *stream(params: unknown) {
        calls.push('manager_llm')
        yield* script.adapter.stream(params as never)
      },
      updateConfig: () => {},
    }

    agent = new UnifiedAgent(
      makeAgentConfig({
        configured: opts.configured !== false,
        moduleId: 'admin-chat-agent',
        port: 19995,
      }),
    )
    internals = agent as unknown as Internals
    internals.agentHandler = { createBuiltinBgToolOptions: () => undefined }

    internals.rpcClient.resolve = async (filter) => {
      const f = filter as { module_type?: string; module_id?: string }
      if (f.module_type === 'memory') {
        return [{ module_id: 'memory', module_type: 'memory', host: 'localhost', port: MEMORY_PORT, status: 'running' }]
      }
      return [{ module_id: 'admin-web', module_type: 'admin', host: 'localhost', port: ADMIN_PORT, status: 'running' }]
    }
    const rpcCall = async (port: number, method: string, params: unknown) => {
      rpcCalls.push({ port, method, params: params as Record<string, unknown> })
      switch (method) {
        case 'consume_admin_chat_assertion':
          if (opts.consumeError) throw opts.consumeError
          return opts.consumeResult ?? { consumed: true, expires_at: '2099-01-01T00:00:00.000Z' }
        case 'resolve_principal_permissions':
          calls.push('resolve_permissions')
          if (permsResponse === 'throw') throw new Error('admin unreachable')
          return { resolved: permsResponse, sources: {} }
        case 'get_session_config':
          calls.push('get_session_config')
          return { config: { memory_scopes: [] } }
        case 'find_master_friend':
          return { friend: null }
        case 'chat_callback':
          calls.push(`chat_callback:${(params as { reply_type: string }).reply_type}`)
          return { received: true }
        case 'send_message':
          calls.push('send_message')
          return { platform_message_id: 'sent-a1', sent_at: '2026-07-31T00:00:05.000Z' }
        case 'add_reaction':
          calls.push('add_reaction')
          return {}
        case 'search_short_term':
          calls.push('search_short_term')
          return { results: [] }
        default:
          return {}
      }
    }
    internals.rpcClient.call = rpcCall
    internals.rpcClient.callSensitive = rpcCall

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
      resolveSceneProfile: async (
        channelId: string,
        sessionId: string,
        sessionType: string,
        friendId?: string,
      ): Promise<RuntimeSceneProfile | null> => {
        sceneCalls.push({ channelId, sessionId, sessionType, ...(friendId ? { friendId } : {}) })
        return SCENE_PROFILE
      },
    }
  }

  /** 走真实 RPC 入口（`handleProcessMessage`），不直接调私有方法。 */
  let requestCounter = 0
  function runAdminChat(
    message: ChannelMessage = amsg({ id: 'a-1' }),
    requestId?: string,
  ): Promise<{ decision_types: string[]; task_ids?: string[] }> {
    // P6-A：durable inbound CAS 按 request_id 判重——每次入站必须唯一 ID（与生产一致）。
    requestCounter += 1
    const effectiveRequestId = requestId ?? `${REQUEST_ID}-${requestCounter}`
    return internals.handleProcessMessage({
      message,
      source_type: 'admin_chat',
      callback_info: { source_module_id: CALLBACK_INFO.source_module_id, request_id: effectiveRequestId },
      admin_chat_assertion: ADMIN_CHAT_ASSERTION,
    })
  }

  function callbacksOf(replyType: string): Array<Record<string, unknown>> {
    return rpcCalls.filter((c) => c.method === 'chat_callback' && c.params.reply_type === replyType).map((c) => c.params)
  }

  /** P6-A §11.11：直回（未配置/fail-loud）走 admin-web send_message + delivery 事务。 */
  function directDeliveries(): Array<{ delivery_id?: string; request_ids?: string[]; content?: { text?: string } }> {
    return rpcCalls
      .filter((c) => c.method === 'send_message' && (c.params as { delivery_id?: string }).delivery_id !== undefined)
      .map((c) => c.params as { delivery_id?: string; request_ids?: string[]; content?: { text?: string } })
  }

  function principal(): ResolvedPrincipalView | undefined {
    return internals.managerStack.principals.get(MANAGER_KEY)
  }

  function workerToolNames(): string[] {
    return internals
      .buildBuiltinWorkerRuntime({
        worker_id: 'w-probe',
        workspace: { root: dataDir.root },
        origin: { spawned_by_episode: MANAGER_KEY, trigger_type: 'message' },
      })
      .tools()
      .map((t) => t.name)
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

  function reply(text = '好的，我看一下'): Record<string, unknown> {
    return sendMessageBlock({ channelId: 'admin-web', sessionId: ADMIN_CHAT_SESSION, text })
  }

  beforeEach(async () => {
    calls = []
    rpcCalls = []
    sceneCalls = []
    laneKeysCreated = []
    laneBatchRuns = []
    permsResponse = MASTER_PERMS
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
    it('带回执信息的 admin_chat 消息固定落在 admin-web / admin-chat 的 manager 上', async () => {
      boot()
      await runAdminChat(amsg({ id: 'a-1', text: '帮我看下季度报表' }))

      // 处理端不看消息自带的 session（入参故意给了 wechat / some-other-session）
      expect(principal(), '身份应当解析在 admin-web::admin-chat 这个 manager key 上').toBeDefined()
      expect(internals.managerStack.principals.currentMasterAuthorization(MANAGER_KEY)?.assertion_id).toBe(ASSERTION_ID)
      expect(sceneCalls[0]).toMatchObject({
        channelId: 'admin-web',
        sessionId: ADMIN_CHAT_SESSION,
        sessionType: 'private',
      })
      expect(rpcCalls.find((c) => c.method === 'resolve_principal_permissions')!.params).toMatchObject({
        session_id: ADMIN_CHAT_SESSION,
      })
      expect(script.streams[0].tools.map((tool) => tool.name)).toContain('list_all_workers')
      expect(String(script.streams[0].messages[0].content)).toContain('帮我看下季度报表')
    })

    it('admin_chat 缺 assertion 或回执信息：拒绝且不唤醒 manager', async () => {
      boot()
      await expect(internals.handleProcessMessage({
        message: amsg({ id: 'a-1' }),
        source_type: 'admin_chat',
      })).rejects.toThrow(/assertion/)

      expect(calls).toEqual([])
      expect(script.streams).toHaveLength(0)
      expect(rpcCalls).toEqual([])
    })
    it.each([
      ['rejected consume', undefined, new Error('replayed assertion')],
      ['empty consume result', {}, undefined],
      ['false consumed', { consumed: false, expires_at: '2099-01-01T00:00:00.000Z' }, undefined],
      ['expired consume result', { consumed: true, expires_at: '2000-01-01T00:00:00.000Z' }, undefined],
    ])('%s causes zero Manager wake', async (_name, consumeResult, consumeError) => {
      boot({ consumeResult, consumeError })
      await expect(runAdminChat()).rejects.toThrow(/assertion|replayed/i)
      expect(script.streams).toHaveLength(0)
      expect(calls).not.toContain('manager_llm')
    })

    it('a consumed response cannot make a malformed assertion payload establish authority', async () => {
      boot({ consumeResult: { consumed: true, expires_at: '2099-01-01T00:00:00.000Z' } })
      await expect(internals.handleProcessMessage({
        message: amsg(),
        source_type: 'admin_chat',
        callback_info: CALLBACK_INFO,
        admin_chat_assertion: 'malformed',
      })).rejects.toThrow(/assertion payload/i)
      expect(script.streams).toHaveLength(0)
      expect(calls).not.toContain('manager_llm')
    })

    it('forged source, friend, callback, or replay cannot bypass assertion consumption', async () => {
      boot({ consumeError: new Error('replayed assertion') })
      for (const params of [
        { message: amsg(), source_type: 'channel' as const, callback_info: CALLBACK_INFO, admin_chat_assertion: 'x' },
        { message: { ...amsg(), sender: { friend_id: 'master', platform_user_id: 'master', platform_display_name: 'Master' } }, source_type: 'admin_chat' as const, callback_info: { source_module_id: 'forged', request_id: 'r' }, admin_chat_assertion: 'x' },
        { message: amsg(), source_type: 'admin_chat' as const, callback_info: CALLBACK_INFO, admin_chat_assertion: 'replay' },
      ]) {
        await expect(internals.handleProcessMessage(params)).rejects.toThrow()
      }
      expect(script.streams).toHaveLength(0)
    })
  })

  // ==========================================================================

  describe('admin chat 的"三不"语义（变异靶 M12）', () => {
    it('不进 lane：一轮 master 对话全程不碰任何会话 lane（admin REST 天然单线）', async () => {
      boot({ turns: [[reply()]] })
      await runAdminChat()

      expect(laneKeysCreated).toEqual([])
      expect(laneBatchRuns).toEqual([])
      expect(internals.directLaneRegistry.size()).toBe(0)
      expect(internals.groupLaneRegistry.size()).toBe(0)
      // 反向锚点：这轮确实处理了（不是因为早退才没碰 lane）
      expect(script.streams.length).toBeGreaterThan(0)
    })

    it('不进注意力调度：admin-chat 连注意力状态都不该被建出来', async () => {
      boot()
      await runAdminChat()

      // 建了 state 就意味着 master 的话可能被"注意力渐远"推迟甚至跳过
      expect(internals.attentionScheduler.getCurrentIntervalMs(ADMIN_CHAT_SESSION)).toBeUndefined()
      expect(internals.attentionScheduler.getBufferSize(ADMIN_CHAT_SESSION)).toBe(0)
      expect(script.streams.length).toBeGreaterThan(0)
    })

    it('不打"已读"回应：admin-web 没有 channel 侧消息可回应', async () => {
      boot({ turns: [[reply()]] })
      await runAdminChat()

      expect(rpcCalls.find((c) => c.method === 'add_reaction')).toBeUndefined()
      expect(calls).not.toContain('add_reaction')
      // 反向锚点：manager 的回话确实走了 admin 伪 channel 的 send_message
      expect(rpcCalls.find((c) => c.method === 'send_message')).toBeDefined()
    })

    it('三不在"回话 / 沉默"两条路径上同样成立', async () => {
      boot({ turns: [[reply()]] })
      await runAdminChat(amsg({ id: 'a-1' }))
      expectThreeNots()

      script = makeManagerScript([])
      await runAdminChat(amsg({ id: 'a-2' }))
      expectThreeNots()

      expect(script.streams.length).toBeGreaterThan(0)
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

      const names = workerToolNames()
      // master 的 file_io / shell 开着 → worker 拿得到
      expect(names).toContain('Bash')
      expect(names).toContain('Write')
      // 但 master 派的 worker 仍然不能直接跟人类说话（v3 不变量不被身份放宽）
      expect(names).not.toContain('send_message')
    })

    it('看到的是 master 本人（permission=master），不是普通好友', async () => {
      boot()
      await runAdminChat()

      expect(principal()!.principal.friend).toMatchObject({ id: 'master', permission: 'master' })
      expect(principal()!.principal.sessionType).toBe('private')
    })

    it('记忆档位按 master 身份解析出的 scopes 走（不再是硬编码的私有档）', async () => {
      boot({ turns: [[searchMemoryBlock()]] })
      await runAdminChat()

      const search = rpcCalls.find((c) => c.method === 'search_short_term')
      expect(search!.port).toBe(MEMORY_PORT)
      expect(search!.params.accessible_scopes).toEqual(['master-scope'])
      expect(search!.params.min_visibility).toBe('internal')
      expect(principal()!.memory.write_scopes).toEqual(['master-scope'])
    })

    it('身份解析失败时不写入身份，worker 退回固定档位（不是放开）', async () => {
      boot()
      permsResponse = 'throw'
      await runAdminChat()

      expect(principal()!.permissions).toBeNull()
      const names = workerToolNames()
      expect(names).not.toContain('send_message')
      expect(names).toContain('Bash')
    })
  })

  // ==========================================================================
  // 对话对象档案与消息渲染
  // ==========================================================================

  describe('对话对象档案与消息渲染', () => {
    it('master 的场景画像进 manager system prompt；触发消息完整渲染进上下文', async () => {
      boot()
      await runAdminChat(amsg({ id: 'a-1', text: '把上周的事收个尾' }))

      const sys = script.streams[0].systemPrompt as string
      expect(sys).toContain('## 对话对象档案')
      expect(sys).toContain('master 喜欢直接给结论')

      const rendered = String(script.streams[0].messages[0].content)
      expect(rendered).toContain('id="a-1"')
      expect(rendered).toContain('把上周的事收个尾')
      // admin chat 是"刚说的话"，不是攒批放行
      expect(rendered).toContain('[人类消息]')
    })
  })

  // ==========================================================================
  // 返回值（RPC 响应）
  // ==========================================================================

  describe('返回值（RPC 响应）', () => {
    it('manager 跟人说了话 → 回报 direct_reply', async () => {
      boot({ turns: [[reply('这就去办')]] })
      const result = await runAdminChat()

      expect(result).toEqual({ decision_types: ['direct_reply'] })
      const sent = rpcCalls.find((c) => c.method === 'send_message')
      // admin-web 是伪 channel：出站 RPC 路由到 admin 模块
      expect(sent!.port).toBe(ADMIN_PORT)
      expect(sent!.params).toMatchObject({
        session_id: ADMIN_CHAT_SESSION,
        content: { type: 'text', text: '这就去办' },
      })
    })

    it('manager 一句话都没说 → 空返回（不再有 create_task / task_ids 这类动作投影）', async () => {
      boot()
      const result = await runAdminChat()

      expect(result).toEqual({ decision_types: [] })
      expect(result.task_ids).toBeUndefined()
    })
  })

  // ==========================================================================
  // 早退与异常
  // ==========================================================================

  describe('早退与异常', () => {
    it('未配置 LLM：回一条提示、不唤醒 manager', async () => {
      boot({ configured: false })
      const result = await runAdminChat()

      expect(result).toEqual({ decision_types: [] })
      const deliveries = directDeliveries()
      expect(deliveries).toHaveLength(1)
      expect(deliveries[0].content?.text).toBe('Crabot 尚未配置 LLM 模型。请在全局设置中完成配置后重试。')
      expect(deliveries[0].request_ids).toEqual([expect.stringContaining(REQUEST_ID)])
      // chat_callback 退役后不再出现
      expect(callbacksOf('direct_reply')).toHaveLength(0)
      expect(script.streams).toHaveLength(0)
      expectThreeNots()
    })

  })

  // ==========================================================================
  // fail-loud 兜底（plan §三）—— Master Chat 这一条
  //
  // 与私聊 / 群聊两条 lane **共用同一套**判据（`ManagerEpisodeFailure`：catch + outcome
  // 双管）、同一份文案（`buildFailLoudText`）、同一张冷却表（`failLoudSentAt`）。
  // **只有出站那一跳不同**：
  //
  // - lane 走 `getChannelPort` + 裸 `send_message`；
  // - admin chat 走 `chat_callback`。admin-web 伪 channel 的 `send_message` 落到
  //   `chat_push`（**追加**新消息），前端那个转圈的占位气泡只认 `request_id` 匹配的
  //   `chat_reply`（来自 `chat_callback`）。用 `send_message` 兜底 = 人类看到一条报错，
  //   旁边还挂着一个永远转不完的圈。
  //
  // 冷却命中 / `chat_callback` 自身失败时**把异常抛回 RPC 调用方**：admin 的
  // `dispatchToAgent` catch 会推 `chat_error`，占位气泡照样收口，且不会往消息库里
  // 再落一条重复的兜底文案 —— 冷却在这条路上保住的正是"不重复落库"。
  // ==========================================================================

  describe('fail-loud 兜底（plan §三）', () => {
    /** 让 registry 按 F1 的样子返回：正常 resolve，只是 outcome 是 failed。 */
    function stubOutcome(outcome: 'failed' | 'aborted' | 'completed'): void {
      internals.managerStack.registry.routeHumanMessages = async () => ({
        episodeId: 'ep-1',
        outcome,
        turns: 1,
        consumedEvents: outcome === 'completed',
        repliedToHuman: false,
      })
    }

    /** 兜底文案的观测口：delivery 事务的 send_message content（chat_callback 已退役）。 */
    function failLoudText(): string | undefined {
      const deliveries = directDeliveries()
      return deliveries.length > 0 ? deliveries[deliveries.length - 1].content?.text : undefined
    }

    it('F1：真实 loop 里 LLM 挂掉（不抛错）时 master 仍然收到一条明确回执', async () => {
      boot()
      hoisted.managerAdapter = {
        // eslint-disable-next-line require-yield
        async *stream() {
          calls.push('manager_llm')
          throw new Error('manager boom')
        },
        updateConfig: () => {},
      }

      await expect(runAdminChat()).resolves.toEqual({ decision_types: [] })

      const deliveries = directDeliveries()
      expect(deliveries, 'F1 下 Master Chat 什么都收不到 = 只剩一个转不完的圈').toHaveLength(1)
      expect(deliveries[0].request_ids?.[0]).toContain(REQUEST_ID)
      expect(failLoudText()).toContain('管理员')
      expectThreeNots()
    })

    /**
     * **判据里的 outcome 那一管**：registry 正常 resolve、一个异常都不抛，只有 outcome 是
     * failed。去掉 outcome 判据（只留 catch）这条必挂。
     */
    it('F1：episode 正常 resolve 但 outcome=failed 时也必须兜底（只 catch 抓不住）', async () => {
      boot()
      stubOutcome('failed')

      await expect(runAdminChat()).resolves.toEqual({ decision_types: [] })
      expect(failLoudText()).toContain('failed')
      expect(failLoudText()).toContain('管理员')
    })

    it('F1：outcome=aborted 同样兜底', async () => {
      boot()
      stubOutcome('aborted')

      await runAdminChat()
      expect(failLoudText()).toContain('aborted')
    })

    /**
     * F2：唤醒本身抛错。cutover 前这里是"原样抛回 RPC 调用方"，admin 侧只会推一条笼统的
     * `chat_error`（"系统暂时不可用"）。现在改成先把**带原因**的回执送到人眼前。
     */
    it('F2：episode 抛错时不再裸抛，改发带原始错误的兜底回执', async () => {
      boot()
      internals.managerStack.registry.routeHumanMessages = async () => {
        throw new Error('route boom')
      }

      await expect(runAdminChat()).resolves.toEqual({ decision_types: [] })
      expect(failLoudText()).toContain('route boom')
      expectThreeNots()
    })

    it('F2：manager model slot 没配时，文案说清"去 Admin 配 manager 槽位"', async () => {
      boot()
      internals.managerStack.registry.routeHumanMessages = async () => {
        throw new Error(
          "[ManagerLoop] model_config 缺少 'manager' 与 'powerful' 两个 slot，manager loop 无法解析可用的 LLM 连接信息",
        )
      }

      await runAdminChat()

      const text = failLoudText()!
      expect(text).toContain('Admin')
      expect(text).toContain('manager')
      expect(text).toContain('槽位')
    })

    /**
     * F3 不兜：与另两条路同一条纪律——"故意沉默"和"prompt 坏了"在信号层面无法区分，
     * 误报（无缘无故说"我出错了"）比漏报更伤。
     */
    it('F3：episode 正常完成但 manager 决定沉默时，一个字都不发', async () => {
      boot() // 空脚本 = manager 一句话都不说

      await expect(runAdminChat()).resolves.toEqual({ decision_types: [] })
      expect(callbacksOf('direct_reply')).toEqual([])
      expect(rpcCalls.find((c) => c.method === 'send_message')).toBeUndefined()
    })

    it('F3：连续静默到阈值时记一条 warn（只记日志，仍然不发回执）', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      boot()

      for (let i = 0; i < 3; i++) {
        await runAdminChat(amsg({ id: `a-${i}` }))
      }

      expect(warn.mock.calls.some((c) => String(c[0]).includes('连续 3 轮'))).toBe(true)
      expect(callbacksOf('direct_reply')).toEqual([])
    })

    /**
     * 出站那一跳的判据：**必须是 `chat_callback`**。走 admin-web 伪 channel 的
     * `send_message` 会落到 `chat_push`（追加），占位气泡不会被收口。
     */
    it('兜底走带 delivery 事务的 send_message（chat_callback 已退役，占位气泡靠 request_ids 结算）', async () => {
      boot()
      stubOutcome('failed')

      await runAdminChat()

      const deliveries = directDeliveries()
      expect(deliveries).toHaveLength(1)
      expect(deliveries[0].delivery_id).toBeTruthy()
      expect(deliveries[0].request_ids?.[0]).toContain(REQUEST_ID)
      expect(rpcCalls.filter((c) => c.method === 'chat_callback')).toHaveLength(0)
    })

    it('冷却去重：连续三轮失败只往消息库里落一条兜底文案', async () => {
      boot()
      stubOutcome('failed')

      for (let i = 0; i < 3; i++) {
        await runAdminChat(amsg({ id: `a-${i}` })).catch(() => {/* 冷却命中会抛，见下一条 */})
      }

      expect(directDeliveries()).toHaveLength(1)
    })

    /**
     * 冷却命中时**不能就这么算了**：admin chat 是请求 / 响应式的，每条 master 消息都挂着
     * 一个转圈的占位气泡。抛回调用方让 admin 侧既有的 `chat_error` 去收口它。
     */
    it('冷却命中时把异常抛回 RPC 调用方（交给 admin 的 chat_error 收口占位气泡）', async () => {
      boot()
      stubOutcome('failed')

      await runAdminChat(amsg({ id: 'a-1' }))
      await expect(runAdminChat(amsg({ id: 'a-2' }))).rejects.toThrow(/failed/)
    })

    it('冷却窗口过去之后可以再告诉一次（不是一次性哑掉）', async () => {
      boot()
      stubOutcome('failed')

      await runAdminChat(amsg({ id: 'a-1' }))
      internals.failLoudSentAt.set('admin-web::admin-chat', Date.now() - 6 * 60 * 1000)
      await runAdminChat(amsg({ id: 'a-2' }))

      expect(directDeliveries()).toHaveLength(2)
    })

    it('冷却按 key 隔离：admin chat 的冷却不吃掉 channel 会话那边的兜底', async () => {
      boot()
      stubOutcome('failed')

      await runAdminChat()
      expect(internals.failLoudSentAt.has('admin-web::admin-chat')).toBe(true)
      expect(internals.failLoudSentAt.has('wechat::sess-1')).toBe(false)
    })

    /**
     * 兜底路径与 manager 栈零共享：manager 彻底坏掉（registry 直接抛）时这条回执仍然发得出去
     * ——它只依赖 rpcClient + admin 端口。`chat_callback` 也失败才抛回调用方。
     */
    it('兜底 delivery 发送失败时，把异常抛回调用方而不是静默吞掉', async () => {
      boot()
      stubOutcome('failed')
      const realCall = internals.rpcClient.call
      internals.rpcClient.call = async (port, method, params, from) => {
        if (method === 'send_message' && (params as { delivery_id?: string }).delivery_id !== undefined) throw new Error('admin unreachable')
        return realCall(port, method, params, from)
      }

      await expect(runAdminChat()).rejects.toThrow(/failed/)
    })
  })
})
