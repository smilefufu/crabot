// Public recovery observations only; never reconstruct a role or execution authority.
import fs from 'node:fs'
import path from 'node:path'
import * as original from './workspace-relocation-intent.mjs'
import { readWorkspaceSourceRecoveryScope, workspaceSourceRestorationPaths, assertWorkspaceSourceRootCurrent } from './workspace-interrupted-source-records.mjs'
import { readWorkspaceInterruptedForwardPreparation, forwardFinalizingName } from './workspace-interrupted-forward-records.mjs'
import { assertWorkspaceInterruptedActorsExited, assertWorkspaceInterruptedRecoveriesExited, readWorkspaceInterruptedRecoveryRole } from './workspace-interrupted-role.mjs'
import { assertWorkspaceInterruptedOriginalExecutionExited } from './workspace-interrupted-source-restore.mjs'
import { readWorkspaceInterruptedPositions } from './workspace-interrupted-recovery.mjs'
import { assertWorkspaceInterruptedRootCurrent, readWorkspaceInterruptedServiceScope } from './workspace-interrupted-service-scope.mjs'
import { readWorkspaceInterruptedRuntimePlan } from './workspace-interrupted-runtime.mjs'
import { sha256CanonicalJson as hash } from '../../crabot-shared/dist/canonical-json.js'
import { createWorkspaceMaintenanceFileAccess } from '../../crabot-agent/dist/core/workspace-maintenance-files.js'
const failure = () => Object.assign(new Error('原工作区恢复材料或停止范围尚未核实，原数据与维护保护已保留。'), { code: 'SERVICE_UNAVAILABLE' })
const { owned, readJson } = createWorkspaceMaintenanceFileAccess(failure)
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
function activeIntent(dataDir) {
  try { fs.lstatSync(path.join(dataDir, 'workspace-control/relocation-active')) }
  catch (error) { if (error.code === 'ENOENT') return null; throw error }
  return original.readWorkspaceRelocationIntent(dataDir)
}
function wasResumed(dataDir, facts) {
  const parent = path.join(dataDir, 'workspace-control/relocation-recovery'), names = fs.readdirSync(parent).sort()
  owned(parent, true, true)
  let complete = false
  for (const recoveryId of names) {
    const directory = path.join(parent, recoveryId), record = readJson(path.join(directory, 'service-resumed.json'))
    if (!record || record.job?.intent_id !== facts.checkpoint.intent.id) continue
    const role = readWorkspaceInterruptedRecoveryRole(dataDir, recoveryId), job = record.job, scope = readWorkspaceInterruptedServiceScope(dataDir, recoveryId)
    const plan = readWorkspaceInterruptedRuntimePlan(dataDir, recoveryId)
    if (!exact(record, ['schema_version', 'job', 'scope_sha256']) || record.schema_version !== 2 || record.scope_sha256 !== facts.marker.scope_sha256
      || !exact(job, ['intent_id', 'recovery_id', 'checkpoint_sha256', 'launch_sha256', 'plan_sha256', 'instance_id', 'admin_runtime_id'])
      || !role.launch || !role.ready || role.launch.action !== facts.checkpoint.action || hash(scope.marker) !== hash(facts.marker)
      || job.recovery_id !== recoveryId || job.launch_sha256 !== hash(role.launch)
      || hash(role.launch.request) !== hash({ intent_id: job.intent_id, recovery_id: job.recovery_id, checkpoint_sha256: job.checkpoint_sha256 })
      || !plan || plan.schema_version !== 2 || plan.recovery_id !== recoveryId || plan.launch_sha256 !== job.launch_sha256
      || hash(plan) !== job.plan_sha256 || plan.instance_id !== job.instance_id || plan.admin_runtime_id !== job.admin_runtime_id) throw failure()
    complete = true
  }
  if (hash(fs.readdirSync(parent).sort()) !== hash(names)) throw failure()
  return complete
}
export function readWorkspaceInterruptedRecoveryFacts(dataDir, id) {
  const active = activeIntent(dataDir)
  const source = workspaceSourceRestorationPaths(dataDir, id), marker = readJson(source.fence)
  if (marker?.intent_id === id || fs.existsSync(source.job)) return { kind: 'source', ...readWorkspaceSourceRecoveryScope(dataDir, id) }
  if (!fs.existsSync(source.control)) return null
  const forward = readWorkspaceInterruptedForwardPreparation(dataDir, id)
  if (forward) return { kind: 'forward', ...forward }
  return active?.id === id ? { kind: 'active', checkpoint: original.readWorkspaceInterruptedRelocationCheckpoint(dataDir, id), released: false } : null
}
export function previewWorkspaceInterruptedRecovery(dataDir, id) {
  const facts = readWorkspaceInterruptedRecoveryFacts(dataDir, id)
  if (!facts) return null
  const checkpoint = facts.checkpoint
  if (!checkpoint.coordinator?.ready || !checkpoint.modules) return null
  assertWorkspaceInterruptedActorsExited(checkpoint)
  assertWorkspaceInterruptedRecoveriesExited(dataDir, id)
  assertWorkspaceInterruptedOriginalExecutionExited(checkpoint)
  if (facts.released && wasResumed(dataDir, facts)) return null
  if (facts.kind === 'source') assertWorkspaceSourceRootCurrent(facts)
  else if (facts.kind === 'forward') assertWorkspaceInterruptedRootCurrent(facts)
  else readWorkspaceInterruptedPositions(checkpoint)
  if (checkpoint.action === 'finish_commit' && !checkpoint.closure_plan) throw failure()
  return Object.freeze({ intent_id: id, checkpoint_sha256: checkpoint.checkpoint_sha256, action: checkpoint.action })
}
/** null delegates to the original normal/complete-archive observer, not an empty job assertion. */
export function readWorkspaceInterruptedJobStatus(dataDir, requestedId) {
  try {
    const active = activeIntent(dataDir), control = path.join(dataDir, 'workspace-control')
    const source = readJson(path.join(control, 'relocation-source-finalizing.json')), forward = readJson(path.join(control, forwardFinalizingName))
    if (source && forward) throw failure()
    const id = requestedId ?? active?.id ?? source?.intent_id ?? forward?.intent_id
    if (!id) return null
    // Ordinary active progress keeps its original cheap observer; an explicit
    // recovery preview, not every status poll, reads the whole checkpoint.
    if (active?.id === id && source?.intent_id !== id && forward?.intent_id !== id) return null
    const facts = readWorkspaceInterruptedRecoveryFacts(dataDir, id)
    if (!facts) return null
    const checkpoint = facts.checkpoint
    return { available: true, job: { intent_id: id, state: facts.released ? 'committed' : 'needs_attention',
      stage: facts.released ? 'finished' : facts.kind === 'source' ? 'restoring' : facts.kind === 'forward' ? 'finalizing' : 'unknown',
      source: checkpoint.intent.source.path, target: checkpoint.intent.target, ...(facts.kind === 'source' ? { outcome: 'source_restored' } : {}) } }
  } catch { return { available: false, job: null } }
}
