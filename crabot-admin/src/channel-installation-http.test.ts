import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { createHmac } from 'node:crypto'
import AdminModule from './index.js'
import { ChannelManager } from './channel-manager.js'
import { OnboardingManager } from './onboarding-manager.js'
import { newCredentialsFromPassword, writeCredentials } from './credentials.js'
import { installTestChannel } from '../tests/helpers/installed-channel.js'
const secret = 'synthetic-channel-install-secret'
function token(sub: string) {
  const header = Buffer.from('{"alg":"HS256","typ":"JWT"}').toString('base64url')
  const payload = Buffer.from(JSON.stringify({ sub, e: 0, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 600 })).toString('base64url')
  return `${header}.${payload}.${createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url')}`
}
let root: string, app: any, manager: ChannelManager, server: http.Server, base: string
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'channel-install-http-'))
  await writeCredentials(root, await newCredentialsFromPassword('synthetic-password', { is_temp: false, changed_via: 'start' }))
  manager = new ChannelManager(root, { registerModuleDefinition: vi.fn() } as any)
  await manager.initialize()
  app = Object.create(AdminModule.prototype)
  Object.assign(app, { adminConfig: { data_dir: root, web_port: 0 }, jwtSecret: secret, channelManager: manager,
    voiceAdmin: { handleWeb: async () => false }, onboardingManager: new OnboardingManager(),
    authorizeAgentCliRequest: async () => ({}) })
  server = http.createServer((req, res) => { void app.handleWebRequest(req, res).catch(() => { res.writeHead(500); res.end('{}') }) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})
afterAll(async () => { await app.onboardingManager.shutdown(); await new Promise<void>(resolve => server.close(() => resolve())); await fs.rm(root, { recursive: true, force: true }) })
async function request(endpoint: string, method = 'GET', sub = 'admin', body?: unknown) {
  const response = await fetch(base + endpoint, { method, headers: { ...(sub ? { Authorization: `Bearer ${token(sub)}` } : {}), 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  return { status: response.status, body: await response.json() as any }
}
describe('real Channel installation HTTP boundary', () => {
  it('rejects missing, internal and Agent credentials before installation', async () => {
    const install = vi.spyOn(manager, 'installPlugin')
    expect((await request('/api/channel-plugins', 'GET', '')).status).toBe(401)
    for (const subject of ['internal', 'agent-cli']) {
      expect((await request('/api/channel-plugins', 'GET', subject)).status).toBe(403)
      expect((await request('/api/channel-plugins/channel-feishu/install', 'POST', subject, {})).status).toBe(403)
    }
    expect(install).not.toHaveBeenCalled()
    install.mockRestore()
  })
  it('blocks direct create, detail and onboarding requests until installation, without downloading', async () => {
    expect((await request('/api/channel-implementations')).body.items).toEqual([])
    expect((await request('/api/channel-implementations/channel-feishu')).status).toBe(409)
    const create = await request('/api/channel-instances', 'POST', 'admin', { implementation_id: 'channel-feishu', name: 'blocked' })
    expect(create).toMatchObject({ status: 409, body: { code: 'CHANNEL_NOT_INSTALLED' } })
    const begin = await request('/api/channels/onboard/begin', 'POST', 'admin', { implementation_id: 'channel-feishu', method_id: 'device_code_oauth' })
    expect(begin).toMatchObject({ status: 409, body: { code: 'CHANNEL_NOT_INSTALLED' } })
    expect(manager.listInstances().items).toEqual([])
    expect((await request('/api/channel-plugins')).body.items.filter((item: any) => item.installed)).toEqual([])
  })
  it('exposes the plugin only after successful installation, without creating an account', async () => {
    const install = vi.spyOn(manager, 'installPlugin').mockImplementation(async id => {
      expect(id).toBe('channel-feishu')
      await installTestChannel(root, 'feishu')
      return manager.requireInstalled(id)
    })
    expect((await request('/api/channel-plugins/channel-feishu/install', 'POST', 'admin', {})).status).toBe(200)
    expect((await request('/api/channel-implementations')).body.items.map((item: any) => item.id)).toEqual(['channel-feishu'])
    expect(manager.listInstances().items).toEqual([])
    expect(app.onboardingManager.get('channel-feishu', 'device_code_oauth')).toBeDefined()
    install.mockRestore()
  })
})
