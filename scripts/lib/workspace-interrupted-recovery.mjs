// Read-only active-job facts. No original or recovery process authority is reconstructed.
import fs from 'node:fs'
import path from 'node:path'
import native from './process-identity.cjs'
import { readWorkspaceInterruptedRelocationCheckpoint } from './workspace-relocation-intent.mjs'
import { inspectPublishedWorkspaceRoot } from './workspace-root-publish.mjs'
import { inspectWorkspaceRelocationContent } from '../../crabot-shared/dist/workspace-relocation-content.js'
import { sha256CanonicalJson as hash } from '../../crabot-shared/dist/canonical-json.js'

const fail = stage => { throw Object.assign(new Error('迁移中断后的目录位置或原作业事实无法核实，原文件与维护保护已保留。'), { code: 'WORKSPACE_RELOCATION_INVALID', stage }) }
function directory(file) {
  try {
    const stat = fs.lstatSync(file, { bigint: true })
    if (!stat.isDirectory() || stat.isSymbolicLink() || !stat.ino || fs.realpathSync(file) !== file) fail('directory-identity')
    return { path: file, dev: String(stat.dev), ino: String(stat.ino), native_id: process.platform === 'win32' ? native.inspectDirectoryFileId(file) : null }
  } catch (error) { if (error.code === 'ENOENT') return null; throw error }
}
const matches = (expected, actual, at = expected?.path, nativeId) => Boolean(expected && actual && actual.path === at
  && actual.dev === expected.dev && actual.ino === expected.ino && (nativeId === undefined || actual.native_id === nativeId))

function positions(state) {
  const { intent, file_plan: plan, file_actors: actors, root_plan: root } = state
  const source = directory(intent.source.path), target = directory(intent.target)
  const container = plan ? directory(plan.staging_path) : null, tree = plan ? directory(path.join(plan.staging_path, 'tree')) : null
  if (source && !matches(intent.source, source, intent.source.path, plan?.source_observation.source_identity.native_id)) fail('source-replaced')
  if (container && (!actors?.staging || !matches(actors.staging.container, container, plan.staging_path, actors.staging.container_native_id))) fail('staging-unsettled')
  if (actors?.staging && !container) fail('staging-missing')
  if (tree && (!actors?.file_attempt && plan.mode === 'rename' || !matches(plan.mode === 'copy' ? actors?.staging?.tree : intent.source,
    tree, path.join(plan.staging_path, 'tree'), plan.mode === 'copy' ? actors?.staging?.tree_native_id : plan.source_observation.source_identity.native_id))) fail('tree-replaced')
  let published = false
  if (root && target && matches(root.publication.tree, target, intent.target, root.publication.tree.native_id)) {
    inspectPublishedWorkspaceRoot({ plan: root.publication }); published = true
  } else if (target && (!intent.target_identity || !matches(intent.target_identity, target) || fs.readdirSync(target.path).length)) fail('target-conflict')
  if (state.published && !published || published && tree) fail('publication-conflict')
  if (plan?.mode === 'rename' ? Number(Boolean(source)) + Number(Boolean(tree)) + Number(published) !== 1 : !source) fail('source-position')
  if (plan?.mode === 'copy' && actors?.file_ready && !tree && !published) fail('copy-missing')
  return { source, container, tree, target, published }
}

/** Checkpoint and physical position/content facts only; never a stop, move, cleanup or release permit. */
export async function inspectWorkspaceInterruptedRelocation({ dataDir, id, signal }) {
  const checkpoint = readWorkspaceInterruptedRelocationCheckpoint(dataDir, id), before = positions(checkpoint)
  const mode = checkpoint.file_plan?.mode ?? 'rename'
  const original = before.source ?? (before.published ? before.target : before.tree)
  if (!original) fail('original-directory-missing')
  const content = await inspectWorkspaceRelocationContent(original.path, mode, { signal })
  // The moved original must still contain the bytes captured before its move.
  // An incomplete cross-volume copy never becomes a replacement for the source.
  if (!before.source && content.fingerprint !== checkpoint.file_plan.source_content_sha256) fail('moved-content-changed')
  if (signal?.aborted || readWorkspaceInterruptedRelocationCheckpoint(dataDir, id).checkpoint_sha256 !== checkpoint.checkpoint_sha256
    || hash(positions(checkpoint)) !== hash(before)) fail('observation-changed')
  return { checkpoint, positions: before, content }
}
