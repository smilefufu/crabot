/**
 * MsgConverter - 消息格式转换
 *
 * - MsgContext → ChannelMessage（入站）
 * - MessageContent → ReplyPayload（出站）
 */

import { randomUUID } from 'node:crypto'
import type {
  MsgContext,
  MessageContent,
  MessageType,
  ReplyPayload,
  ChannelMessage,
  Session,
  ModuleId,
} from './types.js'

// ============================================================================
// 入站：MsgContext → ChannelMessage
// ============================================================================

/**
 * 将 OpenClaw MsgContext 转换为 Crabot ChannelMessage
 */
export function msgContextToChannelMessage(
  ctx: MsgContext,
  sessionId: string,
  session: Session,
  channelId: ModuleId
): ChannelMessage {
  const platformUserId = ctx.SenderId ?? 'unknown'
  const displayName = ctx.SenderName ?? ctx.SenderUsername ?? platformUserId

  // 检测媒体内容（由 OpenClaw 插件 buildAgentMediaPayload 设置）
  const mediaPath = ctx.MediaPath ?? ctx.MediaUrl
  const mimeType = ctx.MediaType
  const hasMedia = !!mediaPath
  const contentType: MessageType = hasMedia
    ? (mimeType?.startsWith('image/') ? 'image' : 'file')
    : 'text'

  return {
    platform_message_id: ctx.MessageId ?? randomUUID(),
    session: {
      session_id: sessionId,
      channel_id: channelId,
      type: session.type,
    },
    sender: {
      platform_user_id: platformUserId,
      platform_display_name: displayName,
    },
    content: {
      type: contentType,
      // RawBody 是未经格式化的原始内容（如 "/pair"），Body 是经插件处理后含前缀的内容
      // （如 "张三: /pair"）。Admin 鉴权网关需要原始内容做命令检测，优先取 RawBody。
      text: ctx.RawBody ?? ctx.Body ?? '',
      ...(hasMedia && {
        media_url: mediaPath,
        mime_type: mimeType,
      }),
    },
    features: {
      is_mention_crab: ctx.WasMentioned ?? false,
    },
    platform_timestamp: new Date().toISOString(),
  }
}

// ============================================================================
// 出站：MessageContent → ReplyPayload
// ============================================================================

/**
 * 将 Crabot MessageContent 转换为 OpenClaw ReplyPayload
 */
export function messageContentToReplyPayload(content: MessageContent): ReplyPayload {
  if (content.type === 'text') {
    return { text: content.text ?? '' }
  }

  if (content.type === 'image' || content.type === 'file') {
    if (content.media_url) {
      return { mediaUrl: content.media_url, filename: content.filename }
    }
    if (content.file_path) {
      return { mediaUrl: content.file_path, filename: content.filename }
    }
  }

  // 不支持的消息类型，降级为文本
  return { text: '[unsupported message type]' }
}
