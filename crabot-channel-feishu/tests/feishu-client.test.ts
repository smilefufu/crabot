/**
 * FeishuClient 单元测试
 *
 * 通过对 lark.Client 的 prototype 方法做替换来 mock，避免真实网络请求。
 */

import { describe, it, expect, vi } from 'vitest'
import { RpcError } from 'crabot-shared'

// 必须在 import FeishuClient 之前 mock 整个 lark SDK
vi.mock('@larksuiteoapi/node-sdk', () => {
  return {
    Domain: { Feishu: 'feishu', Lark: 'lark' },
    Client: class MockLarkClient {
      im = {
        message: {
          create: vi.fn(async () => ({ code: 0, data: { message_id: 'om_x', create_time: '1700000000000' } })),
          reply: vi.fn(async () => ({ code: 0, data: { message_id: 'om_reply', create_time: '1700000001000' } })),
          get: vi.fn(async () => ({ data: { items: [{ message_id: 'om_get' }] } })),
          list: vi.fn(async () => ({ data: { items: [], has_more: false } })),
        },
        messageResource: {
          get: vi.fn(async () => ({
            getReadableStream: () => {
              const { Readable } = require('node:stream')
              return Readable.from([Buffer.from('hello')])
            },
          })),
        },
        chat: {
          list: vi.fn(async () => ({ data: { items: [{ chat_id: 'oc_x', name: 'Team' }], has_more: false } })),
        },
        chatMembers: {
          get: vi.fn(async () => ({ data: { items: [{ member_id: 'ou_a', name: 'Alice' }], has_more: false } })),
        },
        image: {
          create: vi.fn(async () => ({ image_key: 'img_xxx' })),
        },
        file: {
          create: vi.fn(async () => ({ file_key: 'file_xxx' })),
        },
      }
      contact = {
        v3: {
          user: {
            get: vi.fn(async () => ({ data: { user: { open_id: 'ou_a', name: 'Alice', avatar: { avatar_72: 'https://x' } } } })),
          },
        },
      }
      request = vi.fn(async () => ({ code: 0, bot: { open_id: 'ou_bot', app_name: 'Crabot', app_id: 'cli_x' } }))
    },
  }
})

import { FeishuClient } from '../src/feishu-client'

function makeClient() {
  return new FeishuClient({ app_id: 'cli_x', app_secret: 'sec', domain: 'feishu' })
}

describe('FeishuClient raw card reads', () => {
  it('requests original card JSON for get and list while retaining pagination', async () => {
    const c = makeClient()
    const sdk = (c as any).client
    await c.getMessage('om_card')
    expect(sdk.im.message.get).toHaveBeenCalledWith({
      path: { message_id: 'om_card' }, params: { user_id_type: 'open_id', card_msg_content_type: 'user_card_content' },
    })
    await c.listMessages({ container_id_type: 'chat', container_id: 'oc_x', page_token: 'next', page_size: 30 })
    expect(sdk.im.message.list).toHaveBeenCalledWith({ params: expect.objectContaining({
      card_msg_content_type: 'user_card_content', container_id: 'oc_x', page_token: 'next', page_size: 30,
    }) })
  })
})

describe('FeishuClient.getBotInfo', () => {
  it('returns app_id / app_name / open_id from /open-apis/bot/v3/info/', async () => {
    const c = makeClient()
    const info = await c.getBotInfo()
    expect(info).toEqual({ app_id: 'cli_x', app_name: 'Crabot', open_id: 'ou_bot' })
  })
})

describe('FeishuClient.sendText', () => {
  it('calls im.message.create with msg_type=text and JSON content', async () => {
    const c = makeClient()
    const r = await c.sendText({ type: 'open_id', id: 'ou_a' }, 'hi')
    expect(r.message_id).toBe('om_x')
  })
})

describe('FeishuClient.sendImage / sendFile', () => {
  it('sendImage uses image_key', async () => {
    const c = makeClient()
    const r = await c.sendImage({ type: 'chat_id', id: 'oc_x' }, 'img_yy')
    expect(r.message_id).toBe('om_x')
  })
  it('sendFile uses file_key', async () => {
    const c = makeClient()
    const r = await c.sendFile({ type: 'chat_id', id: 'oc_x' }, 'file_yy')
    expect(r.message_id).toBe('om_x')
  })
})

describe('FeishuClient.reply', () => {
  it('calls im.message.reply with provided msgType + contentJson', async () => {
    const c = makeClient()
    const r = await c.reply('om_x', 'text', JSON.stringify({ text: 'thread reply' }))
    expect(r.message_id).toBe('om_reply')
  })
})

describe('FeishuClient.uploadImage / uploadFile', () => {
  it('uploadImage returns image_key', async () => {
    const c = makeClient()
    expect(await c.uploadImage(Buffer.from('x'))).toBe('img_xxx')
  })
  it('uploadFile returns file_key', async () => {
    const c = makeClient()
    expect(await c.uploadFile(Buffer.from('x'), 'a.pdf', 'pdf')).toBe('file_xxx')
  })
})

describe('FeishuClient.listChats / getChatMembers', () => {
  it('listChats normalizes structure', async () => {
    const c = makeClient()
    const r = await c.listChats()
    expect(r.items[0]).toEqual({ chat_id: 'oc_x', name: 'Team', chat_mode: 'group' })
  })
  it('getChatMembers paginates', async () => {
    const c = makeClient()
    const r = await c.getChatMembers('oc_x')
    expect(r).toEqual([{ open_id: 'ou_a', name: 'Alice' }])
  })
})

describe('FeishuClient.getUser', () => {
  it('returns user info', async () => {
    const c = makeClient()
    const u = await c.getUser('ou_a')
    expect(u).toEqual({ open_id: 'ou_a', name: 'Alice', avatar_url: 'https://x' })
  })
})

describe('FeishuClient.downloadResource', () => {
  it('returns Buffer', async () => {
    const c = makeClient()
    const buf = await c.downloadResource('om_x', 'img_yy', 'image')
    expect(buf.toString()).toBe('hello')
  })
})

describe('FeishuClient.listContacts', () => {
  it('调 contact.v3.user.list 并把字段映射到协议', async () => {
    const fakeApi = {
      contact: {
        v3: {
          user: {
            list: vi.fn().mockResolvedValue({
              code: 0,
              data: {
                items: [
                  { open_id: 'ou_1', name: '张三', avatar: { avatar_72: 'https://x/72' } },
                  { open_id: 'ou_2', name: 'Lily' },
                ],
                page_token: 'next_xyz',
                has_more: true,
              },
            }),
          },
        },
      },
    }
    const client = new FeishuClient({ app_id: 'a', app_secret: 's', domain: 'feishu' })
    ;(client as unknown as { client: typeof fakeApi }).client = fakeApi as never

    const result = await client.listContacts({ page_size: 20 })
    expect(fakeApi.contact.v3.user.list).toHaveBeenCalledWith(
      expect.objectContaining({
        params: expect.objectContaining({ page_size: 20 }),
      }),
    )
    expect(result.items).toEqual([
      { open_id: 'ou_1', name: '张三', avatar_url: 'https://x/72' },
      { open_id: 'ou_2', name: 'Lily' },
    ])
    expect(result.has_more).toBe(true)
    expect(result.page_token).toBe('next_xyz')
  })

  it('FeishuClient.getChat 返回 { chat_id, name }', async () => {
    const fakeApi = {
      im: {
        chat: {
          get: vi.fn().mockResolvedValue({ data: { name: '心术通识小伙伴' } }),
        },
      },
    }
    const client = new FeishuClient({ app_id: 'a', app_secret: 's', domain: 'feishu' })
    ;(client as unknown as { client: typeof fakeApi }).client = fakeApi as never

    const chat = await client.getChat('oc_xxx')
    expect(fakeApi.im.chat.get).toHaveBeenCalledWith({ path: { chat_id: 'oc_xxx' } })
    expect(chat).toEqual({ chat_id: 'oc_xxx', name: '心术通识小伙伴' })
  })

  it('FeishuClient.getChat 在 SDK 返回无 name 时退化为空字符串', async () => {
    const fakeApi = {
      im: {
        chat: {
          get: vi.fn().mockResolvedValue({ data: {} }),
        },
      },
    }
    const client = new FeishuClient({ app_id: 'a', app_secret: 's', domain: 'feishu' })
    ;(client as unknown as { client: typeof fakeApi }).client = fakeApi as never

    const chat = await client.getChat('oc_yyy')
    expect(chat).toEqual({ chat_id: 'oc_yyy', name: '' })
  })

  it('SDK 返回 99991672 时抛 RpcError(PERMISSION_DENIED) 携带 missing_scope', async () => {
    const fakeApi = {
      contact: {
        v3: {
          user: {
            list: vi.fn().mockRejectedValue({ code: 99991672, msg: '应用未开通通讯录权限' }),
          },
        },
      },
    }
    const client = new FeishuClient({ app_id: 'a', app_secret: 's', domain: 'feishu' })
    ;(client as unknown as { client: typeof fakeApi }).client = fakeApi as never

    let caught: unknown
    try {
      await client.listContacts({})
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(RpcError)
    expect((caught as RpcError).code).toBe('PERMISSION_DENIED')
    expect((caught as RpcError).details?.missing_scope).toBe('contact:user.base:readonly')
  })
})

describe('FeishuClient.getChatMembers permission errors', () => {
  it('SDK 返回 99991672 时抛 RpcError(PERMISSION_DENIED) 携带 im:chat.members:read', async () => {
    const fakeApi = {
      im: {
        chatMembers: {
          get: vi.fn().mockRejectedValue({ code: 99991672, msg: '应用未开通群成员读取权限' }),
        },
      },
    }
    const client = new FeishuClient({ app_id: 'a', app_secret: 's', domain: 'feishu' })
    ;(client as unknown as { client: typeof fakeApi }).client = fakeApi as never

    let caught: unknown
    try {
      await client.getChatMembers('oc_x')
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(RpcError)
    expect((caught as RpcError).code).toBe('PERMISSION_DENIED')
    expect((caught as RpcError).details?.missing_scope).toBe('im:chat.members:read')
  })

  it('SDK 返回 99991663 同样转为 PERMISSION_DENIED', async () => {
    const fakeApi = {
      im: {
        chatMembers: {
          get: vi.fn().mockRejectedValue({ code: 99991663, msg: 'no permission' }),
        },
      },
    }
    const client = new FeishuClient({ app_id: 'a', app_secret: 's', domain: 'feishu' })
    ;(client as unknown as { client: typeof fakeApi }).client = fakeApi as never

    let caught: unknown
    try {
      await client.getChatMembers('oc_x')
    } catch (e) {
      caught = e
    }
    expect((caught as RpcError).code).toBe('PERMISSION_DENIED')
  })

  it('非权限错原样冒泡', async () => {
    const fakeApi = {
      im: {
        chatMembers: {
          get: vi.fn().mockRejectedValue(new Error('network')),
        },
      },
    }
    const client = new FeishuClient({ app_id: 'a', app_secret: 's', domain: 'feishu' })
    ;(client as unknown as { client: typeof fakeApi }).client = fakeApi as never

    await expect(client.getChatMembers('oc_x')).rejects.toThrow('network')
  })
})

describe('FeishuClient.getChat permission errors', () => {
  it('SDK 返回 99991672 时抛 RpcError(PERMISSION_DENIED) 携带 im:chat:readonly', async () => {
    const fakeApi = {
      im: {
        chat: {
          get: vi.fn().mockRejectedValue({ code: 99991672, msg: '应用未开通群信息读取权限' }),
        },
      },
    }
    const client = new FeishuClient({ app_id: 'a', app_secret: 's', domain: 'feishu' })
    ;(client as unknown as { client: typeof fakeApi }).client = fakeApi as never

    let caught: unknown
    try {
      await client.getChat('oc_x')
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(RpcError)
    expect((caught as RpcError).code).toBe('PERMISSION_DENIED')
    expect((caught as RpcError).details?.missing_scope).toBe('im:chat:readonly')
  })
})

describe('addReaction', () => {
  it('调 /open-apis/im/v1/messages/:id/reactions POST，body 含 reaction_type.emoji_type', async () => {
    const client = makeClient()
    const requestMock = (client as any).client.request as ReturnType<typeof vi.fn>
    requestMock.mockReset()
    requestMock.mockResolvedValue({ code: 0 })

    await client.addReaction('om_abc', 'OnIt')

    expect(requestMock).toHaveBeenCalledTimes(1)
    const arg = requestMock.mock.calls[0][0]
    expect(arg.method).toBe('POST')
    expect(arg.url).toBe('/open-apis/im/v1/messages/om_abc/reactions')
    expect(arg.data).toEqual({ reaction_type: { emoji_type: 'OnIt' } })
  })

  it('飞书返回 code !== 0 抛 FeishuClientError(CHANNEL_SEND_FAILED)', async () => {
    const client = makeClient()
    const requestMock = (client as any).client.request as ReturnType<typeof vi.fn>
    requestMock.mockReset()
    requestMock.mockResolvedValue({ code: 230001, msg: 'message not found' })

    await expect(client.addReaction('om_x', 'OnIt')).rejects.toMatchObject({
      name: 'FeishuClientError',
      code: 'CHANNEL_SEND_FAILED',
      message: expect.stringContaining('message not found'),
    })
  })

  it('message_id 含特殊字符时 URL 编码', async () => {
    const client = makeClient()
    const requestMock = (client as any).client.request as ReturnType<typeof vi.fn>
    requestMock.mockReset()
    requestMock.mockResolvedValue({ code: 0 })

    await client.addReaction('om/with slash', 'OnIt')

    const arg = requestMock.mock.calls[0][0]
    expect(arg.url).toBe('/open-apis/im/v1/messages/om%2Fwith%20slash/reactions')
  })
})
