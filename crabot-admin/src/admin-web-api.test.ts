/**
 * Admin 模块 Web API 测试
 */

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import http from 'node:http'
import { WebSocket } from 'ws'
import { sha256CanonicalJson } from 'crabot-shared'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import AdminModule from './index.js'
import { UnifiedAgent } from '../../crabot-agent/src/unified-agent.js'
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

  describe('Admin Chat assertion transport boundaries', () => {
    afterEach(async () => {
      vi.restoreAllMocks()
      await (admin as unknown as { chatManager: { clearMessages(): Promise<void> } }).chatManager.clearMessages()
    })

    function captureProcessMessage() {
      ;(admin as unknown as { agentPort: number }).agentPort = 19999
      return vi.spyOn(
        (admin as unknown as { rpcClient: { callSensitive: (...args: unknown[]) => Promise<unknown> } }).rpcClient,
        'callSensitive',
      ).mockImplementation(async (_port, method) => {
        if (method === 'process_message') return { decision_types: [] }
        throw new Error(`unexpected RPC: ${String(method)}`)
      })
    }

    async function consumeThroughAgent(payload: Record<string, any>): Promise<void> {
      const processAdminChatMessage = vi.fn(async () => ({ decision_types: [] }))
      const agent = Object.create(UnifiedAgent.prototype) as unknown as {
        config: { moduleId: string }
        rpcClient: {
          resolve(filter: unknown): Promise<Array<{ module_id: string; port: number }>>
          callSensitive(port: number, method: string, params: unknown): Promise<unknown>
        }
        processAdminChatMessage: typeof processAdminChatMessage
        managerStack: { principals: { activateAdminChat(key: string, input: unknown): Promise<void> } }
        handleProcessMessage(params: Record<string, unknown>): Promise<unknown>
      }
      agent.config = { moduleId: 'crabot-agent' }
      agent.processAdminChatMessage = processAdminChatMessage
      agent.managerStack = { principals: { activateAdminChat: async () => {} } }
      // P6-A：入站 admission 落到临时目录，不碰真实 Agent 数据目录
      const { AdminChatCorrelationStore } = await import('../../crabot-agent/src/manager/chat-correlation-store.js')
      const correlationDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-correlation-'))
      ;(agent as unknown as Record<string, unknown>).adminChatCorrelationStoreInstance = new AdminChatCorrelationStore(correlationDir)
      agent.rpcClient = {
        resolve: async (filter) => {
          expect(filter).toEqual({ module_id: 'admin-web' })
          return [{ module_id: 'admin-web', port: TEST_PROTOCOL_PORT }]
        },
        callSensitive: async (port, method, params) => {
          expect(port).toBe(TEST_PROTOCOL_PORT)
          expect(method).toBe('consume_admin_chat_assertion')
          return (admin as unknown as {
            handleConsumeAdminChatAssertion(input: unknown): Promise<unknown>
          }).handleConsumeAdminChatAssertion(params)
        },
      }

      await expect(agent.handleProcessMessage(payload)).resolves.toEqual({ decision_types: [] })
      expect(processAdminChatMessage).toHaveBeenCalledTimes(1)
      await expect(agent.handleProcessMessage(payload)).rejects.toThrow(/consumed/)
      expect(processAdminChatMessage).toHaveBeenCalledTimes(1)
    }

    function assertCommonAdminChatPayload(payload: Record<string, any>, requestId: string, text: string): void {
      expect(Object.keys(payload).sort()).toEqual([
        'admin_chat_assertion', 'callback_info', 'message', 'source_type',
      ])
      expect(payload).toMatchObject({
        source_type: 'admin_chat',
        callback_info: { source_module_id: 'admin-web', request_id: requestId },
        message: {
          session: { channel_id: 'admin-web', session_id: 'admin-chat', type: 'private' },
          sender: { friend_id: 'master', platform_user_id: 'master' },
          content: { type: 'text', text },
        },
      })
      expect(Object.keys(payload.message).sort()).toEqual([
        'content', 'features', 'platform_message_id', 'platform_timestamp', 'sender', 'session',
      ])
      expect(typeof payload.admin_chat_assertion).toBe('string')
      expect(sha256CanonicalJson(payload.message)).toMatch(/^[a-f0-9]{64}$/)
    }

    function processPayload(call: unknown[] | undefined): Record<string, any> {
      expect(call?.[1]).toBe('process_message')
      return call?.[2] as Record<string, any>
    }

    async function waitForCall(spy: ReturnType<typeof vi.spyOn>): Promise<unknown[]> {
      const deadline = Date.now() + 2_000
      while (Date.now() < deadline) {
        const call = spy.mock.calls.find(entry => entry[1] === 'process_message')
        if (call) return call
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      throw new Error('timed out waiting for process_message')
    }

    async function rejectedWebSocket(url: string): Promise<number | undefined> {
      return new Promise((resolve, reject) => {
        const socket = new WebSocket(url)
        socket.once('unexpected-response', (_request, response) => {
          response.resume()
          resolve(response.statusCode)
        })
        socket.once('open', () => reject(new Error('websocket unexpectedly opened')))
        socket.once('error', error => {
          // `ws` normally emits this after unexpected-response; wait for the HTTP status.
          if (!socket.readyState || socket.readyState === WebSocket.CLOSED) return
          reject(error)
        })
      })
    }

    it('multipart Admin Chat requires JWT and creates a one-time assertion bound to the final Agent message', async () => {
      const body = new FormData()
      body.set('request_id', 'multipart-assertion-1')
      body.set('text', '来自 multipart 的消息')
      const unauthenticated = await fetch(`http://localhost:${TEST_WEB_PORT}/api/chat/messages`, {
        method: 'POST', body,
      })
      expect(unauthenticated.status).toBe(401)

      const token = await loginAndGetToken()
      const spy = captureProcessMessage()
      const authenticatedBody = new FormData()
      authenticatedBody.set('request_id', 'multipart-assertion-2')
      authenticatedBody.set('text', '来自 multipart 的消息')
      const response = await fetch(`http://localhost:${TEST_WEB_PORT}/api/chat/messages`, {
        method: 'POST', body: authenticatedBody, headers: { Authorization: `Bearer ${token}` },
      })
      expect(response.status).toBe(200)

      const payload = processPayload(await waitForCall(spy))
      assertCommonAdminChatPayload(payload, 'multipart-assertion-2', '来自 multipart 的消息')
      await consumeThroughAgent(payload)
    })

    it('WebSocket rejects missing/invalid JWT and emits the same Admin Chat assertion payload after valid JWT', async () => {
      expect(await rejectedWebSocket(`ws://localhost:${TEST_WEB_PORT}/ws/chat`)).toBe(401)
      expect(await rejectedWebSocket(`ws://localhost:${TEST_WEB_PORT}/ws/chat?token=invalid`)).toBe(401)

      const token = await loginAndGetToken()
      const spy = captureProcessMessage()
      const socket = new WebSocket(`ws://localhost:${TEST_WEB_PORT}/ws/chat?token=${encodeURIComponent(token)}`)
      try {
        await new Promise<void>((resolve, reject) => {
          socket.once('open', resolve)
          socket.once('error', reject)
        })
        socket.send(JSON.stringify({ type: 'chat_message', request_id: 'ws-assertion-1', content: '来自 WS 的消息' }))
        const payload = processPayload(await waitForCall(spy))
        assertCommonAdminChatPayload(payload, 'ws-assertion-1', '来自 WS 的消息')
        await consumeThroughAgent(payload)
      } finally {
        socket.close()
        await new Promise(resolve => socket.once('close', resolve))
      }
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
        description: expect.stringMatching(/mcp__crab-memory__list_entries[\s\S]*mcp__crab-memory__set_memory_links/),
      }), expect.anything())
      const rebuildCall = callSpy.mock.calls.find((call) => call[1] === 'trigger_schedule')
      const description = String((rebuildCall?.[2] as { description?: string })?.description)
      expect(description).toContain('默认不连')
      expect(description).toContain('refines')
      expect(description).toContain('related 对称关系只保留一个方向')
      expect(description).not.toContain('Skill(')
      expect([...admin['tasks'].values()].some((task) => task.tags.includes('memory_rebuild'))).toBe(false)
    })
  })

  describe('P6-A 退役端点负断言', () => {
    it('POST /api/admin/conversation-units 已退役 → 404', async () => {
      const token = await loginAndGetToken()
      const response = await makeWebRequest(
        TEST_WEB_PORT,
        '/api/admin/conversation-units',
        'POST',
        { page: 1, page_size: 20 },
        token,
      )
      expect(response.statusCode).toBe(404)
    })

    it('raw v2 trace REST 全部退役 → 404', async () => {
      const token = await loginAndGetToken()
      for (const [method, url] of [
        ['GET', '/api/agent/traces'],
        ['DELETE', '/api/agent/traces'],
        ['GET', '/api/agent/traces/search'],
        ['GET', '/api/agent/trace-tree/task-1'],
        ['GET', '/api/agent/traces/trace-1'],
        ['GET', '/api/agents/default/traces'],
        ['GET', '/api/agents/default/traces/trace-1'],
      ] as const) {
        const response = await makeWebRequest(TEST_WEB_PORT, url, method, null, token)
        expect(response.statusCode, `${method} ${url}`).toBe(404)
      }
    })

    it('维护面端点保留：disk-usage / traces/old 透传 agent RPC', async () => {
      const token = await loginAndGetToken()
      const spy = vi.spyOn(admin['rpcClient'], 'call')
      spy.mockResolvedValueOnce({ total_bytes: 0, trace_count: 0 })
      const usage = await makeWebRequest(TEST_WEB_PORT, '/api/agent/traces/disk-usage', 'GET', null, token)
      expect(usage.statusCode).toBe(200)
      spy.mockResolvedValueOnce({ affected_count: 0, affected_bytes: 0, deleted_trace_ids: [] })
      const cleanup = await makeWebRequest(TEST_WEB_PORT, '/api/agent/traces/old?days=30', 'DELETE', null, token)
      expect(cleanup.statusCode).toBe(200)
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
  describe('P6-A 新代理端点：managers / episodes', () => {
    const spyAgentRpc = () =>
      vi.spyOn(admin['rpcClient'], 'call')

    it('GET /api/agent/managers 转发 list_managers_admin（分页透传）', async () => {
      const token = await loginAndGetToken()
      admin['agentPort'] = 19005
      const spy = spyAgentRpc().mockResolvedValue({ items: [], pagination: { page: 2, page_size: 5, total_items: 0, total_pages: 0 } })
      const response = await makeWebRequest(TEST_WEB_PORT, '/api/agent/managers?page=2&page_size=5', 'GET', null, token)
      expect(response.statusCode).toBe(200)
      expect(spy).toHaveBeenCalledWith(
        expect.any(Number),
        'list_managers_admin',
        { pagination: { page: 2, page_size: 5 } },
        expect.any(String),
      )
    })

    it('GET /api/agent/managers 用渠道+会话标题做人话 display_name，key 仍保留', async () => {
      const token = await loginAndGetToken()
      admin['agentPort'] = 19005
      spyAgentRpc().mockResolvedValue({
        items: [
          { manager_key: 'wechat-棉花糖::sess-1', active_worker_count: 2 },
          { manager_key: 'admin-web::system-tasks', active_worker_count: 1 },
          { manager_key: 'offline::unknown', active_worker_count: 0 },
        ],
        pagination: { page: 1, page_size: 20, total_items: 3, total_pages: 1 },
      })
      vi.spyOn(admin as never as { resolveChannelSession(channelId: string, sessionId: string): Promise<unknown> }, 'resolveChannelSession')
        .mockImplementation(async (id: string, sessionId: string) => id === 'wechat-棉花糖'
          ? { id: sessionId, channel_id: id, type: 'private', platform_session_id: 'u-1', title: 'FuFu', participants: [] }
          : Promise.reject(new Error('offline')))
      vi.spyOn(admin['channelManager'], 'getInstance').mockReturnValue({
        id: 'wechat-棉花糖', implementation_id: 'wechat', name: '棉花糖', platform: 'wechat',
        auto_start: true, start_priority: 1, module_registered: true, created_at: '', updated_at: '',
      })

      const response = await makeWebRequest<{ items: Array<{ manager_key: string; display_name: string }> }>(
        TEST_WEB_PORT, '/api/agent/managers', 'GET', null, token,
      )
      expect(response.statusCode, JSON.stringify(response.body)).toBe(200)
      expect(response.body.items).toEqual([
        expect.objectContaining({ manager_key: 'wechat-棉花糖::sess-1', display_name: '微信·棉花糖 · FuFu' }),
        expect.objectContaining({ manager_key: 'admin-web::system-tasks', display_name: 'Admin Web · 系统任务' }),
        expect.objectContaining({ manager_key: 'offline::unknown', display_name: 'offline::unknown' }),
      ])
    })

    it('Manager 标题查询只 exact lookup 当前页 session，100 条上限内无全历史扫描', async () => {
      const token = await loginAndGetToken()
      admin['agentPort'] = 19005
      spyAgentRpc().mockResolvedValue({
        items: Array.from({ length: 100 }, (_, i) => ({ manager_key: `wechat-test::s-${i}`, active_worker_count: 0 })),
        pagination: { page: 1, page_size: 100, total_items: 100, total_pages: 1 },
      })
      const resolveSession = vi.spyOn(
        admin as never as { resolveChannelSession(channelId: string, sessionId: string): Promise<unknown> },
        'resolveChannelSession',
      ).mockImplementation(async (channelId: string, sessionId: string) => ({
        id: sessionId, channel_id: channelId, type: 'group', platform_session_id: sessionId,
        title: `群 ${sessionId}`, participants: [],
      }))
      vi.spyOn(admin['channelManager'], 'getInstance').mockReturnValue({
        id: 'wechat-test', implementation_id: 'wechat', name: 'test', platform: 'wechat',
        auto_start: true, start_priority: 1, module_registered: true, created_at: '', updated_at: '',
      })
      const response = await makeWebRequest<{ items: unknown[] }>(TEST_WEB_PORT, '/api/agent/managers?page_size=100', 'GET', null, token)
      expect(response.statusCode).toBe(200)
      expect(response.body.items).toHaveLength(100)
      expect(resolveSession).toHaveBeenCalledTimes(100)
      expect(resolveSession).toHaveBeenCalledWith('wechat-test', 's-0')
    })

    it('GET /api/agent/managers/:key/episodes 转发 list_manager_episodes_admin（path decode 一次）', async () => {
      const token = await loginAndGetToken()
      const spy = spyAgentRpc().mockResolvedValue({ items: [], pagination: { page: 1, page_size: 20, total_items: 0, total_pages: 0 } })
      const key = encodeURIComponent('wechat::sess-1')
      const response = await makeWebRequest(TEST_WEB_PORT, `/api/agent/managers/${key}/episodes`, 'GET', null, token)
      expect(response.statusCode).toBe(200)
      expect(spy).toHaveBeenCalledWith(
        expect.any(Number),
        'list_manager_episodes_admin',
        { manager_key: 'wechat::sess-1', pagination: { page: 1, page_size: 20 } },
        expect.any(String),
      )
    })

    it('manager key 非法 percent-encoding → 400，不发 RPC', async () => {
      const token = await loginAndGetToken()
      const spy = spyAgentRpc()
      const response = await makeWebRequest(TEST_WEB_PORT, '/api/agent/managers/%E0%A4%A/episodes', 'GET', null, token)
      expect(response.statusCode).toBe(400)
      expect(spy).not.toHaveBeenCalled()
    })

    it('agent 不可达 → 503', async () => {
      const token = await loginAndGetToken()
      spyAgentRpc().mockRejectedValue(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }))
      const response = await makeWebRequest(TEST_WEB_PORT, '/api/agent/managers', 'GET', null, token)
      expect(response.statusCode).toBe(503)
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
      '/api/agent/workers/w-1/terminal',
      '/api/agent/workers/w-1/trace',
      '/api/agent/workers/w-1/subagents',
      '/api/agent/workers/w-1/subagents/child-1',
      '/api/agent/workers/w-1/subagents/child-1/trace',
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
        '/api/agent/workers?status=running&status=waiting_input&manager_key=telegram-001%3A%3Aprivate-42'
          + '&impl=codex&q=Minecraft&include_terminal=true&include_legacy=true'
          + '&start=2026-07-01T00%3A00%3A00.000Z&end=2026-07-31T00%3A00%3A00.000Z&page=2&page_size=5',
        'GET',
        null,
        token,
      )

      expect(spy).toHaveBeenCalledWith('list_workers_admin', {
        status: ['running', 'waiting_input'],
        manager_key: 'telegram-001::private-42',
        impl: 'codex',
        q: 'Minecraft',
        include_terminal: true,
        include_legacy: true,
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
     * detail/trace 由 `unified-agent.ts` 的 handler 显式抛（大写 W），terminal 由
     * `harness.ts` 的 `WorkerNotFoundError` 抛（小写 w）。修复前 terminal 端点匹配不上
     * `'Worker not found'` → 落 500。故三处共用同一个大小写无关的谓词。
     */
    it.each([
      ['/api/agent/workers/w-404', 'Worker not found: w-404'],
      ['/api/agent/workers/w-404/trace', 'Worker not found: w-404'],
      ['/api/agent/workers/w-404/terminal', 'worker not found: w-404'],
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
     * 源码：前两条来自 `harness.getWorkerTerminal` / `handleGetWorkerTrace` 的 seq 校验，
     * 第三条来自 crabot-core 的 JSON-RPC 分发（未注册方法，滚动升级期真实可达；由
     * `reject(new Error(response.error.message))` 原样送到这里）。
     * 它们都含 "not found" 却不含 "worker not found"——谓词故意不放宽到前者。
     */
    it.each([
      ['/api/agent/workers/w-1/terminal?seq=9', 'WorkerHarness.getWorkerTerminal: no incarnation with seq=9 found for worker w-1'],
      ['/api/agent/workers/w-1/trace?seq=9', 'get_worker_trace: no incarnation with seq=9 found for worker w-1'],
      ['/api/agent/workers/w-1/terminal', 'Method "get_worker_terminal" not found'],
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
    it('GET /api/agent/workers/:id/terminal → get_worker_terminal（seq 缺省不下发，由 agent 取主线化身）', async () => {
      const token = await loginAndGetToken()
      const spy = spyAgentRpc().mockResolvedValue({ kind: 'live_terminal', text: 'hello', captured_at: '2026-08-19T00:00:00.000Z' })

      const response = await makeWebRequest(
        TEST_WEB_PORT,
        '/api/agent/workers/w-1/terminal?seq=2',
        'GET',
        null,
        token,
      )
      expect(response.statusCode).toBe(200)
      expect(spy).toHaveBeenCalledWith('get_worker_terminal', { worker_id: 'w-1', seq: 2 })

      await makeWebRequest(TEST_WEB_PORT, '/api/agent/workers/w-1/terminal', 'GET', null, token)
      expect(spy).toHaveBeenLastCalledWith('get_worker_terminal', { worker_id: 'w-1' })
      // toHaveBeenCalledWith 把 `{ seq: undefined }` 视同缺席，这里显式钉住 key 真的不在载荷里。
      expect('seq' in (spy.mock.lastCall![1] as object)).toBe(false)

      // 脏值同样不下发（不回落成某个具体化身），与 list 端点"脏分页 → 回落默认值"的区别在于
      // seq 根本没有安全的默认值可回落。
      await makeWebRequest(TEST_WEB_PORT, '/api/agent/workers/w-1/terminal?seq=abc', 'GET', null, token)
      expect(spy).toHaveBeenLastCalledWith('get_worker_terminal', { worker_id: 'w-1' })
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

    it('subagent 路径转发 child 归属与 opaque cursor，并把跨 Worker child 查询视为 404', async () => {
      const token = await loginAndGetToken()
      const spy = spyAgentRpc()
        .mockResolvedValueOnce({ subagents: [{ subagent_id: 'child-1' }] })
        .mockResolvedValueOnce({ subagent: { subagent_id: 'child-1' } })
        .mockResolvedValueOnce({ events: [], next_cursor: 'opaque-next' })

      await makeWebRequest(TEST_WEB_PORT, '/api/agent/workers/w-1/subagents?incarnation_id=inc-1', 'GET', null, token)
      expect(spy).toHaveBeenLastCalledWith('list_worker_subagents', { worker_id: 'w-1', incarnation_id: 'inc-1' })
      await makeWebRequest(TEST_WEB_PORT, '/api/agent/workers/w-1/subagents/child-1', 'GET', null, token)
      expect(spy).toHaveBeenLastCalledWith('get_worker_subagent_detail', { worker_id: 'w-1', subagent_id: 'child-1' })
      await makeWebRequest(TEST_WEB_PORT, '/api/agent/workers/w-1/subagents/child-1/trace?cursor=opaque-in', 'GET', null, token)
      expect(spy).toHaveBeenLastCalledWith('get_worker_subagent_trace', { worker_id: 'w-1', subagent_id: 'child-1', cursor: 'opaque-in' })

      spy.mockRejectedValueOnce(new Error('Worker subagent not found: child-1'))
      const denied = await makeWebRequest<{ error: string }>(TEST_WEB_PORT, '/api/agent/workers/w-other/subagents/child-1', 'GET', null, token)
      expect(denied.statusCode).toBe(404)
      expect(denied.body.error).toBe('Worker subagent not found: child-1')
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
