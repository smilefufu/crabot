import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import http from 'node:http'
import fs from 'node:fs/promises'
import AdminModule from './index.js'
import type { ChannelMessageRef, Friend, LoginResponse, PendingMessage } from './types.js'

const TEST_PROTOCOL_PORT = 19808
const TEST_WEB_PORT = 13008
const TEST_DATA_DIR = './test-data/private-pool-actions-test'

type ChannelSession = {
  id: string
  channel_id: string
  type: 'private' | 'group'
  platform_session_id: string
  title: string
  participants: Array<{
    friend_id?: string
    platform_user_id: string
    role: 'owner' | 'admin' | 'member'
  }>
  permissions: Record<string, unknown>
  memory_scopes: string[]
  workspace_path: string
  created_at: string
  updated_at: string
}

describe('Private Pool Actions And Group Gating', () => {
  let admin: AdminModule
  let token: string
  let rpcResolveCalls: Array<{ module_id?: string; module_type?: string }>
  let rpcCallCalls: Array<{ port: number; method: string; params: unknown }>
  let publishedEvents: Array<Record<string, unknown>>
  let sessionById: Map<string, ChannelSession>

  beforeAll(async () => {
    try {
      await fs.rm(TEST_DATA_DIR, { recursive: true, force: true })
    } catch {
      // ignore
    }

    process.env.TEST_ADMIN_PRIVATE_POOL_PASSWORD = 'test_password_123'
    process.env.TEST_JWT_SECRET_PRIVATE_POOL = 'test_jwt_secret_private_pool_at_least_32_chars'

    admin = new AdminModule(
      {
        moduleId: 'admin-private-pool-test',
        moduleType: 'admin',
        version: '0.1.0',
        protocolVersion: '0.1.0',
        port: TEST_PROTOCOL_PORT,
        subscriptions: [],
      },
      {
        web_port: TEST_WEB_PORT,
        data_dir: TEST_DATA_DIR,
        password_env: 'TEST_ADMIN_PRIVATE_POOL_PASSWORD',
        jwt_secret_env: 'TEST_JWT_SECRET_PRIVATE_POOL',
        token_ttl: 3600,
      }
    )

    await admin.start()
    token = await loginAndGetToken(TEST_WEB_PORT)
  })

  afterAll(async () => {
    await admin.stop()
    try {
      await fs.rm(TEST_DATA_DIR, { recursive: true, force: true })
    } catch {
      // ignore
    }
  })

  beforeEach(async () => {
    const adminAny = admin as any
    adminAny.friends.clear()
    adminAny.pendingMessages.clear()
    adminAny.channelIdentityIndex.clear()
    adminAny.sessionConfigs.clear()
    await adminAny.saveData()

    rpcResolveCalls = []
    rpcCallCalls = []
    publishedEvents = []
    sessionById = new Map()

    adminAny.rpcClient.resolve = async (params: { module_id?: string; module_type?: string }) => {
      rpcResolveCalls.push(params)
      return [{
        module_id: params.module_id ?? 'stub-channel',
        module_type: 'channel',
        version: '0.1.0',
        protocol_version: '0.1.0',
        host: 'localhost',
        port: 29999,
        status: 'running',
      }]
    }

    adminAny.rpcClient.call = async (port: number, method: string, params: { session_id?: string }) => {
      rpcCallCalls.push({ port, method, params })

      if (method === 'get_session' && params.session_id) {
        const session = sessionById.get(params.session_id)
        if (!session) {
          throw new Error(`Unknown session: ${params.session_id}`)
        }
        return { session }
      }

      throw new Error(`Unexpected RPC call: ${method}`)
    }

    adminAny.rpcClient.publishEvent = async (event: Record<string, unknown>) => {
      publishedEvents.push(event)
      return 1
    }
  })

  it('assigns a private-pool session to an existing friend, cleans pending entries, and stays idempotent', async () => {
    const adminAny = admin as any
    const { friend } = adminAny.handleCreateFriend({
      display_name: 'Existing Friend',
      permission: 'normal',
      permission_template_id: 'standard',
    }) as { friend: Friend }
    await adminAny.saveData()

    sessionById.set('private-session-assign', makeSession({
      id: 'private-session-assign',
      channel_id: 'wechat-main',
      type: 'private',
      title: 'Pool User',
      participants: [{ platform_user_id: 'pool-user', role: 'member' }],
    }))

    seedPendingMessages(adminAny, [
      makePendingMessage({
        id: 'pending-assign-1',
        channel_id: 'wechat-main',
        platform_user_id: 'pool-user',
      }),
      makePendingMessage({
        id: 'pending-assign-2',
        channel_id: 'wechat-main',
        platform_user_id: 'pool-user',
      }),
    ])

    const firstResponse = await makeWebRequest<{ friend: Friend }>(
      TEST_WEB_PORT,
      `/api/dialog-objects/private-pool/private-session-assign/assign-friend`,
      'POST',
      { channel_id: 'wechat-main', friend_id: friend.id },
      token
    )

    expect(firstResponse.statusCode).toBe(200)
    expect(firstResponse.body.friend.channel_identities).toEqual([
      {
        channel_id: 'wechat-main',
        platform_user_id: 'pool-user',
        platform_display_name: 'Pool User',
      },
    ])
    expect(Array.from(adminAny.pendingMessages.keys())).toEqual([])

    const secondResponse = await makeWebRequest<{ friend: Friend }>(
      TEST_WEB_PORT,
      `/api/dialog-objects/private-pool/private-session-assign/assign-friend`,
      'POST',
      { channel_id: 'wechat-main', friend_id: friend.id },
      token
    )

    expect(secondResponse.statusCode).toBe(200)
    expect(secondResponse.body.friend.channel_identities).toHaveLength(1)
    expect(rpcResolveCalls).toEqual([
      { module_id: 'wechat-main' },
      { module_id: 'wechat-main' },
    ])
    expect(rpcCallCalls.map((call) => ({ method: call.method, params: call.params }))).toEqual([
      { method: 'get_session', params: { session_id: 'private-session-assign' } },
      { method: 'get_session', params: { session_id: 'private-session-assign' } },
    ])
  })

  it('creates a friend from a private-pool session and removes matching pending entries', async () => {
    const adminAny = admin as any

    sessionById.set('private-session-create', makeSession({
      id: 'private-session-create',
      channel_id: 'telegram-main',
      type: 'private',
      title: 'Fresh User',
      participants: [{ platform_user_id: 'fresh-user', role: 'member' }],
    }))

    seedPendingMessages(adminAny, [
      makePendingMessage({
        id: 'pending-create',
        channel_id: 'telegram-main',
        platform_user_id: 'fresh-user',
      }),
    ])

    const response = await makeWebRequest<{ friend: Friend }>(
      TEST_WEB_PORT,
      `/api/dialog-objects/private-pool/private-session-create/create-friend`,
      'POST',
      {
        channel_id: 'telegram-main',
        display_name: 'Created Friend',
        permission_template_id: 'standard',
      },
      token
    )

    expect(response.statusCode).toBe(201)
    expect(response.body.friend.display_name).toBe('Created Friend')
    expect(response.body.friend.permission).toBe('normal')
    expect(response.body.friend.permission_template_id).toBe('standard')
    expect(response.body.friend.channel_identities).toEqual([
      {
        channel_id: 'telegram-main',
        platform_user_id: 'fresh-user',
        platform_display_name: 'Fresh User',
      },
    ])
    expect(Array.from(adminAny.pendingMessages.keys())).toEqual([])
  })

  it('rejects private-pool actions when a private session has multiple participants', async () => {
    sessionById.set('private-session-ambiguous', makeSession({
      id: 'private-session-ambiguous',
      channel_id: 'wechat-main',
      type: 'private',
      title: 'Ambiguous User',
      participants: [
        { platform_user_id: 'user-a', role: 'member' },
        { platform_user_id: 'user-b', role: 'member' },
      ],
    }))

    const response = await makeWebRequest<{ error: string }>(
      TEST_WEB_PORT,
      `/api/dialog-objects/private-pool/private-session-ambiguous/create-friend`,
      'POST',
      {
        channel_id: 'wechat-main',
        display_name: 'Should Fail',
      },
      token
    )

    expect(response.statusCode).toBe(400)
    expect(response.body.error).toBe('Private session identity is ambiguous')
  })

  it('authorizes a group message when the concrete group session contains a master', async () => {
    const adminAny = admin as any
    const { friend: master } = adminAny.handleCreateFriend({
      display_name: 'Master User',
      permission: 'master',
      channel_identities: [{
        channel_id: 'wechat-main',
        platform_user_id: 'master-user',
        platform_display_name: 'Master User',
      }],
    }) as { friend: Friend }
    const { friend: member } = adminAny.handleCreateFriend({
      display_name: 'Known Member',
      permission: 'normal',
      permission_template_id: 'standard',
      channel_identities: [{
        channel_id: 'wechat-main',
        platform_user_id: 'known-member',
        platform_display_name: 'Known Member',
      }],
    }) as { friend: Friend }
    await adminAny.saveData()

    sessionById.set('group-session-master', makeSession({
      id: 'group-session-master',
      channel_id: 'wechat-main',
      type: 'group',
      title: 'Allowed Group',
      participants: [
        { platform_user_id: 'master-user', role: 'owner' },
        { platform_user_id: 'known-member', role: 'member' },
      ],
    }))

    await adminAny.handleChannelMessage(
      'wechat-main',
      makeChannelMessage({
        session_id: 'group-session-master',
        channel_id: 'wechat-main',
        type: 'group',
        platform_user_id: 'known-member',
        platform_display_name: 'Known Member',
      })
    )

    expect(publishedEvents).toHaveLength(1)
    const payload = publishedEvents[0].payload as {
      friend: Friend
      message: ChannelMessageRef
    }
    expect(payload.friend.id).toBe(member.id)
    expect(payload.message.sender.friend_id).toBe(member.id)
    expect(master.id).toBeDefined()
  })

  it('drops a group message before authorization when that session does not contain a master', async () => {
    const adminAny = admin as any
    adminAny.handleCreateFriend({
      display_name: 'Channel Master',
      permission: 'master',
      channel_identities: [{
        channel_id: 'wechat-main',
        platform_user_id: 'master-user',
        platform_display_name: 'Master User',
      }],
    })
    const { friend: member } = adminAny.handleCreateFriend({
      display_name: 'Known Member',
      permission: 'normal',
      permission_template_id: 'standard',
      channel_identities: [{
        channel_id: 'wechat-main',
        platform_user_id: 'known-member',
        platform_display_name: 'Known Member',
      }],
    }) as { friend: Friend }
    await adminAny.saveData()

    sessionById.set('group-session-no-master', makeSession({
      id: 'group-session-no-master',
      channel_id: 'wechat-main',
      type: 'group',
      title: 'Blocked Group',
      participants: [
        { platform_user_id: 'known-member', role: 'member' },
        { platform_user_id: 'guest-user', role: 'member' },
      ],
    }))

    await adminAny.handleChannelMessage(
      'wechat-main',
      makeChannelMessage({
        session_id: 'group-session-no-master',
        channel_id: 'wechat-main',
        type: 'group',
        platform_user_id: 'known-member',
        platform_display_name: 'Known Member',
      })
    )

    expect(member.id).toBeDefined()
    expect(publishedEvents).toEqual([])
  })
})

function makeSession(overrides: Partial<ChannelSession> & Pick<ChannelSession, 'id'>): ChannelSession {
  return {
    id: overrides.id,
    channel_id: overrides.channel_id ?? 'wechat-main',
    type: overrides.type ?? 'private',
    platform_session_id: overrides.platform_session_id ?? overrides.id,
    title: overrides.title ?? overrides.id,
    participants: overrides.participants ?? [],
    permissions: overrides.permissions ?? {},
    memory_scopes: overrides.memory_scopes ?? [],
    workspace_path: overrides.workspace_path ?? '/tmp',
    created_at: overrides.created_at ?? '2026-04-19T00:00:00.000Z',
    updated_at: overrides.updated_at ?? '2026-04-19T00:00:00.000Z',
  }
}

function makePendingMessage(
  overrides: Partial<PendingMessage> & Pick<PendingMessage, 'id' | 'channel_id' | 'platform_user_id'>
): PendingMessage {
  return {
    id: overrides.id,
    channel_id: overrides.channel_id,
    platform_user_id: overrides.platform_user_id,
    platform_display_name: overrides.platform_display_name ?? overrides.platform_user_id,
    content_preview: overrides.content_preview ?? '/apply',
    raw_message: overrides.raw_message ?? makeChannelMessage({
      session_id: `${overrides.id}-session`,
      channel_id: overrides.channel_id,
      type: 'private',
      platform_user_id: overrides.platform_user_id,
      platform_display_name: overrides.platform_display_name ?? overrides.platform_user_id,
    }),
    intent: overrides.intent ?? 'apply',
    received_at: overrides.received_at ?? '2026-04-19T00:00:00.000Z',
    expires_at: overrides.expires_at ?? '2026-04-20T00:00:00.000Z',
  }
}

function makeChannelMessage(input: {
  session_id: string
  channel_id: string
  type: 'private' | 'group'
  platform_user_id: string
  platform_display_name: string
}): ChannelMessageRef {
  return {
    platform_message_id: `msg-${input.session_id}-${input.platform_user_id}`,
    session: {
      session_id: input.session_id,
      channel_id: input.channel_id,
      type: input.type,
    },
    sender: {
      platform_user_id: input.platform_user_id,
      platform_display_name: input.platform_display_name,
    },
    content: {
      type: 'text',
      text: 'hello',
    },
    features: {
      is_mention_crab: false,
    },
    platform_timestamp: '2026-04-19T00:00:00.000Z',
  }
}

function seedPendingMessages(adminAny: any, pendingMessages: PendingMessage[]): void {
  for (const message of pendingMessages) {
    adminAny.pendingMessages.set(message.id, message)
  }
}

interface WebResponse<D> {
  statusCode: number
  body: D
}

function makeWebRequest<D>(
  port: number,
  path: string,
  method: string,
  body: unknown | null,
  token?: string
): Promise<WebResponse<D>> {
  return new Promise((resolve, reject) => {
    const bodyString = body === null ? '' : JSON.stringify(body)

    const req = http.request(
      {
        hostname: 'localhost',
        port,
        method,
        path,
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(bodyString ? { 'Content-Length': Buffer.byteLength(bodyString) } : {}),
        },
      },
      (res) => {
        let data = ''
        res.on('data', (chunk) => {
          data += chunk
        })
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode ?? 0,
            body: JSON.parse(data) as D,
          })
        })
      }
    )

    req.on('error', reject)
    if (bodyString) {
      req.write(bodyString)
    }
    req.end()
  })
}

async function loginAndGetToken(port: number): Promise<string> {
  const response = await makeWebRequest<LoginResponse>(
    port,
    '/api/auth/login',
    'POST',
    { password: 'test_password_123' }
  )
  expect(response.statusCode).toBe(200)
  return response.body.token
}
