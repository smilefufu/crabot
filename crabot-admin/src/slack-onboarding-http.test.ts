import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import http from 'node:http'
import { createHmac } from 'node:crypto'
import AdminModule from './index.js'
import { newCredentialsFromPassword, writeCredentials } from './credentials.js'
import { SlackOnboardingSessions } from './slack-onboarding-sessions.js'
const sessionId = '22222222-2222-4222-8222-222222222222'
const secret = 'slack-fixture-http-test-secret'
const token = (sub: string) => {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
  const payload = Buffer.from(JSON.stringify({ sub, e: 0, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')
  return `${header}.${payload}.${createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url')}`
}
let server: http.Server, base: string, root: string, app: any
const onboarder = {
  begin: vi.fn(async () => ({ session_id: sessionId, ui_mode: 'challenge_code', authorization_command: '/slackauthticket fixture' })),
  submit: vi.fn(async (_id: string, input: { challenge_code: string }) => { if (!input || typeof input.challenge_code !== 'string') throw Object.assign(new Error('请输入验证码'), { status: 400, code: 'invalid_input' }) }),
  async *poll() { yield { type: 'success' } },
  finish: vi.fn(async () => ({ env: { SLACK_BOT_TOKEN: 'xoxb-fixture', SLACK_APP_TOKEN: 'xapp-fixture' }, authorized_identity: { platform_user_id: 'UOWNER' } })),
  cancel: vi.fn(),
}
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'crabot-slack-http-test-'))
  await writeCredentials(root, await newCredentialsFromPassword('fixture-password', { is_temp: false, changed_via: 'start' }))
  // Exercise actual Admin routing/auth/body parsing with isolated HTTP transport and storage.
  app = Object.create(AdminModule.prototype)
  Object.assign(app, { adminConfig: { data_dir: root, web_port: 0 }, jwtSecret: secret, voiceAdmin: { handleWeb: async () => false }, onboardingManager: { get: (impl: string, method: string) => impl === 'channel-slack' && method === 'local-cli' ? onboarder : undefined }, slackOnboarding: new SlackOnboardingSessions(root) })
  let instance: any
  app.channelManager = { listInstances: () => ({ items: instance ? [instance] : [] }), getInstance: () => instance, loadLocalConfig: async () => ({ SLACK_BOT_TOKEN: 'xoxb-fixture', SLACK_APP_TOKEN: 'xapp-fixture' }), createInstance: vi.fn(async ({ name }: { name: string }) => { instance = { id: name, name, implementation_id: 'channel-slack' }; return instance }) }
  app.ensureMasterForOnboarding = vi.fn(() => { throw new Error('Slack must not claim Master') })
  server = http.createServer((req, res) => { void app.handleWebRequest(req, res).catch(() => { res.writeHead(500); res.end() }) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})
afterAll(async () => { await new Promise<void>(resolve => server.close(() => resolve())); await fs.rm(root, { recursive: true, force: true }) })
async function request(action: string, subject?: string, extra: Record<string, unknown> = {}) {
  return fetch(`${base}/api/channels/onboard/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(subject ? { Authorization: `Bearer ${token(subject)}` } : {}) }, body: JSON.stringify({ implementation_id: 'channel-slack', method_id: 'local-cli', session_id: sessionId, ...extra }) })
}
describe('real Admin browser HTTP boundary', () => {
  it('requires a human and the owning principal for every new Slack operation', async () => {
    expect((await request('begin')).status).toBe(401)
    expect((await request('begin', 'internal')).status).toBe(403)
    expect((await request('begin', 'human-a', { params: { __admin_proxy: { mode: 'custom', custom_url: 'http://untrusted.invalid' } } })).status).toBe(200)
    expect(onboarder.begin).toHaveBeenCalledWith(expect.objectContaining({ __admin_proxy: { mode: 'system' } }))
    for (const action of ['submit', 'finish', 'cancel']) expect((await request(action, 'human-b', { name: 'Slack-test', input: { challenge_code: 'fixture' } })).status).toBe(403)
    const response = await fetch(`${base}/api/channels/onboard/poll?implementation_id=channel-slack&method_id=local-cli&session_id=${sessionId}&token=${token('human-b')}`)
    expect(response.status).toBe(403)
  })
  it('serves submit/SSE and idempotent creation without returning tokens or auto Master effects', async () => {
    const invalid = await request('submit', 'human-a')
    expect(invalid.status).toBe(400); expect(await invalid.json()).toMatchObject({ code: 'invalid_input' })
    const accepted = await request('submit', 'human-a', { input: { challenge_code: 'fixture' } })
    expect(await accepted.json()).toEqual({ accepted: true })
    const poll = await fetch(`${base}/api/channels/onboard/poll?implementation_id=channel-slack&method_id=local-cli&session_id=${sessionId}&token=${token('human-a')}`)
    expect(await poll.text()).toContain('event: success')
    const first = await request('finish', 'human-a', { name: 'Slack-test', finish_params: { created_instance_id: 'attacker' } })
    expect(first.status).toBe(200)
    const result = await first.json()
    expect(result.authorized_identity).toEqual({ platform_user_id: 'UOWNER' })
    expect(JSON.stringify(result)).not.toMatch(/xoxb-|xapp-|master_friend_id|SLACK_BOT_TOKEN/)
    expect((await request('finish', 'human-a', { name: 'Slack-test' })).status).toBe(200)
    expect(app.channelManager.createInstance).toHaveBeenCalledTimes(1)
    expect(app.ensureMasterForOnboarding).not.toHaveBeenCalled()
    expect(onboarder.finish).not.toHaveBeenCalledWith(sessionId, { created_instance_id: 'attacker' })
  })
})
