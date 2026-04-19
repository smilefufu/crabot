import { describe, expect, it } from 'vitest'

import {
  collectDialogObjectChannelSessions,
  projectApplicationDialogObjects,
  projectFriendDialogObjects,
  projectGroupDialogObjects,
  projectPrivatePoolDialogObjects,
} from './dialog-objects.js'
import type {
  DialogObjectChannelSession,
  Friend,
  PendingMessage,
  SessionPermissionConfig,
} from './types.js'

function makeFriend(overrides: Partial<Friend> = {}): Friend {
  return {
    id: overrides.id ?? 'friend-1',
    display_name: overrides.display_name ?? 'Friend 1',
    permission: overrides.permission ?? 'normal',
    permission_template_id: overrides.permission_template_id,
    channel_identities: overrides.channel_identities ?? [],
    created_at: overrides.created_at ?? '2026-04-19T00:00:00.000Z',
    updated_at: overrides.updated_at ?? '2026-04-19T00:00:00.000Z',
  }
}

function makePendingMessage(overrides: Partial<PendingMessage> = {}): PendingMessage {
  return {
    id: overrides.id ?? 'pending-1',
    channel_id: overrides.channel_id ?? 'wechat-main',
    platform_user_id: overrides.platform_user_id ?? 'user-1',
    platform_display_name: overrides.platform_display_name ?? 'User 1',
    content_preview: overrides.content_preview ?? '/apply',
    raw_message: overrides.raw_message ?? {
      platform_message_id: 'msg-1',
      session: {
        session_id: 'session-source-1',
        channel_id: overrides.channel_id ?? 'wechat-main',
        type: 'private',
      },
      sender: {
        platform_user_id: overrides.platform_user_id ?? 'user-1',
        platform_display_name: overrides.platform_display_name ?? 'User 1',
      },
      content: {
        type: 'text',
        text: overrides.content_preview ?? '/apply',
      },
      features: {
        is_mention_crab: false,
      },
      platform_timestamp: '2026-04-19T00:00:00.000Z',
    },
    intent: overrides.intent ?? 'apply',
    received_at: overrides.received_at ?? '2026-04-19T00:00:00.000Z',
    expires_at: overrides.expires_at ?? '2026-04-20T00:00:00.000Z',
  }
}

function makeSession(overrides: Partial<DialogObjectChannelSession> = {}): DialogObjectChannelSession {
  return {
    id: overrides.id ?? 'session-1',
    channel_id: overrides.channel_id ?? 'wechat-main',
    type: overrides.type ?? 'private',
    platform_session_id: overrides.platform_session_id ?? 'platform-session-1',
    title: overrides.title ?? 'Chat 1',
    participants: overrides.participants ?? [
      {
        platform_user_id: 'user-1',
        role: 'member',
      },
    ],
    created_at: overrides.created_at ?? '2026-04-19T00:00:00.000Z',
    updated_at: overrides.updated_at ?? '2026-04-19T00:00:00.000Z',
  }
}

function makeSessionConfig(overrides: Partial<SessionPermissionConfig> = {}): SessionPermissionConfig {
  return {
    updated_at: overrides.updated_at ?? '2026-04-19T00:00:00.000Z',
    template_id: overrides.template_id,
    tool_access: overrides.tool_access,
    storage: overrides.storage,
    memory_scopes: overrides.memory_scopes,
  }
}

describe('dialog object projections', () => {
  it('projects friends with derived status based on channel identities', () => {
    const result = projectFriendDialogObjects([
      makeFriend({
        id: 'friend-active',
        display_name: 'Active Friend',
        channel_identities: [
          {
            channel_id: 'wechat-main',
            platform_user_id: 'wx-active',
            platform_display_name: 'WX Active',
          },
        ],
      }),
      makeFriend({
        id: 'friend-no-channel',
        display_name: 'No Channel Friend',
        channel_identities: [],
      }),
    ])

    expect(result).toEqual([
      expect.objectContaining({
        id: 'friend-active',
        status: 'active',
        identities: [
          {
            channel_id: 'wechat-main',
            platform_user_id: 'wx-active',
            platform_display_name: 'WX Active',
          },
        ],
      }),
      expect.objectContaining({
        id: 'friend-no-channel',
        status: 'no_channel',
        identities: [],
      }),
    ])
  })

  it('projects applications from non-expired pending messages with source session ids', () => {
    const result = projectApplicationDialogObjects(
      [
        makePendingMessage({
          id: 'pending-apply',
          intent: 'apply',
          platform_user_id: 'user-apply',
          platform_display_name: 'Apply User',
          content_preview: 'want normal access',
          received_at: '2026-04-19T01:00:00.000Z',
          expires_at: '2026-04-20T01:00:00.000Z',
          raw_message: {
            platform_message_id: 'msg-apply',
            session: { session_id: 'source-session-apply', channel_id: 'wechat-main', type: 'private' },
            sender: { platform_user_id: 'user-apply', platform_display_name: 'Apply User' },
            content: { type: 'text', text: 'want normal access' },
            features: { is_mention_crab: false },
            platform_timestamp: '2026-04-19T01:00:00.000Z',
          },
        }),
        makePendingMessage({
          id: 'pending-expired',
          expires_at: '2026-04-18T23:59:59.000Z',
        }),
      ],
      new Date('2026-04-19T02:00:00.000Z')
    )

    expect(result).toEqual([
      expect.objectContaining({
        id: 'pending-apply',
        intent: 'apply',
        channel_id: 'wechat-main',
        platform_user_id: 'user-apply',
        platform_display_name: 'Apply User',
        content_preview: 'want normal access',
        source_session_id: 'source-session-apply',
        received_at: '2026-04-19T01:00:00.000Z',
        expires_at: '2026-04-20T01:00:00.000Z',
      }),
    ])
  })

  it('projects private pool sessions excluding identities already assigned to friends', () => {
    const result = projectPrivatePoolDialogObjects({
      friends: [
        makeFriend({
          id: 'friend-linked',
          channel_identities: [
            {
              channel_id: 'wechat-main',
              platform_user_id: 'known-user',
              platform_display_name: 'Known User',
            },
          ],
        }),
      ],
      pendingMessages: [
        makePendingMessage({
          id: 'pending-private-match',
          channel_id: 'wechat-main',
          platform_user_id: 'new-user',
          raw_message: {
            platform_message_id: 'msg-private-match',
            session: { session_id: 'source-session-private', channel_id: 'wechat-main', type: 'private' },
            sender: { platform_user_id: 'new-user', platform_display_name: 'New User' },
            content: { type: 'text', text: '/apply' },
            features: { is_mention_crab: false },
            platform_timestamp: '2026-04-19T01:30:00.000Z',
          },
        }),
        makePendingMessage({
          id: 'pending-private-expired',
          channel_id: 'wechat-main',
          platform_user_id: 'new-user',
          expires_at: '2026-04-18T23:00:00.000Z',
        }),
      ],
      sessions: [
        makeSession({
          id: 'session-known',
          channel_id: 'wechat-main',
          type: 'private',
          participants: [
            {
              platform_user_id: 'known-user',
              role: 'member',
            },
          ],
        }),
        makeSession({
          id: 'session-new',
          channel_id: 'wechat-main',
          type: 'private',
          participants: [
            {
              platform_user_id: 'new-user',
              role: 'member',
            },
          ],
        }),
        makeSession({
          id: 'session-group-ignore',
          type: 'group',
        }),
      ],
      sessionConfigs: new Map([
        ['session-new', makeSessionConfig()],
      ]),
      now: new Date('2026-04-19T02:00:00.000Z'),
    })

    expect(result).toEqual([
      expect.objectContaining({
        id: 'session-new',
        type: 'private',
        has_session_config: true,
        matching_pending_application_ids: ['pending-private-match'],
      }),
    ])
  })

  it('projects only groups containing a master identity on the same channel', () => {
    const result = projectGroupDialogObjects({
      friends: [
        makeFriend({
          id: 'friend-master',
          permission: 'master',
          channel_identities: [
            {
              channel_id: 'wechat-main',
              platform_user_id: 'master-user',
              platform_display_name: 'Master User',
            },
          ],
        }),
        makeFriend({
          id: 'friend-normal',
          permission: 'normal',
          channel_identities: [
            {
              channel_id: 'wechat-main',
              platform_user_id: 'normal-user',
              platform_display_name: 'Normal User',
            },
          ],
        }),
      ],
      sessions: [
        makeSession({
          id: 'group-with-master',
          type: 'group',
          participants: [
            {
              platform_user_id: 'master-user',
              role: 'owner',
            },
            {
              platform_user_id: 'member-2',
              role: 'member',
            },
          ],
        }),
        makeSession({
          id: 'group-with-normal-only',
          type: 'group',
          participants: [
            {
              platform_user_id: 'normal-user',
              role: 'member',
            },
          ],
        }),
        makeSession({
          id: 'group-wrong-channel',
          channel_id: 'telegram-main',
          type: 'group',
          participants: [
            {
              platform_user_id: 'master-user',
              role: 'owner',
            },
          ],
        }),
      ],
      sessionConfigs: new Map([
        ['group-with-master', makeSessionConfig()],
      ]),
    })

    expect(result).toEqual([
      expect.objectContaining({
        id: 'group-with-master',
        master_in_group: true,
        participant_count: 2,
        has_session_config: true,
      }),
    ])
  })

  it('matches participants by friend_id when identity fields are stale or absent', () => {
    const master = makeFriend({
      id: 'friend-master',
      permission: 'master',
      channel_identities: [],
    })
    const normal = makeFriend({
      id: 'friend-normal',
      channel_identities: [],
    })

    const privatePool = projectPrivatePoolDialogObjects({
      friends: [normal],
      pendingMessages: [],
      sessions: [
        makeSession({
          id: 'session-assigned-by-friend-id',
          type: 'private',
          participants: [
            {
              friend_id: 'friend-normal',
              platform_user_id: 'mismatched-user',
              role: 'member',
            },
          ],
        }),
      ],
      sessionConfigs: new Map(),
    })

    const groups = projectGroupDialogObjects({
      friends: [master],
      sessions: [
        makeSession({
          id: 'group-master-by-friend-id',
          type: 'group',
          participants: [
            {
              friend_id: 'friend-master',
              platform_user_id: 'mismatched-master',
              role: 'owner',
            },
          ],
        }),
      ],
      sessionConfigs: new Map(),
    })

    expect(privatePool).toEqual([])
    expect(groups).toEqual([
      expect.objectContaining({
        id: 'group-master-by-friend-id',
        master_in_group: true,
      }),
    ])
  })

  it('collects paginated sessions across multiple pages', async () => {
    const pages = new Map<string, DialogObjectChannelSession[][]>([
      ['chan-a', [
        [makeSession({ id: 'session-a1' }), makeSession({ id: 'session-a2' })],
        [makeSession({ id: 'session-a3' })],
      ]],
    ])

    const sessions = await collectDialogObjectChannelSessions({
      channels: ['chan-a'],
      type: 'private',
      pageSize: 2,
      fetchPage: async (channel, page) => ({
        items: pages.get(channel)?.[page - 1] ?? [],
        pagination: {
          page,
          page_size: 2,
          total_items: 3,
        },
      }),
    })

    expect(sessions.map((session) => session.id)).toEqual(['session-a1', 'session-a2', 'session-a3'])
  })

  it('isolates channel fetch failures instead of aborting the whole collection', async () => {
    const handledErrors: Array<{ channel: string; message: string }> = []

    const sessions = await collectDialogObjectChannelSessions({
      channels: ['chan-ok', 'chan-fail'],
      type: 'group',
      fetchPage: async (channel) => {
        if (channel === 'chan-fail') {
          throw new Error('rpc exploded')
        }

        return {
          items: [makeSession({ id: 'group-ok', type: 'group', channel_id: channel })],
          pagination: {
            page: 1,
            page_size: 100,
            total_pages: 1,
          },
        }
      },
      onError: (channel, error) => {
        handledErrors.push({
          channel,
          message: error instanceof Error ? error.message : String(error),
        })
      },
    })

    expect(sessions.map((session) => session.id)).toEqual(['group-ok'])
    expect(handledErrors).toEqual([{ channel: 'chan-fail', message: 'rpc exploded' }])
  })
})
