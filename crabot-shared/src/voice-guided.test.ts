import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseVoiceClientControl } from './voice-wire.js'
import { isSensitiveRpcCall } from './module-base.js'

const id = '00112233-4455-4677-8899-aabbccddeeff'
test('wire8 guided controls remain bounded and cannot claim identity or microphone authority', () => {
  for (const control of [
    { type: 'guided_prompt', operation_id: id, step: 1 },
    { type: 'guided_cancel', operation_id: id },
    { type: 'guided_playback', operation_id: id, playback_id: id, status: 'completed', played_samples: 24000 },
  ]) assert.deepEqual(parseVoiceClientControl(JSON.stringify(control)), control)
  for (const extra of [{ step: 0 }, { step: 4 }, { friend_id: id }, { permission: 'master' }, { connection_epoch: id }]) {
    assert.throws(() => parseVoiceClientControl(JSON.stringify({ type: 'guided_prompt', operation_id: id, step: 1, ...extra })))
  }
  assert.throws(() => parseVoiceClientControl(JSON.stringify({ type: 'guided_playback', operation_id: id, playback_id: id, status: 'completed' })))
})
test('voice request RPCs always use the sensitive transport', () => {
  for (const method of ['voice_agent_action', 'get_pending_voice_agent_operations']) assert.equal(isSensitiveRpcCall(method, {}), true)
})
