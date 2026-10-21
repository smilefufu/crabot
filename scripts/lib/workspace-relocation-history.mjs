// Read-only coordinates for an original recorded incarnation. This grants no resource or execution permission.
import fs from 'node:fs'
import path from 'node:path'
import native from './process-identity.cjs'
import { sha256CanonicalJson as hash } from '../../crabot-shared/dist/canonical-json.js'
import { WorkspaceCatalog } from '../../crabot-shared/dist/workspace-catalog.js'
import { readWorkspaceRelocationIntent, readWorkspaceRelocationWorkers,
  readWorkspaceRelocationRootPublished, readWorkspaceRelocationRootSelected } from './workspace-relocation-intent.mjs'

const failure = () => Object.assign(new Error('无法核实迁移历史文件位置；原记录与文件已保留。'), { code: 'CRABOT_WORKSPACE_HISTORY_LOCATION' })
const text = value => typeof value === 'string' && value.length > 0 && !value.includes('\0')
function frame(directory) {
  const stat = fs.lstatSync(directory, { bigint: true })
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(directory) !== directory) throw failure()
  return { path: directory, dev: String(stat.dev), ino: String(stat.ino),
    native_id: process.platform === 'win32' ? native.inspectDirectoryFileId(directory) : null }
}

/** Caller still verifies its original visible Worker/request, permissions and actual resource path at use time. */
export async function locateWorkspaceRelocationHistory(options) {
  if (!options || Object.keys(options).length !== 4 || !['dataDir', 'managerKey', 'workerId', 'incarnationId'].every(key => Object.hasOwn(options, key) && text(options[key]))
    || !path.isAbsolute(options.dataDir)) throw failure()
  const { dataDir, managerKey, workerId, incarnationId } = options
  try {
    const intent = readWorkspaceRelocationIntent(dataDir)
    if (!intent) return null
    const selected = readWorkspaceRelocationRootSelected(dataDir, intent.id)
    if (!selected) throw failure()
    const scope = readWorkspaceRelocationWorkers(dataDir, intent.id)
    const worker = scope.workers.find(item => item.manager_key === managerKey && item.worker_id === workerId)
    const incarnation = worker?.incarnations.find(item => item.incarnation_id === incarnationId)
    if (!incarnation) return null
    const original = incarnation.workspace
    if (!path.isAbsolute(original) || path.normalize(original) !== original) return null
    const relative = path.relative(intent.source.path, original)
    if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) return null
    const published = readWorkspaceRelocationRootPublished(dataDir, intent.id)
    if (!published) throw failure()
    const selectedHash = hash(selected), intentHash = hash(intent), storageRoot = process.env.WORKER_WORKSPACES_DIR
    const verify = () => {
      if (process.env.WORKER_WORKSPACES_DIR !== storageRoot || hash(readWorkspaceRelocationIntent(dataDir)) !== intentHash
        || hash(readWorkspaceRelocationRootSelected(dataDir, intent.id)) !== selectedHash
        || hash(frame(intent.target)) !== hash(published.target)) throw failure()
    }
    verify()
    const catalog = await new WorkspaceCatalog({ dataRoot: dataDir, storageRoot, files: native }).snapshot()
    verify()
    if (catalog.storage_root !== intent.target || catalog.revision < selected.catalog_revision) throw failure()
    const target = path.join(intent.target, relative)
    if (frame(target).dev !== published.target.dev) throw failure()
    verify()
    return Object.freeze({ intent_id: intent.id, manager_key: managerKey, worker_id: workerId, incarnation_id: incarnationId,
      before_root: original, after_root: target })
  } catch { throw failure() }
}
