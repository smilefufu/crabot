/**
 * 入站链路测试网 ②：`processDirectBatch`（私聊 lane handler）。
 *
 * 计划：`crabot-docs/superpowers/plans/2026-08-01-mw-p7-j-cutover.md`
 * 前身：P7 / PR A Task 2（下游是 dispatcher）。**P7 / PR J Task 5 起下游是 manager。**
 *
 * ## cutover 之后这条路径还剩什么
 *
 * plan §一 的 8 件事里，私聊 lane handler 只保留两件：
 *
 * | 保留 | 落点 |
 * |---|---|
 * | `reactToTriggerMessage`（且**时机提前**到"消息递给 manager 时"） | 接线层，本文件 |
 * | 整批消息 + 发言者 friend 递给 manager | `ManagerRegistry.routeHumanMessages` |
 *
 * 其余六件（`updateLastMessageTime` / `startTrace` / `recent_messages` /
 * `active_tasks` / `sendImmediateReply` / 引用预取）**明确放弃**；
 * 权限身份、memory 档位、场景画像、`crab_self_handle` 三件**迁进 manager 的唤醒边界**
 * （`ManagerPrincipalStore`），所以本文件对它们的断言全部改从 manager 侧的真实出口读。
 *
 * ## 手法
 *
 * - **真实构造函数**（`roles: []`）+ 真实 `buildManagerStack`（构造函数里就装配好）；
 * - **唯一被替身的是 LLM**：`adapterFromSdkEnv` 是模块级函数、没有实例注入口，
 *   用 `vi.mock` 换成脚本 adapter（与 PR A 时期 mock `dispatch()` 同一手法）。
 *   manager 的工具面、`ManagerPrincipalStore`、harness、记忆 server 全是真件；
 * - **顺序断言只用一条 `calls: string[]` 序列**；
 * - 零 fake timer。
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
import { makeAgentConfig, makeFriend, makeMessage, useTmpDataDir, type DataDirGuard } from './harness.js'
import { makeManagerScript, searchMemoryBlock, sendMessageBlock, type ManagerScript } from './manager-script.js'

// LLM 是这条链路上唯一被替身的东西：`adapterFromSdkEnv` 是模块级函数，没有实例注入口。
const hoisted = vi.hoisted(() => ({ managerAdapter: undefined as unknown }))
vi.mock('../../src/agent/agent-handler.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/agent/agent-handler.js')>()
  return { ...actual, adapterFromSdkEnv: () => hoisted.managerAdapter }
})

const { UnifiedAgent } = await import('../../src/unified-agent.js')

// ============================================================================
// fixtures
// ============================================================================

const ADMIN_PORT = 18000
const WECHAT_PORT = 18001
const MEMORY_PORT = 18002
const MANAGER_KEY = 'wechat::sess-1'

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

const SCENE_PROFILE: RuntimeSceneProfile = {
  label: '私聊场景',
  content: '这个人喜欢直接给结论',
  source: { scene: { type: 'friend' as const, friend_id: 'f-1' } },
}

interface ResolvedPrincipalView {
  permissions: ResolvedPermissions | null
  memory: MemoryPermissions
  dialogProfile?: string
  principal: { friend?: Friend; sessionType: 'private' | 'group' }
}

interface Internals {
  processDirectBatch(batch: ReadonlyArray<{ message: ChannelMessage; friend: Friend }>): Promise<void>
  buildBuiltinWorkerRuntime(ctx: unknown): { tools: () => ReadonlyArray<{ name: string }> }
  contextAssembler: unknown
  channelPorts: Map<string, number>
  crabSelfHandles: Map<string, string>
  attentionScheduler: { stopAll(): void; getCurrentIntervalMs(sessionId: string): number | undefined }
  managerStack: {
    principals: { get(key: string): ResolvedPrincipalView | undefined }
    registry: { routeHumanMessages: (...args: unknown[]) => Promise<unknown> }
  }
  rpcClient: {
    call: (port: number, method: string, params: unknown, from?: string) => Promise<unknown>
    resolve: (filter: unknown, from?: string) => Promise<unknown[]>
  }
}

describe('processDirectBatch —— 私聊 lane handler（cutover 后下游是 manager）', () => {
  let dataDir: DataDirGuard
  let agent: InstanceType<typeof UnifiedAgent>
  let internals: Internals
  let script: ManagerScript

  /** 唯一的顺序事实来源。 */
  let calls: string[]
  let rpcCalls: Array<{ port: number; method: string; params: Record<string, unknown> }>
  let sceneCalls: Array<{ channelId: string; sessionId: string; sessionType: string; friendId?: string }>

  // 可按测试改写的响应
  let permsResponse: ResolvedPermissions | null | 'throw'
  let sessionScopes: string[]
  let reactionFails: boolean

  function boot(turns: ReadonlyArray<ReadonlyArray<Record<string, unknown>>> = []): void {
    script = makeManagerScript(turns.map((t) => t))
    hoisted.managerAdapter = {
      async *stream(params: unknown) {
        calls.push('manager_llm')
        yield* script.adapter.stream(params as never)
      },
      updateConfig: () => {},
    }

    agent = new UnifiedAgent(makeAgentConfig({ configured: true, moduleId: 'direct-batch-agent', port: 19997 }))
    internals = agent as unknown as Internals

    internals.channelPorts.set('wechat', WECHAT_PORT)
    internals.crabSelfHandles.set('wechat', '@crabot_wx')

    internals.rpcClient.resolve = async (filter) => {
      const f = filter as { module_type?: string; module_id?: string }
      if (f.module_type === 'memory') {
        return [{ module_id: 'memory', module_type: 'memory', host: 'localhost', port: MEMORY_PORT, status: 'running' }]
      }
      return [{ module_id: 'admin', module_type: 'admin', host: 'localhost', port: ADMIN_PORT, status: 'running' }]
    }
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
        case 'find_master_friend':
          return { friend: null }
        case 'send_message':
          calls.push('send_message')
          return { platform_message_id: 'sent-1', sent_at: '2026-07-31T00:00:05.000Z' }
        case 'add_reaction':
          calls.push('add_reaction')
          if (reactionFails) throw new Error('channel 不支持 add_reaction')
          return {}
        case 'search_short_term':
          calls.push('search_short_term')
          return { results: [] }
        default:
          return {}
      }
    }

    // 场景画像：cutover 后由 `ManagerPrincipalStore` 在唤醒边界解析（不再走 assembleFrontContext）。
    internals.contextAssembler = {
      resolveSceneProfile: async (
        channelId: string,
        sessionId: string,
        sessionType: string,
        friendId?: string,
      ): Promise<RuntimeSceneProfile | null> => {
        calls.push('resolve_scene_profile')
        sceneCalls.push({ channelId, sessionId, sessionType, ...(friendId ? { friendId } : {}) })
        return SCENE_PROFILE
      },
    }
  }

  function batchOf(messages: ChannelMessage[], friend = makeFriend('f-1')) {
    return messages.map((message) => ({ message, friend }))
  }

  function principal(): ResolvedPrincipalView | undefined {
    return internals.managerStack.principals.get(MANAGER_KEY)
  }

  /** manager 派出去的 builtin worker 实际拿到的工具面（§8.2 权限身份的终点）。 */
  function workerToolNames(): string[] {
    return internals
      .buildBuiltinWorkerRuntime({
        worker_id: 'w-probe',
        workspace: { root: dataDir.root },
        origin: { spawned_by_session: MANAGER_KEY, trigger_type: 'message' },
      })
      .tools()
      .map((t) => t.name)
  }

  beforeEach(async () => {
    calls = []
    rpcCalls = []
    sceneCalls = []
    permsResponse = FRIEND_PERMS
    sessionScopes = ['session-scope-1']
    reactionFails = false
    dataDir = await useTmpDataDir('inbound-pdb-')
  })

  afterEach(async () => {
    internals?.attentionScheduler.stopAll()
    vi.restoreAllMocks()
    await dataDir.restore()
  })

  // ==========================================================================
  // 批合并：整批一次性递给 manager
  // ==========================================================================

  describe('整批递给 manager（变异靶 M2）', () => {
    it('批内每条消息都进 manager 的这一轮上下文，只跑一个 episode', async () => {
      boot()
      await internals.processDirectBatch(
        batchOf([
          makeMessage({ id: 'm-1', type: 'private', text: '第一条' }),
          makeMessage({ id: 'm-2', type: 'private', text: '第二条' }),
        ]),
      )

      expect(script.streams).toHaveLength(1)
      const rendered = String(script.streams[0].messages[0].content)
      expect(rendered).toContain('第一条')
      expect(rendered).toContain('第二条')
      // Task 4 的渲染器：message_id 必须在，manager 才能 get_message / reply
      expect(rendered).toContain('id="m-1"')
      expect(rendered).toContain('id="m-2"')
      // 私聊走 human_messages（不是 attention_flush）——文案不同，混用会让 manager 把
      // 刚说的话当成"攒了一会儿才递过来的"
      expect(rendered).toContain('[人类消息]')
      expect(rendered).not.toContain('补齐')
    })

    it('发言者取批内最后一条：权限、场景画像、台账归档键都按他解析', async () => {
      boot()
      await internals.processDirectBatch([
        { message: makeMessage({ id: 'm-1', type: 'private', text: '第一条' }), friend: makeFriend('f-1') },
        { message: makeMessage({ id: 'm-2', type: 'private', text: '第二条' }), friend: makeFriend('f-2') },
      ])

      expect(principal()!.principal.friend?.id).toBe('f-2')
      const resolveCall = rpcCalls.find((c) => c.method === 'resolve_principal_permissions')
      expect(resolveCall!.params).toMatchObject({ sender_friend_id: 'f-2', session_id: 'sess-1', session_type: 'private' })
      expect(sceneCalls[0]).toMatchObject({ channelId: 'wechat', sessionId: 'sess-1', sessionType: 'private', friendId: 'f-2' })
    })

    it('空 batch 直接返回：既不打已读也不唤醒 manager', async () => {
      boot()
      await internals.processDirectBatch([])

      expect(calls).toEqual([])
      expect(script.streams).toHaveLength(0)
    })
  })

  // ==========================================================================
  // reaction：打批内最后一条 + 时机提前到"递给 manager 之前"（变异靶 M8 / M2）
  // ==========================================================================

  describe('已读回应（变异靶 M8 / M2）', () => {
    it('给批内最后一条打"已读"回应，kind=acknowledged、落在本会话', async () => {
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

    it('reaction 发生在 manager episode 开始之前（不等任何 LLM）', async () => {
      boot([[sendMessageBlock({ channelId: 'wechat', sessionId: 'sess-1', text: '在的' })]])

      await internals.processDirectBatch(batchOf([makeMessage({ id: 'm-1', type: 'private' })]))

      // 唤醒边界的第一次异步解析（resolve_permissions）即 episode 起点
      expect(calls.indexOf('add_reaction')).toBe(0)
      expect(calls.indexOf('add_reaction')).toBeLessThan(calls.indexOf('resolve_permissions'))
      expect(calls.indexOf('add_reaction')).toBeLessThan(calls.indexOf('manager_llm'))
    })

    it('manager 决定沉默时 reaction 仍然发过（"我看到了"不依赖决策结果）', async () => {
      boot([]) // 空脚本 = manager 一句话都不说

      await internals.processDirectBatch(batchOf([makeMessage({ id: 'm-1', type: 'private' })]))

      expect(rpcCalls.find((c) => c.method === 'add_reaction')).toBeDefined()
      expect(rpcCalls.find((c) => c.method === 'send_message')).toBeUndefined()
    })

    it('channel 不支持 add_reaction 时不阻断 manager（RPC 抛错只 warn）', async () => {
      reactionFails = true
      boot([[sendMessageBlock({ channelId: 'wechat', sessionId: 'sess-1', text: '在的' })]])

      await internals.processDirectBatch(batchOf([makeMessage({ id: 'm-1', type: 'private' })]))

      expect(script.streams.length).toBeGreaterThan(0)
      expect(rpcCalls.find((c) => c.method === 'send_message')).toBeDefined()
    })
  })

  // ==========================================================================
  // 权限身份解析（变异靶 M4）—— 数据源从 dispatcher-executor 换成 ManagerPrincipalStore
  // ==========================================================================

  describe('权限身份解析（变异靶 M4）', () => {
    it('解析出的身份决定这轮之后 worker 能用哪些工具', async () => {
      boot()
      await internals.processDirectBatch(batchOf([makeMessage({ id: 'm-1', type: 'private' })]))

      // 解析请求打的是 admin，带的是这条私聊会话的身份三元组
      const resolveCall = rpcCalls.find((c) => c.method === 'resolve_principal_permissions')
      expect(resolveCall).toBeDefined()
      expect(resolveCall!.port).toBe(ADMIN_PORT)
      expect(resolveCall!.params).toMatchObject({
        sender_friend_id: 'f-1',
        session_id: 'sess-1',
        session_type: 'private',
      })

      // 语义落点：manager 从这个会话派出去的 worker 真的看得到 Bash（shell 开）、
      // 看不到写文件工具（file_io 关）——`narrowWorkerPermissions` 取的正是这份解析结果。
      const names = workerToolNames()
      expect(names).toContain('Bash')
      expect(names).not.toContain('Write')
      expect(names).not.toContain('Edit')
    })

    it('解析失败时不写入身份，worker 退回固定档位（不是放开也不是沿用上一轮）', async () => {
      boot()
      permsResponse = 'throw'
      await internals.processDirectBatch(batchOf([makeMessage({ id: 'm-1', type: 'private' })]))

      expect(principal()!.permissions).toBeNull()
      // 退回 F 阶段固定档位：file_io 开着（BUILTIN_WORKER_PERMISSIONS），不因解析失败而放宽到
      // messaging / remote_exec
      const names = workerToolNames()
      expect(names).toContain('Write')
      expect(names).not.toContain('send_message')
    })
  })

  // ==========================================================================
  // memory 权限档位（变异靶 M5）—— 断言落到 memory 模块真的收到的可见范围
  // ==========================================================================

  describe('memory 权限档位（变异靶 M5）', () => {
    it('按该 friend 解析出的 memory_scopes 授权读写，不是 public/全局', async () => {
      boot([[searchMemoryBlock()]])
      await internals.processDirectBatch(batchOf([makeMessage({ id: 'm-1', type: 'private' })]))

      const search = rpcCalls.find((c) => c.method === 'search_short_term')
      expect(search, 'manager 真实工具面上的 search_memory 应当打到 memory 模块').toBeDefined()
      expect(search!.port).toBe(MEMORY_PORT)
      expect(search!.params.accessible_scopes).toEqual(['friend-scope-a', 'friend-scope-b'])
      expect(search!.params.min_visibility).toBe('internal')
      // 反向钉死：不能退化成"公开可见 + 无 scope 限制"
      expect(search!.params.min_visibility).not.toBe('public')

      // 同一份档位随 spawn 下传给 worker
      expect(principal()!.memory).toEqual({
        write_visibility: 'internal',
        write_scopes: ['friend-scope-a', 'friend-scope-b'],
        read_min_visibility: 'internal',
        read_accessible_scopes: ['friend-scope-a', 'friend-scope-b'],
      })
    })

    it('身份解析失败时档位回落到该 session 配置的 scopes（仍不是公开）', async () => {
      boot([[searchMemoryBlock()]])
      permsResponse = 'throw'
      sessionScopes = ['session-scope-1']
      await internals.processDirectBatch(batchOf([makeMessage({ id: 'm-1', type: 'private' })]))

      expect(calls).toContain('get_session_config')
      const search = rpcCalls.find((c) => c.method === 'search_short_term')
      expect(search!.params.accessible_scopes).toEqual(['session-scope-1'])
      expect(search!.params.min_visibility).toBe('internal')
    })
  })

  // ==========================================================================
  // 场景画像 + crab_self_handle（plan §一 5b / 5d）
  // ==========================================================================

  describe('对话对象档案（plan §一 5b / 5d）', () => {
    it('场景画像与本渠道 @handle 真的进了 manager 的 system prompt', async () => {
      boot()
      await internals.processDirectBatch(batchOf([makeMessage({ id: 'm-1', type: 'private' })]))

      const sys = script.streams[0].systemPrompt as string
      expect(sys).toContain('## 对话对象档案')
      expect(sys).toContain('这个人喜欢直接给结论')
      // 多 bot 群里"哪个 @ 是发给我的"的唯一依据（缓存在 handleMessageReceived 里填）
      expect(sys).toContain('@crabot_wx')
    })
  })

  // ==========================================================================
  // 顺序与阻塞语义
  // ==========================================================================

  describe('顺序与阻塞语义', () => {
    it('一轮的固定顺序：已读 → 唤醒边界解析身份 → manager LLM → 说话', async () => {
      boot([[sendMessageBlock({ channelId: 'wechat', sessionId: 'sess-1', text: '收到，我看一下' })]])

      await internals.processDirectBatch(batchOf([makeMessage({ id: 'm-1', type: 'private' })]))

      expect(calls.filter((c) => c !== 'manager_llm' || true)).toEqual([
        'add_reaction',
        'resolve_permissions',
        'resolve_scene_profile',
        'manager_llm',
        'send_message',
        'manager_llm',
      ])
      const sent = rpcCalls.find((c) => c.method === 'send_message')
      expect(sent!.port).toBe(WECHAT_PORT)
      expect(sent!.params).toMatchObject({ session_id: 'sess-1', content: { type: 'text', text: '收到，我看一下' } })
    })

    it('lane handler 必须等 manager episode 结束才返回（fire-and-forget 会让兜底没有落点）', async () => {
      let release: () => void = () => {}
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      boot()
      const inner = hoisted.managerAdapter as { stream: (p: unknown) => AsyncGenerator<unknown> }
      hoisted.managerAdapter = {
        async *stream(params: unknown) {
          await gate
          yield* inner.stream(params)
        },
        updateConfig: () => {},
      }

      let returned = false
      const p = internals
        .processDirectBatch(batchOf([makeMessage({ id: 'm-1', type: 'private' })]))
        .then(() => {
          returned = true
        })

      await new Promise((resolve) => setImmediate(resolve))
      expect(returned, 'manager 还没跑完 lane handler 就返回了 = fire-and-forget').toBe(false)

      release()
      await p
      expect(returned).toBe(true)
      expect(script.streams.length).toBeGreaterThan(0)
    })

    it('唤醒抛错：lane 不炸（异常不会顺着 lane 冒到 SessionLane 上），且已读已经发出去了', async () => {
      boot()
      internals.managerStack.registry.routeHumanMessages = async () => {
        throw new Error('route boom')
      }

      await expect(
        internals.processDirectBatch(batchOf([makeMessage({ id: 'm-1', type: 'private' })])),
      ).resolves.toBeUndefined()

      expect(rpcCalls.find((c) => c.method === 'add_reaction')).toBeDefined()
    })

    /**
     * plan §三 的 F1 形态：LLM 挂掉时 `ManagerLoop` 记 `outcome:'failed'` 并把事件推回
     * mailbox，**不抛**——所以只靠 try/catch 抓不住最常见的那种失败。Task 6 的兜底要
     * 双管（catch + outcome），这里先如实钉住"不抛"这一半。
     */
    it('manager episode 失败（LLM 挂）不抛错，也不会自己回一句话', async () => {
      boot()
      hoisted.managerAdapter = {
        // eslint-disable-next-line require-yield
        async *stream() {
          calls.push('manager_llm')
          throw new Error('LLM boom')
        },
        updateConfig: () => {},
      }

      await expect(
        internals.processDirectBatch(batchOf([makeMessage({ id: 'm-1', type: 'private' })])),
      ).resolves.toBeUndefined()

      expect(calls).toContain('manager_llm')
      expect(rpcCalls.find((c) => c.method === 'send_message')).toBeUndefined()
    })
  })
})
