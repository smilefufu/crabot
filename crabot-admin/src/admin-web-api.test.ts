/**
 * Admin 模块 Web API 测试
 */

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import http from 'node:http'
import fs from 'node:fs/promises'
import AdminModule from './index.js'
import type { ChannelMessageRef, DialogObjectApplication, Friend, FriendPermissionConfig, LoginResponse } from './types.js'
import { AdminErrorCode } from './types.js'

const TEST_PROTOCOL_PORT = 19807
const TEST_WEB_PORT = 13007
const TEST_DATA_DIR = './test-data/admin-web-api-test'

describe('Admin Web API', () => {
  let admin: AdminModule

  afterEach(() => {
    vi.restoreAllMocks()
  })

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

  describe('GET /api/dialog-objects/*', () => {
    it('should return basic shapes for the dialog object read APIs', async () => {
      const token = await loginAndGetToken()

      const [friends, privatePool, groups, applications] = await Promise.all([
        makeWebRequest<{ items: unknown[] }>(
          TEST_WEB_PORT,
          '/api/dialog-objects/friends',
          'GET',
          null,
          token
        ),
        makeWebRequest<{ items: unknown[] }>(
          TEST_WEB_PORT,
          '/api/dialog-objects/private-pool',
          'GET',
          null,
          token
        ),
        makeWebRequest<{ items: unknown[] }>(
          TEST_WEB_PORT,
          '/api/dialog-objects/groups',
          'GET',
          null,
          token
        ),
        makeWebRequest<{ items: unknown[] }>(
          TEST_WEB_PORT,
          '/api/dialog-objects/applications',
          'GET',
          null,
          token
        ),
      ])

      expect(friends.statusCode).toBe(200)
      expect(privatePool.statusCode).toBe(200)
      expect(groups.statusCode).toBe(200)
      expect(applications.statusCode).toBe(200)
      expect(friends.body.items).toBeInstanceOf(Array)
      expect(privatePool.body.items).toBeInstanceOf(Array)
      expect(groups.body.items).toBeInstanceOf(Array)
      expect(applications.body.items).toBeInstanceOf(Array)
    })

    it('should pass telegram master identities when listing groups', async () => {
      const token = await loginAndGetToken()

      admin['friends'].set('friend-master', {
        id: 'friend-master',
        display_name: 'FuFu',
        permission: 'master',
        permission_template_id: undefined,
        channel_identities: [
          {
            channel_id: 'telegram-001',
            platform_user_id: '7692507087',
            platform_display_name: 'FuFu',
          },
        ],
        created_at: '2026-04-19T00:00:00.000Z',
        updated_at: '2026-04-19T00:00:00.000Z',
      })

      vi.spyOn(admin['channelManager'], 'listInstances').mockReturnValue({
        items: [
          {
            id: 'telegram-001',
            implementation_id: 'channel-telegram',
            name: 'telegram-001',
            platform: 'telegram',
            auto_start: true,
            start_priority: 30,
            module_registered: true,
            created_at: '2026-04-19T00:00:00.000Z',
            updated_at: '2026-04-19T00:00:00.000Z',
          },
        ],
        pagination: { page: 1, page_size: 1, total_items: 1, total_pages: 1 },
      } as any)

      vi.spyOn(admin['rpcClient'], 'resolve').mockResolvedValue([
        {
          module_id: 'telegram-001',
          module_type: 'channel',
          version: '0.1.0',
          port: 19009,
        },
      ] as any)

      vi.spyOn(admin['rpcClient'], 'call').mockImplementation(async (_port, method, params) => {
        if (method === 'get_sessions') {
          expect(params).toEqual({
            type: 'group',
            pagination: { page: 1, page_size: 100 },
            hydrate_participant_user_ids: ['7692507087'],
          })
          return {
            items: [
              {
                id: 'group-session-1',
                channel_id: 'telegram-001',
                type: 'group',
                platform_session_id: '-4655543630',
                title: '全栈工程师哈哈 & Mr.Wu',
                participants: [
                  { platform_user_id: '7692507087', role: 'member' },
                ],
                created_at: '2026-04-19T00:00:00.000Z',
                updated_at: '2026-04-19T00:00:00.000Z',
              },
            ],
            pagination: {
              page: 1,
              page_size: 100,
              total_items: 1,
              total_pages: 1,
            },
          } as any
        }
        throw new Error(`Unexpected RPC method: ${String(method)}`)
      })

      const response = await makeWebRequest<{ items: unknown[] }>(
        TEST_WEB_PORT,
        '/api/dialog-objects/groups',
        'GET',
        null,
        token
      )

      expect(response.statusCode).toBe(200)
      expect(response.body.items).toHaveLength(1)
    })
  })

  describe('GET /api/memory/*', () => {
    it('forwards friend and scope filters to short-term memory search', async () => {
      const token = await loginAndGetToken()

      vi.spyOn(admin['rpcClient'], 'resolve').mockResolvedValue([
        {
          module_id: 'memory-test',
          module_type: 'memory',
          version: '0.1.0',
          port: 19001,
        },
      ] as any)

      const callSpy = vi.spyOn(admin['rpcClient'], 'call').mockResolvedValue({ results: [] } as any)

      const response = await makeWebRequest<{ results: unknown[] }>(
        TEST_WEB_PORT,
        '/api/memory/short-term?q=hello&limit=5&friend_id=friend-1&accessible_scope=session-a&accessible_scope=session-b',
        'GET',
        null,
        token
      )

      expect(response.statusCode).toBe(200)
      expect(response.body.results).toEqual([])
      expect(callSpy).toHaveBeenCalledWith(
        19001,
        'search_short_term',
        {
          query: 'hello',
          limit: 5,
          filter: { refs: { friend_id: 'friend-1' } },
          accessible_scopes: ['session-a', 'session-b'],
        },
        'admin-web-test'
      )
    })

    it('returns scene profiles that reference a long-term memory id', async () => {
      const token = await loginAndGetToken()

      vi.spyOn(admin['rpcClient'], 'resolve').mockResolvedValue([
        {
          module_id: 'memory-test',
          module_type: 'memory',
          version: '0.1.0',
          port: 19001,
        },
      ] as any)

      const callSpy = vi.spyOn(admin['rpcClient'], 'call').mockResolvedValue({
        profiles: [
          {
            label: 'Alice',
            scene: { type: 'friend', friend_id: 'friend-1' },
            abstract: '工作搭子',
            overview: '稳定规则',
            content: '完整说明',
            created_at: '2026-04-19T00:00:00.000Z',
            updated_at: '2026-04-20T00:00:00.000Z',
          },
        ],
      } as any)

      const response = await makeWebRequest<{ profiles: Array<{ label: string; scene: { type: string; friend_id: string } }> }>(
        TEST_WEB_PORT,
        '/api/memory/mem-1/scene-profiles',
        'GET',
        null,
        token,
      )

      expect(response.statusCode).toBe(200)
      expect(response.body).toEqual({
        profiles: [
          expect.objectContaining({
            label: 'Alice',
            scene: { type: 'friend', friend_id: 'friend-1' },
          }),
        ],
      })

      expect(callSpy).toHaveBeenCalledWith(
        19001,
        'list_scene_profiles_by_memory',
        { memory_id: 'mem-1' },
        'admin-web-test',
      )
    })
  })

  describe('PATCH /api/scene-profiles/:key', () => {
    it('trims document fields and preserves existing abstract when blank values are submitted', async () => {
      const token = await loginAndGetToken()

      vi.spyOn(admin['rpcClient'], 'resolve').mockResolvedValue([
        {
          module_id: 'memory-test',
          module_type: 'memory',
          version: '0.1.0',
          port: 19001,
        },
      ] as any)

      const callSpy = vi.spyOn(admin['rpcClient'], 'call').mockImplementation(async (_port, method, params) => {
        if (method === 'get_scene_profile') {
          expect(params).toEqual({ scene: { type: 'friend', friend_id: 'friend-1' } })
          return {
            profile: {
              scene: { type: 'friend', friend_id: 'friend-1' },
              label: 'Alice',
              abstract: '现有摘要',
              overview: '现有概览',
              content: '现有正文',
              source_memory_ids: ['mem-1'],
              created_at: '2026-04-19T00:00:00.000Z',
              updated_at: '2026-04-20T00:00:00.000Z',
              last_declared_at: null,
            },
          } as any
        }
        if (method === 'upsert_scene_profile') {
          expect(params).toMatchObject({
            scene: { type: 'friend', friend_id: 'friend-1' },
            label: 'Alice 2',
            abstract: '现有摘要',
            overview: '新概览',
            content: '新正文',
            source_memory_ids: ['mem-1'],
          })
          return { profile: params } as any
        }
        throw new Error(`Unexpected RPC method: ${String(method)}`)
      })

      const response = await makeWebRequest<{ profile: unknown }>(
        TEST_WEB_PORT,
        '/api/scene-profiles/friend%3Afriend-1',
        'PATCH',
        {
          label: '  Alice 2  ',
          abstract: '   ',
          overview: '  新概览  ',
          content: '  新正文  ',
        },
        token
      )

      expect(response.statusCode).toBe(200)
      expect(callSpy).toHaveBeenCalledTimes(2)
    })

    it('rejects a patch when the resulting content is empty', async () => {
      const token = await loginAndGetToken()

      vi.spyOn(admin['rpcClient'], 'resolve').mockResolvedValue([
        {
          module_id: 'memory-test',
          module_type: 'memory',
          version: '0.1.0',
          port: 19001,
        },
      ] as any)

      const callSpy = vi.spyOn(admin['rpcClient'], 'call').mockImplementation(async (_port, method, params) => {
        if (method === 'get_scene_profile') {
          expect(params).toEqual({ scene: { type: 'global' } })
          return { profile: null } as any
        }
        throw new Error(`Unexpected RPC method: ${String(method)}`)
      })

      const response = await makeWebRequest<{ error: string }>(
        TEST_WEB_PORT,
        '/api/scene-profiles/global',
        'PATCH',
        {
          label: 'global',
          abstract: '   ',
          overview: '   ',
          content: '   ',
        },
        token
      )

      expect(response.statusCode).toBe(400)
      expect(response.body.error).toBe('Scene profile content cannot be empty')
      expect(callSpy).toHaveBeenCalledTimes(1)
    })

    it('rejects a patch when edit payload clears existing content', async () => {
      const token = await loginAndGetToken()

      vi.spyOn(admin['rpcClient'], 'resolve').mockResolvedValue([
        {
          module_id: 'memory-test',
          module_type: 'memory',
          version: '0.1.0',
          port: 19001,
        },
      ] as any)

      const callSpy = vi.spyOn(admin['rpcClient'], 'call').mockImplementation(async (_port, method, params) => {
        if (method === 'get_scene_profile') {
          expect(params).toEqual({ scene: { type: 'friend', friend_id: 'friend-2' } })
          return {
            profile: {
              scene: { type: 'friend', friend_id: 'friend-2' },
              label: 'Bob',
              abstract: '现有摘要',
              overview: '现有概览',
              content: '现有正文',
              created_at: '2026-04-19T00:00:00.000Z',
              updated_at: '2026-04-20T00:00:00.000Z',
              last_declared_at: null,
            },
          } as any
        }
        throw new Error(`Unexpected RPC method: ${String(method)}`)
      })

      const response = await makeWebRequest<{ error: string }>(
        TEST_WEB_PORT,
        '/api/scene-profiles/friend%3Afriend-2',
        'PATCH',
        {
          content: '   ',
        },
        token
      )

      expect(response.statusCode).toBe(400)
      expect(response.body.error).toBe('Scene profile content cannot be empty')
      expect(callSpy).toHaveBeenCalledTimes(1)
    })
  })

  describe('POST /api/dialog-objects/private-pool/:sessionId/*', () => {
    it('assigns an unassigned private session to an existing friend and clears matching applications', async () => {
      const token = await loginAndGetToken()
      const createFriend = await makeWebRequest<{ friend: Friend }>(
        TEST_WEB_PORT,
        '/api/friends',
        'POST',
        { display_name: 'Existing Friend', permission: 'normal' },
        token
      )

      expect(createFriend.statusCode).toBe(201)

      await admin['handleUpsertPendingMessage']({
        channel_id: 'wechat-main',
        platform_user_id: 'wx-user-1',
        platform_display_name: 'WX User 1',
        content_preview: '/apply',
        intent: 'apply',
        raw_message: makePrivateMessageRef({
          channel_id: 'wechat-main',
          session_id: 'pending-session-1',
          platform_user_id: 'wx-user-1',
          platform_display_name: 'WX User 1',
          text: '/apply',
        }),
      })

      mockChannelSessionLookup(admin, {
        id: 'private-session-1',
        channel_id: 'wechat-main',
        type: 'private',
        platform_session_id: 'wx-user-1',
        title: 'WX User 1',
        participants: [
          { platform_user_id: 'wx-user-1', role: 'member' },
        ],
        created_at: '2026-04-19T00:00:00.000Z',
        updated_at: '2026-04-19T00:00:00.000Z',
      })

      const assignResponse = await makeWebRequest<{ friend: Friend }>(
        TEST_WEB_PORT,
        '/api/dialog-objects/private-pool/private-session-1/assign-friend',
        'POST',
        {
          channel_id: 'wechat-main',
          friend_id: createFriend.body.friend.id,
        },
        token
      )

      expect(assignResponse.statusCode).toBe(200)
      expect(assignResponse.body.friend.id).toBe(createFriend.body.friend.id)
      expect(assignResponse.body.friend.channel_identities).toEqual([
        {
          channel_id: 'wechat-main',
          platform_user_id: 'wx-user-1',
          platform_display_name: 'WX User 1',
        },
      ])
      expect(Array.from(admin['pendingMessages'].values())).toEqual([])

      const secondAssign = await makeWebRequest<{ friend: Friend }>(
        TEST_WEB_PORT,
        '/api/dialog-objects/private-pool/private-session-1/assign-friend',
        'POST',
        {
          channel_id: 'wechat-main',
          friend_id: createFriend.body.friend.id,
        },
        token
      )

      expect(secondAssign.statusCode).toBe(200)
      expect(secondAssign.body.friend.channel_identities).toHaveLength(1)
    })

    it('creates a new friend from a private-pool session and clears matching applications', async () => {
      const token = await loginAndGetToken()

      await admin['handleUpsertPendingMessage']({
        channel_id: 'wechat-main',
        platform_user_id: 'wx-user-2',
        platform_display_name: 'WX User 2',
        content_preview: '/apply',
        intent: 'apply',
        raw_message: makePrivateMessageRef({
          channel_id: 'wechat-main',
          session_id: 'pending-session-2',
          platform_user_id: 'wx-user-2',
          platform_display_name: 'WX User 2',
          text: '/apply',
        }),
      })

      mockChannelSessionLookup(admin, {
        id: 'private-session-2',
        channel_id: 'wechat-main',
        type: 'private',
        platform_session_id: 'wx-user-2',
        title: 'WX User 2',
        participants: [
          { platform_user_id: 'wx-user-2', role: 'member' },
        ],
        created_at: '2026-04-19T00:00:00.000Z',
        updated_at: '2026-04-19T00:00:00.000Z',
      })

      const createResponse = await makeWebRequest<{ friend: Friend }>(
        TEST_WEB_PORT,
        '/api/dialog-objects/private-pool/private-session-2/create-friend',
        'POST',
        {
          channel_id: 'wechat-main',
          display_name: 'Created From Pool',
          permission_template_id: 'trusted',
        },
        token
      )

      expect(createResponse.statusCode).toBe(201)
      expect(createResponse.body.friend.display_name).toBe('Created From Pool')
      expect(createResponse.body.friend.permission).toBe('normal')
      expect(createResponse.body.friend.permission_template_id).toBe('trusted')
      expect(createResponse.body.friend.channel_identities).toEqual([
        {
          channel_id: 'wechat-main',
          platform_user_id: 'wx-user-2',
          platform_display_name: 'WX User 2',
        },
      ])
      expect(Array.from(admin['pendingMessages'].values())).toEqual([])

      const applications = await makeWebRequest<{ items: DialogObjectApplication[] }>(
        TEST_WEB_PORT,
        '/api/dialog-objects/applications',
        'GET',
        null,
        token
      )

      expect(applications.statusCode).toBe(200)
      expect(applications.body.items).toEqual([])
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

  describe('friend permission API master behavior', () => {
    it('should resolve master permissions from master_private even if an explicit friend config exists', async () => {
      const token = await loginAndGetToken()
      const friendId = 'master-read-test'
      admin['friends'].set(friendId, {
        id: friendId,
        display_name: 'Master Read Test',
        permission: 'master',
        channel_identities: [],
        created_at: '2026-04-21T00:00:00.000Z',
        updated_at: '2026-04-21T00:00:00.000Z',
      })

      const explicitConfig: FriendPermissionConfig = {
        tool_access: {
          memory: false,
          messaging: false,
          task: false,
          mcp_skill: false,
          file_io: false,
          browser: false,
          shell: false,
          remote_exec: false,
          desktop: false,
        },
        storage: null,
        memory_scopes: ['should-not-apply'],
        updated_at: '2026-04-21T00:00:00.000Z',
      }
      admin['friendPermissionConfigs'].set(friendId, explicitConfig)

      const response = await makeWebRequest<{
        config: FriendPermissionConfig | null
        resolved: {
          tool_access: FriendPermissionConfig['tool_access']
          storage: FriendPermissionConfig['storage']
          memory_scopes: string[]
        } | null
      }>(
        TEST_WEB_PORT,
        `/api/friends/${friendId}/permissions`,
        'GET',
        null,
        token
      )

      expect(response.statusCode).toBe(200)
      expect(response.body.config).toEqual(explicitConfig)
      expect(response.body.resolved).toEqual({
        tool_access: {
          memory: true,
          messaging: true,
          task: true,
          mcp_skill: true,
          file_io: true,
          browser: true,
          shell: true,
          remote_exec: true,
          desktop: true,
        },
        storage: { workspace_path: '/', access: 'readwrite' },
        memory_scopes: [],
      })
    })

    it('should resolve an untouched normal friend from the standard template', async () => {
      const token = await loginAndGetToken()
      const friendId = 'normal-standard-read-test'
      admin['friends'].set(friendId, {
        id: friendId,
        display_name: 'Normal Standard Read Test',
        permission: 'normal',
        permission_template_id: 'standard',
        channel_identities: [],
        created_at: '2026-04-21T00:00:00.000Z',
        updated_at: '2026-04-21T00:00:00.000Z',
      })

      const response = await getFriendPermissions(token, friendId)

      expect(response.statusCode).toBe(200)
      expect(response.body.config).toBeNull()
      expect(response.body.resolved).toEqual({
        tool_access: {
          memory: true,
          messaging: true,
          task: true,
          mcp_skill: false,
          file_io: false,
          browser: false,
          shell: false,
          remote_exec: false,
          desktop: false,
        },
        storage: null,
        memory_scopes: [],
      })
    })

    it('should resolve an untouched normal friend without a template id from the standard template', async () => {
      const token = await loginAndGetToken()
      const friendId = 'normal-implicit-standard-read-test'
      admin['friends'].set(friendId, {
        id: friendId,
        display_name: 'Normal Implicit Standard Read Test',
        permission: 'normal',
        channel_identities: [],
        created_at: '2026-04-21T00:00:00.000Z',
        updated_at: '2026-04-21T00:00:00.000Z',
      })

      const response = await getFriendPermissions(token, friendId)

      expect(response.statusCode).toBe(200)
      expect(response.body.config).toBeNull()
      expect(response.body.resolved).toEqual({
        tool_access: {
          memory: true,
          messaging: true,
          task: true,
          mcp_skill: false,
          file_io: false,
          browser: false,
          shell: false,
          remote_exec: false,
          desktop: false,
        },
        storage: null,
        memory_scopes: [],
      })
    })

    it('should return 404 for an unknown friend when reading permissions', async () => {
      const token = await loginAndGetToken()

      const response = await getFriendPermissions(token, 'missing-friend-read-test')

      expect(response.statusCode).toBe(404)
      expect(response.body.error).toBe('Friend not found')
    })

    it('should return 404 for an unknown friend when updating permissions', async () => {
      const token = await loginAndGetToken()

      const response = await putFriendPermissions(token, 'missing-friend-update-test', {
        tool_access: {
          memory: true,
          messaging: true,
          task: true,
          mcp_skill: false,
          file_io: false,
          browser: false,
          shell: false,
          remote_exec: false,
          desktop: false,
        },
        storage: null,
        memory_scopes: [],
      })

      expect(response.statusCode).toBe(404)
      expect(response.body.error).toBe('Friend not found')
    })

    it('should read the master friend with empty memory scopes and master storage defaults', async () => {
      const token = await loginAndGetToken()
      const friendId = 'master-default-read-test'
      admin['friends'].set(friendId, {
        id: friendId,
        display_name: 'Master Default Read Test',
        permission: 'master',
        channel_identities: [],
        created_at: '2026-04-21T00:00:00.000Z',
        updated_at: '2026-04-21T00:00:00.000Z',
      })

      const response = await getFriendPermissions(token, friendId)

      expect(response.statusCode).toBe(200)
      expect(response.body.config).toBeNull()
      expect(response.body.resolved).toEqual({
        tool_access: {
          memory: true,
          messaging: true,
          task: true,
          mcp_skill: true,
          file_io: true,
          browser: true,
          shell: true,
          remote_exec: true,
          desktop: true,
        },
        storage: { workspace_path: '/', access: 'readwrite' },
        memory_scopes: [],
      })
    })

    it('should reject updating master friend permissions', async () => {
      const token = await loginAndGetToken()
      const friendId = 'master-update-test'
      admin['friends'].set(friendId, {
        id: friendId,
        display_name: 'Master Update Test',
        permission: 'master',
        channel_identities: [],
        created_at: '2026-04-21T00:00:00.000Z',
        updated_at: '2026-04-21T00:00:00.000Z',
      })

      const response = await makeWebRequest<{ error: string }>(
        TEST_WEB_PORT,
        `/api/friends/${friendId}/permissions`,
        'PUT',
        {
          config: {
            tool_access: {
              memory: false,
              messaging: true,
              task: false,
              mcp_skill: false,
              file_io: false,
              browser: false,
              shell: false,
              remote_exec: false,
              desktop: false,
            },
            storage: null,
            memory_scopes: ['should-not-save'],
          },
        },
        token
      )

      expect(response.statusCode).toBe(400)
      expect(response.body.error).toBe('Cannot update master friend permissions')
      expect(admin['friendPermissionConfigs'].has(friendId)).toBe(false)
    })
  })

  describe('friend permission API non-master behavior', () => {
    it('should normalize a preexisting stale explicit non-master config on read', async () => {
      const token = await loginAndGetToken()
      const friendId = 'normal-stale-config-read-test'
      admin['friends'].set(friendId, {
        id: friendId,
        display_name: 'Normal Stale Config Read Test',
        permission: 'normal',
        permission_template_id: 'standard',
        channel_identities: [],
        created_at: '2026-04-21T00:00:00.000Z',
        updated_at: '2026-04-21T00:00:00.000Z',
      })
      admin['friendPermissionConfigs'].set(friendId, {
        tool_access: {
          memory: true,
          messaging: true,
          task: true,
          mcp_skill: false,
          file_io: false,
          browser: false,
          shell: false,
          remote_exec: false,
          desktop: true,
        },
        storage: null,
        memory_scopes: ['scope-stale'],
        updated_at: '2026-04-21T00:00:00.000Z',
      })

      const response = await makeWebRequest<{
        config: FriendPermissionConfig | null
        resolved: {
          tool_access: FriendPermissionConfig['tool_access']
          storage: FriendPermissionConfig['storage']
          memory_scopes: string[]
        } | null
      }>(
        TEST_WEB_PORT,
        `/api/friends/${friendId}/permissions`,
        'GET',
        null,
        token
      )

      expect(response.statusCode).toBe(200)
      expect(response.body.config?.tool_access.desktop).toBe(false)
      expect(response.body.resolved?.tool_access.desktop).toBe(false)
    })

    it('should clamp desktop to false when saving explicit non-master friend permissions', async () => {
      const token = await loginAndGetToken()
      const friendId = 'normal-desktop-clamp-test'
      admin['friends'].set(friendId, {
        id: friendId,
        display_name: 'Normal Desktop Clamp Test',
        permission: 'normal',
        permission_template_id: 'standard',
        channel_identities: [],
        created_at: '2026-04-21T00:00:00.000Z',
        updated_at: '2026-04-21T00:00:00.000Z',
      })

      const response = await makeWebRequest<{ config: FriendPermissionConfig }>(
        TEST_WEB_PORT,
        `/api/friends/${friendId}/permissions`,
        'PUT',
        {
          config: {
            tool_access: {
              memory: true,
              messaging: true,
              task: true,
              mcp_skill: false,
              file_io: false,
              browser: false,
              shell: false,
              remote_exec: false,
              desktop: true,
            },
            storage: null,
            memory_scopes: ['scope-a'],
          },
        },
        token
      )

      expect(response.statusCode).toBe(200)
      expect(response.body.config.tool_access.desktop).toBe(false)
      expect(admin['friendPermissionConfigs'].get(friendId)?.tool_access.desktop).toBe(false)
    })

    it('should save explicit non-master permissions and return matching config and resolved data', async () => {
      const token = await loginAndGetToken()
      const friendId = 'normal-explicit-save-test'
      admin['friends'].set(friendId, {
        id: friendId,
        display_name: 'Normal Explicit Save Test',
        permission: 'normal',
        permission_template_id: 'standard',
        channel_identities: [],
        created_at: '2026-04-21T00:00:00.000Z',
        updated_at: '2026-04-21T00:00:00.000Z',
      })

      const requestedConfig = {
        tool_access: {
          memory: true,
          messaging: false,
          task: true,
          mcp_skill: false,
          file_io: true,
          browser: false,
          shell: false,
          remote_exec: false,
          desktop: false,
        },
        storage: { workspace_path: '/workspace/projects', access: 'readwrite' as const },
        memory_scopes: ['scope-a', 'scope-b'],
      }

      const saveResponse = await putFriendPermissions(token, friendId, requestedConfig)

      expect(saveResponse.statusCode).toBe(200)
      expect(saveResponse.body.config).toMatchObject(requestedConfig)
      expect(saveResponse.body.config.updated_at).toBeDefined()

      const readResponse = await getFriendPermissions(token, friendId)

      expect(readResponse.statusCode).toBe(200)
      expect(readResponse.body.config).toMatchObject(requestedConfig)
      expect(readResponse.body.config?.updated_at).toBe(saveResponse.body.config.updated_at)
      expect(readResponse.body.resolved).toEqual({
        ...requestedConfig,
      })
    })

    it('should return resolved null when a non-master friend template is missing', async () => {
      const token = await loginAndGetToken()
      const friendId = 'normal-missing-template-test'
      admin['friends'].set(friendId, {
        id: friendId,
        display_name: 'Normal Missing Template Test',
        permission: 'normal',
        permission_template_id: 'missing-template',
        channel_identities: [],
        created_at: '2026-04-21T00:00:00.000Z',
        updated_at: '2026-04-21T00:00:00.000Z',
      })

      const response = await makeWebRequest<{
        config: FriendPermissionConfig | null
        resolved: {
          tool_access: FriendPermissionConfig['tool_access']
          storage: FriendPermissionConfig['storage']
          memory_scopes: string[]
        } | null
      }>(
        TEST_WEB_PORT,
        `/api/friends/${friendId}/permissions`,
        'GET',
        null,
        token
      )

      expect(response.statusCode).toBe(200)
      expect(response.body.config).toBeNull()
      expect(response.body.resolved).toBeNull()
    })

    it('should delete a friend permission config when the friend is deleted', async () => {
      const token = await loginAndGetToken()
      const friendId = 'normal-delete-config-test'
      admin['friends'].set(friendId, {
        id: friendId,
        display_name: 'Normal Delete Config Test',
        permission: 'normal',
        permission_template_id: 'standard',
        channel_identities: [],
        created_at: '2026-04-21T00:00:00.000Z',
        updated_at: '2026-04-21T00:00:00.000Z',
      })
      admin['friendPermissionConfigs'].set(friendId, {
        tool_access: {
          memory: true,
          messaging: true,
          task: true,
          mcp_skill: false,
          file_io: false,
          browser: false,
          shell: false,
          remote_exec: false,
          desktop: false,
        },
        storage: null,
        memory_scopes: ['scope-delete'],
        updated_at: '2026-04-21T00:00:00.000Z',
      })

      const response = await makeWebRequest<{ deleted: true }>(
        TEST_WEB_PORT,
        `/api/friends/${friendId}`,
        'DELETE',
        null,
        token
      )

      expect(response.statusCode).toBe(200)
      expect(response.body.deleted).toBe(true)
      expect(admin['friendPermissionConfigs'].has(friendId)).toBe(false)
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

function getFriendPermissions(token: string, friendId: string) {
  return makeWebRequest<{
    config: FriendPermissionConfig | null
    resolved: {
      tool_access: FriendPermissionConfig['tool_access']
      storage: FriendPermissionConfig['storage']
      memory_scopes: string[]
    } | null
  }>(
    TEST_WEB_PORT,
    `/api/friends/${friendId}/permissions`,
    'GET',
    null,
    token
  )
}

function putFriendPermissions(
  token: string,
  friendId: string,
  config: Omit<FriendPermissionConfig, 'updated_at'>
) {
  return makeWebRequest<{ config: FriendPermissionConfig }>(
    TEST_WEB_PORT,
    `/api/friends/${friendId}/permissions`,
    'PUT',
    { config },
    token
  )
}

function makePrivateMessageRef(params: {
  channel_id: string
  session_id: string
  platform_user_id: string
  platform_display_name: string
  text: string
}): ChannelMessageRef {
  return {
    platform_message_id: `msg-${params.session_id}`,
    session: {
      session_id: params.session_id,
      channel_id: params.channel_id,
      type: 'private',
    },
    sender: {
      platform_user_id: params.platform_user_id,
      platform_display_name: params.platform_display_name,
    },
    content: {
      type: 'text',
      text: params.text,
    },
    features: {
      is_mention_crab: false,
    },
    platform_timestamp: '2026-04-19T00:00:00.000Z',
  }
}

function mockChannelSessionLookup(admin: AdminModule, session: {
  id: string
  channel_id: string
  type: 'private'
  platform_session_id: string
  title: string
  participants: Array<{ platform_user_id: string; role: 'owner' | 'admin' | 'member'; friend_id?: string }>
  created_at: string
  updated_at: string
}) {
  vi.spyOn(admin['rpcClient'], 'resolve').mockResolvedValue([
    {
      module_id: session.channel_id,
      module_type: 'channel',
      version: '0.1.0',
      port: 19999,
    },
  ] as any)

  vi.spyOn(admin['rpcClient'], 'call').mockImplementation(async (_port, method, params) => {
    if (method === 'get_session') {
      expect(params).toEqual({ session_id: session.id })
      return { session } as any
    }
    throw new Error(`Unexpected RPC method: ${String(method)}`)
  })
}
