import path from 'node:path'
import { RpcError, sha256CanonicalJson } from 'crabot-shared'
import type { StopWorkspaceRelocationWorkersParams, WorkspaceRelocationWorker, WorkspaceRelocationStopResult,
  PrepareWorkspaceRelocationWorkerStopsResult, CompleteWorkspaceRelocationWorkerStopsResult } from 'crabot-shared'
import type { WorkspaceRelocationStopJournal } from '../workers/harness/workspace-relocation-scope.js'
import { verifyWorkspaceRelocationAuthority } from './workspace-relocation-authority.js'

interface WorkspaceRelocationStopOptions {
  dataDir: string
  moduleManagerPort: number
  params: StopWorkspaceRelocationWorkersParams
  bearer?: string
}
interface WorkspaceRelocationStopBinding {
  workers: ReadonlyArray<WorkspaceRelocationWorker>
  journal: WorkspaceRelocationStopJournal
  verify(): Promise<void>
}
const unavailable = () => new RpcError('SERVICE_UNAVAILABLE', '停止材料无法核实，已保留维护保护，未自动重发。')
function exactFields(value: unknown, fields: string[]): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  return Object.keys(value).length === fields.length && fields.every(field => Object.prototype.hasOwnProperty.call(value, field))
}
const sortedResults = (results: ReadonlyArray<WorkspaceRelocationStopResult>) => results.map(item => ({ ...item })).sort((a, b) => {
  if (a.worker_id !== b.worker_id) return a.worker_id < b.worker_id ? -1 : 1
  if (a.incarnation_id !== b.incarnation_id) return a.incarnation_id < b.incarnation_id ? -1 : 1
  return 0
})

/** Only the fixed MM confirmation bridge; never an adapter stop or a closure/exit proof. */
export async function createWorkspaceRelocationStopJournal({ dataDir, moduleManagerPort, params, bearer }: WorkspaceRelocationStopOptions): Promise<WorkspaceRelocationStopBinding> {
  if (typeof bearer !== 'string' || !bearer) throw new RpcError('UNAUTHORIZED', '缺少迁移协调凭据。')
  if (!exactFields(params, ['intent_id', 'launch_id'])) throw new RpcError('INVALID_PARAMS', '迁移停止只接受固定作业标识。')
  const request = Object.freeze({ intent_id: params.intent_id, launch_id: params.launch_id })
  const authority = { dataDir, moduleManagerPort, params: { ...request, action: 'stop_workers' as const }, bearer }
  try {
    const proof = await verifyWorkspaceRelocationAuthority(authority)
    const records = require(path.join(__dirname, '../../../scripts/lib/workspace-relocation-intent.mjs'))
    const scope = records.readWorkspaceRelocationWorkers(dataDir, request.intent_id)
    if (!scope) throw unavailable()
    const scopeHash = sha256CanonicalJson(scope), workersHash = sha256CanonicalJson(scope.workers)
    const assertScope = () => {
      if (sha256CanonicalJson(records.readWorkspaceRelocationWorkers(dataDir, request.intent_id)) !== scopeHash) throw unavailable()
    }
    const verify = async () => {
      try {
        if (sha256CanonicalJson(await verifyWorkspaceRelocationAuthority(authority)) !== sha256CanonicalJson(proof)) throw new RpcError('FORBIDDEN', '固定迁移授权已变化。')
        assertScope()
      } catch (error) { if (error instanceof RpcError) throw error; throw unavailable() }
    }
    async function confirm(method: 'prepare_workspace_relocation_worker_stops' | 'complete_workspace_relocation_worker_stops', results?: ReadonlyArray<WorkspaceRelocationStopResult>): Promise<PrepareWorkspaceRelocationWorkerStopsResult | CompleteWorkspaceRelocationWorkerStopsResult> {
      let rpc: { call(method: string, params: unknown, options: { authorizationBearer: string }): Promise<unknown>; close(): void } | undefined
      try {
        await verify()
        const previous = records.readWorkspaceRelocationStops(dataDir, request.intent_id)
        const { launch } = records.readWorkspaceRelocationCoordinator(dataDir, request.intent_id)
        if (!launch || sha256CanonicalJson(launch) !== proof.launch_sha256) throw unavailable()
        const { openPinnedProcessRpc } = require(path.join(__dirname, '../../../scripts/lib/pinned-process-rpc.cjs'))
        const connection = await openPinnedProcessRpc(launch.parent, moduleManagerPort, { source: 'crabot-agent', timeoutMs: 15000 })
        rpc = connection
        const result = await connection.call(method, results === undefined ? request : { ...request, results }, { authorizationBearer: bearer })
        assertScope()
        const current = records.readWorkspaceRelocationStops(dataDir, request.intent_id)
        if (method === 'prepare_workspace_relocation_worker_stops') {
          if (!exactFields(result, ['dispatch']) || result.dispatch !== 'dispatch' && result.dispatch !== 'observe'
            || !current.attempt || previous.attempt && result.dispatch === 'dispatch') throw unavailable()
          await verify()
          return { dispatch: result.dispatch }
        }
        if (!exactFields(result, ['recorded']) || result.recorded !== true || !current.submission
          || sha256CanonicalJson(current.submission.results) !== sha256CanonicalJson(results)) throw unavailable()
        await verify()
        return { recorded: true }
      } catch (error) { if (error instanceof RpcError) throw error; throw unavailable() }
      finally { rpc?.close() }
    }
    return { workers: scope.workers, verify, journal: {
      async prepare(workers) {
        if (sha256CanonicalJson(workers) !== workersHash) throw new RpcError('WORKSPACE_MAINTENANCE', '固定执行器范围不能替换。')
        const result = await confirm('prepare_workspace_relocation_worker_stops')
        if (!('dispatch' in result)) throw unavailable()
        return result.dispatch
      },
      async complete(results) { await confirm('complete_workspace_relocation_worker_stops', sortedResults(results)) },
    } }
  } catch (error) { if (error instanceof RpcError) throw error; throw unavailable() }
}
