// Precommit filesystem recovery only. It does not retire Workers, select a catalog or release maintenance.
import fs from 'node:fs'
import path from 'node:path'
import native from './process-identity.cjs'
import exits from './known-process-exit.cjs'
import { verifyWorkspaceInterruptedRecoveryRole, readWorkspaceInterruptedRecoveryRole } from './workspace-interrupted-role.mjs'
import { inspectWorkspaceInterruptedRelocation, inspectWorkspaceInterruptedCheckpoint } from './workspace-interrupted-recovery.mjs'
import { readPendingWorkspaceSourceRestoration, workspaceSourceRestorationPaths } from './workspace-interrupted-source-records.mjs'
import { readWorkspaceInterruptedRelocationCheckpoint } from './workspace-relocation-intent.mjs'
import { sha256CanonicalJson as hash } from '../../crabot-shared/dist/canonical-json.js'
import { createWorkspaceMaintenanceFileAccess } from '../../crabot-agent/dist/core/workspace-maintenance-files.js'
const failure = () => Object.assign(new Error('尚未核实恢复原位置完成，原文件和维护保护已保留；不会自动续跑旧任务。'), { code: 'WORKSPACE_RELOCATION_INVALID' })
const { publish, readJson, syncDirectory } = createWorkspaceMaintenanceFileAccess(failure)

function executionScope(checkpoint) {
  if (!checkpoint.coordinator?.ready || !checkpoint.stops?.attempt || !checkpoint.stops.submission
    || !checkpoint.module_stops?.attempt || !checkpoint.module_stops.submission || !checkpoint.modules
    || checkpoint.module_stops.submission.results.some(item => item.status === 'unknown')
    || !checkpoint.process_stops?.completion || !checkpoint.process_stops.observations.length) throw failure()
  const processes = [...checkpoint.process_stops.observations.at(-1).processes,
    ...checkpoint.modules.modules.flatMap(module => module.processes), ...checkpoint.module_stops.observations.flatMap(row => row.processes)]
  if (exits.probeKnownProcessExit(processes).state !== 'stopped') throw failure()
  return hash({ coordinator: checkpoint.coordinator, workers: checkpoint.stops, modules: checkpoint.module_stops, processes: checkpoint.process_stops })
}
/** Current recovery's observation only; never fills the old coordinator's missing record. */
export function readWorkspaceInterruptedExecutionExit({ dataDir, recoveryId, checkpoint }) {
  const role = readWorkspaceInterruptedRecoveryRole(dataDir, recoveryId), scopeHash = executionScope(checkpoint)
  if (!role.launch || !role.ready || role.launch.request.intent_id !== checkpoint.intent.id
    || role.launch.request.checkpoint_sha256 !== checkpoint.checkpoint_sha256) throw failure()
  const record = readJson(path.join(role.launch.control_root.path, 'execution-exit.json'))
  if (!record) return null
  const { observed_at, ...facts } = record
  if (typeof observed_at !== 'string' || new Date(observed_at).toISOString() !== observed_at
    || hash(facts) !== hash({ schema_version: 2, recovery_id: recoveryId, launch_sha256: hash(role.launch),
      checkpoint_sha256: checkpoint.checkpoint_sha256, scope_sha256: scopeHash })) throw failure()
  return record
}
function executionExited(checkpoint, options) {
  const scopeHash = executionScope(checkpoint)
  if (checkpoint.execution_exit || readWorkspaceInterruptedExecutionExit({ ...options, checkpoint })) return
  const role = verifyWorkspaceInterruptedRecoveryRole(options)
  const verify = () => { verifyWorkspaceInterruptedRecoveryRole(options); if (executionScope(checkpoint) !== scopeHash) throw failure() }
  publish(role.launch.control_root.path, 'execution-exit.json', { schema_version: 2, recovery_id: options.recoveryId,
    launch_sha256: hash(role.launch), checkpoint_sha256: checkpoint.checkpoint_sha256, scope_sha256: scopeHash, observed_at: new Date().toISOString() }, verify)
  if (!readWorkspaceInterruptedExecutionExit({ ...options, checkpoint })) throw failure()
}
/** Observe only the original stopped scope, before cleaning prior validation carriers. */
export function observeWorkspaceInterruptedOriginalExit(options) {
  const role = verifyWorkspaceInterruptedRecoveryRole(options)
  if (role.launch.action !== 'restore_source') throw failure()
  const ctx = workspaceSourceRestorationPaths(options.dataDir, role.launch.request.intent_id)
  const checkpoint = fs.existsSync(ctx.fence)
    ? readPendingWorkspaceSourceRestoration(options.dataDir, role.launch.request.intent_id).checkpoint
    : readWorkspaceInterruptedRelocationCheckpoint(options.dataDir, role.launch.request.intent_id)
  executionExited(checkpoint, options)
  verifyWorkspaceInterruptedRecoveryRole(options)
  return Object.freeze({ original_execution_exited: true })
}
export async function restoreWorkspaceInterruptedSource({ dataDir, recoveryId, launchHash, signal }) {
  const roleOptions = { dataDir, recoveryId, launchHash }, role = verifyWorkspaceInterruptedRecoveryRole(roleOptions), request = role.launch.request
  const ctx = workspaceSourceRestorationPaths(dataDir, request.intent_id)
  if (fs.existsSync(ctx.fence)) {
    const pending = readPendingWorkspaceSourceRestoration(dataDir, request.intent_id)
    const verify = () => { verifyWorkspaceInterruptedRecoveryRole(roleOptions); executionExited(pending.checkpoint, roleOptions) }
    const observed = await inspectWorkspaceInterruptedCheckpoint(pending.checkpoint, verify, signal)
    const complete = readJson(path.join(pending.role.launch.control_root.path, 'source-complete.json'))
    if (!observed.positions.source || observed.content.fingerprint !== complete.content_sha256) throw failure()
    return Object.freeze({ source_restored: true, source: observed.positions.source.path, retained_staging: observed.positions.container?.path ?? null })
  }
  const parentPath = path.dirname(readWorkspaceInterruptedRelocationCheckpoint(dataDir, request.intent_id).intent.source.path)
  const parentFrame = () => {
    const stat = fs.lstatSync(parentPath, { bigint: true })
    if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(parentPath) !== parentPath) throw failure()
    return { path: parentPath, dev: String(stat.dev), ino: String(stat.ino), native_id: process.platform === 'win32' ? native.inspectDirectoryFileId(parentPath) : null }
  }
  const parent = parentFrame()
  const verify = () => {
    signal?.throwIfAborted()
    const current = verifyWorkspaceInterruptedRecoveryRole(roleOptions), checkpoint = readWorkspaceInterruptedRelocationCheckpoint(dataDir, request.intent_id)
    if (current.launch.action !== 'restore_source' || checkpoint.action !== 'restore_source' || hash(parentFrame()) !== hash(parent)) throw failure()
    executionExited(checkpoint, roleOptions)
  }
  verify()
  const before = await inspectWorkspaceInterruptedRelocation({ dataDir, id: request.intent_id, signal })
  verify()
  const plan = { schema_version: 2, recovery_id: recoveryId, launch_sha256: launchHash, checkpoint_sha256: request.checkpoint_sha256,
    source_parent: parent, positions: before.positions, content_sha256: before.content.fingerprint }
  publish(role.launch.control_root.path, 'source-plan.json', plan, verify)
  verify()
  const pins = []
  try {
    const current = await inspectWorkspaceInterruptedRelocation({ dataDir, id: request.intent_id, signal })
    verify()
    if (hash(current.positions) !== hash(before.positions) || current.content.fingerprint !== before.content.fingerprint) throw failure()
    if (!before.positions.source) {
      if (before.checkpoint.file_plan.mode !== 'rename' || !before.positions.tree || before.positions.published) throw failure()
      const source = before.checkpoint.intent.source.path, tree = before.positions.tree.path
      if (process.platform === 'win32') for (const directory of [path.dirname(source), before.positions.container.path]) pins.push(native.pinDirectory(directory))
      verify()
      native.renameDirectoryNoReplace(tree, source)
      syncDirectory(path.dirname(source)); syncDirectory(before.positions.container.path)
    }
    const restored = await inspectWorkspaceInterruptedRelocation({ dataDir, id: request.intent_id, signal })
    verify()
    if (!restored.positions.source || restored.positions.source.ino !== before.checkpoint.intent.source.ino
      || restored.content.fingerprint !== before.content.fingerprint) throw failure()
    const complete = { schema_version: 2, recovery_id: recoveryId, plan_sha256: hash(plan), source: restored.positions.source,
      content_sha256: restored.content.fingerprint, retained_staging: restored.positions.container }
    publish(role.launch.control_root.path, 'source-complete.json', complete, verify)
    verify()
    return Object.freeze({ source_restored: true, source: restored.positions.source.path, retained_staging: restored.positions.container?.path ?? null })
  } finally { for (const pin of pins.reverse()) native.releaseDirectoryPin(pin) }
}
