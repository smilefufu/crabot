import { promises as fs } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { sha256CanonicalJson } from 'crabot-shared'
import { AsyncMutex } from '../workers/async-mutex.js'
import { encodeSegment } from '../workers/harness/ledger-store.js'
import { assertRequestPermissionSources, type ConversationRequestSource, type ResolveRequestPermissionSourcesResult } from './request-permission-sources.js'
import type { ConversationRequestRecord, ConversationRequestDelivery } from './conversation-request.js'
import type { TrustedHumanInput } from './trusted-human-input.js'
import type { TrustedHumanInputStore } from './trusted-human-input-store.js'
import type { ManagerKey } from './types.js'

interface State { version: 1; requests: ConversationRequestRecord[] }
interface Proposal { source_id: string; quote?: string; delivery: ConversationRequestDelivery['kind'] }
interface Dependencies {
  now(): string
  resolveSources(source: ConversationRequestSource): Promise<ResolveRequestPermissionSourcesResult>
}
const KEYS = ['schema_version', 'request_id', 'manager_key', 'source_id', 'source_sha256', 'selection', 'created_at', 'permission_sources', 'delivery', 'worker_ids', 'status']
function exact(value: unknown, keys: string[]): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(key => Object.prototype.hasOwnProperty.call(value, key))
}
function nonempty(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0 }
function boundary(text: string, offset: number): boolean {
  return Number.isSafeInteger(offset) && offset >= 0 && offset <= text.length
    && !(offset > 0 && /[\ud800-\udbff]/.test(text[offset - 1]) && /[\udc00-\udfff]/.test(text[offset] ?? ''))
}
function validSelection(text: string, value: unknown): value is ConversationRequestRecord['selection'] {
  return exact(value, ['start', 'end']) && boundary(text, value.start as number) && boundary(text, value.end as number)
    && (value.start as number) < (value.end as number) && text.slice(value.start as number, value.end as number).trim().length > 0
}
function select(text: string, quote?: string): ConversationRequestRecord['selection'] {
  const start = quote === undefined ? 0 : text.indexOf(quote), end = quote === undefined ? text.length : start + quote.length
  const selection = { start, end }
  if (!validSelection(text, selection) || quote !== undefined && text.indexOf(quote, start + 1) !== -1) throw new Error('Invalid or ambiguous request selection')
  return selection
}
function overlaps(a: ConversationRequestRecord['selection'], b: ConversationRequestRecord['selection']): boolean { return a.start < b.end && b.start < a.end }
export function requestSourceFor(source: TrustedHumanInput): ConversationRequestSource {
  if (source.message.session.type !== 'group') throw new Error('Request source must be a real group input')
  return { source_id: source.source_id, channel_id: source.message.session.channel_id, session_id: source.message.session.session_id,
    session_type: 'group', platform_message_id: source.message.platform_message_id, platform_user_id: source.message.sender.platform_user_id, sender_friend_id: source.sender_friend_id }
}
function assertDelivery(value: unknown, source: TrustedHumanInput): asserts value is ConversationRequestDelivery {
  if (!exact(value, ['kind', 'requester_friend_id']) || !(value.kind === 'origin' && value.requester_friend_id === null
    || value.kind === 'requester_private' && source.identity_status === 'friend' && !!source.sender_friend_id && value.requester_friend_id === source.sender_friend_id)) throw new Error('Invalid request delivery; private delivery requires the known original sender')
}

/** Internal host store. A current successfully captured input window is required for creation. */
export class ConversationRequestStore {
  private readonly locks = new Map<ManagerKey, AsyncMutex>()
  constructor(private readonly root: string, private readonly sources: TrustedHumanInputStore, private readonly deps: Dependencies) {}
  private mutex(key: ManagerKey): AsyncMutex {
    let mutex = this.locks.get(key)
    if (!mutex) { mutex = new AsyncMutex(); this.locks.set(key, mutex) }
    return mutex
  }
  private file(key: ManagerKey): string { return path.join(this.root, encodeSegment(key), 'requests.json') }
  forInputs(key: ManagerKey, inputs: ReadonlyArray<TrustedHumanInput>): { create(proposal: Proposal): Promise<ConversationRequestRecord> } {
    const admitted = new Map<string, string>()
    for (const input of inputs) {
      if (input.manager_key !== key || input.message.session.type !== 'group') throw new Error('Request input window target mismatch')
      admitted.set(input.source_id, sha256CanonicalJson(input))
    }
    return { create: input => {
      const proposal = structuredClone(input)
      return this.mutex(key).run(async () => {
        const expected = admitted.get(proposal.source_id)
        if (!expected) throw new Error('Request source is not in the current admitted input window')
        const sources = await this.sourceMap(key), source = sources.get(proposal.source_id)
        if (!source || sha256CanonicalJson(source) !== expected) throw new Error('Request source missing or changed')
        const selection = select(source.message.content.text ?? '', proposal.quote)
        const delivery: ConversationRequestDelivery = { kind: proposal.delivery, requester_friend_id: proposal.delivery === 'requester_private' ? source.sender_friend_id : null }
        assertDelivery(delivery, source)
        const state = await this.read(key, sources), requestId = sha256CanonicalJson([source.source_id, selection.start, selection.end])
        const existing = state.requests.find(item => item.request_id === requestId)
        if (existing) {
          if (existing.delivery.kind !== delivery.kind) throw new Error('Request delivery is immutable')
          return structuredClone(existing)
        }
        if (state.requests.some(item => item.source_id === source.source_id && overlaps(item.selection, selection))) throw new Error('REQUEST_SCOPE_CONFLICT')
        const createdAt = this.deps.now()
        if (!Number.isFinite(Date.parse(createdAt))) throw new Error('Invalid request creation time')
        const origin = requestSourceFor(source), permissionSources = structuredClone(await this.deps.resolveSources(structuredClone(origin)))
        assertRequestPermissionSources(origin, permissionSources)
        const saved: ConversationRequestRecord = { schema_version: 1, request_id: requestId, manager_key: key, source_id: source.source_id,
          source_sha256: expected, selection, created_at: createdAt, permission_sources: permissionSources, delivery, worker_ids: [], status: 'open' }
        state.requests.push(saved); await this.write(key, state)
        return structuredClone(saved)
      })
    } }
  }
  async get(key: ManagerKey, requestId: string): Promise<{ record: ConversationRequestRecord; source: TrustedHumanInput } | null> {
    return this.mutex(key).run(async () => {
      const sources = await this.sourceMap(key), state = await this.read(key, sources), record = state.requests.find(item => item.request_id === requestId)
      return record ? structuredClone({ record, source: sources.get(record.source_id)! }) : null
    })
  }
  async attachWorker(key: ManagerKey, requestId: string, workerId: string): Promise<void> {
    if (!nonempty(workerId)) throw new Error('Invalid request Worker ID')
    await this.change(key, requestId, (record, state) => {
      if (record.status !== 'open') throw new Error('Request is closed')
      if (state.requests.some(other => other.request_id !== requestId && other.worker_ids.includes(workerId))) throw new Error('Worker already bound to another request')
      if (!record.worker_ids.includes(workerId)) record.worker_ids.push(workerId)
    })
  }
  async close(key: ManagerKey, requestId: string): Promise<void> { await this.change(key, requestId, record => { record.status = 'closed' }) }
  private async change(key: ManagerKey, requestId: string, update: (record: ConversationRequestRecord, state: State) => void): Promise<void> {
    await this.mutex(key).run(async () => {
      const state = await this.read(key, await this.sourceMap(key)), record = state.requests.find(item => item.request_id === requestId)
      if (!record) throw new Error('Request not found')
      update(record, state); await this.write(key, state)
    })
  }
  private async sourceMap(key: ManagerKey): Promise<Map<string, TrustedHumanInput>> { return new Map((await this.sources.list(key)).map(source => [source.source_id, source])) }
  private async read(key: ManagerKey, sources: Map<string, TrustedHumanInput>): Promise<State> {
    let value: unknown
    try { value = JSON.parse(await fs.readFile(this.file(key), 'utf8')) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, requests: [] }; throw error }
    if (!exact(value, ['version', 'requests']) || value.version !== 1 || !Array.isArray(value.requests)) throw new Error('Unsupported request store')
    const ids = new Set<string>(), workers = new Set<string>(), checked: ConversationRequestRecord[] = []
    for (const item of value.requests) {
      if (!exact(item, KEYS) || item.schema_version !== 1 || item.manager_key !== key || !nonempty(item.source_id)) throw new Error('Invalid request record')
      const source = sources.get(item.source_id)
      if (!source || source.manager_key !== key || source.message.session.type !== 'group' || item.source_sha256 !== sha256CanonicalJson(source)) throw new Error('Request source missing or changed')
      if (!validSelection(source.message.content.text ?? '', item.selection) || item.request_id !== sha256CanonicalJson([source.source_id, item.selection.start, item.selection.end])
        || typeof item.created_at !== 'string' || !Number.isFinite(Date.parse(item.created_at)) || !['open', 'closed'].includes(String(item.status))
        || !Array.isArray(item.worker_ids) || !item.worker_ids.every(nonempty) || ids.has(item.request_id as string)) throw new Error('Invalid request identity or selection')
      assertDelivery(item.delivery, source); assertRequestPermissionSources(requestSourceFor(source), item.permission_sources)
      for (const worker of item.worker_ids) { if (workers.has(worker)) throw new Error('Duplicate request Worker'); workers.add(worker) }
      const record = item as unknown as ConversationRequestRecord
      if (checked.some(other => other.source_id === source.source_id && overlaps(other.selection, record.selection))) throw new Error('REQUEST_SCOPE_CONFLICT')
      ids.add(record.request_id); checked.push(record)
    }
    return value as unknown as State
  }
  private async write(key: ManagerKey, state: State): Promise<void> {
    const target = this.file(key), temporary = `${target}.${randomUUID()}.tmp`
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 })
    try {
      const handle = await fs.open(temporary, 'wx', 0o600)
      try { await handle.writeFile(JSON.stringify(state)); await handle.sync() } finally { await handle.close() }
      await fs.rename(temporary, target)
    } catch (error) { await fs.rm(temporary, { force: true }).catch(() => undefined); throw error }
  }
}
