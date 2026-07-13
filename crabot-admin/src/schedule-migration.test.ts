/**
 * Schedule 启动迁移单元测试 — migrateScheduleTargetSession。
 *
 * 边界用例覆盖：
 * - legacy 字段完整且 lookup 命中 → 提升 + 清理 input
 * - 已有 target_session → 幂等（identity equal）
 * - 其他 input key 保留
 * - 无 legacy 字段 → 不动
 * - lookup 返回 undefined → 不动（兜底）
 * - lookup 抛错 → 不动（兜底）
 */

import { describe, it, expect } from 'vitest'
import type { Schedule, ScheduleTargetSession } from './types.js'
import {
  migrateScheduleTargetSession,
  repairScheduleTargetSession,
  type SessionTypeLookup,
  type TargetSessionRepairLookup,
} from './schedule-migration.js'

function makeSchedule(overrides: Partial<Schedule> = {}): Schedule {
  return {
    id: 'sched-1',
    name: 'Test',
    enabled: true,
    trigger: { type: 'interval', seconds: 60 },
    task_template: {
      type: 'test',
      title: 'Test',
      priority: 'normal',
      tags: [],
    },
    execution_count: 0,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

describe('migrateScheduleTargetSession', () => {
  it('migrates input.target_channel_id + target_session_id to target_session field', async () => {
    const schedule = makeSchedule({
      task_template: {
        type: 'test',
        title: 'T',
        priority: 'normal',
        tags: [],
        input: {
          target_channel_id: 'wechat-X',
          target_session_id: 'sess-Y',
        },
      },
    })

    const lookup: SessionTypeLookup = async () => 'group'
    const migrated = await migrateScheduleTargetSession(schedule, lookup)

    expect(migrated).not.toBe(schedule)
    expect(migrated.target_session).toEqual({
      channel_id: 'wechat-X',
      session_id: 'sess-Y',
      type: 'group',
    })
    expect(migrated.task_template.input).toBeUndefined()
    expect(new Date(migrated.updated_at).getTime()).toBeGreaterThan(
      new Date(schedule.updated_at).getTime(),
    )
  })

  it('is idempotent when target_session already set', async () => {
    const existingTarget: ScheduleTargetSession = {
      channel_id: 'telegram-A',
      session_id: 'sess-Z',
      type: 'private',
    }
    const schedule = makeSchedule({
      target_session: existingTarget,
      task_template: {
        type: 'test',
        title: 'T',
        priority: 'normal',
        tags: [],
        input: {
          target_channel_id: 'should-be-ignored',
          target_session_id: 'should-be-ignored',
        },
      },
    })

    let called = false
    const lookup: SessionTypeLookup = async () => {
      called = true
      return 'group'
    }
    const migrated = await migrateScheduleTargetSession(schedule, lookup)

    expect(migrated).toBe(schedule)
    expect(called).toBe(false)
  })

  it('preserves other input keys when migrating', async () => {
    const schedule = makeSchedule({
      task_template: {
        type: 'test',
        title: 'T',
        priority: 'normal',
        tags: [],
        input: {
          target_channel_id: 'C',
          target_session_id: 'S',
          extra: 'foo',
          nested: { a: 1 },
        },
      },
    })

    const lookup: SessionTypeLookup = async () => 'group'
    const migrated = await migrateScheduleTargetSession(schedule, lookup)

    expect(migrated.task_template.input).toEqual({
      extra: 'foo',
      nested: { a: 1 },
    })
    expect(migrated.target_session).toEqual({
      channel_id: 'C',
      session_id: 'S',
      type: 'group',
    })
  })

  it('preserves schedule when no legacy fields present', async () => {
    const scheduleNoInput = makeSchedule()
    const scheduleOtherInput = makeSchedule({
      task_template: {
        type: 'test',
        title: 'T',
        priority: 'normal',
        tags: [],
        input: { other: 'foo' },
      },
    })

    const lookup: SessionTypeLookup = async () => 'group'

    expect(await migrateScheduleTargetSession(scheduleNoInput, lookup)).toBe(scheduleNoInput)
    expect(await migrateScheduleTargetSession(scheduleOtherInput, lookup)).toBe(scheduleOtherInput)
  })

  it('preserves schedule when session type lookup returns undefined', async () => {
    const schedule = makeSchedule({
      task_template: {
        type: 'test',
        title: 'T',
        priority: 'normal',
        tags: [],
        input: {
          target_channel_id: 'C',
          target_session_id: 'S',
        },
      },
    })

    const lookup: SessionTypeLookup = async () => undefined
    const migrated = await migrateScheduleTargetSession(schedule, lookup)

    expect(migrated).toBe(schedule)
    expect(migrated.target_session).toBeUndefined()
    expect(migrated.task_template.input).toEqual({
      target_channel_id: 'C',
      target_session_id: 'S',
    })
  })

  it('preserves schedule when session type lookup throws', async () => {
    const schedule = makeSchedule({
      task_template: {
        type: 'test',
        title: 'T',
        priority: 'normal',
        tags: [],
        input: {
          target_channel_id: 'C',
          target_session_id: 'S',
        },
      },
    })

    const lookup: SessionTypeLookup = async () => {
      throw new Error('channel offline')
    }
    const migrated = await migrateScheduleTargetSession(schedule, lookup)

    expect(migrated).toBe(schedule)
    expect(migrated.target_session).toBeUndefined()
  })

  it('skips when only one of the two legacy fields is present', async () => {
    const scheduleChannelOnly = makeSchedule({
      task_template: {
        type: 'test',
        title: 'T',
        priority: 'normal',
        tags: [],
        input: { target_channel_id: 'C' },
      },
    })
    const scheduleSessionOnly = makeSchedule({
      task_template: {
        type: 'test',
        title: 'T',
        priority: 'normal',
        tags: [],
        input: { target_session_id: 'S' },
      },
    })

    const lookup: SessionTypeLookup = async () => 'group'
    expect(await migrateScheduleTargetSession(scheduleChannelOnly, lookup)).toBe(scheduleChannelOnly)
    expect(await migrateScheduleTargetSession(scheduleSessionOnly, lookup)).toBe(scheduleSessionOnly)
  })

  it('skips when legacy fields are not strings', async () => {
    const schedule = makeSchedule({
      task_template: {
        type: 'test',
        title: 'T',
        priority: 'normal',
        tags: [],
        input: {
          target_channel_id: 123,
          target_session_id: { nested: 'no' },
        },
      },
    })

    const lookup: SessionTypeLookup = async () => 'group'
    const migrated = await migrateScheduleTargetSession(schedule, lookup)
    expect(migrated).toBe(schedule)
  })
})

describe('repairScheduleTargetSession', () => {
  it('preserves valid target_session', async () => {
    const schedule = makeSchedule({
      target_session: {
        channel_id: 'wechat-X',
        session_id: 'valid-session',
        type: 'group',
      },
    })

    const lookup: TargetSessionRepairLookup = async () => ({
      session_id: 'valid-session',
      type: 'group',
    })

    expect(await repairScheduleTargetSession(schedule, lookup)).toBe(schedule)
  })

  it('rewrites stale target_session to the current session id', async () => {
    const schedule = makeSchedule({
      target_session: {
        channel_id: 'wechat-X',
        session_id: 'stale-session',
        type: 'group',
      },
    })

    const lookup: TargetSessionRepairLookup = async () => ({
      session_id: 'current-session',
      type: 'group',
    })

    const repaired = await repairScheduleTargetSession(schedule, lookup)

    expect(repaired).not.toBe(schedule)
    expect(repaired.target_session).toEqual({
      channel_id: 'wechat-X',
      session_id: 'current-session',
      type: 'group',
    })
    expect(new Date(repaired.updated_at).getTime()).toBeGreaterThan(
      new Date(schedule.updated_at).getTime(),
    )
  })

  it('uses platform_session_id when present for deterministic repair', async () => {
    const schedule = makeSchedule({
      target_session: {
        channel_id: 'wechat-X',
        session_id: 'stale-session',
        platform_session_id: '12345@chatroom',
        type: 'group',
      },
    })

    let seenPlatformSessionId: string | undefined
    const lookup: TargetSessionRepairLookup = async (_channelId, _sessionId, platformSessionId) => {
      seenPlatformSessionId = platformSessionId
      return { session_id: 'current-session', type: 'group' }
    }

    const repaired = await repairScheduleTargetSession(schedule, lookup)

    expect(seenPlatformSessionId).toBe('12345@chatroom')
    expect(repaired.target_session?.session_id).toBe('current-session')
    expect(repaired.target_session?.platform_session_id).toBe('12345@chatroom')
  })

  it('preserves schedule when resolved session conflicts with stored platform_session_id', async () => {
    const schedule = makeSchedule({
      target_session: {
        channel_id: 'wechat-X',
        session_id: 'wrong-current-session',
        platform_session_id: '12345@chatroom',
        type: 'group',
      },
    })

    const lookup: TargetSessionRepairLookup = async () => ({
      session_id: 'wrong-current-session',
      platform_session_id: '67890@chatroom',
      type: 'group',
    })

    expect(await repairScheduleTargetSession(schedule, lookup)).toBe(schedule)
  })

  it('preserves schedule when lookup cannot repair', async () => {
    const schedule = makeSchedule({
      target_session: {
        channel_id: 'wechat-X',
        session_id: 'stale-session',
        type: 'group',
      },
    })

    const lookup: TargetSessionRepairLookup = async () => undefined

    expect(await repairScheduleTargetSession(schedule, lookup)).toBe(schedule)
  })
})
