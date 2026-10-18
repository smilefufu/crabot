import { prepareSharedRequests, previewSharedRequests } from './shared-requests.mjs'
import { describeMigration, executeMigration, assertNoInterruptedMigrations, commitConvertedMigrations } from './migration-transaction.mjs'
import { acquireCliLock, releaseCliLock } from '../lib/cli-lock.mjs'
import fs from 'node:fs/promises'
import { snapshot, backupBytes, assertStopped } from './scoped-data.mjs'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { join, basename } from 'node:path'

function readTrim(path) {
  if (!existsSync(path)) return null
  return readFileSync(path, 'utf-8').trim() || null
}

// 与 crabot-core/src/schema-check.ts 的 isDataDirEmpty 语义一致：目录不存在或
// 只剩点文件 / SCHEMA_VERSION 时算空 → 全新安装，没有数据可迁移。
function isDataDirEmpty(dataDir) {
  if (!existsSync(dataDir)) return true
  return readdirSync(dataDir).every((n) => n.startsWith('.') || n === 'SCHEMA_VERSION')
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
    // dataVersion 为 null 且数据目录空（含不存在）→ 全新安装，不是遗留 v0 数据。
    // MM 启动时 checkSchema 会判 allow_first_install 直接写当前版本，无需迁移/备份。
    // 这一步只该处理「有真实数据但版本落后」的模块。
    if (dataVersion === null && isDataDirEmpty(moduleDataDir)) continue
    out.push({
      moduleId: name,
      codeVersion,
      dataVersion,
      dataDir: moduleDataDir,
    })
  }
  return out
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

/**
 * 低层：跑迁移脚本链（v<from> → v<to>）。
 *
 * 注意：**只跑脚本，不写 SCHEMA_VERSION**。caller 若直接用本函数，必须在成功后
 * 自己调 writeSchemaVersion 收尾，否则 module 下次启动仍判 pending（死循环）。
 * 推荐用 applyMigration 包装版（chainUpgrade + writeSchemaVersion 原子），
 * 避免漏调。本函数保留为低层 API 给特殊场景（如 dry-run）。
 */
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

/** Every write entry, including start fallback, uses the same scoped transaction. */
export async function applyMigration(moduleDir, dataDir, fromVersion, toVersion, runScriptFn, options = {}) {
  if (fromVersion === toVersion) return { ok: true }
  const description = await describeMigration(moduleDir, dataDir, fromVersion, toVersion)
  return executeMigration(description, runScriptFn, options)
}

export async function previewMigrations(crabotHome, dataDir) {
  await assertNoInterruptedMigrations(dataDir)
  const modules = []
  for (const target of scanModules(crabotHome, dataDir)) {
    const description = await describeMigration(join(crabotHome, target.moduleId), target.dataDir, target.dataVersion, target.codeVersion)
    const entries = await snapshot(dataDir, description.scope.writes)
    modules.push({ ...target, scope: description.scope, backup_bytes: backupBytes(entries) })
  }
  const shared = await previewSharedRequests(crabotHome, dataDir)
  return { modules, shared, backup_bytes: shared.backup_bytes === null ? null : modules.reduce((sum, entry) => sum + entry.backup_bytes, shared.backup_bytes) }
}

export async function runMigrations(crabotHome, dataDir, runScriptFn, logger = console, options = {}) {
  let lock
  if (!options.lockHeld) { await fs.mkdir(dataDir, { recursive: true }); lock = await acquireCliLock(dataDir, 'data-migration') }
  try {
    await assertNoInterruptedMigrations(dataDir)
    const targets = scanModules(crabotHome, dataDir)
    // Fail unknown adapters/scripts before writing any module or stopping any service.
    let descriptions = await Promise.all(targets.map(t => describeMigration(join(crabotHome, t.moduleId), t.dataDir, t.dataVersion, t.codeVersion)))
    if (descriptions.length) await assertStopped(dataDir)
    if (await commitConvertedMigrations(crabotHome, dataDir, runScriptFn)) {
      descriptions = await Promise.all(scanModules(crabotHome, dataDir).map(t => describeMigration(join(crabotHome, t.moduleId), t.dataDir, t.dataVersion, t.codeVersion)))
    }
    const migrated = []
    for (const description of descriptions) {
      logger.info(`[${description.module_id}] ${description.from ?? 'v0'} → ${description.to}`)
      const result = await executeMigration(description, runScriptFn, { lockHeld: true })
      if (!result.ok) return { ...result, failedModule: description.module_id }
      logger.info(`[${description.module_id}] verified scoped backup: ${result.backup_bytes ?? 0} bytes`)
      migrated.push(description.module_id)
    }
    await prepareSharedRequests(crabotHome, dataDir, logger, { lockHeld: true })
    return { ok: true, migrated, skipped: [] }
  } finally { releaseCliLock(lock) }
}
