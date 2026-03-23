/**
 * Admin 模块测试
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import http from 'node:http'
import fs from 'node:fs/promises'
import AdminModule from './index.js'
import type { Friend } from './types.js'

// 测试配置
const TEST_PROTOCOL_PORT = 19801
const TEST_WEB_PORT = 13000
const TEST_DATA_DIR = './test-data/admin-test'

// 全局存储 JWT token
let jwtToken: string = ''

describe('AdminModule', () => {
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
        moduleId: 'admin-test',
        moduleType: 'admin',
        version: '0.1.0',
        protocolVersion: '0.1.0',
        port: TEST_PROTOCOL_PORT,
        subscriptions: [],
      },
      {
        web_port: TEST_WEB_PORT,
        data_dir: TEST_DATA_DIR,
        password_env: 'TEST_ADMIN_PASSWORD',
        jwt_secret_env: 'TEST_JWT_SECRET',
        token_ttl: 3600,
      }
    )

    // 设置测试环境变量
    process.env.TEST_ADMIN_PASSWORD = 'test_password_123'
    process.env.TEST_JWT_SECRET = 'test_jwt_secret_at_least_32_chars'

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

  describe('Health Check', () => {
    it('should return healthy status', async () => {
      const response = await makeProtocolRequest<Record<string, unknown>>(
        TEST_PROTOCOL_PORT,
        'health',
        {}
      )
      expect(response.success).toBe(true)
      expect(response.data.status).toBe('healthy')
    })
  })

  describe('Authentication', () => {
    it('should login with correct password', async () => {
      const response = await makeWebRequest<{ token: string; expires_at: string }>(
        TEST_WEB_PORT,
        'POST',
        '/api/auth/login',
        { password: 'test_password_123' },
        false
      )

      expect(response.token).toBeDefined()
      expect(response.expires_at).toBeDefined()
      jwtToken = response.token
    })

    it('should reject wrong password', async () => {
      const response = await makeWebRequestRaw(
        TEST_WEB_PORT,
        'POST',
        '/api/auth/login',
        { password: 'wrong_password' },
        false
      )

      expect(response.status).toBe(401)
    })

    it('should require auth for protected endpoints', async () => {
      const response = await makeWebRequestRaw(
        TEST_WEB_PORT,
        'GET',
        '/api/friends',
        null,
        false
      )
      expect(response.status).toBe(401)
    })

    it('should access protected endpoint with valid token', async () => {
      const response = await makeWebRequestRaw(
        TEST_WEB_PORT,
        'GET',
        '/api/friends',
        null,
        true
      )
      expect(response.status).toBe(200)
    })
  })

  describe('Friend Management (Protocol)', () => {
    it('should create a master friend', async () => {
      const response = await makeProtocolRequest<{ friend: Friend }>(
        TEST_PROTOCOL_PORT,
        'create_friend',
        {
          display_name: 'Master User',
          permission: 'master',
        }
      )

      expect(response.success).toBe(true)
      expect(response.data.friend.display_name).toBe('Master User')
      expect(response.data.friend.permission).toBe('master')
    })

    it('should not create second master', async () => {
      const response = await makeProtocolRequest<unknown>(
        TEST_PROTOCOL_PORT,
        'create_friend',
        {
          display_name: 'Second Master',
          permission: 'master',
        }
      )

      expect(response.success).toBe(false)
    })

    it('should create normal friend with template', async () => {
      const response = await makeProtocolRequest<{ friend: Friend }>(
        TEST_PROTOCOL_PORT,
        'create_friend',
        {
          display_name: 'Normal User',
          permission: 'normal',
          permission_template_id: 'standard',
        }
      )

      expect(response.success).toBe(true)
      expect(response.data.friend.permission).toBe('normal')
    })

    it('should list friends', async () => {
      const response = await makeProtocolRequest<{
        items: Friend[]
        pagination: { total_items: number }
      }>(TEST_PROTOCOL_PORT, 'list_friends', {})

      expect(response.success).toBe(true)
      expect(response.data.items.length).toBeGreaterThanOrEqual(2)
    })

    it('should filter friends by permission', async () => {
      const response = await makeProtocolRequest<{ items: Friend[] }>(
        TEST_PROTOCOL_PORT,
        'list_friends',
        { permission: 'master' }
      )

      expect(response.success).toBe(true)
      expect(response.data.items).toHaveLength(1)
      expect(response.data.items[0].permission).toBe('master')
    })

    it('should search friends', async () => {
      const response = await makeProtocolRequest<{ items: Friend[] }>(
        TEST_PROTOCOL_PORT,
        'list_friends',
        { search: 'Master' }
      )

      expect(response.success).toBe(true)
      expect(response.data.items.length).toBeGreaterThanOrEqual(1)
    })

    it('should get friend by id', async () => {
      // 先创建一个 friend
      const createResponse = await makeProtocolRequest<{ friend: Friend }>(
        TEST_PROTOCOL_PORT,
        'create_friend',
        {
          display_name: 'Get Test User',
          permission: 'normal',
          permission_template_id: 'standard',
        }
      )

      const friendId = createResponse.data.friend.id

      const response = await makeProtocolRequest<{ friend: Friend }>(
        TEST_PROTOCOL_PORT,
        'get_friend',
        { friend_id: friendId }
      )

      expect(response.success).toBe(true)
      expect(response.data.friend.id).toBe(friendId)
    })

    it('should update friend', async () => {
      const createResponse = await makeProtocolRequest<{ friend: Friend }>(
        TEST_PROTOCOL_PORT,
        'create_friend',
        {
          display_name: 'Update Test User',
          permission: 'normal',
          permission_template_id: 'standard',
        }
      )

      const friendId = createResponse.data.friend.id

      const response = await makeProtocolRequest<{ friend: Friend }>(
        TEST_PROTOCOL_PORT,
        'update_friend',
        {
          friend_id: friendId,
          display_name: 'Updated Name',
        }
      )

      expect(response.success).toBe(true)
      expect(response.data.friend.display_name).toBe('Updated Name')
    })

    it('should delete friend', async () => {
      const createResponse = await makeProtocolRequest<{ friend: Friend }>(
        TEST_PROTOCOL_PORT,
        'create_friend',
        {
          display_name: 'Delete Test User',
          permission: 'normal',
          permission_template_id: 'standard',
        }
      )

      const friendId = createResponse.data.friend.id

      const response = await makeProtocolRequest<{ deleted: boolean }>(
        TEST_PROTOCOL_PORT,
        'delete_friend',
        { friend_id: friendId }
      )

      expect(response.success).toBe(true)
      expect(response.data.deleted).toBe(true)
    })

    it('should not delete master friend', async () => {
      const listResponse = await makeProtocolRequest<{ items: Friend[] }>(
        TEST_PROTOCOL_PORT,
        'list_friends',
        { permission: 'master' }
      )

      const masterId = listResponse.data.items[0].id

      const response = await makeProtocolRequest<unknown>(
        TEST_PROTOCOL_PORT,
        'delete_friend',
        { friend_id: masterId }
      )

      expect(response.success).toBe(false)
    })
  })

  describe('Channel Identity Management', () => {
    let friendId: string

    beforeEach(async () => {
      const response = await makeProtocolRequest<{ friend: Friend }>(
        TEST_PROTOCOL_PORT,
        'create_friend',
        {
          display_name: 'Channel Test User',
          permission: 'normal',
          permission_template_id: 'standard',
        }
      )
      friendId = response.data.friend.id
    })

    it('should link channel identity', async () => {
      const response = await makeProtocolRequest<{ friend: Friend }>(
        TEST_PROTOCOL_PORT,
        'link_channel_identity',
        {
          friend_id: friendId,
          channel_identity: {
            channel_id: 'channel-feishu',
            platform_user_id: 'user_001',
          },
        }
      )

      expect(response.success).toBe(true)
      expect(response.data.friend.channel_identities).toHaveLength(1)
    })

    it('should resolve friend by channel identity', async () => {
      // 先绑定
      await makeProtocolRequest<unknown>(
        TEST_PROTOCOL_PORT,
        'link_channel_identity',
        {
          friend_id: friendId,
          channel_identity: {
            channel_id: 'channel-test',
            platform_user_id: 'user_resolve_test',
          },
        }
      )

      const response = await makeProtocolRequest<{ friend: Friend | null }>(
        TEST_PROTOCOL_PORT,
        'resolve_friend',
        {
          channel_id: 'channel-test',
          platform_user_id: 'user_resolve_test',
        }
      )

      expect(response.success).toBe(true)
      expect(response.data.friend).not.toBeNull()
      expect(response.data.friend?.id).toBe(friendId)
    })

    it('should return null for unknown channel identity', async () => {
      const response = await makeProtocolRequest<{ friend: Friend | null }>(
        TEST_PROTOCOL_PORT,
        'resolve_friend',
        {
          channel_id: 'channel-unknown',
          platform_user_id: 'unknown_user',
        }
      )

      expect(response.success).toBe(true)
      expect(response.data.friend).toBeNull()
    })

    it('should unlink channel identity', async () => {
      // 先绑定
      await makeProtocolRequest<unknown>(
        TEST_PROTOCOL_PORT,
        'link_channel_identity',
        {
          friend_id: friendId,
          channel_identity: {
            channel_id: 'channel-unlink',
            platform_user_id: 'user_unlink_test',
          },
        }
      )

      const response = await makeProtocolRequest<{ friend: Friend }>(
        TEST_PROTOCOL_PORT,
        'unlink_channel_identity',
        {
          friend_id: friendId,
          channel_id: 'channel-unlink',
          platform_user_id: 'user_unlink_test',
        }
      )

      expect(response.success).toBe(true)
      expect(
        response.data.friend.channel_identities.find(
          (i) => i.channel_id === 'channel-unlink' && i.platform_user_id === 'user_unlink_test'
        )
      ).toBeUndefined()
    })

    it('should reject duplicate channel identity', async () => {
      // 绑定到第一个 friend
      await makeProtocolRequest<unknown>(
        TEST_PROTOCOL_PORT,
        'link_channel_identity',
        {
          friend_id: friendId,
          channel_identity: {
            channel_id: 'channel-duplicate',
            platform_user_id: 'user_duplicate',
          },
        }
      )

      // 创建第二个 friend
      const createResponse = await makeProtocolRequest<{ friend: Friend }>(
        TEST_PROTOCOL_PORT,
        'create_friend',
        {
          display_name: 'Second User',
          permission: 'normal',
          permission_template_id: 'standard',
        }
      )

      // 尝试绑定相同的 channel identity
      const response = await makeProtocolRequest<unknown>(
        TEST_PROTOCOL_PORT,
        'link_channel_identity',
        {
          friend_id: createResponse.data.friend.id,
          channel_identity: {
            channel_id: 'channel-duplicate',
            platform_user_id: 'user_duplicate',
          },
        }
      )

      expect(response.success).toBe(false)
    })
  })

  describe('Friend REST API', () => {
    it('should list friends via REST', async () => {
      const response = await makeWebRequest<{
        items: Friend[]
        pagination: { total_items: number }
      }>(TEST_WEB_PORT, 'GET', '/api/friends', null, true)

      expect(response.items).toBeInstanceOf(Array)
      expect(response.pagination.total_items).toBeGreaterThanOrEqual(0)
    })

    it('should filter friends by permission via REST', async () => {
      const response = await makeWebRequest<{ items: Friend[] }>(
        TEST_WEB_PORT,
        'GET',
        '/api/friends?permission=master',
        null,
        true
      )

      expect(response.items).toHaveLength(1)
    })

    it('should create friend via REST', async () => {
      const response = await makeWebRequest<{ friend: Friend }>(
        TEST_WEB_PORT,
        'POST',
        '/api/friends',
        {
          display_name: 'REST API User',
          permission: 'normal',
          permission_template_id: 'standard',
        },
        true
      )

      expect(response.friend.display_name).toBe('REST API User')
    })
  })

  describe('Pending Messages', () => {
    it('should list pending messages', async () => {
      const response = await makeProtocolRequest<{ items: unknown[] }>(
        TEST_PROTOCOL_PORT,
        'list_pending_messages',
        {}
      )

      expect(response.success).toBe(true)
      expect(response.data.items).toBeInstanceOf(Array)
    })
  })

  describe('Friend Update and Delete', () => {
    let friendId: string

    beforeEach(async () => {
      const response = await makeProtocolRequest<{ friend: Friend }>(
        TEST_PROTOCOL_PORT,
        'create_friend',
        {
          display_name: 'Update Test User',
          permission: 'normal',
          permission_template_id: 'standard',
        }
      )
      friendId = response.data.friend.id
    })

    it('should update friend display name', async () => {
      const response = await makeProtocolRequest<{ friend: Friend }>(
        TEST_PROTOCOL_PORT,
        'update_friend',
        {
          friend_id: friendId,
          display_name: 'Updated Name',
        }
      )

      expect(response.success).toBe(true)
      expect(response.data.friend.display_name).toBe('Updated Name')
    })

    it('should update friend permission', async () => {
      const response = await makeProtocolRequest<{ friend: Friend }>(
        TEST_PROTOCOL_PORT,
        'update_friend',
        {
          friend_id: friendId,
          permission: 'readonly',
        }
      )

      expect(response.success).toBe(true)
      expect(response.data.friend.permission).toBe('readonly')
    })

    it('should return error for non-existent friend update', async () => {
      const response = await makeProtocolRequest(
        TEST_PROTOCOL_PORT,
        'update_friend',
        {
          friend_id: 'non-existent-friend',
          display_name: 'New Name',
        }
      )

      expect(response.success).toBe(false)
    })

    it('should return error for non-existent friend get', async () => {
      const response = await makeProtocolRequest(
        TEST_PROTOCOL_PORT,
        'get_friend',
        { friend_id: 'non-existent-friend' }
      )

      expect(response.success).toBe(false)
    })

    it('should return error for non-existent friend delete', async () => {
      const response = await makeProtocolRequest(
        TEST_PROTOCOL_PORT,
        'delete_friend',
        { friend_id: 'non-existent-friend' }
      )

      expect(response.success).toBe(false)
    })
  })

  describe('Channel Identity Unlink', () => {
    it('should return error for non-existent friend unlink', async () => {
      const response = await makeProtocolRequest(
        TEST_PROTOCOL_PORT,
        'unlink_channel_identity',
        {
          friend_id: 'non-existent-friend',
          channel_id: 'test-channel',
          platform_user_id: 'test-user',
        }
      )

      expect(response.success).toBe(false)
    })
  })

  describe('Resolve Friend', () => {
    it('should return null for non-existent channel identity', async () => {
      const response = await makeProtocolRequest<{ friend: Friend | null }>(
        TEST_PROTOCOL_PORT,
        'resolve_friend',
        {
          channel_id: 'non-existent-channel',
          platform_user_id: 'non-existent-user',
        }
      )

      expect(response.success).toBe(true)
      expect(response.data.friend).toBeNull()
    })
  })

  describe('List Friends with Pagination', () => {
    it('should paginate friends list', async () => {
      const response = await makeProtocolRequest<{
        items: Friend[]
        pagination: { page: number; page_size: number; total_items: number }
      }>(
        TEST_PROTOCOL_PORT,
        'list_friends',
        {
          pagination: { page: 1, page_size: 10 },
        }
      )

      expect(response.success).toBe(true)
      expect(response.data.pagination.page).toBe(1)
      expect(response.data.pagination.page_size).toBe(10)
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
