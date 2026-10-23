import path from 'node:path'
import fs from 'node:fs'
import { RpcError, sha256CanonicalJson } from 'crabot-shared'
import type { PrepareWorkspaceRelocationRecoveryCompletionResult, VerifyWorkspaceRelocationRecoveryFinalizationResult } from 'crabot-shared'
import { WorkspaceCatalog } from 'crabot-shared/dist/workspace-catalog.js'
import { observeCurrentWorkspaceAdmin } from './workspace-recovery-auth.js'

interface Options {
  dataDir: string
  moduleManagerPort: number
  modulePort: number
  runtimeIdentity: () => { instance_id?: string; module_id: string; runtime_id?: string }
  quiesce: () => Promise<void>
}
const native = require('../../scripts/lib/process-identity.cjs')
const admission = require('../../scripts/lib/workspace-recovery-admission.mjs')
const recovery = require('../../scripts/lib/workspace-recovery-records.mjs')
const { openPinnedProcessRpc } = require('../../scripts/lib/pinned-process-rpc.cjs')
const unavailable = () => new RpcError('SERVICE_UNAVAILABLE', '当前恢复完成准备无法核实，原业务维护已保留。')
const exact = (value: unknown, fields: string[]): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === fields.length && fields.every(key => Object.prototype.hasOwnProperty.call(value, key))
const digest = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)

/** Preparation for a current recovery role; archived normal credentials cannot authorize it. */
export function createWorkspaceRecoveryFinalizationWeb(options: Options) {
  const dataDir = path.resolve(options.dataDir)
  let preparation: { fingerprint: string; failed: boolean; pending: Promise<PrepareWorkspaceRelocationRecoveryCompletionResult> } | undefined
  async function scope(params: unknown, bearer?: string) {
    if (!bearer) throw new RpcError('UNAUTHORIZED', '缺少当前恢复完成凭据。')
    let actor: ReturnType<typeof observeCurrentWorkspaceAdmin>
    try { actor = observeCurrentWorkspaceAdmin(options) }
    catch (cause) { throw Object.assign(unavailable(), { cause }) }
    const authenticate = async (): Promise<VerifyWorkspaceRelocationRecoveryFinalizationResult> => {
      let rpc
      try {
        actor.verify()
        rpc = await openPinnedProcessRpc(actor.parent, options.moduleManagerPort, { source: 'admin-web', timeoutMs: 5000 })
        const result = await rpc.call('verify_workspace_relocation_recovery_finalization', { action: 'prepare_web' }, { authorizationBearer: bearer })
        actor.verify()
        if (!exact(result, ['verified', 'intent_id', 'recovery_id', 'completion_sha256', 'finalizing_sha256', 'launch_sha256', 'plan_sha256', 'instance_id', 'admin_runtime_id', 'action'])
          || result.verified !== true || result.action !== 'prepare_web' || !digest(result.launch_sha256) || !digest(result.plan_sha256)
          || result.instance_id !== actor.runtime.instance_id || result.admin_runtime_id !== actor.runtime.runtime_id) throw unavailable()
        admission.parseWorkspaceRecoveryAdmissionRequest({ intent_id: result.intent_id, recovery_id: result.recovery_id,
          completion_sha256: result.completion_sha256, finalizing_sha256: result.finalizing_sha256 })
        return Object.freeze(result) as unknown as VerifyWorkspaceRelocationRecoveryFinalizationResult
      } catch (cause) {
        const code = (cause as { remote_code?: string }).remote_code
        if (code && ['UNAUTHORIZED', 'FORBIDDEN', 'INVALID_PARAMS'].includes(code)) throw new RpcError(code, '当前恢复完成角色拒绝认证。')
        if (cause instanceof RpcError) throw cause
        throw Object.assign(unavailable(), { cause })
      } finally { rpc?.close() }
    }
    // The credential chooses the canonical job before caller fields can select a recovery directory.
    const expected = await authenticate()
    let request
    try { request = admission.parseWorkspaceRecoveryAdmissionRequest(params) }
    catch { throw new RpcError('INVALID_PARAMS', '恢复完成准备只接受固定作业标识。') }
    if (['intent_id', 'recovery_id', 'completion_sha256', 'finalizing_sha256'].some(key => request[key] !== expected[key as keyof typeof expected])) {
      throw new RpcError('FORBIDDEN', '恢复完成准备与当前规范作业不匹配。')
    }
    const { verified, action, ...job } = expected, fingerprint = sha256CanonicalJson(job)
    const invalidate = () => { if (preparation?.fingerprint === fingerprint) preparation.failed = true }
    try {
      const original = admission.readWorkspaceRecoveryAdmissionScope(dataDir, request), workspaceRootOverride = process.env.WORKER_WORKSPACES_DIR
      const coordinator = recovery.readWorkspaceRecoveryCoordinator(dataDir, request.recovery_id), plan = recovery.readWorkspaceRecoveryRuntimePlan(dataDir, request.recovery_id)
      if (sha256CanonicalJson(coordinator.launch) !== expected.launch_sha256 || sha256CanonicalJson(plan) !== expected.plan_sha256) throw unavailable()
      const local = () => {
        actor.verify()
        if (process.env.WORKER_WORKSPACES_DIR !== workspaceRootOverride || admission.readWorkspaceRecoveryAdmissionScope(dataDir, request).fingerprint !== original.fingerprint
          || sha256CanonicalJson(recovery.readWorkspaceRecoveryCoordinator(dataDir, request.recovery_id)) !== sha256CanonicalJson(coordinator)
          || sha256CanonicalJson(recovery.readWorkspaceRecoveryRuntimePlan(dataDir, request.recovery_id)) !== expected.plan_sha256) throw unavailable()
        const target = original.state.published.target, stat = fs.lstatSync(target.path, { bigint: true })
        const actual = { path: target.path, dev: String(stat.dev), ino: String(stat.ino), native_id: process.platform === 'win32' ? native.inspectDirectoryFileId(target.path) : null }
        if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(target.path) !== target.path || sha256CanonicalJson(actual) !== sha256CanonicalJson(target)) throw unavailable()
      }
      const verify = async () => {
        try {
          if (preparation?.fingerprint === fingerprint && preparation.failed) throw unavailable()
          local()
          if (sha256CanonicalJson(await authenticate()) !== sha256CanonicalJson(expected)) throw unavailable()
          local()
          const snapshot = await new WorkspaceCatalog({ dataRoot: dataDir, storageRoot: workspaceRootOverride, files: native }).snapshot()
          local()
          if (sha256CanonicalJson(snapshot) !== original.state.selected.catalog_sha256) throw unavailable()
        } catch (cause) { invalidate(); throw Object.assign(unavailable(), { cause }) }
      }
      await verify()
      return { fingerprint, job, verify, invalidate }
    } catch (cause) { invalidate(); if (cause instanceof RpcError) throw cause; throw Object.assign(unavailable(), { cause }) }
  }
  return Object.freeze({
    async prepare(input: unknown, bearer?: string): Promise<PrepareWorkspaceRelocationRecoveryCompletionResult> {
      const params = input && typeof input === 'object' && !Array.isArray(input) ? Object.freeze({ ...input }) : input
      const current = await scope(params, bearer)
      if (!preparation || preparation.fingerprint !== current.fingerprint) {
        const pending = Promise.resolve().then(async () => {
          try {
            await current.verify(); await options.quiesce(); await current.verify()
            return Object.freeze({ prepared: true as const, ...current.job })
          } catch (cause) { current.invalidate(); throw cause }
        })
        preparation = { fingerprint: current.fingerprint, failed: false, pending }
      }
      const currentPreparation = preparation
      if (currentPreparation.failed) throw unavailable()
      const result = await currentPreparation.pending
      await current.verify()
      if (preparation !== currentPreparation || currentPreparation.failed) throw unavailable()
      return result
    },
  })
}
