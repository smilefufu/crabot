// Precommit filesystem recovery only. It does not retire Workers, select a catalog or release maintenance.
import fs from 'node:fs'
import path from 'node:path'
import native from './process-identity.cjs'
import exits from './known-process-exit.cjs'
import { verifyWorkspaceInterruptedRecoveryRole } from './workspace-interrupted-role.mjs'
import { inspectWorkspaceInterruptedRelocation, inspectWorkspaceInterruptedCheckpoint } from './workspace-interrupted-recovery.mjs'
import { readPendingWorkspaceSourceRestoration, workspaceSourceRestorationPaths } from './workspace-interrupted-source-records.mjs'
import { readWorkspaceInterruptedRelocationCheckpoint } from './workspace-relocation-intent.mjs'
import { sha256CanonicalJson as hash } from '../../crabot-shared/dist/canonical-json.js'
import { createWorkspaceMaintenanceFileAccess } from '../../crabot-agent/dist/core/workspace-maintenance-files.js'
const failure = () => Object.assign(new Error('尚未核实恢复原位置完成，原文件和维护保护已保留；不会自动续跑旧任务。'), { code: 'WORKSPACE_RELOCATION_INVALID' })
const { publish, syncDirectory } = createWorkspaceMaintenanceFileAccess(failure)

function executionExited(checkpoint) {
  if (!checkpoint.execution_exit || !checkpoint.process_stops?.completion) throw failure()
  const processes = [...checkpoint.process_stops.observations.at(-1).processes,
    ...checkpoint.modules.modules.flatMap(module => module.processes), ...checkpoint.module_stops.observations.flatMap(row => row.processes)]
  if (exits.probeKnownProcessExit(processes).state !== 'stopped') throw failure()
}
export async function restoreWorkspaceInterruptedSource({ dataDir, recoveryId, launchHash, signal }) {
  const roleOptions = { dataDir, recoveryId, launchHash }, role = verifyWorkspaceInterruptedRecoveryRole(roleOptions), request = role.launch.request
  const ctx = workspaceSourceRestorationPaths(dataDir, request.intent_id)
  if (fs.existsSync(ctx.fence)) {
    const pending = readPendingWorkspaceSourceRestoration(dataDir, request.intent_id)
    const verify = () => { verifyWorkspaceInterruptedRecoveryRole(roleOptions); executionExited(pending.checkpoint) }
    const observed = await inspectWorkspaceInterruptedCheckpoint(pending.checkpoint, verify, signal)
    const { readJson } = createWorkspaceMaintenanceFileAccess(failure)
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
    executionExited(checkpoint)
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
