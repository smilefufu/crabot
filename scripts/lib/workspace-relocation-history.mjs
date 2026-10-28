// Read-only coordinates for an original recorded incarnation. This grants no resource or execution permission.
import fs from 'node:fs'
import path from 'node:path'
import native from './process-identity.cjs'
import management from './desktop-management.cjs'
import { workspaceMaintenancePending } from '../../crabot-shared/dist/workspace-maintenance.js'
import { sha256CanonicalJson as hash } from '../../crabot-shared/dist/canonical-json.js'
import { WorkspaceCatalog } from '../../crabot-shared/dist/workspace-catalog.js'
import { readWorkspaceRelocationIntent, readWorkspaceRelocationWorkers,
  readWorkspaceRelocationRootPublished, readWorkspaceRelocationRootSelected, readWorkspaceRelocationFilePlan,
  readWorkspaceRelocationArchivedState, readWorkspaceRelocationReleased, readCurrentWorkspaceRelocationFinalizing } from './workspace-relocation-intent.mjs'
import { readWorkspaceInterruptedForwardPreparation } from './workspace-interrupted-forward-records.mjs'

const failure = () => Object.assign(new Error('无法核实迁移历史文件位置；原记录与文件已保留。'), { code: 'CRABOT_WORKSPACE_HISTORY_LOCATION' })
const text = value => typeof value === 'string' && value.length > 0 && !value.includes('\0')
function frame(directory) {
  const stat = fs.lstatSync(directory, { bigint: true })
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(directory) !== directory) throw failure()
  return { path: directory, dev: String(stat.dev), ino: String(stat.ino),
    native_id: process.platform === 'win32' ? native.inspectDirectoryFileId(directory) : null }
}

const releasedSuffix = '.released.json'
const uuid = value => /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value)
function privateDirectory(directory) {
  const current = frame(directory), stat = fs.lstatSync(directory)
  if (process.platform === 'win32' ? !native.isPrivateDirectory(directory) : stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o700) throw failure()
  return current
}
function exists(file) {
  try { fs.lstatSync(file); return true } catch (error) { if (error.code !== 'ENOENT') throw error; return false }
}
function historyGraph(dataDir) {
  management.requireExistingDataRoot(dataDir)
  const control = path.join(dataDir, 'workspace-control'), history = path.join(control, 'relocation-history')
  const directories = {}, nodes = [], ids = new Set(), receipts = new Set()
  let names = []
  if (exists(control)) directories.control = privateDirectory(control)
  if (exists(history)) {
    directories.history = privateDirectory(history)
    names = fs.readdirSync(history).sort()
    for (const name of names) {
      if (uuid(name)) ids.add(name)
      else if (name.endsWith(releasedSuffix) && uuid(name.slice(0, -releasedSuffix.length))) receipts.add(name.slice(0, -releasedSuffix.length))
      else throw failure()
    }
    if ([...receipts].some(id => !ids.has(id))) throw failure()
  }
  const finalizing = readCurrentWorkspaceRelocationFinalizing(dataDir)
  for (const id of ids) {
    if (exists(path.join(history, id, 'forward-committed.json'))) {
      const state = readWorkspaceInterruptedForwardPreparation(dataDir, id), checkpoint = state?.checkpoint
      if (!state?.archived || receipts.has(id) || finalizing?.intent_id === id) throw failure()
      nodes.push({ intent: checkpoint.intent, selected: checkpoint.selected, published: checkpoint.published, workers: checkpoint.workers,
        files: checkpoint.file_plan, completion: state.scope, released: state.released, forward: true })
      continue
    }
    const state = readWorkspaceRelocationArchivedState(dataDir, id), released = readWorkspaceRelocationReleased(dataDir, id)
    if ((!released && finalizing?.intent_id !== id) || (finalizing?.intent_id === id && released)) throw failure()
    nodes.push({ intent: state.intent, selected: state.selected, published: state.published, workers: state.workers, files: state.files,
      completion: state.completion, released })
  }
  const active = exists(path.join(control, 'relocation-active'))
  if (active) {
    const intent = readWorkspaceRelocationIntent(dataDir)
    if (!intent || ids.has(intent.id)) throw failure()
    const selected = readWorkspaceRelocationRootSelected(dataDir, intent.id), published = readWorkspaceRelocationRootPublished(dataDir, intent.id)
    if (!selected || !published) throw failure()
    nodes.push({ intent, selected, published, workers: readWorkspaceRelocationWorkers(dataDir, intent.id), files: readWorkspaceRelocationFilePlan(dataDir, intent.id) })
  } else if ((finalizing && !ids.has(finalizing.intent_id)) || (!finalizing && workspaceMaintenancePending(dataDir) && !nodes.some(node => node.forward && !node.released))) throw failure()
  nodes.sort((a, b) => a.intent.catalog_revision - b.intent.catalog_revision)
  for (let i = 1; i < nodes.length; i++) {
    const previous = nodes[i - 1], current = nodes[i], source = current.files?.source_observation.source_identity
    if (!source || current.intent.catalog_revision < previous.selected.catalog_revision
      || current.intent.source.path !== previous.intent.target || source.dev !== previous.published.target.dev || source.ino !== previous.published.target.ino
      || (source.native_id ?? null) !== previous.published.target.native_id) throw failure()
  }
  if (hash(names) !== hash(exists(history) ? fs.readdirSync(history).sort() : [])) throw failure()
  return { directories, names, nodes, finalizing }
}
const within = (root, file) => {
  const relative = path.relative(root, file)
  return relative === '' || relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)
}

/** Caller still verifies its original visible Worker/request, permissions and actual resource path at use time. */
export async function locateWorkspaceRelocationHistory(options) {
  if (!options || Object.keys(options).length !== 4 || !['dataDir', 'managerKey', 'workerId', 'incarnationId'].every(key => Object.hasOwn(options, key) && text(options[key]))
    || !path.isAbsolute(options.dataDir)) throw failure()
  const { dataDir, managerKey, workerId, incarnationId } = options
  try {
    const graph = historyGraph(dataDir), graphHash = hash(graph), storageRoot = process.env.WORKER_WORKSPACES_DIR
    let original, first
    for (const node of graph.nodes) {
      const worker = node.workers.workers.find(item => item.manager_key === managerKey && item.worker_id === workerId)
      const incarnation = worker?.incarnations.find(item => item.incarnation_id === incarnationId)
      if (!incarnation) continue
      if (original !== undefined && original !== incarnation.workspace) throw failure()
      original = incarnation.workspace
      if (!first && path.isAbsolute(original) && path.normalize(original) === original && within(node.intent.source.path, original)) first = node
    }
    if (!first) return null
    const last = graph.nodes.at(-1), target = path.join(last.intent.target, path.relative(first.intent.source.path, original))
    const verify = () => {
      if (process.env.WORKER_WORKSPACES_DIR !== storageRoot || hash(historyGraph(dataDir)) !== graphHash
        || hash(frame(last.intent.target)) !== hash(last.published.target)) throw failure()
    }
    verify()
    const catalog = await new WorkspaceCatalog({ dataRoot: dataDir, storageRoot, files: native }).snapshot()
    verify()
    if (catalog.storage_root !== last.intent.target || catalog.revision < last.selected.catalog_revision
      || frame(target).dev !== last.published.target.dev) throw failure()
    verify()
    return Object.freeze({ intent_id: last.intent.id, manager_key: managerKey, worker_id: workerId, incarnation_id: incarnationId,
      before_root: original, after_root: target })
  } catch { throw failure() }
}
