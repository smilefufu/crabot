import { RpcError } from './module-base.js'
import type { StartWorkspaceRelocationRecoveryParams } from './workspace-types.js'

/** Shape only; the current human, archive and new coordinator are verified separately. */
export function parseWorkspaceRelocationRecoveryStartRequest(input: unknown): Readonly<StartWorkspaceRelocationRecoveryParams> {
  const value = input as Record<string, unknown>
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 5
    || !['intent_id', 'recovery_id', 'completion_sha256', 'finalizing_sha256', 'confirmed'].every(key => Object.hasOwn(value, key))
    || !['intent_id', 'recovery_id'].every(key => typeof value[key] === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value[key] as string))
    || !['completion_sha256', 'finalizing_sha256'].every(key => typeof value[key] === 'string' && /^[a-f0-9]{64}$/.test(value[key] as string)) || value.confirmed !== true) {
    throw new RpcError('INVALID_PARAMS', 'Invalid workspace recovery confirmation')
  }
  return Object.freeze({ intent_id: value.intent_id as string, recovery_id: value.recovery_id as string,
    completion_sha256: value.completion_sha256 as string, finalizing_sha256: value.finalizing_sha256 as string, confirmed: true })
}
