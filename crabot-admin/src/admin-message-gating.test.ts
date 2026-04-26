import { describe, expect, it, vi } from 'vitest'

import type { ModuleConfig } from 'crabot-shared'

import AdminModule from './index.js'
import type { ChannelIdentity, ChannelMessageRef, Friend } from './types.js'

function makeAdmin(): AdminModule {
  const config: ModuleConfig = {
    moduleId: 'admin-message-gating-test',
    moduleType: 'admin',
    version: '0.1.0',
    protocolVersion: '0.1.0',
    port: 19808,
    subscriptions: [],
  }

  return new AdminModule(config, {
    web_port: 13008,
    data_dir: './test-data/admin-message-gating-test',
    password_env: 'TEST_ADMIN_GATING_PASSWORD',
    jwt_secret_env: 'TEST_ADMIN_GATING_JWT_SECRET',
    token_ttl: 3600,
  })
}

function makeFriend(overrides: Partial<Friend> & { id: string; permission: Friend['permission'] }): Friend {
  return {
    id: overrides.id,
    display_name: overrides.display_name ?? overrides.id,
    permission: overrides.permission,
    permission_template_id: overrides.permission_template_id,
    channel_identities: overrides.channel_identities ?? [],
    created_at: overrides.created_at ?? '2026-04-19T00:00:00.000Z',
    updated_at: overrides.updated_at ?? '2026-04-19T00:00:00.000Z',
  }
}

function makeIdentity(platformUserId: string, platformDisplayName: string): ChannelIdentity {
  return {
    channel_id: 'wechat-main',
    platform_user_id: platformUserId,
    platform_display_name: platformDisplayName,
  }
}

function makeGroupMessage(platformUserId: string, platformDisplayName: string): ChannelMessageRef {
  return {
    platform_message_id: 'msg-group-1',
    session: {
      session_id: 'group-session-1',
      channel_id: 'wechat-main',
      type: 'group',
    },
    sender: {
      platform_user_id: platformUserId,
      platform_display_name: platformDisplayName,
    },
    content: {
      type: 'text',
      text: 'hello group',
    },
    features: {
      is_mention_crab: false,
    },
    platform_timestamp: '2026-04-19T00:00:00.000Z',
  }
}

function seedFriend(admin: AdminModule, friend: Friend) {
  admin['friends'].set(friend.id, friend)
  for (const identity of friend.channel_identities) {
    admin['channelIdentityIndex'].set(`${identity.channel_id}:${identity.platform_user_id}`, friend.id)
  }
}

function mockGroupSessionLookup(admin: AdminModule, participants: Array<{
  platform_user_id: string
  role: 'owner' | 'admin' | 'member'
  friend_id?: string
}>) {
  vi.spyOn(admin['rpcClient'], 'resolve').mockResolvedValue([
    {
      module_id: 'wechat-main',
      module_type: 'channel',
      version: '0.1.0',
      port: 19998,
    },
  ] as any)

  vi.spyOn(admin['rpcClient'], 'call').mockImplementation(async (_port, method, params) => {
    if (method === 'get_session') {
      expect(params).toMatchObject({ session_id: 'group-session-1' })
      return {
        session: {
          id: 'group-session-1',
          channel_id: 'wechat-main',
          type: 'group',
          platform_session_id: 'wechat-group-1',
          title: 'Group 1',
          participants,
          created_at: '2026-04-19T00:00:00.000Z',
          updated_at: '2026-04-19T00:00:00.000Z',
        },
      } as any
    }
    throw new Error(`Unexpected RPC method: ${String(method)}`)
  })
}

describe('Admin group message gating', () => {
  it('authorizes a group message when the concrete group session contains a master', async () => {
    const admin = makeAdmin()
    const master = makeFriend({
      id: 'friend-master',
      permission: 'master',
      channel_identities: [makeIdentity('master-user', 'Master User')],
    })
    const sender = makeFriend({
      id: 'friend-sender',
      permission: 'normal',
      channel_identities: [makeIdentity('sender-user', 'Sender User')],
    })

    seedFriend(admin, master)
    seedFriend(admin, sender)
    mockGroupSessionLookup(admin, [
      { platform_user_id: 'master-user', role: 'owner' },
      { platform_user_id: 'sender-user', friend_id: sender.id, role: 'member' },
    ])

    const publishSpy = vi.spyOn(admin['rpcClient'], 'publishEvent').mockResolvedValue(1)

    await admin['handleChannelMessage']('wechat-main', makeGroupMessage('sender-user', 'Sender User'))

    expect(publishSpy).toHaveBeenCalledTimes(1)
    const [event, source] = publishSpy.mock.calls[0]
    expect(source).toBe('admin-message-gating-test')
    expect((event as any).type).toBe('channel.message_authorized')
    expect((event as any).payload.friend.id).toBe(sender.id)
    expect((event as any).payload.message.sender.friend_id).toBe(sender.id)
  })

  it('drops a group message when that concrete group session does not contain a master', async () => {
    const admin = makeAdmin()
    const master = makeFriend({
      id: 'friend-master',
      permission: 'master',
      channel_identities: [makeIdentity('master-user', 'Master User')],
    })
    const sender = makeFriend({
      id: 'friend-sender',
      permission: 'normal',
      channel_identities: [makeIdentity('sender-user', 'Sender User')],
    })

    seedFriend(admin, master)
    seedFriend(admin, sender)
    mockGroupSessionLookup(admin, [
      { platform_user_id: 'sender-user', friend_id: sender.id, role: 'member' },
    ])

    const publishSpy = vi.spyOn(admin['rpcClient'], 'publishEvent').mockResolvedValue(1)

    await admin['handleChannelMessage']('wechat-main', makeGroupMessage('sender-user', 'Sender User'))

    expect(publishSpy).not.toHaveBeenCalled()
  })
})
