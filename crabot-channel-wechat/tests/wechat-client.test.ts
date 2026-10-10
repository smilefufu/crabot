import { describe, it, expect } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { WechatClient } from '../src/wechat-client.js'

interface RecordedRequest {
  method: string
  url: string
  authorization: string | undefined
}

function createFakeServer(respond: (req: RecordedRequest) => { status?: number; body: unknown }) {
  const recorded: RecordedRequest[] = []
  const server = http.createServer((req, res) => {
    const recordedReq: RecordedRequest = {
      method: req.method ?? '',
      url: req.url ?? '',
      authorization: req.headers['authorization'] as string | undefined,
    }
    recorded.push(recordedReq)
    const { status = 200, body } = respond(recordedReq)
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(body))
  })
  return { server, recorded }
}

async function listen(server: http.Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return `http://127.0.0.1:${port}`
}

describe('WechatClient.listGroups', () => {
  it('calls GET /api/v1/bot/groups with page and pageSize query', async () => {
    const { server, recorded } = createFakeServer(() => ({
      body: {
        code: 0,
        data: {
          items: [
            {
              fieldChatroomName: '12345@chatroom',
              fieldChatroomNick: '工作群',
              fieldMemberCount: 8,
            },
          ],
          total: 1,
          page: 1,
          pageSize: 20,
        },
      },
    }))
    const base = await listen(server)
    try {
      const client = new WechatClient(base, 'wct_test')
      const result = await client.listGroups({ page: 1, pageSize: 20 })

      expect(recorded).toHaveLength(1)
      expect(recorded[0].method).toBe('GET')
      expect(recorded[0].url).toBe('/api/v1/bot/groups?page=1&pageSize=20')
      expect(recorded[0].authorization).toBe('Bearer wct_test')

      expect(result.items).toEqual([
        { chatroomName: '12345@chatroom', name: '工作群' },
      ])
      expect(result.pagination).toEqual({
        page: 1,
        pageSize: 20,
        total: 1,
        totalPages: 1,
      })
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it('includes keyword when provided', async () => {
    const { server, recorded } = createFakeServer(() => ({
      body: { code: 0, data: { items: [], total: 0, page: 1, pageSize: 20 } },
    }))
    const base = await listen(server)
    try {
      const client = new WechatClient(base, 'wct_test')
      await client.listGroups({ keyword: '工作群', page: 1, pageSize: 20 })

      expect(recorded[0].url).toBe(
        `/api/v1/bot/groups?keyword=${encodeURIComponent('工作群')}&page=1&pageSize=20`
      )
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it('falls back to chatroomName when fieldChatroomNick is missing', async () => {
    const { server } = createFakeServer(() => ({
      body: {
        code: 0,
        data: {
          items: [{ fieldChatroomName: 'abc@chatroom' }],
          total: 1,
          page: 1,
          pageSize: 20,
        },
      },
    }))
    const base = await listen(server)
    try {
      const client = new WechatClient(base, 'wct_test')
      const result = await client.listGroups({ page: 1, pageSize: 20 })
      expect(result.items).toEqual([
        { chatroomName: 'abc@chatroom', name: 'abc@chatroom' },
      ])
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})

describe('WechatClient.listContacts', () => {
  it('calls GET /api/v1/bot/contacts with keyword/page/pageSize 并把字段映射到协议', async () => {
    const { server, recorded } = createFakeServer(() => ({
      body: {
        code: 0,
        data: {
          items: [
            {
              fieldUsername: 'wxid_test1',
              fieldNickname: '测试联系人',
              fieldConRemark: '老李',
              iconUrl: 'https://avatar.example/1.png',
            },
            {
              fieldUsername: 'wxid_test2',
              fieldNickname: 'Bob',
            },
          ],
          total: 2,
          page: 1,
          pageSize: 20,
        },
      },
    }))
    const base = await listen(server)
    try {
      const client = new WechatClient(base, 'wct_test')
      const result = await client.listContacts({ keyword: '测试', page: 1, pageSize: 20 })

      expect(recorded).toHaveLength(1)
      expect(recorded[0].method).toBe('GET')
      expect(recorded[0].url).toBe('/api/v1/bot/contacts?keyword=%E6%B5%8B%E8%AF%95&page=1&pageSize=20')
      expect(recorded[0].authorization).toBe('Bearer wct_test')
      expect(result.items).toEqual([
        { username: 'wxid_test1', nickname: '测试联系人', remark: '老李', avatar_url: 'https://avatar.example/1.png' },
        { username: 'wxid_test2', nickname: 'Bob' },
      ])
      expect(result.pagination.total).toBe(2)
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it('未传参时不带任何 query', async () => {
    const { server, recorded } = createFakeServer(() => ({
      body: { code: 0, data: { items: [], total: 0, page: 1, pageSize: 20 } },
    }))
    const base = await listen(server)
    try {
      const client = new WechatClient(base, 'wct_test')
      await client.listContacts()
      expect(recorded[0].url).toBe('/api/v1/bot/contacts')
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})


it('单条消息只把 404 视为不存在，查询服务故障必须保留为错误', async () => {
  const { server } = createFakeServer(req => req.url.endsWith('/missing')
    ? { status: 404, body: { code: -1, message: '消息不存在' } }
    : { status: 503, body: { code: -1, message: 'unavailable' } })
  const base = await listen(server)
  try {
    const client = new WechatClient(base, 'wct_test')
    expect(await client.getMessageById('missing')).toBeNull()
    await expect(client.getMessageById('unavailable')).rejects.toThrow('HTTP 503')
  } finally { await new Promise<void>(resolve => server.close(() => resolve())) }
})
