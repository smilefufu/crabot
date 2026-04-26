import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scanModules, backupDataDir } from '../migrate.mjs'

describe('scanModules', () => {
  let crabotHome, dataDir

  beforeEach(() => {
    crabotHome = mkdtempSync(join(tmpdir(), 'crabot-home-'))
    dataDir = mkdtempSync(join(tmpdir(), 'crabot-data-'))
  })

  afterEach(() => {
    rmSync(crabotHome, { recursive: true, force: true })
    rmSync(dataDir, { recursive: true, force: true })
  })

  function setupModule(name, codeVer, dataVer) {
    const moduleDir = join(crabotHome, `crabot-${name}`)
    mkdirSync(moduleDir)
    if (codeVer !== null) writeFileSync(join(moduleDir, 'schema_version'), codeVer)
    const moduleData = join(dataDir, name)
    mkdirSync(moduleData)
    if (dataVer !== null) writeFileSync(join(moduleData, 'SCHEMA_VERSION'), dataVer)
  }

  it('returns empty array when no modules have schema_version', () => {
    setupModule('memory', null, null)
    setupModule('admin', null, null)
    expect(scanModules(crabotHome, dataDir)).toEqual([])
  })

  it('detects modules where code/data versions differ', () => {
    setupModule('memory', 'v2', 'v1')
    setupModule('admin', null, null)
    const result = scanModules(crabotHome, dataDir)
    expect(result).toEqual([
      { moduleId: 'crabot-memory', codeVersion: 'v2', dataVersion: 'v1', dataDir: join(dataDir, 'memory') },
    ])
  })

  it('treats missing data SCHEMA_VERSION as null (signals first migration)', () => {
    setupModule('memory', 'v2', null)
    const result = scanModules(crabotHome, dataDir)
    expect(result[0].dataVersion).toBeNull()
  })

  it('skips modules whose versions match', () => {
    setupModule('memory', 'v2', 'v2')
    expect(scanModules(crabotHome, dataDir)).toEqual([])
  })

  it('returns modules sorted alphabetically', () => {
    setupModule('memory', 'v2', 'v1')
    setupModule('admin', 'v2', 'v1')
    setupModule('agent', 'v2', 'v1')
    const ids = scanModules(crabotHome, dataDir).map(m => m.moduleId)
    expect(ids).toEqual(['crabot-admin', 'crabot-agent', 'crabot-memory'])
  })

  it('trims whitespace from version strings', () => {
    setupModule('memory', '  v2\n', ' v1 \n')
    const result = scanModules(crabotHome, dataDir)
    expect(result[0].codeVersion).toBe('v2')
    expect(result[0].dataVersion).toBe('v1')
  })
})

describe('backupDataDir', () => {
  let dataDir

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'crabot-bkp-'))
  })

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true })
    rmSync(`${dataDir}.backup-20260423-153012`, { recursive: true, force: true })
  })

  it('copies dataDir to <dataDir>.backup-<timestamp>', async () => {
    writeFileSync(join(dataDir, 'a.txt'), 'hello')
    mkdirSync(join(dataDir, 'sub'))
    writeFileSync(join(dataDir, 'sub', 'b.txt'), 'world')

    const backupPath = await backupDataDir(dataDir, '20260423-153012')
    expect(backupPath).toBe(`${dataDir}.backup-20260423-153012`)
    const { readFileSync: rfs, existsSync: ex } = await import('node:fs')
    expect(rfs(join(backupPath, 'a.txt'), 'utf-8')).toBe('hello')
    expect(ex(join(backupPath, 'sub', 'b.txt'))).toBe(true)
  })

  it('throws if dataDir does not exist', async () => {
    await expect(backupDataDir('/nonexistent/path-xyz', '20260423-153012')).rejects.toThrow()
  })
})

describe('chainUpgrade', () => {
  let moduleDir, dataDir, calls

  beforeEach(() => {
    moduleDir = mkdtempSync(join(tmpdir(), 'crabot-mod-'))
    dataDir = mkdtempSync(join(tmpdir(), 'crabot-data-'))
    mkdirSync(join(moduleDir, 'upgrade'))
    calls = []
  })

  afterEach(() => {
    rmSync(moduleDir, { recursive: true, force: true })
    rmSync(dataDir, { recursive: true, force: true })
  })

  function fakeRunner(result = { exitCode: 0, stdout: '', stderr: '' }) {
    return async (scriptPath, dd) => {
      calls.push({ scriptPath, dd })
      return result
    }
  }

  function makeScript(name) {
    writeFileSync(join(moduleDir, 'upgrade', name), '// noop\n')
  }

  it('runs scripts in version order from null to vN', async () => {
    makeScript('from_v0_to_v1.mjs')
    makeScript('from_v1_to_v2.mjs')
    const { chainUpgrade } = await import('../migrate.mjs')
    const result = await chainUpgrade(moduleDir, dataDir, null, 'v2', fakeRunner())
    expect(result.ok).toBe(true)
    expect(calls.map(c => c.scriptPath.split('/').pop())).toEqual([
      'from_v0_to_v1.mjs',
      'from_v1_to_v2.mjs',
    ])
  })

  it('runs only steps in range when fromVersion is mid-chain', async () => {
    makeScript('from_v0_to_v1.mjs')
    makeScript('from_v1_to_v2.mjs')
    makeScript('from_v2_to_v3.mjs')
    const { chainUpgrade } = await import('../migrate.mjs')
    await chainUpgrade(moduleDir, dataDir, 'v1', 'v3', fakeRunner())
    expect(calls.map(c => c.scriptPath.split('/').pop())).toEqual([
      'from_v1_to_v2.mjs',
      'from_v2_to_v3.mjs',
    ])
  })

  it('stops on first failure and reports failedAt', async () => {
    makeScript('from_v0_to_v1.mjs')
    makeScript('from_v1_to_v2.mjs')
    let n = 0
    const runner = async (scriptPath, dd) => {
      calls.push({ scriptPath, dd })
      n += 1
      return n === 1
        ? { exitCode: 0, stdout: '', stderr: '' }
        : { exitCode: 7, stdout: '', stderr: 'boom' }
    }
    const { chainUpgrade } = await import('../migrate.mjs')
    const result = await chainUpgrade(moduleDir, dataDir, null, 'v2', runner)
    expect(result.ok).toBe(false)
    expect(result.failedAt).toBe('from_v1_to_v2.mjs')
    expect(calls.length).toBe(2)
  })

  it('throws when an intermediate script is missing', async () => {
    makeScript('from_v0_to_v1.mjs')
    const { chainUpgrade } = await import('../migrate.mjs')
    await expect(
      chainUpgrade(moduleDir, dataDir, null, 'v2', fakeRunner()),
    ).rejects.toThrow(/missing.*v1.*v2/i)
  })
})

describe('writeSchemaVersion', () => {
  let dataDir

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'crabot-sv-'))
  })

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true })
  })

  it('writes the version string to SCHEMA_VERSION', async () => {
    const { writeSchemaVersion } = await import('../migrate.mjs')
    await writeSchemaVersion(dataDir, 'v2')
    const { readFileSync: rfs } = await import('node:fs')
    expect(rfs(join(dataDir, 'SCHEMA_VERSION'), 'utf-8')).toBe('v2\n')
  })

  it('overwrites existing SCHEMA_VERSION', async () => {
    const { writeSchemaVersion } = await import('../migrate.mjs')
    writeFileSync(join(dataDir, 'SCHEMA_VERSION'), 'v1')
    await writeSchemaVersion(dataDir, 'v2')
    const { readFileSync: rfs } = await import('node:fs')
    expect(rfs(join(dataDir, 'SCHEMA_VERSION'), 'utf-8')).toBe('v2\n')
  })
})

describe('runMigrations', () => {
  let crabotHome, dataDir, logs

  beforeEach(() => {
    crabotHome = mkdtempSync(join(tmpdir(), 'crabot-rm-h-'))
    dataDir = mkdtempSync(join(tmpdir(), 'crabot-rm-d-'))
    logs = { info: [], warn: [], error: [] }
  })

  afterEach(() => {
    rmSync(crabotHome, { recursive: true, force: true })
    rmSync(dataDir, { recursive: true, force: true })
  })

  function logger() {
    return {
      info: (m) => logs.info.push(m),
      warn: (m) => logs.warn.push(m),
      error: (m) => logs.error.push(m),
    }
  }

  function setupModule(name, codeVer, dataVer, scripts = []) {
    const md = join(crabotHome, `crabot-${name}`)
    mkdirSync(md, { recursive: true })
    writeFileSync(join(md, 'schema_version'), codeVer)
    mkdirSync(join(md, 'upgrade'), { recursive: true })
    for (const s of scripts) writeFileSync(join(md, 'upgrade', s), '// noop\n')
    const dd = join(dataDir, name)
    mkdirSync(dd, { recursive: true })
    if (dataVer !== null) writeFileSync(join(dd, 'SCHEMA_VERSION'), dataVer)
    writeFileSync(join(dd, 'somefile'), 'data')
  }

  it('returns ok with empty migrated list when nothing to do', async () => {
    setupModule('memory', 'v2', 'v2', [])
    const { runMigrations } = await import('../migrate.mjs')
    const result = await runMigrations(crabotHome, dataDir, async () => ({ exitCode: 0, stdout: '', stderr: '' }), logger())
    expect(result).toEqual({ ok: true, migrated: [], skipped: [] })
  })

  it('migrates one module successfully end-to-end', async () => {
    setupModule('memory', 'v2', 'v1', ['from_v1_to_v2.mjs'])
    const { runMigrations } = await import('../migrate.mjs')
    const result = await runMigrations(
      crabotHome, dataDir,
      async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      logger(),
    )
    expect(result.ok).toBe(true)
    expect(result.migrated.length).toBe(1)
    const { readFileSync: rfs, readdirSync: rds } = await import('node:fs')
    expect(rfs(join(dataDir, 'memory', 'SCHEMA_VERSION'), 'utf-8').trim()).toBe('v2')
    const entries = rds(dataDir)
    expect(entries.some(e => e.startsWith('memory.backup-'))).toBe(true)
  })

  it('stops at first failed module and does NOT write SCHEMA_VERSION', async () => {
    setupModule('admin', 'v2', 'v1', ['from_v1_to_v2.mjs'])
    setupModule('memory', 'v2', 'v1', ['from_v1_to_v2.mjs'])
    const failer = async (scriptPath) => {
      if (scriptPath.includes('crabot-admin')) {
        return { exitCode: 5, stdout: '', stderr: 'boom' }
      }
      return { exitCode: 0, stdout: '', stderr: '' }
    }
    const { runMigrations } = await import('../migrate.mjs')
    const result = await runMigrations(crabotHome, dataDir, failer, logger())
    expect(result.ok).toBe(false)
    expect(result.failedModule).toBe('crabot-admin')
    const { readFileSync: rfs } = await import('node:fs')
    expect(rfs(join(dataDir, 'admin', 'SCHEMA_VERSION'), 'utf-8').trim()).toBe('v1')
  })
})
