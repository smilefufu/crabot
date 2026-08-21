/**
 * Admin 模块 Task 和 Schedule 管理测试
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import http from 'node:http'
import fs from 'node:fs/promises'
import AdminModule from './index.js'
import { RpcClient } from 'crabot-shared'
import type { Friend, Task, Schedule } from './types.js'

const TEST_PROTOCOL_PORT = 19802
const TEST_WEB_PORT = 13002
const TEST_DATA_DIR = './test-data/admin-task-schedule-test'

let admin: AdminModule

// Helper function for protocol requests
interface ProtocolResponse<D = unknown> {
  id: string
  success: boolean
  data: D
  error?: { code: string; message: string }
  timestamp: string
}

function makeProtocolRequest<D = unknown>(
  port: number,
  method: string,
  params: unknown
): Promise<ProtocolResponse<D>> {
  return new Promise((resolve, reject) => {
    const request = {
      id: `test-${Date.now()}`,
      source: 'test',
      method,
      params,
      timestamp: new Date().toISOString(),
    }

    const body = JSON.stringify(request)

    const req = http.request(
      {
        hostname: 'localhost',
        port,
        method: 'POST',
        path: `/${method}`,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = ''
        res.on('data', (chunk) => {
          data += chunk
        })
        res.on('end', () => {
          try {
            resolve(JSON.parse(data) as ProtocolResponse<D>)
          } catch (e) {
            reject(new Error(`Failed to parse response: ${String(e)}`))
          }
        })
      }
    )

    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

describe('AdminModule - Task Management', () => {
  let masterFriendId: string

  beforeAll(async () => {
    // 清理测试数据目录
    try {
      await fs.rm(TEST_DATA_DIR, { recursive: true, force: true })
    } catch {
      // ignore
    }

    admin = new AdminModule(
      {
        moduleId: 'admin-task-test',
        moduleType: 'admin',
        version: '0.1.0',
        protocolVersion: '0.1.0',
        port: TEST_PROTOCOL_PORT,
        subscriptions: [],
      },
      {
        web_port: TEST_WEB_PORT,
        data_dir: TEST_DATA_DIR,
        password_env: 'TEST_ADMIN_TASK_PASSWORD',
        jwt_secret_env: 'TEST_JWT_SECRET_TASK',
        token_ttl: 3600,
      }
    )

    // 设置测试环境变量
    process.env.TEST_ADMIN_TASK_PASSWORD = 'test_password_123'
    process.env.TEST_JWT_SECRET_TASK = 'test_jwt_secret_at_least_32_chars'

    await admin.start()

    // 创建 master friend 用于测试
    const createResponse = await makeProtocolRequest<{ friend: Friend }>(
      TEST_PROTOCOL_PORT,
      'create_friend',
      {
        display_name: 'Task Master',
        permission: 'master',
      }
    )

    expect(createResponse.success).toBe(true)
    masterFriendId = createResponse.data.friend.id
  })

  afterAll(async () => {
    await admin.stop()
    // 清理测试数据
    try {
      await fs.rm(TEST_DATA_DIR, { recursive: true, force: true })
    } catch {
      // ignore
    }
  })

  describe('create_task', () => {
    it('should create a task', async () => {
      const response = await makeProtocolRequest<{ task: Task }>(
        TEST_PROTOCOL_PORT,
        'create_task',
        {
          type: 'generic',
          title: 'Test Task',
          description: 'A test task for unit testing',
          priority: 'normal',
          source: {
            trigger_type: 'manual',
          },
        }
      )

      expect(response.success).toBe(true)
      expect(response.data.task.title).toBe('Test Task')
      expect(response.data.task.status).toBe('pending')
      expect(response.data.task.id).toBeDefined()
    })
  })

  describe('get_task', () => {
    it('should get a task by id', async () => {
      // 先创建任务
      const createResponse = await makeProtocolRequest<{ task: Task }>(
        TEST_PROTOCOL_PORT,
        'create_task',
        {
          type: 'generic',
          title: 'Get Task Test',
          source: { trigger_type: 'manual' },
        }
      )

      const taskId = createResponse.data.task.id

      const response = await makeProtocolRequest<{ task: Task }>(
        TEST_PROTOCOL_PORT,
        'get_task',
        { task_id: taskId }
      )

      expect(response.success).toBe(true)
      expect(response.data.task.id).toBe(taskId)
      expect(response.data.task.title).toBe('Get Task Test')
    })

    it('should return error for non-existent task', async () => {
      const response = await makeProtocolRequest(
        TEST_PROTOCOL_PORT,
        'get_task',
        { task_id: 'non-existent-task' }
      )

      expect(response.success).toBe(false)
    })
  })

  describe('list_tasks', () => {
    it('should list tasks', async () => {
      // 创建一些任务
      await makeProtocolRequest(TEST_PROTOCOL_PORT, 'create_task', {
        type: 'generic',
        title: 'List Test Task 1',
        source: { trigger_type: 'manual' },
      })
      await makeProtocolRequest(TEST_PROTOCOL_PORT, 'create_task', {
        type: 'generic',
        title: 'List Test Task 2',
        source: { trigger_type: 'manual' },
      })

      const response = await makeProtocolRequest<{ items: Task[]; pagination: { total_items: number } }>(
        TEST_PROTOCOL_PORT,
        'list_tasks',
        {}
      )

      expect(response.success).toBe(true)
      expect(response.data.items.length).toBeGreaterThanOrEqual(2)
      expect(response.data.pagination.total_items).toBeGreaterThanOrEqual(2)
    })
  })

  describe('update_task_status', () => {
    it('should update task status', async () => {
      // 创建任务
      const createResponse = await makeProtocolRequest<{ task: Task }>(
        TEST_PROTOCOL_PORT,
        'create_task',
        {
          type: 'generic',
          title: 'Status Update Test',
          source: { trigger_type: 'manual' },
        }
      )

      const taskId = createResponse.data.task.id

      // pending -> planning (valid transition)
      const response = await makeProtocolRequest<{ task: Task }>(
        TEST_PROTOCOL_PORT,
        'update_task_status',
        {
          task_id: taskId,
          status: 'planning',
        }
      )

      expect(response.success).toBe(true)
      expect(response.data.task.status).toBe('planning')
    })

    it('should follow valid status transitions', async () => {
      // 创建任务
      const createResponse = await makeProtocolRequest<{ task: Task }>(
        TEST_PROTOCOL_PORT,
        'create_task',
        {
          type: 'generic',
          title: 'Status Transition Test',
          source: { trigger_type: 'manual' },
        }
      )

      const taskId = createResponse.data.task.id

      // pending -> planning -> executing (valid chain)
      await makeProtocolRequest<{ task: Task }>(
        TEST_PROTOCOL_PORT,
        'update_task_status',
        {
          task_id: taskId,
          status: 'planning',
        }
      )

      const response = await makeProtocolRequest<{ task: Task }>(
        TEST_PROTOCOL_PORT,
        'update_task_status',
        {
          task_id: taskId,
          status: 'executing',
        }
      )

      expect(response.success).toBe(true)
      expect(response.data.task.status).toBe('executing')
    })
  })

  describe('append_message', () => {
    it('should append a message to task', async () => {
      // 创建任务
      const createResponse = await makeProtocolRequest<{ task: Task }>(
        TEST_PROTOCOL_PORT,
        'create_task',
        {
          type: 'generic',
          title: 'Message Append Test',
          source: { trigger_type: 'manual' },
        }
      )

      const taskId = createResponse.data.task.id

      // spec 2026-06-09-task-trace-tool-unification.md §4.2: TaskMessage type 字段已改成 role + agent_intent。
      // 旧 type='info' 语义 = agent 出站 info 消息 → role='agent' + agent_intent='info'。
      const response = await makeProtocolRequest<{ message: { id: string; role: string; agent_intent?: string; content: string } }>(
        TEST_PROTOCOL_PORT,
        'append_message',
        {
          task_id: taskId,
          role: 'agent',
          agent_intent: 'info',
          content: 'Test message content',
        }
      )

      expect(response.success).toBe(true)
      expect(response.data.message.id).toBeDefined()
      expect(response.data.message.role).toBe('agent')
      expect(response.data.message.agent_intent).toBe('info')
      expect(response.data.message.content).toBe('Test message content')
    })
  })

  describe('get_task_messages', () => {
    it('should get task messages', async () => {
      // 创建任务并添加消息
      const createResponse = await makeProtocolRequest<{ task: Task }>(
        TEST_PROTOCOL_PORT,
        'create_task',
        {
          type: 'generic',
          title: 'Messages Test',
          source: { trigger_type: 'manual' },
        }
      )

      const taskId = createResponse.data.task.id

      await makeProtocolRequest(TEST_PROTOCOL_PORT, 'append_message', {
        task_id: taskId,
        role: 'agent',
        content: 'Test message 1',
      })

      const response = await makeProtocolRequest<{ items: Array<{ role: string; content: string }[]> }>(
        TEST_PROTOCOL_PORT,
        'get_task_messages',
        { task_id: taskId }
      )

      expect(response.success).toBe(true)
      expect(response.data.items.length).toBeGreaterThanOrEqual(1)
    })
  })

  describe('get_task_stats', () => {
    it('should return task statistics', async () => {
      const response = await makeProtocolRequest<{
        total: number
        by_status: Record<string, number>
        by_priority: Record<string, number>
      }>(
        TEST_PROTOCOL_PORT,
        'get_task_stats',
        {}
      )

      expect(response.success).toBe(true)
      expect(response.data.total).toBeDefined()
      expect(response.data.by_status).toBeDefined()
      expect(response.data.by_priority).toBeDefined()
    })
  })

  describe('legacy task mutation RPC retirement', () => {
    it.each([
      ['cancel_task', { task_id: 'legacy-task-id', reason: 'retired' }],
      ['list_recent_terminal_tasks', { channel_id: 'channel-1', session_id: 'session-1', since: new Date(0).toISOString(), limit: 3 }],
      ['revive_task_for_supplement', { task_id: 'legacy-task-id', channel_id: 'channel-1', session_id: 'session-1', supplement_text: 'retired' }],
    ])('does not expose %s', async (method, params) => {
      const response = await makeProtocolRequest(TEST_PROTOCOL_PORT, method, params)
      expect(response.success).toBe(false)
    })
  })
})

describe('AdminModule - Schedule Management', () => {
  beforeAll(async () => {
    // 清理测试数据目录
    try {
      await fs.rm(TEST_DATA_DIR, { recursive: true, force: true })
    } catch {
      // ignore
    }

    admin = new AdminModule(
      {
        moduleId: 'admin-schedule-test',
        moduleType: 'admin',
        version: '0.1.0',
        protocolVersion: '0.1.0',
        port: TEST_PROTOCOL_PORT,
        subscriptions: [],
      },
      {
        web_port: TEST_WEB_PORT,
        data_dir: TEST_DATA_DIR,
        password_env: 'TEST_ADMIN_SCHED_PASSWORD',
        jwt_secret_env: 'TEST_JWT_SECRET_SCHED',
        token_ttl: 3600,
      }
    )

    // 设置测试环境变量
    process.env.TEST_ADMIN_SCHED_PASSWORD = 'test_password_123'
    process.env.TEST_JWT_SECRET_SCHED = 'test_jwt_secret_at_least_32_chars'

    await admin.start()
  })

  afterAll(async () => {
    await admin.stop()
    // 清理测试数据
    try {
      await fs.rm(TEST_DATA_DIR, { recursive: true, force: true })
    } catch {
      // ignore
    }
  })

  describe('create_schedule', () => {
    it('should create a schedule', async () => {
      const response = await makeProtocolRequest<{ schedule: Schedule }>(
        TEST_PROTOCOL_PORT,
        'create_schedule',
        {
          name: 'Test Schedule',
          trigger: {
            type: 'cron',
            expression: '0 0 * * *',
          },
          task_template: {
            type: 'routine',
            title: 'Scheduled Task',
            priority: 'normal',
          },
          enabled: true,
        }
      )

      expect(response.success).toBe(true)
      expect(response.data.schedule.name).toBe('Test Schedule')
      expect(response.data.schedule.id).toBeDefined()
    })

    it('rejects creator_friend_id pointing to a non-existent friend', async () => {
      const response = await makeProtocolRequest<{ schedule: Schedule }>(
        TEST_PROTOCOL_PORT,
        'create_schedule',
        {
          name: 'Schedule with bogus creator',
          trigger: { type: 'cron', expression: '0 0 * * *' },
          task_template: { type: 'routine', title: 'Bogus', priority: 'normal' },
          enabled: true,
          creator_friend_id: 'friend-that-does-not-exist',
        } as Record<string, unknown>
      )

      expect(response.success).toBe(false)
    })
  })

  describe('get_schedule', () => {
    it('should get a schedule by id', async () => {
      // 先创建调度
      const createResponse = await makeProtocolRequest<{ schedule: Schedule }>(
        TEST_PROTOCOL_PORT,
        'create_schedule',
        {
          name: 'Get Schedule Test',
          trigger: {
            type: 'cron',
            expression: '0 0 * * *',
          },
          task_template: {
            type: 'routine',
            title: 'Scheduled Task',
            priority: 'normal',
          },
        }
      )

      const scheduleId = createResponse.data.schedule.id

      const response = await makeProtocolRequest<{ schedule: Schedule }>(
        TEST_PROTOCOL_PORT,
        'get_schedule',
        { schedule_id: scheduleId }
      )

      expect(response.success).toBe(true)
      expect(response.data.schedule.id).toBe(scheduleId)
    })

    it('should return error for non-existent schedule', async () => {
      const response = await makeProtocolRequest(
        TEST_PROTOCOL_PORT,
        'get_schedule',
        { schedule_id: 'non-existent-schedule' }
      )

      expect(response.success).toBe(false)
    })
  })

  describe('list_schedules', () => {
    it('should list schedules', async () => {
      // 创建几个调度
      await makeProtocolRequest(TEST_PROTOCOL_PORT, 'create_schedule', {
        name: 'List Test Schedule 1',
        trigger: { type: 'cron', expression: '0 0 * * *' },
        task_template: { type: 'routine', title: 'Task 1', priority: 'normal' },
      })
      await makeProtocolRequest(TEST_PROTOCOL_PORT, 'create_schedule', {
        name: 'List Test Schedule 2',
        trigger: { type: 'cron', expression: '0 0 * * *' },
        task_template: { type: 'routine', title: 'Task 2', priority: 'normal' },
      })

      const response = await makeProtocolRequest<{ items: Schedule[]; pagination: { total_items: number } }>(
        TEST_PROTOCOL_PORT,
        'list_schedules',
        {}
      )

      expect(response.success).toBe(true)
      expect(response.data.items.length).toBeGreaterThanOrEqual(2)
    })
  })

  describe('update_schedule', () => {
    it('should update a schedule', async () => {
      // 先创建调度
      const createResponse = await makeProtocolRequest<{ schedule: Schedule }>(
        TEST_PROTOCOL_PORT,
        'create_schedule',
        {
          name: 'Update Test Schedule',
          trigger: { type: 'cron', expression: '0 0 * * *' },
          task_template: { type: 'routine', title: 'Task', priority: 'normal' },
        }
      )

      const scheduleId = createResponse.data.schedule.id

      const response = await makeProtocolRequest<{ schedule: Schedule }>(
        TEST_PROTOCOL_PORT,
        'update_schedule',
        {
          schedule_id: scheduleId,
          name: 'Updated Schedule Name',
          enabled: false,
        }
      )

      expect(response.success).toBe(true)
      expect(response.data.schedule.name).toBe('Updated Schedule Name')
      expect(response.data.schedule.enabled).toBe(false)
    })
  })

  describe('delete_schedule', () => {
    it('should delete a schedule', async () => {
      // 先创建调度
      const createResponse = await makeProtocolRequest<{ schedule: Schedule }>(
        TEST_PROTOCOL_PORT,
        'create_schedule',
        {
          name: 'Delete Test Schedule',
          trigger: { type: 'cron', expression: '0 0 * * *' },
          task_template: { type: 'routine', title: 'Task', priority: 'normal' },
        }
      )

      const scheduleId = createResponse.data.schedule.id

      const response = await makeProtocolRequest<{ deleted: true }>(
        TEST_PROTOCOL_PORT,
        'delete_schedule',
        { schedule_id: scheduleId }
      )

      expect(response.success).toBe(true)
      expect(response.data.deleted).toBe(true)
    })
  })

  describe('trigger_now', () => {
    let triggerCallSpy: ReturnType<typeof vi.spyOn>
    let resolveSpy: ReturnType<typeof vi.spyOn>

    beforeAll(() => {
      resolveSpy = vi.spyOn(RpcClient.prototype, 'resolve').mockImplementation(
        (params: { module_id?: string; module_type?: string }) => {
          if (params.module_id === 'wechat-棉花糖') {
            return Promise.resolve([{ module_id: 'wechat-棉花糖', port: 19998, module_type: 'channel' }])
          }
          return Promise.resolve([{ module_id: 'mock-agent', port: 19999, module_type: 'agent' }])
        }
      )
      triggerCallSpy = vi.spyOn(RpcClient.prototype, 'call').mockImplementation(
        (_port: unknown, method: string, params: unknown) => {
          if (method === 'trigger_schedule') {
            return Promise.resolve({ accepted: true })
          }
          if (method === 'get_session') {
            return Promise.reject(new Error(`Session not found: ${(params as { session_id?: string }).session_id}`))
          }
          if (method === 'get_sessions') {
            const page = (params as { pagination?: { page?: number } }).pagination?.page ?? 1
            return Promise.resolve({
              items: page === 1
                ? [
                    {
                      id: 'other-session-on-page-1',
                      channel_id: 'wechat-棉花糖',
                      type: 'group',
                      platform_session_id: '11111111111@chatroom',
                      title: '第一页其他群',
                    },
                    {
                      id: 'current-master-private-session',
                      channel_id: 'wechat-棉花糖',
                      type: 'private',
                      platform_session_id: 'master-user',
                      title: 'Task Master',
                    },
                  ]
                : [
                    {
                      id: 'current-claude-codex-session',
                      channel_id: 'wechat-棉花糖',
                      type: 'group',
                      platform_session_id: '54213229026@chatroom',
                      title: 'Claude&codex开发工具',
                    },
              ],
              pagination: { page, page_size: 500, total_items: 502, total_pages: 2 },
            })
          }
          return Promise.resolve({})
        }
      )
    })

    afterAll(() => {
      triggerCallSpy.mockRestore()
      resolveSpy.mockRestore()
    })

    it('should trigger a schedule via Agent RPC', async () => {
      const createResponse = await makeProtocolRequest<{ schedule: Schedule }>(
        TEST_PROTOCOL_PORT,
        'create_schedule',
        {
          name: 'Trigger Test Schedule',
          trigger: { type: 'cron', expression: '0 0 * * *' },
          task_template: { type: 'routine', title: 'Scheduled Task', priority: 'normal', tags: [] },
        }
      )

      const scheduleId = createResponse.data.schedule.id

      const response = await makeProtocolRequest<{ task_id: string; schedule: Schedule }>(
        TEST_PROTOCOL_PORT,
        'trigger_now',
        { schedule_id: scheduleId }
      )

      expect(response.success).toBe(true)
      expect(response.data.schedule.last_triggered_at).toBeDefined()
      expect(response.data.schedule.execution_count).toBeGreaterThanOrEqual(1)
    })

    /**
     * P7/J：调用点切到 `trigger_schedule`（protocol-agent-v3 §8.2）。
     * 普通 schedule 不下发 `task_type` / `input` / `resolved_permissions`——
     * 模板变量仍在 title/description 上渲染，权限改由 agent 按 `creator_friend_id` 解析，
     * 所以 admin 传的是**事实**（谁建的、是不是内置），不是解析结果。
     */
    it('普通 schedule 切到 trigger_schedule：渲染 title/description，不下发 task_type/input/resolved_permissions', async () => {
      const schedResult = await makeProtocolRequest<{ schedule: Schedule }>(
        TEST_PROTOCOL_PORT,
        'create_schedule',
        {
          name: 'Template Input Propagation Schedule',
          trigger: { type: 'cron', expression: '0 0 * * *' },
          task_template: {
            type: 'routine',
            title: 'Targeted Task {{date}}',
            description: 'Send update at {{datetime}}',
            priority: 'normal',
            tags: [],
            input: {
              target_channel_id: 'feishu-fengyan',
              target_session_id: 'e283b6c6-373a-4568-ab6f-db134fa71790',
              target_session_type: 'group',
            },
          },
        }
      )

      expect(schedResult.success).toBe(true)
      const scheduleId = schedResult.data!.schedule.id

      await makeProtocolRequest(TEST_PROTOCOL_PORT, 'trigger_now', { schedule_id: scheduleId })

      // 旧 RPC 一次都不该再被调到
      expect(
        triggerCallSpy.mock.calls.some((call) => call[1] === 'create_task_from_schedule'),
      ).toBe(false)

      const agentCall = triggerCallSpy.mock.calls.findLast((call) => call[1] === 'trigger_schedule')
      expect(agentCall).toBeTruthy()
      const payload = agentCall![2] as Record<string, unknown>
      expect(payload.schedule_id).toBe(scheduleId)
      expect(payload.title).toMatch(/^Targeted Task \d{4}-\d{2}-\d{2}$/)
      expect(String(payload.description)).toContain('Send update at 20')
      expect(payload.task_type).toBeUndefined()
      expect(payload.input).toBeUndefined()
      expect(payload.resolved_permissions).toBeUndefined()
    })

    it('trigger_schedule 带上 creator_friend_id（权限改由 agent 侧按它解析）', async () => {
      const friendResult = await makeProtocolRequest<{ friend: Friend }>(
        TEST_PROTOCOL_PORT,
        'create_friend',
        {
          display_name: 'Schedule Creator',
          permission: 'normal',
          channel_identities: [
            { channel_id: 'wechat-棉花糖', platform_user_id: 'creator-user', platform_display_name: 'Creator' },
          ],
        }
      )
      expect(friendResult.success).toBe(true)
      const creatorId = friendResult.data!.friend.id

      const schedResult = await makeProtocolRequest<{ schedule: Schedule }>(
        TEST_PROTOCOL_PORT,
        'create_schedule',
        {
          name: 'Creator Fact Passthrough',
          trigger: { type: 'cron', expression: '0 0 * * *' },
          task_template: { type: 'routine', title: 'T', description: 'D', priority: 'normal', tags: [] },
          creator_friend_id: creatorId,
        }
      )
      expect(schedResult.success).toBe(true)

      await makeProtocolRequest(TEST_PROTOCOL_PORT, 'trigger_now', {
        schedule_id: schedResult.data!.schedule.id,
      })

      const payload = triggerCallSpy.mock.calls.findLast(
        (call) => call[1] === 'trigger_schedule',
      )![2] as Record<string, unknown>
      expect(payload.creator_friend_id).toBe(creatorId)
    })

    it('受理即返回：trigger_now 不再回 task_id，schedule 也不再写 last_task_id', async () => {
      const schedResult = await makeProtocolRequest<{ schedule: Schedule }>(
        TEST_PROTOCOL_PORT,
        'create_schedule',
        {
          name: 'Accepted Only Schedule',
          trigger: { type: 'cron', expression: '0 0 * * *' },
          task_template: { type: 'routine', title: 'T', description: 'D', priority: 'normal', tags: [] },
        }
      )

      const response = await makeProtocolRequest<{ accepted: true; schedule: Schedule; task_id?: string }>(
        TEST_PROTOCOL_PORT,
        'trigger_now',
        { schedule_id: schedResult.data!.schedule.id }
      )

      expect(response.success).toBe(true)
      expect(response.data.accepted).toBe(true)
      expect(response.data.task_id).toBeUndefined()
      expect(response.data.schedule.last_task_id).toBeUndefined()
      expect(response.data.schedule.execution_count).toBeGreaterThanOrEqual(1)
    })

    it('builtin memory_maintenance forwards system-task metadata and stores returned task_id', async () => {
      const defaultImplementation = triggerCallSpy.getMockImplementation()
      triggerCallSpy.mockImplementation(
        (_port: unknown, method: string, params: unknown) => {
          if (method === 'trigger_schedule') {
            const payload = params as { task_type?: string; is_builtin?: boolean }
            return Promise.resolve(payload.task_type === 'memory_maintenance' && payload.is_builtin
              ? { accepted: true, task_id: 'agent-system-task-1' }
              : { accepted: true })
          }
          return defaultImplementation?.(_port, method, params)
        },
      )
      try {
        const list = await makeProtocolRequest<{ items: Schedule[] }>(
          TEST_PROTOCOL_PORT,
          'list_schedules',
          { page: 1, page_size: 100, filter: {} },
        )
        const maintenance = list.data!.items.find(
          (schedule) => schedule.is_builtin && schedule.task_template.type === 'memory_maintenance',
        )!

        const response = await makeProtocolRequest<{
          accepted: true
          schedule: Schedule
          task_id?: string
        }>(TEST_PROTOCOL_PORT, 'trigger_now', { schedule_id: maintenance.id })

        const call = triggerCallSpy.mock.calls.findLast((item) => item[1] === 'trigger_schedule')!
        expect(call[2]).toMatchObject({
          schedule_id: maintenance.id,
          task_type: 'memory_maintenance',
          priority: 'low',
          input: undefined,
          tags: ['memory_maintenance', 'builtin'],
          is_builtin: true,
        })
        expect(response.data!.task_id).toBe('agent-system-task-1')
        expect(response.data!.schedule.last_task_id).toBe('agent-system-task-1')
      } finally {
        triggerCallSpy.mockImplementation(defaultImplementation!)
      }
    })

    it('builtin daily_reflection forwards task_type without maintenance metadata', async () => {
      const list = await makeProtocolRequest<{ items: Schedule[] }>(
        TEST_PROTOCOL_PORT,
        'list_schedules',
        { page: 1, page_size: 100, filter: {} },
      )
      const dailyReflection = list.data!.items.find(
        (schedule) => schedule.is_builtin && schedule.task_template.type === 'daily_reflection',
      )!

      const response = await makeProtocolRequest<{
        accepted: true
        schedule: Schedule
        task_id?: string
      }>(TEST_PROTOCOL_PORT, 'trigger_now', { schedule_id: dailyReflection.id })

      const call = triggerCallSpy.mock.calls.findLast((item) => item[1] === 'trigger_schedule')!
      expect(call[2]).toMatchObject({
        schedule_id: dailyReflection.id,
        task_type: 'daily_reflection',
        is_builtin: true,
      })
      expect(call[2]).not.toHaveProperty('priority')
      expect(call[2]).not.toHaveProperty('input')
      expect(call[2]).not.toHaveProperty('tags')
      expect(response.data!.task_id).toBeUndefined()
      expect(response.data!.schedule.last_task_id).toBeUndefined()
    })

    it('user-created memory_maintenance type remains on the ordinary manager route', async () => {
      const created = await makeProtocolRequest<{ schedule: Schedule }>(
        TEST_PROTOCOL_PORT,
        'create_schedule',
        {
          name: 'User maintenance lookalike',
          trigger: { type: 'cron', expression: '0 6 * * *' },
          task_template: {
            type: 'memory_maintenance',
            title: 'User-owned task',
            priority: 'normal',
            tags: ['user-owned'],
            input: { scope: 'all' },
          },
        },
      )

      const response = await makeProtocolRequest<{ accepted: true; task_id?: string }>(
        TEST_PROTOCOL_PORT,
        'trigger_now',
        { schedule_id: created.data!.schedule.id },
      )

      const call = triggerCallSpy.mock.calls.findLast((item) => item[1] === 'trigger_schedule')!
      expect(call[2]).toMatchObject({
        schedule_id: created.data!.schedule.id,
      })
      expect(call[2]).not.toHaveProperty('task_type')
      expect(call[2]).not.toHaveProperty('priority')
      expect(call[2]).not.toHaveProperty('input')
      expect(call[2]).not.toHaveProperty('tags')
      expect(response.data!.task_id).toBeUndefined()
    })

    it('forwards retired user memory_curate only for Agent fail-loud handling', async () => {
      const created = await makeProtocolRequest<{ schedule: Schedule }>(
        TEST_PROTOCOL_PORT,
        'create_schedule',
        {
          name: 'Legacy memory curate',
          trigger: { type: 'cron', expression: '0 6 * * *' },
          task_template: {
            type: 'memory_curate',
            title: '旧记忆整理',
            priority: 'normal',
            tags: ['user-owned'],
            input: { scope: 'all' },
          },
        },
      )

      const response = await makeProtocolRequest<{ accepted: true; task_id?: string }>(
        TEST_PROTOCOL_PORT,
        'trigger_now',
        { schedule_id: created.data!.schedule.id },
      )

      const call = triggerCallSpy.mock.calls.findLast((item) => item[1] === 'trigger_schedule')!
      expect(call[2]).toMatchObject({
        schedule_id: created.data!.schedule.id,
        task_type: 'memory_curate',
      })
      expect(call[2]).not.toHaveProperty('priority')
      expect(call[2]).not.toHaveProperty('input')
      expect(call[2]).not.toHaveProperty('tags')
      expect(response.data!.task_id).toBeUndefined()
    })

    it('does not fuzzy-repair stale group target_session without platform_session_id', async () => {
      const schedResult = await makeProtocolRequest<{ schedule: Schedule }>(
        TEST_PROTOCOL_PORT,
        'create_schedule',
        {
          name: 'GitHub AI News to Claude&codex开发工具',
          description: '发送到微信 Claude&codex开发工具 群',
          trigger: { type: 'cron', expression: '0 0 * * *' },
          task_template: {
            type: 'routine',
            title: 'Daily AI News',
            description: '发送到 Claude&codex开发工具',
            priority: 'normal',
            tags: [],
          },
          target_session: {
            channel_id: 'wechat-棉花糖',
            session_id: 'stale-random-session-id',
            type: 'group',
          },
        }
      )

      expect(schedResult.success).toBe(true)

      await makeProtocolRequest(TEST_PROTOCOL_PORT, 'trigger_now', { schedule_id: schedResult.data!.schedule.id })

      const agentCall = triggerCallSpy.mock.calls.findLast((call) => call[1] === 'trigger_schedule')
      expect(agentCall).toBeTruthy()
      const payload = agentCall![2] as { target_session?: Record<string, unknown> }
      expect(payload.target_session).toEqual({
        channel_id: 'wechat-棉花糖',
        session_id: 'stale-random-session-id',
        type: 'group',
      })
    })

    it('does not repair stale private target_session to master without platform_session_id', async () => {
      const createMaster = await makeProtocolRequest<{ friend: Friend }>(
        TEST_PROTOCOL_PORT,
        'create_friend',
        {
          display_name: 'Schedule Master',
          permission: 'master',
          channel_identities: [
            {
              channel_id: 'wechat-棉花糖',
              platform_user_id: 'master-user',
              platform_display_name: 'Task Master',
            },
          ],
        }
      )
      expect(createMaster.success).toBe(true)

      const schedResult = await makeProtocolRequest<{ schedule: Schedule }>(
        TEST_PROTOCOL_PORT,
        'create_schedule',
        {
          name: 'Legacy private schedule',
          trigger: { type: 'cron', expression: '0 0 * * *' },
          task_template: {
            type: 'routine',
            title: 'Private reminder',
            priority: 'normal',
            tags: [],
          },
          target_session: {
            channel_id: 'wechat-棉花糖',
            session_id: 'stale-non-master-private-session',
            type: 'private',
          },
        }
      )

      expect(schedResult.success).toBe(true)

      await makeProtocolRequest(TEST_PROTOCOL_PORT, 'trigger_now', { schedule_id: schedResult.data!.schedule.id })

      const agentCall = triggerCallSpy.mock.calls.findLast((call) => call[1] === 'trigger_schedule')
      expect(agentCall).toBeTruthy()
      const payload = agentCall![2] as { target_session?: Record<string, unknown> }
      expect(payload.target_session).toEqual({
        channel_id: 'wechat-棉花糖',
        session_id: 'stale-non-master-private-session',
        type: 'private',
      })
    })

    it('repairs stale target_session deterministically when platform_session_id is present', async () => {
      const schedResult = await makeProtocolRequest<{ schedule: Schedule }>(
        TEST_PROTOCOL_PORT,
        'create_schedule',
        {
          name: 'GitHub AI News',
          trigger: { type: 'cron', expression: '0 0 * * *' },
          task_template: {
            type: 'routine',
            title: 'Daily AI News',
            priority: 'normal',
            tags: [],
          },
          target_session: {
            channel_id: 'wechat-棉花糖',
            session_id: 'stale-random-session-id',
            platform_session_id: '54213229026@chatroom',
            type: 'group',
          },
        }
      )

      expect(schedResult.success).toBe(true)

      await makeProtocolRequest(TEST_PROTOCOL_PORT, 'trigger_now', { schedule_id: schedResult.data!.schedule.id })

      const agentCall = triggerCallSpy.mock.calls.findLast((call) => call[1] === 'trigger_schedule')
      expect(agentCall).toBeTruthy()
      const payload = agentCall![2] as { target_session?: Record<string, unknown> }
      expect(payload.target_session).toEqual({
        channel_id: 'wechat-棉花糖',
        session_id: 'current-claude-codex-session',
        platform_session_id: '54213229026@chatroom',
        type: 'group',
      })
    })

    it('prefers stored platform_session_id over a mismatched resolvable session_id', async () => {
      const defaultCallImplementation = triggerCallSpy.getMockImplementation()
      triggerCallSpy.mockImplementation(
        (_port: unknown, method: string, params: unknown) => {
          if (method === 'trigger_schedule') {
            return Promise.resolve({ accepted: true })
          }
          if (method === 'get_session') {
            return Promise.resolve({
              id: (params as { session_id?: string }).session_id,
              channel_id: 'wechat-棉花糖',
              type: 'group',
              platform_session_id: '11111111111@chatroom',
              title: 'Wrong current group',
            })
          }
          if (method === 'get_sessions') {
            return Promise.resolve({
              items: [
                {
                  id: 'current-claude-codex-session',
                  channel_id: 'wechat-棉花糖',
                  type: 'group',
                  platform_session_id: '54213229026@chatroom',
                  title: 'Claude&codex开发工具',
                },
              ],
              pagination: { page: 1, page_size: 500, total_items: 1, total_pages: 1 },
            })
          }
          return defaultCallImplementation?.(_port, method, params) ?? Promise.resolve({})
        }
      )

      try {
        const schedResult = await makeProtocolRequest<{ schedule: Schedule }>(
          TEST_PROTOCOL_PORT,
          'create_schedule',
          {
            name: 'Mismatched platform repair anchor',
            trigger: { type: 'cron', expression: '0 0 * * *' },
            task_template: {
              type: 'routine',
              title: 'Daily AI News',
              priority: 'normal',
              tags: [],
            },
            target_session: {
              channel_id: 'wechat-棉花糖',
              session_id: 'wrong-current-session',
              platform_session_id: '54213229026@chatroom',
              type: 'group',
            },
          }
        )

        expect(schedResult.success).toBe(true)
        await makeProtocolRequest(TEST_PROTOCOL_PORT, 'trigger_now', { schedule_id: schedResult.data!.schedule.id })

        const agentCall = triggerCallSpy.mock.calls.findLast((call) => call[1] === 'trigger_schedule')
        expect(agentCall).toBeTruthy()
        const payload = agentCall![2] as { target_session?: Record<string, unknown> }
        expect(payload.target_session).toEqual({
          channel_id: 'wechat-棉花糖',
          session_id: 'current-claude-codex-session',
          platform_session_id: '54213229026@chatroom',
          type: 'group',
        })
      } finally {
        triggerCallSpy.mockImplementation(defaultCallImplementation)
      }
    })

    it('does not repair target_session to a session with the wrong type', async () => {
      const defaultCallImplementation = triggerCallSpy.getMockImplementation()
      triggerCallSpy.mockImplementation(
        (_port: unknown, method: string, params: unknown) => {
          if (method === 'trigger_schedule') {
            return Promise.resolve({ accepted: true })
          }
          if (method === 'get_session') {
            return Promise.reject(new Error(`Session not found: ${(params as { session_id?: string }).session_id}`))
          }
          if (method === 'get_sessions') {
            return Promise.resolve({
              items: [
                {
                  id: 'private-session-with-same-platform-id',
                  channel_id: 'wechat-棉花糖',
                  type: 'private',
                  platform_session_id: '54213229026@chatroom',
                  title: 'Wrong private target',
                },
              ],
              pagination: { page: 1, page_size: 500, total_items: 1, total_pages: 1 },
            })
          }
          return defaultCallImplementation?.(_port, method, params) ?? Promise.resolve({})
        }
      )

      try {
        const schedResult = await makeProtocolRequest<{ schedule: Schedule }>(
          TEST_PROTOCOL_PORT,
          'create_schedule',
          {
            name: 'Wrong type repair guard',
            trigger: { type: 'cron', expression: '0 0 * * *' },
            task_template: {
              type: 'routine',
              title: 'Daily AI News',
              priority: 'normal',
              tags: [],
            },
            target_session: {
              channel_id: 'wechat-棉花糖',
              session_id: 'stale-random-session-id',
              platform_session_id: '54213229026@chatroom',
              type: 'group',
            },
          }
        )

        expect(schedResult.success).toBe(true)
        await makeProtocolRequest(TEST_PROTOCOL_PORT, 'trigger_now', { schedule_id: schedResult.data!.schedule.id })

        const agentCall = triggerCallSpy.mock.calls.findLast((call) => call[1] === 'trigger_schedule')
        expect(agentCall).toBeTruthy()
        const payload = agentCall![2] as { target_session?: Record<string, unknown> }
        expect(payload.target_session).toEqual({
          channel_id: 'wechat-棉花糖',
          session_id: 'stale-random-session-id',
          platform_session_id: '54213229026@chatroom',
          type: 'group',
        })
      } finally {
        triggerCallSpy.mockImplementation(defaultCallImplementation)
      }
    })
  })

  describe('assign_worker', () => {
    it('should assign worker to task', async () => {
      // 创建任务
      const createResponse = await makeProtocolRequest<{ task: Task }>(
        TEST_PROTOCOL_PORT,
        'create_task',
        {
          type: 'generic',
          title: 'Worker Assignment Test',
          source: { trigger_type: 'manual' },
        }
      )

      const taskId = createResponse.data.task.id

      const response = await makeProtocolRequest<{ task: Task }>(
        TEST_PROTOCOL_PORT,
        'assign_worker',
        {
          task_id: taskId,
          worker_agent_id: 'test-agent-001',
        }
      )

      expect(response.success).toBe(true)
      expect(response.data.task.worker_agent_id).toBe('test-agent-001')
    })
  })

  describe('update_plan', () => {
    it('should update task plan', async () => {
      // 创建任务
      const createResponse = await makeProtocolRequest<{ task: Task }>(
        TEST_PROTOCOL_PORT,
        'create_task',
        {
          type: 'generic',
          title: 'Plan Update Test',
          source: { trigger_type: 'manual' },
        }
      )
      const taskId = createResponse.data.task.id

      const response = await makeProtocolRequest<{ task: Task }>(
        TEST_PROTOCOL_PORT,
        'update_plan',
        {
          task_id: taskId,
          plan: {
            steps: [
              { id: 'step-1', action: 'fetch_data', status: 'pending' },
              { id: 'step-2', action: 'process_data', status: 'pending' },
            ],
            current_step_index: 0,
          },
        }
      )

      expect(response.success).toBe(true)
      expect(response.data.task.plan).toBeDefined()
      expect(response.data.task.plan?.steps).toHaveLength(2)
    })
  })

  describe('once trigger schedule', () => {
    it('should create a once trigger schedule', async () => {
      const executeAt = new Date(Date.now() + 60000).toISOString()
      const response = await makeProtocolRequest<{ schedule: Schedule }>(
        TEST_PROTOCOL_PORT,
        'create_schedule',
        {
          name: 'Once Test Schedule',
          trigger: {
            type: 'once',
            execute_at: executeAt,
          },
          task_template: {
            type: 'routine',
            title: 'Once Triggered Task',
            priority: 'normal',
          },
        }
      )

      expect(response.success).toBe(true)
      expect(response.data.schedule.trigger.type).toBe('once')
      expect(response.data.schedule.trigger.execute_at).toBe(executeAt)
    })
  })

  describe('interval trigger schedule', () => {
    it('should create an interval trigger schedule', async () => {
      const response = await makeProtocolRequest<{ schedule: Schedule }>(
        TEST_PROTOCOL_PORT,
        'create_schedule',
        {
          name: 'Interval Test Schedule',
          trigger: {
            type: 'interval',
            seconds: 3600,
          },
          task_template: {
            type: 'routine',
            title: 'Interval Triggered Task',
            priority: 'low',
          },
        }
      )

      expect(response.success).toBe(true)
      expect(response.data.schedule.trigger.type).toBe('interval')
      expect(response.data.schedule.next_trigger_at).toBeDefined()
    })
  })

  describe('invalid schedule', () => {
    it('should reject invalid cron expression', async () => {
      const response = await makeProtocolRequest(
        TEST_PROTOCOL_PORT,
        'create_schedule',
        {
          name: 'Invalid Cron Schedule',
          trigger: {
            type: 'cron',
            expression: 'invalid-cron-expression',
          },
          task_template: {
            type: 'routine',
            title: 'Invalid Cron Task',
            priority: 'normal',
          },
        }
      )

      expect(response.success).toBe(false)
    })
  })

  describe('get_schedule for non-existent', () => {
    it('should return error for non-existent schedule', async () => {
      const response = await makeProtocolRequest(
        TEST_PROTOCOL_PORT,
        'get_schedule',
        { schedule_id: 'non-existent-schedule' }
      )

      expect(response.success).toBe(false)
    })
  })

  describe('update_schedule for non-existent', () => {
    it('should return error for non-existent schedule', async () => {
      const response = await makeProtocolRequest(
        TEST_PROTOCOL_PORT,
        'update_schedule',
        {
          schedule_id: 'non-existent-schedule',
          name: 'Updated Name',
        }
      )

      expect(response.success).toBe(false)
    })
  })

  describe('delete_schedule for non-existent', () => {
    it('should return error for non-existent schedule', async () => {
      const response = await makeProtocolRequest(
        TEST_PROTOCOL_PORT,
        'delete_schedule',
        { schedule_id: 'non-existent-schedule' }
      )

      expect(response.success).toBe(false)
    })
  })

  describe('trigger_now for non-existent', () => {
    it('should return error for non-existent schedule', async () => {
      const response = await makeProtocolRequest(
        TEST_PROTOCOL_PORT,
        'trigger_now',
        { schedule_id: 'non-existent-schedule' }
      )

      expect(response.success).toBe(false)
    })
  })
})
