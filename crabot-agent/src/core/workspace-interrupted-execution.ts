import { timingSafeEqual } from 'node:crypto'
import { RpcError, sha256CanonicalJson } from 'crabot-shared'
import type { WorkspaceInterruptedRecoveryRequest, WorkspaceInterruptedExecutionAuthorityResult, WorkspaceRelocationStopResult } from 'crabot-shared'

interface Options {
  dataDir: string
  moduleManagerPort: number
  runtimeBearer: () => string | undefined
  runtimeIdentity: () => { instance_id?: string; module_id: string; runtime_id?: string }
  isClosing: () => boolean
}
const failure = () => new RpcError('SERVICE_UNAVAILABLE', '当前恢复执行范围尚未核实，原文件与维护保护已保留。')
/** Current Core/Agent authority only; no original coordinator or validation-runtime plan. */
export async function createWorkspaceInterruptedExecutionAuthority(options: Options, input: unknown, bearer: string | undefined, action: 'capture' | 'stop_workers') {
  const token = options.runtimeBearer()
  if (!bearer) throw new RpcError('UNAUTHORIZED', '缺少当前Agent运行凭据。')
  if (!token || Buffer.byteLength(token) !== Buffer.byteLength(bearer) || !timingSafeEqual(Buffer.from(token), Buffer.from(bearer))) throw new RpcError('FORBIDDEN', '当前Agent运行凭据不匹配。')
  const roles = require('../../../scripts/lib/workspace-interrupted-role.mjs'), native = require('../../../scripts/lib/process-identity.cjs')
  let request: WorkspaceInterruptedRecoveryRequest
  try { request = roles.parseWorkspaceInterruptedRecoveryRequest(input) } catch { throw new RpcError('INVALID_PARAMS', '恢复执行仅接受固定作业标识。') }
  const role = roles.readWorkspaceInterruptedRecoveryRole(options.dataDir, request.recovery_id), identity = Object.freeze({ ...options.runtimeIdentity() })
  if (!role.launch || !role.ready || role.launch.action !== 'restore_source' || sha256CanonicalJson(role.launch.request) !== sha256CanonicalJson(request)
    || identity.module_id !== 'crabot-agent') throw failure()
  const assertCurrent = () => {
    if (options.isClosing() || options.runtimeBearer() !== token || sha256CanonicalJson(options.runtimeIdentity()) !== sha256CanonicalJson(identity)
      || sha256CanonicalJson(roles.readWorkspaceInterruptedRecoveryRole(options.dataDir, request.recovery_id)) !== sha256CanonicalJson(role)
      || !native.sameProcess(role.launch.parent, native.inspectProcess(role.launch.parent.pid))
      || !native.sameProcess(role.launch.process, native.inspectProcess(role.launch.process.pid))) throw failure()
  }
  const call = async (method: string, params: unknown) => {
    assertCurrent()
    const rpc = await require('../../../scripts/lib/pinned-process-rpc.cjs').openPinnedProcessRpc(role.launch.parent, options.moduleManagerPort, { source: 'crabot-agent', timeoutMs: 30000 })
    try {
      const result = await rpc.call(method, params, { authorizationBearer: token })
      assertCurrent(); return result
    } finally { rpc.close() }
  }
  let original: WorkspaceInterruptedExecutionAuthorityResult | undefined
  const verify = async () => {
    const proof = await call('verify_workspace_interrupted_recovery_execution', { ...request, action })
    if (sha256CanonicalJson(proof) !== sha256CanonicalJson({ verified: true, ...request, action, launch_sha256: sha256CanonicalJson(role.launch), scope_sha256: proof?.scope_sha256,
      instance_id: identity.instance_id, module_id: 'crabot-agent', runtime_id: identity.runtime_id })
      || typeof proof.scope_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(proof.scope_sha256)
      || original && sha256CanonicalJson(proof) !== sha256CanonicalJson(original)) throw failure()
    original ??= Object.freeze(proof)
    return proof as WorkspaceInterruptedExecutionAuthorityResult
  }
  const proof = await verify()
  return { request, proof, verify, async prepare() {
    await verify()
    const result = await call('prepare_workspace_interrupted_recovery_worker_stops', request)
    if (sha256CanonicalJson(result) !== sha256CanonicalJson({ dispatch: result?.dispatch }) || !['dispatch', 'observe'].includes(result.dispatch)) throw failure()
    await verify(); return result.dispatch as 'dispatch' | 'observe'
  }, async complete(results: ReadonlyArray<WorkspaceRelocationStopResult>) {
    await verify()
    const result = await call('complete_workspace_interrupted_recovery_worker_stops', { ...request, results })
    if (sha256CanonicalJson(result) !== sha256CanonicalJson({ recorded: true })) throw failure()
    await verify()
  } }
}
