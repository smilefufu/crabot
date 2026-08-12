/**
 * 入站链路测试网 ①：`handleMessageReceived`（P7 / PR A Task 1）。
 *
 * 计划：`crabot-docs/superpowers/plans/2026-07-31-mw-p7-a-inbound-test-net.md`
 * 侦察：`.superpowers/sdd/p7-recon.md` §A.1 / §A.2
 *
 * ## 为什么走真实构造函数而不是 `Object.create(prototype)`
 *
 * `rpc-handlers.test.ts` 的造壳手法适合"handler 自身语义"——被测函数的依赖是它自己读的字段。
 * 但本文件要钉的是**分流**：群消息必须最终落到 `processGroupLaneBatch`、私聊必须落到
 * `processDirectBatch`。这条路径的一半在**构造函数的接线**里
 * （`unified-agent.ts:375-389`：attentionScheduler.flushCallback → groupLaneRegistry；
 * directLaneRegistry → processDirectBatch）。造壳就得在测试里把这段接线抄一遍，
 * 抄出来的接线永远是对的，M1 那类变异就只能靠"某个函数被调用了"这种参数透传断言去抓——
 * 恰恰是 CLAUDE.md 明令禁止的。
 *
 * 所以这里照 `tests/manager/p5-integration.test.ts` 走**真实构造函数**（`roles: []`，
 * 不建 AgentHandler / 不起 LSP），只把两个 lane handler 换成录制器：
 * 从事件入口到"落到哪条处理路径"整条链全是生产装配。
 *
 * ## 确定性
 *
 * 全链路无 `setTimeout`：
 * - `@mention` 群消息 → `AttentionScheduler.flushNow` 同步触发；
 * - 非 `@mention` 群消息 → 用 `group_attention_min_ms: 0` 让 `scheduleCheck` 算出
 *   `remaining <= 0`，同样走 `flushNow`；
 * - `SessionLane.enqueue` → `kick()` 在第一个 `await` 之前就同步调 handler。
 *
 * 因此断言不依赖任何真实定时器，也不需要轮询等待。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

import { UnifiedAgent } from '../../src/unified-agent.js'
import type { ChannelMessage, Friend, ModuleId } from '../../src/types.js'
import type { BufferedMessage } from '../../src/orchestration/attention-scheduler.js'
import type { Event } from 'crabot-shared'
import {
  authorizedEvent,
  makeAgentConfig,
  makeFriend,
  makeMessage,
  useTmpDataDir,
  type DataDirGuard,
} from './harness.js'

// ============================================================================
// harness
// ============================================================================

/** 一次"落到某条处理路径"的记录。 */
type Landing =
  | { path: 'direct'; batch: ReadonlyArray<{ message: ChannelMessage; friend: Friend }> }
  | { path: 'group'; batch: ReadonlyArray<{ messages: BufferedMessage[]; sessionId: string }> }

/**
 * 四个 channel 的 `send_message` 接收端契约（**已逐一核对源码**，四份一字不差地共用同一形状）：
 *
 * - `crabot-channel-feishu/src/feishu-channel.ts:826`
 * - `crabot-channel-wechat/src/wechat-channel.ts:468`
 * - `crabot-channel-dingtalk/src/dingtalk-channel.ts:387`
 * - `crabot-channel-telegram/src/telegram-channel.ts:502`
 *
 * 四者的第一行都是 `this.sessionManager.findById(params.session_id)`，找不到即
 * `NOT_FOUND` 抛出；正文一律取自 `params.content`（`SendMessageParams = {session_id,
 * content, features?}`，见四个仓的 `src/types.ts`）。
 *
 * 本函数把这条契约做成测试里的**真实接收端**：只有入参形状正确、`session_id` 指向一个
 * 存在的会话，文本才会被"送达"。断言落在"人类收到了什么"，而不是"某个 RPC 被调过"——
 * 这正是历史上那条 bug（`{message: reply}`）能长期存活的原因：调用发生了，送达从未发生。
 */
/** 接收端"认识"的会话（= 本文件里 `makeMessage` 会用到的全部 session_id）。 */
const KNOWN_SESSION_IDS: ReadonlySet<string> = new Set([
  'sess-1',
  'sess-a',
  'group-1',
  'group-2',
  'group-3',
  'group-a',
])

function deliverLikeChannel(
  params: unknown,
  knownSessionIds: ReadonlySet<string>,
): { sessionId: string; text: string } {
  const p = params as { session_id?: string; content?: { type?: string; text?: string } }
  if (!p.session_id || !knownSessionIds.has(p.session_id)) {
    throw new Error(`NOT_FOUND: Session not found: ${String(p.session_id)}`)
  }
  return { sessionId: p.session_id, text: p.content?.text ?? '' }
}

interface AgentInternals {
  onEvent(event: Event): Promise<void>
  processDirectBatch(batch: ReadonlyArray<{ message: ChannelMessage; friend: Friend }>): Promise<void>
  processGroupLaneBatch(batch: ReadonlyArray<{ messages: BufferedMessage[]; sessionId: string }>): Promise<void>
  attentionScheduler: { getBufferSize(sessionId: string): number; stopAll(): void }
  channelPorts: Map<string, number>
  crabDisplayNames: Map<string, string>
  crabSelfHandles: Map<string, string>
  rpcClient: { call: (...args: unknown[]) => Promise<unknown> }
  config: { subscriptions?: string[] }
}

describe('handleMessageReceived —— 入站分流（P7/PR A 测试网 ①）', () => {
  let dataDir: DataDirGuard
  let agent: UnifiedAgent
  let internals: AgentInternals
  /** 落点序列：断言"最终进了哪条处理路径"用的唯一事实来源。 */
  let landings: Landing[]
  /** 出站 RPC 序列（未配置提示语走这里）。 */
  let rpcCalls: Array<{ port: number; method: string; params: unknown }>
  /** **真正送达人类**的消息（经 `deliverLikeChannel` 这个 channel 契约接收端）。 */
  let delivered: Array<{ sessionId: string; text: string }>
  /** channel 契约接收端拒收的原因（入参形状错 / session 不存在）。 */
  let rejected: string[]
  /** lane handler 的放行闸：默认立即放行；需要观察串行/合并时挂起它。 */
  let gate: Promise<void> | undefined

  function boot(opts: { configured: boolean; attentionMinMs?: number }): void {
    // roles: [] —— 不建 AgentHandler、不起 LSP 子进程；分流不看 roles。
    agent = new UnifiedAgent(
      makeAgentConfig({ ...opts, moduleId: 'inbound-test-agent', port: 19998 }),
    )
    internals = agent as unknown as AgentInternals

    // 两个 lane handler 换成录制器。构造函数把它们接成
    // `(batch) => this.processDirectBatch(batch)` 的闭包（读取时才解引用），
    // 因此实例上覆盖同名方法不破坏任何生产接线。
    internals.processDirectBatch = async (batch) => {
      landings.push({ path: 'direct', batch })
      if (gate) await gate
    }
    internals.processGroupLaneBatch = async (batch) => {
      landings.push({ path: 'group', batch })
      if (gate) await gate
    }

    // 出站：预置 channel 端口，绕开 MM resolve；rpcClient.call 只记录。
    internals.channelPorts.set('wechat', 18001)
    internals.channelPorts.set('telegram', 18002)
    internals.rpcClient.call = async (port, method, params) => {
      rpcCalls.push({ port: port as number, method: method as string, params })
      // send_message 交给 channel 契约接收端处理：只有形状对了才算送达。
      if (method === 'send_message') {
        try {
          delivered.push(deliverLikeChannel(params, KNOWN_SESSION_IDS))
        } catch (err) {
          rejected.push(err instanceof Error ? err.message : String(err))
          throw err
        }
      }
      return {}
    }
  }

  beforeEach(async () => {
    landings = []
    rpcCalls = []
    delivered = []
    rejected = []
    gate = undefined
    dataDir = await useTmpDataDir('inbound-hmr-')
  })

  afterEach(async () => {
    internals?.attentionScheduler.stopAll()
    vi.restoreAllMocks()
    await dataDir.restore()
  })

  // --- 入口 ---

  describe('事件入口', () => {
    it('agent 订阅的是 admin 鉴权后的 channel.message_authorized，而不是 channel 原始事件', () => {
      boot({ configured: true })
      expect(internals.config.subscriptions).toContain('channel.message_authorized')
      expect(internals.config.subscriptions).not.toContain('channel.message_received')
    })

    it('非入站事件不会误入分流（走错 case 会把无关事件当消息处理）', async () => {
      boot({ configured: true })
      await internals.onEvent({
        id: 'evt-x',
        type: 'admin.friend_updated',
        source: 'admin' as ModuleId,
        payload: { friend_id: 'f-1' },
        timestamp: '2026-07-31T00:00:00.000Z',
      })
      expect(landings).toEqual([])
    })
  })

  // --- M1：群/私分流 ---

  describe('群/私分流（变异靶 M1）', () => {
    it('私聊消息最终落到私聊处理路径，且完全不经过群聊注意力调度', async () => {
      boot({ configured: true })
      const message = makeMessage({ id: 'pm-1', type: 'private' })

      await internals.onEvent(authorizedEvent({ message, friend: makeFriend('f-1') }))

      expect(landings).toHaveLength(1)
      const landing = landings[0]
      expect(landing.path).toBe('direct')
      if (landing.path !== 'direct') throw new Error('unreachable')
      // 落到私聊路径的是**这条消息本身**（不是空批、不是别的消息）
      expect(landing.batch.map((b) => b.message.platform_message_id)).toEqual(['pm-1'])
      expect(landing.batch[0].friend.id).toBe('f-1')
      // 私聊绕开注意力调度：调度器里不该留下任何缓冲
      expect(internals.attentionScheduler.getBufferSize('sess-1')).toBe(0)
    })

    it('群聊 @ 消息最终落到群聊处理路径，私聊路径零命中', async () => {
      boot({ configured: true })
      const message = makeMessage({ id: 'gm-1', type: 'group', sessionId: 'group-1', mention: true })

      await internals.onEvent(authorizedEvent({ message, friend: makeFriend('f-1') }))

      expect(landings).toHaveLength(1)
      const landing = landings[0]
      expect(landing.path).toBe('group')
      if (landing.path !== 'group') throw new Error('unreachable')
      expect(landing.batch).toHaveLength(1)
      expect(landing.batch[0].sessionId).toBe('group-1')
      expect(landing.batch[0].messages.map((m) => m.message.platform_message_id)).toEqual(['gm-1'])
      expect(landing.batch[0].messages[0].friend.id).toBe('f-1')
      // 已被取走：调度器缓冲清空
      expect(internals.attentionScheduler.getBufferSize('group-1')).toBe(0)
    })

    it('群聊非 @ 消息同样只走群聊路径（巡检到点即 flush）', async () => {
      boot({ configured: true, attentionMinMs: 0 })
      const message = makeMessage({ id: 'gm-2', type: 'group', sessionId: 'group-2', mention: false })

      await internals.onEvent(authorizedEvent({ message, friend: makeFriend('f-1') }))

      expect(landings.map((l) => l.path)).toEqual(['group'])
    })

    it('群、私两条消息交错到达时各走各的路，互不串台', async () => {
      boot({ configured: true })
      const priv = makeMessage({ id: 'pm-2', type: 'private', sessionId: 'sess-a' })
      const grp = makeMessage({ id: 'gm-3', type: 'group', sessionId: 'group-a', mention: true })

      await internals.onEvent(authorizedEvent({ message: priv, friend: makeFriend('f-1') }))
      await internals.onEvent(authorizedEvent({ message: grp, friend: makeFriend('f-2') }))

      expect(landings.map((l) => l.path)).toEqual(['direct', 'group'])
      const first = landings[0]
      const second = landings[1]
      if (first.path !== 'direct' || second.path !== 'group') throw new Error('unreachable')
      expect(first.batch[0].message.platform_message_id).toBe('pm-2')
      expect(second.batch[0].messages[0].message.platform_message_id).toBe('gm-3')
    })
  })

  // --- M3：未配置早退 ---

  describe('runtime config admission（变异靶 M3）', () => {
    it('未配置 LLM 时私聊消息 fail closed，且不产生处理或回复副作用', async () => {
      boot({ configured: false })
      const message = makeMessage({ id: 'pm-3', type: 'private' })

      await expect(internals.onEvent(authorizedEvent({ message, friend: makeFriend('f-1') })))
        .rejects.toThrow('Agent runtime config is not configured')

      expect(landings).toEqual([])
      expect(rpcCalls).toEqual([])
      expect(delivered).toEqual([])
    })

    it('未配置 LLM 时群聊消息 fail closed，且不进入注意力调度', async () => {
      boot({ configured: false })
      const message = makeMessage({ id: 'gm-4', type: 'group', sessionId: 'group-3', mention: true })

      await expect(internals.onEvent(authorizedEvent({ message, friend: makeFriend('f-1') })))
        .rejects.toThrow('Agent runtime config is not configured')

      expect(landings).toEqual([])
      expect(internals.attentionScheduler.getBufferSize('group-3')).toBe(0)
      expect(rpcCalls).toEqual([])
    })

    it('配置齐备时正常处理消息', async () => {
      boot({ configured: true })
      await internals.onEvent(
        authorizedEvent({ message: makeMessage({ id: 'pm-4', type: 'private' }), friend: makeFriend('f-1') }),
      )
      expect(rpcCalls.filter((c) => c.method === 'send_message')).toHaveLength(0)
      expect(landings.map((l) => l.path)).toEqual(['direct'])
    })
  })

  // --- lane key：串行化边界 ---

  describe('私聊 lane key = channel + session', () => {
    it('同一会话连发：第二条不与第一条并发，等第一批处理完后合并成新一批', async () => {
      boot({ configured: true })
      let release: () => void = () => {}
      gate = new Promise<void>((resolve) => {
        release = resolve
      })

      const friend = makeFriend('f-1')
      await internals.onEvent(authorizedEvent({ message: makeMessage({ id: 'a1', type: 'private' }), friend }))
      // 第一批还卡在 gate 上
      expect(landings).toHaveLength(1)

      await internals.onEvent(authorizedEvent({ message: makeMessage({ id: 'a2', type: 'private' }), friend }))
      await internals.onEvent(authorizedEvent({ message: makeMessage({ id: 'a3', type: 'private' }), friend }))
      // 串行化：处理中不得再起第二次 handler
      expect(landings).toHaveLength(1)

      gate = undefined
      release()
      await new Promise((resolve) => process.nextTick(resolve))

      expect(landings).toHaveLength(2)
      const second = landings[1]
      if (second.path !== 'direct') throw new Error('unreachable')
      // a2/a3 合并进同一批（合并语义本身的完整覆盖在 processDirectBatch 测试里）
      expect(second.batch.map((b) => b.message.platform_message_id)).toEqual(['a2', 'a3'])
    })

    it('session_id 相同但 channel_id 不同 → 两条独立 lane，不互相阻塞', async () => {
      boot({ configured: true })
      let release: () => void = () => {}
      gate = new Promise<void>((resolve) => {
        release = resolve
      })

      const friend = makeFriend('f-1')
      await internals.onEvent(
        authorizedEvent({ message: makeMessage({ id: 'w1', type: 'private', channelId: 'wechat' }), friend }),
      )
      await internals.onEvent(
        authorizedEvent({ message: makeMessage({ id: 't1', type: 'private', channelId: 'telegram' }), friend }),
      )

      // 若 lane key 只用 session_id，t1 会被 w1 的 lane 挡住，这里只有 1 条落点
      expect(landings).toHaveLength(2)
      expect(
        landings.map((l) => (l.path === 'direct' ? l.batch[0].message.session.channel_id : '?')),
      ).toEqual(['wechat', 'telegram'])

      gate = undefined
      release()
      await new Promise((resolve) => process.nextTick(resolve))
    })
  })

  // --- 昵称 / self-handle 缓存 ---

  describe('crab 昵称与 self-handle 缓存', () => {
    it('按 channel 分桶缓存，多渠道互不覆盖', async () => {
      boot({ configured: true })
      const friend = makeFriend('f-1')
      await internals.onEvent(
        authorizedEvent({
          message: makeMessage({ id: 'c1', type: 'private', channelId: 'wechat' }),
          friend,
          crab_display_name: '小蟹',
          crab_self_handle: '@crabot_wx',
        }),
      )
      await internals.onEvent(
        authorizedEvent({
          message: makeMessage({ id: 'c2', type: 'private', channelId: 'telegram' }),
          friend,
          crab_display_name: 'Crabot',
          crab_self_handle: '@crabot_tg',
        }),
      )

      expect(internals.crabDisplayNames.get('wechat')).toBe('小蟹')
      expect(internals.crabDisplayNames.get('telegram')).toBe('Crabot')
      expect(internals.crabSelfHandles.get('wechat')).toBe('@crabot_wx')
      expect(internals.crabSelfHandles.get('telegram')).toBe('@crabot_tg')
    })

    it('后续消息不带这两个字段时保留已缓存值（不能被 undefined 抹掉）', async () => {
      boot({ configured: true })
      const friend = makeFriend('f-1')
      await internals.onEvent(
        authorizedEvent({
          message: makeMessage({ id: 'c3', type: 'private' }),
          friend,
          crab_display_name: '小蟹',
          crab_self_handle: '@crabot_wx',
        }),
      )
      await internals.onEvent(
        authorizedEvent({ message: makeMessage({ id: 'c4', type: 'private' }), friend }),
      )

      expect(internals.crabDisplayNames.get('wechat')).toBe('小蟹')
      expect(internals.crabSelfHandles.get('wechat')).toBe('@crabot_wx')
    })

    it('未配置 admission 发生在缓存之前，不吸收消息元数据', async () => {
      boot({ configured: false })
      await expect(internals.onEvent(
        authorizedEvent({
          message: makeMessage({ id: 'c5', type: 'private' }),
          friend: makeFriend('f-1'),
          crab_self_handle: '@crabot_wx',
        }),
      )).rejects.toThrow('Agent runtime config is not configured')
      expect(internals.crabSelfHandles.has('wechat')).toBe(false)
    })
  })
})
