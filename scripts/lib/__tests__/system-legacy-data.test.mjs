import test from 'node:test'
import assert from 'node:assert/strict'
import fs, { promises as fsp, constants } from 'node:fs'
import path from 'node:path'
import { tmpdir, userInfo } from 'node:os'
import { randomUUID, createHash } from 'node:crypto'
import { maintainLegacySystemUser } from '../system-legacy-data.mjs'
import { newCredentialsFromPassword, verifyPassword } from '../../../crabot-admin/dist/credentials.js'
import { writeCoreRelease, verifyCoreRelease } from '../core-release.mjs'
import { readVersionMaintenance, assertVersionMaintenanceAllowsStart } from '../version-maintenance.mjs'
import { verifyMaintenanceBackup } from '../maintenance-backup.mjs'
import management from '../desktop-management.cjs'
const options = { skip: process.platform === 'win32' }
const hash = bytes => createHash('sha256').update(bytes).digest('hex'), nodeHash = hash(fs.readFileSync(process.execPath))
async function fixture(t, { fails = false } = {}) {
  const parent = await fsp.realpath(await fsp.mkdtemp(path.join(tmpdir(), 'crabot-system-legacy-data-')))
  t.after(() => fsp.rm(parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))
  const dataDir = management.ensurePrivateDataRoot(path.join(parent, 'data')), sourceRoot = path.join(parent, 'old-source')
  await fsp.mkdir(sourceRoot); await fsp.writeFile(path.join(sourceRoot, 'retained'), 'old shared base retained')
  const install = path.join(parent, 'managed'), staging = path.join(parent, 'target'), node = path.join(staging, 'bin/node')
  await fsp.mkdir(path.join(install, 'releases'), { recursive: true }); await fsp.mkdir(path.dirname(node), { recursive: true })
  await fsp.copyFile(process.execPath, node, constants.COPYFILE_FICLONE); await fsp.chmod(node, 0o755)
  await fsp.writeFile(path.join(staging, 'package.json'), '{"version":"1.2.4"}')
  await fsp.writeFile(path.join(staging, 'product-runtime.json'), JSON.stringify({ schema_version: 1, version: '1.2.4', platform: process.platform, arch: process.arch,
    versions: { node: process.versions.node, python: '3.12.12' }, executables: Object.fromEntries(['node', 'python', 'uv', 'bash', 'git', 'rg'].map(name => [name, 'bin/node'])),
    files: { 'bin/node': { size: (await fsp.stat(node)).size, sha256: nodeHash } }, path_entries: ['bin'], python_home: 'bin', memory_packages: 'bin', seed_wheels: [] }))
  await fsp.mkdir(path.join(staging, 'crabot-fixture/upgrade'), { recursive: true })
  await fsp.writeFile(path.join(staging, 'crabot-fixture/schema_version'), 'v2')
  await fsp.writeFile(path.join(staging, 'crabot-fixture/upgrade/scope.mjs'), `export const migrationScope = () => ({ reads: [], writes: ['fixture/content', 'fixture/SCHEMA_VERSION'] })`)
  await fsp.writeFile(path.join(staging, 'crabot-fixture/upgrade/from_v1_to_v2.mjs'),
    "import fs from 'node:fs';const dir=process.argv.find(a=>a.startsWith('--data-dir=')).slice(11);fs.appendFileSync(dir+'/content',' changed');process.exit(" + (fails ? '13' : '0') + ");")
  await writeCoreRelease(staging, { schema_version: 1, version: '1.2.4', platform: process.platform, arch: process.arch, commit: '1'.repeat(40), source_dirty: false })
  const target = await verifyCoreRelease(staging), targetRoot = path.join(install, 'releases', target.inventory_sha256)
  await fsp.rename(staging, targetRoot)
  await fsp.writeFile(path.join(install, 'cli-installation.json'), JSON.stringify({ schema_version: 1, scope: 'system', launcher_sha256: 'a'.repeat(64) }))
  const choose = id => fsp.writeFile(path.join(install, 'current-core'), id + '\n'); await choose(target.inventory_sha256)
  for (const name of ['admin', 'agent', 'memory']) await fsp.mkdir(path.join(dataDir, name), { mode: 0o755 })
  await fsp.writeFile(path.join(dataDir, 'admin/credentials.json'), JSON.stringify(await newCredentialsFromPassword('private-fixture-password', { is_temp: false, changed_via: 'start' })), { mode: 0o600 })
  await fsp.mkdir(path.join(dataDir, 'fixture')); await fsp.writeFile(path.join(dataDir, 'fixture/SCHEMA_VERSION'), 'v1'); await fsp.writeFile(path.join(dataDir, 'fixture/content'), 'before')
  const actual = userInfo(), entry = { user: actual.username, uid: actual.uid, gid: actual.gid, home: actual.homedir, data_dir: dataDir, port_offset: 100, enabled: true, autostart: false }
  const home = management.ensurePrivateDataRoot(path.join(parent, 'home-manifest-fixture')), manifestFile = path.join(home, 'instance.json')
  const original = JSON.stringify({ mode: 'system', port_offset: 100, crabot_home: sourceRoot, data_dir: '/display-only-do-not-adopt', api_key: 'private-fixture-kept-only-in-uid-file' }) + '\n'
  await fsp.writeFile(manifestFile, original, { mode: 0o600 })
  const source = { version: 'v2026.10.15.1', installRoot: sourceRoot, code_fingerprint: 'b'.repeat(64) }
  const observed = () => ({ user: entry.user, uid: entry.uid, port_offset: entry.port_offset, install_root: sourceRoot,
    code_fingerprint: source.code_fingerprint, manifest_fingerprint: hash(fs.readFileSync(manifestFile)), data_binding: 'unverified' })
  const observation = { ...observed(), runtime_state: 'running', data_binding: 'observed_running', data_dir: dataDir, data_directory: { device: (await fsp.stat(dataDir, { bigint: true })).dev.toString(), inode: (await fsp.stat(dataDir, { bigint: true })).ino.toString() },
    controller: { pid: 10001, parent: 1, owner: String(entry.uid), started: 'preflight-controller-fixture', executable: process.execPath },
    mm: { pid: 10002, parent: 10001, owner: String(entry.uid), started: 'preflight-mm-fixture', executable: process.execPath }, mm_port: 19100, launch_kind: 'daemon' }
  const runtimeOptions = { observeAccount: async () => observed(), observeProcesses: async (_, use) => use({ state: 'stopped' }, null) }
  const operationId = randomUUID(), sourceFenceId = randomUUID(), params = { source, observation, sourceFenceId, operationId, targetRoot, manifestFile,
    env: {}, runtimeOptions, inspectEnvironment: async () => ({ status: 'absent' }), prepareEnvironment: () => assert.fail('absent legacy environment must not execute Python'),
    processes: async (root, use) => { assert.equal(root, sourceRoot); return use({ state: 'stopped' }) } }
  const invoke = (action, extra) => maintainLegacySystemUser(entry, { ...params, action, ...extra })
  return { entry, dataDir, sourceRoot, targetRoot, operationId, sourceFenceId, params, original, manifestFile, choose, invoke }
}

test('legacy UID snapshot includes the original home manifest, migrates once, and preserves all private fields and original data binding', options, async t => {
  const f = await fixture(t), snapshot = await f.invoke('snapshot')
  assert.equal(JSON.stringify(snapshot).includes('private-fixture'), false)
  const directory = path.join(f.dataDir + '.desktop-backups', snapshot.backup.id)
  await verifyMaintenanceBackup(directory, snapshot.backup.sha256)
  assert.equal(await fsp.readFile(path.join(directory, 'data/system-conversion', f.operationId, 'legacy-instance.json'), 'utf8'), f.original)
  assert.equal(await fsp.readFile(f.manifestFile, 'utf8'), f.original)
  assert.deepEqual(await f.invoke('migrate', { snapshot }), { migrated: true, service_started: false })
  const after = JSON.parse(await fsp.readFile(f.manifestFile, 'utf8'))
  assert.equal(after.crabot_home, f.targetRoot); assert.equal(after.data_dir, f.dataDir); assert.equal(after.port_offset, 100)
  assert.equal(after.api_key, JSON.parse(f.original).api_key)
  assert.equal((await fsp.stat(f.manifestFile)).mode & 0o777, 0o600)
  assert.equal(readVersionMaintenance(f.dataDir), null)
  assert.equal(await fsp.readFile(path.join(f.dataDir, 'fixture/content'), 'utf8'), 'before changed')
  assert.deepEqual(await f.invoke('check-migration', { snapshot }), { verified: true, service_started: false })
  await assert.rejects(f.invoke('migrate', { snapshot }))
  assert.equal(await fsp.readFile(path.join(f.sourceRoot, 'retained'), 'utf8'), 'old shared base retained')
  await assert.rejects(fsp.stat(path.join(f.dataDir, 'instance-runtime.json')), { code: 'ENOENT' })
})

test('pre-data environment failure can cancel only this preparation, leaving manifest, source and backup intact', options, async t => {
  const f = await fixture(t)
  await assert.rejects(f.invoke('snapshot', { inspectEnvironment: async () => ({ status: 'observed', fingerprint: 'a'.repeat(64) }),
    prepareEnvironment: async () => { throw new Error('controlled unsupported source environment') } }))
  assert.equal(readVersionMaintenance(f.dataDir).phase, 'backed_up')
  await assert.rejects(f.invoke('cancel-preparation', { operationId: randomUUID() }))
  assert.deepEqual(await f.invoke('cancel-preparation'), { preparation_cancelled: true, service_started: false })
  assert.equal(readVersionMaintenance(f.dataDir), null); assert.equal(await fsp.readFile(f.manifestFile, 'utf8'), f.original)
  assert.equal(await fsp.readFile(path.join(f.dataDir, 'fixture/content'), 'utf8'), 'before')
})

test('a failed real schema migration stays guarded and never updates the original home manifest or reruns', options, async t => {
  const f = await fixture(t, { fails: true }), snapshot = await f.invoke('snapshot')
  await assert.rejects(f.invoke('migrate', { snapshot }), { code: 'CRABOT_MIGRATION_FAILED' })
  assert.equal(readVersionMaintenance(f.dataDir).phase, 'verifying'); assert.throws(() => assertVersionMaintenanceAllowsStart(f.dataDir))
  await assert.rejects(f.invoke('migrate', { snapshot })); await assert.rejects(f.invoke('cancel-preparation'))
  assert.equal(JSON.parse(await fsp.readFile(path.join(f.dataDir, '.upgrade-migrations/crabot-fixture-v1-v2/state.json'), 'utf8')).phase, 'rolled_back')
  assert.equal(await fsp.readFile(f.manifestFile, 'utf8'), f.original)
  assert.equal(await fsp.readFile(path.join(f.dataDir, 'fixture/content'), 'utf8'), 'before')
})

for (const changed of ['operation', 'snapshot', 'manifest', 'selection']) test('changed migration authority preserves data and dispatches no migration: ' + changed, options, async t => {
  const f = await fixture(t), snapshot = await f.invoke('snapshot'), extra = { snapshot }
  if (changed === 'operation') extra.operationId = randomUUID()
  if (changed === 'snapshot') extra.snapshot = { ...snapshot, id: randomUUID() }
  if (changed === 'manifest') await fsp.writeFile(f.manifestFile, f.original + ' ')
  if (changed === 'selection') await f.choose('f'.repeat(64))
  await assert.rejects(f.invoke('migrate', extra))
  assert.equal(readVersionMaintenance(f.dataDir).phase, 'backed_up')
  assert.equal(await fsp.readFile(path.join(f.dataDir, 'fixture/content'), 'utf8'), 'before')
})

test('a manifest publication error after schema writes retains verifying state without replay', options, async t => {
  const f = await fixture(t), snapshot = await f.invoke('snapshot'), rename = fs.renameSync
  const fault = t.mock.method(fs, 'renameSync', (from, to) => { rename(from, to); if (to === f.manifestFile) throw Object.assign(new Error('controlled manifest post-rename error'), { code: 'EIO' }) })
  await assert.rejects(f.invoke('migrate', { snapshot }), { code: 'EIO' }); fault.mock.restore()
  assert.equal(readVersionMaintenance(f.dataDir).phase, 'verifying')
  assert.equal(JSON.parse(await fsp.readFile(f.manifestFile, 'utf8')).crabot_home, f.targetRoot)
  await assert.rejects(f.invoke('migrate', { snapshot }))
  assert.equal(await fsp.readFile(path.join(f.dataDir, 'fixture/content'), 'utf8'), 'before changed')
})

test('wrong actual UID and missing bound data never access or recreate an employee path', options, async t => {
  const f = await fixture(t), uid = f.entry.uid
  f.entry.uid++
  const guard = t.mock.method(management, 'requirePrivateDataRoot', () => assert.fail('actual UID must match before employee path checks'))
  await assert.rejects(f.invoke('snapshot')); guard.mock.restore(); f.entry.uid = uid
  await fsp.rename(f.dataDir, f.dataDir + '-retained')
  await assert.rejects(f.invoke('snapshot'), { code: 'CRABOT_DATA_MISSING' })
  await assert.rejects(fsp.stat(f.dataDir), { code: 'ENOENT' })
})

test('pre-data cancellation with no record still refuses an unexpected selected environment', options, async t => {
  const f = await fixture(t), id = randomUUID()
  await fsp.writeFile(path.join(f.dataDir, 'agent-python.json'), JSON.stringify({ schema_version: 1, id, directory: 'agent-environments/' + id,
    receipt_sha256: 'a'.repeat(64), source_fingerprint: 'b'.repeat(64) }), { mode: 0o600 })
  await assert.rejects(f.invoke('cancel-preparation'), { code: 'CRABOT_SYSTEM_CONVERSION_DATA' })
  assert.equal(await fsp.readFile(f.manifestFile, 'utf8'), f.original)
})

test('a verified legacy source alias is adopted without moving its shared base or losing original private fields', options, async t => {
  const f = await fixture(t), alias = f.sourceRoot + '-alias'
  await fsp.symlink(f.sourceRoot, alias, 'dir')
  const previous = { ...JSON.parse(f.original), crabot_home: alias }
  await fsp.writeFile(f.manifestFile, JSON.stringify(previous) + '\n')
  f.params.observation.manifest_fingerprint = hash(fs.readFileSync(f.manifestFile))
  const snapshot = await f.invoke('snapshot'); await f.invoke('migrate', { snapshot })
  assert.equal(JSON.parse(await fsp.readFile(f.manifestFile, 'utf8')).api_key, previous.api_key)
  assert.equal(await fsp.realpath(alias), f.sourceRoot)
})

for (const selection of ['absent', 'other']) test('all legacy snapshots and pre-data cancellation work before target command selection: ' + selection, options, async t => {
  const f = await fixture(t)
  if (selection === 'absent') await fsp.rm(path.join(path.dirname(path.dirname(f.targetRoot)), 'current-core'))
  else await f.choose('f'.repeat(64))
  const snapshot = await f.invoke('snapshot')
  assert.equal(readVersionMaintenance(f.dataDir).phase, 'backed_up')
  assert.equal(await fsp.readFile(f.manifestFile, 'utf8'), f.original)
  await assert.rejects(f.invoke('migrate', { snapshot }), { code: 'CRABOT_CLI_INSTALLATION' })
  assert.deepEqual(await f.invoke('cancel-preparation'), { preparation_cancelled: true, service_started: false })
  assert.equal(await fsp.readFile(path.join(f.dataDir, 'fixture/content'), 'utf8'), 'before')
})


test('standard 0755 legacy data is privatized only after stopped-source and existing-credential checks, without changing children', options, async t => {
  const f = await fixture(t), credentials = await fsp.readFile(path.join(f.dataDir, 'admin/credentials.json'))
  await fsp.chmod(f.dataDir, 0o755)
  const snapshot = await f.invoke('snapshot')
  assert.equal((await fsp.stat(f.dataDir)).mode & 0o7777, 0o700)
  for (const name of ['admin', 'agent', 'memory']) assert.equal((await fsp.stat(path.join(f.dataDir, name))).mode & 0o7777, 0o755)
  assert.deepEqual(await fsp.readFile(path.join(f.dataDir, 'admin/credentials.json')), credentials)
  assert.equal(await verifyPassword('private-fixture-password', JSON.parse(credentials)), true)
  assert.equal((await fsp.stat(path.dirname(f.manifestFile))).mode & 0o7777, 0o700)
  await f.invoke('cancel-preparation')
  assert.equal((await fsp.stat(f.dataDir)).mode & 0o7777, 0o700)
  assert.equal(snapshot.system_operation_id, f.operationId)
})
for (const changed of ['missing-admin', 'missing-credentials', 'invalid-credentials', 'remaining-process', 'directory-replaced']) test('invalid old data refuses before privacy or schema changes: ' + changed, options, async t => {
  const f = await fixture(t); await fsp.chmod(f.dataDir, 0o755)
  if (changed === 'missing-admin') await fsp.rename(path.join(f.dataDir, 'admin'), path.join(f.dataDir, 'old-admin'))
  if (changed === 'missing-credentials') await fsp.rename(path.join(f.dataDir, 'admin/credentials.json'), path.join(f.dataDir, 'admin/old-credentials.json'))
  if (changed === 'invalid-credentials') await fsp.writeFile(path.join(f.dataDir, 'admin/credentials.json'), '{}')
  if (changed === 'remaining-process') f.params.runtimeOptions.observeProcesses = async (_, use) => use({ state: 'running', mm_port: 19100 }, { getDefinition: async () => { throw new Error('controlled active source') } })
  if (changed === 'directory-replaced') {
    await fsp.rename(f.dataDir, f.dataDir + '-retained'); await fsp.cp(f.dataDir + '-retained', f.dataDir, { recursive: true }); await fsp.chmod(f.dataDir, 0o755)
  }
  await assert.rejects(f.invoke('snapshot'))
  assert.equal((await fsp.stat(f.dataDir)).mode & 0o7777, 0o755)
  assert.equal(await fsp.readFile(path.join(f.dataDir, 'fixture/content'), 'utf8'), 'before')
  assert.equal(readVersionMaintenance(f.dataDir), null)
  await assert.rejects(fsp.stat(path.join(f.dataDir + '.desktop-backups')), { code: 'ENOENT' })
})

test('an originally verified stopped UID is backed up and migrated without starting it or replacing its credentials', options, async t => {
  const f = await fixture(t), observation = f.params.observation
  observation.runtime_state = 'stopped'; observation.data_binding = 'verified_stopped'
  for (const name of ['controller', 'mm', 'mm_port', 'launch_kind']) delete observation[name]
  const before = await fsp.readFile(path.join(f.dataDir, 'admin/credentials.json'))
  const snapshot = await f.invoke('snapshot')
  const result = await f.invoke('migrate', { snapshot })
  assert.equal(result.migrated, true); assert.equal(result.service_started, false)
  assert.deepEqual(await fsp.readFile(path.join(f.dataDir, 'admin/credentials.json')), before)
  assert.equal(await verifyPassword('private-fixture-password', JSON.parse(before)), true)
  assert.equal(await fsp.readFile(path.join(f.dataDir, 'fixture/content'), 'utf8'), 'before changed')
})

for (const changed of ['schema', 'backup', 'manifest', 'source-active', 'data-replaced', 'other-running-target', 'unknown-runtime', 'malformed-manifest']) {
  test('post-migration UID verification rejects changed data without reapplying migrations: ' + changed, options, async t => {
    const f = await fixture(t), snapshot = await f.invoke('snapshot')
    await f.invoke('migrate', { snapshot })
    const extra = { snapshot }
    if (changed === 'schema') await fsp.writeFile(path.join(f.dataDir, 'fixture/SCHEMA_VERSION'), 'v1')
    if (changed === 'backup') await fsp.writeFile(path.join(f.dataDir + '.desktop-backups', snapshot.backup.id, 'data/fixture/content'), 'changed backup')
    if (changed === 'manifest') await fsp.writeFile(f.manifestFile, JSON.stringify({ ...JSON.parse(f.original), crabot_home: f.targetRoot, data_dir: f.dataDir, port_offset: 200 }))
    if (changed === 'source-active') extra.processes = async (_, use) => use({ state: 'running' })
    if (changed === 'data-replaced') { await fsp.rename(f.dataDir, f.dataDir + '-original'); await fsp.mkdir(f.dataDir, { mode: 0o700 }) }
    if (changed === 'other-running-target') extra.inspectCurrent = () => ({ state: 'running', record: { install_root: f.sourceRoot } })
    if (changed === 'unknown-runtime') extra.inspectCurrent = () => ({ state: 'starting' })
    if (changed === 'malformed-manifest') await fsp.writeFile(f.manifestFile, '{private-fixture-kept-only-in-uid-file')
    await assert.rejects(f.invoke('check-migration', extra), error => {
      assert.equal(error.message.includes('private-fixture'), false); return true
    })
    if (changed !== 'data-replaced') assert.equal(await fsp.readFile(path.join(f.dataDir, 'fixture/content'), 'utf8'), 'before changed')
    assert.equal(readVersionMaintenance(f.dataDir), null)
  })
}
test('read-only migration verification accepts the exact running target without stopping or replaying it', options, async t => {
  const f = await fixture(t), snapshot = await f.invoke('snapshot')
  await f.invoke('migrate', { snapshot })
  const before = await fsp.readFile(f.manifestFile, 'utf8')
  assert.deepEqual(await f.invoke('check-migration', { snapshot, inspectCurrent: () => ({ state: 'running', record: { install_root: f.targetRoot } }) }), { verified: true, service_started: false })
  assert.equal(await fsp.readFile(f.manifestFile, 'utf8'), before)
  assert.equal(readVersionMaintenance(f.dataDir), null)
})
