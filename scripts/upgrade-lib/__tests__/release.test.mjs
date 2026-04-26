import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getCurrentVersion, detectPlatform } from '../release.mjs'

describe('getCurrentVersion', () => {
  let dir

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'crabot-ver-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('reads VERSION file content', () => {
    writeFileSync(join(dir, 'VERSION'), 'v1.5\n')
    expect(getCurrentVersion(dir)).toBe('v1.5')
  })

  it('returns null if VERSION file is absent', () => {
    expect(getCurrentVersion(dir)).toBeNull()
  })

  it('returns null if VERSION file is empty', () => {
    writeFileSync(join(dir, 'VERSION'), '')
    expect(getCurrentVersion(dir)).toBeNull()
  })
})

describe('detectPlatform', () => {
  it('returns string of form <os>-<arch>', () => {
    const p = detectPlatform()
    expect(p).toMatch(/^(darwin|linux)-(x64|arm64)$/)
  })
})
