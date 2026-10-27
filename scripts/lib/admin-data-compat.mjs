// A target without an Admin schema declaration cannot consume upgraded permission records.
import fs from 'node:fs'
import path from 'node:path'
const invalid = () => Object.assign(new Error('Admin 数据版本无法核验，原数据保留。'), { code: 'CRABOT_SCHEMA_VERSION_INVALID' })
function version(file) {
  let stat
  try { stat = fs.lstatSync(file) } catch (error) { if (error.code === 'ENOENT') return null; throw invalid() }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 64) throw invalid()
  const text = fs.readFileSync(file, 'utf8').trim()
  if (!/^v\d+$/.test(text) || !Number.isSafeInteger(Number(text.slice(1)))) throw invalid()
  return Number(text.slice(1))
}
export function assertAdminDataCompatibility(root, dataDir) {
  const current = version(path.join(dataDir, 'admin', 'SCHEMA_VERSION'))
  if (current === null || current === 0) return
  const target = version(path.join(root, 'crabot-admin', 'schema_version'))
  if (target === null || target < current) throw Object.assign(new Error('目标 Core 不支持当前 Admin 权限数据版本；请保留原数据并选择兼容版本。'), { code: 'CRABOT_DATA_NEWER_THAN_CODE' })
}
