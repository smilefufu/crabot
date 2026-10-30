import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { createHmac } from 'node:crypto'
import { ProxyManager, proxyManager } from 'crabot-shared'
import AdminModule from './index.js'
import { ModelProviderManager } from './model-provider-manager.js'
import { newCredentialsFromPassword, writeCredentials } from './credentials.js'
let root: string, server: http.Server, base: string, app: any, manager: ModelProviderManager
const secret = 'proxy-http-fixture-secret'
const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
const payload = Buffer.from(JSON.stringify({ sub: 'admin', e: 0, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')
const token = `${header}.${payload}.${createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url')}`
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'crabot-proxy-http-'))
  await writeCredentials(root, await newCredentialsFromPassword('fixture-only', { is_temp: false, changed_via: 'start' }))
  manager = new ModelProviderManager(root); await manager.initialize()
  await manager.updateProxyConfig({ mode: 'none' })
  app = Object.create(AdminModule.prototype)
  Object.assign(app, { adminConfig: { data_dir: root, web_port: 0 }, jwtSecret: secret,
    voiceAdmin: { handleWeb: async () => false, validateIdentity() {} }, modelProviderManager: manager,
    pushProxyConfigToAllModules: vi.fn().mockResolvedValue(undefined) })
  server = http.createServer((req, res) => { void app.handleWebRequest(req, res).catch(() => { res.writeHead(500); res.end() }) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})
afterEach(async () => {
  proxyManager.updateConfig({ mode: 'none' }); vi.restoreAllMocks()
  server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()))
  await fs.rm(root, { recursive: true, force: true })
})
it('does not detect a native proxy for custom/none or bypass Admin authentication', async () => {
  const detect = vi.spyOn(ProxyManager, 'resolveSystemProxyUrl').mockReturnValue('http://fixture.example:8080')
  expect((await fetch(base + '/api/proxy-config')).status).toBe(401)
  for (const config of [{ mode: 'none' }, { mode: 'custom', custom_url: 'http://custom.example:8080' }] as const) {
    await manager.updateProxyConfig(config)
    const response = await fetch(base + '/api/proxy-config', { headers: { Authorization: `Bearer ${token}` } })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ config, system_proxy_url: null })
  }
  expect(detect).not.toHaveBeenCalled()
})
it('saves existing system configuration, applies the proxy and returns the detected address through the existing GET', async () => {
  vi.spyOn(ProxyManager, 'resolveSystemProxyUrl').mockReturnValue('http://fixture.example:8080')
  const response = await fetch(base + '/api/proxy-config', { method: 'PATCH', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'system' }) })
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ config: { mode: 'system' } })
  expect(proxyManager.getProxyUrl()).toBe('http://fixture.example:8080')
  const current = await fetch(base + '/api/proxy-config', { headers: { Authorization: `Bearer ${token}` } })
  expect(await current.json()).toEqual({ config: { mode: 'system' }, system_proxy_url: 'http://fixture.example:8080' })
  expect(app.pushProxyConfigToAllModules).toHaveBeenCalledWith({ mode: 'system', custom_url: undefined })
  const reloaded = new ModelProviderManager(root); await reloaded.initialize()
  expect(reloaded.getProxyConfig()).toEqual({ mode: 'system' })
})
