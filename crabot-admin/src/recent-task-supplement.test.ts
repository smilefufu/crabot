import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import fs from 'node:fs/promises'
import AdminModule from './index.js'
import { AdminErrorCode, type CreateTaskParams, type Task } from './types.js'

const TEST_PROTOCOL_PORT = 19846
const TEST_WEB_PORT = 13046
const TEST_DATA_DIR = './test-data/admin-recent-task-supplement-test'

describe('recent terminal task supplement RPCs', () => {
  let admin: AdminModule

  beforeAll(async () => {
    await fs.rm(TEST_DATA_DIR, { recursive: true, force: true }).catch(() => {})

    admin = new AdminModule(
      {
        moduleId: 'admin-recent-task-supplement-test',
        moduleType: 'admin',
        version: '0.1.0',
        protocolVersion: '0.1.0',
        port: TEST_PROTOCOL_PORT,
        subscriptions: [],
      },
      {
        web_port: TEST_WEB_PORT,
        data_dir: TEST_DATA_DIR,
        password_env: 'TEST_ADMIN_PASSWORD_RECENT_SUPPLEMENT',
        jwt_secret_env: 'TEST_JWT_SECRET_RECENT_SUPPLEMENT',
        token_ttl: 3600,
      }
    )

    process.env.TEST_ADMIN_PASSWORD_RECENT_SUPPLEMENT = 'test_password_123'
    process.env.TEST_JWT_SECRET_RECENT_SUPPLEMENT = 'test_jwt_secret_at_least_32_chars'

    await admin.start()
  })

  afterAll(async () => {
    await admin.stop()
    await fs.rm(TEST_DATA_DIR, { recursive: true, force: true }).catch(() => {})
  })

  beforeEach(() => {
    ;(admin as any).tasks = new Map()
  })

  async function createTask(overrides: Partial<CreateTaskParams> = {}): Promise<Task> {
    const params: CreateTaskParams = {
      title: 'test task',
      priority: 'normal',
      source: {
        trigger_type: 'message',
        origin: 'human',
        channel_id: 'ch',
        session_id: 'sess',
      },
      initial_message: {
        content: '开始任务',
        source: { channel_id: 'ch', session_id: 'sess' },
      },
      ...overrides,
    }
    const { task } = await (admin as any).handleCreateTask(params)
    return task
  }

  async function completeTask(overrides: Partial<CreateTaskParams> = {}): Promise<Task> {
    const task = await createTask(overrides)
    await (admin as any).handleUpdateTaskStatus({ task_id: task.id, status: 'planning' })
    await (admin as any).handleUpdateTaskStatus({ task_id: task.id, status: 'executing' })
    await (admin as any).handleUpdateTaskStatus({ task_id: task.id, status: 'completed' })
    return (admin as any).tasks.get(task.id)
  }

  async function failTask(error: string, overrides: Partial<CreateTaskParams> = {}): Promise<Task> {
    const task = await createTask(overrides)
    await (admin as any).handleUpdateTaskStatus({ task_id: task.id, status: 'planning' })
    await (admin as any).handleUpdateTaskStatus({ task_id: task.id, status: 'executing' })
    await (admin as any).handleUpdateTaskStatus({ task_id: task.id, status: 'failed', error })
    return (admin as any).tasks.get(task.id)
  }

  async function cancelTask(overrides: Partial<CreateTaskParams> = {}): Promise<Task> {
    const task = await createTask(overrides)
    const { task: cancelled } = await (admin as any).handleCancelTask({
      task_id: task.id,
      reason: 'user-canceled',
    })
    return cancelled
  }

  function setCompletedAt(task: Task, completedAt: string): void {
    task.completed_at = completedAt
    task.updated_at = completedAt
    ;(admin as any).tasks.set(task.id, task)
  }

  it('handleListRecentTerminalTasks lists completed and recoverable failed tasks sorted by completed_at desc, excluding cancelled', async () => {
    const since = '2026-06-29T00:00:00.000Z'
    const older = await completeTask({ title: 'older completed' })
    setCompletedAt(older, '2026-06-29T10:00:00.000Z')
    const newerFailed = await failTask('network timeout', { title: 'newer recoverable failed' })
    setCompletedAt(newerFailed, '2026-06-29T11:00:00.000Z')
    const cancelled = await cancelTask({ title: 'cancelled task' })
    setCompletedAt(cancelled, '2026-06-29T12:00:00.000Z')
    const systemFailed = await failTask('agent_restarted_during_execution', { title: 'self healing failure' })
    setCompletedAt(systemFailed, '2026-06-29T13:00:00.000Z')
    const manualFailed = await failTask('人工取消', { title: 'manual cancel failure' })
    setCompletedAt(manualFailed, '2026-06-29T14:00:00.000Z')
    const otherSession = await completeTask({
      title: 'other session',
      source: { trigger_type: 'message', origin: 'human', channel_id: 'ch', session_id: 'other' },
    })
    setCompletedAt(otherSession, '2026-06-29T15:00:00.000Z')

    const result = await (admin as any).handleListRecentTerminalTasks({
      channel_id: 'ch',
      session_id: 'sess',
      since,
      limit: 10,
    })

    expect(result.items.map((t: Task) => t.id)).toEqual([newerFailed.id, older.id])
  })

  it('handleListRecentTerminalTasks uses completed_at window, not created_at window', async () => {
    const task = await completeTask({ title: 'old created recent completed' })
    task.created_at = '2026-06-01T00:00:00.000Z'
    setCompletedAt(task, '2026-06-29T10:00:00.000Z')

    const result = await (admin as any).handleListRecentTerminalTasks({
      channel_id: 'ch',
      session_id: 'sess',
      since: '2026-06-29T00:00:00.000Z',
      limit: 10,
    })

    expect(result.items.map((t: Task) => t.id)).toEqual([task.id])
  })

  it('handleReviveTaskForSupplement revives completed task without opening generic terminal transition', async () => {
    const task = await completeTask({ title: 'revive me' })
    task.waiting_human_at = '2026-06-29T09:00:00.000Z'
    task.waiting_at = '2026-06-29T09:01:00.000Z'
    task.pending_question = '旧问题'
    task.error = 'old error'
    ;(admin as any).tasks.set(task.id, task)

    await expect(
      (admin as any).handleUpdateTaskStatus({ task_id: task.id, status: 'executing' }),
    ).rejects.toThrow(AdminErrorCode.INVALID_STATUS_TRANSITION)

    const result = await (admin as any).handleReviveTaskForSupplement({
      task_id: task.id,
      channel_id: 'ch',
      session_id: 'sess',
      supplement_text: '继续刚才的',
    })

    expect(result.task.status).toBe('executing')
    expect(result.task.completed_at).toBeUndefined()
    expect(result.task.error).toBeUndefined()
    expect(result.task.waiting_human_at).toBeUndefined()
    expect(result.task.waiting_at).toBeUndefined()
    expect(result.task.pending_question).toBeUndefined()
    expect(result.task.started_at).toBeDefined()
    expect(result.task.messages.at(-1)).toMatchObject({
      role: 'human',
      content: expect.stringContaining('继续刚才的'),
      source: { channel_id: 'ch', session_id: 'sess' },
    })
  })

  it('handleReviveTaskForSupplement rejects wrong session and non-terminal task', async () => {
    const terminal = await completeTask()
    await expect(
      (admin as any).handleReviveTaskForSupplement({
        task_id: terminal.id,
        channel_id: 'ch',
        session_id: 'other',
        supplement_text: '继续',
      }),
    ).rejects.toThrow(AdminErrorCode.TASK_NOT_FOUND)

    const active = await createTask()
    await expect(
      (admin as any).handleReviveTaskForSupplement({
        task_id: active.id,
        channel_id: 'ch',
        session_id: 'sess',
        supplement_text: '继续',
      }),
    ).rejects.toThrow(AdminErrorCode.INVALID_STATUS_TRANSITION)
  })
})
