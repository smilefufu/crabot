import { describe, expect, it } from 'vitest'
import { renderTimedWakeEnvelope, type TimedWakeEnvelope } from '../../src/manager/loop.js'
import type { ChannelMessage } from '../../src/types.js'

function message(id: string, timestamp?: string): ChannelMessage {
  return {
    platform_message_id: id,
    session: { channel_id: 'wechat', session_id: 's', type: 'private' },
    sender: { platform_user_id: 'u', platform_display_name: 'U' },
    content: { type: 'text', text: id },
    features: { is_mention_crab: false },
    ...(timestamp ? { platform_timestamp: timestamp } : {}),
  }
}

describe('TimedWakeEnvelope rendering', () => {
  it('renders fixed ingress time and valid human source times in original batch order', () => {
    const envelope: TimedWakeEnvelope = {
      wake: { kind: 'human_messages', messages: [message('one', '2026-08-10T01:02:03.000Z'), message('two')] },
      received_at: '2026-08-10T09:02:04+08:00',
      timezone: 'Asia/Shanghai',
      human_occurred_at: [
        { message_id: 'one', occurred_at: '2026-08-10T01:02:03.000Z' },
        { message_id: 'two' },
      ],
    }
    const rendered = renderTimedWakeEnvelope(envelope)
    expect(rendered).toContain('[event received_at="2026-08-10T09:02:04+08:00" timezone="Asia/Shanghai"]')
    expect(rendered.indexOf('occurred_at="2026-08-10T01:02:03.000Z"')).toBeLessThan(rendered.lastIndexOf('two'))
    expect(rendered).toContain('one')
  })

  it('does not invent an occurred_at for schedules and pure rendering is byte-stable', () => {
    const envelope: TimedWakeEnvelope = {
      wake: { kind: 'schedule', scheduleId: 's', title: '巡检', description: '执行' },
      received_at: '2026-08-10T09:02:04+08:00',
      timezone: 'Asia/Shanghai',
    }
    expect(renderTimedWakeEnvelope(envelope)).toBe(renderTimedWakeEnvelope(envelope))
    expect(renderTimedWakeEnvelope(envelope)).not.toContain('occurred_at=')
  })

  it('任务板系统输入只渲染固定正文，不带任务板正文或 ingress 时间头', () => {
    const envelope: TimedWakeEnvelope = {
      wake: {
        kind: 'workboard_admin_update',
        noticeRevision: 42,
      },
      received_at: '2026-09-05T09:02:04+08:00',
      timezone: 'Asia/Shanghai',
    }
    const rendered = renderTimedWakeEnvelope(envelope)
    expect(rendered).toBe('[系统提示]\n管理员已更新任务板。请查阅最新任务板，并核对后续安排。')
    expect(rendered).not.toContain('42')
    expect(rendered).not.toContain('received_at=')
  })
})
