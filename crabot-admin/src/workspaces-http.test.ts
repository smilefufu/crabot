import { afterEach, expect, it, vi } from 'vitest'
import { createServer } from 'node:http'
import { once } from 'node:events'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { randomUUID } from 'node:crypto'
import jwt from 'jsonwebtoken'
import { HttpClient, WorkspaceClient } from 'crabot-client'
import AdminModule from './index.js'
import { WorkspaceService } from './workspaces.js'

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
async function fixture() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-http-')))
  cleanup.push(() => fs.rm(root, { recursive: true, force: true }))
  const service = new WorkspaceService({ dataRoot: root }); await service.initialize()
  cleanup.push(() => service.close())
  const admin = Object.create(AdminModule.prototype) as any
  admin.adminConfig = { web_port: 0, data_dir: path.join(root, 'admin') }; admin.jwtSecret = 'fixture-secret'; admin.cutoverActivated = true
  admin.verifyAuthenticatedToken = vi.fn(async token => token === 'fixture-human' ? { sub: 'admin' } : token === 'fixture-internal' ? { sub: 'internal' } : null)
  admin.workspaceService = service
  admin.voiceAdmin = { handleWeb: vi.fn(async () => false) }
  const server = createServer((request, response) => { void admin.handleWebRequest(request, response) })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  cleanup.push(() => new Promise<void>(resolve => server.close(() => resolve())))
  const endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`
  const client = new WorkspaceClient(new HttpClient({ endpoint, token: () => 'fixture-human' }))
  return { root, service, endpoint, client, admin }
}
it('the real Admin router exposes the shared SDK contract and rejects nonhuman identities before mutation', async () => {
  const { endpoint, client } = await fixture()
  expect((await fetch(endpoint + '/workspaces')).status).toBe(401)
  for (const token of ['fixture-internal', jwt.sign({ sub: 'agent-cli', exp: Math.floor(Date.now() / 1000) + 60 }, 'fixture-secret')]) {
    const response = await fetch(endpoint + '/workspaces', { method: 'POST', headers: { Authorization: 'Bearer ' + token,
      'Content-Type': 'application/json' }, body: JSON.stringify({ workspace_id: randomUUID(), name: 'forbidden' }) })
    expect(response.status).toBe(403)
  }
  expect((await client.list()).items.map(item => item.workspace.workspace_id)).toEqual(['default'])
  const id = randomUUID(), created = await client.create({ workspace_id: id, name: '中文项目', description: '开发' })
  expect((await client.create({ workspace_id: id, name: '重试' })).workspace).toEqual(created.workspace)
  const updated = await client.update(id, { expected_revision: created.revision, name: '新名称', description: '新用途' })
  await expect(client.update(id, { expected_revision: created.revision, name: '旧草稿', description: '保留' })).rejects.toMatchObject({ kind: 'conflict' })
  expect((await client.get(id)).item.workspace).toEqual(updated.workspace)
  expect((await client.list()).items).toHaveLength(2)
})
it('refresh returns accepted state without holding the HTTP connection; later HTTP observes real size', async () => {
  const { client } = await fixture(), id = randomUUID()
  const { workspace } = await client.create({ workspace_id: id, name: 'size' })
  await fs.writeFile(path.join(workspace.root, 'artifact.bin'), Buffer.alloc(123))
  expect((await client.refresh(id)).usage.status).toBe('measuring')
  let measured
  for (let attempt = 0; attempt < 100; attempt++) {
    measured = await client.usage(id)
    if (measured.usage.status !== 'measuring') break
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  expect(measured?.usage).toMatchObject({ status: 'complete', logical_bytes: 123, file_count: 1 })
})
it('invalid JSON, field injection and invalid identifiers fail without creating data or exposing paths', async () => {
  const { endpoint, client } = await fixture()
  for (const body of ['{bad', JSON.stringify({ workspace_id: randomUUID(), name: 'x', mode: 'delete' })]) {
    const response = await fetch(endpoint + '/workspaces', { method: 'POST', headers: { Authorization: 'Bearer fixture-human', 'Content-Type': 'application/json' }, body })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ code: 'WORKSPACE_INVALID_REQUEST' })
  }
  expect((await fetch(endpoint + '/workspaces/not-an-id', { headers: { Authorization: 'Bearer fixture-human' } })).status).toBe(400)
  expect((await client.list()).items).toHaveLength(1)
})

it('associated-worker HTTP filtering validates the stable identity and preserves explicit terminal visibility', async () => {
  const { endpoint, admin } = await fixture()
  admin.callAgentRpc = vi.fn(async () => ({ items: [], pagination: { page: 1, page_size: 20, total_items: 0, total_pages: 0 } }))
  const headers = { Authorization: 'Bearer fixture-human' }
  expect((await fetch(endpoint + '/agent/workers?workspace_id=invalid', { headers })).status).toBe(400)
  expect(admin.callAgentRpc).not.toHaveBeenCalled()
  const response = await fetch(endpoint + '/agent/workers?workspace_id=default&include_terminal=true&include_legacy=true', { headers })
  expect(response.status).toBe(200)
  expect(admin.callAgentRpc).toHaveBeenCalledWith('list_workers_admin', expect.objectContaining({ workspace_id: 'default', include_terminal: true, include_legacy: true }))
})

it('aggregate HTTP routes precede workspace-id parsing and preserve human authentication and strict refresh input', async () => {
  const { client, endpoint } = await fixture()
  expect((await client.totalUsage()).status).toBe('pending')
  expect((await client.refreshTotalUsage()).status).toBe('measuring')
  await vi.waitFor(async () => expect((await client.totalUsage()).status).toBe('complete'))
  expect((await fetch(endpoint + '/workspaces/usage')).status).toBe(401)
  const denied = await fetch(endpoint + '/workspaces/usage/refresh', { method: 'POST', headers: {
    Authorization: 'Bearer fixture-internal', 'Content-Type': 'application/json' }, body: '{}' })
  expect(denied.status).toBe(403)
  const invalid = await fetch(endpoint + '/workspaces/usage/refresh', { method: 'POST', headers: {
    Authorization: 'Bearer fixture-human', 'Content-Type': 'application/json' }, body: '{"root":"/"}' })
  expect(invalid.status).toBe(400)
})

it('maintenance status is human-only, no-store and retains the Admin closure after durable release', async () => {
  const f = await fixture(), pathname = f.endpoint + '/workspaces/maintenance'
  const read = () => fetch(pathname, { headers: { Authorization: 'Bearer fixture-human' } })
  expect((await fetch(pathname)).status).toBe(401)
  for (const token of ['fixture-internal', jwt.sign({ sub: 'agent-cli', exp: Math.floor(Date.now() / 1000) + 60 }, 'fixture-secret')]) {
    expect((await fetch(pathname, { headers: { Authorization: 'Bearer ' + token } })).status).toBe(403)
  }
  const original = await f.service.list(), file = path.join(f.root, 'workspace-control/catalog.json'), bytes = await fs.readFile(file)
  const idle = await read()
  expect(idle.status).toBe(200); expect(idle.headers.get('cache-control')).toBe('no-store')
  expect(await idle.json()).toEqual({ maintenance: false })
  expect((await fetch(pathname, { method: 'POST', headers: { Authorization: 'Bearer fixture-human' } })).status).toBe(405)
  const fence = path.join(f.root, 'workspace-control/relocation-finalizing.json')
  await fs.writeFile(fence, 'unverified maintenance is still closed')
  expect(await (await read()).json()).toEqual({ maintenance: true })
  await f.admin.quiesceWorkspaceWebAccess(); await fs.unlink(fence)
  expect(await (await read()).json()).toEqual({ maintenance: true })
  f.service.resumeScanning(); f.admin.workspaceWebAccess().reopen()
  expect(await (await read()).json()).toEqual({ maintenance: false })
  await f.admin.recloseWorkspaceWebAccessAfterResumeFailure()
  expect(await (await read()).json()).toEqual({ maintenance: true })
  expect(await f.service.list()).toEqual(original)
  expect(await fs.readFile(file)).toEqual(bytes)
})


it('relocation preview reads the current scope without creating a job, destination or changing catalog and keeps external projects in place', async () => {
  const f = await fixture(), parent = path.dirname(f.root), target = path.join(parent, 'workspace-preview-' + randomUUID())
  const existing = await fs.mkdtemp(path.join(parent, 'workspace-external-'))
  cleanup.push(() => fs.rm(existing, { recursive: true, force: true }))
  await f.client.create({ workspace_id: randomUUID(), name: 'external', root: existing })
  const file = path.join(f.root, 'workspace-control/catalog.json'), before = await fs.readFile(file)
  const response = await fetch(f.endpoint + '/workspaces/relocation/preview', { method: 'POST', headers: { Authorization: 'Bearer fixture-human', 'Content-Type': 'application/json' }, body: JSON.stringify({ target }) })
  expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store')
  const result = await response.json() as any
  expect(result).toMatchObject({ source: path.join(f.root, 'workspaces'), target, mode: 'rename', execution: { ready: false, items: {} } })
  expect(result.workspaces.map((record: any) => record.workspace_id)).toEqual(['default'])
  expect(result.retained_workspaces.map((record: any) => record.root)).toEqual([existing])
  expect(result.available_bytes).toMatch(/^[0-9]+$/)
  expect(await fs.readFile(file)).toEqual(before)
  await expect(fs.stat(target)).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(fs.stat(path.join(f.root, 'workspace-control/relocation-active'))).rejects.toMatchObject({ code: 'ENOENT' })
  expect((await f.client.maintenance()).maintenance).toBe(false)
})


it('preview keeps human auth, strict input and maintenance admission before any observation', async () => {
  const f = await fixture(), endpoint = f.endpoint + '/workspaces/relocation/preview'
  const call = (token: string, body: unknown) => fetch(endpoint, { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  expect((await fetch(endpoint, { method: 'POST' })).status).toBe(401)
  expect((await call('fixture-internal', { target: '/unused' })).status).toBe(403)
  expect((await fetch(endpoint, { headers: { Authorization: 'Bearer fixture-human' } })).status).toBe(405)
  const preview = vi.spyOn(f.service, 'previewRelocation')
  for (const body of [{ target: 'relative' }, { target: '/unused', source: '/' }, { target: '/unused', protectedTargets: [] }]) {
    expect((await call('fixture-human', body)).status).toBe(400)
  }
  expect(preview).not.toHaveBeenCalled()
  expect((await call('fixture-human', { target: path.join(f.root, 'admin') })).status).toBe(400)
  await fs.writeFile(path.join(f.root, 'workspace-control/relocation-finalizing.json'), 'unknown fence')
  preview.mockClear()
  expect((await call('fixture-human', { target: '/unused' })).status).toBe(503)
  expect(preview).not.toHaveBeenCalled()
})


it('a disconnected preview is cancelled while maintenance still waits for its complete handler cleanup', async () => {
  const f = await fixture()
  let started!: () => void, cancelled!: () => void, finish!: () => void, drained = false
  const seen = new Promise<void>(resolve => { started = resolve }), aborted = new Promise<void>(resolve => { cancelled = resolve }), cleanupDone = new Promise<void>(resolve => { finish = resolve })
  vi.spyOn(f.service, 'previewRelocation').mockImplementation(async (_input, signal) => {
    started()
    await new Promise<void>(resolve => signal!.addEventListener('abort', () => { cancelled(); resolve() }, { once: true }))
    await cleanupDone
    throw new Error('cancelled read-only fixture')
  })
  const controller = new AbortController()
  const response = fetch(f.endpoint + '/workspaces/relocation/preview', { method: 'POST', headers: { Authorization: 'Bearer fixture-human', 'Content-Type': 'application/json' }, body: '{"target":"/unused"}', signal: controller.signal }).catch(error => error)
  await seen; controller.abort(); await aborted; await response
  await fs.writeFile(path.join(f.root, 'workspace-control/relocation-finalizing.json'), 'retain maintenance')
  const quiesce = f.admin.quiesceWorkspaceWebAccess().then(() => { drained = true })
  try { await Promise.resolve(); expect(drained).toBe(false) }
  finally { finish(); await quiesce }
  expect(drained).toBe(true)
  expect((await f.client.maintenance()).maintenance).toBe(true)
})
