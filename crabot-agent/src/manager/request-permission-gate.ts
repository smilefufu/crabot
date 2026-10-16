import type { PermissionDecision } from '../engine/types.js'
import { isResolvedPermissionsSnapshot } from '../workers/harness/context-store.js'
import type { ConversationRequestSource, RequestPermissionSource, ResolveRequestPermissionSourcesResult } from './request-permission-sources.js'

type Kind = RequestPermissionSource['kind']
export type RequestOperationDecision =
  | { allowed: true; source: Pick<RequestPermissionSource, 'kind' | 'subject_id'> }
  | { allowed: false; reason: string }

/** Applies the same complete operation to a fixed source ceiling and its current authority. */
export class RequestPermissionGate {
  private readonly ceilings: ResolveRequestPermissionSourcesResult
  private readonly subjects: Record<Kind, string | null>
  constructor(
    origin: ConversationRequestSource,
    ceilings: ResolveRequestPermissionSourcesResult,
    private readonly resolveCurrent: (kind: Kind) => Promise<RequestPermissionSource | null>,
  ) {
    this.ceilings = structuredClone(ceilings)
    this.subjects = { group: `${origin.channel_id}::${origin.session_id}`, friend: origin.sender_friend_id }
    if (origin.session_type !== 'group' || !this.matches(this.ceilings.group, 'group') || this.ceilings.friend && !this.matches(this.ceilings.friend, 'friend')) throw new Error('Invalid request permission ceiling')
  }
  private matches(source: RequestPermissionSource | null, kind: Kind): source is RequestPermissionSource {
    return source !== null && typeof source === 'object' && source.kind === kind && this.subjects[kind] !== null && source.subject_id === this.subjects[kind]
      && typeof source.is_master === 'boolean' && (kind !== 'group' || !source.is_master) && isResolvedPermissionsSnapshot(source.resolved)
  }
  async authorize(check: (source: RequestPermissionSource) => Promise<PermissionDecision>): Promise<RequestOperationDecision> {
    let unavailable = false
    for (const kind of ['group', 'friend'] as const) {
      const ceiling = this.ceilings[kind]
      if (!ceiling || !(await check(structuredClone(ceiling))).allowed) continue
      let current: RequestPermissionSource | null
      try { current = await this.resolveCurrent(kind) }
      catch { unavailable = true; continue }
      if (!this.matches(current, kind)) continue
      if ((await check(structuredClone(current))).allowed) return { allowed: true, source: { kind, subject_id: current.subject_id } }
    }
    return { allowed: false, reason: unavailable ? 'CAPABILITY_UNKNOWN: 当前请求授权来源不可用' : 'PERMISSION_DENIED: 没有完整且仍有效的授权来源允许此操作' }
  }
}
