/**
 * Admin 模块 Web API 测试
 */

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import http from 'node:http'
import fs from 'node:fs/promises'
import AdminModule from './index.js'
import type { ChannelMessageRef, DialogObjectApplication, Friend, FriendPermissionConfig, ListConversationUnitsResult, LoginResponse, Task } from './types.js'
import { AdminErrorCode, createCliAccessConfig } from './types.js'
import { newCredentialsFromPassword, writeCredentials } from './credentials.js'

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

    // 密码从 .env 迁到 credentials.json
    process.env.TEST_JWT_SECRET_WEB = 'test_jwt_secret_at_least_32_chars'
    await fs.mkdir(TEST_DATA_DIR, { recursive: true })
    const cred = await newCredentialsFromPassword('test_password_123', { is_temp: false, changed_via: 'start' })
    await writeCredentials(TEST_DATA_DIR, cred)

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

  describe('POST /api/memory/v2/graph/rebuild', () => {
    it('triggers a manager-native memory graph rebuild without a legacy pending task', async () => {
      const token = await loginAndGetToken()
      admin['agentPort'] = 19002
      const callSpy = vi.spyOn(admin['rpcClient'], 'call').mockResolvedValue({} as never)
      const response = await makeWebRequest<{ accepted: boolean }>(
        TEST_WEB_PORT, '/api/memory/v2/graph/rebuild', 'POST', {}, token,
      )
      expect(response.statusCode).toBe(200)
      expect(response.body.accepted).toBe(true)
      expect(callSpy).toHaveBeenCalledWith(19002, 'trigger_schedule', expect.objectContaining({
        schedule_id: 'memory-graph-rebuild', title: '重建长期记忆图谱', is_builtin: true,
        description: expect.stringContaining('memory-graph-linking'),
      }), expect.anything())
      expect([...admin['tasks'].values()].some((task) => task.tags.includes('memory_rebuild'))).toBe(false)
    })
  })

  describe('list_conversation_units activity ordering', () => {
    const taskIds = ['test-activity-old', 'test-activity-new']

    afterEach(() => {
      for (const id of taskIds) admin['tasks'].delete(id as never)
    })

    it('orders task rows by last activity instead of original creation time', async () => {
      vi.spyOn(admin as unknown as { callAgentRpc: (...args: unknown[]) => Promise<unknown> }, 'callAgentRpc')
        .mockResolvedValue({ traces: [], total: 0 })
      const revivedOldTask = makeTask({
        id: 'test-activity-old',
        title: '开卷考试策略 v2',
        created_at: '2026-07-01T16:15:15.921Z',
        updated_at: '2026-07-02T00:17:45.462Z',
        messages: [
          { id: 'm-old-1', role: 'human', content: '原始需求', timestamp: '2026-07-01T16:15:15.921Z' },
          { id: 'm-old-2', role: 'human', content: '那你现在还不赶紧去做？', timestamp: '2026-07-02T00:12:42.281Z' },
        ],
      })
      const newlyCreatedTask = makeTask({
        id: 'test-activity-new',
        title: '较新创建但没有后续活动',
        created_at: '2026-07-02T00:10:00.000Z',
        updated_at: '2026-07-02T00:10:00.000Z',
        messages: [
          { id: 'm-new-1', role: 'human', content: '新任务', timestamp: '2026-07-02T00:10:00.000Z' },
        ],
      })
      admin['tasks'].set(revivedOldTask.id as never, revivedOldTask)
      admin['tasks'].set(newlyCreatedTask.id as never, newlyCreatedTask)

      const result = await admin['handleListConversationUnits']({
        page: 1,
        page_size: 10,
        filter: { trigger_type: 'task' },
      }) as ListConversationUnitsResult

      const ids = result.items
        .filter((u): u is Extract<typeof u, { kind: 'task' }> => u.kind === 'task')
        .map((u) => u.task.id)
      expect(ids.indexOf('test-activity-old')).toBeLessThan(ids.indexOf('test-activity-new'))
    })

    it('uses related dispatcher activity even when listing task-only rows', async () => {
      const oldTask = makeTask({
        id: 'test-activity-old',
        title: '旧标题',
        created_at: '2026-07-01T16:15:15.921Z',
        updated_at: '2026-07-01T16:15:15.921Z',
        messages: [
          { id: 'm-old-1', role: 'human', content: '原始需求', timestamp: '2026-07-01T16:15:15.921Z' },
        ],
      })
      const newTask = makeTask({
        id: 'test-activity-new',
        title: '较新创建但没有后续活动',
        created_at: '2026-07-02T00:10:00.000Z',
        updated_at: '2026-07-02T00:10:00.000Z',
        messages: [
          { id: 'm-new-1', role: 'human', content: '新任务', timestamp: '2026-07-02T00:10:00.000Z' },
        ],
      })
      admin['tasks'].set(oldTask.id as never, oldTask)
      admin['tasks'].set(newTask.id as never, newTask)
      vi.spyOn(admin as unknown as { callAgentRpc: (...args: unknown[]) => Promise<unknown> }, 'callAgentRpc')
        .mockResolvedValue({
          traces: [
            {
              trace_id: 'trace-related',
              trigger_type: 'message',
              trigger_summary: '那你现在还不赶紧去做？',
              started_at: '2026-07-02T00:12:42.281Z',
              status: 'completed',
              span_count: 1,
              related_task_id: 'test-activity-old',
            },
          ],
          total: 1,
        })

      const result = await admin['handleListConversationUnits']({
        page: 1,
        page_size: 10,
        filter: { trigger_type: 'task' },
      }) as ListConversationUnitsResult

      const taskUnits = result.items.filter((u): u is Extract<typeof u, { kind: 'task' }> => u.kind === 'task')
      const oldUnit = taskUnits.find((u) => u.task.id === 'test-activity-old')
      expect(oldUnit?.activity_at).toBe('2026-07-02T00:12:42.281Z')
      expect(oldUnit?.activity_summary).toBe('那你现在还不赶紧去做？')
      expect(taskUnits.findIndex((u) => u.task.id === 'test-activity-old'))
        .toBeLessThan(taskUnits.findIndex((u) => u.task.id === 'test-activity-new'))
    })

    it('filters orphan dispatcher traces by the search keyword', async () => {
      const callAgentRpc = vi.spyOn(admin as unknown as { callAgentRpc: (...args: unknown[]) => Promise<unknown> }, 'callAgentRpc')
        .mockResolvedValue({
          traces: [
            {
              trace_id: 'trace-match',
              trigger_type: 'message',
              trigger_summary: '[private×1] needle message',
              started_at: '2026-07-02T00:12:37.518Z',
              status: 'completed',
              span_count: 1,
            },
            {
              trace_id: 'trace-unrelated',
              trigger_type: 'message',
              trigger_summary: '[group×1] unrelated chatter',
              started_at: '2026-07-02T00:13:37.518Z',
              status: 'completed',
              span_count: 1,
            },
          ],
          total: 2,
        })

      const result = await admin['handleListConversationUnits']({
        page: 1,
        page_size: 10,
        filter: { trigger_type: 'message', search: 'needle' },
      }) as ListConversationUnitsResult

      expect(callAgentRpc).toHaveBeenCalledWith(
        'search_traces',
        expect.objectContaining({ keyword: 'needle' }),
      )
      expect(result.items).toHaveLength(1)
      expect(result.items[0]).toMatchObject({
        kind: 'orphan_dispatcher',
        trace: { trace_id: 'trace-match' },
      })
    })
  })

  describe('POST /api/memory/v2/graph/data', () => {
    it('透传 get_memory_graph 返回图谱数据', async () => {
      const token = await loginAndGetToken()
      vi.spyOn(admin['rpcClient'], 'resolve').mockResolvedValue([
        { module_id: 'memory-test', module_type: 'memory', version: '0.1.0', port: 19001 },
      ] as any)
      const fakeGraph = { nodes: [{ id: 'mem-l-a', kind: 'memory' }], edges: [], stats: { node_count: 1, edge_count: 0 } }
      vi.spyOn(admin['rpcClient'], 'call').mockImplementation(async (_port, method) => {
        if (method === 'get_memory_graph') return fakeGraph as any
        return {} as any
      })
      const res = await makeWebRequest<typeof fakeGraph>(TEST_WEB_PORT, '/api/memory/v2/graph/data', 'POST', {}, token)
      expect(res.statusCode).toBe(200)
      expect(res.body.stats.node_count).toBe(1)
      expect(res.body.nodes[0].id).toBe('mem-l-a')
    })
  })

  describe('PATCH /api/scene-profiles/:key', () => {
    it('trims label/content and preserves existing label when blank value is submitted', async () => {
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
              content: '现有描述',
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
            content: '新描述',
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
          content: '  新描述  ',
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
          expect(params).toEqual({ scene: { type: 'friend', friend_id: 'friend-empty' } })
          return { profile: null } as any
        }
        throw new Error(`Unexpected RPC method: ${String(method)}`)
      })

      const response = await makeWebRequest<{ error: string }>(
        TEST_WEB_PORT,
        '/api/scene-profiles/friend%3Afriend-empty',
        'PATCH',
        {
          label: 'Friend Empty',
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
              content: '现有描述',
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
        cli_access: createCliAccessConfig('none'),
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
        cli_access: createCliAccessConfig('write'),
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
        cli_access: createCliAccessConfig('none'),
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
        cli_access: createCliAccessConfig('none'),
        storage: null,
        memory_scopes: [],
      })
    })

    it('should return 404 for an unknown friend when reading permissions', async () => {
      const token = await loginAndGetToken()

      const response = await getFriendPermissions(token, 'missing-friend-read-test')

      expect(response.statusCode).toBe(404)
      expect((response.body as unknown as { error: string }).error).toBe('Friend not found')
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
        cli_access: createCliAccessConfig('none'),
        storage: null,
        memory_scopes: [],
      })

      expect(response.statusCode).toBe(404)
      expect((response.body as unknown as { error: string }).error).toBe('Friend not found')
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
        cli_access: createCliAccessConfig('write'),
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
        cli_access: createCliAccessConfig('none'),
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
        cli_access: createCliAccessConfig('none'),
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
        cli_access: createCliAccessConfig('none'),
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
        cli_access: createCliAccessConfig('none'),
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

  describe('resolve_principal_permissions REST', () => {
    it('master friend → 全 write 短路', async () => {
      const token = await loginAndGetToken()
      const friendId = 'master-resolve-test'
      admin['friends'].set(friendId, {
        id: friendId,
        display_name: 'Master Resolve',
        permission: 'master',
        channel_identities: [],
        created_at: '2026-04-21T00:00:00.000Z',
        updated_at: '2026-04-21T00:00:00.000Z',
      })

      const response = await makeWebRequest<{ resolved: { cli_access: Record<string, string> }, sources: { friend_template_id?: string } }>(
        TEST_WEB_PORT,
        `/api/permissions/resolve-principal`,
        'POST',
        { sender_friend_id: friendId, session_id: 'any-session', session_type: 'group' },
        token,
      )
      expect(response.statusCode).toBe(200)
      expect(response.body.resolved.cli_access.provider).toBe('write')
      expect(response.body.resolved.cli_access.schedule).toBe('write')
      expect(response.body.sources.friend_template_id).toBe('master_private')
    })

    it('无 friend，session 挂 group_scheduler → schedule=write', async () => {
      const token = await loginAndGetToken()
      const sessionId = 'group-scheduler-session-test'
      admin['sessionConfigs'].set(sessionId, {
        template_id: 'group_scheduler',
        updated_at: '2026-04-21T00:00:00.000Z',
      })

      const response = await makeWebRequest<{ resolved: { cli_access: Record<string, string> }, sources: { session_template_id?: string } }>(
        TEST_WEB_PORT,
        `/api/permissions/resolve-principal`,
        'POST',
        { session_id: sessionId, session_type: 'group' },
        token,
      )
      expect(response.statusCode).toBe(200)
      expect(response.body.resolved.cli_access.schedule).toBe('write')
      expect(response.body.resolved.cli_access.provider).toBe('none')
      expect(response.body.sources.session_template_id).toBe('group_scheduler')
    })

    it('friend(standard) ∪ session(group_scheduler) → 并集中 schedule=write', async () => {
      const token = await loginAndGetToken()
      const friendId = 'normal-union-test'
      const sessionId = 'union-session-test'
      admin['friends'].set(friendId, {
        id: friendId,
        display_name: 'Normal Union',
        permission: 'normal',
        permission_template_id: 'standard',
        channel_identities: [],
        created_at: '2026-04-21T00:00:00.000Z',
        updated_at: '2026-04-21T00:00:00.000Z',
      })
      admin['sessionConfigs'].set(sessionId, {
        template_id: 'group_scheduler',
        updated_at: '2026-04-21T00:00:00.000Z',
      })

      const response = await makeWebRequest<{ resolved: { cli_access: Record<string, string>, tool_access: Record<string, boolean> }, sources: { friend_template_id?: string, session_template_id?: string } }>(
        TEST_WEB_PORT,
        `/api/permissions/resolve-principal`,
        'POST',
        { sender_friend_id: friendId, session_id: sessionId, session_type: 'group' },
        token,
      )
      expect(response.statusCode).toBe(200)
      expect(response.body.resolved.cli_access.schedule).toBe('write')
      expect(response.body.resolved.tool_access.task).toBe(true)
      expect(response.body.resolved.cli_access.provider).toBe('none')
      expect(response.body.sources.friend_template_id).toBe('standard')
      expect(response.body.sources.session_template_id).toBe('group_scheduler')
    })

    it('无 friend 无 session_config → minimal 兜底', async () => {
      const token = await loginAndGetToken()
      const response = await makeWebRequest<{ resolved: { cli_access: Record<string, string>, tool_access: Record<string, boolean> }, sources: { fallback?: string } }>(
        TEST_WEB_PORT,
        `/api/permissions/resolve-principal`,
        'POST',
        { session_id: 'totally-unknown-session', session_type: 'private' },
        token,
      )
      expect(response.statusCode).toBe(200)
      expect(response.body.resolved.tool_access.messaging).toBe(true)
      expect(response.body.resolved.tool_access.shell).toBe(false)
      expect(response.body.resolved.cli_access.provider).toBe('none')
      expect(response.body.sources.fallback).toBe('minimal')
    })

    it('群聊 无 friend 无 session_config → group_default 兜底（非 friend 发言人按群聊默认权限）', async () => {
      const token = await loginAndGetToken()
      const response = await makeWebRequest<{ resolved: { tool_access: Record<string, boolean> }, sources: { session_template_id?: string, fallback?: string } }>(
        TEST_WEB_PORT,
        `/api/permissions/resolve-principal`,
        'POST',
        { session_id: 'group-stranger-no-config-session', session_type: 'group' },
        token,
      )
      expect(response.statusCode).toBe(200)
      // group_default：除 desktop 外全部 true
      expect(response.body.resolved.tool_access.messaging).toBe(true)
      expect(response.body.resolved.tool_access.shell).toBe(true)
      expect(response.body.resolved.tool_access.task).toBe(true)
      expect(response.body.resolved.tool_access.desktop).toBe(false)
      expect(response.body.sources.session_template_id).toBe('group_default')
      expect(response.body.sources.fallback).toBeUndefined()
    })

    it('群聊 无 friend，sessionConfig 缺 template_id 但带 tool_access 覆盖 → 快照式（脱离模板）', async () => {
      const token = await loginAndGetToken()
      const sessionId = 'group-legacy-session-no-template'
      // 快照式语义：sessionConfig.tool_access 存在即完全脱离模板，缺省字段默认 false
      admin['sessionConfigs'].set(sessionId, {
        tool_access: { shell: false } as Partial<{ shell: boolean }>,
        updated_at: '2026-04-21T00:00:00.000Z',
      } as never)

      const response = await makeWebRequest<{ resolved: { tool_access: Record<string, boolean> }, sources: { session_template_id?: string } }>(
        TEST_WEB_PORT,
        `/api/permissions/resolve-principal`,
        'POST',
        { session_id: sessionId, session_type: 'group' },
        token,
      )
      expect(response.statusCode).toBe(200)
      expect(response.body.resolved.tool_access.shell).toBe(false)         // session 显式设置
      expect(response.body.resolved.tool_access.messaging).toBe(false)     // 快照式：不从模板继承
      expect(response.body.resolved.tool_access.task).toBe(false)          // 快照式：不从模板继承
      expect(response.body.resolved.tool_access.desktop).toBe(false)
      expect(response.body.sources.session_template_id).toBe('group_default')
    })
  })

  // ==========================================================================
  // 既有 /api/agent/* 转发端点的特征化测试（P5 Task 5 第一步）
  //
  // 这四个 handler 各自重复同一段 503/500 样板，本组用例在抽 proxyAgentRpc **之前**
  // 就写下它们当前的行为（method / params / 状态码 / body），抽完之后必须逐条照旧通过——
  // 这是"纯重构、行为一字不变"的证据，而不是靠肉眼比对。
  // ==========================================================================
  describe('既有 /api/agent/* 转发端点（重构护栏）', () => {
    const spyAgentRpc = () =>
      vi.spyOn(
        admin as unknown as { callAgentRpc: (...args: unknown[]) => Promise<unknown> },
        'callAgentRpc',
      )

    it('GET /api/agent/traces 转发 get_traces（默认 limit/offset，status 缺省为 undefined）', async () => {
      const token = await loginAndGetToken()
      const spy = spyAgentRpc().mockResolvedValue({ traces: [], total: 0 })

      const response = await makeWebRequest(TEST_WEB_PORT, '/api/agent/traces', 'GET', null, token)

      expect(response.statusCode).toBe(200)
      expect(spy).toHaveBeenCalledWith('get_traces', { limit: 20, offset: 0, status: undefined })
    })

    it('GET /api/agent/traces 透传 limit/offset/status', async () => {
      const token = await loginAndGetToken()
      const spy = spyAgentRpc().mockResolvedValue({ traces: [], total: 0 })

      await makeWebRequest(TEST_WEB_PORT, '/api/agent/traces?limit=5&offset=10&status=completed', 'GET', null, token)

      expect(spy).toHaveBeenCalledWith('get_traces', { limit: 5, offset: 10, status: 'completed' })
    })

    it('GET /api/agent/traces：agent 不可达 → 503 + 固定文案', async () => {
      const token = await loginAndGetToken()
      spyAgentRpc().mockRejectedValue(new Error('Agent not available'))

      const response = await makeWebRequest<{ error: string }>(TEST_WEB_PORT, '/api/agent/traces', 'GET', null, token)

      expect(response.statusCode).toBe(503)
      expect(response.body.error).toBe('Agent not available')
    })

    it('GET /api/agent/traces：其他错误 → 500 + 原始 message', async () => {
      const token = await loginAndGetToken()
      spyAgentRpc().mockRejectedValue(new Error('boom'))

      const response = await makeWebRequest<{ error: string }>(TEST_WEB_PORT, '/api/agent/traces', 'GET', null, token)

      expect(response.statusCode).toBe(500)
      expect(response.body.error).toBe('boom')
    })

    it('GET /api/agent/traces/:traceId 转发 get_trace', async () => {
      const token = await loginAndGetToken()
      const spy = spyAgentRpc().mockResolvedValue({ trace: { trace_id: 't-1' } })

      const response = await makeWebRequest(TEST_WEB_PORT, '/api/agent/traces/t-1', 'GET', null, token)

      expect(response.statusCode).toBe(200)
      expect(spy).toHaveBeenCalledWith('get_trace', { trace_id: 't-1' })
    })

    it('GET /api/agent/traces/:traceId：not found → 404 + 原始 message（该端点独有分支）', async () => {
      const token = await loginAndGetToken()
      spyAgentRpc().mockRejectedValue(new Error('Trace not found: t-404'))

      const response = await makeWebRequest<{ error: string }>(TEST_WEB_PORT, '/api/agent/traces/t-404', 'GET', null, token)

      expect(response.statusCode).toBe(404)
      expect(response.body.error).toBe('Trace not found: t-404')
    })

    it('GET /api/agent/traces/:traceId：ECONNREFUSED → 503', async () => {
      const token = await loginAndGetToken()
      spyAgentRpc().mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:19000'))

      const response = await makeWebRequest<{ error: string }>(TEST_WEB_PORT, '/api/agent/traces/t-1', 'GET', null, token)

      expect(response.statusCode).toBe(503)
      expect(response.body.error).toBe('Agent not available')
    })

    it('DELETE /api/agent/traces 转发 clear_traces（带 body / 空 body）', async () => {
      const token = await loginAndGetToken()
      const spy = spyAgentRpc().mockResolvedValue({ cleared_count: 3 })

      const withBody = await makeWebRequest(
        TEST_WEB_PORT,
        '/api/agent/traces',
        'DELETE',
        { before: '2026-01-01T00:00:00.000Z' },
        token,
      )
      expect(withBody.statusCode).toBe(200)
      expect(spy).toHaveBeenCalledWith('clear_traces', { before: '2026-01-01T00:00:00.000Z' })

      await makeWebRequest(TEST_WEB_PORT, '/api/agent/traces', 'DELETE', null, token)
      expect(spy).toHaveBeenLastCalledWith('clear_traces', {})
    })

    it('DELETE /api/agent/traces：agent 不可达 → 503', async () => {
      const token = await loginAndGetToken()
      spyAgentRpc().mockRejectedValue(new Error('connect failed'))

      const response = await makeWebRequest<{ error: string }>(TEST_WEB_PORT, '/api/agent/traces', 'DELETE', null, token)

      expect(response.statusCode).toBe(503)
      expect(response.body.error).toBe('Agent not available')
    })

    it('GET /api/agent/traces/search 转发 search_traces（time_range 需 start+end 同时存在）', async () => {
      const token = await loginAndGetToken()
      const spy = spyAgentRpc().mockResolvedValue({ traces: [], total: 0 })

      await makeWebRequest(
        TEST_WEB_PORT,
        '/api/agent/traces/search?task_id=task-1&keyword=needle&status=completed&start=2026-01-01&end=2026-02-01&limit=3&offset=1',
        'GET',
        null,
        token,
      )
      expect(spy).toHaveBeenCalledWith('search_traces', {
        task_id: 'task-1',
        keyword: 'needle',
        status: 'completed',
        time_range: { start: '2026-01-01', end: '2026-02-01' },
        limit: 3,
        offset: 1,
      })

      await makeWebRequest(TEST_WEB_PORT, '/api/agent/traces/search?start=2026-01-01', 'GET', null, token)
      expect(spy).toHaveBeenLastCalledWith('search_traces', { limit: 20, offset: 0 })
    })

    it('GET /api/agent/traces/search：agent 不可达 → 503', async () => {
      const token = await loginAndGetToken()
      spyAgentRpc().mockRejectedValue(new Error('Agent not available'))

      const response = await makeWebRequest<{ error: string }>(
        TEST_WEB_PORT,
        '/api/agent/traces/search',
        'GET',
        null,
        token,
      )

      expect(response.statusCode).toBe(503)
      expect(response.body.error).toBe('Agent not available')
    })
  })

  // ==========================================================================
  // Worker 只读 REST 代理（protocol-agent-v3 §10.3 / §8.3，P5 Task 5 第二步）
  //
  // 本阶段生产链路无人调用这四个端点（web 切换在 P6、cutover 在 P7），所以用例只钉两件事：
  // 鉴权走既有 /api/* 中间件、query → RPC 参数按 §8.3 逐字段映射。
  // **不写**"worker 失败 → 返回 failed"这类断言：台账 status 目前被 P7 阻塞项 #1 污染。
  // ==========================================================================
  describe('GET /api/agent/workers*（§10.3 只读代理）', () => {
    const spyAgentRpc = () =>
      vi.spyOn(
        admin as unknown as { callAgentRpc: (...args: unknown[]) => Promise<unknown> },
        'callAgentRpc',
      )

    it.each([
      '/api/agent/workers',
      '/api/agent/workers/w-1',
      '/api/agent/workers/w-1/output',
      '/api/agent/workers/w-1/trace',
    ])('%s 未带 token → 401', async (path) => {
      const response = await makeWebRequest(TEST_WEB_PORT, path, 'GET', null, null)
      expect(response.statusCode).toBe(401)
    })

    it('GET /api/agent/workers 无 query → list_workers_admin 只带默认分页', async () => {
      const token = await loginAndGetToken()
      const spy = spyAgentRpc().mockResolvedValue({
        items: [],
        pagination: { page: 1, page_size: 20, total_items: 0, total_pages: 0 },
      })

      const response = await makeWebRequest(TEST_WEB_PORT, '/api/agent/workers', 'GET', null, token)

      expect(response.statusCode).toBe(200)
      expect(spy).toHaveBeenCalledWith('list_workers_admin', { pagination: { page: 1, page_size: 20 } })
    })

    it('GET /api/agent/workers 全量 query → 逐字段映射（status 重复出现即数组）', async () => {
      const token = await loginAndGetToken()
      const spy = spyAgentRpc().mockResolvedValue({
        items: [],
        pagination: { page: 2, page_size: 5, total_items: 0, total_pages: 0 },
      })

      await makeWebRequest(
        TEST_WEB_PORT,
        '/api/agent/workers?status=executing&status=waiting&dialog_object_id=telegram-001%3Aprivate-42'
          + '&start=2026-07-01T00%3A00%3A00.000Z&end=2026-07-31T00%3A00%3A00.000Z&page=2&page_size=5',
        'GET',
        null,
        token,
      )

      expect(spy).toHaveBeenCalledWith('list_workers_admin', {
        status: ['executing', 'waiting'],
        dialog_object_id: 'telegram-001:private-42',
        time_range: { start: '2026-07-01T00:00:00.000Z', end: '2026-07-31T00:00:00.000Z' },
        pagination: { page: 2, page_size: 5 },
      })
    })

    it('GET /api/agent/workers 单个 status → 单值而非数组（§8.3 是联合类型）', async () => {
      const token = await loginAndGetToken()
      const spy = spyAgentRpc().mockResolvedValue({
        items: [],
        pagination: { page: 1, page_size: 20, total_items: 0, total_pages: 0 },
      })

      await makeWebRequest(TEST_WEB_PORT, '/api/agent/workers?status=completed', 'GET', null, token)

      expect(spy).toHaveBeenCalledWith('list_workers_admin', {
        status: 'completed',
        pagination: { page: 1, page_size: 20 },
      })
    })

    it('GET /api/agent/workers 只给 start → time_range 只带 start（TimeRange 两端各自可选）', async () => {
      const token = await loginAndGetToken()
      const spy = spyAgentRpc().mockResolvedValue({
        items: [],
        pagination: { page: 1, page_size: 20, total_items: 0, total_pages: 0 },
      })

      await makeWebRequest(TEST_WEB_PORT, '/api/agent/workers?start=2026-07-01T00%3A00%3A00.000Z', 'GET', null, token)

      expect(spy).toHaveBeenCalledWith('list_workers_admin', {
        time_range: { start: '2026-07-01T00:00:00.000Z' },
        pagination: { page: 1, page_size: 20 },
      })
    })

    it('GET /api/agent/workers 脏分页参数 → 回落默认值', async () => {
      const token = await loginAndGetToken()
      const spy = spyAgentRpc().mockResolvedValue({
        items: [],
        pagination: { page: 1, page_size: 20, total_items: 0, total_pages: 0 },
      })

      await makeWebRequest(TEST_WEB_PORT, '/api/agent/workers?page=abc&page_size=', 'GET', null, token)

      expect(spy).toHaveBeenCalledWith('list_workers_admin', { pagination: { page: 1, page_size: 20 } })
    })

    it('GET /api/agent/workers：agent 不可达 → 503', async () => {
      const token = await loginAndGetToken()
      spyAgentRpc().mockRejectedValue(new Error('Agent not available'))

      const response = await makeWebRequest<{ error: string }>(TEST_WEB_PORT, '/api/agent/workers', 'GET', null, token)

      expect(response.statusCode).toBe(503)
      expect(response.body.error).toBe('Agent not available')
    })

    it('GET /api/agent/workers/:id → get_worker_detail', async () => {
      const token = await loginAndGetToken()
      const spy = spyAgentRpc().mockResolvedValue({ worker: { worker_id: 'w-1' } })

      const response = await makeWebRequest<{ worker: { worker_id: string } }>(
        TEST_WEB_PORT,
        '/api/agent/workers/w-1',
        'GET',
        null,
        token,
      )

      expect(response.statusCode).toBe(200)
      expect(response.body.worker.worker_id).toBe('w-1')
      expect(spy).toHaveBeenCalledWith('get_worker_detail', { worker_id: 'w-1' })
    })

    /**
     * 三个按 worker_id 读的端点对**同一个**不存在的 id 必须给同一个状态码——P6 前端要靠状态码
     * 区分"worker 不存在"与"agent 侧真错"。
     *
     * agent 侧两条路径的文案大小写**不一致**（下表 message 列逐字取自 agent 源码）：
     * detail/trace 由 `unified-agent.ts` 的 handler 显式抛（大写 W），output 由
     * `harness.ts` 的 `WorkerNotFoundError` 抛（小写 w）。修复前 output 端点匹配不上
     * `'Worker not found'` → 落 500。故三处共用同一个大小写无关的谓词。
     */
    it.each([
      ['/api/agent/workers/w-404', 'Worker not found: w-404'],
      ['/api/agent/workers/w-404/trace', 'Worker not found: w-404'],
      ['/api/agent/workers/w-404/output', 'worker not found: w-404'],
    ])('GET %s：worker 不存在 → 404（agent 侧文案 %s）', async (path, agentMessage) => {
      const token = await loginAndGetToken()
      spyAgentRpc().mockRejectedValue(new Error(agentMessage))

      const response = await makeWebRequest<{ error: string }>(TEST_WEB_PORT, path, 'GET', null, token)

      expect(response.statusCode).toBe(404)
      expect(response.body.error).toBe(agentMessage)
    })

    /**
     * 谓词只认"worker 不存在"，agent 侧其它真错仍是 500——否则前端会把"这个化身不存在"
     * 或"这个 agent build 还没有这个方法"当成"这个 worker 不存在"。三条 message 都逐字取自
     * 源码：前两条来自 `harness.readWorkerOutput` / `handleGetWorkerTrace` 的 seq 校验，
     * 第三条来自 crabot-core 的 JSON-RPC 分发（未注册方法，滚动升级期真实可达；由
     * `reject(new Error(response.error.message))` 原样送到这里）。
     * 它们都含 "not found" 却不含 "worker not found"——谓词故意不放宽到前者。
     */
    it.each([
      ['/api/agent/workers/w-1/output?seq=9', 'WorkerHarness.readWorkerOutput: no incarnation with seq=9 found for worker w-1'],
      ['/api/agent/workers/w-1/trace?seq=9', 'get_worker_trace: no incarnation with seq=9 found for worker w-1'],
      ['/api/agent/workers/w-1/output', 'Method "read_worker_output_admin" not found'],
    ])('GET %s：不是 worker 不存在 → 500', async (path, agentMessage) => {
      const token = await loginAndGetToken()
      spyAgentRpc().mockRejectedValue(new Error(agentMessage))

      const response = await makeWebRequest<{ error: string }>(TEST_WEB_PORT, path, 'GET', null, token)

      expect(response.statusCode).toBe(500)
      expect(response.body.error).toBe(agentMessage)
    })

    /**
     * `?seq=` 缺省时**不下发该字段**（与 cursor 同一纪律）：化身 seq 从 1 起编号，admin 侧
     * 任何硬编码缺省都是错的——0 在台账里恒不存在（agent 侧 findIncarnationBySeq 抛错 → 500），
     * 1 则锁死在最早那个化身上（worker 经 revive/handoff 后主线早已不是它）。唯一正确的缺省
     * 是"主线化身"，只有持台账的 agent 侧算得出来。
     *
     * 这两条只钉住"admin 转发的载荷长什么样"；"这个载荷打到真实 agent 上确实读到主线化身"
     * 由 crabot-agent `tests/manager/p5-integration.test.ts` 经真实 RPC + 真实台账验证。
     */
    it('GET /api/agent/workers/:id/output → read_worker_output_admin（seq 缺省不下发，由 agent 取主线化身）', async () => {
      const token = await loginAndGetToken()
      const spy = spyAgentRpc().mockResolvedValue({ chunk: 'hello', next_cursor: '133', eof: false })

      const response = await makeWebRequest(
        TEST_WEB_PORT,
        '/api/agent/workers/w-1/output?seq=2&cursor=128',
        'GET',
        null,
        token,
      )
      expect(response.statusCode).toBe(200)
      expect(spy).toHaveBeenCalledWith('read_worker_output_admin', { worker_id: 'w-1', seq: 2, cursor: '128' })

      await makeWebRequest(TEST_WEB_PORT, '/api/agent/workers/w-1/output', 'GET', null, token)
      expect(spy).toHaveBeenLastCalledWith('read_worker_output_admin', { worker_id: 'w-1' })
      // toHaveBeenCalledWith 把 `{ seq: undefined }` 视同缺席，这里显式钉住 key 真的不在载荷里。
      expect('seq' in (spy.mock.lastCall![1] as object)).toBe(false)

      // 脏值同样不下发（不回落成某个具体化身），与 list 端点"脏分页 → 回落默认值"的区别在于
      // seq 根本没有安全的默认值可回落。
      await makeWebRequest(TEST_WEB_PORT, '/api/agent/workers/w-1/output?seq=abc', 'GET', null, token)
      expect(spy).toHaveBeenLastCalledWith('read_worker_output_admin', { worker_id: 'w-1' })
    })

    it('GET /api/agent/workers/:id/trace → get_worker_trace（seq 缺省不下发，由 agent 取主线化身）', async () => {
      const token = await loginAndGetToken()
      const spy = spyAgentRpc().mockResolvedValue({ events: [], next_cursor: '0' })

      const response = await makeWebRequest(
        TEST_WEB_PORT,
        '/api/agent/workers/w-1/trace?seq=1&cursor=3',
        'GET',
        null,
        token,
      )
      expect(response.statusCode).toBe(200)
      expect(spy).toHaveBeenCalledWith('get_worker_trace', { worker_id: 'w-1', seq: 1, cursor: '3' })

      await makeWebRequest(TEST_WEB_PORT, '/api/agent/workers/w-1/trace', 'GET', null, token)
      expect(spy).toHaveBeenLastCalledWith('get_worker_trace', { worker_id: 'w-1' })
      expect('seq' in (spy.mock.lastCall![1] as object)).toBe(false)
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

function makeTask(overrides: Partial<Task> & Pick<Task, 'id' | 'title' | 'created_at' | 'updated_at'>): Task {
  return {
    id: overrides.id,
    status: overrides.status ?? 'completed',
    priority: overrides.priority ?? 'normal',
    title: overrides.title,
    source: overrides.source ?? { origin: 'human', channel_id: 'telegram-001', session_id: 'session-1', trigger_type: 'message' },
    messages: overrides.messages ?? [],
    tags: overrides.tags ?? [],
    created_at: overrides.created_at,
    updated_at: overrides.updated_at,
    ...(overrides.completed_at ? { completed_at: overrides.completed_at } : {}),
    ...(overrides.result ? { result: overrides.result } : {}),
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
