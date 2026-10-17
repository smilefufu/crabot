import { describe, it, expect } from 'vitest'
import { computeBashPathPure } from '../../src/utils/resolve-bash-path'

const ALWAYS_EXISTS = (_p: string) => true
const NEVER_EXISTS = (_p: string) => false
const WHICH_NOTHING = (_n: string) => null

describe('computeBashPathPure (POSIX)', () => {
  it('uses the sealed product Bash on every platform and never falls back when it is damaged', () => {
    for (const platform of ['linux', 'darwin', 'win32'] as const) {
      const env = { CRABOT_PRODUCT_ROOT: '/sealed', CRABOT_BASH_PATH: '/sealed/bash' }
      expect(computeBashPathPure(platform, env, ALWAYS_EXISTS, WHICH_NOTHING)).toBe('/sealed/bash')
      expect(computeBashPathPure(platform, env, NEVER_EXISTS, () => '/host/bash')).toBeNull()
    }
  })
  it("returns 'bash' on linux without touching env/fs/which", () => {
    expect(computeBashPathPure('linux', {}, NEVER_EXISTS, WHICH_NOTHING)).toBe('bash')
  })

  it("returns 'bash' on darwin", () => {
    expect(computeBashPathPure('darwin', {}, NEVER_EXISTS, WHICH_NOTHING)).toBe('bash')
  })

  it("ignores CRABOT_BASH_PATH on POSIX (we always use system bash)", () => {
    const env = { CRABOT_BASH_PATH: '/never/used' }
    expect(computeBashPathPure('linux', env, ALWAYS_EXISTS, () => '/some/where')).toBe('bash')
  })
})

describe('computeBashPathPure (win32)', () => {
  it('prefers CRABOT_BASH_PATH when set and file exists', () => {
    const env = { CRABOT_BASH_PATH: 'C:\\custom\\bash.exe' }
    const result = computeBashPathPure(
      'win32',
      env,
      (p) => p === 'C:\\custom\\bash.exe',
      WHICH_NOTHING,
    )
    expect(result).toBe('C:\\custom\\bash.exe')
  })

  it('falls through CRABOT_BASH_PATH when file does not exist', () => {
    const env = { CRABOT_BASH_PATH: 'C:\\bogus\\bash.exe' }
    // env value lies → check existence → fall through to PATH lookup
    const result = computeBashPathPure(
      'win32',
      env,
      (p) => p === 'C:\\real\\bash.exe',
      (n) => (n === 'bash.exe' ? 'C:\\real\\bash.exe' : null),
    )
    expect(result).toBe('C:\\real\\bash.exe')
  })

  it('ignores empty CRABOT_BASH_PATH', () => {
    const env = { CRABOT_BASH_PATH: '   ' }
    const result = computeBashPathPure(
      'win32',
      env,
      (p) => p === 'C:\\real\\bash.exe',
      (n) => (n === 'bash.exe' ? 'C:\\real\\bash.exe' : null),
    )
    expect(result).toBe('C:\\real\\bash.exe')
  })

  it('uses where.exe bash result when env unset', () => {
    const result = computeBashPathPure(
      'win32',
      {},
      ALWAYS_EXISTS,
      (n) => (n === 'bash.exe' ? 'C:\\Program Files\\Git\\bin\\bash.exe' : null),
    )
    expect(result).toBe('C:\\Program Files\\Git\\bin\\bash.exe')
  })

  it('derives bash from git.exe path (Git for Windows default PATH option)', () => {
    // The most common real-world Windows scenario: Git for Windows installed with
    // the default "Git from command line" PATH option puts git.exe in PATH but
    // bash.exe (which sits in ..\..\bin\bash.exe relative to git.exe) is NOT in PATH.
    const result = computeBashPathPure(
      'win32',
      {},
      (p) => p === 'C:\\Program Files\\Git\\bin\\bash.exe',
      (n) => (n === 'git.exe' ? 'C:\\Program Files\\Git\\cmd\\git.exe' : null),
    )
    expect(result).toBe('C:\\Program Files\\Git\\bin\\bash.exe')
  })

  it('returns null when nothing locates bash (MinGit / no git)', () => {
    // MinGit (e.g. GitHub Desktop) ships git.exe but no bash.exe sibling.
    const result = computeBashPathPure(
      'win32',
      {},
      NEVER_EXISTS,
      (n) => (n === 'git.exe' ? 'C:\\PortableMinGit\\cmd\\git.exe' : null),
    )
    expect(result).toBeNull()
  })

  it('returns null when neither bash nor git on PATH and no env override', () => {
    expect(computeBashPathPure('win32', {}, ALWAYS_EXISTS, WHICH_NOTHING)).toBeNull()
  })

  it('rejects where.exe bash result if file does not exist (stale PATH entry)', () => {
    // where.exe can return paths that are listed in PATH but no longer exist on disk.
    const result = computeBashPathPure(
      'win32',
      {},
      (p) => p === 'C:\\Program Files\\Git\\bin\\bash.exe',
      (n) => {
        if (n === 'bash.exe') return 'C:\\stale\\bash.exe'
        if (n === 'git.exe') return 'C:\\Program Files\\Git\\cmd\\git.exe'
        return null
      },
    )
    // Falls through to git-derived path
    expect(result).toBe('C:\\Program Files\\Git\\bin\\bash.exe')
  })
})
