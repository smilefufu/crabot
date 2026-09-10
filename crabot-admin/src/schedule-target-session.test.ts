/**
 * Admin 模块 — Schedule.target_session 一等可选字段测试
 *
 * 验证新记录总有 target，且 update 不能换绑 target。
 *
 * 直接调 admin handler，不走 HTTP RPC（避免端口绑定 / 测试间串扰）。
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs/promises'
import AdminModule from './index.js'
import type {
  Schedule,
  ScheduleView,
  CreateScheduleParams,
  UpdateScheduleParams,
  GetScheduleParams,
  ScheduleTargetSession,
} from './types.js'

const TEST_PROTOCOL_PORT = 19820
const TEST_WEB_PORT = 13020
const TEST_DATA_DIR = './test-data/schedule-target-session-test'

interface AdminHandlers {
  handleCreateSchedule(params: CreateScheduleParams): Promise<{ schedule: ScheduleView }>
  handleUpdateSchedule(params: UpdateScheduleParams): Promise<{ schedule: ScheduleView }>
  handleGetSchedule(params: GetScheduleParams): Promise<{ schedule: ScheduleView }>
}

describe('Schedule.target_session', () => {
  let admin: AdminModule
  let handlers: AdminHandlers

  beforeAll(async () => {
    try {
      await fs.rm(TEST_DATA_DIR, { recursive: true, force: true })
    } catch {
      // ignore
    }

    process.env.TEST_ADMIN_PASSWORD_TGT = 'test_password_123'
    process.env.TEST_JWT_SECRET_TGT = 'test_jwt_secret_at_least_32_chars_target'

    admin = new AdminModule(
      {
        moduleId: 'admin-target-session-test',
        moduleType: 'admin',
        version: '0.1.0',
        protocolVersion: '0.1.0',
        port: TEST_PROTOCOL_PORT,
        subscriptions: [],
      },
      {
        web_port: TEST_WEB_PORT,
        data_dir: TEST_DATA_DIR,
        password_env: 'TEST_ADMIN_PASSWORD_TGT',
        jwt_secret_env: 'TEST_JWT_SECRET_TGT',
        token_ttl: 3600,
      }
    )

    await admin.start()
    handlers = admin as unknown as AdminHandlers
  })

  afterAll(async () => {
    await admin.stop()
    try {
      await fs.rm(TEST_DATA_DIR, { recursive: true, force: true })
    } catch {
      // ignore
    }
  })

  const baseTemplate = {
    type: 'routine',
    title: 'Daily Routine',
    priority: 'normal' as const,
    tags: [] as string[],
  }

  const sampleTarget: ScheduleTargetSession = {
    channel_id: 'telegram-main',
    session_id: 'sess-abc-123',
    type: 'group',
  }

  it('create_schedule accepts target_session and persists it', async () => {
    const result = await handlers.handleCreateSchedule({
      name: 'WithTarget',
      trigger: { type: 'interval', seconds: 60 },
      task_template: baseTemplate,
      target_session: sampleTarget,
    })

    expect(result.schedule.target_session).toEqual(sampleTarget)

    // 持久化后 get_schedule 也能读到
    const fetched = await handlers.handleGetSchedule({ schedule_id: result.schedule.id })
    expect(fetched.schedule.target_session).toEqual(sampleTarget)
  })

  it('accepts the authenticated Admin Chat Master only on its exact private target', async () => {
    const result = await handlers.handleCreateSchedule({
      name: 'admin chat reminder',
      trigger: { type: 'interval', seconds: 60 },
      task_template: baseTemplate,
      creator_friend_id: 'master',
      target_session: { channel_id: 'admin-web', session_id: 'admin-chat', type: 'private' },
    })
    expect(result.schedule.creator_friend_id).toBe('master')

    await expect(handlers.handleCreateSchedule({
      name: 'forged master',
      trigger: { type: 'interval', seconds: 60 },
      task_template: baseTemplate,
      creator_friend_id: 'master',
      target_session: sampleTarget,
    })).rejects.toThrow('not found')
  })

  it('create_schedule without target_session uses the canonical Admin target', async () => {
    const result = await handlers.handleCreateSchedule({
      name: 'NoTarget',
      trigger: { type: 'interval', seconds: 60 },
      task_template: baseTemplate,
    })

    expect(result.schedule.target_session).toEqual({
      channel_id: 'admin-web',
      session_id: 'system-tasks',
      type: 'private',
    })
  })

  it('update_schedule without target_session field preserves existing', async () => {
    const created = await handlers.handleCreateSchedule({
      name: 'PreserveTarget',
      trigger: { type: 'interval', seconds: 60 },
      task_template: baseTemplate,
      target_session: sampleTarget,
    })

    // 不传 target_session — 只改 name
    const updated = await handlers.handleUpdateSchedule({
      schedule_id: created.schedule.id,
      name: 'PreserveTarget-Renamed',
    })

    expect(updated.schedule.name).toBe('PreserveTarget-Renamed')
    expect(updated.schedule.target_session).toEqual(sampleTarget)
  })

  it('update_schedule rejects target rebinding', async () => {
    const created = await handlers.handleCreateSchedule({
      name: 'ClearTarget',
      trigger: { type: 'interval', seconds: 60 },
      task_template: baseTemplate,
      target_session: sampleTarget,
    })

    await expect(handlers.handleUpdateSchedule({
      schedule_id: created.schedule.id,
      target_session: null,
    } as UpdateScheduleParams)).rejects.toThrow('INVALID_PARAMS')
  })

  it('rejects target_session with invalid type field', async () => {
    await expect(
      handlers.handleCreateSchedule({
        name: 'InvalidType',
        trigger: { type: 'interval', seconds: 60 },
        task_template: baseTemplate,
        target_session: {
          channel_id: 'telegram-main',
          session_id: 'sess-1',
          // @ts-expect-error testing runtime rejection of invalid type
          type: 'channel',
        },
      })
    ).rejects.toThrow(/target_session\.type/)
  })

  it('stores one normalized script branch and redacts source by default', async () => {
    const created = await handlers.handleCreateSchedule({
      name: 'Script',
      trigger: { type: 'interval', seconds: 60 },
      script: { source: 'echo ok' },
      target_session: sampleTarget,
    })

    expect(created.schedule.task_template).toBeUndefined()
    expect(created.schedule.script).toMatchObject({
      source_sha256: '7d10fced96b38c84f90db07708f266e83da48ca763189eaed7fe1a00348385eb',
      timeout_seconds: 120,
      deliver_result: false,
    })
    expect(created.schedule.script?.source).toBeUndefined()

    const fetched = await handlers.handleGetSchedule({
      schedule_id: created.schedule.id,
      include_script_source: true,
    })
    expect(fetched.schedule.script?.source).toBe('echo ok')
  })

  it('atomically switches content branches and rejects mixed content', async () => {
    const created = await handlers.handleCreateSchedule({
      name: 'Switch',
      trigger: { type: 'interval', seconds: 60 },
      task_template: baseTemplate,
      target_session: sampleTarget,
    })
    const updated = await handlers.handleUpdateSchedule({
      schedule_id: created.schedule.id,
      task_template: null,
      script: { source: 'pwd', timeout_seconds: 30, deliver_result: true },
    })
    expect(updated.schedule.task_template).toBeUndefined()
    expect(updated.schedule.script?.deliver_result).toBe(true)

    await expect(handlers.handleUpdateSchedule({
      schedule_id: created.schedule.id,
      task_template: baseTemplate,
    })).rejects.toThrow('INVALID_PARAMS')
  })
})
