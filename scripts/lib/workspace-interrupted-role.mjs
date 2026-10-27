// Current interrupted-job role only. Archived recovery records and old launch identities stay unchanged.
import fs from 'node:fs'
import path from 'node:path'
import native from './process-identity.cjs'
import management from './desktop-management.cjs'
import exits from './known-process-exit.cjs'
import { cliLockToken } from './cli-lock.mjs'
import { readPendingWorkspaceSourceRestoration } from './workspace-interrupted-source-records.mjs'
import { readWorkspaceInterruptedRelocationCheckpoint } from './workspace-relocation-intent.mjs'
import { sha256CanonicalJson as hash } from '../../crabot-shared/dist/canonical-json.js'
import { createWorkspaceMaintenanceFileAccess } from '../../crabot-agent/dist/core/workspace-maintenance-files.js'

const failure = () => Object.assign(new Error('本次迁移中断恢复角色无法核实，原文件与维护保护已保留。'), { code: 'CRABOT_WORKSPACE_RECOVERY_COORDINATOR' })
const { owned, readJson, publish, syncDirectory } = createWorkspaceMaintenanceFileAccess(failure)
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value)
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const processIdentity = value => exact(value, ['pid', 'parent', 'started', 'owner', 'executable']) && Number.isInteger(value.pid) && value.pid > 0
  && Number.isInteger(value.parent) && value.parent >= 0 && ['started', 'owner', 'executable'].every(key => typeof value[key] === 'string' && value[key] && !value[key].includes('\0'))
function frame(directory, privateEntry = true) {
  const stat = owned(directory, true, privateEntry)
  if (fs.realpathSync(directory) !== directory) throw failure()
  return { path: directory, dev: String(stat.dev), ino: String(stat.ino), native_id: process.platform === 'win32' ? native.inspectDirectoryFileId(directory) : null }
}
export function parseWorkspaceInterruptedRecoveryRequest(value) {
  if (!exact(value, ['intent_id', 'recovery_id', 'checkpoint_sha256']) || !uuid(value.intent_id) || !uuid(value.recovery_id) || !digest(value.checkpoint_sha256)) throw failure()
  return Object.freeze({ ...value })
}
function context(dataDir, recoveryId) {
  if (!uuid(recoveryId)) throw failure()
  const data = management.requireExistingDataRoot(dataDir), control = path.join(data, 'workspace-control')
  return { data, control, parent: path.join(control, 'relocation-recovery'), directory: path.join(control, 'relocation-recovery', recoveryId) }
}
function optionalDirectory(directory) {
  try { frame(directory); return true } catch (error) { if (error.code === 'ENOENT') return false; throw error }
}
/** Known old actors only. Business execution settlement is a separate driver check. */
export function assertWorkspaceInterruptedActorsExited(checkpoint) {
  const actors = [checkpoint.coordinator.launch?.process, checkpoint.file_actors?.host?.process,
    ...(checkpoint.file_actors?.tools?.tools ?? []).map(item => item.process)].filter(Boolean)
  if (exits.probeKnownProcessExit(actors).state !== 'stopped') throw failure()
}
/** Historical role metadata only; this never reconstructs current authorization. */
export function readWorkspaceInterruptedRecoveryRole(dataDir, recoveryId) {
  const ctx = context(dataDir, recoveryId), data = frame(ctx.data, false), control = frame(ctx.control)
  if (!optionalDirectory(ctx.parent) || !optionalDirectory(ctx.directory)) return { launch: null, ready: null }
  const parent = frame(ctx.parent), directory = frame(ctx.directory), launch = readJson(path.join(ctx.directory, 'launch.json')), ready = readJson(path.join(ctx.directory, 'ready.json'))
  if (!launch || !exact(launch, ['schema_version', 'request', 'action', 'parent', 'process', 'data_root', 'control_root', 'active_root', 'created_at'])
    || launch.schema_version !== 2 || launch.request?.recovery_id !== recoveryId || !['restore_source', 'finish_commit'].includes(launch.action)
    || !processIdentity(launch.parent) || !processIdentity(launch.process) || launch.process.parent !== launch.parent.pid
    || launch.parent.pid === launch.process.pid || launch.process.owner !== launch.parent.owner
    || hash(launch.data_root) !== hash(data) || hash(launch.control_root) !== hash(directory)
    || typeof launch.created_at !== 'string' || new Date(launch.created_at).toISOString() !== launch.created_at) throw failure()
  parseWorkspaceInterruptedRecoveryRequest(launch.request)
  if (ready && (!exact(ready, ['schema_version', 'recovery_id', 'launch_sha256', 'created_at']) || ready.schema_version !== 2
    || ready.recovery_id !== recoveryId || ready.launch_sha256 !== hash(launch) || typeof ready.created_at !== 'string'
    || new Date(ready.created_at).toISOString() !== ready.created_at)) throw failure()
  if (hash(frame(ctx.data, false)) !== hash(data) || hash(frame(ctx.control)) !== hash(control)
    || hash(frame(ctx.parent)) !== hash(parent) || hash(frame(ctx.directory)) !== hash(directory)) throw failure()
  return { launch, ready: ready ?? null }
}
function originalScope(ctx, request) {
  const active = path.join(ctx.control, 'relocation-active')
  let checkpoint
  if (readJson(path.join(ctx.control, 'relocation-source-finalizing.json'))) {
    checkpoint = readPendingWorkspaceSourceRestoration(ctx.data, request.intent_id).checkpoint
  } else if (optionalDirectory(active)) checkpoint = readWorkspaceInterruptedRelocationCheckpoint(ctx.data, request.intent_id)
  else throw failure()
  if (checkpoint.checkpoint_sha256 !== request.checkpoint_sha256) throw failure()
  assertWorkspaceInterruptedActorsExited(checkpoint)
  return checkpoint
}
export async function commitWorkspaceInterruptedRecoveryLaunch({ dataDir, request: input, coordinator, verify }) {
  if (typeof verify !== 'function' || process.versions.electron) throw failure()
  const request = parseWorkspaceInterruptedRecoveryRequest(input), ctx = context(dataDir, request.recovery_id)
  const self = native.inspectProcess(process.pid), token = cliLockToken(path.join(ctx.data, 'cli.lock')), data = frame(ctx.data, false), control = frame(ctx.control)
  const checkpoint = originalScope(ctx, request), activePath = path.join(ctx.control, 'relocation-active')
  const active = optionalDirectory(activePath) ? frame(activePath) : readPendingWorkspaceSourceRestoration(ctx.data, request.intent_id).original
  const current = () => {
    if (!token || cliLockToken(path.join(ctx.data, 'cli.lock')) !== token || !processIdentity(self) || !processIdentity(coordinator)
      || coordinator.parent !== self.pid || coordinator.owner !== self.owner || coordinator.pid === self.pid
      || !native.sameProcess(self, native.inspectProcess(process.pid)) || !native.sameProcess(coordinator, native.inspectProcess(coordinator.pid))
      || hash(frame(ctx.data, false)) !== hash(data) || hash(frame(ctx.control)) !== hash(control)
      || hash(frame(active.path)) !== hash(active) || originalScope(ctx, request).action !== checkpoint.action) throw failure()
  }
  await verify(); current()
  if (!optionalDirectory(ctx.parent)) management.ensurePrivateDataRoot(ctx.parent)
  const parent = frame(ctx.parent)
  if (optionalDirectory(ctx.directory)) throw failure()
  current()
  if (process.platform === 'win32') native.createPrivateDirectory(ctx.directory)
  else fs.mkdirSync(ctx.directory, { mode: 0o700 })
  const directory = frame(ctx.directory)
  const check = () => { current(); if (hash(frame(ctx.parent)) !== hash(parent) || hash(frame(ctx.directory)) !== hash(directory)) throw failure() }
  const launch = { schema_version: 2, request, action: checkpoint.action, parent: self, process: { ...coordinator }, data_root: data,
    control_root: directory, active_root: active, created_at: new Date().toISOString() }
  await verify(); check(); publish(ctx.directory, 'launch.json', launch, check)
  syncDirectory(ctx.parent); syncDirectory(ctx.control); syncDirectory(ctx.data)
  await verify(); check()
  if (hash(readWorkspaceInterruptedRecoveryRole(ctx.data, request.recovery_id).launch) !== hash(launch)) throw failure()
  return launch
}
/** Current child and actual mutex only; a launch file alone is never a live role. */
export function verifyWorkspaceInterruptedRecoveryRole({ dataDir, recoveryId, launchHash, requireReady = true }) {
  const ctx = context(dataDir, recoveryId), role = readWorkspaceInterruptedRecoveryRole(ctx.data, recoveryId), self = native.inspectProcess(process.pid)
  if (!role.launch || hash(role.launch) !== launchHash || requireReady && !role.ready || !process.connected
    || !cliLockToken(path.join(ctx.data, 'cli.lock')) || !native.sameProcess(role.launch.process, self)
    || !native.sameProcess(role.launch.parent, native.inspectProcess(role.launch.parent.pid))
    || hash(optionalDirectory(role.launch.active_root.path) ? frame(role.launch.active_root.path)
      : { ...readPendingWorkspaceSourceRestoration(ctx.data, role.launch.request.intent_id).original, path: role.launch.active_root.path }) !== hash(role.launch.active_root)) throw failure()
  const checkpoint = originalScope(ctx, role.launch.request)
  if (checkpoint.action !== role.launch.action) throw failure()
  return role
}
export function commitWorkspaceInterruptedRecoveryReady(options) {
  const role = verifyWorkspaceInterruptedRecoveryRole({ ...options, requireReady: false }), ctx = context(options.dataDir, options.recoveryId)
  if (role.ready) throw failure()
  const record = { schema_version: 2, recovery_id: options.recoveryId, launch_sha256: options.launchHash, created_at: new Date().toISOString() }
  publish(ctx.directory, 'ready.json', record, () => { verifyWorkspaceInterruptedRecoveryRole({ ...options, requireReady: false }) })
  return verifyWorkspaceInterruptedRecoveryRole(options).ready
}
