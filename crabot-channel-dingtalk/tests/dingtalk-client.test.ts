/**
 * DingtalkClient 单元测试（mock fetch + 可注入 now）
 *
 * 覆盖：token 缓存/过期刷新、group/oTo 请求体与鉴权 header、错误码映射、auth 失效重试。
 */

import { describe, it, expect } from 'vitest'
import { DingtalkClient, DingtalkClientError } from '../src/dingtalk-client'

const OAUTH_URL = 'https://api.dingtalk.com/v1.0/oauth2/accessToken'
const GROUP_SEND_URL = 'https://api.dingtalk.com/v1.0/robot/groupMessages/send'
const OTO_SEND_URL = 'https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend'

interface MockResp {
  ok: boolean
  status: number
  body: unknown
}

function mockFetch(handlers: Record<string, () => MockResp>) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = []
  const fn = (async (url: unknown, init?: RequestInit) => {
    const u = String(url)
    calls.push({ url: u, init })
    const h = handlers[u]
    if (!h) throw new Error('no mock handler for ' + u)
    const r = h()
    return {
      ok: r.ok,
      status: r.status,
      json: async () => r.body,
    } as unknown as Response
  }) as unknown as typeof fetch
  return { fn, calls }
}

function tokenOk(token = 't1', expireIn = 7200): MockResp {
  return { ok: true, status: 200, body: { accessToken: token, expireIn } }
}

function bodyOf(init: RequestInit | undefined): Record<string, unknown> {
  return JSON.parse(String(init?.body)) as Record<string, unknown>
}

describe('getAccessToken caching', () => {
  it('caches the token: second call within TTL does not re-fetch', async () => {
    const { fn, calls } = mockFetch({ [OAUTH_URL]: () => tokenOk() })
    const client = new DingtalkClient({
      appKey: 'ak', appSecret: 'as', robotCode: 'robot-1', fetchImpl: fn, now: () => 1000,
    })
    expect(await client.getAccessToken()).toBe('t1')
    expect(await client.getAccessToken()).toBe('t1')
    expect(calls.filter((c) => c.url === OAUTH_URL)).toHaveLength(1)
  })

  it('refreshes the token after it expires', async () => {
    let n = 0
    let now = 1000
    const { fn, calls } = mockFetch({
      [OAUTH_URL]: () => { n += 1; return tokenOk(`t${n}`, 7200) },
    })
    const client = new DingtalkClient({
      appKey: 'ak', appSecret: 'as', robotCode: 'robot-1', fetchImpl: fn, now: () => now,
    })
    expect(await client.getAccessToken()).toBe('t1')
    now = 1000 + 7200 * 1000 // advance past expiry
    expect(await client.getAccessToken()).toBe('t2')
    expect(calls.filter((c) => c.url === OAUTH_URL)).toHaveLength(2)
  })
})

describe('sendGroupMessage', () => {
  it('sends correct body + auth header and returns processQueryKey', async () => {
    const { fn, calls } = mockFetch({
      [OAUTH_URL]: () => tokenOk(),
      [GROUP_SEND_URL]: () => ({ ok: true, status: 200, body: { processQueryKey: 'pqk-1' } }),
    })
    const client = new DingtalkClient({ appKey: 'ak', appSecret: 'as', robotCode: 'robot-1', fetchImpl: fn, now: () => 1000 })
    const key = await client.sendGroupMessage('ocid-1', 'sampleText', { content: 'hi' })
    expect(key).toBe('pqk-1')

    const groupCall = calls.find((c) => c.url === GROUP_SEND_URL)!
    expect((groupCall.init?.headers as Record<string, string>)['x-acs-dingtalk-access-token']).toBe('t1')
    expect(bodyOf(groupCall.init)).toEqual({
      robotCode: 'robot-1',
      openConversationId: 'ocid-1',
      msgKey: 'sampleText',
      msgParam: JSON.stringify({ content: 'hi' }),
    })
  })
})

describe('sendOneToOneMessage', () => {
  it('sends userIds array with sampleMarkdown', async () => {
    const { fn, calls } = mockFetch({
      [OAUTH_URL]: () => tokenOk(),
      [OTO_SEND_URL]: () => ({ ok: true, status: 200, body: { processQueryKey: 'pqk-2' } }),
    })
    const client = new DingtalkClient({ appKey: 'ak', appSecret: 'as', robotCode: 'robot-1', fetchImpl: fn, now: () => 1000 })
    const key = await client.sendOneToOneMessage(['staff_a'], 'sampleMarkdown', { title: 'T', text: '# H' })
    expect(key).toBe('pqk-2')

    const otoCall = calls.find((c) => c.url === OTO_SEND_URL)!
    expect(bodyOf(otoCall.init)).toEqual({
      robotCode: 'robot-1',
      userIds: ['staff_a'],
      msgKey: 'sampleMarkdown',
      msgParam: JSON.stringify({ title: 'T', text: '# H' }),
    })
  })
})

describe('error mapping', () => {
  it('maps 429 to RATE_LIMITED (no retry)', async () => {
    const { fn, calls } = mockFetch({
      [OAUTH_URL]: () => tokenOk(),
      [GROUP_SEND_URL]: () => ({ ok: false, status: 429, body: { code: 'flowControl', message: 'slow down' } }),
    })
    const client = new DingtalkClient({ appKey: 'ak', appSecret: 'as', robotCode: 'robot-1', fetchImpl: fn, now: () => 1000 })
    await expect(client.sendGroupMessage('ocid', 'sampleText', { content: 'x' })).rejects.toMatchObject({
      code: 'RATE_LIMITED',
    })
    expect(calls.filter((c) => c.url === GROUP_SEND_URL)).toHaveLength(1)
  })

  it('maps 404 to NOT_FOUND', async () => {
    const { fn } = mockFetch({
      [OAUTH_URL]: () => tokenOk(),
      [GROUP_SEND_URL]: () => ({ ok: false, status: 404, body: { code: 'conversationNotFound' } }),
    })
    const client = new DingtalkClient({ appKey: 'ak', appSecret: 'as', robotCode: 'robot-1', fetchImpl: fn, now: () => 1000 })
    await expect(client.sendGroupMessage('ocid', 'sampleText', { content: 'x' })).rejects.toBeInstanceOf(DingtalkClientError)
    await expect(client.sendGroupMessage('ocid', 'sampleText', { content: 'x' })).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('on auth failure clears token and retries once, then throws PERMISSION_DENIED', async () => {
    const { fn, calls } = mockFetch({
      [OAUTH_URL]: () => tokenOk(),
      [GROUP_SEND_URL]: () => ({ ok: false, status: 401, body: { code: 'InvalidAuthentication' } }),
    })
    const client = new DingtalkClient({ appKey: 'ak', appSecret: 'as', robotCode: 'robot-1', fetchImpl: fn, now: () => 1000 })
    await expect(client.sendGroupMessage('ocid', 'sampleText', { content: 'x' })).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
    })
    // token re-fetched on retry (2x oauth), group send attempted twice
    expect(calls.filter((c) => c.url === OAUTH_URL)).toHaveLength(2)
    expect(calls.filter((c) => c.url === GROUP_SEND_URL)).toHaveLength(2)
  })
})
