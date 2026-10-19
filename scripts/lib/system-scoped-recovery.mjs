// Employee-UID data component. The caller authenticates the immutable shared
// installation and Root operation first. These receipts never authorize a start.
import fs from 'node:fs/promises'
import { constants, realpathSync } from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import management from './desktop-management.cjs'
import { cliLockToken } from './cli-lock.mjs'
import { readVersionMaintenance } from './version-maintenance.mjs'
import { verifyCoreRelease } from './core-release.mjs'
import { describeScopedPreparation } from '../upgrade-lib/scoped-preparation.mjs'
import { prepareMigration } from '../upgrade-lib/migration-transaction.mjs'
import { prepareSharedRequests, previewSharedRequests } from '../upgrade-lib/shared-requests.mjs'
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
async function publishDocument(file, value) {
  await writeAtomic(file, JSON.stringify(value) + '\n')
  const directory = await fs.open(path.dirname(file), 'r')
  try { await directory.sync() } finally { await directory.close() }
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
async function syncMaterials(dataDir, control, intent, plan) {
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
  const materials = intent.modules.map(entry => ({ directory: path.join(moduleDirectory(dataDir, entry.description.id), 'backup'), original: entry.original }))
  if (plan.shared.status === 'backup_prepared') materials.push({ directory: path.join(dataDir, 'shared-request-upgrade-v2/backup'), original: intent.shared.original })
  for (const material of materials) {
    addParents(material.directory)
    for (const entry of material.original) {
      const file = await scopedPath(material.directory, entry.name)
      if (entry.type === 'directory') addParents(file)
      if (entry.type !== 'file') continue
      const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        const stat = await handle.stat()
        if (!stat.isFile() || stat.uid !== process.getuid() || stat.nlink !== 1) fail()
        await handle.sync()
      } finally { await handle.close() }
      addParents(path.dirname(file))
    }
  }
  for (const directory of [...directories].sort((a, b) => b.split(path.sep).length - a.split(path.sep).length)) {
    const handle = await fs.open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    try {
      const stat = await handle.stat()
      if (!stat.isDirectory() || stat.uid !== process.getuid()) fail()
      await handle.sync()
    } finally { await handle.close() }
  }
}
const moduleDirectory = (root, id) => path.join(root, '.upgrade-migrations', id)
export async function prepareSystemScopedRecovery(options) {
  const { dataDir, targetRoot, directory } = context(options)
  const record = readVersionMaintenance(dataDir)
  if (record?.schema_version !== 3 || record.id !== options.maintenanceId || record.phase !== 'preparing'
    || record.system_operation_id !== options.operationId || record.target_core?.root !== targetRoot
    || record.source_inventory_sha256 !== options.sourceInventory || record.target_core.inventory_sha256 !== options.targetInventory) fail()
  await assertStopped(dataDir); await verifyTarget(targetRoot, record.target_core.inventory_sha256)
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
export async function verifySystemScopedRecovery(options) {
  const { dataDir, targetRoot, directory } = context(options)
  const receipt = options.receipt
  if (receipt?.id !== options.maintenanceId || !hash(receipt.sha256)) fail()
  await assertStopped(dataDir)
  const prepared = await readDocument(dataDir, path.join(directory, 'prepared.json')), plan = prepared.value
  const saved = await readDocument(dataDir, path.join(directory, 'intent.json')), intent = saved.value
  if (prepared.sha256 !== receipt.sha256 || plan.schema_version !== 1 || plan.id !== receipt.id || plan.intent_sha256 !== saved.sha256
    || intent.schema_version !== 1 || intent.id !== receipt.id || intent.operation_id !== options.operationId || intent.data_dir !== dataDir
    || intent.target_core?.root !== targetRoot || intent.target_core.inventory_sha256 !== options.targetInventory
    || intent.source_inventory_sha256 !== options.sourceInventory || !Array.isArray(intent.modules) || plan.modules?.length !== intent.modules.length) fail()
  await verifyTarget(targetRoot, intent.target_core.inventory_sha256)
  await verifyMaterials(dataDir, targetRoot, intent, plan)
  return { verified: true, service_started: false }
}
async function verifyMaterials(dataDir, targetRoot, intent, plan) {
  for (let index = 0; index < intent.modules.length; index++) {
    const entry = intent.modules[index], reference = plan.modules[index]
    if (reference.id !== entry.description.id || !/^crabot-[a-z0-9-]+-v\d+-v\d+$/.test(reference.id)) fail()
    const base = moduleDirectory(dataDir, reference.id), material = await readDocument(dataDir, path.join(base, 'plan.json'))
    const state = (await readDocument(dataDir, path.join(base, 'state.json'))).value
    if (material.sha256 !== reference.sha256 || state.schema_version !== 1 || state.plan_sha256 !== material.sha256 || state.phase !== 'prepared'
      || JSON.stringify(material.value.description) !== JSON.stringify(entry.description)
      || !sameSnapshot(material.value.original, entry.original) || !sameSnapshot(material.value.inputs, entry.inputs)) fail()
    await verifyMaterial(dataDir, path.join(base, 'backup'), entry.description.scope.writes, entry.original)
    if (!sameSnapshot(entry.original, await snapshot(dataDir, entry.description.scope.writes))
      || !sameSnapshot(entry.inputs, await snapshot(dataDir, entry.description.scope.reads))) fail()
  }
  if (plan.shared.status === 'backup_prepared') {
    const base = path.join(dataDir, 'shared-request-upgrade-v2'), material = await readDocument(dataDir, path.join(base, 'plan.json')), value = material.value
    if (material.sha256 !== plan.shared.sha256 || value.schema_version !== 2
      || JSON.stringify([...value.write_scope].sort()) !== JSON.stringify([...intent.shared.writes].sort())
      || !sameSnapshot(value.backup_manifest, intent.shared.original) || !sameSnapshot(value.inputs, intent.shared.inputs)
      || digest(await fs.readFile(path.join(base, 'impact.json'))) !== value.impact_sha256) fail()
    await verifyMaterial(dataDir, path.join(base, 'backup'), value.write_scope, value.backup_manifest)
    if (!sameSnapshot(value.backup_manifest, await snapshot(dataDir, value.write_scope))
      || !sameSnapshot(value.inputs, await snapshot(dataDir, value.inputs.map(entry => entry.name)))) fail()
  } else {
    const shared = await previewSharedRequests(targetRoot, dataDir)
    if (shared.status !== plan.shared.status || shared.status === 'ready'
      && digest(await fs.readFile(path.join(dataDir, 'agent/shared-request-upgrade.json'))) !== intent.shared.marker_sha256) fail()
  }
}
