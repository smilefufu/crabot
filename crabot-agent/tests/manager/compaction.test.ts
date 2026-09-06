import { describe, expect, it } from 'vitest'
import {
  decideCompaction,
  managerPolicyForWindow,
  type CompactionPolicy,
} from '../../src/manager/compaction'

const POLICY: CompactionPolicy = {
  keepRecent: 3,
  hardCapTokens: 500,
}

describe('decideCompaction', () => {
  it.each([0, 499, 500])('keeps a complete request of %i tokens within the hard cap unchanged', (mainRequestTokens) => {
    expect(decideCompaction({ policy: POLICY, mainRequestTokens })).toEqual({ kind: 'none' })
  })

  it('returns force_hot when the complete request exceeds the hard cap', () => {
    expect(decideCompaction({ policy: POLICY, mainRequestTokens: 501 })).toEqual({ kind: 'force_hot' })
  })
})

describe('managerPolicyForWindow', () => {
  it('derives hardCap from the active model window and preserves keepRecent', () => {
    const result = managerPolicyForWindow(POLICY, 128_000)

    expect(result).toEqual({ ...POLICY, hardCapTokens: 102_400 })
    expect(managerPolicyForWindow(POLICY, 1_000_000).hardCapTokens).toBe(800_000)
  })

  it('keeps the configured fallback when context_window is absent', () => {
    expect(managerPolicyForWindow(POLICY, undefined)).toBe(POLICY)
  })
})
