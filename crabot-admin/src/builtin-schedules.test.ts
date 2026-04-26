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
})
