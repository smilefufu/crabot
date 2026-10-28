import path from 'node:path'
import { RpcError } from './module-base.js'
import type { VerifyWorkspaceRelocationStartParams } from './workspace-types.js'

/** Shape only. This neither authenticates a human nor grants directory or execution access. */
export function parseWorkspaceRelocationStartRequest(input: unknown): Readonly<VerifyWorkspaceRelocationStartParams> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new RpcError('INVALID_PARAMS', 'Invalid workspace relocation start request')
  const value = input as Record<string, unknown>
  if (Object.keys(value).length !== 4 || !Object.keys(value).every(key => ['intent_id', 'target', 'expected_revision', 'confirmed'].includes(key))
    || typeof value.intent_id !== 'string' || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value.intent_id)
    || typeof value.target !== 'string' || !path.isAbsolute(value.target) || value.target.includes('\0')
    || typeof value.expected_revision !== 'number' || !Number.isSafeInteger(value.expected_revision) || value.expected_revision < 1 || value.confirmed !== true) {
    throw new RpcError('INVALID_PARAMS', 'Invalid workspace relocation start request')
  }
  return Object.freeze({ intent_id: value.intent_id, target: value.target, expected_revision: value.expected_revision, confirmed: true })
}
