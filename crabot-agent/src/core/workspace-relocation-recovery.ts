import fs from 'node:fs'
import path from 'node:path'
import { createWorkspaceMaintenanceFileAccess } from './workspace-maintenance-files.js'
import { sha256CanonicalJson } from 'crabot-shared'
import { publishWorkspaceRelocationRetirements } from './workspace-relocation-retirements.js'
import { archiveWorkspaceRelocationCheckpoint } from './workspace-relocation-checkpoints.js'
import { assertWorkspaceRecoveryProgress, verifyWorkspaceRecoveryProgress } from './workspace-relocation-recovery-commit.js'
import { captureWorkspaceRelocationRecovery } from './workspace-relocation-recovery-capture.js'

/** Fixed offline Agent role; no business startup, models or ordinary recovery. */
export async function prepareWorkspaceRelocationRecovery({ dataDir, id, signal }: { dataDir: string; id: string; signal?: AbortSignal }) {
  const records = require(path.join(__dirname, '../../../scripts/lib/workspace-relocation-intent.mjs'))
  let stage = 'authority'
  try {
    await records.verifyWorkspaceRelocationClosureReadiness({ dataDir, id, signal })
    if (!records.readWorkspaceRelocationClosureCommit(dataDir, id)) throw new Error('Original Worker closure is incomplete')
    stage = 'existing-plan'
    const previous = records.readWorkspaceRelocationRecoveryPlan(dataDir, id)
    if (previous) return { dispatch: 'observe' as const, plan_sha256: sha256CanonicalJson(previous) }
    stage = 'recovery-capture'
    const snapshot = await captureWorkspaceRelocationRecovery(dataDir, { signal })
    const manifest = { bindings: records.readWorkspaceRelocationClosureBindings(dataDir, id),
      worker_closure_sha256: sha256CanonicalJson(records.readWorkspaceRelocationClosureCommit(dataDir, id)),
      snapshot_sha256: sha256CanonicalJson(snapshot), snapshot }
    stage = 'plan-publish'
    const result = await records.prepareWorkspaceRelocationRecoveryPlan({ dataDir, id, manifest, signal })
    return { dispatch: result.dispatch as 'dispatch' | 'observe', plan_sha256: sha256CanonicalJson(result.plan) }
  } catch (cause) {
    throw Object.assign(new Error('原自动恢复责任尚未可靠固定，已保留原记录和维护保护。'), { code: 'CRABOT_WORKSPACE_RECOVERY_PLAN', stage, cause })
  }
}

/** The same finite Agent role closes original recovery entry points without settling their business records. */
export async function commitWorkspaceRelocationRecovery({ dataDir, id, signal }: { dataDir: string; id: string; signal?: AbortSignal }) {
  const records = require(path.join(__dirname, '../../../scripts/lib/workspace-relocation-intent.mjs'))
  let stage = 'authority'
  try {
    await records.verifyWorkspaceRelocationClosureReadiness({ dataDir, id, signal })
    const plan = records.readWorkspaceRelocationRecoveryPlan(dataDir, id)
    if (!plan) throw new Error('Missing original recovery plan')
    const planHash = sha256CanonicalJson(plan)
    // Reject damaged completion metadata before publishing retirements or removing any active checkpoint.
    records.readWorkspaceRelocationRecoveryCommit(dataDir, id)
    const verify = async () => {
      await records.verifyWorkspaceRelocationClosureReadiness({ dataDir, id, signal })
      if (sha256CanonicalJson(records.readWorkspaceRelocationRecoveryPlan(dataDir, id)) !== planHash) throw new Error('Original recovery plan changed')
      verifyWorkspaceRecoveryProgress(plan.snapshot)
    }
    stage = 'recovery-capture'
    assertWorkspaceRecoveryProgress(plan.snapshot, await captureWorkspaceRelocationRecovery(dataDir, { signal }))
    stage = 'retirement-publication'
    const retirement = await publishWorkspaceRelocationRetirements({ dataDir, document: { schema_version: 1, intent_id: id,
      file_ready_sha256: plan.bindings.file_ready_sha256, worker_closure_sha256: plan.worker_closure_sha256, records: plan.snapshot.records }, verify })
    const checkpointVerifiers: Array<() => void> = []
    const checkpoints: Array<{ index: number; manifest_sha256: string; complete_sha256: string }> = []
    stage = 'checkpoint-archive'
    for (const [index, checkpoint] of plan.snapshot.checkpoints.entries()) {
      const result = await archiveWorkspaceRelocationCheckpoint({ dataDir, id, managerKey: checkpoint.manager_key, source: checkpoint.source,
        beforeVersion: checkpoint.before_version, beforeSha256: checkpoint.before_sha256, verify, retainVerification: check => checkpointVerifiers.push(check) })
      checkpoints.push({ index, manifest_sha256: result.manifest_sha256, complete_sha256: result.complete_sha256 })
    }
    stage = 'recovery-verification'
    const current = await captureWorkspaceRelocationRecovery(dataDir, { signal })
    assertWorkspaceRecoveryProgress(plan.snapshot, current)
    if (current.checkpoints.length) throw new Error('Original active checkpoints remain')
    await verify()
    stage = 'completion-publication'
    const { owned, readJson } = createWorkspaceMaintenanceFileAccess(() => new Error('Recovery receipts changed'))
    const verifyEffects = () => {
      verifyWorkspaceRecoveryProgress(plan.snapshot)
      const directory = path.join(dataDir, 'agent/workspace-relocation-retirements')
      owned(directory, true, true)
      if (fs.realpathSync(directory) !== directory || sha256CanonicalJson(readJson(path.join(directory, id + '.json'), 32 * 1024 * 1024)) !== retirement.retirement_sha256) throw new Error('Retirement receipt changed')
      for (const check of checkpointVerifiers) check()
    }
    return await records.completeWorkspaceRelocationRecovery({ dataDir, id, signal,
      manifest: { plan_sha256: planHash, retirement_sha256: retirement.retirement_sha256, checkpoints },
      verifyEffects })
  } catch (cause) {
    throw Object.assign(new Error('原自动恢复责任尚未全部收口，已保留历史、提交事实和维护保护。'), { code: 'CRABOT_WORKSPACE_RECOVERY_COMMIT', stage, cause })
  }
}
