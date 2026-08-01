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
 * ## `onAsyncError` 出口(Task 4 遗留接线点)
 *
 * `worker-tools.ts` 的 `query_worker` 是字面 fire-and-forget:发起 `adapter.fork` 后不
 * `await`,失败时唯一的"通知调用方"手段是 `WorkerToolsDeps.onAsyncError` 这个可选回调
 * (Task 4 只留出口、不接线)。`getOrCreate` 为每个 key 构造一个绑定该 key 的
 * `OnAsyncError` 实现并通过 `deps.toolFace(key, isSystemThread, onAsyncError)` 交给调用方
 * ——调用方(真正装配 `buildManagerToolFace`/`buildWorkerTools` 的那一层,不在本任务范围)
 * 负责把它接进 `WorkerToolsDeps.onAsyncError`。本文件只负责这个回调"接住错误之后做什么":
 * 按"当前这个 manager 是否正有 episode 在跑"(`activeEpisodes`)二选一——
 *   - 有 episode 在跑:`enqueueDuringEpisode`,错误作为 mid-episode 注入随下一轮 turn 一起
 *     喂给 LLM,不用等这个 episode 结束再唤醒一次;
 *   - 没有 episode 在跑(该 episode 已经结束/loop 甚至被 evictIdle 回收过):`getOrCreate`
 *     惰性重建后直接 `wakeUp`,开一个新 episode 处理这条错误。
 * 错误信息包成 `WakeEvent`:复用既有 `worker_event` kind(不新增 `WakeEvent` 变体,因为
 * `loop.ts` 是 Task 7 的既有产物,本任务的"零现网影响"约束不允许改动),用既有的
 * `HarnessEventKind.query_failed`(worker-events.ts 已经为 `query_worker` 失败预留了这个
 * kind)承载,`seq` 填 `0` 作 sentinel——真实 seq 从 1 起分配(与 harness.ts `queryWorker`
 * 对"worker 不存在"场景同一套 sentinel 约定),`0` 标记"这不对应任何真实化身事件,只是一次
 * 唤醒信号"(真正的失败留痕已经由 `harness.queryWorker` 自己 `appendEvent('query_failed')`
 * 完成,这里不重复写事件流,只借用同一个 kind 语义)。
 *
 * @see crabot-docs/protocols/protocol-agent-v3.md §4.4
 */

import { ManagerLoop, type WakeEvent, type EpisodeResult, type ManagerLoopDeps } from './loop.js'
import type { ManagerSessionStore } from './session-store.js'
import type { CompactionPolicy } from './compaction.js'
import type { ManagerKey } from './types.js'
import type { EngineMessage, LLMAdapter, ToolDefinition } from '../engine/index.js'
import type { WorkerHarness } from '../workers/harness/harness'
import type { LedgerStore } from '../workers/harness/ledger-store'
import type { DialogObjectId } from '../workers/harness/ledger-types'
import type { HarnessEvent, HarnessEventKind } from '../workers/harness/worker-events'
import type { ChannelMessage, Friend } from '../types'
import type { HumanPrincipal } from './principal.js'

/** §4.4 保留线程:未配置目标 session 的 scheduled 触发 / 台账查不到监护 session 的 worker 事件落此。 */
export const SYSTEM_TASKS_MANAGER_KEY = 'admin-web::system-tasks' as ManagerKey

/**
 * 连锁自唤醒的上限(见 `ManagerRegistry.maybeSelfWake`)。
 *
 * 自唤醒本身可能再产生新的 mailbox 内容(自唤醒 episode 期间又有注入到达),不设上限就是
 * 一条"episode → 注入 → episode"的无限链:注入源若是稳定复发的故障(如某 worker 上
 * `query_worker` 恒失败,每个 episode 都触发一次 onAsyncError),链条永不收敛,烧的是真钱。
 * 取 3:够把"收口瞬间才到达"这类一次性尾巴处理干净,又不至于替一个稳定故障源无限重开
 * episode。到顶后残留**不丢**——它留在 mailbox 里,受 `evictIdle` 的非空保护,由下一次
 * 真实唤醒(人类消息 / worker 事件 / schedule)顺带 drain 走,仍满足 §4.1 至少一次投递。
 */
export const MAX_SELF_WAKE_CHAIN = 3

/** `query_worker` 异步失败(Task 4 `WorkerToolsDeps.onAsyncError`)的信息形状,逐字对齐该接口。 */
export interface AsyncToolErrorInfo {
  readonly tool: string
  readonly worker_id: string
  readonly error: string
}

export type OnAsyncError = (info: AsyncToolErrorInfo) => void

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
}

export interface ManagerRegistryDeps {
  readonly store: ManagerSessionStore
  readonly policy: CompactionPolicy
  readonly estimateTokens: (msgs: ReadonlyArray<EngineMessage>) => number
  readonly harness: WorkerHarness
  /** routeWorkerEvent 的 origin 归属查找用(harness 未公开 findWorker,直接持有台账存储)。 */
  readonly ledger: LedgerStore
  /**
   * manager model slot 解析器(protocol-agent-v3.md §11):调用方在此按最新 admin config
   * 解析 `model_config.manager ?? model_config.powerful`(见 `model-slot.ts`
   * `resolveManagerModelConfig`)、用 `createAdapter` 建出 `LLMAdapter`。做成 thunk 而非
   * 字面量是为了让"下一个 episode 生效"的热更语义成立——`getOrCreate` 只在 key 首次建
   * `ManagerLoop` 时把这两个 thunk 原样转给 `ManagerLoopDeps`(见下),`ManagerLoop` 自己
   * 按 episode 边界调用,本 registry 不缓存解析结果。
   */
  readonly adapter: () => LLMAdapter
  readonly model: () => string
  readonly maxTurns?: number
  readonly contextWindowTokens?: number
  readonly now: () => Date
  /**
   * `ManagerKey` → 台账渲染用的 `DialogObjectId`(`ManagerLoopDeps.dialogObjectId`)。
   * 两者粒度不同(manager 按 channel::session,worker 台账按 friend 跨 channel 聚合/单群),
   * 这层映射依赖 friend 解析等本模块无法自行完成的信息,由调用方按 protocol §3 解析好注入。
   *
   * **每次读都要现算**:私聊的归档键要等第一条人类消息带来 friend 之后才能收敛成
   * `friend:<id>`(见 `onHumanWake`),调用方持有的映射会随之变化。
   */
  readonly dialogObjectIdFor: (key: ManagerKey) => DialogObjectId
  /**
   * **人类消息唤醒边界**的异步解析钩子:`routeHumanMessages` 在 `runWake` 之前 await 它一次,
   * 调用方据 `principal`(发起人 friend + 私/群)解析权限、记忆档位、对话对象档案并缓存,
   * 供下面那三个**同步** thunk(`dialogObjectIdFor` / `toolFace` / `promptInputs`)读取。
   *
   * 这是"加参数而不是全面异步化"的落点:异步只发生在唤醒边界这一处,每轮 turn 被同步调用的
   * 签名一个都不用改。不注入则行为与之前逐字相同(manager 拿不到发起人身份)。
   */
  readonly onHumanWake?: (key: ManagerKey, principal: HumanPrincipal) => Promise<void>
  /**
   * 工具面工厂:调用方据 key/isSystemThread 装配 `buildManagerToolFace` 的完整依赖并返回
   * 工具面数组;`onAsyncError` 由本 registry 按 key 绑定好传入,调用方负责把它接进
   * `WorkerToolsDeps.onAsyncError`(见文件头说明)。
   *
   * P5 Task 4 additive:第四个参数是**本 episode 若由 scheduled 触发**时随行的权限身份
   * (非 schedule 唤醒为 undefined),调用方据它填 `WorkerToolsContext.creatorFriendId` /
   * `triggerType`。可选参数,既有三参调用点无需改动。
   *
   * P7 J additive:第五个参数是**本 episode 若由人类消息唤醒**时随行的发起人身份
   * (非人类消息唤醒为 undefined)。与 scheduleIdentity 分开两个参数而不是合成一个
   * "身份"联合体,是因为两者的语义不同:schedule 的身份来自任务定义(§8.2),人类消息的
   * 身份来自本批消息的发言者(§4.3),混成一个会让调用方无从判断该走哪条权限规则。
   */
  readonly toolFace: (
    key: ManagerKey,
    isSystemThread: boolean,
    onAsyncError: OnAsyncError,
    scheduleIdentity?: ScheduleIdentity,
    humanPrincipal?: HumanPrincipal
  ) => ReadonlyArray<ToolDefinition>
  /** system prompt 动态段素材(档案/待处理通知),每轮重算,由调用方决定要不要按最新状态重建。 */
  readonly promptInputs: (key: ManagerKey) => { readonly dialogProfile?: string; readonly pendingNotes?: ReadonlyArray<string> }
}

export class ManagerRegistry {
  private readonly loops = new Map<ManagerKey, ManagerLoop>()
  /**
   * 每个 key 当前"在途" episode 的引用计数——决定 evictIdle 是否可回收、onAsyncError 走
   * wakeUp 还是 enqueueDuringEpisode。**必须是计数,不能是布尔/Set 的有无标记**:同一 key 可能
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

  /** 惰性拉起:key 无实例则建;同 key 幂等返回同一实例。实例常驻内存,session 状态在盘上。 */
  getOrCreate(key: ManagerKey): ManagerLoop {
    const existing = this.loops.get(key)
    if (existing) return existing

    const isSystemThread = key === SYSTEM_TASKS_MANAGER_KEY
    const onAsyncError: OnAsyncError = (info) => this.handleAsyncToolError(key, info)

    const loopDeps: ManagerLoopDeps = {
      key,
      isSystemThread,
      // thunk 而非定值:私聊的台账归档键要等第一条人类消息带来 friend 才收敛成
      // `friend:<id>`,而 loop 实例可能先被 worker 事件建出来。定值会把那一刻的
      // group 形状永久钉死在实例上,同一个人的台账因此裂成两份。
      dialogObjectId: () => this.deps.dialogObjectIdFor(key),
      store: this.deps.store,
      policy: this.deps.policy,
      estimateTokens: this.deps.estimateTokens,
      adapter: this.deps.adapter,
      model: this.deps.model,
      maxTurns: this.deps.maxTurns,
      contextWindowTokens: this.deps.contextWindowTokens,
      // 唤醒事件由 ManagerLoop 按 episode 传入(见 ManagerLoopDeps.toolFace);schedule 之外
      // 的唤醒不带身份,工具面照旧。
      toolFace: (wakeEvent) =>
        this.deps.toolFace(
          key,
          isSystemThread,
          onAsyncError,
          scheduleIdentityOf(wakeEvent),
          humanPrincipalOf(wakeEvent),
        ),
      promptInputs: () => this.deps.promptInputs(key),
      harness: this.deps.harness,
      now: this.deps.now,
      onEpisodeEnd: () => this.lastActiveAtMs.set(key, this.deps.now().getTime()),
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
    friend?: Friend
  ): Promise<EpisodeResult> {
    return this.routeHumanWake('human_messages', channelId, sessionId, messages, friend)
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
    friend?: Friend
  ): Promise<EpisodeResult> {
    return this.routeHumanWake('attention_flush', channelId, sessionId, messages, friend)
  }

  /** 两个人类消息入口的公共路径:解析发起人身份(唤醒边界的唯一一次异步)→ 按 kind 造事件唤醒。 */
  private async routeHumanWake(
    kind: 'human_messages' | 'attention_flush',
    channelId: string,
    sessionId: string,
    messages: ReadonlyArray<ChannelMessage>,
    friend?: Friend
  ): Promise<EpisodeResult> {
    const key = `${channelId}::${sessionId}` as ManagerKey
    // 私/群不新增数据来源:它就在消息自己的 session 上。空批(理论上不该发生)按私聊算,
    // 与 `handleMessageReceived` 的默认分流一致。
    const sessionType = messages[0]?.session.type === 'group' ? 'group' : 'private'
    const principal: HumanPrincipal = { ...(friend ? { friend } : {}), sessionType }

    // 唤醒边界的唯一一次异步解析。失败不阻断投递——人类消息比档位重要,档位缺失
    // 只会退回 fail-soft 兜底,而消息丢了就是丢了。
    if (this.deps.onHumanWake) {
      try {
        await this.deps.onHumanWake(key, principal)
      } catch (err) {
        console.error(`[ManagerRegistry] manager '${key}' 的发起人身份解析失败,按未解析继续:`, err)
      }
    }

    const withFriend = friend ? { friend } : {}
    const event: WakeEvent =
      kind === 'human_messages'
        ? { kind: 'human_messages', messages, ...withFriend }
        : { kind: 'attention_flush', messages, ...withFriend }
    return this.runWake(key, event)
  }

  /**
   * harness 事件 → 该 worker 的监护 manager(台账 `origin.spawned_by_session`);查不到则落
   * 系统线程。注意:这里解出的 manager 与该 worker 台账所属的 `DialogObjectId` 可以是两个
   * 不同的对话对象(同一 friend 跨 channel 共享台账)——这是设计意图,不是需要修正的不一致。
   */
  async routeWorkerEvent(event: HarnessEvent): Promise<EpisodeResult | undefined> {
    const found = await this.deps.ledger.findWorker(event.worker_id)
    const key = found?.worker.origin.spawned_by_session ?? SYSTEM_TASKS_MANAGER_KEY
    return this.runWake(key, { kind: 'worker_event', event })
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
    targetSession?: { channel_id: string; session_id: string }
    creatorFriendId?: string
    isBuiltin?: boolean
  }): Promise<EpisodeResult> {
    const key = p.targetSession
      ? (`${p.targetSession.channel_id}::${p.targetSession.session_id}` as ManagerKey)
      : SYSTEM_TASKS_MANAGER_KEY
    return this.runWake(key, {
      kind: 'schedule',
      scheduleId: p.scheduleId,
      title: p.title,
      description: p.description,
      creatorFriendId: p.creatorFriendId,
      isBuiltin: p.isBuiltin,
    })
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

  /** query_worker 异步失败 → 唤醒信号(见文件头"onAsyncError 出口"一节)。 */
  private handleAsyncToolError(key: ManagerKey, info: AsyncToolErrorInfo): void {
    const event = buildAsyncErrorWakeEvent(info, this.deps.now())
    if (this.isEpisodeActive(key)) {
      this.getOrCreate(key).enqueueDuringEpisode(event)
      return
    }
    void this.runWake(key, event).catch((err) => {
      console.error(`[ManagerRegistry] onAsyncError 唤醒 manager '${key}' 失败:`, err)
    })
  }

  /** 该 key 是否还有至少一个在途 episode(引用计数 > 0)。 */
  private isEpisodeActive(key: ManagerKey): boolean {
    return (this.activeEpisodes.get(key) ?? 0) > 0
  }

  /**
   * getOrCreate + 维护 activeEpisodes 引用计数的公共路径,所有 routeXxx / onAsyncError /
   * 自唤醒都走这里。`event === undefined` ⇒ 自唤醒(只处理 mailbox 残留,见
   * `ManagerLoop.drainMailbox`);`selfWakeChain` 是当前连锁自唤醒的深度,真实唤醒恒为 0。
   */
  private async runWake(key: ManagerKey, event: WakeEvent | undefined, selfWakeChain = 0): Promise<EpisodeResult> {
    const loop = this.getOrCreate(key)
    this.activeEpisodes.set(key, (this.activeEpisodes.get(key) ?? 0) + 1)
    let result: EpisodeResult | undefined
    try {
      result = await (event === undefined ? loop.drainMailbox() : loop.wakeUp(event))
      return result
    } finally {
      const remaining = (this.activeEpisodes.get(key) ?? 1) - 1
      if (remaining <= 0) this.activeEpisodes.delete(key)
      else this.activeEpisodes.set(key, remaining)
      // 必须与上面的引用计数递减处在**同一个同步块**里(中间不 await):否则会出现
      // "计数已归零、自唤醒尚未登记"的窗口,`evictIdle` 恰在此时跑就会把实例连同 mailbox
      // 一起回收掉。`maybeSelfWake` 内部的 `runWake` 在第一个 await 之前就完成了 +1。
      this.maybeSelfWake(key, loop, result, selfWakeChain)
    }
  }

  /**
   * episode 收口后的 mailbox 兜底(P7 阻塞项 #5):engine 在 end_turn 收口前做最后一次
   * `drainPending`,落在那之后的 `enqueueDuringEpisode` 内容没有任何消费者在等,不自唤醒
   * 就会一直停滞在内存 mailbox 里(cutover 后这条路径上会跑人类消息 → 表现为"机器人收到了
   * 但永远不回")。这里在 episode 刚收口、引用计数刚归零的同步窗口里补一次自唤醒。
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
}

/** 唤醒事件 → 随行的 scheduled 权限身份;非 schedule 唤醒没有身份(undefined)。 */
function scheduleIdentityOf(wakeEvent: WakeEvent | undefined): ScheduleIdentity | undefined {
  if (wakeEvent?.kind !== 'schedule') return undefined
  return { creatorFriendId: wakeEvent.creatorFriendId, isBuiltin: wakeEvent.isBuiltin }
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

/** query_worker 异步失败 → 借用既有 `worker_event`/`query_failed` kind 包装成 WakeEvent(见文件头)。 */
function buildAsyncErrorWakeEvent(info: AsyncToolErrorInfo, now: Date): WakeEvent {
  const kind: HarnessEventKind = 'query_failed'
  const event: HarnessEvent = {
    ts: now.toISOString(),
    kind,
    worker_id: info.worker_id,
    seq: 0, // sentinel:不对应任何真实化身事件,只是一次唤醒信号(见文件头)
    detail: { tool: info.tool, error: info.error, synthetic: true },
  }
  return { kind: 'worker_event', event }
}
