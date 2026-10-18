/** Read-only request metadata validation shared by runtime and offline upgrade; no execution. */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { sha256CanonicalJson } from 'crabot-shared'
import type { VoicePendingResult } from './voice-output.js'
import type { HarnessEvent } from '../workers/harness/worker-events.js'
import type { EpisodeResult } from './loop.js'
import type { ConversationRequestRecord } from './conversation-request.js'
import type { ManagerKey } from './types.js'

export interface RequestVoiceDeliveryEvent {
  kind: 'voice_delivery'
  ts: string
  seq: number
  worker_id: string
  result: VoicePendingResult
}
export interface RequestVoiceManagementEvent {
  kind: 'voice_management'
  ts: string
  seq: number
  result: import('crabot-shared').VoiceAgentManagementResult
}
export type RequestRuntimeEvent = HarnessEvent | RequestVoiceDeliveryEvent | RequestVoiceManagementEvent
export interface RequestEvent {
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
export interface Admission {
  schema_version: 1
  request_id: string
  source_sha256: string
  phase: 'admitted' | 'settled'
  outcome: EpisodeResult['outcome'] | null
}

export function requestEventId(event: RequestRuntimeEvent): string {
  return sha256CanonicalJson(event.kind === 'voice_management' ? { kind: event.kind, operation_id: event.result.operation_id } : event)
}

export async function readRequestEvent(file: string, request: ConversationRequestRecord, id: string): Promise<RequestEvent | null> {
  let item: RequestEvent
  try { item = JSON.parse(await fs.readFile(file, 'utf8')) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
  const fields = ['schema_version', 'manager_key', 'request_id', 'source_sha256', 'event_id', 'event', 'received_at', 'phase', 'consumed', 'context_admitted']
  if (item?.schema_version === 3) fields.push('event_sha256')
  if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).length !== fields.length || fields.some(field => !Object.prototype.hasOwnProperty.call(item, field))
    || ![1, 2, 3].includes(item.schema_version) || (item.schema_version === 2) !== (item.event?.kind === 'voice_delivery') || (item.schema_version === 3) !== (item.event?.kind === 'voice_management') || item.manager_key !== request.manager_key || item.request_id !== request.request_id
    || item.source_sha256 !== request.source_sha256 || item.event_id !== id || requestEventId(item.event) !== id
    || item.schema_version === 3 && item.event_sha256 !== sha256CanonicalJson(item.event)
    || !item.event || typeof item.event.kind !== 'string' || !Number.isFinite(Date.parse(item.event.ts)) || !Number.isInteger(item.event.seq) || item.event.seq < 0
    || (item.event.kind === 'voice_management' ? !item.event.result?.operation_id || !['completed', 'rejected'].includes(item.event.result.status) : !request.worker_ids.includes(item.event.worker_id)) || !['queued', 'admitted', 'settled'].includes(item.phase)
    || item.phase === 'queued' && (item.consumed || item.context_admitted) || item.phase === 'admitted' && item.consumed || item.phase === 'settled' && !item.consumed
    || typeof item.consumed !== 'boolean' || typeof item.context_admitted !== 'boolean' || !Number.isFinite(Date.parse(item.received_at))) throw new Error('Invalid request event; refusing replay')
  return item
}

export async function readRequestAdmission(file: string, request: ConversationRequestRecord): Promise<Admission | null> {
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

export interface RequestDeliveryReceipt { platform_message_id: string; sent_at: string }
export interface RequestDeliveryAttempt {
  schema_version: 1
  request_id: string
  source_sha256: string
  operation_id: string
  target: { channel_id: string; session_id: string }
}
export function isRequestDeliveryReceipt(value: unknown): value is RequestDeliveryReceipt {
  const receipt = value as Partial<RequestDeliveryReceipt> | null
  return !!receipt && typeof receipt.platform_message_id === 'string' && !!receipt.platform_message_id
    && typeof receipt.sent_at === 'string' && Number.isFinite(Date.parse(receipt.sent_at))
}

export function parseRequestDeliveryAttempt(value: unknown, request: ConversationRequestRecord): RequestDeliveryAttempt {
  const item = value as RequestDeliveryAttempt
  const fields = ['schema_version', 'request_id', 'source_sha256', 'operation_id', 'target']
  if (!item || Object.keys(item).length !== fields.length || fields.some(field => !Object.prototype.hasOwnProperty.call(item, field))
    || item.schema_version !== 1 || item.request_id !== request.request_id || item.source_sha256 !== request.source_sha256
    || !/^[a-f0-9]{64}$/.test(item.operation_id) || typeof item.target?.channel_id !== 'string' || !item.target.channel_id
    || typeof item.target.session_id !== 'string' || !item.target.session_id) throw new Error('DELIVERY_OUTCOME_UNKNOWN: Invalid request delivery record')
  return item
}

export async function readRequestDeliveryConfirmation(root: string, request: ConversationRequestRecord, attempt: RequestDeliveryAttempt): Promise<RequestDeliveryReceipt | null> {
  const value = await readRequestDeliveryFile(path.join(root, 'deliveries', `${attempt.operation_id}.json`)) as (RequestDeliveryAttempt & { receipt: RequestDeliveryReceipt }) | null
  if (!value) return null
  const { receipt, ...saved } = value
  parseRequestDeliveryAttempt(saved, request)
  if (sha256CanonicalJson(saved) !== sha256CanonicalJson(attempt) || !isRequestDeliveryReceipt(receipt)) throw new Error('DELIVERY_OUTCOME_UNKNOWN: Invalid delivery confirmation')
  return receipt
}

export async function readRequestDeliveryFile(file: string): Promise<unknown | null> {
  try {
    const value: unknown = JSON.parse(await fs.readFile(file, 'utf8'))
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('DELIVERY_OUTCOME_UNKNOWN: Invalid delivery file')
    return value
  }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
}
