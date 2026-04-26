import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkSchema } from './schema-check.js'

describe('checkSchema', () => {
  let moduleDir: string
  let dataDir: string

  beforeEach(() => {
    moduleDir = mkdtempSync(join(tmpdir(), 'mod-'))
    dataDir = mkdtempSync(join(tmpdir(), 'data-'))
  })

  afterEach(() => {
    rmSync(moduleDir, { recursive: true, force: true })
    rmSync(dataDir, { recursive: true, force: true })
  })

  it('allows when module has no schema_version (not opted in)', () => {
    expect(checkSchema({ moduleDir, dataDir })).toEqual({ kind: 'allow' })
  })

  it('signals first-install when data dir is empty and code declares version', () => {
    writeFileSync(join(moduleDir, 'schema_version'), 'v2\n')
    expect(checkSchema({ moduleDir, dataDir })).toEqual({
      kind: 'allow_first_install',
      writeVersion: 'v2',
    })
  })

  it('signals first-install when data dir contains only dotfiles', () => {
    writeFileSync(join(moduleDir, 'schema_version'), 'v2\n')
    writeFileSync(join(dataDir, '.gitkeep'), '')
    expect(checkSchema({ moduleDir, dataDir })).toEqual({
      kind: 'allow_first_install',
      writeVersion: 'v2',
    })
  })

  it('signals first-install when data dir contains only SCHEMA_VERSION itself', () => {
    writeFileSync(join(moduleDir, 'schema_version'), 'v2\n')
    writeFileSync(join(dataDir, 'SCHEMA_VERSION'), 'v2\n')
    expect(checkSchema({ moduleDir, dataDir })).toEqual({ kind: 'allow' })
  })

  it('blocks when data has content but no SCHEMA_VERSION', () => {
    writeFileSync(join(moduleDir, 'schema_version'), 'v2\n')
    writeFileSync(join(dataDir, 'real.db'), 'data')
    const result = checkSchema({ moduleDir, dataDir })
    expect(result).toEqual({ kind: 'block', codeVersion: 'v2', dataVersion: null })
  })

  it('blocks when versions differ', () => {
    writeFileSync(join(moduleDir, 'schema_version'), 'v2\n')
    writeFileSync(join(dataDir, 'SCHEMA_VERSION'), 'v1\n')
    writeFileSync(join(dataDir, 'real.db'), 'data')
    expect(checkSchema({ moduleDir, dataDir })).toEqual({
      kind: 'block', codeVersion: 'v2', dataVersion: 'v1',
    })
  })

  it('allows when versions match', () => {
    writeFileSync(join(moduleDir, 'schema_version'), 'v2\n')
    writeFileSync(join(dataDir, 'SCHEMA_VERSION'), 'v2\n')
    writeFileSync(join(dataDir, 'real.db'), 'data')
    expect(checkSchema({ moduleDir, dataDir })).toEqual({ kind: 'allow' })
  })

  it('handles non-existent dataDir as empty (first install)', () => {
    writeFileSync(join(moduleDir, 'schema_version'), 'v2\n')
    rmSync(dataDir, { recursive: true })
    expect(checkSchema({ moduleDir, dataDir })).toEqual({
      kind: 'allow_first_install',
      writeVersion: 'v2',
    })
  })
})
