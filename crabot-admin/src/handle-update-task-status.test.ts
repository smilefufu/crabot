/**
 * Admin 模块 - handleUpdateTaskStatus 端到端行为测试
 *
 * 验证 handleUpdateTaskStatus 走 applyStatusTransition 后行为与重构前一致。
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs/promises'
import AdminModule from './index.js'
import type { Task, CreateTaskParams } from './types.js'

const TEST_PROTOCOL_PORT = 19820
const TEST_WEB_PORT = 13020
const TEST_DATA_DIR = './test-data/admin-status-transition-test'

describe('handleUpdateTaskStatus through applyStatusTransition', () => {
  let admin: AdminModule

  beforeAll(async () => {
    await fs.rm(TEST_DATA_DIR, { recursive: true, force: true }).catch(() => {})

    admin = new AdminModule(
      {
        moduleId: 'admin-status-transition-test',
        moduleType: 'admin',
        version: '0.1.0',
        protocolVersion: '0.1.0',
        port: TEST_PROTOCOL_PORT,
        subscriptions: [],
      },
      {
        web_port: TEST_WEB_PORT,
        data_dir: TEST_DATA_DIR,
        password_env: 'TEST_ADMIN_PASSWORD_STATUS',
        jwt_secret_env: 'TEST_JWT_SECRET_STATUS',
        token_ttl: 3600,
      }
    )

    process.env.TEST_ADMIN_PASSWORD_STATUS = 'test_password_123'
    process.env.TEST_JWT_SECRET_STATUS = 'test_jwt_secret_at_least_32_chars'

    await admin.start()
  })

  afterAll(async () => {
    await admin.stop()
    await fs.rm(TEST_DATA_DIR, { recursive: true, force: true }).catch(() => {})
  })

  async function createTask(overrides: Partial<CreateTaskParams> = {}): Promise<Task> {
    const params: CreateTaskParams = {
      title: 'test',
      description: 'test',
      priority: 'normal',
      source: { trigger_type: 'manual', origin: 'human' },
      ...overrides,
    }
    const { task } = await (admin as any).handleCreateTask(params)
    return task
  }

  it('transitions pending → planning → executing → waiting_human → executing → completed', async () => {
    const task = await createTask()
    await (admin as any).handleUpdateTaskStatus({ task_id: task.id, status: 'planning' })
    await (admin as any).handleUpdateTaskStatus({ task_id: task.id, status: 'executing' })
    const afterExec = (admin as any).tasks.get(task.id)
    expect(afterExec.started_at).toBeDefined()

    await (admin as any).handleUpdateTaskStatus({
      task_id: task.id,
      status: 'waiting_human',
      pending_question: '需要确认？',
    })
    const waiting = (admin as any).tasks.get(task.id)
    expect(waiting.waiting_human_at).toBeDefined()
    expect(waiting.pending_question).toBe('需要确认？')

    await (admin as any).handleUpdateTaskStatus({ task_id: task.id, status: 'executing' })
    const resumed = (admin as any).tasks.get(task.id)
    expect(resumed.waiting_human_at).toBeUndefined()
    expect(resumed.pending_question).toBeUndefined()
    expect(resumed.started_at).toBe(afterExec.started_at)  // sticky

    await (admin as any).handleUpdateTaskStatus({ task_id: task.id, status: 'completed' })
    const done = (admin as any).tasks.get(task.id)
    expect(done.completed_at).toBeDefined()
  })

  it('rejects invalid transition: completed → executing', async () => {
    const task = await createTask()
    await (admin as any).handleUpdateTaskStatus({ task_id: task.id, status: 'planning' })
    await (admin as any).handleUpdateTaskStatus({ task_id: task.id, status: 'executing' })
    await (admin as any).handleUpdateTaskStatus({ task_id: task.id, status: 'completed' })

    await expect(
      (admin as any).handleUpdateTaskStatus({ task_id: task.id, status: 'executing' }),
    ).rejects.toThrow()
  })

  it('completed 推进 schedule watermark 到 input.ingestion_time_end（窗口终点），避免任务执行期间的覆盖缺口', async () => {
    const scheduleId = 'sched-watermark-window-end'
    ;(admin as any).schedules.set(scheduleId, {
      id: scheduleId,
      name: 'watermark-window-test',
      description: '',
      trigger: { type: 'interval', seconds: 3600 },
      task_template: { type: 'memory_curate', title: 't', description: 'd' },
      enabled: true,
      is_builtin: false,
      execution_count: 0,
      created_at: '2026-07-01T00:00:00.000Z',
      updated_at: '2026-07-01T00:00:00.000Z',
    })
    const windowEnd = '2026-07-11T10:00:00.000Z'
    const task = await createTask({
      input: { schedule_id: scheduleId, ingestion_time_start: '2026-07-11T09:00:00.000Z', ingestion_time_end: windowEnd },
    })
    await (admin as any).handleUpdateTaskStatus({ task_id: task.id, status: 'planning' })
    await (admin as any).handleUpdateTaskStatus({ task_id: task.id, status: 'executing' })
    await (admin as any).handleUpdateTaskStatus({ task_id: task.id, status: 'completed' })

    const schedule = (admin as any).schedules.get(scheduleId)
    expect(schedule.watermark).toBe(windowEnd)
  })

  it('completed 时无 input.ingestion_time_end 的 schedule 任务，watermark 回退到 completed_at', async () => {
    const scheduleId = 'sched-watermark-completed-at'
    ;(admin as any).schedules.set(scheduleId, {
      id: scheduleId,
      name: 'watermark-fallback-test',
      description: '',
      trigger: { type: 'interval', seconds: 3600 },
      task_template: { type: 'daily_reflection', title: 't', description: 'd' },
      enabled: true,
      is_builtin: false,
      execution_count: 0,
      created_at: '2026-07-01T00:00:00.000Z',
      updated_at: '2026-07-01T00:00:00.000Z',
    })
    const task = await createTask({ input: { schedule_id: scheduleId } })
    await (admin as any).handleUpdateTaskStatus({ task_id: task.id, status: 'planning' })
    await (admin as any).handleUpdateTaskStatus({ task_id: task.id, status: 'executing' })
    await (admin as any).handleUpdateTaskStatus({ task_id: task.id, status: 'completed' })

    const done = (admin as any).tasks.get(task.id)
    const schedule = (admin as any).schedules.get(scheduleId)
    expect(schedule.watermark).toBe(done.completed_at)
  })

  it('waiting_human → failed clears waiting_human_at and pending_question', async () => {
    const task = await createTask()
    await (admin as any).handleUpdateTaskStatus({ task_id: task.id, status: 'planning' })
    await (admin as any).handleUpdateTaskStatus({ task_id: task.id, status: 'executing' })
    await (admin as any).handleUpdateTaskStatus({
      task_id: task.id,
      status: 'waiting_human',
      pending_question: 'q?',
    })
    await (admin as any).handleUpdateTaskStatus({ task_id: task.id, status: 'failed', error: 'gave up' })

    const final = (admin as any).tasks.get(task.id)
    expect(final.status).toBe('failed')
    expect(final.waiting_human_at).toBeUndefined()
    expect(final.pending_question).toBeUndefined()
    expect(final.completed_at).toBeDefined()
    expect(final.error).toBe('gave up')
  })
})
