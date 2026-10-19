// Employee-UID data component. The caller authenticates the immutable shared
// installation and Root operation first. These receipts never authorize a start.
import fs from 'node:fs/promises'
import { constants, realpathSync } from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import management from './desktop-management.cjs'
import { cliLockToken } from './cli-lock.mjs'
import { readVersionMaintenance, cancelPreparedVersionMaintenance } from './version-maintenance.mjs'
import { verifyCoreRelease } from './core-release.mjs'
import { verifyDataCompatibility } from './core-preparation.mjs'
import cliLocation from './cli-location.cjs'
import { previewMigrations } from '../upgrade-lib/migrate.mjs'
import { describeScopedPreparation } from '../upgrade-lib/scoped-preparation.mjs'
import { prepareMigration, executeMigration } from '../upgrade-lib/migration-transaction.mjs'
import { prepareSharedRequests, previewSharedRequests } from '../upgrade-lib/shared-requests.mjs'
import { ledgerValue } from '../upgrade-lib/shared-requests-v1.mjs'
import { snapshot, sameSnapshot, verifyBackup, writeAtomic, assertStopped, scopedPath } from '../upgrade-lib/scoped-data.mjs'
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value)
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const fail = () => { throw Object.assign(new Error('本人范围恢复材料无法核验，原文件和维护保护已保留。'), { code: 'CRABOT_SYSTEM_SCOPED_RECOVERY' }) }
function context(options) {
  if (!process.getuid || process.getuid() === 0 || !uuid(options.maintenanceId) || !uuid(options.operationId) || !hash(options.sourceInventory) || !hash(options.targetInventory)) fail()
  const dataDir = management.requirePrivateDataRoot(options.dataDir), targetRoot = realpathSync(options.targetRoot)
  if (!cliLockToken(path.join(dataDir, 'cli.lock'))) fail()
  const directory = path.join(dataDir, 'system-control/scoped-recovery', options.maintenanceId)
  return { dataDir, targetRoot, directory }
}
async function safeParents(root, file) {
  const relative = path.relative(root, file)
  if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) fail()
  let current = root
  for (const part of relative.split(path.sep).slice(0, -1)) {
    current = path.join(current, part)
    const stat = await fs.lstat(current)
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || stat.mode & 0o022) fail()
  }
}
async function readDocument(root, file) {
  await safeParents(root, file)
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o600 || stat.nlink !== 1 || stat.size > 64 * 1024 * 1024) fail()
    const bytes = await handle.readFile(), value = JSON.parse(bytes)
    return { value, sha256: digest(bytes) }
  } finally { await handle.close() }
}
async function syncDirectory(directory) {
  const handle = await fs.open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try {
    const stat = await handle.stat()
    if (!stat.isDirectory() || stat.uid !== process.getuid()) fail()
    await handle.sync()
  } finally { await handle.close() }
}
async function publishDocument(file, value) {
  await writeAtomic(file, JSON.stringify(value) + '\n')
  await syncDirectory(path.dirname(file))
}

async function verifyTarget(root, expected) {
  const release = await verifyCoreRelease(root)
  if (release.inventory_sha256 !== expected) fail()
}
async function verifyMaterial(dataDir, directory, scope, original) {
  await safeParents(dataDir, path.join(directory, '.material-proof'))
  for (const entry of original) {
    if (entry.type !== 'file') continue
    const stat = await fs.lstat(await scopedPath(directory, entry.name))
    if (!stat.isFile() || stat.uid !== process.getuid() || stat.nlink !== 1) fail()
  }
  await verifyBackup(directory, scope, original)
}
async function syncFiles(dataDir, control, materials) {
  const directories = new Set()
  const addParents = directory => {
    const relative = path.relative(dataDir, directory)
    if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) fail()
    while (true) {
      directories.add(directory)
      if (directory === dataDir) break
      directory = path.dirname(directory)
    }
  }
  addParents(control)
  for (const material of materials) {
    addParents(material.directory)
    for (const entry of material.original) {
      const file = await scopedPath(material.directory, entry.name)
      if (entry.type === 'directory') addParents(file)
      if (entry.type !== 'file') continue
      const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        const stat = await handle.stat()
        if (!stat.isFile() || stat.uid !== process.getuid() || material.independent !== false && stat.nlink !== 1) fail()
        await handle.sync()
      } finally { await handle.close() }
      addParents(path.dirname(file))
    }
  }
  for (const directory of [...directories].sort((a, b) => b.split(path.sep).length - a.split(path.sep).length)) {
    await syncDirectory(directory)
  }
}
async function syncMaterials(dataDir, control, intent, plan) {
  const materials = intent.modules.map(entry => ({ directory: path.join(moduleDirectory(dataDir, entry.description.id), 'backup'), original: entry.original }))
  if (plan.shared.status === 'backup_prepared') materials.push({ directory: path.join(dataDir, 'shared-request-upgrade-v2/backup'), original: intent.shared.original })
  await syncFiles(dataDir, control, materials)
}
const moduleDirectory = (root, id) => path.join(root, '.upgrade-migrations', id)
export async function prepareSystemScopedRecovery(options) {
  const { dataDir, targetRoot, directory } = context(options)
  const record = readVersionMaintenance(dataDir)
  if (record?.schema_version !== 3 || record.id !== options.maintenanceId || record.phase !== 'preparing'
    || record.system_operation_id !== options.operationId || record.target_core?.root !== targetRoot
    || record.source_inventory_sha256 !== options.sourceInventory || record.target_core.inventory_sha256 !== options.targetInventory) fail()
  await assertStopped(dataDir); await verifyTarget(targetRoot, record.target_core.inventory_sha256)
  await assertUnchangedPreparationTransactions(dataDir, new Set())
  await assertNoPartialSharedConversion(dataDir)
  const description = await describeScopedPreparation(targetRoot, dataDir), modules = []
  for (const entry of description.modules) modules.push({ description: entry,
    original: await snapshot(dataDir, entry.scope.writes), inputs: await snapshot(dataDir, entry.scope.reads) })
  const shared = { status: description.shared.status, writes: description.shared_writes,
    original: await snapshot(dataDir, description.shared_writes), inputs: description.shared.entries ?? [] }
  if (shared.status === 'ready') shared.marker_sha256 = digest(await fs.readFile(path.join(dataDir, 'agent/shared-request-upgrade.json')))
  const intent = { schema_version: 1, id: record.id, operation_id: options.operationId, data_dir: dataDir,
    source_inventory_sha256: record.source_inventory_sha256, target_core: record.target_core, modules, shared }
  const parent = management.ensurePrivateDataRoot(path.dirname(directory))
  // EEXIST is an unfinished attempt, never permission to repeat its preparation.
  await fs.mkdir(directory, { mode: 0o700 })
  const parentHandle = await fs.open(parent, 'r'); try { await parentHandle.sync() } finally { await parentHandle.close() }
  await publishDocument(path.join(directory, 'intent.json'), intent)
  const references = []
  for (const entry of modules) {
    await prepareMigration(entry.description, { lockHeld: true })
    const plan = await readDocument(dataDir, path.join(moduleDirectory(dataDir, entry.description.id), 'plan.json'))
    if (JSON.stringify(plan.value.description) !== JSON.stringify(entry.description)
      || !sameSnapshot(plan.value.original, entry.original) || !sameSnapshot(plan.value.inputs, entry.inputs)) fail()
    references.push({ id: entry.description.id, sha256: plan.sha256 })
  }
  const prepared = await prepareSharedRequests(targetRoot, dataDir, { info() {} }, { lockHeld: true, prepareOnly: true })
  const sharedReference = { status: prepared.status }
  if (prepared.status === 'backup_prepared') sharedReference.sha256 = (await readDocument(dataDir, path.join(dataDir, 'shared-request-upgrade-v2/plan.json'))).sha256
  else if (!['ready', 'not_applicable'].includes(prepared.status)) fail()
  const savedIntent = await readDocument(dataDir, path.join(directory, 'intent.json'))
  if (savedIntent.sha256 !== digest(JSON.stringify(intent) + '\n')) fail()
  const plan = { schema_version: 1, id: record.id, intent_sha256: savedIntent.sha256, modules: references, shared: sharedReference }
  await verifyTarget(targetRoot, options.targetInventory)
  await verifyMaterials(dataDir, targetRoot, intent, plan)
  await syncMaterials(dataDir, directory, intent, plan)
  await publishDocument(path.join(directory, 'prepared.json'), plan)
  return { id: record.id, sha256: (await readDocument(dataDir, path.join(directory, 'prepared.json'))).sha256 }
}
async function preparedEvidence(options, { dataDir, targetRoot, directory }) {
  const receipt = options.receipt
  if (receipt?.id !== options.maintenanceId || !hash(receipt.sha256)) fail()
  const prepared = await readDocument(dataDir, path.join(directory, 'prepared.json')), plan = prepared.value
  const saved = await readDocument(dataDir, path.join(directory, 'intent.json')), intent = saved.value
  if (prepared.sha256 !== receipt.sha256 || plan.schema_version !== 1 || plan.id !== receipt.id || plan.intent_sha256 !== saved.sha256
    || intent.schema_version !== 1 || intent.id !== receipt.id || intent.operation_id !== options.operationId || intent.data_dir !== dataDir
    || intent.target_core?.root !== targetRoot || intent.target_core.inventory_sha256 !== options.targetInventory
    || intent.source_inventory_sha256 !== options.sourceInventory || !Array.isArray(intent.modules) || plan.modules?.length !== intent.modules.length) fail()
  return { intent, plan, sha256: prepared.sha256 }
}
export async function verifySystemScopedRecovery(options) {
  const current = context(options), { dataDir, targetRoot } = current
  await assertStopped(dataDir)
  const { intent, plan } = await preparedEvidence(options, current)
  await verifyTarget(targetRoot, options.targetInventory)
  await verifyMaterials(dataDir, targetRoot, intent, plan)
  return { verified: true, service_started: false }
}
async function verifyModuleMaterial(dataDir, entry, reference, phase) {
  if (reference.id !== entry.description.id || !/^crabot-[a-z0-9-]+-v\d+-v\d+$/.test(reference.id)) fail()
  const base = moduleDirectory(dataDir, reference.id), material = await readDocument(dataDir, path.join(base, 'plan.json'))
  const state = await readDocument(dataDir, path.join(base, 'state.json'))
  if (material.sha256 !== reference.sha256 || state.value.schema_version !== 1 || state.value.plan_sha256 !== material.sha256 || state.value.phase !== phase
    || JSON.stringify(material.value.description) !== JSON.stringify(entry.description)
    || !sameSnapshot(material.value.original, entry.original) || !sameSnapshot(material.value.inputs, entry.inputs)) fail()
  await verifyMaterial(dataDir, path.join(base, 'backup'), entry.description.scope.writes, entry.original)
  return state.sha256
}
async function verifySharedMaterial(dataDir, intent, plan) {
  const base = path.join(dataDir, 'shared-request-upgrade-v2'), material = await readDocument(dataDir, path.join(base, 'plan.json')), value = material.value
  if (material.sha256 !== plan.shared.sha256 || value.schema_version !== 2
    || JSON.stringify([...value.write_scope].sort()) !== JSON.stringify([...intent.shared.writes].sort())
    || !sameSnapshot(value.backup_manifest, intent.shared.original) || !sameSnapshot(value.inputs, intent.shared.inputs)
    || digest(await fs.readFile(path.join(base, 'impact.json'))) !== value.impact_sha256) fail()
  await verifyMaterial(dataDir, path.join(base, 'backup'), value.write_scope, value.backup_manifest)
  return { value, sha256: material.sha256 }
}
async function verifyMaterials(dataDir, targetRoot, intent, plan) {
  for (let index = 0; index < intent.modules.length; index++) {
    const entry = intent.modules[index]
    await verifyModuleMaterial(dataDir, entry, plan.modules[index], 'prepared')
    if (!sameSnapshot(entry.original, await snapshot(dataDir, entry.description.scope.writes))
      || !sameSnapshot(entry.inputs, await snapshot(dataDir, entry.description.scope.reads))) fail()
  }
  const shared = await previewSharedRequests(targetRoot, dataDir)
  if (plan.shared.status === 'backup_prepared') {
    const { value } = await verifySharedMaterial(dataDir, intent, plan)
    if (shared.status !== 'pending' || !sameSnapshot(value.inputs, shared.entries)
      || !sameSnapshot(value.backup_manifest, await snapshot(dataDir, value.write_scope))) fail()
  } else if (shared.status !== plan.shared.status || shared.status === 'ready'
    && digest(await fs.readFile(path.join(dataDir, 'agent/shared-request-upgrade.json'))) !== intent.shared.marker_sha256) fail()
}

async function optionalDocument(dataDir, file) {
  try { return await readDocument(dataDir, file) } catch (error) { if (error.code === 'ENOENT') return null; throw error }
}
async function assertNoPartialSharedConversion(dataDir) {
  try {
    const ready = await scopedPath(dataDir, 'agent/shared-request-upgrade.json')
    if (await fs.lstat(ready).catch(error => { if (error.code === 'ENOENT') return null; throw error })) return
    const directory = await scopedPath(dataDir, 'agent/worker-ledgers/.scope-probe')
    const names = await fs.readdir(path.dirname(directory)).catch(error => { if (error.code === 'ENOENT') return []; throw error })
    for (const name of names.filter(name => name.endsWith('.json') && !name.startsWith('.tmp-'))) {
      const relative = path.join('agent/worker-ledgers', name)
      if (ledgerValue(await fs.readFile(await scopedPath(dataDir, relative)), relative).wrapped) fail()
    }
  } catch { fail() }
}
async function assertUnchangedPreparationTransactions(dataDir, owned) {
  const names = await fs.readdir(path.join(dataDir, '.upgrade-migrations')).catch(error => { if (error.code === 'ENOENT') return []; throw error })
  for (const id of names) {
    const saved = await optionalDocument(dataDir, path.join(moduleDirectory(dataDir, id), 'state.json'))
    if (!saved && owned.has(id)) continue // A failed backup cannot have dispatched a script.
    const state = saved?.value
    if (state?.schema_version !== 1 || !hash(state.plan_sha256) || !['prepared', 'rolled_back', 'completed'].includes(state.phase)
      || owned.has(id) && state.phase === 'completed') fail()
  }
}
async function unchangedIntentData(dataDir, targetRoot, intent) {
  for (const entry of intent.modules) {
    if (!sameSnapshot(entry.original, await snapshot(dataDir, entry.description.scope.writes))
      || !sameSnapshot(entry.inputs, await snapshot(dataDir, entry.description.scope.reads))) fail()
  }
  const shared = await previewSharedRequests(targetRoot, dataDir)
  if (shared.status !== intent.shared.status) fail()
  if (shared.status === 'pending' && (!sameSnapshot(shared.entries, intent.shared.inputs)
    || !sameSnapshot(intent.shared.original, await snapshot(dataDir, intent.shared.writes)))) fail()
  if (shared.status === 'ready' && digest(await fs.readFile(path.join(dataDir, 'agent/shared-request-upgrade.json'))) !== intent.shared.marker_sha256) fail()
}
async function directoryIdentity(directory) {
  const stat = await fs.lstat(directory, { bigint: true }).catch(error => { if (error.code === 'ENOENT') return null; throw error })
  if (!stat) return null
  if (!stat.isDirectory() || stat.isSymbolicLink() || String(stat.uid) !== String(process.getuid()) || stat.mode & 0o022n) fail()
  return { dev: String(stat.dev), ino: String(stat.ino) }
}
// Root may have lost the final cancellation reply after its fence was removed.
// Find only this operation's private journal; it grants no start authority.
export async function findSystemScopedCancellation({ dataDir, operationId }) {
  if (!process.getuid || process.getuid() === 0 || !uuid(operationId)) fail()
  dataDir = management.requirePrivateDataRoot(dataDir)
  if (!cliLockToken(path.join(dataDir, 'cli.lock'))) fail()
  const parent = path.dirname(await scopedPath(dataDir, 'system-control/scoped-recovery/.scan'))
  const names = await fs.readdir(parent).catch(error => { if (error.code === 'ENOENT') return []; throw error })
  const matches = []
  for (const id of names.filter(uuid)) {
    const journal = await optionalDocument(dataDir, path.join(parent, id, 'cancel.json'))
    if (journal?.value.operation_id !== operationId) continue
    if (journal.value.id !== id || journal.value.data_dir !== dataDir) fail()
    matches.push(id)
  }
  if (matches.length > 1) fail()
  return matches[0] ?? null
}
// Only the pre-install, source-selected cancel role may call this component.
// It archives unused recovery artifacts; it never restores data or starts Core.
export async function cancelSystemScopedRecovery(options) {
  const { dataDir, targetRoot, directory } = context(options), sourceRoot = realpathSync(options.sourceRoot)
  await assertStopped(dataDir); cliLocation.assertSelectedCli(sourceRoot); await verifyTarget(sourceRoot, options.sourceInventory)
  const record = readVersionMaintenance(dataDir)
  if (record && (record.schema_version !== 3 || record.id !== options.maintenanceId || record.system_operation_id !== options.operationId
    || !['preparing', 'prepared'].includes(record.phase) || record.install_root !== sourceRoot
    || record.source_inventory_sha256 !== options.sourceInventory || record.target_core?.root !== targetRoot
    || record.target_core.inventory_sha256 !== options.targetInventory)) fail()
  const saved = await optionalDocument(dataDir, path.join(directory, 'intent.json')), intent = saved?.value
  if (intent && (intent.schema_version !== 1 || intent.id !== options.maintenanceId || intent.operation_id !== options.operationId || intent.data_dir !== dataDir
    || intent.source_inventory_sha256 !== options.sourceInventory || intent.target_core?.root !== targetRoot
    || intent.target_core.inventory_sha256 !== options.targetInventory || !Array.isArray(intent.modules))) fail()
  const owned = new Set(intent?.modules.map(entry => entry.description.id) ?? [])
  for (const id of owned) if (!/^crabot-[a-z0-9-]+-v\d+-v\d+$/.test(id)) fail()
  await assertUnchangedPreparationTransactions(dataDir, owned)
  await assertNoPartialSharedConversion(dataDir)
  if (intent) await unchangedIntentData(dataDir, targetRoot, intent)
  const prepared = await optionalDocument(dataDir, path.join(directory, 'prepared.json'))
  if (prepared && (!intent || prepared.value.intent_sha256 !== saved.sha256 || prepared.value.id !== options.maintenanceId
    || options.receipt && (options.receipt.id !== options.maintenanceId || options.receipt.sha256 !== prepared.sha256))) fail()
  let journal = (await optionalDocument(dataDir, path.join(directory, 'cancel.json')))?.value
  const bindings = { schema_version: 1, id: options.maintenanceId, operation_id: options.operationId, data_dir: dataDir,
    source_root: sourceRoot, source_inventory_sha256: options.sourceInventory, target_inventory_sha256: options.targetInventory,
    intent_sha256: saved?.sha256 ?? null }
  if (journal && (Object.entries(bindings).some(([key, value]) => journal[key] !== value)
    || !['archiving', 'finalizing', 'completed'].includes(journal.phase) || !Array.isArray(journal.items))) fail()
  if (!record && !journal) fail()
  const sourceFor = item => item.kind === 'module' ? moduleDirectory(dataDir, item.id) : path.join(dataDir, 'shared-request-upgrade-v2')
  const destinationFor = item => path.join(directory, 'retained', item.kind === 'module' ? 'module-' + item.id : 'shared-request-upgrade-v2')
  if (!journal) {
    management.ensurePrivateDataRoot(directory)
    const candidates = [...owned].map(id => ({ kind: 'module', id }))
    if (intent?.shared.status === 'pending') candidates.push({ kind: 'shared', id: 'shared-request-upgrade-v2' })
    const items = []
    for (const item of candidates) {
      const from = sourceFor(item), identity = await directoryIdentity(from)
      if (identity) { await safeParents(dataDir, path.join(from, '.archive-proof')); items.push({ ...item, identity, archived: false }) }
    }
    journal = { ...bindings, phase: 'archiving', items }
    await publishDocument(path.join(directory, 'cancel.json'), journal)
    for (let current = directory; ; current = path.dirname(current)) { await syncDirectory(current); if (current === dataDir) break }
  }
  if (journal.phase === 'completed') {
    if (record) fail()
    return { preparation_cancelled: true, service_started: false }
  }
  management.ensurePrivateDataRoot(path.join(directory, 'retained'))
  for (const item of journal.items) {
    const valid = item.kind === 'module' ? owned.has(item.id)
      : item.kind === 'shared' && item.id === 'shared-request-upgrade-v2' && intent?.shared.status === 'pending'
    if (!valid) fail()
    const from = sourceFor(item), destination = destinationFor(item), source = await directoryIdentity(from), retained = await directoryIdentity(destination)
    const matches = actual => actual && actual.dev === item.identity?.dev && actual.ino === item.identity?.ino
    if (source && retained || source && !matches(source) || retained && !matches(retained) || !source && !retained) fail()
    if (source) {
      await safeParents(dataDir, path.join(from, '.archive-proof'))
      await fs.rename(from, destination)
      await syncDirectory(path.dirname(from)); await syncDirectory(path.dirname(destination))
    }
    item.archived = true
    await publishDocument(path.join(directory, 'cancel.json'), journal)
  }
  journal.phase = 'finalizing'; await publishDocument(path.join(directory, 'cancel.json'), journal)
  if (intent) await unchangedIntentData(dataDir, targetRoot, intent)
  await assertUnchangedPreparationTransactions(dataDir, new Set())
  const verifyCompatible = async () => { verifyDataCompatibility(sourceRoot, dataDir); await previewMigrations(sourceRoot, dataDir) }
  await verifyCompatible(); cliLocation.assertSelectedCli(sourceRoot); await verifyTarget(sourceRoot, options.sourceInventory)
  if (record) await cancelPreparedVersionMaintenance({ dataDir, root: sourceRoot, id: record.id, systemOperationId: options.operationId, verifyCompatible })
  journal.phase = 'completed'; await publishDocument(path.join(directory, 'cancel.json'), journal)
  return { preparation_cancelled: true, service_started: false }
}


// This is the stopped system path only. Default CLI/start migration order is
// unchanged; the authenticated Root coordinator owns the all-UID switch barrier.
export async function executeSystemScopedMigrations(options, runScript) {
  const current = context(options), { dataDir, targetRoot, directory } = current
  const record = readVersionMaintenance(dataDir)
  if (record?.schema_version !== 3 || record.id !== options.maintenanceId || record.phase !== 'verifying'
    || record.system_operation_id !== options.operationId || record.source_inventory_sha256 !== options.sourceInventory
    || record.target_core?.root !== targetRoot || record.target_core.inventory_sha256 !== options.targetInventory) fail()
  cliLocation.assertSelectedCli(targetRoot)
  await assertStopped(dataDir); await verifyTarget(targetRoot, options.targetInventory)
  const { intent, plan, sha256 } = await preparedEvidence(options, current)
  await verifyMaterials(dataDir, targetRoot, intent, plan)
  // An unknown dispatch is not replayable, even if a schema still looks old.
  const execution = await fs.open(path.join(directory, 'execution.json'), 'wx', 0o600)
  try { await execution.writeFile(JSON.stringify({ schema_version: 1, id: record.id, operation_id: options.operationId, prepared_sha256: sha256 }) + '\n'); await execution.sync() }
  finally { await execution.close() }
  await syncDirectory(directory)
  await prepareSharedRequests(targetRoot, dataDir, { info() {} }, { lockHeld: true })
  for (const entry of intent.modules) {
    cliLocation.assertSelectedCli(targetRoot); await verifyTarget(targetRoot, options.targetInventory)
    const result = await executeMigration(entry.description, runScript, { lockHeld: true })
    if (!result.ok) throw Object.assign(new Error('本人数据迁移未完成，维护保护与材料已保留。'), { code: 'CRABOT_MIGRATION_FAILED' })
  }
  const writes = [...intent.shared.writes]
  for (const entry of intent.modules) writes.push(...entry.description.scope.writes,
    path.join('.upgrade-migrations', entry.description.id, 'state.json'))
  await syncFiles(dataDir, directory, [{ directory: dataDir, original: await snapshot(dataDir, writes), independent: false }])
  const evidence = await completedEvidence(dataDir, targetRoot, intent, plan)
  await assertStopped(dataDir); cliLocation.assertSelectedCli(targetRoot); await verifyTarget(targetRoot, options.targetInventory)
  await publishDocument(path.join(directory, 'completed.json'), { schema_version: 1, id: record.id, operation_id: options.operationId,
    prepared_sha256: sha256, target_inventory_sha256: options.targetInventory, ...evidence })
  return { migrated: true, service_started: false }
}
async function completedEvidence(dataDir, targetRoot, intent, plan) {
  const modules = []
  for (let index = 0; index < intent.modules.length; index++) {
    const entry = intent.modules[index], reference = plan.modules[index]
    const stateHash = await verifyModuleMaterial(dataDir, entry, reference, 'completed')
    if (!sameSnapshot(entry.inputs, await snapshot(dataDir, entry.description.scope.reads))
      || (await fs.readFile(await scopedPath(dataDir, path.join(entry.description.module_id.slice(7), 'SCHEMA_VERSION')), 'utf8')).trim() !== entry.description.to) fail()
    modules.push({ id: reference.id, state_sha256: stateHash })
  }
  const shared = await previewSharedRequests(targetRoot, dataDir)
  if (plan.shared.status === 'backup_prepared') {
    const material = await verifySharedMaterial(dataDir, intent, plan)
    const marker = await readDocument(dataDir, path.join(dataDir, 'agent/shared-request-upgrade.json'))
    if (shared.status !== 'ready' || marker.value.transaction !== 'shared-request-upgrade-v2' || marker.value.plan_sha256 !== material.sha256) fail()
  } else if (shared.status !== plan.shared.status) fail()
  const result = { status: shared.status }
  if (shared.status === 'ready') {
    result.marker_sha256 = (await readDocument(dataDir, path.join(dataDir, 'agent/shared-request-upgrade.json'))).sha256
    if (plan.shared.status === 'ready' && result.marker_sha256 !== intent.shared.marker_sha256) fail()
  }
  return { modules, shared: result }
}
// An offline proof only: the caller still requires Root's durable successful
// migration dispatch before it may start the previously running instance.
export async function verifyCompletedSystemScopedRecovery(options) {
  const current = context(options), { dataDir, targetRoot, directory } = current
  await assertStopped(dataDir); cliLocation.assertSelectedCli(targetRoot); await verifyTarget(targetRoot, options.targetInventory)
  const { intent, plan, sha256 } = await preparedEvidence(options, current)
  const execution = (await readDocument(dataDir, path.join(directory, 'execution.json'))).value
  const completed = (await readDocument(dataDir, path.join(directory, 'completed.json'))).value
  if (execution.schema_version !== 1 || execution.id !== options.maintenanceId || execution.operation_id !== options.operationId || execution.prepared_sha256 !== sha256
    || completed.schema_version !== 1 || completed.id !== options.maintenanceId || completed.operation_id !== options.operationId
    || completed.prepared_sha256 !== sha256 || completed.target_inventory_sha256 !== options.targetInventory) fail()
  const evidence = await completedEvidence(dataDir, targetRoot, intent, plan)
  if (JSON.stringify(completed.modules) !== JSON.stringify(evidence.modules) || JSON.stringify(completed.shared) !== JSON.stringify(evidence.shared)) fail()
  return { verified: true, service_started: false }
}
