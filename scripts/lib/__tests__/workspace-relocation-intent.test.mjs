import test from 'node:test'
import assert from 'node:assert/strict'
import syncFs, { promises as fs } from 'node:fs'
import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
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
import { observeWorkspaceRelocationRecords, commitWorkspaceRelocationProcesses, readWorkspaceRelocationProcesses, commitWorkspaceRelocationCoordinator, commitWorkspaceRelocationCoordinatorReady, readWorkspaceRelocationCoordinator, commitWorkspaceRelocationModules, readWorkspaceRelocationModules, prepareWorkspaceRelocationModuleStops, observeWorkspaceRelocationModuleProcesses, completeWorkspaceRelocationModuleStops, readWorkspaceRelocationModuleStops, beginWorkspaceRelocationIntent, readWorkspaceRelocationIntent, commitWorkspaceRelocationWorkers, readWorkspaceRelocationWorkers, prepareWorkspaceRelocationStops, completeWorkspaceRelocationStops, readWorkspaceRelocationStops } from '../workspace-relocation-intent.mjs'

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
  const recordFile = path.join(data, 'workspace-control/relocation-active/relocation.json')
  return { root, data, catalog, snapshot, source, input, recordFile }
}

test('an initial intent requires the actual instance operation lock before publishing a fence', async t => {
  const f = await fixture(t)
  await assert.rejects(beginWorkspaceRelocationIntent(f.input), { code: 'WORKSPACE_RELOCATION_INVALID' })
  assert.equal(readWorkspaceRelocationIntent(f.data), null)
  assertWorkspaceExecutionAllowed(f.data)
  assert.equal(await fs.readFile(path.join(f.source, 'default/original.txt'), 'utf8'), 'user bytes')
})

test('an unrelated data-root entry does not invalidate the fixed synchronous intent graph', async t => {
  const f = await fixture(t), lock = await acquireCliLock(f.data, 'workspace-relocation')
  try {
    const accepted = await beginWorkspaceRelocationIntent(f.input), lstat = syncFs.lstatSync
    let injected = false
    t.mock.method(syncFs, 'lstatSync', function(file, ...args) {
      const stat = lstat.call(this, file, ...args)
      if (!injected && String(file) === f.recordFile) {
        injected = true; syncFs.writeFileSync(path.join(f.data, 'unrelated-runtime-marker'), 'keep')
      }
      return stat
    })
    assert.deepEqual(readWorkspaceRelocationIntent(f.data), accepted)
    assert.equal(injected, true)
    assert.equal(await fs.readFile(path.join(f.data, 'unrelated-runtime-marker'), 'utf8'), 'keep')
    assert.throws(() => assertWorkspaceExecutionAllowed(f.data), { code: 'WORKSPACE_MAINTENANCE' })
  } finally { releaseCliLock(lock) }
})

test('synchronous graph observation releases its data-root handle', async t => {
  const f = await fixture(t), lock = await acquireCliLock(f.data, 'workspace-relocation')
  try {
    const accepted = await beginWorkspaceRelocationIntent(f.input)
    releaseCliLock(lock)
    assert.deepEqual(readWorkspaceRelocationIntent(f.data), accepted)
    const moved = f.data + '-roundtrip'
    await fs.rename(f.data, moved)
    await fs.rename(moved, f.data)
    assert.deepEqual(readWorkspaceRelocationIntent(f.data), accepted)
  } finally { releaseCliLock(lock) }
})

for (const change of ['root replaced', ...(process.platform === 'win32' ? [] : ['root permissions']), 'control directory entry', 'record changed']) {
  test('synchronous intent observation still refuses ' + change, async t => {
    const f = await fixture(t), lock = await acquireCliLock(f.data, 'workspace-relocation')
    let moved = false
    try {
      await beginWorkspaceRelocationIntent(f.input)
      releaseCliLock(lock)
      const lstat = syncFs.lstatSync
      let injected = false
      t.mock.method(syncFs, 'lstatSync', function(file, ...args) {
        const stat = lstat.call(this, file, ...args)
        if (!injected && String(file) === f.recordFile) {
          injected = true
          if (change === 'root replaced') {
            syncFs.renameSync(f.data, f.data + '-original'); moved = true
            syncFs.cpSync(f.data + '-original', f.data, { recursive: true, preserveTimestamps: true })
          } else if (change === 'root permissions') syncFs.chmodSync(f.data, 0o755)
          else if (change === 'control directory entry') syncFs.writeFileSync(path.join(path.dirname(f.recordFile), 'unexpected-record'), 'keep')
          else syncFs.appendFileSync(f.recordFile, ' ')
        }
        return stat
      })
      assert.throws(() => readWorkspaceRelocationIntent(f.data))
      assert.equal(injected, true)
      t.mock.restoreAll()
    } finally {
      t.mock.restoreAll()
      if (moved) { await fs.rm(f.data, { recursive: true, force: true }); await fs.rename(f.data + '-original', f.data) }
      else if (process.platform !== 'win32') await fs.chmod(f.data, 0o700)
      releaseCliLock(lock)
    }
  })
}

test('completion preparation requires the original coordinator and current technical health', async t => {
  const f = await fixture(t), lock = await acquireCliLock(f.data, 'workspace-relocation')
  try {
    await beginWorkspaceRelocationIntent(f.input)
    const records = await import('../workspace-relocation-intent.mjs')
    assert.equal(records.readWorkspaceRelocationCompletion(f.data, f.input.id), null)
    await assert.rejects(records.prepareWorkspaceRelocationCompletion({ dataDir: f.data, id: f.input.id }), { code: 'WORKSPACE_RELOCATION_INVALID' })
    await assert.rejects(records.archiveWorkspaceRelocationJob({ dataDir: f.data, id: f.input.id }), { code: 'WORKSPACE_RELOCATION_INVALID' })
    assert.equal(records.readWorkspaceRelocationCompletion(f.data, f.input.id), null)
    assert.throws(() => assertWorkspaceExecutionAllowed(f.data), { code: 'WORKSPACE_MAINTENANCE' })
    assert.deepEqual(await f.catalog.snapshot(), f.snapshot)
    await assert.rejects(fs.stat(path.join(path.dirname(f.recordFile), 'relocation-complete.json')), { code: 'ENOENT' })
  } finally { releaseCliLock(lock) }
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

test('a historical job id cannot be reused to freeze a new migration', async t => {
  const f = await fixture(t), lock = await acquireCliLock(f.data, 'workspace-relocation')
  const history = management.ensurePrivateDataRoot(path.join(f.data, 'workspace-control/relocation-history'))
  const existing = management.ensurePrivateDataRoot(path.join(history, f.input.id))
  await fs.writeFile(path.join(existing, 'preserve'), 'old job material')
  try {
    await assert.rejects(beginWorkspaceRelocationIntent(f.input), { code: 'WORKSPACE_RELOCATION_CONFLICT' })
    assert.equal(readWorkspaceRelocationIntent(f.data), null)
    assertWorkspaceExecutionAllowed(f.data)
    assert.deepEqual(await f.catalog.snapshot(), f.snapshot)
    assert.equal(await fs.readFile(path.join(existing, 'preserve'), 'utf8'), 'old job material')
  } finally { releaseCliLock(lock) }
})

test('a retained release fact reserves its job id even when the archive is unavailable', async t => {
  const f = await fixture(t), lock = await acquireCliLock(f.data, 'workspace-relocation')
  const history = management.ensurePrivateDataRoot(path.join(f.data, 'workspace-control/relocation-history'))
  const released = path.join(history, f.input.id + '.released.json')
  await fs.writeFile(released, 'retained release fact')
  try {
    await assert.rejects(beginWorkspaceRelocationIntent(f.input), { code: 'WORKSPACE_RELOCATION_CONFLICT' })
    assert.equal(readWorkspaceRelocationIntent(f.data), null)
    assertWorkspaceExecutionAllowed(f.data)
    assert.deepEqual(await f.catalog.snapshot(), f.snapshot)
    assert.equal(await fs.readFile(released, 'utf8'), 'retained release fact')
  } finally { releaseCliLock(lock) }
})

test('new intent owns an independent active directory while the catalog stays in place', async t => {
  const f = await fixture(t), lock = await acquireCliLock(f.data, 'workspace-relocation')
  const control = path.join(f.data, 'workspace-control'), catalog = path.join(control, 'catalog.json')
  const before = await fs.readFile(catalog), catalogStat = await fs.stat(catalog, { bigint: true })
  try {
    const accepted = await beginWorkspaceRelocationIntent(f.input)
    const active = path.join(control, 'relocation-active'), stat = await fs.lstat(active, { bigint: true })
    assert.deepEqual(accepted.control_root, { path: active, dev: String(stat.dev), ino: String(stat.ino) })
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(active, 'relocation.json'), 'utf8')), accepted)
    await assert.rejects(fs.lstat(path.join(control, 'relocation.json')), { code: 'ENOENT' })
    assert.deepEqual(await fs.readFile(catalog), before)
    assert.equal((await fs.stat(catalog, { bigint: true })).ino, catalogStat.ino)
  } finally { releaseCliLock(lock) }
})

test('the whole catalog control root stays protected when the caller supplies no extra protected paths', async t => {
  const f = await fixture(t), lock = await acquireCliLock(f.data, 'workspace-relocation')
  const control = path.join(f.data, 'workspace-control'), before = await fs.readdir(control)
  try {
    await assert.rejects(beginWorkspaceRelocationIntent({ ...f.input, target: path.join(control, 'workspace-target'), protectedRoots: [] }))
    assert.equal(readWorkspaceRelocationIntent(f.data), null)
    assertWorkspaceExecutionAllowed(f.data)
    assert.deepEqual(await fs.readdir(control), before)
    assert.deepEqual(await f.catalog.snapshot(), f.snapshot)
  } finally { releaseCliLock(lock) }
})

for (const residue of ['empty active directory', 'finalizing marker', 'legacy flat intent']) test('does not adopt or overwrite ' + residue, async t => {
  const f = await fixture(t), lock = await acquireCliLock(f.data, 'workspace-relocation')
  const control = path.join(f.data, 'workspace-control'), active = path.join(control, 'relocation-active')
  const record = path.join(control, residue === 'finalizing marker' ? 'relocation-finalizing.json' : 'relocation.json')
  try {
    if (residue === 'empty active directory') await fs.mkdir(active, { mode: 0o700 })
    else await fs.writeFile(record, 'preserve unknown activity', { mode: 0o600 })
    const names = await fs.readdir(control)
    await assert.rejects(beginWorkspaceRelocationIntent(f.input))
    assert.deepEqual(await fs.readdir(control), names)
    assert.deepEqual(await f.catalog.snapshot(), f.snapshot)
    await assert.rejects(fs.lstat(f.input.target), { code: 'ENOENT' })
    if (residue !== 'empty active directory') assert.equal(await fs.readFile(record, 'utf8'), 'preserve unknown activity')
  } finally { releaseCliLock(lock) }
})

test('failed first intent publication does not freeze business or create an empty active job', async t => {
  const f = await fixture(t), lock = await acquireCliLock(f.data, 'workspace-relocation')
  try {
    const link = t.mock.method(syncFs, 'linkSync', () => { throw Object.assign(new Error('finite publication write failure'), { code: 'EIO' }) })
    await assert.rejects(beginWorkspaceRelocationIntent(f.input), { code: 'EIO' })
    link.mock.restore()
    assert.equal(readWorkspaceRelocationIntent(f.data), null)
    assertWorkspaceExecutionAllowed(f.data)
    await assert.rejects(fs.lstat(path.join(f.data, 'workspace-control/relocation-active')), { code: 'ENOENT' })
    assert.deepEqual(await f.catalog.snapshot(), f.snapshot)
    assert.equal(await fs.readFile(path.join(f.source, 'default/original.txt'), 'utf8'), 'user bytes')
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

for (const choice of ['different root', 'current root', 'environment changed during preview']) test('an explicit deployment workspace is checked before freezing: ' + choice, async t => {
  const f = await fixture(t), lock = await acquireCliLock(f.data, 'workspace-relocation')
  const previous = process.env.WORKER_WORKSPACES_DIR, control = path.join(f.data, 'workspace-control'), names = await fs.readdir(control)
  try {
    process.env.WORKER_WORKSPACES_DIR = f.source
    if (choice === 'environment changed during preview') {
      delete process.env.WORKER_WORKSPACES_DIR
      const statfs = fs.statfs
      t.mock.method(fs, 'statfs', async (...args) => { const result = await statfs(...args); process.env.WORKER_WORKSPACES_DIR = f.source; return result })
    }
    if (choice !== 'current root') await assert.rejects(beginWorkspaceRelocationIntent(f.input), { code: 'WORKSPACE_DIRECTORY_CONFLICT' })
    else assert.deepEqual(await beginWorkspaceRelocationIntent({ ...f.input, target: f.source }), { unchanged: true, source: f.source })
    assert.equal(readWorkspaceRelocationIntent(f.data), null)
    assertWorkspaceExecutionAllowed(f.data)
    assert.deepEqual(await fs.readdir(control), names)
    assert.deepEqual(await f.catalog.snapshot(), f.snapshot)
    assert.equal(await fs.readFile(path.join(f.source, 'default/original.txt'), 'utf8'), 'user bytes')
    await assert.rejects(fs.stat(f.input.target), { code: 'ENOENT' })
  } finally {
    if (previous === undefined) delete process.env.WORKER_WORKSPACES_DIR
    else process.env.WORKER_WORKSPACES_DIR = previous
    releaseCliLock(lock)
  }
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
      if (syncFs.fstatSync(fd).isDirectory() && syncFs.existsSync(f.recordFile)) throw Object.assign(new Error('flush fault'), { code: 'EIO' })
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
  const original = native.renameDirectoryNoReplace
  let injected = false
  try {
    const mocked = t.mock.method(native, 'renameDirectoryNoReplace', function(source, target) {
      const result = original(source, target)
      if (target !== path.dirname(f.recordFile)) return result
      injected = true
      throw Object.assign(new Error('publication reply lost'), { code: 'EIO' })
    })
    await assert.rejects(beginWorkspaceRelocationIntent(f.input), { code: 'EIO' })
    mocked.mock.restore(); assert.equal(injected, true)
    const record = readWorkspaceRelocationIntent(f.data), before = await fs.readFile(f.recordFile)
    assert.equal(record.id, f.input.id)
    assert.deepEqual(await beginWorkspaceRelocationIntent(f.input), record)
    assert.deepEqual(await fs.readFile(f.recordFile), before)
    assert.deepEqual(await f.catalog.snapshot(), f.snapshot)
    assert.equal(await fs.readFile(path.join(f.source, 'default/original.txt'), 'utf8'), 'user bytes')
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
  const original = syncFs.lstatSync, control = path.join(f.data, 'workspace-control'), retained = path.join(f.root, 'retained-control')
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
  let unexpected
  try {
    const mocked = t.mock.method(syncFs, 'linkSync', function(source, target) {
      unexpected = target
      syncFs.writeFileSync(target, 'unexpected existing control', { flag: 'wx', mode: 0o600 })
      return original(source, target)
    })
    await assert.rejects(beginWorkspaceRelocationIntent(f.input), { code: 'WORKSPACE_RELOCATION_CONFLICT' })
    mocked.mock.restore()
    assert.equal(await fs.readFile(unexpected, 'utf8'), 'unexpected existing control')
    assert.equal(readWorkspaceRelocationIntent(f.data), null)
    assertWorkspaceExecutionAllowed(f.data)
    await assert.rejects(fs.lstat(f.recordFile), { code: 'ENOENT' })
  } finally { releaseCliLock(lock) }
})

test('atomic job admission never replaces an unexpected active directory', async t => {
  const f = await fixture(t), lock = await acquireCliLock(f.data, 'workspace-relocation')
  const active = path.dirname(f.recordFile), move = native.renameDirectoryNoReplace
  let injected = false
  try {
    const mocked = t.mock.method(native, 'renameDirectoryNoReplace', function(source, target) {
      if (target !== active) return move(source, target)
      injected = true
      if (process.platform === 'win32') native.createPrivateDirectory(active)
      else syncFs.mkdirSync(active, { mode: 0o700 })
      syncFs.writeFileSync(path.join(active, 'unexpected'), 'preserve foreign content')
      return move(source, target)
    })
    await assert.rejects(beginWorkspaceRelocationIntent(f.input))
    mocked.mock.restore(); assert.equal(injected, true)
    assertWorkspaceStillProtected(f.data)
    assert.equal(await fs.readFile(path.join(active, 'unexpected'), 'utf8'), 'preserve foreign content')
    assert.throws(() => readWorkspaceRelocationIntent(f.data))
    assert.deepEqual(await f.catalog.snapshot(), f.snapshot)
    assert.equal(await fs.readFile(path.join(f.source, 'default/original.txt'), 'utf8'), 'user bytes')
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
  const scopeFile = path.join(f.data, 'workspace-control/relocation-active/relocation-workers.json')
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
  const file = path.join(f.data, 'workspace-control/relocation-active/relocation-workers.json')
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
    await assert.rejects(fs.stat(path.join(f.data, 'workspace-control/relocation-active/relocation-workers.json')), { code: 'ENOENT' })
  } finally { releaseCliLock(lock) }
})

test('fixed set survives a lost publication reply and later id-bound native lock recovery', async t => {
  const f = await fixture(t), workers = workerSet(), file = path.join(f.data, 'workspace-control/relocation-active/relocation-workers.json')
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
    await assert.rejects(fs.stat(path.join(f.data, 'workspace-control/relocation-active/relocation-workers.json')), { code: 'ENOENT' })
  } finally { syncFs.writeFileSync = write; releaseCliLock(lock) }
})

test('an unknown fixed-set entry appearing at publication is preserved', async t => {
  const f = await fixture(t), lock = await acquireCliLock(f.data, 'workspace-relocation'), workers = workerSet()
  const link = syncFs.linkSync, file = path.join(f.data, 'workspace-control/relocation-active/relocation-workers.json')
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
  const link = syncFs.linkSync, file = path.join(f.data, 'workspace-control/relocation-active/relocation-workers.json')
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


for (const file of ['relocation-stop-attempt.json', 'relocation-stop-submission.json', 'relocation-modules.json', 'relocation-module-stop-attempt.json', 'relocation-module-processes', 'relocation-module-stop-submission.json', 'relocation-coordinator.json', 'relocation-coordinator-ready.json']) test('orphaned stop evidence keeps all execution entry points fenced: ' + file, async t => {
  const f = await fixture(t), active = path.join(f.data, 'workspace-control/relocation-active')
  if (process.platform === 'win32') native.createPrivateDirectory(active)
  else await fs.mkdir(active, { mode: 0o700 })
  await fs.writeFile(path.join(active, file), '{}', { mode: 0o600 })
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
  const file = path.join(f.data, 'workspace-control/relocation-active/relocation-stop-attempt.json'), submitted = path.join(f.data, 'workspace-control/relocation-active/relocation-stop-submission.json')
  try {
    await beginWorkspaceRelocationIntent(f.input); commitWorkspaceRelocationWorkers({ dataDir: f.data, id: f.input.id, workers })
    const { attempt } = prepareWorkspaceRelocationStops({ dataDir: f.data, id: f.input.id, workers })
    const result = completeWorkspaceRelocationStops({ dataDir: f.data, id: f.input.id, results: submissionResults(workers) })
    if (damage === 'attempt json') await fs.writeFile(file, '{broken')
    if (damage === 'attempt scope') await fs.writeFile(file, JSON.stringify({ ...attempt, workers_sha256: '0'.repeat(64) }))
    if (damage === 'attempt link') { const original = path.join(f.root, 'retained-attempt'); await fs.rename(file, original); await fs.symlink(original, file, 'file') }
    if (damage === 'attempt hardlink') await fs.link(file, path.join(f.root, 'hardlink'))
    if (damage === 'submission attempt') await fs.writeFile(submitted, JSON.stringify({ ...result, attempt_sha256: '0'.repeat(64) }))
    if (damage === 'missing upstream') await fs.rm(path.join(f.data, 'workspace-control/relocation-active/relocation-workers.json'))
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
  const control = path.join(f.data, 'workspace-control/relocation-active'), observations = path.join(control, 'relocation-module-processes'), first = path.join(observations, '00000000.json')
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
  const directory = path.join(f.data, 'workspace-control/relocation-active/relocation-module-processes'), inode = syncFs.statSync(directory).ino
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
for (const kind of ['module', 'CLI']) test('historical ' + kind + ' scope permits the reader to reuse an exited generation PID without adopting it', async t => {
  const f = await moduleFixture(t), self = native.inspectProcess(process.pid)
  const file = path.join(f.data, 'workspace-control/relocation-active', kind === 'module' ? 'relocation-modules.json' : 'relocation-worker-processes.json')
  if (kind === 'module') commitWorkspaceRelocationModules({ ...f.options, modules: f.modules })
  else commitWorkspaceRelocationProcesses({ ...f.options, processes: f.modules[0].processes })
  const stored = JSON.parse(await fs.readFile(file, 'utf8'))
  const processes = kind === 'module' ? stored.modules[0].processes : stored.processes
  processes[0] = { ...self, started: self.started + '-departed-generation' }
  await fs.writeFile(file, JSON.stringify(stored) + '\n')
  const bytes = await fs.readFile(file)
  const read = () => kind === 'module' ? readWorkspaceRelocationModules(f.data, f.input.id) : readWorkspaceRelocationProcesses(f.data, f.input.id)
  assert.deepEqual(read(), stored)
  const require = createRequire(import.meta.url)
  assert.equal(require('../known-process-exit.cjs').probeKnownProcessExit(processes).state, 'stopped')
  assert.deepEqual(await fs.readFile(file), bytes)
  assertWorkspaceStillProtected(f.data)

  for (const executable of [self.executable, self.executable + '.previous-image']) {
    processes[0] = { ...self, executable }
    await fs.writeFile(file, JSON.stringify(stored) + '\n')
    assert.throws(read, { code: 'WORKSPACE_RELOCATION_INVALID' })
  }
})

test('an observation directory replaced before its first entry cannot restart a fresh chain', async t => {
  const f = await moduleFixture(t)
  commitWorkspaceRelocationModules({ ...f.options, modules: f.modules }); prepareWorkspaceRelocationModuleStops({ ...f.options, modules: f.modules })
  const directory = path.join(f.data, 'workspace-control/relocation-active/relocation-module-processes')
  await fs.rename(directory, path.join(f.root, 'first-observation-directory'))
  management.ensurePrivateDataRoot(directory)
  assert.throws(() => observeWorkspaceRelocationModuleProcesses({ ...f.options, moduleId: 'fixture-memory', processes: f.modules[0].processes }), { code: 'WORKSPACE_RELOCATION_INVALID' })
  assert.throws(() => prepareWorkspaceRelocationModuleStops({ ...f.options, modules: f.modules }), { code: 'WORKSPACE_RELOCATION_INVALID' })
})

test('the read-only record API loads from the actual CommonJS Node backend without awaiting upgrade code', () => {
  const file = createRequire(import.meta.url).resolve('../workspace-relocation-intent.mjs')
  assert.equal(execFileSync(process.execPath, ['-e', 'process.stdout.write(typeof require(process.argv[1]).readWorkspaceRelocationIntent)', file], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }), 'function')
})

test('asynchronous version loading cannot borrow a later operation lock from the same process', async t => {
  const f = await fixture(t), lock = await acquireCliLock(f.data, 'workspace-relocation')
  const pending = beginWorkspaceRelocationIntent(f.input)
  const rejected = assert.rejects(pending, { code: 'WORKSPACE_RELOCATION_INVALID' })
  releaseCliLock(lock)
  const replacement = await acquireCliLock(f.data, 'different-operation')
  try { await rejected; assert.equal(readWorkspaceRelocationIntent(f.data), null) }
  finally { releaseCliLock(replacement) }
})

async function coordinatorChild(t) {
  const entry = new URL('../workspace-relocation-intent.mjs', import.meta.url).href
  const locks = new URL('../cli-lock.mjs', import.meta.url).href
  const code = `import {commitWorkspaceRelocationCoordinatorReady} from ${JSON.stringify(entry)};
    import {acquireWorkspaceRelocationLock} from ${JSON.stringify(locks)};
    setTimeout(()=>process.exit(0),30000);
    process.on('message',async({dataDir,id,withoutLock})=>{try{if(!withoutLock)await acquireWorkspaceRelocationLock(dataDir,id);const ready=commitWorkspaceRelocationCoordinatorReady({dataDir,id});
      process.send({ready});}catch(error){process.send({error:{code:error.code,message:error.message}})}});`
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
  const exited = once(child, 'exit'); void exited.catch(() => {})
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited })
  await once(child, 'spawn')
  return { child, process: native.inspectProcess(child.pid), exited }
}

test('coordinator launch requires the actual lock and actual child identity without granting any file action', async t => {
  let lock
  const c = await coordinatorChild(t), f = await fixture(t, () => releaseCliLock(lock))
  lock = await acquireCliLock(f.data, 'workspace-relocation'); await beginWorkspaceRelocationIntent(f.input); releaseCliLock(lock)
  const args = { dataDir: f.data, id: f.input.id, launchId: randomUUID(), coordinator: c.process }
  assert.throws(() => commitWorkspaceRelocationCoordinator(args), { code: 'WORKSPACE_RELOCATION_INVALID' })
  lock = await acquireWorkspaceRelocationLock(f.data, f.input.id)
  for (const patch of [{ parent: -1 }, { started: 'other' }, { owner: 'other' }, { pid: process.pid }]) {
    assert.throws(() => commitWorkspaceRelocationCoordinator({ ...args, coordinator: { ...c.process, ...patch } }), { code: 'WORKSPACE_RELOCATION_INVALID' })
  }
  const first = commitWorkspaceRelocationCoordinator(args)
  assert.deepEqual(commitWorkspaceRelocationCoordinator(args), first)
  assert.deepEqual(readWorkspaceRelocationCoordinator(f.data, f.input.id), { launch: first, ready: null })
  assert.throws(() => commitWorkspaceRelocationCoordinator({ ...args, launchId: randomUUID() }), { code: 'WORKSPACE_RELOCATION_CONFLICT' })
  assert.throws(() => commitWorkspaceRelocationCoordinatorReady({ dataDir: f.data, id: f.input.id }), { code: 'WORKSPACE_RELOCATION_INVALID' })
  assert.equal(await fs.readFile(path.join(f.source, 'default/original.txt'), 'utf8'), 'user bytes')
  assert.deepEqual(await f.catalog.snapshot(), f.snapshot)
})

test('only the fixed coordinator publishes readiness under its own native lock and history survives its exit', async t => {
  let lock
  const c = await coordinatorChild(t), f = await fixture(t, () => releaseCliLock(lock))
  lock = await acquireCliLock(f.data, 'workspace-relocation'); await beginWorkspaceRelocationIntent(f.input)
  const launch = commitWorkspaceRelocationCoordinator({ dataDir: f.data, id: f.input.id, launchId: randomUUID(), coordinator: c.process })
  releaseCliLock(lock)
  const reply = once(c.child, 'message', { signal: AbortSignal.timeout(10000) })
  c.child.send({ dataDir: f.data, id: f.input.id })
  const [response] = await reply
  assert.equal(response.error, undefined)
  const result = readWorkspaceRelocationCoordinator(f.data, f.input.id)
  assert.deepEqual(result.ready, response.ready)
  assert.deepEqual(result.launch, launch)
  await assert.rejects(acquireWorkspaceRelocationLock(f.data, f.input.id, 0), /another crabot CLI operation/)
  c.child.kill('SIGKILL'); await c.exited
  assert.deepEqual(readWorkspaceRelocationCoordinator(f.data, f.input.id), result)
  assertWorkspaceStillProtected(f.data)
  await assert.rejects(fs.stat(f.input.target), { code: 'ENOENT' })
})

for (const damage of ['hash', 'extra', 'hardlink', 'missing-launch', 'null-launch', 'null-ready']) test('coordinator handoff rejects damaged or orphaned identity: ' + damage, async t => {
  let lock
  const c = await coordinatorChild(t), f = await fixture(t, () => releaseCliLock(lock))
  lock = await acquireCliLock(f.data, 'workspace-relocation'); await beginWorkspaceRelocationIntent(f.input)
  const record = commitWorkspaceRelocationCoordinator({ dataDir: f.data, id: f.input.id, launchId: randomUUID(), coordinator: c.process })
  const file = path.join(f.data, 'workspace-control/relocation-active/relocation-coordinator.json')
  if (damage === 'hash') await fs.writeFile(file, JSON.stringify({ ...record, intent_sha256: '0'.repeat(64) }))
  if (damage === 'extra') await fs.writeFile(file, JSON.stringify({ ...record, token: 'not-allowed' }))
  if (damage === 'null-launch') await fs.writeFile(file, 'null')
  if (damage === 'null-ready') {
    const invalid = path.join(f.data, 'workspace-control/relocation-active/relocation-coordinator-ready.json')
    if (process.platform === 'win32') native.writePrivateFile(invalid, 'null')
    else await fs.writeFile(invalid, 'null', { mode: 0o600 })
  }
  if (damage === 'hardlink') await fs.link(file, path.join(f.root, 'outside-launch'))
  if (damage === 'missing-launch') {
    await fs.rm(file);
    const orphan = path.join(f.data, 'workspace-control/relocation-active/relocation-coordinator-ready.json')
    if (process.platform === 'win32') native.writePrivateFile(orphan, '{}')
    else await fs.writeFile(orphan, '{}', { mode: 0o600 })
  }
  assert.throws(() => readWorkspaceRelocationCoordinator(f.data, f.input.id), { code: 'WORKSPACE_RELOCATION_INVALID' })
  assertWorkspaceStillProtected(f.data)
})

test('coordinator launch publication reply loss preserves the first child and launch without replacing it', async t => {
  let lock
  const c = await coordinatorChild(t), f = await fixture(t, () => releaseCliLock(lock))
  lock = await acquireCliLock(f.data, 'workspace-relocation'); await beginWorkspaceRelocationIntent(f.input)
  const input = { dataDir: f.data, id: f.input.id, launchId: randomUUID(), coordinator: c.process }, link = syncFs.linkSync
  const mocked = t.mock.method(syncFs, 'linkSync', (source, target) => {
    link(source, target); throw Object.assign(new Error('reply lost'), { code: 'EIO' })
  })
  try { assert.throws(() => commitWorkspaceRelocationCoordinator(input), { code: 'EIO' }) }
  finally { mocked.mock.restore() }
  const first = readWorkspaceRelocationCoordinator(f.data, f.input.id)
  assert.equal(first.launch.launch_id, input.launchId)
  assert.deepEqual(commitWorkspaceRelocationCoordinator(input), first.launch)
  assertWorkspaceStillProtected(f.data)
})

test('the real coordinator cannot publish readiness before taking over its own native lock', async t => {
  let lock
  const c = await coordinatorChild(t), f = await fixture(t, () => releaseCliLock(lock))
  lock = await acquireCliLock(f.data, 'workspace-relocation'); await beginWorkspaceRelocationIntent(f.input)
  commitWorkspaceRelocationCoordinator({ dataDir: f.data, id: f.input.id, launchId: randomUUID(), coordinator: c.process })
  releaseCliLock(lock)
  const reply = once(c.child, 'message', { signal: AbortSignal.timeout(10000) })
  c.child.send({ dataDir: f.data, id: f.input.id, withoutLock: true })
  const [response] = await reply
  assert.equal(response.error?.code, 'WORKSPACE_RELOCATION_INVALID')
  assert.equal(readWorkspaceRelocationCoordinator(f.data, f.input.id).ready, null)
  assertWorkspaceStillProtected(f.data)
})

for (const dependent of ['relocation-worker-processes.json', 'relocation-stop-attempt.json', 'relocation-stop-submission.json', 'relocation-modules.json', 'relocation-module-stop-attempt.json', 'relocation-module-processes', 'relocation-module-stop-submission.json']) test('an existing intent cannot reconstruct a missing Worker scope over downstream evidence: ' + dependent, async t => {
  let lock
  const f = await fixture(t, () => releaseCliLock(lock))
  lock = await acquireCliLock(f.data, 'workspace-relocation'); await beginWorkspaceRelocationIntent(f.input)
  const orphan = path.join(f.data, 'workspace-control/relocation-active', dependent), workersFile = path.join(f.data, 'workspace-control/relocation-active/relocation-workers.json')
  if (process.platform === 'win32') native.writePrivateFile(orphan, '{}')
  else await fs.writeFile(orphan, '{}', { mode: 0o600 })
  assert.throws(() => commitWorkspaceRelocationWorkers({ dataDir: f.data, id: f.input.id, workers: workerSet() }), { code: 'WORKSPACE_RELOCATION_INVALID' })
  assert.throws(() => readWorkspaceRelocationWorkers(f.data, f.input.id), { code: 'WORKSPACE_RELOCATION_INVALID' })
  await assert.rejects(fs.stat(workersFile), { code: 'ENOENT' })
  assert.equal(await fs.readFile(orphan, 'utf8'), '{}')
  assertWorkspaceStillProtected(f.data)
})


async function processFixture(t) {
  const f = await moduleFixture(t)
  return { ...f, processes: f.modules[0].processes, file: path.join(f.data, 'workspace-control/relocation-active/relocation-worker-processes.json') }
}
test('the first CLI process observation is lock-bound, immutable and independent from exit or Worker closure', async t => {
  const f = await processFixture(t), before = await f.catalog.snapshot()
  const input = { ...f.options, processes: f.processes }
  const original = commitWorkspaceRelocationProcesses(input)
  assert.deepEqual(readWorkspaceRelocationProcesses(f.data, f.input.id), original)
  assert.deepEqual(commitWorkspaceRelocationProcesses(input), original)
  assert.deepEqual(original.processes, f.processes)
  assert.equal(readWorkspaceRelocationStops(f.data, f.input.id).attempt, null)
  assert.throws(() => commitWorkspaceRelocationProcesses({ ...input, processes: [] }), { code: 'WORKSPACE_RELOCATION_CONFLICT' })
  releaseCliLock(f.lock)
  assert.throws(() => commitWorkspaceRelocationProcesses(input), { code: 'WORKSPACE_RELOCATION_INVALID' })
  assert.deepEqual(readWorkspaceRelocationProcesses(f.data, f.input.id), original)
  assert.deepEqual(await f.catalog.snapshot(), before)
  assert.equal(await fs.readFile(path.join(f.source, 'default/original.txt'), 'utf8'), 'user bytes')
  assertWorkspaceStillProtected(f.data)
})
for (const change of ['extra field', 'duplicate', 'wrong owner', 'self', 'unsorted', 'bad parent', 'bad pid', 'empty start']) test('bad CLI process scope is not published: ' + change, async t => {
  const f = await processFixture(t), processes = structuredClone(f.processes)
  if (change === 'extra field') processes[0].secret = 'never copy'
  if (change === 'duplicate') processes.push({ ...processes[0] })
  if (change === 'wrong owner') processes[0].owner = 'another-owner'
  if (change === 'self') processes[0].pid = process.pid
  if (change === 'unsorted') processes.push({ ...processes[0], pid: processes[0].pid - 1 })
  if (change === 'bad parent') processes[0].parent = -1
  if (change === 'bad pid') processes[0].pid = 0
  if (change === 'empty start') processes[0].started = ''
  assert.throws(() => commitWorkspaceRelocationProcesses({ ...f.options, processes }), { code: 'WORKSPACE_RELOCATION_INVALID' })
  assert.equal(readWorkspaceRelocationProcesses(f.data, f.input.id), null)
  await assert.rejects(fs.stat(f.file), { code: 'ENOENT' })
})
for (const attempt of ['Worker', 'module']) test('a missing pre-stop CLI observation cannot be added after a ' + attempt + ' stop attempt', async t => {
  const f = await processFixture(t)
  if (attempt === 'Worker') prepareWorkspaceRelocationStops({ ...f.options, workers: [] })
  else { commitWorkspaceRelocationModules({ ...f.options, modules: f.modules }); prepareWorkspaceRelocationModuleStops({ ...f.options, modules: f.modules }) }
  assert.throws(() => commitWorkspaceRelocationProcesses({ ...f.options, processes: f.processes }), { code: 'WORKSPACE_RELOCATION_INVALID' })
  await assert.rejects(fs.stat(f.file), { code: 'ENOENT' })
  assertWorkspaceStillProtected(f.data)
})
for (const change of ['missing Worker scope', 'changed Worker scope', 'missing intent', 'hardlink', 'control replaced']) test('CLI process scope cannot survive unverifiable upstream materials: ' + change, async t => {
  const f = await processFixture(t)
  commitWorkspaceRelocationProcesses({ ...f.options, processes: f.processes })
  const control = path.dirname(f.file), workers = path.join(control, 'relocation-workers.json')
  if (change === 'missing Worker scope') await fs.rm(workers)
  if (change === 'changed Worker scope') {
    const record = JSON.parse(await fs.readFile(workers, 'utf8')); record.workers = workerSet(); await fs.writeFile(workers, JSON.stringify(record))
  }
  if (change === 'missing intent') await fs.rm(f.recordFile)
  if (change === 'hardlink') await fs.link(f.file, path.join(f.root, 'extra-link'))
  if (change === 'control replaced') {
    await fs.rename(control, control + '-old')
    if (process.platform === 'win32') native.createPrivateDirectory(control)
    else await fs.mkdir(control, { mode: 0o700 })
    for (const file of await fs.readdir(control + '-old')) await fs.rename(path.join(control + '-old', file), path.join(control, file))
  }
  assert.throws(() => readWorkspaceRelocationProcesses(f.data, f.input.id), { code: 'WORKSPACE_RELOCATION_INVALID' })
  assert.throws(() => commitWorkspaceRelocationProcesses({ ...f.options, processes: f.processes }), { code: 'WORKSPACE_RELOCATION_INVALID' })
  assertWorkspaceStillProtected(f.data)
})
test('published CLI process scope is retained after a lost publication acknowledgement', async t => {
  const f = await processFixture(t), original = syncFs.linkSync
  t.mock.method(syncFs, 'linkSync', (...args) => { original(...args); throw new Error('reply lost after publication') })
  assert.throws(() => commitWorkspaceRelocationProcesses({ ...f.options, processes: f.processes }), /reply lost/)
  t.mock.restoreAll()
  const stored = readWorkspaceRelocationProcesses(f.data, f.input.id)
  assert.ok(stored)
  assert.deepEqual(commitWorkspaceRelocationProcesses({ ...f.options, processes: f.processes }), stored)
  assertWorkspaceStillProtected(f.data)
})

test('no lock means zero initial CLI observation publication, including an empty scope', async t => {
  const f = await processFixture(t)
  releaseCliLock(f.lock)
  assert.throws(() => commitWorkspaceRelocationProcesses({ ...f.options, processes: [] }), { code: 'WORKSPACE_RELOCATION_INVALID' })
  assert.equal(readWorkspaceRelocationProcesses(f.data, f.input.id), null)
  await assert.rejects(fs.stat(f.file), { code: 'ENOENT' })
})
test('an empty initial CLI scope is retained as an observation without inventing a stop attempt', async t => {
  const f = await processFixture(t)
  const record = commitWorkspaceRelocationProcesses({ ...f.options, processes: [] })
  assert.deepEqual(record.processes, [])
  assert.deepEqual(readWorkspaceRelocationProcesses(f.data, f.input.id), record)
  assert.equal(readWorkspaceRelocationStops(f.data, f.input.id).attempt, null)
  assertWorkspaceStillProtected(f.data)
})


test('cross-volume unsupported source metadata is rejected before publishing maintenance or stopping execution', { skip: process.platform !== 'linux' }, async t => {
  const f = await fixture(t), target = path.join('/dev/shm', 'crabot-preflight-' + randomUUID())
  if (!syncFs.existsSync('/dev/shm') || syncFs.statSync('/dev/shm').dev === syncFs.statSync(f.source).dev) { t.skip('requires a distinct writable fixture filesystem'); return }
  const file = path.join(f.source, 'default/original.txt'), lock = await acquireCliLock(f.data, 'workspace-relocation')
  execFileSync('chattr', ['+d', file])
  try {
    await assert.rejects(beginWorkspaceRelocationIntent({ ...f.input, target }), { code: 'WORKSPACE_COPY_METADATA_UNSUPPORTED' })
    assert.equal(readWorkspaceRelocationIntent(f.data), null); assertWorkspaceExecutionAllowed(f.data)
    assert.equal(syncFs.existsSync(target), false); assert.deepEqual(await f.catalog.snapshot(), f.snapshot)
    assert.equal(await fs.readFile(file, 'utf8'), 'user bytes')
  } finally { execFileSync('chattr', ['-d', file]); releaseCliLock(lock) }
})


test('new intents fix the exact policy and legacy schema1 is read unchanged without promotion', async t => {
  const f = await fixture(t), lock = await acquireCliLock(f.data, 'workspace-relocation')
  try {
    const current = await beginWorkspaceRelocationIntent(f.input)
    assert.equal(current.schema_version, 2); assert.equal(current.metadata_compatibility, 'exact')
    const legacy = { ...current, schema_version: 1 }; delete legacy.metadata_compatibility
    await fs.writeFile(f.recordFile, JSON.stringify(legacy))
    const bytes = await fs.readFile(f.recordFile)
    assert.deepEqual(readWorkspaceRelocationIntent(f.data), legacy)
    assert.deepEqual(await beginWorkspaceRelocationIntent(f.input), legacy)
    assert.deepEqual(await fs.readFile(f.recordFile), bytes)
    for (const metadata_compatibility of ['arbitrary', null, 'windows-owner-inheritance-v1']) {
      await fs.writeFile(f.recordFile, JSON.stringify({ ...current, metadata_compatibility }))
      assert.throws(() => readWorkspaceRelocationIntent(f.data), { code: 'WORKSPACE_RELOCATION_INVALID' })
    }
    await fs.writeFile(f.recordFile, JSON.stringify({ ...legacy, metadata_compatibility: 'exact' }))
    assert.throws(() => readWorkspaceRelocationIntent(f.data), { code: 'WORKSPACE_RELOCATION_INVALID' })
  } finally { releaseCliLock(lock) }
})


test('a finite synchronous record observation shares reads but still detects a cached record changed before return', async t => {
  const f = await fixture(t), lock = await acquireCliLock(f.data, 'workspace-relocation')
  try {
    const accepted = await beginWorkspaceRelocationIntent(f.input), bytes = await fs.readFile(f.recordFile)
    const original = syncFs.readFileSync; let reads = 0
    const counting = t.mock.method(syncFs, 'readFileSync', function(file, ...args) {
      if (typeof file === 'number') reads++
      return original.call(this, file, ...args)
    })
    try {
      readWorkspaceRelocationIntent(f.data); const single = reads; reads = 0
      observeWorkspaceRelocationRecords(() => {
        const first = readWorkspaceRelocationIntent(f.data)
        assert.equal(readWorkspaceRelocationIntent(f.data), first)
        assert.deepEqual(first, accepted)
        assert.equal(readWorkspaceRelocationWorkers(f.data, f.input.id), null)
      })
      assert.ok(single > 0); assert.equal(reads, single)
      assert.throws(() => observeWorkspaceRelocationRecords(() => {
        readWorkspaceRelocationIntent(f.data)
        syncFs.appendFileSync(f.recordFile, ' ')
        return readWorkspaceRelocationIntent(f.data)
      }))
    } finally { counting.mock.restore(); await fs.writeFile(f.recordFile, bytes) }
    assert.deepEqual(readWorkspaceRelocationIntent(f.data), accepted)
    assert.throws(() => observeWorkspaceRelocationRecords(() => Promise.resolve('never a record frame')), { code: 'WORKSPACE_RELOCATION_INVALID' })
    let executed = false
    assert.throws(() => observeWorkspaceRelocationRecords(async () => { executed = true }), { code: 'WORKSPACE_RELOCATION_INVALID' })
    assert.equal(executed, false)
    // Only record-observation pins are under test; the intentional CLI lock
    // otherwise also holds a non-delete-shared file inside this Windows root.
    releaseCliLock(lock)
    const moved = f.data + '-roundtrip'; await fs.rename(f.data, moved); await fs.rename(moved, f.data)
    assert.deepEqual(readWorkspaceRelocationIntent(f.data), accepted)
  } finally { releaseCliLock(lock) }
})
