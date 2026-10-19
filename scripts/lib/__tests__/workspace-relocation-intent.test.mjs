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
import { beginWorkspaceRelocationIntent, readWorkspaceRelocationIntent, commitWorkspaceRelocationWorkers, readWorkspaceRelocationWorkers } from '../workspace-relocation-intent.mjs'

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'crabot-relocation-intent-中文 space-')))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
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
