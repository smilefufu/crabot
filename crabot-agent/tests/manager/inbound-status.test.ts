import { describe, expect, it } from 'vitest'

import {
  projectManagerInboundMessages,
  type ManagerInboundMessageFact,
} from '../../src/manager/inbound-status.js'
import type { ChannelMessage } from '../../src/types.js'

function message(p: {
  id: string
  timestamp: string
  text?: string
  type?: ChannelMessage['content']['type']
  sender?: string
}): ChannelMessage {
  return {
    platform_message_id: p.id,
    session: { session_id: 'sess-1', channel_id: 'wechat', type: 'private' },
    sender: { platform_user_id: 'u-1', platform_display_name: p.sender ?? '测试用户' },
    content: { type: p.type ?? 'text', ...(p.text === undefined ? {} : { text: p.text }) },
    features: { is_mention_crab: false },
    platform_timestamp: p.timestamp,
  }
}

describe('projectManagerInboundMessages', () => {
  it('按消息 ID 去重，processing 优先，并按平台时间与 ID 稳定升序', () => {
    const queuedDuplicate = message({
      id: 'pm-b',
      timestamp: '2026-09-05T06:28:15.000Z',
      text: '仍在 lane',
    })
    const processingDuplicate = { ...queuedDuplicate, platform_timestamp: '2026-09-05T06:28:16.000Z' }
    const facts: ManagerInboundMessageFact[] = [
      { message: message({ id: 'pm-c', timestamp: '2026-09-05T06:28:20.000Z', text: '最后到达' }), status: 'queued' },
      { message: queuedDuplicate, status: 'queued' },
      { message: processingDuplicate, status: 'processing', episode_id: 'ep-running' },
      { message: message({ id: 'pm-a', timestamp: '2026-09-05T06:28:15.000Z', text: '同秒更早 ID' }), status: 'queued' },
    ]

    const result = projectManagerInboundMessages(facts, (text) => text)

    expect(result.map((item) => item.platform_message_id)).toEqual(['pm-a', 'pm-b', 'pm-c'])
    expect(result[1]).toMatchObject({
      status: 'processing',
      episode_id: 'ep-running',
      platform_timestamp: '2026-09-05T06:28:16.000Z',
    })
  })

  it('同状态重复项保留更早平台时间，不修改输入消息', () => {
    const later = message({ id: 'pm-1', timestamp: '2026-09-05T06:28:20.000Z', text: 'later' })
    const earlier = message({ id: 'pm-1', timestamp: '2026-09-05T06:28:10.000Z', text: 'earlier' })
    const facts: ManagerInboundMessageFact[] = [
      { message: later, status: 'queued' },
      { message: earlier, status: 'queued' },
    ]

    expect(projectManagerInboundMessages(facts, (text) => text)[0]).toMatchObject({
      platform_timestamp: '2026-09-05T06:28:10.000Z',
      preview: 'earlier',
    })
    expect(later.content.text).toBe('later')
    expect(earlier.content.text).toBe('earlier')
  })

  it('只输出脱敏截断预览与媒体类型标记，不泄漏消息 payload 字段', () => {
    const secret = 'secret-value-123456'
    const longText = `  请使用 ${secret}\n${'很长内容 '.repeat(80)}`
    const facts: ManagerInboundMessageFact[] = [{
      message: message({ id: 'pm-image', timestamp: '2026-09-05T06:28:20.000Z', text: longText, type: 'image', sender: ' 风言 ' }),
      status: 'queued',
    }]

    const [item] = projectManagerInboundMessages(facts, (text) => text.replace(secret, '[REDACTED]'))

    expect(item.preview).toMatch(/^\[图片\] 请使用 \[REDACTED\]/)
    expect(item.preview.endsWith('…')).toBe(true)
    expect(Array.from(item.preview).length).toBeLessThanOrEqual(181)
    expect(item.sender_display_name).toBe('风言')
    expect(item).not.toHaveProperty('content')
    expect(item).not.toHaveProperty('sender')
    expect(item).not.toHaveProperty('session')
  })
})
