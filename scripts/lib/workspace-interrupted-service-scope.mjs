// Read-only projection of each recovery action's own fixed terminal facts.
import fs from 'node:fs'
import path from 'node:path'
import native from './process-identity.cjs'
import { readWorkspaceInterruptedRecoveryRole, assertWorkspaceInterruptedForwardProgress } from './workspace-interrupted-role.mjs'
import { readWorkspaceSourceCompletionScope } from './workspace-interrupted-source-records.mjs'
import { readWorkspaceInterruptedForwardPreparation } from './workspace-interrupted-forward-records.mjs'
import { readWorkspaceInterruptedOriginalModules } from './workspace-interrupted-execution.mjs'
import { createWorkspaceMaintenanceFileAccess } from '../../crabot-agent/dist/core/workspace-maintenance-files.js'
import { sha256CanonicalJson as hash } from '../../crabot-shared/dist/canonical-json.js'
const failure = () => Object.assign(new Error('当前恢复角色的固定工作区事实无法核实，维护保护已保留。'), { code: 'WORKSPACE_RELOCATION_INVALID' })
const { readJson } = createWorkspaceMaintenanceFileAccess(failure)
export function readWorkspaceInterruptedServiceScope(dataDir, recoveryId) {
  const role = readWorkspaceInterruptedRecoveryRole(dataDir, recoveryId)
  if (!role.launch || !role.ready) throw failure()
  const { intent_id: id, checkpoint_sha256: checkpointHash } = role.launch.request, action = role.launch.action
  if (action === 'restore_source') {
    const facts = readWorkspaceSourceCompletionScope(dataDir, id)
    if (facts.checkpoint.checkpoint_sha256 !== checkpointHash) throw failure()
    return { role, action, facts, checkpoint: facts.checkpoint, modules: readWorkspaceInterruptedOriginalModules(dataDir, facts.checkpoint), marker: facts.marker, root: facts.complete.source,
      catalog_sha256: facts.scope.catalog_sha256, catalog_revision: facts.scope.catalog_revision, released: facts.released, release: facts.release }
  }
  const facts = readWorkspaceInterruptedForwardPreparation(dataDir, id), baseline = readJson(path.join(role.launch.control_root.path, 'forward-checkpoint.json'), 32 * 1024 * 1024)
  if (action !== 'finish_commit' || !facts || !baseline || baseline.checkpoint_sha256 !== checkpointHash) throw failure()
  assertWorkspaceInterruptedForwardProgress(baseline, facts.checkpoint)
  return { role, action, facts, checkpoint: facts.checkpoint, modules: facts.checkpoint.modules.modules, marker: facts.marker, root: facts.root,
    catalog_sha256: facts.scope.catalog_sha256, catalog_revision: facts.scope.catalog_revision, released: facts.released, release: facts.release }
}
/** The current capability owner checks the actual directory generation before each probe/use. */
export function assertWorkspaceInterruptedRootCurrent(scope) {
  const expected = scope.root, stat = fs.lstatSync(expected.path, { bigint: true })
  if (!stat.isDirectory() || stat.isSymbolicLink() || String(stat.dev) !== expected.dev || String(stat.ino) !== expected.ino
    || fs.realpathSync(expected.path) !== expected.path || process.platform === 'win32' && native.inspectDirectoryFileId(expected.path) !== expected.native_id) throw failure()
}
