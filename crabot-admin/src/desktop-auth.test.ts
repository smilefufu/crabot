import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHmac } from 'node:crypto'
import { AdminModule } from './index.js'
import { newCredentialsFromPassword, rotateCredentials, writeCredentials } from './credentials.js'

const secret = 'isolated-test-signing-key'
function jwt(payload: Record<string, unknown>, key = secret) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
  const body = Buffer.from(JSON.stringify({ iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 900, ...payload })).toString('base64url')
  return `${header}.${body}.${createHmac('sha256', key).update(`${header}.${body}`).digest('base64url')}`
}

describe('Desktop token branch preserves legacy authority and requires a live registered human session', () => {
  let data: string, admin: any
  const desktop = { session_id: 'session-one', instance_id: 'current-instance', generation: 'current-generation' }
  beforeEach(async () => {
    data = await mkdtemp(join(tmpdir(), 'crabot-desktop-auth-'))
    // Actual Admin methods, without starting MM, models, stores or listeners.
    admin = Object.create(AdminModule.prototype)
    admin.adminConfig = { data_dir: data, web_port: 3000 }; admin.jwtSecret = secret
    admin.desktopSessions = { validate: vi.fn((claims: unknown) => JSON.stringify(claims) === JSON.stringify(desktop)) }
  })
  afterEach(async () => { await rm(data, { recursive: true, force: true }) })

  it('internal retains management authentication without credentials and never becomes human', async () => {
    const token = jwt({ sub: 'internal' })
    expect((await admin.verifyAuthenticatedToken(token))?.sub).toBe('internal')
    expect(await admin.verifyHumanToken(token)).toBeNull()
    expect(admin.desktopSessions.validate).not.toHaveBeenCalled()
  })

  it('password epoch validation preserves revocation and absent-credentials behavior', async () => {
    const token = jwt({ sub: 'admin', e: 0 })
    expect(await admin.verifyAuthenticatedToken(token)).toBeNull()
    const cred = await newCredentialsFromPassword('fixture-only', { is_temp: false, changed_via: 'ui' })
    await writeCredentials(data, cred)
    expect((await admin.verifyHumanToken(token))?.sub).toBe('admin')
    await writeCredentials(data, await rotateCredentials(cred, 'new-fixture-only', 'ui'))
    expect(await admin.verifyAuthenticatedToken(token)).toBeNull()
    expect(admin.desktopSessions.validate).not.toHaveBeenCalled()
  })

  it('Agent CLI and altered internal claims cannot obtain desktop/human identity', async () => {
    await writeCredentials(data, await newCredentialsFromPassword('fixture-only', { is_temp: false, changed_via: 'ui' }))
    for (const payload of [{ sub: 'agent-cli', e: 0, agent_cli: {} }, { sub: 'internal', desktop }, { sub: 'admin', e: 0, desktop, agent_cli: {} }]) {
      expect(await admin.verifyHumanToken(jwt(payload))).toBeNull()
    }
  })

  it('only a signed, unexpired registered desktop session works without a browser password', async () => {
    expect((await admin.verifyHumanToken(jwt({ sub: 'admin', e: 0, desktop })))?.desktop).toEqual(desktop)
    for (const token of [jwt({ sub: 'admin', e: 0, desktop }, 'wrong-key'), jwt({ sub: 'admin', e: 0, desktop, exp: 1 }),
      jwt({ sub: 'admin', e: 0, desktop: { ...desktop, generation: 'old-generation' } }),
      jwt({ sub: 'admin', e: 0, desktop: { ...desktop, session_id: 'unregistered' } })]) {
      expect(await admin.verifyHumanToken(token)).toBeNull()
    }
    admin.desktopSessions = undefined
    expect(await admin.verifyHumanToken(jwt({ sub: 'admin', e: 0, desktop }))).toBeNull()
    const valid = jwt({ sub: 'admin', e: 0, desktop })
    expect(await admin.verifyHumanToken(valid.slice(0, valid.lastIndexOf('.') + 1) + '坏'.repeat(43))).toBeNull()
  })

  it('a desktop-looking token never falls back to ordinary password validation', async () => {
    await writeCredentials(data, await newCredentialsFromPassword('fixture-only', { is_temp: false, changed_via: 'ui' }))
    expect(await admin.verifyAuthenticatedToken(jwt({ sub: 'admin', e: 0, desktop: { ...desktop, session_id: 'unregistered' } }))).toBeNull()
    expect(await admin.verifyHumanToken(jwt({ sub: 'admin', e: 7, desktop }))).toBeNull()
  })

  function response() { return { writeHead: vi.fn(), end: vi.fn(), setHeader: vi.fn() } }

  it('GET me exposes the no-password desktop state and login remains unavailable', async () => {
    const token = jwt({ sub: 'admin', e: 0, desktop }), res = response()
    await admin.handleGetMe({ headers: { authorization: `Bearer ${token}` } }, res)
    expect(JSON.parse(res.end.mock.calls[0][0])).toEqual({ is_temp: false, password_configured: false, auth_method: 'desktop' })
    admin.readJsonBody = vi.fn().mockResolvedValue({ password: '' })
    const denied = response()
    await admin.handleLogin({}, denied)
    expect(denied.writeHead.mock.calls[0][0]).toBe(503)
  })

  it('only registered desktop can initialize a password; existing password still requires the old one', async () => {
    admin.readJsonBody = vi.fn().mockResolvedValue({ new_password: 'explicit-first-password' })
    for (const token of ['', jwt({ sub: 'internal' }), jwt({ sub: 'agent-cli', e: 0 })]) {
      const res = response()
      await admin.handleChangePassword({ headers: token ? { authorization: `Bearer ${token}` } : {} }, res)
      expect([401, 403]).toContain(res.writeHead.mock.calls[0][0])
    }
    expect(admin.readJsonBody).not.toHaveBeenCalled()
    const token = jwt({ sub: 'admin', e: 0, desktop }), headers = { authorization: `Bearer ${token}` }
    const first = response(), second = response()
    await Promise.all([admin.handleChangePassword({ headers }, first), admin.handleChangePassword({ headers }, second)])
    expect([first, second].map(res => res.writeHead.mock.calls[0][0]).sort()).toEqual([200, 409])
    const existing = response()
    await admin.handleChangePassword({ headers }, existing)
    expect(existing.writeHead.mock.calls[0][0]).toBe(400)
  })

  it('HTTP retains internal management access, rejects it for human Chat, and reports desktop revocation accurately', async () => {
    admin.cutoverActivated = true
    admin.voiceAdmin = { handleWeb: vi.fn().mockResolvedValue(false) }
    admin.handleListFriendsApi = vi.fn(async (_req, res) => { res.writeHead(200); res.end('{}') })
    admin.chatManager = { handleInboundMessage: vi.fn() }
    const headers = { authorization: `Bearer ${jwt({ sub: 'internal' })}` }
    const allowed = response()
    await admin.handleWebRequest({ url: '/api/friends', method: 'GET', headers }, allowed)
    expect(allowed.writeHead.mock.calls[0][0]).toBe(200)
    expect(admin.handleListFriendsApi).toHaveBeenCalledOnce()
    const denied = response()
    await admin.handleWebRequest({ url: '/api/chat/messages', method: 'POST', headers }, denied)
    expect(denied.writeHead.mock.calls[0][0]).toBe(403)
    expect(admin.chatManager.handleInboundMessage).not.toHaveBeenCalled()
    const stale = response()
    await admin.handleWebRequest({ url: '/api/auth/me', method: 'GET', headers: {
      authorization: `Bearer ${jwt({ sub: 'admin', e: 0, desktop: { ...desktop, generation: 'old' } })}`,
    } }, stale)
    expect(stale.writeHead.mock.calls[0][0]).toBe(401)
    expect(JSON.parse(stale.end.mock.calls[0][0]).error).toBe('DESKTOP_UNAUTHORIZED')
  })
})
