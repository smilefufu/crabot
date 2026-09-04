/** Manager 的缓存感知压缩触发策略。批次规划与摘要执行统一由 Engine ContextManager 负责。 */

import type { EngineMessage } from '../engine/index.js'
import { DEFAULT_COMPACT_THRESHOLD } from '../engine/context-manager.js'
import type { ManagerSessionState } from './types.js'

export interface CompactionPolicy {
  readonly keepRecent: number
  readonly cacheTtlMs: number
  readonly foldTokenThreshold: number
  readonly hardCapTokens: number
}

export type CompactionDecision =
  | { readonly kind: 'none' }
  | { readonly kind: 'fold_at_wake' }
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
 * - 冷缓存按 preferred keepRecent 之前的原始历史量触发 preserve_recent；
 * - 完整主请求超过 hardCap 时触发 fit_hard_cap，keepRecent 不构成短路条件。
 */
export function decideCompaction(args: {
  readonly state: ManagerSessionState
  readonly nowMs: number
  readonly policy: CompactionPolicy
  readonly estimateTokens: (messages: ReadonlyArray<EngineMessage>) => number
  readonly mainRequestTokens: number
}): CompactionDecision {
  const { state, nowMs, policy, estimateTokens, mainRequestTokens } = args
  const preferredFoldCount = Math.max(0, state.recent.length - policy.keepRecent)
  const preferredFold = state.recent.slice(0, preferredFoldCount)
  const isCold = state.lastActiveAt !== undefined
    && nowMs - Date.parse(state.lastActiveAt) > policy.cacheTtlMs

  if (mainRequestTokens > policy.hardCapTokens) {
    return { kind: 'force_hot' }
  }
  if (isCold && estimateTokens(preferredFold) > policy.foldTokenThreshold) {
    return { kind: 'fold_at_wake' }
  }
  return { kind: 'none' }
}
