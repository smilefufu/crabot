import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import management from '../desktop-management.cjs'
import { acquireCliLock, releaseCliLock } from '../cli-lock.mjs'
import { prepareWorkspaceLegacyExecutions, previewWorkspaceLegacyExecutions } from '../workspace-legacy-executions.mjs'
import records from '../workspace-legacy-record.cjs'
const home = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..'), require = createRequire(import.meta.url)
const { LedgerStore, managerKeyToFilename } = require(path.join(home, 'crabot-agent/dist/workers/harness/ledger-store.js'))
const { createLegacyWorkspaceExecutionMatcher } = require(path.join(home, 'crabot-agent/dist/workers/harness/workspace-legacy-executions.js'))
const at = '2026-10-19T00:00:00.000Z', end = '2026-10-19T00:01:00.000Z', manager = 'channel::session'
async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'legacy-execution-中文 space-')))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const data = management.ensurePrivateDataRoot(path.join(root, 'data')), dir = path.join(data, 'agent/worker-ledgers')
  await fs.mkdir(dir, { recursive: true })
  const worker = { worker_id: 'old', manager_key: manager, task: { id: 'old-task', title: 'PRIVATE BODY', status: 'halted', created_at: at, halt: { halted_at: end, halt_reason: 'turn_end' } },
    origin: { trigger_type: 'message' }, report_to: { channel_id: 'channel', session_id: 'session' }, updated_at: end,
    incarnations: [{ impl: 'codex', seq: 1, state: 'exited', workspace: path.join(root, 'project'), session_ref: 'PRIVATE SESSION', started_at: at, ended_at: end, ended_reason: 'completed' }] }
  const file = path.join(dir, managerKeyToFilename(manager)), save = () => fs.writeFile(file, JSON.stringify({ manager_key: manager, workers: [worker] }))
  await save()
  const control = path.join(data, 'workspace-control'), boundary = path.join(control, 'legacy-executions.json'), ready = path.join(control, 'legacy-executions.ready')
  return { root, data, dir, worker, file, save, control, boundary, ready }
}
for (const ending of ['\n', '\r\n']) test('capability text accepts the checkout line ending: ' + JSON.stringify(ending), async t => {
  const f = await fixture(t), target = path.join(f.root, 'target')
  await fs.mkdir(path.join(target, 'crabot-agent'), { recursive: true })
  await fs.writeFile(path.join(target, 'crabot-agent/workspace-legacy-execution-version'), '1' + ending)
  assert.deepEqual(await previewWorkspaceLegacyExecutions(target, f.data), { status: 'pending' })
  await assert.rejects(fs.stat(f.control), { code: 'ENOENT' })
})
for (const content of ['1', '1 \n', ' 1\n', '\ufeff1\n', '2\n', '1\n\n', '1\r\r\n', '1\0\n']) test('malformed capability text remains rejected: ' + JSON.stringify(content), async t => {
  const f = await fixture(t), target = path.join(f.root, 'target')
  await fs.mkdir(path.join(target, 'crabot-agent'), { recursive: true })
  await fs.writeFile(path.join(target, 'crabot-agent/workspace-legacy-execution-version'), content)
  await assert.rejects(previewWorkspaceLegacyExecutions(target, f.data), { code: 'WORKSPACE_MAINTENANCE' })
  await assert.rejects(fs.stat(f.control), { code: 'ENOENT' })
})
test('stopped common upgrade fixes old deterministic identities, leaves original ledgers byte-for-byte and never widens on repeat', async t => {
  const f = await fixture(t), original = await fs.readFile(f.file), lock = await acquireCliLock(f.data, 'test')
  try {
    assert.equal((await previewWorkspaceLegacyExecutions(home, f.data)).status, 'pending')
    assert.equal((await prepareWorkspaceLegacyExecutions(home, f.data, { lockHeld: true })).status, 'ready')
    assert.deepEqual(await fs.readFile(f.file), original)
    const first = records.readWorkspaceLegacyExecutions(f.data), bytes = await fs.readFile(f.boundary)
    assert.equal(first.status, 'ready'); assert.equal(first.value.entries.length, 1)
    assert.doesNotMatch(JSON.stringify(first.value), /PRIVATE|project|task/)
    const ledger = new LedgerStore(f.dir), old = (await ledger.listAllWorkers())[0]
    const matches = createLegacyWorkspaceExecutionMatcher(first.value)
    assert.equal(matches(old.managerKey, old.worker, old.worker.incarnations[0].incarnation_id), true)
    f.worker.incarnations.push({ ...f.worker.incarnations[0], seq: 2, ended_reason: undefined, ended_at: undefined, state: 'idle' }); await f.save()
    assert.equal((await prepareWorkspaceLegacyExecutions(home, f.data, { lockHeld: true })).status, 'ready')
    assert.deepEqual(await fs.readFile(f.boundary), bytes)
    const changed = (await new LedgerStore(f.dir).listAllWorkers())[0]
    assert.equal(matches(changed.managerKey, changed.worker, changed.worker.incarnations[1].incarnation_id), false)
  } finally { releaseCliLock(lock) }
})
test('prepare refuses a claimed but unheld lock and a live runtime before publishing anything', async t => {
  const f = await fixture(t)
  await assert.rejects(prepareWorkspaceLegacyExecutions(home, f.data, { lockHeld: true }))
  await fs.writeFile(path.join(f.data, 'mm.pid'), String(process.pid))
  const lock = await acquireCliLock(f.data, 'test')
  try { await assert.rejects(prepareWorkspaceLegacyExecutions(home, f.data, { lockHeld: true })) } finally { releaseCliLock(lock) }
  await assert.rejects(fs.stat(f.boundary), { code: 'ENOENT' })
})
test('a lost ready publication completes only the first boundary even if later ledgers change', async t => {
  const f = await fixture(t)
  await prepareWorkspaceLegacyExecutions(home, f.data)
  const original = await fs.readFile(f.boundary)
  await fs.rm(f.ready)
  f.worker.incarnations.push({ ...f.worker.incarnations[0], seq: 2 }); await f.save()
  assert.equal(records.readWorkspaceLegacyExecutions(f.data).status, 'prepared')
  assert.equal((await prepareWorkspaceLegacyExecutions(home, f.data)).status, 'ready')
  assert.deepEqual(await fs.readFile(f.boundary), original)
})
for (const damage of ['missing boundary', 'bad digest', 'bad JSON', 'hardlink', 'directory link']) test('damaged first boundary is preserved and never reselected: ' + damage, async t => {
  const f = await fixture(t); await prepareWorkspaceLegacyExecutions(home, f.data)
  if (damage === 'missing boundary') await fs.rm(f.boundary)
  if (damage === 'bad digest') await fs.writeFile(f.boundary, '{}\n')
  if (damage === 'bad JSON') await fs.writeFile(f.ready, '{bad')
  if (damage === 'hardlink') await fs.link(f.boundary, path.join(f.root, 'outside-link'))
  if (damage === 'directory link') { await fs.rename(f.control, f.control + '-original'); await fs.symlink(f.control + '-original', f.control, process.platform === 'win32' ? 'junction' : 'dir') }
  await assert.rejects(prepareWorkspaceLegacyExecutions(home, f.data))
  assert.deepEqual(await fs.readFile(f.file, 'utf8'), JSON.stringify({ manager_key: manager, workers: [f.worker] }))
})
test('a target without capability is a read-only no-op and no old storage tree is scanned', async t => {
  const f = await fixture(t), target = path.join(f.root, 'old-target'); await fs.mkdir(target)
  await fs.writeFile(f.file, 'invalid old ledger')
  assert.equal((await prepareWorkspaceLegacyExecutions(target, f.data)).status, 'not_applicable')
  await assert.rejects(fs.stat(f.control), { code: 'ENOENT' })
})
test('losing the real lifecycle lock while building the new output cannot publish a boundary', async t => {
  const f = await fixture(t), syncFs = require('node:fs'), originalWrite = syncFs.writeFileSync, lock = await acquireCliLock(f.data, 'test')
  let lost = false
  syncFs.writeFileSync = function(file, ...args) {
    const result = originalWrite.call(this, file, ...args)
    if (typeof file === 'string' && path.basename(file).startsWith('.legacy-executions-')) { releaseCliLock(lock); lost = true }
    return result
  }
  try { await assert.rejects(prepareWorkspaceLegacyExecutions(home, f.data, { lockHeld: true })) }
  finally { syncFs.writeFileSync = originalWrite; releaseCliLock(lock) }
  assert.equal(lost, true); await assert.rejects(fs.stat(f.boundary), { code: 'ENOENT' })
  assert.deepEqual(await fs.readdir(f.control), [])
})
test('a ledger changed after capture is not silently made into an upgrade boundary', async t => {
  const f = await fixture(t), syncFs = require('node:fs'), originalWrite = syncFs.writeFileSync
  let changed = false
  syncFs.writeFileSync = function(file, ...args) {
    const result = originalWrite.call(this, file, ...args)
    if (typeof file === 'string' && path.basename(file).startsWith('.legacy-executions-')) {
      originalWrite(f.file, JSON.stringify({ manager_key: manager, workers: [] })); changed = true
    }
    return result
  }
  try { await assert.rejects(prepareWorkspaceLegacyExecutions(home, f.data)) } finally { syncFs.writeFileSync = originalWrite }
  assert.equal(changed, true); await assert.rejects(fs.stat(f.boundary), { code: 'ENOENT' })
})
test('a reply lost after actual first publication retains that first boundary on retry', async t => {
  const f = await fixture(t), syncFs = require('node:fs'), originalLink = syncFs.linkSync
  let published = false
  syncFs.linkSync = function(source, target, ...args) {
    const result = originalLink.call(this, source, target, ...args)
    if (target === f.boundary) { published = true; throw new Error('reply lost after physical publication') }
    return result
  }
  try { await assert.rejects(prepareWorkspaceLegacyExecutions(home, f.data)) } finally { syncFs.linkSync = originalLink }
  assert.equal(published, true)
  const first = await fs.readFile(f.boundary)
  f.worker.incarnations.push({ ...f.worker.incarnations[0], seq: 2 }); await f.save()
  assert.equal((await prepareWorkspaceLegacyExecutions(home, f.data)).status, 'ready')
  assert.deepEqual(await fs.readFile(f.boundary), first)
})
for (const damage of ['malformed ledger', 'unknown envelope', 'wrong owner key', 'file link', 'ledger directory link']) test('unverified source metadata is never skipped: ' + damage, async t => {
  const f = await fixture(t)
  if (damage === 'malformed ledger') await fs.writeFile(f.file, '{bad')
  if (damage === 'unknown envelope') await fs.writeFile(f.file, JSON.stringify({ schema_version: 2, ledger: { manager_key: manager, workers: [f.worker] } }))
  if (damage === 'wrong owner key') await fs.writeFile(f.file, JSON.stringify({ manager_key: 'other::session', workers: [f.worker] }))
  if (damage === 'file link') { await fs.rename(f.file, f.file + '.old'); await fs.symlink(f.file + '.old', f.file) }
  if (damage === 'ledger directory link') { await fs.rename(f.dir, f.dir + '.old'); await fs.symlink(f.dir + '.old', f.dir, process.platform === 'win32' ? 'junction' : 'dir') }
  await assert.rejects(prepareWorkspaceLegacyExecutions(home, f.data))
  await assert.rejects(fs.stat(f.boundary), { code: 'ENOENT' })
})
test('read-only preview never loads executable code from the target Core', async t => {
  const f = await fixture(t), target = path.join(f.root, 'preview-target'), marker = path.join(f.root, 'executed-target')
  const module = path.join(target, 'crabot-agent/dist/workers/harness')
  await fs.mkdir(module, { recursive: true })
  await fs.writeFile(path.join(target, 'crabot-agent/workspace-legacy-execution-version'), '1\n')
  await fs.writeFile(path.join(module, 'workspace-legacy-executions.js'), `require('node:fs').writeFileSync(${JSON.stringify(marker)},'executed');module.exports={}`)
  assert.equal((await previewWorkspaceLegacyExecutions(target, f.data)).status, 'pending')
  await assert.rejects(fs.stat(marker), { code: 'ENOENT' })
  await prepareWorkspaceLegacyExecutions(home, f.data)
  assert.equal((await previewWorkspaceLegacyExecutions(target, f.data)).status, 'ready')
  await assert.rejects(fs.stat(marker), { code: 'ENOENT' })
})
test('common stopped migration preparation fixes the boundary before its first successful return', async t => {
  const f = await fixture(t), { runMigrations } = await import('../../upgrade-lib/migrate.mjs')
  const result = await runMigrations(home, f.data, async () => { throw new Error('no module migration should run for empty Admin/Memory') }, { info() {}, warn() {}, error() {} })
  assert.equal(result.ok, true)
  const first = records.readWorkspaceLegacyExecutions(f.data)
  assert.equal(first?.status, 'ready'); assert.equal(first.value.entries.length, 1)
  const bytes = await fs.readFile(f.boundary)
  const ledger = new LedgerStore(f.dir), old = (await ledger.listAllWorkers())[0]
  assert.equal(createLegacyWorkspaceExecutionMatcher(first.value)(old.managerKey, old.worker, old.worker.incarnations[0].incarnation_id), true)
  assert.equal((await runMigrations(home, f.data, async () => { throw new Error('must not replay') }, { info() {}, warn() {}, error() {} })).ok, true)
  assert.deepEqual(await fs.readFile(f.boundary), bytes)
})
for (const damage of ['schema', 'date', 'duplicate', 'extra entry', 'extra header']) test('neutral preview rejects malformed original evidence even when its byte digest matches: ' + damage, async t => {
  const f = await fixture(t); await prepareWorkspaceLegacyExecutions(home, f.data)
  const body = JSON.parse(await fs.readFile(f.boundary, 'utf8'))
  if (damage === 'schema') body.schema_version = 2
  if (damage === 'date') body.captured_at = 'invalid'
  if (damage === 'duplicate') body.entries.push(body.entries[0])
  if (damage === 'extra entry') body.entries[0].allow_current = true
  if (damage === 'extra header') body.allow_all = true
  const bytes = JSON.stringify(body) + '\n'
  await fs.writeFile(f.boundary, bytes)
  await fs.writeFile(f.ready, JSON.stringify({ schema_version: 1, sha256: createHash('sha256').update(bytes).digest('hex') }))
  await assert.rejects(previewWorkspaceLegacyExecutions(home, f.data))
  await assert.rejects(prepareWorkspaceLegacyExecutions(home, f.data))
  assert.equal(await fs.readFile(f.boundary, 'utf8'), bytes)
})
test('corrupt existing legacy material rejects the entire common migration before any module script or schema write', async t => {
  const f = await fixture(t); await prepareWorkspaceLegacyExecutions(home, f.data)
  await fs.writeFile(f.boundary, '{invalid')
  const directory = path.join(f.data, 'memory'); await fs.mkdir(directory)
  await fs.writeFile(path.join(directory, 'SCHEMA_VERSION'), 'v4\n')
  const { runMigrations } = await import('../../upgrade-lib/migrate.mjs')
  let dispatched = false
  await assert.rejects(runMigrations(home, f.data, async () => { dispatched = true; return { exitCode: 0 } }, { info() {}, warn() {}, error() {} }))
  assert.equal(dispatched, false); assert.equal(await fs.readFile(path.join(directory, 'SCHEMA_VERSION'), 'utf8'), 'v4\n')
})
test('first-start fallback shares the real held-lock migration entry and fixed legacy boundary', async t => {
  const f = await fixture(t), { applyStartupMigrations } = await import('../core-preparation.mjs'), lock = await acquireCliLock(f.data, 'test-start')
  try {
    await applyStartupMigrations(home, f.data, { PATH: '' })
    const first = records.readWorkspaceLegacyExecutions(f.data)
    assert.equal(first?.status, 'ready'); assert.equal(first.value.entries.length, 1)
  } finally { releaseCliLock(lock) }
})
test('the original data root cannot be replaced while stopped-state inspection awaits filesystem reads', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t), syncFs = require('node:fs'), originalRead = fs.readFile, lock = await acquireCliLock(f.data, 'test-root')
  let replaced = false
  fs.readFile = async function(file, ...args) {
    if (file === path.join(f.data, 'mm.pid') && !replaced) {
      syncFs.renameSync(f.data, f.data + '-original'); syncFs.mkdirSync(f.data, { mode: 0o700 }); replaced = true
    }
    return originalRead.call(this, file, ...args)
  }
  try { await assert.rejects(prepareWorkspaceLegacyExecutions(home, f.data, { lockHeld: true })) }
  finally { fs.readFile = originalRead; releaseCliLock(lock) }
  assert.equal(replaced, true)
  await assert.rejects(fs.stat(f.boundary), { code: 'ENOENT' })
  assert.equal(await fs.readFile(path.join(f.data + '-original', 'agent/worker-ledgers', managerKeyToFilename(manager)), 'utf8'), JSON.stringify({ manager_key: manager, workers: [f.worker] }))
})
test('an existing owned CLI data directory keeps its original 0755 mode; only new control material is private', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t); await fs.chmod(f.data, 0o755)
  assert.equal((await prepareWorkspaceLegacyExecutions(home, f.data)).status, 'ready')
  assert.equal((await fs.stat(f.data)).mode & 0o777, 0o755)
  assert.equal((await fs.stat(f.control)).mode & 0o777, 0o700)
  assert.equal((await fs.stat(f.boundary)).mode & 0o777, 0o600)
})
