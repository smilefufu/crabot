import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

export type SchemaCheckResult =
  | { kind: 'allow' }
  | { kind: 'allow_first_install'; writeVersion: string }
  | { kind: 'block'; codeVersion: string; dataVersion: string | null }

function readTrim(path: string): string | null {
  if (!existsSync(path)) return null
  const v = readFileSync(path, 'utf-8').trim()
  return v || null
}

function isDataDirEmpty(dataDir: string): boolean {
  if (!existsSync(dataDir)) return true
  const entries = readdirSync(dataDir).filter(
    (n) => !n.startsWith('.') && n !== 'SCHEMA_VERSION',
  )
  return entries.length === 0
}

export function checkSchema(params: {
  moduleDir: string
  dataDir: string
}): SchemaCheckResult {
  const { moduleDir, dataDir } = params
  const codeVersion = readTrim(join(moduleDir, 'schema_version'))
  if (codeVersion === null) {
    return { kind: 'allow' }
  }
  const dataVersion = readTrim(join(dataDir, 'SCHEMA_VERSION'))
  if (dataVersion === null) {
    if (isDataDirEmpty(dataDir)) {
      return { kind: 'allow_first_install', writeVersion: codeVersion }
    }
    return { kind: 'block', codeVersion, dataVersion: null }
  }
  if (dataVersion !== codeVersion) {
    return { kind: 'block', codeVersion, dataVersion }
  }
  return { kind: 'allow' }
}
