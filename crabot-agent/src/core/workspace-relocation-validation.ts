import path from 'node:path'
import { timingSafeEqual } from 'node:crypto'
import { RpcError, sha256CanonicalJson } from 'crabot-shared'
import { WorkspaceCatalog } from 'crabot-shared/dist/workspace-catalog.js'
import type { VerifyWorkspaceRelocationRootParams, VerifyWorkspaceRelocationRootResult, VerifyWorkspaceRelocationRecoveryRootParams, VerifyWorkspaceRelocationRecoveryRootResult } from 'crabot-shared'

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
        const rpc = await openPinnedProcessRpc(state.launch.parent, options.moduleManagerPort, { source: 'crabot-agent', timeoutMs: 30000 })
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
      const causes: Array<Record<string, string | null>> = []
      for (let current: unknown = error, depth = 0; current && typeof current === 'object' && depth < 4; depth++) {
        const value = current as { code?: unknown; stage?: unknown; transport_code?: unknown; remote_code?: unknown; cause?: unknown }
        const fixed = (field: unknown, pattern: RegExp): string | null => typeof field === 'string' && field.length <= 128 && pattern.test(field) ? field : null
        causes.push({ code: fixed(value.code, /^(?:CRABOT_|WORKSPACE_)[A-Z_]+$|^(?:UNAUTHORIZED|FORBIDDEN|INVALID_PARAMS|SERVICE_UNAVAILABLE)$/),
          stage: fixed(value.stage, /^[a-z][a-z0-9-]*$/), transport_code: fixed(value.transport_code, /^(?:ERR_[A-Z_]+|E[A-Z]+|ABORT_ERR)$/),
          remote_code: fixed(value.remote_code, /^(?:INVALID_REQUEST|INVALID_PARAMS|METHOD_NOT_FOUND|UNAUTHORIZED|FORBIDDEN|PERMISSION_DENIED|NOT_FOUND|CONFLICT|INTERNAL_ERROR|SERVICE_UNAVAILABLE|TIMEOUT)$/) })
        current = value.cause
      }
      console.error(JSON.stringify({ event: 'workspace_root_validation_failed', causes }))
      if (error instanceof RpcError) throw error
      throw Object.assign(unavailable(), { cause: error })
    }
  }
}


/** The current recovery role has its own probe; an archived normal launch never authorizes it. */
export function createWorkspaceRecoveryRootVerifier(options: Options) {
  let original: string | undefined, pending: Promise<VerifyWorkspaceRelocationRecoveryRootResult> | undefined, failed = false, releasedObserved = false
  return async (params: VerifyWorkspaceRelocationRecoveryRootParams, bearer?: string): Promise<VerifyWorkspaceRelocationRecoveryRootResult> => {
    if (!bearer) throw new RpcError('UNAUTHORIZED', '缺少当前Agent运行凭据。')
    const token = options.runtimeBearer(), supplied = Buffer.from(bearer)
    if (!token || Buffer.byteLength(token) !== supplied.length || !timingSafeEqual(Buffer.from(token), supplied)) {
      throw new RpcError('FORBIDDEN', 'Agent运行凭据不匹配。')
    }
    const admission = require(path.join(__dirname, '../../../scripts/lib/workspace-recovery-admission.mjs'))
    let request: VerifyWorkspaceRelocationRecoveryRootParams
    try { request = admission.parseWorkspaceRecoveryAdmissionRequest(params) }
    catch { throw new RpcError('INVALID_PARAMS', '目录核验只接受固定恢复作业标识。') }
    let stage = 'fixed-materials'
    try {
      if (failed) throw unavailable()
      const records = require(path.join(__dirname, '../../../scripts/lib/workspace-recovery-records.mjs'))
      const native = require(path.join(__dirname, '../../../scripts/lib/process-identity.cjs'))
      const read = () => {
        const { released, ...scope } = admission.readWorkspaceRecoveryCompletionScope(options.dataDir, request)
        if (releasedObserved && !released) throw unavailable()
        releasedObserved ||= released
        return { scope,
          coordinator: records.readWorkspaceRecoveryCoordinator(options.dataDir, request.recovery_id),
          plan: records.readWorkspaceRecoveryRuntimePlan(options.dataDir, request.recovery_id),
          start: records.readWorkspaceRecoveryRuntimeStart(options.dataDir, request.recovery_id, 'crabot-agent') }
      }
      const state = read(), identity = Object.freeze({ ...options.runtimeIdentity() }), self = native.inspectProcess(process.pid)
      if (!state.coordinator.launch || !state.coordinator.ready || !state.plan || !state.start || !self
        || identity.module_id !== 'crabot-agent' || !identity.instance_id || !identity.runtime_id
        || state.start.runtime.instance_id !== identity.instance_id || state.start.runtime.runtime_id !== identity.runtime_id) throw unavailable()
      const snapshot = sha256CanonicalJson(state), workspaceRootOverride = process.env.WORKER_WORKSPACES_DIR
      const key = sha256CanonicalJson({ snapshot, identity, self, workspace_root_override: workspaceRootOverride ?? null })
      if (original && original !== key) throw unavailable()
      const result: VerifyWorkspaceRelocationRecoveryRootResult = Object.freeze({ verified: true, ...request,
        launch_sha256: sha256CanonicalJson(state.coordinator.launch), plan_sha256: sha256CanonicalJson(state.plan),
        root_selected_sha256: state.plan.root_selected_sha256, instance_id: identity.instance_id, module_id: 'crabot-agent', runtime_id: identity.runtime_id })
      const assertCurrent = () => {
        if (process.env.WORKER_WORKSPACES_DIR !== workspaceRootOverride || options.isClosing() || options.runtimeBearer() !== token
          || sha256CanonicalJson(options.runtimeIdentity()) !== sha256CanonicalJson(identity) || sha256CanonicalJson(read()) !== snapshot
          || !native.sameProcess(self, native.inspectProcess(process.pid))) throw unavailable()
        records.verifyWorkspaceRecoveryRuntimeStart({ dataDir: options.dataDir, recoveryId: request.recovery_id, moduleId: 'crabot-agent',
          recordHash: sha256CanonicalJson(state.start), definitionHash: state.start.definition_sha256 })
        const { processBirthAtLeast } = require(path.join(__dirname, '../../../scripts/lib/owned-process-tree.cjs'))
        const ancestors = [self], seen = new Set([self.pid])
        let current = self
        while (!native.sameProcess(state.start.process, current)) {
          if (ancestors.length >= 32768 || !current.parent || seen.has(current.parent)) throw unavailable()
          const parent = native.inspectProcess(current.parent)
          if (!parent || parent.owner !== self.owner || !processBirthAtLeast(current.started, parent.started)) throw unavailable()
          seen.add(parent.pid); ancestors.push(parent); current = parent
        }
        if (ancestors.length < 2 || ancestors.some(item => {
          const actual = native.inspectProcess(item.pid)
          return !native.sameProcess(item, actual) || actual.parent !== item.parent
        })) throw unavailable()
      }
      const verify = async () => {
        assertCurrent()
        stage = 'catalog'
        const catalog = await new WorkspaceCatalog({ dataRoot: options.dataDir,
          storageRoot: workspaceRootOverride ? path.resolve(workspaceRootOverride) : undefined, files: native }).snapshot()
        assertCurrent()
        const selected = state.scope.state.selected, target = state.scope.state.published.target
        const released = admission.readWorkspaceRecoveryCompletionScope(options.dataDir, request).released
        if (catalog.storage_root !== target.path || catalog.revision < selected.catalog_revision
          || !released && (catalog.revision !== selected.catalog_revision || sha256CanonicalJson(catalog) !== selected.catalog_sha256)) throw unavailable()
        stage = 'current-mm-runtime'
        const rpc = await require(path.join(__dirname, '../../../scripts/lib/pinned-process-rpc.cjs')).openPinnedProcessRpc(
          state.coordinator.launch.parent, options.moduleManagerPort, { source: 'crabot-agent', timeoutMs: 30000 })
        try {
          const proof = await rpc.call('verify_workspace_relocation_recovery_runtime', request, { authorizationBearer: token })
          assertCurrent()
          if (!exact(proof, Object.keys(result)) || sha256CanonicalJson(proof) !== sha256CanonicalJson(result)) throw unavailable()
        } finally { rpc.close() }
      }
      stage = 'initial-current-facts'
      assertCurrent()
      if (!pending) {
        original = key
        pending = (async () => {
          const { probeWorkspaceDirectory } = require(path.join(__dirname, '../../../scripts/lib/workspace-root-probe.mjs'))
          stage = 'directory-probe'
          await probeWorkspaceDirectory({ directory: state.scope.state.published.target, authorize: async () => { await verify(); return assertCurrent } })
          return result
        })()
      }
      const confirmed = await pending
      await verify()
      return confirmed
    } catch (error) {
      failed = true
      const cause = error as { code?: unknown; stage?: unknown; cause?: { code?: unknown; stage?: unknown } }
      const fixed = (value: unknown) => typeof value === 'string' && /^[a-zA-Z][a-zA-Z0-9_-]{0,127}$/.test(value) ? value : null
      console.error(JSON.stringify({ event: 'workspace_recovery_root_validation_failed', stage, code: fixed(cause.code), inner_stage: fixed(cause.stage),
        cause_code: fixed(cause.cause?.code), cause_stage: fixed(cause.cause?.stage) }))
      if (error instanceof RpcError) throw error
      throw Object.assign(unavailable(), { cause: error })
    }
  }
}
