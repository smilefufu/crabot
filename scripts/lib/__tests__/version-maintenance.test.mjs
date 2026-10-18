import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs, realpathSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import management from '../desktop-management.cjs'
import { acquireCliLock, releaseCliLock } from '../cli-lock.mjs'
import { writeCoreRelease, verifyCoreRelease } from '../core-release.mjs'
import { createMaintenanceBackup } from '../maintenance-backup.mjs'
import { prepareCoreEnvironment } from '../core-preparation.mjs'
import { assertVersionMaintenanceAllowsStart, beginVersionMaintenance, readVersionMaintenance,
  recordVersionMaintenanceBackup, markVersionMaintenanceInstalling, recoverVersionMaintenance, bindVersionMaintenanceTarget, cancelPreparedVersionMaintenance } from '../version-maintenance.mjs'

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


async function immutableTarget(f, name = '目标') {
  const root = path.join(path.dirname(f.root), name)
  await fs.mkdir(root)
  for (const file of ['package.json', 'product-runtime.json']) await fs.writeFile(path.join(root, file), '{"version":"1.2.4"}')
  await writeCoreRelease(root, { schema_version: 1, version: '1.2.4', platform: process.platform, arch: process.arch, commit: '2'.repeat(40), source_dirty: false })
  return root
}

test('an immutable target is bound once under the held lock and can recover from its separate physical root', async t => {
  const f = await fixture(t), target = await immutableTarget(f), { lock, record } = await f.begin()
  const bound = await bindVersionMaintenanceTarget(f.dataDir, record.id, target)
  assert.equal(bound.target_core.root, realpathSync(target))
  assert.equal(bound.target_core.inventory_sha256, (await verifyCoreRelease(target)).inventory_sha256)
  assert.deepEqual((await bindVersionMaintenanceTarget(f.dataDir, record.id, target)).target_core, bound.target_core)
  await assert.rejects(bindVersionMaintenanceTarget(f.dataDir, record.id, await immutableTarget(f, '另一目标')), { code: 'CRABOT_MAINTENANCE_PENDING' })
  const backup = await createMaintenanceBackup(f.dataDir)
  await recordVersionMaintenanceBackup(f.dataDir, record.id, backup); await markVersionMaintenanceInstalling(f.dataDir, record.id)
  releaseCliLock(lock)
  let started = false
  await recoverVersionMaintenance({ dataDir: f.dataDir, root: target, appVersion: '1.2.4', verifyCompatible: async () => {},
    run: async () => { started = true; assertVersionMaintenanceAllowsStart(f.dataDir); return true } })
  assert.equal(started, true)
  assert.equal(readVersionMaintenance(f.dataDir), null)
  assert.equal((await verifyCoreRelease(f.root)).version, '1.2.3')
  assert.equal(await fs.readFile(path.join(f.dataDir, 'admin/config'), 'utf8'), 'preserved')
})

for (const failure of ['unbound-root', 'changed-target', 'changed-during-recovery', 'old-source', 'corrupt-backup']) {
  test('an immutable recovery target cannot be substituted: ' + failure, async t => {
    const f = await fixture(t), target = await immutableTarget(f), { lock, record } = await f.begin()
    await bindVersionMaintenanceTarget(f.dataDir, record.id, target)
    const backup = await createMaintenanceBackup(f.dataDir)
    await recordVersionMaintenanceBackup(f.dataDir, record.id, backup); await markVersionMaintenanceInstalling(f.dataDir, record.id)
    releaseCliLock(lock)
    let root = target
    if (failure === 'unbound-root') root = await immutableTarget(f, '未绑定副本')
    if (failure === 'old-source') root = f.root
    if (failure === 'corrupt-backup') await fs.appendFile(path.join(backup.directory, 'data/admin/config'), 'changed')
    async function changeTarget() {
      await fs.writeFile(path.join(target, 'different-build'), 'same version, other inventory')
      for (const file of ['core-files.json', 'core-release.json']) await fs.rm(path.join(target, file))
      await writeCoreRelease(target, { schema_version: 1, version: '1.2.4', platform: process.platform, arch: process.arch, commit: '3'.repeat(40), source_dirty: false })
    }
    if (failure === 'changed-target') await changeTarget()
    let ran = false
    await assert.rejects(recoverVersionMaintenance({ dataDir: f.dataDir, root, appVersion: failure === 'old-source' ? '1.2.3' : '1.2.4',
      verifyCompatible: async () => {}, run: async () => { ran = true; if (failure === 'changed-during-recovery') await changeTarget(); return true } }))
    assert.equal(ran, failure === 'changed-during-recovery')
    assert.equal(readVersionMaintenance(f.dataDir).id, record.id)
    assert.throws(() => assertVersionMaintenanceAllowsStart(f.dataDir), { code: 'CRABOT_MAINTENANCE_PENDING' })
    assert.equal(await fs.readFile(path.join(f.dataDir, 'admin/config'), 'utf8'), 'preserved')
  })
}


test('target binding requires the held operation lock and the declared target version', async t => {
  const f = await fixture(t), target = await immutableTarget(f)
  await assert.rejects(bindVersionMaintenanceTarget(f.dataDir, '00000000-0000-4000-8000-000000000000', target), { code: 'CRABOT_MAINTENANCE_PENDING' })
  const { lock, record } = await f.begin()
  await assert.rejects(bindVersionMaintenanceTarget(f.dataDir, record.id, f.root), { code: 'CRABOT_CORE_INTEGRITY' })
  assert.equal(readVersionMaintenance(f.dataDir).target_core, undefined)
  await bindVersionMaintenanceTarget(f.dataDir, record.id, target)
  releaseCliLock(lock)
  await assert.rejects(bindVersionMaintenanceTarget(f.dataDir, record.id, target), { code: 'CRABOT_MAINTENANCE_PENDING' })
})

for (const phase of ['preparing', 'backed_up']) test('safe pre-install cancellation preserves all data without starting or restoring: ' + phase, async t => {
  const f = await fixture(t), { lock, record } = await f.begin()
  try {
    if (phase === 'backed_up') await recordVersionMaintenanceBackup(f.dataDir, record.id, await createMaintenanceBackup(f.dataDir))
    await fs.writeFile(path.join(f.dataDir, 'admin/config'), 'keep-current-source-data')
    let checked = false
    assert.deepEqual(await cancelPreparedVersionMaintenance({ ...f, id: record.id, verifyCompatible: async () => { checked = true } }),
      { preparation_cancelled: true, service_started: false })
    assert.equal(checked, true); assert.equal(readVersionMaintenance(f.dataDir), null)
    assert.equal(await fs.readFile(path.join(f.dataDir, 'admin/config'), 'utf8'), 'keep-current-source-data')
    assert.equal(await fs.stat(path.join(f.dataDir, 'mm.pid')).catch(() => null), null)
  } finally { releaseCliLock(lock) }
})
test('pre-install cancellation refuses begun migration, incompatible source or an unknown identity', async t => {
  const f = await fixture(t), { lock, record } = await f.begin()
  try {
    await assert.rejects(cancelPreparedVersionMaintenance({ ...f, id: 'b'.repeat(36), verifyCompatible: () => assert.fail() }))
    await assert.rejects(cancelPreparedVersionMaintenance({ ...f, id: record.id, verifyCompatible: () => { throw new Error('data incompatible') } }), /data incompatible/)
    assert.equal(readVersionMaintenance(f.dataDir).phase, 'preparing')
    await recordVersionMaintenanceBackup(f.dataDir, record.id, await createMaintenanceBackup(f.dataDir))
    await markVersionMaintenanceInstalling(f.dataDir, record.id)
    await assert.rejects(cancelPreparedVersionMaintenance({ ...f, id: record.id, verifyCompatible: () => assert.fail('must not replay any migration') }))
    assert.equal(readVersionMaintenance(f.dataDir).phase, 'installing')
  } finally { releaseCliLock(lock) }
})

test('pre-install cancellation retains the fence if source changes during verification', async t => {
  const f = await fixture(t), { lock, record } = await f.begin()
  try {
    await assert.rejects(cancelPreparedVersionMaintenance({ ...f, id: record.id, verifyCompatible: () => fs.appendFile(path.join(f.root, 'package.json'), ' ') }), { code: 'CRABOT_CORE_INTEGRITY' })
    assert.equal(readVersionMaintenance(f.dataDir).phase, 'preparing')
  } finally { releaseCliLock(lock) }
})

test('a system preparation is linked to one deployment operation and cannot be cancelled by another', async t => {
  const f = await fixture(t), lock = await acquireCliLock(f.dataDir, 'system-operation-owner')
  const operation = '11111111-1111-1111-1111-111111111111'
  try {
    const record = await beginVersionMaintenance(f.dataDir, f.root, '1.2.4', undefined, { systemOperationId: operation })
    assert.equal(readVersionMaintenance(f.dataDir).system_operation_id, operation)
    await assert.rejects(cancelPreparedVersionMaintenance({ ...f, id: record.id, systemOperationId: '22222222-2222-2222-2222-222222222222', verifyCompatible: () => assert.fail() }))
    await cancelPreparedVersionMaintenance({ ...f, id: record.id, systemOperationId: operation, verifyCompatible: async () => {} })
    assert.equal(readVersionMaintenance(f.dataDir), null)
    await assert.rejects(beginVersionMaintenance(f.dataDir, f.root, '1.2.4', undefined, { systemOperationId: '../not-an-operation' }))
    assert.equal(readVersionMaintenance(f.dataDir), null)
  } finally { releaseCliLock(lock) }
})
