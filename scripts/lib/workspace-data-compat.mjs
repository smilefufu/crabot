// Read-only capability check under the caller's existing lifecycle/UID boundary.
import fs from 'node:fs'
import path from 'node:path'
import identity from './process-identity.cjs'
import management from './desktop-management.cjs'

const declaration = 'workspace-data-compat.json'
const invalid = () => Object.assign(new Error('工作区格式版本或必要登记无法核验，原文件保留；请查看诊断及备份。'), { code: 'CRABOT_SCHEMA_VERSION_INVALID' })
function stat(file) {
  try { return fs.lstatSync(file) } catch (error) { if (error.code === 'ENOENT') return null; throw error }
}

/** Static code capability, covered by a complete Core's existing integrity inventory. */
export function readWorkspaceDataVersions(root) {
  try {
    const file = path.join(root, 'crabot-agent', declaration), info = stat(file)
    if (!info?.isFile() || info.isSymbolicLink() || info.size > 8192) return []
    const value = JSON.parse(fs.readFileSync(file, 'utf8')), versions = value?.workspace_data_versions
    if (value?.schema_version !== 1 || Object.keys(value).some(key => !['schema_version', 'workspace_data_versions'].includes(key))
      || !Array.isArray(versions) || !versions.length || versions.length > 64 || new Set(versions).size !== versions.length
      || versions.some(version => !Number.isSafeInteger(version) || version < 1)) return []
    return versions
  } catch { return [] }
}

function readWorkspaceDataVersion(dataDir) {
  try {
    const requested = path.join(dataDir, 'workspace-control'), runtime = stat(path.join(dataDir, 'agent/worker-runtime'))
    if (!stat(requested)) { if (runtime) throw invalid(); return null }
    const control = management.requirePrivateDataRoot(requested), file = path.join(control, 'catalog.json'), info = stat(file)
    if (!info) {
      if (stat(path.join(control, 'catalog.ready')) || runtime) throw invalid()
      return null // A first initializer may have created its empty private control directory.
    }
    const privateFile = process.platform === 'win32' ? identity.isPrivateFile(file)
      : info.uid === process.getuid() && (info.mode & 0o777) === 0o600
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 16 * 1024 * 1024 || !privateFile) throw invalid()
    const value = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (!Number.isSafeInteger(value?.version) || value.version < 1) throw invalid()
    return value.version
  } catch { throw invalid() }
}

export function assertWorkspaceDataCompatibility(root, dataDir) {
  const version = readWorkspaceDataVersion(dataDir)
  if (version === null) return
  if (!readWorkspaceDataVersions(root).includes(version)) throw Object.assign(new Error('目标Core未声明支持当前项目工作区/私有运行数据；原数据保留，请选择兼容版本或核验备份后恢复。'), {
    code: 'CRABOT_DATA_NEWER_THAN_CODE',
  })
}
