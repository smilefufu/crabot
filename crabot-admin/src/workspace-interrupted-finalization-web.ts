import path from 'node:path'
import { RpcError, sha256CanonicalJson, assertWorkspaceExecutionAllowed } from 'crabot-shared'
import type { WorkspaceInterruptedRecoveryRequest, WorkspaceInterruptedRecoveryWebJob, WorkspaceInterruptedRecoveryWebPrepared, WorkspaceInterruptedRecoveryWebResumed } from 'crabot-shared'
import { observeCurrentWorkspaceAdmin } from './workspace-recovery-auth.js'
interface Options {
  dataDir: string
  moduleManagerPort: number
  modulePort: number
  runtimeIdentity: () => { instance_id?: string; module_id: string; runtime_id?: string }
  quiesce: (released: boolean) => Promise<void>
  resume: (verify: () => Promise<void>) => Promise<void>
  reclose: () => Promise<void>
}
const failure = () => new RpcError('SERVICE_UNAVAILABLE', '工作区恢复的当前Web交接尚未核实，未确认业务已恢复。')
const exact = (value: any, fields: string[]) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === fields.length && fields.every(key => Object.prototype.hasOwnProperty.call(value, key))
/** Private current-role Web handoff; human JWTs and old archived-job credentials do not select this role. */
export function createWorkspaceInterruptedFinalizationWeb(options: Options) {
  let preparation: { fingerprint: string; failed: boolean; pending: Promise<WorkspaceInterruptedRecoveryWebPrepared>; resumed?: Promise<WorkspaceInterruptedRecoveryWebResumed> } | undefined
  async function scope(input: unknown, bearer: string | undefined, action: 'prepare_web' | 'resume_web') {
    if (!bearer) throw new RpcError('UNAUTHORIZED', '缺少当前收尾凭据。')
    const parse = require('../../scripts/lib/workspace-interrupted-role.mjs').parseWorkspaceInterruptedRecoveryRequest
    const request = parse(input) as WorkspaceInterruptedRecoveryRequest, actor = observeCurrentWorkspaceAdmin(options)
    const scopes = require('../../scripts/lib/workspace-interrupted-service-scope.mjs')
    const authenticate = async () => {
      actor.verify()
      const rpc = await require('../../scripts/lib/pinned-process-rpc.cjs').openPinnedProcessRpc(actor.parent, options.moduleManagerPort, { source: 'admin-web', timeoutMs: 5000 })
      try {
        const result = await rpc.call('verify_workspace_interrupted_recovery_web', { action }, { authorizationBearer: bearer })
        actor.verify()
        const keys = ['verified', 'intent_id', 'recovery_id', 'checkpoint_sha256', 'launch_sha256', 'plan_sha256', 'instance_id', 'admin_runtime_id', 'action']
        if (!exact(result, keys) || result.verified !== true || result.action !== action || result.instance_id !== actor.runtime.instance_id
          || result.admin_runtime_id !== actor.runtime.runtime_id || ['intent_id', 'recovery_id', 'checkpoint_sha256'].some(key => result[key] !== request[key as keyof typeof request])) throw failure()
        const { verified: _, action: purpose, ...job } = result
        return job as WorkspaceInterruptedRecoveryWebJob
      } finally { rpc.close() }
    }
    const job = await authenticate(), fingerprint = sha256CanonicalJson(job), original = scopes.readWorkspaceInterruptedServiceScope(options.dataDir, request.recovery_id)
    const role = require('../../scripts/lib/workspace-interrupted-role.mjs').readWorkspaceInterruptedRecoveryRole(options.dataDir, request.recovery_id)
    const plan = require('../../scripts/lib/workspace-interrupted-runtime.mjs').readWorkspaceInterruptedRuntimePlan(options.dataDir, request.recovery_id)
    const native = require('../../scripts/lib/process-identity.cjs')
    if (!role.launch || !role.ready || !plan || sha256CanonicalJson(role.launch) !== job.launch_sha256 || sha256CanonicalJson(plan) !== job.plan_sha256
      || !native.sameProcess(role.launch.parent, actor.parent)) throw failure()
    if (action === 'resume_web' && (!original.released || !preparation || preparation.fingerprint !== fingerprint || preparation.failed)) throw failure()
    const verify = async () => {
      actor.verify()
      const current = scopes.readWorkspaceInterruptedServiceScope(options.dataDir, request.recovery_id)
      if (sha256CanonicalJson(current.marker) !== sha256CanonicalJson(original.marker) || action === 'resume_web' && !current.released
        || sha256CanonicalJson(await authenticate()) !== fingerprint) throw failure()
      actor.verify()
    }
    await verify()
    return { job, fingerprint, verify, released: original.released }
  }
  return Object.freeze({
    async prepare(input: unknown, bearer?: string) {
      const current = await scope(input, bearer, 'prepare_web')
      if (!preparation || preparation.fingerprint !== current.fingerprint) {
        const pending = Promise.resolve().then(async () => {
          try {
            await current.verify(); await options.quiesce(current.released); await current.verify()
            return Object.freeze({ prepared: true as const, ...current.job })
          } catch (cause) {
            if (preparation?.fingerprint === current.fingerprint) preparation.failed = true
            throw cause
          }
        })
        preparation = { fingerprint: current.fingerprint, failed: false, pending }
      }
      const own = preparation
      if (own.failed) throw failure()
      const result = await own.pending
      await current.verify()
      if (preparation !== own || own.failed) throw failure()
      return result
    },
    async resume(input: unknown, bearer?: string) {
      const current = await scope(input, bearer, 'resume_web'), own = preparation!
      own.resumed ??= Promise.resolve().then(async () => {
        try {
          await current.verify(); assertWorkspaceExecutionAllowed(path.resolve(options.dataDir))
          await options.resume(current.verify); await current.verify()
          if (preparation !== own || own.failed) throw failure()
          return Object.freeze({ resumed: true as const, ...current.job })
        } catch (cause) {
          own.failed = true; await options.reclose()
          throw cause
        }
      })
      return own.resumed
    },
  })
}
