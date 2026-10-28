// Retain original forward materials without forging the old coordinator's completion.
import fs from 'node:fs'
import path from 'node:path'
import native from './process-identity.cjs'
import management from './desktop-management.cjs'
import { verifyWorkspaceInterruptedRecoveryRole } from './workspace-interrupted-role.mjs'
import { readWorkspaceInterruptedForwardPreparation, workspaceInterruptedForwardPaths } from './workspace-interrupted-forward-records.mjs'
import { assertWorkspaceInterruptedRootCurrent } from './workspace-interrupted-service-scope.mjs'
import { WorkspaceCatalog } from '../../crabot-shared/dist/workspace-catalog.js'
import { sha256CanonicalJson as hash } from '../../crabot-shared/dist/canonical-json.js'
import { createWorkspaceMaintenanceFileAccess } from '../../crabot-agent/dist/core/workspace-maintenance-files.js'
const failure = () => Object.assign(new Error('向前收尾的原材料尚未完整保留，维护保护仍在。'), { code: 'WORKSPACE_RELOCATION_INVALID' })
const { owned, readJson, publish, syncDirectory } = createWorkspaceMaintenanceFileAccess(failure)
function frame(file) {
  const stat = owned(file, true, true)
  if (fs.realpathSync(file) !== file) throw failure()
  return { path: file, dev: String(stat.dev), ino: String(stat.ino), native_id: process.platform === 'win32' ? native.inspectDirectoryFileId(file) : null }
}
export async function archiveWorkspaceInterruptedForward({ dataDir, recoveryId, launchHash }) {
  const options = { dataDir, recoveryId, launchHash }, role = verifyWorkspaceInterruptedRecoveryRole(options), id = role.launch.request.intent_id
  if (role.launch.action !== 'finish_commit') throw failure()
  const ctx = workspaceInterruptedForwardPaths(dataDir, id), original = readWorkspaceInterruptedForwardPreparation(dataDir, id)
  if (!original || hash(readJson(ctx.fence)) !== hash(original.marker)) throw failure()
  const verify = async () => {
    verifyWorkspaceInterruptedRecoveryRole(options)
    const current = readWorkspaceInterruptedForwardPreparation(dataDir, id)
    if (!current || hash(current.marker) !== hash(original.marker)) throw failure()
  }
  const { inspectInterruptedWorkspaceRelocationClosures } = await import('../../crabot-agent/dist/core/workspace-relocation-closed-evidence.js')
  const closures = await inspectInterruptedWorkspaceRelocationClosures({ dataDir, id, verify })
  await verify(); closures.verify()
  const catalog = await new WorkspaceCatalog({ dataRoot: ctx.data, storageRoot: process.env.WORKER_WORKSPACES_DIR, files: native }).snapshot()
  await verify(); closures.verify()
  if (hash(catalog) !== original.scope.catalog_sha256) throw failure()
  management.ensurePrivateDataRoot(ctx.parent)
  if (!fs.existsSync(ctx.job)) {
    if (process.platform === 'win32') native.createPrivateDirectory(ctx.job)
    else fs.mkdirSync(ctx.job, { mode: 0o700 })
  }
  const job = frame(ctx.job)
  const check = temporary => {
    verifyWorkspaceInterruptedRecoveryRole(options)
    assertWorkspaceInterruptedRootCurrent(original)
    if (hash(frame(ctx.job)) !== hash(job) || fs.readdirSync(ctx.job).some(name => !['forward-committed.json', 'original'].includes(name) && path.join(ctx.job, name) !== temporary)
      || hash(readWorkspaceInterruptedForwardPreparation(dataDir, id).marker) !== hash(original.marker)) throw failure()
  }
  check()
  const previous = readJson(path.join(ctx.job, 'forward-committed.json'))
  if (previous && hash(previous) !== hash(original.marker)) throw failure()
  if (!previous) publish(ctx.job, 'forward-committed.json', original.marker, check)
  if (!original.archived) {
    await verify(); closures.verify(); check()
    native.renameDirectoryNoReplace(ctx.active, ctx.original)
    syncDirectory(ctx.control); syncDirectory(ctx.job); syncDirectory(ctx.parent)
  }
  check()
  if (!readWorkspaceInterruptedForwardPreparation(dataDir, id).archived) throw failure()
  return Object.freeze({ committed: true, service_restored: false })
}
