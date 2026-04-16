/**
 * Admin 模块 Web API 测试
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'node:http'
import fs from 'node:fs/promises'
import AdminModule from './index.js'
import type { Friend, LoginResponse } from './types.js'
import { AdminErrorCode } from './types.js'

const TEST_PROTOCOL_PORT = 19805
const TEST_WEB_PORT = 13005
const TEST_DATA_DIR = './test-data/admin-web-api-test'

describe('Admin Web API', () => {
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
        moduleId: 'admin-web-test',
        moduleType: 'admin',
        version: '0.1.0',
        protocolVersion: '0.1.0',
        port: TEST_PROTOCOL_PORT,
        subscriptions: [],
      },
      {
        web_port: TEST_WEB_PORT,
        data_dir: TEST_DATA_DIR,
        password_env: 'TEST_ADMIN_WEB_PASSWORD',
        jwt_secret_env: 'TEST_JWT_SECRET_WEB',
        token_ttl: 3600,
      }
    )

    // 设置测试环境变量
    process.env.TEST_ADMIN_WEB_PASSWORD = 'test_password_123'
    process.env.TEST_JWT_SECRET_WEB = 'test_jwt_secret_at_least_32_chars'
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

  // 登录 API 测试
  describe('POST /api/auth/login', () => {
    it('should login successfully with correct password', async () => {
      const response = await makeWebRequest<LoginResponse>(
        TEST_WEB_PORT,
        '/api/auth/login',
        'POST',
        { password: 'test_password_123' }
      )
      expect(response.statusCode).toBe(200)
      expect(response.body.token).toBeDefined()
      expect(response.body.expires_at).toBeDefined()
    })

    it('should reject login with wrong password', async () => {
      const response = await makeWebRequest<{ error: string; message: string }>(
        TEST_WEB_PORT,
        '/api/auth/login',
        'POST',
        { password: 'wrong_password' }
      )
      expect(response.statusCode).toBe(401)
      expect(response.body.error).toBe(AdminErrorCode.INVALID_PASSWORD)
    })
  })

  // 认证测试
  describe('authentication', () => {
    it('should reject request without token', async () => {
      const response = await makeWebRequest(
        TEST_WEB_PORT,
        '/api/friends',
        'GET',
        null,
        null
      )
      expect(response.statusCode).toBe(401)
    })

    it('should reject request with invalid token', async () => {
      const response = await makeWebRequest(
        TEST_WEB_PORT,
        '/api/friends',
        'GET',
        null,
        'invalid-token'
      )
      expect(response.statusCode).toBe(401)
    })
  })

  // Friends API 测试
  describe('GET /api/friends', () => {
    it('should list friends with authentication', async () => {
      const token = await loginAndGetToken()
      const response = await makeWebRequest<{ items: Friend[] }>(
        TEST_WEB_PORT,
        '/api/friends',
        'GET',
        null,
        token
      )
      expect(response.statusCode).toBe(200)
      expect(response.body.items).toBeDefined()
    })
  })

  describe('POST /api/friends', () => {
    it('should create friend with authentication', async () => {
      const token = await loginAndGetToken()
      const response = await makeWebRequest<{ friend: Friend }>(
        TEST_WEB_PORT,
        '/api/friends',
        'POST',
        { display_name: 'Web User', permission: 'normal' },
        token
      )
      expect(response.statusCode).toBe(201)
      expect(response.body.friend.display_name).toBe('Web User')
      expect(response.body.friend.permission).toBe('normal')
    })
  })

  describe('CORS', () => {
    it('should handle CORS preflight requests', async () => {
      const response = await makeOptionsRequest(
        TEST_WEB_PORT,
        '/api/friends'
      )
      expect(response.statusCode).toBe(204)
    })
  })
})

// Helper functions
interface WebResponse<D = unknown> {
  statusCode: number
  body: D
}

function makeWebRequest<D = unknown>(
  port: number,
  path: string,
  method: string,
  body: unknown | null,
  token?: string | null
): Promise<WebResponse<D>> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: 'localhost',
        port,
        method,
        path,
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(body !== undefined && body !== null ? { 'Content-Length': Buffer.byteLength(JSON.stringify(body)) } : {}),
        },
      },
      (res) => {
        let data = ''
        res.on('data', (chunk) => {
          data += chunk
        })
        res.on('end', () => {
          try {
            resolve({ statusCode: res.statusCode ?? 0, body: JSON.parse(data) as D })
          } catch (e) {
            reject(new Error(`Failed to parse response: ${String(e)}`))
          }
        })
      }
    )
    req.on('error', reject)
    if (body !== undefined && body !== null) {
      req.write(JSON.stringify(body))
    }
    req.end()
  })
}

function makeOptionsRequest(
  port: number,
  path: string
): Promise<{ statusCode: number }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: 'localhost',
        port,
        method: 'OPTIONS',
        path,
      },
      (res) => {
        res.on('data', () => {
          // ignore data
        })
        res.on('end', () => {
          resolve({ statusCode: res.statusCode ?? 0 })
        })
      }
    )
    req.on('error', reject)
    req.end()
  })
}

async function loginAndGetToken(): Promise<string> {
  const response = await makeWebRequest<LoginResponse>(
    TEST_WEB_PORT,
    '/api/auth/login',
    'POST',
    { password: 'test_password_123' }
  )
  expect(response.statusCode).toBe(200)
  expect(response.body.token).toBeDefined()
  return response.body.token
}
