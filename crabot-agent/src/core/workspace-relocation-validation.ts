import path from 'node:path'
import { timingSafeEqual } from 'node:crypto'
import { RpcError, sha256CanonicalJson } from 'crabot-shared'
import { WorkspaceCatalog } from 'crabot-shared/dist/workspace-catalog.js'
import type { VerifyWorkspaceRelocationRootParams, VerifyWorkspaceRelocationRootResult } from 'crabot-shared'

interface Options {
  dataDir: string
  moduleManagerPort: number
  runtimeBearer: () => string | undefined
  runtimeIdentity: () => { instance_id?: string; module_id: string; runtime_id?: string }
  isClosing: () => boolean
}
const unavailable = () => new RpcError('SERVICE_UNAVAILABLE', '无法核实迁移后的目录文件能力，已保留维护保护。')
const uuid = (value: unknown) => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)
const exact = (value: unknown, fields: string[]): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === fields.length && fields.every(field => Object.prototype.hasOwnProperty.call(value, field))

/** One fixed probe attempt; later reads revalidate the original job without replaying I/O. */
export function createWorkspaceRelocationRootVerifier(options: Options) {
  let original: string | undefined, pending: Promise<VerifyWorkspaceRelocationRootResult> | undefined
  return async (params: VerifyWorkspaceRelocationRootParams, bearer?: string): Promise<VerifyWorkspaceRelocationRootResult> => {
    if (!bearer) throw new RpcError('UNAUTHORIZED', '缺少当前Agent运行凭据。')
    const token = options.runtimeBearer(), supplied = Buffer.from(bearer)
    if (!token || Buffer.byteLength(token) !== supplied.length || !timingSafeEqual(Buffer.from(token), supplied)) {
      throw new RpcError('FORBIDDEN', 'Agent运行凭据不匹配。')
    }
    if (!exact(params, ['intent_id', 'launch_id']) || !uuid(params.intent_id) || !uuid(params.launch_id)) {
      throw new RpcError('INVALID_PARAMS', '目录核验只接受固定作业标识。')
    }
    const request = Object.freeze({ ...params })
    try {
      const records = require(path.join(__dirname, '../../../scripts/lib/workspace-relocation-intent.mjs'))
      const native = require(path.join(__dirname, '../../../scripts/lib/process-identity.cjs'))
      const read = () => ({ intent: records.readWorkspaceRelocationIntent(options.dataDir),
        ...records.readWorkspaceRelocationCoordinator(options.dataDir, request.intent_id),
        published: records.readWorkspaceRelocationRootPublished(options.dataDir, request.intent_id),
        selected: records.readWorkspaceRelocationRootSelected(options.dataDir, request.intent_id) })
      const state = read(), identity = Object.freeze({ ...options.runtimeIdentity() })
      if (!state.intent || !state.launch || !state.ready || !state.published || !state.selected
        || identity.module_id !== 'crabot-agent' || !identity.instance_id || !identity.runtime_id) throw unavailable()
      if (state.intent.id !== request.intent_id || state.launch.launch_id !== request.launch_id) {
        throw new RpcError('FORBIDDEN', '目录核验与当前迁移作业不匹配。')
      }
      const snapshot = sha256CanonicalJson(state), workspaceRootOverride = process.env.WORKER_WORKSPACES_DIR
      const key = sha256CanonicalJson({ snapshot, identity, workspace_root_override: workspaceRootOverride ?? null })
      if (original && original !== key) throw unavailable()
      const result: VerifyWorkspaceRelocationRootResult = Object.freeze({ verified: true, ...request,
        intent_sha256: sha256CanonicalJson(state.intent), launch_sha256: sha256CanonicalJson(state.launch),
        root_selected_sha256: sha256CanonicalJson(state.selected), instance_id: identity.instance_id,
        module_id: 'crabot-agent', runtime_id: identity.runtime_id })
      const assertCurrent = (): void => {
        if (process.env.WORKER_WORKSPACES_DIR !== workspaceRootOverride || options.isClosing() || options.runtimeBearer() !== token || sha256CanonicalJson(options.runtimeIdentity()) !== sha256CanonicalJson(identity)
          || sha256CanonicalJson(read()) !== snapshot || !native.sameProcess(state.launch.parent, native.inspectProcess(state.launch.parent.pid))) throw unavailable()
      }
      const verify = async (): Promise<void> => {
        assertCurrent()
        const catalog = await new WorkspaceCatalog({ dataRoot: options.dataDir,
          storageRoot: workspaceRootOverride ? path.resolve(workspaceRootOverride) : undefined, files: native }).snapshot()
        assertCurrent()
        if (catalog.storage_root !== state.published.target.path || catalog.revision !== state.selected.catalog_revision
          || sha256CanonicalJson(catalog) !== state.selected.catalog_sha256) throw unavailable()
        const { openPinnedProcessRpc } = require(path.join(__dirname, '../../../scripts/lib/pinned-process-rpc.cjs'))
        const rpc = await openPinnedProcessRpc(state.launch.parent, options.moduleManagerPort, { source: 'crabot-agent', timeoutMs: 5000 })
        try {
          const proof = await rpc.call('verify_workspace_relocation_runtime', request, { authorizationBearer: token })
          assertCurrent()
          if (!exact(proof, Object.keys(result)) || sha256CanonicalJson(proof) !== sha256CanonicalJson(result)) throw unavailable()
        } finally { rpc.close() }
      }
      assertCurrent()
      if (!pending) {
        original = key
        pending = (async () => {
          const { probeWorkspaceDirectory } = require(path.join(__dirname, '../../../scripts/lib/workspace-root-probe.mjs'))
          await probeWorkspaceDirectory({ directory: state.published.target, authorize: async () => { await verify(); return assertCurrent } })
          return result
        })()
      }
      const confirmed = await pending
      await verify()
      return confirmed
    } catch (error) {
      if (error instanceof RpcError) throw error
      throw Object.assign(unavailable(), { cause: error })
    }
  }
}
