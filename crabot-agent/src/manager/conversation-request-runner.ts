import type { VoicePendingResult } from './voice-output.js'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { sha256CanonicalJson } from 'crabot-shared'
import { AsyncMutex } from '../workers/async-mutex.js'
import type { HarnessEvent, HarnessEventDelivery, ActivityContextAdmissionReceipt } from '../workers/harness/worker-events.js'
import type { VoiceReplyContext } from 'crabot-shared'
import { RequestDeliveryStore } from './request-delivery-store.js'
import { ManagerLoop, type EpisodeResult } from './loop.js'
import { ManagerSessionStore } from './session-store.js'
import { ConversationRequestStore } from './conversation-request-store.js'
import { ConversationRequestAuthority } from './conversation-request-authority.js'
import type { ConversationRequestRecord, ExecuteConversationRequestParams, ExecuteConversationRequestResult } from './conversation-request.js'
import type { RequestPermissionSource, ConversationRequestSource } from './request-permission-sources.js'
import type { TrustedHumanInput } from './trusted-human-input.js'
import type { ManagerKey } from './types.js'

export interface RequestRunContext {
  request: ConversationRequestRecord
  source: TrustedHumanInput
  store: ManagerSessionStore
  authority: ConversationRequestAuthority
  onSuccessfulOriginDelivery?: (target: { channel_id: string; session_id: string }) => void
  voiceReplyContext?: VoiceReplyContext
}
interface Dependencies {
  canRun?(): boolean
  onSettled?(key: ManagerKey): void
  createLoop(context: RequestRunContext): ManagerLoop
  resolveCurrent(kind: RequestPermissionSource['kind'], source: ConversationRequestSource): Promise<RequestPermissionSource | null>
  validateVoiceDelivery?(key: ManagerKey, requestId: string, result: VoicePendingResult): Promise<void>
  validateVoiceManagement?(key: ManagerKey, requestId: string, result: import('crabot-shared').VoiceAgentManagementResult): Promise<void>
  validateEvent?(key: ManagerKey, requestId: string, event: HarnessEvent): Promise<void>
  timezone(): string
}
interface RequestVoiceDeliveryEvent {
  kind: 'voice_delivery'
  ts: string
  seq: number
  worker_id: string
  result: VoicePendingResult
}
interface RequestVoiceManagementEvent {
  kind: 'voice_management'
  ts: string
  seq: number
  result: import('crabot-shared').VoiceAgentManagementResult
}
type RequestRuntimeEvent = HarnessEvent | RequestVoiceDeliveryEvent | RequestVoiceManagementEvent
interface RequestEvent {
  schema_version: 1 | 2 | 3
  event_sha256?: string
  manager_key: ManagerKey
  request_id: string
  source_sha256: string
  event_id: string
  event: RequestRuntimeEvent
  received_at: string
  phase: 'queued' | 'admitted' | 'settled'
  consumed: boolean
  context_admitted: boolean
}
interface Admission {
  schema_version: 1
  request_id: string
  source_sha256: string
  phase: 'admitted' | 'settled'
  outcome: EpisodeResult['outcome'] | null
}

export function parseConversationRequestProposal(value: unknown): ExecuteConversationRequestParams {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_PARAMS: request proposal required')
  const input = value as Record<string, unknown>
  if (Object.keys(input).some(key => !['source_id', 'quote', 'delivery'].includes(key))
    || !Object.prototype.hasOwnProperty.call(input, 'source_id') || typeof input.source_id !== 'string' || !input.source_id.trim()
    || !Object.prototype.hasOwnProperty.call(input, 'delivery') || (typeof input.delivery !== 'string' || !['origin', 'requester_private'].includes(input.delivery))
    || Object.prototype.hasOwnProperty.call(input, 'quote') && typeof input.quote !== 'string') throw new Error('INVALID_PARAMS: only original source, quote and delivery are accepted')
  return structuredClone(input) as unknown as ExecuteConversationRequestParams
}

/** Owns request-only Manager stores. It never receives a shared mailbox or shared/private history. */
export class ConversationRequestRunner {
  private readonly active = new Set<string>()
  private readonly eventRequests = new Set<string>()
  private readonly queueLock = new AsyncMutex()
  private readonly drains = new Map<string, Promise<void>>()
  private readonly receipts = new Map<string, ActivityContextAdmissionReceipt>()
  private closing = false
  constructor(private readonly root: string, private readonly requests: ConversationRequestStore, private readonly deps: Dependencies) {}

  async execute(key: ManagerKey, inputs: ReadonlyArray<TrustedHumanInput>, input: unknown, voice?: VoiceReplyContext, onDelivered?: RequestRunContext['onSuccessfulOriginDelivery']): Promise<ExecuteConversationRequestResult> {
    if (this.closing || this.deps.canRun?.() === false) throw new Error('CAPABILITY_UNKNOWN: Request runtime is not ready')
    const args = parseConversationRequestProposal(input)
    const record = await this.requests.forInputs(key, inputs).create(args)
    return this.run(key, record.request_id, true, voice, onDelivered)
  }

  /** Host recovery only; no old request ID is accepted as a new human authorization. */
  async recover(key: ManagerKey, requestId: string): Promise<ExecuteConversationRequestResult> {
    const result = await this.run(key, requestId, false)
    if (result.status !== 'waiting') return result
    try { await this.drain(key, requestId) } catch { return { ...result, status: 'recovery_required' } }
    const fixed = await this.requests.get(key, requestId)
    return fixed && (await this.hasUnknownDelivery(fixed.record) || await this.hasUnknownEvent(fixed.record)) ? { ...result, status: 'recovery_required' } : result
  }

  private async run(key: ManagerKey, requestId: string, allowFirstAdmission: boolean, voice?: VoiceReplyContext, onDelivered?: RequestRunContext['onSuccessfulOriginDelivery']): Promise<ExecuteConversationRequestResult> {
    const fixed = await this.requests.get(key, requestId)
    if (!fixed) throw new Error('Request not found')
    if (fixed.record.status === 'closed') return this.report(fixed.record, 'closed')
    if (this.closing || this.deps.canRun?.() === false) return this.report(fixed.record, 'recovery_required')
    if (this.active.has(requestId)) return this.report(fixed.record, 'running')
    this.active.add(requestId)
    try {
      const directory = path.join(this.root, requestId), file = path.join(directory, 'admission.json')
      await this.saveOwner(key, fixed.record)
      const store = new ManagerSessionStore(path.join(directory, 'session'))
      let admission = await this.readAdmission(file, fixed.record)
      const checkpoint = await store.loadCheckpoint(key)
      if (!admission && checkpoint) throw new Error('Request checkpoint has no durable admission')
      if (admission?.phase === 'settled' && checkpoint) throw new Error('Settled request admission has an unfinished checkpoint')
      if (admission?.phase === 'settled') return this.report(fixed.record, admission.outcome === 'completed' && !await this.hasUnknownDelivery(fixed.record) && !await this.hasUnknownEvent(fixed.record) ? 'waiting' : 'recovery_required')
      if ((admission && !checkpoint) || (!admission && !allowFirstAdmission)) return this.report(fixed.record, 'recovery_required')
      if (!admission) {
        const state = await store.load(key)
        if (state.recent.length || state.foldedCount || state.rollingSummary !== undefined) throw new Error('Unadmitted request history cannot be replayed')
        admission = { schema_version: 1, request_id: requestId, source_sha256: fixed.record.source_sha256, phase: 'admitted', outcome: null }
        await fs.mkdir(directory, { recursive: true, mode: 0o700 })
        const handle = await fs.open(file, 'wx', 0o600)
        try { await handle.writeFile(JSON.stringify(admission)); await handle.sync() } finally { await handle.close() }
      }
      const reply = allowFirstAdmission && !checkpoint && fixed.record.delivery.kind === 'origin' && voice
        && voice.channel_id === fixed.source.message.session.channel_id && voice.session_id === fixed.source.message.session.session_id
        && Date.parse(voice.expires_at) > Date.now() ? structuredClone(voice) : undefined
      const loop = this.deps.createLoop({ source: structuredClone(fixed.source), request: structuredClone(fixed.record), store,
        authority: new ConversationRequestAuthority(this.requests, key, requestId, 'request', this.deps.resolveCurrent),
        ...(reply ? { voiceReplyContext: reply } : {}), ...(onDelivered ? { onSuccessfulOriginDelivery: onDelivered } : {}) })
      const result = checkpoint ? await loop.resume(checkpoint) : await loop.wakeUp({
        wake: { kind: 'human_messages', messages: [structuredClone(fixed.source.message)], request_inputs: [structuredClone(fixed.source)] },
        received_at: fixed.source.received_at, timezone: this.deps.timezone(), ...(reply ? { voice_reply_context: reply } : {}),
      })
      if (!result.contextRecoveryRequired) await this.writeJsonAtomic(file, { ...admission, phase: 'settled', outcome: result.outcome })
      const latest = await this.requests.get(key, requestId)
      if (!latest) throw new Error('Request disappeared during execution')
      return this.report(latest.record, latest.record.status === 'closed' ? 'closed' : result.outcome === 'completed' && !result.contextRecoveryRequired && !await this.hasUnknownDelivery(latest.record) ? 'waiting' : 'recovery_required')
    } finally {
      this.active.delete(requestId)
      this.deps.onSettled?.(key)
      if (!this.closing && this.eventRequests.has(requestId)) void this.drain(key, requestId).catch(() => { /* Durable private responsibility remains pending. */ })
    }
  }

  /** Host-only routing after the ledger/context double binding has been checked. */
  async routeWorkerEvent(key: ManagerKey, requestId: string, event: HarnessEvent, receipt?: ActivityContextAdmissionReceipt): Promise<HarnessEventDelivery> {
    return this.routeEvent(key, requestId, event, receipt)
  }
  async routeVoiceDelivery(key: ManagerKey, requestId: string, result: VoicePendingResult): Promise<HarnessEventDelivery> {
    if (result.status !== 'completed' || result.binding.request_id !== requestId || !result.binding.worker_id || !result.binding.worker_turn_id
      || !result.sent_at || !Number.isFinite(Date.parse(result.sent_at))) throw new Error('Voice delivery has no completed original binding')
    return this.routeEvent(key, requestId, { kind: 'voice_delivery', ts: result.sent_at, seq: 0, worker_id: result.binding.worker_id, result: structuredClone(result) })
  }
  async routeVoiceManagement(key: ManagerKey, requestId: string, result: import('crabot-shared').VoiceAgentManagementResult): Promise<HarnessEventDelivery> {
    const fixed = await this.requests.get(key, requestId)
    if (!fixed || !result.operation_id || !['completed', 'rejected'].includes(result.status)) throw new Error('Original management result is unavailable')
    return this.routeEvent(key, requestId, { kind: 'voice_management', ts: fixed.source.received_at, seq: 0, result: structuredClone(result) })
  }
  private eventId(event: RequestRuntimeEvent): string {
    return sha256CanonicalJson(event.kind === 'voice_management' ? { kind: event.kind, operation_id: event.result.operation_id } : event)
  }
  private async validateEvent(key: ManagerKey, requestId: string, event: RequestRuntimeEvent): Promise<void> {
    if (event.kind === 'voice_management') {
      if (!this.deps.validateVoiceManagement) throw new Error('Management event validation is unavailable')
      await this.deps.validateVoiceManagement(key, requestId, event.result)
    } else if (event.kind === 'voice_delivery') await this.deps.validateVoiceDelivery?.(key, requestId, event.result)
    else await this.deps.validateEvent?.(key, requestId, event)
  }
  private async routeEvent(key: ManagerKey, requestId: string, event: RequestRuntimeEvent, receipt?: ActivityContextAdmissionReceipt): Promise<HarnessEventDelivery> {
    if (this.closing) return { consumed: false }
    const fixed = await this.requests.get(key, requestId)
    if (!fixed || fixed.record.status !== 'open' || event.kind !== 'voice_management' && !fixed.record.worker_ids.includes(event.worker_id)) throw new Error('Request event binding unavailable')
    await this.validateEvent(key, requestId, event)
    if (receipt && event.kind !== 'activity_available') throw new Error('Invalid activity receipt kind')
    const normalized = JSON.parse(JSON.stringify(event)) as RequestRuntimeEvent
    const eventId = this.eventId(normalized), directory = path.join(this.root, requestId, 'events', eventId), file = path.join(directory, 'event.json')
    const item = await this.queueLock.run(async () => {
      let item = await this.readEvent(file, fixed.record, eventId)
      if (!item) {
        item = { schema_version: event.kind === 'voice_management' ? 3 : event.kind === 'voice_delivery' ? 2 : 1, manager_key: key, request_id: requestId, source_sha256: fixed.record.source_sha256,
          ...(event.kind === 'voice_management' ? { event_sha256: sha256CanonicalJson(normalized) } : {}),
          event_id: eventId, event: normalized, received_at: new Date().toISOString(), phase: 'queued', consumed: false, context_admitted: false }
        await fs.mkdir(directory, { recursive: true, mode: 0o700 })
        await this.writeJsonAtomic(file, item)
      }
      return item
    })
    if (this.deps.canRun?.() === false) return { consumed: false }
    if (receipt) {
      if (item.context_admitted || item.phase === 'settled' && item.consumed) {
        await receipt.admit(); void this.drain(key, requestId).catch(() => undefined); return { consumed: true }
      }
      this.receipts.set(eventId, receipt)
    }
    if (item.phase === 'settled') return { consumed: item.consumed }
    this.eventRequests.add(requestId)
    const wasActive = this.active.has(requestId)
    const run = this.drain(key, requestId)
    // Worker callbacks can occur inside spawn/query tools; never await the active initial episode.
    if (wasActive || receipt) {
      void run.then(() => this.drain(key, requestId)).catch(async () => {
        const pending = this.receipts.get(eventId)
        this.receipts.delete(eventId)
        try { await pending?.reject() } catch { /* Harness keeps the durable notification for recovery. */ }
      })
      return { consumed: false, ...(receipt ? { registered: true } : {}) }
    }
    await run
    return { consumed: (await this.readEvent(file, fixed.record, eventId))?.consumed === true }
  }

  private drain(key: ManagerKey, requestId: string): Promise<void> {
    const existing = this.drains.get(requestId)
    if (existing) return existing
    if (this.active.has(requestId) || this.closing || this.deps.canRun?.() === false) return Promise.resolve()
    // Claim synchronously; queue writes have their own short mutex and do not wait on model/tools.
    this.active.add(requestId)
    const run = this.drainEvents(key, requestId).finally(async () => {
      try { await this.rejectPendingReceipts(requestId) } finally { this.active.delete(requestId); this.drains.delete(requestId); this.deps.onSettled?.(key) }
    })
    this.drains.set(requestId, run)
    return run
  }
  private async drainEvents(key: ManagerKey, requestId: string): Promise<void> {
    let fixed = await this.requests.get(key, requestId)
    if (!fixed || fixed.record.status !== 'open') return
    const root = path.join(this.root, requestId), initial = await this.readAdmission(path.join(root, 'admission.json'), fixed.record)
    if (initial?.phase !== 'settled' || initial.outcome !== 'completed' || await this.hasUnknownDelivery(fixed.record)) return
    const canonical = new ManagerSessionStore(path.join(root, 'session'))
    for (;;) {
      fixed = await this.requests.get(key, requestId)
      if (!fixed || fixed.record.status !== 'open') return
      const entries = await fs.readdir(path.join(root, 'events')).catch(error => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error
      })
      const pending: RequestEvent[] = []
      for (const id of entries) {
        if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('Invalid private event directory')
        const item = await this.readEvent(path.join(root, 'events', id, 'event.json'), fixed.record, id)
        if (!item) throw new Error('Missing private event receipt')
        if (item.phase !== 'settled') pending.push(item)
      }
      pending.sort((a, b) => Number(b.phase === 'admitted') - Number(a.phase === 'admitted') || a.received_at.localeCompare(b.received_at) || a.event_id.localeCompare(b.event_id))
      const item = pending[0]
      if (!item) { this.eventRequests.delete(requestId); return }
      if (this.closing) return
      await this.validateEvent(key, requestId, item.event)
      const directory = path.join(root, 'events', item.event_id), file = path.join(directory, 'event.json')
      const store = new ManagerSessionStore(path.join(directory, 'session'))
      const checkpoint = await store.loadCheckpoint(key)
      if (item.phase === 'admitted' && !checkpoint) return // Unknown outcome is a barrier, never replay.
      if (item.phase === 'queued') {
        if (checkpoint) throw new Error('Unadmitted private event checkpoint')
        await store.save(await canonical.load(key))
        item.phase = 'admitted'
        await this.persistEvent(file, item)
      }
      const liveReceipt = this.receipts.get(item.event_id)
      const admission: ActivityContextAdmissionReceipt | undefined = liveReceipt ? { ...liveReceipt,
        admit: async () => {
          item.context_admitted = true
          await this.persistEvent(file, item)
          await liveReceipt.admit()
        },
      } : undefined
      const loop = this.deps.createLoop({ source: structuredClone(fixed.source), request: structuredClone(fixed.record), store,
        authority: new ConversationRequestAuthority(this.requests, key, requestId, 'request', this.deps.resolveCurrent) })
      try {
        const result = checkpoint ? await loop.resume(checkpoint) : await loop.wakeUp({
          wake: item.event.kind === 'voice_management' ? { kind: 'voice_management', result: structuredClone(item.event.result) } : item.event.kind === 'voice_delivery' ? { kind: 'voice_delivery', results: [structuredClone(item.event.result)] } : { kind: 'worker_event', event: structuredClone(item.event) }, received_at: item.received_at, timezone: this.deps.timezone(),
          ...(admission ? { activity_context_receipt: admission } : {}),
        })
        if (result.contextRecoveryRequired || !result.consumedEvents) { await liveReceipt?.reject(); return }
        if (liveReceipt && !item.context_admitted) {
          item.context_admitted = true
          await this.persistEvent(file, item)
          await liveReceipt.admit()
        }
        await canonical.save(await store.load(key))
        item.consumed = true; item.phase = 'settled'
        await this.persistEvent(file, item)
      } finally { this.receipts.delete(item.event_id) }
    }
  }

  private async persistEvent(file: string, item: RequestEvent): Promise<void> {
    await this.queueLock.run(() => this.writeJsonAtomic(file, structuredClone(item)))
  }

  private async rejectPendingReceipts(requestId: string): Promise<void> {
    const ids = await fs.readdir(path.join(this.root, requestId, 'events')).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error
    })
    for (const id of ids) {
      const receipt = this.receipts.get(id)
      this.receipts.delete(id)
      try { await receipt?.reject() } catch { /* Harness retains the original durable notification. */ }
    }
  }

  /** Startup recovery scans only the request-owned index, never the shared mailbox/history. */
  async recoverPending(): Promise<void> {
    const ids = await fs.readdir(this.root).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error })
    for (const id of ids) {
      if (!/^[a-f0-9]{64}$/.test(id)) continue
      try {
        const owner = JSON.parse(await fs.readFile(path.join(this.root, id, 'owner.json'), 'utf8'))
        const fixed = await this.requests.get(owner.manager_key, id)
        if (!fixed || owner.schema_version !== 1 || owner.request_id !== id || owner.source_sha256 !== fixed.record.source_sha256) throw new Error('Invalid request owner')
        await this.recover(owner.manager_key, id)
        await this.drain(owner.manager_key, id)
      } catch { console.error(`[request-runner] Request recovery unavailable (${id}); original responsibility preserved`) }
    }
  }
  async dispose(): Promise<void> { this.closing = true; await Promise.allSettled(this.drains.values()) }

  private async saveOwner(key: ManagerKey, request: ConversationRequestRecord): Promise<void> {
    const directory = path.join(this.root, request.request_id), file = path.join(directory, 'owner.json')
    const owner = { schema_version: 1, manager_key: key, request_id: request.request_id, source_sha256: request.source_sha256 }
    await fs.mkdir(directory, { recursive: true, mode: 0o700 })
    try { if (sha256CanonicalJson(JSON.parse(await fs.readFile(file, 'utf8'))) !== sha256CanonicalJson(owner)) throw new Error('Invalid request owner') }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; await this.writeJsonAtomic(file, owner) }
  }
  private hasUnknownDelivery(request: ConversationRequestRecord): Promise<boolean> { return new RequestDeliveryStore(path.join(this.root, request.request_id), request).unsettled() }
  private async hasUnknownEvent(request: ConversationRequestRecord): Promise<boolean> {
    const directory = path.join(this.root, request.request_id, 'events')
    const ids = await fs.readdir(directory).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error })
    for (const id of ids) {
      if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('Invalid request event directory')
      const item = await this.readEvent(path.join(directory, id, 'event.json'), request, id)
      if (!item) throw new Error('Missing request event receipt')
      if (item.phase === 'admitted' && !await new ManagerSessionStore(path.join(directory, id, 'session')).loadCheckpoint(request.manager_key)) return true
    }
    return false
  }

  private async readEvent(file: string, request: ConversationRequestRecord, id: string): Promise<RequestEvent | null> {
    let item: RequestEvent
    try { item = JSON.parse(await fs.readFile(file, 'utf8')) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
    const fields = ['schema_version', 'manager_key', 'request_id', 'source_sha256', 'event_id', 'event', 'received_at', 'phase', 'consumed', 'context_admitted']
    if (item?.schema_version === 3) fields.push('event_sha256')
    if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).length !== fields.length || fields.some(field => !Object.prototype.hasOwnProperty.call(item, field))
      || ![1, 2, 3].includes(item.schema_version) || (item.schema_version === 2) !== (item.event?.kind === 'voice_delivery') || (item.schema_version === 3) !== (item.event?.kind === 'voice_management') || item.manager_key !== request.manager_key || item.request_id !== request.request_id
      || item.source_sha256 !== request.source_sha256 || item.event_id !== id || this.eventId(item.event) !== id
      || item.schema_version === 3 && item.event_sha256 !== sha256CanonicalJson(item.event)
      || !item.event || typeof item.event.kind !== 'string' || !Number.isFinite(Date.parse(item.event.ts)) || !Number.isInteger(item.event.seq) || item.event.seq < 0
      || (item.event.kind === 'voice_management' ? !item.event.result?.operation_id || !['completed', 'rejected'].includes(item.event.result.status) : !request.worker_ids.includes(item.event.worker_id)) || !['queued', 'admitted', 'settled'].includes(item.phase)
      || item.phase === 'queued' && (item.consumed || item.context_admitted) || item.phase === 'admitted' && item.consumed || item.phase === 'settled' && !item.consumed
      || typeof item.consumed !== 'boolean' || typeof item.context_admitted !== 'boolean' || !Number.isFinite(Date.parse(item.received_at))) throw new Error('Invalid request event; refusing replay')
    return item
  }

  private report(request: ConversationRequestRecord, status: ExecuteConversationRequestResult['status']): ExecuteConversationRequestResult {
    return { request_id: request.request_id, status, delivery: request.delivery.kind, worker_ids: [...request.worker_ids] }
  }
  private async readAdmission(file: string, request: ConversationRequestRecord): Promise<Admission | null> {
    let value: unknown
    try { value = JSON.parse(await fs.readFile(file, 'utf8')) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
    const item = value as Partial<Admission> | null
    if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).length !== 5
      || item.schema_version !== 1 || item.request_id !== request.request_id || item.source_sha256 !== request.source_sha256
      || (typeof item.phase !== 'string' || !['admitted', 'settled'].includes(item.phase))
      || (item.phase === 'admitted' ? item.outcome !== null : (typeof item.outcome !== 'string' || !['completed', 'failed', 'max_turns', 'aborted'].includes(item.outcome)))) throw new Error('Invalid request admission; refusing replay')
    return item as Admission
  }
  private async writeJsonAtomic(file: string, value: unknown): Promise<void> {
    const temporary = `${file}.${randomUUID()}.tmp`
    try {
      const handle = await fs.open(temporary, 'wx', 0o600)
      try { await handle.writeFile(JSON.stringify(value)); await handle.sync() } finally { await handle.close() }
      await fs.rename(temporary, file)
    } finally { await fs.rm(temporary, { force: true }) }
  }
}
