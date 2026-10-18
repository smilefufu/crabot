import { prepareSharedRequests } from './shared-requests.mjs'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { cp, writeFile } from 'node:fs/promises'
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

/**
 * 高层：跑迁移脚本链 + 成功时写 SCHEMA_VERSION（原子组合，推荐入口）。
 *
 * 不做 backup（caller 决定）。runMigrations 内部用本函数 + 外加 backup；start.mjs
 * 兜底直接用本函数（启动不备份）。两者都通过本函数走 → 不可能漏写 SCHEMA_VERSION。
 *
 * 返回与 chainUpgrade 同 shape：`{ ok: true } | { ok: false, failedAt }`。
 * failed 时 SCHEMA_VERSION 不写（保持 json + 磁盘一致：下次启动重试同一 migration）。
 */
export async function applyMigration(moduleDir, dataDir, fromVersion, toVersion, runScriptFn) {
  const result = await chainUpgrade(moduleDir, dataDir, fromVersion, toVersion, runScriptFn)
  if (!result.ok) return result
  await writeSchemaVersion(dataDir, toVersion)
  return { ok: true }
}

function timestamp() {
  const d = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`
}

export async function runMigrations(crabotHome, dataDir, runScriptFn, logger) {
  const targets = scanModules(crabotHome, dataDir)
  if (targets.length === 0) {
    await prepareSharedRequests(crabotHome, dataDir, logger)
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
    const result = await applyMigration(moduleDir, t.dataDir, t.dataVersion, t.codeVersion, runScriptFn)
    if (!result.ok) {
      logger.error(`[${t.moduleId}] FAILED at ${result.failedAt}`)
      return {
        ok: false,
        failedModule: t.moduleId,
        failedAt: result.failedAt,
        backupPath,
      }
    }
    logger.info(`[${t.moduleId}] done`)
    migrated.push(t.moduleId)
  }
  await prepareSharedRequests(crabotHome, dataDir, logger)
  return { ok: true, migrated, skipped: [] }
}
