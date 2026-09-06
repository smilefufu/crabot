/** Manager 的容量压缩触发策略。批次规划与摘要执行统一由 Engine ContextManager 负责。 */

import { DEFAULT_COMPACT_THRESHOLD } from '../engine/context-manager.js'

export interface CompactionPolicy {
  readonly keepRecent: number
  readonly hardCapTokens: number
}

export type CompactionDecision =
  | { readonly kind: 'none' }
  | { readonly kind: 'force_hot' }

export function managerPolicyForWindow(
  policy: CompactionPolicy,
  contextWindowTokens: number | undefined,
): CompactionPolicy {
  if (contextWindowTokens === undefined) return policy
  return { ...policy, hardCapTokens: Math.floor(contextWindowTokens * DEFAULT_COMPACT_THRESHOLD) }
}

/**
 * 这里只判断是否需要压缩，不选择消息边界：
 * 完整主请求超过 hardCap 时触发 fit_hard_cap，keepRecent 不构成短路条件。
 */
export function decideCompaction(args: {
  readonly policy: CompactionPolicy
  readonly mainRequestTokens: number
}): CompactionDecision {
  const { policy, mainRequestTokens } = args

  if (mainRequestTokens > policy.hardCapTokens) {
    return { kind: 'force_hot' }
  }
  return { kind: 'none' }
}
