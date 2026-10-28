import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { createHash, randomUUID } from 'node:crypto'
import management from '../desktop-management.cjs'
import identity from '../process-identity.cjs'
import selection from '../agent-python-selection.cjs'
import python from '../product-python-env.cjs'
function fixture(t) {
  const parent = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'Crabot Python 选择 ')))
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }))
  const data = management.ensurePrivateDataRoot(path.join(parent, 'data')), id = randomUUID()
  const container = management.ensurePrivateDataRoot(path.join(data, 'agent-environments'))
  const directory = management.ensurePrivateDataRoot(path.join(container, id))
  function write(file, value) {
    const bytes = typeof value === 'string' ? value : JSON.stringify(value) + '\n'
    if (process.platform === 'win32' && !fs.existsSync(file)) identity.writePrivateFile(file, bytes)
    else fs.writeFileSync(file, bytes, { mode: 0o600 })
    return createHash('sha256').update(bytes).digest('hex')
  }
  const receipt = path.join(directory, 'legacy-rebuild.json')
  const hash = write(receipt, { schema_version: 1, kind: 'legacy-python-rebuild', id, source_fingerprint: 'a'.repeat(64), python_version: '3.12.12', pins: [] })
  write(path.join(directory, '.crabot-runtime.json'), { schema_version: 1, base_id: 'b'.repeat(24), python_version: '3.12.12' })
  const record = { schema_version: 1, id, directory: 'agent-environments/' + id, receipt_sha256: hash, source_fingerprint: 'a'.repeat(64) }
  const file = path.join(data, selection.selectionName)
  return { data, directory, record, receipt, file, write, publish: patch => write(file, { ...record, ...patch }) }
}
test('only a private completed reference selects the fixed environment; absence does not create state', t => {
  const f = fixture(t)
  assert.equal(selection.readAgentEnvironmentSelection(f.data), null); assert.equal(fs.existsSync(f.file), false)
  f.publish()
  const result = selection.readAgentEnvironmentSelection(f.data)
  assert.equal(result.directory, f.directory); assert.deepEqual(result.record, f.record)
  assert.deepEqual(selection.readAgentEnvironmentReference(f.data), f.record)
})
test('references cannot escape, change receipt identity, or silently fall back on missing targets', t => {
  const f = fixture(t)
  for (const patch of [{ directory: '../outside' }, { id: '--custom' }, { schema_version: 2 }, { extra: 'ignored?' }, { receipt_sha256: 'c'.repeat(64) }, { source_fingerprint: 'd'.repeat(64) }]) {
    f.publish(patch); assert.throws(() => selection.readAgentEnvironmentSelection(f.data), { code: 'CRABOT_PYTHON_ENV_SELECTION_INVALID' })
  }
  f.publish(); fs.rmSync(f.directory, { recursive: true })
  assert.throws(() => python.ensureProductAgentVenv({}, f.data, () => assert.fail('no alternate interpreter may run')), { code: 'CRABOT_PYTHON_ENV_SELECTION_INVALID' })
  assert.equal(fs.existsSync(f.directory), false); assert.equal(fs.existsSync(path.join(f.data, 'agent-venv')), false)
  assert.deepEqual(selection.readAgentEnvironmentReference(f.data), f.record, 'exact cancellation can still identify a damaged target reference')
})
test('damaged/incomplete completion markers and writable reference files stay blocked', t => {
  const f = fixture(t); f.publish()
  f.write(f.receipt, '{"private":"broken JSON"')
  assert.throws(() => selection.readAgentEnvironmentSelection(f.data), error => !error.message.includes('broken JSON'))
  f.write(f.file, ' '.repeat(65537)); assert.throws(() => selection.readAgentEnvironmentSelection(f.data))
  if (process.platform !== 'win32') {
    f.publish(); fs.chmodSync(f.file, 0o644)
    assert.throws(() => selection.readAgentEnvironmentSelection(f.data), { code: 'CRABOT_PYTHON_ENV_SELECTION_INVALID' })
  }
})
test('redirected environment roots and hardlinked control files are rejected', t => {
  const f = fixture(t); f.publish()
  fs.linkSync(f.file, f.file + '.alias'); assert.throws(() => selection.readAgentEnvironmentSelection(f.data)); fs.unlinkSync(f.file + '.alias')
  const retained = f.directory + '-retained'; fs.renameSync(f.directory, retained)
  fs.symlinkSync(retained, f.directory, process.platform === 'win32' ? 'junction' : 'dir')
  assert.throws(() => selection.readAgentEnvironmentSelection(f.data), { code: 'CRABOT_PYTHON_ENV_SELECTION_INVALID' })
  assert.equal(fs.existsSync(path.join(retained, 'legacy-rebuild.json')), true)
})
