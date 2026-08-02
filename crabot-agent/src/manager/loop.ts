/**
 * ManagerLoop —— episode 生命周期(protocol-agent-v3.md §4.1/§4.2)。
 *
 * 逻辑长驻:manager session 永不 finalize、无终态;无活跃 episode 时不占内存,状态全在盘上
 * (ManagerSessionStore)。`wakeUp` 是唯一入口——被唤醒→跑一个 episode(一次完整的
 * runEngine 往返)→回睡,同一 loop 内串行(AsyncMutex),不同 loop 相互独立、可并行。
 *
 * ## 压缩自管(disableCompaction:true)
 *
 * manager 把 engine 内建的两条压缩路径都关掉(见 compaction.ts 文件头),自己在唤醒边界
 * 接管:load → decideCompaction → 需要则 foldIntoSummary 并落盘 → 把
 * [摘要块(如有)] + [尾巴] + [本次事件] 拼成 initialMessages 喂 runEngine。折叠只发生在
 * 唤醒边界,burst(同一 episode 内的多轮 turn)绝不压缩。
 *
 * disableCompaction 关掉的第二条路径是 engine 对 stop_reason==='max_tokens' 的强压重试——
 * 关掉后 engine 遇到静默 max_tokens 直接以 outcome='completed'、finalText='' 收场(见
 * query-loop.ts 该分支的 disableCompaction 短路,读代码确认,不是猜的)，本模块用
 * `isContextOverflow` 从 EngineResult 结构里识别这一情形(以及吞吐层真的抛出"上下文超限"
 * 错误的少数情形),命中后强制 force_hot 折叠一次并重试一次,仍不行就放弃 episode。
 *
 * ## episode 失败语义(protocol §4.1)
 *
 * LLM 重试耗尽 → 放弃 episode:邮箱事件不消费(`consumedEvents: false`),原样推回内部邮箱,
 * 下次唤醒重投(至少一次投递);已经落盘的东西(如折叠产生的新摘要)不回滚。
 *
 * ## 摘要块在 initialMessages 里的表达形式
 *
 * EngineMessage 没有 system 角色,滚动摘要因此借道一条打了明确标记的 user message
 * (`SUMMARY_MESSAGE_PREFIX`)置于 initialMessages 最前——protocol §4.2"滚动摘要块"在上下文
 * 里排第二位(仅次于静态身份段,后者由 system prompt 承载),这里摘要与"最近 K 条原始消息"
 * 都放进 messages 数组,不进 system prompt(与 compaction.ts/prompt.ts 的既定分工一致)。
 */

import { randomUUID } from 'crypto'
import {
  runEngine,
  createUserMessage,
  HumanMessageQueue,
  type EngineMessage,
  type EngineResult,
  type EngineOptions,
  type ToolDefinition,
  type LLMAdapter,
  type QueueContent,
  type TextBlock,
} from '../engine/index.js'
import { AsyncMutex } from '../workers/async-mutex'
import { formatChannelMessageLine } from '../prompt-manager.js'
import { resolveSenderIdentity } from '../utils/sender-identity.js'
import { resolveTimezone } from '../utils/time.js'
import { decideCompaction, foldIntoSummary, type CompactionPolicy, type CompactionDecision } from './compaction.js'
import { assembleManagerSystemPrompt } from './prompt.js'
import type { ManagerSessionStore } from './session-store.js'
import type { ManagerSessionState, ManagerKey } from './types.js'
import type { WorkerHarness } from '../workers/harness/harness'
import type { DialogObjectId, LedgerWorker } from '../workers/harness/ledger-types'
import type { HarnessEvent } from '../workers/harness/worker-events'
import type { ChannelMessage, Friend, ResolvedPermissions } from '../types'

// --- Public Interface ---

export type WakeEvent =
  | {
      readonly kind: 'human_messages'
      readonly messages: ReadonlyArray<ChannelMessage>
      /**
       * P7 J additive:本批消息的**发言者**(§4.3 权限身份、§8.2 `creator_friend_id`)。
       * 与 schedule 的 `creatorFriendId` 同样只在唤醒事件上随行、**不作为独立字段进对话
       * 上下文**:它的用途是让本 episode 的工具面按发起人身份装配、让派出去的 worker 记对
       * `origin.creator_friend_id`,不是给 LLM 看的。
       *
       * (渲染层只把它当作 `resolveSenderIdentity` 的判据——决定每条消息渲染成
       * `identity="master|friend|stranger"`,friend 对象本身不进正文。)
       */
      readonly friend?: Friend
      /**
       * 上面那个发言者**算好的权限档位**(§8.2),与 friend 同源同刻,由唤醒边界的异步解析
       * (`ManagerRegistryDeps.onHumanWake`)产出。
       *
       * **跟着 episode 走,不从会话级缓存现取**:缓存是"该会话最近一次解析",群聊里换个人
       * 说话就整体覆盖;本 episode 派出去的 worker 必须拿到**本批发言者**的档位,而不是
       * 派活那一瞬间恰好最新的那个人的(PR #59 review)。同 `friend`,不进对话上下文。
       */
      readonly principalPermissions?: ResolvedPermissions
    }
  | { readonly kind: 'worker_event'; readonly event: HarnessEvent }
  | {
      readonly kind: 'schedule'
      readonly scheduleId: string
      readonly title: string
      readonly description: string
      /**
       * P5 Task 4 additive:本次调度触发的**权限身份**(protocol-agent-v3 §8.2
       * `creator_friend_id` / `is_builtin`,§4.4"权限按 Schedule.creator_friend_id 解析")。
       * 只在唤醒事件上随行,不进 manager 的对话上下文(`renderWakeEvent` 不渲染它):它的
       * 用途是让本 episode 派出去的 worker 记对 `origin.creator_friend_id`,不是给 LLM 看的。
       */
      readonly creatorFriendId?: string
      readonly isBuiltin?: boolean
      /**
       * 上面那个调度身份**算好的权限档位**(§4.4"权限按 `Schedule.creator_friend_id` 解析
       * (`is_builtin` 按 master 等价)"),由唤醒边界的异步解析
       * (`ManagerRegistryDeps.onScheduleWake`)产出。
       *
       * 必须随事件走:scheduled 触发可以打进一个**人类会话**的 manager,那个会话的
       * 发起人缓存是"最近谁在说话",与这次调度的身份毫无关系(PR #59 review)。
       */
      readonly principalPermissions?: ResolvedPermissions
    }
  | {
      readonly kind: 'attention_flush'
      readonly messages: ReadonlyArray<ChannelMessage>
      /**
       * P7 J additive:与 `human_messages` 的同名字段逐字同义(见上)。
       * **群聊注意力放行走的是这一条**,漏带 friend 就等于群聊路径拿不到发起人身份
       * ——权限档位 / 记忆 scopes / 台账归档键全部退回未解析那一档。
       */
      readonly friend?: Friend
      /** 与 `human_messages` 的同名字段逐字同义(见上)。 */
      readonly principalPermissions?: ResolvedPermissions
    }

export interface EpisodeResult {
  readonly episodeId: string
  readonly outcome: 'completed' | 'failed' | 'max_turns' | 'aborted'
  readonly turns: number
  /** false ⇒ 邮箱事件不消费,已推回内部邮箱,下次唤醒重投 */
  readonly consumedEvents: boolean
  /**
   * 本 episode 里 manager 有没有**跟人说话**(调过 `HUMAN_REPLY_TOOL_NAMES` 里的任一工具)。
   *
   * 存在的理由只有一个:群聊注意力退避(`AttentionScheduler.reportResult(sessionId, replied)`)
   * 需要这个信号,而 `outcome` 答不了——`completed` 既可能是"回了话"也可能是"决定沉默",
   * 语义上无法区分。漏了它 = 群聊巡检间隔永久停在当前值,群聊逐渐停止响应。
   *
   * **判据是"发起了发送动作",不是"人类真的收到了"**:与 v2 的
   * `hasReply = actions.some(a => a.kind !== 'stay_silent')` 同一层语义(决策层,不是投递层)
   * ——工具执行结果是否 is_error 不参与判定。
   */
  readonly repliedToHuman: boolean
}

export interface ManagerLoopDeps {
  readonly key: ManagerKey
  readonly isSystemThread: boolean
  /** 台账渲染用(harness.listWorkers 的入参)。manager 会话粒度(ManagerKey)与台账聚合粒度
   *  (DialogObjectId)不同——由调用方按 protocol §3 解析好传入,本模块不做这层映射。
   *
   *  **thunk 而非定值**(P7 J):私聊的归档键要等第一条人类消息带来 friend 之后才能收敛成
   *  `friend:<id>`,而 loop 实例可能先由 worker 事件建出来。定值会把那一刻的 group 形状
   *  永久钉死在实例上,同一个人的台账因此裂成两份。 */
  readonly dialogObjectId: () => DialogObjectId
  readonly store: ManagerSessionStore
  readonly policy: CompactionPolicy
  /** decideCompaction 的 token 估算器,调用方注入(与 compaction.ts 的既定依赖注入方式一致)。 */
  readonly estimateTokens: (msgs: ReadonlyArray<EngineMessage>) => number
  /**
   * LLM adapter / model 解析器(protocol-agent-v3.md §11:"manager 的 prompt / model 热更于
   * 下一个 episode 生效")。刻意做成 thunk 而不是字面量:`ManagerLoop` 实例按 key 常驻
   * 在 `ManagerRegistry` 里跨多个 episode 复用(见 registry.ts),若 adapter/model 是构造时
   * 就固定的字面量,admin 侧改了 model_config 也无法在不销毁重建 loop 的前提下生效。
   * `runEpisodeBody` 只在每个 episode 开始时调用一次并整段复用同一份快照(包括 max_tokens
   * 兜底重试)——同一 episode 内绝不重复解析,下一次 `wakeUp` 才会拿到最新值,与 toolFace/
   * promptInputs "每轮重算"的更细粒度热更不同(那两个是 per-turn,这两个是 per-episode)。
   */
  readonly adapter: () => LLMAdapter
  readonly model: () => string
  readonly maxTurns?: number
  readonly contextWindowTokens?: number
  /**
   * 工具面提供者(thunk):每轮重算,由调用方决定要不要按最新状态重建。
   *
   * P5 Task 4 additive:入参是**本 episode 的唤醒事件**,让调用方能按"这次是被什么唤醒的"
   * 装配工具面(当前唯一用途:scheduled 触发的权限身份 → `spawn_worker` 的
   * `origin.creator_friend_id`)。可选参数,既有调用方 `() => [...]` 无需改动。
   */
  readonly toolFace: (wakeEvent?: WakeEvent) => ReadonlyArray<ToolDefinition>
  /** system prompt 里除动态台账/时间外的其余输入(档案、待处理通知),每轮重算。 */
  readonly promptInputs: () => { readonly dialogProfile?: string; readonly pendingNotes?: ReadonlyArray<string> }
  readonly harness: WorkerHarness
  readonly now: () => Date
  /**
   * 人类消息渲染用的时区(`formatChannelMessageLine` 的 `ts` 属性)。thunk 而非定值:
   * 与 adapter/model 同理,admin 改了实例时区不必销毁重建 loop。
   * 不注入则退回 `resolveTimezone(undefined)`(env `CRABOT_DEFAULT_TIMEZONE` → Asia/Shanghai)。
   */
  readonly timezone?: () => string
  readonly onEpisodeEnd?: (result: EpisodeResult) => void
}

/** 滚动摘要块在 initialMessages 里的前缀标记,避免 LLM 把它误当成用户刚发的话。 */
const SUMMARY_MESSAGE_PREFIX = '[以下是本次对话更早历史的滚动摘要,不是用户刚发的话]\n\n'

export class ManagerLoop {
  private readonly deps: ManagerLoopDeps
  private readonly mutex = new AsyncMutex()
  /**
   * 唯一的内部邮箱,episode 运行中/不运行中共用同一个实例:
   * - 运行中:作为 EngineOptions.humanMessageQueue 传给 runEngine,engine 在 turn 间隙
   *   drainPending() 消费,新内容对下一轮可见;
   * - 不运行中:enqueueDuringEpisode 照样 push,只是没有消费者在等,内容原样留在
   *   `pending`(见 human-message-queue.ts push() 实现),下次 wakeUp() 顶部的
   *   drainPending() 会把它们和本次唤醒事件一起拼进新 episode 的 initialMessages——
   *   "至少一次投递"对两种时机是同一套代码路径,不需要再维护一份独立的 pending 队列。
   *
   * 但"下次唤醒"未必会到来:注入若落在 engine 最后一次 drain 之后(query-loop 在 end_turn
   * 收口前的那次 drainPending),内容就会一直躺在这里。这个停滞窗口由 `ManagerRegistry`
   * 在 episode 收口时按 `hasPendingMailbox` 自唤醒(`drainMailbox`)兜底,并由 `evictIdle`
   * 拒绝回收 mailbox 非空的实例保证它不会先被回收掉(P7 阻塞项 #5)。
   */
  private readonly mailbox = new HumanMessageQueue()
  /**
   * 非 null 期间表示"当前正有一个 episode 在跑",记录本次 episode 期间所有经
   * `enqueueDuringEpisode` 推进 mailbox 的原始文本(按到达顺序)。episode 失败时,
   * 其中已被 engine `drainPending()` 消费进(随失败一起被丢弃的)`finalMessages` 的那部分
   * 内容不会再留在 mailbox 里——必须靠这份记录才能连同 carriedTexts/eventText 一起重投,
   * 否则永久丢失(见 runEpisode 失败分支)。episode 成功时整份丢弃,不重投(已被消费进
   * 保存的 state.recent,重投会变成重复投递)。episode 未在跑时为 null,enqueueDuringEpisode
   * 不记录——那时 mailbox 只是普通 pending 队列,靠下次 wakeUp 顶部的 drainPending 自然带走。
   */
  private currentEpisodeInjected: string[] | null = null
  /**
   * P5 Task 4 additive:本 episode 的唤醒事件,供 `deps.toolFace(wakeEvent)` 按"这次是被
   * 什么唤醒的"装配工具面(见 `ManagerLoopDeps.toolFace`)。与 `currentEpisodeInjected`
   * 同一套生命周期纪律(runEpisode 进入时置、finally 清),因此天然是**每 episode 精确**的
   * ——同一 loop 的 episode 由 `wakeUp` 的 mutex 串行,不会有两个 episode 的唤醒事件交叠;
   * 这正是不把它做成 registry 侧 `Map<ManagerKey, …>` 的原因(那样并发唤醒会串身份)。
   */
  private currentWakeEvent: WakeEvent | null = null

  constructor(deps: ManagerLoopDeps) {
    this.deps = deps
  }

  /** 唯一入口:被唤醒 → 跑一个 episode → 回睡。同一 loop 串行,不同 loop 互不影响。 */
  async wakeUp(event: WakeEvent): Promise<EpisodeResult> {
    return this.mutex.run(() => this.runEpisode(event))
  }

  /**
   * 自唤醒入口(`ManagerRegistry` 专用):不带新唤醒事件,只把 mailbox 里的残留跑一个 episode
   * 处理掉。用途见 registry.ts `maybeSelfWake`——engine 在 end_turn 收口前做最后一次
   * `drainPending`,落在那之后的 `enqueueDuringEpisode` 内容没有任何消费者在等,若不自唤醒
   * 就会一直躺在内存 mailbox 里。
   *
   * mailbox 为空(残留已被别的 episode 顺带 drain 走)时是 no-op:不调 LLM、不写盘、不记
   * episode 日志——否则会拿一份没有任何新内容的上下文再问一次 LLM,凭空多出一次回复。
   */
  async drainMailbox(): Promise<EpisodeResult> {
    return this.mutex.run(() => this.runEpisode(undefined))
  }

  /**
   * mailbox 里是否还有尚未投递给 LLM 的内容。`ManagerRegistry` 用它做两件事:
   * ① episode 收口后判断要不要自唤醒;② `evictIdle` 判断该实例能不能回收——mailbox 是这些
   * 内容**唯一**的存放处(盘上 state 没有它们,正因为还没被消费),回收即永久丢失。
   */
  get hasPendingMailbox(): boolean {
    return this.mailbox.hasPending
  }

  /** episode 进行中到达的新事件:渲染成文本推进内部邮箱,由 engine 的 humanMessageQueue
   *  在 turn 间隙注入;episode 不在跑时同样入队,行为见 `mailbox` 字段注释。 */
  enqueueDuringEpisode(event: WakeEvent): void {
    const text = this.renderEvent(event)
    this.mailbox.push(text)
    this.currentEpisodeInjected?.push(text)
  }

  /**
   * 唤醒事件 → 投喂给 LLM 的文本。**每个事件只渲染一次**(渲染结果之后作为字符串在
   * mailbox / state.recent 里流转,失败重投也是同一份字符串),因此渲染依赖当前时钟这件事
   * 不会让已经进上下文的内容事后改变——前缀缓存不受影响。
   */
  private renderEvent(event: WakeEvent): string {
    return renderWakeEvent(event, {
      timezone: this.deps.timezone?.() ?? resolveTimezone(undefined),
      now: this.deps.now(),
    })
  }

  /** `event === undefined` ⇒ 自唤醒(见 `drainMailbox`):只处理 mailbox 残留,不渲染唤醒事件。 */
  private async runEpisode(event: WakeEvent | undefined): Promise<EpisodeResult> {
    const episodeId = randomUUID()
    const carriedTexts = this.mailbox.drainPending().map(toText)
    if (event === undefined && carriedTexts.length === 0) {
      // 自唤醒但 mailbox 已空(残留被排在前面的另一个 episode 顺带 drain 走了)——
      // 没有任何新内容,直接空转返回,不开 episode(见 drainMailbox 注释)。
      return { episodeId, outcome: 'completed', turns: 0, consumedEvents: true, repliedToHuman: false }
    }
    const eventText = event === undefined ? undefined : this.renderEvent(event)
    this.currentEpisodeInjected = []
    this.currentWakeEvent = event ?? null

    try {
      return await this.runEpisodeBody(episodeId, carriedTexts, eventText)
    } catch (err) {
      // runEpisodeBody 内部按 outcome 判定的失败分支(约 L232-249,LLM 报错被 engine 捕获为
      // outcome='failed'/'aborted' 后正常 return 的路径)已经在返回前自行完成了重投——那条路径
      // 不会走到这里。这里的 catch 专门兜"直接 throw、根本没走到 outcome 判定"的路径:
      // applyFold → foldIntoSummary(折叠 LLM 持续故障、callNonStreaming 重试耗尽抛出)、
      // runAttempt 顶部首次 fetchLedgerRender(台账读盘瞬时失败,onTurn 的 refresh 路径才有
      // .catch,这个首次 await 没有)、store.load/store.save/appendEpisodeLog 的 IO 失败等。
      // 两条路径互斥(runEpisodeBody 要么正常 return、要么中途 throw,不会同时触发两次重投),
      // 否则已 drain 的 carriedTexts/eventText/currentEpisodeInjected 会随栈展开永久丢失,
      // 绕过"至少一次投递"(见文件头)。
      this.mailbox.drainPending()
      for (const t of carriedTexts) this.mailbox.push(t)
      if (eventText !== undefined) this.mailbox.push(eventText)
      for (const t of this.currentEpisodeInjected ?? []) this.mailbox.push(t)
      throw err
    } finally {
      this.currentEpisodeInjected = null
      this.currentWakeEvent = null
    }
  }

  private async runEpisodeBody(
    episodeId: string,
    carriedTexts: ReadonlyArray<string>,
    eventText: string | undefined,
  ): Promise<EpisodeResult> {
    // §11 热更语义:整个 episode(含下面的 max_tokens 兜底重试)只在这里解析一次 adapter/
    // model,固定用这份快照——即使两次解析之间 admin config 已经变了,当前 episode 也不换。
    const adapter = this.deps.adapter()
    const model = this.deps.model()

    let state = await this.deps.store.load(this.deps.key)
    const nowMs = this.deps.now().getTime()

    const wakeDecision = decideCompaction({
      state,
      nowMs,
      policy: this.deps.policy,
      estimateTokens: this.deps.estimateTokens,
    })
    if (wakeDecision.kind !== 'none') {
      state = await this.applyFold(state, wakeDecision, adapter, model)
    }

    const tailMessages: EngineMessage[] = [
      ...state.recent,
      ...carriedTexts.map((t) => createUserMessage(t)),
      ...(eventText === undefined ? [] : [createUserMessage(eventText)]),
    ]

    let attempt = await this.runAttempt(state, tailMessages, adapter, model)
    let totalTurnsUsed = attempt.result.totalTurns
    // 与 totalTurnsUsed 同一套累加纪律:兜底重试会整体丢弃首次尝试的 finalMessages,但首次
    // 尝试里已经发出去的话人类是真的收到了——只看重试那一份会把"说过话"错报成"没说过"。
    let repliedToHuman = detectRepliedToHuman(attempt.result.finalMessages)

    // max_tokens 兜底(§4.2):disableCompaction 关掉了 engine 自己的强压重试路径,
    // 这里识别到"上下文超限收场"时强制 force_hot 折叠一次并重试一次,仍失败就放弃。
    //
    // mid-episode 注入与这条重试路径的交互(想清楚过,记录结论):
    // 首次尝试期间通过 enqueueDuringEpisode 到达的 mid-episode 注入内容,无论当时是否已被
    // engine drainPending() 消费(消费掉的已经进了随首次尝试一起丢弃的 finalMessages;未消费
    // 的——例如恰好在首次尝试最后一次 LLM 调用期间到达,或在两次尝试之间 applyFold 的折叠
    // LLM 调用期间到达——仍原样躺在 mailbox.pending 里),currentEpisodeInjected 都完整记录了
    // 原始文本,是唯一权威来源。首次尝试的所有轮次连同其中的消费行为都被丢弃,这些内容等于
    // 没被处理过,重试时显式把它们追加进 retryTailMessages 才是准确的重投。
    // 若 mailbox.pending 里还残留"未被消费"那一段不清空,它是 currentEpisodeInjected 的
    // 后缀——retry 复用同一个 `this.mailbox` 实例作为 humanMessageQueue,engine 会在 retry
    // 的 turn 边界自然把它再 drain 一次,与下面显式追加的 currentEpisodeInjected 重复投递
    // (同一条内容在 retry 上下文出现两份)。因此显式追加前必须先 drainPending() 清空残留。
    if (isContextOverflow(attempt.result)) {
      const forceDecision = forceHotFold({ ...state, recent: tailMessages }, this.deps.policy, this.deps.estimateTokens, nowMs)
      if (forceDecision.kind !== 'none') {
        state = await this.applyFold(state, forceDecision, adapter, model)
        // 清空 mailbox 残留后缀(见上方注释),再按 currentEpisodeInjected 的到达顺序整体追加
        this.mailbox.drainPending()
        const retryTailMessages: EngineMessage[] = [
          ...state.recent,
          ...(this.currentEpisodeInjected?.map((t) => createUserMessage(t)) ?? []),
        ]
        const retryAttempt = await this.runAttempt(state, retryTailMessages, adapter, model)
        totalTurnsUsed += retryAttempt.result.totalTurns
        repliedToHuman = repliedToHuman || detectRepliedToHuman(retryAttempt.result.finalMessages)
        attempt = retryAttempt
      }
      // forceDecision.kind === 'none':无法进一步压缩,直接接受第一次尝试的结果,不重试
      // (大概率仍是 outcome='completed' 空 finalText,不强行判 failed——engine 本身没有报错,
      // 只是这条上下文天生就大)。触发场景有两类:①历史短到连一条都折不动(< keepRecent);
      // ②历史恰好等于 keepRecent 条(decideCompaction 的 force_hot 分支已对 foldMessages
      // 为空这一情形短路返回 none,见 compaction.ts)——这两类都意味着"折叠"这条缓解手段已经
      // 榨不出任何进展,再重试一次只会拿同样大小的上下文重新问一遍 LLM,注定再次超限,纯烧钱,
      // 因此这里不为它们单独加重试:维持"forceDecision.kind==='none' 就不重试"这一既有分支
      // 覆盖两类触发场景,不需要额外判断。
    }

    await this.deps.store.appendEpisodeLog(this.deps.key, episodeId, attempt.result.finalMessages)

    // 只有真正跑完 turn(completed / max_turns)才算"处理过"这批事件;
    // failed / aborted 一律不消费,交回邮箱下次重投。
    const consumedEvents = attempt.result.outcome === 'completed' || attempt.result.outcome === 'max_turns'

    if (consumedEvents) {
      const newRecent = attempt.result.finalMessages.slice(attempt.hasSummaryMarker ? 1 : 0)
      state = { ...state, recent: newRecent, lastActiveAt: this.deps.now().toISOString() }
      await this.deps.store.save(state)
    } else {
      // 放弃 episode:已落盘的折叠不回滚(见文件头)——若本次途中发生过 force_hot 折叠
      // (上面 max_tokens 兜底重试路径),carriedTexts/eventText 有可能已经作为
      // tailMessages 的一部分被折进了 rollingSummary(见 forceHotFold),这里仍会原样
      // 重投它们,导致同一份内容同时以"摘要"与"原始文本"两种形式留存——已知取舍,不在此修复。
      //
      // 把"这次没处理完的输入"按原始到达顺序整体推回邮箱:carriedTexts → eventText →
      // episode 期间经 enqueueDuringEpisode 注入的内容(currentEpisodeInjected,顺序即
      // 到达顺序)。后者无论当时是否已被 engine drainPending() 消费——消费掉的已经进了
      // 随失败一起丢弃的 finalMessages,不消费的还原样躺在 mailbox.pending 里——
      // currentEpisodeInjected 都完整记录了原始文本,是唯一权威来源;先 drainPending()
      // 清空 mailbox 里可能残留的"尚未被消费"那一段(它是 currentEpisodeInjected 的后缀,
      // 不清空会和下面的整体重投重复),再按到达顺序整体重投,保证至少一次投递、不丢失、不重复。
      this.mailbox.drainPending()
      for (const t of carriedTexts) this.mailbox.push(t)
      if (eventText !== undefined) this.mailbox.push(eventText)
      for (const t of this.currentEpisodeInjected ?? []) this.mailbox.push(t)
    }

    const result: EpisodeResult = {
      episodeId,
      outcome: attempt.result.outcome,
      turns: totalTurnsUsed,
      consumedEvents,
      repliedToHuman,
    }
    this.deps.onEpisodeEnd?.(result)
    return result
  }

  /** 按 decision 折叠并立即落盘(唤醒边界折叠 / 强制 force_hot 折叠共用同一落盘逻辑)。
   *  adapter/model 由调用方(runEpisodeBody)按本次 episode 的快照传入,不在此处重新解析。 */
  private async applyFold(
    state: ManagerSessionState,
    decision: Extract<CompactionDecision, { kind: 'fold_at_wake' | 'force_hot' }>,
    adapter: LLMAdapter,
    model: string,
  ): Promise<ManagerSessionState> {
    const newSummary = await foldIntoSummary({
      adapter,
      model,
      prevSummary: state.rollingSummary,
      foldMessages: decision.foldMessages,
    })
    // 落盘前的最后一道防线:decision.keep 首条按 compaction.ts findSafeSplitIndex 的约定
    // 不应是孤儿 tool_result(其匹配的 tool_use 已被折进 rollingSummary)——一旦真的落盘,
    // 下一个 episode 必然把它原样发给 LLM 触发 API 400,且无自愈路径(见 findSafeSplitIndex
    // 注释)。这里只是复核 decideCompaction 的既有保证,不引入新语义;命中即说明调用方绕过了
    // findSafeSplitIndex 构造了 decision,直接拒绝落盘、把损坏状态挡在这一步,好过让它随
    // runEpisode 外层 catch 重投后在下次唤醒继续复现。
    if (decision.keep.length > 0 && 'toolResults' in decision.keep[0]) {
      throw new Error('[applyFold] decision.keep 首条是孤儿 tool_result,拒绝落盘(见 compaction.ts findSafeSplitIndex)')
    }
    const next: ManagerSessionState = {
      ...state,
      rollingSummary: newSummary,
      recent: decision.keep,
      foldedCount: state.foldedCount + decision.foldMessages.length,
    }
    await this.deps.store.save(next)
    return next
  }

  /** 跑一次 runEngine(可能是首次尝试,也可能是 max_tokens 兜底的重试)。
   *  adapter/model 由调用方(runEpisodeBody)按本次 episode 的快照传入,不在此处重新解析。 */
  private async runAttempt(
    state: ManagerSessionState,
    tailMessages: ReadonlyArray<EngineMessage>,
    adapter: LLMAdapter,
    model: string,
  ): Promise<{ readonly result: EngineResult; readonly hasSummaryMarker: boolean }> {
    const hasSummaryMarker = state.rollingSummary !== undefined
    const initialMessages: EngineMessage[] = hasSummaryMarker
      ? [createUserMessage(SUMMARY_MESSAGE_PREFIX + state.rollingSummary), ...tailMessages]
      : [...tailMessages]

    // 台账渲染依赖 WorkerHarness.listWorkers(异步读盘),但 EngineOptions.systemPrompt
    // 的 Resolvable thunk 必须同步(query-loop 每轮同步调用,见 types.ts Resolvable 注释)。
    // 取舍:episode/attempt 开始前先 await 一次拿起始值;此后每轮 onTurn 完成时
    // fire-and-forget 重新拉取——工具执行/下一轮 LLM 调用之间总有若干次 await,通常足够
    //让新值在下一次 thunk 调用前落地。不保证严格的"这一轮绝对最新",但避免了把台账查询
    // 变成阻塞整条 loop 的等待原语(与 protocol §4.1"loop 内不存在阻塞等待原语"的精神一致)。
    let ledgerRender = await this.fetchLedgerRender()
    const refreshLedgerRender = (): void => {
      void this.fetchLedgerRender()
        .then((r) => { ledgerRender = r })
        .catch(() => { /* 台账查询失败不影响当前 episode,下一轮沿用旧值重试 */ })
    }

    const systemPrompt = (): string => {
      const extra = this.deps.promptInputs()
      return assembleManagerSystemPrompt({
        managerKey: this.deps.key,
        isSystemThread: this.deps.isSystemThread,
        dialogProfile: extra.dialogProfile,
        dynamic: {
          ledgerRender,
          nowIso: this.deps.now().toISOString(),
          pendingNotes: extra.pendingNotes,
        },
      })
    }
    const tools = (): ReadonlyArray<ToolDefinition> => this.deps.toolFace(this.currentWakeEvent ?? undefined)

    const options: EngineOptions = {
      systemPrompt,
      tools,
      model,
      maxTurns: this.deps.maxTurns,
      contextWindowTokens: this.deps.contextWindowTokens,
      disableCompaction: true,
      humanMessageQueue: this.mailbox,
      onTurn: () => refreshLedgerRender(),
    }

    const result = await runEngine({
      prompt: '', // 被忽略:initialMessages 非空时 runEngine 不使用 prompt(见 query-loop.ts)
      adapter,
      options,
      initialMessages,
    })

    return { result, hasSummaryMarker }
  }

  private async fetchLedgerRender(): Promise<string> {
    const workers = await this.deps.harness.listWorkers(this.deps.dialogObjectId())
    return renderLedger(workers)
  }
}

// --- Helpers ---

/**
 * "跟人说话"的工具名集合(`EpisodeResult.repliedToHuman` 的判据)。
 *
 * 三个成员都是 crab-messaging 的**投递类**工具,共同点是"这次调用的直接结果是某个人类
 * 看到一条新消息"——这正是群聊注意力退避要问的问题(`AttentionScheduler.reportResult`)。
 *
 * - `send_message` —— 本会话(以及跨 session)的正常回话,最主要的一条;
 * - `send_private_message` —— 群里被问、转私聊回答是真实模式,只认 `send_message` 会把
 *   它错报成"沉默",退避因此错误地×5;
 * - `send_master_private` —— 系统线程的 reach_master,同样是一句人类会看到的话。
 *
 * **不在集合里的**:`get_history` / `get_message` / `lookup_friend` 等只读工具(没人被打扰)、
 * `spawn_worker` / `send_to_worker` 等编排工具(v3 下 worker 不直接跟人类说话,派活本身
 * 人类看不到)、以及记忆/info 工具。名字用**裸名**,与 manager 工具面一致
 * (`tools/tool-face.ts` 的 messaging 工具不带 `mcp__` 前缀,只有 crab-memory 带)。
 */
export const HUMAN_REPLY_TOOL_NAMES: ReadonlySet<string> = new Set([
  'send_message',
  'send_private_message',
  'send_master_private',
])

/** 扫 `finalMessages` 里的 assistant tool_use 块,判断本 episode 有没有跟人说话。 */
function detectRepliedToHuman(finalMessages: ReadonlyArray<EngineMessage>): boolean {
  for (const msg of finalMessages) {
    if (msg.role !== 'assistant') continue
    for (const block of msg.content) {
      if (block.type === 'tool_use' && HUMAN_REPLY_TOOL_NAMES.has(block.name)) return true
    }
  }
  return false
}

function toText(content: QueueContent): string {
  // mailbox 唯一的写入方是 enqueueDuringEpisode(总是 push 字符串),这里的分支只是
  // 类型层面的防御——QueueContent 的联合类型允许 ContentBlock[],实际不会走到这条分支。
  return typeof content === 'string' ? content : '[附件内容,唤醒边界渲染不支持结构化内容,已降级为占位文本]'
}

function renderLedger(workers: ReadonlyArray<LedgerWorker>): string {
  if (workers.length === 0) return '(当前无 worker)'
  return workers
    .map((w) => `- ${w.worker_id} | ${w.task.title} | ${w.task.status} | 化身数=${w.incarnations.length}`)
    .join('\n')
}

/** 消息渲染的两个外部输入(时区 + 时钟),由 `ManagerLoop.renderEvent` 按 deps 解析后传入。 */
interface MessageRenderOpts {
  readonly timezone: string
  readonly now: Date
}

function renderWakeEvent(event: WakeEvent, opts: MessageRenderOpts): string {
  switch (event.kind) {
    case 'human_messages':
      return renderChannelMessages('[人类消息]', event.messages, event.friend, opts)
    case 'attention_flush':
      return renderChannelMessages('[补齐:群聊注意力放行期间累积的人类消息]', event.messages, event.friend, opts)
    case 'worker_event':
      return renderWorkerEvent(event.event)
    case 'schedule':
      return `[定时任务触发] scheduleId=${event.scheduleId}\n标题:${event.title}\n描述:${event.description}`
  }
}

/**
 * 人类消息渲染(P7 J Task 4)。
 *
 * 早先这里只出 `- 名: 文本`,丢掉了 `platform_message_id`、`platform_timestamp`、
 * `is_mention_crab`、`mentions`、`reply_to/quote/thread`、媒体与发送者身份——manager 因此
 * 在群里分不清 @ 的是不是自己、不知道某条在回谁、看不到图片/文件、也拿不到能喂给
 * `get_message` 的 id。J 放弃了引用原文的入站预取(8 件事第 6 条),代价必须由渲染保真度补上:
 * **manager 看到 `reply_to="…"` 才知道自己该不该去拉那条原文**。
 *
 * **复用 `prompt-manager.formatChannelMessageLine`,不另写一版**:它已经把
 * "ChannelMessage 的全部结构化字段按存在性输出成 XML 属性"这件事做完了(含闭合标签转义、
 * 超长截断、媒体/system_event 渲染),worker 与 dispatcher 用的都是它。manager 的上下文虽然是
 * `EngineMessage[]` 而不是 worker 那种整块 XML prompt,但**这里要渲染的是同一种东西**——
 * 一条 ChannelMessage 的完整结构;差别只在"渲染结果放进哪个信封"(这里是一条 user message
 * 的正文)。另写一版必然漂移(本项目已经因为重造既有实现栽过)。
 *
 * `quotedMessages` 刻意不传:入站不预取引用原文,渲染只出 `reply_to` / `quote` 属性,
 * manager 需要时自己调白名单里的 `get_message`(pull 型兜底,与 `get_history` 同款)。
 *
 * `friend` 是本批的发言者,只用于 `resolveSenderIdentity` 判 master/friend/stranger;
 * 群里别人发的消息判不出来就是 `stranger`,与 dispatcher 侧 `buildUserPrompt` 同一套取舍。
 */
function renderChannelMessages(
  label: string,
  messages: ReadonlyArray<ChannelMessage>,
  friend: Friend | undefined,
  opts: MessageRenderOpts,
): string {
  if (messages.length === 0) return `${label}(空)`
  const lines = messages.map((m) =>
    formatChannelMessageLine(m, {
      timezone: opts.timezone,
      now: opts.now,
      identity: resolveSenderIdentity({ msg: m, ...(friend ? { senderFriend: friend } : {}) }),
    }),
  )
  return `${label}\n${lines.join('\n')}`
}

function renderWorkerEvent(e: HarnessEvent): string {
  const detail = e.detail ? ` detail=${JSON.stringify(e.detail)}` : ''
  return `[worker 事件] worker_id=${e.worker_id} seq=${e.seq} kind=${e.kind}${detail}`
}

/**
 * 强制 force_hot 折叠:复用 decideCompaction 的切分规则(不重复实现 slicing 逻辑),
 * 通过覆盖 policy/state 让它无视 TTL 与阈值、只要历史够长(>= keepRecent)就必然判定
 * force_hot——lastActiveAt 钉在 nowMs 上保证 isCold=false(不会误走 fold_at_wake 分支),
 * hardCapTokens 覆盖为 0 保证任何非空历史都判定"超过硬上限"。
 * 历史不足 keepRecent 条时原样返回 'none'(没有可折叠的东西,调用方需自行处理)。
 */
function forceHotFold(
  state: ManagerSessionState,
  policy: CompactionPolicy,
  estimateTokens: (msgs: ReadonlyArray<EngineMessage>) => number,
  nowMs: number,
): CompactionDecision {
  return decideCompaction({
    state: { ...state, lastActiveAt: new Date(nowMs).toISOString() },
    nowMs,
    policy: { ...policy, hardCapTokens: 0 },
    estimateTokens,
  })
}

/**
 * 识别"episode 因上下文超限收场"这一真实表征(读 query-loop.ts 确认,不是猜测):
 *
 * 1. disableCompaction=true 时,engine 遇到静默 max_tokens(text='' 且 stop_reason=
 *    'max_tokens')不会走强压重试,而是直接 finishTask() 收场——outcome 变成
 *    'completed'(不是 'failed'/'max_tokens'!),finalText=''，唯一留下的痕迹是
 *    finalMessages 最后一条 assistant 消息的 stopReason==='max_tokens'。这是结构化信号,
 *    比在 EngineResult.error 里找文案更可靠(这条路径下 error 根本不会被设置)。
 *    "静默"这个前提本身必须校验,不能只看 stopReason:LLM 输出被 max output tokens
 *    截断(有实际文字,只是没写完)时 stopReason 同样是 'max_tokens',但 query-loop.ts
 *    的 isSilentText(见 partitionResponseContent + `isSilentText = processed.text.trim()
 *    .length === 0`,query-loop.ts:614)判它为非静默,直接走"有文字的 end_turn"分支正常
 *    completed 收场——与上下文超限无关。这里必须对齐同一判定,只统计末条 assistant 消息里
 *    的 text 块(忽略 tool_use/raw_reasoning,与 partitionResponseContent 一致),trim 后
 *    为空才算静默。否则会把"回复被截断但已完成"误判为"超限",对已经跑完的 episode 强制
 *    折叠重试一遍——重复触发首次尝试里已执行的副作用(如 send_message 已发送、
 *    spawn_worker 已拉起 worker)。
 * 2. adapter.stream 真的抛出"上下文/超限"相关错误时(如 provider 直接拒绝过长请求),
 *    走的是 query-loop 顶层 try/catch → outcome='failed'、error=formatError(err)——
 *    这种情形只能靠错误文案关键字识别,兜底覆盖 max_tokens/context/token limit 等常见表述。
 */
function isContextOverflow(result: EngineResult): boolean {
  const last = result.finalMessages[result.finalMessages.length - 1]
  if (last?.role === 'assistant' && last.stopReason === 'max_tokens') {
    const text = last.content
      .filter((b): b is TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('')
    if (text.trim().length === 0) {
      return true
    }
  }
  if (result.outcome === 'failed' && result.error && /max_tokens|context[^a-z]{0,10}(length|window)|token[^a-z]{0,10}limit|too (long|large)/i.test(result.error)) {
    return true
  }
  return false
}
