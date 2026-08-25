import type { ToolCallResult } from '../types'

export const LOCAL_HOST_PROTOCOL_VERSION = 1 as const

export const LOCAL_HOST_OPERATIONS = ['read', 'write', 'edit', 'glob', 'grep', 'skill'] as const
export type LocalHostOperation = typeof LOCAL_HOST_OPERATIONS[number]

export interface ReadObservation {
  readonly kind: 'read_observation'
  readonly path: string
  readonly mtime_ms: number
  readonly offset: number
  readonly limit: number
}

export interface LocalHostRequest {
  readonly protocol_version: typeof LOCAL_HOST_PROTOCOL_VERSION
  readonly call_id: string
  readonly operation: LocalHostOperation
  readonly input: Record<string, unknown>
  readonly context: { readonly cwd: string; readonly timezone: string }
}

export interface LocalHostResponse {
  readonly protocol_version: typeof LOCAL_HOST_PROTOCOL_VERSION
  readonly call_id: string
  readonly ok: true
  readonly result: ToolCallResult
  readonly effect?: ReadObservation
}

export function isLocalHostOperation(value: unknown): value is LocalHostOperation {
  return typeof value === 'string' && (LOCAL_HOST_OPERATIONS as readonly string[]).includes(value)
}

export function isReadObservation(value: unknown): value is ReadObservation {
  if (value === undefined) return false
  if (value === null || typeof value !== 'object') return false
  const effect = value as Record<string, unknown>
  return effect.kind === 'read_observation'
    && typeof effect.path === 'string'
    && typeof effect.mtime_ms === 'number'
    && typeof effect.offset === 'number'
    && typeof effect.limit === 'number'
}
