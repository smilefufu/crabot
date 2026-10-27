// Static schema facts only; no data initialization, scope scripts or migration.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

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
