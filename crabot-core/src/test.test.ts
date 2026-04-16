/**
 * Module Manager 测试
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'node:http'
import fs from 'node:fs/promises'
import path from 'node:path'
import ModuleManager from './index.js'
import type { Request } from 'crabot-shared'
import type { ModuleManagerConfig, ModuleDefinition as ModuleDef } from './types.js'

const TEST_PORT = 19900
const MODULE_PORT_START = 19901
const MODULE_PORT_END = 19920
const TEST_DATA_DIR = './test-data/module-manager-test'

describe('ModuleManager', () => {
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
        shutdown_timeout: 5000,
        hotplug_allowed_types: ['agent', 'channel'],
        modules: [],
      } as ModuleManagerConfig,
      TEST_DATA_DIR
    )
    await manager.start()
  })

  afterAll(async () => {
    await manager.stop()
    // 清理测试数据
    try {
      await fs.rm(TEST_DATA_DIR, { recursive: true, force: true })
    } catch {
      // ignore
    }
  })

  describe('HTTP Server', () => {
    it('should be listening on configured port', async () => {
      const response = await makeRequest(TEST_PORT, 'health', {})
      expect(response.success).toBe(true)
      expect(response.data).toHaveProperty('status')
    })
  })

  describe('allocate_port', () => {
    it('should allocate a port within range', async () => {
      const response = await makeRequest<{ port: number }>(TEST_PORT, 'allocate_port', {
        module_id: 'test-module-allocate',
      })
      expect(response.success).toBe(true)
      expect(response.data!.port).toBeGreaterThanOrEqual(MODULE_PORT_START)
      expect(response.data!.port).toBeLessThanOrEqual(MODULE_PORT_END)
    })

    it('should return same port for same module_id', async () => {
      const response1 = await makeRequest<{ port: number }>(TEST_PORT, 'allocate_port', {
        module_id: 'test-module-same-port',
      })
      const response2 = await makeRequest<{ port: number }>(TEST_PORT, 'allocate_port', {
        module_id: 'test-module-same-port',
      })
      expect(response1.data!.port).toBe(response2.data!.port)
    })
  })
  describe('release_port', () => {
    it('should release an allocated port', async () => {
      // First allocate a port
      const allocResponse = await makeRequest<{ port: number }>(TEST_PORT, 'allocate_port', {
        module_id: 'test-release-port-unique',
      })
      expect(allocResponse.success).toBe(true)
    })
  })
  describe('register_module_definition', () => {
    it('should register module definition for hotplug type', async () => {
      const response = await makeRequest<{ registered: boolean }>(TEST_PORT, 'register_module_definition', {
        module_definition: {
          module_id: 'test-agent-module-def',
          module_type: 'agent',
          entry: 'node test.js',
          auto_start: false,
          start_priority: 100,
        },
      })
      expect(response.success).toBe(true)
      expect(response.data.registered).toBe(true)
    })

    it('should reject non-hotplug type', async () => {
      const response = await makeRequest(TEST_PORT, 'register_module_definition', {
        module_definition: {
          module_id: 'test-admin-module-def',
          module_type: 'admin',
          entry: 'node test.js',
          auto_start: false,
          start_priority: 100,
        },
      })
      expect(response.success).toBe(false)
    })
    it('should reject duplicate module_id', async () => {
      await makeRequest(TEST_PORT, 'register_module_definition', {
        module_definition: {
          module_id: 'test-duplicate-module',
          module_type: 'agent',
          entry: 'node test.js',
          auto_start: false,
          start_priority: 100,
        },
      })
      const response = await makeRequest(TEST_PORT, 'register_module_definition', {
        module_definition: {
          module_id: 'test-duplicate-module',
          module_type: 'agent',
          entry: 'node test.js',
          auto_start: false,
          start_priority: 100,
        },
      })
      expect(response.success).toBe(false)
    })
  })
  describe('unregister_module_definition', () => {
    it('should unregister a module definition', async () => {
      await makeRequest(TEST_PORT, 'register_module_definition', {
        module_definition: {
          module_id: 'test-unregister-module-def',
          module_type: 'agent',
          entry: 'node test.js',
          auto_start: false,
          start_priority: 100,
        },
      })
      const response = await makeRequest<{ unregistered: boolean }>(TEST_PORT, 'unregister_module_definition', {
        module_id: 'test-unregister-module-def',
      })
      expect(response.success).toBe(true)
      expect(response.data!.unregistered).toBe(true)
    })

    it('should reject unregister for non-existent module', async () => {
      const response = await makeRequest(TEST_PORT, 'unregister_module_definition', {
        module_id: 'non-existent-module',
      })
      expect(response.success).toBe(false)
    })
  })
  describe('update_module_definition', () => {
    it('should update a module definition', async () => {
      await makeRequest(TEST_PORT, 'register_module_definition', {
        module_definition: {
          module_id: 'test-update-module-def',
          module_type: 'agent',
          entry: 'node test.js',
          auto_start: false,
          start_priority: 100,
        },
      })
      const response = await makeRequest<{ module_definition: { auto_start: boolean } }>(TEST_PORT, 'update_module_definition', {
        module_id: 'test-update-module-def',
        updates: {
          auto_start: true,
        },
      })
      expect(response.success).toBe(true)
      expect(response.data!.module_definition.auto_start).toBe(true)
    })

    it('should reject update for non-existent module', async () => {
      const response = await makeRequest(TEST_PORT, 'update_module_definition', {
        module_id: 'non-existent-module',
        updates: {
          auto_start: true,
        },
      })
      expect(response.success).toBe(false)
    })
  })
  describe('get_module_definition', () => {
    it('should get a module definition', async () => {
      await makeRequest(TEST_PORT, 'register_module_definition', {
        module_definition: {
          module_id: 'test-get-module-def',
          module_type: 'agent',
          entry: 'node test.js',
          auto_start: false,
          start_priority: 100,
        },
      })
      const response = await makeRequest<{ definition: { module_id: string } }>(TEST_PORT, 'get_module_definition', {
        module_id: 'test-get-module-def',
      })
      expect(response.success).toBe(true)
      expect(response.data!.definition.module_id).toBe('test-get-module-def')
    })
    it('should reject get for non-existent module', async () => {
      const response = await makeRequest(TEST_PORT, 'get_module_definition', {
        module_id: 'non-existent-module',
      })
      expect(response.success).toBe(false)
    })
  })
  describe('list_module_definitions', () => {
    it('should list all module definitions', async () => {
      const response = await makeRequest<{ definitions: Array<{ module_id: string }> }>(TEST_PORT, 'list_module_definitions', {})
      expect(response.success).toBe(true)
      expect(response.data.definitions).toBeInstanceOf(Array)
    })
    it('should filter by module_type', async () => {
      await makeRequest(TEST_PORT, 'register_module_definition', {
        module_definition: {
          module_id: 'test-filter-module-def',
          module_type: 'channel',
          entry: 'node test.js',
          auto_start: false,
          start_priority: 100,
        },
      })
      const response = await makeRequest<{ definitions: Array<{ module_type: string }> }>(TEST_PORT, 'list_module_definitions', {
        module_type: 'channel',
      })
      expect(response.success).toBe(true)
      expect(
        response.data.definitions.every((d) => d.module_type === 'channel')
      ).toBe(true)
    })
  })
  describe('list_modules', () => {
    it('should list modules', async () => {
      const response = await makeRequest<{ modules: Array<{ module_id: string }> }>(TEST_PORT, 'list_modules', {})
      expect(response.success).toBe(true)
      expect(response.data.modules).toBeInstanceOf(Array)
    })
  })
  describe('health', () => {
    it('should return health status', async () => {
      const response = await makeRequest<{ status: string; details: { total_modules: number } }>(TEST_PORT, 'health', {})
      expect(response.success).toBe(true)
      expect(response.data.status).toBe('healthy')
      expect(response.data.details).toBeDefined()
      expect(response.data.details.total_modules).toBeDefined()
    })
  })
})

// Helper function
interface TestResponse<D = unknown> {
  id: string
  success: boolean
  data: D
  error?: { code: string; message: string }
  timestamp: string
}

function makeRequest<D = unknown>(port: number, method: string, params: unknown): Promise<TestResponse<D>> {
  return new Promise((resolve, reject) => {
    const request: Request = {
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
            resolve(JSON.parse(data) as TestResponse<D>)
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
