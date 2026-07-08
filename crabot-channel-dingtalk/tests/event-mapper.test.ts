/**
 * event-mapper 单元测试（纯函数，无网络副作用）
 */

import { describe, it, expect } from 'vitest'
import {
  mapMessageContent,
  detectMentionCrab,
  flattenRichText,
  buildMentionsList,
  resolveSenderId,
} from '../src/event-mapper'
import type { DingtalkInboundMessage } from '../src/types'

function baseMsg(overrides: Partial<DingtalkInboundMessage>): DingtalkInboundMessage {
  return {
    conversationId: 'cidxxxx',
    conversationType: '1',
    chatbotUserId: 'bot-user-1',
    senderStaffId: 'staff_alice',
    senderNick: 'Alice',
    robotCode: 'robot-1',
    msgId: 'msg-1',
    msgtype: 'text',
    createAt: 1730000000000,
    ...overrides,
  }
}

describe('mapMessageContent', () => {
  it('maps text', () => {
    const m = mapMessageContent(baseMsg({ msgtype: 'text', text: { content: '  hello  ' } }))
    expect(m.content).toEqual({ type: 'text', text: 'hello' })
    expect(m.raw).toBeUndefined()
  })

  it('maps markdown to text (title + body)', () => {
    const m = mapMessageContent(
      baseMsg({ msgtype: 'markdown', markdown: { title: '标题', text: '**正文**' } })
    )
    expect(m.content.type).toBe('text')
    expect(m.content.text).toBe('标题\n**正文**')
  })

  it('maps richText containing a picture to an image (download_code from content.richText)', () => {
    // 真机实测形态：群里发图 + @ → msgtype richText，图片元素在 content.richText
    const m = mapMessageContent(
      baseMsg({
        msgtype: 'richText',
        content: {
          richText: [
            { pictureDownloadCode: 'pdc1', downloadCode: 'dc1', type: 'picture' },
            { text: '\n' },
            { text: '@crabot' },
          ],
        },
      })
    )
    expect(m.content.type).toBe('image')
    expect(m.raw?.download_code).toBe('dc1')
  })

  it('flattens a pure-text richText to text', () => {
    const m = mapMessageContent(
      baseMsg({
        msgtype: 'richText',
        content: { richText: [{ text: 'hello ' }, { text: 'world' }] },
      })
    )
    expect(m.content).toEqual({ type: 'text', text: 'hello world' })
  })

  it('maps picture to image with download_code in raw', () => {
    const m = mapMessageContent(
      baseMsg({ msgtype: 'picture', content: { downloadCode: 'dc-pic' } })
    )
    expect(m.content.type).toBe('image')
    expect(m.raw?.download_code).toBe('dc-pic')
  })

  it('maps file to file with filename + size (numeric-string coerced)', () => {
    const m = mapMessageContent(
      baseMsg({
        msgtype: 'file',
        content: { downloadCode: 'dc-file', fileName: 'report.pdf', fileSize: '2048' },
      })
    )
    expect(m.content.type).toBe('file')
    expect(m.content.filename).toBe('report.pdf')
    expect(m.content.size).toBe(2048)
    expect(m.raw).toEqual({ download_code: 'dc-file', filename: 'report.pdf', file_size: 2048 })
  })

  it('falls back to placeholder text for audio', () => {
    const m = mapMessageContent(baseMsg({ msgtype: 'audio' }))
    expect(m.content).toEqual({ type: 'text', text: '[语音]' })
  })

  it('falls back to a typed placeholder for unknown msgtype', () => {
    const m = mapMessageContent(baseMsg({ msgtype: 'weird_type' }))
    expect(m.content.text).toBe('[不支持的消息类型: weird_type]')
  })

  it('attaches mentions from atUsers', () => {
    const m = mapMessageContent(
      baseMsg({
        msgtype: 'text',
        text: { content: 'hi' },
        atUsers: [{ staffId: 'staff_bob' }, { dingtalkId: 'dt_carol' }],
      })
    )
    expect(m.features.mentions).toEqual([
      { friend_id: '', platform_user_id: 'staff_bob' },
      { friend_id: '', platform_user_id: 'dt_carol' },
    ])
  })
})

describe('buildMentionsList', () => {
  it('prefers staffId, falls back to dingtalkId, skips empty', () => {
    expect(
      buildMentionsList([{ staffId: 's1' }, { dingtalkId: 'd2' }, {}])
    ).toEqual([
      { friend_id: '', platform_user_id: 's1' },
      { friend_id: '', platform_user_id: 'd2' },
    ])
  })
  it('handles undefined', () => {
    expect(buildMentionsList(undefined)).toEqual([])
  })
})

describe('flattenRichText', () => {
  it('joins text parts and replaces images', () => {
    expect(
      flattenRichText([{ text: 'a' }, { text: 'b' }, { pictureDownloadCode: 'x' }])
    ).toBe('ab[图片]')
  })
  it('returns empty for non-array', () => {
    expect(flattenRichText(undefined)).toBe('')
  })
})

describe('resolveSenderId', () => {
  it('uses senderStaffId when present (internal enterprise member)', () => {
    expect(resolveSenderId(baseMsg({ senderStaffId: 'staff_alice', senderId: 'uid_alice' }))).toBe('staff_alice')
  })
  it('falls back to senderId when staffId is empty (external member / cross-org group)', () => {
    // 钉钉真机：外部群/外部联系人拿不到本企业 staffId，senderStaffId 为空串，但 senderId 恒有
    expect(resolveSenderId(baseMsg({ senderStaffId: '', senderId: 'uid_bob' }))).toBe('uid_bob')
  })
  it('returns empty string when neither id is available', () => {
    expect(resolveSenderId(baseMsg({ senderStaffId: '', senderId: undefined }))).toBe('')
  })
})

describe('detectMentionCrab', () => {
  it('true when isInAtList is true', () => {
    expect(detectMentionCrab(baseMsg({ isInAtList: true }))).toBe(true)
  })
  it('false when isInAtList is false and no matching atUsers', () => {
    expect(detectMentionCrab(baseMsg({ isInAtList: false, atUsers: [{ staffId: 'x' }] }))).toBe(false)
  })
  it('true when atUsers contains chatbotUserId (fallback)', () => {
    expect(
      detectMentionCrab(baseMsg({ atUsers: [{ staffId: 'bot-user-1' }] }))
    ).toBe(true)
  })
  it('false in a plain 1:1 message', () => {
    expect(detectMentionCrab(baseMsg({}))).toBe(false)
  })
})
