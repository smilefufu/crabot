/**
 * DingtalkOnboarder 单元测试（mock fetch）
 */

import { describe, it, expect } from 'vitest'
import { DingtalkOnboarder, createOnboarder } from '../src/onboard'

interface MockResp {
  ok: boolean
  status: number
  body: unknown
}

function mockFetch(resp: MockResp) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = []
  const fn = (async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init })
    return { ok: resp.ok, status: resp.status, json: async () => resp.body } as unknown as Response
  }) as unknown as typeof fetch
  return { fn, calls }
}

describe('begin', () => {
  it('returns a pending session with a guide', async () => {
    const ob = new DingtalkOnboarder()
    const r = await ob.begin()
    expect(r.session_id).toBeTruthy()
    expect(r.ui_mode).toBe('pending')
    expect(r.display?.description).toContain('Stream')
  })
})

describe('poll', () => {
  it('yields success immediately for a known session', async () => {
    const ob = new DingtalkOnboarder()
    const { session_id } = await ob.begin()
    const events = []
    for await (const e of ob.poll(session_id)) events.push(e)
    expect(events).toEqual([{ type: 'success' }])
  })

  it('yields session_not_found for an unknown session', async () => {
    const ob = new DingtalkOnboarder()
    const events = []
    for await (const e of ob.poll('nope')) events.push(e)
    expect(events).toEqual([{ type: 'error', code: 'session_not_found' }])
  })
})

describe('finish', () => {
  it('validates creds and returns env on success', async () => {
    const { fn, calls } = mockFetch({ ok: true, status: 200, body: { accessToken: 'tok', expireIn: 7200 } })
    const ob = new DingtalkOnboarder({ fetchImpl: fn })
    const { session_id } = await ob.begin()
    const r = await ob.finish(session_id, { app_key: 'ak', app_secret: 'as', robot_code: 'rc' })
    expect(r.env).toEqual({
      DINGTALK_APP_KEY: 'ak',
      DINGTALK_APP_SECRET: 'as',
      DINGTALK_ROBOT_CODE: 'rc',
      DINGTALK_ONLY_RESPOND_TO_MENTIONS: 'true',
    })
    expect(calls[0].url).toContain('oauth2/accessToken')
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ appKey: 'ak', appSecret: 'as' })
  })

  it('throws when required creds are missing', async () => {
    const ob = new DingtalkOnboarder()
    const { session_id } = await ob.begin()
    await expect(ob.finish(session_id, { app_key: 'ak' })).rejects.toThrow()
  })

  it('throws when credential validation fails', async () => {
    const { fn } = mockFetch({ ok: false, status: 401, body: { code: 'InvalidAuth', message: 'bad key' } })
    const ob = new DingtalkOnboarder({ fetchImpl: fn })
    const { session_id } = await ob.begin()
    await expect(
      ob.finish(session_id, { app_key: 'ak', app_secret: 'as', robot_code: 'rc' })
    ).rejects.toThrow('钉钉凭据校验失败')
  })

  it('throws for an unknown session', async () => {
    const ob = new DingtalkOnboarder()
    await expect(ob.finish('nope', { app_key: 'ak', app_secret: 'as', robot_code: 'rc' })).rejects.toThrow()
  })
})

describe('cancel + factory', () => {
  it('cancel drops the session so finish fails', async () => {
    const ob = new DingtalkOnboarder()
    const { session_id } = await ob.begin()
    ob.cancel(session_id)
    await expect(ob.finish(session_id, { app_key: 'a', app_secret: 'b', robot_code: 'c' })).rejects.toThrow()
  })

  it('createOnboarder returns a working instance', async () => {
    const ob = createOnboarder()
    const r = await ob.begin()
    expect(r.ui_mode).toBe('pending')
  })
})
