import { describe, expect, it, vi } from 'vitest'

import { AttentionScheduler } from '../../src/orchestration/attention-scheduler.js'
import type { ChannelMessage, Friend } from '../../src/types.js'

function message(id: string, text: string): ChannelMessage {
  return {
    platform_message_id: id,
    session: { session_id: 'group-1', channel_id: 'feishu-fengyan', type: 'group' },
    sender: { platform_user_id: 'u-1', platform_display_name: '风言' },
    content: { type: 'text', text },
    features: { is_mention_crab: false },
    platform_timestamp: '2026-09-05T06:28:20.000Z',
  }
}

describe('AttentionScheduler snapshot', () => {
  it('返回 buffer 浅拷贝，读取和修改返回数组都不消费原队列', () => {
    const flush = vi.fn(async () => undefined)
    const scheduler = new AttentionScheduler(
      { group_attention_min_ms: 60_000, group_attention_max_ms: 60_000 },
      flush,
    )
    const first = message('pm-1', '第一条')
    const second = message('pm-2', '第二条')
    scheduler.enqueue('group-1', first, {} as Friend)
    scheduler.enqueue('group-1', second, {} as Friend)

    const snapshot = scheduler.snapshotBuffer('group-1')
    expect(snapshot.map(({ message: item }) => item.platform_message_id)).toEqual(['pm-1', 'pm-2'])
    snapshot.reverse()

    expect(scheduler.snapshotBuffer('group-1').map(({ message: item }) => item.platform_message_id))
      .toEqual(['pm-1', 'pm-2'])
    expect(scheduler.getBufferSize('group-1')).toBe(2)
    expect(flush).not.toHaveBeenCalled()
    scheduler.stopAll()
  })

  it('未知 session 返回空数组且不创建状态', () => {
    const scheduler = new AttentionScheduler(
      { group_attention_min_ms: 60_000, group_attention_max_ms: 60_000 },
      async () => undefined,
    )
    expect(scheduler.snapshotBuffer('missing')).toEqual([])
    expect(scheduler.getBufferSize('missing')).toBe(0)
  })
})
