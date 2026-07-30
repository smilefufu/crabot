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
} from '../engine/index.js'
import { AsyncMutex } from '../workers/async-mutex'
import { decideCompaction, foldIntoSummary, type CompactionPolicy, type CompactionDecision } from './compaction.js'
import { assembleManagerSystemPrompt } from './prompt.js'
import type { ManagerSessionStore } from './session-store.js'
import type { ManagerSessionState, ManagerKey } from './types.js'
import type { WorkerHarness } from '../workers/harness/harness'
import type { DialogObjectId, LedgerWorker } from '../workers/harness/ledger-types'
import type { HarnessEvent } from '../workers/harness/worker-events'
import type { ChannelMessage } from '../types'

// --- Public Interface ---

export type WakeEvent =
  | { readonly kind: 'human_messages'; readonly messages: ReadonlyArray<ChannelMessage> }
  | { readonly kind: 'worker_event'; readonly event: HarnessEvent }
  | { readonly kind: 'schedule'; readonly scheduleId: string; readonly title: string; readonly description: string }
  | { readonly kind: 'attention_flush'; readonly messages: ReadonlyArray<ChannelMessage> }

export interface EpisodeResult {
  readonly episodeId: string
  readonly outcome: 'completed' | 'failed' | 'max_turns' | 'aborted'
  readonly turns: number
  /** false ⇒ 邮箱事件不消费,已推回内部邮箱,下次唤醒重投 */
  readonly consumedEvents: boolean
}

export interface ManagerLoopDeps {
  readonly key: ManagerKey
  readonly isSystemThread: boolean
  /** 台账渲染用(harness.listWorkers 的入参)。manager 会话粒度(ManagerKey)与台账聚合粒度
   *  (DialogObjectId)不同——由调用方按 protocol §3 解析好传入,本模块不做这层映射。 */
  readonly dialogObjectId: DialogObjectId
  readonly store: ManagerSessionStore
  readonly policy: CompactionPolicy
  /** decideCompaction 的 token 估算器,调用方注入(与 compaction.ts 的既定依赖注入方式一致)。 */
  readonly estimateTokens: (msgs: ReadonlyArray<EngineMessage>) => number
  readonly adapter: LLMAdapter
  readonly model: string
  readonly maxTurns?: number
  readonly contextWindowTokens?: number
  /** 工具面提供者(thunk):每轮重算,由调用方决定要不要按最新状态重建。 */
  readonly toolFace: () => ReadonlyArray<ToolDefinition>
  /** system prompt 里除动态台账/时间外的其余输入(档案、待处理通知),每轮重算。 */
  readonly promptInputs: () => { readonly dialogProfile?: string; readonly pendingNotes?: ReadonlyArray<string> }
  readonly harness: WorkerHarness
  readonly now: () => Date
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
   */
  private readonly mailbox = new HumanMessageQueue()

  constructor(deps: ManagerLoopDeps) {
    this.deps = deps
  }

  /** 唯一入口:被唤醒 → 跑一个 episode → 回睡。同一 loop 串行,不同 loop 互不影响。 */
  async wakeUp(event: WakeEvent): Promise<EpisodeResult> {
    return this.mutex.run(() => this.runEpisode(event))
  }

  /** episode 进行中到达的新事件:渲染成文本推进内部邮箱,由 engine 的 humanMessageQueue
   *  在 turn 间隙注入;episode 不在跑时同样入队,行为见 `mailbox` 字段注释。 */
  enqueueDuringEpisode(event: WakeEvent): void {
    this.mailbox.push(renderWakeEvent(event))
  }

  private async runEpisode(event: WakeEvent): Promise<EpisodeResult> {
    const episodeId = randomUUID()
    const carriedTexts = this.mailbox.drainPending().map(toText)
    const eventText = renderWakeEvent(event)

    let state = await this.deps.store.load(this.deps.key)
    const nowMs = this.deps.now().getTime()

    const wakeDecision = decideCompaction({
      state,
      nowMs,
      policy: this.deps.policy,
      estimateTokens: this.deps.estimateTokens,
    })
    if (wakeDecision.kind !== 'none') {
      state = await this.applyFold(state, wakeDecision)
    }

    const tailMessages: EngineMessage[] = [
      ...state.recent,
      ...carriedTexts.map((t) => createUserMessage(t)),
      createUserMessage(eventText),
    ]

    let attempt = await this.runAttempt(state, tailMessages)
    let totalTurnsUsed = attempt.result.totalTurns

    // max_tokens 兜底(§4.2):disableCompaction 关掉了 engine 自己的强压重试路径,
    // 这里识别到"上下文超限收场"时强制 force_hot 折叠一次并重试一次,仍失败就放弃。
    if (isContextOverflow(attempt.result)) {
      const forceDecision = forceHotFold({ ...state, recent: tailMessages }, this.deps.policy, this.deps.estimateTokens, nowMs)
      if (forceDecision.kind !== 'none') {
        state = await this.applyFold(state, forceDecision)
        const retryAttempt = await this.runAttempt(state, state.recent)
        totalTurnsUsed += retryAttempt.result.totalTurns
        attempt = retryAttempt
      }
      // forceDecision.kind === 'none'(历史短到连一条都折不动):无法进一步压缩,
      // 只能接受第一次尝试的结果——大概率仍是 outcome='completed' 空 finalText,
      // 不强行判 failed(engine 本身没有报错,只是这条上下文天生就大)。
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
      // 放弃 episode:已落盘的折叠不回滚(见文件头),只把"这次没处理完的输入"按原顺序
      // 推回邮箱,下次唤醒会连同新事件一起重投,保证至少一次投递。
      for (const t of carriedTexts) this.mailbox.push(t)
      this.mailbox.push(eventText)
    }

    const result: EpisodeResult = {
      episodeId,
      outcome: attempt.result.outcome,
      turns: totalTurnsUsed,
      consumedEvents,
    }
    this.deps.onEpisodeEnd?.(result)
    return result
  }

  /** 按 decision 折叠并立即落盘(唤醒边界折叠 / 强制 force_hot 折叠共用同一落盘逻辑)。 */
  private async applyFold(
    state: ManagerSessionState,
    decision: Extract<CompactionDecision, { kind: 'fold_at_wake' | 'force_hot' }>,
  ): Promise<ManagerSessionState> {
    const newSummary = await foldIntoSummary({
      adapter: this.deps.adapter,
      model: this.deps.model,
      prevSummary: state.rollingSummary,
      foldMessages: decision.foldMessages,
    })
    const next: ManagerSessionState = {
      ...state,
      rollingSummary: newSummary,
      recent: decision.keep,
      foldedCount: state.foldedCount + decision.foldMessages.length,
    }
    await this.deps.store.save(next)
    return next
  }

  /** 跑一次 runEngine(可能是首次尝试,也可能是 max_tokens 兜底的重试)。 */
  private async runAttempt(
    state: ManagerSessionState,
    tailMessages: ReadonlyArray<EngineMessage>,
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
    const tools = (): ReadonlyArray<ToolDefinition> => this.deps.toolFace()

    const options: EngineOptions = {
      systemPrompt,
      tools,
      model: this.deps.model,
      maxTurns: this.deps.maxTurns,
      contextWindowTokens: this.deps.contextWindowTokens,
      disableCompaction: true,
      humanMessageQueue: this.mailbox,
      onTurn: () => refreshLedgerRender(),
    }

    const result = await runEngine({
      prompt: '', // 被忽略:initialMessages 非空时 runEngine 不使用 prompt(见 query-loop.ts)
      adapter: this.deps.adapter,
      options,
      initialMessages,
    })

    return { result, hasSummaryMarker }
  }

  private async fetchLedgerRender(): Promise<string> {
    const workers = await this.deps.harness.listWorkers(this.deps.dialogObjectId)
    return renderLedger(workers)
  }
}

// --- Helpers ---

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

function renderWakeEvent(event: WakeEvent): string {
  switch (event.kind) {
    case 'human_messages':
      return renderChannelMessages('[人类消息]', event.messages)
    case 'attention_flush':
      return renderChannelMessages('[补齐:群聊注意力放行期间累积的人类消息]', event.messages)
    case 'worker_event':
      return renderWorkerEvent(event.event)
    case 'schedule':
      return `[定时任务触发] scheduleId=${event.scheduleId}\n标题:${event.title}\n描述:${event.description}`
  }
}

function renderChannelMessages(label: string, messages: ReadonlyArray<ChannelMessage>): string {
  if (messages.length === 0) return `${label}(空)`
  const lines = messages.map((m) => {
    const who = m.sender.platform_display_name || m.sender.platform_user_id
    const text = m.content.text ?? `[${m.content.type}]`
    return `- ${who}: ${text}`
  })
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
 * 2. adapter.stream 真的抛出"上下文/超限"相关错误时(如 provider 直接拒绝过长请求),
 *    走的是 query-loop 顶层 try/catch → outcome='failed'、error=formatError(err)——
 *    这种情形只能靠错误文案关键字识别,兜底覆盖 max_tokens/context/token limit 等常见表述。
 */
function isContextOverflow(result: EngineResult): boolean {
  const last = result.finalMessages[result.finalMessages.length - 1]
  if (last?.role === 'assistant' && last.stopReason === 'max_tokens') {
    return true
  }
  if (result.outcome === 'failed' && result.error && /max_tokens|context[^a-z]{0,10}(length|window)|token[^a-z]{0,10}limit|too (long|large)/i.test(result.error)) {
    return true
  }
  return false
}
