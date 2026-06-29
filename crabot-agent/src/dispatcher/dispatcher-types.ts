/**
 * Pre-Front Dispatcher 类型定义。
 *
 * Spec: crabot-docs/superpowers/specs/2026-05-19-prefront-dispatcher-design.md §3
 */

import type { ChannelMessage, Friend, TaskSummary, RuntimeSceneProfile } from '../types.js'

/**
 * Dispatcher 的 trace 写入回调接口。
 * 采用 minimal interface，避免 dispatcher 模块直接 import agent 内部的 TraceStoreInterface。
 * 调用方（unified-agent）通过闭包将 traceStore 实例包装成此接口注入。
 */
export interface DispatchTraceCallback {
  readonly startSpan: (params: {
    type: string
    details?: Record<string, unknown>
    parent_span_id?: string
  }) => { span_id: string }
  readonly endSpan: (
    spanId: string,
    status: 'completed' | 'failed',
    details?: Record<string, unknown>,
  ) => void
}

/** Dispatcher 输出的单个动作。LLM 通过 structured output 约束格式。 */
export type DispatchAction =
  | { readonly kind: 'supplement'; readonly target_task_id: string; readonly text: string }
  | {
      readonly kind: 'new_task'
      readonly text: string
      /**
       * 可选预回复：dispatcher 判断任务复杂时给出。executor 在 spawnAgentInstance
       * 之前 await 一次 channel.send_message 发出去，再把 ack 元数据透给 spawn 闭包，
       * 由 spawn 拼成 outbound ChannelMessage 追加进 worker 的 recent_messages，
       * 让 worker 第一轮 prompt 就看到"自己刚发过 ack"，不会重复 ack。
       *
       * 不带 immediate_reply 的 new_task 表示 dispatcher 判断这是 1-2 步能答完的简单任务，
       * worker 一轮回完就行，不需要预回复。
       *
       * Spec: crabot-docs/superpowers/specs/2026-06-03-dispatcher-immediate-reply-and-overdue-removal-design.md
       */
      readonly immediate_reply?: string
    }
  | { readonly kind: 'stay_silent'; readonly reason?: string }

/** Dispatcher 调用上下文。 */
export interface DispatchContext {
  /** 当前触发批次：私聊单条 / 群聊 attention 批次。dispatcher 决策的直接对象。 */
  readonly messages: ReadonlyArray<ChannelMessage>
  /**
   * 最近聊天历史（不含当前 messages）。
   * dispatcher 需要它判断 supplement 时引用的「那个 PDF」「那个手机调研」是否指向当前活跃任务，
   * 并把媒体上下文（文件 / 图片）传递给 spawn 出来的 worker。
   * 由 contextAssembler 填充（参 FrontAgentContext.recent_messages）。
   */
  readonly recentMessages: ReadonlyArray<ChannelMessage>
  /** 已 union 去重 + 过滤 schedule task 的 active_tasks。dispatcher 直接信任。 */
  readonly activeTasks: ReadonlyArray<TaskSummary>
  readonly sessionType: 'private' | 'group' | 'admin_chat'
  readonly channelId: string
  readonly sessionId: string
  readonly senderFriend: Friend
  readonly sceneProfile?: RuntimeSceneProfile
  /**
   * Crabot 在该渠道里 @ 自己时的稳定标识（含 `@` 前缀，如 `@fufu_ai_001_bot`）。
   * dispatcher 用它判断多 @ 消息里哪一段是发给自己的；缺省时 LLM 只能靠
   * `is_mention_crab` 这种布尔信号瞎猜（多 bot 群里会猜错，已踩过坑）。
   */
  readonly crabSelfHandle?: string
  /** trace 关联：dispatcher 在此 trace 下挂 dispatch_call + dispatch_action span */
  readonly traceId: string
  readonly parentSpanId?: string
}

/** Dispatcher 返回结果。 */
export interface DispatchResult {
  readonly actions: ReadonlyArray<DispatchAction>
}

/**
 * sendImmediateReply 调用成功后返回的 ack 元数据。
 * executor 转手给 spawnAgentInstance(spawnOptions.immediateReply)，
 * 由 spawn 实现拼成 outbound ChannelMessage 注入 worker 的 recent_messages。
 */
export interface ImmediateReplySentInfo {
  readonly text: string
  readonly platform_message_id: string
  readonly sent_at: string
}

export type TerminalSupplementResult =
  | { readonly outcome: 'revived'; readonly traceId?: string }
  | { readonly outcome: 'fallback'; readonly reason?: string }

/** 动作执行器的运行时上下文（注入 unified-agent 提供的回调）。 */
export interface ExecuteContext {
  readonly dispatchCtx: DispatchContext
  /** supplement 投递回调：把 text push 到目标 task 的 humanQueue。
   *  返回值：'delivered' = 投递成功；'fallback' = task not found（agent 进程内 activeTasks 没有）。 */
  readonly pushSupplement: (taskId: string, text: string) => Promise<'delivered' | 'fallback'>
  /** recent_terminal supplement 恢复回调：尝试复活已终止任务；不可用或失败时 executor 降级为 new_task。 */
  readonly reviveTerminalSupplement?: (taskId: string, text: string) => Promise<TerminalSupplementResult>
  /** new_task spawn 回调：启动一个 agent 实例。
   *  实施细节：内部调 admin create_task with client-provided id 注册，然后跑 runWorkerLoop + finalizeTask。
   *  spawnOptions.immediateReply 透传 dispatcher 已发出的 ack 元数据（仅 new_task
   *  带 immediate_reply 且 sendImmediateReply 成功时由 executor 注入），让 spawn 实现把
   *  这条 outbound 拼进 worker 的 recent_messages。
   *  返回值 spawnedTraceId 用于 cross-trace link。 */
  readonly spawnAgentInstance: (
    text: string,
    spawnOptions?: { readonly immediateReply?: ImmediateReplySentInfo },
  ) => Promise<{ readonly spawnedTraceId: string }>
  /** channel send 回调：dispatcher 失败兜底走这条向人类报错。 */
  readonly sendErrorToUser: (errorText: string) => Promise<void>
  /**
   * 预回复回调（仅 new_task 携带 immediate_reply 时由 executor 调用一次）。
   * 闭包封装 channel.send_message RPC，把 dispatcher 给的简短 ack 发给当前会话。
   * 返回值带 channel 落 outbound 后的 platform_message_id / sent_at，executor 转手
   * 经 spawnAgentInstance.spawnOptions.immediateReply 透给 spawn 实现拼进 worker
   * recent_messages。
   * 不注入或抛错都不阻塞后续 spawnAgentInstance（错时按 worker 看不到 ack 的语义降级）。
   *
   * Spec: 2026-06-03-dispatcher-immediate-reply-and-overdue-removal-design.md
   */
  readonly sendImmediateReply?: (text: string) => Promise<ImmediateReplySentInfo>
  /**
   * 接住消息后的 reaction 回调（可选）。
   * Executor 在 new_task / supplement（含 fallback 降级）成功后调用一次，传该批
   * 最后一条消息的 platform_message_id。stay_silent 不调。抛错不阻塞主流程。
   *
   * Spec: 2026-06-04-channel-task-pickup-reaction-design.md §4
   */
  readonly reactToTriggerMessage?: (platformMessageId: string) => Promise<void>
  /** trace 写入回调（可选）。注入后 executeDispatchActions 为每个 action 写 dispatch_action span。 */
  readonly trace?: DispatchTraceCallback
}

/** Dispatcher 失败时的 trace outcome 标记。 */
export type DispatchTraceOutcome = 'dispatched' | 'silent' | 'error'

/** 软上限：单次 dispatch 最多输出多少个动作。LLM prompt 内告知此上限，超出截断。 */
export const MAX_ACTIONS_PER_DISPATCH = 5
