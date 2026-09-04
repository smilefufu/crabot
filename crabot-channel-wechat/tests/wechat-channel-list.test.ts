import { describe, it, expect, vi } from 'vitest'
import { WechatChannel } from '../src/wechat-channel.js'

function makeChannel(): WechatChannel {
  return new WechatChannel({
    module_id: 'wechat-test',
    module_type: 'channel',
    version: '0.0.1',
    protocol_version: '0.1.0',
    port: 0,
    data_dir: '/tmp/wechat-test',
    wechat: {
      connector_url: 'http://localhost:0',
      api_key: 'wct_test',
      mode: 'socketio',
    },
  })
}

describe('WechatChannel list_groups handler', () => {
  it('委托 wechat-client.listGroups 并把 chatroomName 映射成 platform_session_id', async () => {
    const channel = makeChannel()
    const listGroupsMock = vi.fn().mockResolvedValue({
      items: [
        { chatroomName: '12345@chatroom', name: '工作群' },
        { chatroomName: '6789@chatroom', name: '家庭群' },
      ],
      pagination: { page: 1, pageSize: 20, total: 2, totalPages: 1 },
    })
    ;(channel as unknown as { client: { listGroups: typeof listGroupsMock } }).client = { listGroups: listGroupsMock } as never

    const result = await (channel as unknown as { handleListGroups(p: unknown): Promise<unknown> })
      .handleListGroups({ search: '群', pagination: { page: 1, page_size: 20 } })

    expect(listGroupsMock).toHaveBeenCalledWith({ keyword: '群', page: 1, pageSize: 20 })
    expect(result).toEqual({
      items: [
        { platform_session_id: '12345@chatroom', group_name: '工作群' },
        { platform_session_id: '6789@chatroom', group_name: '家庭群' },
      ],
      pagination: { page: 1, page_size: 20, total_items: 2, total_pages: 1 },
    })
  })
})

describe('WechatChannel list_contacts handler', () => {
  it('委托 wechat-client.listContacts 并把字段映射到协议', async () => {
    const channel = makeChannel()
    const listContactsMock = vi.fn().mockResolvedValue({
      items: [
        { username: 'wxid_a', nickname: '老李', remark: '李哥', avatar_url: 'https://x' },
      ],
      pagination: { page: 1, pageSize: 20, total: 1, totalPages: 1 },
    })
    ;(channel as unknown as { client: { listContacts: typeof listContactsMock } }).client = { listContacts: listContactsMock } as never

    const result = await (channel as unknown as { handleListContacts(p: unknown): Promise<unknown> })
      .handleListContacts({ search: '李', pagination: { page: 1, page_size: 20 } })

    expect(listContactsMock).toHaveBeenCalledWith({ keyword: '李', page: 1, pageSize: 20 })
    expect(result).toEqual({
      items: [
        { platform_user_id: 'wxid_a', display_name: '老李', remark: '李哥', avatar_url: 'https://x' },
      ],
      pagination: { page: 1, page_size: 20, total_items: 1, total_pages: 1 },
    })
  })
})

describe('WechatChannel capabilities', () => {
  it('上报 supports_list_contacts: true 和 supports_list_groups: true', () => {
    const channel = makeChannel()
    const caps = (channel as unknown as { handleGetCapabilities(): unknown }).handleGetCapabilities()
    expect(caps).toMatchObject({
      supports_list_contacts: true,
      supports_list_groups: true,
    })
  })
})

describe('WechatChannel get_session handler', () => {
  it('session 不存在时抛协议级 NOT_FOUND', () => {
    const channel = makeChannel()
    const invoke = () => (channel as unknown as {
      handleGetSession(params: { session_id: string }): unknown
    }).handleGetSession({ session_id: 'missing' })

    expect(invoke).toThrowError(expect.objectContaining({
      name: 'RpcError',
      code: 'NOT_FOUND',
    }))
  })
})
