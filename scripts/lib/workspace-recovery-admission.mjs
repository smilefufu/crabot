// Read-only fixed archive scope. This supplies no recovery or normal-job command authority.
import { sha256CanonicalJson as hash } from '../../crabot-shared/dist/canonical-json.js'
import { readCurrentWorkspaceRelocationFinalizing, readWorkspaceRelocationArchivedState, readWorkspaceRelocationReleased } from './workspace-relocation-intent.mjs'
import exits from './known-process-exit.cjs'
import fs from 'node:fs'
import native from './process-identity.cjs'
import { WorkspaceCatalog } from '../../crabot-shared/dist/workspace-catalog.js'
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value)
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const unavailable = () => Object.assign(new Error('当前冷恢复范围或原协调退出无法核实，维护保护已保留。'), { code: 'SERVICE_UNAVAILABLE' })
export function parseWorkspaceRecoveryAdmissionRequest(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 4
    || !['intent_id', 'recovery_id', 'completion_sha256', 'finalizing_sha256'].every(key => Object.hasOwn(input, key))
    || !uuid(input.intent_id) || !uuid(input.recovery_id) || !digest(input.completion_sha256) || !digest(input.finalizing_sha256)) {
    throw Object.assign(new Error('Invalid recovery admission parameters'), { code: 'INVALID_PARAMS' })
  }
  return Object.freeze({ ...input })
}
export function readWorkspaceRecoveryAdmissionScope(dataDir, input) {
  const request = parseWorkspaceRecoveryAdmissionRequest(input)
  try {
    const fence = readCurrentWorkspaceRelocationFinalizing(dataDir)
    if (!fence || fence.intent_id !== request.intent_id || hash(fence) !== request.finalizing_sha256
      || readWorkspaceRelocationReleased(dataDir, request.intent_id)) throw unavailable()
    const state = readWorkspaceRelocationArchivedState(dataDir, request.intent_id)
    if (hash(state.completion) !== request.completion_sha256 || exits.probeKnownProcessExit([state.launch.process]).state !== 'stopped') throw unavailable()
    return { request, state, fence, fingerprint: hash({ state, fence }) }
  } catch { throw unavailable() }
}

/** Current read-only facts under a new role. Historical health is never current health. */
export async function inspectWorkspaceRecoveryFacts({ dataDir, request, verify: authorize }) {
  if (typeof authorize !== 'function') throw unavailable()
  await authorize()
  const original = readWorkspaceRecoveryAdmissionScope(dataDir, request), state = original.state
  request = original.request
  const catalog = new WorkspaceCatalog({ dataRoot: dataDir, storageRoot: process.env.WORKER_WORKSPACES_DIR, files: native })
  const check = () => {
    if (readWorkspaceRecoveryAdmissionScope(dataDir, request).fingerprint !== original.fingerprint) throw unavailable()
    const target = state.published.target, stat = fs.lstatSync(target.path, { bigint: true })
    const actual = { path: target.path, dev: String(stat.dev), ino: String(stat.ino), native_id: process.platform === 'win32' ? native.inspectDirectoryFileId(target.path) : null }
    if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(target.path) !== target.path || hash(actual) !== hash(target)) throw unavailable()
  }
  const current = async () => { check(); await authorize(); check() }
  await current()
  const agent = await import('../../crabot-agent/dist/core/workspace-relocation-closed-evidence.js')
  await current()
  const closures = await agent.inspectArchivedWorkspaceRelocationClosures({ dataDir, id: request.intent_id, verify: current })
  if (closures.worker_commit_sha256 !== state.completion.worker_commit_sha256 || closures.recovery_commit_sha256 !== state.completion.recovery_commit_sha256) throw unavailable()
  const observeRoots = () => state.health.modules.map(module => {
    const observed = exits.probeKnownProcessExit([module.process])
    if (observed.state === 'unknown') throw unavailable()
    return { module_id: module.module_id, runtime_id: module.runtime_id, root_state: observed.state }
  })
  const roots = observeRoots(), rootHash = hash(roots)
  let failed = false
  const verify = async () => {
    try {
      if (failed) throw unavailable()
      await current(); closures.verify()
      const snapshot = await catalog.snapshot()
      await current(); closures.verify()
      if (hash(snapshot) !== state.selected.catalog_sha256 || snapshot.storage_root !== state.published.target.path || hash(observeRoots()) !== rootHash) throw unavailable()
    } catch (cause) { failed = true; throw Object.assign(unavailable(), { cause }) }
  }
  await verify()
  return Object.freeze({ completion_sha256: request.completion_sha256, root_selected_sha256: hash(state.selected), catalog_revision: state.selected.catalog_revision,
    worker_commit_sha256: closures.worker_commit_sha256, recovery_commit_sha256: closures.recovery_commit_sha256,
    validation_roots: Object.freeze(roots.map(module => Object.freeze(module))), verify })
}
