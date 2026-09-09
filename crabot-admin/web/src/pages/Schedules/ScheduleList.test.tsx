import { describe, expect, it, vi } from 'vitest'
import { api } from '../../services/api'
import { scheduleService } from '../../services/schedule'
import type { Schedule } from '../../types'
import {
  buildScheduleTargetSession,
  buildScheduleUpdateData,
  scheduleToForm,
} from './ScheduleList'

vi.mock('../../services/api', () => ({ api: { get: vi.fn() } }))

const SCRIPT_SCHEDULE: Schedule = {
  id: 'schedule-1',
  name: '检查状态',
  enabled: true,
  trigger: { type: 'interval', seconds: 300 },
  script: {
    source: 'echo ok',
    source_sha256: 'abc123',
    timeout_seconds: 45,
    deliver_result: true,
  },
  target_session: { channel_id: 'feishu-1', session_id: 'session-1', type: 'private' },
  execution_count: 0,
  created_at: '2026-09-01T00:00:00.000Z',
  updated_at: '2026-09-01T00:00:00.000Z',
}

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

describe('script Schedule form', () => {
  it('loads source only through the explicit get query', async () => {
    vi.mocked(api.get).mockResolvedValueOnce({ schedule: SCRIPT_SCHEDULE })

    await scheduleService.get('schedule-1', true)

    expect(api.get).toHaveBeenCalledWith('/schedules/schedule-1?include_script_source=true')
  })

  it('maps script fields and never includes target in an edit payload', () => {
    const form = scheduleToForm(SCRIPT_SCHEDULE)
    const update = buildScheduleUpdateData({ ...form, scriptSource: 'echo changed' }, SCRIPT_SCHEDULE)

    expect(update).toMatchObject({
      script: { source: 'echo changed', timeout_seconds: 45, deliver_result: true },
    })
    expect(update).not.toHaveProperty('target_session')
    expect(JSON.stringify(update)).not.toContain('abc123')
  })

  it('atomically replaces script with instruction content', () => {
    const form = scheduleToForm(SCRIPT_SCHEDULE)
    const update = buildScheduleUpdateData({
      ...form,
      contentType: 'instruction',
      taskTitle: '查看 Worker 状态',
    }, SCRIPT_SCHEDULE)

    expect(update).toMatchObject({
      task_template: { title: '查看 Worker 状态' },
      script: null,
    })
  })
})
