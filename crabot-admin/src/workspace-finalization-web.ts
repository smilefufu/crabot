import path from 'node:path'
import { RpcError, sha256CanonicalJson } from 'crabot-shared'
import type { PrepareWorkspaceRelocationCompletionParams, PrepareWorkspaceRelocationCompletionResult, ResumeWorkspaceRelocationWebResult, VerifyWorkspaceRelocationFinalizationResult, WorkspaceRelocationFinalizationAction } from 'crabot-shared'

interface Options {
  dataDir: string
  moduleManagerPort: number
  runtimeIdentity: () => { instance_id?: string; module_id: string; runtime_id?: string }
  quiesce: () => Promise<void>
  resume: () => void
}
const native = require('../../scripts/lib/process-identity.cjs')
const records = require('../../scripts/lib/workspace-relocation-intent.mjs')
const { openPinnedProcessRpc } = require('../../scripts/lib/pinned-process-rpc.cjs')
const unavailable = () => new RpcError('SERVICE_UNAVAILABLE', '当前作业完成角色或实时状态无法确认，维护保护已保留。')
const exact = (value: unknown, keys: string[]): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.prototype.hasOwnProperty.call(value, key))
interface PreparedBinding {
  request: PrepareWorkspaceRelocationCompletionParams
  expected: VerifyWorkspaceRelocationFinalizationResult
  stateHash: string
  fenceHash: string
}
const uuid = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value)

/** Current Admin's normal job only; old tokens and archived facts grant no authority. */
export function createWorkspaceFinalizationWeb(options: Options) {
  const dataDir = path.resolve(options.dataDir), self = native.inspectProcess(process.pid), runtime = Object.freeze({ ...options.runtimeIdentity() })
  let preparation: { fingerprint: string; pending: Promise<PrepareWorkspaceRelocationCompletionResult>; binding: PreparedBinding; resumed: boolean } | undefined
  async function scope(params: unknown, bearer: string | undefined, action: WorkspaceRelocationFinalizationAction) {
    if (!bearer) throw new RpcError('UNAUTHORIZED', 'Current job credential required')
    let state: any, fence: any
    try {
      if (action === 'prepare_web') {
        fence = records.readCurrentWorkspaceRelocationFinalizing(dataDir)
        if (!fence) throw new RpcError('FORBIDDEN', 'No current normal finalization job')
      } else {
        if (!preparation) throw new RpcError('FORBIDDEN', 'No current prepared job')
        fence = records.readWorkspaceRelocationReleased(dataDir, preparation.binding.request.intent_id)
        if (!fence) throw unavailable()
      }
      state = records.readWorkspaceRelocationArchivedState(dataDir, fence.intent_id)
    } catch (error) { if (error instanceof RpcError) throw error; throw unavailable() }
    const stateHash = sha256CanonicalJson(state), fenceHash = sha256CanonicalJson(fence)
    const request = Object.freeze({ intent_id: state.intent.id, launch_id: state.launch.launch_id, completion_sha256: sha256CanonicalJson(state.completion) })
    const expected: VerifyWorkspaceRelocationFinalizationResult = { verified: true, ...request, intent_sha256: state.completion.intent_sha256,
      launch_sha256: state.completion.launch_sha256, action }
    if (action === 'resume_web' && (stateHash !== preparation?.binding.stateHash || fenceHash !== preparation.binding.fenceHash)) throw unavailable()
    const local = () => {
      if (runtime.module_id !== 'admin-web' || !runtime.runtime_id || runtime.instance_id !== state.health.root_proof.instance_id
        || sha256CanonicalJson(options.runtimeIdentity()) !== sha256CanonicalJson(runtime)
        || !native.sameProcess(self, native.inspectProcess(process.pid)) || self.owner !== state.launch.parent.owner
        || !native.sameProcess(state.launch.parent, native.inspectProcess(state.launch.parent.pid))
        || !native.sameProcess(state.launch.process, native.inspectProcess(state.launch.process.pid))
        || sha256CanonicalJson(records.readWorkspaceRelocationArchivedState(dataDir, request.intent_id)) !== stateHash
        || sha256CanonicalJson(action === 'prepare_web' ? records.readWorkspaceRelocationFinalizing(dataDir, request.intent_id)
          : records.readWorkspaceRelocationReleased(dataDir, request.intent_id)) !== fenceHash) throw unavailable()
      if (action === 'resume_web') require('../../scripts/lib/workspace-maintenance.cjs').assertWorkspaceExecutionAllowed(dataDir)
    }
    const verify = async () => {
      let rpc: { call(method: string, params: unknown, options: { authorizationBearer: string }): Promise<unknown>; close(): void } | undefined
      try {
        local()
        rpc = await openPinnedProcessRpc(state.launch.parent, options.moduleManagerPort, { source: 'admin-web', timeoutMs: 5000 })
        local()
        const result = await rpc!.call('verify_workspace_relocation_finalization', { ...request, action }, { authorizationBearer: bearer })
        local()
        if (sha256CanonicalJson(result) !== sha256CanonicalJson(expected)) throw unavailable()
      } catch (error) {
        if (error instanceof RpcError) throw error
        const code = (error as { remote_code?: string }).remote_code
        if (code === 'UNAUTHORIZED' || code === 'FORBIDDEN' || code === 'INVALID_PARAMS') throw new RpcError(code, 'Current fixed-job role was refused')
        throw Object.assign(unavailable(), { cause: error })
      } finally { rpc?.close() }
    }
    // Authenticate the canonical current job before inspecting caller-provided fields.
    await verify()
    if (!exact(params, ['intent_id', 'launch_id', 'completion_sha256']) || !uuid(params.intent_id) || !uuid(params.launch_id)
      || typeof params.completion_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(params.completion_sha256)) throw new RpcError('INVALID_PARAMS', 'Invalid finalization parameters')
    if (sha256CanonicalJson(params) !== sha256CanonicalJson(request)) throw new RpcError('FORBIDDEN', 'Finalization parameters do not match the current job')
    return { request, expected, stateHash, fenceHash, verify }
  }
  return Object.freeze({
    async prepare(input: unknown, bearer?: string): Promise<PrepareWorkspaceRelocationCompletionResult> {
      const params = input && typeof input === 'object' && !Array.isArray(input) ? Object.freeze({ ...input }) : input
      const current = await scope(params, bearer, 'prepare_web'), fingerprint = sha256CanonicalJson(current.expected)
      if (preparation && !preparation.resumed && preparation.fingerprint !== fingerprint) throw new RpcError('FORBIDDEN', 'A different finalization job is pending')
      if (!preparation || preparation.resumed) {
        const pending = (async () => {
          await current.verify()
          await options.quiesce()
          await current.verify()
          await records.verifyWorkspaceRelocationArchivedCapabilities({ dataDir, id: current.request.intent_id, verify: current.verify })
          await current.verify()
          return Object.freeze({ prepared: true as const, ...current.request, intent_sha256: current.expected.intent_sha256, launch_sha256: current.expected.launch_sha256 })
        })()
        const binding = { request: current.request, expected: current.expected, stateHash: current.stateHash, fenceHash: current.fenceHash }
        preparation = { fingerprint, pending, binding, resumed: false }
      }
      const result = await preparation.pending
      await current.verify()
      return result
    },
    async resume(input: unknown, bearer?: string): Promise<ResumeWorkspaceRelocationWebResult> {
      const params = input && typeof input === 'object' && !Array.isArray(input) ? Object.freeze({ ...input }) : input
      const current = await scope(params, bearer, 'resume_web'), prepared = preparation
      if (!prepared || sha256CanonicalJson(current.request) !== sha256CanonicalJson(prepared.binding.request)) throw unavailable()
      await prepared.pending
      await current.verify()
      if (!prepared.resumed) {
        await records.verifyWorkspaceRelocationReleasedCapabilities({ dataDir, id: current.request.intent_id, verify: current.verify })
        await current.verify()
        if (!prepared.resumed) { options.resume(); prepared.resumed = true }
      }
      await current.verify()
      return Object.freeze({ resumed: true as const, ...current.request, intent_sha256: current.expected.intent_sha256, launch_sha256: current.expected.launch_sha256 })
    },
  })
}
