/**
 * Module Manager 高级测试
 * 覆盖进程管理、事件发布、健康检查等高级功能
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'node:http'
import fs from 'node:fs/promises'
import ModuleManager from './index.js'
import type { Response } from 'crabot-shared'

const TEST_PORT = 19950
const MODULE_PORT_START = 19951
const MODULE_PORT_END = 19970
const TEST_DATA_DIR = './test-data/module-manager-advanced-test'

// 辅助函数：发送请求
async function makeRequest<D>(
  port: number,
  method: string,
  params: unknown
): Promise<Response<D>> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      id: `test-${Date.now()}`,
      source: 'test',
      method,
      params,
      timestamp: new Date().toISOString(),
    })

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
        res.on('data', (chunk) => (data += chunk))
        res.on('end', () => {
          try {
            resolve(JSON.parse(data) as Response<D>)
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

describe('ModuleManager Advanced', () => {
  let manager: ModuleManager

  beforeAll(async () => {
    // 清理测试数据目录
    try {
      await fs.rm(TEST_DATA_DIR, { recursive: true, force: true })
    } catch {
      // ignore
    }

    manager = new ModuleManager(
      {
        port: TEST_PORT,
        port_range: {
          range_start: MODULE_PORT_START,
          range_end: MODULE_PORT_END,
        },
        health_check_interval: 60000,
        health_check_timeout: 5000,
        health_check_failure_threshold: 3,
        shutdown_timeout: 5,
        hotplug_allowed_types: ['agent', 'channel', 'business'],
        modules: [
          {
            module_id: 'predefined-module',
            module_type: 'agent',
            entry: 'node -e "console.log(123)"',
            cwd: '.',
            auto_start: false,
            start_priority: 10,
          },
        ],
      },
      TEST_DATA_DIR
    )
    await manager.start()
  })

  afterAll(async () => {
    await manager.stop()
    try {
      await fs.rm(TEST_DATA_DIR, { recursive: true, force: true })
    } catch {
      // ignore
    }
  })

  describe('register', () => {
    it('should register a predefined module', async () => {
      // 首先获取预定义模块的端口
      const portResponse = await makeRequest<{ port: number }>(
        TEST_PORT,
        'allocate_port',
        { module_id: 'predefined-module' }
      )
      expect(portResponse.success).toBe(true)

      const response = await makeRequest(TEST_PORT, 'register', {
        module_id: 'predefined-module',
        module_type: 'agent',
        version: '1.0.0',
        protocol_version: '1.0.0',
        port: portResponse.data!.port,
        subscriptions: [],
      })
      expect(response.success).toBe(true)
      expect(response.data).toHaveProperty('registered', true)
    })

    it('should reject registration for non-existent module definition', async () => {
      const response = await makeRequest(TEST_PORT, 'register', {
        module_id: 'non-existent-module',
        module_type: 'agent',
        version: '1.0.0',
        protocol_version: '1.0.0',
        port: 19999,
        subscriptions: [],
      })
      expect(response.success).toBe(false)
      expect(response.error?.message).toContain('Module definition not found')
    })

    it('should reject registration with wrong port', async () => {
      // 创建一个新的模块定义用于测试端口不匹配
      await makeRequest(TEST_PORT, 'register_module_definition', {
        module_definition: {
          module_id: 'port-mismatch-test',
          module_type: 'agent',
          entry: 'node -e "console.log(123)"',
          cwd: '.',
          auto_start: false,
          start_priority: 10,
        },
      })

      const response = await makeRequest(TEST_PORT, 'register', {
        module_id: 'port-mismatch-test',
        module_type: 'agent',
        version: '1.0.0',
        protocol_version: '1.0.0',
        port: 99999, // Wrong port
        subscriptions: [],
      })
      expect(response.success).toBe(false)
      expect(response.error?.message).toContain('Port mismatch')
    })
  })

  describe('unregister', () => {
    it('should unregister a registered module', async () => {
      // 先注册一个新模块
      await makeRequest(TEST_PORT, 'register_module_definition', {
        module_definition: {
          module_id: 'unregister-test-module',
          module_type: 'agent',
          entry: 'node -e "console.log(123)"',
          cwd: '.',
          auto_start: false,
          start_priority: 10,
        },
      })

      const portResponse = await makeRequest<{ port: number }>(TEST_PORT, 'allocate_port', {
        module_id: 'unregister-test-module',
      })

      await makeRequest(TEST_PORT, 'register', {
        module_id: 'unregister-test-module',
        module_type: 'agent',
        version: '1.0.0',
        protocol_version: '1.0.0',
        port: portResponse.data!.port,
        subscriptions: [],
      })

      const response = await makeRequest(TEST_PORT, 'unregister', {
        module_id: 'unregister-test-module',
      })
      expect(response.success).toBe(true)
      expect(response.data).toHaveProperty('unregistered', true)
    })

    it('should reject unregister for non-existent module', async () => {
      const response = await makeRequest(TEST_PORT, 'unregister', {
        module_id: 'non-existent-module',
      })
      expect(response.success).toBe(false)
      expect(response.error?.message).toContain('Module not found')
    })
  })

  describe('subscribe/unsubscribe', () => {
    it('should subscribe to events', async () => {
      // 先注册模块
      await makeRequest(TEST_PORT, 'register_module_definition', {
        module_definition: {
          module_id: 'subscribe-test-module',
          module_type: 'agent',
          entry: 'node -e "console.log(123)"',
          cwd: '.',
          auto_start: false,
          start_priority: 10,
        },
      })

      const portResponse = await makeRequest<{ port: number }>(TEST_PORT, 'allocate_port', {
        module_id: 'subscribe-test-module',
      })

      await makeRequest(TEST_PORT, 'register', {
        module_id: 'subscribe-test-module',
        module_type: 'agent',
        version: '1.0.0',
        protocol_version: '1.0.0',
        port: portResponse.data!.port,
        subscriptions: [],
      })

      const response = await makeRequest<{ subscribed: boolean; event_types: string[] }>(
        TEST_PORT,
        'subscribe',
        {
          subscriber: 'subscribe-test-module',
          event_types: ['module_manager.*', 'custom.event'],
        }
      )
      expect(response.success).toBe(true)
      expect(response.data).toHaveProperty('subscribed', true)
      expect(response.data?.event_types).toContain('module_manager.*')
    })

    it('should unsubscribe from events', async () => {
      const response = await makeRequest(TEST_PORT, 'unsubscribe', {
        subscriber: 'subscribe-test-module',
        event_types: ['custom.event'],
      })
      expect(response.success).toBe(true)
      expect(response.data).toHaveProperty('unsubscribed', true)
    })
  })

  describe('publish_event', () => {
    it('should publish event to subscribers', async () => {
      const response = await makeRequest<{ subscriber_count: number }>(
        TEST_PORT,
        'publish_event',
        {
          event: {
            type: 'module_manager.test_event',
            source: 'test',
            payload: { message: 'hello' },
            timestamp: new Date().toISOString(),
          },
        }
      )
      expect(response.success).toBe(true)
      expect(response.data).toHaveProperty('subscriber_count')
    })
  })

  describe('start_module', () => {
    it('should return accepted status when starting module', async () => {
      const response = await makeRequest<{ status: string; tracking_id: string }>(
        TEST_PORT,
        'start_module',
        { module_id: 'predefined-module' }
      )
      expect(response.success).toBe(true)
      expect(response.data).toHaveProperty('status', 'accepted')
      expect(response.data).toHaveProperty('tracking_id')
    })
  })

  describe('stop_module', () => {
    it('should return accepted status when stopping module', async () => {
      const response = await makeRequest<{ status: string }>(TEST_PORT, 'stop_module', {
        module_id: 'predefined-module',
      })
      expect(response.success).toBe(true)
      expect(response.data).toHaveProperty('status', 'accepted')
    })
  })

  describe('restart_module', () => {
    it('should return accepted status when restarting module', async () => {
      const response = await makeRequest<{ status: string }>(TEST_PORT, 'restart_module', {
        module_id: 'predefined-module',
      })
      expect(response.success).toBe(true)
      expect(response.data).toHaveProperty('status', 'accepted')
    })
  })

  describe('get_module', () => {
    it('should get module info', async () => {
      const response = await makeRequest<{ module_id: string }>(TEST_PORT, 'get_module', {
        module_id: 'predefined-module',
      })
      expect(response.success).toBe(true)
      expect(response.data).toHaveProperty('module_id', 'predefined-module')
    })

    it('should reject get for non-existent module', async () => {
      const response = await makeRequest(TEST_PORT, 'get_module', {
        module_id: 'non-existent-module',
      })
      expect(response.success).toBe(false)
      expect(response.error?.message).toContain('Module not found')
    })
  })

  describe('resolve', () => {
    it('should require module_id or module_type', async () => {
      const response = await makeRequest(TEST_PORT, 'resolve', {})
      expect(response.success).toBe(false)
      expect(response.error?.message).toContain('required')
    })

    it('should resolve by module_id', async () => {
      // 先注册模块使其变为 running 状态
      await makeRequest(TEST_PORT, 'register_module_definition', {
        module_definition: {
          module_id: 'resolve-test-module',
          module_type: 'agent',
          entry: 'node -e "console.log(123)"',
          cwd: '.',
          auto_start: false,
          start_priority: 10,
        },
      })

      const portResponse = await makeRequest<{ port: number }>(TEST_PORT, 'allocate_port', {
        module_id: 'resolve-test-module',
      })

      await makeRequest(TEST_PORT, 'register', {
        module_id: 'resolve-test-module',
        module_type: 'agent',
        version: '1.0.0',
        protocol_version: '1.0.0',
        port: portResponse.data!.port,
        subscriptions: [],
      })

      const response = await makeRequest<{ modules: unknown[] }>(TEST_PORT, 'resolve', {
        module_id: 'resolve-test-module',
      })
      expect(response.success).toBe(true)
      expect(response.data?.modules).toBeInstanceOf(Array)
    })

    it('should resolve by module_type', async () => {
      const response = await makeRequest<{ modules: unknown[] }>(TEST_PORT, 'resolve', {
        module_type: 'agent',
      })
      expect(response.success).toBe(true)
      expect(response.data?.modules).toBeInstanceOf(Array)
    })

    it('should reject resolve for non-existent module', async () => {
      const response = await makeRequest(TEST_PORT, 'resolve', {
        module_id: 'non-existent-module',
      })
      expect(response.success).toBe(false)
      expect(response.error?.message).toContain('Module not found')
    })
  })

  describe('update_module_definition', () => {
    it('should update a module definition', async () => {
      // 先注册
      await makeRequest(TEST_PORT, 'register_module_definition', {
        module_definition: {
          module_id: 'update-test-module-def',
          module_type: 'agent',
          entry: 'node -e "console.log(123)"',
          cwd: '.',
          auto_start: false,
          start_priority: 10,
        },
      })

      const response = await makeRequest<{ module_definition: { auto_start: boolean } }>(
        TEST_PORT,
        'update_module_definition',
        {
          module_id: 'update-test-module-def',
          updates: {
            auto_start: true,
          },
        }
      )
      expect(response.success).toBe(true)
      expect(response.data?.module_definition?.auto_start).toBe(true)
    })

    it('should reject update for non-existent module', async () => {
      const response = await makeRequest(TEST_PORT, 'update_module_definition', {
        module_id: 'non-existent-module',
        updates: { auto_start: true },
      })
      expect(response.success).toBe(false)
      expect(response.error?.message).toContain('Module definition not found')
    })
  })

  describe('unregister_module_definition', () => {
    it('should reject unregister for running module', async () => {
      // 先注册一个新的模块并设为 running
      await makeRequest(TEST_PORT, 'register_module_definition', {
        module_definition: {
          module_id: 'running-module-test',
          module_type: 'agent',
          entry: 'node -e "console.log(123)"',
          cwd: '.',
          auto_start: false,
          start_priority: 10,
        },
      })

      const portResponse = await makeRequest<{ port: number }>(TEST_PORT, 'allocate_port', {
        module_id: 'running-module-test',
      })

      await makeRequest(TEST_PORT, 'register', {
        module_id: 'running-module-test',
        module_type: 'agent',
        version: '1.0.0',
        protocol_version: '1.0.0',
        port: portResponse.data!.port,
        subscriptions: [],
      })

      const response = await makeRequest(TEST_PORT, 'unregister_module_definition', {
        module_id: 'running-module-test',
      })
      expect(response.success).toBe(false)
      expect(response.error?.message).toContain('running')
    })

    it('should reject unregister for non-existent module', async () => {
      const response = await makeRequest(TEST_PORT, 'unregister_module_definition', {
        module_id: 'non-existent-module',
      })
      expect(response.success).toBe(false)
      expect(response.error?.message).toContain('Module definition not found')
    })
  })

  describe('health', () => {
    it('should return health status with module counts', async () => {
      const response = await makeRequest<{
        status: string
        details: { total_modules: number; running_modules: number; error_modules: number }
      }>(TEST_PORT, 'health', {})
      expect(response.success).toBe(true)
      expect(response.data).toHaveProperty('status')
      expect(response.data?.details).toHaveProperty('total_modules')
      expect(response.data?.details).toHaveProperty('running_modules')
      expect(response.data?.details).toHaveProperty('error_modules')
    })
  })

  describe('list_modules', () => {
    it('should filter by status', async () => {
      const response = await makeRequest<{ modules: Array<{ status: string }> }>(
        TEST_PORT,
        'list_modules',
        { status: 'running' }
      )
      expect(response.success).toBe(true)
      expect(response.data?.modules).toBeInstanceOf(Array)
      // 所有返回的模块都应该是 running 状态
      for (const mod of response.data?.modules ?? []) {
        expect(mod.status).toBe('running')
      }
    })

    it('should filter by module_type', async () => {
      const response = await makeRequest<{ modules: Array<{ module_type: string }> }>(
        TEST_PORT,
        'list_modules',
        { module_type: 'agent' }
      )
      expect(response.success).toBe(true)
      expect(response.data?.modules).toBeInstanceOf(Array)
      // 所有返回的模块都应该是 agent 类型
      for (const mod of response.data?.modules ?? []) {
        expect(mod.module_type).toBe('agent')
      }
    })
  })

  describe('list_module_definitions', () => {
    it('should filter by installed_only', async () => {
      const response = await makeRequest<{
        definitions: Array<{ is_installed: boolean }>
      }>(TEST_PORT, 'list_module_definitions', { installed_only: true })
      expect(response.success).toBe(true)
      expect(response.data?.definitions).toBeInstanceOf(Array)
    })

    it('should filter by module_type', async () => {
      const response = await makeRequest<{
        definitions: Array<{ module_type: string }>
      }>(TEST_PORT, 'list_module_definitions', { module_type: 'agent' })
      expect(response.success).toBe(true)
      expect(response.data?.definitions).toBeInstanceOf(Array)
    })
  })
})
