import { isDeepStrictEqual } from 'node:util'
import type { PermissionDecision } from '../../engine/types.js'
import { allowed, denied } from '../../permissions/tool-authorization.js'
import { ConversationRequestAuthority, type RequestOperationFrame } from '../../manager/conversation-request-authority.js'
import { ConversationRequestStore, requestSourceFor } from '../../manager/conversation-request-store.js'
import { matchesRequestPermissionSource, type ConversationRequestSource, type RequestPermissionSource } from '../../manager/request-permission-sources.js'
import type { TrustedHumanInput } from '../../manager/trusted-human-input.js'
import type { ConversationRequestRecord } from '../../manager/conversation-request.js'
import { BUILTIN_WORKER_PERMISSIONS, narrowWorkerPermissions, workerCliExecutionPermissions } from '../builtin/runtime.js'
import type { LedgerWorker } from './ledger-types.js'
import type { LedgerStore } from './ledger-store.js'
import type { WorkerContextStore } from './context-store.js'

type CurrentResolver = (kind: RequestPermissionSource['kind'], origin: ConversationRequestSource) => Promise<RequestPermissionSource | null>
export interface BoundWorkerRequest {
  worker: LedgerWorker
  request: ConversationRequestRecord
  source: TrustedHumanInput
}
function workerSource(source: RequestPermissionSource): RequestPermissionSource {
  return { ...source, resolved: { ...narrowWorkerPermissions(BUILTIN_WORKER_PERMISSIONS, source.resolved), cli_access: workerCliExecutionPermissions(source.resolved).cli_access } }
}

/** Checks both durable copies before any new request-bound action; never guesses legacy identity. */
export class WorkerRequestGuard {
  constructor(private readonly ledger: LedgerStore, private readonly contexts: WorkerContextStore, private readonly requests: ConversationRequestStore, private readonly resolveCurrent: CurrentResolver) {}
  async load(workerId: string): Promise<BoundWorkerRequest | null> {
    try { return await this.loadBound(workerId) }
    catch (cause) { throw Object.assign(new Error('CAPABILITY_UNKNOWN: Worker request binding/context unavailable'), { cause }) }
  }
  private async loadBound(workerId: string): Promise<BoundWorkerRequest | null> {
    const found = await this.ledger.findWorker(workerId)
    if (!found) throw new Error('Worker not found')
    const context = await this.contexts.read(workerId), binding = found.worker.origin.request
    if (!binding && !context?.request) return null
    if (!binding || !context?.request || !isDeepStrictEqual(binding, context.request) || context.manager_key !== found.managerKey) throw new Error('Worker request binding/context mismatch')
    const fixed = await this.requests.get(found.managerKey, binding.request_id)
    if (!fixed || fixed.record.source_sha256 !== binding.source_sha256 || !fixed.record.worker_ids.includes(workerId)) throw new Error('Worker request source or association unavailable')
    const owner = fixed.source.sender_friend_id ?? undefined
    if (found.worker.origin.creator_friend_id !== owner || context.creator_friend_id !== owner) throw new Error('Worker request creator mismatch')
    if (context.target_session?.type !== 'group' || `${context.target_session.channel_id}::${context.target_session.session_id}` !== fixed.source.manager_key
      || binding.execution_scope === 'group' && fixed.record.delivery.kind === 'requester_private') throw new Error('Worker request scope/target mismatch')
    return { worker: found.worker, request: fixed.record, source: fixed.source }
  }
  async bindSpawn(frame: RequestOperationFrame, workerId: string, executionScope: 'group' | 'request') {
    const fixed = await this.requests.get(frame.request.manager_key, frame.request.request_id)
    if (!fixed || fixed.record.source_sha256 !== frame.request.source_sha256 || fixed.source.source_id !== frame.source.source_id || fixed.record.status !== 'open') throw new Error('Request spawn source unavailable or closed')
    if (executionScope === 'group' && fixed.record.delivery.kind === 'requester_private') throw new Error('Private delivery requires an isolated request')
    await this.requests.attachWorker(fixed.record.manager_key, fixed.record.request_id, workerId)
    return { schema_version: 1 as const, request_id: fixed.record.request_id, source_sha256: fixed.record.source_sha256, execution_scope: executionScope }
  }
  async runResource<T>(workerId: string, checkCompleteOperation: (source: RequestPermissionSource) => Promise<PermissionDecision>, execute: (frame: RequestOperationFrame) => Promise<T>): Promise<T> {
    const bound = await this.load(workerId)
    if (!bound) throw new Error('Worker has no request binding')
    if (bound.worker.task.status === 'closed') throw new Error('Worker is closed')
    const authority = new ConversationRequestAuthority(this.requests, bound.worker.manager_key, bound.request.request_id, bound.worker.origin.request!.execution_scope, this.resolveCurrent)
    return authority.run(source => checkCompleteOperation(workerSource(source)), async frame => {
      const current = await this.load(workerId)
      if (!current || current.worker.task.status === 'closed' || !isDeepStrictEqual(current.worker.origin.request, bound.worker.origin.request)) throw new Error('Worker request changed or closed')
      return execute({ ...frame, ceiling: workerSource(frame.ceiling), current: workerSource(frame.current) })
    })
  }
  async authorizeControl(workerId: string, caller: ConversationRequestAuthority, checkCompleteOperation: (source: RequestPermissionSource) => Promise<PermissionDecision>): Promise<void> {
    const found = await this.ledger.findWorker(workerId)
    if (!found) throw new Error('Worker not found')
    const bound = await this.load(workerId)
    const personal = bound && bound.worker.origin.request!.execution_scope === 'request'
      && (bound.request.permission_sources.friend !== null || bound.request.delivery.kind === 'requester_private')
    if (personal && caller.executionScope !== 'request') throw new Error('REQUEST_CONTEXT_REQUIRED: 个人任务需在独立请求上下文中操作')
    await caller.run(async (source, origin) => {
      if (origin.manager_key !== found.managerKey) return denied('PERMISSION_DENIED', '群请求不能跨会话操作执行器')
      if (personal) {
        let owner = false
        if (origin.sender_friend_id && origin.sender_friend_id === bound!.source.sender_friend_id) {
          try { owner = matchesRequestPermissionSource(await this.resolveCurrent('friend', requestSourceFor(origin)), 'friend', origin.sender_friend_id) }
          catch { return denied('CAPABILITY_UNKNOWN', '当前请求发起人身份不可核验') }
        }
        if (!owner && !(source.kind === 'friend' && source.is_master)) return denied('PERMISSION_DENIED', '个人任务只能由原发起人或有效 Master 操作')
      }
      return checkCompleteOperation(source)
    }, async () => allowed)
  }
}
