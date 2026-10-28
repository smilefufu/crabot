import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { materializeLegacyRelease } from './fixtures/legacy-release.mjs'
import { discoverLegacyUserInstall } from '../legacy-desktop.mjs'
import { fenceLegacyEntries, inspectLegacyEntryFence, restoreLegacyEntries, sealLegacyEntryFence } from '../legacy-entry-fence.mjs'
import { entryFenceBytes } from '../legacy-entry-files.mjs'

async function fixture(t, version) {
  const parent = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'Crabot 旧入口 ')))
  t.after(() => fs.rm(parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))
  const root = path.join(parent, '旧安装'), dataDir = path.join(parent, '数据')
  await fs.mkdir(root); await fs.mkdir(dataDir); await fs.writeFile(path.join(dataDir, 'keep'), 'business-data')
  const originals = await materializeLegacyRelease(root, version)
  const installation = await discoverLegacyUserInstall({ root, dataDir })
  return { root, dataDir, originals, installation, journal: path.join(root, '.desktop-takeover/transaction.json') }
}
async function unchanged(f) {
  assert.equal(await fs.readFile(path.join(f.dataDir, 'keep'), 'utf8'), 'business-data')
  assert.deepEqual(await fs.readdir(f.dataDir), ['keep'])
}
async function restored(f) {
  for (const [name, bytes] of Object.entries(f.originals)) assert.deepEqual(await fs.readFile(path.join(f.root, name)), bytes)
  if (process.platform !== 'win32') assert.equal((await fs.stat(path.join(f.root, 'cli.mjs'))).mode & 0o777, 0o755)
  assert.equal((await discoverLegacyUserInstall({ root: f.root, dataDir: f.dataDir })).fingerprint, f.installation.fingerprint)
  await unchanged(f)
}

for (const version of ['v2026.10.14.1', 'v2026.10.15.1']) test('recognized entry fencing is reversible before data changes: ' + version, async t => {
  const f = await fixture(t, version), record = await fenceLegacyEntries(f.installation)
  assert.equal(record.phase, 'fenced')
  assert.equal((await inspectLegacyEntryFence(f.root)).id, record.id)
  assert.deepEqual(await fs.readFile(path.join(f.root, 'cli.mjs')), entryFenceBytes('cli.mjs'))
  await assert.rejects(promisify(execFile)(process.execPath, [path.join(f.root, 'cli.mjs'), 'start']), error => {
    assert.match(error.stderr, /CRABOT_LEGACY_ENTRY_FENCE/); return true
  })
  await unchanged(f)
  assert.equal((await restoreLegacyEntries(f.root)).phase, 'restored')
  await restored(f)
  assert.notEqual((await fenceLegacyEntries(f.installation)).id, record.id)
  await restoreLegacyEntries(f.root); await restored(f)
})

for (const stage of ['fencing', 'restoring']) test('an interrupted ' + stage + ' retains durable originals and releases its lock', async t => {
  const f = await fixture(t), rename = fs.rename
  if (stage === 'restoring') await fenceLegacyEntries(f.installation)
  let injected = false
  fs.rename = async (from, to) => {
    if (!injected && to === path.join(f.root, 'scripts/start.mjs')) {
      injected = true; throw Object.assign(new Error('Injected interrupted entry replacement'), { code: 'EIO' })
    }
    return rename(from, to)
  }
  try {
    await assert.rejects(stage === 'fencing' ? fenceLegacyEntries(f.installation) : restoreLegacyEntries(f.root), { code: 'EIO' })
  } finally { fs.rename = rename }
  assert.equal(injected, true)
  assert.equal((await inspectLegacyEntryFence(f.root)).phase, stage)
  await restoreLegacyEntries(f.root); await restored(f)
})

test('a user edit blocks the whole restore before another entry is overwritten', async t => {
  const f = await fixture(t); await fenceLegacyEntries(f.installation)
  const cli = await fs.readFile(path.join(f.root, 'cli.mjs'))
  await fs.appendFile(path.join(f.root, 'scripts/start.mjs'), '\n// preserve user edit\n')
  await assert.rejects(restoreLegacyEntries(f.root), { code: 'CRABOT_LEGACY_ENTRY_FENCE' })
  assert.deepEqual(await fs.readFile(path.join(f.root, 'cli.mjs')), cli)
  assert.match(await fs.readFile(path.join(f.root, 'scripts/start.mjs'), 'utf8'), /preserve user edit/)
  await unchanged(f)
})

test('redirected entry parents are never followed during restore', async t => {
  const f = await fixture(t); await fenceLegacyEntries(f.installation)
  const external = path.join(f.root, 'external'); await fs.mkdir(external)
  const before = await fs.readFile(path.join(f.root, 'scripts/start.mjs'))
  for (const name of ['start.mjs', 'supervisor.mjs']) await fs.copyFile(path.join(f.root, 'scripts', name), path.join(external, name))
  await fs.rm(path.join(f.root, 'scripts'), { recursive: true })
  await fs.symlink(external, path.join(f.root, 'scripts'), process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(restoreLegacyEntries(f.root), { code: 'CRABOT_LEGACY_ENTRY_FENCE' })
  assert.deepEqual(await fs.readFile(path.join(external, 'start.mjs')), before)
  await unchanged(f)
})

test('modified retained code and sealed data-changing state cannot reopen an old core', async t => {
  const f = await fixture(t), record = await fenceLegacyEntries(f.installation)
  const text = await fs.readFile(f.journal, 'utf8'), value = JSON.parse(text)
  value.originals['cli.mjs'].bytes = Buffer.from('unrecognized old program').toString('base64')
  await fs.writeFile(f.journal, JSON.stringify(value))
  await assert.rejects(restoreLegacyEntries(f.root), { code: 'CRABOT_LEGACY_ENTRY_FENCE' })
  await fs.writeFile(f.journal, text)
  await assert.rejects(sealLegacyEntryFence(f.root, 'wrong-id'), { code: 'CRABOT_LEGACY_ENTRY_FENCE' })
  await sealLegacyEntryFence(f.root, record.id)
  assert.equal((await inspectLegacyEntryFence(f.root)).phase, 'data_changing')
  await assert.rejects(restoreLegacyEntries(f.root), { code: 'CRABOT_LEGACY_ENTRY_FENCE' })
  await unchanged(f)
})

test('an original entry is never replaced before its recovery record is durable', async t => {
  const f = await fixture(t), rename = fs.rename
  fs.rename = async (from, to) => {
    if (to === f.journal) throw Object.assign(new Error('Snapshot record could not publish'), { code: 'EIO' })
    return rename(from, to)
  }
  try { await assert.rejects(fenceLegacyEntries(f.installation), { code: 'EIO' }) }
  finally { fs.rename = rename }
  await restored(f)
  await assert.rejects(fs.stat(f.journal), { code: 'ENOENT' })
  assert.equal((await fenceLegacyEntries(f.installation)).phase, 'fenced')
})


test('strict umask does not change original entry permissions after a cancelled takeover', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t), entry = path.join(f.root, 'cli.mjs'), original = (await fs.stat(entry)).mode & 0o777
  const mask = process.umask(0o077)
  try { await fenceLegacyEntries(f.installation); await restoreLegacyEntries(f.root) }
  finally { process.umask(mask) }
  assert.equal((await fs.stat(entry)).mode & 0o777, original)
  await restored(f)
})

test('known CLI forwarding remains a reversible fence until the actual desktop handoff is healthy', async t => {
  const f = await fixture(t), record = await fenceLegacyEntries(f.installation)
  const { enableLegacyCliForwarding } = await import('../legacy-entry-fence.mjs')
  await assert.rejects(enableLegacyCliForwarding(f.root, 'wrong-id'))
  await enableLegacyCliForwarding(f.root, record.id)
  assert.equal((await inspectLegacyEntryFence(f.root)).entries_fenced, true)
  await assert.rejects(promisify(execFile)(process.execPath, [path.join(f.root, 'cli.mjs'), '--version']), error => {
    assert.match(error.stderr, /CRABOT_LEGACY_ENTRY_FENCE/); return true
  })
  await restoreLegacyEntries(f.root); await restored(f)
})

test('lost CLI forwarding publication accepts only the two known guards and can finish once', async t => {
  const f = await fixture(t), record = await fenceLegacyEntries(f.installation), rename = fs.rename
  const { enableLegacyCliForwarding } = await import('../legacy-entry-fence.mjs')
  const patch = t.mock.method(fs, 'rename', async (from, to) => {
    if (to === path.join(f.root, 'crabot.cmd')) throw Object.assign(new Error('controlled command publication failure'), { code: 'EIO' })
    return rename(from, to)
  })
  await assert.rejects(enableLegacyCliForwarding(f.root, record.id), { code: 'EIO' }); patch.mock.restore()
  assert.equal((await inspectLegacyEntryFence(f.root)).entries_fenced, true)
  await enableLegacyCliForwarding(f.root, record.id)
  const cli = await fs.readFile(path.join(f.root, 'cli.mjs'))
  await enableLegacyCliForwarding(f.root, record.id)
  assert.deepEqual(await fs.readFile(path.join(f.root, 'cli.mjs')), cli)
  await sealLegacyEntryFence(f.root, record.id)
  await assert.rejects(restoreLegacyEntries(f.root))
  await unchanged(f)
})

test('an edited CLI or original-entry state cannot be overwritten by forwarding', async t => {
  const f = await fixture(t), record = await fenceLegacyEntries(f.installation)
  const { enableLegacyCliForwarding } = await import('../legacy-entry-fence.mjs')
  const before = await fs.readFile(path.join(f.root, 'crabot.cmd'))
  await fs.appendFile(path.join(f.root, 'cli.mjs'), '// user change')
  await assert.rejects(enableLegacyCliForwarding(f.root, record.id))
  assert.deepEqual(await fs.readFile(path.join(f.root, 'crabot.cmd')), before)
})

test('an interrupted initial fence completes the same recorded entry set without changing data', async t => {
  const f = await fixture(t), rename = fs.rename
  const fault = t.mock.method(fs, 'rename', async (from, to) => {
    if (to === path.join(f.root, 'scripts/start.mjs')) throw Object.assign(new Error('controlled initial fence interruption'), { code: 'EIO' })
    return rename(from, to)
  })
  await assert.rejects(fenceLegacyEntries(f.installation), { code: 'EIO' }); fault.mock.restore()
  const partial = await inspectLegacyEntryFence(f.root), before = JSON.parse(await fs.readFile(f.journal, 'utf8'))
  assert.equal(partial.phase, 'fencing'); assert.equal(partial.entries_fenced, false)
  const { resumeLegacyEntryFence } = await import('../legacy-entry-fence.mjs')
  assert.equal(typeof resumeLegacyEntryFence, 'function')
  await assert.rejects(resumeLegacyEntryFence(f.root, '11111111-1111-4111-8111-111111111111'))
  const result = await resumeLegacyEntryFence(f.root, partial.id)
  assert.equal(result.id, partial.id); assert.equal(result.phase, 'fenced')
  assert.equal((await inspectLegacyEntryFence(f.root)).entries_fenced, true)
  assert.deepEqual(JSON.parse(await fs.readFile(f.journal, 'utf8')).originals, before.originals)
  await resumeLegacyEntryFence(f.root, partial.id)
  await unchanged(f); await restoreLegacyEntries(f.root); await restored(f)
})

for (const changed of ['edited-entry', 'data-maintenance', 'data-changing']) test('initial entry continuation cannot cross changed or data-maintenance state: ' + changed, async t => {
  const f = await fixture(t), entry = await fenceLegacyEntries(f.installation)
  if (changed === 'edited-entry') await fs.appendFile(path.join(f.root, 'scripts/start.mjs'), 'custom edit')
  if (changed === 'data-maintenance') await fs.writeFile(path.join(f.dataDir, 'desktop-maintenance.json'), '{}', { mode: 0o600 })
  if (changed === 'data-changing') await sealLegacyEntryFence(f.root, entry.id)
  const file = path.join(f.root, 'cli.mjs'), before = await fs.readFile(file), journal = await fs.readFile(f.journal)
  const { resumeLegacyEntryFence } = await import('../legacy-entry-fence.mjs')
  await assert.rejects(resumeLegacyEntryFence(f.root, entry.id), { code: 'CRABOT_LEGACY_ENTRY_FENCE' })
  assert.deepEqual(await fs.readFile(file), before); assert.deepEqual(await fs.readFile(f.journal), journal)
  assert.equal(await fs.readFile(path.join(f.dataDir, 'keep'), 'utf8'), 'business-data')
})
