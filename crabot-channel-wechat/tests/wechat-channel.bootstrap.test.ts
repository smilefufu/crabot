import { describe, it, expect, vi, beforeEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { WechatChannel } from '../src/wechat-channel.js'

function makeChannel(dataDir: string): WechatChannel {
  return new WechatChannel({
    module_id: 'vongcloud-wechat',
    module_type: 'channel',
    version: '0.1.0',
    protocol_version: '0.1.0',
    port: 0,
    data_dir: dataDir,
    wechat: {
      connector_url: 'http://localhost:9999',
      api_key: 'wct_test',
      mode: 'socketio',
    },
  })
}

function installMocks(channel: WechatChannel, overrides: {
  listGroups: ReturnType<typeof vi.fn>
  getGroupMembers: ReturnType<typeof vi.fn>
  upsertGroupSessionFromSnapshot?: ReturnType<typeof vi.fn>
}) {
  const mockClient = {
    listGroups: overrides.listGroups,
    getGroupMembers: overrides.getGroupMembers,
  }
  ;(channel as any).client = mockClient
  if (overrides.upsertGroupSessionFromSnapshot) {
    ;(channel as any).sessionManager = {
      upsertGroupSessionFromSnapshot: overrides.upsertGroupSessionFromSnapshot,
      listSessions: () => [],
      findById: () => undefined,
      findByPlatformId: () => undefined,
    }
  }
  return mockClient
}

describe('WechatChannel.bootstrapGroupSessions', () => {
  let dataDir: string

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-channel-'))
  })

  it('writes fetched groups and members to session manager', async () => {
    const channel = makeChannel(dataDir)

    const upsertSpy = vi.fn().mockReturnValue({
      session: { id: 'sess-1' },
      created: true,
    })

    installMocks(channel, {
      listGroups: vi.fn().mockResolvedValueOnce({
        items: [
          { chatroomName: 'r1@chatroom', name: '工作群' },
          { chatroomName: 'r2@chatroom', name: '技术群' },
        ],
        pagination: { page: 1, pageSize: 50, total: 2, totalPages: 1 },
      }),
      getGroupMembers: vi
        .fn()
        .mockResolvedValueOnce({
          members: [
            { username: 'wxid_a', nickname: 'A' },
            { username: 'wxid_b', nickname: 'B' },
          ],
          memberCount: 2,
        })
        .mockResolvedValueOnce({
          members: [{ username: 'wxid_c', nickname: 'C' }],
          memberCount: 1,
        }),
      upsertGroupSessionFromSnapshot: upsertSpy,
    })

    await (channel as any).bootstrapGroupSessions()

    expect(upsertSpy).toHaveBeenCalledTimes(2)
    expect(upsertSpy).toHaveBeenNthCalledWith(1, {
      platform_session_id: 'r1@chatroom',
      title: '工作群',
      participants: [
        { platform_user_id: 'wxid_a', role: 'member' },
        { platform_user_id: 'wxid_b', role: 'member' },
      ],
    })
    expect(upsertSpy).toHaveBeenNthCalledWith(2, {
      platform_session_id: 'r2@chatroom',
      title: '技术群',
      participants: [{ platform_user_id: 'wxid_c', role: 'member' }],
    })
  })

  it('skips a group when getGroupMembers fails, continues with the rest', async () => {
    const channel = makeChannel(dataDir)

    const upsertSpy = vi.fn().mockReturnValue({
      session: { id: 'sess' },
      created: true,
    })

    installMocks(channel, {
      listGroups: vi.fn().mockResolvedValueOnce({
        items: [
          { chatroomName: 'r1@chatroom', name: '群1' },
          { chatroomName: 'r2@chatroom', name: '群2' },
        ],
        pagination: { page: 1, pageSize: 50, total: 2, totalPages: 1 },
      }),
      getGroupMembers: vi
        .fn()
        .mockRejectedValueOnce(new Error('network error'))
        .mockResolvedValueOnce({
          members: [{ username: 'wxid_x', nickname: 'X' }],
          memberCount: 1,
        }),
      upsertGroupSessionFromSnapshot: upsertSpy,
    })

    await (channel as any).bootstrapGroupSessions()

    expect(upsertSpy).toHaveBeenCalledTimes(1)
    expect(upsertSpy).toHaveBeenCalledWith({
      platform_session_id: 'r2@chatroom',
      title: '群2',
      participants: [{ platform_user_id: 'wxid_x', role: 'member' }],
    })
  })

  it('does not throw when listGroups fails entirely', async () => {
    const channel = makeChannel(dataDir)

    const upsertSpy = vi.fn()

    installMocks(channel, {
      listGroups: vi.fn().mockRejectedValueOnce(new Error('connector down')),
      getGroupMembers: vi.fn(),
      upsertGroupSessionFromSnapshot: upsertSpy,
    })

    await expect((channel as any).bootstrapGroupSessions()).resolves.toBeUndefined()
    expect(upsertSpy).not.toHaveBeenCalled()
  })

  it('paginates through all pages', async () => {
    const channel = makeChannel(dataDir)

    const upsertSpy = vi.fn().mockReturnValue({ session: { id: 'x' }, created: true })

    const listGroups = vi
      .fn()
      .mockResolvedValueOnce({
        items: [{ chatroomName: 'r1@chatroom', name: '群1' }],
        pagination: { page: 1, pageSize: 50, total: 2, totalPages: 2 },
      })
      .mockResolvedValueOnce({
        items: [{ chatroomName: 'r2@chatroom', name: '群2' }],
        pagination: { page: 2, pageSize: 50, total: 2, totalPages: 2 },
      })

    installMocks(channel, {
      listGroups,
      getGroupMembers: vi
        .fn()
        .mockResolvedValue({
          members: [{ username: 'wxid_a', nickname: 'A' }],
          memberCount: 1,
        }),
      upsertGroupSessionFromSnapshot: upsertSpy,
    })

    await (channel as any).bootstrapGroupSessions()

    expect(listGroups).toHaveBeenCalledTimes(2)
    expect(listGroups.mock.calls[0][0]).toEqual({ page: 1, pageSize: 50 })
    expect(listGroups.mock.calls[1][0]).toEqual({ page: 2, pageSize: 50 })
    expect(upsertSpy).toHaveBeenCalledTimes(2)
  })
})
