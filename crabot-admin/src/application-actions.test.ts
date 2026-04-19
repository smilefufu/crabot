import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import http from 'node:http'
import fs from 'node:fs/promises'
import AdminModule from './index.js'
import type { ChannelMessageRef, DialogObjectApplication, Friend, LoginResponse, PendingMessage } from './types.js'

const TEST_PROTOCOL_PORT = 19809
const TEST_WEB_PORT = 13009
const TEST_DATA_DIR = './test-data/application-actions-test'

describe('Dialog object application actions', () => {
  let admin: AdminModule
  let token: string

  beforeAll(async () => {
    try {
      await fs.rm(TEST_DATA_DIR, { recursive: true, force: true })
    } catch {
      // ignore
    }

    process.env.TEST_ADMIN_APPLICATION_ACTIONS_PASSWORD = 'test_password_123'
    process.env.TEST_JWT_SECRET_APPLICATION_ACTIONS = 'test_jwt_secret_application_actions_at_least_32_chars'

    admin = new AdminModule(
      {
        moduleId: 'admin-application-actions-test',
        moduleType: 'admin',
        version: '0.1.0',
        protocolVersion: '0.1.0',
        port: TEST_PROTOCOL_PORT,
        subscriptions: [],
      },
      {
        web_port: TEST_WEB_PORT,
        data_dir: TEST_DATA_DIR,
        password_env: 'TEST_ADMIN_APPLICATION_ACTIONS_PASSWORD',
        jwt_secret_env: 'TEST_JWT_SECRET_APPLICATION_ACTIONS',
        token_ttl: 3600,
      }
    )

    await admin.start()
    token = await loginAndGetToken()
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
    await adminAny.saveData()
    vi.restoreAllMocks()

    vi.spyOn(adminAny.rpcClient, 'resolve').mockImplementation(async ({ module_id }) => [
      {
        module_id: module_id ?? 'wechat-main',
        module_type: 'channel',
        version: '0.1.0',
        protocol_version: '0.1.0',
        host: 'localhost',
        port: 29999,
        status: 'running',
      },
    ])

    vi.spyOn(adminAny.rpcClient, 'call').mockImplementation(async (_port, method, params) => {
      if (method !== 'get_session') {
        throw new Error(`Unexpected RPC method: ${String(method)}`)
      }

      const sessionId = (params as { session_id?: string }).session_id
      if (!sessionId) {
        throw new Error('Missing session_id')
      }

      const pending = Array.from(adminAny.pendingMessages.values()).find(
        (message: PendingMessage) => message.raw_message.session.session_id === sessionId
      )
      if (!pending) {
        throw new Error(`Unknown session: ${sessionId}`)
      }

      return {
        session: {
          id: sessionId,
          channel_id: pending.channel_id,
          type: 'private',
          platform_session_id: pending.platform_user_id,
          title: pending.platform_display_name,
          participants: [
            {
              platform_user_id: pending.platform_user_id,
              role: 'member',
            },
          ],
          created_at: '2026-04-19T00:00:00.000Z',
          updated_at: '2026-04-19T00:00:00.000Z',
        },
      }
    })
  })

  it('assigns an apply application to an existing friend and removes the application', async () => {
    const adminAny = admin as any
    const { friend } = adminAny.handleCreateFriend({
      display_name: 'Existing Friend',
      permission: 'normal',
      permission_template_id: 'standard',
    }) as { friend: Friend }

    const application = await seedApplication(adminAny, {
      id: 'application-apply-assign',
      channel_id: 'wechat-main',
      platform_user_id: 'apply-user',
      platform_display_name: 'Apply User',
      intent: 'apply',
      source_session_id: 'source-session-apply-assign',
    })

    const response = await makeWebRequest<{ friend: Friend }>(
      TEST_WEB_PORT,
      `/api/dialog-objects/applications/${application.id}/assign-friend`,
      'POST',
      { friend_id: friend.id },
      token
    )

    expect(response.statusCode).toBe(200)
    expect(response.body.friend.id).toBe(friend.id)
    expect(response.body.friend.channel_identities).toEqual([
      {
        channel_id: 'wechat-main',
        platform_user_id: 'apply-user',
        platform_display_name: 'Apply User',
      },
    ])
    expect(Array.from(adminAny.pendingMessages.values())).toEqual([])

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

  it('creates a normal friend from an apply application with a permission template', async () => {
    const adminAny = admin as any
    const application = await seedApplication(adminAny, {
      id: 'application-apply-create',
      channel_id: 'telegram-main',
      platform_user_id: 'create-user',
      platform_display_name: 'Create User',
      intent: 'apply',
      source_session_id: 'source-session-apply-create',
    })

    const response = await makeWebRequest<{ friend: Friend }>(
      TEST_WEB_PORT,
      `/api/dialog-objects/applications/${application.id}/create-friend`,
      'POST',
      {
        display_name: 'Created Friend',
        permission_template_id: 'trusted',
      },
      token
    )

    expect(response.statusCode).toBe(201)
    expect(response.body.friend.display_name).toBe('Created Friend')
    expect(response.body.friend.permission).toBe('normal')
    expect(response.body.friend.permission_template_id).toBe('trusted')
    expect(response.body.friend.channel_identities).toEqual([
      {
        channel_id: 'telegram-main',
        platform_user_id: 'create-user',
        platform_display_name: 'Create User',
      },
    ])
    expect(Array.from(adminAny.pendingMessages.values())).toEqual([])
  })

  it('returns 409 when an apply application create-friend action reuses an existing channel identity', async () => {
    const adminAny = admin as any
    adminAny.handleCreateFriend({
      display_name: 'Existing Identity',
      permission: 'normal',
      channel_identities: [
        {
          channel_id: 'wechat-main',
          platform_user_id: 'apply-user',
          platform_display_name: 'Existing Apply User',
        },
      ],
    })

    const application = await seedApplication(adminAny, {
      id: 'application-apply-conflict',
      channel_id: 'wechat-main',
      platform_user_id: 'apply-user',
      platform_display_name: 'Apply User',
      intent: 'apply',
      source_session_id: 'source-session-apply-conflict',
    })

    const response = await makeWebRequest<{ error: string; message: string }>(
      TEST_WEB_PORT,
      `/api/dialog-objects/applications/${application.id}/create-friend`,
      'POST',
      {
        display_name: 'Conflicting Friend',
      },
      token
    )

    expect(response.statusCode).toBe(409)
    expect(response.body.error).toBe('ADMIN_CHANNEL_IDENTITY_IN_USE')
    expect(response.body.message).toContain('Channel identity already in use:')
  })

  it('links a pair application to an existing master friend', async () => {
    const adminAny = admin as any
    const { friend: master } = adminAny.handleCreateFriend({
      display_name: 'Existing Master',
      permission: 'master',
    }) as { friend: Friend }

    const application = await seedApplication(adminAny, {
      id: 'application-pair-link',
      channel_id: 'wechat-main',
      platform_user_id: 'pair-user',
      platform_display_name: 'Pair User',
      intent: 'pair',
      source_session_id: 'source-session-pair-link',
    })

    const response = await makeWebRequest<{ friend: Friend }>(
      TEST_WEB_PORT,
      `/api/dialog-objects/applications/${application.id}/link-master`,
      'POST',
      null,
      token
    )

    expect(response.statusCode).toBe(200)
    expect(response.body.friend.id).toBe(master.id)
    expect(response.body.friend.permission).toBe('master')
    expect(response.body.friend.channel_identities).toEqual([
      {
        channel_id: 'wechat-main',
        platform_user_id: 'pair-user',
        platform_display_name: 'Pair User',
      },
    ])
    expect(Array.from(adminAny.pendingMessages.values())).toEqual([])
  })

  it('creates a master friend when a pair application has no existing master', async () => {
    const adminAny = admin as any
    const application = await seedApplication(adminAny, {
      id: 'application-pair-create',
      channel_id: 'wechat-main',
      platform_user_id: 'pair-create-user',
      platform_display_name: 'Pair Create User',
      intent: 'pair',
      source_session_id: 'source-session-pair-create',
    })

    const response = await makeWebRequest<{ friend: Friend }>(
      TEST_WEB_PORT,
      `/api/dialog-objects/applications/${application.id}/link-master`,
      'POST',
      null,
      token
    )

    expect(response.statusCode).toBe(201)
    expect(response.body.friend.permission).toBe('master')
    expect(response.body.friend.display_name).toBe('Pair Create User')
    expect(response.body.friend.channel_identities).toEqual([
      {
        channel_id: 'wechat-main',
        platform_user_id: 'pair-create-user',
        platform_display_name: 'Pair Create User',
      },
    ])
    expect(Array.from(adminAny.pendingMessages.values())).toEqual([])
  })

  it('assigns an apply application without re-resolving the source session', async () => {
    const adminAny = admin as any
    const { friend } = adminAny.handleCreateFriend({
      display_name: 'Existing Friend',
      permission: 'normal',
    }) as { friend: Friend }

    const application = await seedApplication(adminAny, {
      id: 'application-apply-no-rpc',
      channel_id: 'wechat-main',
      platform_user_id: 'no-rpc-apply-user',
      platform_display_name: 'No RPC Apply User',
      intent: 'apply',
      source_session_id: 'missing-source-session-apply',
    })

    adminAny.rpcClient.resolve.mockRejectedValue(new Error('RPC should not be called'))
    adminAny.rpcClient.call.mockRejectedValue(new Error('RPC should not be called'))

    const response = await makeWebRequest<{ friend: Friend }>(
      TEST_WEB_PORT,
      `/api/dialog-objects/applications/${application.id}/assign-friend`,
      'POST',
      { friend_id: friend.id },
      token
    )

    expect(response.statusCode).toBe(200)
    expect(response.body.friend.channel_identities).toEqual([
      {
        channel_id: 'wechat-main',
        platform_user_id: 'no-rpc-apply-user',
        platform_display_name: 'No RPC Apply User',
      },
    ])
  })

  it('links a pair application without re-resolving the source session', async () => {
    const adminAny = admin as any
    const { friend: master } = adminAny.handleCreateFriend({
      display_name: 'Existing Master',
      permission: 'master',
    }) as { friend: Friend }

    const application = await seedApplication(adminAny, {
      id: 'application-pair-no-rpc',
      channel_id: 'wechat-main',
      platform_user_id: 'no-rpc-pair-user',
      platform_display_name: 'No RPC Pair User',
      intent: 'pair',
      source_session_id: 'missing-source-session-pair',
    })

    adminAny.rpcClient.resolve.mockRejectedValue(new Error('RPC should not be called'))
    adminAny.rpcClient.call.mockRejectedValue(new Error('RPC should not be called'))

    const response = await makeWebRequest<{ friend: Friend }>(
      TEST_WEB_PORT,
      `/api/dialog-objects/applications/${application.id}/link-master`,
      'POST',
      null,
      token
    )

    expect(response.statusCode).toBe(200)
    expect(response.body.friend.id).toBe(master.id)
    expect(response.body.friend.channel_identities).toEqual([
      {
        channel_id: 'wechat-main',
        platform_user_id: 'no-rpc-pair-user',
        platform_display_name: 'No RPC Pair User',
      },
    ])
  })

  it('rejects an application and removes it from the queue', async () => {
    const adminAny = admin as any
    const application = await seedApplication(adminAny, {
      id: 'application-reject',
      channel_id: 'wechat-main',
      platform_user_id: 'reject-user',
      platform_display_name: 'Reject User',
      intent: 'apply',
      source_session_id: 'source-session-reject',
    })

    const response = await makeWebRequest<{ deleted: true }>(
      TEST_WEB_PORT,
      `/api/dialog-objects/applications/${application.id}`,
      'DELETE',
      null,
      token
    )

    expect(response.statusCode).toBe(200)
    expect(response.body.deleted).toBe(true)
    expect(Array.from(adminAny.pendingMessages.values())).toEqual([])
  })
})

function makePendingMessage(overrides: Partial<PendingMessage> = {}): PendingMessage {
  return {
    id: overrides.id ?? 'pending-1',
    channel_id: overrides.channel_id ?? 'wechat-main',
    platform_user_id: overrides.platform_user_id ?? 'user-1',
    platform_display_name: overrides.platform_display_name ?? 'User 1',
    content_preview: overrides.content_preview ?? '/apply',
    raw_message: overrides.raw_message ?? makeChannelMessageRef({
      channel_id: overrides.channel_id ?? 'wechat-main',
      session_id: 'source-session-1',
      platform_user_id: overrides.platform_user_id ?? 'user-1',
      platform_display_name: overrides.platform_display_name ?? 'User 1',
      text: overrides.content_preview ?? '/apply',
    }),
    intent: overrides.intent ?? 'apply',
    received_at: overrides.received_at ?? '2026-04-19T00:00:00.000Z',
    expires_at: overrides.expires_at ?? '2026-04-20T00:00:00.000Z',
  }
}

function makeChannelMessageRef(params: {
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

async function seedApplication(
  adminAny: any,
  overrides: {
    id: string
    channel_id: string
    platform_user_id: string
    platform_display_name: string
    intent: 'apply' | 'pair'
    source_session_id: string
  }
): Promise<PendingMessage> {
  const { pending_message } = await adminAny.handleUpsertPendingMessage({
    channel_id: overrides.channel_id,
    platform_user_id: overrides.platform_user_id,
    platform_display_name: overrides.platform_display_name,
    content_preview: overrides.intent === 'pair' ? '/认主' : '/apply',
    intent: overrides.intent,
    raw_message: makeChannelMessageRef({
      channel_id: overrides.channel_id,
      session_id: overrides.source_session_id,
      platform_user_id: overrides.platform_user_id,
      platform_display_name: overrides.platform_display_name,
      text: overrides.intent === 'pair' ? '/认主' : '/apply',
    }),
  })

  const stored = adminAny.pendingMessages.get(pending_message.id) as PendingMessage | undefined
  if (!stored) {
    throw new Error('Failed to seed pending message')
  }

  if (overrides.id !== pending_message.id) {
    adminAny.pendingMessages.delete(pending_message.id)
    const updated = { ...stored, id: overrides.id }
    adminAny.pendingMessages.set(updated.id, updated)
    await adminAny.saveData()
    return updated
  }

  return stored
}

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
          } catch (error) {
            reject(new Error(`Failed to parse response: ${String(error)}`))
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
