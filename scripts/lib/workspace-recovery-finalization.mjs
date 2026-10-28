// This new coordinator's fixed release only; an archived normal launch supplies facts, not authority.
import native from './process-identity.cjs'
import { openPinnedProcessRpc } from './pinned-process-rpc.cjs'
import { readWorkspaceRecoveryAdmissionScope, readWorkspaceRecoveryCompletionScope, inspectWorkspaceRecoveryControlFacts } from './workspace-recovery-admission.mjs'
import { readWorkspaceRecoveryCoordinator, readWorkspaceRecoveryRuntimePlan, readWorkspaceRecoveryRuntimeStart, verifyWorkspaceRecoveryRuntimeStart } from './workspace-recovery-records.mjs'
import { probeWorkspaceDirectory } from './workspace-root-probe.mjs'
import { commitWorkspaceRelocationFinalizing } from './workspace-relocation-intent.mjs'
import { sha256CanonicalJson as hash } from '../../crabot-shared/dist/canonical-json.js'
const fail = () => { throw Object.assign(new Error('当前恢复保护收口尚未确认，未重发效果。'), { code: 'CRABOT_WORKSPACE_RECOVERY_RELEASE' }) }

export async function releaseWorkspaceRecoveryFinalizing({ dataDir, launch, ready, prepared, credential, moduleManagerPort, verify: verifyOwner }) {
  if (typeof verifyOwner !== 'function' || typeof credential !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(credential)
    || !Number.isInteger(moduleManagerPort) || moduleManagerPort < 1 || moduleManagerPort > 65535) fail()
  verifyOwner()
  const request = launch.request, original = readWorkspaceRecoveryAdmissionScope(dataDir, request)
  const plan = readWorkspaceRecoveryRuntimePlan(dataDir, request.recovery_id), planHash = hash(plan)
  const { prepared: confirmed, ...job } = prepared ?? {}
  const expectedFields = ['intent_id', 'recovery_id', 'completion_sha256', 'finalizing_sha256', 'launch_sha256', 'plan_sha256', 'instance_id', 'admin_runtime_id']
  if (confirmed !== true || Object.keys(job).length !== expectedFields.length || !expectedFields.every(key => Object.hasOwn(job, key))
    || Object.keys(request).some(key => job[key] !== request[key]) || job.launch_sha256 !== hash(launch) || job.plan_sha256 !== planHash
    || job.instance_id !== original.state.health.root_proof.instance_id) fail()
  const starts = plan.modules.map(module => readWorkspaceRecoveryRuntimeStart(dataDir, request.recovery_id, module.module_id))
  if (starts.some(start => !start)) fail()
  const startHashes = starts.map(hash)
  const local = () => {
    verifyOwner()
    const current = readWorkspaceRecoveryCoordinator(dataDir, request.recovery_id)
    if (!process.connected || !native.sameProcess(launch.process, native.inspectProcess(process.pid))
      || !native.sameProcess(launch.parent, native.inspectProcess(launch.parent.pid)) || hash(current.launch) !== hash(launch) || hash(current.ready) !== hash(ready)
      || readWorkspaceRecoveryCompletionScope(dataDir, request).fingerprint !== original.fingerprint
      || hash(readWorkspaceRecoveryRuntimePlan(dataDir, request.recovery_id)) !== planHash) fail()
    for (let i = 0; i < starts.length; i++) verifyWorkspaceRecoveryRuntimeStart({ dataDir, recoveryId: request.recovery_id, moduleId: plan.modules[i].module_id,
      recordHash: startHashes[i], definitionHash: starts[i].definition_sha256 })
  }
  const authorize = async () => {
    local()
    const rpc = await openPinnedProcessRpc(launch.parent, moduleManagerPort, { timeoutMs: 30000 })
    try {
      local()
      const proof = await rpc.call('verify_workspace_relocation_recovery_release', request, { authorizationBearer: credential })
      local()
      if (hash(proof) !== hash({ verified: true, ...job })) fail()
    } finally { rpc.close() }
  }
  await authorize()
  const result = await commitWorkspaceRelocationFinalizing({ dataDir, id: request.intent_id, verify: authorize, assertCurrent: local, checkCapabilities: async verify => {
    const control = await inspectWorkspaceRecoveryControlFacts({ dataDir, request, verify, readScope: readWorkspaceRecoveryCompletionScope })
    await control.verify(); await verify()
    await probeWorkspaceDirectory({ directory: original.state.published.target, authorize: async () => { await verify(); return local } })
    await control.verify(); await verify()
  } })
  local(); await authorize(); local()
  if (!readWorkspaceRecoveryCompletionScope(dataDir, request).released
    || hash(result) !== hash({ intent_id: request.intent_id, completion_sha256: request.completion_sha256, finalizing_sha256: request.finalizing_sha256 })) fail()
  return Object.freeze({ released: true, ...job })
}
