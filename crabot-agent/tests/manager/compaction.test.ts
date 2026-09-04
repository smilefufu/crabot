import { describe, expect, it } from 'vitest'
import {
  decideCompaction,
  managerPolicyForWindow,
  type CompactionPolicy,
} from '../../src/manager/compaction'
import { createUserMessage, type EngineMessage } from '../../src/engine/index.js'
import type { ManagerKey, ManagerSessionState } from '../../src/manager/types'

const KEY: ManagerKey = 'wechat::sess-compaction'
const POLICY: CompactionPolicy = {
  keepRecent: 3,
  cacheTtlMs: 1_000,
  foldTokenThreshold: 100,
  hardCapTokens: 500,
}
const estimateTokens = (messages: ReadonlyArray<EngineMessage>): number => messages.length * 50

function makeHistory(count: number): EngineMessage[] {
  return Array.from({ length: count }, (_, index) => createUserMessage(`msg-${index}`))
}

function baseState(overrides: Partial<ManagerSessionState>): ManagerSessionState {
  return { key: KEY, recent: [], foldedCount: 0, ...overrides }
}

function decide(args: {
  readonly state: ManagerSessionState
  readonly nowMs: number
  readonly mainRequestTokens?: number
}) {
  return decideCompaction({
    ...args,
    policy: POLICY,
    estimateTokens,
    mainRequestTokens: args.mainRequestTokens ?? estimateTokens(args.state.recent),
  })
}

describe('decideCompaction', () => {
  it('keeps a hot session below the complete-request hard cap unchanged', () => {
    const nowMs = 10_000
    const state = baseState({
      recent: makeHistory(5),
      lastActiveAt: new Date(nowMs - 500).toISOString(),
    })

    expect(decide({ state, nowMs, mainRequestTokens: 450 })).toEqual({ kind: 'none' })
  })

  it('returns force_hot when the complete request exceeds the hard cap', () => {
    const nowMs = 10_000
    const state = baseState({
      recent: makeHistory(5),
      lastActiveAt: new Date(nowMs - 500).toISOString(),
    })

    expect(decide({ state, nowMs, mainRequestTokens: 501 })).toEqual({ kind: 'force_hot' })
  })

  it('prioritizes the hard cap over cold-cache folding', () => {
    const nowMs = 10_000
    const state = baseState({
      recent: makeHistory(8),
      lastActiveAt: new Date(nowMs - 2_000).toISOString(),
    })

    expect(decide({ state, nowMs, mainRequestTokens: 501 })).toEqual({ kind: 'force_hot' })
  })

  it('uses only the preferred foldable prefix for the cold-cache threshold', () => {
    const nowMs = 10_000
    const cold = new Date(nowMs - 2_000).toISOString()

    expect(decide({
      state: baseState({ recent: makeHistory(5), lastActiveAt: cold }),
      nowMs,
    })).toEqual({ kind: 'none' })
    expect(decide({
      state: baseState({ recent: makeHistory(8), lastActiveAt: cold }),
      nowMs,
    })).toEqual({ kind: 'fold_at_wake' })
  })

  it('lets hardCap override preferred keepRecent for short but oversized histories', () => {
    const nowMs = 10_000
    const state = baseState({
      recent: makeHistory(2),
      lastActiveAt: new Date(nowMs - 500).toISOString(),
    })

    expect(decide({ state, nowMs, mainRequestTokens: 600 })).toEqual({ kind: 'force_hot' })
  })

  it('also returns force_hot when history length exactly equals keepRecent', () => {
    const nowMs = 10_000
    const state = baseState({
      recent: makeHistory(POLICY.keepRecent),
      lastActiveAt: new Date(nowMs - 500).toISOString(),
    })

    expect(decide({ state, nowMs, mainRequestTokens: 600 })).toEqual({ kind: 'force_hot' })
  })

  it('treats a missing lastActiveAt as hot while retaining the hardCap fallback', () => {
    const state = baseState({ recent: makeHistory(5) })

    expect(decide({ state, nowMs: 10_000, mainRequestTokens: 400 })).toEqual({ kind: 'none' })
    expect(decide({ state, nowMs: 10_000, mainRequestTokens: 600 })).toEqual({ kind: 'force_hot' })
  })

  it('does not rewrite state while deciding, preserving the cacheable prefix byte-for-byte', () => {
    const nowMs = 10_000
    const state = baseState({
      recent: makeHistory(5),
      rollingSummary: '此前对话摘要文本',
      lastActiveAt: new Date(nowMs - 500).toISOString(),
    })
    const before = JSON.stringify(state)

    expect(decide({ state, nowMs, mainRequestTokens: 400 })).toEqual({ kind: 'none' })
    expect(JSON.stringify(state)).toBe(before)
  })
})

describe('managerPolicyForWindow', () => {
  it('derives hardCap from the active model window and preserves the other policy fields', () => {
    const result = managerPolicyForWindow(POLICY, 128_000)

    expect(result).toEqual({ ...POLICY, hardCapTokens: 102_400 })
    expect(managerPolicyForWindow(POLICY, 1_000_000).hardCapTokens).toBe(800_000)
  })

  it('keeps the configured fallback when context_window is absent', () => {
    expect(managerPolicyForWindow(POLICY, undefined)).toBe(POLICY)
  })
})
