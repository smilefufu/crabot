/**
 * PromptManager - 统一提示词管理
 *
 * 所有提示词在此文件中以常量维护，不再读写外部 .md 文件。
 * 唯一的外部输入是 Admin 配置中的 system_prompt（adminPersonality）。
 *
 * 组装顺序: adminPersonality（可选）+ 产品自我认知 + 角色规则 + 能力注入（可选）
 */

import type { ChannelMessage } from './types.js'
import type { SenderIdentity } from './utils/sender-identity.js'
import { formatChannelMessageTime, formatRelativeTime } from './utils/time.js'
import { formatMessageContent } from './agent/media-resolver.js'
import {
  assembleAgentPrompt as assembleAgentPromptImpl,
  type AssembleAgentPromptOptions,
} from './prompts/assemble-agent.js'

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** 调用方预拉的引用原文映射：platform_message_id → {msg, identity}。helper 命中即嵌套 <quoted_message>。 */
export interface QuotedMessageEntry {
  readonly msg: ChannelMessage
  readonly identity: SenderIdentity
}

export interface FormatChannelMessageOpts {
  readonly timezone: string
  readonly now?: Date
  readonly maxLen?: number
  readonly identity: SenderIdentity
  /**
   * 引用原文映射（platform_message_id → 原消息 + 它的 identity）。命中时嵌套渲染
   * `<quoted_message>` 子标签；未命中只输出 reply_to / quote 属性，agent 仍可用
   * `mcp__crab-messaging__get_message` 拉。
   *
   * 调用方负责异步并发预拉（agent-handler 在 buildTriggerUserPrompt 前做），helper
   * 本身无 I/O，保持同步。
   */
  readonly quotedMessages?: ReadonlyMap<string, QuotedMessageEntry>
  /** 嵌套深度（递归保护）。默认 1：当前消息可展开 1 层引用；嵌套消息再嵌套就只出属性。 */
  readonly maxQuoteDepth?: number
}

const QUOTED_MAX_LEN = 180

/**
 * 统一渲染 channel 消息为 XML `<message>` 标签。
 *
 * 输出（属性按存在性增量出现）：
 * ```
 * <message ts="HH:MM" id="..." from="..." from_id="..." identity="..."
 *   [media="image|file"] [media_url="..."] [filename="..."]
 *   [mention="@you"] [mentions="@a,@b"]
 *   [reply_to="..."] [quote="..."] [thread="..."]>
 *   [<quoted_message ...>原文</quoted_message>]
 *   正文
 * </message>
 * ```
 *
 * 设计：所有 ChannelMessage 结构化字段（features / sender / id / content metadata）
 * 都按存在性输出为属性，避免 agent 因 prompt 渲染丢字段而看不到 quote/mention/媒体
 * 引用等语义。早期 markdown 版本用 `> ` 前缀区分引用内容；XML 版本用嵌套
 * `<quoted_message>` 子标签作为等价实现，避免引用内容和正文 markdown 混淆。
 *
 * 内容超过 maxLen 时截断并附 `...[内容截断]`。
 */
export function formatChannelMessageLine(
  msg: ChannelMessage,
  opts: FormatChannelMessageOpts,
): string {
  return renderMessageTag(msg, opts, 'message', opts.maxLen ?? 2000)
}

/** 内部：递归渲染 message 或 quoted_message 标签。 */
function renderMessageTag(
  msg: ChannelMessage,
  opts: FormatChannelMessageOpts,
  tagName: 'message' | 'quoted_message',
  maxLen: number,
): string {
  const { timezone, now, identity, quotedMessages, maxQuoteDepth = 1 } = opts
  const sender = msg.sender.platform_display_name
  const time = msg.platform_timestamp
    ? formatChannelMessageTime(msg.platform_timestamp, timezone, now ?? new Date())
    : ''
  const fullText = formatMessageContent(msg)
  const truncationSuffix = tagName === 'quoted_message'
    ? '...[引用已精简，可按 id 查原文]'
    : '...[内容截断]'
  const truncated = fullText.length > maxLen ? fullText.slice(0, maxLen) + truncationSuffix : fullText
  // 正文里出现 </message> 或 </quoted_message> 都要转义，避免提前闭合外层标签
  const escaped = truncated
    .replace(/<\/message>/g, '&lt;/message&gt;')
    .replace(/<\/quoted_message>/g, '&lt;/quoted_message&gt;')

  // ── 属性按存在性增量拼装 ──
  const attrs: string[] = []
  attrs.push(`ts="${time}"`)
  if (msg.platform_message_id) attrs.push(`id="${escapeAttr(msg.platform_message_id)}"`)
  if (msg.task_id) attrs.push(`task="${escapeAttr(msg.task_id)}"`)
  attrs.push(`from="${escapeAttr(sender)}"`)
  if (msg.sender.platform_user_id) attrs.push(`from_id="${escapeAttr(msg.sender.platform_user_id)}"`)
  attrs.push(`identity="${identity}"`)
  if (msg.content.type !== 'text' && msg.content.type !== 'system_event') {
    attrs.push(`media="${msg.content.type}"`)
  }
  if (msg.content.media_url) attrs.push(`media_url="${escapeAttr(msg.content.media_url)}"`)
  if (msg.content.filename) attrs.push(`filename="${escapeAttr(msg.content.filename)}"`)
  // system_event 单独用 event 属性标记，给 LLM 一眼可识别"这是事件，不是人发的消息"
  if (msg.content.type === 'system_event' && msg.content.event_type) {
    attrs.push(`event="${escapeAttr(msg.content.event_type)}"`)
  }
  if (msg.features.is_mention_crab) attrs.push(`mention="@you"`)
  const mentions = msg.features.mentions
  if (mentions && mentions.length > 0) {
    const list = mentions
      .map((m) => `@${m.display_name ?? m.user_id}`)
      .join(',')
    attrs.push(`mentions="${escapeAttr(list)}"`)
  }
  if (msg.features.reply_to_message_id) attrs.push(`reply_to="${escapeAttr(msg.features.reply_to_message_id)}"`)
  if (msg.features.quote_message_id) attrs.push(`quote="${escapeAttr(msg.features.quote_message_id)}"`)
  if (msg.features.thread_id) attrs.push(`thread="${escapeAttr(msg.features.thread_id)}"`)

  // ── 引用嵌套渲染（depth > 0 + 命中 quotedMessages）──
  let quotedBlock = ''
  const refId = msg.features.reply_to_message_id ?? msg.features.quote_message_id
  if (refId && quotedMessages && maxQuoteDepth > 0) {
    const entry = quotedMessages.get(refId)
    if (entry) {
      const innerOpts: FormatChannelMessageOpts = {
        timezone,
        ...(now !== undefined ? { now } : {}),
        identity: entry.identity,
        ...(quotedMessages !== undefined ? { quotedMessages } : {}),
        maxQuoteDepth: maxQuoteDepth - 1,
      }
      const inner = renderMessageTag(entry.msg, innerOpts, 'quoted_message', QUOTED_MAX_LEN)
      quotedBlock = `\n${inner}`
    }
  }

  return `<${tagName} ${attrs.join(' ')}>${quotedBlock}\n${escaped}\n</${tagName}>`
}

/**
 * 渲染单条短期记忆条目。
 * 输出格式：`- [<相对时间>] (channel=X, session=Y, task=Z) <content 截断>`
 * source 字段尽量给齐：让 LLM 跨 session 解析指代时能直接 cite 到具体的 channel/session。
 */
export function formatShortTermMemoryLine(
  entry: import('./types.js').ShortTermMemoryEntry,
  opts: { timezone: string; now?: Date; maxLen?: number },
): string {
  const { timezone, now, maxLen = 500 } = opts
  const rel = formatRelativeTime(entry.event_time, timezone, now ?? new Date())
  const stamp = rel ? `[${rel}]` : ''
  const sourceParts: string[] = []
  if (entry.source.channel_id) sourceParts.push(`channel=${entry.source.channel_id}`)
  if (entry.source.session_id) sourceParts.push(`session=${entry.source.session_id}`)
  const taskId = entry.refs?.task_id
  if (taskId) sourceParts.push(`task=${taskId}`)
  const sourceTag = sourceParts.length > 0 ? ` (${sourceParts.join(', ')})` : ''
  const fullText = entry.content
  const text = fullText.length > maxLen ? fullText.slice(0, maxLen) + '...[内容截断]' : fullText
  return `- ${stamp}${sourceTag}: ${text}`
}

export class PromptManager {
  /**
   * 组装统一 Agent system prompt。
   * 装配顺序由 src/prompts/assemble-agent.ts 控制。
   *
   * Spec: crabot-docs/superpowers/specs/2026-05-15-agent-unified-loop-redesign-design.md
   */
  assembleAgentPrompt(opts: AssembleAgentPromptOptions): string {
    return assembleAgentPromptImpl(opts)
  }
}
