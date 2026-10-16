import type { PermissionDecision } from '../engine/types.js'
import type { ManagerKey } from './types.js'
import type { TrustedHumanInput } from './trusted-human-input.js'
import type { ConversationRequestRecord } from './conversation-request.js'
import { ConversationRequestStore, requestSourceFor } from './conversation-request-store.js'
import { RequestPermissionGate } from './request-permission-gate.js'
import type { ConversationRequestSource, RequestPermissionSource } from './request-permission-sources.js'

export interface RequestOperationFrame {
  request: ConversationRequestRecord
  source: TrustedHumanInput
  ceiling: RequestPermissionSource
  current: RequestPermissionSource
}

/** Host-only operation boundary. A locator never supplies actor identity or permission. */
export class ConversationRequestAuthority {
  constructor(
    private readonly store: ConversationRequestStore,
    private readonly managerKey: ManagerKey,
    private readonly requestId: string,
    private readonly scope: 'group' | 'request',
    private readonly resolveCurrent: (kind: RequestPermissionSource['kind'], origin: ConversationRequestSource) => Promise<RequestPermissionSource | null>,
  ) {
    if (scope !== 'group' && scope !== 'request') throw new Error('Invalid request execution scope')
  }
  async run<T>(checkCompleteOperation: (source: RequestPermissionSource) => Promise<PermissionDecision>, execute: (frame: RequestOperationFrame) => Promise<T>): Promise<T> {
    const fixed = await this.requireOpen()
    const ceilings = structuredClone(fixed.record.permission_sources)
    if (this.scope === 'group') ceilings.friend = null
    const current = new Map<RequestPermissionSource['kind'], RequestPermissionSource>()
    const origin = requestSourceFor(fixed.source)
    const gate = new RequestPermissionGate(origin, ceilings, async kind => {
      const resolved = await this.resolveCurrent(kind, structuredClone(origin))
      if (resolved) current.set(kind, structuredClone(resolved))
      return resolved
    })
    const decision = await gate.authorize(checkCompleteOperation)
    if (!decision.allowed) throw new Error(decision.reason)
    // A close committed while current authority was being fetched must stop a new action.
    await this.requireOpen()
    const kind = decision.source.kind
    return execute(structuredClone({ request: fixed.record, source: fixed.source, ceiling: ceilings[kind]!, current: current.get(kind)! }))
  }
  private async requireOpen(): Promise<{ record: ConversationRequestRecord; source: TrustedHumanInput }> {
    const fixed = await this.store.get(this.managerKey, this.requestId)
    if (!fixed) throw new Error('Request not found')
    if (fixed.record.status !== 'open') throw new Error('Request is closed')
    return fixed
  }
}
