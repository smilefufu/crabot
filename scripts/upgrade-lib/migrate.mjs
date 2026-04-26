import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { cp, writeFile } from 'node:fs/promises'
import { join, basename } from 'node:path'

function readTrim(path) {
  if (!existsSync(path)) return null
  return readFileSync(path, 'utf-8').trim() || null
}

export function scanModules(crabotHome, dataDir) {
  const out = []
  for (const name of readdirSync(crabotHome).sort()) {
    if (!name.startsWith('crabot-')) continue
    const moduleDir = join(crabotHome, name)
    if (!statSync(moduleDir).isDirectory()) continue
    const codeVersion = readTrim(join(moduleDir, 'schema_version'))
    if (!codeVersion) continue
    const subName = name.slice('crabot-'.length)
    const moduleDataDir = join(dataDir, subName)
    const dataVersion = readTrim(join(moduleDataDir, 'SCHEMA_VERSION'))
    if (codeVersion === dataVersion) continue
    out.push({
      moduleId: name,
      codeVersion,
      dataVersion,
      dataDir: moduleDataDir,
    })
  }
  return out
}

export async function backupDataDir(dataDir, timestamp) {
  if (!existsSync(dataDir)) {
    throw new Error(`backup source missing: ${dataDir}`)
  }
  const dest = `${dataDir}.backup-${timestamp}`
  await cp(dataDir, dest, { recursive: true })
  return dest
}

function parseVersion(v) {
  if (v === null) return 0
  const m = /^v(\d+)$/.exec(v)
  if (!m) throw new Error(`invalid version format: ${v}`)
  return parseInt(m[1], 10)
}

function findScript(upgradeDir, fromN, toN) {
  if (!existsSync(upgradeDir)) return null
  const prefix = `from_v${fromN}_to_v${toN}.`
  for (const name of readdirSync(upgradeDir)) {
    if (name.startsWith(prefix)) return join(upgradeDir, name)
  }
  return null
}

export async function chainUpgrade(moduleDir, dataDir, fromVersion, toVersion, runScriptFn) {
  const fromN = parseVersion(fromVersion)
  const toN = parseVersion(toVersion)
  if (toN <= fromN) return { ok: true }
  const upgradeDir = join(moduleDir, 'upgrade')
  for (let n = fromN; n < toN; n++) {
    const script = findScript(upgradeDir, n, n + 1)
    if (!script) {
      throw new Error(`missing upgrade script: from v${n} to v${n + 1} (looked in ${upgradeDir})`)
    }
    const { exitCode } = await runScriptFn(script, dataDir)
    if (exitCode !== 0) {
      return { ok: false, failedAt: basename(script) }
    }
  }
  return { ok: true }
}

export async function writeSchemaVersion(dataDir, version) {
  await writeFile(join(dataDir, 'SCHEMA_VERSION'), `${version}\n`, 'utf-8')
}

function timestamp() {
  const d = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`
}

export async function runMigrations(crabotHome, dataDir, runScriptFn, logger) {
  const targets = scanModules(crabotHome, dataDir)
  if (targets.length === 0) {
    return { ok: true, migrated: [], skipped: [] }
  }

  const ts = timestamp()
  const migrated = []
  for (const t of targets) {
    logger.info(`[${t.moduleId}] ${t.dataVersion ?? 'v0'} → ${t.codeVersion}`)
    let backupPath
    try {
      backupPath = await backupDataDir(t.dataDir, ts)
    } catch (e) {
      logger.error(`[${t.moduleId}] backup failed: ${e.message}`)
      return { ok: false, failedModule: t.moduleId, failedAt: 'backup', backupPath: null }
    }
    logger.info(`[${t.moduleId}] backup → ${backupPath}`)

    const moduleDir = join(crabotHome, t.moduleId)
    const result = await chainUpgrade(moduleDir, t.dataDir, t.dataVersion, t.codeVersion, runScriptFn)
    if (!result.ok) {
      logger.error(`[${t.moduleId}] FAILED at ${result.failedAt}`)
      return {
        ok: false,
        failedModule: t.moduleId,
        failedAt: result.failedAt,
        backupPath,
      }
    }
    await writeSchemaVersion(t.dataDir, t.codeVersion)
    logger.info(`[${t.moduleId}] done`)
    migrated.push(t.moduleId)
  }
  return { ok: true, migrated, skipped: [] }
}
