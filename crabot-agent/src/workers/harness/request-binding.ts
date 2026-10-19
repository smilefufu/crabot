import type { ConversationRequestBinding } from '../../manager/conversation-request.js'

/** Structural check only; execution still verifies the actual request and original source. */
export function assertConversationRequestBinding(value: unknown): asserts value is ConversationRequestBinding {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Worker request binding')
  const binding = value as Record<string, unknown>, keys = ['schema_version', 'request_id', 'source_sha256', 'execution_scope']
  if (Object.keys(binding).length !== keys.length || !keys.every(key => Object.prototype.hasOwnProperty.call(binding, key)) || binding.schema_version !== 1
    || typeof binding.request_id !== 'string' || !/^[0-9a-f]{64}$/.test(binding.request_id)
    || typeof binding.source_sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(binding.source_sha256)
    || !['group', 'request'].includes(String(binding.execution_scope))) throw new Error('Invalid Worker request binding')
}
