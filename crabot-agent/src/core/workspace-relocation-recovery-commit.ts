import fs from 'node:fs'
import path from 'node:path'
import { sha256CanonicalJson } from 'crabot-shared'
import type { captureWorkspaceRelocationRecovery } from './workspace-relocation-recovery-capture.js'
import { createWorkspaceMaintenanceFileAccess, version, sameIdentity } from './workspace-maintenance-files.js'

type RecoverySnapshot = Awaited<ReturnType<typeof captureWorkspaceRelocationRecovery>>
const failure = () => Object.assign(new Error('原恢复责任范围发生变化，已保留封存材料和维护保护。'), { code: 'CRABOT_WORKSPACE_RECOVERY_COMMIT' })
const equal = (left: unknown, right: unknown) => sha256CanonicalJson(left) === sha256CanonicalJson(right)

/** Allows only this plan's checkpoint removal/history addition. Missing source is never an archival receipt. */
export function assertWorkspaceRecoveryProgress(original: RecoverySnapshot, current: RecoverySnapshot): void {
  if (original.data_root !== current.data_root || !equal(original.missing_directories, current.missing_directories)
    || !equal(original.records, current.records) || original.directories.length !== current.directories.length
    || original.names.length !== current.names.length) throw failure()
  const directories = new Map(original.directories.map(item => [item.relative, item]))
  for (const directory of current.directories) {
    const before = directories.get(directory.relative)
    if (!before || !sameIdentity(before.version, directory.version, true) || before.native_id !== directory.native_id) throw failure()
  }
  const files = new Map(original.files.map(item => [item.relative, item]))
  const checkpointFiles = new Set(original.files.filter(item => item.kind === 'manager_checkpoint' || item.kind === 'request_checkpoint').map(item => item.relative))
  const checkpointParents = new Set([...checkpointFiles].map(file => path.dirname(file)))
  for (const file of current.files) if (!equal(files.get(file.relative), file)) throw failure()
  const present = new Set(current.files.map(item => item.relative))
  for (const file of files.keys()) if (!present.has(file) && !checkpointFiles.has(file)) throw failure()
  const checkpoints = new Set(original.checkpoints.map(item => sha256CanonicalJson(item)))
  if (current.checkpoints.some(item => !checkpoints.has(sha256CanonicalJson(item)))) throw failure()
  const views = new Map(original.names.map(item => [item.relative, item.names]))
  for (const view of current.names) {
    const before = views.get(view.relative)
    if (!before) throw failure()
    const expected = new Set(before), actual = new Set(view.names)
    if (checkpointParents.has(view.relative)) {
      if (!present.has(path.join(view.relative, 'running.json'))) expected.delete('running.json')
      if (!expected.has('workspace-relocation-history')) actual.delete('workspace-relocation-history')
    }
    if (!equal([...expected].sort(), [...actual].sort())) throw failure()
  }
}

const native = require('../../../scripts/lib/process-identity.cjs')
const { owned } = createWorkspaceMaintenanceFileAccess(failure)

/** Recheck the fixed physical scope between awaits without repeatedly decoding private bodies. */
export function verifyWorkspaceRecoveryProgress(original: RecoverySnapshot): void {
  const root = original.data_root
  const directories = original.directories.map(frame => {
    const file = path.join(root, frame.relative), stat = owned(file, true)
    if (fs.realpathSync(file) !== file) throw failure()
    return { ...frame, version: version(stat), native_id: process.platform === 'win32' ? native.inspectDirectoryFileId(file) : null }
  })
  for (const relative of original.missing_directories) {
    try { fs.lstatSync(path.join(root, relative)); throw failure() }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }
  const files = original.files.filter(file => {
    try {
      if (version(owned(path.join(root, file.relative))) !== file.version) throw failure()
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || !['manager_checkpoint', 'request_checkpoint'].includes(file.kind)) throw error
      return false
    }
  })
  const present = new Set(files.filter(item => item.kind === 'manager_checkpoint' || item.kind === 'request_checkpoint').map(item => item.sha256 + ':' + item.version))
  assertWorkspaceRecoveryProgress(original, { ...original, directories, files,
    names: original.names.map(view => ({ relative: view.relative, names: fs.readdirSync(path.join(root, view.relative)).sort() })),
    checkpoints: original.checkpoints.filter(item => present.has(item.before_sha256 + ':' + item.before_version)) })
}
