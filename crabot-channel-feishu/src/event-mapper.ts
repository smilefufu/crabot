/**
 * event-mapper - 飞书事件 → Crabot 协议数据结构
 *
 * 关注点：
 * - mapMessageContent: 把飞书 message_type + content JSON 字符串转成 Crabot 的 MessageContent + features
 * - detectMentionCrab: 在 mentions 数组中查找 bot 的 open_id
 * - parsePostText: 把飞书 rich-text 'post' 拍平为纯文本
 * - injectMentionTags: 发送时把 mention open_id 列表拼成 <at> 标签
 *
 * 注意：mapper 不带网络副作用。image / file 的真正下载在 feishu-channel.ts 处理事件时调 client。
 */

import type {
  FeishuMention,
  MessageContent,
  MessageFeatures,
  MessageMention,
} from './types.js'

export interface MappedMessage {
  content: MessageContent
  features: Pick<MessageFeatures, 'mentions'>
  /** 飞书侧附加结构（image_key / file_key 等），由 channel 层用于后续下载 */
  raw?: {
    image_key?: string
    file_key?: string
    filename?: string
    file_size?: number
  }
}

const FALLBACK_PLACEHOLDERS: Record<string, string> = {
  audio: '[语音]',
  video: '[视频]',
  sticker: '[表情]',
  share_chat: '[分享会话]',
  share_user: '[分享名片]',
  merge_forward: '[合并转发]',
  hongbao: '[红包]',
  calendar: '[日历邀请]',
  todo: '[任务]',
}

function safeParseContent(content: string): Record<string, unknown> {
  try {
    return JSON.parse(content) as Record<string, unknown>
  } catch {
    return {}
  }
}

/** 把 mentions 数组里的 @_user_X 占位符替换为 @Name；保留未匹配的占位符不动 */
function applyMentionPlaceholders(text: string, mentions: FeishuMention[]): string {
  if (!mentions.length) return text
  let out = text
  for (const m of mentions) {
    const replaceWith = `@${m.name}`
    out = out.split(m.key).join(replaceWith)
  }
  return out
}

function buildMentionsList(mentions: FeishuMention[]): MessageMention[] {
  return mentions
    .map((m) => m.id?.open_id ?? '')
    .filter((id) => !!id)
    .map((openId) => ({ friend_id: '', platform_user_id: openId }))
}

export function mapMessageContent(
  msgType: string,
  contentJson: string,
  mentions: FeishuMention[]
): MappedMessage {
  const raw = safeParseContent(contentJson)

  const features: Pick<MessageFeatures, 'mentions'> = {}
  const ml = buildMentionsList(mentions)
  if (ml.length > 0) features.mentions = ml

  switch (msgType) {
    case 'text': {
      const text = typeof raw.text === 'string' ? raw.text : ''
      return {
        content: { type: 'text', text: applyMentionPlaceholders(text, mentions) },
        features,
      }
    }
    case 'post': {
      const flat = parsePostText(raw)
      return {
        content: { type: 'text', text: applyMentionPlaceholders(flat, mentions) },
        features,
      }
    }
    case 'image': {
      const image_key = (raw.image_key as string | undefined) ?? ''
      return {
        content: { type: 'image' },
        features,
        raw: { image_key },
      }
    }
    case 'file': {
      const file_key = (raw.file_key as string | undefined) ?? ''
      const filename = (raw.file_name as string | undefined) ?? undefined
      // 飞书事件的 file_size 可能是 number 或 numeric string，两种都接受
      const sizeRaw = raw.file_size
      const file_size =
        typeof sizeRaw === 'number'
          ? sizeRaw
          : typeof sizeRaw === 'string' && sizeRaw.length > 0 && Number.isFinite(Number(sizeRaw))
            ? Number(sizeRaw)
            : undefined
      return {
        content: {
          type: 'file',
          filename,
          size: file_size,
        },
        features,
        raw: { file_key, filename, file_size },
      }
    }
    case 'audio': {
      const ms = typeof raw.duration === 'number' ? raw.duration : 0
      const seconds = Math.round(ms / 1000)
      return {
        content: { type: 'text', text: `[语音] (${seconds}s)` },
        features,
      }
    }
    case 'video': {
      const ms = typeof raw.duration === 'number' ? raw.duration : 0
      const seconds = Math.round(ms / 1000)
      return {
        content: { type: 'text', text: `[视频] (${seconds}s)` },
        features,
      }
    }
    case 'location': {
      const name = (raw.name as string | undefined) ?? ''
      return {
        content: { type: 'text', text: `[位置] ${name}`.trim() },
        features,
      }
    }
    default: {
      const placeholder = FALLBACK_PLACEHOLDERS[msgType] ?? `[不支持的消息类型: ${msgType}]`
      return {
        content: { type: 'text', text: placeholder },
        features,
      }
    }
  }
}

/**
 * 飞书 post 消息有结构：
 *   { title, content: [[ {tag,text|...}, ... ], ...] }
 * 这里把它拍平为多行文本，链接用 text + 'href'，at 用 '@user_name'。
 */
export function parsePostText(post: Record<string, unknown>): string {
  const lines: string[] = []
  const title = post.title
  if (typeof title === 'string' && title.trim()) lines.push(title)

  const content = post.content
  if (Array.isArray(content)) {
    for (const row of content) {
      if (!Array.isArray(row)) continue
      const segs: string[] = []
      for (const seg of row as Array<Record<string, unknown>>) {
        if (!seg || typeof seg !== 'object') continue
        const tag = (seg.tag as string | undefined) ?? ''
        if (tag === 'text') {
          segs.push((seg.text as string | undefined) ?? '')
        } else if (tag === 'a') {
          const text = (seg.text as string | undefined) ?? ''
          segs.push(text)
        } else if (tag === 'at') {
          const userName = (seg.user_name as string | undefined) ?? (seg.user_id as string | undefined) ?? ''
          segs.push(userName ? `@${userName}` : '')
        } else if (tag === 'img') {
          segs.push('[图片]')
        }
      }
      if (segs.length > 0) lines.push(segs.join(''))
    }
  }
  return lines.join('\n')
}

export function detectMentionCrab(mentions: FeishuMention[], botOpenId: string | undefined | null): boolean {
  if (!botOpenId || !mentions.length) return false
  return mentions.some((m) => m.id?.open_id === botOpenId)
}

/**
 * 在 text 末尾追加 <at user_id="ou_xxx"></at>，用于发送侧 mention。
 * 飞书原生 text 协议允许嵌入 <at> 标签实现 @用户。
 */
export function injectMentionTags(text: string, mentions: Array<{ open_id: string }>): string {
  if (!mentions.length) return text
  const tags = mentions.map((m) => `<at user_id="${m.open_id}"></at>`).join(' ')
  return text + (text.endsWith(' ') || text === '' ? '' : ' ') + tags
}
