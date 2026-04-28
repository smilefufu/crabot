import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { AdminClient } from './client.js'
import { CliError, ErrorCode } from './errors.js'

interface MockResponseInit {
  readonly status?: number
  readonly body?: unknown
  readonly bodyText?: string
}

function bodyToText(init: MockResponseInit): string {
  if (init.bodyText !== undefined) return init.bodyText
  if (init.body !== undefined) return JSON.stringify(init.body)
  return ''
}

function makeResponse(init: MockResponseInit = {}): Response {
  return new Response(bodyToText(init), { status: init.status ?? 200 })
}

const auth = { endpoint: 'http://localhost:3000', token: 'tk-secret' } as const
const client = new AdminClient(auth)

describe('AdminClient', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue(makeResponse({ body: { ok: true } }))
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  describe('URL & headers', () => {
    it('endpoint 末尾的 / 不会和 path 拼出双斜杠', async () => {
      const trailingSlashClient = new AdminClient({ endpoint: 'http://localhost:3000/', token: 'tk' })
      await trailingSlashClient.get('/api/agents')
      expect(fetchMock).toHaveBeenCalledWith(
        'http://localhost:3000/api/agents',
        expect.anything()
      )
    })

    it('path 缺少前导 / 时自动补全', async () => {
      await client.get('api/agents')
      expect(fetchMock).toHaveBeenCalledWith(
        'http://localhost:3000/api/agents',
        expect.anything()
      )
    })

    it('Authorization Bearer 头部注入', async () => {
      await client.get('/api/agents')
      const init = fetchMock.mock.calls[0]?.[1] as RequestInit
      expect(init.headers).toMatchObject({
        'Authorization': 'Bearer tk-secret',
        'Content-Type': 'application/json',
      })
    })

    it('post 带 body 时序列化为 JSON 字符串', async () => {
      await client.post('/api/agents', { name: 'foo' })
      const init = fetchMock.mock.calls[0]?.[1] as RequestInit
      expect(init.method).toBe('POST')
      expect(init.body).toBe('{"name":"foo"}')
    })

    it('post 无 body 时 body=undefined（不发空字符串）', async () => {
      await client.post('/api/agents/abc/restart')
      const init = fetchMock.mock.calls[0]?.[1] as RequestInit
      expect(init.body).toBeUndefined()
    })

    it('patch 必须带 body 且序列化', async () => {
      await client.patch('/api/agents/abc', { enabled: true })
      const init = fetchMock.mock.calls[0]?.[1] as RequestInit
      expect(init.method).toBe('PATCH')
      expect(init.body).toBe('{"enabled":true}')
    })

    it('delete 走 DELETE method', async () => {
      await client.delete('/api/agents/abc')
      const init = fetchMock.mock.calls[0]?.[1] as RequestInit
      expect(init.method).toBe('DELETE')
    })
  })

  describe('错误映射', () => {
    it('fetch 抛出（连不上）→ ADMIN_UNREACHABLE', async () => {
      fetchMock.mockRejectedValue(new Error('ECONNREFUSED'))
      await expect(client.get('/x')).rejects.toMatchObject({
        code: ErrorCode.ADMIN_UNREACHABLE,
        exitCode: 2,
      })
    })

    it('404 → NOT_FOUND', async () => {
      fetchMock.mockResolvedValue(makeResponse({ status: 404, body: { message: 'not found' } }))
      await expect(client.get('/x')).rejects.toMatchObject({
        code: ErrorCode.NOT_FOUND,
        exitCode: 1,
        message: 'not found',
      })
    })

    it('401 → PERMISSION_DENIED', async () => {
      fetchMock.mockResolvedValue(makeResponse({ status: 401, body: { message: 'auth' } }))
      await expect(client.get('/x')).rejects.toMatchObject({ code: ErrorCode.PERMISSION_DENIED })
    })

    it('403 → PERMISSION_DENIED', async () => {
      fetchMock.mockResolvedValue(makeResponse({ status: 403, body: { message: 'forbidden' } }))
      await expect(client.get('/x')).rejects.toMatchObject({ code: ErrorCode.PERMISSION_DENIED })
    })

    it('500 → INTERNAL_ERROR 且 details.upstream_status=500', async () => {
      fetchMock.mockResolvedValue(makeResponse({ status: 500, body: { message: 'boom' } }))
      let caught: CliError | null = null
      try {
        await client.get('/x')
      } catch (e) {
        caught = e as CliError
      }
      expect(caught).toBeInstanceOf(CliError)
      expect(caught?.code).toBe(ErrorCode.INTERNAL_ERROR)
      expect(caught?.details).toMatchObject({ upstream_status: 500 })
    })

    it('错误 body 用 message 字段', async () => {
      fetchMock.mockResolvedValue(makeResponse({ status: 500, body: { message: 'M' } }))
      await expect(client.get('/x')).rejects.toMatchObject({ message: 'M' })
    })

    it('错误 body 缺 message 时回退到 error 字段', async () => {
      fetchMock.mockResolvedValue(makeResponse({ status: 500, body: { error: 'E' } }))
      await expect(client.get('/x')).rejects.toMatchObject({ message: 'E' })
    })

    it('错误 body 是纯字符串时直接当 message', async () => {
      fetchMock.mockResolvedValue(makeResponse({ status: 500, bodyText: 'plain text error' }))
      await expect(client.get('/x')).rejects.toMatchObject({ message: 'plain text error' })
    })

    it('错误 body 既无 message 也无 error 时回退到 "HTTP <status>"', async () => {
      fetchMock.mockResolvedValue(makeResponse({ status: 500, body: { other: 'x' } }))
      await expect(client.get('/x')).rejects.toMatchObject({ message: 'HTTP 500' })
    })
  })

  describe('getList 归一化', () => {
    it('admin 返回 bare array → 直接返回', async () => {
      fetchMock.mockResolvedValue(makeResponse({ body: [{ id: '1' }, { id: '2' }] }))
      expect(await client.getList<{ id: string }>('/api/agents')).toEqual([{ id: '1' }, { id: '2' }])
    })

    it('admin 返回 {items: []} 格式 → 解包', async () => {
      fetchMock.mockResolvedValue(makeResponse({ body: { items: [{ id: '1' }] } }))
      expect(await client.getList<{ id: string }>('/api/agents')).toEqual([{ id: '1' }])
    })

    it('admin 返回非数组、非 {items:[]} → 安全返回 []', async () => {
      fetchMock.mockResolvedValue(makeResponse({ body: { something: 'else' } }))
      expect(await client.getList('/api/agents')).toEqual([])
    })

    it('admin 返回 null → 安全返回 []', async () => {
      fetchMock.mockResolvedValue(makeResponse({ body: null }))
      expect(await client.getList('/api/agents')).toEqual([])
    })
  })
})
