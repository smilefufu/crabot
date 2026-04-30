/**
 * FeishuOnboarder 单元测试 — mock fetch，不打真实端点
 */

import { describe, it, expect } from 'vitest'
import { FeishuOnboarder, createOnboarder } from '../src/onboard'
import type { OnboarderEvent } from 'crabot-shared'

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
  return new URLSearchParams(body).get('action') ?? ''
}

describe('createOnboarder', () => {
  it('factory returns Onboarder instance', () => {
    const ob = createOnboarder()
    expect(typeof ob.begin).toBe('function')
    expect(typeof ob.poll).toBe('function')
    expect(typeof ob.finish).toBe('function')
    expect(typeof ob.cancel).toBe('function')
  })
})

describe('begin', () => {
  it('runs init + begin and returns ui_mode=qrcode + verification_uri', async () => {
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
    const ob = new FeishuOnboarder({ fetchImpl })
    const r = await ob.begin()
    expect(initCalled).toBe(true)
    expect(beginCalled).toBe(true)
    expect(r.ui_mode).toBe('qrcode')
    expect(r.session_id).toBeTruthy()
    expect(r.verification_uri).toMatch(/from=onboard/)
    expect(r.interval).toBe(2)
    expect(r.display?.title).toMatch(/扫码/)
  })

  it('throws when client_secret method not supported', async () => {
    const fetchImpl = makeFetch(async () => jsonResponse({ supported_auth_methods: ['authorization_code'] }))
    const ob = new FeishuOnboarder({ fetchImpl })
    await expect(ob.begin()).rejects.toThrow(/不支持 client_secret/)
  })
})

describe('poll', () => {
  it('emits pending then success without payload (per protocol)', async () => {
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
    const ob = new FeishuOnboarder({ fetchImpl, delayMs: async () => {} })
    const { session_id } = await ob.begin()
    const events: OnboarderEvent[] = []
    for await (const ev of ob.poll(session_id)) events.push(ev)
    expect(events.map((e) => e.type)).toEqual(['pending', 'success'])
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
    const ob = new FeishuOnboarder({ fetchImpl, delayMs: async () => {} })
    const { session_id } = await ob.begin()
    const events: OnboarderEvent[] = []
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
    const ob = new FeishuOnboarder({ fetchImpl, delayMs: async () => {} })
    const { session_id } = await ob.begin()
    const events: OnboarderEvent[] = []
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
    const ob = new FeishuOnboarder({ fetchImpl, delayMs: async () => {} })
    const { session_id } = await ob.begin()
    const events: OnboarderEvent[] = []
    for await (const ev of ob.poll(session_id)) events.push(ev)
    expect(events).toEqual([{ type: 'error', code: 'expired_token' }])
  })

  it('emits error on unknown session_id', async () => {
    const ob = new FeishuOnboarder({ fetchImpl: makeFetch(async () => jsonResponse({})) })
    const events: OnboarderEvent[] = []
    for await (const ev of ob.poll('nonexistent')) events.push(ev)
    expect(events).toEqual([{ type: 'error', code: 'session_not_found' }])
  })
})

describe('finish', () => {
  it('returns env including FEISHU_APP_ID/SECRET/DOMAIN/OWNER_OPEN_ID', async () => {
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
    const ob = new FeishuOnboarder({ fetchImpl, delayMs: async () => {} })
    const { session_id } = await ob.begin()
    const events: OnboarderEvent[] = []
    for await (const ev of ob.poll(session_id)) events.push(ev)
    expect(events[0].type).toBe('success')
    const r = await ob.finish(session_id)
    expect(r.env).toMatchObject({
      FEISHU_APP_ID: 'cli_x',
      FEISHU_APP_SECRET: 'secret_x',
      FEISHU_DOMAIN: 'feishu',
      FEISHU_OWNER_OPEN_ID: 'ou_x',
      FEISHU_ONLY_RESPOND_TO_MENTIONS: 'true',
    })
  })

  it('throws when session does not exist or has no result', async () => {
    const ob = new FeishuOnboarder({ fetchImpl: makeFetch(async () => jsonResponse({})) })
    await expect(ob.finish('nope')).rejects.toThrow(/会话不存在/)
  })
})

describe('cancel', () => {
  it('removes the session', async () => {
    const fetchImpl = makeFetch(async (init) => {
      const action = bodyAction(init)
      if (action === 'init') return jsonResponse({ supported_auth_methods: ['client_secret'] })
      if (action === 'begin') return jsonResponse({ device_code: 'dc', verification_uri_complete: 'https://x', interval: 0, expire_in: 600 })
      throw new Error('unexpected')
    })
    const ob = new FeishuOnboarder({ fetchImpl })
    const { session_id } = await ob.begin()
    ob.cancel(session_id)
    const events: OnboarderEvent[] = []
    for await (const ev of ob.poll(session_id)) events.push(ev)
    expect(events).toEqual([{ type: 'error', code: 'session_not_found' }])
  })
})
