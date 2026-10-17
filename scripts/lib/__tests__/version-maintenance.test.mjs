import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import management from '../desktop-management.cjs'
import { acquireCliLock, releaseCliLock } from '../cli-lock.mjs'
import { writeCoreRelease } from '../core-release.mjs'
import { createMaintenanceBackup } from '../maintenance-backup.mjs'
import { prepareCoreEnvironment } from '../core-preparation.mjs'
import { assertVersionMaintenanceAllowsStart, beginVersionMaintenance, readVersionMaintenance,
  recordVersionMaintenanceBackup, markVersionMaintenanceInstalling, recoverVersionMaintenance } from '../version-maintenance.mjs'

async function fixture(t) {
  const temporary = await fs.mkdtemp(path.join(tmpdir(), 'Crabot 版本维护 '))
  const root = path.join(temporary, '安装'), dataDir = management.ensurePrivateDataRoot(path.join(temporary, '数据'))
  await fs.mkdir(root); await fs.mkdir(path.join(dataDir, 'admin')); await fs.writeFile(path.join(dataDir, 'admin/config'), 'preserved')
  t.after(async () => { releaseCliLock(path.join(dataDir, 'cli.lock')); await fs.rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) })
  async function seal(version) {
    for (const file of ['core-files.json', 'core-release.json']) await fs.rm(path.join(root, file), { force: true })
    for (const file of ['package.json', 'product-runtime.json']) await fs.writeFile(path.join(root, file), JSON.stringify({ version }))
    await writeCoreRelease(root, { schema_version: 1, version, platform: process.platform, arch: process.arch, commit: '1'.repeat(40), source_dirty: false })
  }
  await seal('1.2.3')
  async function begin() {
    const lock = await acquireCliLock(dataDir, 'maintenance-test')
    const record = await beginVersionMaintenance(dataDir, root, '1.2.4')
    return { lock, record }
  }
  return { root, dataDir, seal, begin }
}
test('maintenance requires the real held operation lock and fences preparation before any startup writes', async t => {
  const f = await fixture(t)
  await assert.rejects(beginVersionMaintenance(f.dataDir, f.root, '1.2.4'), { code: 'CRABOT_MAINTENANCE_PENDING' })
  const { lock } = await f.begin(); releaseCliLock(lock)
  assert.throws(() => assertVersionMaintenanceAllowsStart(f.dataDir), { code: 'CRABOT_MAINTENANCE_PENDING' })
  assert.throws(() => prepareCoreEnvironment({ root: f.root, dataDir: f.dataDir }), { code: 'CRABOT_MAINTENANCE_PENDING' })
  await assert.rejects(fs.lstat(path.join(f.dataDir, 'agent')), { code: 'ENOENT' })
  assert.equal(await fs.readFile(path.join(f.dataDir, 'admin/config'), 'utf8'), 'preserved')
})
test('installer phase cannot be recorded without a verified scoped backup', async t => {
  const f = await fixture(t), { lock, record } = await f.begin()
  await assert.rejects(markVersionMaintenanceInstalling(f.dataDir, record.id), { code: 'CRABOT_MAINTENANCE_PENDING' })
  const backup = await createMaintenanceBackup(f.dataDir)
  await recordVersionMaintenanceBackup(f.dataDir, record.id, backup)
  await markVersionMaintenanceInstalling(f.dataDir, record.id)
  assert.equal(readVersionMaintenance(f.dataDir).phase, 'installing'); releaseCliLock(lock)
})
test('a pre-install interruption may resume only the exact verified source and preserves all business data', async t => {
  const f = await fixture(t), { lock } = await f.begin(); releaseCliLock(lock)
  let started = false
  assert.equal(await recoverVersionMaintenance({ ...f, appVersion: '1.2.3', verifyCompatible: async () => {}, run: async () => {
    assertVersionMaintenanceAllowsStart(f.dataDir); started = true; return true
  } }), true)
  assert.equal(started, true); assert.equal(readVersionMaintenance(f.dataDir), null)
  assert.equal(await fs.readFile(path.join(f.dataDir, 'admin/config'), 'utf8'), 'preserved')
})
for (const failure of ['old version after installer', 'incompatible data', 'health failure', 'corrupt core', 'corrupt backup']) {
  test('interrupted replacement retains the fence and evidence: ' + failure, async t => {
    const f = await fixture(t), { lock, record } = await f.begin(), backup = await createMaintenanceBackup(f.dataDir)
    await recordVersionMaintenanceBackup(f.dataDir, record.id, backup); await markVersionMaintenanceInstalling(f.dataDir, record.id); releaseCliLock(lock)
    if (failure !== 'old version after installer') await f.seal('1.2.4')
    if (failure === 'corrupt core') await fs.appendFile(path.join(f.root, 'package.json'), ' ')
    if (failure === 'corrupt backup') await fs.appendFile(path.join(backup.directory, 'data/admin/config'), ' ')
    let started = false
    await assert.rejects(recoverVersionMaintenance({ ...f, appVersion: failure === 'old version after installer' ? '1.2.3' : '1.2.4',
      verifyCompatible: async () => { if (failure === 'incompatible data') throw new Error('newer schema') },
      run: async () => { started = true; return false } }))
    assert.equal(started, failure === 'health failure')
    assert.equal(readVersionMaintenance(f.dataDir).id, record.id)
    assert.throws(() => assertVersionMaintenanceAllowsStart(f.dataDir), { code: 'CRABOT_MAINTENANCE_PENDING' })
    assert.equal(await fs.readFile(path.join(f.dataDir, 'admin/config'), 'utf8'), 'preserved')
  })
}
test('a full target version clears the record only after compatibility and health succeed', async t => {
  const f = await fixture(t), { lock, record } = await f.begin(), backup = await createMaintenanceBackup(f.dataDir)
  await recordVersionMaintenanceBackup(f.dataDir, record.id, backup); await markVersionMaintenanceInstalling(f.dataDir, record.id); releaseCliLock(lock)
  await f.seal('1.2.4')
  const order = []
  await recoverVersionMaintenance({ ...f, appVersion: '1.2.4', verifyCompatible: async () => { order.push('compatibility') },
    run: async () => { order.push('ordinary-start-health'); assertVersionMaintenanceAllowsStart(f.dataDir); return true } })
  assert.deepEqual(order, ['compatibility', 'ordinary-start-health', 'compatibility'])
  assert.equal(readVersionMaintenance(f.dataDir), null)
})
