import { RpcError } from './module-base.js'
import type { WorkspaceRelocationJobQuery } from './workspace-types.js'

/** Read-only identity shape; it carries no initial confirmation or recovery authority. */
export function parseWorkspaceRelocationJobQuery(input: unknown): Readonly<WorkspaceRelocationJobQuery> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new RpcError('INVALID_PARAMS', 'Invalid workspace job query')
  const value = input as Record<string, unknown>, keys = Object.keys(value)
  if (keys.length === 0) return Object.freeze({})
  if (keys.length !== 1 || keys[0] !== 'intent_id' || typeof value.intent_id !== 'string'
    || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value.intent_id)) {
    throw new RpcError('INVALID_PARAMS', 'Invalid workspace job query')
  }
  return Object.freeze({ intent_id: value.intent_id })
}
