// Only the admitted fixed file Host executes this driver. No model, Worker or arbitrary command graph.
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import native from './process-identity.cjs'
import { readWorkspaceRelocationIntent, readWorkspaceRelocationCoordinator, readWorkspaceRelocationFilePlan, readWorkspaceRelocationFileActors } from './workspace-relocation-intent.mjs'
import { sha256CanonicalJson as hash } from '../../crabot-shared/dist/canonical-json.js'

const failure = () => Object.assign(new Error('固定文件操作未能核实，原文件及迁移记录保留。'), { code: 'WORKSPACE_COPY_UNVERIFIED' })
export async function runWorkspaceFilePreparation(context, signal) {
  const { dataDir, id } = context, intent = readWorkspaceRelocationIntent(dataDir), plan = readWorkspaceRelocationFilePlan(dataDir, id)
  const original = readWorkspaceRelocationFileActors(dataDir, id), coordinator = readWorkspaceRelocationCoordinator(dataDir, id)
  const check = () => {
    const current = readWorkspaceRelocationFileActors(dataDir, id), self = native.inspectProcess(process.pid)
    if (signal.aborted || !process.connected || hash(original.attempt) !== context.entered.attempt_sha256
      || hash(original.host) !== context.entered.host_sha256 || hash(original.permission) !== context.entered.permission_sha256 || !original.file_attempt || current.file_ready || hash(current.file_attempt) !== hash(original.file_attempt)
      || hash(current.host) !== hash(original.host) || hash(current.staging) !== hash(original.staging)
      || !native.sameProcess(original.host.process, self) || self.parent !== coordinator.launch.process.pid
      || !native.sameProcess(coordinator.launch.process, native.inspectProcess(self.parent))
      || !native.sameProcess(coordinator.launch.parent, native.inspectProcess(coordinator.launch.parent.pid))) throw failure()
  }
  check()
  if (process.platform === 'win32' && plan.mode === 'copy') throw Object.assign(failure(), { code: 'WORKSPACE_COPY_SYNC_UNSUPPORTED' })
  const { inspectWorkspaceFileSource } = await import('./workspace-copy.mjs')
  const observation = await inspectWorkspaceFileSource(intent.source.path, plan.mode, { signal })
  if (hash(observation) !== hash(plan.source_observation)) throw failure()
  check()
  const target = path.join(plan.staging_path, 'tree'), descriptors = []
  let journal, containerPin
  try {
    if (plan.mode === 'copy') {
      const { createWorkspaceFileToolJournal } = await import('./workspace-file-tool-journal.mjs')
      const { copyWorkspaceTreeFd } = await import('./workspace-posix-copy.mjs')
      const expected = [intent.source, original.staging.tree, original.staging.container]
      for (const item of expected) {
        const fd = fs.openSync(item.path, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW)
        descriptors.push(fd)
        const stat = fs.fstatSync(fd, { bigint: true })
        if (stat.dev.toString() !== item.dev || stat.ino.toString() !== item.ino) throw failure()
      }
      journal = createWorkspaceFileToolJournal({ dataDir, id })
      check(); await copyWorkspaceTreeFd(...descriptors, { journal, signal }); check()
    } else {
      if (process.platform === 'win32') {
        containerPin = native.pinDirectory(plan.staging_path)
        if (containerPin.identity !== original.staging.container_native_id) throw failure()
      }
      const container = fs.lstatSync(plan.staging_path, { bigint: true }), source = fs.lstatSync(intent.source.path, { bigint: true })
      if (container.dev.toString() !== original.staging.container.dev || container.ino.toString() !== original.staging.container.ino
        || createHash('sha256').update(native.inspectFileMetadata(plan.staging_path).metadata).digest('hex') !== original.staging.container_metadata_sha256
        || fs.readdirSync(plan.staging_path).length || source.dev.toString() !== intent.source.dev || source.ino.toString() !== intent.source.ino
        || process.platform === 'win32' && native.inspectDirectoryFileId(intent.source.path) !== plan.source_observation.source_identity.native_id) throw failure()
      if (process.platform !== 'win32') for (const item of [path.dirname(intent.source.path), plan.staging_path]) {
        descriptors.push(fs.openSync(item, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW))
      }
      check(); native.renameDirectoryNoReplace(intent.source.path, target)
      for (const fd of descriptors) fs.fsyncSync(fd)
      check()
    }
  } finally { journal?.close(); for (const fd of descriptors.reverse()) fs.closeSync(fd); if (containerPin) native.releaseDirectoryPin(containerPin) }
}
