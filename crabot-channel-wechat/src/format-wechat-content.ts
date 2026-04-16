/**
 * format-wechat-content.ts
 *
 * 将 wechat-connector 结构化 content 转为 Crabot MessageContent + MessageFeatures。
 * 入站消息处理和 get_history/get_message 代理共用此逻辑。
 *
 * wechat-connector MessageType 枚举值参考:
 *   0=TEXT, 1=IMAGE, 2=VOICE, 3=CARD, 4=TRANSFER, 5=RED_PACKET,
 *   9=FILE, 10=VIDEO, 11=LINK, 15=MINI_PROGRAM, 17=PAT_PAT,
 *   18=QUOTE, 20=APP_MSG, 34=VOICE, 42=CARD, 43=VIDEO, 47=EMOJI
 */

import type { MessageContent, MessageFeatures, MessageType } from './types.js'

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
    case 9:
    case 1090519089: {
      const fileName = s('file_name') ?? '未知文件'
      const fileUrl = s('file_url')
      const content: MessageContent = {
        type: 'file',
        text: fileName,
        ...(fileUrl ? { media_url: fileUrl } : {}),
        filename: fileName,
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

      const parts: string[] = []
      if (quotedSender || quotedContent) {
        const attribution = quotedSender ? `${quotedSender}: ` : ''
        parts.push(`> ${attribution}${quotedContent ?? '[消息]'}`)
        parts.push('')  // blank line after blockquote
      }
      parts.push(text)

      return {
        content: { type: 'text', text: parts.join('\n') },
        features: {
          ...(quotedSvrId ? { quote_message_id: quotedSvrId } : {}),
        },
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
