import test from 'node:test'
import assert from 'node:assert/strict'
import syncFs, { promises as fs } from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import management from '../desktop-management.cjs'
import native from '../process-identity.cjs'
import { acquireCliLock, acquireWorkspaceRelocationLock, releaseCliLock } from '../cli-lock.mjs'
import { beginVersionMaintenance } from '../version-maintenance.mjs'
import { writeCoreRelease } from '../core-release.mjs'
import { WorkspaceCatalog } from '../../../crabot-shared/dist/workspace-catalog.js'
import { assertWorkspaceExecutionAllowed } from '../../../crabot-shared/dist/workspace-maintenance.js'
import { commitWorkspaceRelocationModules, readWorkspaceRelocationModules, prepareWorkspaceRelocationModuleStops, observeWorkspaceRelocationModuleProcesses, completeWorkspaceRelocationModuleStops, readWorkspaceRelocationModuleStops, beginWorkspaceRelocationIntent, readWorkspaceRelocationIntent, commitWorkspaceRelocationWorkers, readWorkspaceRelocationWorkers, prepareWorkspaceRelocationStops, completeWorkspaceRelocationStops, readWorkspaceRelocationStops } from '../workspace-relocation-intent.mjs'

async function fixture(t, beforeCleanup = () => {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'crabot-relocation-intent-中文 space-')))
  t.after(async () => { await beforeCleanup(); await fs.rm(root, { recursive: true, force: true }) })
  const data = management.ensurePrivateDataRoot(path.join(root, 'data'))
  const catalog = new WorkspaceCatalog({ dataRoot: data, files: native })
  await catalog.initialize()
  const snapshot = await catalog.snapshot(), source = snapshot.storage_root
  await fs.writeFile(path.join(source, 'default/original.txt'), 'user bytes')
  const input = { dataDir: data, id: randomUUID(), target: path.join(root, 'new workspace'), expectedRevision: snapshot.revision,
    protectedRoots: [path.join(data, 'workspace-control')] }
  const recordFile = path.join(data, 'workspace-control/relocation.json')
  return { root, data, catalog, snapshot, source, input, recordFile }
}

test('an initial intent requires the actual instance operation lock before publishing a fence', async t => {
  const f = await fixture(t)
  await assert.rejects(beginWorkspaceRelocationIntent(f.input), { code: 'WORKSPACE_RELOCATION_INVALID' })
  assert.equal(readWorkspaceRelocationIntent(f.data), null)
  assertWorkspaceExecutionAllowed(f.data)
  assert.equal(await fs.readFile(path.join(f.source, 'default/original.txt'), 'utf8'), 'user bytes')
})

test('publication is durable and retryable without moving files, changing catalog, or relaxing execution', async t => {
  const f = await fixture(t), lock = await acquireCliLock(f.data, 'workspace-relocation')
  try {
    const result = await beginWorkspaceRelocationIntent(f.input)
    assert.equal(result.phase, 'freezing'); assert.equal(result.id, f.input.id)
    assert.equal(typeof result.source.ino, 'string')
    assert.deepEqual(readWorkspaceRelocationIntent(f.data), result)
    assert.deepEqual(await beginWorkspaceRelocationIntent(f.input), result)
    assert.throws(() => assertWorkspaceExecutionAllowed(f.data), { code: 'WORKSPACE_MAINTENANCE' })
    assert.deepEqual(await f.catalog.snapshot(), f.snapshot)
    assert.equal(await fs.readFile(path.join(f.source, 'default/original.txt'), 'utf8'), 'user bytes')
    await assert.rejects(fs.stat(f.input.target), { code: 'ENOENT' })
    assert.deepEqual((await fs.readdir(path.dirname(f.recordFile))).filter(name => name.startsWith('.relocation-')), [])
  } finally { releaseCliLock(lock) }
})

test('another id or conflicting retry input cannot replace an accepted intent', async t => {
  const f = await fixture(t), lock = await acquireCliLock(f.data, 'workspace-relocation')
  try {
    await beginWorkspaceRelocationIntent(f.input)
    const before = await fs.readFile(f.recordFile)
    for (const patch of [{ id: randomUUID() }, { target: path.join(f.root, 'different') }, { expectedRevision: f.snapshot.revision + 1 }]) {
      await assert.rejects(beginWorkspaceRelocationIntent({ ...f.input, ...patch }), { code: 'WORKSPACE_RELOCATION_CONFLICT' })
      assert.deepEqual(await fs.readFile(f.recordFile), before)
    }
  } finally { releaseCliLock(lock) }
})

test('stale catalog or nonempty target rejects before a maintenance record exists', async t => {
  const f = await fixture(t), lock = await acquireCliLock(f.data, 'workspace-relocation')
  try {
    await assert.rejects(beginWorkspaceRelocationIntent({ ...f.input, expectedRevision: f.snapshot.revision + 1 }), { code: 'WORKSPACE_REVISION_CONFLICT' })
    await fs.mkdir(f.input.target); await fs.writeFile(path.join(f.input.target, 'keep'), 'keep')
    await assert.rejects(beginWorkspaceRelocationIntent(f.input), { code: 'WORKSPACE_DIRECTORY_CONFLICT' })
    assert.equal(readWorkspaceRelocationIntent(f.data), null)
    assertWorkspaceExecutionAllowed(f.data)
    assert.equal(await fs.readFile(path.join(f.input.target, 'keep'), 'utf8'), 'keep')
  } finally { releaseCliLock(lock) }
})

test('selecting the current root is unchanged and does not create protection', async t => {
  const f = await fixture(t), lock = await acquireCliLock(f.data, 'workspace-relocation')
  try {
    assert.deepEqual(await beginWorkspaceRelocationIntent({ ...f.input, target: f.source }), { unchanged: true, source: f.source })
    assert.equal(readWorkspaceRelocationIntent(f.data), null)
  } finally { releaseCliLock(lock) }
})

for (const damage of ['json', 'instance', 'link', 'control']) test('damaged control retains the fence: ' + damage, async t => {
  const f = await fixture(t), lock = await acquireCliLock(f.data, 'workspace-relocation')
  try {
    const record = await beginWorkspaceRelocationIntent(f.input)
    if (damage === 'json') await fs.writeFile(f.recordFile, 'broken')
    if (damage === 'control') {
      const retained = path.join(f.root, 'retained-control'); await fs.rename(path.dirname(f.recordFile), retained)
      management.ensurePrivateDataRoot(path.dirname(f.recordFile))
      await fs.copyFile(path.join(retained, 'relocation.json'), f.recordFile)
    }
    if (damage === 'instance') await fs.writeFile(f.recordFile, JSON.stringify({ ...record, data_root: { ...record.data_root, ino: '0' } }))
    if (damage === 'link') {
      const retained = path.join(f.root, 'retained.json'); await fs.rename(f.recordFile, retained)
      await fs.symlink(retained, f.recordFile, 'file')
    }
    await assert.rejects(beginWorkspaceRelocationIntent(f.input), { code: 'WORKSPACE_RELOCATION_INVALID' })
    assert.throws(() => readWorkspaceRelocationIntent(f.data), { code: 'WORKSPACE_RELOCATION_INVALID' })
    assert.throws(() => assertWorkspaceExecutionAllowed(f.data), { code: 'WORKSPACE_MAINTENANCE' })
  } finally { releaseCliLock(lock) }
})


test('a fresh process can read the same durable intent after the publishing lock is released', async t => {
  const f = await fixture(t), lock = await acquireCliLock(f.data, 'workspace-relocation')
  let result
  try { result = await beginWorkspaceRelocationIntent(f.input) } finally { releaseCliLock(lock) }
  const entry = new URL('../workspace-relocation-intent.mjs', import.meta.url).href
  const code = 'const {readWorkspaceRelocationIntent}=await import(' + JSON.stringify(entry) + '); console.log(JSON.stringify(readWorkspaceRelocationIntent(' + JSON.stringify(f.data) + ')))'
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', timeout: 15000 })
  assert.deepEqual(JSON.parse(output), result)
  assertWorkspaceStillProtected(f.data)
})

function assertWorkspaceStillProtected(data) {
  assert.throws(() => assertWorkspaceExecutionAllowed(data), { code: 'WORKSPACE_MAINTENANCE' })
}

test('a directory flush failure retains the published id and retry finishes durability without a new preview', async t => {
  const f = await fixture(t), lock = await acquireCliLock(f.data, 'workspace-relocation')
  const original = syncFs.fsyncSync
  try {
    const mocked = t.mock.method(syncFs, 'fsyncSync', function(fd) {
      if (syncFs.fstatSync(fd).isDirectory()) throw Object.assign(new Error('flush fault'), { code: 'EIO' })
      return original(fd)
    })
    if (process.platform === 'win32') { mocked.mock.restore(); return t.skip('Node does not expose Windows directory flushing') }
    await assert.rejects(beginWorkspaceRelocationIntent(f.input), { code: 'EIO' })
    mocked.mock.restore()
    const record = readWorkspaceRelocationIntent(f.data)
    assert.equal(record.id, f.input.id)
    await fs.writeFile(path.join(f.source, 'pyvenv.cfg'), 'a new blocker after the intent was published')
    assert.deepEqual(await beginWorkspaceRelocationIntent(f.input), record)
    assertWorkspaceStillProtected(f.data)
  } finally { releaseCliLock(lock) }
})

test('a lost publication reply never creates another intent or removes the active protection', async t => {
  const f = await fixture(t), lock = await acquireCliLock(f.data, 'workspace-relocation')
  const original = syncFs.linkSync
  try {
    const mocked = t.mock.method(syncFs, 'linkSync', function(source, target) {
      original(source, target)
      throw Object.assign(new Error('publication reply lost'), { code: 'EIO' })
    })
    await assert.rejects(beginWorkspaceRelocationIntent(f.input), { code: 'EIO' })
    mocked.mock.restore()
    const record = readWorkspaceRelocationIntent(f.data)
    assert.equal(record.id, f.input.id)
    assert.deepEqual(await beginWorkspaceRelocationIntent(f.input), record)
    assertWorkspaceStillProtected(f.data)
  } finally { releaseCliLock(lock) }
})

test('a hardlinked activity record is retained but cannot become verified control metadata', async t => {
  const f = await fixture(t), lock = await acquireCliLock(f.data, 'workspace-relocation')
  try {
    await beginWorkspaceRelocationIntent(f.input)
    await fs.link(f.recordFile, path.join(f.root, 'outside-link'))
    assert.throws(() => readWorkspaceRelocationIntent(f.data), { code: 'WORKSPACE_RELOCATION_INVALID' })
    assertWorkspaceStillProtected(f.data)
    assert.equal(await fs.readFile(path.join(f.source, 'default/original.txt'), 'utf8'), 'user bytes')
  } finally { releaseCliLock(lock) }
})


test('ordinary absolute directory input with a trailing separator uses the same normalized retry', async t => {
  const f = await fixture(t), lock = await acquireCliLock(f.data, 'workspace-relocation')
  try {
    const record = await beginWorkspaceRelocationIntent({ ...f.input, target: f.input.target + path.sep })
    assert.equal(record.requested_target, f.input.target)
    assert.deepEqual(await beginWorkspaceRelocationIntent(f.input), record)
  } finally { releaseCliLock(lock) }
})


test('a pending version replacement cannot acquire a second workspace maintenance intent', async t => {
  const f = await fixture(t), core = path.join(f.root, 'verified-core'), lock = await acquireCliLock(f.data, 'maintenance-test')
  try {
    await fs.mkdir(core)
    for (const file of ['package.json', 'product-runtime.json']) await fs.writeFile(path.join(core, file), JSON.stringify({ version: '1.2.3' }))
    await writeCoreRelease(core, { schema_version: 1, version: '1.2.3', platform: process.platform, arch: process.arch,
      commit: '1'.repeat(40), source_dirty: false })
    const version = await beginVersionMaintenance(f.data, core, '1.2.4')
    await assert.rejects(beginWorkspaceRelocationIntent(f.input), { code: 'WORKSPACE_RELOCATION_CONFLICT' })
    assert.equal(readWorkspaceRelocationIntent(f.data), null)
    assert.equal(JSON.parse(await fs.readFile(path.join(f.data, 'desktop-maintenance.json'), 'utf8')).id, version.id)
  } finally { releaseCliLock(lock) }
})


test('a control directory disappearing after preview is never recreated to publish an intent', async t => {
  const f = await fixture(t), lock = await acquireCliLock(f.data, 'workspace-relocation')
  const original = syncFs.lstatSync, control = path.dirname(f.recordFile), retained = path.join(f.root, 'retained-control')
  let moved = false
  try {
    const mocked = t.mock.method(syncFs, 'lstatSync', function(file, ...args) {
      const result = original(file, ...args)
      if (!moved && file === f.source) { syncFs.renameSync(control, retained); moved = true }
      return result
    })
    await assert.rejects(beginWorkspaceRelocationIntent(f.input), { code: 'WORKSPACE_RELOCATION_INVALID' })
    mocked.mock.restore()
    assert.equal(moved, true)
    await assert.rejects(fs.stat(control), { code: 'ENOENT' })
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(retained, 'catalog.json'), 'utf8')).revision, f.snapshot.revision)
    assert.equal(await fs.readFile(path.join(f.source, 'default/original.txt'), 'utf8'), 'user bytes')
  } finally { releaseCliLock(lock) }
})


test('an unexpected publication entry is preserved atomically without replacement', async t => {
  const f = await fixture(t), lock = await acquireCliLock(f.data, 'workspace-relocation'), original = syncFs.linkSync
  try {
    const mocked = t.mock.method(syncFs, 'linkSync', function(source, target) {
      syncFs.writeFileSync(target, 'unexpected existing control', { flag: 'wx', mode: 0o600 })
      return original(source, target)
    })
    await assert.rejects(beginWorkspaceRelocationIntent(f.input), { code: 'WORKSPACE_RELOCATION_CONFLICT' })
    mocked.mock.restore()
    assert.equal(await fs.readFile(f.recordFile, 'utf8'), 'unexpected existing control')
    assertWorkspaceStillProtected(f.data)
  } finally { releaseCliLock(lock) }
})

test('a known nonportable project environment blocks before publishing maintenance', async t => {
  const f = await fixture(t), lock = await acquireCliLock(f.data, 'workspace-relocation')
  try {
    await fs.writeFile(path.join(f.source, 'default/pyvenv.cfg'), 'user environment')
    await assert.rejects(beginWorkspaceRelocationIntent(f.input), { code: 'WORKSPACE_RELOCATION_BLOCKED' })
    assert.equal(readWorkspaceRelocationIntent(f.data), null)
    assertWorkspaceExecutionAllowed(f.data)
    assert.equal(await fs.readFile(path.join(f.source, 'default/pyvenv.cfg'), 'utf8'), 'user environment')
  } finally { releaseCliLock(lock) }
})


test('only the same private intent can reacquire its recovery lock while ordinary lifecycle is blocked', async t => {
  const f = await fixture(t), initial = await acquireCliLock(f.data, 'workspace-relocation')
  try { await beginWorkspaceRelocationIntent(f.input) } finally { releaseCliLock(initial) }
  await assert.rejects(acquireCliLock(f.data, 'upgrade', 0), { code: 'WORKSPACE_MAINTENANCE' })
  await assert.rejects(acquireWorkspaceRelocationLock(f.data, randomUUID(), 0), { code: 'WORKSPACE_MAINTENANCE' })
  const recovery = await acquireWorkspaceRelocationLock(f.data, f.input.id, 0)
  try { assert.equal((await beginWorkspaceRelocationIntent(f.input)).id, f.input.id) }
  finally { releaseCliLock(recovery) }
  await fs.writeFile(f.recordFile, 'broken')
  await assert.rejects(acquireWorkspaceRelocationLock(f.data, f.input.id, 0), { code: 'WORKSPACE_RELOCATION_INVALID' })
  assertWorkspaceStillProtected(f.data)
})


test('a changed intent at recovery lock acquisition is rejected and releases the native lock', async t => {
  const f = await fixture(t), initial = await acquireCliLock(f.data, 'workspace-relocation')
  try { await beginWorkspaceRelocationIntent(f.input) } finally { releaseCliLock(initial) }
  const original = native.tryFileLock
  const mocked = t.mock.method(native, 'tryFileLock', function(...args) {
    const handle = original(...args)
    if (handle) {
      const current = JSON.parse(syncFs.readFileSync(f.recordFile, 'utf8'))
      syncFs.writeFileSync(f.recordFile, JSON.stringify({ ...current, id: randomUUID() }))
    }
    return handle
  })
  await assert.rejects(acquireWorkspaceRelocationLock(f.data, f.input.id, 0), { code: 'WORKSPACE_MAINTENANCE' })
  mocked.mock.restore()
  const { acquireStartupLock } = await import('../cli-lock.mjs')
  const management = await acquireStartupLock(f.data, 'management-start', 0)
  releaseCliLock(management)
  assertWorkspaceStillProtected(f.data)
})


function workerSet() {
  return [{ worker_id: 'a', manager_key: 'channel::session', task_id: 'a', workspace_id: 'default', incarnations: [
    { incarnation_id: 'inc-a', impl: 'builtin', seq: 1, workspace: path.resolve('fixture-workspace'), started_at: '2026-10-20T00:00:00.000Z' },
    { incarnation_id: 'inc-b', impl: 'codex', seq: 1, workspace: path.resolve('fixture-workspace'), started_at: '2026-10-20T00:00:00.000Z', forked_from: 'inc-a', query_id: 'query' },
  ] }, { worker_id: 'native', manager_key: 'admin-web::system-tasks', task_id: 'native', incarnations: [] },
  { worker_id: 'old', manager_key: 'other::session', task_id: 'old', incarnations: [
    { incarnation_id: 'legacy-inc', impl: 'legacy', seq: 1, workspace: path.resolve('old-project'), started_at: '2026-01-01T00:00:00.000Z' },
  ] }]
}

test('fixed Worker set requires the native lock and binds the first complete set to its intent', async t => {
  const f = await fixture(t), lock = await acquireCliLock(f.data, 'workspace-relocation'), workers = workerSet()
  const scopeFile = path.join(f.data, 'workspace-control/relocation-workers.json')
  try { await beginWorkspaceRelocationIntent(f.input) } finally { releaseCliLock(lock) }
  assert.throws(() => commitWorkspaceRelocationWorkers({ dataDir: f.data, id: f.input.id, workers }), { code: 'WORKSPACE_RELOCATION_INVALID' })
  await assert.rejects(fs.stat(scopeFile), { code: 'ENOENT' })
  const recoveredLock = await acquireWorkspaceRelocationLock(f.data, f.input.id)
  try {
    assert.equal(readWorkspaceRelocationWorkers(f.data, f.input.id), null)
    const record = commitWorkspaceRelocationWorkers({ dataDir: f.data, id: f.input.id, workers })
    assert.deepEqual(record.workers, workers)
    assert.deepEqual(commitWorkspaceRelocationWorkers({ dataDir: f.data, id: f.input.id, workers }), record)
    assert.deepEqual(readWorkspaceRelocationWorkers(f.data, f.input.id), record)
    const raw = await fs.readFile(scopeFile, 'utf8')
    assert.throws(() => commitWorkspaceRelocationWorkers({ dataDir: f.data, id: randomUUID(), workers }), { code: 'WORKSPACE_RELOCATION_INVALID' })
    assert.throws(() => commitWorkspaceRelocationWorkers({ dataDir: f.data, id: f.input.id, workers: [] }), { code: 'WORKSPACE_RELOCATION_CONFLICT' })
    assert.equal(await fs.readFile(scopeFile, 'utf8'), raw)
    assert.equal(await fs.readFile(path.join(f.source, 'default/original.txt'), 'utf8'), 'user bytes')
    assert.equal((await f.catalog.snapshot()).storage_root, f.source)
    assert.throws(() => assertWorkspaceExecutionAllowed(f.data), { code: 'WORKSPACE_MAINTENANCE' })
  } finally { releaseCliLock(recoveredLock) }
})

for (const damage of ['json', 'null', 'intent', 'workers', 'link', 'hardlink', 'large']) test('fixed Worker set damage retains protection: ' + damage, async t => {
  const f = await fixture(t), lock = await acquireCliLock(f.data, 'workspace-relocation'), workers = workerSet()
  const file = path.join(f.data, 'workspace-control/relocation-workers.json')
  try {
    await beginWorkspaceRelocationIntent(f.input)
    const record = commitWorkspaceRelocationWorkers({ dataDir: f.data, id: f.input.id, workers })
    if (damage === 'json') await fs.writeFile(file, 'broken')
    if (damage === 'null') await fs.writeFile(file, 'null')
    if (damage === 'intent') await fs.writeFile(file, JSON.stringify({ ...record, intent_sha256: '0'.repeat(64) }))
    if (damage === 'workers') await fs.writeFile(file, JSON.stringify({ ...record, workers: [...workers, workers[0]] }))
    if (damage === 'link') { const retained = path.join(f.root, 'retained-workers'); await fs.rename(file, retained); await fs.symlink(retained, file, 'file') }
    if (damage === 'hardlink') await fs.link(file, path.join(f.root, 'second-link'))
    if (damage === 'large') await fs.truncate(file, 32 * 1024 * 1024 + 1)
    assert.throws(() => readWorkspaceRelocationWorkers(f.data, f.input.id), { code: 'WORKSPACE_RELOCATION_INVALID' })
    assert.throws(() => commitWorkspaceRelocationWorkers({ dataDir: f.data, id: f.input.id, workers }), { code: 'WORKSPACE_RELOCATION_INVALID' })
    assert.throws(() => assertWorkspaceExecutionAllowed(f.data), { code: 'WORKSPACE_MAINTENANCE' })
  } finally { releaseCliLock(lock) }
})

for (const invalid of ['extra content', 'duplicate Worker', 'duplicate incarnation', 'sparse workers', 'sparse incarnations', 'unsorted', 'missing task', 'missing incarnation']) test('invalid fixed set is rejected before publication: ' + invalid, async t => {
  const f = await fixture(t), lock = await acquireCliLock(f.data, 'workspace-relocation'), workers = workerSet()
  try {
    await beginWorkspaceRelocationIntent(f.input)
    if (invalid === 'extra content') workers[0].prompt = 'never persist task content'
    if (invalid === 'duplicate Worker') workers.push(workers[0])
    if (invalid === 'duplicate incarnation') workers[0].incarnations.push(workers[0].incarnations[0])
    if (invalid === 'sparse workers') workers.length++
    if (invalid === 'sparse incarnations') workers[0].incarnations.length++
    if (invalid === 'unsorted') workers.reverse()
    if (invalid === 'missing task') delete workers[0].task_id
    if (invalid === 'missing incarnation') delete workers[0].incarnations[0].incarnation_id
    assert.throws(() => commitWorkspaceRelocationWorkers({ dataDir: f.data, id: f.input.id, workers }), { code: 'WORKSPACE_RELOCATION_INVALID' })
    await assert.rejects(fs.stat(path.join(f.data, 'workspace-control/relocation-workers.json')), { code: 'ENOENT' })
  } finally { releaseCliLock(lock) }
})

test('fixed set survives a lost publication reply and later id-bound native lock recovery', async t => {
  const f = await fixture(t), workers = workerSet(), file = path.join(f.data, 'workspace-control/relocation-workers.json')
  const lock = await acquireCliLock(f.data, 'workspace-relocation')
  try { await beginWorkspaceRelocationIntent(f.input); commitWorkspaceRelocationWorkers({ dataDir: f.data, id: f.input.id, workers }) }
  finally { releaseCliLock(lock) }
  const raw = await fs.readFile(file, 'utf8'), recovered = await acquireWorkspaceRelocationLock(f.data, f.input.id)
  try {
    assert.deepEqual(commitWorkspaceRelocationWorkers({ dataDir: f.data, id: f.input.id, workers }), JSON.parse(raw))
    assert.equal(await fs.readFile(file, 'utf8'), raw)
  } finally { releaseCliLock(recovered) }
})


test('fixed set rejects a different original intent even when its id is unchanged', async t => {
  const f = await fixture(t), lock = await acquireCliLock(f.data, 'workspace-relocation'), workers = workerSet()
  try {
    const intent = await beginWorkspaceRelocationIntent(f.input)
    commitWorkspaceRelocationWorkers({ dataDir: f.data, id: f.input.id, workers })
    await fs.writeFile(f.recordFile, JSON.stringify({ ...intent, created_at: '2026-10-21T00:00:00.000Z' }))
    assert.throws(() => readWorkspaceRelocationWorkers(f.data, f.input.id), { code: 'WORKSPACE_RELOCATION_INVALID' })
  } finally { releaseCliLock(lock) }
})

test('source replacement during fixed-set publication does not commit or overwrite user files', async t => {
  const f = await fixture(t), lock = await acquireCliLock(f.data, 'workspace-relocation'), workers = workerSet()
  const write = syncFs.writeFileSync, retained = path.join(f.root, 'retained-source')
  try {
    await beginWorkspaceRelocationIntent(f.input)
    syncFs.writeFileSync = function(file, ...args) {
      const result = write.call(this, file, ...args)
      if (path.basename(String(file)).startsWith('.relocation-')) { syncFs.renameSync(f.source, retained); syncFs.mkdirSync(f.source) }
      return result
    }
    assert.throws(() => commitWorkspaceRelocationWorkers({ dataDir: f.data, id: f.input.id, workers }), { code: 'WORKSPACE_RELOCATION_INVALID' })
    assert.equal(await fs.readFile(path.join(retained, 'default/original.txt'), 'utf8'), 'user bytes')
    await assert.rejects(fs.stat(path.join(f.data, 'workspace-control/relocation-workers.json')), { code: 'ENOENT' })
  } finally { syncFs.writeFileSync = write; releaseCliLock(lock) }
})

test('an unknown fixed-set entry appearing at publication is preserved', async t => {
  const f = await fixture(t), lock = await acquireCliLock(f.data, 'workspace-relocation'), workers = workerSet()
  const link = syncFs.linkSync, file = path.join(f.data, 'workspace-control/relocation-workers.json')
  try {
    await beginWorkspaceRelocationIntent(f.input)
    syncFs.linkSync = function(source, target, ...args) {
      if (target === file) syncFs.writeFileSync(file, 'unknown owner', { mode: 0o600 })
      return link.call(this, source, target, ...args)
    }
    assert.throws(() => commitWorkspaceRelocationWorkers({ dataDir: f.data, id: f.input.id, workers }), { code: 'WORKSPACE_RELOCATION_CONFLICT' })
    assert.equal(await fs.readFile(file, 'utf8'), 'unknown owner')
    assert.deepEqual((await fs.readdir(path.dirname(file))).filter(name => name.startsWith('.relocation-')), [])
  } finally { syncFs.linkSync = link; releaseCliLock(lock) }
})

test('directory sync failure after fixed-set publication retains the first result', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t), lock = await acquireCliLock(f.data, 'workspace-relocation'), workers = workerSet()
  const sync = syncFs.fsyncSync
  try {
    await beginWorkspaceRelocationIntent(f.input)
    syncFs.fsyncSync = function(fd) {
      if (syncFs.fstatSync(fd).isDirectory()) throw Object.assign(new Error('sync interrupted'), { code: 'EIO' })
      return sync.call(this, fd)
    }
    assert.throws(() => commitWorkspaceRelocationWorkers({ dataDir: f.data, id: f.input.id, workers }), { code: 'EIO' })
    syncFs.fsyncSync = sync
    const record = readWorkspaceRelocationWorkers(f.data, f.input.id)
    assert.deepEqual(record.workers, workers)
    assert.deepEqual(commitWorkspaceRelocationWorkers({ dataDir: f.data, id: f.input.id, workers }), record)
  } finally { syncFs.fsyncSync = sync; releaseCliLock(lock) }
})

test('actual Agent identity projection roundtrips through the private fixed-set validator and a fresh Node reader', async t => {
  const f = await fixture(t), lock = await acquireCliLock(f.data, 'workspace-relocation')
  try {
    await beginWorkspaceRelocationIntent(f.input)
    const { captureWorkspaceRelocationWorkers } = createRequire(import.meta.url)('../../../crabot-agent/dist/workers/harness/workspace-relocation-scope.js')
    const workers = captureWorkspaceRelocationWorkers(workerSet().map(worker => ({ managerKey: worker.manager_key,
      worker: { ...worker, task: { id: worker.task_id }, incarnations: worker.incarnations } })))
    const record = commitWorkspaceRelocationWorkers({ dataDir: f.data, id: f.input.id, workers })
    const script = 'import { readWorkspaceRelocationWorkers } from ' + JSON.stringify(new URL('../workspace-relocation-intent.mjs', import.meta.url).href)
      + '; process.stdout.write(JSON.stringify(readWorkspaceRelocationWorkers(process.argv[1], process.argv[2])));'
    const observed = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script, f.data, f.input.id], { encoding: 'utf8' }))
    assert.deepEqual(observed, record)
  } finally { releaseCliLock(lock) }
})


test('oversized fixed set fails without publishing a partial membership list', async t => {
  const f = await fixture(t), lock = await acquireCliLock(f.data, 'workspace-relocation')
  try {
    await beginWorkspaceRelocationIntent(f.input)
    const workers = [{ worker_id: 'a'.repeat(32 * 1024 * 1024), manager_key: 'channel::session', task_id: 'a', incarnations: [] }]
    assert.throws(() => commitWorkspaceRelocationWorkers({ dataDir: f.data, id: f.input.id, workers }), { code: 'WORKSPACE_RELOCATION_INVALID' })
    assert.equal(readWorkspaceRelocationWorkers(f.data, f.input.id), null)
    assert.deepEqual((await fs.readdir(path.dirname(f.recordFile))).filter(name => name.startsWith('.relocation-')), [])
    assert.throws(() => assertWorkspaceExecutionAllowed(f.data), { code: 'WORKSPACE_MAINTENANCE' })
  } finally { releaseCliLock(lock) }
})


test('a persisted fixed set cannot lose its fence when the initial intent is missing', async t => {
  const f = await fixture(t), lock = await acquireCliLock(f.data, 'workspace-relocation')
  try {
    await beginWorkspaceRelocationIntent(f.input)
    commitWorkspaceRelocationWorkers({ dataDir: f.data, id: f.input.id, workers: workerSet() })
    await fs.unlink(f.recordFile)
    assert.throws(() => assertWorkspaceExecutionAllowed(f.data), { code: 'WORKSPACE_MAINTENANCE' })
    assert.throws(() => readWorkspaceRelocationIntent(f.data), { code: 'WORKSPACE_RELOCATION_INVALID' })
    assert.throws(() => commitWorkspaceRelocationWorkers({ dataDir: f.data, id: f.input.id, workers: workerSet() }), { code: 'WORKSPACE_RELOCATION_INVALID' })
    await assert.rejects(fs.stat(f.recordFile), { code: 'ENOENT' })
    assert.equal(await fs.readFile(path.join(f.source, 'default/original.txt'), 'utf8'), 'user bytes')
  } finally { releaseCliLock(lock) }
})


for (const change of ['missing', 'different']) test('fixed-set publication cannot report success after readback changes: ' + change, async t => {
  const f = await fixture(t), lock = await acquireCliLock(f.data, 'workspace-relocation'), workers = workerSet()
  const link = syncFs.linkSync, file = path.join(f.data, 'workspace-control/relocation-workers.json')
  try {
    await beginWorkspaceRelocationIntent(f.input)
    syncFs.linkSync = function(source, target, ...args) {
      const result = link.call(this, source, target, ...args)
      if (target === file) {
        if (change === 'missing') syncFs.unlinkSync(file)
        else { const value = JSON.parse(syncFs.readFileSync(file, 'utf8')); value.workers = []; syncFs.writeFileSync(file, JSON.stringify(value)) }
      }
      return result
    }
    assert.throws(() => commitWorkspaceRelocationWorkers({ dataDir: f.data, id: f.input.id, workers }), { code: 'WORKSPACE_RELOCATION_INVALID' })
    assert.throws(() => assertWorkspaceExecutionAllowed(f.data), { code: 'WORKSPACE_MAINTENANCE' })
    assert.equal(await fs.readFile(path.join(f.source, 'default/original.txt'), 'utf8'), 'user bytes')
  } finally { syncFs.linkSync = link; releaseCliLock(lock) }
})


for (const file of ['relocation-stop-attempt.json', 'relocation-stop-submission.json', 'relocation-modules.json', 'relocation-module-stop-attempt.json', 'relocation-module-processes', 'relocation-module-stop-submission.json']) test('orphaned stop evidence keeps all execution entry points fenced: ' + file, async t => {
  const f = await fixture(t)
  await fs.writeFile(path.join(f.data, 'workspace-control', file), '{}', { mode: 0o600 })
  assertWorkspaceStillProtected(f.data)
  assert.throws(() => readWorkspaceRelocationIntent(f.data), { code: 'WORKSPACE_RELOCATION_INVALID' })
})


const submissionResults = workers => workers.flatMap(worker => worker.incarnations.map(item => ({
  worker_id: worker.worker_id, incarnation_id: item.incarnation_id, status: item.impl === 'legacy' ? 'unavailable' : 'submitted',
})))

test('stopping records durably bind one dispatch and full submission results, without claiming exit', async t => {
  const f = await fixture(t), workers = workerSet(), lock = await acquireCliLock(f.data, 'workspace-relocation')
  try {
    await beginWorkspaceRelocationIntent(f.input)
    assert.throws(() => prepareWorkspaceRelocationStops({ dataDir: f.data, id: f.input.id, workers }), { code: 'WORKSPACE_RELOCATION_INVALID' })
    commitWorkspaceRelocationWorkers({ dataDir: f.data, id: f.input.id, workers })
    const first = prepareWorkspaceRelocationStops({ dataDir: f.data, id: f.input.id, workers })
    assert.equal(first.dispatch, 'dispatch')
    assert.deepEqual(readWorkspaceRelocationStops(f.data, f.input.id), { attempt: first.attempt, submission: null })
    assert.deepEqual(prepareWorkspaceRelocationStops({ dataDir: f.data, id: f.input.id, workers }), { dispatch: 'observe', attempt: first.attempt })
    const results = submissionResults(workers); results[0].status = 'unknown'
    const complete = completeWorkspaceRelocationStops({ dataDir: f.data, id: f.input.id, results: [...results].reverse() })
    assert.deepEqual(complete.results, results)
    assert.deepEqual(completeWorkspaceRelocationStops({ dataDir: f.data, id: f.input.id, results }), complete)
    assert.deepEqual(readWorkspaceRelocationStops(f.data, f.input.id), { attempt: first.attempt, submission: complete })
    const entry = new URL('../workspace-relocation-intent.mjs', import.meta.url).href
    const fresh = execFileSync(process.execPath, ['--input-type=module', '-e',
      `const m = await import(process.argv[1]); process.stdout.write(JSON.stringify(m.readWorkspaceRelocationStops(process.argv[2], process.argv[3])))`, entry, f.data, f.input.id], { encoding: 'utf8' })
    assert.deepEqual(JSON.parse(fresh), { attempt: first.attempt, submission: complete })
    assert.equal((await f.catalog.snapshot()).storage_root, f.source)
    assert.equal(await fs.readFile(path.join(f.source, 'default/original.txt'), 'utf8'), 'user bytes')
    assertWorkspaceStillProtected(f.data)
  } finally { releaseCliLock(lock) }
})

for (const invalid of ['missing', 'duplicate', 'replacement', 'extra content', 'sparse', 'claimed stopped']) test('invalid stop submission never shrinks or inflates fixed evidence: ' + invalid, async t => {
  const f = await fixture(t), workers = workerSet(), lock = await acquireCliLock(f.data, 'workspace-relocation')
  try {
    await beginWorkspaceRelocationIntent(f.input); commitWorkspaceRelocationWorkers({ dataDir: f.data, id: f.input.id, workers })
    prepareWorkspaceRelocationStops({ dataDir: f.data, id: f.input.id, workers })
    const results = submissionResults(workers)
    if (invalid === 'missing') results.pop()
    if (invalid === 'duplicate') results.push(results[0])
    if (invalid === 'replacement') results[0].incarnation_id = 'replacement'
    if (invalid === 'extra content') results[0].message = 'do not persist exception content'
    if (invalid === 'sparse') delete results[0]
    if (invalid === 'claimed stopped') results[0].status = 'stopped'
    assert.throws(() => completeWorkspaceRelocationStops({ dataDir: f.data, id: f.input.id, results }), { code: 'WORKSPACE_RELOCATION_INVALID' })
    assert.equal(readWorkspaceRelocationStops(f.data, f.input.id).submission, null)
    assertWorkspaceStillProtected(f.data)
  } finally { releaseCliLock(lock) }
})

for (const damage of ['attempt json', 'attempt scope', 'attempt link', 'attempt hardlink', 'submission attempt', 'missing upstream', 'missing attempt']) test('damaged stop records preserve maintenance and never authorize redispatch: ' + damage, async t => {
  const f = await fixture(t), workers = workerSet(), lock = await acquireCliLock(f.data, 'workspace-relocation')
  const file = path.join(f.data, 'workspace-control/relocation-stop-attempt.json'), submitted = path.join(f.data, 'workspace-control/relocation-stop-submission.json')
  try {
    await beginWorkspaceRelocationIntent(f.input); commitWorkspaceRelocationWorkers({ dataDir: f.data, id: f.input.id, workers })
    const { attempt } = prepareWorkspaceRelocationStops({ dataDir: f.data, id: f.input.id, workers })
    const result = completeWorkspaceRelocationStops({ dataDir: f.data, id: f.input.id, results: submissionResults(workers) })
    if (damage === 'attempt json') await fs.writeFile(file, '{broken')
    if (damage === 'attempt scope') await fs.writeFile(file, JSON.stringify({ ...attempt, workers_sha256: '0'.repeat(64) }))
    if (damage === 'attempt link') { const original = path.join(f.root, 'retained-attempt'); await fs.rename(file, original); await fs.symlink(original, file, 'file') }
    if (damage === 'attempt hardlink') await fs.link(file, path.join(f.root, 'hardlink'))
    if (damage === 'submission attempt') await fs.writeFile(submitted, JSON.stringify({ ...result, attempt_sha256: '0'.repeat(64) }))
    if (damage === 'missing upstream') await fs.rm(path.join(f.data, 'workspace-control/relocation-workers.json'))
    if (damage === 'missing attempt') await fs.rm(file)
    assert.throws(() => readWorkspaceRelocationStops(f.data, f.input.id), { code: 'WORKSPACE_RELOCATION_INVALID' })
    assert.throws(() => prepareWorkspaceRelocationStops({ dataDir: f.data, id: f.input.id, workers }), { code: 'WORKSPACE_RELOCATION_INVALID' })
    assertWorkspaceStillProtected(f.data)
  } finally { releaseCliLock(lock) }
})

test('a lost stop-attempt reply is observed after reacquiring the lock and never redispatched', async t => {
  const f = await fixture(t), workers = workerSet(), lock = await acquireCliLock(f.data, 'workspace-relocation')
  try {
    await beginWorkspaceRelocationIntent(f.input); commitWorkspaceRelocationWorkers({ dataDir: f.data, id: f.input.id, workers })
    const original = syncFs.linkSync
    const link = t.mock.method(syncFs, 'linkSync', (...args) => { original(...args); throw new Error('reply lost after publication') })
    assert.throws(() => prepareWorkspaceRelocationStops({ dataDir: f.data, id: f.input.id, workers }), /reply lost/)
    link.mock.restore()
  } finally { releaseCliLock(lock) }
  const recovered = await acquireWorkspaceRelocationLock(f.data, f.input.id)
  try { assert.equal(prepareWorkspaceRelocationStops({ dataDir: f.data, id: f.input.id, workers }).dispatch, 'observe') }
  finally { releaseCliLock(recovered) }
})


test('stop attempt and submission writes require the actual lock, exact fixed set and original receipt', async t => {
  const f = await fixture(t), workers = workerSet(), lock = await acquireCliLock(f.data, 'workspace-relocation')
  try { await beginWorkspaceRelocationIntent(f.input); commitWorkspaceRelocationWorkers({ dataDir: f.data, id: f.input.id, workers }) }
  finally { releaseCliLock(lock) }
  const options = { dataDir: f.data, id: f.input.id }
  assert.throws(() => prepareWorkspaceRelocationStops({ ...options, workers }), { code: 'WORKSPACE_RELOCATION_INVALID' })
  assert.throws(() => completeWorkspaceRelocationStops({ ...options, results: submissionResults(workers) }), { code: 'WORKSPACE_RELOCATION_INVALID' })
  const recovered = await acquireWorkspaceRelocationLock(f.data, f.input.id)
  try {
    assert.throws(() => prepareWorkspaceRelocationStops({ ...options, workers: [] }), { code: 'WORKSPACE_RELOCATION_INVALID' })
    assert.throws(() => completeWorkspaceRelocationStops({ ...options, results: submissionResults(workers) }), { code: 'WORKSPACE_RELOCATION_INVALID' })
    prepareWorkspaceRelocationStops({ ...options, workers })
    const results = submissionResults(workers), original = completeWorkspaceRelocationStops({ ...options, results })
    results[0].status = 'unknown'
    assert.throws(() => completeWorkspaceRelocationStops({ ...options, results }), { code: 'WORKSPACE_RELOCATION_CONFLICT' })
    assert.deepEqual(readWorkspaceRelocationStops(f.data, f.input.id).submission, original)
  } finally { releaseCliLock(recovered) }
})

test('a published stop receipt survives an interrupted directory flush and keeps its first result', async t => {
  const f = await fixture(t), workers = workerSet(), lock = await acquireCliLock(f.data, 'workspace-relocation')
  try {
    await beginWorkspaceRelocationIntent(f.input); commitWorkspaceRelocationWorkers({ dataDir: f.data, id: f.input.id, workers })
    prepareWorkspaceRelocationStops({ dataDir: f.data, id: f.input.id, workers })
    const original = syncFs.fsyncSync
    const flush = t.mock.method(syncFs, 'fsyncSync', fd => {
      if (syncFs.fstatSync(fd).isDirectory()) throw new Error('directory flush interrupted')
      return original(fd)
    })
    if (process.platform === 'win32') {
      // Windows has native private ACLs and no Node directory fsync; inject after the atomic link instead.
      flush.mock.restore()
      const link = syncFs.linkSync
      t.mock.method(syncFs, 'linkSync', (...args) => { link(...args); throw new Error('directory flush interrupted') })
    }
    assert.throws(() => completeWorkspaceRelocationStops({ dataDir: f.data, id: f.input.id, results: submissionResults(workers) }), /directory flush interrupted/)
    t.mock.restoreAll()
    const stored = readWorkspaceRelocationStops(f.data, f.input.id).submission
    assert.deepEqual(completeWorkspaceRelocationStops({ dataDir: f.data, id: f.input.id, results: submissionResults(workers) }), stored)
    assertWorkspaceStillProtected(f.data)
  } finally { t.mock.restoreAll(); releaseCliLock(lock) }
})


function moduleSet() {
  const self = native.inspectProcess(process.pid)
  return [{ instance_id: 'fixture-instance', module_id: 'fixture-memory', module_port: 19911, runtime_id: 'fixture-runtime',
    processes: [{ pid: 881100, parent: process.pid, started: '100', owner: self.owner, executable: self.executable }] },
    { instance_id: 'fixture-instance', module_id: 'stopped-channel', module_port: 19912, processes: [] }]
}
async function moduleFixture(t) {
  let lock
  const f = await fixture(t, () => releaseCliLock(lock))
  lock = await acquireCliLock(f.data, 'workspace-relocation')
  await beginWorkspaceRelocationIntent(f.input)
  commitWorkspaceRelocationWorkers({ dataDir: f.data, id: f.input.id, workers: [] })
  const options = { dataDir: f.data, id: f.input.id }, modules = moduleSet()
  return { ...f, lock, options, modules }
}
function moduleResults(modules) {
  return modules.map(item => ({ module_id: item.module_id, ...(item.runtime_id ? { runtime_id: item.runtime_id } : {}),
    shutdown: item.runtime_id ? 'submitted' : 'not_submitted', status: item.runtime_id ? 'known_scope_exited' : 'inactive' }))
}
test('module scope, attempt, monotonic observations and result stay bound without replacing first evidence', async t => {
  const f = await moduleFixture(t)
  const record = commitWorkspaceRelocationModules({ ...f.options, modules: f.modules })
  assert.deepEqual(readWorkspaceRelocationModules(f.data, f.input.id), record)
  assert.deepEqual(commitWorkspaceRelocationModules({ ...f.options, modules: f.modules }), record)
  assert.equal(prepareWorkspaceRelocationModuleStops({ ...f.options, modules: f.modules }).dispatch, 'dispatch')
  const first = observeWorkspaceRelocationModuleProcesses({ ...f.options, moduleId: 'fixture-memory', processes: f.modules[0].processes })
  const processes = [...f.modules[0].processes, { ...f.modules[0].processes[0], pid: 881101, parent: 881100, started: '101' }]
  const second = observeWorkspaceRelocationModuleProcesses({ ...f.options, moduleId: 'fixture-memory', processes })
  assert.deepEqual(observeWorkspaceRelocationModuleProcesses({ ...f.options, moduleId: 'fixture-memory', processes }), second)
  assert.equal(first.sequence, 0); assert.equal(second.sequence, 1)
  const results = moduleResults(f.modules), receipt = completeWorkspaceRelocationModuleStops({ ...f.options, results })
  assert.deepEqual(completeWorkspaceRelocationModuleStops({ ...f.options, results }), receipt)
  const stored = readWorkspaceRelocationModuleStops(f.data, f.input.id)
  assert.deepEqual(stored.observations, [first, second]); assert.deepEqual(stored.submission, receipt)
  assert.equal(prepareWorkspaceRelocationModuleStops({ ...f.options, modules: f.modules }).dispatch, 'observe')
  results[0].status = 'unknown'
  assert.throws(() => completeWorkspaceRelocationModuleStops({ ...f.options, results }), { code: 'WORKSPACE_RELOCATION_CONFLICT' })
  assertWorkspaceStillProtected(f.data)
})
for (const kind of ['missing original', 'wrong owner', 'changed generation', 'duplicate', 'extra content', 'inactive module']) test('invalid process observation cannot shrink or retarget a module: ' + kind, async t => {
  const f = await moduleFixture(t)
  commitWorkspaceRelocationModules({ ...f.options, modules: f.modules }); prepareWorkspaceRelocationModuleStops({ ...f.options, modules: f.modules })
  const processes = structuredClone(f.modules[0].processes)
  if (kind === 'missing original') processes.length = 0
  if (kind === 'wrong owner') processes[0].owner = 'another-user'
  if (kind === 'changed generation') processes[0].started = 'replacement'
  if (kind === 'duplicate') processes.push(processes[0])
  if (kind === 'extra content') processes[0].secret = 'never persist business content'
  assert.throws(() => observeWorkspaceRelocationModuleProcesses({ ...f.options, moduleId: kind === 'inactive module' ? 'stopped-channel' : 'fixture-memory', processes }), { code: 'WORKSPACE_RELOCATION_INVALID' })
  assert.deepEqual(readWorkspaceRelocationModuleStops(f.data, f.input.id).observations, [])
})
for (const kind of ['missing worker scope', 'missing module scope', 'missing attempt', 'broken observation', 'missing observation', 'observation hardlink', 'extra file', 'observation directory replaced']) test('damaged module materials do not authorize a fresh attempt: ' + kind, async t => {
  const f = await moduleFixture(t)
  commitWorkspaceRelocationModules({ ...f.options, modules: f.modules }); prepareWorkspaceRelocationModuleStops({ ...f.options, modules: f.modules })
  observeWorkspaceRelocationModuleProcesses({ ...f.options, moduleId: 'fixture-memory', processes: f.modules[0].processes })
  completeWorkspaceRelocationModuleStops({ ...f.options, results: moduleResults(f.modules) })
  const control = path.join(f.data, 'workspace-control'), observations = path.join(control, 'relocation-module-processes'), first = path.join(observations, '00000000.json')
  if (kind === 'missing worker scope') await fs.rm(path.join(control, 'relocation-workers.json'))
  if (kind === 'missing module scope') await fs.rm(path.join(control, 'relocation-modules.json'))
  if (kind === 'missing attempt') await fs.rm(path.join(control, 'relocation-module-stop-attempt.json'))
  if (kind === 'broken observation') await fs.writeFile(first, '{broken')
  if (kind === 'missing observation') await fs.rm(first)
  if (kind === 'observation hardlink') await fs.link(first, path.join(f.root, 'borrowed-record'))
  if (kind === 'extra file') await fs.writeFile(path.join(observations, 'unknown.json'), '{}')
  if (kind === 'observation directory replaced') { await fs.rename(observations, path.join(f.root, 'retained-observations')); await fs.mkdir(observations, { mode: 0o700 }) }
  assert.throws(() => readWorkspaceRelocationModuleStops(f.data, f.input.id), { code: 'WORKSPACE_RELOCATION_INVALID' })
  assert.throws(() => prepareWorkspaceRelocationModuleStops({ ...f.options, modules: f.modules }), { code: 'WORKSPACE_RELOCATION_INVALID' })
  assertWorkspaceStillProtected(f.data)
})


test('cross-module ownership conflict is rejected before publishing a corrupt observation', async t => {
  const f = await moduleFixture(t)
  f.modules[1] = { ...f.modules[1], runtime_id: 'other-runtime', processes: [{ ...f.modules[0].processes[0], pid: 881102 }] }
  commitWorkspaceRelocationModules({ ...f.options, modules: f.modules }); prepareWorkspaceRelocationModuleStops({ ...f.options, modules: f.modules })
  const processes = [...f.modules[0].processes, ...f.modules[1].processes]
  assert.throws(() => observeWorkspaceRelocationModuleProcesses({ ...f.options, moduleId: 'fixture-memory', processes }), { code: 'WORKSPACE_RELOCATION_INVALID' })
  assert.deepEqual(readWorkspaceRelocationModuleStops(f.data, f.input.id).observations, [])
})
for (const kind of ['missing', 'duplicate', 'wrong runtime', 'extra content', 'sparse', 'false inactive']) test('module receipt requires the complete exact module results: ' + kind, async t => {
  const f = await moduleFixture(t)
  commitWorkspaceRelocationModules({ ...f.options, modules: f.modules }); prepareWorkspaceRelocationModuleStops({ ...f.options, modules: f.modules })
  observeWorkspaceRelocationModuleProcesses({ ...f.options, moduleId: 'fixture-memory', processes: f.modules[0].processes })
  const results = moduleResults(f.modules)
  if (kind === 'missing') results.pop()
  if (kind === 'duplicate') results[1] = results[0]
  if (kind === 'wrong runtime') results[0].runtime_id = 'replacement'
  if (kind === 'extra content') results[0].secret = 'never persist business content'
  if (kind === 'sparse') delete results[0]
  if (kind === 'false inactive') results[0].status = 'inactive'
  assert.throws(() => completeWorkspaceRelocationModuleStops({ ...f.options, results }), { code: 'WORKSPACE_RELOCATION_INVALID' })
  assert.equal(readWorkspaceRelocationModuleStops(f.data, f.input.id).submission, null)
})
test('module writes require the actual native lock and do not create observation storage without it', async t => {
  const f = await moduleFixture(t)
  releaseCliLock(f.lock)
  assert.throws(() => commitWorkspaceRelocationModules({ ...f.options, modules: f.modules }), { code: 'WORKSPACE_RELOCATION_INVALID' })
  assert.throws(() => prepareWorkspaceRelocationModuleStops({ ...f.options, modules: f.modules }), { code: 'WORKSPACE_RELOCATION_INVALID' })
  assert.throws(() => observeWorkspaceRelocationModuleProcesses({ ...f.options, moduleId: 'fixture-memory', processes: f.modules[0].processes }), { code: 'WORKSPACE_RELOCATION_INVALID' })
  assert.throws(() => completeWorkspaceRelocationModuleStops({ ...f.options, results: moduleResults(f.modules) }), { code: 'WORKSPACE_RELOCATION_INVALID' })
  assert.equal(readWorkspaceRelocationModules(f.data, f.input.id), null)
})
test('a lost module attempt reply resumes only observation after reacquiring the original job lock', async t => {
  const f = await moduleFixture(t)
  commitWorkspaceRelocationModules({ ...f.options, modules: f.modules })
  const original = syncFs.linkSync
  const link = t.mock.method(syncFs, 'linkSync', (...args) => { original(...args); if (String(args[1]).endsWith('relocation-module-stop-attempt.json')) throw new Error('module attempt reply lost') })
  assert.throws(() => prepareWorkspaceRelocationModuleStops({ ...f.options, modules: f.modules }), /reply lost/)
  link.mock.restore(); releaseCliLock(f.lock)
  const recovered = await acquireWorkspaceRelocationLock(f.data, f.input.id)
  try { assert.equal(prepareWorkspaceRelocationModuleStops({ ...f.options, modules: f.modules }).dispatch, 'observe') }
  finally { releaseCliLock(recovered) }
})
test('read-only observations can extend an unknown receipt without replacing its original result', async t => {
  const f = await moduleFixture(t)
  commitWorkspaceRelocationModules({ ...f.options, modules: f.modules }); prepareWorkspaceRelocationModuleStops({ ...f.options, modules: f.modules })
  observeWorkspaceRelocationModuleProcesses({ ...f.options, moduleId: 'fixture-memory', processes: f.modules[0].processes })
  const results = moduleResults(f.modules); results[0].status = 'unknown'; results[0].shutdown = 'unknown'
  const receipt = completeWorkspaceRelocationModuleStops({ ...f.options, results })
  observeWorkspaceRelocationModuleProcesses({ ...f.options, moduleId: 'fixture-memory', processes: [...f.modules[0].processes, { ...f.modules[0].processes[0], pid: 881101, parent: 881100, started: '101' }] })
  const current = readWorkspaceRelocationModuleStops(f.data, f.input.id)
  assert.equal(current.observations.length, 2); assert.deepEqual(current.submission, receipt)
  assert.equal(prepareWorkspaceRelocationModuleStops({ ...f.options, modules: f.modules }).dispatch, 'observe')
})

test('an observation published before acknowledgement loss keeps its first sequence and content', async t => {
  const f = await moduleFixture(t)
  commitWorkspaceRelocationModules({ ...f.options, modules: f.modules }); prepareWorkspaceRelocationModuleStops({ ...f.options, modules: f.modules })
  const directory = path.join(f.data, 'workspace-control/relocation-module-processes'), inode = syncFs.statSync(directory).ino
  if (process.platform === 'win32') {
    const original = syncFs.linkSync
    t.mock.method(syncFs, 'linkSync', (...args) => { original(...args); if (String(args[1]).endsWith('00000000.json')) throw new Error('observation acknowledgement lost') })
  } else {
    const original = syncFs.fsyncSync
    t.mock.method(syncFs, 'fsyncSync', fd => { const stat = syncFs.fstatSync(fd); if (stat.isDirectory() && stat.ino === inode) throw new Error('observation acknowledgement lost'); return original(fd) })
  }
  assert.throws(() => observeWorkspaceRelocationModuleProcesses({ ...f.options, moduleId: 'fixture-memory', processes: f.modules[0].processes }), /acknowledgement lost/)
  t.mock.restoreAll()
  const original = readWorkspaceRelocationModuleStops(f.data, f.input.id).observations[0]
  assert.deepEqual(observeWorkspaceRelocationModuleProcesses({ ...f.options, moduleId: 'fixture-memory', processes: f.modules[0].processes }), original)
  assert.equal(readWorkspaceRelocationModuleStops(f.data, f.input.id).observations.length, 1)
  assert.equal(prepareWorkspaceRelocationModuleStops({ ...f.options, modules: f.modules }).dispatch, 'observe')
})
for (const kind of ['admin', 'self process', 'duplicate runtime', 'extra content', 'missing processes']) test('invalid fixed modules never publish new authority: ' + kind, async t => {
  const f = await moduleFixture(t), modules = structuredClone(f.modules)
  if (kind === 'admin') modules[0].module_id = 'admin-web'
  if (kind === 'self process') modules[0].processes[0].pid = process.pid
  if (kind === 'duplicate runtime') modules[1] = { ...modules[1], runtime_id: modules[0].runtime_id, processes: [{ ...modules[0].processes[0], pid: 881102 }] }
  if (kind === 'extra content') modules[0].apikey = 'never persist credentials'
  if (kind === 'missing processes') modules[0].processes = []
  assert.throws(() => commitWorkspaceRelocationModules({ ...f.options, modules }), { code: 'WORKSPACE_RELOCATION_INVALID' })
  assert.equal(readWorkspaceRelocationModules(f.data, f.input.id), null)
})
test('an observation directory replaced before its first entry cannot restart a fresh chain', async t => {
  const f = await moduleFixture(t)
  commitWorkspaceRelocationModules({ ...f.options, modules: f.modules }); prepareWorkspaceRelocationModuleStops({ ...f.options, modules: f.modules })
  const directory = path.join(f.data, 'workspace-control/relocation-module-processes')
  await fs.rename(directory, path.join(f.root, 'first-observation-directory'))
  management.ensurePrivateDataRoot(directory)
  assert.throws(() => observeWorkspaceRelocationModuleProcesses({ ...f.options, moduleId: 'fixture-memory', processes: f.modules[0].processes }), { code: 'WORKSPACE_RELOCATION_INVALID' })
  assert.throws(() => prepareWorkspaceRelocationModuleStops({ ...f.options, modules: f.modules }), { code: 'WORKSPACE_RELOCATION_INVALID' })
})
