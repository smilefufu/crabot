import { describe, it, expect } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { WorkspaceCatalog } from 'crabot-shared/dist/workspace-catalog.js'
import { sha256CanonicalJson } from 'crabot-shared'
import { verifyWorkspaceRelocationAuthority } from '../../src/core/workspace-relocation-authority.js'

async function fixture(mode = 'normal') {
  const root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'crabot-agent-relocation-auth-')))
  const native = require('../../../scripts/lib/process-identity.cjs'), management = require('../../../scripts/lib/desktop-management.cjs')
  const records = await import('../../../scripts/lib/workspace-relocation-intent.mjs'), locks = await import('../../../scripts/lib/cli-lock.mjs')
  const data = management.ensurePrivateDataRoot(path.join(root, 'data')), calls: any[] = [], sockets = new Set()
  const id = randomUUID(), entry = new URL('../../../scripts/lib/workspace-coordinator-entry.mjs', import.meta.url).href
  let child: ReturnType<typeof spawn> | undefined, exited: Promise<unknown> | undefined, lock: string | undefined, launch: any, intent: any
  const server = http.createServer(async (req, res) => {
    let text = ''; for await (const bytes of req) text += bytes
    const body = JSON.parse(text); calls.push({ body, header_present: Boolean(req.headers.authorization) })
    if (mode === 'disconnect') { req.socket.destroy(); return }
    if (mode === 'mutate') {
      const file = path.join(data, 'workspace-control/relocation-coordinator-ready.json')
      const ready = JSON.parse(await fs.readFile(file, 'utf8'))
      await fs.writeFile(file, JSON.stringify({ ...ready, acquired_at: new Date(Date.parse(ready.acquired_at) + 1000).toISOString() }))
    }
    if (req.headers.authorization !== 'Bearer fixture-coordinator') { res.writeHead(403); res.end(JSON.stringify({ id: body.id, success: false, error: { code: 'FORBIDDEN' } })); return }
    const proof = { verified: mode !== 'false', intent_id: id, intent_sha256: mode === 'hash' ? '0'.repeat(64) : sha256CanonicalJson(intent),
      launch_id: launch.launch_id, launch_sha256: sha256CanonicalJson(launch), action: body.params.action, ...(mode === 'extra' ? { untrusted: true } : {}) }
    res.end(JSON.stringify({ id: body.id, success: true, data: proof }))
  })
  server.on('connection', socket => sockets.add(socket))
  const cleanup = async () => {
    locks.releaseCliLock(lock)
    if (child?.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await exited?.catch(() => {})
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()))
    await fs.rm(root, { recursive: true, force: true })
  }
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as { port: number }).port
    const catalog = new WorkspaceCatalog({ dataRoot: data, files: native }); await catalog.initialize()
    lock = await locks.acquireCliLock(data, 'workspace-relocation')
    intent = await records.beginWorkspaceRelocationIntent({ dataDir: data, id, target: path.join(root, 'relocated'), expectedRevision: (await catalog.snapshot()).revision, protectedRoots: [] })
    child = spawn(process.execPath, ['--input-type=module', '-e', `import{enterWorkspaceRelocationCoordinator}from ${JSON.stringify(entry)};await enterWorkspaceRelocationCoordinator();process.send({kind:'fixture-ready'});setTimeout(()=>process.exit(0),30000);`], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
    const messages: any[] = []; let errors = ''
    child.on('message', message => messages.push(message)); child.stderr!.on('data', bytes => { errors += bytes.toString() })
    exited = once(child, 'exit'); void exited.catch(() => {})
    await once(child, 'spawn')
    launch = records.commitWorkspaceRelocationCoordinator({ dataDir: data, id, launchId: randomUUID(), coordinator: native.inspectProcess(child.pid) })
    locks.releaseCliLock(lock)
    child.send!({ kind: 'workspace_relocation_start', data_dir: data, intent_id: id, launch_id: launch.launch_id, launch_sha256: sha256CanonicalJson(launch) })
    const deadline = Date.now() + 10000
    while (!messages.some(message => message.kind === 'fixture-ready')) {
      if (Date.now() > deadline) throw new Error('finite coordinator not ready: ' + errors)
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    const params = { intent_id: id, launch_id: launch.launch_id, action: 'capture_workers' as const }
    return { root, data, calls, sockets, launch, intent, records, options: { dataDir: data, moduleManagerPort: port, params, bearer: 'fixture-coordinator' }, cleanup }
  } catch (error) { await cleanup(); throw error }
}

describe('Agent consumes only its private job proof from the actual MM connection', () => {
  it('uses one native-bound connection, the correct source and header-only bearer without writing job data', async () => {
    const f = await fixture()
    try {
      const before = await fs.readFile(path.join(f.data, 'workspace-control/relocation.json'))
      expect(await verifyWorkspaceRelocationAuthority(f.options)).toEqual({ verified: true, ...f.options.params,
        intent_sha256: sha256CanonicalJson(f.intent), launch_sha256: sha256CanonicalJson(f.launch) })
      expect(f.calls).toHaveLength(1); expect(f.calls[0].header_present).toBe(true)
      expect(f.calls[0].body.source).toBe('crabot-agent')
      expect(JSON.stringify(f.calls)).not.toContain(f.options.bearer)
      expect(f.sockets.size).toBe(1)
      expect(await fs.readFile(path.join(f.data, 'workspace-control/relocation.json'))).toEqual(before)
      await expect(fs.stat(path.join(f.root, 'relocated'))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally { await f.cleanup() }
  }, 30000)
  it('refuses missing credentials before inspecting a missing data root or connecting', async () => {
    const f = await fixture()
    try {
      await expect(verifyWorkspaceRelocationAuthority({ ...f.options, dataDir: path.join(f.root, 'absent'), bearer: undefined })).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
      expect(f.calls).toEqual([])
    } finally { await f.cleanup() }
  }, 30000)
  it('rejects a wrong fixed job and malformed params before forwarding credentials', async () => {
    const f = await fixture()
    try {
      await expect(verifyWorkspaceRelocationAuthority({ ...f.options, params: { ...f.options.params, intent_id: randomUUID() } })).rejects.toMatchObject({ code: 'FORBIDDEN' })
      await expect(verifyWorkspaceRelocationAuthority({ ...f.options, params: { ...f.options.params, action: 'move_files' } as any })).rejects.toMatchObject({ code: 'INVALID_PARAMS' })
      expect(f.calls).toEqual([])
    } finally { await f.cleanup() }
  }, 30000)
  it('refuses a coherent private record with the wrong MM creation identity before sending any bearer', async () => {
    const f = await fixture()
    try {
      const control = path.join(f.data, 'workspace-control'), launch = { ...f.launch, parent: { ...f.launch.parent, started: 'wrong-generation' } }
      const readyFile = path.join(control, 'relocation-coordinator-ready.json'), ready = JSON.parse(await fs.readFile(readyFile, 'utf8'))
      await fs.writeFile(path.join(control, 'relocation-coordinator.json'), JSON.stringify(launch))
      await fs.writeFile(readyFile, JSON.stringify({ ...ready, launch_sha256: sha256CanonicalJson(launch) }))
      await expect(verifyWorkspaceRelocationAuthority(f.options)).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
      expect(f.calls).toEqual([])
    } finally { await f.cleanup() }
  }, 30000)
  for (const mode of ['hash', 'extra', 'false', 'disconnect', 'mutate']) it(`does not treat an unverified response as authority: ${mode}`, async () => {
    const f = await fixture(mode)
    try {
      await expect(verifyWorkspaceRelocationAuthority(f.options)).rejects.toMatchObject({ code: mode === 'hash' ? 'FORBIDDEN' : 'SERVICE_UNAVAILABLE' })
      expect(f.calls).toHaveLength(1); expect(f.sockets.size).toBe(1)
    } finally { await f.cleanup() }
  }, 30000)
})
