import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeCoreRelease } from '../../lib/core-release.mjs'
import { verifyReleasePackage } from '../../lib/release-package.mjs'
import { getCurrentVersion, detectPlatform, writeVersionFile } from '../release.mjs'

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

  it('reads and verifies a sealed version without adding mutable VERSION or running dependency installers', async () => {
    for (const file of ['package.json', 'product-runtime.json']) writeFileSync(join(dir, file), '{"version":"1.2.3"}')
    await writeCoreRelease(dir, { schema_version: 1, version: '1.2.3', platform: process.platform, arch: process.arch, commit: '1'.repeat(40), source_dirty: false })
    expect(getCurrentVersion(dir)).toBe('1.2.3')
    const index = readFileSync(join(dir, 'core-files.json'), 'utf8')
    await verifyReleasePackage(dir, 'v1.2.3', { run: () => { throw new Error('Must not run an installer') } })
    await writeVersionFile(dir, 'v1.2.3')
    expect(existsSync(join(dir, 'VERSION'))).toBe(false)
    expect(readFileSync(join(dir, 'core-files.json'), 'utf8')).toBe(index)
    writeFileSync(join(dir, 'unexpected'), 'not part of this release')
    await expect(verifyReleasePackage(dir, '1.2.3')).rejects.toHaveProperty('code', 'CRABOT_CORE_INTEGRITY')
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
    expect(p).toMatch(/^(darwin|linux|windows)-(x64|arm64)$/)
  })
})
