import { it, expect, vi } from 'vitest'
import { createServer } from 'node:http'
import { once } from 'node:events'
import AdminModule from './index.js'
import { startUpgrade } from './version/upgrade-runner.js'

vi.mock('./version/upgrade-runner.js', async importOriginal => ({
  ...await importOriginal<typeof import('./version/upgrade-runner.js')>(),
  requiresDesktopUpdater: vi.fn(() => true),
  startUpgrade: vi.fn(() => ({ status: 'started' })),
  isUpgradeInProgress: vi.fn(() => false),
}))

it('the real Admin router rejects archive updates to desktop installations before legacy checks or writes', async () => {
  const admin = Object.create(AdminModule.prototype) as any
  admin.adminConfig = { web_port: 0, data_dir: 'unused' }; admin.jwtSecret = 'unused'; admin.cutoverActivated = true
  admin.verifyAuthenticatedToken = vi.fn(async (token: string) => token === 'fixture-human' ? { sub: 'admin' } : null)
  admin.voiceAdmin = { handleWeb: vi.fn(async () => false) }
  admin.versionService = { check: vi.fn(async () => ({ upgrade_available: true, upgrade_capability: 'release' })) }
  const server = createServer((request, response) => { void admin.handleWebRequest(request, response) })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/system/upgrade`
  try {
    expect((await fetch(url, { method: 'POST' })).status).toBe(401)
    const response = await fetch(url, { method: 'POST', headers: { Authorization: 'Bearer fixture-human' } })
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ code: 'DESKTOP_MANAGED_INSTALLATION' })
    expect(admin.versionService.check).not.toHaveBeenCalled()
    expect(startUpgrade).not.toHaveBeenCalled()
  } finally { await new Promise<void>(resolve => server.close(() => resolve())) }
})
