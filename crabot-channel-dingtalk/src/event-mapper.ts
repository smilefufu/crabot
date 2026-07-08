/**
 * event-mapper - 钉钉 Stream 消息 → Crabot 协议数据结构
 *
 * 关注点：
 * - mapMessageContent: 把钉钉 msgtype + payload 转成 Crabot 的 MessageContent + features
 * - detectMentionCrab: 判断本条消息是否 @ 了机器人（优先用平台给的 isInAtList）
 * - flattenRichText: 把钉钉 richText 数组拍平为纯文本
 * - buildMentionsList: 把 atUsers 拍成 Crabot MessageMention[]
 *
 * 注意：mapper 不带网络副作用。picture / file 的真正下载在 dingtalk-channel.ts
 * 处理事件时调 client（这里只把 downloadCode 放进 raw 供后续下载）。
 */

import type {
  DingtalkInboundMessage,
  DingtalkAtUser,
  DingtalkRichTextItem,
  MessageContent,
  MessageFeatures,
  MessageMention,
} from './types.js'

/** 钉钉侧附加结构（downloadCode 等），由 channel 层用于后续下载 */
export interface DingtalkMappedRaw {
  download_code?: string
  filename?: string
  file_size?: number
}

export interface MappedMessage {
  content: MessageContent
  features: Pick<MessageFeatures, 'mentions'>
  raw?: DingtalkMappedRaw
}

const FALLBACK_PLACEHOLDERS: Record<string, string> = {
  audio: '[语音]',
  video: '[视频]',
  voice: '[语音]',
  sticker: '[表情]',
  location: '[位置]',
  link: '[链接]',
  actionCard: '[卡片]',
  feedCard: '[卡片]',
}

/** 数值字段可能是 number 或 numeric string，统一容错 */
function coerceNumeric(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined
  if (typeof v !== 'string') return undefined
  const trimmed = v.trim()
  if (!trimmed) return undefined
  const n = Number(trimmed)
  return Number.isFinite(n) ? n : undefined
}

/** atUsers → Crabot MessageMention[]；friend_id 留空由 Admin 鉴权回填 */
export function buildMentionsList(atUsers?: DingtalkAtUser[]): MessageMention[] {
  return (atUsers ?? [])
    .map((a) => a.staffId ?? a.dingtalkId ?? '')
    .filter((id) => !!id)
    .map((id) => ({ friend_id: '', platform_user_id: id }))
}

/**
 * 钉钉 richText 是数组，元素形如 { text } 或 { type:'picture', downloadCode }。
 * 拍平为纯文本：文本原样拼接，图片元素替换为 [图片]。
 */
export function flattenRichText(items?: DingtalkRichTextItem[]): string {
  if (!Array.isArray(items)) return ''
  const parts: string[] = []
  for (const item of items) {
    if (!item || typeof item !== 'object') continue
    if (typeof item.text === 'string' && item.text) {
      parts.push(item.text)
    } else if (item.downloadCode || item.pictureDownloadCode || item.type === 'picture') {
      parts.push('[图片]')
    }
  }
  return parts.join('')
}

export function mapMessageContent(msg: DingtalkInboundMessage): MappedMessage {
  const features: Pick<MessageFeatures, 'mentions'> = {}
  const ml = buildMentionsList(msg.atUsers)
  if (ml.length > 0) features.mentions = ml

  switch (msg.msgtype) {
    case 'text': {
      const text = typeof msg.text?.content === 'string' ? msg.text.content : ''
      return { content: { type: 'text', text: text.trim() }, features }
    }
    case 'markdown': {
      const md = msg.markdown
      const text = [md?.title, md?.text].filter((s) => typeof s === 'string' && s).join('\n')
      return { content: { type: 'text', text }, features }
    }
    case 'richText': {
      // 真机实测：richText 在 content.richText。含图片元素 → 当图片消息（取 downloadCode 供 VLM/下载）；
      // 纯文本 richText → 拍平为文本。
      const items = msg.content?.richText ?? []
      const pic = items.find(
        (it) => it && (it.type === 'picture' || !!it.downloadCode || !!it.pictureDownloadCode),
      )
      if (pic) {
        const downloadCode = pic.downloadCode ?? pic.pictureDownloadCode
        return { content: { type: 'image' }, features, raw: { download_code: downloadCode } }
      }
      return { content: { type: 'text', text: flattenRichText(items) }, features }
    }
    case 'picture': {
      const downloadCode = msg.content?.downloadCode
      return {
        content: { type: 'image' },
        features,
        raw: { download_code: downloadCode },
      }
    }
    case 'file': {
      const downloadCode = msg.content?.downloadCode
      const filename =
        typeof msg.content?.fileName === 'string' ? msg.content.fileName : undefined
      const fileSize = coerceNumeric(msg.content?.fileSize)
      return {
        content: { type: 'file', filename, size: fileSize },
        features,
        raw: { download_code: downloadCode, filename, file_size: fileSize },
      }
    }
    default: {
      const placeholder =
        FALLBACK_PLACEHOLDERS[msg.msgtype] ?? `[不支持的消息类型: ${msg.msgtype}]`
      return { content: { type: 'text', text: placeholder }, features }
    }
  }
}

/**
 * 判断本条消息是否 @ 了机器人。
 * 优先用钉钉平台直接给的 isInAtList（该条消息是否 @ 到本机器人）；
 * 兜底：atUsers 里出现 chatbotUserId（少见，钉钉 atUsers 通常给 staffId/dingtalkId）。
 */
export function detectMentionCrab(msg: DingtalkInboundMessage): boolean {
  if (msg.isInAtList === true) return true
  if (!msg.chatbotUserId || !Array.isArray(msg.atUsers)) return false
  return msg.atUsers.some(
    (a) => a.staffId === msg.chatbotUserId || a.dingtalkId === msg.chatbotUserId
  )
}
