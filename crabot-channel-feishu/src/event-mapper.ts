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
    image_keys?: string[]
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

/** 飞书事件 file_size / duration 等数值字段可能是 number 或 numeric string，统一容错 */
function coerceNumeric(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined
  if (typeof v !== 'string') return undefined
  const trimmed = v.trim()
  if (!trimmed) return undefined
  const n = Number(trimmed)
  return Number.isFinite(n) ? n : undefined
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
      const parsed = parsePostContent(raw)
      return {
        content: {
          type: parsed.imageKeys.length > 0 ? 'image' : 'text',
          text: applyMentionPlaceholders(parsed.text, mentions),
        },
        features,
        ...(parsed.imageKeys.length > 0 ? { raw: { image_keys: parsed.imageKeys } } : {}),
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
      const file_size = coerceNumeric(raw.file_size)
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
 * 文本拍平为多行；有效 img.image_key 另行收集供 channel 下载，缺 key 才保留占位。
 */
function parsePostContent(post: Record<string, unknown>): { text: string; imageKeys: string[] } {
  const lines: string[] = []
  const imageKeys: string[] = []
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
          const imageKey = typeof seg.image_key === 'string' ? seg.image_key.trim() : ''
          if (imageKey) imageKeys.push(imageKey)
          else segs.push('[图片]')
        }
      }
      if (segs.length > 0) lines.push(segs.join(''))
    }
  }
  return { text: lines.join('\n'), imageKeys }
}

export function parsePostText(post: Record<string, unknown>): string {
  return parsePostContent(post).text
}

export function detectMentionCrab(mentions: FeishuMention[], botOpenId: string | undefined | null): boolean {
  if (!botOpenId || !mentions.length) return false
  return mentions.some((m) => m.id?.open_id === botOpenId)
}

/**
 * 内联替换：把 text 中出现的 at_name（如 "@徐倩"）替换为 Feishu @mention 标签。
 * 有 at_name 且在文中找到 → 做替换；找不到或无 at_name → 放入 unmatched，由调用方决定是否末尾追加。
 * - text 消息：<at user_id="ou_xxx"></at>
 * - card markdown：<at id="ou_xxx"></at>
 */
export function replaceMentionsInline(
  text: string,
  mentions: Array<{ open_id: string; at_name?: string }>,
  mode: 'text' | 'card',
): { text: string; unmatched: Array<{ open_id: string }> } {
  let result = text
  const unmatched: Array<{ open_id: string }> = []
  for (const m of mentions) {
    if (!m.at_name) {
      unmatched.push({ open_id: m.open_id })
      continue
    }
    const tag =
      mode === 'card'
        ? `<at id="${m.open_id}"></at>`
        : `<at user_id="${m.open_id}"></at>`
    const escaped = m.at_name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const replaced = result.replace(new RegExp(escaped, 'g'), tag)
    if (replaced === result) {
      // at_name 在正文里找不到，降级为末尾追加
      unmatched.push({ open_id: m.open_id })
    } else {
      result = replaced
    }
  }
  return { text: result, unmatched }
}

/**
 * 在 text 末尾追加 @mention 标签（无 at_name 的纯通知场景，或内联替换兜底）。
 * - text 消息：<at user_id="ou_xxx"></at>
 * - card markdown：<at id="ou_xxx"></at>
 */
export function injectMentionTags(
  text: string,
  mentions: Array<{ open_id: string }>,
  mode: 'text' | 'card' = 'text',
): string {
  if (!mentions.length) return text
  const tags = mentions
    .map((m) =>
      mode === 'card'
        ? `<at id="${m.open_id}"></at>`
        : `<at user_id="${m.open_id}"></at>`,
    )
    .join(' ')
  return text + (text.endsWith(' ') || text === '' ? '' : ' ') + tags
}
