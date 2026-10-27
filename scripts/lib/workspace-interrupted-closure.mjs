// Original closure effects under a fresh current role; never the old coordinator entry.
import exits from './known-process-exit.cjs'
import { verifyWorkspaceInterruptedRecoveryRole } from './workspace-interrupted-role.mjs'
import { inspectWorkspaceInterruptedCheckpoint } from './workspace-interrupted-recovery.mjs'
import { readWorkspaceInterruptedRelocationCheckpoint, readWorkspaceRelocationClosureCommit } from './workspace-relocation-intent.mjs'
import { sha256CanonicalJson as hash } from '../../crabot-shared/dist/canonical-json.js'
const failure = () => Object.assign(new Error('原执行器关闭提交尚未全部核实，已保留原计划和维护保护。'), { code: 'WORKSPACE_RELOCATION_INVALID' })

export async function finishWorkspaceInterruptedClosures({ dataDir, recoveryId, launchHash, signal }) {
  const options = { dataDir, recoveryId, launchHash }, role = verifyWorkspaceInterruptedRecoveryRole(options)
  const checkpoint = readWorkspaceInterruptedRelocationCheckpoint(dataDir, role.launch.request.intent_id)
  if (checkpoint.action !== 'finish_commit' || !checkpoint.execution_exit || !checkpoint.closure_plan) throw failure()
  const processes = [...(checkpoint.process_stops?.observations ?? []).flatMap(item => item.processes),
    ...(checkpoint.modules?.modules ?? []).flatMap(item => item.processes), ...(checkpoint.module_stops?.observations ?? []).flatMap(item => item.processes)]
  const verify = () => {
    signal?.throwIfAborted()
    verifyWorkspaceInterruptedRecoveryRole(options)
    if (exits.probeKnownProcessExit(processes).state !== 'stopped') throw failure()
  }
  await inspectWorkspaceInterruptedCheckpoint(checkpoint, verify, signal)
  const { captureWorkspaceRelocationLedgers } = await import('../../crabot-agent/dist/core/workspace-relocation-ledgers.js')
  const { prepareWorkspaceRelocationWorkerClosure } = await import('../../crabot-agent/dist/workers/harness/workspace-relocation-close.js')
  const { commitWorkspaceRelocationLedgers } = await import('../../crabot-agent/dist/core/workspace-relocation-commit.js')
  verify()
  const snapshot = await captureWorkspaceRelocationLedgers(dataDir, { signal }), plan = checkpoint.closure_plan
  const prepared = prepareWorkspaceRelocationWorkerClosure({ intentId: checkpoint.intent.id, closedAt: plan.closed_at, workers: checkpoint.workers.workers, ledgers: snapshot.files })
  const result = await commitWorkspaceRelocationLedgers({ snapshot, plan, prepared, verify: async () => verify() })
  verify()
  if (hash(readWorkspaceRelocationClosureCommit(dataDir, checkpoint.intent.id)) !== result.commit_sha256) throw failure()
  return result
}
