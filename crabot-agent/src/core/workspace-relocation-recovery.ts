import path from 'node:path'
import { sha256CanonicalJson } from 'crabot-shared'
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
