import fs from 'node:fs'
import path from 'node:path'
import { sha256CanonicalJson } from 'crabot-shared'
import { isManagerKey } from '../workers/harness/ledger-store.js'
import { createWorkspaceMaintenanceFileAccess, version, sameIdentity } from './workspace-maintenance-files.js'

const native = require('../../../scripts/lib/process-identity.cjs')
const management = require('../../../scripts/lib/desktop-management.cjs')
const failure = () => new Error('工作目录迁移的旧恢复责任无法核实，已保留原业务记录；自动恢复保持关闭。')
const { owned, syncDirectory, readJson, publish } = createWorkspaceMaintenanceFileAccess(failure)
const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/
const hash = /^[a-f0-9]{64}$/
const limit = 32 * 1024 * 1024
const fields = (value: any, keys: string[]) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.prototype.hasOwnProperty.call(value, key))
const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0 && !value.includes('\0')

type RetiredRecovery =
  | { kind: 'request'; manager_key: string; request_id: string; source_sha256: string }
  | { kind: 'admin_chat'; manager_key: string; request_id: string; message_sha256: string }
  | { kind: 'voice'; channel_id: string; turn_id: string; payload_sha256: string }
  | { kind: 'workboard'; manager_key: string; revision: number }
interface RetirementDocument {
  schema_version: 1
  intent_id: string
  file_ready_sha256: string
  worker_closure_sha256: string
  records: RetiredRecovery[]
}
function recordIdentity(record: RetiredRecovery): string {
  if (record.kind === 'voice') return sha256CanonicalJson([record.kind, record.channel_id, record.turn_id])
  return sha256CanonicalJson([record.kind, record.manager_key, record.kind === 'workboard' ? record.revision : record.request_id])
}
function recordValue(record: RetiredRecovery): string {
  if (record.kind === 'request') return record.source_sha256
  if (record.kind === 'admin_chat') return record.message_sha256
  if (record.kind === 'voice') return record.payload_sha256
  return recordIdentity(record)
}
function validateDocument(value: any): asserts value is RetirementDocument {
  if (!fields(value, ['schema_version', 'intent_id', 'file_ready_sha256', 'worker_closure_sha256', 'records'])
    || value.schema_version !== 1 || typeof value.intent_id !== 'string' || !uuid.test(value.intent_id)
    || typeof value.file_ready_sha256 !== 'string' || !hash.test(value.file_ready_sha256)
    || typeof value.worker_closure_sha256 !== 'string' || !hash.test(value.worker_closure_sha256) || !Array.isArray(value.records)) throw failure()
  const ids = new Set<string>()
  for (const record of value.records) {
    if (!record || typeof record !== 'object') throw failure()
    const kind = record.kind
    if (kind === 'request' || kind === 'admin_chat') {
      const field = kind === 'request' ? 'source_sha256' : 'message_sha256'
      if (!fields(record, ['kind', 'manager_key', 'request_id', field]) || !text(record.manager_key) || !isManagerKey(record.manager_key)
        || !text(record.request_id) || kind === 'request' && !hash.test(record.request_id)
        || typeof record[field] !== 'string' || !hash.test(record[field])) throw failure()
    } else if (kind === 'voice') {
      if (!fields(record, ['kind', 'channel_id', 'turn_id', 'payload_sha256']) || !text(record.channel_id) || !text(record.turn_id)
        || typeof record.payload_sha256 !== 'string' || !hash.test(record.payload_sha256)) throw failure()
    } else if (kind === 'workboard') {
      if (!fields(record, ['kind', 'manager_key', 'revision']) || !text(record.manager_key) || !isManagerKey(record.manager_key)
        || !Number.isSafeInteger(record.revision) || record.revision < 0) throw failure()
    } else throw failure()
    const identity = recordIdentity(record)
    if (ids.has(identity)) throw failure()
    ids.add(identity)
  }
}
function directoryExists(directory: string) {
  try { owned(directory, true, true); return true }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error }
}
/** Keep actual ancestor identities pinned while reading or publishing this Agent-owned namespace. */
function directoryScope(dataDir: string, directory: string) {
  const root = management.requireExistingDataRoot(dataDir) as string
  const paths = [root, path.join(root, 'agent'), directory]
  const frames: Array<{ path: string; version: string; privatePath: boolean; native_id: string | null }> = [], pins: unknown[] = []
  const close = () => { for (const pin of pins.splice(0).reverse()) native.releaseDirectoryPin(pin) }
  try {
    for (const [index, file] of paths.entries()) {
      const privatePath = index === 2, stat = owned(file, true, privatePath)
      if (fs.realpathSync(file) !== file) throw failure()
      let nativeId: string | null = null
      if (process.platform === 'win32') { const pin = native.pinDirectory(file); pins.push(pin); nativeId = pin.identity }
      frames.push({ path: file, version: version(stat), privatePath, native_id: nativeId })
    }
  } catch (error) { close(); throw error }
  return { close, verify: () => {
    for (const frame of frames) if (!sameIdentity(version(owned(frame.path, true, frame.privatePath)), frame.version, true)
      || fs.realpathSync(frame.path) !== frame.path || process.platform === 'win32' && native.inspectDirectoryFileId(frame.path) !== frame.native_id) throw failure()
  } }
}
function readDocuments(directory: string, temporary?: string, allowEmpty = false): RetirementDocument[] {
  const names = fs.readdirSync(directory).sort(), documents: RetirementDocument[] = [], versions = new Map<string, string>()
  if (!names.length && !allowEmpty) throw failure()
  let remaining = 64n * 1024n * 1024n
  for (const name of names) {
    if (temporary !== undefined && path.dirname(temporary) === directory && path.basename(temporary) === name) {
      owned(temporary, false, true); continue
    }
    if (!name.endsWith('.json') || !uuid.test(name.slice(0, -5))) throw failure()
    const file = path.join(directory, name), stat = owned(file, false, true)
    if (stat.size > BigInt(limit) || stat.size > remaining) throw failure()
    remaining -= stat.size
    const document = readJson(file, limit)
    if (version(owned(file, false, true)) !== version(stat)) throw failure()
    versions.set(file, version(stat))
    validateDocument(document)
    if (document.intent_id + '.json' !== name) throw failure()
    documents.push(document)
  }
  for (const [file, expected] of versions) if (version(owned(file, false, true)) !== expected) throw failure()
  if (JSON.stringify(fs.readdirSync(directory).sort()) !== JSON.stringify(names)) throw failure()
  return documents
}

function recordsFor(documents: ReadonlyArray<{ records: ReadonlyArray<RetiredRecovery> }>): Map<string, string> {
  const records = new Map<string, string>()
  for (const document of documents) for (const record of document.records) {
    const identity = recordIdentity(record), value = recordValue(record), previous = records.get(identity)
    if (previous !== undefined && previous !== value) throw failure()
    records.set(identity, value)
  }
  return records
}

/** Private technical lookup; it never edits requests, acknowledgements, task goals or delivery facts. */
export class WorkspaceRelocationRetirements {
  private records?: Map<string, string>
  constructor(private readonly dataDir: string) {}
  load(): void {
    this.records = undefined
    const directory = path.join(this.dataDir, 'agent', 'workspace-relocation-retirements')
    let records = new Map<string, string>()
    if (directoryExists(directory)) {
      const scope = directoryScope(this.dataDir, directory)
      try {
        records = recordsFor(readDocuments(directory))
        scope.verify()
      } finally { scope.close() }
    }
    const restored = require('../../../scripts/lib/workspace-interrupted-source-records.mjs').listWorkspaceSourceRestorations(this.dataDir)
    const sourceRecords = recordsFor(restored.map((item: any) => ({ records: item.scope.recovery_snapshot.records })))
    for (const [identity, value] of sourceRecords) {
      if (records.has(identity) && records.get(identity) !== value) throw failure()
      records.set(identity, value)
    }
    this.records = records
  }
  private contains(record: RetiredRecovery): boolean {
    if (!this.records) this.load()
    const value = this.records!.get(recordIdentity(record))
    if (value !== undefined && value !== recordValue(record)) throw failure()
    return value !== undefined
  }
  request(key: string, requestId: string, sourceSha256: string): boolean {
    return this.contains({ kind: 'request', manager_key: key, request_id: requestId, source_sha256: sourceSha256 })
  }
  adminChat(key: string, requestId: string, messageSha256: string): boolean {
    return this.contains({ kind: 'admin_chat', manager_key: key, request_id: requestId, message_sha256: messageSha256 })
  }
  voice(channelId: string, turnId: string, payloadSha256: string): boolean {
    return this.contains({ kind: 'voice', channel_id: channelId, turn_id: turnId, payload_sha256: payloadSha256 })
  }
  workboard(key: string, revision: number): boolean {
    return this.contains({ kind: 'workboard', manager_key: key, revision })
  }
}

/** Agent-owned publication primitive; the original fixed coordinator supplies fresh verification before effects. */
export async function publishWorkspaceRelocationRetirements({ dataDir, document: input, verify }: {
  dataDir: string; document: unknown; verify: () => Promise<unknown>
}) {
  const document = structuredClone(input)
  validateDocument(document)
  if (Buffer.byteLength(JSON.stringify(document)) + 1 > limit) throw failure()
  await verify()
  const root = management.requireExistingDataRoot(dataDir) as string, agent = path.join(root, 'agent')
  owned(agent, true)
  if (fs.realpathSync(agent) !== agent) throw failure()
  const directory = path.join(agent, 'workspace-relocation-retirements')
  if (!directoryExists(directory)) {
    if (process.platform === 'win32') native.createPrivateDirectory(directory)
    else fs.mkdirSync(directory, { mode: 0o700 })
    syncDirectory(agent)
  }
  const scope = directoryScope(root, directory)
  try {
    const documents = readDocuments(directory, undefined, true), current = documents.find(item => item.intent_id === document.intent_id), hash = sha256CanonicalJson(document)
    recordsFor([...documents, document])
    if (current && sha256CanonicalJson(current) !== hash) throw failure()
    if (!current) {
      await verify(); scope.verify()
      publish(directory, document.intent_id + '.json', document, temporary => {
        scope.verify()
        if (sha256CanonicalJson(readDocuments(directory, temporary, true)) !== sha256CanonicalJson(documents)) throw failure()
      }, limit)
    }
    await verify(); scope.verify()
    const actual = readDocuments(directory)
    recordsFor(actual)
    if (sha256CanonicalJson(actual.find(item => item.intent_id === document.intent_id)) !== hash) throw failure()
    return { dispatch: current ? 'observe' as const : 'dispatch' as const, retirement_sha256: hash }
  } finally { scope.close() }
}
