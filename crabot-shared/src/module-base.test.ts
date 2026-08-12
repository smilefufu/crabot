import assert from 'node:assert/strict'
import test from 'node:test'
import { isSensitiveRpcCall } from './module-base.js'

test('sensitive RPC classifier requires no-trace transport', () => {
  assert.equal(isSensitiveRpcCall('get_agent_config', {}), true)
  assert.equal(isSensitiveRpcCall('verify_core_agent_runtime', {}), true)
  assert.equal(isSensitiveRpcCall('process_message', { source_type: 'admin_chat' }), true)
})

test('ordinary Channel process_message remains non-sensitive', () => {
  assert.equal(isSensitiveRpcCall('process_message', { source_type: 'channel' }), false)
  assert.equal(isSensitiveRpcCall('health', {}), false)
})
