import { timingSafeEqual } from 'node:crypto'
import { RpcError, sha256CanonicalJson } from 'crabot-shared'
import { WorkspaceCatalog } from 'crabot-shared/dist/workspace-catalog.js'
import type { WorkspaceInterruptedRecoveryRequest, WorkspaceInterruptedRecoveryRuntimeResult } from 'crabot-shared'
interface Options {
  dataDir: string
  moduleManagerPort: number
  runtimeBearer: () => string | undefined
  runtimeIdentity: () => { instance_id?: string; module_id: string; runtime_id?: string }
  isClosing: () => boolean
}
const failure = () => new RpcError('SERVICE_UNAVAILABLE', '原位置与本次实际Agent文件能力尚未核实，未报告恢复完成。')
/** Current interrupted role only; the old normal/archived root verifiers keep their own contracts. */
export function createWorkspaceInterruptedRootVerifier(options: Options) {
  let original: string | undefined, pending: Promise<WorkspaceInterruptedRecoveryRuntimeResult> | undefined
  return async (input: WorkspaceInterruptedRecoveryRequest, bearer?: string): Promise<WorkspaceInterruptedRecoveryRuntimeResult> => {
    const token = options.runtimeBearer()
    if (!bearer) throw new RpcError('UNAUTHORIZED', '缺少当前Agent运行凭据。')
    if (!token || Buffer.byteLength(token) !== Buffer.byteLength(bearer) || !timingSafeEqual(Buffer.from(token), Buffer.from(bearer))) throw new RpcError('FORBIDDEN', 'Agent运行凭据不匹配。')
    const records = require('../../../scripts/lib/workspace-interrupted-runtime.mjs')
    const { parseWorkspaceInterruptedRecoveryRequest, readWorkspaceInterruptedRecoveryRole } = require('../../../scripts/lib/workspace-interrupted-role.mjs')
    const { readWorkspaceSourceCompletionScope } = require('../../../scripts/lib/workspace-interrupted-source-records.mjs')
    const native = require('../../../scripts/lib/process-identity.cjs')
    let request: WorkspaceInterruptedRecoveryRequest
    try { request = parseWorkspaceInterruptedRecoveryRequest(input) }
    catch { throw new RpcError('INVALID_PARAMS', '原位置核验只接受固定恢复作业标识。') }
    const role = readWorkspaceInterruptedRecoveryRole(options.dataDir, request.recovery_id)
    const plan = records.readWorkspaceInterruptedRuntimePlan(options.dataDir, request.recovery_id), start = records.readWorkspaceInterruptedRuntimeStart(options.dataDir, request.recovery_id, 'crabot-agent')
    const source = readWorkspaceSourceCompletionScope(options.dataDir, request.intent_id), identity = Object.freeze({ ...options.runtimeIdentity() })
    if (!role.launch || !role.ready || !plan || !start || sha256CanonicalJson(role.launch.request) !== sha256CanonicalJson(request)
      || identity.module_id !== 'crabot-agent' || identity.instance_id !== plan.instance_id || identity.runtime_id !== start.runtime.runtime_id) throw failure()
    const signature = sha256CanonicalJson({ role, plan, start, marker: source.marker, identity })
    if (original && original !== signature) throw failure()
    const result: WorkspaceInterruptedRecoveryRuntimeResult = Object.freeze({ verified: true, ...request, launch_sha256: sha256CanonicalJson(role.launch),
      plan_sha256: sha256CanonicalJson(plan), catalog_sha256: source.scope.catalog_sha256, instance_id: plan.instance_id, module_id: 'crabot-agent', runtime_id: start.runtime.runtime_id })
    const assertCurrent = () => {
      if (options.isClosing() || options.runtimeBearer() !== token || sha256CanonicalJson(options.runtimeIdentity()) !== sha256CanonicalJson(identity)
        || sha256CanonicalJson(readWorkspaceInterruptedRecoveryRole(options.dataDir, request.recovery_id)) !== sha256CanonicalJson(role)) throw failure()
      records.verifyWorkspaceInterruptedRuntimeStart({ dataDir: options.dataDir, recoveryId: request.recovery_id, moduleId: 'crabot-agent',
        recordHash: sha256CanonicalJson(start), definitionHash: start.definition_sha256 })
      // The actual Agent must descend from the exact registered idle carrier.
      const chain = [], seen = new Set<number>()
      let current = native.inspectProcess(process.pid)
      while (current && !native.sameProcess(start.process, current)) {
        if (seen.has(current.pid) || seen.size > 32768 || current.owner !== start.process.owner) throw failure()
        seen.add(current.pid); chain.push(current)
        const parent = native.inspectProcess(current.parent)
        if (!parent || !require('../../../scripts/lib/owned-process-tree.cjs').processBirthAtLeast(current.started, parent.started)) throw failure()
        current = parent
      }
      if (!current || !chain.length || chain.some(item => {
        const actual = native.inspectProcess(item.pid)
        return !native.sameProcess(item, actual) || actual.parent !== item.parent
      })) throw failure()
    }
    const verify = async () => {
      assertCurrent()
      const scope = readWorkspaceSourceCompletionScope(options.dataDir, request.intent_id)
      if (sha256CanonicalJson(scope.marker) !== sha256CanonicalJson(source.marker)) throw failure()
      const catalog = await new WorkspaceCatalog({ dataRoot: options.dataDir, storageRoot: process.env.WORKER_WORKSPACES_DIR, files: native }).snapshot()
      assertCurrent()
      if (catalog.storage_root !== source.complete.source.path || catalog.revision < source.scope.catalog_revision
        || !scope.released && sha256CanonicalJson(catalog) !== source.scope.catalog_sha256) throw failure()
      const rpc = await require('../../../scripts/lib/pinned-process-rpc.cjs').openPinnedProcessRpc(role.launch.parent, options.moduleManagerPort, { source: 'crabot-agent', timeoutMs: 30000 })
      try {
        const proof = await rpc.call('verify_workspace_interrupted_recovery_runtime', request, { authorizationBearer: token })
        assertCurrent()
        if (sha256CanonicalJson(proof) !== sha256CanonicalJson(result)) throw failure()
      } finally { rpc.close() }
    }
    if (!pending) {
      original = signature
      pending = Promise.resolve().then(async () => {
        await require('../../../scripts/lib/workspace-root-probe.mjs').probeWorkspaceDirectory({ directory: source.complete.source, authorize: async () => { await verify(); return assertCurrent } })
        return result
      })
    }
    const confirmed = await pending
    await verify()
    return confirmed
  }
}
