import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('../../lib/scrapling-prepare.mjs', () => ({ runBounded: vi.fn() }))
vi.mock('../../lib/release-package.mjs', () => ({ verifyReleasePackage: vi.fn() }))
import { runBounded } from '../../lib/scrapling-prepare.mjs'
import { extractRelease } from '../release.mjs'

describe('Windows release extraction', () => {
  let directory, tmp, home
  beforeEach(() => {
    vi.resetAllMocks()
    directory = mkdtempSync(join(tmpdir(), 'crabot-extract-'))
    tmp = join(directory, 'download')
    home = join(directory, 'installed')
    mkdirSync(tmp)
    mkdirSync(home)
    writeFileSync(join(home, 'VERSION'), 'previous\n')
    writeFileSync(join(home, 'cli.mjs'), 'previous code')
  })
  afterEach(() => rmSync(directory, { recursive: true, force: true }))

  it('allows a full ZIP extraction lasting longer than two minutes', async () => {
    runBounded.mockImplementation(async (_command, _args, options) => {
      // Simulate a three-minute extraction without delaying the test. An omitted
      // timeout uses runBounded's existing twenty-minute preparation deadline.
      if ((options.timeout ?? 20 * 60_000) < 180_000) throw new Error('preparation timed out')
      const root = join(options.env.CRABOT_UPGRADE_STAGE, 'crabot-release')
      mkdirSync(root, { recursive: true })
      writeFileSync(join(root, 'cli.mjs'), 'new code')
    })
    await extractRelease({ tmp, tarPath: join(tmp, 'release.zip'), version: 'next', crabotHome: home })
    expect(readFileSync(join(home, 'cli.mjs'), 'utf8')).toBe('new code')
    expect(readFileSync(join(home, 'VERSION'), 'utf8')).toBe('previous\n')
    expect(existsSync(tmp)).toBe(false)
  })

  it.each(['preparation timed out', 'archive is corrupt', 'preparation cancelled'])('preserves installed files and cleans staging on %s', async (message) => {
    const failure = new Error(message)
    runBounded.mockRejectedValue(failure)
    await expect(extractRelease({ tmp, tarPath: join(tmp, 'release.zip'), version: 'next', crabotHome: home })).rejects.toBe(failure)
    expect(readFileSync(join(home, 'cli.mjs'), 'utf8')).toBe('previous code')
    expect(readFileSync(join(home, 'VERSION'), 'utf8')).toBe('previous\n')
    expect(existsSync(tmp)).toBe(false)
  })
})
