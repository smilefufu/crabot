/**
 * Static check that long-term memory v1 concepts are fully purged from
 * the codebase (per Memory v2 spec §11.5 + §15).
 *
 * Patterns to flag:
 *  - LongTermL0Entry / LongTermL1Entry / LongTermMemoryEntry  (deleted v1 types)
 *  - SearchDetail / detail=L0|L1|L2  (deleted RPC discriminator)
 *  - Skill or doc text mentioning "L0 / L1 / L2" as memory tiers
 *  - mcp__crab-memory__store_memory  (deleted v1 RPC)
 *
 * Excluded paths: data*, *.backup-*, node_modules, dist, .git, .pytest_cache,
 * crabot-docs (historical specs/plans intentionally reference v1 for context),
 * crabot-memory/upgrade (migration script + tests need to read v1 fields).
 */
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'

const ROOT = resolve(__dirname, '../../')

function runRg(pattern: string, opts: { extraGlobs?: string[] } = {}): string[] {
  const args = [
    '--no-config',
    '--with-filename',
    '--line-number',
    '--regexp', pattern,
    '--glob', '!data*/**',
    '--glob', '!**/*.backup-*/**',
    '--glob', '!**/node_modules/**',
    '--glob', '!**/dist/**',
    '--glob', '!**/build/**',
    '--glob', '!**/.git/**',
    '--glob', '!**/__pycache__/**',
    '--glob', '!**/.pytest_cache/**',
    '--glob', '!**/.venv/**',
    '--glob', '!**/coverage/**',
    // Specs / plans / research intentionally reference v1 for historical context
    '--glob', '!crabot-docs/**',
    // Migration script + its tests must reference v1 schema
    '--glob', '!crabot-memory/upgrade/**',
    '--glob', '!crabot-memory/tests/upgrade/**',
    // The cleanup test itself contains the patterns
    '--glob', '!**/v1-cleanup.test.ts',
    // crabot-shared base protocol historical comments
    '--glob', '!crabot-shared/**',
  ]
  if (opts.extraGlobs) for (const g of opts.extraGlobs) args.push('--glob', g)
  args.push(ROOT)

  try {
    const out = execFileSync('rg', args, { encoding: 'utf-8' })
    return out.split('\n').filter(Boolean)
  } catch (e: any) {
    // exit code 1 = no matches (good)
    if (e.status === 1) return []
    throw e
  }
}

describe('Memory v1 cleanup (spec §11.5 + §15)', () => {
  it('no LongTermL0Entry / LongTermL1Entry / LongTermMemoryEntry refs remain', () => {
    const hits = runRg('\\bLongTerm(L[01]|Memory)Entry\\b')
    expect(hits, `v1 entry types still referenced:\n${hits.join('\n')}`).toEqual([])
  })

  it('no SearchDetail / detail=L0|L1|L2 RPC discriminator remains', () => {
    const hits = [
      ...runRg('\\bSearchDetail\\b'),
      ...runRg("detail\\s*[:=]\\s*['\"]?L[012]['\"]?"),
    ]
    expect(hits, `v1 detail discriminator still referenced:\n${hits.join('\n')}`).toEqual([])
  })

  it('no v1 store_memory RPC reference remains in skills/code', () => {
    const hits = runRg('mcp__crab-memory__store_memory')
    expect(hits, `deleted v1 store_memory RPC still referenced:\n${hits.join('\n')}`).toEqual([])
  })

  it('no L0/L1/L2 memory-tier vocabulary in skills', () => {
    // Limit to skills + agent docs since SceneProfile fields like "overview" are legit
    const hits = runRg('\\b(L0|L1|L2)\\b[^a-zA-Z]', {
      extraGlobs: [
        // Only check skill markdowns + agent source TS
        '!**/*',
        'crabot-admin/builtins/skills/**/*.md',
      ],
    })
    expect(hits, `v1 memory-tier vocabulary still in skills:\n${hits.join('\n')}`).toEqual([])
  })
})
