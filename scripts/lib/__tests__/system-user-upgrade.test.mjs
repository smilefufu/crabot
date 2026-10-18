import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs, constants, readFileSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { createHash, randomUUID } from 'node:crypto'
import { maintainSystemUser } from '../system-user-upgrade.mjs'
import { writeCoreRelease, verifyCoreRelease } from '../core-release.mjs'
import { readVersionMaintenance, assertVersionMaintenanceAllowsStart } from '../version-maintenance.mjs'
import { verifyMaintenanceBackup } from '../maintenance-backup.mjs'
import management from '../desktop-management.cjs'

const options = { skip: process.platform === 'win32' }
const nodeHash = createHash('sha256').update(readFileSync(process.execPath)).digest('hex')
async function fixture(t, { fail = false } = {}) {
  const parent = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'crabot-system-data-')))
  t.after(() => fs.rm(parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))
  const install = path.join(parent, 'shared'); await fs.mkdir(path.join(install, 'releases'), { recursive: true })
  await fs.writeFile(path.join(install, 'cli-installation.json'), JSON.stringify({ schema_version: 1, scope: 'system', launcher_sha256: 'a'.repeat(64) }))
  const make = async (version, schema) => {
    const root = path.join(parent, version), node = path.join(root, 'bin/node')
    await fs.mkdir(path.dirname(node), { recursive: true }); await fs.copyFile(process.execPath, node, constants.COPYFILE_FICLONE); await fs.chmod(node, 0o755)
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ version }))
    await fs.writeFile(path.join(root, 'product-runtime.json'), JSON.stringify({ schema_version: 1, version, platform: process.platform, arch: process.arch,
      versions: { node: process.versions.node, python: '3.12.12' },
      executables: Object.fromEntries(['node', 'python', 'uv', 'bash', 'git', 'rg'].map(name => [name, 'bin/node'])),
      path_entries: ['bin'], python_home: 'bin', memory_packages: 'bin', seed_wheels: [],
      files: { 'bin/node': { size: (await fs.stat(node)).size, sha256: nodeHash } } }))
    await fs.mkdir(path.join(root, 'crabot-fixture/upgrade'), { recursive: true })
    await fs.writeFile(path.join(root, 'crabot-fixture/schema_version'), schema)
    await fs.writeFile(path.join(root, 'crabot-fixture/upgrade/from_v1_to_v2.mjs'),
      "import{appendFileSync}from'node:fs';const dir=process.argv.find(a=>a.startsWith('--data-dir=')).slice(11);appendFileSync(dir+'/content',' changed');console.log('ordinary migration output');process.exit(" + (fail ? '13' : '0') + ");")
    await writeCoreRelease(root, { schema_version: 1, version, platform: process.platform, arch: process.arch, commit: 'a'.repeat(40), source_dirty: false })
    const id = (await verifyCoreRelease(root)).inventory_sha256; await fs.rename(root, path.join(install, 'releases', id)); return { id, version }
  }
  const source = await make('1.2.3', 'v1'), target = await make('1.2.4', 'v2')
  const choose = release => fs.writeFile(path.join(install, 'current-core'), release.id + '\n')
  await choose(source)
  const data = management.ensurePrivateDataRoot(path.join(parent, 'private-data'))
  await fs.mkdir(path.join(data, 'fixture')); await fs.writeFile(path.join(data, 'fixture/SCHEMA_VERSION'), 'v1'); await fs.writeFile(path.join(data, 'fixture/content'), 'before')
  const entry = { uid: process.getuid(), data_dir: data }, operationId = randomUUID(), deployment = { install_root: install, source, target }
  const invoke = (action, extra) => maintainSystemUser(entry, { action, deployment, operationId, env: {}, observe: async () => ({ state: 'stopped' }), ...extra })
  return { entry, data, choose, source, target, operationId, invoke }
}
test('UID upgrade creates an actual verified snapshot and migrates once without starting services', options, async t => {
  const f = await fixture(t), snapshot = await f.invoke('snapshot')
  assert.equal(snapshot.system_operation_id, f.operationId); assert.equal(readVersionMaintenance(f.data).phase, 'backed_up')
  assert.throws(() => assertVersionMaintenanceAllowsStart(f.data), { code: 'CRABOT_MAINTENANCE_PENDING' })
  await f.choose(f.target)
  assert.deepEqual(await f.invoke('migrate', { snapshot }), { migrated: true, service_started: false })
  assert.equal(readVersionMaintenance(f.data), null); assert.equal(await fs.readFile(path.join(f.data, 'fixture/SCHEMA_VERSION'), 'utf8'), 'v2\n')
  assert.equal(await fs.readFile(path.join(f.data, 'fixture/content'), 'utf8'), 'before changed')
  const directory = path.join(f.data + '.desktop-backups', snapshot.backup.id)
  await verifyMaintenanceBackup(directory, snapshot.backup.sha256)
  assert.equal(await fs.readFile(path.join(directory, 'data/fixture/content'), 'utf8'), 'before')
  await assert.rejects(f.invoke('migrate', { snapshot })); assert.equal(await fs.readFile(path.join(f.data, 'fixture/content'), 'utf8'), 'before changed')
  await assert.rejects(fs.stat(path.join(f.data, 'mm.pid')), { code: 'ENOENT' })
})
test('a partially failed real migration remains fenced and a second invocation cannot replay it', options, async t => {
  const f = await fixture(t, { fail: true }), snapshot = await f.invoke('snapshot'); await f.choose(f.target)
  await assert.rejects(f.invoke('migrate', { snapshot }), { code: 'CRABOT_MIGRATION_FAILED' })
  assert.equal(readVersionMaintenance(f.data).phase, 'verifying')
  await assert.rejects(f.invoke('migrate', { snapshot }), { code: 'CRABOT_SYSTEM_OPERATION_INTERRUPTED' })
  await assert.rejects(f.invoke('cancel-preparation'))
  assert.equal(await fs.readFile(path.join(f.data, 'fixture/content'), 'utf8'), 'before changed')
  assert.equal(await fs.readFile(path.join(f.data, 'fixture/SCHEMA_VERSION'), 'utf8'), 'v1')
})
test('prepared data can be released only while the exact source is selected; cancellation never restores data', options, async t => {
  const f = await fixture(t); await f.invoke('snapshot')
  await f.choose(f.target); await assert.rejects(f.invoke('cancel-preparation'), { code: 'CRABOT_SYSTEM_INSTANCE_CHANGED' })
  await f.choose(f.source)
  await fs.writeFile(path.join(f.data, 'fixture/content'), 'preserved current data')
  assert.deepEqual(await f.invoke('cancel-preparation'), { preparation_cancelled: true, service_started: false })
  assert.equal(readVersionMaintenance(f.data), null)
  assert.equal(await fs.readFile(path.join(f.data, 'fixture/content'), 'utf8'), 'preserved current data')
})
test('another operation, changed snapshot or a live replacement cannot authorize data migration', options, async t => {
  const f = await fixture(t), snapshot = await f.invoke('snapshot'); await f.choose(f.target)
  await assert.rejects(f.invoke('migrate', { snapshot, operationId: randomUUID() }))
  await assert.rejects(f.invoke('migrate', { snapshot: { ...snapshot, backup: { ...snapshot.backup, sha256: 'a'.repeat(64) } } }))
  await assert.rejects(f.invoke('migrate', { snapshot, observe: async () => ({ state: 'running', generation: 'new-instance' }) }), { code: 'CRABOT_SYSTEM_INSTANCE_CHANGED' })
  assert.equal(readVersionMaintenance(f.data).phase, 'backed_up')
  assert.equal(await fs.readFile(path.join(f.data, 'fixture/content'), 'utf8'), 'before')
})
