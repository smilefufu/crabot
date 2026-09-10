/**
 * Agent 与 Manager 共用的引用消息异步预拉 helper；不改变调用方的任务或会话语义。
 *
 * 早期 prompt 渲染走 markdown，引用内容用 `> ` 前缀区分以避免和正文 markdown 混淆；
 * 现在统一到 XML <message> 标签后，等价做法是嵌套 <quoted_message> 子标签。但要做到
 * 嵌套，渲染前必须知道引用原文的内容——本 helper 负责在 prompt 拼装前并发预拉。
 *
 * 流程：
 * 1. 扫描 messages 收集 reply_to_message_id ∪ quote_message_id
 * 2. 命中 alreadyKnown 或 messages 自身的不拉（避免无谓 RPC）
 * 3. 剩下的并发调 channel.get_message RPC
 * 4. 单条拉失败仅跳过该条（不影响主流程）；helper 整体只可能返回部分结果
 *
 * 渲染层（formatChannelMessageLine）拿不到对应 entry 时只输出 reply_to / quote 属性，
 * agent 仍能通过 mcp__crab-messaging__get_message 工具补救——双层兜底。
 */

import type { ChannelMessage } from '../types.js'
import type { QuotedMessageEntry } from '../prompt-manager.js'
import type { SenderIdentity } from '../utils/sender-identity.js'
import type { RpcClient } from 'crabot-shared'

export interface PrefetchQuotedDeps {
  readonly rpcClient: RpcClient
  readonly moduleId: string
  readonly resolveChannelPort: (channelId: string) => Promise<number>
}

/** channel.get_message RPC 响应（参 protocol-channel.md §3.4 HistoryMessage） */
interface GetMessageResult {
  platform_message_id: string
  sender: { platform_user_id: string; platform_display_name: string }
  content: { type: string; text?: string; media_url?: string; filename?: string; mime_type?: string; size?: number; media?: Array<{ media_url: string; mime_type: string; filename?: string; size?: number }> }
  features: {
    is_mention_crab?: boolean
    mentions?: Array<{ user_id: string; display_name?: string }>
    quote_message_id?: string
    reply_to_message_id?: string
    thread_id?: string
  }
  platform_timestamp: string
}

/**
 * 收集 messages 中所有 reply_to / quote 引用，扣除 alreadyKnown 已可见的，剩余并发拉。
 *
 * @param messages 待渲染的当前消息（trigger 批次 / current 消息）
 * @param alreadyKnown 上下文中已经在 prompt 里渲染的消息（如 recent_messages），命中即跳过 RPC
 * @param channelId 当前 session 所在 channel（用于 resolveChannelPort）
 * @param sessionId 当前 session（get_message RPC 需要）
 * @param deps RPC 调用依赖
 * @param identityResolver 给每条已拉到的消息推断 identity（caller 通常注入 resolveSenderIdentity 闭包）
 */
export async function prefetchQuotedMessages(
  messages: ReadonlyArray<ChannelMessage>,
  alreadyKnown: ReadonlyArray<ChannelMessage>,
  channelId: string,
  sessionId: string,
  sessionType: 'private' | 'group',
  deps: PrefetchQuotedDeps,
  identityResolver: (msg: ChannelMessage) => SenderIdentity,
): Promise<Map<string, QuotedMessageEntry>> {
  const wanted = new Set<string>()
  for (const m of messages) {
    if (m.features.reply_to_message_id) wanted.add(m.features.reply_to_message_id)
    if (m.features.quote_message_id) wanted.add(m.features.quote_message_id)
  }
  if (wanted.size === 0) return new Map()

  // 命中本地已可见的（不拉），并直接 fold 进结果
  const result = new Map<string, QuotedMessageEntry>()
  const localPool: ChannelMessage[] = [...alreadyKnown, ...messages]
  for (const m of localPool) {
    if (wanted.has(m.platform_message_id)) {
      if (!result.has(m.platform_message_id)) {
        result.set(m.platform_message_id, { msg: m, identity: identityResolver(m) })
      }
      wanted.delete(m.platform_message_id)
    }
  }
  if (wanted.size === 0) return result

  // 剩下的并发 RPC 拉
  let channelPort: number
  try {
    channelPort = await deps.resolveChannelPort(channelId)
  } catch {
    return result // channel 不可用——只能放弃 RPC 路径，已经命中的还可以用
  }
  if (!channelPort) return result

  const fetched = await Promise.allSettled(
    [...wanted].map(async (msgId) => {
      const res = await deps.rpcClient.call<
        { session_id: string; platform_message_id: string },
        GetMessageResult
      >(channelPort, 'get_message', {
        session_id: sessionId,
        platform_message_id: msgId,
      }, deps.moduleId)
      return { msgId, res }
    }),
  )

  for (const r of fetched) {
    if (r.status !== 'fulfilled') continue
    const { msgId, res } = r.value
    const msg: ChannelMessage = {
      platform_message_id: res.platform_message_id,
      session: { session_id: sessionId, channel_id: channelId, type: sessionType },
      sender: {
        platform_user_id: res.sender.platform_user_id,
        platform_display_name: res.sender.platform_display_name,
      },
      content: {
        type: (res.content.type as ChannelMessage['content']['type']) ?? 'text',
        ...(res.content.text !== undefined ? { text: res.content.text } : {}),
        ...(res.content.media_url !== undefined ? { media_url: res.content.media_url } : {}),
        ...(res.content.filename !== undefined ? { filename: res.content.filename } : {}),
        ...(res.content.mime_type !== undefined ? { mime_type: res.content.mime_type } : {}),
        ...(res.content.size !== undefined ? { size: res.content.size } : {}),
        ...(res.content.media !== undefined ? { media: res.content.media } : {}),
      },
      features: {
        is_mention_crab: res.features.is_mention_crab ?? false,
        ...(res.features.mentions !== undefined ? { mentions: res.features.mentions } : {}),
        ...(res.features.quote_message_id !== undefined ? { quote_message_id: res.features.quote_message_id } : {}),
        ...(res.features.reply_to_message_id !== undefined ? { reply_to_message_id: res.features.reply_to_message_id } : {}),
        ...(res.features.thread_id !== undefined ? { thread_id: res.features.thread_id } : {}),
      },
      platform_timestamp: res.platform_timestamp,
    }
    result.set(msgId, { msg, identity: identityResolver(msg) })
  }

  return result
}
