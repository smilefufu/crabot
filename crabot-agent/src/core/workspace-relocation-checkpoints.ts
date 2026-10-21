import fs from 'node:fs'
import path from 'node:path'
import { TextDecoder } from 'node:util'
import { sha256CanonicalJson } from 'crabot-shared'
import { ManagerSessionStore } from '../manager/session-store.js'
import { encodeSegment, isManagerKey } from '../workers/harness/ledger-store.js'
import type { ManagerKey } from '../manager/types.js'
import { createWorkspaceMaintenanceFileAccess, version, sameIdentity, digest } from './workspace-maintenance-files.js'

const native = require('../../../scripts/lib/process-identity.cjs')
const management = require('../../../scripts/lib/desktop-management.cjs')
const failure = () => new Error('原检查点封存无法核实，已保留历史、提交材料和维护保护。')
const { owned, syncDirectory, readBoundBytes, readJson, publish } = createWorkspaceMaintenanceFileAccess(failure)
const validVersion = (value: unknown): value is string => typeof value === 'string' && /^-?[0-9]+(?::-?[0-9]+){8}$/.test(value)
const fields = (value: any, keys: string[]) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.prototype.hasOwnProperty.call(value, key))
const optionalStat = (file: string, directory = false, privatePath = false) => {
  try { return owned(file, directory, privatePath) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
}
interface CheckpointArchiveOptions {
  dataDir: string
  id: string
  managerKey: ManagerKey
  source: { kind: 'manager' } | { kind: 'request'; requestId: string }
  beforeVersion: string
  beforeSha256: string
  verify: () => Promise<unknown>
  retainVerification?: (verify: () => void) => void
}

/** Agent-owned file primitive, not authorization. The fixed offline caller verifies the original whole job before each effect. */
export async function archiveWorkspaceRelocationCheckpoint(options: CheckpointArchiveOptions) {
  const { id, managerKey, beforeVersion, beforeSha256, verify } = options
  if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(id) || !isManagerKey(managerKey) || managerKey.includes('\0')
    || !validVersion(beforeVersion) || !/^[a-f0-9]{64}$/.test(beforeSha256)
    || !['manager', 'request'].includes(options.source.kind)
    || options.source.kind === 'request' && !/^[a-f0-9]{64}$/.test(options.source.requestId)) throw failure()
  await verify()
  const root = management.requirePrivateDataRoot(options.dataDir) as string, agent = path.join(root, 'agent')
  const paths = options.source.kind === 'manager' ? [root, agent, path.join(agent, 'managers')]
    : [root, agent, path.join(agent, 'conversation-requests'), path.join(agent, 'conversation-requests', options.source.requestId),
      path.join(agent, 'conversation-requests', options.source.requestId, 'session')]
  const manager = path.join(paths[paths.length - 1], encodeSegment(managerKey)); paths.push(manager)
  const source = path.join(manager, 'running.json'), history = path.join(manager, 'workspace-relocation-history'), archive = path.join(history, id)
  const checkpointFile = path.join(archive, 'checkpoint.json'), manifestFile = path.join(archive, 'manifest.json'), completeFile = path.join(archive, 'complete.json')
  const frames: Array<{ path: string; version: string; native_id: string | null; privatePath: boolean }> = [], pins: unknown[] = []
  const remember = (directory: string, privatePath = false) => {
    const stat = owned(directory, true, privatePath)
    if (fs.realpathSync(directory) !== directory) throw failure()
    let nativeId: string | null = null
    if (process.platform === 'win32') { const pin = native.pinDirectory(directory); pins.push(pin); nativeId = pin.identity }
    frames.push({ path: directory, version: version(stat), native_id: nativeId, privatePath })
  }
  const checkPaths = () => {
    for (const frame of frames) {
      if (!sameIdentity(version(owned(frame.path, true, frame.privatePath)), frame.version, true) || fs.realpathSync(frame.path) !== frame.path
        || process.platform === 'win32' && native.inspectDirectoryFileId(frame.path) !== frame.native_id) throw failure()
    }
  }
  const createDirectory = (directory: string) => {
    if (process.platform === 'win32') native.createPrivateDirectory(directory)
    else fs.mkdirSync(directory, { mode: 0o700 })
    syncDirectory(path.dirname(directory)); remember(directory, true)
  }
  const decode = (body: Buffer) => ManagerSessionStore.parseWorkspaceRelocationCheckpoint(managerKey, new TextDecoder('utf-8', { fatal: true }).decode(body))
  try {
    for (const directory of paths) remember(directory)
    const active = optionalStat(source), original = active ? readBoundBytes(source, beforeVersion) : undefined
    const parsed = original ? decode(original) : undefined
    if (original && (digest(original) !== beforeSha256 || !parsed?.episodeId)) throw failure()
    const historyExists = optionalStat(history, true, true)
    if (historyExists) remember(history, true)
    const archiveExists = historyExists && optionalStat(archive, true, true)
    if (archiveExists) remember(archive, true)
    let changed = false
    if (!archiveExists) {
      if (!original || !parsed) throw failure()
      await verify(); checkPaths()
      if (version(owned(source)) !== beforeVersion) throw failure()
      if (!historyExists) createDirectory(history)
      createDirectory(archive)
      if (process.platform === 'win32') native.writePrivateFile(checkpointFile, '')
      else fs.writeFileSync(checkpointFile, '', { flag: 'wx', mode: 0o600 })
      const frame = frames[frames.length - 1]
      publish(archive, 'manifest.json', { schema_version: 1, intent_id: id, manager_key: managerKey, source_kind: options.source.kind,
        request_id: options.source.kind === 'request' ? options.source.requestId : null, source_version: beforeVersion, source_sha256: beforeSha256,
        episode_id: parsed.episodeId, directory_version: frame.version, native_id: frame.native_id, archive_version: version(owned(checkpointFile, false, true)) }, checkPaths)
      changed = true
    }
    const manifest = readJson(manifestFile)
    const checkArchive = (temporary?: string) => {
      checkPaths()
      const names = new Set(['manifest.json', 'checkpoint.json', 'complete.json'])
      if (temporary !== undefined) {
        if (path.dirname(temporary) !== archive) throw failure()
        owned(temporary, false, true); names.add(path.basename(temporary))
      }
      if (!fields(manifest, ['schema_version', 'intent_id', 'manager_key', 'source_kind', 'request_id', 'source_version', 'source_sha256', 'episode_id', 'directory_version', 'native_id', 'archive_version'])
        || manifest.schema_version !== 1 || manifest.intent_id !== id || manifest.manager_key !== managerKey || manifest.source_kind !== options.source.kind
        || manifest.request_id !== (options.source.kind === 'request' ? options.source.requestId : null)
        || manifest.source_version !== beforeVersion || manifest.source_sha256 !== beforeSha256 || typeof manifest.episode_id !== 'string' || !manifest.episode_id
        || parsed && manifest.episode_id !== parsed.episodeId
        || !validVersion(manifest.directory_version) || !validVersion(manifest.archive_version)
        || !sameIdentity(version(owned(archive, true, true)), manifest.directory_version, true)
        || !sameIdentity(version(owned(checkpointFile, false, true)), manifest.archive_version)
        || (process.platform === 'win32' ? native.inspectDirectoryFileId(archive) !== manifest.native_id : manifest.native_id !== null)
        || sha256CanonicalJson(readJson(manifestFile)) !== sha256CanonicalJson(manifest)
        || fs.readdirSync(archive).some(name => !names.has(name))) throw failure()
    }
    checkArchive()
    const manifestHash = sha256CanonicalJson(manifest), previous = readJson(completeFile)
    if (previous !== undefined && (!fields(previous, ['schema_version', 'manifest_sha256', 'archive_version']) || previous.schema_version !== 1
      || previous.manifest_sha256 !== manifestHash || !validVersion(previous.archive_version) || active)) throw failure()
    const beforeArchiveVersion = version(owned(checkpointFile, false, true))
    let archived = readBoundBytes(checkpointFile, beforeArchiveVersion, true)
    if (digest(archived) !== beforeSha256) {
      if (previous !== undefined || !original) throw failure()
      await verify(); checkArchive()
      if (version(owned(source)) !== beforeVersion || version(owned(checkpointFile, false, true)) !== beforeArchiveVersion) throw failure()
      const fd = fs.openSync(checkpointFile, fs.constants.O_RDWR | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0))
      try {
        if (version(fs.fstatSync(fd, { bigint: true })) !== beforeArchiveVersion) throw failure()
        fs.writeFileSync(fd, original); fs.ftruncateSync(fd, original.length); fs.fsyncSync(fd)
        if (version(owned(checkpointFile, false, true)) !== version(fs.fstatSync(fd, { bigint: true }))) throw failure()
      } finally { fs.closeSync(fd) }
      changed = true
      syncDirectory(archive)
      archived = readBoundBytes(checkpointFile, version(owned(checkpointFile, false, true)), true)
    }
    if (digest(archived) !== beforeSha256 || decode(archived).episodeId !== manifest.episode_id) throw failure()
    const archiveVersion = version(owned(checkpointFile, false, true))
    if (previous !== undefined && previous.archive_version !== archiveVersion) throw failure()
    if (active) {
      await verify(); checkArchive()
      if (digest(readBoundBytes(source, beforeVersion)) !== beforeSha256 || version(owned(checkpointFile, false, true)) !== archiveVersion) throw failure()
      fs.unlinkSync(source); syncDirectory(manager); changed = true
    }
    await verify(); checkArchive()
    if (optionalStat(source) || version(owned(checkpointFile, false, true)) !== archiveVersion) throw failure()
    const complete = { schema_version: 1, manifest_sha256: manifestHash, archive_version: archiveVersion }
    if (previous === undefined) { publish(archive, 'complete.json', complete, checkArchive); changed = true }
    else if (sha256CanonicalJson(previous) !== sha256CanonicalJson(complete)) throw failure()
    const verifyComplete = () => {
      checkArchive()
      if (optionalStat(source) || version(owned(checkpointFile, false, true)) !== archiveVersion
        || sha256CanonicalJson(readJson(completeFile)) !== sha256CanonicalJson(complete)) throw failure()
    }
    await verify(); verifyComplete()
    options.retainVerification?.(verifyComplete)
    return { dispatch: changed ? 'dispatch' as const : 'observe' as const, manifest_sha256: manifestHash, complete_sha256: sha256CanonicalJson(complete) }
  } finally { for (const pin of pins.reverse()) native.releaseDirectoryPin(pin) }
}
