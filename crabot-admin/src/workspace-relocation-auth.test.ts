import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { createHmac, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { sha256CanonicalJson, RpcClient } from 'crabot-shared'
import { WorkspaceCatalog } from 'crabot-shared/dist/workspace-catalog.js'
import AdminModule from './index.js'
import { newCredentialsFromPassword, writeCredentials } from './credentials.js'

const cleanup: string[] = []
afterEach(async () => { for (const root of cleanup.splice(0)) await fs.rm(root, { recursive: true, force: true }) })
async function fixture() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'crabot-relocation-human-'))); cleanup.push(root)
  const management = require('../../scripts/lib/desktop-management.cjs'), native = require('../../scripts/lib/process-identity.cjs')
  const data = management.ensurePrivateDataRoot(path.join(root, 'data')), adminData = path.join(data, 'admin')
  await fs.mkdir(adminData, { mode: 0o700 })
  const catalog = new WorkspaceCatalog({ dataRoot: data, files: native }); await catalog.initialize()
  const locks = await import('../../scripts/lib/cli-lock.mjs'), relocation = await import('../../scripts/lib/workspace-relocation-intent.mjs')
  const lock = await locks.acquireCliLock(data, 'workspace-relocation'), id = randomUUID()
  let intent
  try { intent = await relocation.beginWorkspaceRelocationIntent({ dataDir: data, id, target: path.join(root, 'relocated'),
    expectedRevision: (await catalog.snapshot()).revision, protectedRoots: [path.join(data, 'workspace-control')] }) }
  finally { locks.releaseCliLock(lock) }
  const admin = Object.create(AdminModule.prototype) as any, secret = randomUUID()
  const desktop = { session_id: 'fixture-session', instance_id: 'fixture-instance', generation: 'fixture-generation' }
  admin.adminConfig = { data_dir: adminData }; admin.jwtSecret = secret
  admin.desktopSessions = { validate: vi.fn((claims: unknown) => JSON.stringify(claims) === JSON.stringify(desktop)) }
  const jwt = (payload: Record<string, unknown>, key = secret) => {
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
    const body = Buffer.from(JSON.stringify({ iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 60, ...payload })).toString('base64url')
    return `${header}.${body}.${createHmac('sha256', key).update(`${header}.${body}`).digest('base64url')}`
  }
  const params = { intent_id: id, intent_sha256: sha256CanonicalJson(intent) }, token = jwt({ sub: 'admin', e: 0, desktop })
  return { root, data, adminData, admin, desktop, jwt, params, token, file: path.join(data, 'workspace-control/relocation.json') }
}
describe('human authorization for one fixed workspace relocation intent', () => {
  it('accepts a registered desktop session without configuring another password or changing files', async () => {
    const f = await fixture(), before = await fs.readFile(f.file, 'utf8')
    expect(await f.admin.handleVerifyWorkspaceRelocationRequest(f.params, { authorizationBearer: f.token })).toEqual({ verified: true, ...f.params })
    expect(await fs.readFile(f.file, 'utf8')).toBe(before)
    await expect(fs.stat(path.join(f.adminData, 'credentials.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(fs.stat(path.join(f.root, 'relocated'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('uses the actual sensitive HTTP envelope and never treats body credentials or source as authority', async () => {
    const f = await fixture(), bodies: string[] = []
    f.admin.methodHandlers = new Map([['verify_workspace_relocation_request', f.admin.handleVerifyWorkspaceRelocationRequest.bind(f.admin)]])
    const server = createServer((request, response) => {
      let body = ''; request.on('data', chunk => { body += chunk }); request.on('end', () => bodies.push(body))
      void f.admin.handleRequest(request, response).catch(() => { response.writeHead(500); response.end('{}') })
    })
    server.listen(0, '127.0.0.1'); await once(server, 'listening')
    const port = (server.address() as { port: number }).port
    try {
      expect(await new RpcClient().callSensitive(port, 'verify_workspace_relocation_request', f.params, 'arbitrary-audit-source',
        { authorizationBearer: f.token })).toEqual({ verified: true, ...f.params })
      expect(bodies[0]).not.toContain(f.token)
      for (const source of ['admin-web', 'module-manager']) {
        const response = await fetch(`http://127.0.0.1:${port}/verify_workspace_relocation_request`, { method: 'POST',
          headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: randomUUID(), source,
            params: { ...f.params, authorizationBearer: f.token } }) })
        expect(response.status).toBe(401)
        expect(await response.json()).toMatchObject({ success: false, error: { code: 'UNAUTHORIZED' } })
      }
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
  })
  it('keeps the existing password epoch and revokes the old request when credentials rotate', async () => {
    const f = await fixture(), credentials = await newCredentialsFromPassword('fixture-only-password', { is_temp: false, changed_via: 'ui' })
    await writeCredentials(f.adminData, credentials)
    expect(await f.admin.handleVerifyWorkspaceRelocationRequest(f.params, { authorizationBearer: f.jwt({ sub: 'admin', e: 0 }) })).toEqual({ verified: true, ...f.params })
    await writeCredentials(f.adminData, { ...credentials, token_epoch: 1 })
    await expect(f.admin.handleVerifyWorkspaceRelocationRequest(f.params, { authorizationBearer: f.jwt({ sub: 'admin', e: 0 }) })).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
    expect(await f.admin.handleVerifyWorkspaceRelocationRequest(f.params, { authorizationBearer: f.jwt({ sub: 'admin', e: 1 }) })).toEqual({ verified: true, ...f.params })
  })
  it('rejects module/internal/Agent CLI and forged source before consulting the private job', async () => {
    const f = await fixture(); await fs.writeFile(f.file, '{broken-private-record')
    for (const [token, code] of [
      ['', 'UNAUTHORIZED'], ['opaque-module-runtime', 'UNAUTHORIZED'],
      [f.jwt({ sub: 'internal' }), 'FORBIDDEN'], [f.jwt({ sub: 'agent-cli', e: 0, agent_cli: {} }), 'FORBIDDEN'],
      [f.jwt({ sub: 'admin', e: 0, desktop: f.desktop, agent_cli: {} }), 'FORBIDDEN'],
    ]) await expect(f.admin.handleVerifyWorkspaceRelocationRequest(f.params, { authorizationBearer: token, source: 'admin-web' })).rejects.toMatchObject({ code })
    expect(await fs.readFile(f.file, 'utf8')).toBe('{broken-private-record')
  })
  it('does not accept a bad signature, expired or unregistered desktop session', async () => {
    const f = await fixture()
    for (const token of [f.jwt({ sub: 'admin', e: 0, desktop: f.desktop }, 'wrong-key'),
      f.jwt({ sub: 'admin', e: 0, desktop: f.desktop, exp: 1 }),
      f.jwt({ sub: 'admin', e: 0, desktop: { ...f.desktop, generation: 'stale-generation' } })]) {
      await expect(f.admin.handleVerifyWorkspaceRelocationRequest(f.params, { authorizationBearer: token })).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
    }
    f.admin.desktopSessions = undefined
    await expect(f.admin.handleVerifyWorkspaceRelocationRequest(f.params, { authorizationBearer: f.token })).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
  })
  it('requires the exact existing intent ID and canonical hash', async () => {
    const f = await fixture()
    for (const params of [{ ...f.params, intent_id: randomUUID() }, { ...f.params, intent_sha256: '0'.repeat(64) }]) {
      await expect(f.admin.handleVerifyWorkspaceRelocationRequest(params, { authorizationBearer: f.token })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    }
  })
  it('rejects extra identities, paths, secrets and malformed requests instead of widening the target', async () => {
    const f = await fixture()
    for (const params of [null, [], {}, { ...f.params, source: 'admin-web' }, { ...f.params, target: f.root },
      { ...f.params, apikey: 'must-not-be-echoed' }, { ...f.params, intent_id: 'invalid' }, { ...f.params, intent_sha256: 'not-a-hash' }]) {
      await expect(f.admin.handleVerifyWorkspaceRelocationRequest(params, { authorizationBearer: f.token })).rejects.toMatchObject({ code: 'INVALID_PARAMS' })
    }
  })
  it('keeps a damaged or missing private job unavailable without creating a replacement', async () => {
    const f = await fixture()
    await fs.writeFile(f.file, '{broken-private-record')
    await expect(f.admin.handleVerifyWorkspaceRelocationRequest(f.params, { authorizationBearer: f.token })).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
    expect(await fs.readFile(f.file, 'utf8')).toBe('{broken-private-record')
    await fs.rm(f.file)
    await expect(f.admin.handleVerifyWorkspaceRelocationRequest(f.params, { authorizationBearer: f.token })).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
    await expect(fs.stat(f.file)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
