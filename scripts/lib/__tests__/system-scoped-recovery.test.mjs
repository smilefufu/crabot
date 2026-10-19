import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import management from '../desktop-management.cjs'
import { acquireCliLock, releaseCliLock } from '../cli-lock.mjs'
import { writeCoreRelease } from '../core-release.mjs'
import { beginVersionMaintenance, bindVersionMaintenanceTarget, assertVersionMaintenanceAllowsStart, readVersionMaintenance, prepareScopedVersionMaintenance, markVersionMaintenanceInstalling } from '../version-maintenance.mjs'
import { prepareSystemScopedRecovery, verifySystemScopedRecovery, cancelSystemScopedRecovery } from '../system-scoped-recovery.mjs'

const platformOptions = { skip: process.platform === 'win32' }
async function fixture(t, { shared = false } = {}) {
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
  await fs.writeFile(path.join(target, 'crabot-fixture/schema_version'), 'v2')
  await fs.writeFile(path.join(target, 'crabot-fixture/upgrade/scope.mjs'), "export const migrationScope=()=>({reads:['fixture/input'],writes:['fixture/content']})")
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
  for (const [directory, version] of [[source, '1.2.3'], [target, '1.2.4']]) await writeCoreRelease(directory,
    { schema_version: 1, version, platform: process.platform, arch: process.arch, commit: 'a'.repeat(40), source_dirty: false })
  await fs.mkdir(path.join(dataDir, 'fixture'))
  for (const [file, value] of [['SCHEMA_VERSION', 'v1'], ['input', 'fixed input'], ['content', 'before']]) await fs.writeFile(path.join(dataDir, 'fixture', file), value)
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
