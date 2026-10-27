// Independent forward terminal facts; never an old coordinator completion or current authority.
import fs from 'node:fs'
import path from 'node:path'
import native from './process-identity.cjs'
import management from './desktop-management.cjs'
import { readWorkspaceInterruptedRecoveryRole, verifyWorkspaceInterruptedRecoveryRole, assertWorkspaceInterruptedForwardProgress } from './workspace-interrupted-role.mjs'
import { readWorkspaceInterruptedRelocationCheckpoint } from './workspace-relocation-intent.mjs'
import { assertWorkspaceInterruptedCheckpointSnapshot } from './workspace-interrupted-source-records.mjs'
import { WorkspaceCatalog } from '../../crabot-shared/dist/workspace-catalog.js'
import { sha256CanonicalJson as hash } from '../../crabot-shared/dist/canonical-json.js'
import { createWorkspaceMaintenanceFileAccess } from '../../crabot-agent/dist/core/workspace-maintenance-files.js'
const failure = () => Object.assign(new Error('选中工作区的当前交接事实尚未核实，原材料和维护保护已保留。'), { code: 'WORKSPACE_RELOCATION_INVALID' })
const { owned, readJson, publish } = createWorkspaceMaintenanceFileAccess(failure)
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value)
export const forwardFinalizingName = 'relocation-forward-finalizing.json'
function context(dataDir, id) {
  if (!uuid(id)) throw failure()
  const data = management.requireExistingDataRoot(dataDir), control = path.join(data, 'workspace-control')
  return { data, control, active: path.join(control, 'relocation-active'), fence: path.join(control, forwardFinalizingName) }
}
function frame(file, privateEntry = true) {
  const stat = privateEntry ? owned(file, true, true) : fs.lstatSync(file, { bigint: true })
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(file) !== file) throw failure()
  return { path: file, dev: String(stat.dev), ino: String(stat.ino), native_id: process.platform === 'win32' ? native.inspectDirectoryFileId(file) : null }
}
/** Prepared active-job facts only. Archival and service completion are separate. */
export function readWorkspaceInterruptedForwardPreparation(dataDir, id) {
  const ctx = context(dataDir, id), control = frame(ctx.control), original = frame(ctx.active), marker = readJson(ctx.fence)
  if (!marker) return null
  if (!exact(marker, ['schema_version', 'intent_id', 'recovery_id', 'launch_sha256', 'scope_sha256']) || marker.schema_version !== 2 || marker.intent_id !== id || !uuid(marker.recovery_id)) throw failure()
  const role = readWorkspaceInterruptedRecoveryRole(ctx.data, marker.recovery_id)
  if (!role.launch || !role.ready || role.launch.action !== 'finish_commit' || role.launch.request.intent_id !== id || hash(role.launch) !== marker.launch_sha256
    || hash(role.launch.active_root) !== hash(original)) throw failure()
  const directory = role.launch.control_root.path, scope = readJson(path.join(directory, 'forward-terminal.json'), 32 * 1024 * 1024)
  if (!exact(scope, ['schema_version', 'intent_id', 'recovery_id', 'launch_sha256', 'checkpoint', 'root', 'catalog_sha256', 'catalog_revision'])
    || scope.schema_version !== 2 || scope.intent_id !== id || scope.recovery_id !== marker.recovery_id || scope.launch_sha256 !== marker.launch_sha256 || hash(scope) !== marker.scope_sha256) throw failure()
  assertWorkspaceInterruptedCheckpointSnapshot(scope.checkpoint)
  const baseline = readJson(path.join(directory, 'forward-checkpoint.json'), 32 * 1024 * 1024)
  if (!baseline || baseline.checkpoint_sha256 !== role.launch.request.checkpoint_sha256) throw failure()
  assertWorkspaceInterruptedForwardProgress(baseline, scope.checkpoint)
  const selected = scope.checkpoint.selected
  if (!selected || !scope.checkpoint.recovery_commit || scope.catalog_sha256 !== selected.catalog_sha256 || scope.catalog_revision !== selected.catalog_revision
    || hash(scope.root) !== hash(scope.checkpoint.published?.target) || hash(frame(scope.root.path, false)) !== hash(scope.root)
    || hash(readWorkspaceInterruptedRelocationCheckpoint(ctx.data, id)) !== hash(scope.checkpoint)
    || hash(readJson(ctx.fence)) !== hash(marker) || hash(frame(ctx.control)) !== hash(control) || hash(frame(ctx.active)) !== hash(original)) throw failure()
  return { marker, scope, checkpoint: scope.checkpoint, root: scope.root, original, role }
}
export async function prepareWorkspaceInterruptedForwardService({ dataDir, recoveryId, launchHash }) {
  const options = { dataDir, recoveryId, launchHash }, role = verifyWorkspaceInterruptedRecoveryRole(options), id = role.launch.request.intent_id
  if (role.launch.action !== 'finish_commit') throw failure()
  const ctx = context(dataDir, id), checkpoint = readWorkspaceInterruptedRelocationCheckpoint(dataDir, id)
  const verify = () => {
    verifyWorkspaceInterruptedRecoveryRole(options)
    if (hash(readWorkspaceInterruptedRelocationCheckpoint(ctx.data, id)) !== hash(checkpoint)) throw failure()
  }
  const catalog = await new WorkspaceCatalog({ dataRoot: ctx.data, storageRoot: process.env.WORKER_WORKSPACES_DIR, files: native }).snapshot()
  verify()
  const previous = readWorkspaceInterruptedForwardPreparation(ctx.data, id)
  if (previous) {
    if (hash(catalog) !== previous.scope.catalog_sha256) throw failure()
    return Object.freeze({ prepared: true, scope_sha256: previous.marker.scope_sha256 })
  }
  if (!checkpoint.selected || !checkpoint.published || !checkpoint.recovery_commit) throw failure()
  const root = frame(checkpoint.intent.target, false)
  if (hash(root) !== hash(checkpoint.published.target) || hash(catalog) !== checkpoint.selected.catalog_sha256 || catalog.storage_root !== root.path) throw failure()
  const scope = { schema_version: 2, intent_id: id, recovery_id: recoveryId, launch_sha256: launchHash, checkpoint, root,
    catalog_sha256: hash(catalog), catalog_revision: catalog.revision }
  publish(role.launch.control_root.path, 'forward-terminal.json', scope, verify, 32 * 1024 * 1024)
  const marker = { schema_version: 2, intent_id: id, recovery_id: recoveryId, launch_sha256: launchHash, scope_sha256: hash(scope) }
  publish(ctx.control, forwardFinalizingName, marker, verify)
  verify()
  if (hash(readWorkspaceInterruptedForwardPreparation(ctx.data, id).marker) !== hash(marker)) throw failure()
  return Object.freeze({ prepared: true, scope_sha256: marker.scope_sha256 })
}
