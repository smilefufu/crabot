import { afterEach, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { randomUUID } from 'node:crypto'
import jwt from 'jsonwebtoken'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { RpcClient } from 'crabot-shared'
import AdminModule from './index.js'
import { newCredentialsFromPassword, writeCredentials } from './credentials.js'

const roots: string[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }) })
async function fixture() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-start-human-'))); roots.push(root)
  const admin = Object.create(AdminModule.prototype) as any, secret = randomUUID()
  admin.adminConfig = { data_dir: root }; admin.jwtSecret = secret
  const desktop = { session_id: 'finite-start-session', instance_id: 'finite-start-instance', generation: 'finite-start-generation' }
  admin.desktopSessions = { validate: vi.fn((value: unknown) => JSON.stringify(value) === JSON.stringify(desktop)) }
  const token = (payload: Record<string, unknown>) => jwt.sign({ e: 0, ...payload }, secret, { expiresIn: '1m' })
  const params = { intent_id: randomUUID(), target: path.join(root, 'not-created'), expected_revision: 1, confirmed: true }
  return { root, admin, params, token, desktop, human: token({ sub: 'admin', desktop }) }
}
it('verifies an initial desktop confirmation without requiring or creating an intent, password or destination', async () => {
  const f = await fixture(), before = await fs.readdir(f.root)
  expect(await f.admin.handleVerifyWorkspaceRelocationStart(f.params, { authorizationBearer: f.human })).toEqual({ verified: true, ...f.params })
  expect(await fs.readdir(f.root)).toEqual(before)
  await expect(fs.stat(f.params.target)).rejects.toMatchObject({ code: 'ENOENT' })
})
it('authenticates before parsing malformed start parameters and rejects nonhuman or forged credentials', async () => {
  const f = await fixture()
  await expect(f.admin.handleVerifyWorkspaceRelocationStart(null)).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
  for (const bearer of ['forged', f.token({ sub: 'internal' }), f.token({ sub: 'agent-cli' })]) {
    await expect(f.admin.handleVerifyWorkspaceRelocationStart(null, { authorizationBearer: bearer })).rejects.toMatchObject({ code: bearer === 'forged' ? 'UNAUTHORIZED' : 'FORBIDDEN' })
  }
  expect(await fs.readdir(f.root)).toEqual([])
})
it('accepts only an explicit stable confirmation and never accepts caller authority, scripts or sources', async () => {
  const f = await fixture()
  for (const invalid of [{ ...f.params, confirmed: false }, { ...f.params, expected_revision: 0 }, { ...f.params, target: 'relative' },
    { ...f.params, intent_id: 'unknown' }, { ...f.params, intent_id: 'ABCDEFAB-1234-4123-8123-123456789ABC' },
    { ...f.params, target: f.params.target + String.fromCharCode(0) }, { ...f.params, expected_revision: 1.5 }, { ...f.params, expected_revision: Number.MAX_SAFE_INTEGER + 1 }, { ...f.params, source: '/' }, { ...f.params, command: 'stop' }, { ...f.params, authorizationBearer: f.human }]) {
    await expect(f.admin.handleVerifyWorkspaceRelocationStart(invalid, { authorizationBearer: f.human })).rejects.toMatchObject({ code: 'INVALID_PARAMS' })
  }
  expect(await fs.readdir(f.root)).toEqual([])
})
it('pins the request before asynchronous human verification instead of switching targets after confirmation', async () => {
  const f = await fixture(), original = { ...f.params }
  vi.spyOn(f.admin, 'verifyHumanToken').mockImplementationOnce(async () => { f.params.target = path.join(f.root, 'switched'); return { sub: 'admin' } })
  expect(await f.admin.handleVerifyWorkspaceRelocationStart(f.params, { authorizationBearer: f.human })).toEqual({ verified: true, ...original })
  expect(await fs.readdir(f.root)).toEqual([])
})
it('retains the original password epoch and desktop session revocation rules', async () => {
  const f = await fixture(), credentials = await newCredentialsFromPassword('finite-start-password', { is_temp: false, changed_via: 'ui' })
  await writeCredentials(f.root, credentials)
  const password = f.token({ sub: 'admin', e: 0 })
  expect(await f.admin.handleVerifyWorkspaceRelocationStart(f.params, { authorizationBearer: password })).toMatchObject({ verified: true })
  await writeCredentials(f.root, { ...credentials, token_epoch: 1 })
  await expect(f.admin.handleVerifyWorkspaceRelocationStart(f.params, { authorizationBearer: password })).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
  f.admin.desktopSessions.validate.mockReturnValue(false)
  await expect(f.admin.handleVerifyWorkspaceRelocationStart(f.params, { authorizationBearer: f.token({ sub: 'admin', e: 1, desktop: f.desktop }) })).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
})


it('the actual sensitive RPC uses only the header human identity and never body/source authority', async () => {
  const f = await fixture(), bodies: string[] = []
  f.admin.methodHandlers = new Map([['verify_workspace_relocation_start', f.admin.handleVerifyWorkspaceRelocationStart.bind(f.admin)]])
  const server = createServer((request, response) => {
    let body = ''; request.on('data', chunk => { body += chunk }); request.on('end', () => bodies.push(body))
    void f.admin.handleRequest(request, response).catch(() => { response.writeHead(500); response.end('{}') })
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const port = (server.address() as { port: number }).port
  try {
    expect(await new RpcClient().callSensitive(port, 'verify_workspace_relocation_start', f.params, 'untrusted-source',
      { authorizationBearer: f.human })).toEqual({ verified: true, ...f.params })
    expect(bodies[0]).not.toContain(f.human)
    const denied = await fetch(`http://127.0.0.1:${port}/verify_workspace_relocation_start`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: randomUUID(), source: 'admin-web', params: f.params }) })
    expect(denied.status).toBe(401)
    expect(await fs.readdir(f.root)).toEqual([])
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
})
