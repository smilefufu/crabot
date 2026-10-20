import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import native from '../process-identity.cjs'
import management from '../desktop-management.cjs'
import { acquireCliLock, acquireWorkspaceRelocationLock, cliLockToken, releaseCliLock } from '../cli-lock.mjs'
import { beginWorkspaceRelocationIntent, readWorkspaceRelocationCoordinator, readWorkspaceRelocationWorkers, readWorkspaceRelocationModules, readWorkspaceRelocationStops, readWorkspaceRelocationModuleStops } from '../workspace-relocation-intent.mjs'
import { launchWorkspaceRelocationCoordinator } from '../workspace-coordinator-launch.mjs'
import { createWorkspaceWorkerJournal } from '../workspace-worker-journal.mjs'
import { createWorkspaceModuleJournal } from '../workspace-module-journal.mjs'
import { createWorkspaceProcessJournal } from '../workspace-process-journal.mjs'
import { WorkspaceCatalog } from '../../../crabot-shared/dist/workspace-catalog.js'
import { sha256CanonicalJson } from '../../../crabot-shared/dist/canonical-json.js'

async function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'coordinator-launch-')))
  const data = management.ensurePrivateDataRoot(path.join(root, 'data')), id = randomUUID()
  const catalog = new WorkspaceCatalog({ dataRoot: data, files: native }); await catalog.initialize()
  const before = await catalog.snapshot(), marker = path.join(before.storage_root, 'original.txt')
  fs.writeFileSync(marker, 'original work')
  const lock = await acquireCliLock(data, 'workspace-relocation')
  await beginWorkspaceRelocationIntent({ dataDir: data, id, target: path.join(root, 'new'), expectedRevision: before.revision, protectedRoots: [] })
  let coordinator
  const close = async () => {
    if (coordinator) {
      const child = coordinator.child
      if (child.exitCode === null && child.signalCode === null) {
        const ended = once(child, 'exit')
        if (child.connected) child.disconnect()
        await ended
      }
    }
  }
  t.after(async () => { await close(); releaseCliLock(lock); fs.rmSync(root, { recursive: true, force: true }) })
  return { root, data, id, lock, before, catalog, marker, close,
    launch: async options => { coordinator = await launchWorkspaceRelocationCoordinator(options ?? { dataDir: data, id }); return coordinator } }
}

test('the actual fixed script owns the lock and serves the first journals before launch returns', { timeout: 20000 }, async t => {
  const f = await fixture(t), result = await f.launch(), { child, launch, ready } = result
  const worker = createWorkspaceWorkerJournal(child, { dataDir: f.data, id: f.id, launch })
  const modules = createWorkspaceModuleJournal(child, { dataDir: f.data, id: f.id, launch })
  const processes = createWorkspaceProcessJournal(child, { dataDir: f.data, id: f.id, launch })
  try {
    assert.equal(cliLockToken(f.lock), undefined)
    assert.ok(native.sameProcess(launch.process, native.inspectProcess(child.pid)))
    assert.equal(launch.parent.pid, process.pid)
    assert.deepEqual(readWorkspaceRelocationCoordinator(f.data, f.id), { launch, ready })
    await assert.rejects(acquireWorkspaceRelocationLock(f.data, f.id, 0), /another crabot CLI operation/)
    await worker.capture([]); await worker.captureProcesses([]); await modules.capture([])
    assert.equal(await processes.prepare(), 'dispatch'); assert.equal(await processes.prepare(), 'observe')
    await processes.observe([]); await processes.complete()
    assert.deepEqual(readWorkspaceRelocationWorkers(f.data, f.id).workers, [])
    assert.deepEqual(readWorkspaceRelocationModules(f.data, f.id).modules, [])
    assert.equal(readWorkspaceRelocationStops(f.data, f.id).attempt, null)
    assert.equal(readWorkspaceRelocationModuleStops(f.data, f.id).attempt, null)
    assert.deepEqual(await f.catalog.snapshot(), f.before)
    assert.equal(fs.readFileSync(f.marker, 'utf8'), 'original work')
    assert.equal(fs.existsSync(path.join(f.root, 'new')), false)
    const beforeHash = sha256CanonicalJson({ launch, ready })
    await f.close()
    assert.equal(sha256CanonicalJson(readWorkspaceRelocationCoordinator(f.data, f.id)), beforeHash)
    const lock = await acquireWorkspaceRelocationLock(f.data, f.id, 0); releaseCliLock(lock)
  } finally { worker.close(); modules.close(); processes.close() }
})

for (const mode of ['missing lock', 'wrong id', 'extra entry']) test('rejects before publishing a new launch: ' + mode, async t => {
  const f = await fixture(t)
  if (mode === 'missing lock') releaseCliLock(f.lock)
  const input = { dataDir: f.data, id: mode === 'wrong id' ? randomUUID() : f.id, ...(mode === 'extra entry' ? { entry: '/not-accepted' } : {}) }
  await assert.rejects(f.launch(input), { code: 'CRABOT_WORKSPACE_COORDINATOR' })
  assert.deepEqual(readWorkspaceRelocationCoordinator(f.data, f.id), { launch: null, ready: null })
  assert.equal(fs.readFileSync(f.marker, 'utf8'), 'original work')
})

test('does not inherit a parent Node loader and cannot create a second launch', { timeout: 20000 }, async t => {
  const f = await fixture(t), marker = path.join(f.root, 'loader-ran'), preload = path.join(f.root, 'parent-only.cjs')
  fs.writeFileSync(preload, `require('node:fs').writeFileSync(${JSON.stringify(marker)},'must not inherit')`)
  const previous = process.env.NODE_OPTIONS
  process.env.NODE_OPTIONS = '--require ' + JSON.stringify(preload)
  let first
  try { first = await f.launch() }
  finally { if (previous === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = previous }
  assert.equal(fs.existsSync(marker), false)
  const before = readWorkspaceRelocationCoordinator(f.data, f.id)
  await assert.rejects(launchWorkspaceRelocationCoordinator({ dataDir: f.data, id: f.id }), { code: 'CRABOT_WORKSPACE_COORDINATOR' })
  assert.deepEqual(readWorkspaceRelocationCoordinator(f.data, f.id), before)
  assert.equal(first.child.exitCode, null)
})

test('a concurrent launch cannot spawn another child before the first record is published', { timeout: 20000 }, async t => {
  const f = await fixture(t), before = new Set(native.listChildProcessIds(process.pid))
  const first = f.launch(), second = launchWorkspaceRelocationCoordinator({ dataDir: f.data, id: f.id })
  const settled = Promise.allSettled([first, second])
  try { assert.equal(native.listChildProcessIds(process.pid).filter(pid => !before.has(pid)).length, 1) }
  finally { await settled }
  const results = await settled
  assert.equal(results[0].status, 'fulfilled'); assert.equal(results[1].status, 'rejected')
  assert.equal(results[1].reason.code, 'CRABOT_WORKSPACE_COORDINATOR')
})
