/**
 * ModuleBase 测试
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'node:http'
import { ModuleBase, RpcClient, type ModuleConfig } from './module-base.js'
import type { Event } from './base-protocol.js'

const TEST_PORT = 19701
const SHUTDOWN_TEST_PORT = 19710

// 创建一个简单的测试模块
class TestModule extends ModuleBase {
  public testMethodCalled = false
  public lastParams: unknown = null
  public lastEvent: Event | null = null
  public callbackCalled = false
  public callbackParams: unknown = null

  public healthDetails: Record<string, unknown> | null = null

  constructor(config: ModuleConfig) {
    super(config)

    this.registerMethod('test_method', this.handleTestMethod.bind(this))
    this.registerMethod('echo', this.handleEcho.bind(this))
    this.registerMethod('error_method', this.handleErrorMethod.bind(this))
    this.registerMethod('accepted_method', this.handleAcceptedMethod.bind(this))
    this.registerMethod('query_method', this.handleQueryMethod.bind(this))
  }

  private async handleTestMethod(params: { value: string }): Promise<{ received: string }> {
    this.testMethodCalled = true
    this.lastParams = params
    return { received: params.value }
  }

  private async handleEcho(params: unknown): Promise<unknown> {
    return params
  }

  private async handleErrorMethod(): Promise<void> {
    throw new Error('Test error message')
  }

  private async handleAcceptedMethod(): Promise<{ status: 'accepted'; tracking_id: string }> {
    return { status: 'accepted', tracking_id: 'test-tracking-id' }
  }

  private async handleQueryMethod(params: Record<string, string>): Promise<Record<string, string>> {
    return params
  }

  protected override async getHealthDetails(): Promise<Record<string, unknown>> {
    return this.healthDetails ?? {}
  }

  protected override async onEvent(event: Event): Promise<void> {
    this.lastEvent = event
  }

  // 暴露 registerCallback 给测试用
  public testRegisterCallback(trackingId: string, handler: (params: unknown) => Promise<void>): void {
    this.registerCallback(trackingId, handler)
  }

  // 重写 setHealthDetails
  public setTestHealthDetails(details: Record<string, unknown> | null): void {
    this.healthDetails = details
  }
}

describe('ModuleBase', () => {
  let module: TestModule

  beforeAll(async () => {
    module = new TestModule({
      moduleId: 'test-module',
      moduleType: 'test',
      version: '1.0.0',
      protocolVersion: '0.1.0',
      port: TEST_PORT,
    })
    await module.start()
  })

  afterAll(async () => {
    await module.stop()
  })

  describe('start / stop', () => {
    it('should start and listen on configured port', () => {
      expect(module.getMetadata().port).toBe(TEST_PORT)
    })

    it('should return correct metadata', () => {
      const metadata = module.getMetadata()
      expect(metadata.module_id).toBe('test-module')
      expect(metadata.module_type).toBe('test')
      expect(metadata.version).toBe('1.0.0')
      expect(metadata.protocol_version).toBe('0.1.0')
      expect(metadata.host).toBe('localhost')
    })
  })

  describe('health', () => {
    it('should return healthy status', async () => {
      const response = await makeRequest(TEST_PORT, 'health', {})
      expect(response.success).toBe(true)
      expect(response.data.status).toBe('healthy')
    })

    it('should include custom health details', async () => {
      module.setTestHealthDetails({ custom: 'value' })
      const response = await makeRequest(TEST_PORT, 'health', {})
      expect(response.data.details.custom).toBe('value')
    })
  })

  describe('method handling', () => {
    it('should handle registered method', async () => {
      const response = await makeRequest(TEST_PORT, 'test_method', { value: 'hello' })
      expect(response.success).toBe(true)
      expect(response.data.received).toBe('hello')
      expect(module.testMethodCalled).toBe(true)
    })

    it('should return error for unregistered method', async () => {
      const response = await makeRequest(TEST_PORT, 'unknown_method', {})
      expect(response.success).toBe(false)
      expect(response.error?.code).toBe('METHOD_NOT_FOUND')
    })

    it('should echo params back', async () => {
      const response = await makeRequest(TEST_PORT, 'echo', { foo: 'bar', count: 42 })
      expect(response.success).toBe(true)
      expect(response.data.foo).toBe('bar')
      expect(response.data.count).toBe(42)
    })

    it('should handle method errors', async () => {
      const response = await makeRequest(TEST_PORT, 'error_method', {})
      expect(response.success).toBe(false)
      expect(response.error?.message).toBe('Test error message')
    })

    it('should return accepted response', async () => {
      const response = await makeRequest<{ status: string; tracking_id: string }>(
        TEST_PORT,
        'accepted_method',
        {}
      )
      expect(response.success).toBe(true)
      expect(response.data.status).toBe('accepted')
      expect(response.data.tracking_id).toBe('test-tracking-id')
    })
  })

  describe('HTTP method handling', () => {
    it('should reject non-POST requests with 405', async () => {
      const result = await makeNonPostRequest(TEST_PORT, 'GET', 'test_method')
      expect(result.statusCode).toBe(405)
      expect(result.body).toContain('Method not allowed')
    })

    it('should reject PUT requests', async () => {
      const result = await makeNonPostRequest(TEST_PORT, 'PUT', 'test_method')
      expect(result.statusCode).toBe(405)
    })

    it('should reject DELETE requests', async () => {
      const result = await makeNonPostRequest(TEST_PORT, 'DELETE', 'test_method')
      expect(result.statusCode).toBe(405)
    })
  })

  describe('event handling', () => {
    it('should handle on_event method', async () => {
      const testEvent: Event = {
        id: 'event-123',
        type: 'test.event',
        source: 'test-source',
        payload: { message: 'hello' },
        timestamp: new Date().toISOString(),
      }

      const response = await makeRequest(TEST_PORT, 'on_event', { event: testEvent })
      expect(response.success).toBe(true)
      expect(response.data.received).toBe(true)

      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(module.lastEvent).toEqual(testEvent)
    })
  })

  describe('callback handling', () => {
    it('should handle callback method', async () => {
      const trackingId = 'test-tracking-123'
      module.testRegisterCallback(trackingId, async (params) => {
        module.callbackCalled = true
        module.callbackParams = params
      })
      const response = await makeRequest(TEST_PORT, 'callback', {
        tracking_id: trackingId,
        success: true,
        data: { result: 'ok' },
      })
      expect(response.success).toBe(true)
      expect(response.data.received).toBe(true)
      expect(module.callbackCalled).toBe(true)
      expect(module.callbackParams).toEqual({
        tracking_id: trackingId,
        success: true,
        data: { result: 'ok' },
      })
    })

    it('should handle callback for non-existent tracking_id', async () => {
      const response = await makeRequest(TEST_PORT, 'callback', {
        tracking_id: 'non-existent',
        success: true,
      })
      expect(response.success).toBe(true)
      expect(response.data.received).toBe(true)
    })
  })

  describe('shutdown', () => {
    it('should handle shutdown request', async () => {
      const shutdownModule = new TestModule({
        moduleId: 'shutdown-test',
        moduleType: 'test',
        version: '1.0.0',
        protocolVersion: '0.1.0',
        port: SHUTDOWN_TEST_PORT,
      })
      await shutdownModule.start()

      const response = await makeRequest(SHUTDOWN_TEST_PORT, 'shutdown', {})
      expect(response.success).toBe(true)

      await new Promise((resolve) => setTimeout(resolve, 200))
    })
  })

  describe('register method', () => {
    it('should have register method available', () => {
      expect(typeof module.register).toBe('function')
    })
  })
})

describe('RpcClient', () => {
  const RPC_TEST_PORT = TEST_PORT + 1
  let module: TestModule
  let client: RpcClient

  beforeAll(async () => {
    module = new TestModule({
      moduleId: 'rpc-test-module',
      moduleType: 'test',
      version: '1.0.0',
      protocolVersion: '0.1.0',
      port: RPC_TEST_PORT,
    })
    await module.start()
    client = new RpcClient(19000)
  })

  afterAll(async () => {
    await module.stop()
  })

  describe('call', () => {
    it('should call remote method successfully', async () => {
      const result = await client.call<{ received: string }>(
        RPC_TEST_PORT,
        'test_method',
        { value: 'rpc-test' },
        'test-client'
      )
      expect(result.received).toBe('rpc-test')
    })

    it('should throw on method error', async () => {
      await expect(
        client.call<void>(RPC_TEST_PORT, 'error_method', {}, 'test-client')
      ).rejects.toThrow('Test error message')
    })

    it('should throw on connection error', async () => {
      await expect(
        client.call<void>(9999, 'test_method', {}, 'test-client')
      ).rejects.toThrow()
    })
  })
})

// Helper functions
interface ProtocolResponse<D = unknown> {
  id: string
  success: boolean
  data: D
  error?: { code: string; message: string }
  timestamp: string
}

function makeRequest<D = unknown>(
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

function makeNonPostRequest(
  port: number,
  httpMethod: string,
  path: string
): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: 'localhost',
        port,
        method: httpMethod,
        path: `/${path}`,
      },
      (res) => {
        let data = ''
        res.on('data', (chunk) => {
          data += chunk
        })
        res.on('end', () => {
          resolve({ statusCode: res.statusCode ?? 0, body: data })
        })
      }
    )

    req.on('error', reject)
    req.end()
  })
}
