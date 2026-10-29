import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
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
let server: http.Server, base: string, root: string, app: any, instance: any
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
  Object.assign(app, { adminConfig: { data_dir: root, web_port: 0 }, jwtSecret: secret, voiceAdmin: { handleWeb: async () => false, validateIdentity() {} }, onboardingManager: { get: (impl: string, method: string) => impl === 'channel-slack' && method === 'local-cli' ? onboarder : undefined }, friends: new Map(), channelIdentityIndex: new Map() })
  app.channelManager = { listInstances: () => ({ items: instance ? [instance] : [] }), getInstance: () => instance, loadLocalConfig: async () => ({ SLACK_BOT_TOKEN: 'xoxb-fixture', SLACK_APP_TOKEN: 'xapp-fixture' }), createInstance: vi.fn(async ({ name }: { name: string }) => { instance = { id: name, name, implementation_id: 'channel-slack' }; return instance }) }
  app.saveData = vi.fn(async () => { await fs.writeFile(path.join(root, 'friends.json'), JSON.stringify([...app.friends.values()])) })
  server = http.createServer((req, res) => { void app.handleWebRequest(req, res).catch(() => { res.writeHead(500); res.end() }) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})
beforeEach(async () => {
  vi.clearAllMocks()
  app.saveData.mockReset().mockImplementation(async () => { await fs.writeFile(path.join(root, 'friends.json'), JSON.stringify([...app.friends.values()])) })
  instance = undefined
  app.friends.clear()
  app.channelIdentityIndex.clear()
  await app.saveData()
  await fs.rm(path.join(root, 'slack-onboarding-receipts'), { recursive: true, force: true })
  app.slackOnboarding = new SlackOnboardingSessions(root, (channelId, identity) => app.ensureSlackOnboardingMaster(channelId, identity))
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
  it('automatically claims the verified owner through HTTP, persists it, and resolves the real identity without a DM', async () => {
    await request('begin', 'human-a')
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
    expect(JSON.stringify(result)).not.toMatch(/xoxb-|xapp-|SLACK_BOT_TOKEN/)
    expect((await request('finish', 'human-a', { name: 'Slack-test' })).status).toBe(200)
    expect(app.channelManager.createInstance).toHaveBeenCalledTimes(1)
    expect(result.master_friend_id).toBeTruthy()
    const resolved = await app.handleResolveFriend({ channel_id: 'Slack-test', platform_user_id: 'UOWNER' })
    expect(resolved.friend).toMatchObject({ id: result.master_friend_id, permission: 'master' })
    expect(JSON.parse(await fs.readFile(path.join(root, 'friends.json'), 'utf8'))).toEqual([resolved.friend])
    expect(onboarder.finish).not.toHaveBeenCalledWith(sessionId, { created_instance_id: 'attacker' })
  })
  it('reuses the existing Master and ignores browser-supplied owner identity', async () => {
    const { friend } = app.handleCreateFriend({ display_name: '原主人', permission: 'master', channel_identities: [{ channel_id: 'feishu-old', platform_user_id: 'ou_owner', platform_display_name: '原主人' }] })
    await request('begin', 'human-a')
    const response = await request('finish', 'human-a', { name: 'Slack-test', authorized_identity: { platform_user_id: 'UFORGED' } })
    const result = await response.json()
    expect(result).toMatchObject({ master_friend_id: friend.id, master_display_name: '原主人' })
    expect(app.friends.size).toBe(1)
    expect(app.friends.get(friend.id).channel_identities).toEqual([
      ...friend.channel_identities,
      { channel_id: 'Slack-test', platform_user_id: 'UOWNER', platform_display_name: '原主人' },
    ])
    expect((await app.handleResolveFriend({ channel_id: 'Slack-test', platform_user_id: 'UFORGED' })).friend).toBeNull()
  })
  it('reports failed owner persistence separately and retries it without recreating the App or channel', async () => {
    await request('begin', 'human-a')
    app.saveData.mockRejectedValueOnce(new Error('fixture disk error'))
    const first = await (await request('finish', 'human-a', { name: 'Slack-test' })).json()
    expect(first.instance.id).toBe('Slack-test')
    expect(first.master_friend_id).toBeUndefined()
    expect(JSON.parse(await fs.readFile(path.join(root, 'friends.json'), 'utf8'))).toEqual([])
    const retry = await (await request('finish', 'human-a', { name: 'Slack-test' })).json()
    const saved = JSON.parse(await fs.readFile(path.join(root, 'friends.json'), 'utf8'))
    expect(saved).toHaveLength(1)
    expect(saved[0]).toMatchObject({ id: retry.master_friend_id, permission: 'master' })
    expect(app.channelManager.createInstance).toHaveBeenCalledTimes(1)
    expect(onboarder.begin).toHaveBeenCalledTimes(1)
  })
  it('does not re-claim a successfully completed owner after restart and a later manual unlink', async () => {
    await request('begin', 'human-a')
    const first = await (await request('finish', 'human-a', { name: 'Slack-test' })).json()
    expect(first.master_friend_id).toBeTruthy()
    const friend = app.friends.get(first.master_friend_id)
    app.friends.set(friend.id, { ...friend, channel_identities: [] })
    app.channelIdentityIndex.clear()
    await app.saveData()
    app.slackOnboarding = new SlackOnboardingSessions(root, (channelId, identity) => app.ensureSlackOnboardingMaster(channelId, identity))
    const retry = await (await request('finish', 'human-a', { name: 'Slack-test' })).json()
    expect(retry).toEqual(first)
    expect((await app.handleResolveFriend({ channel_id: 'Slack-test', platform_user_id: 'UOWNER' })).friend).toBeNull()
    expect(app.channelManager.createInstance).toHaveBeenCalledTimes(1)
  })

})
