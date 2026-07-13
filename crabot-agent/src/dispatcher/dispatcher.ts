/**
 * Pre-Front Dispatcher 入口。
 *
 * 输入消息批次 + active_tasks，LLM 单次调用输出动作列表。
 * - LLM 通过结构化文本输出 JSON（{"actions": [...]}）
 * - schema 校验失败 / JSON 解析失败 / 不合法动作类型 → 重试
 * - 重试用完 → 调 sendErrorToUser 向人类报错 + 返回空 actions
 *
 * Spec: crabot-docs/superpowers/specs/2026-05-19-prefront-dispatcher-design.md §3
 */

import type { LLMAdapter } from '../engine/llm-adapter-types.js'
import { callNonStreaming, extractText } from '../engine/llm-adapter-types.js'
import type { EngineUserMessage } from '../engine/types.js'
import type { ChannelMessage } from '../types.js'
import type { DispatchContext, DispatchResult, DispatchAction, DispatchTraceCallback } from './dispatcher-types.js'
import { MAX_ACTIONS_PER_DISPATCH } from './dispatcher-types.js'
import { assembleDispatcherPrompt } from './dispatcher-prompt.js'
import { formatChannelMessageLine, type QuotedMessageEntry } from '../prompt-manager.js'
import { resolveSenderIdentity } from '../utils/sender-identity.js'
import { prefetchQuotedMessages, type PrefetchQuotedDeps } from '../agent/quoted-message-prefetcher.js'

export interface DispatchDeps {
  readonly adapter: LLMAdapter
  readonly modelId: string
  readonly sendErrorToUser: (errorText: string) => Promise<void>
  readonly maxParseRetries?: number
  /** trace 写入回调（可选）。注入后 dispatch() 在 DispatchContext 指定的 trace 下写 dispatch_call span。 */
  readonly trace?: DispatchTraceCallback
  /** 调用方注入的 batch 大小（SessionLane take 整批时传入）。仅用于 dispatch_call span 观测。 */
  readonly laneBatchSize?: number
  /**
   * 引用消息预拉依赖（可选）。注入后 dispatcher 在调 LLM 前 await prefetch，
   * formatChannelMessageLine 嵌套渲染 <quoted_message>。不注入时 dispatcher 仅靠
   * 本地命中（ctx.messages / recentMessages 间互相引用），跨日 quote 看不到原文。
   */
  readonly quotedPrefetchDeps?: PrefetchQuotedDeps
  /** IANA 时区名（如 "Asia/Shanghai"），用于 message 标签里 ts 属性的本地化。不传默认 'UTC'。 */
  readonly timezone?: string
}

const DEFAULT_MAX_PARSE_RETRIES = 3

export async function dispatch(ctx: DispatchContext, deps: DispatchDeps): Promise<DispatchResult> {
  const maxRetries = deps.maxParseRetries ?? DEFAULT_MAX_PARSE_RETRIES
  const systemPrompt = assembleDispatcherPrompt(ctx)

  // 引用消息预拉：跨日 / 跨窗口的 quote 在本地拿不到原文时走 channel RPC 拉一次。
  // 不注入 quotedPrefetchDeps 时回退到空 Map（仅靠本地 messages/recentMessages 命中）。
  const isGroup = ctx.sessionType === 'group'
  const identityResolver = (msg: ChannelMessage) =>
    resolveSenderIdentity({
      msg,
      senderFriend: ctx.senderFriend,
      isGroup,
    })
  let quotedMessages: ReadonlyMap<string, QuotedMessageEntry> = new Map()
  if (deps.quotedPrefetchDeps) {
    quotedMessages = await prefetchQuotedMessages(
      [...ctx.messages, ...ctx.recentMessages],
      ctx.recentMessages,
      ctx.channelId,
      ctx.sessionId,
      isGroup ? 'group' : 'private',
      deps.quotedPrefetchDeps,
      identityResolver,
    )
  }
  const baseUserContent = buildUserPrompt(ctx, { quotedMessages, timezone: deps.timezone ?? 'UTC' })

  // 写 dispatch_call span（若调用方注入了 trace callback）
  const span = deps.trace?.startSpan({
    type: 'dispatch_call',
    parent_span_id: ctx.parentSpanId,
    details: {
      model: deps.modelId,
      session_type: ctx.sessionType,
      message_count: ctx.messages.length,
      active_task_count: ctx.activeTasks.length,
      ...(deps.laneBatchSize != null ? { lane_batch_size: deps.laneBatchSize } : {}),
    },
  })

  let lastError = ''
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    // 把上一次失败原因回灌进 user message 末尾，让 LLM 看到错在哪里再 retry
    const userContent = attempt === 0
      ? baseUserContent
      : `${baseUserContent}\n\n## 上一次输出被校验拒绝\n${lastError}\n请按规则重新输出 JSON，**不要解释**。`
    const userMessage: EngineUserMessage = {
      id: `dispatch-${Date.now()}-${attempt}`,
      role: 'user',
      content: userContent,
      timestamp: Date.now(),
    }
    try {
      const response = await callNonStreaming(deps.adapter, {
        messages: [userMessage],
        systemPrompt,
        tools: [],
        model: deps.modelId,
        maxTokens: 1500,
      })
      const text = extractText(response.content)
      const parsed = parseAndValidate(text, ctx)
      if (parsed.ok) {
        const actions = parsed.actions.slice(0, MAX_ACTIONS_PER_DISPATCH)
        if (span && deps.trace) {
          deps.trace.endSpan(span.span_id, 'completed', {
            action_count: actions.length,
            retries: attempt,
          })
        }
        return { actions }
      }
      lastError = parsed.error
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err)
    }
  }

  if (span && deps.trace) {
    deps.trace.endSpan(span.span_id, 'failed', {
      error: lastError.slice(0, 200),
      retries: maxRetries,
    })
  }
  await deps.sendErrorToUser(`系统出错，未能处理刚才的消息：${lastError.slice(0, 200)}`)
  return { actions: [] }
}

/** Exported for regression tests; renders messages via formatChannelMessageLine so dispatcher
 *  sees the same structured fields (reply_to / quote / mentions / id 等) as worker. */
export function buildUserPrompt(
  ctx: DispatchContext,
  opts: {
    quotedMessages?: ReadonlyMap<string, QuotedMessageEntry>
    timezone?: string
  } = {},
): string {
  const lines: string[] = []
  const isGroup = ctx.sessionType === 'group'
  const identityResolver = (msg: ChannelMessage) =>
    resolveSenderIdentity({ msg, senderFriend: ctx.senderFriend, isGroup })
  const quotedMessages = opts.quotedMessages ?? new Map<string, QuotedMessageEntry>()
  const timezone = opts.timezone ?? 'UTC'
  const now = new Date()

  // 最近聊天历史：剔除当前批次已含的消息（contextAssembler 拉的 recent_messages 通常会包含 trigger）
  const currentIds = new Set(ctx.messages.map((m) => m.platform_message_id))
  const history = ctx.recentMessages.filter((m) => !currentIds.has(m.platform_message_id))
  if (history.length > 0) {
    lines.push('## 最近聊天历史')
    for (const m of history) {
      lines.push(formatChannelMessageLine(m, {
        timezone, now, maxLen: 2000,
        identity: identityResolver(m),
        quotedMessages,
      }))
    }
    lines.push('')
  }

  lines.push('## 当前消息批次')
  for (const m of ctx.messages) {
    lines.push(formatChannelMessageLine(m, {
      timezone, now, maxLen: 2000,
      identity: identityResolver(m),
      quotedMessages,
    }))
  }
  const activeSessionTasks = ctx.activeTasks.filter((t) => t.candidate_kind !== 'recent_terminal')
  if (activeSessionTasks.length > 0) {
    lines.push('\n## 当前正在运行的本 session task')
    for (const t of activeSessionTasks) {
      lines.push(`- [${t.task_id}] (status: ${t.status})`)
    }
  }
  lines.push('\n按 system prompt 描述的 schema 输出 JSON。')
  return lines.join('\n')
}

type ValidationResult =
  | { readonly ok: true; readonly actions: ReadonlyArray<DispatchAction> }
  | { readonly ok: false; readonly error: string }

function parseAndValidate(text: string, ctx: DispatchContext): ValidationResult {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/, '').replace(/\s*```\s*$/, '').trim()
  let obj: unknown
  try {
    obj = JSON.parse(cleaned)
  } catch (err) {
    return { ok: false, error: `JSON 解析失败：${err instanceof Error ? err.message : String(err)}` }
  }
  if (typeof obj !== 'object' || obj === null || !('actions' in obj)) {
    return { ok: false, error: '输出缺少 actions 字段' }
  }
  const actions = (obj as { actions: unknown }).actions
  if (!Array.isArray(actions)) {
    return { ok: false, error: 'actions 不是数组' }
  }
  const validated: DispatchAction[] = []
  for (let i = 0; i < actions.length; i++) {
    const a = actions[i] as Record<string, unknown>
    if (typeof a?.kind !== 'string') return { ok: false, error: `action[${i}].kind 缺失` }
    if (a.kind === 'supplement') {
      if (typeof a.target_task_id !== 'string') {
        return { ok: false, error: `action[${i}] supplement 缺 target_task_id` }
      }
      // 白名单校验：target_task_id 必须实际存在于本次输入的可补充任务候选中。
      // 防止 LLM 编造 / 截断 / 拼造前缀（典型反例：编出 trigger-<uuid> 这种 syntheticTaskId 形态）。
      if (!ctx.activeTasks.some((t) => t.task_id === a.target_task_id)) {
        const visible = ctx.activeTasks.length === 0
          ? '（无可补充任务，本次禁止使用 supplement，请改用 new_task）'
          : ctx.activeTasks.map((t) => t.task_id).join(', ')
        return {
          ok: false,
          error: `action[${i}] supplement.target_task_id="${a.target_task_id}" 不在可补充任务清单中。当前可见 task_id：${visible}`,
        }
      }
      validated.push({ kind: 'supplement', target_task_id: a.target_task_id })
    } else if (a.kind === 'new_task') {
      // immediate_reply 可选：非空 string 时才透传，其他形态（空串 / 非 string）一律忽略
      // 视为"没带"，不报错——保持 LLM 输出宽容
      const immediateReply = typeof a.immediate_reply === 'string' && a.immediate_reply.length > 0
        ? a.immediate_reply
        : undefined
      validated.push({
        kind: 'new_task',
        ...(immediateReply !== undefined ? { immediate_reply: immediateReply } : {}),
      })
    } else if (a.kind === 'stay_silent') {
      if (ctx.sessionType !== 'group') {
        return { ok: false, error: `action[${i}] stay_silent 仅群聊允许` }
      }
      validated.push({ kind: 'stay_silent', reason: typeof a.reason === 'string' ? a.reason : undefined })
    } else {
      return { ok: false, error: `action[${i}].kind 非法: ${a.kind}` }
    }
  }
  return { ok: true, actions: validated }
}
