// Source-restored history is not successful relocation history or a current effect permit.
import fs from 'node:fs'
import path from 'node:path'
import native from './process-identity.cjs'
import management from './desktop-management.cjs'
import { createWorkspaceMaintenanceFileAccess } from '../../crabot-agent/dist/core/workspace-maintenance-files.js'
import { readWorkspaceInterruptedRecoveryRole } from './workspace-interrupted-role.mjs'
import { readWorkspaceInterruptedRelocationCheckpoint, readWorkspaceCancelledRelocationMaterials } from './workspace-relocation-intent.mjs'
import { validateWorkspaceRecoverySnapshot } from './workspace-recovery-plan.mjs'
import { sha256CanonicalJson as hash } from '../../crabot-shared/dist/canonical-json.js'
const failure = () => Object.assign(new Error('恢复原位置的保留材料无法核实，原文件及维护保护已保留。'), { code: 'WORKSPACE_RELOCATION_INVALID' })
const { owned, readJson } = createWorkspaceMaintenanceFileAccess(failure)
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value)
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
export const sourceFinalizingName = 'relocation-source-finalizing.json'
export function workspaceSourceRestorationPaths(dataDir, id) {
  if (!uuid(id)) throw failure()
  const data = management.requireExistingDataRoot(dataDir), control = path.join(data, 'workspace-control'), parent = path.join(control, 'relocation-cancelled')
  return { data, control, parent, job: path.join(parent, id), original: path.join(parent, id, 'original'), fence: path.join(control, sourceFinalizingName) }
}
function frame(directory) {
  const stat = owned(directory, true, true)
  if (fs.realpathSync(directory) !== directory) throw failure()
  return { path: directory, dev: String(stat.dev), ino: String(stat.ino), native_id: process.platform === 'win32' ? native.inspectDirectoryFileId(directory) : null }
}
/** Verifies the original technical checkpoint hash, never action authority. */
export function assertWorkspaceInterruptedCheckpointSnapshot(checkpoint) {
  if (!checkpoint || !digest(checkpoint.checkpoint_sha256)) throw failure()
  const { checkpoint_sha256, action, materials, ...facts } = checkpoint
  if (hash({ facts, materials, action }) !== checkpoint_sha256) throw failure()
}
function present(file) {
  try { fs.lstatSync(file); return true } catch (error) { if (error.code === 'ENOENT') return false; throw error }
}
export function readPendingWorkspaceSourceRestoration(dataDir, id) {
  return readRestoration(dataDir, id, true)
}
export function readWorkspaceSourceRestoration(dataDir, id) {
  return readRestoration(dataDir, id, false)
}
function readRestoration(dataDir, id, pending) {
  const ctx = workspaceSourceRestorationPaths(dataDir, id)
  const roots = [ctx.control, ctx.parent, ctx.job].filter(present).map(frame)
  const markerFile = path.join(ctx.job, 'source-restored.json')
  const marker = readJson(pending ? ctx.fence : markerFile)
  if (pending && present(markerFile) && hash(readJson(markerFile)) !== hash(marker)) throw failure()
  if (!exact(marker, ['schema_version', 'intent_id', 'recovery_id', 'launch_sha256', 'scope_sha256']) || marker.schema_version !== 2
    || marker.intent_id !== id || !uuid(marker.recovery_id) || !digest(marker.launch_sha256) || !digest(marker.scope_sha256)) throw failure()
  const role = readWorkspaceInterruptedRecoveryRole(ctx.data, marker.recovery_id)
  if (!role.launch || !role.ready || hash(role.launch) !== marker.launch_sha256 || role.launch.action !== 'restore_source' || role.launch.request.intent_id !== id) throw failure()
  const scope = readJson(path.join(role.launch.control_root.path, 'source-terminal.json'), 32 * 1024 * 1024)
  if (!exact(scope, ['schema_version', 'recovery_id', 'launch_sha256', 'checkpoint', 'source_complete_sha256', 'catalog_sha256', 'catalog_revision', 'recovery_snapshot'])
    || scope.schema_version !== 2 || scope.recovery_id !== marker.recovery_id || scope.launch_sha256 !== marker.launch_sha256 || hash(scope) !== marker.scope_sha256
    || !digest(scope.source_complete_sha256) || !digest(scope.catalog_sha256) || !Number.isSafeInteger(scope.catalog_revision) || scope.catalog_revision < 1) throw failure()
  assertWorkspaceInterruptedCheckpointSnapshot(scope.checkpoint)
  if (scope.checkpoint.intent.id !== id || scope.checkpoint.action !== 'restore_source'
    || scope.checkpoint.checkpoint_sha256 !== role.launch.request.checkpoint_sha256) throw failure()
  validateWorkspaceRecoverySnapshot(scope.recovery_snapshot, ctx.data)
  const complete = readJson(path.join(role.launch.control_root.path, 'source-complete.json'))
  if (hash(complete) !== scope.source_complete_sha256 || complete.recovery_id !== marker.recovery_id) throw failure()
  const active = path.join(ctx.control, 'relocation-active'), archived = present(ctx.original)
  if (pending && archived && present(active) || !archived && !pending) throw failure()
  const original = frame(archived ? ctx.original : active)
  const materials = archived ? readWorkspaceCancelledRelocationMaterials(ctx.data, id)
    : readWorkspaceInterruptedRelocationCheckpoint(ctx.data, id).materials
  if (hash({ ...original, path: role.launch.active_root.path }) !== hash(role.launch.active_root)
    || hash(materials) !== hash(scope.checkpoint.materials)) throw failure()
  if (hash([ctx.control, ctx.parent, ctx.job].filter(present).map(frame)) !== hash(roots)) throw failure()
  return { checkpoint: scope.checkpoint, scope, marker, original, role, complete, archived }
}

/** Completed source-restoration history only; no current role or service release. */
export function listWorkspaceSourceRestorations(dataDir) {
  const data = management.requireExistingDataRoot(dataDir), control = path.join(data, 'workspace-control'), parent = path.join(control, 'relocation-cancelled')
  if (!present(parent)) return []
  const roots = [control, parent].map(frame), names = fs.readdirSync(parent).sort()
  if (names.some(name => !uuid(name))) throw failure()
  const result = names.map(id => readWorkspaceSourceRestoration(data, id))
  if (hash([control, parent].map(frame)) !== hash(roots) || hash(fs.readdirSync(parent).sort()) !== hash(names)) throw failure()
  return result
}

/** Read-only terminal handoff facts; these never authorize a fresh recovery role. */
export function readWorkspaceSourceCompletionScope(dataDir, id) {
  const restored = readWorkspaceSourceRestoration(dataDir, id), ctx = workspaceSourceRestorationPaths(dataDir, id)
  const fence = readJson(ctx.fence)
  if (fence) {
    if (hash(fence) !== hash(restored.marker)) throw failure()
    return { ...restored, released: false, release: null }
  }
  const parent = path.join(ctx.control, 'relocation-recovery'), names = fs.readdirSync(parent).sort(), matches = []
  frame(parent)
  for (const recoveryId of names) {
    if (!uuid(recoveryId)) throw failure()
    const directory = path.join(parent, recoveryId), guard = path.join(directory, 'source-released-guard.json')
    if (!present(guard)) continue
    frame(directory)
    const role = readWorkspaceInterruptedRecoveryRole(dataDir, recoveryId)
    if (role.launch?.request.intent_id !== id) continue
    if (hash(readJson(guard)) !== hash(restored.marker)) throw failure()
    matches.push({ role, release: readJson(path.join(directory, 'source-release.json')) })
  }
  if (matches.length !== 1 || hash(fs.readdirSync(parent).sort()) !== hash(names)) throw failure()
  const { role: current, release } = matches[0]
  if (!exact(release, ['schema_version', 'job', 'scope_sha256']) || release.schema_version !== 2 || release.scope_sha256 !== restored.marker.scope_sha256
    || !exact(release.job, ['intent_id', 'recovery_id', 'checkpoint_sha256', 'launch_sha256', 'plan_sha256', 'instance_id', 'admin_runtime_id'])
    || release.job.intent_id !== id || release.job.checkpoint_sha256 !== restored.checkpoint.checkpoint_sha256 || !uuid(release.job.recovery_id)
    || !uuid(release.job.instance_id) || !uuid(release.job.admin_runtime_id) || !digest(release.job.launch_sha256) || !digest(release.job.plan_sha256)) throw failure()
  if (!current.launch || !current.ready || hash(current.launch) !== release.job.launch_sha256 || current.launch.action !== 'restore_source'
    || hash(current.launch.request) !== hash({ intent_id: id, recovery_id: release.job.recovery_id, checkpoint_sha256: release.job.checkpoint_sha256 })
    || hash(readJson(path.join(current.launch.control_root.path, 'runtime-plan.json'))) !== release.job.plan_sha256) throw failure()
  return { ...restored, released: true, release }
}
