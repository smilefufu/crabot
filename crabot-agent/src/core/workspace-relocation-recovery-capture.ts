import fs from 'node:fs'
import path from 'node:path'
import { TextDecoder } from 'node:util'
import { ManagerSessionStore } from '../manager/session-store.js'
import { ManagerWorkboardStore } from '../manager/workboard-store.js'
import { decodeVoiceInboxRecord } from '../manager/voice-inbox.js'
import { encodeSegment, decodeSegment, isManagerKey } from '../workers/harness/ledger-store.js'
import type { ManagerKey } from '../manager/types.js'
import { createWorkspaceMaintenanceFileAccess, version, digest } from './workspace-maintenance-files.js'

const native = require('../../../scripts/lib/process-identity.cjs')
const management = require('../../../scripts/lib/desktop-management.cjs')
const hash = /^[a-f0-9]{64}$/
const failure = (stage: string) => Object.assign(new Error('无法核实原自动恢复责任，已保留原记录和迁移维护保护。'), { code: 'CRABOT_WORKSPACE_RECOVERY_CAPTURE', stage })
type Location = { kind: 'manager_checkpoint' | 'requests' | 'admin_wakes' | 'workboard'; manager_key: ManagerKey }
  | { kind: 'request_checkpoint'; manager_key: ManagerKey; request_id: string } | { kind: 'request_owner'; request_id: string } | { kind: 'voice'; name: string }
interface PlannedFile { file: string; location: Location; version: string; size: bigint }
interface Checkpoint {
  readonly manager_key: ManagerKey
  readonly source: { readonly kind: 'manager' } | { readonly kind: 'request'; readonly requestId: string }
  readonly before_version: string
  readonly before_sha256: string
  readonly episode_id: string
}

/** Read-only Agent input projection; it supplies neither original-coordinator authorization nor an execution/closure receipt. */
export async function captureWorkspaceRelocationRecovery(dataDir: string, { signal }: { signal?: AbortSignal } = {}) {
  let stage = 'authority'
  const { owned, readBoundBytes } = createWorkspaceMaintenanceFileAccess(() => failure(stage))
  const frames = new Map<string, { relative: string; version: string; native_id: string | null }>(), views = new Map<string, string[]>(), missing = new Set<string>(), pins: unknown[] = []
  const planned: PlannedFile[] = []
  const requestIndex = new Map<string, { manager_key: ManagerKey; source_sha256: string; status: 'open' | 'closed' }>(), owners = new Map<string, { manager_key: ManagerKey; source_sha256: string }>()
  const records: Array<Record<string, string | number>> = [], checkpoints: Checkpoint[] = [], files: Array<Location & { relative: string; version: string; sha256: string }> = []
  const check = () => { if (signal?.aborted) throw failure('aborted') }
  check()
  try {
    const root = management.requirePrivateDataRoot(dataDir) as string
    const remember = (relative: string, optional = false): boolean => {
      check()
      if (frames.has(relative)) return true
      const file = relative === '.' ? root : path.join(root, relative)
      let stat
      try { stat = owned(file, true) }
      catch (error) { if (optional && (error as NodeJS.ErrnoException).code === 'ENOENT') { missing.add(relative); return false }; throw error }
      if (fs.realpathSync(file) !== file) throw failure('canonical')
      let nativeId: string | null = null
      if (process.platform === 'win32') { const pin = native.pinDirectory(file); pins.push(pin); nativeId = pin.identity }
      frames.set(relative, { relative, version: version(stat), native_id: nativeId })
      return true
    }
    const names = (relative: string) => {
      let entries = views.get(relative)
      if (!entries) { entries = fs.readdirSync(path.join(root, relative)).sort(); views.set(relative, entries) }
      return entries
    }
    const select = (relative: string, location: Location) => {
      const file = path.join(root, relative)
      let stat
      try { stat = owned(file) }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
      planned.push({ file, location, version: version(stat), size: stat.size })
    }
    const verifyDirectory = (relative: string) => {
      check()
      const frame = frames.get(relative)!, file = relative === '.' ? root : path.join(root, relative)
      if (version(owned(file, true)) !== frame.version || fs.realpathSync(file) !== file
        || process.platform === 'win32' && native.inspectDirectoryFileId(file) !== frame.native_id) throw failure('directory-changed')
    }
    const verifyAncestors = (file: string) => {
      for (let parent = path.dirname(file);; parent = path.dirname(parent)) {
        const relative = parent === root ? '.' : path.relative(root, parent)
        if (!frames.has(relative)) throw failure('ancestor')
        verifyDirectory(relative)
        if (parent === root) return
      }
    }
    stage = 'enumerate'
    remember('.'); remember('agent')
    const managers = path.join('agent', 'managers')
    if (remember(managers, true)) for (const name of names(managers)) {
      check()
      const relative = path.join(managers, name), stat = fs.lstatSync(path.join(root, relative), { bigint: true })
      if (stat.isSymbolicLink()) throw failure('manager-link')
      if (!stat.isDirectory()) continue
      const key = decodeSegment(name)
      if (!isManagerKey(key) || key.includes('\0') || encodeSegment(key) !== name) throw failure('manager-name')
      remember(relative); names(relative)
      for (const [name, kind] of [['running.json', 'manager_checkpoint'], ['requests.json', 'requests'], ['pending-admin-chat-wakes.jsonl', 'admin_wakes'], ['workboard.json', 'workboard']] as const) {
        select(path.join(relative, name), { kind, manager_key: key })
      }
    }
    const voice = path.join('agent', 'voice-inbox')
    if (remember(voice, true)) for (const name of names(voice)) if (/^[a-f0-9]{64}\.json$/.test(name)) select(path.join(voice, name), { kind: 'voice', name })
    const gatherOpenRequests = () => {
      if (![...requestIndex.values()].some(record => record.status === 'open')) return
      stage = 'enumerate'
      const requests = path.join('agent', 'conversation-requests')
      if (!remember(requests, true)) return
      names(requests)
      for (const [requestId, original] of requestIndex) {
        if (original.status !== 'open') continue
        const directory = path.join(requests, requestId), session = path.join(directory, 'session')
        if (!remember(directory, true)) continue
        names(directory)
        select(path.join(directory, 'owner.json'), { kind: 'request_owner', request_id: requestId })
        if (!remember(session, true)) continue
        names(session)
        const manager = path.join(session, encodeSegment(original.manager_key))
        if (!remember(manager, true)) continue
        names(manager)
        select(path.join(manager, 'running.json'), { kind: 'request_checkpoint', manager_key: original.manager_key, request_id: requestId })
      }
      stage = 'budget'
      if (planned.reduce((sum, file) => sum + file.size, 0n) > 64n * 1024n * 1024n) throw failure(stage)
    }
    stage = 'budget'
    if (planned.reduce((sum, file) => sum + file.size, 0n) > 64n * 1024n * 1024n) throw failure(stage)
    const readFiles = (batch: ReadonlyArray<PlannedFile>) => {
      stage = 'read'
      for (const item of batch) {
        check(); verifyAncestors(item.file)
        const body = readBoundBytes(item.file, item.version), text = new TextDecoder('utf-8', { fatal: true }).decode(body), sha = digest(body), location = item.location
        files.push({ ...location, relative: path.relative(root, item.file), version: item.version, sha256: sha })
        stage = 'decode'
        if (location.kind === 'manager_checkpoint' || location.kind === 'request_checkpoint') {
          const checkpoint = ManagerSessionStore.parseWorkspaceRelocationCheckpoint(location.manager_key, text)
          if (!checkpoint.episodeId) throw failure(stage)
          checkpoints.push({ manager_key: location.manager_key, source: Object.freeze(location.kind === 'request_checkpoint'
            ? { kind: 'request' as const, requestId: location.request_id } : { kind: 'manager' as const }),
            before_version: item.version, before_sha256: sha, episode_id: checkpoint.episodeId })
        } else if (location.kind === 'voice') {
          const record = decodeVoiceInboxRecord(location.name, text)
          if (record.phase === 'accepted' || !record.confirmed) records.push({ kind: 'voice', channel_id: record.channel_id, turn_id: record.turn_id, payload_sha256: record.payload_sha256 })
        } else if (location.kind === 'workboard') {
          const board = ManagerWorkboardStore.parseWorkspaceRelocationBoard(location.manager_key, text)
          if (board.pending_admin_notice) records.push({ kind: 'workboard', manager_key: location.manager_key, revision: board.pending_admin_notice.revision })
        } else if (location.kind === 'requests') {
          const state = JSON.parse(text)
          if (!state || state.version !== 1 || !Array.isArray(state.requests)) throw failure(stage)
          const seen = new Set<string>()
          for (const record of state.requests) {
            if (!record || record.schema_version !== 1 || record.manager_key !== location.manager_key || typeof record.request_id !== 'string' || !hash.test(record.request_id)
              || typeof record.source_sha256 !== 'string' || !hash.test(record.source_sha256) || !['open', 'closed'].includes(record.status) || seen.has(record.request_id)) throw failure(stage)
            seen.add(record.request_id)
            if (requestIndex.has(record.request_id)) throw failure(stage)
            requestIndex.set(record.request_id, { manager_key: location.manager_key, source_sha256: record.source_sha256, status: record.status })
            if (record.status === 'open') records.push({ kind: 'request', manager_key: location.manager_key, request_id: record.request_id, source_sha256: record.source_sha256 })
          }
        } else if (location.kind === 'request_owner') {
          const owner = JSON.parse(text)
          if (!owner || owner.schema_version !== 1 || owner.request_id !== location.request_id || typeof owner.manager_key !== 'string'
            || !isManagerKey(owner.manager_key) || owner.manager_key.includes('\0') || typeof owner.source_sha256 !== 'string' || !hash.test(owner.source_sha256)) throw failure('request-owner')
          owners.set(location.request_id, { manager_key: owner.manager_key, source_sha256: owner.source_sha256 })
        } else {
          const seen = new Map<string, string>()
          for (const line of text.split('\n').filter(Boolean)) {
            const record = JSON.parse(line)
            if (!record || record.kind !== 'admin_chat_wake' || record.manager_key !== location.manager_key || typeof record.request_id !== 'string' || !record.request_id.trim()
              || record.request_id.includes('\0') || typeof record.message_sha256 !== 'string' || !hash.test(record.message_sha256) || !['pending', 'settled'].includes(record.status)) throw failure(stage)
            if (record.status !== 'pending') continue
            const previous = seen.get(record.request_id)
            if (previous !== undefined && previous !== record.message_sha256) throw failure(stage)
            if (previous === undefined) records.push({ kind: 'admin_chat', manager_key: location.manager_key, request_id: record.request_id, message_sha256: record.message_sha256 })
            seen.set(record.request_id, record.message_sha256)
          }
        }
        stage = 'read'; verifyAncestors(item.file)
      }
    }
    const mainCount = planned.length
    readFiles(planned)
    gatherOpenRequests()
    readFiles(planned.slice(mainCount))
    for (const [id, owner] of owners) {
      const original = requestIndex.get(id)
      if (!original || original.manager_key !== owner.manager_key || original.source_sha256 !== owner.source_sha256) throw failure('request-owner')
    }
    for (const checkpoint of checkpoints) if (checkpoint.source.kind === 'request') {
      const original = requestIndex.get(checkpoint.source.requestId), owner = owners.get(checkpoint.source.requestId)
      if (!original || !owner || owner.manager_key !== checkpoint.manager_key || owner.manager_key !== original.manager_key
        || owner.source_sha256 !== original.source_sha256) throw failure('request-owner')
    }
    stage = 'verify'
    for (const relative of frames.keys()) verifyDirectory(relative)
    for (const [relative, before] of views) if (JSON.stringify(fs.readdirSync(path.join(root, relative)).sort()) !== JSON.stringify(before)) throw failure('names-changed')
    for (const relative of missing) { try { fs.lstatSync(path.join(root, relative)); throw failure('namespace-appeared') } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error } }
    for (const item of planned) if (version(owned(item.file)) !== item.version) throw failure('file-changed')
    check()
    return Object.freeze({ data_root: root, directories: Object.freeze([...frames.values()].map(item => Object.freeze(item))),
      names: Object.freeze([...views].map(([relative, names]) => Object.freeze({ relative, names: Object.freeze([...names]) }))),
      missing_directories: Object.freeze([...missing].sort()), files: Object.freeze(files.map(item => Object.freeze(item))),
      records: Object.freeze(records.map(item => Object.freeze(item))), checkpoints: Object.freeze(checkpoints.map(item => Object.freeze(item))) })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'CRABOT_WORKSPACE_RECOVERY_CAPTURE') throw error
    throw failure(stage)
  } finally { for (const pin of pins.reverse()) native.releaseDirectoryPin(pin) }
}
