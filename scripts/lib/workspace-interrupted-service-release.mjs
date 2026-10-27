// Current health handoff and one guard move; action wrappers retain their own namespace.
import fs from 'node:fs'
import path from 'node:path'
import native from './process-identity.cjs'
import { verifyWorkspaceInterruptedRecoveryRole } from './workspace-interrupted-role.mjs'
import { workspaceSourceRestorationPaths } from './workspace-interrupted-source-records.mjs'
import { workspaceInterruptedForwardPaths } from './workspace-interrupted-forward-records.mjs'
import { readWorkspaceInterruptedServiceScope } from './workspace-interrupted-service-scope.mjs'
import { readWorkspaceInterruptedRuntimePlan } from './workspace-interrupted-runtime.mjs'
import { createWorkspaceMaintenanceFileAccess } from '../../crabot-agent/dist/core/workspace-maintenance-files.js'
import { sha256CanonicalJson as hash } from '../../crabot-shared/dist/canonical-json.js'
import { openPinnedProcessRpc } from './pinned-process-rpc.cjs'
const failure = () => Object.assign(new Error('工作区服务交接尚未核实，已保留文件及收尾记录；未重发恢复动作。'), { code: 'WORKSPACE_RELOCATION_INVALID' })
const { readJson, publish, syncDirectory } = createWorkspaceMaintenanceFileAccess(failure)
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
export async function releaseWorkspaceInterruptedProtection({ dataDir, recoveryId, launchHash, job, credential, moduleManagerPort }, action) {
  const options = { dataDir, recoveryId, launchHash }, role = verifyWorkspaceInterruptedRecoveryRole(options), request = role.launch.request
  if (!['restore_source', 'finish_commit'].includes(action) || role.launch.action !== action
    || !exact(job, ['intent_id', 'recovery_id', 'checkpoint_sha256', 'launch_sha256', 'plan_sha256', 'instance_id', 'admin_runtime_id'])
    || ['intent_id', 'recovery_id', 'checkpoint_sha256'].some(key => job[key] !== request[key]) || job.launch_sha256 !== launchHash
    || typeof credential !== 'string' || !credential || !Number.isInteger(moduleManagerPort) || moduleManagerPort < 1 || moduleManagerPort > 65535) throw failure()
  const original = readWorkspaceInterruptedServiceScope(dataDir, recoveryId)
  const ctx = (action === 'restore_source' ? workspaceSourceRestorationPaths : workspaceInterruptedForwardPaths)(dataDir, request.intent_id)
  const prefix = action === 'restore_source' ? 'source' : 'forward'
  const directory = role.launch.control_root.path
  const plan = readWorkspaceInterruptedRuntimePlan(dataDir, recoveryId)
  if (!original.facts.archived || original.released || !plan || hash(plan) !== job.plan_sha256 || plan.instance_id !== job.instance_id || plan.admin_runtime_id !== job.admin_runtime_id) throw failure()
  const current = () => {
    verifyWorkspaceInterruptedRecoveryRole(options)
    if (hash(readWorkspaceInterruptedRuntimePlan(dataDir, recoveryId)) !== hash(plan)
      || hash(readWorkspaceInterruptedServiceScope(dataDir, recoveryId).marker) !== hash(original.marker)) throw failure()
  }
  const rpc = await openPinnedProcessRpc(role.launch.parent, moduleManagerPort, { source: 'workspace-interrupted-recovery', timeoutMs: 5000 })
  try {
    const verify = async () => {
      current()
      const result = await rpc.call('verify_workspace_interrupted_recovery_web', { action: 'prepare_web' }, { authorizationBearer: credential })
      current()
      if (hash(result) !== hash({ verified: true, ...job, action: 'prepare_web' })) throw failure()
    }
    await verify()
    const record = { schema_version: 2, job: structuredClone(job), scope_sha256: original.marker.scope_sha256 }
    const previous = readJson(path.join(directory, prefix + '-release.json'))
    if (previous && hash(previous) !== hash(record)) throw failure()
    if (!previous) publish(directory, prefix + '-release.json', record, current)
    await verify()
    if (fs.existsSync(path.join(directory, prefix + '-released-guard.json')) || hash(readJson(ctx.fence)) !== hash(original.marker)) throw failure()
    current()
    native.renameFileNoReplace(ctx.fence, path.join(directory, prefix + '-released-guard.json'))
    syncDirectory(ctx.control); syncDirectory(directory)
    current()
    if (!readWorkspaceInterruptedServiceScope(dataDir, recoveryId).released) throw failure()
    return Object.freeze({ released: true, ...job })
  } finally { rpc.close() }
}
