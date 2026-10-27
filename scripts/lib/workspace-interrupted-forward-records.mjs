// Independent forward terminal facts; never an old coordinator completion or current authority.
import fs from 'node:fs'
import path from 'node:path'
import native from './process-identity.cjs'
import management from './desktop-management.cjs'
import { readWorkspaceInterruptedRecoveryRole, verifyWorkspaceInterruptedRecoveryRole, assertWorkspaceInterruptedForwardProgress } from './workspace-interrupted-role.mjs'
import { readWorkspaceInterruptedRelocationCheckpoint, readWorkspaceForwardRelocationMaterials } from './workspace-relocation-intent.mjs'
import { assertWorkspaceInterruptedCheckpointSnapshot } from './workspace-interrupted-source-records.mjs'
import { WorkspaceCatalog } from '../../crabot-shared/dist/workspace-catalog.js'
import { sha256CanonicalJson as hash } from '../../crabot-shared/dist/canonical-json.js'
import { createWorkspaceMaintenanceFileAccess } from '../../crabot-agent/dist/core/workspace-maintenance-files.js'
const failure = () => Object.assign(new Error('选中工作区的当前交接事实尚未核实，原材料和维护保护已保留。'), { code: 'WORKSPACE_RELOCATION_INVALID' })
const { owned, readJson, publish } = createWorkspaceMaintenanceFileAccess(failure)
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value)
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
export const forwardFinalizingName = 'relocation-forward-finalizing.json'
export function workspaceInterruptedForwardPaths(dataDir, id) {
  if (!uuid(id)) throw failure()
  const data = management.requireExistingDataRoot(dataDir), control = path.join(data, 'workspace-control')
  const parent = path.join(control, 'relocation-history'), job = path.join(parent, id)
  return { data, control, active: path.join(control, 'relocation-active'), parent, job, original: path.join(job, 'original'), fence: path.join(control, forwardFinalizingName) }
}
function frame(file, privateEntry = true) {
  const stat = privateEntry ? owned(file, true, true) : fs.lstatSync(file, { bigint: true })
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(file) !== file) throw failure()
  return { path: file, dev: String(stat.dev), ino: String(stat.ino), native_id: process.platform === 'win32' ? native.inspectDirectoryFileId(file) : null }
}
/** Prepared active or retained facts only. Current Root capability and service completion are separate. */
export function readWorkspaceInterruptedForwardPreparation(dataDir, id) {
  const ctx = workspaceInterruptedForwardPaths(dataDir, id), control = frame(ctx.control), archived = fs.existsSync(ctx.original)
  const stored = readJson(path.join(ctx.job, 'forward-committed.json')), fence = readJson(ctx.fence), marker = fence?.intent_id === id ? fence : stored
  if (!marker) return null
  if (fence?.intent_id === id && archived && fs.existsSync(ctx.active) || stored && hash(stored) !== hash(marker)) throw failure()
  const original = frame(archived ? ctx.original : ctx.active)
  if (!exact(marker, ['schema_version', 'intent_id', 'recovery_id', 'launch_sha256', 'scope_sha256']) || marker.schema_version !== 2 || marker.intent_id !== id || !uuid(marker.recovery_id)) throw failure()
  const role = readWorkspaceInterruptedRecoveryRole(ctx.data, marker.recovery_id)
  if (!role.launch || !role.ready || role.launch.action !== 'finish_commit' || role.launch.request.intent_id !== id || hash(role.launch) !== marker.launch_sha256
    || hash(role.launch.active_root) !== hash({ ...original, path: role.launch.active_root.path })) throw failure()
  const directory = role.launch.control_root.path, scope = readJson(path.join(directory, 'forward-terminal.json'), 32 * 1024 * 1024)
  if (!exact(scope, ['schema_version', 'intent_id', 'recovery_id', 'launch_sha256', 'checkpoint', 'root', 'catalog_sha256', 'catalog_revision'])
    || scope.schema_version !== 2 || scope.intent_id !== id || scope.recovery_id !== marker.recovery_id || scope.launch_sha256 !== marker.launch_sha256 || hash(scope) !== marker.scope_sha256) throw failure()
  assertWorkspaceInterruptedCheckpointSnapshot(scope.checkpoint)
  const baseline = readJson(path.join(directory, 'forward-checkpoint.json'), 32 * 1024 * 1024)
  if (!baseline || baseline.checkpoint_sha256 !== role.launch.request.checkpoint_sha256) throw failure()
  assertWorkspaceInterruptedForwardProgress(baseline, scope.checkpoint)
  const selected = scope.checkpoint.selected
  if (!selected || !scope.checkpoint.recovery_commit || scope.catalog_sha256 !== selected.catalog_sha256 || scope.catalog_revision !== selected.catalog_revision
    || hash(scope.root) !== hash(scope.checkpoint.published?.target)
    || hash(archived ? readWorkspaceForwardRelocationMaterials(ctx.data, id) : readWorkspaceInterruptedRelocationCheckpoint(ctx.data, id).materials) !== hash(scope.checkpoint.materials)
    || hash(readJson(ctx.fence) ?? null) !== hash(fence ?? null) || hash(frame(ctx.control)) !== hash(control) || hash(frame(original.path)) !== hash(original)) throw failure()
  if (archived) {
    frame(ctx.parent); frame(ctx.job)
    if (!stored || fs.readdirSync(ctx.job).some(name => !['forward-committed.json', 'original'].includes(name))) throw failure()
  }
  const facts = { marker, scope, checkpoint: scope.checkpoint, root: scope.root, original, role, archived }
  if (fence?.intent_id === id) return { ...facts, released: false, release: null }
  if (!archived) throw failure()
  const parent = path.dirname(role.launch.control_root.path), names = fs.readdirSync(parent).sort(), matches = []
  frame(parent)
  for (const recoveryId of names) {
    if (!uuid(recoveryId)) throw failure()
    const directory = path.join(parent, recoveryId), guard = readJson(path.join(directory, 'forward-released-guard.json'))
    if (!guard || guard.intent_id !== id) continue
    frame(directory)
    if (hash(guard) !== hash(marker)) throw failure()
    matches.push({ role: readWorkspaceInterruptedRecoveryRole(dataDir, recoveryId), release: readJson(path.join(directory, 'forward-release.json')) })
  }
  if (matches.length !== 1 || hash(fs.readdirSync(parent).sort()) !== hash(names)) throw failure()
  const { role: releasedRole, release } = matches[0], job = release?.job
  if (!exact(release, ['schema_version', 'job', 'scope_sha256']) || release.schema_version !== 2 || release.scope_sha256 !== marker.scope_sha256
    || !exact(job, ['intent_id', 'recovery_id', 'checkpoint_sha256', 'launch_sha256', 'plan_sha256', 'instance_id', 'admin_runtime_id'])
    || job.intent_id !== id || !uuid(job.recovery_id) || !uuid(job.instance_id) || !uuid(job.admin_runtime_id)
    || !digest(job.checkpoint_sha256) || !digest(job.launch_sha256) || !digest(job.plan_sha256)
    || !releasedRole.launch || !releasedRole.ready || releasedRole.launch.action !== 'finish_commit' || hash(releasedRole.launch) !== job.launch_sha256
    || hash(releasedRole.launch.request) !== hash({ intent_id: id, recovery_id: job.recovery_id, checkpoint_sha256: job.checkpoint_sha256 })
    || hash(readJson(path.join(releasedRole.launch.control_root.path, 'runtime-plan.json'))) !== job.plan_sha256) throw failure()
  return { ...facts, released: true, release }
}
export async function prepareWorkspaceInterruptedForwardService({ dataDir, recoveryId, launchHash }) {
  const options = { dataDir, recoveryId, launchHash }, role = verifyWorkspaceInterruptedRecoveryRole(options), id = role.launch.request.intent_id
  if (role.launch.action !== 'finish_commit') throw failure()
  const ctx = workspaceInterruptedForwardPaths(dataDir, id), previous = readWorkspaceInterruptedForwardPreparation(ctx.data, id)
  if (previous) {
    const catalog = await new WorkspaceCatalog({ dataRoot: ctx.data, storageRoot: process.env.WORKER_WORKSPACES_DIR, files: native }).snapshot()
    verifyWorkspaceInterruptedRecoveryRole(options)
    if (hash(catalog) !== previous.scope.catalog_sha256 || hash(frame(previous.root.path, false)) !== hash(previous.root)) throw failure()
    return Object.freeze({ prepared: true, scope_sha256: previous.marker.scope_sha256 })
  }
  const checkpoint = readWorkspaceInterruptedRelocationCheckpoint(dataDir, id)
  const verify = () => {
    verifyWorkspaceInterruptedRecoveryRole(options)
    if (hash(readWorkspaceInterruptedRelocationCheckpoint(ctx.data, id)) !== hash(checkpoint)) throw failure()
  }
  const catalog = await new WorkspaceCatalog({ dataRoot: ctx.data, storageRoot: process.env.WORKER_WORKSPACES_DIR, files: native }).snapshot()
  verify()
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
