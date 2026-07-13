import { describe, expect, it } from 'vitest'
import { buildScheduleTargetSession } from './ScheduleList'

describe('buildScheduleTargetSession', () => {
  it('preserves existing platform_session_id when sessions are not loaded during edit', () => {
    expect(buildScheduleTargetSession(
      { targetChannelId: 'wechat-1', targetSessionId: 'stable-1', targetSessionType: 'group' },
      [],
      { channel_id: 'wechat-1', session_id: 'stable-1', platform_session_id: '12345@chatroom', type: 'group' },
    )).toEqual({
      channel_id: 'wechat-1',
      session_id: 'stable-1',
      platform_session_id: '12345@chatroom',
      type: 'group',
    })
  })

  it('does not carry platform_session_id when user changes target session', () => {
    expect(buildScheduleTargetSession(
      { targetChannelId: 'wechat-1', targetSessionId: 'stable-2', targetSessionType: 'group' },
      [],
      { channel_id: 'wechat-1', session_id: 'stable-1', platform_session_id: '12345@chatroom', type: 'group' },
    )).toEqual({
      channel_id: 'wechat-1',
      session_id: 'stable-2',
      type: 'group',
    })
  })
})
