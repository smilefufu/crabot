import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { createInstanceRuntime, identity } from '../../scripts/lib/instance-runtime.mjs'
import { collectPairedUpdateTargetEvidence } from './paired-update-target-evidence.mjs'
async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'crabot-target-evidence-')))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const dataDir = path.join(root, 'data'), targetRoot = path.join(root, 'core')
  await fs.mkdir(dataDir); await fs.mkdir(targetRoot); await fs.mkdir(path.join(dataDir, 'logs'))
  return { root, dataDir, targetRoot }
}
test('absent target records are distinguished from a live starting controller without exposing identity', async t => {
  const f = await fixture(t)
  const empty = await collectPairedUpdateTargetEvidence(f)
  assert.equal(empty.runtime.state, 'stopped'); assert.equal(empty.runtime.status, 'absent')
  createInstanceRuntime({ dataDir: f.dataDir, root: f.targetRoot, mmPort: 19000 })
  const starting = await collectPairedUpdateTargetEvidence(f)
  assert.deepEqual(starting.runtime, { status: 'readable', state: 'starting', target_core_matches: true, controller_alive: true, mm_alive: false })
  assert.equal(JSON.stringify(starting).includes(f.root), false)
  assert.equal(starting.maintenance.status, 'absent')
})
test('malformed and oversized records remain unreadable rather than becoming a stopped instance', async t => {
  const f = await fixture(t)
  await fs.writeFile(path.join(f.dataDir, 'instance-runtime.json'), 'not json')
  await fs.writeFile(path.join(f.dataDir, 'desktop-maintenance.json'), 'x'.repeat(65537))
  const result = await collectPairedUpdateTargetEvidence(f)
  assert.deepEqual(result.runtime, { status: 'unreadable' }); assert.deepEqual(result.maintenance, { status: 'unreadable' })
})
test('fixed bounded log summaries retain failure signals and discard all raw text and secrets', async t => {
  const f = await fixture(t), secret = 'super-secret-provider-and-user-path'
  const file = path.join(f.dataDir, 'logs/mm.stderr.log')
  await fs.writeFile(file, 'EADDRINUSE' + 'x'.repeat(9000) + '\n' + secret + ' CRABOT_MAINTENANCE_PENDING ERR_MODULE_NOT_FOUND\n')
  const result = await collectPairedUpdateTargetEvidence({ ...f, handoffAt: Date.now() - 10000 })
  assert.deepEqual(result.logs['mm.stderr.log'], { status: 'readable', modified_after_handoff: true, codes: ['CRABOT_MAINTENANCE_PENDING'], module_not_found: true, address_in_use: false, permission_denied: false })
  assert.equal(JSON.stringify(result).includes(secret), false)
})
test('redirected and shared diagnostic files are rejected without reading their contents', async t => {
  const f = await fixture(t), file = path.join(f.root, 'private')
  await fs.writeFile(file, 'CRABOT_SHOULD_NOT_BE_READ')
  await fs.link(file, path.join(f.dataDir, 'logs/mm.stderr.log'))
  await fs.symlink(file, path.join(f.dataDir, 'desktop-maintenance.json'), process.platform === 'win32' ? 'file' : undefined)
  const result = await collectPairedUpdateTargetEvidence(f)
  assert.deepEqual(result.logs['mm.stderr.log'], { status: 'unreadable' })
  assert.deepEqual(result.maintenance, { status: 'unreadable' })
  assert.equal(JSON.stringify(result).includes('SHOULD_NOT_BE_READ'), false)
})

test('a valid maintenance phase is read through the product validator without exporting its private record', async t => {
  const f = await fixture(t)
  const record = { schema_version: 3, id: '11111111-1111-4111-8111-111111111111', data_dir: f.dataDir, install_root: f.targetRoot,
    source_version: '1.0.0', source_inventory_sha256: 'a'.repeat(64), target_version: '1.0.1', data_protection: 'scoped',
    phase: 'verifying', backup: null, target_core: { root: f.targetRoot, inventory_sha256: 'b'.repeat(64) } }
  const file = path.join(f.dataDir, 'desktop-maintenance.json'), text = JSON.stringify(record)
  if (process.platform === 'win32') identity.writePrivateFile(file, text)
  else await fs.writeFile(file, text, { mode: 0o600 })
  const result = await collectPairedUpdateTargetEvidence(f)
  assert.deepEqual(result.maintenance, { status: 'readable', schema_version: 3, phase: 'verifying', target_core_matches: true })
  assert.equal(JSON.stringify(result).includes(record.id), false)
})
