import path from 'node:path'
import { sha256CanonicalJson } from 'crabot-shared'
import { captureWorkspaceRelocationLedgers } from './workspace-relocation-ledgers.js'
import { prepareWorkspaceRelocationWorkerClosure } from '../workers/harness/workspace-relocation-close.js'

/** Fixed offline entry; no UnifiedAgent, Manager recovery, model or business ingress graph. */
export async function prepareWorkspaceRelocationClosure({ dataDir, id, signal }: { dataDir: string; id: string; signal?: AbortSignal }) {
  const records = require(path.join(__dirname, '../../../scripts/lib/workspace-relocation-intent.mjs'))
  await records.verifyWorkspaceRelocationClosureReadiness({ dataDir, id, signal })
  const previous = records.readWorkspaceRelocationClosurePlan(dataDir, id)
  if (previous) return { dispatch: 'observe' as const, plan_sha256: sha256CanonicalJson(previous) }
  const bindings = records.readWorkspaceRelocationClosureBindings(dataDir, id)
  const snapshot = await captureWorkspaceRelocationLedgers(dataDir, { signal }), closedAt = new Date().toISOString()
  const scope = records.readWorkspaceRelocationWorkers(dataDir, id)
  const prepared = prepareWorkspaceRelocationWorkerClosure({ intentId: id, closedAt, workers: scope.workers, ledgers: snapshot.files })
  const byManager = new Map(prepared.map(item => [item.manager_key, item]))
  const manifest = { bindings, closed_at: closedAt, directories: snapshot.directories, names: snapshot.names,
    ledgers: snapshot.files.map(file => {
      const item = byManager.get(file.manager_key)!
      return { name: file.name, manager_key: file.manager_key, before_version: file.version,
        before_sha256: item.before_sha256, after_sha256: item.after_sha256, closed_worker_ids: item.closed_worker_ids }
    }) }
  const result = await records.prepareWorkspaceRelocationClosurePlan({ dataDir, id, manifest, signal })
  return { dispatch: result.dispatch as 'dispatch' | 'observe', plan_sha256: sha256CanonicalJson(result.plan) }
}
