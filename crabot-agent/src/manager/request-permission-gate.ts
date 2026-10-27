import type { PermissionDecision } from '../engine/types.js'
import { assertRequestPermissionSources, matchesRequestPermissionSource } from './request-permission-sources.js'
import type { ConversationRequestSource, RequestPermissionSource, ResolveRequestPermissionSourcesResult } from './request-permission-sources.js'

type Kind = RequestPermissionSource['kind']
export type RequestOperationDecision =
  | { allowed: true; source: Pick<RequestPermissionSource, 'kind' | 'subject_id'> }
  | { allowed: false; reason: string }

/** Applies the same complete operation to a fixed source ceiling and its current authority. */
export class RequestPermissionGate {
  private readonly ceilings: ResolveRequestPermissionSourcesResult
  constructor(
    private readonly origin: ConversationRequestSource,
    ceilings: ResolveRequestPermissionSourcesResult,
    private readonly resolveCurrent: (kind: Kind) => Promise<RequestPermissionSource | null>,
  ) {
    this.ceilings = structuredClone(ceilings)
    this.origin = structuredClone(origin)
    assertRequestPermissionSources(origin, this.ceilings)
  }
  private matches(source: RequestPermissionSource | null, kind: Kind): source is RequestPermissionSource {
    return matchesRequestPermissionSource(source, kind, kind === 'group' ? `${this.origin.channel_id}::${this.origin.session_id}` : this.origin.sender_friend_id)
  }
  async authorize(check: (source: RequestPermissionSource) => Promise<PermissionDecision>): Promise<RequestOperationDecision> {
    let unavailable = false
    const reasons = new Set<string>()
    const remember = (decision: PermissionDecision) => {
      if (decision.allowed) return
      const explanations = new Map([
        ['未授权额外文件范围', '目录范围未授权'], ['文件路径超出授权范围', '目录范围未授权'],
        ['文件范围只读', '目录范围只读'], ['未授权内置文件入口', '文件操作入口未开启'],
        ['缺少可信主体授权', '缺少可信主体授权'],
      ])
      const explanation = decision.reason.replace(/^[A-Z_]+: /, '')
      const safe = explanation.startsWith('无法核实文件范围：') ? '文件范围无法核验' : explanations.get(explanation)
      if (safe) reasons.add(safe)
    }
    for (const kind of ['group', 'friend'] as const) {
      const ceiling = this.ceilings[kind]
      if (!ceiling) continue
      const original = await check(structuredClone(ceiling)); remember(original)
      if (!original.allowed) continue
      let current: RequestPermissionSource | null
      try { current = structuredClone(await this.resolveCurrent(kind)) }
      catch { unavailable = true; continue }
      if (!this.matches(current, kind)) { reasons.add('当前授权主体已改变或不可核验'); continue }
      const decision = await check(structuredClone(current)); remember(decision)
      if (decision.allowed) return { allowed: true, source: { kind, subject_id: current.subject_id } }
    }
    return { allowed: false, reason: unavailable ? 'CAPABILITY_UNKNOWN: 当前请求授权来源不可用' : `PERMISSION_DENIED: 没有完整且仍有效的授权来源允许此操作${reasons.size ? '（' + [...reasons].join('；') + '）' : ''}` }
  }
}
