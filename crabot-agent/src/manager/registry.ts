/**
 * ManagerRegistry —— manager 实例台账与唤醒路由(protocol-agent-v3.md §4.4)。
 *
 * `ManagerLoop`(Task 7)按 `ManagerKey` 逻辑长驻:session 状态全在盘上
 * (`ManagerSessionStore`),但 loop 实例本身要有人持有、有人按 key 复用、有人在合适的时机
 * 回收。`ManagerRegistry` 就是这个持有者,同时是三类唤醒来源(人类消息 / worker 事件 /
 * scheduled 触发)到具体 `ManagerLoop` 实例的路由入口——调用方不需要自己判断"这次事件该
 * 唤醒哪个 manager",只管调 `routeXxx`。
 *
 * ## 惰性 + 常驻 + 可回收
 *
 * `getOrCreate` 惰性建实例、同 key 幂等;`evictIdle` 按内存压力回收空闲实例——回收只影响
 * 内存,不碰盘上状态(`ManagerSessionStore`),所以回收后同一 key 再次 `wakeUp` 会经
 * `getOrCreate` 重新建一个新的 `ManagerLoop` 实例,而它构造时 `ManagerLoop.runEpisodeBody`
 * 顶部的 `store.load(key)` 会原样读回历史——对调用方完全透明。
 *
 * **例外:mailbox 非空的实例不可回收**——那些内容只存在于内存 mailbox,盘上没有(见
 * `evictIdle`);与之配套的是 episode 收口时的自唤醒兜底(见 `maybeSelfWake`)。两者合起来
 * 关掉 P7 阻塞项 #5 的"停滞 + 回收丢失"窗口。
 *
 * ## 系统线程(§4.4)
 *
 * `SYSTEM_TASKS_MANAGER_KEY` 是协议保留的"系统任务"线程:未指定目标 session 的 scheduled
 * 触发、以及台账查不到监护 session 的 worker 事件,都落在这个固定 key 上。`getOrCreate`
 * 内部按 `key === SYSTEM_TASKS_MANAGER_KEY` 判定 `ManagerLoopDeps.isSystemThread`,不需要
 * 调用方在路由时额外传一个"是不是系统线程"的标志——key 本身就是唯一判据。
 *
 * @see crabot-docs/protocols/protocol-agent-v3.md §4.4
 */

import { ManagerLoop, type WakeEvent, type TimedWakeEnvelope, type EpisodeResult, type ManagerLoopDeps } from './loop.js'
import type { ManagerSessionStore } from './session-store.js'
import type { CompactionPolicy } from './compaction.js'
import type { ManagerKey } from './types.js'
import type { LLMAdapter, ToolDefinition } from '../engine/index.js'
import type { WorkerHarness } from '../workers/harness/harness'
import type { LedgerStore } from '../workers/harness/ledger-store'
import type {
  ActivityContextAdmissionReceipt,
  HarnessEvent,
  HarnessEventDelivery,
} from '../workers/harness/worker-events'
import type { ChannelMessage, Friend, ResolvedPermissions } from '../types'
import type { SessionTarget } from '../mcp/crab-messaging.js'
import type { HumanPrincipal } from './principal.js'
import { resolveTimezone } from '../utils/time.js'
import type { ManagerInboundMessageFact } from './inbound-status.js'

/** §4.4 保留线程:未配置目标 session 的 scheduled 触发 / 台账查不到监护 session 的 worker 事件落此。 */
export const SYSTEM_TASKS_MANAGER_KEY = 'admin-web::system-tasks' as ManagerKey

/**
 * 连锁自唤醒的上限(见 `ManagerRegistry.maybeSelfWake`)。
 *
 * 自唤醒本身可能再产生新的 mailbox 内容(自唤醒 episode 期间又有普通事件到达),不设上限
 * 就是一条"episode → 注入 → episode"的无限链:注入源若稳定复发,链条永不收敛,烧的是真钱。
 * 取 3:够把"收口瞬间才到达"这类一次性尾巴处理干净,又不至于替一个稳定故障源无限重开
 * episode。到顶后残留**不丢**——它留在 mailbox 里,受 `evictIdle` 的非空保护,由下一次
 * 真实唤醒(人类消息 / worker 事件 / schedule)顺带 drain 走,仍满足 §4.1 至少一次投递。
 */
export const MAX_SELF_WAKE_CHAIN = 3

/**
 * scheduled 唤醒随行的**权限身份**(protocol-agent-v3 §8.2 的 `creator_friend_id` /
 * `is_builtin`;§4.4"scheduled 任务约束……权限按 `Schedule.creator_friend_id` 解析
 * (`is_builtin` 按 master 等价)")。
 *
 * **过渡形态,P7 收敛**:v2 的 admin 在自己那侧把 schedule 解析成 `resolved_permissions`
 * 再下发;v3 改成 agent 侧按 `origin.creator_friend_id` 解析。P5 的 `trigger_schedule`
 * 已按 v3 协议接收身份并一路透到 `SpawnWorkerParams.origin.creator_friend_id`,但 admin
 * 调用点尚未切换(P5 Global Constraints:不激活生产链路),真正的"以此身份解析工具权限"
 * 在 P7 cutover 时才接上。
 */
export interface ScheduleIdentity {
  readonly creatorFriendId?: string
  readonly isBuiltin?: boolean
  readonly taskType?: string
}

export interface ManagerRegistryDeps {
  readonly store: ManagerSessionStore
  readonly policy: CompactionPolicy
  readonly harness: WorkerHarness
  /** routeWorkerEvent 的 origin 归属查找用(harness 未公开 findWorker,直接持有台账存储)。 */
  readonly ledger: LedgerStore
  /**
   * manager model 解析器(protocol-agent-v3.md §11;2026-08 收敛后即 `model_config.powerful`,
   * 见 `model-slot.ts` `resolveManagerModelConfig`)、用 `createAdapter` 建出 `LLMAdapter`。
   * 做成 thunk 而非字面量是为了让"下一个 episode 生效"的热更语义成立——`getOrCreate` 只在
   * key 首次建 `ManagerLoop` 时把这两个 thunk 原样转给 `ManagerLoopDeps`(见下),`ManagerLoop`
   * 自己按 episode 边界调用,本 registry 不缓存解析结果。
   */
  readonly adapter: () => LLMAdapter
  readonly model: () => string
  /** 运行时配置已原子替换后的通知源与代数 getter(spec 2026-08-30-llm-retry-config-hotreload);原样下传 ManagerLoopDeps。 */
  readonly onRuntimeConfigApplied?: (listener: () => void) => () => void
  readonly runtimeConfigAppliedGeneration?: () => number
  readonly maxTurns?: number
  /** manager 模型的上下文窗口(随 powerful slot,thunk 支持 hot-reload);undefined = engine 默认 200K */
  readonly contextWindowTokens?: () => number | undefined
  /** manager 的槽位思考强度(随 powerful slot,thunk 支持 hot-reload);undefined = 跟随默认 */
  readonly thinking?: () => import('../engine/llm-adapter-types.js').LLMThinkingConfig | undefined
  /** manager 模型的视觉能力(随 powerful slot,thunk 支持 hot-reload);原样下传 ManagerLoopDeps */
  readonly supportsVision?: () => boolean | undefined
  readonly now: () => Date
  /** Once true, no new wake may create or enqueue work for a Manager episode. */
  readonly isClosing?: () => boolean
  /** 人类消息渲染的时区(见 `ManagerLoopDeps.timezone`);不注入则退回 `resolveTimezone(undefined)`。 */
  readonly timezone?: () => string
  /**
   * `ManagerKey` → 台账渲染用的 `ManagerKey`(`ManagerLoopDeps.managerKey`)。
   * 两者粒度不同(manager 按 channel::session,worker 台账按 friend 跨 channel 聚合/单群),
   * 这层映射依赖 friend 解析等本模块无法自行完成的信息,由调用方按 protocol §3 解析好注入。
   *
   * **每次读都要现算**:私聊的归档键要等第一条人类消息带来 friend 之后才能收敛成
   * `friend:<id>`(见 `onHumanWake`),调用方持有的映射会随之变化。
   */
  readonly managerKeyFor: (key: ManagerKey) => ManagerKey
  /**
   * **人类消息唤醒边界**的异步解析钩子:`routeHumanMessages` 在 `runWake` 之前 await 它一次,
   * 调用方据 `principal`(发起人 friend + 私/群)解析权限、记忆档位、对话对象档案并缓存,
   * 供下面那三个**同步** thunk(`managerKeyFor` / `toolFace` / `promptInputs`)读取。
   *
   * 这是"加参数而不是全面异步化"的落点:异步只发生在唤醒边界这一处,每轮 turn 被同步调用的
   * 签名一个都不用改。不注入则行为与之前逐字相同(manager 拿不到发起人身份)。
   *
   * **返回值**(PR #59 review):解析出来的权限档位,由本 registry 挂到本 episode 的唤醒事件上
   * (`WakeEvent.principalPermissions`)。会话级缓存回答不了"本 episode 的发言者是谁"——群聊里
   * 换个人说话就整体覆盖——而派出去的 worker 的权限身份必须是**本批消息的发言者**。
   */
  readonly onHumanWake?: (
    key: ManagerKey,
    principal: HumanPrincipal,
  ) => Promise<ResolvedPermissions | null | void>
  /** Refreshes durable Friend authorization before a non-human/self wake exposes tools. */
  readonly beforeWake?: (key: ManagerKey, envelope: TimedWakeEnvelope | undefined) => Promise<void>
  /**
   * **scheduled 唤醒边界**的异步解析钩子(PR #59 review):`routeSchedule` 在 `runWake` 之前
   * await 它一次,按 §4.4"权限按 `Schedule.creator_friend_id` 解析(`is_builtin` 按 master
   * 等价)"算出本次调度的档位,同样挂到唤醒事件上。
   *
   * 单独一个钩子而不是复用 `onHumanWake`:调度身份来自任务定义,不是"某个人在这个会话里说话"
   * ——scheduled 触发可以打进一个人类会话的 manager,那个会话的发起人缓存与本次调度无关。
   * 不注入则本次调度没有发起人档位,worker 退回自己的固定档位。
   */
  readonly onScheduleWake?: (p: {
    key: ManagerKey
    creatorFriendId?: string
    isBuiltin?: boolean
  }) => Promise<ResolvedPermissions | null>
  /**
   * 工具面工厂:调用方据 key/isSystemThread 装配 `buildManagerToolFace` 的完整依赖并返回
   * 工具面数组。
   *
   * P5 Task 4 additive:第四个参数是**本 episode 若由 scheduled 触发**时随行的权限身份
   * (非 schedule 唤醒为 undefined),调用方据它填 `WorkerToolsContext.creatorFriendId` /
   * `triggerType`。可选参数,既有三参调用点无需改动。
   *
   * P7 J additive:第五个参数是**本 episode 若由人类消息唤醒**时随行的发起人身份
   * (非人类消息唤醒为 undefined)。与 scheduleIdentity 分开两个参数而不是合成一个
   * "身份"联合体,是因为两者的语义不同:schedule 的身份来自任务定义(§8.2),人类消息的
   * 身份来自本批消息的发言者(§4.3),混成一个会让调用方无从判断该走哪条权限规则。
   *
   * PR #59 review:第六个参数是**上面那个身份算好的权限档位**——由唤醒边界解析、随本
   * episode 的唤醒事件而来。调用方必须用它填 `WorkerToolsContext.principalPermissions`,
   * 不得回头去读会话级缓存(那是"最近谁在说话",不是"本 episode 是谁")。
   */
  readonly toolFace: (
    key: ManagerKey,
    isSystemThread: boolean,
    scheduleIdentity?: ScheduleIdentity,
    humanPrincipal?: HumanPrincipal,
    principalPermissions?: ResolvedPermissions,
    /** 当前 episode 的 trace、发送后复核与交付证据桥（registry 惰性桥接到 loops 实例）。 */
    traceHooks?: {
      currentTraceId: () => string | undefined
      onWorkerSpawned: (workerId: string) => void
      onPostSendAction: () => void
      hasSuccessfulSendMessageTo: (target: { channel_id: string; session_id: string }) => boolean
      onSuccessfulSendMessage: (target: { channel_id: string; session_id: string }) => void
      sessionChannelsFor: (sessionId: string) => ReadonlySet<string> | undefined
      onObservedSessionTargets: (targets: ReadonlyArray<SessionTarget>) => void
      hasContinuedWorker: (workerId: string) => boolean
      onWorkerContinuation: (workerId: string) => void
    },
    /** 当前 episode 的原始唤醒事件；仅供工具调用时授权，不进入 schema 或 history。 */
    wakeEvent?: WakeEvent,
  ) => ReadonlyArray<ToolDefinition>
  /** Manager episode trace writer（窄接口；见 ManagerLoopDeps.traceWriter）。 */
  readonly traceWriter?: import('./trace-types.js').ManagerTraceWriter
  /** P6-A §3.2：episode 消费后结算未 claim 的 Admin Chat request IDs。 */
  readonly onAdminChatWakeConsumed?: (key: ManagerKey, requestIds: string[]) => void
  /** 仅在任务板系统输入实际被成功 episode 消费后结算其持久化 notice。 */
  readonly onWorkboardAdminUpdateConsumed?: (key: ManagerKey, noticeRevisions: ReadonlyArray<number>) => void | Promise<void>
  /** Stable system prompt profile material. */
  readonly promptInputs: (key: ManagerKey) => { readonly dialogProfile?: string; readonly isGroup?: boolean; readonly adminPersonality?: string }
}

export class ManagerRegistry {
  private readonly loops = new Map<ManagerKey, ManagerLoop>()
  /**
   * 每个 key 当前"在途" episode 的引用计数——决定 evictIdle 是否可回收，以及持久操作通知
   * 是否需要 deferred。**必须是计数,不能是布尔/Set 的有无标记**:同一 key 可能
   * 有多个并发唤醒同时在途(人类消息与该 session 监护的 worker 事件几乎必然撞上)——第二个
   * 已经进了 `runWake`,可能仍在 `ManagerLoop` 内部 mutex 排队或执行,第一个却先 resolve。
   * 若只用 Set,第一个 resolve 时 `finally` 会直接 `delete(key)`,把仍在途的第二个也一并
   * 抹掉("有 episode 在跑"的标记被错误清空)——`evictIdle` 会在这个窗口误判该 key 空闲、
   * 回收 `this.loops` 的引用;之后任何新事件经 `getOrCreate` 会在仍有旧 episode 运行的情况
   * 下新建一个持有独立 mutex 的 `ManagerLoop`,与旧实例并发读写同一份 `ManagerSessionStore`
   * 记录,造成 split-brain 覆盖/丢写。引用计数(进入 runWake +1、episode 结束 -1、归零才删)
   * 能正确表达"还有几个在途",避免这个问题。
   */
  private readonly activeEpisodes = new Map<ManagerKey, number>()
  /** 每个 key 最近一次"活跃"的时间戳(创建时 / 每次 episode 结束时刷新),evictIdle 的判据。 */
  private readonly lastActiveAtMs = new Map<ManagerKey, number>()

  constructor(private readonly deps: ManagerRegistryDeps) {}

  /** 内存 registry 当前 running manager 的只读快照（P6-A §7.3：补充尚未首次 save 的当前 manager）。 */
  listActiveManagers(): Array<{ key: ManagerKey; lastActiveAtMs?: number }> {
    return Array.from(this.loops.keys()).map((key) => ({ key, lastActiveAtMs: this.lastActiveAtMs.get(key) }))
  }

  /** 不创建 loop；只读取 exact ManagerKey 当前内存上下文与 mailbox。 */
  snapshotHumanInbound(key: ManagerKey): ManagerInboundMessageFact[] {
    return this.loops.get(key)?.snapshotHumanInbound() ?? []
  }

  /** 惰性拉起:key 无实例则建;同 key 幂等返回同一实例。实例常驻内存,session 状态在盘上。 */
  getOrCreate(key: ManagerKey): ManagerLoop {
    const existing = this.loops.get(key)
    if (existing) return existing

    const isSystemThread = key === SYSTEM_TASKS_MANAGER_KEY

    const loopDeps: ManagerLoopDeps = {
      key,
      isSystemThread,
      // ManagerKey 是 worker 的固定台账归属。使用 thunk 只为保持 ManagerLoop 的
      // 同步依赖注入形状，不从当前 principal 派生或改写会话归属。
      managerKey: () => this.deps.managerKeyFor(key),
      store: this.deps.store,
      policy: this.deps.policy,
      adapter: this.deps.adapter,
      model: this.deps.model,
      onRuntimeConfigApplied: this.deps.onRuntimeConfigApplied,
      runtimeConfigAppliedGeneration: this.deps.runtimeConfigAppliedGeneration,
      maxTurns: this.deps.maxTurns,
      contextWindowTokens: this.deps.contextWindowTokens,
      // thunk 原样下传：thinking 的解析在 episode 内与 adapter/model 同点发生（同样的
      // fail-loud 语义），不能在 getOrCreate 急切调用——缺 powerful 会让唤醒路径直接抛错。
      thinking: this.deps.thinking,
      supportsVision: this.deps.supportsVision,
      // 唤醒事件由 ManagerLoop 按 episode 传入(见 ManagerLoopDeps.toolFace);schedule 之外
      // 的唤醒不带身份,工具面照旧。
      toolFace: (wakeEvent) =>
        this.deps.toolFace(
          key,
          isSystemThread,
          scheduleIdentityOf(wakeEvent),
          humanPrincipalOf(wakeEvent),
          principalPermissionsOf(wakeEvent),
          {
            currentTraceId: () => this.loops.get(key)?.currentEpisodeTraceId,
            onWorkerSpawned: (workerId) => this.loops.get(key)?.recordSpawnedWorker(workerId),
            onPostSendAction: () => this.loops.get(key)?.recordPostSendAction(),
            hasSuccessfulSendMessageTo: (target) => this.loops.get(key)?.hasSuccessfulSendMessageTo(target) ?? false,
            onSuccessfulSendMessage: (target) => this.loops.get(key)?.recordSuccessfulSendMessage(target),
            sessionChannelsFor: (sessionId) => this.loops.get(key)?.sessionChannelsFor(sessionId),
            onObservedSessionTargets: (targets) => this.loops.get(key)?.recordObservedSessionTargets(targets),
            hasContinuedWorker: (workerId) => this.loops.get(key)?.hasContinuedWorker(workerId) ?? false,
            onWorkerContinuation: (workerId) => this.loops.get(key)?.recordWorkerContinuation(workerId),
          },
          wakeEvent,
        ),
      promptInputs: () => this.deps.promptInputs(key),
      harness: this.deps.harness,
      now: this.deps.now,
      timezone: this.deps.timezone,
      onEpisodeEnd: () => this.lastActiveAtMs.set(key, this.deps.now().getTime()),
      traceWriter: this.deps.traceWriter,
      onAdminChatWakeConsumed: this.deps.onAdminChatWakeConsumed
        ? (ids) => this.deps.onAdminChatWakeConsumed!(key, ids)
        : undefined,
      onWorkboardAdminUpdateConsumed: this.deps.onWorkboardAdminUpdateConsumed
        ? (revisions) => this.deps.onWorkboardAdminUpdateConsumed!(key, revisions)
        : undefined,
    }

    const loop = new ManagerLoop(loopDeps)
    this.loops.set(key, loop)
    this.lastActiveAtMs.set(key, this.deps.now().getTime())
    return loop
  }

  /**
   * 人类消息 → 对应 session 的 manager(私聊 lane 批 / 群聊即时放行都走这条)。
   *
   * `friend` 是**本批消息的发言者**(私聊即对端;群聊取批内最后一条的发言者,与 v2
   * `processGroupLaneBatch` 的 `lastEntry.friend` 同义)。它一路带到两个地方:
   * ① `onHumanWake` —— 唤醒边界解析权限 / 记忆档位 / 对话对象档案;
   * ② `WakeEvent.friend` —— 供 `toolFace(wakeEvent)` 按 per-episode 的发起人身份装配工具面。
   *
   * 不传 friend 时(陌生人、或调用方尚未接线)行为与之前逐字相同。
   */
  async routeHumanMessages(
    channelId: string,
    sessionId: string,
    messages: ReadonlyArray<ChannelMessage>,
    friend?: Friend,
    /** P6-A §3.2：system-only 关联元数据（不渲染进 LLM 正文）。 */
    correlation?: import('./loop.js').ManagerWakeCorrelation,
    /** 人类输入已持久化进对应 Manager 会话后的非关键通知。 */
    onHumanInputCommitted?: (lastCommittedMessageId: string) => Promise<void>,
    /** 消息被注入在跑 episode 时(PR #131),处理结果的结算委托给该 episode 的真实
     * 收尾 result——调用方以此补跑 fail-loud,不用注入分支立即返回的占位值。 */
    onEpisodeSettled?: (result: EpisodeResult) => void,
  ): Promise<EpisodeResult> {
    const capture = this.captureIngress()
    return this.routeHumanWake(capture, 'human_messages', channelId, sessionId, messages, friend, correlation, onHumanInputCommitted, onEpisodeSettled)
  }

  /**
   * 群聊注意力放行(`AttentionScheduler` 的 flush 回调)→ 对应 session 的 manager。
   *
   * 与 `routeHumanMessages` 共用同一条唤醒边界(同样解析发起人身份、同样把 friend 带进
   * `WakeEvent`),**唯一的区别是 `WakeEvent.kind`**——`attention_flush` 在 `loop.ts`
   * `renderWakeEvent` 里渲染成"补齐:群聊注意力放行期间累积的人类消息",告诉 LLM 这批话
   * 是攒了一会儿才递过来的、不是刚说的。两个 kind 的文案不同,**不能拿
   * `routeHumanMessages` 顶替**:那样 manager 会把一批陈旧消息当成刚发生的对话。
   *
   * 在此之前 registry 没有任何 `attention_flush` 的公开入口(`runWake` 是 private,
   * `attentionFlushToWakeEvent` 零生产调用方),群聊放行路径因此**无路可走**。
   */
  async routeAttentionFlush(
    channelId: string,
    sessionId: string,
    messages: ReadonlyArray<ChannelMessage>,
    friend?: Friend,
    /** 人类输入已持久化进对应 Manager 会话后的非关键通知。 */
    onHumanInputCommitted?: (lastCommittedMessageId: string) => Promise<void>,
    /** flush 消息被注入在跑 episode 时(PR #131),处理结果的结算委托给该 episode 的
     * 真实收尾 result——调用方以此 reportResult,不用注入分支立即返回的占位值。 */
    onEpisodeSettled?: (result: EpisodeResult) => void,
  ): Promise<EpisodeResult> {
    const capture = this.captureIngress()
    return this.routeHumanWake(capture, 'attention_flush', channelId, sessionId, messages, friend, undefined, onHumanInputCommitted, onEpisodeSettled)
  }

  /** 两个人类消息入口的公共路径:解析发起人身份(唤醒边界的唯一一次异步)→ 按 kind 造事件唤醒。 */
  private async routeHumanWake(
    capture: IngressCapture,
    kind: 'human_messages' | 'attention_flush',
    channelId: string,
    sessionId: string,
    messages: ReadonlyArray<ChannelMessage>,
    friend?: Friend,
    correlation?: import('./loop.js').ManagerWakeCorrelation,
    onHumanInputCommitted?: (lastCommittedMessageId: string) => Promise<void>,
    onEpisodeSettled?: (result: EpisodeResult) => void,
  ): Promise<EpisodeResult> {
    const key = `${channelId}::${sessionId}` as ManagerKey
    // 私/群不新增数据来源:它就在消息自己的 session 上。空批(理论上不该发生)按私聊算,
    // 与 `handleMessageReceived` 的默认分流一致。
    const sessionType = messages[0]?.session.type === 'group' ? 'group' : 'private'
    const principal: HumanPrincipal = { ...(friend ? { friend } : {}), sessionType }
    const initialWake: WakeEvent = kind === 'human_messages'
      ? { kind: 'human_messages', messages, ...(friend ? { friend } : {}) }
      : { kind: 'attention_flush', messages, ...(friend ? { friend } : {}) }
    // Capture before principal lookup so queueing cannot rewrite ingress time.
    const envelope = this.makeEnvelope(capture, initialWake, undefined, messages, correlation)
    // 只会退回 fail-soft 兜底,而消息丢了就是丢了。
    let principalPermissions: ResolvedPermissions | undefined
    if (this.deps.onHumanWake) {
      try {
        principalPermissions = (await this.deps.onHumanWake(key, principal)) ?? undefined
      } catch (err) {
        console.error(`[ManagerRegistry] manager '${key}' 的发起人身份解析失败,按未解析继续:`, err)
      }
    }

    const withFriend = friend ? { friend } : {}
    // 档位挂在事件上,和 friend 一样按 episode 随行(见 `principalPermissionsOf`)。
    const withPerms = principalPermissions ? { principalPermissions } : {}
    const event: WakeEvent =
      kind === 'human_messages'
        ? { kind: 'human_messages', messages, ...withFriend, ...withPerms }
        : { kind: 'attention_flush', messages, ...withFriend, ...withPerms }
    // P7 cutover 遗留接线补齐(2026-08-29):episode 运行中到达的人类消息进入当前
    // episode mailbox,turn 边界注入当前 episode 的下一轮 LLM——不再阻塞在 wakeUp 的
    // mutex 上等本 episode 跑完。先提交(写历史+去重+回调)再注入,语义与 builtin
    // worker 输入注入一致(参照 PR #130)。协议 §4.1「episode 进行中到达的事件直接
    // 进入当前 Manager mailbox」同样涵盖人类消息。
    const loop = this.getOrCreate(key)
    if (this.isEpisodeActive(key)) {
      // 同步入队(check 与 push 之间无 await,与 routeWorkerEvent 同构原子):
      // 提交延后到当前 episode 收尾临界区,由 settle hook 拿真实处理结果。
      loop.enqueueHumanWakeDuringActiveEpisode({ ...envelope, wake: event }, onHumanInputCommitted, onEpisodeSettled)
      return {
        episodeId: '',
        outcome: 'completed',
        turns: 0,
        consumedEvents: true,
        repliedToHuman: false,
        successfulSendMessageTargets: [],
      }
    }
    return this.runWake(key, { ...envelope, wake: event }, 0, onHumanInputCommitted)
  }

  /**
   * harness 事件 → 该 worker 的监护 manager(台账 `origin.manager_key`);查不到则落
   * 系统线程。注意:这里解出的 manager 与该 worker 台账所属的 `ManagerKey` 可以是两个
   * 不同的对话对象(同一 friend 跨 channel 共享台账)——这是设计意图,不是需要修正的不一致。
   */
  async routeWorkerEvent(event: HarnessEvent): Promise<EpisodeResult | undefined> {
    const { key, envelope } = await this.prepareWorkerEventRoute(event)
    const loop = this.getOrCreate(key)
    if (this.isEpisodeActive(key)) {
      // A hook raised while a Manager tool is running belongs to the current episode.
      // Enqueue synchronously so the next engine turn sees the whole mailbox batch; never
      // wait for (or recursively start) another Manager episode here.
      loop.enqueueDuringEpisode(envelope)
      return {
        episodeId: '',
        outcome: 'completed',
        turns: 0,
        consumedEvents: true,
        repliedToHuman: false,
        successfulSendMessageTargets: [],
      }
    }
    return this.runWake(key, envelope)
  }

  /**
   * A supervision due has a persistent pending identity. Check it immediately before admission so
   * a rule replaced while the event was queued stays audit-only and never creates a Manager episode.
   */
  async routeSupervisionDue(event: HarnessEvent): Promise<EpisodeResult | undefined> {
    if (event.kind !== 'supervision_due') throw new Error('routeSupervisionDue requires supervision_due')
    if (!await this.deps.harness.isSupervisionDueCurrent(event)) return undefined
    const { key, envelope } = await this.prepareWorkerEventRoute(event)
    // A periodic/default supervision due needs a real episode result to decide whether its
    // persistent due can be consumed. Do not enqueue it into an unrelated active episode
    // and then fabricate that result: the Harness will retain and retry this due instead.
    // Route preparation reads the ledger asynchronously, so the due can be cleared or
    // replaced after the first check. Revalidate immediately before episode admission.
    if (!await this.deps.harness.isSupervisionDueCurrent(event)) return undefined
    if (this.isEpisodeActive(key)) return undefined
    return this.runWake(
      key,
      envelope,
      0,
      undefined,
      () => this.deps.harness.isSupervisionDueCurrent(event),
    )
  }

  /** Operation notifications join an active episode mailbox; idle Managers get a fresh wake. */
  async routeOperationNotification(
    key: ManagerKey,
    event: HarnessEvent,
    activityReceipt?: ActivityContextAdmissionReceipt,
  ): Promise<HarnessEventDelivery> {
    if (event.kind === 'activity_available' && activityReceipt) {
      const capture = this.captureIngress()
      const envelope = this.makeEnvelope(
        capture,
        { kind: 'worker_event', event },
        event.ts,
        undefined,
        undefined,
        activityReceipt,
      )
      if (this.isEpisodeActive(key)) {
        this.getOrCreate(key).enqueueDuringEpisode(envelope)
      } else {
        void this.runWake(key, envelope).catch(async (error) => {
          try {
            await activityReceipt.reject()
          } catch (rejectError) {
            console.error(`[ManagerRegistry] activity receipt rejection failed for ${activityReceipt.notification_id}:`, rejectError)
          }
          console.error(`[ManagerRegistry] activity notification episode failed for ${activityReceipt.notification_id}:`, error)
        })
      }
      return { consumed: false, registered: true }
    }
    // 与 onEvent 通道同一份 detail 形态：trigger_type / task_id / outcome 由
    // prepareWorkerEventRoute 现读台账注入（manager 的 prompt 判据如「完成结果的记忆候选」
    // 依赖它们）——durable 通道不能因为是通知就少了这层丰富化。路由目标以台账
    // manager_key 为准（与 routeWorkerEvent 一致）；台账查不到时退回入参 key——它是
    // harness 持久化通知时记下的快照，比系统线程更贴近原投递意图。
    const { key: routedKey, envelope } = await this.prepareWorkerEventRoute(event, key)
    const loop = this.getOrCreate(routedKey)
    if (this.isEpisodeActive(routedKey)) {
      loop.enqueueDuringEpisode(envelope)
      return { consumed: true }
    }
    const result = await this.runWake(routedKey, envelope)
    return { consumed: result.consumedEvents === true }
  }

  async routeMediaNotification(p: {
    channelId: string
    sessionId: string
    text: string
    occurredAt?: string
  }): Promise<EpisodeResult> {
    const capture = this.captureIngress()
    const envelope = this.makeEnvelope(capture, { kind: 'media_notification', text: p.text }, p.occurredAt)
    const key = `${p.channelId}::${p.sessionId}` as ManagerKey
    if (this.isEpisodeActive(key)) {
      this.getOrCreate(key).enqueueDuringEpisode(envelope)
      return {
        episodeId: '',
        outcome: 'completed',
        turns: 0,
        consumedEvents: true,
        repliedToHuman: false,
        successfulSendMessageTargets: [],
      }
    }
    return this.runWake(key, envelope)
  }

  /**
   * scheduled 触发(§4.4):有 target_session → 该 manager;无 → 系统线程 manager。
   *
   * P5 Task 4 additive:`creatorFriendId` / `isBuiltin`(§8.2 权限身份)随唤醒事件下传,
   * 供本 episode 的工具面把它填进 `SpawnWorkerParams.origin.creator_friend_id`;两者都不传
   * 时行为与之前逐字相同(既有调用点无需改动)。
   */
  async routeSchedule(p: {
    scheduleId: string
    title: string
    description: string
    taskType?: string
    targetSession?: { channel_id: string; session_id: string }
    creatorFriendId?: string
    isBuiltin?: boolean
  }): Promise<EpisodeResult> {
    const capture = this.captureIngress()
    const key = p.targetSession
      ? (`${p.targetSession.channel_id}::${p.targetSession.session_id}` as ManagerKey)
      : SYSTEM_TASKS_MANAGER_KEY
    const envelope = this.makeEnvelope(capture, {
      kind: 'schedule',
      scheduleId: p.scheduleId,
      title: p.title,
      description: p.description,
      taskType: p.taskType,
      creatorFriendId: p.creatorFriendId,
      isBuiltin: p.isBuiltin,
    })

    // 调度自己的权限身份在唤醒边界解析一次(§4.4),随事件走。**绝不能退回该 key 的会话级
    // 缓存**:打进人类会话的调度会因此拿到"那个会话最近谁在说话"的档位(PR #59 review)。
    // 失败不阻断触发:档位缺失只是让 worker 退回固定档位,调度本身照跑。
    let principalPermissions: ResolvedPermissions | undefined
    if (this.deps.onScheduleWake) {
      try {
        principalPermissions =
          (await this.deps.onScheduleWake({
            key,
            creatorFriendId: p.creatorFriendId,
            isBuiltin: p.isBuiltin,
          })) ?? undefined
      } catch (err) {
        console.error(`[ManagerRegistry] schedule '${p.scheduleId}' 的权限身份解析失败,按未解析继续:`, err)
      }
    }

    return this.runWake(key, {
      ...envelope,
      wake: {
        ...envelope.wake,
        ...(principalPermissions ? { principalPermissions } : {}),
      },
    })
  }

  /** Admin 任务板保存的系统管理输入：只携带通知 revision，不改变会话主体。 */
  async routeWorkboardAdminUpdate(p: {
    key: ManagerKey
    noticeRevision: number
    onSettled?: (result: EpisodeResult) => void
  }): Promise<EpisodeResult> {
    const capture = this.captureIngress()
    const envelope = this.makeEnvelope(capture, {
      kind: 'workboard_admin_update',
      noticeRevision: p.noticeRevision,
    })
    const onSettled = (result: EpisodeResult): void => {
      p.onSettled?.(result)
    }
    const loop = this.getOrCreate(p.key)
    if (this.isEpisodeActive(p.key)) {
      loop.enqueueWorkboardAdminUpdate(envelope)
      return {
        episodeId: '',
        outcome: 'completed',
        turns: 0,
        consumedEvents: false,
        repliedToHuman: false,
        successfulSendMessageTargets: [],
      }
    }
    const result = await this.runWake(p.key, envelope)
    onSettled(result)
    return result
  }

  /**
   * 空闲实例回收:回收 `nowMs - 最后活跃时间 > idleMs`、当前无 episode 在跑、且 **mailbox 为空**
   * 的实例。只删内存里的 `ManagerLoop` 引用,不碰 `ManagerSessionStore` 的盘上状态——回收后
   * 同一 key 再次唤醒会经 `getOrCreate` 重建实例并从盘上恢复历史(见文件头说明)。
   * 返回本次回收数量。
   *
   * **mailbox 非空必须跳过**(P7 阻塞项 #5):mailbox 里的内容是"已经收到、但还没被投递给
   * LLM"的事件——盘上 state 里没有它们(正因为还没消费),`ManagerLoop` 实例是它们唯一的
   * 存放处。回收即永久丢失,直接违反 §4.1"至少一次投递";cutover 之后这条路径上跑的是**人类
   * 消息**(episode 失败会把整批人类消息推回 mailbox 等下次唤醒重投),丢的就是人类消息。
   *
   * 代价是这类实例可能长期不被回收(极端情况:一个 key 的 mailbox 一直非空 → 永不回收)。
   * 这是有意的取舍,且边界可控:①内存占用是一个 `ManagerLoop` 外壳 + 若干条待投递文本,
   * 会话历史本来就在盘上;②mailbox 非空只有两种来路——episode 失败推回(下次唤醒即消费)、
   * 收口后到达的注入(episode 收口时自唤醒消费,见 `maybeSelfWake`),两条都自带收敛路径,
   * "永不回收"意味着"这个 key 确实还欠着一条没投递的消息",此时保住实例正是我们要的。
   */
  evictIdle(idleMs: number, nowMs: number): number {
    let evicted = 0
    for (const [key, loop] of this.loops) {
      if (this.isEpisodeActive(key)) continue
      if (loop.hasPendingMailbox) continue
      const lastActive = this.lastActiveAtMs.get(key) ?? 0
      if (nowMs - lastActive <= idleMs) continue
      this.loops.delete(key)
      this.lastActiveAtMs.delete(key)
      evicted++
    }
    return evicted
  }

  private captureIngress(): IngressCapture {
    this.assertWakeAdmission()
    const now = this.deps.now()
    const timezone = this.deps.timezone?.() ?? resolveTimezone(undefined)
    return { now, timezone, received_at: formatOffsetIso(now, timezone) }
  }

  private async prepareWorkerEventRoute(event: HarnessEvent, fallbackKey?: ManagerKey): Promise<{
    key: ManagerKey
    envelope: TimedWakeEnvelope
  }> {
    const capture = this.captureIngress()
    const found = await this.deps.ledger.findWorker(event.worker_id)
    const eventWithOrigin: HarnessEvent = found
      ? {
          ...event,
          detail: {
            ...(event.detail ?? {}),
            ...(event.task_status ? { outcome: event.task_status } : {}),
            trigger_type: found.worker.origin.trigger_type,
            task_id: found.worker.task.id,
          },
        }
      : event
    return {
      key: found?.worker.manager_key ?? fallbackKey ?? SYSTEM_TASKS_MANAGER_KEY,
      envelope: this.makeEnvelope(
        capture,
        { kind: 'worker_event', event: eventWithOrigin },
        typeof event.ts === 'string' ? event.ts : undefined,
      ),
    }
  }

  private makeEnvelope(
    capture: IngressCapture,
    wake: WakeEvent,
    occurredAt?: string,
    humanMessages?: ReadonlyArray<ChannelMessage>,
    correlation?: import('./loop.js').ManagerWakeCorrelation,
    activityReceipt?: ActivityContextAdmissionReceipt,
  ): TimedWakeEnvelope {
    const occurred_at = parseOccurredAt(occurredAt, 'source')
    const human_occurred_at = humanMessages?.map((message) => ({
      ...(message.platform_message_id ? { message_id: message.platform_message_id } : {}),
      ...toHumanOccurredAt(message.platform_timestamp),
    }))

    return {
      wake,
      received_at: capture.received_at,
      timezone: capture.timezone,
      ...(occurred_at ? { occurred_at } : {}),
      ...(human_occurred_at ? { human_occurred_at } : {}),
      ...(correlation ? { correlation } : {}),
      ...(activityReceipt ? { activity_context_receipt: activityReceipt } : {}),
    }
  }

  /** P6-A §11.6：给 exact admin-chat manager 当前 episode 原子 claim 未 claim 的 request IDs。 */
  claimAdminChatRequestIds(key: ManagerKey): string[] {
    return this.loops.get(key)?.claimAdminChatRequestIds() ?? []
  }

  /** prepare 失败时归还 claim（见 ManagerLoop.unclaimAdminChatRequestIds）。 */
  unclaimAdminChatRequestIds(key: ManagerKey, ids: ReadonlyArray<string>): void {
    this.loops.get(key)?.unclaimAdminChatRequestIds(ids)
  }

  /** 该 key 是否还有至少一个在途 episode(引用计数 > 0)。 */
  private isEpisodeActive(key: ManagerKey): boolean {
    return (this.activeEpisodes.get(key) ?? 0) > 0
  }

  /**
   * getOrCreate + 维护 activeEpisodes 引用计数的公共路径,所有 routeXxx /
   * 自唤醒都走这里。`event === undefined` ⇒ 自唤醒(只处理 mailbox 残留,见
   * `ManagerLoop.drainMailbox`);`selfWakeChain` 是当前连锁自唤醒的深度,真实唤醒恒为 0。
   */
  private runWake(
    key: ManagerKey,
    envelope: TimedWakeEnvelope | undefined,
    selfWakeChain?: number,
    onHumanInputCommitted?: (lastCommittedMessageId: string) => Promise<void>,
  ): Promise<EpisodeResult>
  private runWake(
    key: ManagerKey,
    envelope: TimedWakeEnvelope | undefined,
    selfWakeChain: number,
    onHumanInputCommitted: ((lastCommittedMessageId: string) => Promise<void>) | undefined,
    shouldAdmit: () => Promise<boolean>,
  ): Promise<EpisodeResult | undefined>
  private async runWake(
    key: ManagerKey,
    envelope: TimedWakeEnvelope | undefined,
    selfWakeChain = 0,
    onHumanInputCommitted?: (lastCommittedMessageId: string) => Promise<void>,
    shouldAdmit?: () => Promise<boolean>,
  ): Promise<EpisodeResult | undefined> {
    this.assertWakeAdmission()
    if (this.deps.beforeWake) await this.deps.beforeWake(key, envelope)
    this.assertWakeAdmission()
    if (shouldAdmit && !await shouldAdmit()) return undefined
    const loop = this.getOrCreate(key)
    this.activeEpisodes.set(key, (this.activeEpisodes.get(key) ?? 0) + 1)
    let result: EpisodeResult | undefined
    try {
      // `wakeUp()` 会在输入持久化后才触发非关键通知；这不是 LLM 已完成的确认。
      if (envelope === undefined) {
        result = await loop.drainMailbox()
      } else if (onHumanInputCommitted) {
        result = await loop.wakeUp(envelope, onHumanInputCommitted)
      } else {
        result = await loop.wakeUp(envelope)
      }
      return result
    } finally {
      const remaining = (this.activeEpisodes.get(key) ?? 1) - 1
      if (remaining <= 0) this.activeEpisodes.delete(key)
      else this.activeEpisodes.set(key, remaining)
      if (remaining <= 0 && result?.consumedEvents !== true) {
        loop.rejectPendingActivityMailbox()
      }
      // 必须与上面的引用计数递减处在**同一个同步块**里(中间不 await):否则会出现
      // "计数已归零、自唤醒尚未登记"的窗口,`evictIdle` 恰在此时跑就会把实例连同 mailbox
      // 一起回收掉。`maybeSelfWake` 内部的 `runWake` 在第一个 await 之前就完成了 +1。
      this.maybeSelfWake(key, loop, result, selfWakeChain)
    }
  }

  /**
   * episode 收口后的 mailbox 兜底(P7 阻塞项 #5):engine 在 end_turn 收口前做最后一次
   * `drainPending`,落在那之后的 `enqueueDuringEpisode` 内容没有任何消费者在等,不自唤醒
   * 就会一直停滞在内存 mailbox 里。人类输入由 `wakeUp()` 串行提交或经
   * `enqueueHumanWakeDuringActiveEpisode` 提交后注入(PR #131);
   * 这里在 episode 刚收口、引用计数刚归零的同步窗口里补一次自唤醒。
   *
   * 四道门,缺一不可:
   * 1. `result?.consumedEvents === true` —— **只在成功收口后自唤醒**。episode 失败
   *    (含直接抛错,此时 `result` 是 undefined)会把整批输入原样推回 mailbox,那是 §4.1
   *    "下次唤醒重投"的既有语义;若在这里自唤醒,LLM 持续故障时就变成"失败→立刻重试→再
   *    失败"的热循环,把重投语义变成无限重试。失败留下的残留由 `evictIdle` 的非空保护守住,
   *    等下一次真实唤醒重投。
   * 2. `loop.hasPendingMailbox` —— 没有残留就没有要处理的东西(绝大多数 episode 走这条)。
   * 3. `!isEpisodeActive(key)` —— 同 key 还有别的在途 episode 时不插队:它要么已经在
   *    turn 间隙 drain 掉这批残留,要么在自己收口时走这同一段逻辑。
   * 4. `selfWakeChain < MAX_SELF_WAKE_CHAIN` —— 防无限自唤醒(见该常量注释)。
   */
  private maybeSelfWake(
    key: ManagerKey,
    loop: ManagerLoop,
    result: EpisodeResult | undefined,
    selfWakeChain: number
  ): void {
    if (this.deps.isClosing?.()) return
    if (result?.consumedEvents !== true) return
    if (!loop.hasPendingMailbox) return
    if (this.isEpisodeActive(key)) return
    if (selfWakeChain >= MAX_SELF_WAKE_CHAIN) {
      console.warn(
        `[ManagerRegistry] manager '${key}' 连锁自唤醒达到上限 ${MAX_SELF_WAKE_CHAIN},` +
          `剩余 mailbox 内容留待下次唤醒投递(实例不会被 evictIdle 回收)`
      )
      return
    }
    void this.runWake(key, undefined, selfWakeChain + 1).catch((err) => {
      console.error(`[ManagerRegistry] manager '${key}' 自唤醒失败:`, err)
    })
  }

  private assertWakeAdmission(): void {
    if (this.deps.isClosing?.()) throw new Error('AGENT_SHUTTING_DOWN')
  }
}

/** 唤醒事件 → 随行的 scheduled 权限身份;非 schedule 唤醒没有身份(undefined)。 */
function scheduleIdentityOf(wakeEvent: WakeEvent | undefined): ScheduleIdentity | undefined {
  if (wakeEvent?.kind !== 'schedule') return undefined
  return {
    creatorFriendId: wakeEvent.creatorFriendId,
    isBuiltin: wakeEvent.isBuiltin,
    taskType: wakeEvent.taskType,
  }
}

/**
 * 唤醒事件 → 随行的人类发起人身份;非人类消息唤醒没有身份(undefined)。
 *
 * 认 `human_messages` 与 `attention_flush` 两个 kind:它们都是"某个人在说话",只是递过来
 * 的时机不同(即时 vs 注意力放行后补齐)。**漏掉 attention_flush 就等于群聊放行路径永远
 * 拿不到发起人身份**——那条路上派出去的 worker 会记成"没有 creator"。
 *
 * 反过来,worker 事件与自唤醒虽然也发生在同一个会话里,但它们不是"某个人在说话",拿上一次
 * 的发言者冒充会让 worker 的 `origin.creator_friend_id` 记错人。
 */
function humanPrincipalOf(wakeEvent: WakeEvent | undefined): HumanPrincipal | undefined {
  if (wakeEvent?.kind !== 'human_messages' && wakeEvent?.kind !== 'attention_flush') return undefined
  const sessionType = wakeEvent.messages[0]?.session.type === 'group' ? 'group' : 'private'
  return { ...(wakeEvent.friend ? { friend: wakeEvent.friend } : {}), sessionType }
}

/**
 * 唤醒事件 → 随行的权限档位(PR #59 review)。与上面两个 `*Of` 同一条原则:身份类信息**跟着
 * episode 走**,不从会话级缓存现取。三种带身份的唤醒(人类消息 / 注意力放行 / 调度)各自在
 * 自己的唤醒边界解析好挂上来;worker 事件与自唤醒没有身份,返回 undefined。
 */
function principalPermissionsOf(wakeEvent: WakeEvent | undefined): ResolvedPermissions | undefined {
  if (
    wakeEvent?.kind !== 'human_messages' &&
    wakeEvent?.kind !== 'attention_flush' &&
    wakeEvent?.kind !== 'schedule'
  ) {
    return undefined
  }
  return wakeEvent.principalPermissions
}

interface IngressCapture {
  readonly now: Date
  readonly timezone: string
  readonly received_at: string
}

function parseOccurredAt(value: unknown, source: string): string | undefined {
  if (value === undefined || validIso(value)) return value
  console.warn(`[ManagerRegistry] invalid ${source} occurred_at omitted`)
  return undefined
}

function toHumanOccurredAt(platformTimestamp: unknown): { readonly occurred_at?: string } {
  const occurred_at = parseOccurredAt(platformTimestamp, 'human platform_timestamp')
  return occurred_at ? { occurred_at } : {}
}

function validIso(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
}

/** ISO 8601 with seconds and numeric offset, fixed exactly at registry ingress. */
function formatOffsetIso(date: Date, timezone: string): string {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
    timeZoneName: 'longOffset',
  })
  const parts = formatter.formatToParts(date)
  const part = (type: string): string | undefined =>
    parts.find((item) => item.type === type)?.value
  const offset = part('timeZoneName')?.replace('GMT', '') || '+00:00'
  const normalizedOffset = offset === '+00:00' || offset === '-00:00'
    ? '+00:00'
    : offset

  return [
    `${part('year')}-${part('month')}-${part('day')}`,
    `${part('hour')}:${part('minute')}:${part('second')}${normalizedOffset}`,
  ].join('T')
}
