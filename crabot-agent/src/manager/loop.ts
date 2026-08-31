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
 * LLM 重试耗尽 → 放弃 episode:未提交的人类输入和非人类邮箱事件不消费(`consumedEvents: false`),
 * 下次唤醒重投(至少一次投递);已提交人类输入留在会话历史，已经落盘的东西(如折叠产生的新摘要)
 * 也不回滚。
 *
 * ## 摘要块在 initialMessages 里的表达形式
 *
 * EngineMessage 没有 system 角色,滚动摘要因此借道一条打了明确标记的 user message
 * (`SUMMARY_MESSAGE_PREFIX`)置于 initialMessages 最前——protocol §4.2"滚动摘要块"在上下文
 * 里排第二位(仅次于静态身份段,后者由 system prompt 承载),这里摘要与"最近 K 条原始消息"
 * 都放进 messages 数组,不进 system prompt(与 compaction.ts/prompt.ts 的既定分工一致)。
 */

import { randomUUID } from 'crypto'
import type { ManagerEpisodeTrigger, ManagerTraceWriter } from './trace-types.js'
import {
  runEngine,
  createUserMessage,
  type EngineMessage,
  type EngineResult,
  type EngineOptions,
  type ToolDefinition,
  type LLMAdapter,
  type TextBlock,
  type ContentBlock,
} from '../engine/index.js'
import type { HumanMessageQueueLike } from '../engine/types.js'
import { AsyncMutex } from '../workers/async-mutex'
import { formatChannelMessageLine } from '../prompt-manager.js'
import { resolveSenderIdentity } from '../utils/sender-identity.js'
import { decideCompaction, foldIntoSummary, managerPolicyForWindow, type CompactionPolicy, type CompactionDecision } from './compaction.js'
import { collectInboundImages, injectInboundImages, pruneImageRefs, readImageFileSync, toImageBlock, type ManagerImageRef } from './image-vision.js'
import { fetchRemoteImage } from '../agent/media-resolver.js'
import type { ImageBlock } from '../engine/index.js'
import { assembleManagerSystemPrompt } from './prompt.js'
import { summarizeSpanInput, summarizeSpanOutput } from './span-summary.js'
import type { ManagerSessionStore } from './session-store.js'
import type { ManagerSessionState, ManagerKey } from './types.js'
import type { WorkerHarness } from '../workers/harness/harness'
import type { ActivityContextAdmissionReceipt, HarnessEvent } from '../workers/harness/worker-events'
import type { ChannelMessage, Friend, ResolvedPermissions } from '../types'

const ASSISTANT_TEXT_END_TURN_REMINDER = '[系统提醒] 你刚才直接输出了一段文字、没有调用 send_message，然后结束了回复。\n'
  + '请注意：直接输出的文字只留在系统内部，人类看不到；只有 send_message 发送的内容才能送达人类。\n'
  + '请据此判断刚才那段文字：\n'
  + '- 如果它是希望让人类看到的新内容，且与你已经发送的内容不重复 → 调用 send_message 发送一次，然后直接结束，不要再输出任何文字；\n'
  + '- 如果它只是内部总结，或与你已经发送的内容重复 → 不需要任何操作，直接结束即可，不要重复发送。'

const DAILY_REFLECTION_ASSISTANT_TEXT_END_TURN_REMINDER = '[系统提醒] 你刚才直接输出了一段文字、没有调用 send_daily_reflection_summary，然后结束了回复。\n'
  + '请注意：直接输出的文字只留在系统内部，人类看不到；每日反思只有 send_daily_reflection_summary 能把必要摘要送到 Admin Web 系统任务线程。\n'
  + '请据此判断刚才那段文字：\n'
  + '- 如果它是需要让人类看到的新摘要，且与你已经发送的内容不重复 → 调用 send_daily_reflection_summary 发送一次，然后直接结束，不要再输出任何文字；\n'
  + '- 如果它只是内部总结，或与你已经发送的内容重复 → 不需要任何操作，直接结束即可，不要重复发送。'
const POST_SEND_ACTION_RECHECK_PROMPT = '[系统复核] 你刚才发出的消息标记为“随后新建 Worker”，但系统尚未观察到成功的 spawn_worker。\n'
  + '请根据真实意图重新确认：若仍需新建 Worker，现在调用 spawn_worker；若刚才只是讨论、无需派发，或字段误填，直接结束即可。\n'
  + '不要因为这条系统提示重复向人类发送消息，也不要向人类提及系统复核。'

/** 插话远程图预取超时:enqueue 与 drain 之间隔着工具执行,后台预取不阻塞任何人。 */
const REMOTE_IMAGE_PREFETCH_TIMEOUT_MS = 8_000

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
  | { readonly kind: 'media_notification'; readonly text: string }
  | {
      readonly kind: 'schedule'
      readonly scheduleId: string
      readonly title: string
      readonly description: string
      /**
       * Schedule task subtype. It controls the per-episode tool face but never enters
       * the rendered schedule prompt.
       */
      readonly taskType?: string
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
       * ——权限档位 / 记忆 scopes 全部退回未解析那一档。
       */
      readonly friend?: Friend
      /** 与 `human_messages` 的同名字段逐字同义(见上)。 */
      readonly principalPermissions?: ResolvedPermissions
    }

/**
 * P6-A §3.2：不渲染到 LLM 正文的 system-only 关联元数据。
 * Admin Chat 入站的 request IDs 只经这个通道进 Manager——不进 ChannelMessage 正文、
 * 不进工具 schema、不伪造 Friend 字段。
 */
export interface ManagerWakeCorrelation {
  readonly admin_chat_request_ids?: ReadonlyArray<string>
}

export interface TimedWakeEnvelope {
  readonly wake: WakeEvent
  readonly received_at: string
  readonly timezone: string
  readonly occurred_at?: string
  readonly human_occurred_at?: ReadonlyArray<{ readonly message_id?: string; readonly occurred_at?: string }>
  readonly correlation?: ManagerWakeCorrelation
  /** Process-local activity delivery receipt; never rendered or persisted. */
  readonly activity_context_receipt?: ActivityContextAdmissionReceipt
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
  /** Successful `send_message` deliveries, paired with their tool results by tool_use_id. */
  readonly successfulSendMessageTargets: ReadonlyArray<{ readonly channel_id: string; readonly session_id: string }>
}

export interface ManagerLoopDeps {
  readonly key: ManagerKey
  readonly isSystemThread: boolean
  /** 台账渲染用(harness.listWorkers 的入参)。manager 会话粒度(ManagerKey)与台账聚合粒度
   *  (ManagerKey)不同——由调用方按 protocol §3 解析好传入,本模块不做这层映射。
   *
   *  **thunk 而非定值**(P7 J):私聊的归档键要等第一条人类消息带来 friend 之后才能收敛成
   *  `friend:<id>`,而 loop 实例可能先由 worker 事件建出来。定值会把那一刻的 group 形状
   *  永久钉死在实例上,同一个人的台账因此裂成两份。 */
  readonly managerKey: () => ManagerKey
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
  /**
   * 运行时配置已原子替换后的通知源与代数 getter(spec 2026-08-30-llm-retry-config-hotreload):
   * runAttempt 用前者构造 configChangedSignal——LLM 重试 sleep 期间配置落地时提前唤醒,
   * onConfigChanged 现解析 adapter/model 后下一次 attempt 换新配置重试;后者作为
   * configGeneration 探针传给 engine,消费「sleep 窗口之外落地的变更」。
   */
  readonly onRuntimeConfigApplied?: (listener: () => void) => () => void
  readonly runtimeConfigAppliedGeneration?: () => number
  readonly maxTurns?: number
  /** manager 模型的上下文窗口(thunk,episode 内与 adapter/model 同点解析);undefined = engine 默认 200K */
  readonly contextWindowTokens?: () => number | undefined
  /** manager 的槽位思考强度(thunk,episode 内与 adapter/model 同点解析);undefined = 跟随默认 */
  readonly thinking?: () => import('../engine/llm-adapter-types.js').LLMThinkingConfig | undefined
  /** manager 模型的视觉能力(thunk,episode 内与 adapter/model 同点解析);false/undefined = 不注入入站图片 */
  readonly supportsVision?: () => boolean | undefined
  /**
   * 工具面提供者(thunk):每轮重算,由调用方决定要不要按最新状态重建。
   *
   * P5 Task 4 additive:入参是**本 episode 的唤醒事件**,让调用方能按"这次是被什么唤醒的"
   * 装配工具面(当前唯一用途:scheduled 触发的权限身份 → `spawn_worker` 的
   * `origin.creator_friend_id`)。可选参数,既有调用方 `() => [...]` 无需改动。
   */
  readonly toolFace: (wakeEvent?: WakeEvent) => ReadonlyArray<ToolDefinition>
  /** System prompt inputs are stable for the whole dialogProfile revision. */
  readonly promptInputs: () => { readonly dialogProfile?: string; readonly isGroup?: boolean }
  readonly harness: WorkerHarness
  readonly now: () => Date
  /**
   * 人类消息渲染用的时区(`formatChannelMessageLine` 的 `ts` 属性)。thunk 而非定值:
   * 与 adapter/model 同理,admin 改了实例时区不必销毁重建 loop。
   * 不注入则退回 `resolveTimezone(undefined)`(env `CRABOT_DEFAULT_TIMEZONE` → Asia/Shanghai)。
   */
  readonly timezone?: () => string
  readonly onEpisodeEnd?: (result: EpisodeResult) => void
  /**
   * Manager episode trace writer（P6-A §6）：窄接口，episode 边界调用。
   * root trace 持久化是 episode admission——startEpisode 抛错时本 loop 不得调用
   * LLM/tool，原 wake 保持未结算。缺省时整个 trace 面静默关闭（测试/降级）。
   */
  readonly traceWriter?: ManagerTraceWriter
  /**
   * P6-A §3.2：episode 被消费或已提交来源被识别为重复时，回调仍未 claim 的 Admin Chat
   * request IDs。F3 沉默与重复来源都是合法终态，不结算会让 wake 在每次重启无限重放；
   * 已 claim 的 ID 由 delivery confirm 路径结算，不在此列。
   */
  readonly onAdminChatWakeConsumed?: (requestIds: string[]) => void
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
  private readonly mailbox = new TimedWakeMailbox()
  /**
   * 本 episode 进行中经 `enqueueDuringEpisode` 推进 mailbox 的原始 envelope（按到达顺序）。
   * episode 失败时，即使其中一部分已被 engine `drainPending()` 消费进失败的
   * `finalMessages`，也必须靠这份记录重投。episode 成功时整份丢弃，避免重复投递。
   */
  private currentEpisodeInjected: TimedWakeEnvelope[] | null = null
  /**
   * 注入方委托的结算钩子(PR #131 review):mid-episode 注入的人类消息(如群聊
   * attention flush)其调用方关心的处理结果由被注入 episode 的真实收尾回答——
   * episode 收尾时以真实 result 逐个调用并清空。runEpisode 进入时重置。
   */
  private currentEpisodeSettleHooks: Array<(result: EpisodeResult) => void> = []
  /**
   * 待提交的注入人类消息(PR #131 四审):注入路径不做 store RMW(与在跑 episode 的
   * 收尾 save 并发会互相覆盖),只登记到这里;episode 收尾临界区(mutex 内)统一
   * commitHumanInputs 落盘。runEpisode 进入时清空。
   */
  private pendingHumanCommit: Array<{
    envelope: TimedWakeEnvelope
    onHumanInputCommitted?: (lastCommittedMessageId: string) => Promise<void>
  }> = []
  /**
   * 本 episode 已提交人类消息 id 的内存镜像(runEpisode 开头 commit 后置位):注入
   * 投影的同步判定依据。与 store 的偏差方向安全——镜像缺失的 id 在收尾提交时仍被
   * store 层去重兜底。
   */
  private knownCommittedHumanIds: Set<string> = new Set()
  /**
   * P5 Task 4 additive:本 episode 的 primary 唤醒事件,供非 daily reflection 的
   * `deps.toolFace(wakeEvent)` 按"这次是被什么唤醒的"装配工具面。与 `currentEpisodeInjected`
   * 同一套生命周期纪律(runEpisode 进入时置、finally 清),因此天然是**每 episode 精确**的
   * ——同一 loop 的 episode 由 `wakeUp` 的 mutex 串行,不会有两个 episode 的唤醒事件交叠;
   * 这正是不把它做成 registry 侧 `Map<ManagerKey, …>` 的原因(那样并发唤醒会串身份)。
  */
  private currentWakeEvent: TimedWakeEnvelope | null = null
  /** daily reflection 可能在 failed episode 后作为 carried wake 与新 primary 一同消费。 */
  private currentEpisodeEnvelopes: ReadonlyArray<TimedWakeEnvelope> = []
  private readonly admittedActivityReceipts = new Set<string>()
  private readonly rejectedActivityReceipts = new Set<string>()
  /**
   * 当前 episode 的 trace id（root 持久化成功后才有值）。worker-tools 经 registry 桥读它
   * 填 `origin.spawned_by_episode`，spawn 成功后经 `recordSpawnedWorker` 回写 trace。
   * 与 `currentWakeEvent` 同一生命周期纪律：runEpisode 进入时置、finally 清；同 loop 的
   * episode 由 mutex 串行，不存在交叠。
   */
  private currentTraceId: string | undefined = undefined
  /** 当前 episode 的一次性发送后动作复核状态；不进入 session/ledger。 */
  private needsSpawnRecheck = false
  private spawnRecheckInjected = false
  private spawnRecheckOutcomeRecorded = false
  private postSendRecheckSequence = 0

  /** Delivery/continuation evidence belongs to one Manager episode and is never inferred from history. */
  private readonly successfulSendMessageTargetsInCurrentEpisode = new Set<string>()
  private readonly continuedWorkersInCurrentEpisode = new Set<string>()

  /** 当前 episode 的 trace id（仅 episode 进行中）；registry 桥/worker-tools 读取用。 */
  get currentEpisodeTraceId(): string | undefined {
    return this.currentTraceId
  }

  hasSuccessfulSendMessageTo(target: { channel_id: string; session_id: string }): boolean {
    return this.successfulSendMessageTargetsInCurrentEpisode.has(`${target.channel_id}\u0000${target.session_id}`)
  }

  recordSuccessfulSendMessage(target: { channel_id: string; session_id: string }): void {
    if (this.currentTraceId !== undefined) {
      this.successfulSendMessageTargetsInCurrentEpisode.add(`${target.channel_id}\u0000${target.session_id}`)
    }
  }

  hasContinuedWorker(workerId: string): boolean {
    return this.continuedWorkersInCurrentEpisode.has(workerId)
  }

  recordWorkerContinuation(workerId: string): void {
    if (this.currentTraceId !== undefined) this.continuedWorkersInCurrentEpisode.add(workerId)
  }

  /**
   * P6-A §11.4/6：本 episode 关联的 Admin Chat request IDs 及其 claim 状态。
   * 初始 wake、carried mailbox、mid-episode injection 的 correlation 合并去重；
   * 只有目标 exact admin-web::admin-chat 的 eligible send 才原子 claim 未 claim 的 ID，
   * 每个 ID 最多进入一个 logical delivery。
   */
  private adminChatClaims: Map<string, 'unclaimed' | 'claimed'> = new Map()

  /** 本 episode 的 token 用量累加器（onTurn 回调写入，finish 时聚合成 total_usage）。 */
  private currentUsage = { input_tokens: 0, output_tokens: 0, cache_creation_tokens: 0, cache_read_tokens: 0 }
  /** max_tokens 兜底重试与新 episode 的 span 计数区分（engine turnNumber 在重试时会重数）。 */
  private attemptCounter = 0

  /** spawn_worker 成功回调（registry 桥经 worker-tools 调）：把 worker ID 追加进当前 trace。 */
  recordSpawnedWorker(workerId: string): void {
    if (this.currentTraceId) this.deps.traceWriter?.addSpawnedWorker(this.currentTraceId, workerId)
    if (!this.needsSpawnRecheck) return
    this.needsSpawnRecheck = false
    this.spawnRecheckInjected = false
    this.recordPostSendDecision('cleared')
  }

  /** Manager 人类投递成功且声明随后派发 Worker 时，由 tool-face 调用。 */
  recordPostSendAction(): void {
    this.needsSpawnRecheck = true
    this.spawnRecheckInjected = false
    this.spawnRecheckOutcomeRecorded = false
    this.recordPostSendDecision('marked')
  }

  /**
   * P6-A §11.6：原子 claim 本 episode 尚未 claim 的 Admin Chat request IDs。
   * 每个 ID 最多进入一个 logical delivery；全部被 claim 过后返回空（后续 send 即
   * 追加/proactive，不再携带 IDs）。
   */
  claimAdminChatRequestIds(): string[] {
    const claimed: string[] = []
    for (const [id, state] of this.adminChatClaims) {
      if (state === 'unclaimed') {
        this.adminChatClaims.set(id, 'claimed')
        claimed.push(id)
      }
    }
    return claimed
  }

  /**
   * prepare 失败（staging/落盘抛错）时归还 claim：这些 ID 没有任何 delivery record，
   * 不归还会让 manager 的重发拿到空 claim、回复退化成 proactive、人类消息得不到回复。
   */
  unclaimAdminChatRequestIds(ids: ReadonlyArray<string>): void {
    for (const id of ids) {
      if (this.adminChatClaims.get(id) === 'claimed') this.adminChatClaims.set(id, 'unclaimed')
    }
  }

  constructor(deps: ManagerLoopDeps) {
    this.deps = deps
  }

  /** 唯一入口:被唤醒 → 跑一个 episode → 回睡。同一 loop 串行,不同 loop 互不影响。 */
  async wakeUp(
    envelope: TimedWakeEnvelope,
    onHumanInputCommitted?: (lastCommittedMessageId: string) => Promise<void>,
  ): Promise<EpisodeResult> {
    assertTimedWakeEnvelope(envelope)
    return this.mutex.run(() => this.runEpisode(envelope, onHumanInputCommitted))
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
   * ① episode 收口后判断要不要自唤醒;② `evictIdle` 判断该实例能不能回收。这里仅保存非人类
   * 事件或尚未提交的人类输入；已提交人类输入已在 state，不能再依赖 mailbox。
   */
  get hasPendingMailbox(): boolean {
    return this.mailbox.hasPending
  }

  /** A failed final episode returns late activity receipts to their durable Harness producer. */
  rejectPendingActivityMailbox(): void {
    const pending = this.mailbox.takePendingActivityEnvelopes()
    if (pending.length === 0) return
    void this.rejectPendingActivityEnvelopes(pending).catch((error) => {
      console.warn('[ManagerLoop] pending activity mailbox rejection failed:', error)
    })
  }

  /** episode 进行中到达的新事件:渲染成文本推进内部邮箱,由 engine 的 humanMessageQueue
   *  在 turn 间隙注入;episode 不在跑时同样入队,行为见 `mailbox` 字段注释。
   *
   *  人类消息默认拒绝:必须先经 commitHumanInputs 写入会话历史(协议 §4.1「人类入站
   *  提交」)才可注入,否则 failed/aborted 后会把 LLM 已见过的输入当新 wake 重放。
   *  唯一合法入口是 `enqueueHumanWakeDuringActiveEpisode`(先提交、再带
   *  `humanWakePreCommitted` 放行)。 */
  enqueueDuringEpisode(envelope: TimedWakeEnvelope, opts?: { humanWakePreCommitted?: boolean }): void {
    assertTimedWakeEnvelope(envelope)
    if (isHumanWake(envelope.wake) && !opts?.humanWakePreCommitted) {
      throw new Error('human messages must be committed through wakeUp, not queued during an episode')
    }
    this.mailbox.push(envelope)
    this.currentEpisodeInjected?.push(envelope)
    for (const id of envelope.correlation?.admin_chat_request_ids ?? []) {
      if (!this.adminChatClaims.has(id)) this.adminChatClaims.set(id, 'unclaimed')
    }
  }

  /**
   * episode 运行中到达的人类消息(P7 cutover 遗留接线,2026-08-29 补):**同步**入
   * mailbox 走 turn 边界注入(check 与 push 之间无 await,与 routeWorkerEvent 同构
   * 原子);store 提交延后到本 episode 收尾临界区(mutex 内,见 commitPendingHumanInputs)
   * ——绝不在 mutex 外对 session state 做第二个 RMW(PR #131 四审真实风险:与收尾
   * save 并发互相覆盖)。
   *
   * - 投影按 knownCommittedHumanIds 内存镜像同步计算:整批已提交(重放/渠道重发)→
   *   只登记 admin chat claims 后返回,不进 LLM(协议 §4.1 重复来源守卫,与 idle
   *   空转守卫同语义);部分重叠 → 只注入新消息投影。
   * - 崩溃窗口如实说明:提交延后意味着「注入后、收尾前」进程崩溃时该消息丢失——
   *   与修复前消息在 lane 内存队列等 mutex 的崩溃窗口同级,不劣于现状。
   */
  enqueueHumanWakeDuringActiveEpisode(
    envelope: TimedWakeEnvelope,
    onHumanInputCommitted?: (lastCommittedMessageId: string) => Promise<void>,
    onEpisodeSettled?: (result: EpisodeResult) => void,
  ): void {
    assertTimedWakeEnvelope(envelope)
    const newEntries = isHumanWake(envelope.wake)
      ? envelope.wake.messages
          .map((message, index) => ({ message, index }))
          .filter(({ message }) => !this.knownCommittedHumanIds.has(message.platform_message_id))
      : []
    for (const id of envelope.correlation?.admin_chat_request_ids ?? []) {
      if (!this.adminChatClaims.has(id)) this.adminChatClaims.set(id, 'unclaimed')
    }
    if (newEntries.length === 0) return
    for (const { message } of newEntries) this.knownCommittedHumanIds.add(message.platform_message_id)
    const projected = isHumanWake(envelope.wake)
      ? projectHumanEnvelope(envelope, newEntries)
      : envelope
    this.pendingHumanCommit.push({ envelope: projected, onHumanInputCommitted })
    // 远程图预取:fire-and-forget,drain 时消费已就绪结果(见 TimedWakeMailbox.imagePrefetch)
    this.mailbox.prefetchRemoteImages(projected)
    // currentEpisodeInjected 由 enqueueDuringEpisode 内部统一入账,此处不重复 push
    // (五审:重复 push 会让 max_tokens 兜底重试把同一消息渲染两遍)。
    this.enqueueDuringEpisode(projected, { humanWakePreCommitted: true })
    // 结算委托:调用方关心的「这批消息最终有没有被回复」由被注入 episode 的收尾
    // 真实 result 回答(同 episode 收尾 detectRepliedToHuman),不由注入调用编造。
    if (onEpisodeSettled) this.currentEpisodeSettleHooks.push(onEpisodeSettled)
  }

  /**
   * 唤醒事件 → 投喂给 LLM 的文本。渲染是 envelope 的纯函数，不读取当前时钟；
   * mailbox carry、失败重投或 overflow retry 即使重新渲染，也会得到逐字相同的文本。
   */
  private renderEnvelope(envelope: TimedWakeEnvelope): string {
    return renderTimedWakeEnvelope(envelope)
  }

  /** 注入结算钩子的统一出口(PR #131):正常收口 / 失败收口 / throw 三条路径都以各自
   *  的真实 result 调用注册方(见 enqueueHumanWakeDuringActiveEpisode),调用后清空。 */
  private settleInjectedHooks(result: EpisodeResult): void {
    const hooks = this.currentEpisodeSettleHooks
    this.currentEpisodeSettleHooks = []
    for (const hook of hooks) {
      try {
        hook(result)
      } catch (error) {
        console.warn('[ManagerLoop] episode settle hook failed (ignored):', error instanceof Error ? error.message : String(error))
      }
    }
  }

  /** `event === undefined` ⇒ 自唤醒(见 `drainMailbox`):只处理 mailbox 残留,不渲染唤醒事件。 */
  private async runEpisode(
    envelope: TimedWakeEnvelope | undefined,
    onHumanInputCommitted?: (lastCommittedMessageId: string) => Promise<void>,
  ): Promise<EpisodeResult> {
    const episodeId = randomUUID()
    this.mailbox.clearContextAdmissions()
    this.admittedActivityReceipts.clear()
    this.rejectedActivityReceipts.clear()
    const carriedEnvelopes = this.mailbox.drainEnvelopes()
    const episodeEnvelopes = [...carriedEnvelopes, ...(envelope ? [envelope] : [])]
    if (envelope === undefined && carriedEnvelopes.length === 0) {
      // 自唤醒但 mailbox 已空(残留被排在前面的另一个 episode 顺带 drain 走了)——
      // 没有任何新内容,直接空转返回,不开 episode(见 drainMailbox 注释)。
      return {
        episodeId,
        outcome: 'completed',
        turns: 0,
        consumedEvents: true,
        repliedToHuman: false,
        successfulSendMessageTargets: [],
      }
    }
    this.currentEpisodeInjected = []
    this.currentEpisodeSettleHooks = []
    this.pendingHumanCommit = []
    this.knownCommittedHumanIds = new Set()
    this.currentWakeEvent = envelope ?? null
    this.currentEpisodeEnvelopes = episodeEnvelopes
    this.needsSpawnRecheck = false
    this.spawnRecheckInjected = false
    this.spawnRecheckOutcomeRecorded = false
    this.postSendRecheckSequence = 0
    this.adminChatClaims = new Map()
    this.successfulSendMessageTargetsInCurrentEpisode.clear()
    this.continuedWorkersInCurrentEpisode.clear()
    for (const item of episodeEnvelopes) {
      for (const id of item.correlation?.admin_chat_request_ids ?? []) {
        if (!this.adminChatClaims.has(id)) this.adminChatClaims.set(id, 'unclaimed')
      }
    }

    // 人类输入先进入会话历史，才允许 LLM/工具/trace admission 继续。失败重投只适用于
    // 还没完成此提交的输入；提交后的模型或 trace 失败不能把原文当成新 wake 重放。
    let humanInputsCommitted = false
    let state: ManagerSessionState
    let committedHumanMessages = 0
    let traceStarted = false
    try {
      await this.deps.store.ensureSession(this.deps.key)
      const committed = await this.commitHumanInputs(
        await this.deps.store.load(this.deps.key),
        [...carriedEnvelopes, ...(envelope ? [envelope] : [])],
        envelope,
      )
      state = committed.state
      committedHumanMessages = committed.messageCount
      humanInputsCommitted = true
      // 已提交人类消息 id 的内存镜像:mid-episode 注入的投影判定用它(同步、无 store I/O)
      this.knownCommittedHumanIds = new Set(state.committedHumanMessageIds ?? [])
      if (committed.lastCurrentWakeCommittedMessageId) {
        this.notifyHumanInputCommitted(onHumanInputCommitted, committed.lastCurrentWakeCommittedMessageId)
      }

      const carriedTexts = carriedEnvelopes
        .filter((item) => !isHumanWake(item.wake) || isEmptyHumanWake(item.wake))
        .map((item) => this.renderEnvelope(item))
      const eventText = envelope && (!isHumanWake(envelope.wake) || isEmptyHumanWake(envelope.wake))
        ? this.renderEnvelope(envelope)
        : undefined
      if (committedHumanMessages === 0 && carriedTexts.length === 0 && eventText === undefined) {
        await this.settleUnclaimedAdminChatWakes()
        return {
          episodeId,
          outcome: 'completed',
          turns: 0,
          consumedEvents: true,
          repliedToHuman: false,
          successfulSendMessageTargets: [],
        }
      }

      // 人类提交成功后，trace admission 的失败也不得倒回已提交输入。
      this.deps.traceWriter?.startEpisode(
        episodeId,
        this.deps.managerKey(),
        managerTriggerFromWake(envelope ?? carriedEnvelopes[0], carriedEnvelopes.length + (envelope ? 1 : 0)),
      )
      this.currentTraceId = episodeId
      traceStarted = true
      // root agent_loop span 覆盖整个 episode；finishEpisode 会按 episode 状态收口它。
      this.deps.traceWriter?.appendSpan(episodeId, {
        span_id: `root-${episodeId}`,
        type: 'agent_loop',
        started_at: new Date().toISOString(),
        status: 'running',
        details: { merged_envelopes: carriedEnvelopes.length + (envelope ? 1 : 0) },
      })
      const result = await this.runEpisodeBody(
        episodeId,
        state,
        committed.humanMessages,
        carriedTexts,
        eventText,
        carriedEnvelopes,
        envelope,
      )
      // completed/max_turns → completed；failed/aborted → failed（plan §5.5）。
      const failed = result.outcome === 'failed' || result.outcome === 'aborted'
      if (traceStarted) {
        this.deps.traceWriter?.finishEpisode(episodeId, {
          status: failed ? 'failed' : 'completed',
          outcome: {
            summary: `outcome=${result.outcome}; turns=${result.turns}; replied=${result.repliedToHuman ? 'yes' : 'no'}`,
            ...(failed ? { error: `manager episode ${result.outcome}` } : {}),
          },
          ...(this.currentUsage.input_tokens > 0 || this.currentUsage.output_tokens > 0 ? { total_usage: { ...this.currentUsage } } : {}),
        })
      }
      // P6-A §3.2：episode 被消费（含 F3 沉默终态）即结算未 claim 的 request IDs——
      // 否则 wake 永不 settled，每次 Agent 重启都重放历史消息。已 claim 的由 delivery
      // confirm 结算；失败（consumedEvents=false）的整批重投不结算。
      if (result.consumedEvents) await this.settleUnclaimedAdminChatWakes()
      this.settleInjectedHooks(result)
      return result
    } catch (err) {
      // admission 与直接 throw 都在这里收口。人类提交一旦完成，仅重投非人类事件；否则保留
      // 原输入，下一次 wake 再试提交。
      if (traceStarted) {
        this.deps.traceWriter?.finishEpisode(episodeId, {
          status: 'failed',
          outcome: { summary: '[episode threw]', error: err instanceof Error ? err.message : String(err) },
        })
      }
      const injectedEnvelopes = this.currentEpisodeInjected ?? []
      // 注入的人类消息先补提交(PR #131 五审真实风险:catch 分支原来没有这一步,
      // pendingHumanCommit 里的注入既不在 store、又被 settleFailedEpisodeEnvelopes
      // drain+按主 wake 提交状态跳过重投 → 永久丢失)。与放弃分支同语义:throw 已
      // 丢弃 finalMessages 副本,必须以 recent 形式保留。提交失败(往往就是 store
      // 故障与本 err 同源)只记日志、不掩盖原 err;injectedHumansCommitted=false 时
      // settleFailedEpisodeEnvelopes 把注入人类 wake requeue 回 mailbox,自唤醒按
      // 正常路径重新提交,消息仍不丢。
      let injectedHumansCommitted = false
      try {
        await this.commitPendingHumanInputs(false)
        injectedHumansCommitted = true
      } catch (commitErr) {
        console.error('[ManagerLoop] episode throw 后注入人类消息补提交失败:', commitErr)
      }
      await this.settleFailedEpisodeEnvelopes(
        carriedEnvelopes,
        envelope,
        injectedEnvelopes,
        humanInputsCommitted,
        injectedHumansCommitted,
      )
      this.currentEpisodeInjected = null
      this.currentWakeEvent = null
      this.currentEpisodeEnvelopes = []
      this.mailbox.clearContextAdmissions()
      this.admittedActivityReceipts.clear()
      this.rejectedActivityReceipts.clear()
      this.settleInjectedHooks({
        episodeId,
        outcome: 'failed',
        turns: 0,
        consumedEvents: false,
        repliedToHuman: false,
        successfulSendMessageTargets: [],
      })
      throw err
    } finally {
      this.currentEpisodeInjected = null
      this.currentWakeEvent = null
      this.currentEpisodeEnvelopes = []
      this.currentTraceId = undefined
      this.successfulSendMessageTargetsInCurrentEpisode.clear()
      this.continuedWorkersInCurrentEpisode.clear()
      this.needsSpawnRecheck = false
      this.spawnRecheckInjected = false
      this.spawnRecheckOutcomeRecorded = false
      this.postSendRecheckSequence = 0
      this.currentUsage = { input_tokens: 0, output_tokens: 0, cache_creation_tokens: 0, cache_read_tokens: 0 }
      this.attemptCounter = 0
    }
  }

  private async runEpisodeBody(
    episodeId: string,
    initialState: ManagerSessionState,
    committedHumanMessages: ReadonlyArray<EngineMessage>,
    carriedTexts: ReadonlyArray<string>,
    eventText: string | undefined,
    carriedEnvelopes: ReadonlyArray<TimedWakeEnvelope>,
    envelope: TimedWakeEnvelope | undefined,
  ): Promise<EpisodeResult> {
    // §11 热更语义:整个 episode(含下面的 max_tokens 兜底重试)只在这里解析一次 adapter/
    // model,固定用这份快照——即使两次解析之间 admin config 已经变了,当前 episode 也不换。
    const adapter = this.deps.adapter()
    const model = this.deps.model()
    const thinking = this.deps.thinking?.()
    // 上下文窗口与折叠策略同点快照（§11 热更语义：下一 episode 生效）：
    // hardCap 按模型窗口推导（spec 2026-08-29），fold/keepRecent/cacheTtl 保持原策略。
    const contextWindowTokens = this.deps.contextWindowTokens?.()
    const policy = managerPolicyForWindow(this.deps.policy, contextWindowTokens)

    let state = initialState
    let historyState = withoutProtectedTail(state, committedHumanMessages.length)
    const nowMs = this.deps.now().getTime()

    const wakeDecision = decideCompaction({
      state: historyState,
      nowMs,
      policy,
      estimateTokens: this.deps.estimateTokens,
    })
    if (wakeDecision.kind !== 'none') {
      state = await this.applyFoldWithSpan(episodeId, historyState, wakeDecision, adapter, model, committedHumanMessages)
      historyState = withoutProtectedTail(state, committedHumanMessages.length)
    }

    const currentInputEnvelopes = [
      ...carriedEnvelopes.filter((item) => !isHumanWake(item.wake) || isEmptyHumanWake(item.wake)),
      ...(envelope && (!isHumanWake(envelope.wake) || isEmptyHumanWake(envelope.wake)) ? [envelope] : []),
    ]
    const currentTailMessages: EngineMessage[] = [
      ...carriedTexts.map((text) => createUserMessage(text)),
      ...(eventText === undefined ? [] : [createUserMessage(eventText)]),
    ]
    // 入站图片视觉注入:窗口内 human 消息引用的图片读盘转 ImageBlock(VLM 模型才有)。
    // episode 内与 adapter/model 同点解析一次;文件不可读的引用在变换里改写文本标记。
    // 无图可注入时走同步路径——await 会多让出一个 microtask,打乱既有
    // "manager 提交 → LLM ↔ reaction"时序(变异靶锚定,见 process-direct-batch)。
    // 注入只作 LLM 请求投影:originalsById 保留注入前消息,收尾持久化前按 id 还原,
    // 否则 base64 会随 finalMessages 回写进 recent 与 episode log(codex review P1)。
    const supportsVision = this.deps.supportsVision?.() ?? false
    // 插话 drain 注入的开关:episode 内与 adapter/model 同点快照(§11 热更语义)
    this.mailbox.setVisionEnabled(supportsVision)
    const imageRefs = state.imageRefs ?? []
    const injectable = supportsVision && imageRefs.length > 0
    const baseTailMessages: EngineMessage[] = [...state.recent, ...currentTailMessages]
    const injectedTail = injectable
      ? await injectInboundImages(baseTailMessages, { supportsVision, imageRefs })
      : undefined
    const tailMessages: EngineMessage[] = injectedTail?.messages ?? baseTailMessages
    // attempt 可能被 overflow 重试整体替换,重试路径的注入产生自己的 originals——
    // 用 let + 收尾时读当前值。
    let originalsById: ReadonlyMap<string, EngineMessage> = injectedTail?.originals ?? new Map()

    let attempt = await this.runAttempt(episodeId, state, tailMessages, adapter, model, {
      thinking,
      contextWindowTokens,
      contextEnvelopes: currentInputEnvelopes,
    })
    let totalTurnsUsed = attempt.result.totalTurns
    let usedForceHotRetry = false
    // 与 totalTurnsUsed 同一套累加纪律:兜底重试会整体丢弃首次尝试的 finalMessages,但首次
    // 尝试里已经发出去的话人类是真的收到了——只看重试那一份会把"说过话"错报成"没说过"。
    let repliedToHuman = detectRepliedToHuman(attempt.result.finalMessages)
    let successfulSendMessageTargets = successfulSendMessageTargetsOf(
      attempt.result.finalMessages.slice(attempt.initialMessageCount),
    )

    // max_tokens 兜底(§4.2):disableCompaction 关掉了 engine 自己的强压重试路径,
    // 这里识别到"上下文超限收场"时强制 force_hot 折叠一次并重试一次,仍失败就放弃。
    //
    // mid-episode 注入与这条重试路径的交互:
    // 首次尝试期间通过 enqueueDuringEpisode 到达的内容，无论当时是否已被 engine
    // drainPending() 消费，都由 currentEpisodeInjected 以原始 envelope 顺序记录。
    // 首次尝试的 finalMessages 在重试时整体丢弃，因此这些 envelope 必须显式追加。
    // mailbox.pending 里的未消费后缀先清空，避免与显式追加重复。
    // 初始 wake 与 carried envelopes 同样属于本次 protected current tail；force-hot
    // 只折叠 state.recent 中此前历史，不能把本次事件折进 rolling summary。
    if (isContextOverflow(attempt.result)) {
      // Only pre-existing history may be folded. The current initial wake, carried
      // envelopes and mid-episode supplements are a protected tail (§14.4).
      const forceDecision = forceHotFold(historyState, policy, this.deps.estimateTokens, nowMs)
      if (forceDecision.kind !== 'none') {
        usedForceHotRetry = true
        state = await this.applyFoldWithSpan(
          episodeId,
          historyState,
          forceDecision,
          adapter,
          model,
          committedHumanMessages,
        )
        historyState = withoutProtectedTail(state, committedHumanMessages.length)
        // 清空 mailbox 残留后缀(见上方注释),再按 currentEpisodeInjected 的到达顺序整体追加
        this.mailbox.drainEnvelopes()
        this.mailbox.clearContextAdmissions()
        const retryCurrentEnvelopes = currentInputEnvelopes.filter((item) => this.shouldReplayInAttempt(item))
        const retryInjectedEnvelopes = (this.currentEpisodeInjected ?? [])
          .filter((item) => this.shouldReplayInAttempt(item))
        const retryBaseMessages: EngineMessage[] = [
          ...state.recent,
          ...retryCurrentEnvelopes.map((item) => createUserMessage(this.renderEnvelope(item))),
          ...retryInjectedEnvelopes.map((item) => createUserMessage(this.renderEnvelope(item))),
        ]
        // 重试重建了 current/injected 消息(新 id),注入 originals 必须换成这一份
        const retryInjected = injectable
          ? await injectInboundImages(retryBaseMessages, { supportsVision, imageRefs })
          : undefined
        const retryTailMessages: EngineMessage[] = retryInjected?.messages ?? retryBaseMessages
        const retryAttempt = await this.runAttempt(episodeId, state, retryTailMessages, adapter, model, {
          thinking,
          contextWindowTokens,
          contextEnvelopes: [...retryCurrentEnvelopes, ...retryInjectedEnvelopes],
        })
        originalsById = retryInjected?.originals ?? new Map()
        totalTurnsUsed += retryAttempt.result.totalTurns
        repliedToHuman = repliedToHuman || detectRepliedToHuman(retryAttempt.result.finalMessages)
        successfulSendMessageTargets = [
          ...successfulSendMessageTargets,
          ...successfulSendMessageTargetsOf(retryAttempt.result.finalMessages.slice(retryAttempt.initialMessageCount)),
        ]
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

    // end_turn / stop_sequence 会在 runEngine 内经 endTurnGate 得到复核；max_turns 及
    // disableCompaction 下归并的 max_tokens 则会直接返回这里。后者只补一次受原有
    // maxTurns 限制的 continuation，不能用上限绕过复核，也绝不形成循环。
    if (
      this.needsSpawnRecheck
      && !this.spawnRecheckInjected
      && (attempt.result.outcome === 'completed' || attempt.result.outcome === 'max_turns')
    ) {
      this.spawnRecheckInjected = true
      this.recordPostSendDecision('recheck_injected')
      const continuationInitial = [
        ...attempt.result.finalMessages,
        createUserMessage(POST_SEND_ACTION_RECHECK_PROMPT),
      ]
      // 复核 continuation 期间 engine 可能在 turn 间隙 drain 掉注入(含人类消息)。其
      // finalMessages 只在下方接管(attempt = continuation)时保留;失败分支丢弃它们——
      // 被 drain 的注入人类消息若不还原,收尾会按「已被消费」只补去重键,渠道重投被键
      // 挡掉、mailbox 又空(不触发自唤醒)→ 键在文本无 = 静默永久丢失(十审真实风险)。
      // 捕获期间被 drain 的 envelope,失败时把人类消息还原回 mailbox,走收尾既有的
      // 「留 mailbox 交自唤醒」分支(键未记、文本未提交,下个 episode 正常提交+投喂);
      // 非人类事件维持既有行为(其丢失不违反本 PR 的「人类消息不丢」承诺)。
      this.mailbox.startDrainCapture()
      const continuation = await this.runAttempt(
        episodeId,
        state,
        [],
        adapter,
        model,
        { thinking, contextWindowTokens, initialMessages: continuationInitial },
      )
      totalTurnsUsed += continuation.result.totalTurns
      if (continuation.result.outcome === 'completed' || continuation.result.outcome === 'max_turns') {
        repliedToHuman = repliedToHuman || detectRepliedToHuman(continuation.result.finalMessages)
        successfulSendMessageTargets = [
          ...successfulSendMessageTargets,
          ...successfulSendMessageTargetsOf(continuation.result.finalMessages.slice(continuation.initialMessageCount)),
        ]
        attempt = continuation
        // 文本已随接管保留在 finalMessages,丢弃捕获记录即可。
        this.mailbox.takeDrainedForReplay()
      } else {
        // The recheck is advisory. Its own failure must not replay an already
        // consumable episode.
        this.recordPostSendDecision('recheck_failed_open')
        for (const drained of this.mailbox.takeDrainedForReplay()) {
          if (isHumanWake(drained.wake)) this.mailbox.push(drained)
        }
      }
    }

    if (this.needsSpawnRecheck) {
      this.recordPostSendDecision(
        attempt.result.outcome === 'failed' || attempt.result.outcome === 'aborted'
          ? 'unresolved_failed'
          : 'unresolved_accepted',
      )
    }

    // 注入只存在于 LLM 请求投影:持久化(episode log / recent)前把 finalMessages 里被
    // 注入过的 user message 还原为注入前的纯文本——base64 不落盘,文本标记保留原样,
    // 下一 episode 再从 imageRefs 重新注入(幂等)。
    // 两类来源:initialMessages 注入(originalsById 按 id 还原);插话 drain 注入
    // (query-loop createUserMessage 的随机 id 拿不到,按结构还原——数组 content 的
    // user message 取 text block 原文,drain 构造时文本标记原样保留,拍平后与渲染
    // 文本逐字一致)。
    const persistedFinalMessages = attempt.result.finalMessages.map((m) => {
      const original = originalsById.get(m.id)
      if (original) return original
      if (m.role === 'user' && 'content' in m && Array.isArray(m.content)) {
        const first = m.content[0]
        if (first && first.type === 'text') return { ...m, content: first.text }
      }
      return m
    })

    await this.deps.store.appendEpisodeLog(this.deps.key, episodeId, persistedFinalMessages)

    // 只有真正跑完 turn(completed / max_turns)才算"处理过"这批事件;
    // failed / aborted 一律不消费,交回邮箱下次重投。
    const consumedEvents = attempt.result.outcome === 'completed' || attempt.result.outcome === 'max_turns'

    if (consumedEvents) {
      const priorRecent = state.recent
      const newRecent = persistedFinalMessages.slice(attempt.hasSummaryMarker ? 1 : 0)
      // recent 已滚动:修剪不再被引用的图片路径(按新旧 recent 并集判活,supervision 分支
      // 会恢复 priorRecent,误删活引用比多留死条目更糟)。
      const prunedImageRefs = pruneImageRefs(state.imageRefs, [...newRecent, ...priorRecent])
      state = {
        ...state,
        recent: newRecent,
        lastActiveAt: this.deps.now().toISOString(),
        ...(prunedImageRefs !== state.imageRefs ? { imageRefs: prunedImageRefs } : {}),
      }
      await this.deps.store.save(state)
      const localSupervisionSummary = defaultSupervisionHistorySummary({
        envelope,
        carriedEnvelopes,
        injectedEnvelopes: this.currentEpisodeInjected ?? [],
        outcome: attempt.result.outcome,
        usedForceHotRetry,
        priorRecentCount: priorRecent.length,
        hasSummaryMarker: attempt.hasSummaryMarker,
        finalMessages: persistedFinalMessages,
        startedAt: envelope?.received_at,
        endedAt: this.deps.now().toISOString(),
      })
      if (localSupervisionSummary) {
        state = {
          ...state,
          recent: [...priorRecent, createUserMessage(localSupervisionSummary)],
        }
        await this.deps.store.save(state)
      }
      // 注入人类消息的收尾提交(PR #131 四审):必须在 recent 替换与 supervision save
      // 之后——load 拿到的是最新 state,未被 drain 消费的追加不会被后续 save 覆盖。
      await this.commitPendingHumanInputs(true, persistedFinalMessages)
    } else {
      // 放弃 episode:已落盘的折叠不回滚(见文件头)——若本次途中发生过 force_hot 折叠
      // (上面 max_tokens 兜底重试路径),carriedTexts/eventText 有可能已经作为
      // tailMessages 的一部分被折进了 rollingSummary(见 forceHotFold),这里仍会原样
      // 重投它们,导致同一份内容同时以"摘要"与"原始文本"两种形式留存——已知取舍,不在此修复。
      //
      // 把尚未提交的人类输入和非人类输入按原始到达顺序推回邮箱。已提交人类输入已在
      // `state.recent`，不能再以 wake 形式重放。
      // episode 期间经 enqueueDuringEpisode 注入的内容(currentEpisodeInjected,顺序即
      // 到达顺序)。后者无论当时是否已被 engine drainPending() 消费——消费掉的已经进了
      // 随失败一起丢弃的 finalMessages,不消费的还原样躺在 mailbox.pending 里——
      // currentEpisodeInjected 都完整记录了原始文本,是唯一权威来源;先 drainPending()
      // 清空 mailbox 里可能残留的"尚未被消费"那一段(它是 currentEpisodeInjected 的后缀,
      // 不清空会和下面的整体重投重复),再按到达顺序整体重投,保证至少一次投递、不丢失、不重复。
      // 注入的人类消息由 commitPendingHumanInputs 先落 recent(它们随失败一起丢了
      // finalMessages 副本,必须以 recent 形式保留),之后 settle 重投按去重键跳过。
      const injectedEnvelopes = this.currentEpisodeInjected ?? []
      await this.commitPendingHumanInputs(false)
      await this.settleFailedEpisodeEnvelopes(carriedEnvelopes, envelope, injectedEnvelopes, true)
    }

    const result: EpisodeResult = {
      episodeId,
      outcome: attempt.result.outcome,
      turns: totalTurnsUsed,
      consumedEvents,
      repliedToHuman,
      successfulSendMessageTargets,
    }
    this.deps.onEpisodeEnd?.(result)
    return result
  }

  private async commitHumanInputs(
    state: ManagerSessionState,
    envelopes: ReadonlyArray<TimedWakeEnvelope>,
    currentEnvelope: TimedWakeEnvelope | undefined,
  ): Promise<{
    readonly state: ManagerSessionState
    readonly humanMessages: ReadonlyArray<EngineMessage>
    readonly messageCount: number
    readonly lastCurrentWakeCommittedMessageId?: string
  }> {
    const committedIds = new Set(state.committedHumanMessageIds ?? [])
    const committedMessages: EngineMessage[] = []
    const newImageRefs: ManagerImageRef[] = []
    let lastCurrentWakeCommittedMessageId: string | undefined

    for (const envelope of envelopes) {
      if (!isHumanWake(envelope.wake)) continue
      const newEntries = envelope.wake.messages
        .map((message, index) => ({ message, index }))
        .filter(({ message }) => !committedIds.has(message.platform_message_id))
      if (newEntries.length === 0) continue

      for (const { message } of newEntries) committedIds.add(message.platform_message_id)
      const rendered = createUserMessage(this.renderEnvelope(projectHumanEnvelope(envelope, newEntries)))
      committedMessages.push(rendered)
      // 记录本批消息的入站图片引用(轻量引用,见 image-vision.ts 文件头)
      const images = newEntries.flatMap(({ message }) => collectInboundImages(message))
      if (images.length > 0) newImageRefs.push({ message_id: rendered.id, images })
      if (envelope === currentEnvelope) {
        lastCurrentWakeCommittedMessageId = newEntries[newEntries.length - 1].message.platform_message_id
      }
    }

    if (committedMessages.length === 0) {
      return { state, humanMessages: [], messageCount: 0 }
    }

    const next: ManagerSessionState = {
      ...state,
      recent: [...state.recent, ...committedMessages],
      committedHumanMessageIds: Array.from(committedIds),
      ...(newImageRefs.length > 0
        ? { imageRefs: [...(state.imageRefs ?? []), ...newImageRefs] }
        : {}),
    }
    await this.deps.store.save(next)
    return {
      state: next,
      humanMessages: committedMessages,
      messageCount: committedMessages.length,
      lastCurrentWakeCommittedMessageId,
    }
  }

  private notifyHumanInputCommitted(
    callback: ((lastCommittedMessageId: string) => Promise<void>) | undefined,
    lastCommittedMessageId: string,
  ): void {
    if (!callback) return
    try {
      void callback(lastCommittedMessageId).catch((err) => {
        console.warn('[ManagerLoop] human input committed callback failed (ignored):', err instanceof Error ? err.message : String(err))
      })
    } catch (err) {
      console.warn('[ManagerLoop] human input committed callback failed (ignored):', err instanceof Error ? err.message : String(err))
    }
  }

  /**
   * 注入人类消息的收尾提交(PR #131 四审重构):mid-episode 注入路径不做 store RMW
   * (与在跑 episode 的收尾 save 并发会互相覆盖——review 真实风险),消息登记在
   * pendingHumanCommit,由本方法在 episode 收尾临界区(loop mutex 内)统一落盘。
   *
   * @param recentReplaced 本 episode 是否以 finalMessages 替换过 recent(成功收尾)。
   *   按它分派每条注入消息:
   *   - 已被 engine drain 消费(不在 mailbox.pending)且 recentReplaced:文本已随
   *     替换进入历史 → 只补记去重键,不重复追加;
   *   - 未被消费且 recentReplaced(成功收尾):**不提交、不 discard、不记键、不回调**,
   *     envelope 原样留在 mailbox——收尾后 hasPendingMailbox 触发自唤醒(#54),下个
   *     episode 按正常路径提交+投喂,消息立即被处理(PR #131 五审:提交了就没有
   *     任何 episode 去回答它,「先提交再留邮箱」则自唤醒被去重键打成空转);代价是
   *     该消息的 reaction 回调挂起到自唤醒提交时——自唤醒无调用方回调,reaction
   *     实际丢失,与「写入即已接收」自洽(尚未写入,本就不该打);
   *   - recentReplaced=false(failed/aborted/throw,finalMessages 已丢弃):先从
   *     mailbox 移除,再正常提交(recent 追加文本+去重键)——消息必须以 recent
   *     形式保留,fail-loud 由 settle 回调补发。
   * 回调(onHumanInputCommitted)在提交落定后触发。调用方必须在 loop mutex 内。
   */
  private async commitPendingHumanInputs(
    recentReplaced: boolean,
    persistedFinalMessages?: ReadonlyArray<EngineMessage>,
  ): Promise<void> {
    if (this.pendingHumanCommit.length === 0) return
    const pending = this.pendingHumanCommit
    this.pendingHumanCommit = []
    let state = await this.deps.store.load(this.deps.key)
    let dirty = false
    for (const rec of pending) {
      if (recentReplaced && this.mailbox.isPending(rec.envelope)) continue // 留 mailbox 交自唤醒
      const lastMessageId = isHumanWake(rec.envelope.wake)
        ? rec.envelope.wake.messages.at(-1)?.platform_message_id
        : undefined
      if (recentReplaced) {
        // 已被 drain 消费且 recent 已替换:文本已进历史,只补去重键;
        // 带图插话同时补记 imageRefs——drain 消息(query-loop 随机 id)按渲染文本里的
        // platform_message_id 属性定位,图引用补齐后下一 episode 才能重新注入。
        const ids = isHumanWake(rec.envelope.wake)
          ? rec.envelope.wake.messages.map((m) => m.platform_message_id)
          : []
        const merged = new Set([...(state.committedHumanMessageIds ?? []), ...ids])
        const newImageRefs: ManagerImageRef[] = []
        if (persistedFinalMessages && isHumanWake(rec.envelope.wake)) {
          const images = rec.envelope.wake.messages.flatMap((m) => collectInboundImages(m))
          if (images.length > 0) {
            for (const message of rec.envelope.wake.messages) {
              const marker = `id="${message.platform_message_id}"`
              const drainedMessage = persistedFinalMessages.find((m) => {
                if (m.role !== 'user' || !('content' in m) || typeof m.content !== 'string') return false
                return m.content.includes(marker)
              })
              if (drainedMessage) newImageRefs.push({ message_id: drainedMessage.id, images })
            }
          }
        }
        const mergedRefs = newImageRefs.length > 0
          ? [...(state.imageRefs ?? []), ...newImageRefs]
          : state.imageRefs
        state = {
          ...state,
          committedHumanMessageIds: Array.from(merged),
          ...(mergedRefs !== state.imageRefs ? { imageRefs: mergedRefs } : {}),
        }
        dirty = dirty || ids.length > 0 || newImageRefs.length > 0
      } else {
        // 失败收尾(finalMessages 已随失败丢弃,必须以 recent 形式保留;残留 mailbox
        // 的先移除,避免与 settleFailedEpisodeEnvelopes 的 carry 重投重复):正常提交追加。
        this.mailbox.discard(rec.envelope)
        const committed = await this.commitHumanInputs(state, [rec.envelope], rec.envelope)
        if (committed.messageCount > 0) {
          state = committed.state
          dirty = true
        }
      }
      if (lastMessageId) {
        this.notifyHumanInputCommitted(rec.onHumanInputCommitted, lastMessageId)
      }
    }
    if (dirty) await this.deps.store.save(state)
  }

  private requeueUncommittedEnvelopes(
    envelopes: ReadonlyArray<TimedWakeEnvelope>,
    humanInputsCommitted: boolean,
  ): void {
    for (const envelope of envelopes) {
      if (envelope.activity_context_receipt) continue
      if (humanInputsCommitted && isHumanWake(envelope.wake)) continue
      this.mailbox.push(envelope)
    }
  }

  private async settleFailedEpisodeEnvelopes(
    carriedEnvelopes: ReadonlyArray<TimedWakeEnvelope>,
    envelope: TimedWakeEnvelope | undefined,
    injectedEnvelopes: ReadonlyArray<TimedWakeEnvelope>,
    humanInputsCommitted: boolean,
    // 注入的人类 wake 是否已提交(五审):与主 wake 的 humanInputsCommitted 解耦——
    // catch 分支先跑 commitPendingHumanInputs,注入已提交时此处必须为 true(跳过重投),
    // 而主 wake 自身的提交状态不变。缺省跟随 humanInputsCommitted(B 分支调用现状)。
    injectedHumansCommitted: boolean = humanInputsCommitted,
  ): Promise<void> {
    this.mailbox.drainEnvelopes()
    this.mailbox.clearContextAdmissions()
    await this.rejectPendingActivityEnvelopes([
      ...carriedEnvelopes,
      ...(envelope ? [envelope] : []),
      ...injectedEnvelopes,
    ])
    this.requeueUncommittedEnvelopes(carriedEnvelopes, humanInputsCommitted)
    if (envelope) this.requeueUncommittedEnvelopes([envelope], humanInputsCommitted)
    this.requeueUncommittedEnvelopes(injectedEnvelopes, injectedHumansCommitted)
  }

  private admitActivityEnvelopes(envelopes: ReadonlyArray<TimedWakeEnvelope>): void {
    for (const envelope of envelopes) {
      const receipt = envelope.activity_context_receipt
      if (!receipt) continue
      const key = activityReceiptKey(receipt)
      if (this.admittedActivityReceipts.has(key) || this.rejectedActivityReceipts.has(key)) continue
      this.admittedActivityReceipts.add(key)
      const handleFailure = async (error: unknown): Promise<void> => {
        try {
          await receipt.reject()
        } catch (rejectError) {
          console.warn('[ManagerLoop] activity admission rejection failed:', rejectError)
        }
        console.warn('[ManagerLoop] activity admission acknowledgement failed; durable notification will retry:', error)
      }
      try {
        void receipt.admit().catch(handleFailure)
      } catch (error) {
        void handleFailure(error)
      }
    }
  }

  private async rejectPendingActivityEnvelopes(envelopes: ReadonlyArray<TimedWakeEnvelope>): Promise<void> {
    const seen = new Set<string>()
    for (const envelope of envelopes) {
      const receipt = envelope.activity_context_receipt
      if (!receipt) continue
      const key = activityReceiptKey(receipt)
      if (seen.has(key) || this.admittedActivityReceipts.has(key) || this.rejectedActivityReceipts.has(key)) continue
      seen.add(key)
      try {
        await receipt.reject()
      } catch (error) {
        console.warn('[ManagerLoop] activity admission rejection failed:', error)
      }
      this.rejectedActivityReceipts.add(key)
    }
  }

  private shouldReplayInAttempt(envelope: TimedWakeEnvelope): boolean {
    const receipt = envelope.activity_context_receipt
    return !receipt || !this.admittedActivityReceipts.has(activityReceiptKey(receipt))
  }

  private async settleUnclaimedAdminChatWakes(): Promise<void> {
    if (this.adminChatClaims.size === 0) return
    const unsettled = Array.from(this.adminChatClaims.entries())
      .filter(([, state]) => state === 'unclaimed')
      .map(([id]) => id)
    if (unsettled.length === 0) return
    try {
      await this.deps.onAdminChatWakeConsumed?.(unsettled)
    } catch (error) {
      console.warn('[ManagerLoop] admin chat wake settle failed:', error instanceof Error ? error.message : String(error))
    }
  }

  private takeSpawnRecheckPrompt(): string | null {
    if (!this.needsSpawnRecheck || this.spawnRecheckInjected) return null
    this.spawnRecheckInjected = true
    this.recordPostSendDecision('recheck_injected')
    return POST_SEND_ACTION_RECHECK_PROMPT
  }

  private recordPostSendDecision(
    state: 'marked' | 'cleared' | 'recheck_injected' | 'recheck_failed_open' | 'unresolved_accepted' | 'unresolved_failed',
  ): void {
    if (state === 'unresolved_accepted' || state === 'unresolved_failed') {
      if (this.spawnRecheckOutcomeRecorded) return
      this.spawnRecheckOutcomeRecorded = true
    }
    const traceId = this.currentTraceId
    if (!traceId) return
    const now = new Date().toISOString()
    this.deps.traceWriter?.appendSpan(traceId, {
      span_id: `post-send-action-${traceId}-${++this.postSendRecheckSequence}`,
      parent_span_id: `root-${traceId}`,
      type: 'decision',
      started_at: now,
      ended_at: now,
      duration_ms: 0,
      status: state === 'unresolved_failed' || state === 'recheck_failed_open' ? 'failed' : 'completed',
      details: { kind: 'post_send_action', state },
    })
  }

  /** engine onTurn → llm_call/tool_call span（截断摘要由 writer 侧统一脱敏落盘）。 */
  private recordTurnSpans(episodeId: string, event: import('../engine/types.js').EngineTurnEvent): void {
    const writer = this.deps.traceWriter
    if (!writer || this.currentTraceId !== episodeId) return
    const usage = event.usage
    if (usage) {
      this.currentUsage.input_tokens += usage.inputTokens ?? 0
      this.currentUsage.output_tokens += usage.outputTokens ?? 0
      this.currentUsage.cache_creation_tokens += usage.cacheCreationTokens ?? 0
      this.currentUsage.cache_read_tokens += usage.cacheReadTokens ?? 0
    }
    const attemptTag = this.attemptCounter
    const llmSpanId = `llm-${episodeId}-${attemptTag}-${event.turnNumber}`
    const llmStarted = event.llmStartedAtMs !== undefined ? new Date(event.llmStartedAtMs).toISOString() : new Date().toISOString()
    const llmEnded = event.llmStartedAtMs !== undefined && event.llmCallMs !== undefined
      ? new Date(event.llmStartedAtMs + event.llmCallMs).toISOString()
      : undefined
    writer.appendSpan(episodeId, {
      span_id: llmSpanId,
      parent_span_id: `root-${episodeId}`,
      type: 'llm_call',
      started_at: llmStarted,
      ended_at: llmEnded,
      duration_ms: event.llmCallMs,
      status: 'completed',
      details: {
        turn: event.turnNumber,
        stop_reason: event.stopReason,
        ...(usage ? { usage } : {}),
        ...(event.diagnostics ? {
          retries: event.diagnostics.retries,
          first_chunk_ms: event.diagnostics.firstChunkMs,
          chunk_count: event.diagnostics.chunkCount,
        } : {}),
      },
    })
    for (const toolCall of event.toolCalls) {
      const toolStarted = toolCall.startedAtMs !== undefined ? new Date(toolCall.startedAtMs).toISOString() : llmStarted
      writer.appendSpan(episodeId, {
        span_id: `tool-${episodeId}-${attemptTag}-${event.turnNumber}-${toolCall.id}`,
        parent_span_id: llmSpanId,
        type: 'tool_call',
        started_at: toolStarted,
        ended_at: toolCall.startedAtMs !== undefined && toolCall.durationMs !== undefined
          ? new Date(toolCall.startedAtMs + toolCall.durationMs).toISOString()
          : undefined,
        duration_ms: toolCall.durationMs,
        status: toolCall.isError ? 'failed' : 'completed',
        details: {
          name: toolCall.name,
          input_summary: summarizeSpanInput(toolCall.input),
          output_summary: summarizeSpanOutput(toolCall.output),
        },
      })
    }
  }

  /** applyFold + context_assembly span：只记录计数/耗时/结果，不存摘要全文（§6.5）。 */
  private async applyFoldWithSpan(
    episodeId: string,
    state: ManagerSessionState,
    decision: Extract<CompactionDecision, { kind: 'fold_at_wake' | 'force_hot' }>,
    adapter: LLMAdapter,
    model: string,
    protectedTail: ReadonlyArray<EngineMessage> = [],
  ): Promise<ManagerSessionState> {
    const writer = this.deps.traceWriter
    const startedAt = new Date().toISOString()
    try {
      const next = await this.applyFold(state, decision, adapter, model, protectedTail)
      if (writer && this.currentTraceId === episodeId) {
        const endedAt = new Date().toISOString()
        writer.appendSpan(episodeId, {
          span_id: `fold-${episodeId}-${this.attemptCounter}-${decision.kind}`,
          parent_span_id: `root-${episodeId}`,
          type: 'context_assembly',
          started_at: startedAt,
          ended_at: endedAt,
          duration_ms: new Date(endedAt).getTime() - new Date(startedAt).getTime(),
          status: 'completed',
          details: { kind: decision.kind, folded: decision.foldMessages.length, keep: decision.keep.length },
        })
      }
      return next
    } catch (error) {
      if (writer && this.currentTraceId === episodeId) {
        const endedAt = new Date().toISOString()
        writer.appendSpan(episodeId, {
          span_id: `fold-${episodeId}-${this.attemptCounter}-${decision.kind}`,
          parent_span_id: `root-${episodeId}`,
          type: 'context_assembly',
          started_at: startedAt,
          ended_at: endedAt,
          duration_ms: new Date(endedAt).getTime() - new Date(startedAt).getTime(),
          status: 'failed',
          details: { kind: decision.kind, folded: decision.foldMessages.length, keep: decision.keep.length, error: error instanceof Error ? error.message : String(error) },
        })
      }
      throw error
    }
  }

  /** 按 decision 折叠并立即落盘(唤醒边界折叠 / 强制 force_hot 折叠共用同一落盘逻辑)。
   *  adapter/model 由调用方(runEpisodeBody)按本次 episode 的快照传入,不在此处重新解析。 */
  private async applyFold(
    state: ManagerSessionState,
    decision: Extract<CompactionDecision, { kind: 'fold_at_wake' | 'force_hot' }>,
    adapter: LLMAdapter,
    model: string,
    protectedTail: ReadonlyArray<EngineMessage> = [],
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
      recent: [...decision.keep, ...protectedTail],
      foldedCount: state.foldedCount + decision.foldMessages.length,
    }
    await this.deps.store.save(next)
    return next
  }

  /** 跑一次 runEngine(可能是首次尝试,也可能是 max_tokens 兜底的重试)。
   *  adapter/model 由调用方(runEpisodeBody)按本次 episode 的快照传入,不在此处重新解析。 */
  private async runAttempt(
    episodeId: string,
    state: ManagerSessionState,
    tailMessages: ReadonlyArray<EngineMessage>,
    adapter: LLMAdapter,
    model: string,
    overrides?: {
      readonly initialMessages?: ReadonlyArray<EngineMessage>
      readonly contextEnvelopes?: ReadonlyArray<TimedWakeEnvelope>
      /** 本 episode 的槽位思考强度快照（与 adapter/model 同点解析，episode 内固定） */
      readonly thinking?: import('../engine/llm-adapter-types.js').LLMThinkingConfig
      /** 本 episode 的模型上下文窗口快照（同上） */
      readonly contextWindowTokens?: number
    },
  ): Promise<{ readonly result: EngineResult; readonly hasSummaryMarker: boolean; readonly initialMessageCount: number }> {
    this.attemptCounter += 1
    let assistantTextEndTurnReminderSent = false
    const hasSummaryMarker = state.rollingSummary !== undefined
    const initialMessages: EngineMessage[] = overrides?.initialMessages
      ? [...overrides.initialMessages]
      : hasSummaryMarker
        ? [createUserMessage(SUMMARY_MESSAGE_PREFIX + state.rollingSummary), ...tailMessages]
        : [...tailMessages]
    let initialContextEnvelopes = [...(overrides?.contextEnvelopes ?? [])]

    const dailyReflectionWake = this.currentEpisodeEnvelopes.find((item) =>
      isBuiltinDailyReflectionWake(item.wake),
    )?.wake
    const effectiveWake = dailyReflectionWake ?? this.currentWakeEvent?.wake
    const isBuiltinDailyReflection = isBuiltinDailyReflectionWake(effectiveWake)
    const systemPrompt = (): string => {
      const extra = this.deps.promptInputs()
      return assembleManagerSystemPrompt({
        managerKey: this.deps.key,
        isSystemThread: this.deps.isSystemThread,
        isBuiltinDailyReflection,
        isGroup: extra.isGroup ?? false,
        dialogProfile: extra.dialogProfile,
      })
    }
    const tools = (): ReadonlyArray<ToolDefinition> => this.deps.toolFace(effectiveWake)

    // LLM 重试期间配置热切换的订阅（spec 2026-08-30-llm-retry-config-hotreload）：
    // 只覆盖本 attempt 的 runEngine 生命周期，结束时确定性退订，不泄漏监听器。
    const configChanged = new AbortController()
    const offRuntimeConfigApplied = this.deps.onRuntimeConfigApplied?.(() => configChanged.abort())
      ?? (() => undefined)

    const options: EngineOptions = {
      systemPrompt,
      tools,
      model,
      maxTurns: this.deps.maxTurns,
      ...(overrides?.contextWindowTokens !== undefined ? { contextWindowTokens: overrides.contextWindowTokens } : {}),
      ...(overrides?.thinking !== undefined ? { thinking: overrides.thinking } : {}),
      disableCompaction: true,
      humanMessageQueue: this.mailbox,
      onBeforeLlmCall: () => {
        const envelopes = [
          ...initialContextEnvelopes,
          ...this.mailbox.takeContextAdmissionEnvelopes(),
        ]
        initialContextEnvelopes = []
        if (envelopes.some((envelope) => envelope.activity_context_receipt)) {
          this.admitActivityEnvelopes(envelopes)
        }
      },
      // engine 的 forced_summary 兜底(silent end_turn → 注入"你还没向人类发过内容"追问,
      // 最多 3 次)是 v2 worker loop 的机制:那条路径下 caller 用一整套 outbound buffer
      // 跟踪"这轮有没有发过",engine 只是照着它的判定兜底。manager 没有那套跟踪,不传等于
      // 恒等于"没发过"——现网实证:manager 明明已经 send_message 回过话了,收尾时仍被连追
      // 三次,逼出三条重复发言。
      // 更根本的是语义:manager 本来就是"跟人类说话的那位",这一轮该不该说话由它自己判断
      // (纪律写在 manager system prompt 的收尾责任段里),不需要 engine 在运行时替它决定。
      // 静默 end_turn 对 manager 是完全正常的完成态(比如这次唤醒只是派活或只读检查)。
      suppressForcedSummary: () => true,
      assistantTextEndTurnHandler: async () => {
        if (assistantTextEndTurnReminderSent) return { kind: 'complete' as const }
        assistantTextEndTurnReminderSent = true
        return {
          kind: 'inject' as const,
          text: isBuiltinDailyReflection
            ? DAILY_REFLECTION_ASSISTANT_TEXT_END_TURN_REMINDER
            : ASSISTANT_TEXT_END_TURN_REMINDER,
        }
      },
      endTurnGate: async () => this.takeSpawnRecheckPrompt(),
      // P6-A §6.4：onTurn 是事后观察钩子，用它生成 llm_call/tool_call span；
      // 不复制执行语义、不新增第二个 query loop。
      onTurn: (event) => this.recordTurnSpans(episodeId, event),
      // LLM 重试期间配置热切换（spec 2026-08-30-llm-retry-config-hotreload）：
      // onRuntimeConfigApplied 在 agentConfig 原子替换完成后触发 → abort signal →
      // callNonStreaming 的重试 sleep 提前结束；configGeneration 探针由 engine 记账，
      // 消费 sleep 窗口之外落地的变更。onConfigChanged 现解析 powerful slot 后下一
      // 次 attempt 换新 adapter/model。仅覆盖重试阶段，episode 快照语义不变。
      configChangedSignal: configChanged.signal,
      configGeneration: this.deps.runtimeConfigAppliedGeneration,
      onConfigChanged: async () => ({
        adapter: this.deps.adapter(),
        model: this.deps.model(),
        // thinking 是 per-model 字段，随 model 一并替换；manager 不发 max_tokens。
        ...(this.deps.thinking ? { thinking: this.deps.thinking() } : {}),
      }),
    }

    try {
      const result = await runEngine({
        prompt: '', // 被忽略:initialMessages 非空时 runEngine 不使用 prompt(见 query-loop.ts)
        adapter,
        options,
        initialMessages,
      })
      return { result, hasSummaryMarker, initialMessageCount: initialMessages.length }
    } finally {
      offRuntimeConfigApplied()
    }
  }

}

// --- Helpers ---

function activityReceiptKey(receipt: ActivityContextAdmissionReceipt): string {
  return `${receipt.notification_id}\u0000${receipt.activity_through}`
}

function isBuiltinDailyReflectionWake(wake: WakeEvent | undefined): boolean {
  return wake?.kind === 'schedule'
    && wake.isBuiltin === true
    && wake.taskType === 'daily_reflection'
}

/** trigger 摘要截断（span 摘要见 span-summary.ts；完整脱敏由 writer 侧 redactSecrets 负责）。 */
function truncateForTrace(text: string, max = 300): string {
  return text.length > max ? text.slice(0, max) + '…' : text
}

/**
 * 唤醒事件 → trace trigger（脱敏摘要；不复制完整人类正文/terminal output/tool secret）。
 * `mergedCount` 是本次 episode 合并的 envelope 总数（首个/合并 envelope 触发时传入）。
 */
export function managerTriggerFromWake(envelope: TimedWakeEnvelope | undefined, mergedCount: number): ManagerEpisodeTrigger {
  const mergedNote = mergedCount > 1 ? `（合并 ${mergedCount} 个唤醒）` : ''
  const wake = envelope?.wake
  if (!wake) return { type: 'human_message', summary: `mailbox 残留自唤醒${mergedNote}` }
  switch (wake.kind) {
    case 'human_messages': {
      const excerpt = firstMessageExcerpt(wake.messages)
      return {
        type: 'human_message',
        summary: `人类消息 x${wake.messages.length}${excerpt ? `：${excerpt}` : ''}${mergedNote}`,
        source: wake.friend ? `friend:${wake.friend.id}` : undefined,
      }
    }
    case 'attention_flush': {
      const excerpt = firstMessageExcerpt(wake.messages)
      return {
        type: 'attention_flush',
        summary: `群聊注意力放行 x${wake.messages.length}${excerpt ? `：${excerpt}` : ''}${mergedNote}`,
      }
    }
    case 'schedule':
      return { type: 'schedule', summary: `定时任务:${wake.title}${mergedNote}`, source: `schedule:${wake.scheduleId}` }
    case 'worker_event':
      return { type: 'worker_event', summary: `worker 事件:${wake.event.kind} (${wake.event.worker_id})${mergedNote}`, source: `worker:${wake.event.worker_id}` }
    case 'media_notification':
      return { type: 'worker_event', summary: `媒体下载完成${mergedNote}` }
    default: {
      const exhaustive: never = wake
      return { type: 'human_message', summary: `未知唤醒 ${String((exhaustive as { kind?: string }).kind)}${mergedNote}` }
    }
  }
}

function firstMessageExcerpt(messages: ReadonlyArray<ChannelMessage>): string | undefined {
  const text = messages.find((message) => message.content.text?.trim())?.content.text
  return text ? truncateForTrace(text.replace(/\s+/g, ' ').trim(), 80) : undefined
}

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
 * - `send_daily_reflection_summary` —— builtin 每日反思固定投递到 Admin Web 系统任务线程。
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
  'send_daily_reflection_summary',
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

/**
 * `send_message` has delivery semantics that are narrower than the generic "replied" signal.
 * Pair each assistant tool_use with its following tool result so a failed call, or a successful
 * call to another session, cannot consume a worker's periodic-report responsibility.
 */
function successfulSendMessageTargetsOf(
  finalMessages: ReadonlyArray<EngineMessage>,
): Array<{ readonly channel_id: string; readonly session_id: string }> {
  const pending = new Map<string, { readonly channel_id: string; readonly session_id: string }>()
  const targets: Array<{ readonly channel_id: string; readonly session_id: string }> = []
  for (const message of finalMessages) {
    if (message.role === 'assistant') {
      for (const block of message.content) {
        if (block.type !== 'tool_use' || block.name !== 'send_message') continue
        const channelId = block.input.channel_id
        const sessionId = block.input.session_id
        if (typeof channelId === 'string' && typeof sessionId === 'string') {
          pending.set(block.id, { channel_id: channelId, session_id: sessionId })
        }
      }
      continue
    }
    if (!('toolResults' in message)) continue
    for (const result of message.toolResults) {
      const target = pending.get(result.tool_use_id)
      pending.delete(result.tool_use_id)
      if (target && !result.is_error) targets.push(target)
    }
  }
  return targets
}

/** Manager-only mailbox: envelopes remain authoritative; the engine receives deterministic text. */
class TimedWakeMailbox implements HumanMessageQueueLike {
  private pending: TimedWakeEnvelope[] = []
  private contextAdmissionEnvelopes: TimedWakeEnvelope[] = []
  /** 非 null 时记录此后 drainPending() 拿走的 envelope(复核 continuation 失败还原用,见 runEpisodeBody)。 */
  private drainCapture: TimedWakeEnvelope[] | null = null
  private barrierResolve: (() => void) | null = null
  private barrierTimer: ReturnType<typeof setTimeout> | null = null
  /**
   * 插话带图的视觉注入开关。runEpisodeBody 每个 episode 与 supportsVision 解析同点设置;
   * drainPending 是同步签名,本地图 readFileSync 注入(毫秒级);远程 URL(微信 CDN)在
   * enqueue 时异步预取(fire-and-forget,enqueue 与 drain 之间隔着工具执行,通常已就绪),
   * 未就绪/失败的插话保留文本标记原样——不改写,下一 episode 由 imageRefs 重新 fetch
   * 注入(marker 精确匹配不被破坏)。
   */
  private visionEnabled = false
  /** 远程图预取结果,按 envelope 引用挂 WeakMap(重投/GC 自动清理)。 */
  private imagePrefetch = new WeakMap<TimedWakeEnvelope, Map<string, ImageBlock | 'failed'>>()

  setVisionEnabled(enabled: boolean): void {
    this.visionEnabled = enabled
  }

  /** 对插话 envelope 的远程图片发起预取(fire-and-forget;仅 visionEnabled 时有意义)。 */
  prefetchRemoteImages(envelope: TimedWakeEnvelope): void {
    if (!this.visionEnabled || !isHumanWake(envelope.wake)) return
    const remote = envelope.wake.messages
      .flatMap(collectInboundImages)
      .filter((i) => i.path.startsWith('http://') || i.path.startsWith('https://'))
    if (remote.length === 0) return
    let store = this.imagePrefetch.get(envelope)
    if (!store) {
      store = new Map()
      this.imagePrefetch.set(envelope, store)
    }
    for (const image of remote) {
      if (store.has(image.label)) continue
      void fetchRemoteImage(image.path, REMOTE_IMAGE_PREFETCH_TIMEOUT_MS).then((buffer) => {
        store!.set(image.label, buffer ? toImageBlock(image.path, buffer) : 'failed')
      })
    }
  }

  push(envelope: TimedWakeEnvelope): void {
    this.pending.push(envelope)
    this.clearBarrier()
  }

  drainEnvelopes(): TimedWakeEnvelope[] {
    const drained = this.pending
    this.pending = []
    return drained
  }

  /** 该 envelope 是否仍在等待注入(引用比较)。收尾提交用它区分「已被 drain 消费/未消费」。 */
  isPending(envelope: TimedWakeEnvelope): boolean {
    return this.pending.includes(envelope)
  }

  /** 开始记录此后 drainPending() 拿走的 envelope;与 takeDrainedForReplay 成对使用。 */
  startDrainCapture(): void {
    this.drainCapture = []
  }

  /** 结束记录并返回期间被 drain 的 envelope(按原顺序);未开启时返回空。 */
  takeDrainedForReplay(): TimedWakeEnvelope[] {
    const captured = this.drainCapture ?? []
    this.drainCapture = null
    return captured
  }

  /** 按引用移除一个尚未注入的 envelope(收尾提交改为直接落 recent 时使用)。 */
  discard(envelope: TimedWakeEnvelope): void {
    const index = this.pending.indexOf(envelope)
    if (index >= 0) this.pending.splice(index, 1)
  }

  takePendingActivityEnvelopes(): TimedWakeEnvelope[] {
    const activity: TimedWakeEnvelope[] = []
    const remaining: TimedWakeEnvelope[] = []
    for (const envelope of this.pending) {
      if (envelope.activity_context_receipt) activity.push(envelope)
      else remaining.push(envelope)
    }
    this.pending = remaining
    return activity
  }

  drainPending(): Array<string | ContentBlock[]> {
    const drained = this.drainEnvelopes()
    this.contextAdmissionEnvelopes.push(...drained)
    this.drainCapture?.push(...drained)
    return drained.map((envelope) => {
      const text = renderTimedWakeEnvelope(envelope)
      if (!this.visionEnabled || !isHumanWake(envelope.wake)) return text
      const images = envelope.wake.messages.flatMap(collectInboundImages)
      if (images.length === 0) return text
      // 文本标记一律原样保留(不剔除、不改写):收尾拍平还原后与渲染文本逐字一致,
      // 下一 episode 从 imageRefs 幂等重注入,marker 精确匹配不被破坏。
      // 本地图同步读盘;远程图用 enqueue 时预取的结果——未就绪/失败的本轮不注入
      // (保留标记),由收尾补记的 imageRefs 下一轮 fetch 重试。
      const prefetch = this.imagePrefetch.get(envelope)
      const blocks: ImageBlock[] = []
      for (const image of images) {
        const isRemote = image.path.startsWith('http://') || image.path.startsWith('https://')
        const buffer = isRemote ? null : readImageFileSync(image.path)
        if (buffer) {
          blocks.push(toImageBlock(image.path, buffer))
          continue
        }
        if (isRemote) {
          const prefetched = prefetch?.get(image.label)
          if (prefetched && prefetched !== 'failed') {
            blocks.push(prefetched)
            continue
          }
        }
        // 本地不可读(已 GC/超限/IO)或远程未就绪/失败:保留标记,不注入,不当轮臆断原因
      }
      if (blocks.length === 0) return text
      return [{ type: 'text' as const, text }, ...blocks]
    })
  }

  takeContextAdmissionEnvelopes(): TimedWakeEnvelope[] {
    const drained = this.contextAdmissionEnvelopes
    this.contextAdmissionEnvelopes = []
    return drained
  }

  clearContextAdmissions(): void {
    this.contextAdmissionEnvelopes = []
  }

  get hasPending(): boolean {
    return this.pending.length > 0
  }

  get hasBarrier(): boolean {
    return this.barrierResolve !== null || this.barrierTimer !== null
  }

  setBarrier(timeoutMs: number, onTimeout?: () => void): void {
    this.clearBarrier()
    this.barrierTimer = setTimeout(() => {
      this.barrierTimer = null
      onTimeout?.()
      this.clearBarrier()
    }, timeoutMs)
  }

  clearBarrier(): void {
    if (this.barrierTimer !== null) {
      clearTimeout(this.barrierTimer)
      this.barrierTimer = null
    }
    const resolve = this.barrierResolve
    this.barrierResolve = null
    resolve?.()
  }

  async waitBarrier(signal?: AbortSignal): Promise<void> {
    if (!this.hasBarrier || this.barrierResolve !== null) return
    await new Promise<void>((resolve) => {
      const abort = (): void => this.clearBarrier()
      signal?.addEventListener('abort', abort, { once: true })
      this.barrierResolve = () => {
        signal?.removeEventListener('abort', abort)
        resolve()
      }
    })
  }
}

function assertTimedWakeEnvelope(value: TimedWakeEnvelope): void {
  if (
    value === null ||
    typeof value !== 'object' ||
    !('wake' in value) ||
    typeof value.received_at !== 'string' ||
    typeof value.timezone !== 'string'
  ) {
    throw new TypeError('ManagerLoop requires a TimedWakeEnvelope captured at ingress')
  }
}

/** Pure projection of ingress-fixed time; this function never reads a live clock. */
export function renderTimedWakeEnvelope(envelope: TimedWakeEnvelope): string {
  const header = `[event received_at="${envelope.received_at}" timezone="${envelope.timezone}"]`
  const occurred = envelope.occurred_at ? `\n[event occurred_at="${envelope.occurred_at}"]` : ''
  return `${header}${occurred}\n${renderWakeEvent(envelope.wake, envelope)}`
}

type HumanWake = Extract<WakeEvent, { readonly kind: 'human_messages' | 'attention_flush' }>

function isHumanWake(wake: WakeEvent): wake is HumanWake {
  return wake.kind === 'human_messages' || wake.kind === 'attention_flush'
}

function isEmptyHumanWake(wake: HumanWake): boolean {
  return wake.messages.length === 0
}

function projectHumanEnvelope(
  envelope: TimedWakeEnvelope,
  entries: ReadonlyArray<{ readonly message: ChannelMessage; readonly index: number }>,
): TimedWakeEnvelope {
  if (!isHumanWake(envelope.wake)) throw new Error('projectHumanEnvelope requires a human wake')
  const humanOccurredAt = envelope.human_occurred_at
    ? entries.map(({ message, index }) => envelope.human_occurred_at?.[index] ?? { message_id: message.platform_message_id })
    : undefined
  return {
    ...envelope,
    wake: { ...envelope.wake, messages: entries.map(({ message }) => message) },
    ...(humanOccurredAt ? { human_occurred_at: humanOccurredAt } : {}),
  }
}

function withoutProtectedTail(state: ManagerSessionState, protectedTailLength: number): ManagerSessionState {
  if (protectedTailLength === 0) return state
  return { ...state, recent: state.recent.slice(0, -protectedTailLength) }
}

function renderWakeEvent(event: WakeEvent, envelope: TimedWakeEnvelope): string {
  switch (event.kind) {
    case 'human_messages':
      return renderChannelMessages('[人类消息]', event.messages, event.friend, envelope)
    case 'attention_flush':
      return renderChannelMessages(
        '[补齐:群聊注意力放行期间累积的人类消息]',
        event.messages,
        event.friend,
        envelope,
      )
    case 'worker_event':
      return renderWorkerEvent(event.event)
    case 'media_notification':
      return `[媒体下载完成]\n${event.text}`
    case 'schedule':
      return `[定时任务触发] scheduleId=${event.scheduleId}\n标题:${event.title}\n描述:${event.description}`
  }
}

function renderChannelMessages(
  label: string,
  messages: ReadonlyArray<ChannelMessage>,
  friend: Friend | undefined,
  envelope: TimedWakeEnvelope,
): string {
  if (messages.length === 0) return `${label}(空)`
  const lines = messages.map((message, index) => {
    const occurred = envelope.human_occurred_at?.[index]?.occurred_at
    const prefix = occurred ? `[human occurred_at="${occurred}"]\n` : ''
    return prefix + formatChannelMessageLine(message, {
      timezone: envelope.timezone,
      now: new Date(envelope.received_at),
      identity: resolveSenderIdentity({ msg: message, ...(friend ? { senderFriend: friend } : {}) }),
    })
  })
  return `${label}\n${lines.join('\n')}`
}

/**
 * harness 事件 → manager 决策类别(spec 2026-08-31-worker-stop-oversight-design §5.4)。
 * content=有内容待处置;blocked=受阻需介入;review=例行巡检;info=通报知情。
 */
function workerEventClass(event: HarnessEvent): 'content' | 'blocked' | 'review' | 'info' {
  switch (event.kind) {
    case 'state_changed': {
      if (event.detail?.kind === 'interaction_required') return 'blocked'
      // manager 自己处置动作的回执(stop_verified:任务已 closed)是收据不是新待办,
      // 归 info——否则每次核验成功的 request_worker_stop 都会立刻要求 manager
      // 再走一轮"必须处置",而续办对 closed 是硬拒绝,必错。
      if (event.detail?.reason === 'stop_verified') return 'info'
      if (event.detail?.source === 'liveness_stall') return 'content'
      // 主线状态机的通用事件点:停止/退出迁移是"有内容待处置",to=running 只是
      // "开始跑了"的纯通报,归 info,不逼 manager 走四选一处置。
      const to = event.detail?.to
      return to === 'idle' || to === 'exited' ? 'content' : 'info'
    }
    case 'activity_available':
    case 'turn_completed':
    case 'query_completed':
      return 'content'
    case 'input_delivery_failed':
    case 'worker_recovery_required':
      return 'blocked'
    case 'supervision_due':
      return 'review'
    default:
      return 'info'
  }
}

function renderWorkerEvent(event: HarnessEvent): string {
  const cls = workerEventClass(event)
  const { text, summary, ...rest } = (event.detail ?? {}) as
    { text?: unknown; summary?: unknown } & Record<string, unknown>
  const detail = Object.keys(rest).length > 0 ? ` detail=${JSON.stringify(rest)}` : ''
  const parts = [`<crabot-event class="${cls}" kind="${event.kind}" worker_id="${event.worker_id}" seq="${event.seq}"${detail}>`]
  if (typeof text === 'string' && text.length > 0) {
    // 只有 interaction_required 事件的 text 是终端画面 capture(不是 worker 说的话),
    // 标签必须区分,防止 manager 把画面内容误当发言;其余事件的 text 都是发言/指令原文。
    const isPaneCapture = event.kind === 'state_changed' && event.detail?.kind === 'interaction_required'
    parts.push(isPaneCapture ? `worker 当前画面:\n${text}` : `worker 最后说:\n${text}`)
  }
  if (typeof summary === 'string' && summary.length > 0) parts.push(`worker 的收尾结论:\n${summary}`)
  parts.push('</crabot-event>')
  return parts.join('\n')
}

const SUPERVISION_READ_ONLY_TOOL_NAMES = new Set([
  'get_worker_terminal',
  'get_worker_state',
  'get_worker_activity',
  'get_worker_turn',
  'list_workers',
  'get_worker_detail',
  'get_history',
  'get_message',
  'lookup_friend',
  'list_sessions',
  'list_contacts',
  'list_groups',
  'list_group_members',
  'fetch_media',
  'read_feishu_document',
  'feishu_raw_get',
  'feishu_download_file',
  'get_system_status',
  'get_deployment_info',
  'list_schedules',
  'get_config_summary',
  'list_capabilities',
  'get_friend_permissions',
  'mcp__crab-memory__search_memory',
  'mcp__crab-memory__get_memory_detail',
  'mcp__crab-memory__search_long_term',
  'mcp__crab-memory__list_recent',
  'mcp__crab-memory__list_entries',
  'mcp__crab-memory__get_stats',
  'mcp__crab-memory__get_evolution_mode',
  'mcp__crab-memory__get_scene_profile',
])

function defaultSupervisionHistorySummary(args: {
  readonly envelope: TimedWakeEnvelope | undefined
  readonly carriedEnvelopes: ReadonlyArray<TimedWakeEnvelope>
  readonly injectedEnvelopes: ReadonlyArray<TimedWakeEnvelope>
  readonly outcome: EpisodeResult['outcome']
  readonly usedForceHotRetry: boolean
  readonly priorRecentCount: number
  readonly hasSummaryMarker: boolean
  readonly finalMessages: ReadonlyArray<EngineMessage>
  readonly startedAt: string | undefined
  readonly endedAt: string
}): string | undefined {
  const event = args.envelope?.wake.kind === 'worker_event' ? args.envelope.wake.event : undefined
  if (
    event?.kind !== 'supervision_due' ||
    event.detail?.mode !== 'default' ||
    args.carriedEnvelopes.length !== 0 ||
    args.injectedEnvelopes.length !== 0 ||
    args.outcome !== 'completed' ||
    args.usedForceHotRetry
  ) return undefined

  const start = (args.hasSummaryMarker ? 1 : 0) + args.priorRecentCount + 1
  const episodeMessages = args.finalMessages.slice(start)
  for (const message of episodeMessages) {
    if (message.role !== 'assistant') continue
    for (const block of message.content) {
      if (block.type === 'tool_use' && !SUPERVISION_READ_ONLY_TOOL_NAMES.has(block.name)) return undefined
    }
  }

  const observation = typeof event.detail.observation === 'string' ? event.detail.observation : 'unknown'
  return (
    `[任务巡检摘要] worker_id=${event.worker_id}; ` +
    `时间=${args.startedAt ?? event.ts} 至 ${args.endedAt}; ` +
    `进展分类=${observation}; 未执行外部动作。`
  )
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
