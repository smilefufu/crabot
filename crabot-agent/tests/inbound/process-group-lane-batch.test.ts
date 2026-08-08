/**
 * 入站链路测试网 ③：`processGroupLaneBatch`（群聊 lane handler）。
 *
 * 计划：`crabot-docs/superpowers/plans/2026-08-01-mw-p7-j-cutover.md`
 * 前身：P7 / PR A Task 3（下游是 dispatcher）。**P7 / PR J Task 5 起下游是 manager。**
 *
 * ## 群聊比私聊多出来的三件事，cutover 后的处境
 *
 * | 群聊特有 | cutover 后 |
 * |---|---|
 * | barrier（@bot 时暂停本群在跑的 worker） | **放弃**：v3 下人类消息碰不到 worker 的输入队列（只有 manager 的 `send_to_worker` 一条路），竞态不存在 |
 * | memory scopes 的第二档 fallback（空 scopes → `[sessionId]`） | **迁**：落在 `manager/principal.ts` 的 `applyGroupScopeFallback` |
 * | 退避反馈 `attentionScheduler.reportResult` | **迁**：`replied` 取 `EpisodeResult.repliedToHuman` |
 *
 * ## M9 断的仍然是"退避档位"，不是"reportResult 被调用了"
 *
 * 退避相关用例走**真实事件入口**（`channel.message_authorized` → 真实 AttentionScheduler
 * → 真实群聊 lane → `processGroupLaneBatch` → 真实 manager episode），处理完直接读
 * `getCurrentIntervalMs`。数据源换了（v2 是 `actions.some(kind!=='stay_silent')`，
 * v3 是 manager 这轮有没有调过发送类工具），**语义没换**。
 *
 * ## 手法
 *
 * 与测试网 ② 相同：真实构造函数 + 真实 manager 栈，只把 LLM 换成脚本 adapter。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

import type { BufferedMessage } from '../../src/orchestration/attention-scheduler.js'
import type {
  ChannelMessage,
  Friend,
  MemoryPermissions,
  ResolvedPermissions,
  RuntimeSceneProfile,
  ToolAccessConfig,
} from '../../src/types.js'
import type { Event } from 'crabot-shared'
import { authorizedEvent, makeAgentConfig, makeFriend, makeMessage, useTmpDataDir, type DataDirGuard } from './harness.js'
import {
  makeManagerScript,
  searchMemoryBlock,
  sendMessageBlock,
  spawnWorkerBlock,
  type ManagerScript,
} from './manager-script.js'

const hoisted = vi.hoisted(() => ({ managerAdapter: undefined as unknown }))
vi.mock('../../src/agent/agent-handler.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/agent/agent-handler.js')>()
  return { ...actual, adapterFromSdkEnv: () => hoisted.managerAdapter }
})

const { UnifiedAgent } = await import('../../src/unified-agent.js')

// ============================================================================
// fixtures
// ============================================================================

const ADMIN_PORT = 18100
const WECHAT_PORT = 18101
const MEMORY_PORT = 18102
const GROUP_SESSION = 'sess-group-1'
const MANAGER_KEY = `wechat::${GROUP_SESSION}`

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

const SCENE_PROFILE: RuntimeSceneProfile = {
  label: '技术群',
  content: '这个群喜欢直给结论',
  source: { scene: { type: 'group_session' as const, channel_id: 'wechat', session_id: GROUP_SESSION } },
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

/** manager 只读一次群聊历史——只读工具不算"跟人说话"。 */
function getHistoryBlock(id = 'tu-hist-1'): Record<string, unknown> {
  return {
    type: 'tool_use',
    id,
    name: 'get_history',
    input: { channel_id: 'wechat', session_id: GROUP_SESSION, limit: 5 },
  }
}

type GroupBatch = ReadonlyArray<{ messages: BufferedMessage[]; sessionId: string }>

interface ResolvedPrincipalView {
  permissions: ResolvedPermissions | null
  memory: MemoryPermissions
  dialogProfile?: string
  principal: { friend?: Friend; sessionType: 'private' | 'group' }
}

interface Internals {
  onEvent(event: Event): Promise<void>
  processGroupLaneBatch(batch: GroupBatch): Promise<void>
  buildBuiltinWorkerRuntime(ctx: unknown): { tools: () => ReadonlyArray<{ name: string }> }
  contextAssembler: unknown
  agentHandler: unknown
  channelPorts: Map<string, number>
  crabDisplayNames: Map<string, string>
  crabSelfHandles: Map<string, string>
  managerStack: {
    principals: { get(key: string): ResolvedPrincipalView | undefined }
    registry: { routeAttentionFlush: (...args: unknown[]) => Promise<unknown> }
    harness: { spawnWorker: (p: Record<string, unknown>) => Promise<unknown> }
  }
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

describe('processGroupLaneBatch —— 群聊 lane handler（cutover 后下游是 manager）', () => {
  let dataDir: DataDirGuard
  let agent: InstanceType<typeof UnifiedAgent>
  let internals: Internals
  let script: ManagerScript

  let calls: string[]
  let rpcCalls: Array<{ port: number; method: string; params: Record<string, unknown> }>
  let barrierCalls: string[]
  let inflight: Promise<void>[]

  let permsResponse: ResolvedPermissions | null | 'throw'
  let sessionScopes: string[]

  function boot(
    opts: {
      attentionMinMs?: number
      attentionMaxMs?: number
      turns?: ReadonlyArray<ReadonlyArray<Record<string, unknown>>>
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

    // 事件入口驱动时 lane 是同步 kick 的但 handler 内部有 await；把 in-flight promise 记下来。
    const realGroupBatch = (
      Object.getPrototypeOf(agent) as { processGroupLaneBatch: (b: GroupBatch) => Promise<void> }
    ).processGroupLaneBatch.bind(agent)
    internals.processGroupLaneBatch = (batch: GroupBatch) => {
      const p = realGroupBatch(batch)
      inflight.push(p)
      return p
    }

    // barrier 的观测口：cutover 后这两个入站专用包装不该再被碰（v3 无此竞态）。
    internals.agentHandler = {
      createBuiltinBgToolOptions: () => undefined,
      getActiveTasksByOrigin: () => {
        barrierCalls.push('get_active_tasks_by_origin')
        return ['task-a']
      },
      setBarrierForTask: () => {
        barrierCalls.push('set_barrier')
        return true
      },
      clearBarrierForTask: () => {
        barrierCalls.push('clear_barrier')
      },
      getInflightSnapshot: () => [],
    }

    internals.rpcClient.resolve = async (filter) => {
      const f = filter as { module_type?: string }
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
          return { platform_message_id: 'sent-g1', sent_at: '2026-07-31T00:00:05.000Z' }
        case 'add_reaction':
          calls.push('add_reaction')
          return {}
        case 'get_history':
          calls.push('get_history')
          return { messages: [] }
        case 'search_short_term':
          calls.push('search_short_term')
          return { results: [] }
        default:
          return {}
      }
    }

    internals.contextAssembler = {
      resolveSceneProfile: async (): Promise<RuntimeSceneProfile | null> => {
        calls.push('resolve_scene_profile')
        return SCENE_PROFILE
      },
    }
  }

  /** 一个 attention 批次 = 一条 lane item。 */
  function attentionBatch(messages: ChannelMessage[], friend = makeFriend('f-1')) {
    return { messages: messages.map((message) => ({ message, friend })), sessionId: GROUP_SESSION }
  }

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

  function principal(): ResolvedPrincipalView | undefined {
    return internals.managerStack.principals.get(MANAGER_KEY)
  }

  /**
   * `principalPermissions` = 派活那一刻随 spawn 下传、落进 `context.json` 的那份快照
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

  function reply(text = '我来看看'): Record<string, unknown> {
    return sendMessageBlock({ channelId: 'wechat', sessionId: GROUP_SESSION, text })
  }

  beforeEach(async () => {
    calls = []
    rpcCalls = []
    barrierCalls = []
    inflight = []
    permsResponse = GROUP_PERMS
    sessionScopes = ['session-scope-1']
    dataDir = await useTmpDataDir('inbound-pglb-')
  })

  afterEach(async () => {
    internals?.attentionScheduler.stopAll()
    vi.restoreAllMocks()
    await dataDir.restore()
  })

  // ==========================================================================
  // 批合并与 attention_flush 语义（变异靶 M2）
  // ==========================================================================

  describe('批合并与唤醒语义（变异靶 M2）', () => {
    it('lane 攒下的多个 attention 批次合并成一轮 episode，不丢任何一批', async () => {
      boot()
      const friend = makeFriend('f-1')
      await internals.processGroupLaneBatch([
        attentionBatch([gmsg({ id: 'g-1', text: '第一批' })], friend),
        attentionBatch([gmsg({ id: 'g-2', text: '第二批甲' }), gmsg({ id: 'g-3', text: '第二批乙' })], friend),
      ])

      expect(script.streams).toHaveLength(1)
      const rendered = String(script.streams[0].messages[0].content)
      for (const id of ['g-1', 'g-2', 'g-3']) expect(rendered).toContain(`id="${id}"`)
    })

    it('群聊走 attention_flush：文案告诉 manager 这批话是攒了一会儿才递过来的', async () => {
      boot()
      await runGroup([gmsg({ id: 'g-1', text: '接着说' })])

      const rendered = String(script.streams[0].messages[0].content)
      expect(rendered).toContain('补齐')
      // 不能被 `routeHumanMessages` 顶替——那会让 manager 把陈旧消息当成刚说的
      expect(rendered).not.toContain('[人类消息]')
    })

    it('发言者取批内最后一条：权限按他解析', async () => {
      boot()
      await internals.processGroupLaneBatch([
        {
          messages: [
            { message: gmsg({ id: 'g-1', text: '第一条', senderId: 'u-1', friendId: 'f-1' }), friend: makeFriend('f-1') },
            { message: gmsg({ id: 'g-2', text: '第二条', senderId: 'u-2', friendId: 'f-2' }), friend: makeFriend('f-2') },
          ],
          sessionId: GROUP_SESSION,
        },
      ])

      expect(principal()!.principal.friend?.id).toBe('f-2')
      expect(principal()!.principal.sessionType).toBe('group')
      const resolveCall = rpcCalls.find((c) => c.method === 'resolve_principal_permissions')
      expect(resolveCall!.params).toMatchObject({
        sender_friend_id: 'f-2',
        session_id: GROUP_SESSION,
        session_type: 'group',
      })
    })

    it('空 batch / 批内无消息：不唤醒 manager、不打已读', async () => {
      boot()
      await internals.processGroupLaneBatch([])
      await internals.processGroupLaneBatch([{ messages: [], sessionId: GROUP_SESSION }])

      expect(calls).toEqual([])
      expect(script.streams).toHaveLength(0)
    })
  })

  // ==========================================================================
  // 已读回应（变异靶 M8 / M2）
  // ==========================================================================

  describe('已读回应（变异靶 M8 / M2）', () => {
    it('给批内最后一条打"已读"（群里只回应最新那条，不是第一条）', async () => {
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

    it('reaction 在 manager episode 之前发出；manager 沉默时也照样发过', async () => {
      boot() // 空脚本 = manager 一句话都不说
      await runGroup([gmsg({ id: 'g-1', text: '你们中午吃啥' })])

      expect(calls.indexOf('add_reaction')).toBe(0)
      expect(calls.indexOf('add_reaction')).toBeLessThan(calls.indexOf('manager_llm'))
      expect(rpcCalls.find((c) => c.method === 'send_message')).toBeUndefined()
    })
  })

  // ==========================================================================
  // 群聊 barrier：cutover 后明确放弃
  // ==========================================================================

  describe('barrier 放弃（v3 无此竞态）', () => {
    it('@bot 群消息不再暂停本群在跑的 worker（人类消息碰不到 worker 的输入队列）', async () => {
      boot()
      await runGroup([gmsg({ id: 'g-1', text: '@小蟹 帮我看下', mention: true })])

      expect(barrierCalls).toEqual([])
      // 但这条消息本身照常进 manager
      expect(script.streams.length).toBeGreaterThan(0)
    })
  })

  // ==========================================================================
  // 权限身份解析（变异靶 M4）
  // ==========================================================================

  describe('权限身份解析（变异靶 M4）', () => {
    it('按群聊语义解析发起人身份，结果随 spawn 下传决定这轮 worker 能用哪些工具', async () => {
      boot({ turns: [[spawnWorkerBlock()]] })
      const spawn = spyOnSpawn()
      await runGroup([gmsg({ id: 'g-1', text: '帮我跑个脚本' })])

      const resolveCall = rpcCalls.find((c) => c.method === 'resolve_principal_permissions')
      expect(resolveCall!.port).toBe(ADMIN_PORT)
      expect(resolveCall!.params).toMatchObject({
        sender_friend_id: 'f-1',
        session_id: GROUP_SESSION,
        session_type: 'group',
      })

      // 派活那一刻：**本批发言者**的身份与它算好的档位一起随 spawn 下传（PR #59 review）
      expect(spawn.calls).toHaveLength(1)
      const params = spawn.calls[0] as {
        origin: { creator_friend_id?: string }
        principal_permissions?: ResolvedPermissions
      }
      expect(params.origin.creator_friend_id).toBe('f-1')
      expect(params.principal_permissions).toEqual(GROUP_PERMS)

      const names = workerToolNames(params.principal_permissions)
      expect(names).toContain('Bash')
      expect(names).not.toContain('Write')
      // 群里任何人都不能借 worker 直接跟人类说话（v3 不变量不被身份放宽）
      expect(names).not.toContain('send_message')
    })

    it('解析失败时不写入身份，worker 退回固定档位', async () => {
      boot()
      permsResponse = 'throw'
      await runGroup([gmsg({ id: 'g-1' })])

      expect(principal()!.permissions).toBeNull()
      expect(workerToolNames()).toContain('Write')
    })
  })

  // ==========================================================================
  // 群聊 memory 三档（变异靶 M5 / M5G2）
  // ==========================================================================

  describe('memory 权限档位 —— 群聊三档（变异靶 M5 / M5G2）', () => {
    it('第一档：按解析出的 memory_scopes 授权读写，不是 public/全局', async () => {
      boot({ turns: [[searchMemoryBlock()]] })
      await runGroup([gmsg({ id: 'g-1' })])

      const search = rpcCalls.find((c) => c.method === 'search_short_term')
      expect(search!.port).toBe(MEMORY_PORT)
      expect(search!.params.accessible_scopes).toEqual(['group-scope-a', 'group-scope-b'])
      expect(search!.params.min_visibility).toBe('internal')
      expect(principal()!.memory.write_scopes).toEqual(['group-scope-a', 'group-scope-b'])
    })

    it('第二档（群聊专有）：解析成功但 scopes 为空时收敛到本群，不允许空 scope 越界', async () => {
      boot({ turns: [[searchMemoryBlock()]] })
      permsResponse = { ...GROUP_PERMS, memory_scopes: [] }
      await runGroup([gmsg({ id: 'g-1' })])

      const search = rpcCalls.find((c) => c.method === 'search_short_term')
      expect(search!.params.accessible_scopes).toEqual([GROUP_SESSION])
      // 这一档是就地收敛，不是第三档——没有去问 admin 要 session 配置
      expect(calls).not.toContain('get_session_config')
      // 同一份收敛结果也落在 `ResolvedPermissions` 上（随 spawn 下传给 worker）
      expect(principal()!.permissions!.memory_scopes).toEqual([GROUP_SESSION])
    })

    it('第三档：身份解析失败时回落到该 session 配置的 scopes（仍不是公开）', async () => {
      boot({ turns: [[searchMemoryBlock()]] })
      permsResponse = 'throw'
      sessionScopes = ['session-scope-1']
      await runGroup([gmsg({ id: 'g-1' })])

      expect(calls).toContain('get_session_config')
      const search = rpcCalls.find((c) => c.method === 'search_short_term')
      expect(search!.params.accessible_scopes).toEqual(['session-scope-1'])
      expect(search!.params.min_visibility).toBe('internal')
    })
  })

  // ==========================================================================
  // 对话对象档案（plan §一 5b / 5d）
  // ==========================================================================

  describe('对话对象档案（plan §一 5b / 5d）', () => {
    it('群画像与本渠道 @handle 真的进了 manager 的 system prompt', async () => {
      boot()
      await runGroup([gmsg({ id: 'g-1', text: '继续' })])

      const sys = script.streams[0].systemPrompt as string
      expect(sys).toContain('## 对话对象档案')
      expect(sys).toContain('这个群喜欢直给结论')
      expect(sys).toContain('@crabot_wx')
    })
  })

  // ==========================================================================
  // 退避反馈（变异靶 M9 —— 本文件的核心）
  // ==========================================================================

  describe('退避反馈：群聊打扰频率（变异靶 M9）', () => {
    it('这轮没跟人说话 → 下次巡检间隔按 ×5 拉长（注意力渐远）', async () => {
      boot({ attentionMinMs: 1000 })

      expect(internals.attentionScheduler.getCurrentIntervalMs(GROUP_SESSION)).toBeUndefined()
      await deliverMention(gmsg({ id: 'g-1', text: '@小蟹 你觉得呢', mention: true }))

      expect(internals.attentionScheduler.getCurrentIntervalMs(GROUP_SESSION)).toBe(5000)
      expect(rpcCalls.find((c) => c.method === 'send_message')).toBeUndefined()
    })

    it('连续没出声时退避逐级累积（第二轮再 ×5）', async () => {
      boot({ attentionMinMs: 1000 })

      await deliverMention(gmsg({ id: 'g-1', mention: true }))
      expect(internals.attentionScheduler.getCurrentIntervalMs(GROUP_SESSION)).toBe(5000)

      await deliverMention(gmsg({ id: 'g-2', mention: true }))
      expect(internals.attentionScheduler.getCurrentIntervalMs(GROUP_SESSION)).toBe(25000)
    })

    it('退避拉长有上限，不会一路退到永不理人', async () => {
      boot({ attentionMinMs: 1000, attentionMaxMs: 3000 })

      await deliverMention(gmsg({ id: 'g-1', mention: true }))

      expect(internals.attentionScheduler.getCurrentIntervalMs(GROUP_SESSION)).toBe(3000)
    })

    it('这轮出声后注意力被拉回：退避档位从拉长状态回到最小间隔', async () => {
      boot({ attentionMinMs: 1000 })
      await deliverMention(gmsg({ id: 'g-1', mention: true }))
      expect(internals.attentionScheduler.getCurrentIntervalMs(GROUP_SESSION)).toBe(5000)

      // 第二轮换成"会说话"的脚本
      script = makeManagerScript([[reply('我看一下')]])
      await deliverMention(gmsg({ id: 'g-2', mention: true }))

      expect(rpcCalls.find((c) => c.method === 'send_message')).toBeDefined()
      expect(internals.attentionScheduler.getCurrentIntervalMs(GROUP_SESSION)).toBe(1000)
    })

    it('只调只读工具（没跟人说话）不算出声：退避照样拉长', async () => {
      boot({ attentionMinMs: 1000, turns: [[getHistoryBlock()]] })

      await deliverMention(gmsg({ id: 'g-1', mention: true }))

      expect(calls).toContain('get_history')
      expect(rpcCalls.find((c) => c.method === 'send_message')).toBeUndefined()
      expect(internals.attentionScheduler.getCurrentIntervalMs(GROUP_SESSION)).toBe(5000)
    })

    it('一轮里混着只读工具与一次发言时按"有出声"算，不按第一个动作算', async () => {
      boot({ attentionMinMs: 1000, turns: [[getHistoryBlock()], [reply('查到了，是这样')]] })

      await deliverMention(gmsg({ id: 'g-1', mention: true }))

      expect(calls).toContain('get_history')
      expect(rpcCalls.find((c) => c.method === 'send_message')).toBeDefined()
      expect(internals.attentionScheduler.getCurrentIntervalMs(GROUP_SESSION)).toBe(1000)
    })

    it('manager episode 抛错时退避按"没出声"算，且不把异常抛回 lane', async () => {
      boot({ attentionMinMs: 1000 })
      hoisted.managerAdapter = {
        // eslint-disable-next-line require-yield
        async *stream() {
          throw new Error('LLM boom')
        },
        updateConfig: () => {},
      }

      await deliverMention(gmsg({ id: 'g-1', mention: true }))

      expect(internals.attentionScheduler.getCurrentIntervalMs(GROUP_SESSION)).toBe(5000)
    })

    it('真实事件入口：@bot 群消息走完整条链（注意力 → 群 lane → manager）', async () => {
      boot({ attentionMinMs: 1000, turns: [[reply('好的')]] })

      await deliverMention(gmsg({ id: 'g-1', text: '@小蟹 建个任务', mention: true }))

      // 缓冲已被取空，消息确实是经注意力调度落到群聊处理路径的
      expect(internals.attentionScheduler.getBufferSize(GROUP_SESSION)).toBe(0)
      expect(String(script.streams[0].messages[0].content)).toContain('@小蟹 建个任务')
      expect(internals.attentionScheduler.getCurrentIntervalMs(GROUP_SESSION)).toBe(1000)
    })
  })

  // ==========================================================================
  // fail-loud 兜底（plan §三）
  //
  // 群里没人说话时"agent 死了"和"agent 决定不插嘴"从外面看是一样的，所以 F1/F2
  // 必须出声；而 F3（正常收口、决定沉默）恰恰是群聊的常态，绝不能兜。
  // ==========================================================================

  describe('fail-loud 兜底（plan §三）', () => {
    function stubOutcome(outcome: 'failed' | 'aborted'): void {
      internals.managerStack.registry.routeAttentionFlush = async () => ({
        episodeId: 'ep-g1',
        outcome,
        turns: 1,
        consumedEvents: false,
        repliedToHuman: false,
      })
    }

    function failLoudSent() {
      return rpcCalls.filter((c) => c.method === 'send_message')
    }

    it('F1：outcome=failed（不抛错）时群里收到一条明确回复', async () => {
      boot({ attentionMinMs: 1000 })
      stubOutcome('failed')

      await runGroup([gmsg({ id: 'g-1', mention: true })])

      const sent = failLoudSent()
      expect(sent).toHaveLength(1)
      expect(sent[0].port).toBe(WECHAT_PORT)
      expect(sent[0].params.session_id).toBe(GROUP_SESSION)
      expect((sent[0].params.content as { text: string }).text).toContain('管理员')
    })

    /**
     * 兜底回复不是 manager 在说话：退避档位仍按"这一轮没出声"上报。
     * 按"出声"算 = 故障期间群聊巡检间隔被冻结在最短值，反而更吵。
     */
    it('F1：兜底回复不算 manager 出声，退避照常拉长', async () => {
      boot({ attentionMinMs: 1000 })
      stubOutcome('failed')

      await deliverMention(gmsg({ id: 'g-1', mention: true }))

      expect(failLoudSent()).toHaveLength(1)
      expect(internals.attentionScheduler.getCurrentIntervalMs(GROUP_SESSION)).toBe(5000)
    })

    it('F2：episode 抛错时也兜底，且异常不冒回 lane、退避仍按没出声算', async () => {
      boot({ attentionMinMs: 1000 })
      internals.managerStack.registry.routeAttentionFlush = async () => {
        throw new Error('store IO boom')
      }

      await expect(deliverMention(gmsg({ id: 'g-1', mention: true }))).resolves.toBeUndefined()

      expect((failLoudSent()[0].params.content as { text: string }).text).toContain('store IO boom')
      expect(internals.attentionScheduler.getCurrentIntervalMs(GROUP_SESSION)).toBe(5000)
    })

    /** 群聊沉默合法且必要（stay_silent）——误报比漏报更伤。 */
    it('F3：manager 决定不插嘴时群里一个字都不多说', async () => {
      boot({ attentionMinMs: 1000, turns: [[getHistoryBlock()]] })

      await runGroup([gmsg({ id: 'g-1', mention: true })])

      expect(failLoudSent()).toHaveLength(0)
      expect(calls).toContain('get_history')
    })

    it('冷却去重：连续三轮失败只在群里说一次', async () => {
      boot({ attentionMinMs: 1000 })
      stubOutcome('failed')

      for (let i = 0; i < 3; i++) {
        await runGroup([gmsg({ id: `g-${i}`, mention: true })])
      }

      expect(failLoudSent()).toHaveLength(1)
    })
  })

  // ==========================================================================
  // 阻塞语义
  // ==========================================================================

  describe('阻塞语义', () => {
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
      const p = runGroup([gmsg({ id: 'g-1', mention: true })]).then(() => {
        returned = true
      })

      await new Promise((resolve) => setImmediate(resolve))
      expect(returned, 'manager 还没跑完 lane handler 就返回了 = fire-and-forget').toBe(false)

      release()
      await p
      expect(returned).toBe(true)
    })
  })
})
