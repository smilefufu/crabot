/**
 * FeishuOnboard 单元测试 — 用 mock fetch，不打真实端点
 */

import { describe, it, expect, vi } from 'vitest'
import { FeishuOnboard, type PollEvent } from './feishu-onboard.js'

interface FetchHandler {
  (init: RequestInit | undefined): Response | Promise<Response>
}

function makeFetch(handler: FetchHandler): typeof fetch {
  return (async (_url: string | URL, init?: RequestInit) => handler(init)) as typeof fetch
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function bodyAction(init: RequestInit | undefined): string {
  const body = init?.body
  if (typeof body !== 'string') return ''
  const params = new URLSearchParams(body)
  return params.get('action') ?? ''
}

describe('FeishuOnboard.begin', () => {
  it('runs init + begin and returns session info', async () => {
    let initCalled = false
    let beginCalled = false
    const fetchImpl = makeFetch(async (init) => {
      const action = bodyAction(init)
      if (action === 'init') {
        initCalled = true
        return jsonResponse({ supported_auth_methods: ['client_secret'] })
      }
      if (action === 'begin') {
        beginCalled = true
        return jsonResponse({
          device_code: 'dc1',
          verification_uri_complete: 'https://feishu.cn/qr',
          interval: 2,
          expire_in: 600,
        })
      }
      throw new Error(`unexpected action: ${action}`)
    })
    const ob = new FeishuOnboard({ fetchImpl, delayMs: async () => {} })
    const r = await ob.begin()
    expect(initCalled).toBe(true)
    expect(beginCalled).toBe(true)
    expect(r.session_id).toBeTruthy()
    expect(r.verification_uri).toMatch(/from=onboard/)
    expect(r.interval).toBe(2)
  })

  it('throws when client_secret method not supported', async () => {
    const fetchImpl = makeFetch(async () => jsonResponse({ supported_auth_methods: ['authorization_code'] }))
    const ob = new FeishuOnboard({ fetchImpl, delayMs: async () => {} })
    await expect(ob.begin()).rejects.toThrow(/不支持 client_secret/)
  })
})

describe('FeishuOnboard.poll', () => {
  it('emits pending then success with credentials', async () => {
    let pollCount = 0
    const fetchImpl = makeFetch(async (init) => {
      const action = bodyAction(init)
      if (action === 'init') return jsonResponse({ supported_auth_methods: ['client_secret'] })
      if (action === 'begin') return jsonResponse({ device_code: 'dc', verification_uri_complete: 'https://x', interval: 0, expire_in: 600 })
      if (action === 'poll') {
        pollCount += 1
        if (pollCount === 1) return jsonResponse({ error: 'authorization_pending' })
        return jsonResponse({
          client_id: 'cli_x',
          client_secret: 'secret_x',
          user_info: { open_id: 'ou_x', tenant_brand: 'feishu' },
        })
      }
      throw new Error(`unexpected: ${action}`)
    })
    const ob = new FeishuOnboard({ fetchImpl, delayMs: async () => {} })
    const { session_id } = await ob.begin()
    const events: PollEvent[] = []
    for await (const ev of ob.poll(session_id)) events.push(ev)
    expect(events.map((e) => e.type)).toEqual(['pending', 'success'])
    expect(events[1]).toMatchObject({ app_id: 'cli_x', app_secret: 'secret_x', open_id: 'ou_x', domain: 'feishu' })
  })

  it('emits slow_down when server says so', async () => {
    let pollCount = 0
    const fetchImpl = makeFetch(async (init) => {
      const action = bodyAction(init)
      if (action === 'init') return jsonResponse({ supported_auth_methods: ['client_secret'] })
      if (action === 'begin') return jsonResponse({ device_code: 'dc', verification_uri_complete: 'https://x', interval: 0, expire_in: 600 })
      if (action === 'poll') {
        pollCount += 1
        if (pollCount === 1) return jsonResponse({ error: 'slow_down' })
        return jsonResponse({ client_id: 'cli_x', client_secret: 'secret_x', user_info: { open_id: 'ou' } })
      }
      throw new Error('unexpected')
    })
    const ob = new FeishuOnboard({ fetchImpl, delayMs: async () => {} })
    const { session_id } = await ob.begin()
    const events: PollEvent[] = []
    for await (const ev of ob.poll(session_id)) events.push(ev)
    expect(events.map((e) => e.type)).toEqual(['slow_down', 'success'])
  })

  it('emits access_denied error and stops', async () => {
    const fetchImpl = makeFetch(async (init) => {
      const action = bodyAction(init)
      if (action === 'init') return jsonResponse({ supported_auth_methods: ['client_secret'] })
      if (action === 'begin') return jsonResponse({ device_code: 'dc', verification_uri_complete: 'https://x', interval: 0, expire_in: 600 })
      if (action === 'poll') return jsonResponse({ error: 'access_denied' })
      throw new Error('unexpected')
    })
    const ob = new FeishuOnboard({ fetchImpl, delayMs: async () => {} })
    const { session_id } = await ob.begin()
    const events: PollEvent[] = []
    for await (const ev of ob.poll(session_id)) events.push(ev)
    expect(events).toEqual([{ type: 'error', code: 'access_denied' }])
  })

  it('emits expired_token error and stops', async () => {
    const fetchImpl = makeFetch(async (init) => {
      const action = bodyAction(init)
      if (action === 'init') return jsonResponse({ supported_auth_methods: ['client_secret'] })
      if (action === 'begin') return jsonResponse({ device_code: 'dc', verification_uri_complete: 'https://x', interval: 0, expire_in: 600 })
      if (action === 'poll') return jsonResponse({ error: 'expired_token' })
      throw new Error('unexpected')
    })
    const ob = new FeishuOnboard({ fetchImpl, delayMs: async () => {} })
    const { session_id } = await ob.begin()
    const events: PollEvent[] = []
    for await (const ev of ob.poll(session_id)) events.push(ev)
    expect(events).toEqual([{ type: 'error', code: 'expired_token' }])
  })
})

describe('FeishuOnboard.finish', () => {
  it('calls channelManager.createInstance with feishu env', async () => {
    let pollCalled = false
    const fetchImpl = makeFetch(async (init) => {
      const action = bodyAction(init)
      if (action === 'init') return jsonResponse({ supported_auth_methods: ['client_secret'] })
      if (action === 'begin') return jsonResponse({ device_code: 'dc', verification_uri_complete: 'https://x', interval: 0, expire_in: 600 })
      if (action === 'poll' && !pollCalled) {
        pollCalled = true
        return jsonResponse({
          client_id: 'cli_x',
          client_secret: 'secret_x',
          user_info: { open_id: 'ou_x', tenant_brand: 'feishu' },
        })
      }
      throw new Error('unexpected')
    })
    const cm = { createInstance: vi.fn(async (p: any) => ({ id: p.name })) }
    const ob = new FeishuOnboard({ fetchImpl, channelManager: cm, delayMs: async () => {} })
    const { session_id } = await ob.begin()
    const events: PollEvent[] = []
    for await (const ev of ob.poll(session_id)) events.push(ev)
    expect(events[0].type).toBe('success')
    const inst = await ob.finish(session_id, { name: 'feishu-bot-1' })
    expect(cm.createInstance).toHaveBeenCalledWith({
      implementation_id: 'channel-feishu',
      name: 'feishu-bot-1',
      auto_start: true,
      env: expect.objectContaining({
        FEISHU_APP_ID: 'cli_x',
        FEISHU_APP_SECRET: 'secret_x',
        FEISHU_DOMAIN: 'feishu',
        FEISHU_OWNER_OPEN_ID: 'ou_x',
      }),
    })
    expect(inst).toEqual({ id: 'feishu-bot-1' })
  })

  it('throws when session not found / not yet succeeded', async () => {
    const ob = new FeishuOnboard({ fetchImpl: makeFetch(async () => jsonResponse({})), channelManager: { createInstance: vi.fn() } })
    await expect(ob.finish('nope', { name: 'x' })).rejects.toThrow(/会话不存在/)
  })
})

describe('FeishuOnboard.cancel', () => {
  it('removes the session', async () => {
    const fetchImpl = makeFetch(async (init) => {
      const action = bodyAction(init)
      if (action === 'init') return jsonResponse({ supported_auth_methods: ['client_secret'] })
      if (action === 'begin') return jsonResponse({ device_code: 'dc', verification_uri_complete: 'https://x', interval: 0, expire_in: 600 })
      throw new Error('unexpected')
    })
    const ob = new FeishuOnboard({ fetchImpl, delayMs: async () => {} })
    const { session_id } = await ob.begin()
    ob.cancel(session_id)
    // poll should now emit error
    const events: PollEvent[] = []
    for await (const ev of ob.poll(session_id)) events.push(ev)
    expect(events).toEqual([{ type: 'error', code: 'session_not_found' }])
  })
})
