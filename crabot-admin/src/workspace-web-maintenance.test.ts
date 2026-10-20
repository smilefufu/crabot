import { afterEach, describe, expect, it, vi } from 'vitest'
import http from 'node:http'
import { once } from 'node:events'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import AdminModule from './index.js'
import { WorkspaceService } from './workspaces.js'

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const close of cleanup.splice(0).reverse()) await close()
})
async function fixture(scan?: ConstructorParameters<typeof WorkspaceService>[0]['scan']) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'crabot-workspace-web-')))
  cleanup.push(() => fs.rm(root, { recursive: true, force: true }))
  const service = new WorkspaceService({ dataRoot: root, scan }); await service.initialize()
  cleanup.push(() => service.close())
  const admin = Object.create(AdminModule.prototype) as any
  admin.adminConfig = { data_dir: path.join(root, 'admin'), web_port: 0 }; admin.jwtSecret = 'fixture-web-maintenance'; admin.cutoverActivated = true
  admin.workspaceService = service
  admin.verifyAuthenticatedToken = vi.fn(async (token: string) => token === 'fixture-human' ? { sub: 'admin' } : token === 'fixture-internal' ? { sub: 'internal' } : null)
  admin.voiceAdmin = { handleWeb: vi.fn(async () => false) }
  admin.handleListFriendsApi = vi.fn(async (_req, res) => { res.writeHead(200); res.end('{"friends":[]}') })
  admin.handleLogin = vi.fn(async (_req, res) => { res.writeHead(200); res.end('{"fixture_login":true}') })
  const errors: unknown[] = []
  const server = http.createServer((req, res) => {
    void admin.handleWebRequest(req, res).catch(error => { errors.push(error); if (!res.headersSent) res.writeHead(500); res.end() })
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  cleanup.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) })
  const endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  const headers = { Authorization: 'Bearer fixture-human', 'Content-Type': 'application/json' }
  const fence = (name = 'relocation.json') => fs.writeFile(path.join(root, 'workspace-control', name), '{not valid authority}')
  return { root, admin, service, errors, endpoint, headers, fence }
}

describe('Admin workspace maintenance HTTP admission', () => {
  it.each(['relocation.json', 'relocation-coordinator-ready.json', 'relocation-module-stop-submission.json'])('blocks new writes under %s while authentication and management reads remain online', async name => {
    const f = await fixture(), id = randomUUID(), before = await f.service.list()
    await f.fence(name)
    const input = { method: 'POST', headers: f.headers, body: JSON.stringify({ workspace_id: id, name: 'must not create' }) }
    const denied = await fetch(f.endpoint + '/api/workspaces', input)
    expect(denied.status).toBe(503); expect(await denied.json()).toMatchObject({ code: 'WORKSPACE_MAINTENANCE' })
    expect((await f.service.list()).revision).toBe(before.revision); expect((await f.service.list()).items).toHaveLength(1)
    expect((await fetch(f.endpoint + '/api/workspaces', { ...input, headers: {} })).status).toBe(401)
    expect((await fetch(f.endpoint + '/api/workspaces', { ...input, headers: { Authorization: 'Bearer fixture-internal' } })).status).toBe(403)
    expect((await fetch(f.endpoint + '/api/workspaces', { headers: f.headers })).status).toBe(200)
    expect((await fetch(f.endpoint + '/api/friends', { headers: f.headers })).status).toBe(200)
    expect((await fetch(f.endpoint + '/api/auth/login', { method: 'POST' })).status).toBe(200); expect(f.errors).toEqual([])
  })
  it('does not let a corrupt control directory permit writes, and does not affect another instance', async () => {
    const f = await fixture(), other = await fixture()
    await fs.rename(path.join(f.root, 'workspace-control'), path.join(f.root, 'retained-control'))
    await fs.writeFile(path.join(f.root, 'workspace-control'), 'broken')
    const body = JSON.stringify({ workspace_id: randomUUID(), name: 'isolated' })
    expect((await fetch(f.endpoint + '/api/workspaces', { method: 'POST', headers: f.headers, body })).status).toBe(503)
    expect((await fetch(other.endpoint + '/api/workspaces', { method: 'POST', headers: other.headers, body })).status).toBe(200)
  })
  it('checks the fence after asynchronous authentication and before business or file handlers', async () => {
    const f = await fixture(), mutation = vi.fn(async (_req, res) => { res.writeHead(200); res.end('{}') })
    f.admin.handlePostChatMessageApi = mutation
    f.admin.verifyAuthenticatedToken = vi.fn(async () => { await f.fence(); return { sub: 'admin' } })
    expect((await fetch(f.endpoint + '/api/chat/messages', { method: 'POST', headers: f.headers, body: '{"text":"do not execute"}' })).status).toBe(503)
    expect(mutation).not.toHaveBeenCalled()
    for (const route of ['/api/backup/export', '/api/channels/onboard/poll', '/tmp-pages/fixture/']) {
      expect((await fetch(f.endpoint + route, { headers: f.headers })).status).toBe(503)
    }
  })
  it('waits for an admitted HTTP body and its real catalog write before draining; closed admission stays closed', async () => {
    const f = await fixture(), id = randomUUID(), read = vi.spyOn(f.admin, 'readJsonBody')
    expect(typeof f.admin.quiesceWorkspaceWebAccess).toBe('function')
    const req = http.request(f.endpoint + '/api/workspaces', { method: 'POST', headers: f.headers })
    req.on('error', () => {}); const response = once(req, 'response'); req.write('{')
    let drained = false
    try {
      await vi.waitFor(() => expect(read).toHaveBeenCalledOnce()); await f.fence()
      const drainage = f.admin.quiesceWorkspaceWebAccess().then(() => { drained = true })
      await Promise.resolve(); expect(drained).toBe(false)
      expect((await fetch(f.endpoint + '/api/workspaces', { method: 'POST', headers: f.headers, body: '{}' })).status).toBe(503)
      req.end(JSON.stringify({ workspace_id: id, name: 'admitted before freeze' }).slice(1))
      const [res] = await response; res.resume(); await once(res, 'end'); await drainage
      expect(res.statusCode).toBe(200); expect(drained).toBe(true)
      expect((await f.service.get(id)).item.workspace.name).toBe('admitted before freeze')
      await fs.rm(path.join(f.root, 'workspace-control/relocation.json'))
      expect((await fetch(f.endpoint + '/api/workspaces', { method: 'POST', headers: f.headers, body: '{}' })).status).toBe(503)
      expect((await fetch(f.endpoint + '/api/friends', { headers: f.headers })).status).toBe(200)
    } finally { req.destroy(); void response.catch(() => {}) }
  })
  it('keeps a real file handle pending after client disconnect, and authenticates new media before refusing it', async () => {
    const f = await fixture(), file = path.join((await f.service.get('default')).item.workspace.root, 'media.txt')
    expect(typeof f.admin.quiesceWorkspaceWebAccess).toBe('function')
    await fs.writeFile(file, 'unchanged media')
    f.admin.mediaStore = { resolve: vi.fn(() => ({ abs_path: file, mime_type: 'text/plain', filename: 'media.txt' })) }
    let release!: () => void, opened: Awaited<ReturnType<typeof fs.open>> | undefined, drained = false
    const wait = new Promise<void>(resolve => { release = resolve }), read = fs.readFile.bind(fs)
    vi.spyOn(fs, 'readFile').mockImplementation(async (...args: Parameters<typeof fs.readFile>) => {
      if (args[0] !== file) return read(...args)
      opened = await fs.open(file, 'r')
      try { await wait; return await opened.readFile() } finally { await opened.close() }
    })
    const req = http.get(f.endpoint + '/api/media/item', { headers: f.headers }); req.on('error', () => {})
    try {
      await vi.waitFor(() => expect(opened?.fd).toBeGreaterThanOrEqual(0)); await f.fence()
      const drainage = f.admin.quiesceWorkspaceWebAccess().then(() => { drained = true })
      req.destroy(); await Promise.resolve(); expect(drained).toBe(false)
      expect((await fetch(f.endpoint + '/api/media/item')).status).toBe(401)
      const denied = await fetch(f.endpoint + '/api/media/item', { headers: f.headers })
      expect(denied.status).toBe(503); expect(await denied.json()).toMatchObject({ code: 'WORKSPACE_MAINTENANCE' })
      expect(f.admin.mediaStore.resolve).toHaveBeenCalledOnce()
      expect((await fetch(f.endpoint + '/api/friends', { headers: f.headers })).status).toBe(200)
      release(); await drainage; expect(opened?.fd).toBe(-1); expect(f.errors).toEqual([])
    } finally { release(); req.destroy() }
  })
  it('waits for handler finally cleanup even if its response already finished', async () => {
    const f = await fixture(), file = path.join(f.root, 'admitted.txt')
    expect(typeof f.admin.quiesceWorkspaceWebAccess).toBe('function')
    let release!: () => void, started = false, drained = false, closed = false
    const wait = new Promise<void>(resolve => { release = resolve })
    f.admin.handleCreateFriendApi = vi.fn(async (_req, res) => {
      const handle = await fs.open(file, 'w'); started = true
      try { res.writeHead(200); res.end('{}'); await wait }
      finally { await handle.close(); closed = true }
    })
    const request = fetch(f.endpoint + '/api/friends', { method: 'POST', headers: f.headers, body: '{}' })
    try {
      await vi.waitFor(() => expect(started).toBe(true)); expect((await request).status).toBe(200); await f.fence()
      const drainage = f.admin.quiesceWorkspaceWebAccess().then(() => { drained = true })
      await Promise.resolve(); expect(drained).toBe(false); expect(closed).toBe(false)
      release(); await drainage; expect(closed).toBe(true); expect(drained).toBe(true)
    } finally { release(); await request }
  })
  it('refuses internal drainage without a durable fence before pausing statistics', async () => {
    const f = await fixture(), pause = vi.spyOn(f.service, 'pauseScanning')
    await expect(f.admin.quiesceWorkspaceWebAccess()).rejects.toMatchObject({ code: 'WORKSPACE_MAINTENANCE' })
    expect(pause).not.toHaveBeenCalled()
    expect((await f.service.refresh('default')).usage.status).toBe('measuring')
  })
  it('drains a failed handler only after its real file cleanup and preserves the original failure response', async () => {
    const f = await fixture(), file = path.join(f.root, 'failed-write.txt')
    let release!: () => void, started = false, drained = false, closed = false
    const wait = new Promise<void>(resolve => { release = resolve })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    f.admin.handleCreateFriendApi = vi.fn(async () => {
      const handle = await fs.open(file, 'w'); started = true
      try { await wait; throw new Error('fixture handler failure') }
      finally { await handle.close(); closed = true }
    })
    const request = fetch(f.endpoint + '/api/friends', { method: 'POST', headers: f.headers, body: '{}' })
    try {
      await vi.waitFor(() => expect(started).toBe(true)); await f.fence()
      const drainage = f.admin.quiesceWorkspaceWebAccess().then(() => { drained = true })
      await Promise.resolve(); expect(drained).toBe(false); expect(closed).toBe(false)
      release(); await drainage
      expect((await request).status).toBe(500); expect(closed).toBe(true); expect(f.errors).toEqual([])
    } finally { release(); await request }
  })
  it('also waits for the original scan handle to close, without treating it as execution exit', async () => {
    let release!: () => void, opened: Awaited<ReturnType<typeof fs.open>> | undefined, aborted = false, drained = false
    const wait = new Promise<void>(resolve => { release = resolve })
    const f = await fixture(async (root, options) => {
      opened = await fs.open(path.join(root, 'scan.txt'), 'r')
      options?.signal?.addEventListener('abort', () => { aborted = true }, { once: true })
      try { await wait; return { status: 'complete', logical_bytes: 1, file_count: 1, skipped_entries: 0 } }
      finally { await opened.close() }
    })
    expect(typeof f.admin.quiesceWorkspaceWebAccess).toBe('function')
    await fs.writeFile(path.join((await f.service.get('default')).item.workspace.root, 'scan.txt'), 'x'); await f.service.refresh('default')
    try {
      await vi.waitFor(() => expect(opened?.fd).toBeGreaterThanOrEqual(0)); await f.fence()
      const drainage = f.admin.quiesceWorkspaceWebAccess().then(() => { drained = true })
      await vi.waitFor(() => expect(aborted).toBe(true)); expect(drained).toBe(false)
      release(); await drainage; expect(opened?.fd).toBe(-1)
      expect((await f.service.usage('default')).usage.status).toBe('failed')
    } finally { release() }
  })
})
