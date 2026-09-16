/**
 * format-wechat-content.ts
 *
 * 将 wechat-connector 结构化 content 转为 Crabot MessageContent + MessageFeatures。
 * 入站消息处理和 get_history/get_message 代理共用此逻辑。
 *
 * 主路径——connector 推送的 `message.type` 是 MessageType 枚举（参 BOT_INTEGRATION.md §消息类型）：
 *   0=TEXT, 1=IMAGE, 2=VOICE_2, 3=CARD_3, 4=TRANSFER, 5=RED_PACKET, 6=SYSTEM,
 *   9=FILE_9, 10=VIDEO_10, 11=LINK, 13=CHANNEL_VIDEO, 15=MINI_PROGRAM, 17=PAT_PAT, 18=QUOTE, 20=APP_MSG
 *
 * 兼容路径——历史上 puppet 上报时可能直接传微信原始 field_type，下面 case 里多出来的
 *   34=VOICE / 42=CARD / 43=VIDEO / 47=EMOJI / 1090519089=FILE / 10000/10002=SYSTEM
 * 都是这种兼容性兜底，主路径不会走到。
 */

import type { MessageContent, MessageFeatures, MessageType } from './types.js'

/**
 * 调试用：把 raw object 里的非空 string 字段 (key=value) 列出来，截断每个 value 到 200 字符避免日志爆。
 * 用于 console.warn 「未识别字段」场景，方便回查 wechat-connector 协议字段名。
 */
function dumpRawForDebug(raw: Record<string, unknown>): string {
  const lines: string[] = []
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === 'string' && v.trim()) {
      const val = v.length > 200 ? v.slice(0, 200) + '...[截断]' : v
      lines.push(`${k}=${JSON.stringify(val)}`)
    } else if (typeof v === 'number' || typeof v === 'boolean') {
      lines.push(`${k}=${v}`)
    } else if (v && typeof v === 'object') {
      lines.push(`${k}=<${Array.isArray(v) ? `array(${v.length})` : `object(keys=${Object.keys(v).join(',')})`}>`)
    }
  }
  return `{ ${lines.join(', ')} }`
}

export interface FormattedMessage {
  content: MessageContent
  features: Partial<MessageFeatures>
}

/**
 * 将 wechat-connector 的结构化 content + fieldType 转为 Crabot 格式
 */
export function formatWechatContent(
  fieldType: number,
  raw: Record<string, unknown>,
): FormattedMessage {
  const s = (key: string): string | undefined => {
    const v = raw[key]
    return typeof v === 'string' && v.trim() ? v.trim() : undefined
  }

  switch (fieldType) {
    // ── 文本 ──
    case 0: {
      return textMsg(s('text') ?? '')
    }

    // ── 图片 ──
    case 1: {
      return {
        content: {
          type: 'image',
          text: '',
          media_url: s('resource_url'),
        },
        features: {},
      }
    }

    // ── 语音 (2, 34) ──
    case 2:
    case 34: {
      return textMsg('[语音消息]')
    }

    // ── 名片 (3, 42) ──
    case 3:
    case 42: {
      const nickname = s('nickname') ?? '未知'
      const alias = s('alias')
      const detail = alias ? `${nickname} (微信号: ${alias})` : nickname
      return textMsg(`**名片**: ${detail}`)
    }

    // ── 转账 ──
    case 4: {
      const amount = s('money_amount') ?? '?'
      const desc = s('money_desc')
      return textMsg(desc ? `**转账** ¥${amount}: ${desc}` : `**转账** ¥${amount}`)
    }

    // ── 红包 ──
    case 5: {
      const desc = s('money_desc')
      return textMsg(desc ? `**红包**: ${desc}` : '**红包**')
    }

    // ── 文件 (9, 1090519089) ──
    // 参 BOT_INTEGRATION.md §「入站文件消息（type=9）的字段保证与降级」：
    //   - 主路径：connector 在 emit 前会主动下发 down_file 任务让 puppet 下载并上传图床，
    //     ack 回来后 emit，此时 content 含 file_url (string) + file_name (string) + file_size (number)
    //   - envelope 兜底：file_name 优先 ack 回执，否则取 puppet 原始上报的 `text`（文件名）；
    //                    file_size 优先 ack 回执，否则从 `describe`（字节数字符串）转 number
    //   - 60s 超时降级：file_url 缺失，但 file_name + file_size 会被 connector 主动回填
    // type=1090519089 (FILE) 是历史微信原始 type，connector 走同一套字段补齐流程。
    case 9:
    case 1090519089: {
      const fileName = s('file_name') ?? s('text')
      const fileUrl = s('file_url')
      // file_size 是 number 类型（ack 回执填的），envelope 兜底从 describe 字符串转
      const rawFileSize = raw.file_size
      const fileSize: number | undefined =
        typeof rawFileSize === 'number' && Number.isFinite(rawFileSize)
          ? rawFileSize
          : (() => {
              const d = s('describe')
              return d && /^\d+$/.test(d) ? Number(d) : undefined
            })()
      if (!fileName) {
        console.warn(
          `[format-wechat-content] case ${fieldType} 文件消息字段未识别，raw=${dumpRawForDebug(raw)}`
        )
      }
      const resolvedName = fileName ?? '未知文件'
      const content: MessageContent = {
        type: 'file',
        text: resolvedName,
        ...(fileUrl ? { media_url: fileUrl } : {}),
        filename: resolvedName,
        ...(fileSize !== undefined ? { size: fileSize } : {}),
      }
      return { content, features: {} }
    }

    // ── 视频 (10, 43) ──
    case 10:
    case 43: {
      const videoUrl = s('video_url')
      const content: MessageContent = videoUrl
        ? { type: 'file', text: '视频', media_url: videoUrl, mime_type: 'video/mp4' }
        : { type: 'text', text: '[视频消息]' }
      return { content, features: {} }
    }

    // ── 链接 (11) ──
    case 11: {
      const title = s('title') ?? '链接'
      const url = s('url') ?? s('addUrl')
      const describe = s('describe')
      const parts: string[] = []
      parts.push(url ? `[${title}](${url})` : `**${title}**`)
      if (describe) parts.push(describe)
      return textMsg(parts.join('\n\n'))
    }

    // ── 视频号卡片 (13)：只呈现元信息，不将加密视频登记为可下载媒体 ──
    case 13: {
      const feed = raw.finderFeed
      if (!isRecord(feed)) return textMsg('[视频号卡片]\n上游未提供媒体详情。')
      const nickname = typeof feed.nickname === 'string' ? feed.nickname.trim() : ''
      const description = typeof feed.desc === 'string' ? feed.desc.trim() : ''
      const media = Array.isArray(feed.mediaList) ? feed.mediaList : []
      const isVideo = media.some(item => isRecord(item) && item.mediaType === 4)
      const parts = [isVideo ? '[视频号视频]' : '[视频号卡片]']
      if (nickname) parts.push(`作者：${nickname}`)
      if (description) parts.push(`描述：${description}`)
      if (typeof feed.mediaCount === 'number' && Number.isSafeInteger(feed.mediaCount) && feed.mediaCount >= 0) {
        parts.push(`媒体数量：${feed.mediaCount}`)
      }
      media.forEach((item, index) => {
        if (!isRecord(item) || item.mediaType !== 4) return
        const prefix = media.length > 1 ? `媒体 ${index + 1} ` : ''
        if (isPositiveNumber(item.videoPlayDuration)) parts.push(`${prefix}时长：${item.videoPlayDuration} 秒`)
        if (isPositiveNumber(item.width) && isPositiveNumber(item.height)) {
          parts.push(`${prefix}尺寸：${item.width}×${item.height}`)
        }
      })
      parts.push(parts.length > 1 || isVideo
        ? '以上为卡片元信息；视频画面和音频尚未读取。'
        : '上游未提供媒体详情。')
      return textMsg(parts.join('\n'))
    }

    // ── 小程序 (15) ──
    case 15: {
      const title = s('title') ?? '小程序'
      const des = s('des')
      const redirectUrl = s('redirectUrl')
      const parts: string[] = []
      parts.push(redirectUrl ? `[${title}](${redirectUrl})` : `**${title}**`)
      if (des) parts.push(des)
      return textMsg(parts.join('\n\n'))
    }

    // ── 拍一拍 (17) ──
    case 17: {
      return textMsg(s('text') ?? '[拍一拍]')
    }

    // ── 引用/回复 (18) ──
    case 18: {
      const text = s('text') ?? ''
      const quotedSender = s('quoted_sender_name')
      const quotedContent = s('quoted_content')
      const quotedSvrId = s('quoted_svr_id')
      const quotedResourceUrl = s('quoted_resource_url')
      const quotedMsgType = typeof raw.quoted_msg_type === 'number' ? raw.quoted_msg_type : undefined

      const parts: string[] = []
      if (quotedSender || quotedContent) {
        const attribution = quotedSender ? `${quotedSender}: ` : ''
        parts.push(`> ${attribution}${quotedContent ?? '[消息]'}`)
        parts.push('')  // blank line after blockquote
      }
      parts.push(text)
      const composedText = parts.join('\n')

      const features: Partial<MessageFeatures> = quotedSvrId
        ? { quote_message_id: quotedSvrId }
        : {}

      // 当被引用消息携带 resource URL 时，把 content 升级为对应媒体类型，
      // 使 Agent 端的 media-resolver 能下载并喂给 LLM（仅 image 会真正进 ImageBlock，
      // file 至少把 URL 透传给 Agent，便于工具下载）。
      // quoted_msg_type 是微信原始 type：1=图片、47=表情、3/42=名片缩略、10/43=视频。
      if (quotedResourceUrl && quotedMsgType !== undefined) {
        if (quotedMsgType === 1 || quotedMsgType === 47 || quotedMsgType === 3 || quotedMsgType === 42) {
          return {
            content: { type: 'image', text: composedText, media_url: quotedResourceUrl },
            features,
          }
        }
        if (quotedMsgType === 10 || quotedMsgType === 43) {
          return {
            content: { type: 'file', text: composedText, media_url: quotedResourceUrl, mime_type: 'video/mp4' },
            features,
          }
        }
      }

      return {
        content: { type: 'text', text: composedText },
        features,
      }
    }

    // ── 应用消息/聊天记录 (20) ──
    case 20: {
      const title = s('title')
      const describe = s('describe')
      const text = s('text')
      if (title) {
        const parts: string[] = [`**${title}**`]
        if (describe) parts.push(describe)
        return textMsg(parts.join('\n\n'))
      }
      return textMsg(text ?? '[应用消息]')
    }

    // ── 表情 (47) ──
    case 47: {
      return textMsg('[表情]')
    }

    // ── 系统消息 (6, 10000, 10002) ──
    case 6:
    case 10000:
    case 10002: {
      return textMsg('[系统消息]')
    }

    // ── 未知类型 ──
    default: {
      const text = s('text')
      if (text) return textMsg(text)
      console.warn(
        `[format-wechat-content] 未识别消息类型 fieldType=${fieldType}, raw=${dumpRawForDebug(raw)}`
      )
      return textMsg(`[未知消息类型: ${fieldType}]`)
    }
  }
}

function textMsg(text: string): FormattedMessage {
  return {
    content: { type: 'text' as MessageType, text },
    features: {},
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isPositiveNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}
