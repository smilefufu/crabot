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
import {
  makeManagerScript,
  searchMemoryBlock,
  sendMessageBlock,
  spawnWorkerBlock,
  type ManagerScript,
} from './manager-script.js'

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
    harness: { spawnWorker: (p: Record<string, unknown>) => Promise<unknown> }
  }
  failLoudSentAt: Map<string, number>
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

  /**
   * manager 派出去的 builtin worker 实际拿到的工具面（§8.2 权限身份的终点）。
   *
   * `principalPermissions` 就是派活那一刻随 spawn 下传、落进 `context.json` 的那份快照
   * （PR #59 review：worker 只认自己这份，不回头读会话级缓存）；不传 = 系统派工那一档。
   */
  function workerToolNames(principalPermissions?: ResolvedPermissions): string[] {
    return internals
      .buildBuiltinWorkerRuntime({
        worker_id: 'w-probe',
        workspace: { root: dataDir.root },
        origin: { spawned_by_session: MANAGER_KEY, trigger_type: 'message' },
        ...(principalPermissions ? { principal_permissions: principalPermissions } : {}),
      })
      .tools()
      .map((t) => t.name)
  }

  /** 拦下真实 spawn（不起真 worker），只看 manager 递给 harness 的派活参数。 */
  function spyOnSpawn(): { calls: Array<Record<string, unknown>> } {
    const calls: Array<Record<string, unknown>> = []
    internals.managerStack.harness.spawnWorker = async (p: Record<string, unknown>) => {
      calls.push(p)
      return { worker_id: 'w-spawned', incarnations: [{ seq: 1, impl: 'builtin' }] }
    }
    return { calls }
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
    it('解析出的身份随 spawn 下传，决定这轮派出去的 worker 能用哪些工具', async () => {
      boot([[spawnWorkerBlock()]])
      const spawn = spyOnSpawn()
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

      // 派活那一刻：身份与它算好的档位一起随 spawn 下传（PR #59 review：worker 之后只认这份）
      expect(spawn.calls).toHaveLength(1)
      const params = spawn.calls[0] as {
        origin: { creator_friend_id?: string }
        principal_permissions?: ResolvedPermissions
      }
      expect(params.origin.creator_friend_id).toBe('f-1')
      expect(params.principal_permissions).toEqual(FRIEND_PERMS)

      // 语义落点：这个 worker 真的看得到 Bash（shell 开）、看不到写文件工具（file_io 关）
      // ——`narrowWorkerPermissions` 取的正是随 spawn 下传的这份。
      const names = workerToolNames(params.principal_permissions)
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
     * mailbox，**不抛**——所以只靠 try/catch 抓不住最常见的那种失败。
     */
    it('manager episode 失败（LLM 挂）不把异常抛回 lane', async () => {
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
    })
  })

  // ==========================================================================
  // fail-loud 兜底（plan §三）
  //
  // 风险面：manager episode 失败 → agent 活着、health 还是绿的，但它完全不回话。
  // 三形态行为不同，判据必须双管（catch + outcome）：
  //
  // | 形态 | 触发 | 抛错? | 兜底? |
  // |---|---|---|---|
  // | F1 正常失败（LLM 挂 / key 过期 / 限流） | `outcome ∈ {failed, aborted}` | 不抛 | 发 |
  // | F2 中途抛错（adapter thunk / store IO） | 抛 | 抛 | 发 |
  // | F3 静默完成（manager 决定不说话） | `outcome='completed'` + 没出声 | 不抛 | **不发** |
  // ==========================================================================

  describe('fail-loud 兜底（plan §三）', () => {
    /** 让 registry 按 F1 的样子返回：正常 resolve，只是 outcome 是 failed。 */
    function stubOutcome(outcome: 'failed' | 'aborted' | 'completed'): void {
      internals.managerStack.registry.routeHumanMessages = async () => {
        calls.push('manager_llm')
        return { episodeId: 'ep-1', outcome, turns: 1, consumedEvents: outcome === 'completed', repliedToHuman: false }
      }
    }

    function failLoudText(): string | undefined {
      const sent = rpcCalls.find((c) => c.method === 'send_message')
      if (!sent) return undefined
      return (sent.params.content as { text: string } | undefined)?.text
    }

    it('F1：真实 loop 里 LLM 挂掉（不抛错）时人类仍然收到一条明确回复', async () => {
      boot()
      hoisted.managerAdapter = {
        // eslint-disable-next-line require-yield
        async *stream() {
          calls.push('manager_llm')
          throw new Error('LLM boom')
        },
        updateConfig: () => {},
      }

      await internals.processDirectBatch(batchOf([makeMessage({ id: 'm-1', type: 'private' })]))

      const sent = rpcCalls.find((c) => c.method === 'send_message')
      expect(sent, 'F1 下人类什么都收不到 = 本次兜底的整个存在理由落空').toBeDefined()
      expect(sent!.port).toBe(WECHAT_PORT)
      expect(sent!.params.session_id).toBe('sess-1')
      expect(failLoudText()).toContain('管理员')
    })

    /**
     * **判据里的 outcome 那一管**：这里 registry 正常 resolve、一个异常都不抛，
     * 只有 `outcome` 是 failed。去掉 outcome 判据（只留 catch）这条必挂。
     */
    it('F1：episode 正常 resolve 但 outcome=failed 时也必须兜底（只 catch 抓不住）', async () => {
      boot()
      stubOutcome('failed')

      await internals.processDirectBatch(batchOf([makeMessage({ id: 'm-1', type: 'private' })]))

      expect(failLoudText()).toContain('failed')
      expect(failLoudText()).toContain('管理员')
    })

    it('F1：outcome=aborted 同样兜底', async () => {
      boot()
      stubOutcome('aborted')

      await internals.processDirectBatch(batchOf([makeMessage({ id: 'm-1', type: 'private' })]))

      expect(failLoudText()).toContain('aborted')
    })

    /** F2：loop 本身起不来（`adapter()` thunk 抛、store IO 抛）——异常冒到 lane handler。 */
    it('F2：episode 抛错时兜底回复带上原始错误信息', async () => {
      boot()
      internals.managerStack.registry.routeHumanMessages = async () => {
        throw new Error('store IO boom')
      }

      await internals.processDirectBatch(batchOf([makeMessage({ id: 'm-1', type: 'private' })]))

      expect(failLoudText()).toContain('store IO boom')
    })

    /**
     * 文案必须能指导下一步动作。model slot 没配不是故障而是配置没做完，
     * 笼统的"我出错了"会让人类和管理员都无从下手。
     */
    it('F2：manager model slot 没配时，文案说清"去 Admin 配 manager 槽位"', async () => {
      boot()
      internals.managerStack.registry.routeHumanMessages = async () => {
        throw new Error(
          "[ManagerLoop] model_config 缺少 'manager' 与 'powerful' 两个 slot，manager loop 无法解析可用的 LLM 连接信息",
        )
      }

      await internals.processDirectBatch(batchOf([makeMessage({ id: 'm-1', type: 'private' })]))

      const text = failLoudText()!
      expect(text).toContain('Admin')
      expect(text).toContain('manager')
      expect(text).toContain('槽位')
    })

    /**
     * F3 不兜：群聊里 stay_silent 合法，私聊里也分不清"故意沉默"和"prompt 坏了"。
     * 误报（机器人无缘无故说"我出错了"）比漏报更伤。
     */
    it('F3：episode 正常完成但 manager 决定沉默时，一个字都不发', async () => {
      boot([]) // 空脚本 = manager 一句话都不说

      await internals.processDirectBatch(batchOf([makeMessage({ id: 'm-1', type: 'private' })]))

      expect(rpcCalls.find((c) => c.method === 'send_message')).toBeUndefined()
      // 但 react 照发（"我看到了"与"我回话了"是两件事）
      expect(rpcCalls.find((c) => c.method === 'add_reaction')).toBeDefined()
    })

    it('F3：私聊连续静默到阈值时记一条 warn（只记日志，仍然不发消息）', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      boot([])

      for (let i = 0; i < 3; i++) {
        await internals.processDirectBatch(batchOf([makeMessage({ id: `m-${i}`, type: 'private' })]))
      }

      expect(warn.mock.calls.some((c) => String(c[0]).includes('连续 3 轮'))).toBe(true)
      expect(rpcCalls.find((c) => c.method === 'send_message')).toBeUndefined()
    })

    /**
     * F1 会把整批输入推回 mailbox 下次重投，同一批消息会**反复**触发失败。
     * 没有冷却 = 故障期间往用户脸上刷屏。
     */
    it('冷却去重：连续三轮失败只告诉人类一次', async () => {
      boot()
      stubOutcome('failed')

      for (let i = 0; i < 3; i++) {
        await internals.processDirectBatch(batchOf([makeMessage({ id: `m-${i}`, type: 'private' })]))
      }

      expect(rpcCalls.filter((c) => c.method === 'send_message')).toHaveLength(1)
    })

    it('冷却按 key 隔离：另一个会话失败照样告诉那边的人', async () => {
      boot()
      stubOutcome('failed')

      await internals.processDirectBatch(batchOf([makeMessage({ id: 'm-1', type: 'private' })]))
      await internals.processDirectBatch(
        batchOf([makeMessage({ id: 'm-2', type: 'private', sessionId: 'sess-2' })]),
      )

      const sent = rpcCalls.filter((c) => c.method === 'send_message')
      expect(sent).toHaveLength(2)
      expect(sent.map((c) => c.params.session_id)).toEqual(['sess-1', 'sess-2'])
    })

    it('冷却窗口过去之后可以再告诉一次（不是一次性哑掉）', async () => {
      boot()
      stubOutcome('failed')

      await internals.processDirectBatch(batchOf([makeMessage({ id: 'm-1', type: 'private' })]))
      // 把台账往前拨 6 分钟（窗口 5 分钟）
      internals.failLoudSentAt.set('wechat::sess-1', Date.now() - 6 * 60 * 1000)
      await internals.processDirectBatch(batchOf([makeMessage({ id: 'm-2', type: 'private' })]))

      expect(rpcCalls.filter((c) => c.method === 'send_message')).toHaveLength(2)
    })

    /**
     * 兜底路径与 manager 栈零共享：manager 已经彻底坏掉（registry 直接抛）时，
     * 这条回复仍然要发得出去——它只依赖 rpcClient + channel 端口。
     */
    it('兜底走裸 send_message RPC，不经 manager 工具面', async () => {
      boot()
      internals.managerStack.registry.routeHumanMessages = async () => {
        throw new Error('manager stack is dead')
      }

      await internals.processDirectBatch(batchOf([makeMessage({ id: 'm-1', type: 'private' })]))

      const sent = rpcCalls.find((c) => c.method === 'send_message')!
      expect(sent.port).toBe(WECHAT_PORT)
      // channel 的 SendMessageParams 形状：`{session_id, content}`（不是 `{message}`）
      expect(sent.params).toMatchObject({ session_id: 'sess-1', content: { type: 'text' } })
      // manager 一次 LLM 都没起来过
      expect(calls).not.toContain('manager_llm')
    })

    it('channel 也挂了时兜底失败只记日志，不把异常抛回 lane', async () => {
      boot()
      internals.managerStack.registry.routeHumanMessages = async () => {
        throw new Error('manager stack is dead')
      }
      const realCall = internals.rpcClient.call
      internals.rpcClient.call = async (port, method, params, from) => {
        if (method === 'send_message') throw new Error('channel down')
        return realCall(port, method, params, from)
      }

      await expect(
        internals.processDirectBatch(batchOf([makeMessage({ id: 'm-1', type: 'private' })])),
      ).resolves.toBeUndefined()
    })
  })
})
