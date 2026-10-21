import path from 'node:path'
import { sha256CanonicalJson } from 'crabot-shared'
import { commitWorkspaceRelocationLedgers } from './workspace-relocation-commit.js'
import { captureWorkspaceRelocationLedgers } from './workspace-relocation-ledgers.js'
import { prepareWorkspaceRelocationWorkerClosure } from '../workers/harness/workspace-relocation-close.js'

/** Fixed offline entry; no UnifiedAgent, Manager recovery, model or business ingress graph. */
export async function prepareWorkspaceRelocationClosure({ dataDir, id, signal }: { dataDir: string; id: string; signal?: AbortSignal }) {
  const records = require(path.join(__dirname, '../../../scripts/lib/workspace-relocation-intent.mjs'))
  let stage = 'authority'
  try {
    await records.verifyWorkspaceRelocationClosureReadiness({ dataDir, id, signal })
    stage = 'existing-plan'
    const previous = records.readWorkspaceRelocationClosurePlan(dataDir, id)
    if (previous) return { dispatch: 'observe' as const, plan_sha256: sha256CanonicalJson(previous) }
    const bindings = records.readWorkspaceRelocationClosureBindings(dataDir, id)
    stage = 'ledger-capture'
    const snapshot = await captureWorkspaceRelocationLedgers(dataDir, { signal }), closedAt = new Date().toISOString()
    const scope = records.readWorkspaceRelocationWorkers(dataDir, id)
    stage = 'ledger-transform'
    const prepared = prepareWorkspaceRelocationWorkerClosure({ intentId: id, closedAt, workers: scope.workers, ledgers: snapshot.files })
    const byManager = new Map(prepared.map(item => [item.manager_key, item]))
    const manifest = { bindings, closed_at: closedAt, directories: snapshot.directories, names: snapshot.names,
      ledgers: snapshot.files.map(file => {
        const item = byManager.get(file.manager_key)!
        return { name: file.name, manager_key: file.manager_key, before_version: file.version,
          before_sha256: item.before_sha256, after_sha256: item.after_sha256, closed_worker_ids: item.closed_worker_ids }
      }) }
    stage = 'plan-publish'
    const result = await records.prepareWorkspaceRelocationClosurePlan({ dataDir, id, manifest, signal })
    return { dispatch: result.dispatch as 'dispatch' | 'observe', plan_sha256: sha256CanonicalJson(result.plan) }
  } catch (cause) {
    throw Object.assign(new Error('固定执行器关闭计划准备失败；原台账及维护保护保留。'), { code: 'CRABOT_WORKSPACE_CLOSURE_PLAN', stage, cause })
  }
}


/** Fixed Agent-owned effects; the original coordinator remains authenticated throughout the finite commit. */
export async function commitWorkspaceRelocationClosure({ dataDir, id, signal }: { dataDir: string; id: string; signal?: AbortSignal }) {
  const records = require(path.join(__dirname, '../../../scripts/lib/workspace-relocation-intent.mjs'))
  let stage = 'authority'
  try {
    await records.verifyWorkspaceRelocationClosureReadiness({ dataDir, id, signal })
    const plan = records.readWorkspaceRelocationClosurePlan(dataDir, id)
    if (!plan) throw new Error('Missing original closure plan')
    const planHash = sha256CanonicalJson(plan)
    const verify = async () => {
      await records.verifyWorkspaceRelocationClosureReadiness({ dataDir, id, signal })
      if (sha256CanonicalJson(records.readWorkspaceRelocationClosurePlan(dataDir, id)) !== planHash) throw new Error('Original closure plan changed')
    }
    stage = 'ledger-capture'
    const snapshot = await captureWorkspaceRelocationLedgers(dataDir, { signal })
    stage = 'ledger-transform'
    const prepared = prepareWorkspaceRelocationWorkerClosure({ intentId: id, closedAt: plan.closed_at,
      workers: records.readWorkspaceRelocationWorkers(dataDir, id).workers, ledgers: snapshot.files })
    stage = 'ledger-commit'
    return await commitWorkspaceRelocationLedgers({ snapshot, plan, prepared, verify })
  } catch (cause) {
    throw Object.assign(new Error('固定执行器关闭尚未全部核实，已保留提交事实和维护保护。'), { code: 'CRABOT_WORKSPACE_CLOSURE_COMMIT', stage, cause })
  }
}
