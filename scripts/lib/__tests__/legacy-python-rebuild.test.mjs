import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs, realpathSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { gunzipSync } from 'node:zlib'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { planLegacyPythonRebuild, prepareLegacyPythonRebuild } from '../legacy-python-rebuild.mjs'
import { inspectLegacyPythonEnvironment } from '../legacy-python.mjs'
import { createInstanceRuntime, clearInstanceRuntime } from '../instance-runtime.mjs'
import { acquireCliLock, releaseCliLock } from '../cli-lock.mjs'
import product from '../product-runtime.cjs'
import management from '../desktop-management.cjs'
import python from '../product-python-env.cjs'
import selection from '../agent-python-selection.cjs'
import { selectLegacyPythonRebuild, cancelLegacyPythonSelection } from '../legacy-python-selection.mjs'

const root = realpathSync(new URL('../../../', import.meta.url))
const require = createRequire(path.join(root, 'crabot-admin/package.json')), AdmZip = require('adm-zip'), execute = promisify(execFile)
const digest = bytes => createHash('sha256').update(bytes).digest('base64url')
const pkg = { name: 'crabot-migration-probe', version: '1.2.3', has_file_record: true, has_source_record: false,
  modified_files: 0, missing_files: 0, unverified_files: 0, references: 0 }
const observation = () => ({ status: 'observed', fingerprint: 'a'.repeat(64), packages: [{ ...pkg }],
  site_references: 0, special_site_files: 0, unrecorded_site_files: 0, unrecorded_files: [] })

test('rebuild planning refuses unknown sources, changed records, duplicate identities and unsafe requirement tokens', () => {
  assert.deepEqual(planLegacyPythonRebuild(observation()).pins, [{ name: pkg.name, version: pkg.version }])
  for (const patch of [{ has_source_record: true }, { modified_files: 1 }, { missing_files: 1 }, { unverified_files: 1 },
    { references: 1 }, { has_file_record: false }, { name: '--index-url' }, { version: '1.2.3\n--index-url=secret' }]) {
    const value = observation(); Object.assign(value.packages[0], patch)
    assert.throws(() => planLegacyPythonRebuild(value), { code: 'CRABOT_LEGACY_PYTHON_REBUILD_UNVERIFIED' })
  }
  const duplicate = observation(); duplicate.packages.push({ ...pkg, name: 'Crabot_Migration.Probe' })
  assert.throws(() => planLegacyPythonRebuild(duplicate))
  const extension = observation(); extension.unrecorded_site_files = 1
  extension.unrecorded_files = [{ path: 'user-extension.py', size: 1, sha256: 'b'.repeat(64) }]
  assert.throws(() => planLegacyPythonRebuild(extension))
})

async function fixture(t) {
  const parent = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'Crabot Python 重建 ')))
  let lock
  t.after(async () => { if (lock) releaseCliLock(lock); await fs.rm(parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) })
  const dataDir = management.ensurePrivateDataRoot(path.join(parent, 'private-data'))
  const legacy = path.join(dataDir, 'agent-venv')
  const site = path.join(legacy, process.platform === 'win32' ? 'Lib/site-packages' : 'lib/python3.11/site-packages')
  const info = 'crabot_migration_probe-1.2.3.dist-info/'
  await fs.mkdir(path.join(site, info), { recursive: true })
  await fs.writeFile(path.join(legacy, 'pyvenv.cfg'), 'version_info = 3.11.14\n')
  const code = 'raise RuntimeError("OLD_PACKAGE_MUST_NEVER_EXECUTE")\n'
  const metadata = 'Metadata-Version: 2.1\nName: crabot-migration-probe\nVersion: 1.2.3\n'
  await fs.writeFile(path.join(site, 'crabot_migration_probe.py'), code)
  await fs.writeFile(path.join(site, info, 'METADATA'), metadata)
  await fs.writeFile(path.join(site, info, 'RECORD'), `crabot_migration_probe.py,sha256=${digest(code)},${Buffer.byteLength(code)}\n${info}METADATA,sha256=${digest(metadata)},${Buffer.byteLength(metadata)}\n${info}RECORD,,\n`)
  const wheels = path.join(dataDir, 'offline-wheels'); await fs.mkdir(wheels)
  const archive = new AdmZip()
  const files = { 'crabot_migration_probe.py': 'value = "rebuilt-from-wheel"\n', [info + 'METADATA']: metadata,
    [info + 'WHEEL']: 'Wheel-Version: 1.0\nGenerator: crabot-regression\nRoot-Is-Purelib: true\nTag: py3-none-any\n' }
  for (const [name, bytes] of Object.entries(files)) archive.addFile(name, Buffer.from(bytes))
  archive.addFile(info + 'RECORD', Buffer.from(Object.entries(files).map(([name, bytes]) => `${name},sha256=${digest(bytes)},${Buffer.byteLength(bytes)}`).join('\n') + `\n${info}RECORD,,\n`))
  archive.writeZip(path.join(wheels, 'crabot_migration_probe-1.2.3-py3-none-any.whl'))
  const old = await inspectLegacyPythonEnvironment({ root, dataDir })
  lock = await acquireCliLock(dataDir, 'test-legacy-python-rebuild')
  const runtime = product.loadProductRuntime(root, { required: true })
  const calls = []
  const offline = async (command, args, options) => {
    assert.equal(options.env.CRABOT_CORE_AGENT_RUNTIME_BEARER, undefined)
    assert.equal(options.env.PYTHONPATH, undefined)
    assert.equal(options.env.UV_PYTHON_DOWNLOADS, 'never')
    calls.push({ command, args, options })
    if (command !== runtime.executables.uv) {
      assert.ok(command.startsWith(path.join(dataDir, 'agent-environments'))); assert.ok(args.includes('-I')); assert.ok(args.includes('-B'))
      return execute(command, args, options)
    }
    assert.ok(args.includes('--no-config')); assert.ok(args.includes('--no-python-downloads'))
    if (args[1] === 'install') {
      assert.ok(args.includes('--only-binary')); assert.ok(args.includes('--no-deps'))
      return execute(command, [...args, '--offline', '--no-index', '--find-links', wheels], options)
    }
    return execute(command, args, options)
  }
  return { dataDir, site, old, code, calls, offline, lock }
}
const prepare = (f, extra = {}) => prepareLegacyPythonRebuild({ root, dataDir: f.dataDir,
  progress: stage => console.log('LEGACY_PYTHON_REBUILD_STAGE ' + stage),
  expectedFingerprint: f.old.fingerprint, execute: f.offline, ...extra })

async function assertOriginal(f) {
  assert.equal((await inspectLegacyPythonEnvironment({ root, dataDir: f.dataDir })).fingerprint, f.old.fingerprint)
  assert.equal(await fs.readFile(path.join(f.site, 'crabot_migration_probe.py'), 'utf8'), f.code)
  assert.equal(await fs.stat(path.join(f.dataDir, 'agent-python.json')).catch(() => null), null)
}

test('a real offline wheel rebuild runs in the new interpreter and leaves the original environment selected', async t => {
  const f = await fixture(t), phases = []
  const secret = process.env.CRABOT_CORE_AGENT_RUNTIME_BEARER
  process.env.CRABOT_CORE_AGENT_RUNTIME_BEARER = 'rebuild-must-not-inherit'
  t.after(() => { if (secret === undefined) delete process.env.CRABOT_CORE_AGENT_RUNTIME_BEARER; else process.env.CRABOT_CORE_AGENT_RUNTIME_BEARER = secret })
  const result = await prepare(f, { progress: phase => phases.push(phase) })
  assert.equal(result.selected, false); assert.ok(result.directory.startsWith('agent-environments/'))
  assert.equal(f.calls.length, 3)
  assert.deepEqual(phases, ['creating_environment', 'restoring_dependencies', 'verifying_dependencies'])
  const record = await fs.readFile(path.join(f.dataDir, result.directory, 'legacy-rebuild.json'))
  assert.equal(createHash('sha256').update(record).digest('hex'), result.receipt_sha256)
  assert.equal(JSON.parse(record).source_fingerprint, f.old.fingerprint)
  const output = await execute(result.binary, ['-I', '-B', '-c', 'import crabot_migration_probe,sys; print(crabot_migration_probe.value); assert sys.version_info[:2] == (3,12)'], { env: f.calls[0].options.env })
  assert.equal(output.stdout.trim(), 'rebuilt-from-wheel')
  await assertOriginal(f)
  const bootstrap = JSON.parse(gunzipSync(await fs.readFile(new URL('./fixtures/legacy-python-bootstrap.json.gz', import.meta.url))))
  const catalog = JSON.parse(await fs.readFile(new URL('../../desktop/legacy-python-bootstrap.json', import.meta.url)))
  for (const [name, encoded] of Object.entries(bootstrap.files)) {
    const bytes = Buffer.from(encoded, 'base64')
    assert.equal(bytes.length, catalog.files[name].size)
    assert.equal(createHash('sha256').update(bytes).digest('hex'), catalog.files[name].sha256)
    await fs.writeFile(path.join(f.site, name), bytes)
  }
  f.old = await inspectLegacyPythonEnvironment({ root, dataDir: f.dataDir })
  assert.equal(f.old.unrecorded_site_files, 2)
  const again = await prepare(f)
  assert.notEqual(again.directory, result.directory); assert.equal(again.selected, false)
  await assertOriginal(f)
})

test('a failed dependency install retains the original and an unselected preparation without a completion receipt', async t => {
  const f = await fixture(t)
  await assert.rejects(prepare(f, { execute: async () => { throw new Error('https://credential-never-returned@example.invalid') } }), error => {
    assert.equal(error.code, 'CRABOT_LEGACY_PYTHON_INSTALL_FAILED'); assert.equal(error.message.includes('credential'), false); return true
  })
  const [id] = await fs.readdir(path.join(f.dataDir, 'agent-environments'))
  assert.equal(await fs.stat(path.join(f.dataDir, 'agent-environments', id, 'legacy-rebuild.json')).catch(() => null), null)
  await assertOriginal(f)
})

test('cancellation and a changed original are never published as a completed preparation', async t => {
  const f = await fixture(t), abort = new AbortController()
  await assert.rejects(prepare(f, { signal: abort.signal, execute: async () => { abort.abort(); throw new Error('aborted') } }), { code: 'CRABOT_PREPARATION_CANCELLED' })
  await assertOriginal(f)
  const result = prepare(f, { execute: async (command, args, options) => {
    const value = await f.offline(command, args, options)
    if (args[1] === 'install') await fs.writeFile(path.join(f.site, 'crabot_migration_probe.py'), 'a concurrent user edit')
    return value
  } })
  await assert.rejects(result, { code: 'CRABOT_LEGACY_PYTHON_CHANGED' })
  for (const id of await fs.readdir(path.join(f.dataDir, 'agent-environments'))) {
    assert.equal(await fs.stat(path.join(f.dataDir, 'agent-environments', id, 'legacy-rebuild.json')).catch(() => null), null)
  }
  assert.equal(await fs.readFile(path.join(f.site, 'crabot_migration_probe.py'), 'utf8'), 'a concurrent user edit')
})

test('unverified bootstrap contents stop before downloading dependencies or touching the original', async t => {
  const f = await fixture(t)
  await fs.writeFile(path.join(f.site, '_virtualenv.py'), 'user-modified-bootstrap')
  f.old = await inspectLegacyPythonEnvironment({ root, dataDir: f.dataDir })
  await assert.rejects(prepare(f), { code: 'CRABOT_LEGACY_PYTHON_REBUILD_UNVERIFIED' })
  assert.equal(f.calls.length, 0)
  await assertOriginal(f)
})


test('a missing common lock and an already cancelled operation create no preparation', async t => {
  const f = await fixture(t)
  const abort = new AbortController(); abort.abort()
  await assert.rejects(prepare(f, { signal: abort.signal }), { code: 'CRABOT_PREPARATION_CANCELLED' })
  releaseCliLock(f.lock)
  await assert.rejects(prepare(f), { code: 'CRABOT_BACKUP_REQUIRES_STOP' })
  assert.equal(await fs.stat(path.join(f.dataDir, 'agent-environments')).catch(() => null), null)
  await assertOriginal(f)
})

test('the production preparation runner verifies a dependency-free legacy environment entirely offline', async t => {
  const f = await fixture(t)
  await fs.rm(path.join(f.site, 'crabot_migration_probe.py'))
  await fs.rm(path.join(f.site, 'crabot_migration_probe-1.2.3.dist-info'), { recursive: true })
  f.old = await inspectLegacyPythonEnvironment({ root, dataDir: f.dataDir })
  const result = await prepare(f, { execute: undefined })
  assert.equal(result.selected, false); assert.equal(f.calls.length, 0)
  assert.equal((await inspectLegacyPythonEnvironment({ root, dataDir: f.dataDir })).fingerprint, f.old.fingerprint)
  const record = JSON.parse(await fs.readFile(path.join(f.dataDir, result.directory, 'legacy-rebuild.json')))
  assert.deepEqual(record.pins, [])
  assert.equal(await fs.stat(path.join(f.dataDir, 'agent-python.json')).catch(() => null), null)
})


test('verified rebuild selection changes the default interpreter without moving either environment', async t => {
  const f = await fixture(t), prepared = await prepare(f)
  const input = { root, dataDir: f.dataDir, prepared, expectedFingerprint: f.old.fingerprint }
  console.log('LEGACY_PYTHON_SELECTION_STAGE pre-publication-failure-check')
  const open = fs.open, rename = fs.rename
  const failedPublication = t.mock.method(fs, 'rename', async (from, to) => {
    if (to === path.join(f.dataDir, selection.selectionName)) throw Object.assign(new Error('controlled pre-publication rename failure'), { code: 'EIO' })
    return rename(from, to)
  })
  await assert.rejects(selectLegacyPythonRebuild(input), { code: 'EIO' })
  failedPublication.mock.restore()
  assert.equal(selection.readAgentEnvironmentReference(f.dataDir), null)
  if (process.platform !== 'win32') {
    let published = false
    const syncFailure = t.mock.method(fs, 'open', async (file, ...args) => {
      if (file === f.dataDir && !published) { published = true; throw Object.assign(new Error('controlled directory fsync failure'), { code: 'EIO' }) }
      return open(file, ...args)
    })
    await assert.rejects(selectLegacyPythonRebuild(input), { code: 'CRABOT_PYTHON_SELECTION_UNKNOWN' })
    syncFailure.mock.restore()
  } else await selectLegacyPythonRebuild(input) // Node has no Windows directory-fsync path to inject.
  console.log('LEGACY_PYTHON_SELECTION_STAGE publication-verified')
  assert.equal(selection.readAgentEnvironmentSelection(f.dataDir).record.id, prepared.id)
  assert.equal((await selectLegacyPythonRebuild(input)).id, prepared.id)
  const runtime = product.loadProductRuntime(root, { required: true })
  const selectedPath = python.ensureProductAgentVenv(runtime, f.dataDir)
  assert.equal(selectedPath.split(path.delimiter)[0], path.dirname(prepared.binary))
  const output = await execute(prepared.binary, ['-I', '-B', '-c', 'import crabot_migration_probe;print(crabot_migration_probe.value)'])
  assert.equal(output.stdout.trim(), 'rebuilt-from-wheel')
  assert.equal((await inspectLegacyPythonEnvironment({ root, dataDir: f.dataDir })).fingerprint, f.old.fingerprint)
  assert.equal(await fs.readFile(path.join(f.site, 'crabot_migration_probe.py'), 'utf8'), f.code)
  console.log('LEGACY_PYTHON_SELECTION_STAGE conflict-and-cancellation-check')
  const selectedFile = path.join(f.dataDir, selection.selectionName), originalReference = await fs.readFile(selectedFile)
  const otherReference = { ...JSON.parse(originalReference), id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', directory: 'agent-environments/bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' }
  await fs.writeFile(selectedFile, JSON.stringify(otherReference))
  await assert.rejects(selectLegacyPythonRebuild(input), { code: 'CRABOT_PYTHON_SELECTION_CONFLICT' })
  assert.deepEqual(JSON.parse(await fs.readFile(selectedFile, 'utf8')), otherReference)
  await fs.writeFile(selectedFile, originalReference)
  await assert.rejects(cancelLegacyPythonSelection({ ...input, prepared: { ...prepared, receipt_sha256: 'b'.repeat(64) } }), { code: 'CRABOT_PYTHON_SELECTION_CONFLICT' })
  // A damaged selected target remains blocked; cancellation can clear only this
  // exact reference and does not delete either environment.
  await fs.rename(path.join(f.dataDir, prepared.directory, 'legacy-rebuild.json'), path.join(f.dataDir, prepared.directory, 'receipt-retained'))
  assert.throws(() => python.ensureProductAgentVenv(runtime, f.dataDir), { code: 'CRABOT_PYTHON_ENV_SELECTION_INVALID' })
  if (process.platform !== 'win32') {
    const cancelSyncFailure = t.mock.method(fs, 'open', async (file, ...args) => {
      if (file === f.dataDir) throw Object.assign(new Error('controlled cancel fsync failure'), { code: 'EIO' })
      return open(file, ...args)
    })
    await assert.rejects(cancelLegacyPythonSelection(input), { code: 'CRABOT_PYTHON_SELECTION_UNKNOWN' })
    cancelSyncFailure.mock.restore()
  } else assert.deepEqual(await cancelLegacyPythonSelection(input), { cleared: true })
  assert.deepEqual(await cancelLegacyPythonSelection(input), { cleared: false })
  assert.equal(selection.readAgentEnvironmentSelection(f.dataDir), null)
  assert.equal((await fs.stat(path.join(f.dataDir, prepared.directory))).isDirectory(), true)
  await assertOriginal(f)
})

test('selection refuses a changed source and a missing operation lock without replacing the old default', async t => {
  const f = await fixture(t), prepared = await prepare(f)
  const input = { root, dataDir: f.dataDir, prepared, expectedFingerprint: f.old.fingerprint }
  const running = createInstanceRuntime({ dataDir: f.dataDir, root, mmPort: 18999 })
  await assert.rejects(selectLegacyPythonRebuild(input), { code: 'CRABOT_BACKUP_REQUIRES_STOP' })
  clearInstanceRuntime(f.dataDir, running.generation)
  const probe = t.mock.method(python, 'ensureProductPythonEnvironment', () => { throw new Error('https://private-probe-output.invalid/must-not-return') })
  await assert.rejects(selectLegacyPythonRebuild(input), error => {
    assert.equal(error.code, 'CRABOT_LEGACY_PYTHON_SELECTION_UNVERIFIED')
    assert.equal(error.message.includes('must-not-return'), false)
    assert.equal(error.cause.message.includes('must-not-return'), true)
    return true
  })
  probe.mock.restore()
  await fs.writeFile(path.join(f.site, 'crabot_migration_probe.py'), 'concurrent source change')
  await assert.rejects(selectLegacyPythonRebuild(input))
  assert.equal(selection.readAgentEnvironmentSelection(f.dataDir), null)
  releaseCliLock(f.lock)
  await assert.rejects(selectLegacyPythonRebuild(input), { code: 'CRABOT_BACKUP_REQUIRES_STOP' })
  assert.equal(selection.readAgentEnvironmentSelection(f.dataDir), null)
})


test('a known exact pre-business reference can be cancelled without deleting the old environment', async t => {
  const f = await fixture(t), prepared = { id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', directory: 'agent-environments/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    receipt_sha256: 'b'.repeat(64), source_fingerprint: f.old.fingerprint }
  const file = path.join(f.dataDir, selection.selectionName)
  const record = { schema_version: 1, id: prepared.id, directory: prepared.directory, receipt_sha256: prepared.receipt_sha256, source_fingerprint: prepared.source_fingerprint }
  const bytes = JSON.stringify(record) + '\n'
  if (process.platform === 'win32') { const { default: identity } = await import('../process-identity.cjs'); identity.writePrivateFile(file, bytes) }
  else await fs.writeFile(file, bytes, { flag: 'wx', mode: 0o600 })
  assert.deepEqual(await cancelLegacyPythonSelection({ root, dataDir: f.dataDir, prepared, expectedFingerprint: f.old.fingerprint }), { cleared: true })
  await assertOriginal(f)
})
