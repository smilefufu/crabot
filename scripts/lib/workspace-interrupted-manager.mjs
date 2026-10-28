// Retire only original administrative recovery entries under the current role.
import path from 'node:path'
import { verifyWorkspaceInterruptedRecoveryRole } from './workspace-interrupted-role.mjs'
import * as records from './workspace-relocation-intent.mjs'
import { inspectWorkspaceInterruptedCheckpoint } from './workspace-interrupted-recovery.mjs'
import { sha256CanonicalJson as hash } from '../../crabot-shared/dist/canonical-json.js'
import { captureWorkspaceRelocationRecovery } from '../../crabot-agent/dist/core/workspace-relocation-recovery-capture.js'
import { assertWorkspaceRecoveryProgress, verifyWorkspaceRecoveryProgress } from '../../crabot-agent/dist/core/workspace-relocation-recovery-commit.js'
import { archiveWorkspaceRelocationCheckpoint } from '../../crabot-agent/dist/core/workspace-relocation-checkpoints.js'
import { publishWorkspaceRelocationRetirements } from '../../crabot-agent/dist/core/workspace-relocation-retirements.js'
import { createWorkspaceMaintenanceFileAccess } from '../../crabot-agent/dist/core/workspace-maintenance-files.js'
const failure = () => Object.assign(new Error('原自动恢复入口尚未全部封存，已保留历史和维护保护，不重投旧业务。'), { code: 'WORKSPACE_RELOCATION_INVALID' })
const { owned, readJson } = createWorkspaceMaintenanceFileAccess(failure)

export async function finishWorkspaceInterruptedManagerRecovery({ dataDir, recoveryId, launchHash, signal }) {
  const options = { dataDir, recoveryId, launchHash }, role = verifyWorkspaceInterruptedRecoveryRole(options), id = role.launch.request.intent_id
  const checkpoint = records.readWorkspaceInterruptedRelocationCheckpoint(dataDir, id)
  if (role.launch.action !== 'finish_commit' || !checkpoint.closure_commit) throw failure()
  const assertCurrent = () => { signal?.throwIfAborted(); verifyWorkspaceInterruptedRecoveryRole(options) }
  await inspectWorkspaceInterruptedCheckpoint(checkpoint, assertCurrent, signal)
  let plan = records.readWorkspaceRelocationRecoveryPlan(dataDir, id)
  if (!plan) {
    const snapshot = await captureWorkspaceRelocationRecovery(dataDir, { signal })
    plan = (await records.publishWorkspaceRelocationRecoveryPlan({ dataDir, id,
      manifest: { bindings: records.readWorkspaceRelocationClosureBindings(dataDir, id), worker_closure_sha256: hash(checkpoint.closure_commit), snapshot_sha256: hash(snapshot), snapshot },
      authorize: async () => assertCurrent(), assertCurrent, temporaryDirectory: role.launch.control_root.path })).plan
  }
  const planHash = hash(plan), previous = records.readWorkspaceRelocationRecoveryCommit(dataDir, id)
  const check = () => {
    assertCurrent()
    if (hash(records.readWorkspaceRelocationRecoveryPlan(dataDir, id)) !== planHash) throw failure()
    verifyWorkspaceRecoveryProgress(plan.snapshot)
  }
  const verify = async () => check()
  assertWorkspaceRecoveryProgress(plan.snapshot, await captureWorkspaceRelocationRecovery(dataDir, { signal }))
  const retirement = await publishWorkspaceRelocationRetirements({ dataDir, document: { schema_version: 1, intent_id: id,
    file_ready_sha256: plan.bindings.file_ready_sha256, worker_closure_sha256: plan.worker_closure_sha256, records: plan.snapshot.records }, verify })
  const checkpoints = [], checkpointVerifiers = []
  for (const [index, original] of plan.snapshot.checkpoints.entries()) {
    const receipt = await archiveWorkspaceRelocationCheckpoint({ dataDir, id, managerKey: original.manager_key, source: original.source,
      beforeVersion: original.before_version, beforeSha256: original.before_sha256, verify, requireComplete: !!previous,
      retainVerification: check => checkpointVerifiers.push(check) })
    checkpoints.push({ index, manifest_sha256: receipt.manifest_sha256, complete_sha256: receipt.complete_sha256 })
  }
  const current = await captureWorkspaceRelocationRecovery(dataDir, { signal })
  assertWorkspaceRecoveryProgress(plan.snapshot, current)
  if (current.checkpoints.length) throw failure()
  const verifyEffects = () => {
    check()
    const directory = path.join(dataDir, 'agent/workspace-relocation-retirements')
    owned(directory, true, true)
    if (hash(readJson(path.join(directory, id + '.json'), 32 * 1024 * 1024)) !== retirement.retirement_sha256) throw failure()
    for (const verify of checkpointVerifiers) verify()
  }
  return records.publishWorkspaceRelocationRecoveryCommit({ dataDir, id,
    manifest: { plan_sha256: planHash, retirement_sha256: retirement.retirement_sha256, checkpoints }, authorize: verify, assertCurrent: check, verifyEffects,
    temporaryDirectory: role.launch.control_root.path })
}
