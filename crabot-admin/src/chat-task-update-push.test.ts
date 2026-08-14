/**
 * 任务状态/计划变更 → chat_task_update 推送钩子测试
 * admin-web 来源任务推送；其他来源不推送。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import fs from 'node:fs/promises'
import AdminModule from './index.js'
import type { Task, CreateTaskParams, ChatTaskSnapshot, ChatMessage } from './types.js'

const TEST_PROTOCOL_PORT = 19828
const TEST_WEB_PORT = 13028
const TEST_DATA_DIR = './test-data/admin-chat-task-push-test'

describe('chat_task_update push hooks', () => {
  let admin: AdminModule
  let pushed: ChatTaskSnapshot[]

  beforeAll(async () => {
    await fs.rm(TEST_DATA_DIR, { recursive: true, force: true }).catch(() => {})
    admin = new AdminModule(
      {
        moduleId: 'admin-chat-task-push-test',
        moduleType: 'admin',
        version: '0.1.0',
        protocolVersion: '0.1.0',
        port: TEST_PROTOCOL_PORT,
        subscriptions: [],
      },
      {
        web_port: TEST_WEB_PORT,
        data_dir: TEST_DATA_DIR,
        password_env: 'TEST_ADMIN_PASSWORD_CHATPUSH',
        jwt_secret_env: 'TEST_JWT_SECRET_CHATPUSH',
        token_ttl: 3600,
      }
    )
    process.env.TEST_ADMIN_PASSWORD_CHATPUSH = 'test_password_123'
    process.env.TEST_JWT_SECRET_CHATPUSH = 'test_jwt_secret_at_least_32_chars'
    await admin.start()
  })

  afterAll(async () => {
    await admin.stop()
    await fs.rm(TEST_DATA_DIR, { recursive: true, force: true }).catch(() => {})
  })

  beforeEach(() => {
    pushed = []
    ;(admin as any).chatManager.pushTaskUpdate = (s: ChatTaskSnapshot) => { pushed.push(s) }
  })

  async function createTask(overrides: Partial<CreateTaskParams> = {}): Promise<Task> {
    const params: CreateTaskParams = {
      title: 'test',
      priority: 'normal',
      source: { trigger_type: 'manual', origin: 'human' },
      ...overrides,
    }
    const { task } = await (admin as any).handleCreateTask(params)
    return task
  }

  it('admin-web 任务状态变更 → 推送快照', async () => {
    const task = await createTask({
      source: {
        trigger_type: 'message',
        origin: 'human',
        channel_id: 'admin-web',
        session_id: 'admin-chat',
      },
    })
    await (admin as any).handleUpdateTaskStatus({ task_id: task.id, status: 'planning' })
    expect(pushed).toHaveLength(1)
    expect(pushed[0].task_id).toBe(task.id)
    expect(pushed[0].status).toBe('planning')
    expect(pushed[0].title).toBe('test')
  })

  it('非 admin-web 任务状态变更 → 不推送', async () => {
    const task = await createTask({
      source: { trigger_type: 'message', origin: 'human', channel_id: 'wechat-1', session_id: 's1' },
    })
    await (admin as any).handleUpdateTaskStatus({ task_id: task.id, status: 'planning' })
    expect(pushed).toHaveLength(0)
  })

  it('admin-web 任务 update_plan → 推送含 step 的快照', async () => {
    const task = await createTask({
      source: {
        trigger_type: 'message',
        origin: 'human',
        channel_id: 'admin-web',
        session_id: 'admin-chat',
      },
    })
    await (admin as any).handleUpdatePlan({
      task_id: task.id,
      plan: {
        goal: 'g',
        steps: [
          { id: 's1', description: '第一步', status: 'in_progress', retry_count: 0 },
          { id: 's2', description: '第二步', status: 'pending', retry_count: 0 },
        ],
        current_step_index: 0,
        created_at: '2026-06-10T00:00:00Z',
        updated_at: '2026-06-10T00:00:00Z',
      },
    })
    expect(pushed).toHaveLength(1)
    expect(pushed[0].step).toEqual({ index: 0, total: 2, description: '第一步' })
  })

  it('handleAppendMessage：admin-web 任务 + role=agent + source.platform_message_id → 回填聊天消息 task_id', async () => {
    // 1. 用 chatManager.handleSendMessage 造一条 assistant 消息（拿到 message_id）
    const chatMgr = (admin as any).chatManager
    const sendResult = await chatMgr.handleSendMessage({
      session_id: 'admin-chat',
      delivery_id: 'd-task-push-1',
      content: { type: 'text', text: 'worker 产出消息' },
    })
    const chatMsgId = sendResult.platform_message_id

    // 2. 创建 admin-web 来源任务
    const task = await createTask({
      source: {
        trigger_type: 'message',
        origin: 'human',
        channel_id: 'admin-web',
        session_id: 'admin-chat',
      },
    })

    // 3. 调 handleAppendMessage，带 role=agent + source.platform_message_id
    await (admin as any).handleAppendMessage({
      task_id: task.id,
      role: 'agent',
      content: 'worker 做完了',
      source: {
        channel_id: 'admin-web',
        platform_message_id: chatMsgId,
      },
    })

    // 4. 断言聊天消息的 task_id 已被回填
    const msgs: ChatMessage[] = chatMgr.getMessages(20)
    const chatMsg = msgs.find((m: ChatMessage) => m.message_id === chatMsgId)
    expect(chatMsg?.task_id).toBe(task.id)
  })

  it('listActiveChatTaskSnapshots：只含 admin-web 来源的非终态任务', async () => {
    const running = await createTask({
      title: '进行中的',
      source: { trigger_type: 'message', origin: 'human', channel_id: 'admin-web', session_id: 'admin-chat' },
    })
    const done = await createTask({
      title: '已完成的',
      source: { trigger_type: 'message', origin: 'human', channel_id: 'admin-web', session_id: 'admin-chat' },
    })
    await (admin as any).handleUpdateTaskStatus({ task_id: done.id, status: 'planning' })
    await (admin as any).handleUpdateTaskStatus({ task_id: done.id, status: 'executing' })
    await (admin as any).handleUpdateTaskStatus({ task_id: done.id, status: 'completed' })
    await createTask({
      title: '非 admin-web 的',
      source: { trigger_type: 'message', origin: 'human', channel_id: 'wechat-1', session_id: 's1' },
    })

    const snapshots = (admin as any).listActiveChatTaskSnapshots()
    const ids = snapshots.map((s: { task_id: string }) => s.task_id)
    expect(ids).toContain(running.id)
    expect(ids).not.toContain(done.id)
    expect(snapshots.find((s: { task_id: string }) => s.task_id === running.id).title).toBe('进行中的')
    expect(snapshots.every((s: { title: string }) => s.title !== '非 admin-web 的')).toBe(true)
  })
})
