import path from 'node:path'
import { RpcError, sha256CanonicalJson } from 'crabot-shared'
import type { VerifyWorkspaceRelocationCoordinatorParams, VerifyWorkspaceRelocationCoordinatorResult } from 'crabot-shared'

interface WorkspaceRelocationAuthorityOptions {
  dataDir: string
  moduleManagerPort: number
  params: VerifyWorkspaceRelocationCoordinatorParams
  bearer?: string
}

const uuid = (value: unknown): value is string => typeof value === 'string'
  && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)
function exactFields(value: unknown, fields: string[]): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  return Object.keys(value).length === fields.length && fields.every(field => Object.prototype.hasOwnProperty.call(value, field))
}
const unavailable = () => new RpcError('SERVICE_UNAVAILABLE', '无法核实当前迁移协调授权，请保留维护状态后重试核验。')

/** Read-only proof consumption; this does not grant file moves or prove execution exit. */
export async function verifyWorkspaceRelocationAuthority({ dataDir, moduleManagerPort, params, bearer }: WorkspaceRelocationAuthorityOptions): Promise<VerifyWorkspaceRelocationCoordinatorResult> {
  if (typeof bearer !== 'string' || !bearer) throw new RpcError('UNAUTHORIZED', '缺少迁移协调凭据。')
  if (!exactFields(params, ['intent_id', 'launch_id', 'action']) || !uuid(params.intent_id) || !uuid(params.launch_id)
    || !['capture_workers', 'stop_workers'].includes(params.action)) throw new RpcError('INVALID_PARAMS', '迁移作业参数无效。')
  const request = Object.freeze({ ...params })
  let rpc: { call(method: string, params: unknown, options: { authorizationBearer: string }): Promise<unknown>; close(): void } | undefined
  try {
    const records = require(path.join(__dirname, '../../../scripts/lib/workspace-relocation-intent.mjs'))
    const intent = records.readWorkspaceRelocationIntent(dataDir)
    if (!intent) throw unavailable()
    if (intent.id !== request.intent_id) throw new RpcError('FORBIDDEN', '迁移作业与当前实例不符。')
    const { launch, ready } = records.readWorkspaceRelocationCoordinator(dataDir, intent.id)
    if (!launch || !ready) throw unavailable()
    if (launch.launch_id !== request.launch_id) throw new RpcError('FORBIDDEN', '迁移协调器与当前作业不符。')
    const snapshot = sha256CanonicalJson({ intent, launch, ready })
    const { openPinnedProcessRpc } = require(path.join(__dirname, '../../../scripts/lib/pinned-process-rpc.cjs'))
    const connection = await openPinnedProcessRpc(launch.parent, moduleManagerPort, { source: 'crabot-agent', timeoutMs: 1500 })
    rpc = connection
    const result = await connection.call('verify_workspace_relocation_coordinator', request, { authorizationBearer: bearer })
    if (!exactFields(result, ['verified', 'intent_id', 'intent_sha256', 'launch_id', 'launch_sha256', 'action'])
      || result.verified !== true) throw unavailable()
    if (result.intent_id !== request.intent_id || result.launch_id !== request.launch_id || result.action !== request.action
      || result.intent_sha256 !== sha256CanonicalJson(intent) || result.launch_sha256 !== sha256CanonicalJson(launch)) {
      throw new RpcError('FORBIDDEN', '迁移授权与固定作业范围不符。')
    }
    const current = records.readWorkspaceRelocationCoordinator(dataDir, intent.id)
    if (sha256CanonicalJson({ intent: records.readWorkspaceRelocationIntent(dataDir), ...current }) !== snapshot) throw unavailable()
    return { verified: true, ...request, intent_sha256: sha256CanonicalJson(intent), launch_sha256: sha256CanonicalJson(launch) }
  } catch (error) {
    if (error instanceof RpcError) throw error
    throw unavailable()
  } finally { rpc?.close() }
}
