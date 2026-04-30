/**
 * FeishuClient 单元测试
 *
 * 通过对 lark.Client 的 prototype 方法做替换来 mock，避免真实网络请求。
 */

import { describe, it, expect, vi } from 'vitest'

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
