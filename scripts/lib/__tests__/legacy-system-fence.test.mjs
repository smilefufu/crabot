import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { materializeLegacyRelease } from './fixtures/legacy-release.mjs'
import { discoverLegacySystemRelease } from '../legacy-system-release.mjs'
import { LegacySystemEntryFence } from '../legacy-system-fence.mjs'
const options = { skip: process.platform === 'win32' }
async function fixture(t, version = 'v2026.10.15.1') {
  const parent = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'crabot-shared-entry-fence-')))
  t.after(() => fs.rm(parent, { recursive: true, force: true }))
  const root = path.join(parent, 'shared'), base = path.join(root, 'old-python-base'), employee = path.join(parent, 'employee')
  await fs.mkdir(root); const originals = await materializeLegacyRelease(root, version)
  await fs.mkdir(base); await fs.writeFile(path.join(base, 'keep'), 'old venv absolute base must stay')
  await fs.mkdir(employee); await fs.writeFile(path.join(employee, 'private-business'), 'must not read or change')
  const policy = { ownerUid: process.getuid(), checkRoot: () => {} }
  const installation = await discoverLegacySystemRelease({ root, platform: 'linux', ...policy })
  const fence = new LegacySystemEntryFence(policy), operation = randomUUID()
  return { root, base, employee, originals, installation, fence, operation }
}
for (const version of ['v2026.10.14.1', 'v2026.10.15.1']) test('shared entries fence and restore only known code, preserving Python bases: ' + version, options, async t => {
  const f = await fixture(t, version), mask = process.umask(0o077), read = fs.readFile
  const guard = t.mock.method(fs, 'readFile', (file, ...args) => {
    if (typeof file === 'string' && file.startsWith(f.employee + path.sep)) assert.fail('shared code fencing must not read employee files')
    return read(file, ...args)
  })
  let record
  try { record = await f.fence.fence(f.installation, f.operation) } finally { process.umask(mask) }
  assert.equal(record.phase, 'fenced'); assert.equal(record.operation_id, f.operation)
  assert.equal(record.installation.dataRoot, undefined); assert.equal((await f.fence.inspect(f.root)).entries_fenced, true)
  const same = await f.fence.fence({ code_fingerprint: f.installation.code_fingerprint, installRoot: f.root, version }, f.operation)
  assert.equal(same.id, record.id, 'same operation retry must not create another takeover')
  await assert.rejects(promisify(execFile)(process.execPath, [path.join(f.root, 'cli.mjs'), 'start']), error => /CRABOT_LEGACY_SYSTEM_ENTRY_FENCE/.test(error.stderr))
  await assert.rejects(f.fence.restore(f.root, record.id, randomUUID()))
  await f.fence.restore(f.root, record.id, f.operation)
  assert.equal((await fs.stat(path.join(f.root, 'cli.mjs'))).mode & 0o777, 0o755)
  for (const [name, bytes] of Object.entries(f.originals)) assert.deepEqual(await fs.readFile(path.join(f.root, name)), bytes)
  assert.equal(await fs.readFile(path.join(f.base, 'keep'), 'utf8'), 'old venv absolute base must stay')
  guard.mock.restore()
  assert.equal(await fs.readFile(path.join(f.employee, 'private-business'), 'utf8'), 'must not read or change')
})
for (const stage of ['fencing', 'restoring']) test('same-operation shared file interruption can be reconciled: ' + stage, options, async t => {
  const f = await fixture(t), rename = fs.rename
  let record
  if (stage === 'restoring') record = await f.fence.fence(f.installation, f.operation)
  let failed = false
  const patch = t.mock.method(fs, 'rename', async (from, to) => {
    if (!failed && to === path.join(f.root, 'scripts/start.mjs')) { failed = true; throw Object.assign(new Error('controlled code-file publication failure'), { code: 'EIO' }) }
    return rename(from, to)
  })
  if (stage === 'fencing') await assert.rejects(f.fence.fence(f.installation, f.operation), { code: 'EIO' })
  else await assert.rejects(f.fence.restore(f.root, record.id, f.operation), { code: 'EIO' })
  patch.mock.restore(); assert.equal(failed, true)
  const observed = await f.fence.inspect(f.root)
  assert.equal(observed.phase, stage)
  if (stage === 'fencing') {
    await assert.rejects(f.fence.fence(f.installation, randomUUID()))
    record = await f.fence.fence(f.installation, f.operation)
    assert.equal(record.id, observed.id)
  }
  await f.fence.restore(f.root, observed.id, f.operation)
  for (const [name, bytes] of Object.entries(f.originals)) assert.deepEqual(await fs.readFile(path.join(f.root, name)), bytes)
})
test('unknown edits and source markers refuse restoration before overwriting another shared entry', options, async t => {
  const f = await fixture(t), record = await f.fence.fence(f.installation, f.operation), cli = await fs.readFile(path.join(f.root, 'cli.mjs'))
  await fs.appendFile(path.join(f.root, 'scripts/start.mjs'), '\n// preserve administrator changes\n')
  await assert.rejects(f.fence.restore(f.root, record.id, f.operation))
  assert.deepEqual(await fs.readFile(path.join(f.root, 'cli.mjs')), cli)
  assert.match(await fs.readFile(path.join(f.root, 'scripts/start.mjs'), 'utf8'), /preserve administrator/)
  await fs.mkdir(path.join(f.root, '.git')); await fs.writeFile(path.join(f.root, '.git/local-wip'), 'keep')
  await assert.rejects(f.fence.inspect(f.root)); assert.equal(await fs.readFile(path.join(f.root, '.git/local-wip'), 'utf8'), 'keep')
})
test('data-change sealing permanently refuses old-entry restoration or another conversion', options, async t => {
  const f = await fixture(t), record = await f.fence.fence(f.installation, f.operation)
  await f.fence.seal(f.root, record.id, f.operation)
  await assert.rejects(f.fence.restore(f.root, record.id, f.operation))
  await assert.rejects(f.fence.fence(f.installation, f.operation))
  assert.equal((await f.fence.inspect(f.root)).phase, 'data_changing')
  assert.equal((await f.fence.inspect(f.root)).entries_fenced, true)
})
test('the production fence cannot mutate through an ordinary user fixture', { skip: process.platform === 'win32' || process.getuid() === 0 }, async t => {
  const f = await fixture(t)
  await assert.rejects(new LegacySystemEntryFence().fence(f.installation, f.operation), { code: 'CRABOT_SYSTEM_ADMIN_REQUIRED' })
  await assert.rejects(fs.lstat(path.join(f.root, '.system-takeover')), { code: 'ENOENT' })
})


test('a cancelled code-only transaction can accept a freshly verified later standard release', options, async t => {
  const f = await fixture(t, 'v2026.10.14.1'), old = await f.fence.fence(f.installation, f.operation)
  await f.fence.restore(f.root, old.id, f.operation)
  await materializeLegacyRelease(f.root, 'v2026.10.15.1')
  await assert.rejects(f.fence.fence(f.installation, randomUUID()), 'the old preflight snapshot is stale')
  const current = await discoverLegacySystemRelease({ root: f.root, platform: 'linux', ownerUid: process.getuid(), checkRoot: () => {} })
  const operation = randomUUID(), next = await f.fence.fence(current, operation)
  assert.notEqual(next.id, old.id); assert.equal(next.installation.version, 'v2026.10.15.1')
  await f.fence.restore(f.root, next.id, operation)
})
