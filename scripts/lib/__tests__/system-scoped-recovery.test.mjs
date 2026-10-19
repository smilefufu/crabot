import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import management from '../desktop-management.cjs'
import { acquireCliLock, releaseCliLock } from '../cli-lock.mjs'
import { writeCoreRelease } from '../core-release.mjs'
import { beginVersionMaintenance, bindVersionMaintenanceTarget, assertVersionMaintenanceAllowsStart, readVersionMaintenance, prepareScopedVersionMaintenance, markVersionMaintenanceInstalling } from '../version-maintenance.mjs'
import { prepareSystemScopedRecovery, verifySystemScopedRecovery, cancelSystemScopedRecovery } from '../system-scoped-recovery.mjs'

const platformOptions = { skip: process.platform === 'win32' }
async function fixture(t, { shared = false, changesAdmin = false, realAdmin = false, moduleUpdate = true } = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'system-scoped-recovery-')))
  const dataDir = management.ensurePrivateDataRoot(path.join(root, 'data')), source = path.join(root, 'source'), target = path.join(root, 'target')
  t.after(async () => { releaseCliLock(path.join(dataDir, 'cli.lock')); await fs.rm(root, { recursive: true, force: true }) })
  for (const [directory, version] of [[source, '1.2.3'], [target, '1.2.4']]) {
    await fs.mkdir(directory)
    await fs.writeFile(path.join(directory, 'package.json'), JSON.stringify({ version, type: 'module' }))
    await fs.writeFile(path.join(directory, 'product-runtime.json'), JSON.stringify({ version }))
  }
  await fs.mkdir(path.join(source, 'crabot-fixture'), { recursive: true })
  await fs.writeFile(path.join(source, 'crabot-fixture/schema_version'), 'v1')
  await fs.mkdir(path.join(target, 'crabot-fixture/upgrade'), { recursive: true })
  await fs.writeFile(path.join(target, 'crabot-fixture/schema_version'), moduleUpdate ? 'v2' : 'v1')
  await fs.writeFile(path.join(target, 'crabot-fixture/upgrade/scope.mjs'), `export const migrationScope=()=>(${JSON.stringify({ reads: ['fixture/input'], writes: ['fixture/content', ...(changesAdmin ? ['admin/session-configs.json'] : [])] })})`)
  await fs.writeFile(path.join(target, 'crabot-fixture/upgrade/from_v1_to_v2.mjs'), '// no script is executed by recovery preparation')
  if (shared) {
    const readers = {
      'crabot-agent/shared_request_version': '1',
      'crabot-agent/dist/workers/harness/context-store.js': 'export class WorkerContextStore {}',
      'crabot-agent/dist/manager/trusted-human-input-store.js': 'export class TrustedHumanInputStore {}',
      'crabot-agent/dist/manager/conversation-request-store.js': 'export class ConversationRequestStore {}',
      'crabot-agent/dist/workers/harness/request-guard.js': 'export class WorkerRequestGuard {}',
      'crabot-admin/dist/shared-request-impact.js': 'export async function buildSharedRequestImpact(){return {pending_requests:0}}',
    }
    for (const [file, content] of Object.entries(readers)) {
      for (const directory of [source, target]) {
        await fs.mkdir(path.dirname(path.join(directory, file)), { recursive: true }); await fs.writeFile(path.join(directory, file), content)
      }
    }
    await fs.mkdir(path.join(dataDir, 'agent/worker-ledgers'), { recursive: true })
    await fs.writeFile(path.join(dataDir, 'agent/worker-ledgers/channel%3A%3Agroup.json'), JSON.stringify({ manager_key: 'channel::group', workers: [] }))
  }
  if (realAdmin) {
    const repository = fileURLToPath(new URL('../../../', import.meta.url))
    for (const file of ['crabot-admin/schema_version', 'crabot-admin/upgrade/scope.mjs', 'crabot-admin/upgrade/legacy-directory-inputs.mjs', 'crabot-admin/upgrade/from_v0_to_v1.mjs', 'scripts/upgrade-lib/scoped-data.mjs']) {
      await fs.mkdir(path.dirname(path.join(target, file)), { recursive: true })
      await fs.copyFile(path.join(repository, file), path.join(target, file))
    }
    await fs.writeFile(path.join(target, 'crabot-admin/package.json'), JSON.stringify({ type: 'commonjs' }))
    // Use the production permission planner; other metadata readers still use
    // the explicitly empty-ledger fixture above. This is not a full Core boot.
    await fs.writeFile(path.join(target, 'crabot-admin/dist/legacy-directory-migration.js'),
      'module.exports=require(' + JSON.stringify(path.join(repository, 'crabot-admin/dist/legacy-directory-migration.js')) + ')')
    await fs.writeFile(path.join(target, 'crabot-admin/dist/shared-request-impact.js'),
      'exports.buildSharedRequestImpact=require(' + JSON.stringify(path.join(repository, 'crabot-admin/dist/shared-request-impact.js')) + ').buildSharedRequestImpact')
    await fs.mkdir(path.join(dataDir, 'admin'), { recursive: true })
    const storage = { workspace_path: '/limited', access: 'read' }
    const groups = ['old', 'restricted'].map(session_id => ({ channel_id: 'channel', session_id,
      config: { tool_access: { file_io: true, shell: true }, storage: session_id === 'old' ? null : storage, updated_at: '2026-10-19T00:00:00.000Z' } }))
    await fs.writeFile(path.join(dataDir, 'admin/session-configs.json'), JSON.stringify(groups))
    await fs.writeFile(path.join(dataDir, 'admin/friends.json'), JSON.stringify([{ id: 'inherited', permission: 'normal', channel_identities: [] }]))
  }
  for (const [directory, version] of [[source, '1.2.3'], [target, '1.2.4']]) await writeCoreRelease(directory,
    { schema_version: 1, version, platform: process.platform, arch: process.arch, commit: 'a'.repeat(40), source_dirty: false })
  await fs.mkdir(path.join(dataDir, 'fixture'))
  for (const [file, value] of [['SCHEMA_VERSION', 'v1'], ['input', 'fixed input'], ['content', 'before']]) await fs.writeFile(path.join(dataDir, 'fixture', file), value)
  if (changesAdmin) {
    await fs.mkdir(path.join(dataDir, 'admin'), { recursive: true })
    await fs.writeFile(path.join(dataDir, 'admin/session-configs.json'), JSON.stringify([{ channel_id: 'channel', session_id: 'group', config: { storage: null } }]))
  }
  const lock = await acquireCliLock(dataDir, 'system-scoped-recovery-test'), operationId = randomUUID()
  const record = await beginVersionMaintenance(dataDir, source, '1.2.4', undefined, { systemOperationId: operationId, dataProtection: 'scoped' })
  const bound = await bindVersionMaintenanceTarget(dataDir, record.id, target)
  return { root, dataDir, source, target, lock, operationId, record, options: { dataDir, sourceRoot: source, targetRoot: target, operationId, maintenanceId: record.id, sourceInventory: record.source_inventory_sha256, targetInventory: bound.target_core.inventory_sha256 } }
}
test('employee recovery preparation binds real common material without a broad snapshot or data conversion', platformOptions, async t => {
  const f = await fixture(t), receipt = await prepareSystemScopedRecovery(f.options)
  assert.equal(receipt.id, f.record.id); assert.match(receipt.sha256, /^[a-f0-9]{64}$/)
  await verifySystemScopedRecovery({ ...f.options, receipt })
  assert.equal(await fs.readFile(path.join(f.dataDir, 'fixture/content'), 'utf8'), 'before')
  assert.equal(await fs.readFile(path.join(f.dataDir, 'fixture/SCHEMA_VERSION'), 'utf8'), 'v1')
  assert.equal(await fs.readFile(path.join(f.dataDir, '.upgrade-migrations/crabot-fixture-v1-v2/backup/fixture/content'), 'utf8'), 'before')
  await assert.rejects(fs.stat(f.dataDir + '.desktop-backups'), { code: 'ENOENT' })
  await assert.rejects(prepareSystemScopedRecovery(f.options))
})
for (const changed of ['operation', 'source-id', 'target-id', 'receipt', 'backup', 'current-data', 'target']) {
  test('employee recovery rejects changed binding or evidence: ' + changed, platformOptions, async t => {
    const f = await fixture(t), receipt = await prepareSystemScopedRecovery(f.options), options = { ...f.options, receipt }
    if (changed === 'operation') options.operationId = randomUUID()
    if (changed === 'source-id') options.sourceInventory = 'c'.repeat(64)
    if (changed === 'target-id') options.targetInventory = 'c'.repeat(64)
    if (changed === 'receipt') options.receipt = { ...receipt, sha256: 'b'.repeat(64) }
    if (changed === 'backup') await fs.writeFile(path.join(f.dataDir, '.upgrade-migrations/crabot-fixture-v1-v2/backup/fixture/content'), 'corrupt')
    if (changed === 'current-data') await fs.writeFile(path.join(f.dataDir, 'fixture/content'), 'changed')
    if (changed === 'target') await fs.appendFile(path.join(f.target, 'package.json'), ' ')
    await assert.rejects(verifySystemScopedRecovery(options))
    assert.equal(await fs.readFile(path.join(f.dataDir, 'fixture/SCHEMA_VERSION'), 'utf8'), 'v1')
  })
}
test('a lost lifecycle lock cannot prepare data or publish a recovery reference', platformOptions, async t => {
  const f = await fixture(t); releaseCliLock(f.lock)
  await assert.rejects(prepareSystemScopedRecovery(f.options))
  await assert.rejects(fs.stat(path.join(f.dataDir, '.upgrade-migrations')), { code: 'ENOENT' })
})

test('failed scoped backup retains its intent and the original startup fence without granting a receipt', platformOptions, async t => {
  const f = await fixture(t)
  const copy = t.mock.method(fs, 'copyFile', async () => { throw Object.assign(new Error('disk fault'), { code: 'EIO' }) })
  try { await assert.rejects(prepareSystemScopedRecovery(f.options), /disk fault/) }
  finally { copy.mock.restore() }
  const directory = path.join(f.dataDir, 'system-control/scoped-recovery', f.record.id)
  const intent = JSON.parse(await fs.readFile(path.join(directory, 'intent.json'), 'utf8'))
  assert.equal(intent.operation_id, f.operationId)
  await assert.rejects(fs.stat(path.join(directory, 'prepared.json')), { code: 'ENOENT' })
  assert.equal(await fs.readFile(path.join(f.dataDir, 'fixture/content'), 'utf8'), 'before')
  assert.equal(await fs.readFile(path.join(f.dataDir, 'fixture/SCHEMA_VERSION'), 'utf8'), 'v1')
  assert.throws(() => assertVersionMaintenanceAllowsStart(f.dataDir), { code: 'CRABOT_MAINTENANCE_PENDING' })
})

test('shared ledger recovery is referenced without conversion using empty metadata-reader fixtures', platformOptions, async t => {
  const f = await fixture(t, { shared: true }), receipt = await prepareSystemScopedRecovery(f.options)
  const ledger = path.join(f.dataDir, 'agent/worker-ledgers/channel%3A%3Agroup.json')
  assert.deepEqual(JSON.parse(await fs.readFile(ledger, 'utf8')), { manager_key: 'channel::group', workers: [] })
  await assert.rejects(fs.stat(path.join(f.dataDir, 'agent/shared-request-upgrade.json')), { code: 'ENOENT' })
  await verifySystemScopedRecovery({ ...f.options, receipt })
  const backup = path.join(f.dataDir, 'shared-request-upgrade-v2/backup/agent/worker-ledgers/channel%3A%3Agroup.json')
  assert.equal(await fs.readFile(backup, 'utf8'), await fs.readFile(ledger, 'utf8'))
  await fs.writeFile(backup, '{}')
  await assert.rejects(verifySystemScopedRecovery({ ...f.options, receipt }))
})
for (const link of ['symbolic-directory', 'hardlinked-file']) {
  test('recovery references cannot follow a substituted material: ' + link, platformOptions, async t => {
    const f = await fixture(t), receipt = await prepareSystemScopedRecovery(f.options)
    const backup = path.join(f.dataDir, '.upgrade-migrations/crabot-fixture-v1-v2/backup')
    if (link === 'symbolic-directory') {
      const outside = path.join(f.root, 'retained-backup'); await fs.rename(backup, outside); await fs.symlink(outside, backup, 'dir')
    } else {
      const file = path.join(backup, 'fixture/content'); await fs.unlink(file); await fs.link(path.join(f.dataDir, 'fixture/content'), file)
    }
    await assert.rejects(verifySystemScopedRecovery({ ...f.options, receipt }))
    assert.equal(await fs.readFile(path.join(f.dataDir, 'fixture/content'), 'utf8'), 'before')
  })
}
test('a recovery-material flush failure cannot publish a prepared receipt', platformOptions, async t => {
  const f = await fixture(t), open = fs.open
  const fault = t.mock.method(fs, 'open', async (file, ...args) => {
    const handle = await open(file, ...args)
    if (String(file).endsWith(path.join('backup', 'fixture', 'content'))) handle.sync = async () => { throw Object.assign(new Error('backup flush failed'), { code: 'EIO' }) }
    return handle
  })
  try { await assert.rejects(prepareSystemScopedRecovery(f.options), /backup flush failed/) }
  finally { fault.mock.restore() }
  await assert.rejects(fs.stat(path.join(f.dataDir, 'system-control/scoped-recovery', f.record.id, 'prepared.json')), { code: 'ENOENT' })
  assert.equal(await fs.readFile(path.join(f.dataDir, 'fixture/content'), 'utf8'), 'before')
  assert.throws(() => assertVersionMaintenanceAllowsStart(f.dataDir), { code: 'CRABOT_MAINTENANCE_PENDING' })
})

test('a live writer blocks recovery preparation before any material or intent is created', platformOptions, async t => {
  const f = await fixture(t)
  await fs.writeFile(path.join(f.dataDir, 'mm.pid'), String(process.pid))
  await assert.rejects(prepareSystemScopedRecovery(f.options), /Stop Crabot/)
  for (const directory of ['.upgrade-migrations', 'system-control/scoped-recovery']) await assert.rejects(fs.stat(path.join(f.dataDir, directory)), { code: 'ENOENT' })
  assert.equal(await fs.readFile(path.join(f.dataDir, 'fixture/content'), 'utf8'), 'before')
})
test('new authority metadata after preparation invalidates the shared recovery reference', platformOptions, async t => {
  const f = await fixture(t, { shared: true }), receipt = await prepareSystemScopedRecovery(f.options)
  await fs.writeFile(path.join(f.dataDir, 'agent/worker-ledgers/channel%3A%3Anew.json'), JSON.stringify({ manager_key: 'channel::new', workers: [] }))
  await assert.rejects(verifySystemScopedRecovery({ ...f.options, receipt }))
  await assert.rejects(fs.stat(path.join(f.dataDir, 'agent/shared-request-upgrade.json')), { code: 'ENOENT' })
})

test('pre-install cancellation preserves current business bytes and archives even a damaged unused backup', platformOptions, async t => {
  const f = await fixture(t), receipt = await prepareSystemScopedRecovery(f.options)
  const backup = path.join(f.dataDir, '.upgrade-migrations/crabot-fixture-v1-v2/backup/fixture/content')
  await fs.writeFile(backup, 'damaged material')
  assert.deepEqual(await cancelSystemScopedRecovery({ ...f.options, receipt }), { preparation_cancelled: true, service_started: false })
  assert.equal(readVersionMaintenance(f.dataDir), null)
  assert.equal(await fs.readFile(path.join(f.dataDir, 'fixture/content'), 'utf8'), 'before')
  const retained = path.join(f.dataDir, 'system-control/scoped-recovery', f.record.id, 'retained/module-crabot-fixture-v1-v2/backup/fixture/content')
  assert.equal(await fs.readFile(retained, 'utf8'), 'damaged material')
  assert.deepEqual(await cancelSystemScopedRecovery({ ...f.options, receipt }), { preparation_cancelled: true, service_started: false })
})
test('a backup failure before any conversion can cancel using its fixed original intent', platformOptions, async t => {
  const f = await fixture(t), copy = t.mock.method(fs, 'copyFile', async () => { throw new Error('copy failed') })
  try { await assert.rejects(prepareSystemScopedRecovery(f.options), /copy failed/) } finally { copy.mock.restore() }
  assert.deepEqual(await cancelSystemScopedRecovery(f.options), { preparation_cancelled: true, service_started: false })
  assert.equal(readVersionMaintenance(f.dataDir), null)
  assert.equal(await fs.readFile(path.join(f.dataDir, 'fixture/content'), 'utf8'), 'before')
  await assert.rejects(fs.stat(path.join(f.dataDir, '.upgrade-migrations/crabot-fixture-v1-v2')), { code: 'ENOENT' })
})
test('current data changes prevent cancellation without restoring bytes or moving evidence', platformOptions, async t => {
  const f = await fixture(t), receipt = await prepareSystemScopedRecovery(f.options)
  await fs.writeFile(path.join(f.dataDir, 'fixture/content'), 'current change')
  await assert.rejects(cancelSystemScopedRecovery({ ...f.options, receipt }))
  assert.equal(readVersionMaintenance(f.dataDir).id, f.record.id)
  assert.equal(await fs.readFile(path.join(f.dataDir, 'fixture/content'), 'utf8'), 'current change')
  await fs.stat(path.join(f.dataDir, '.upgrade-migrations/crabot-fixture-v1-v2'))
})
test('a converted or installing result is never undone by preparation cancellation', platformOptions, async t => {
  const f = await fixture(t), receipt = await prepareSystemScopedRecovery(f.options)
  const file = path.join(f.dataDir, '.upgrade-migrations/crabot-fixture-v1-v2/state.json'), state = JSON.parse(await fs.readFile(file, 'utf8'))
  await fs.writeFile(file, JSON.stringify({ ...state, phase: 'converted' }))
  await assert.rejects(cancelSystemScopedRecovery({ ...f.options, receipt }))
  await fs.writeFile(file, JSON.stringify(state))
  await prepareScopedVersionMaintenance(f.dataDir, f.record.id); await markVersionMaintenanceInstalling(f.dataDir, f.record.id)
  await assert.rejects(cancelSystemScopedRecovery({ ...f.options, receipt }))
  assert.equal(readVersionMaintenance(f.dataDir).phase, 'installing')
  assert.equal(await fs.readFile(path.join(f.dataDir, 'fixture/content'), 'utf8'), 'before')
})
test('cancellation resumes the same archive after rename succeeds but its result is lost', platformOptions, async t => {
  const f = await fixture(t), receipt = await prepareSystemScopedRecovery(f.options), rename = fs.rename
  let injected = false
  const fault = t.mock.method(fs, 'rename', async (from, to) => {
    await rename(from, to)
    if (!injected && path.basename(String(to)).startsWith('module-')) { injected = true; throw new Error('archive result lost') }
  })
  try { await assert.rejects(cancelSystemScopedRecovery({ ...f.options, receipt }), /archive result lost/) }
  finally { fault.mock.restore() }
  assert.equal(injected, true); assert.equal(readVersionMaintenance(f.dataDir).id, f.record.id)
  assert.deepEqual(await cancelSystemScopedRecovery({ ...f.options, receipt }), { preparation_cancelled: true, service_started: false })
  assert.equal(readVersionMaintenance(f.dataDir), null)
  assert.equal(await fs.readFile(path.join(f.dataDir, 'fixture/content'), 'utf8'), 'before')
})
test('cancellation before material preparation clears only the verified source maintenance', platformOptions, async t => {
  const f = await fixture(t)
  assert.deepEqual(await cancelSystemScopedRecovery(f.options), { preparation_cancelled: true, service_started: false })
  assert.equal(readVersionMaintenance(f.dataDir), null)
  assert.equal(await fs.readFile(path.join(f.dataDir, 'fixture/content'), 'utf8'), 'before')
  await assert.rejects(fs.stat(path.join(f.dataDir, '.upgrade-migrations')), { code: 'ENOENT' })
})


test('unfinished shared conversion is never adopted as untouched preparation or archived by cancellation', platformOptions, async t => {
  const f = await fixture(t, { shared: true })
  releaseCliLock(f.lock)
  const helper = new URL('../../upgrade-lib/shared-requests.mjs', import.meta.url).href
  const code = `import { prepareSharedRequests } from ${JSON.stringify(helper)}; await prepareSharedRequests(${JSON.stringify(f.target)}, ${JSON.stringify(f.dataDir)}, console, { afterConvert() { process.exit(41) } })`
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', timeout: 10_000 })
  assert.equal(child.status, 41, child.stderr)
  await acquireCliLock(f.dataDir, 'system-scoped-recovery-test')
  const transaction = path.join(f.dataDir, 'shared-request-upgrade-v2')
  const plan = await fs.readFile(path.join(transaction, 'plan.json'), 'utf8')
  const ledger = path.join(f.dataDir, 'agent/worker-ledgers/channel%3A%3Agroup.json')
  const partial = await fs.readFile(ledger, 'utf8')
  await assert.rejects(prepareSystemScopedRecovery(f.options))
  await assert.rejects(cancelSystemScopedRecovery(f.options))
  assert.equal(await fs.readFile(path.join(transaction, 'plan.json'), 'utf8'), plan)
  assert.equal(await fs.readFile(ledger, 'utf8'), partial)
  assert.equal(readVersionMaintenance(f.dataDir).id, f.record.id)
  await assert.rejects(fs.stat(path.join(f.dataDir, 'system-control/scoped-recovery', f.record.id, 'retained')), { code: 'ENOENT' })
})


test('cancellation finalizes its own journal after fence removal succeeds but final publication fails', platformOptions, async t => {
  const f = await fixture(t), receipt = await prepareSystemScopedRecovery(f.options)
  const rename = fs.rename
  let injected = false
  const fault = t.mock.method(fs, 'rename', async (from, to) => {
    if (!injected && to.endsWith('/cancel.json') && JSON.parse(await fs.readFile(from, 'utf8')).phase === 'completed') {
      injected = true
      throw Object.assign(new Error('final publication lost'), { code: 'EIO' })
    }
    return rename(from, to)
  })
  try { await assert.rejects(cancelSystemScopedRecovery({ ...f.options, receipt }), /final publication lost/) }
  finally { fault.mock.restore() }
  assert.equal(injected, true)
  assert.equal(readVersionMaintenance(f.dataDir), null)
  assert.deepEqual(await cancelSystemScopedRecovery({ ...f.options, receipt }), { preparation_cancelled: true, service_started: false })
  assert.equal(await fs.readFile(path.join(f.dataDir, 'fixture/content'), 'utf8'), 'before')
})
for (const changed of ['source', 'running']) {
  test('cancellation keeps its fence when the selected source cannot be proved safe: ' + changed, platformOptions, async t => {
    const f = await fixture(t), receipt = await prepareSystemScopedRecovery(f.options)
    if (changed === 'source') await fs.appendFile(path.join(f.source, 'package.json'), ' ')
    else await fs.writeFile(path.join(f.dataDir, 'mm.pid'), String(process.pid))
    await assert.rejects(cancelSystemScopedRecovery({ ...f.options, receipt }))
    assert.equal(readVersionMaintenance(f.dataDir).id, f.record.id)
    assert.equal(await fs.readFile(path.join(f.dataDir, 'fixture/content'), 'utf8'), 'before')
    await assert.rejects(fs.stat(path.join(f.dataDir, 'system-control/scoped-recovery', f.record.id, 'retained')), { code: 'ENOENT' })
  })
}


test('prepared system execution seals shared requests before changing their Admin metadata and reuses its backups', platformOptions, async t => {
  const f = await fixture(t, { shared: true, changesAdmin: true }), receipt = await prepareSystemScopedRecovery(f.options)
  const { executeSystemScopedMigrations, verifyCompletedSystemScopedRecovery } = await import('../system-scoped-recovery.mjs')
  await prepareScopedVersionMaintenance(f.dataDir, f.record.id)
  await markVersionMaintenanceInstalling(f.dataDir, f.record.id)
  const { completeStoppedVersionMaintenance } = await import('../version-maintenance.mjs')
  let calls = 0
  const copy = t.mock.method(fs, 'copyFile', async () => { throw new Error('duplicate backup during execution') })
  try {
    await completeStoppedVersionMaintenance({ dataDir: f.dataDir, root: f.target, id: f.record.id,
      migrate: () => executeSystemScopedMigrations({ ...f.options, receipt }, async () => {
        calls++
        const ready = JSON.parse(await fs.readFile(path.join(f.dataDir, 'agent/shared-request-upgrade.json'), 'utf8'))
        assert.equal(ready.status, 'ready')
        await fs.writeFile(path.join(f.dataDir, 'admin/session-configs.json'), JSON.stringify([{ channel_id: 'channel', session_id: 'group', config: { storage: { scope: 'all', access: 'readwrite' } } }]))
        await fs.writeFile(path.join(f.dataDir, 'fixture/content'), 'converted')
        return { exitCode: 0 }
      }), verifyComplete: () => verifyCompletedSystemScopedRecovery({ ...f.options, receipt }) })
  } finally { copy.mock.restore() }
  assert.equal(calls, 1)
  assert.equal(readVersionMaintenance(f.dataDir), null)
  assert.equal(await fs.readFile(path.join(f.dataDir, 'fixture/content'), 'utf8'), 'converted')
  assert.equal(await fs.readFile(path.join(f.dataDir, 'fixture/SCHEMA_VERSION'), 'utf8'), 'v2\n')
  await verifyCompletedSystemScopedRecovery({ ...f.options, receipt })
  await assert.rejects(executeSystemScopedMigrations({ ...f.options, receipt }, async () => { throw new Error('must not repeat') }))
  await assert.rejects(fs.stat(f.dataDir + '.desktop-backups'), { code: 'ENOENT' })
})


test('real Admin scope script preserves explicit limits while shared preparation uses the original null permissions', platformOptions, async t => {
  const f = await fixture(t, { shared: true, realAdmin: true }), receipt = await prepareSystemScopedRecovery(f.options)
  const { executeSystemScopedMigrations, verifyCompletedSystemScopedRecovery } = await import('../system-scoped-recovery.mjs')
  const { completeStoppedVersionMaintenance } = await import('../version-maintenance.mjs')
  const sharedPlan = path.join(f.dataDir, 'shared-request-upgrade-v2/plan.json'), preparedBytes = await fs.readFile(sharedPlan, 'utf8')
  const originalGroups = JSON.parse(await fs.readFile(path.join(f.dataDir, 'admin/session-configs.json'), 'utf8'))
  await prepareScopedVersionMaintenance(f.dataDir, f.record.id); await markVersionMaintenanceInstalling(f.dataDir, f.record.id)
  const scripts = []
  const copy = t.mock.method(fs, 'copyFile', async () => { throw new Error('a second backup must not be made') })
  try {
    await completeStoppedVersionMaintenance({ dataDir: f.dataDir, root: f.target, id: f.record.id,
      migrate: () => executeSystemScopedMigrations({ ...f.options, receipt }, async (script, directory, context) => {
        assert.equal(JSON.parse(await fs.readFile(path.join(f.dataDir, 'agent/shared-request-upgrade.json'), 'utf8')).status, 'ready')
        const child = spawnSync(process.execPath, [script, '--data-dir=' + directory], { env: { ...process.env,
          CRABOT_MIGRATION_PLAN: context.plan, CRABOT_MIGRATION_PLAN_SHA256: context.planSha256 }, encoding: 'utf8', timeout: 10_000 })
        assert.equal(child.status, 0, child.stderr); scripts.push(path.basename(script))
        return { exitCode: child.status }
      }), verifyComplete: () => verifyCompletedSystemScopedRecovery({ ...f.options, receipt }) })
  } finally { copy.mock.restore() }
  assert.deepEqual(scripts, ['from_v0_to_v1.mjs', 'from_v1_to_v2.mjs'])
  const groups = JSON.parse(await fs.readFile(path.join(f.dataDir, 'admin/session-configs.json'), 'utf8'))
  assert.match(groups[0].config.updated_at, /^\d{4}-\d{2}-\d{2}T/)
  assert.deepEqual(groups[0].config, { ...originalGroups[0].config, storage: { scope: 'all', access: 'readwrite' }, updated_at: groups[0].config.updated_at })
  assert.deepEqual(groups[1], originalGroups[1])
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(f.dataDir, 'admin/friend-permission-configs.json'), 'utf8')), [{ friend_id: 'inherited', storage_override: { scope: 'all', access: 'readwrite' } }])
  assert.equal(await fs.readFile(sharedPlan, 'utf8'), preparedBytes)
  assert.equal(await fs.readFile(path.join(f.dataDir, 'admin/SCHEMA_VERSION'), 'utf8'), 'v1\n')
  assert.equal(readVersionMaintenance(f.dataDir), null)
  await verifyCompletedSystemScopedRecovery({ ...f.options, receipt })
})


async function executeFixture(f, receipt, runScript) {
  const { executeSystemScopedMigrations, verifyCompletedSystemScopedRecovery } = await import('../system-scoped-recovery.mjs')
  const { completeStoppedVersionMaintenance } = await import('../version-maintenance.mjs')
  await prepareScopedVersionMaintenance(f.dataDir, f.record.id); await markVersionMaintenanceInstalling(f.dataDir, f.record.id)
  return completeStoppedVersionMaintenance({ dataDir: f.dataDir, root: f.target, id: f.record.id,
    migrate: () => executeSystemScopedMigrations({ ...f.options, receipt }, runScript),
    verifyComplete: () => verifyCompletedSystemScopedRecovery({ ...f.options, receipt }) })
}
test('a migration failure retains the execution claim and cannot dispatch the scripts again', platformOptions, async t => {
  const f = await fixture(t, { shared: true }), receipt = await prepareSystemScopedRecovery(f.options)
  const { executeSystemScopedMigrations, verifyCompletedSystemScopedRecovery } = await import('../system-scoped-recovery.mjs')
  let calls = 0
  await assert.rejects(executeFixture(f, receipt, async () => {
    calls++; await fs.writeFile(path.join(f.dataDir, 'fixture/content'), 'partial conversion'); return { exitCode: 13 }
  }), { code: 'CRABOT_MIGRATION_FAILED' })
  assert.equal(readVersionMaintenance(f.dataDir).phase, 'verifying')
  assert.equal(await fs.readFile(path.join(f.dataDir, 'fixture/content'), 'utf8'), 'before')
  await assert.rejects(executeSystemScopedMigrations({ ...f.options, receipt }, async () => { calls++; return { exitCode: 0 } }))
  await assert.rejects(verifyCompletedSystemScopedRecovery({ ...f.options, receipt }))
  assert.equal(calls, 1)
})
test('converted files must be durable before a completion receipt is published', platformOptions, async t => {
  const f = await fixture(t), receipt = await prepareSystemScopedRecovery(f.options), open = fs.open
  const fault = t.mock.method(fs, 'open', async (file, ...args) => {
    const handle = await open(file, ...args)
    if (String(file) === path.join(f.dataDir, 'fixture/content')) handle.sync = async () => { throw new Error('converted data flush failed') }
    return handle
  })
  try { await assert.rejects(executeFixture(f, receipt, async () => ({ exitCode: 0 })), /converted data flush failed/) }
  finally { fault.mock.restore() }
  assert.equal(readVersionMaintenance(f.dataDir).phase, 'verifying')
  await assert.rejects(fs.stat(path.join(f.dataDir, 'system-control/scoped-recovery', f.record.id, 'completed.json')), { code: 'ENOENT' })
})
for (const changed of ['material', 'module-state', 'schema', 'shared-marker', 'receipt']) {
  test('offline completion proof rejects changed evidence: ' + changed, platformOptions, async t => {
    const f = await fixture(t, { shared: true }), receipt = await prepareSystemScopedRecovery(f.options)
    await executeFixture(f, receipt, async () => ({ exitCode: 0 }))
    const { verifyCompletedSystemScopedRecovery } = await import('../system-scoped-recovery.mjs')
    const base = path.join(f.dataDir, '.upgrade-migrations/crabot-fixture-v1-v2')
    if (changed === 'material') await fs.writeFile(path.join(base, 'backup/fixture/content'), 'damaged')
    if (changed === 'module-state') {
      const state = JSON.parse(await fs.readFile(path.join(base, 'state.json'), 'utf8')); state.phase = 'prepared'
      await fs.writeFile(path.join(base, 'state.json'), JSON.stringify(state))
    }
    if (changed === 'schema') await fs.writeFile(path.join(f.dataDir, 'fixture/SCHEMA_VERSION'), 'v3')
    if (changed === 'shared-marker') await fs.appendFile(path.join(f.dataDir, 'agent/shared-request-upgrade.json'), ' ')
    const expected = changed === 'receipt' ? { ...receipt, sha256: 'c'.repeat(64) } : receipt
    await assert.rejects(verifyCompletedSystemScopedRecovery({ ...f.options, receipt: expected }))
  })
}


test('execution claim must be durable before even the shared request conversion begins', platformOptions, async t => {
  const f = await fixture(t, { shared: true }), receipt = await prepareSystemScopedRecovery(f.options), open = fs.open
  let calls = 0
  const fault = t.mock.method(fs, 'open', async (file, ...args) => {
    const handle = await open(file, ...args)
    if (String(file).endsWith('/execution.json')) handle.sync = async () => { throw new Error('dispatch claim flush failed') }
    return handle
  })
  try { await assert.rejects(executeFixture(f, receipt, async () => { calls++; return { exitCode: 0 } }), /dispatch claim flush failed/) }
  finally { fault.mock.restore() }
  assert.equal(calls, 0)
  const ledger = JSON.parse(await fs.readFile(path.join(f.dataDir, 'agent/worker-ledgers/channel%3A%3Agroup.json'), 'utf8'))
  assert.equal(ledger.schema_version, undefined)
  assert.equal(readVersionMaintenance(f.dataDir).phase, 'verifying')
  await assert.rejects(fs.stat(path.join(f.dataDir, 'agent/shared-request-upgrade.json')), { code: 'ENOENT' })
})
test('lost completion publication never clears the maintenance fence or repeats a finished conversion', platformOptions, async t => {
  const f = await fixture(t), receipt = await prepareSystemScopedRecovery(f.options), rename = fs.rename
  let calls = 0
  const fault = t.mock.method(fs, 'rename', async (from, to) => {
    await rename(from, to)
    if (String(to).endsWith('/completed.json')) throw new Error('completion publication result lost')
  })
  try { await assert.rejects(executeFixture(f, receipt, async () => { calls++; return { exitCode: 0 } }), /completion publication result lost/) }
  finally { fault.mock.restore() }
  assert.equal(readVersionMaintenance(f.dataDir).phase, 'verifying')
  assert.throws(() => assertVersionMaintenanceAllowsStart(f.dataDir), { code: 'CRABOT_MAINTENANCE_PENDING' })
  const { executeSystemScopedMigrations } = await import('../system-scoped-recovery.mjs')
  await assert.rejects(executeSystemScopedMigrations({ ...f.options, receipt }, async () => { calls++; return { exitCode: 0 } }))
  assert.equal(calls, 1)
})


test('code-only shared deployment creates no business backup and keeps the service stopped', platformOptions, async t => {
  const f = await fixture(t, { moduleUpdate: false }), receipt = await prepareSystemScopedRecovery(f.options)
  await executeFixture(f, receipt, async () => { throw new Error('code-only switch must not dispatch a migration') })
  assert.equal(readVersionMaintenance(f.dataDir), null)
  assert.equal(await fs.readFile(path.join(f.dataDir, 'fixture/content'), 'utf8'), 'before')
  await assert.rejects(fs.stat(path.join(f.dataDir, '.upgrade-migrations')), { code: 'ENOENT' })
  await assert.rejects(fs.stat(f.dataDir + '.desktop-backups'), { code: 'ENOENT' })
  await assert.rejects(fs.stat(path.join(f.dataDir, 'mm.pid')), { code: 'ENOENT' })
})
