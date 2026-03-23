/**
 * Admin 模块 Task 和 Schedule 管理测试
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'node:http'
import fs from 'node:fs/promises'
import AdminModule from './index.js'
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

      const response = await makeProtocolRequest<{ message: { id: string; type: string; content: string } }>(
        TEST_PROTOCOL_PORT,
        'append_message',
        {
          task_id: taskId,
          type: 'info',
          content: 'Test message content',
        }
      )

      expect(response.success).toBe(true)
      expect(response.data.message.id).toBeDefined()
      expect(response.data.message.type).toBe('info')
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
        role: 'assistant',
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

  describe('cancel_task', () => {
    it('should cancel a task', async () => {
      // 创建任务
      const createResponse = await makeProtocolRequest<{ task: Task }>(
        TEST_PROTOCOL_PORT,
        'create_task',
        {
          type: 'generic',
          title: 'Cancel Test',
          source: { trigger_type: 'manual' },
        }
      )

      const taskId = createResponse.data.task.id

      const response = await makeProtocolRequest<{ task: Task; cancelled: boolean }>(
        TEST_PROTOCOL_PORT,
        'cancel_task',
        {
          task_id: taskId,
          reason: 'Test cancellation',
        }
      )

      expect(response.success).toBe(true)
      expect(response.data.cancelled).toBe(true)
      expect(response.data.task.status).toBe('cancelled')
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
    it('should trigger a schedule immediately', async () => {
      // 先创建调度
      const createResponse = await makeProtocolRequest<{ schedule: Schedule }>(
        TEST_PROTOCOL_PORT,
        'create_schedule',
        {
          name: 'Trigger Test Schedule',
          trigger: { type: 'cron', expression: '0 0 * * *' },
          task_template: { type: 'routine', title: 'Triggered Task', priority: 'normal' },
        }
      )

      const scheduleId = createResponse.data.schedule.id

      const response = await makeProtocolRequest<{ task: Task; schedule: Schedule }>(
        TEST_PROTOCOL_PORT,
        'trigger_now',
        { schedule_id: scheduleId }
      )

      expect(response.success).toBe(true)
      expect(response.data.task).toBeDefined()
      expect(response.data.task.status).toBe('pending')
      expect(response.data.schedule.last_triggered_at).toBeDefined()
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
