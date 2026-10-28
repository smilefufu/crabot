// Neutral Agent administrative primitives under the new current recovery role.
// No original Coordinator authority, old task execution or Worker closure.
import path from 'node:path'
import { verifyWorkspaceInterruptedRecoveryRole } from './workspace-interrupted-role.mjs'
import { readPendingWorkspaceSourceRestoration, workspaceSourceRestorationPaths } from './workspace-interrupted-source-records.mjs'
import { captureWorkspaceRelocationRecovery } from '../../crabot-agent/dist/core/workspace-relocation-recovery-capture.js'
import { assertWorkspaceRecoveryProgress, verifyWorkspaceRecoveryProgress } from '../../crabot-agent/dist/core/workspace-relocation-recovery-commit.js'
import { archiveWorkspaceRelocationCheckpoint } from '../../crabot-agent/dist/core/workspace-relocation-checkpoints.js'
import { WorkspaceRelocationRetirements } from '../../crabot-agent/dist/core/workspace-relocation-retirements.js'
import { createWorkspaceMaintenanceFileAccess } from '../../crabot-agent/dist/core/workspace-maintenance-files.js'
import { sha256CanonicalJson as hash } from '../../crabot-shared/dist/canonical-json.js'
const failure = () => Object.assign(new Error('原位置已保留，旧任务自动恢复入口尚未全部核实；维护保护已保留。'), { code: 'WORKSPACE_RELOCATION_INVALID' })
const { readJson, publish } = createWorkspaceMaintenanceFileAccess(failure)
export async function prepareWorkspaceInterruptedSourceBusiness(options) {
  const role = verifyWorkspaceInterruptedRecoveryRole(options), id = role.launch.request.intent_id
  const original = readPendingWorkspaceSourceRestoration(options.dataDir, id), ctx = workspaceSourceRestorationPaths(options.dataDir, id)
  if (!original.archived || role.launch.action !== 'restore_source') throw failure()
  const snapshot = original.scope.recovery_snapshot, previous = readJson(path.join(ctx.job, 'business-prepared.json'), 32 * 1024 * 1024)
  const verify = async () => {
    verifyWorkspaceInterruptedRecoveryRole(options)
    if (hash(readPendingWorkspaceSourceRestoration(options.dataDir, id).marker) !== hash(original.marker)) throw failure()
    verifyWorkspaceRecoveryProgress(snapshot)
  }
  await verify()
  assertWorkspaceRecoveryProgress(snapshot, await captureWorkspaceRelocationRecovery(ctx.data))
  // Historical source records are consumed as exact retired request/wake identities;
  // they are never recast as successful relocation/Worker-closure evidence.
  new WorkspaceRelocationRetirements(ctx.data).load()
  const checkpoints = []
  for (const [index, checkpoint] of snapshot.checkpoints.entries()) {
    const receipt = await archiveWorkspaceRelocationCheckpoint({ dataDir: ctx.data, id, managerKey: checkpoint.manager_key, source: checkpoint.source,
      beforeVersion: checkpoint.before_version, beforeSha256: checkpoint.before_sha256, verify, requireComplete: !!previous })
    checkpoints.push({ index, manifest_sha256: receipt.manifest_sha256, complete_sha256: receipt.complete_sha256 })
  }
  await verify()
  const current = await captureWorkspaceRelocationRecovery(ctx.data)
  assertWorkspaceRecoveryProgress(snapshot, current)
  if (current.checkpoints.length) throw failure()
  const complete = { schema_version: 2, intent_id: id, scope_sha256: original.marker.scope_sha256, checkpoints }
  if (previous && hash(previous) !== hash(complete)) throw failure()
  if (!previous) publish(ctx.job, 'business-prepared.json', complete, () => { verifyWorkspaceInterruptedRecoveryRole(options); verifyWorkspaceRecoveryProgress(snapshot) }, 32 * 1024 * 1024)
  await verify()
  if (hash(readJson(path.join(ctx.job, 'business-prepared.json'), 32 * 1024 * 1024)) !== hash(complete)) throw failure()
  return Object.freeze({ prepared: true })
}
