import fs from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { WorkspaceCatalog } from 'crabot-shared/dist/workspace-catalog.js'
import { sha256CanonicalJson } from 'crabot-shared'

export async function relocationMmFixture(mode = 'normal', withJournal = false) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'crabot-agent-relocation-auth-')))
  const native = require('../../../../scripts/lib/process-identity.cjs'), management = require('../../../../scripts/lib/desktop-management.cjs')
  const records = await import('../../../../scripts/lib/workspace-relocation-intent.mjs'), locks = await import('../../../../scripts/lib/cli-lock.mjs')
  const data = management.ensurePrivateDataRoot(path.join(root, 'data')), calls: any[] = [], sockets = new Set()
  const id = randomUUID(), entry = new URL('../../../../scripts/lib/workspace-coordinator-entry.mjs', import.meta.url).href
  let child: ReturnType<typeof spawn> | undefined, exited: Promise<unknown> | undefined, lock: string | undefined, launch: any, intent: any, journal: any, moduleJournal: any
  let authorized = true, dropped = false
  const server = http.createServer(async (req, res) => {
    let text = ''; for await (const bytes of req) text += bytes
    const body = JSON.parse(text); calls.push({ body, header_present: Boolean(req.headers.authorization) })
    if (mode === 'disconnect') { req.socket.destroy(); return }
    if (mode === 'mutate') {
      const file = path.join(data, 'workspace-control/relocation-coordinator-ready.json')
      const ready = JSON.parse(await fs.readFile(file, 'utf8'))
      await fs.writeFile(file, JSON.stringify({ ...ready, acquired_at: new Date(Date.parse(ready.acquired_at) + 1000).toISOString() }))
    }
    if (!authorized || req.headers.authorization !== 'Bearer fixture-coordinator') { res.writeHead(403); res.end(JSON.stringify({ id: body.id, success: false, error: { code: 'FORBIDDEN' } })); return }
    try {
      let result: any
      if (body.method === 'verify_workspace_relocation_coordinator') {
        if (mode === 'scope-change-on-second-proof' && calls.filter(call => call.body.method === 'verify_workspace_relocation_coordinator').length === 2) {
          const file = path.join(data, 'workspace-control/relocation-workers.json'), stored = JSON.parse(await fs.readFile(file, 'utf8'))
          await fs.writeFile(file, JSON.stringify({ ...stored, created_at: new Date(Date.parse(stored.created_at) + 1000).toISOString() }))
        }
        result = { verified: mode !== 'false', intent_id: id, intent_sha256: mode === 'hash' ? '0'.repeat(64) : sha256CanonicalJson(intent),
          launch_id: launch.launch_id, launch_sha256: sha256CanonicalJson(launch), action: body.params.action, ...(mode === 'extra' ? { untrusted: true } : {}) }
      } else if (body.method === 'prepare_workspace_relocation_worker_stops' && journal) {
        result = { dispatch: mode === 'false-prepare' ? 'dispatch' : await journal.prepare(records.readWorkspaceRelocationWorkers(data, id).workers) }
        if (mode === 'extra-prepare') result.extra = true
        if (mode === 'revoke-prepare') authorized = false
        if (mode === 'scope-change-prepare') {
          const file = path.join(data, 'workspace-control/relocation-workers.json'), value = JSON.parse(await fs.readFile(file, 'utf8'))
          value.workers[0].incarnations[0].workspace += '-changed'
          await fs.writeFile(file, JSON.stringify(value))
        }
        if (mode === 'drop-prepare' && !dropped) { dropped = true; req.socket.destroy(); return }
      } else if (body.method === 'complete_workspace_relocation_worker_stops' && journal) {
        if (mode !== 'false-complete') await journal.complete(body.params.results)
        result = { recorded: true }
        if (mode === 'drop-complete' && !dropped) { dropped = true; req.socket.destroy(); return }
      } else throw new Error('Unexpected finite fixture method')
      res.end(JSON.stringify({ id: body.id, success: true, data: result }))
    } catch { res.writeHead(503); res.end(JSON.stringify({ id: body.id, success: false, error: { code: 'SERVICE_UNAVAILABLE' } })) }
  })
  server.on('connection', socket => sockets.add(socket))
  const cleanup = async () => {
    moduleJournal?.close(); journal?.close()
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
    const journalEntry = new URL('../../../../scripts/lib/workspace-worker-journal.mjs', import.meta.url).href
    const moduleJournalEntry = new URL('../../../../scripts/lib/workspace-module-journal.mjs', import.meta.url).href
    child = spawn(process.execPath, ['--input-type=module', '-e', `import{enterWorkspaceRelocationCoordinator}from ${JSON.stringify(entry)};import{serveWorkspaceWorkerJournal}from ${JSON.stringify(journalEntry)};import{serveWorkspaceModuleJournal}from ${JSON.stringify(moduleJournalEntry)};const context=await enterWorkspaceRelocationCoordinator();if(${withJournal})serveWorkspaceWorkerJournal(context);if(${JSON.stringify(mode)}==='module-stop-started')serveWorkspaceModuleJournal(context);process.send({kind:'fixture-ready'});setTimeout(()=>process.exit(0),30000);`], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
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
    if (withJournal) {
      const { createWorkspaceWorkerJournal } = await import('../../../../scripts/lib/workspace-worker-journal.mjs')
      journal = createWorkspaceWorkerJournal(child, { dataDir: data, id, launch })
    }
    if (mode === 'module-stop-started') {
      const { createWorkspaceModuleJournal } = await import('../../../../scripts/lib/workspace-module-journal.mjs')
      moduleJournal = createWorkspaceModuleJournal(child, { dataDir: data, id, launch })
    }
    const params = { intent_id: id, launch_id: launch.launch_id, action: 'capture_workers' as const }
    return { root, data, calls, sockets, launch, intent, records, journal, moduleJournal, revoke: () => { authorized = false }, options: { dataDir: data, moduleManagerPort: port, params, bearer: 'fixture-coordinator' }, cleanup }
  } catch (error) { await cleanup(); throw error }
}
