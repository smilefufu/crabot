import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHmac } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import AdminModule from './index.js'
const dirs: string[] = []
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true }))) })
function token(sub = 'admin', epoch = 3, expiry = Math.floor(Date.now() / 1000) + 60) {
  const header = Buffer.from('{"alg":"HS256","typ":"JWT"}').toString('base64url')
  const payload = Buffer.from(JSON.stringify({ sub, e: epoch, exp: expiry, iat: 0 })).toString('base64url')
  return `${header}.${payload}.${createHmac('sha256', 'setup-test').update(`${header}.${payload}`).digest('base64url')}`
}
async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'crabot-setup-api-')); dirs.push(dir)
  await fs.writeFile(path.join(dir, 'credentials.json'), JSON.stringify({ token_epoch: 3 }))
  const admin: any = Object.create(AdminModule.prototype)
  admin.jwtSecret = 'setup-test'; admin.adminConfig = { data_dir: dir }
  const setup = { status: vi.fn().mockResolvedValue({ enabled: true }), start: vi.fn().mockResolvedValue({ setup: { setup_id: 'current' } }),
    reveal: vi.fn().mockResolvedValue({}), cancel: vi.fn().mockResolvedValue({ setup: { phase: 'cancelled' } }) }
  admin.desktopSetup = vi.fn().mockReturnValue(setup)
  admin.readJsonBody = vi.fn().mockResolvedValue({})
  const response = { writeHead: vi.fn(), end: vi.fn() }
  const call = async (method: string, bearer: string | undefined = token(), body = {}) => {
    response.writeHead.mockClear(); response.end.mockClear(); admin.readJsonBody.mockResolvedValue(body)
    await admin.handleComputerUseSetupApi({ method, headers: bearer ? { authorization: `Bearer ${bearer}` } : {}, source: 'admin' }, response)
    return { status: response.writeHead.mock.calls[0][0], body: JSON.parse(response.end.mock.calls[0][0]) }
  }
  return { call, setup, admin }
}
describe('desktop setup human API boundary', () => {
  it('rejects internal, CLI, forged, expired and revoked tokens before native I/O', async () => {
    const { call, admin } = await fixture()
    for (const bearer of ['', token('internal'), token('agent-cli'), token('other'), 'forged', token('admin', 2), token('admin', 3, 1)]) {
      expect([401, 403]).toContain((await call('POST', bearer)).status)
    }
    expect(admin.desktopSetup).not.toHaveBeenCalled()
  })
  it('GET never starts permission setup; POST returns accepted; DELETE is scoped to the ID', async () => {
    const { call, setup } = await fixture()
    expect((await call('GET')).status).toBe(200)
    expect(setup.start).not.toHaveBeenCalled()
    expect((await call('POST')).status).toBe(202)
    expect((await call('DELETE', token(), { setup_id: 'current' })).status).toBe(200)
    expect(setup.cancel).toHaveBeenCalledWith('current')
    expect((await call('POST', token(), { action: 'reveal_app' })).status).toBe(200)
    expect(setup.reveal).toHaveBeenCalledTimes(1)
  })
  it('does not accept caller-supplied paths, tools, prompts or foreign cancellation', async () => {
    const { call, setup } = await fixture()
    for (const body of [{ root: '/foreign' }, { action: 'grant' }, { prompt: true }, { tool: 'click' }]) {
      expect((await call('POST', token(), body)).status).toBe(400)
    }
    expect((await call('DELETE', token(), {})).status).toBe(400)
    setup.cancel.mockRejectedValue(new Error('COMPUTER_USE_SETUP_CHANGED'))
    expect((await call('DELETE', token(), { setup_id: 'old' })).status).toBe(409)
    expect(setup.start).not.toHaveBeenCalled()
  })
  it('rejects malformed JSON as invalid parameters before starting setup', async () => {
    const { admin, setup } = await fixture()
    admin.readJsonBody.mockRejectedValue(new SyntaxError('invalid JSON'))
    const response = { writeHead: vi.fn(), end: vi.fn() }
    await admin.handleComputerUseSetupApi({ method: 'POST', headers: { authorization: `Bearer ${token()}` } }, response)
    expect(response.writeHead.mock.calls[0][0]).toBe(400)
    expect(setup.start).not.toHaveBeenCalled()
  })
})
