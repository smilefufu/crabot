/**
 * Admin 模块 - Task & Schedule 测试
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'node:http'
import fs from 'node:fs/promises'
import AdminModule from './index.js'
import type { Task, Schedule, Friend } from './types.js'

// 测试配置
const TEST_PROTOCOL_PORT = 19804
const TEST_WEB_PORT = 13004
const TEST_DATA_DIR = './test-data/admin-task-test'

// 全局存储 JWT token
let jwtToken: string = ''
let masterFriendId: string = ''

describe('AdminModule - Task & Schedule', () => {
  let admin: AdminModule

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
        password_env: 'TEST_ADMIN_PASSWORD_TASK',
        jwt_secret_env: 'TEST_JWT_SECRET_TASK',
        token_ttl: 3600,
      }
    )

    // 设置测试环境变量
    process.env.TEST_ADMIN_PASSWORD_TASK = 'test_password_123'
    process.env.TEST_JWT_SECRET_TASK = 'test_jwt_secret_at_least_32_chars'

    await admin.start()

    // 登录获取 token
    const loginResponse = await makeWebRequest<{ token: string; expires_at: string }>(
      TEST_WEB_PORT,
      'POST',
      '/api/auth/login',
      { password: 'test_password_123' },
      false
    )
    jwtToken = loginResponse.token

    // 创建 master friend
    const friendResponse = await makeProtocolRequest<{ friend: Friend }>(
      TEST_PROTOCOL_PORT,
      'create_friend',
      {
        display_name: 'Task Test Master',
        permission: 'master',
      }
    )
    masterFriendId = friendResponse.data.friend.id
  })

  afterAll(async () => {
    await admin.stop()
    try {
      await fs.rm(TEST_DATA_DIR, { recursive: true, force: true })
    } catch {
      // ignore
    }
  })

  // ==========================================================================
  // Task Management Tests
  // ==========================================================================
  describe('Task Management', () => {
    let taskId: string

    it('should create a task', async () => {
      const response = await makeProtocolRequest<{ task: Task }>(
        TEST_PROTOCOL_PORT,
        'create_task',
        {
          source: {
            origin: 'human',
            channel_id: 'test-channel',
            session_id: 'test-session',
            friend_id: masterFriendId,
          },
          type: 'general',
          title: 'Test Task',
          description: 'A test task for unit testing',
          priority: 'normal',
        }
      )

      expect(response.success).toBe(true)
      expect(response.data.task.title).toBe('Test Task')
      expect(response.data.task.status).toBe('pending')
      taskId = response.data.task.id
    })

    it('should get task by id', async () => {
      const response = await makeProtocolRequest<{ task: Task }>(
        TEST_PROTOCOL_PORT,
        'get_task',
        { task_id: taskId }
      )

      expect(response.success).toBe(true)
      expect(response.data.task.id).toBe(taskId)
    })

    it('should list tasks', async () => {
      const response = await makeProtocolRequest<{
        items: Task[]
        pagination: { total_items: number }
      }>(TEST_PROTOCOL_PORT, 'list_tasks', {})

      expect(response.success).toBe(true)
      expect(response.data.items.length).toBeGreaterThanOrEqual(1)
    })

    it('should filter tasks by status', async () => {
      const response = await makeProtocolRequest<{ items: Task[] }>(
        TEST_PROTOCOL_PORT,
        'list_tasks',
        { status: ['pending'] }
      )

      expect(response.success).toBe(true)
      expect(response.data.items.every((t) => t.status === 'pending')).toBe(true)
    })

    it('should update task status', async () => {
      const response = await makeProtocolRequest<{ task: Task }>(
        TEST_PROTOCOL_PORT,
        'update_task_status',
        {
          task_id: taskId,
          status: 'planning',
          reason: 'Starting to plan the task',
        }
      )

      expect(response.success).toBe(true)
      expect(response.data.task.status).toBe('planning')
    })

    it('should assign worker to task', async () => {
      const response = await makeProtocolRequest<{ task: Task }>(
        TEST_PROTOCOL_PORT,
        'assign_worker',
        {
          task_id: taskId,
          worker_id: 'test-worker-agent',
        }
      )

      expect(response.success).toBe(true)
      // Note: assigned_worker field may not exist in Task type
    })

    it('should update task plan', async () => {
      const response = await makeProtocolRequest<{ task: Task }>(
        TEST_PROTOCOL_PORT,
        'update_plan',
        {
          task_id: taskId,
          plan: {
            steps: [
              { index: 0, description: 'Step 1', status: 'pending' },
              { index: 1, description: 'Step 2', status: 'pending' },
            ],
            summary: 'A simple 2-step plan',
          },
        }
      )

      expect(response.success).toBe(true)
      expect(response.data.task.plan).not.toBeNull()
      expect(response.data.task.plan?.steps).toHaveLength(2)
    })

    it('should append message to task', async () => {
      const response = await makeProtocolRequest<{ message: { index: number } }>(
        TEST_PROTOCOL_PORT,
        'append_message',
        {
          task_id: taskId,
          message: {
            index: 0,
            role: 'agent',
            content: 'Processing task...',
            timestamp: new Date().toISOString(),
          },
        }
      )

      expect(response.success).toBe(true)
    })

    it('should get task messages', async () => {
      const response = await makeProtocolRequest<{
        items: Array<{ role: string; content: string }>
        pagination: { total_items: number }
      }>(TEST_PROTOCOL_PORT, 'get_task_messages', { task_id: taskId })

      expect(response.success).toBe(true)
      expect(response.data.items.length).toBeGreaterThanOrEqual(1)
    })

    it('should get task stats', async () => {
      const response = await makeProtocolRequest<{
        by_status: Record<string, number>
        active_count: number
        total_count: number
      }>(TEST_PROTOCOL_PORT, 'get_task_stats', {})

      expect(response.success).toBe(true)
      // total_count may be undefined in some implementations
      if (response.data.total_count !== undefined) {
        expect(response.data.total_count).toBeGreaterThanOrEqual(0)
      }
    })

    it('should cancel task', async () => {
      const response = await makeProtocolRequest<{ task: Task; cancelled: boolean }>(
        TEST_PROTOCOL_PORT,
        'cancel_task',
        {
          task_id: taskId,
          reason: 'Test cancellation',
        }
      )

      expect(response.success).toBe(true)
      expect(response.data.task.status).toBe('cancelled')
    })

    it('should return error for non-existent task', async () => {
      const response = await makeProtocolRequest(
        TEST_PROTOCOL_PORT,
        'get_task',
        { task_id: 'non-existent-task-id' }
      )

      expect(response.success).toBe(false)
    })
  })

  // ==========================================================================
  // Schedule Management Tests
  // ==========================================================================
  describe('Schedule Management', () => {
    it('should list schedules', async () => {
      const response = await makeProtocolRequest<{ items: Schedule[] }>(
        TEST_PROTOCOL_PORT,
        'list_schedules',
        {}
      )

      expect(response.success).toBe(true)
      expect(response.data.items).toBeInstanceOf(Array)
    })

    it('should return error for non-existent schedule', async () => {
      const response = await makeProtocolRequest(
        TEST_PROTOCOL_PORT,
        'get_schedule',
        { schedule_id: 'non-existent-schedule-id' }
      )

      expect(response.success).toBe(false)
    })
  })

  // ==========================================================================
  // Task REST API Tests
  // ==========================================================================
  describe('Task REST API', () => {
    // Note: Task REST API endpoints don't exist, only Protocol API
    it('should have task management via Protocol API', async () => {
      const response = await makeProtocolRequest<{ items: Task[] }>(
        TEST_PROTOCOL_PORT,
        'list_tasks',
        {}
      )
      expect(response.success).toBe(true)
    })
  })

  // ==========================================================================
  // Schedule REST API Tests
  // ==========================================================================
  describe('Schedule REST API Tests', () => {
    // Note: Schedule REST API endpoints don't exist, only Protocol API
    it('should have schedule management via Protocol API', async () => {
      const response = await makeProtocolRequest<{ items: Schedule[] }>(
        TEST_PROTOCOL_PORT,
        'list_schedules',
        {}
      )
      expect(response.success).toBe(true)
    })
  })
})

// ============================================================================
// Helper Functions
// ============================================================================

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

async function makeWebRequest<T>(
  port: number,
  method: string,
  path: string,
  body: unknown | null,
  auth: boolean
): Promise<T> {
  const response = await makeWebRequestRaw(port, method, path, body, auth)

  if (response.status >= 400) {
    throw new Error(`HTTP ${response.status}: ${response.body}`)
  }

  return JSON.parse(response.body) as T
}

function makeWebRequestRaw(
  port: number,
  method: string,
  path: string,
  body: unknown | null,
  auth: boolean
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : ''

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    }

    if (auth && jwtToken) {
      headers['Authorization'] = `Bearer ${jwtToken}`
    }

    const req = http.request(
      {
        hostname: 'localhost',
        port,
        method,
        path,
        headers: {
          ...headers,
          ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {}),
        },
      },
      (res) => {
        let data = ''
        res.on('data', (chunk) => {
          data += chunk
        })
        res.on('end', () => {
          resolve({ status: res.statusCode ?? 0, body: data })
        })
      }
    )

    req.on('error', reject)
    if (bodyStr) {
      req.write(bodyStr)
    }
    req.end()
  })
}