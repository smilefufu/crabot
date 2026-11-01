import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs, readFileSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { copyDesktopData, importDesktopData, discoverDesktopDataSource } from '../desktop-data-import.mjs'
import management from '../desktop-management.cjs'
import identity from '../process-identity.cjs'
import { privateJson } from '../desktop-preparation-files.mjs'
import { verifyDataCompatibility } from '../data-compatibility.mjs'

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'crabot-import-')))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const source = path.join(root, 'old/data'), target = path.join(root, 'new/data'), code = path.join(root, 'core')
  await fs.mkdir(source, { recursive: true, mode: 0o700 }); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.mkdir(code)
  await fs.mkdir(path.join(source, 'agent')); await fs.writeFile(path.join(source, 'agent/history.json'), '{"original":true}')
  return { root, source, target, code }
}
test('copy preserves original bytes and counts data without a second scan or copying the source lock', async t => {
  const f = await fixture(t); await fs.writeFile(path.join(f.source, 'cli.lock'), 'source lock')
  const value = await copyDesktopData(f.source, f.target)
  assert.equal(value.files, 1)
  assert.equal(await fs.readFile(path.join(f.target, 'agent/history.json'), 'utf8'), '{"original":true}')
  assert.equal(await fs.readFile(path.join(f.source, 'agent/history.json'), 'utf8'), '{"original":true}')
  await assert.rejects(fs.stat(path.join(f.target, 'cli.lock')), { code: 'ENOENT' })
})
test('overlap and existing target data are rejected without overwriting either copy', async t => {
  const f = await fixture(t)
  await assert.rejects(copyDesktopData(f.source, path.join(f.source, 'nested')), /重叠/)
  await fs.mkdir(f.target); await fs.writeFile(path.join(f.target, 'keep'), 'keep')
  await assert.rejects(copyDesktopData(f.source, f.target), /非空/)
  assert.equal(await fs.readFile(path.join(f.target, 'keep'), 'utf8'), 'keep')
})
test('discovery accepts user data without a historical program-byte whitelist', async t => {
  const f = await fixture(t); await fs.writeFile(path.join(path.dirname(f.source), 'VERSION'), 'v2026.10.14.1\n')
  const result = await discoverDesktopDataSource({ root: path.dirname(f.source) })
  assert.equal(result.dataRoot, f.source); assert.equal(result.version, 'v2026.10.14.1')
})
test('stop precedes copy; migrate receives only the new data and old operational receipts are retained as history', async t => {
  const f = await fixture(t), events = []
  await fs.writeFile(path.join(f.source, 'desktop-maintenance.json'), '{"phase":"installing"}')
  await importDesktopData({ source: { installRoot: path.dirname(f.source), dataRoot: f.source }, root: f.code, target: f.target,
    stop: async () => { events.push('stop'); await assert.rejects(fs.stat(f.target), { code: 'ENOENT' }) },
    migrate: async target => { events.push('migrate'); assert.equal(target, f.target); await fs.writeFile(path.join(target, 'agent/new'), 'new') } })
  assert.deepEqual(events, ['stop', 'migrate'])
  await assert.rejects(fs.stat(path.join(f.source, 'agent/new')), { code: 'ENOENT' })
  assert.equal(await fs.readFile(path.join(f.source, 'desktop-maintenance.json'), 'utf8'), '{"phase":"installing"}')
  await fs.stat(path.join(f.target, 'imported-source-state/desktop-maintenance.json'))
  await assert.rejects(fs.stat(path.join(f.target, 'desktop-maintenance.json')), { code: 'ENOENT' })
})
test('migration failure exposes its real phase and cause while preserving the source', async t => {
  const f = await fixture(t)
  await assert.rejects(importDesktopData({ source: { dataRoot: f.source }, root: f.code, target: f.target,
    stop: async () => {}, migrate: async () => { throw new Error('specific migration failure') } }),
    error => error.code === 'CRABOT_DATA_IMPORT_FAILED' && /迁移数据.*specific migration failure/.test(error.message))
  assert.equal(await fs.readFile(path.join(f.source, 'agent/history.json'), 'utf8'), '{"original":true}')
})

test('workspace paths inside copied data move while external project paths and source catalog remain unchanged', async t => {
  const f = await fixture(t), directory = path.join(f.source, 'workspace-control')
  management.ensurePrivateDataRoot(directory)
  await fs.mkdir(path.join(f.code, 'crabot-agent'))
  await fs.writeFile(path.join(f.code, 'crabot-agent/workspace-data-compat.json'), '{"schema_version":1,"workspace_data_versions":[1]}')
  const catalog = { version: 1, revision: 2, storage_root: path.join(f.source, 'workspaces'), workspaces: [
    { workspace_id: 'default', root: path.join(f.source, 'workspaces/default') },
    { workspace_id: 'external', root: path.join(f.root, 'external-project') } ] }
  await privateJson(path.join(directory, 'catalog.json'), catalog)
  await importDesktopData({ source: { dataRoot: f.source }, root: f.code, target: f.target, stop: async () => {}, migrate: async () => {} })
  const copied = JSON.parse(await fs.readFile(path.join(f.target, 'workspace-control/catalog.json'), 'utf8'))
  assert.doesNotThrow(() => management.requirePrivateDataRoot(path.join(f.target, 'workspace-control')))
  if (process.platform === 'win32') assert.equal(identity.isPrivateFile(path.join(f.target, 'workspace-control/catalog.json')), true)
  assert.doesNotThrow(() => verifyDataCompatibility(f.code, f.target), 'Copied workspace remains usable by the actual startup compatibility reader')
  assert.equal(copied.storage_root, path.join(f.target, 'workspaces'))
  assert.equal(copied.workspaces[0].root, path.join(f.target, 'workspaces/default'))
  assert.equal(copied.workspaces[1].root, catalog.workspaces[1].root)
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(directory, 'catalog.json'), 'utf8')), catalog)
})

test('an unfinished source migration is retained and never rerun in a new copy', async t => {
  const f = await fixture(t), transaction = path.join(f.source, '.upgrade-migrations/task')
  await fs.mkdir(transaction, { recursive: true }); await fs.writeFile(path.join(transaction, 'state.json'), '{"phase":"running"}')
  await assert.rejects(importDesktopData({ source: { dataRoot: f.source }, root: f.code, target: f.target,
    stop: async () => {}, migrate: async () => assert.fail('Unknown migration must not execute again') }), /尚未确认完成/)
  assert.equal(await fs.readFile(path.join(transaction, 'state.json'), 'utf8'), '{"phase":"running"}')
})

test('copy progress counts only files already present and complete at the destination', async t => {
  const f = await fixture(t), updates = []
  await copyDesktopData(f.source, f.target, { progress: value => {
    updates.push(value)
    const file = path.join(f.target, 'agent/history.json')
    assert.equal(readFileSync(file, 'utf8'), '{"original":true}')
    assert.equal(value.bytes, Buffer.byteLength('{"original":true}'))
  } })
  assert.equal(updates.length, 1)
  assert.equal(updates[0].files, 1)
})

test('source lifecycle lock is held before stopping, and released after import failure', async t => {
  const f = await fixture(t)
  const { acquireExistingCliLock, releaseCliLock } = await import('../cli-lock.mjs')
  await assert.rejects(importDesktopData({ source: { dataRoot: f.source }, root: f.code, target: f.target,
    stop: async () => {
      await assert.rejects(acquireExistingCliLock(f.source, 'competing-start', 0), /another crabot CLI operation/)
      throw new Error('stop failed')
    }, migrate: async () => assert.fail('Stop failed, must not migrate') }), /stop failed/)
  const lock = await acquireExistingCliLock(f.source, 'retry', 0)
  releaseCliLock(lock)
})

test('cancelling after the last copied file does not begin migration', async t => {
  const f = await fixture(t), abort = new AbortController()
  await assert.rejects(importDesktopData({ source: { dataRoot: f.source }, root: f.code, target: f.target,
    stop: async () => {}, signal: abort.signal,
    progress: value => { if (value.files === 1) abort.abort() },
    migrate: async () => assert.fail('Cancelled copy must not start migration') }), /abort/i)
  assert.equal(await fs.readFile(path.join(f.source, 'agent/history.json'), 'utf8'), '{"original":true}')
})

test('a copied source desktop marker does not mark an interrupted conversion as ready', async t => {
  const f = await fixture(t)
  await fs.writeFile(path.join(f.source, 'desktop-managed.json'), '{"schema_version":1,"install_kind":"desktop","admin_listen_host":"0.0.0.0"}')
  await assert.rejects(importDesktopData({ source: { dataRoot: f.source }, root: f.code, target: f.target,
    stop: async () => {}, migrate: async () => { throw new Error('conversion interrupted') } }), /conversion interrupted/)
  await assert.rejects(fs.stat(path.join(f.target, 'desktop-managed.json')), { code: 'ENOENT' })
  await fs.stat(path.join(f.target, 'imported-source-state/desktop-managed.json'))
})

test('successful conversion publishes desktop initialization and preserves explicit listening configuration', async t => {
  const f = await fixture(t)
  await fs.writeFile(path.join(f.source, 'desktop-managed.json'), '{"schema_version":1,"install_kind":"desktop","admin_listen_host":"0.0.0.0"}')
  await importDesktopData({ source: { dataRoot: f.source }, root: f.code, target: f.target, stop: async () => {}, migrate: async target => {
    await assert.rejects(fs.stat(path.join(target, 'desktop-managed.json')), { code: 'ENOENT' })
  } })
  assert.equal(JSON.parse(await fs.readFile(path.join(f.target, 'desktop-managed.json'))).admin_listen_host, '0.0.0.0')
})

test('explicit copy retry preserves the lock and recreates only the unfinished copy', async t => {
  const f = await fixture(t)
  management.ensurePrivateDataRoot(f.target); await fs.writeFile(path.join(f.target, 'partial'), 'incomplete')
  await importDesktopData({ source: { dataRoot: f.source }, root: f.code, target: f.target, restartCopy: true,
    stop: async () => {}, migrate: async target => {
      const { acquireExistingCliLock } = await import('../cli-lock.mjs')
      await assert.rejects(acquireExistingCliLock(target, 'competing-start', 0), /another crabot CLI operation/)
    } })
  await assert.rejects(fs.stat(path.join(f.target, 'partial')), { code: 'ENOENT' })
  assert.equal(await fs.readFile(path.join(f.target, 'agent/history.json'), 'utf8'), '{"original":true}')
})

test('copy retry never erases an existing migration with unknown writes', async t => {
  const f = await fixture(t), record = path.join(f.target, '.upgrade-migrations/task/state.json')
  management.ensurePrivateDataRoot(f.target); await fs.mkdir(path.dirname(record), { recursive: true }); await fs.writeFile(record, '{"phase":"running"}')
  await assert.rejects(importDesktopData({ source: { dataRoot: f.source }, root: f.code, target: f.target, restartCopy: true,
    stop: async () => {}, migrate: async () => assert.fail('Must not rerun') }), /迁移/)
  assert.equal(await fs.readFile(record, 'utf8'), '{"phase":"running"}')
})

// A crash during copying must never leave the source initialization marker active.
test('copying source data never publishes the source desktop marker in the new data root', async t => {
  const f = await fixture(t)
  await fs.writeFile(path.join(f.source, 'desktop-managed.json'), '{"schema_version":1,"install_kind":"desktop","admin_listen_host":"127.0.0.1"}')
  await copyDesktopData(f.source, f.target)
  await assert.rejects(fs.stat(path.join(f.target, 'desktop-managed.json')), { code: 'ENOENT' })
  await fs.stat(path.join(f.source, 'desktop-managed.json'))
})

test('ordinary files use the direct copy path and retain their source mode', async t => {
  const f = await fixture(t), file = path.join(f.source, 'agent/history.json')
  await fs.chmod(file, 0o440)
  t.mock.method(fs, 'cp', () => assert.fail('An already classified regular file does not need recursive cp checks'))
  const result = await copyDesktopData(f.source, f.target)
  assert.equal(result.files, 1)
  assert.equal(await fs.readFile(path.join(f.target, 'agent/history.json'), 'utf8'), '{"original":true}')
  assert.equal((await fs.stat(path.join(f.target, 'agent/history.json'))).mode & 0o777, (await fs.stat(file)).mode & 0o777)
})

test('ordinary-file fast copy never overwrites a destination created before its write', async t => {
  const f = await fixture(t), original = fs.copyFile
  if (process.platform === 'win32') t.mock.method(identity, 'isPrivateFile', () => false)
  t.mock.method(fs, 'copyFile', async (source, target, mode) => {
    await fs.writeFile(target, 'another file', { flag: 'wx' })
    return original(source, target, mode)
  })
  await assert.rejects(copyDesktopData(f.source, f.target), { code: 'EEXIST' })
  assert.equal(await fs.readFile(path.join(f.target, 'agent/history.json'), 'utf8'), 'another file')
  assert.equal(await fs.readFile(path.join(f.source, 'agent/history.json'), 'utf8'), '{"original":true}')
})

test('copy progress is coalesced while always publishing the final completed totals', async t => {
  const f = await fixture(t), updates = []
  for (let index = 0; index < 32; index++) await fs.writeFile(path.join(f.source, 'agent', String(index)), 'extra')
  t.mock.method(performance, 'now', () => 0)
  const result = await copyDesktopData(f.source, f.target, { progress: value => updates.push(value) })
  assert.equal(result.files, 33)
  assert.equal(result.bytes, Buffer.byteLength('{"original":true}') + 32 * 5)
  assert.equal(updates.length, 2, 'A burst needs its first progress event and exact final totals, not one IPC per file')
  assert.equal(updates[0].files, 1)
  assert.deepEqual(updates[1], { phase: 'copying', ...result })
  for (let index = 0; index < 32; index++) assert.equal(await fs.readFile(path.join(f.target, 'agent', String(index)), 'utf8'), 'extra')
})

for (const abort of [false, true]) test(`bounded copying drains in-flight writes before ${abort ? 'cancellation' : 'failure'} releases either lifecycle lock`, async t => {
  const f = await fixture(t), { acquireExistingCliLock, releaseCliLock } = await import('../cli-lock.mjs')
  for (let index = 0; index < 24; index++) {
    const directory = path.join(f.source, 'agent', 'nested-' + index)
    await fs.mkdir(directory); await fs.writeFile(path.join(directory, 'content'), 'retained ' + index)
  }
  const controller = new AbortController(), original = fs.copyFile
  let release, failFirst, active = 0, maximum = 0, started = 0, settled = false
  const writes = new Promise(resolve => { release = resolve }), failure = new Promise((_resolve, reject) => { failFirst = reject })
  void failure.catch(() => {})
  t.mock.method(fs, 'copyFile', async (source, target, mode) => {
    started++; active++; maximum = Math.max(maximum, active)
    try {
      if (!abort && started === 1) await failure
      else await writes
      return await original(source, target, mode)
    } finally { active-- }
  })
  const outcome = importDesktopData({ source: { dataRoot: f.source }, root: f.code, target: f.target,
    signal: controller.signal, stop: async () => {}, migrate: async () => assert.fail('Unfinished copying must never begin migration') })
    .then(value => { settled = true; return { value } }, error => { settled = true; return { error } })
  try {
    const deadline = Date.now() + 3000
    while (active < 8 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5))
    assert.equal(active, 8, 'Different directories share a bounded pool instead of serializing every file')
    if (abort) controller.abort()
    else failFirst(Object.assign(new Error('copy fixture failed'), { code: 'EIO' }))
    await new Promise(resolve => setTimeout(resolve, 25))
    assert.equal(settled, false, 'The caller must wait for all outstanding filesystem operations')
    assert.equal(started, 8, 'No new file starts after a failure or cancellation')
    assert.equal(maximum, 8, 'Nested directories must not multiply the global concurrency limit')
    await assert.rejects(acquireExistingCliLock(f.source, 'competing-start', 0), /another crabot CLI operation/)
    await assert.rejects(acquireExistingCliLock(f.target, 'competing-start', 0), /another crabot CLI operation/)
  } finally {
    if (!abort) failFirst(Object.assign(new Error('copy fixture failed'), { code: 'EIO' }))
    release()
    await outcome
  }
  const result = await outcome
  assert.match(result.error.message, abort ? /abort/i : /copy fixture failed/)
  assert.equal(active, 0)
  for (const data of [f.source, f.target]) { const lock = await acquireExistingCliLock(data, 'retry', 0); releaseCliLock(lock) }
  await assert.rejects(fs.stat(path.join(f.target, 'desktop-managed.json')), { code: 'ENOENT' })
  assert.equal(await fs.readFile(path.join(f.source, 'agent/history.json'), 'utf8'), '{"original":true}')
})

test('parallel file copying still preserves literal symbolic links without copying their targets', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t)
  await fs.symlink('history.json', path.join(f.source, 'agent/history-link'))
  const result = await copyDesktopData(f.source, f.target)
  assert.equal(result.files, 1)
  assert.equal(await fs.readlink(path.join(f.target, 'agent/history-link')), 'history.json')
  assert.equal(await fs.readFile(path.join(f.target, 'agent/history-link'), 'utf8'), '{"original":true}')
})

test('read-only directory modes are applied only after all child file writes finish', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t), source = path.join(f.source, 'agent'), target = path.join(f.target, 'agent')
  for (let index = 0; index < 7; index++) await fs.writeFile(path.join(source, String(index)), 'child')
  await fs.chmod(source, 0o500)
  const original = fs.copyFile
  let release, active = 0
  const writes = new Promise(resolve => { release = resolve })
  t.mock.method(fs, 'copyFile', async (...args) => { active++; try { await writes; return await original(...args) } finally { active-- } })
  const copying = copyDesktopData(f.source, f.target)
  try {
    const deadline = Date.now() + 3000
    while (active < 8 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5))
    assert.equal(active, 8)
    assert.notEqual((await fs.stat(target)).mode & 0o200, 0, 'The target must remain writable until its in-flight children complete')
    release()
    assert.equal((await copying).files, 8)
    assert.equal((await fs.stat(target)).mode & 0o777, 0o500)
  } finally {
    release(); await copying.catch(() => {})
    await fs.chmod(source, 0o700)
    await fs.chmod(target, 0o700).catch(error => { if (error.code !== 'ENOENT') throw error })
  }
})
