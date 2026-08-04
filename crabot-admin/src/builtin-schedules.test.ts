/**
 * Admin 模块 - 内置 Schedule 种子测试
 *
 * 验证 ensureBuiltinSchedules 在首次启动时正确创建三个内置调度：
 *   - 每日反思 (cron)
 *   - 记忆整理 (interval)
 *   - 记忆维护 (cron)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs/promises'
import AdminModule from './index.js'
import type { Schedule } from './types.js'

const TEST_PROTOCOL_PORT = 19810
const TEST_WEB_PORT = 13010
const TEST_DATA_DIR = './test-data/builtin-schedules-test'

describe('AdminModule - ensureBuiltinSchedules', () => {
  let admin: AdminModule

  beforeAll(async () => {
    // Clean slate so no prior 每日反思 seeds from previous runs pollute assertions
    try {
      await fs.rm(TEST_DATA_DIR, { recursive: true, force: true })
    } catch {
      // ignore
    }

    admin = new AdminModule(
      {
        moduleId: 'admin-builtin-schedules-test',
        moduleType: 'admin',
        version: '0.1.0',
        protocolVersion: '0.1.0',
        port: TEST_PROTOCOL_PORT,
        subscriptions: [],
      },
      {
        web_port: TEST_WEB_PORT,
        data_dir: TEST_DATA_DIR,
        password_env: 'TEST_ADMIN_PASSWORD_BUILTIN',
        jwt_secret_env: 'TEST_JWT_SECRET_BUILTIN',
        token_ttl: 3600,
      }
    )

    process.env.TEST_ADMIN_PASSWORD_BUILTIN = 'test_password_123'
    process.env.TEST_JWT_SECRET_BUILTIN = 'test_jwt_secret_at_least_32_chars_builtin'

    await admin.start()
  })

  afterAll(async () => {
    await admin.stop()
    try {
      await fs.rm(TEST_DATA_DIR, { recursive: true, force: true })
    } catch {
      // ignore
    }
  })

  it('should seed 每日反思 (cron, 0 2 * * *)', async () => {
    const result = await (admin as unknown as { handleListSchedules: (params: { page: number; page_size: number; filter: Record<string, unknown> }) => Promise<{ items: Schedule[] }> }).handleListSchedules({ page: 1, page_size: 50, filter: {} })
    const dailyReflection = result.items.find(s => s.name === '每日反思')
    expect(dailyReflection, '每日反思 should exist').toBeDefined()
    expect(dailyReflection!.is_builtin).toBe(true)
    expect(dailyReflection!.trigger.type).toBe('cron')
    expect(dailyReflection!.task_template.type).toBe('daily_reflection')
  })

  it('should seed 记忆整理 (interval, 3600s)', async () => {
    const result = await (admin as unknown as { handleListSchedules: (params: { page: number; page_size: number; filter: Record<string, unknown> }) => Promise<{ items: Schedule[] }> }).handleListSchedules({ page: 1, page_size: 50, filter: {} })
    const memoryCurate = result.items.find(s => s.name === '记忆整理')
    expect(memoryCurate, '记忆整理 should exist').toBeDefined()
    expect(memoryCurate!.is_builtin).toBe(true)
    expect(memoryCurate!.trigger.type).toBe('interval')
    if (memoryCurate!.trigger.type === 'interval') {
      expect(memoryCurate!.trigger.seconds).toBe(3600)
    }
    expect(memoryCurate!.task_template.type).toBe('memory_curate')
  })

  it('should seed 记忆整理 with explicit watermark input for incremental inbox curation', async () => {
    const result = await (admin as unknown as { handleListSchedules: (params: { page: number; page_size: number; filter: Record<string, unknown> }) => Promise<{ items: Schedule[] }> }).handleListSchedules({ page: 1, page_size: 50, filter: {} })
    const memoryCurate = result.items.find(s => s.name === '记忆整理')
    expect(memoryCurate, '记忆整理 should exist').toBeDefined()
    expect(memoryCurate!.task_template.description).toContain('{{watermark}}')
    expect(memoryCurate!.task_template.description).toContain('{{datetime}}')
    expect(memoryCurate!.task_template.input).toMatchObject({
      ingestion_time_start: '{{watermark}}',
      ingestion_time_end: '{{datetime}}',
    })
  })

  it('should seed 记忆维护 (cron, 0 4 * * *)', async () => {
    const result = await (admin as unknown as { handleListSchedules: (params: { page: number; page_size: number; filter: Record<string, unknown> }) => Promise<{ items: Schedule[] }> }).handleListSchedules({ page: 1, page_size: 50, filter: {} })
    const memoryMaintenance = result.items.find(s => s.name === '记忆维护')
    expect(memoryMaintenance, '记忆维护 should exist').toBeDefined()
    expect(memoryMaintenance!.is_builtin).toBe(true)
    expect(memoryMaintenance!.trigger.type).toBe('cron')
    if (memoryMaintenance!.trigger.type === 'cron') {
      expect(memoryMaintenance!.trigger.expression).toBe('0 4 * * *')
    }
    expect(memoryMaintenance!.task_template.type).toBe('memory_maintenance')
  })

  it('should have exactly 3 builtin schedules (no duplicates)', async () => {
    const result = await (admin as unknown as { handleListSchedules: (params: { page: number; page_size: number; filter: Record<string, unknown> }) => Promise<{ items: Schedule[] }> }).handleListSchedules({ page: 1, page_size: 50, filter: {} })
    const builtins = result.items.filter(s => s.is_builtin)
    expect(builtins).toHaveLength(3)
  })

  it('should not duplicate schedules on repeated ensureBuiltinSchedules calls', async () => {
    // Call the private method again (simulates a second startup)
    await (admin as unknown as { ensureBuiltinSchedules: () => Promise<void> }).ensureBuiltinSchedules()

    const result = await (admin as unknown as { handleListSchedules: (params: { page: number; page_size: number; filter: Record<string, unknown> }) => Promise<{ items: Schedule[] }> }).handleListSchedules({ page: 1, page_size: 50, filter: {} })
    const builtins = result.items.filter(s => s.is_builtin)
    expect(builtins).toHaveLength(3)
  })

  it('should converge same-name builtin duplicates to one (keep earliest created_at)', async () => {
    // Simulates the historical bug where multiple same-name builtin schedules
    // accumulated across migrations / failed loads. ensureBuiltinSchedules
    // must collapse them, keeping the earliest one.
    const schedulesMap = (admin as unknown as { schedules: Map<string, Schedule> }).schedules
    const original = Array.from(schedulesMap.values()).find(s => s.is_builtin && s.name === '记忆整理')
    expect(original, 'pre-existing 记忆整理 seed must exist').toBeDefined()

    const baseTs = Date.parse(original!.created_at)
    const dupe1: Schedule = {
      ...original!,
      id: 'dupe-curate-1',
      created_at: new Date(baseTs + 60_000).toISOString(),
      execution_count: 99,
    }
    const dupe2: Schedule = {
      ...original!,
      id: 'dupe-curate-2',
      created_at: new Date(baseTs + 120_000).toISOString(),
      execution_count: 50,
    }
    schedulesMap.set(dupe1.id, dupe1)
    schedulesMap.set(dupe2.id, dupe2)

    await (admin as unknown as { ensureBuiltinSchedules: () => Promise<void> }).ensureBuiltinSchedules()

    const curatesAfter = Array.from(schedulesMap.values()).filter(s => s.is_builtin && s.name === '记忆整理')
    expect(curatesAfter).toHaveLength(1)
    expect(curatesAfter[0].id).toBe(original!.id)
  })

  it('should resync stale memory_curate task_template to current SEED on startup', async () => {
    // memory_curate remains system-seeded as before; the two managed daily
    // schedules preserve their other user-editable template fields.
    const schedulesMap = (admin as unknown as { schedules: Map<string, Schedule> }).schedules
    const dailyReflection = Array.from(schedulesMap.values()).find(
      s => s.is_builtin && s.name === '记忆整理'
    )
    expect(dailyReflection, 'pre-existing 记忆整理 seed must exist').toBeDefined()

    const staleDescription = '执行每日反思（旧版文案，缺少 Skill 调用指令）。'
    const originalId = dailyReflection!.id
    const originalCreatedAt = dailyReflection!.created_at

    schedulesMap.set(originalId, {
      ...dailyReflection!,
      task_template: { ...dailyReflection!.task_template, description: staleDescription },
      execution_count: 42,
    })

    await (admin as unknown as { ensureBuiltinSchedules: () => Promise<void> }).ensureBuiltinSchedules()

    const refreshed = schedulesMap.get(originalId)
    expect(refreshed, 'schedule should still exist with same id').toBeDefined()
    expect(refreshed!.task_template.description).not.toBe(staleDescription)
    expect(refreshed!.task_template.description).toMatch(/第一步必须调用 Skill\("memory-curate"\)/)
    expect(refreshed!.created_at).toBe(originalCreatedAt) // user-facing fields preserved
    expect(refreshed!.execution_count).toBe(42) // runtime stats preserved
  })

  it.each([
    ['0', 'daily_reflection', '0 2 * * *'],
    ['100', 'daily_reflection', '1 2 * * *'],
    ['200', 'memory_maintenance', '2 4 * * *'],
    ['9900', 'memory_maintenance', '39 5 * * *'],
  ])('derives offset %s %s trigger without instance modulo', (offset, type, expected) => {
    const previous = process.env.CRABOT_PORT_OFFSET
    process.env.CRABOT_PORT_OFFSET = offset
    try {
      const trigger = (admin as unknown as {
        getManagedBuiltinTrigger: (taskType: string) => Schedule['trigger']
      }).getManagedBuiltinTrigger(type)
      expect(trigger).toEqual({ type: 'cron', expression: expected, timezone: 'Asia/Shanghai' })
    } finally {
      if (previous === undefined) delete process.env.CRABOT_PORT_OFFSET
      else process.env.CRABOT_PORT_OFFSET = previous
    }
  })

  it('deduplicates managed schedules by task type and preserves the earliest record', async () => {
    const schedulesMap = (admin as unknown as { schedules: Map<string, Schedule> }).schedules
    const original = Array.from(schedulesMap.values()).find(
      s => s.is_builtin && s.task_template.type === 'memory_maintenance'
    )!
    const customDescription = '保留用户修改后的维护说明'
    const lastTriggeredAt = '2026-08-03T01:02:03.000Z'
    schedulesMap.set(original.id, {
      ...original,
      name: '保留的维护名称',
      description: '保留名称之外的用户字段',
      enabled: false,
      trigger: { type: 'cron', expression: '59 23 * * *', timezone: 'UTC' },
      task_template: { ...original.task_template, description: customDescription },
      execution_count: 17,
      last_task_id: 'previous-task',
      last_triggered_at: lastTriggeredAt,
    })
    schedulesMap.set('renamed-maintenance-duplicate', {
      ...original,
      id: 'renamed-maintenance-duplicate',
      name: '另一条不同名维护',
      created_at: new Date(Date.parse(original.created_at) + 60_000).toISOString(),
      execution_count: 99,
    })

    await (admin as unknown as { ensureBuiltinSchedules: () => Promise<void> }).ensureBuiltinSchedules()

    const matches = Array.from(schedulesMap.values()).filter(
      s => s.is_builtin && s.task_template.type === 'memory_maintenance'
    )
    expect(matches).toHaveLength(1)
    expect(matches[0].id).toBe(original.id)
    expect(matches[0].execution_count).toBe(17)
    expect(matches[0]).toMatchObject({
      name: '保留的维护名称',
      enabled: false,
      last_task_id: 'previous-task',
      last_triggered_at: lastTriggeredAt,
    })
    expect(matches[0].task_template.description).toBe(customDescription)
    expect(matches[0].trigger).toEqual({
      type: 'cron', expression: '0 4 * * *', timezone: 'Asia/Shanghai',
    })
  })

  it('rejects managed trigger/type changes while allowing equal trigger and enable updates', async () => {
    const schedulesMap = (admin as unknown as { schedules: Map<string, Schedule> }).schedules
    const managed = Array.from(schedulesMap.values()).find(
      s => s.is_builtin && s.task_template.type === 'memory_maintenance'
    )!
    const update = (params: Record<string, unknown>) => (
      admin as unknown as { handleUpdateSchedule: (p: Record<string, unknown>) => Promise<{ schedule: Schedule }> }
    ).handleUpdateSchedule({ schedule_id: managed.id, ...params })

    await expect(update({
      trigger: { type: 'cron', expression: '1 4 * * *', timezone: 'Asia/Shanghai' },
    })).rejects.toThrow('INVALID_PARAMS')
    await expect(update({
      task_template: { ...managed.task_template, type: 'routine' },
    })).rejects.toThrow('INVALID_PARAMS')

    await expect(update({ trigger: managed.trigger })).resolves.toMatchObject({
      schedule: { id: managed.id },
    })
    const updatedTemplate = {
      ...managed.task_template,
      description: '允许修改受管任务的其他模板字段',
      input: { scope: 'all' },
      tags: ['custom-maintenance'],
    }
    await expect(update({ task_template: updatedTemplate })).resolves.toMatchObject({
      schedule: { id: managed.id, task_template: updatedTemplate },
    })
    await expect(update({ enabled: true, name: '允许改名' })).resolves.toMatchObject({
      schedule: { id: managed.id, enabled: true, name: '允许改名' },
    })
  })
})
