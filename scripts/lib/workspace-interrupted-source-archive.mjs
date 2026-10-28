// Retain the original cancelled migration atomically; service admission stays closed.
import fs from 'node:fs'
import path from 'node:path'
import native from './process-identity.cjs'
import management from './desktop-management.cjs'
import { verifyWorkspaceInterruptedRecoveryRole } from './workspace-interrupted-role.mjs'
import { inspectWorkspaceInterruptedRelocation } from './workspace-interrupted-recovery.mjs'
import { workspaceSourceRestorationPaths, readPendingWorkspaceSourceRestoration, readWorkspaceSourceRestoration } from './workspace-interrupted-source-records.mjs'
import { WorkspaceCatalog } from '../../crabot-shared/dist/workspace-catalog.js'
import { sha256CanonicalJson as hash } from '../../crabot-shared/dist/canonical-json.js'
import { captureWorkspaceRelocationRecovery } from '../../crabot-agent/dist/core/workspace-relocation-recovery-capture.js'
import { verifyWorkspaceRecoveryProgress } from '../../crabot-agent/dist/core/workspace-relocation-recovery-commit.js'
import { verifyWorkspaceRecoverySnapshot } from './workspace-recovery-plan.mjs'
import { createWorkspaceMaintenanceFileAccess } from '../../crabot-agent/dist/core/workspace-maintenance-files.js'
const failure = () => Object.assign(new Error('恢复原位置的收尾尚未全部核实，原材料、文件和维护保护已保留。'), { code: 'WORKSPACE_RELOCATION_INVALID' })
const { owned, readJson, publish, syncDirectory } = createWorkspaceMaintenanceFileAccess(failure)
function directory(file) {
  const stat = owned(file, true, true)
  if (fs.realpathSync(file) !== file) throw failure()
  return { path: file, dev: String(stat.dev), ino: String(stat.ino), native_id: process.platform === 'win32' ? native.inspectDirectoryFileId(file) : null }
}
export async function archiveWorkspaceInterruptedSource({ dataDir, recoveryId, launchHash }) {
  const options = { dataDir, recoveryId, launchHash }, role = verifyWorkspaceInterruptedRecoveryRole(options), request = role.launch.request
  if (role.launch.action !== 'restore_source') throw failure()
  const ctx = workspaceSourceRestorationPaths(dataDir, request.intent_id), recovery = role.launch.control_root.path
  if (fs.existsSync(ctx.fence)) return finishArchive(options, ctx)
  const sourceComplete = readJson(path.join(recovery, 'source-complete.json'))
  if (!sourceComplete || sourceComplete.recovery_id !== recoveryId) throw failure()
  const before = await inspectWorkspaceInterruptedRelocation({ dataDir: ctx.data, id: request.intent_id })
  if (!before.positions.source || before.positions.source.path !== sourceComplete.source.path || before.content.fingerprint !== sourceComplete.content_sha256) throw failure()
  const catalog = new WorkspaceCatalog({ dataRoot: ctx.data, storageRoot: process.env.WORKER_WORKSPACES_DIR, files: native }), snapshot = await catalog.snapshot()
  if (snapshot.storage_root !== before.positions.source.path || snapshot.revision !== before.checkpoint.intent.catalog_revision) throw failure()
  const originalRecovery = await captureWorkspaceRelocationRecovery(ctx.data)
  const current = () => {
    verifyWorkspaceInterruptedRecoveryRole(options)
    verifyWorkspaceRecoverySnapshot(originalRecovery, ctx.data)
    if (hash(readJson(path.join(recovery, 'source-complete.json'))) !== hash(sourceComplete)) throw failure()
  }
  current()
  const scope = { schema_version: 2, recovery_id: recoveryId, launch_sha256: launchHash, checkpoint: before.checkpoint,
    source_complete_sha256: hash(sourceComplete), catalog_sha256: hash(snapshot), catalog_revision: snapshot.revision, recovery_snapshot: originalRecovery }
  publish(recovery, 'source-terminal.json', scope, current, 32 * 1024 * 1024)
  current()
  const marker = { schema_version: 2, intent_id: request.intent_id, recovery_id: recoveryId, launch_sha256: launchHash, scope_sha256: hash(scope) }
  // Publish the guard before moving the old activity directory. A crash at any
  // later boundary cannot make bootstrap or Shared mistake it for idle.
  publish(ctx.control, path.basename(ctx.fence), marker, current)
  return finishArchive(options, ctx)
}
async function finishArchive(options, ctx) {
  const pending = readPendingWorkspaceSourceRestoration(ctx.data, path.basename(ctx.job))
  const { marker, scope } = pending
  const current = () => {
    verifyWorkspaceInterruptedRecoveryRole(options)
    verifyWorkspaceRecoveryProgress(scope.recovery_snapshot)
    const state = readPendingWorkspaceSourceRestoration(ctx.data, marker.intent_id)
    if (hash(state.marker) !== hash(marker) || hash(state.scope) !== hash(scope)) throw failure()
  }
  current()
  const catalog = new WorkspaceCatalog({ dataRoot: ctx.data, storageRoot: process.env.WORKER_WORKSPACES_DIR, files: native })
  if (hash(await catalog.snapshot()) !== scope.catalog_sha256) throw failure()
  current()
  management.ensurePrivateDataRoot(ctx.parent)
  if (!fs.existsSync(ctx.job)) {
    current()
    if (process.platform === 'win32') native.createPrivateDirectory(ctx.job)
    else fs.mkdirSync(ctx.job, { mode: 0o700 })
  }
  const job = directory(ctx.job)
  if (fs.readdirSync(ctx.job).some(name => !['source-restored.json', 'original', 'business-prepared.json'].includes(name))) throw failure()
  const check = () => { current(); if (hash(directory(ctx.job)) !== hash(job)) throw failure() }
  if (!fs.existsSync(path.join(ctx.job, 'source-restored.json'))) publish(ctx.job, 'source-restored.json', marker, check)
  if (!pending.archived) {
    const observed = await inspectWorkspaceInterruptedRelocation({ dataDir: ctx.data, id: marker.intent_id })
    const complete = readJson(path.join(pending.role.launch.control_root.path, 'source-complete.json'))
    if (!observed.positions.source || observed.content.fingerprint !== complete.content_sha256) throw failure()
    check()
    native.renameDirectoryNoReplace(path.join(ctx.control, 'relocation-active'), ctx.original)
    syncDirectory(ctx.control); syncDirectory(ctx.job); syncDirectory(ctx.parent)
  }
  current()
  const archived = readWorkspaceSourceRestoration(ctx.data, marker.intent_id)
  if (hash(archived.marker) !== hash(marker) || hash(archived.scope) !== hash(scope)) throw failure()
  return Object.freeze({ source_restored: true, service_restored: false })
}
