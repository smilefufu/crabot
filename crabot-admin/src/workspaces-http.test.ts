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

function initialRequest(root: string) {
  return { intent_id: randomUUID(), target: path.join(root, 'next workspaces'), expected_revision: 1, confirmed: true }
}
function startRpc(admin: any, implementation: (...args: any[]) => Promise<unknown>) {
  admin.config = { moduleId: 'admin-web' }
  const call = vi.fn(implementation); admin.rpcClient = { callModuleManagerSensitive: call }
  return call
}
it('initial relocation HTTP authenticates before parsing, enforces one closed confirmation and never trusts body credentials', async () => {
  const f = await fixture(), call = startRpc(f.admin, async () => { throw new Error('must not dispatch') })
  const submit = (body: unknown, token?: string) => fetch(f.endpoint + '/workspaces/relocation/start', { method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: JSON.stringify(body) })
  expect((await submit({ token: 'fixture-human' })).status).toBe(401)
  for (const token of ['fixture-internal', jwt.sign({ sub: 'agent-cli', exp: Math.floor(Date.now() / 1000) + 60 }, 'fixture-secret')]) expect((await submit({}, token)).status).toBe(403)
  const request = initialRequest(f.root)
  for (const body of [{ ...request, confirmed: false }, { ...request, expected_revision: 0 }, { ...request, authorization: 'body-only' }, { ...request, source: 'admin-web' }, { ...request, managedDefaultTarget: request.target }]) {
    expect((await submit(body, 'fixture-human')).status).toBe(400)
  }
  expect((await fetch(f.endpoint + '/workspaces/relocation/start', { headers: { Authorization: 'Bearer fixture-human' } })).status).toBe(405)
  expect(call).not.toHaveBeenCalled()
})
it('initial control HTTP waits for real file-handler drainage without counting itself, and dispatches exactly once with a header bearer', async () => {
  const f = await fixture(), request = initialRequest(f.root), before = await f.service.list()
  const call = startRpc(f.admin, async () => {
    await fs.writeFile(path.join(f.root, 'workspace-control/relocation-finalizing.json'), 'finite test fence')
    await f.admin.quiesceWorkspaceWebAccess()
    return { intent_id: request.intent_id, accepted: true }
  })
  const response = await fetch(f.endpoint + '/workspaces/relocation/start', { method: 'POST', headers: { Authorization: 'Bearer fixture-human', 'Content-Type': 'application/json' }, body: JSON.stringify(request) })
  expect(response.status).toBe(202); expect(response.headers.get('cache-control')).toBe('no-store')
  expect(await response.json()).toEqual({ intent_id: request.intent_id, accepted: true })
  expect(call).toHaveBeenCalledTimes(1)
  expect(call).toHaveBeenCalledWith('start_workspace_relocation', request, 'admin-web', { authorizationBearer: 'fixture-human', timeoutMs: 120_000 })
  expect(JSON.stringify(call.mock.calls[0][1])).not.toContain('fixture-human')
  expect(await f.service.list()).toEqual(before)
  const again = await fetch(f.endpoint + '/workspaces/relocation/start', { method: 'POST', headers: { Authorization: 'Bearer fixture-human', 'Content-Type': 'application/json' }, body: JSON.stringify(request) })
  expect(again.status).toBe(503); expect(call).toHaveBeenCalledTimes(1)
})
it('initial HTTP distinguishes unchanged, unknown handoff and malformed Core receipts without exposing remote content', async () => {
  const f = await fixture(), request = initialRequest(f.root)
  const call = startRpc(f.admin, async () => ({ unchanged: true, source: path.join(f.root, 'workspaces') }))
  const submit = () => fetch(f.endpoint + '/workspaces/relocation/start', { method: 'POST', headers: { Authorization: 'Bearer fixture-human', 'Content-Type': 'application/json' }, body: JSON.stringify(request) })
  const unchanged = await submit(); expect(unchanged.status).toBe(200); expect(await unchanged.json()).toEqual({ unchanged: true, source: path.join(f.root, 'workspaces') })
  call.mockRejectedValueOnce(Object.assign(new Error('private-remote-content'), { code: 'SERVICE_UNAVAILABLE' }))
  const unknown = await submit(); expect(unknown.status).toBe(503); expect(JSON.stringify(await unknown.json())).not.toContain('private-remote-content')
  call.mockResolvedValueOnce({ intent_id: randomUUID(), accepted: true })
  expect((await submit()).status).toBe(503)
  for (const code of ['__proto__', 'toString']) {
    call.mockRejectedValueOnce(Object.assign(new Error('private-remote-content'), { code }))
    const response = await submit(); expect(response.status).toBe(503); expect(await response.json()).toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
  }
  expect(call).toHaveBeenCalledTimes(5)
})
it('maintenance appearing while a confirmation body is being read refuses before any handoff', async () => {
  const f = await fixture(), call = startRpc(f.admin, async () => { throw new Error('must not dispatch') })
  let continueBody!: () => void, entered!: () => void
  const bodyEntered = new Promise<void>(resolve => { entered = resolve }), bodyReady = new Promise<void>(resolve => { continueBody = resolve })
  const read = f.admin.readJsonBody.bind(f.admin)
  vi.spyOn(f.admin, 'readJsonBody').mockImplementation(async (...args: any[]) => { entered(); await bodyReady; return read(...args) })
  const response = fetch(f.endpoint + '/workspaces/relocation/start', { method: 'POST', headers: { Authorization: 'Bearer fixture-human', 'Content-Type': 'application/json' }, body: JSON.stringify(initialRequest(f.root)) })
  await bodyEntered
  await fs.writeFile(path.join(f.root, 'workspace-control/relocation-finalizing.json'), 'finite concurrent fence'); continueBody()
  expect((await response).status).toBe(503); expect(call).not.toHaveBeenCalled()
})

it('closing the browser only cancels its wait after handoff, never the owned Core operation', async () => {
  const f = await fixture(), request = initialRequest(f.root), controller = new AbortController()
  let entered!: () => void, complete!: () => void, finished!: () => void
  const handed = new Promise<void>(resolve => { entered = resolve }), finish = new Promise<void>(resolve => { complete = resolve })
  const done = new Promise<void>(resolve => { finished = resolve })
  const call = startRpc(f.admin, async (...args) => {
    expect(args[3]).toEqual({ authorizationBearer: 'fixture-human', timeoutMs: 120_000 })
    entered(); await finish
    await fs.writeFile(path.join(f.root, 'workspace-control/relocation-finalizing.json'), 'finite test owned job')
    await f.admin.quiesceWorkspaceWebAccess(); finished()
    return { intent_id: request.intent_id, accepted: true }
  })
  const pending = fetch(f.endpoint + '/workspaces/relocation/start', { method: 'POST', signal: controller.signal,
    headers: { Authorization: 'Bearer fixture-human', 'Content-Type': 'application/json' }, body: JSON.stringify(request) })
  const closed = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  await handed; controller.abort(); await closed
  complete(); await done
  expect(call).toHaveBeenCalledTimes(1); expect(f.admin.workspaceWebAccess().isClosed()).toBe(true)
})

it('job status remains a human-only management read during maintenance, with one query and header-only identity', async () => {
  const f = await fixture(), id = randomUUID(), snapshot = { available: true, job: { intent_id: id, state: 'needs_attention', stage: 'finalizing', source: path.join(f.root, 'workspaces'), target: path.join(f.root, 'next') } }
  const call = startRpc(f.admin, async () => snapshot)
  const pathname = f.endpoint + '/workspaces/relocation/current', headers = { Authorization: 'Bearer fixture-human' }
  expect((await fetch(pathname)).status).toBe(401)
  expect((await fetch(pathname, { headers: { Authorization: 'Bearer fixture-internal' } })).status).toBe(403)
  expect(call).not.toHaveBeenCalled()
  await fs.writeFile(path.join(f.root, 'workspace-control/relocation-finalizing.json'), 'finite stored fence')
  await f.admin.quiesceWorkspaceWebAccess()
  const response = await fetch(pathname, { headers })
  expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store'); expect(await response.json()).toEqual(snapshot)
  expect(call).toHaveBeenCalledTimes(1)
  expect(call).toHaveBeenCalledWith('get_workspace_relocation_status', {}, 'admin-web', { authorizationBearer: 'fixture-human', timeoutMs: 30_000 })
  expect((await fetch(f.endpoint + '/workspaces/default/usage/refresh', { method: 'POST', headers, body: '{}' })).status).toBe(503)
  expect(await fs.readFile(path.join(f.root, 'workspace-control/relocation-finalizing.json'), 'utf8')).toBe('finite stored fence')
})
it('fixed job status validates the identity and receipt without falling back from unknown to no job', async () => {
  const f = await fixture(), id = randomUUID(), headers = { Authorization: 'Bearer fixture-human' }
  const call = startRpc(f.admin, async () => ({ available: false, job: null }))
  const pathname = f.endpoint + '/workspaces/relocation/jobs/' + id
  const unknown = await fetch(pathname, { headers }); expect(unknown.status).toBe(200); expect(await unknown.json()).toEqual({ available: false, job: null })
  expect(call).toHaveBeenCalledWith('get_workspace_relocation_status', { intent_id: id }, 'admin-web', { authorizationBearer: 'fixture-human', timeoutMs: 30_000 })
  call.mockResolvedValueOnce({ available: true, job: { intent_id: randomUUID(), state: 'committed', stage: 'finished' } })
  expect((await fetch(pathname, { headers })).status).toBe(503)
  call.mockResolvedValueOnce({ available: false, job: { intent_id: id, state: 'completed', stage: 'finished' } })
  expect((await fetch(pathname, { headers })).status).toBe(503)
  expect((await fetch(f.endpoint + '/workspaces/relocation/jobs/not-a-job', { headers })).status).toBe(400)
  expect((await fetch(f.endpoint + '/workspaces/relocation/current?target=forged', { headers })).status).toBe(400)
  expect(call).toHaveBeenCalledTimes(3)
})


function recoveryConfirmation(interrupted = false) {
  const common = { intent_id: randomUUID(), recovery_id: randomUUID(), confirmed: true as const }
  return interrupted ? { ...common, checkpoint_sha256: 'a'.repeat(64) }
    : { ...common, completion_sha256: 'a'.repeat(64), finalizing_sha256: 'b'.repeat(64) }
}
it.each([false, true])('recovery HTTP is human-only and remains live behind its closed file drain: interrupted=%s', async interrupted => {
  const f = await fixture(), request = recoveryConfirmation(interrupted), headers = { Authorization: 'Bearer fixture-human', 'Content-Type': 'application/json' }
  const { recovery_id, confirmed, ...offer } = request
  const suggestion = interrupted ? { ...offer, action: 'restore_source' } : offer
  const call = startRpc(f.admin, async (method: string) => method === 'preview_workspace_relocation_recovery' ? { available: true, recovery: suggestion } : { intent_id: request.intent_id, recovery_id, accepted: true })
  const preview = f.endpoint + '/workspaces/relocation/jobs/' + request.intent_id + '/recovery', submit = f.endpoint + '/workspaces/relocation/recover'
  expect((await fetch(preview)).status).toBe(401)
  for (const token of ['fixture-internal', jwt.sign({ sub: 'agent-cli', exp: Math.floor(Date.now() / 1000) + 60 }, 'fixture-secret')]) {
    const denied = await fetch(submit, { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: '{broken' })
    expect(denied.status).toBe(403); expect(denied.headers.get('cache-control')).toBe('no-store')
  }
  expect(call).not.toHaveBeenCalled()
  await fs.writeFile(path.join(f.root, 'workspace-control/relocation-finalizing.json'), 'finite original fence')
  await f.admin.quiesceWorkspaceWebAccess()
  expect(await f.client.previewRelocationRecovery(request.intent_id)).toEqual({ available: true, recovery: suggestion })
  const response = await fetch(submit, { method: 'POST', headers, body: JSON.stringify(request) })
  expect(response.status).toBe(202); expect(response.headers.get('cache-control')).toBe('no-store')
  expect(await response.json()).toEqual({ intent_id: request.intent_id, recovery_id, accepted: true })
  expect(call).toHaveBeenLastCalledWith('start_workspace_relocation_recovery', request, 'admin-web', { authorizationBearer: 'fixture-human', timeoutMs: 120_000 })
  expect((await f.client.maintenance()).maintenance).toBe(true)
  expect((await fetch(f.endpoint + '/workspaces/default/usage/refresh', { method: 'POST', headers, body: '{}' })).status).toBe(503)
  expect(await fs.readFile(path.join(f.root, 'workspace-control/relocation-finalizing.json'), 'utf8')).toBe('finite original fence')
})
it.each([false, true])('recovery rejects injected input, mismatched replies and unknown admission without leaking raw errors: interrupted=%s', async interrupted => {
  const f = await fixture(), request = recoveryConfirmation(interrupted), headers = { Authorization: 'Bearer fixture-human', 'Content-Type': 'application/json' }
  const call = startRpc(f.admin, async () => ({ intent_id: request.intent_id, recovery_id: request.recovery_id, accepted: true }))
  const submit = (body: unknown) => fetch(f.endpoint + '/workspaces/relocation/recover', { method: 'POST', headers, body: JSON.stringify(body) })
  for (const body of [{ ...request, confirmed: false }, { ...request, path: '/forged' }, { ...request, action: 'finish_commit' }, { ...request, finalizing_sha256: 'bad' }]) expect((await submit(body)).status).toBe(400)
  expect((await fetch(f.endpoint + '/workspaces/relocation/jobs/not-a-job/recovery', { headers })).status).toBe(400)
  expect((await fetch(f.endpoint + '/workspaces/relocation/jobs/' + request.intent_id + '/recovery?source=x', { headers })).status).toBe(400)
  expect(call).not.toHaveBeenCalled()
  call.mockResolvedValueOnce({ intent_id: request.intent_id, recovery_id: randomUUID(), accepted: true })
  expect((await submit(request)).status).toBe(503)
  call.mockRejectedValueOnce(new Error('raw-private-auth-secret'))
  const unknown = await submit(request); expect(unknown.status).toBe(503); expect(await unknown.text()).not.toContain('raw-private-auth-secret')
  call.mockResolvedValueOnce({ available: false, recovery: null })
  expect(await f.client.previewRelocationRecovery(request.intent_id)).toEqual({ available: false, recovery: null })
})
it.each([false, true])('disconnecting recovery HTTP does not cancel the single already handed off admission: interrupted=%s', async interrupted => {
  const f = await fixture(), request = recoveryConfirmation(interrupted)
  let seen!: () => void, finish!: () => void, completed = false
  const entered = new Promise<void>(resolve => { seen = resolve }), release = new Promise<void>(resolve => { finish = resolve })
  const call = startRpc(f.admin, async () => { seen(); await release; await f.admin.quiesceWorkspaceWebAccess(); completed = true; return { intent_id: request.intent_id, recovery_id: request.recovery_id, accepted: true } })
  await fs.writeFile(path.join(f.root, 'workspace-control/relocation-finalizing.json'), 'finite original fence')
  const controller = new AbortController()
  const response = fetch(f.endpoint + '/workspaces/relocation/recover', { method: 'POST', headers: { Authorization: 'Bearer fixture-human' }, body: JSON.stringify(request), signal: controller.signal }).catch(error => error)
  await entered; controller.abort(); finish(); await response
  await vi.waitFor(() => expect(completed).toBe(true))
  expect(call).toHaveBeenCalledOnce()
})
