import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { detectMode } from '../mode.mjs'

describe('detectMode', () => {
  let dir

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'crabot-mode-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('returns "source" when .git directory exists', () => {
    mkdirSync(join(dir, '.git'))
    expect(detectMode(dir)).toBe('source')
  })

  it('returns "release" when .git is absent', () => {
    expect(detectMode(dir)).toBe('release')
  })

  it('returns "source" when .git is a file (worktree)', () => {
    writeFileSync(join(dir, '.git'), 'gitdir: /elsewhere/.git/worktrees/foo\n')
    expect(detectMode(dir)).toBe('source')
  })
})
