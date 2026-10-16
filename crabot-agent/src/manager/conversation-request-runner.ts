import { promises as fs } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { VoiceReplyContext } from 'crabot-shared'
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
  voiceReplyContext?: VoiceReplyContext
}
interface Dependencies {
  createLoop(context: RequestRunContext): ManagerLoop
  resolveCurrent(kind: RequestPermissionSource['kind'], source: ConversationRequestSource): Promise<RequestPermissionSource | null>
  timezone(): string
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
  constructor(private readonly root: string, private readonly requests: ConversationRequestStore, private readonly deps: Dependencies) {}

  async execute(key: ManagerKey, inputs: ReadonlyArray<TrustedHumanInput>, input: unknown, voice?: VoiceReplyContext): Promise<ExecuteConversationRequestResult> {
    const args = parseConversationRequestProposal(input)
    const record = await this.requests.forInputs(key, inputs).create(args)
    return this.run(key, record.request_id, true, voice)
  }

  /** Host recovery only; no old request ID is accepted as a new human authorization. */
  async recover(key: ManagerKey, requestId: string): Promise<ExecuteConversationRequestResult> {
    return this.run(key, requestId, false)
  }

  private async run(key: ManagerKey, requestId: string, allowFirstAdmission: boolean, voice?: VoiceReplyContext): Promise<ExecuteConversationRequestResult> {
    const fixed = await this.requests.get(key, requestId)
    if (!fixed) throw new Error('Request not found')
    if (fixed.record.status === 'closed') return this.report(fixed.record, 'closed')
    if (this.active.has(requestId)) return this.report(fixed.record, 'running')
    this.active.add(requestId)
    try {
      const directory = path.join(this.root, requestId), file = path.join(directory, 'admission.json')
      const store = new ManagerSessionStore(path.join(directory, 'session'))
      let admission = await this.readAdmission(file, fixed.record)
      const checkpoint = await store.loadCheckpoint(key)
      if (!admission && checkpoint) throw new Error('Request checkpoint has no durable admission')
      if (admission?.phase === 'settled' && checkpoint) throw new Error('Settled request admission has an unfinished checkpoint')
      if (admission?.phase === 'settled') return this.report(fixed.record, admission.outcome === 'completed' ? 'waiting' : 'recovery_required')
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
        ...(reply ? { voiceReplyContext: reply } : {}) })
      const result = checkpoint ? await loop.resume(checkpoint) : await loop.wakeUp({
        wake: { kind: 'human_messages', messages: [structuredClone(fixed.source.message)], request_inputs: [structuredClone(fixed.source)] },
        received_at: fixed.source.received_at, timezone: this.deps.timezone(), ...(reply ? { voice_reply_context: reply } : {}),
      })
      if (!result.contextRecoveryRequired) await this.settleAdmission(file, { ...admission, phase: 'settled', outcome: result.outcome })
      const latest = await this.requests.get(key, requestId)
      if (!latest) throw new Error('Request disappeared during execution')
      return this.report(latest.record, latest.record.status === 'closed' ? 'closed' : result.outcome === 'completed' && !result.contextRecoveryRequired ? 'waiting' : 'recovery_required')
    } finally { this.active.delete(requestId) }
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
  private async settleAdmission(file: string, admission: Admission): Promise<void> {
    const temporary = `${file}.${randomUUID()}.tmp`
    try {
      const handle = await fs.open(temporary, 'wx', 0o600)
      try { await handle.writeFile(JSON.stringify(admission)); await handle.sync() } finally { await handle.close() }
      await fs.rename(temporary, file)
    } finally { await fs.rm(temporary, { force: true }) }
  }
}
