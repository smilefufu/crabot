import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseVoiceClientControl } from './voice-wire.js'
import { isSensitiveRpcCall } from './module-base.js'

const id = '00112233-4455-6677-8899-aabbccddeeff'
const parse = (value: unknown) => parseVoiceClientControl(JSON.stringify(value))
test('feedback heartbeat distinguishes temporary closed microphone from explicit mute', () => {
  for (const speech_enabled of [true, false]) for (const activity of ['idle', 'recording', 'processing', 'answering', 'management']) {
    const value = { type: 'heartbeat', foreground: true, microphone: 'closed', playback: 'idle', enrollment_revision: 0, speech_enabled, activity }
    assert.deepEqual(parse(value), value)
  }
  assert.throws(() => parse({ type: 'heartbeat', foreground: true, microphone: 'closed', playback: 'idle', enrollment_revision: 0 }))
  assert.throws(() => parse({ type: 'heartbeat', foreground: true, microphone: 'closed', playback: 'idle', enrollment_revision: 0, speech_enabled: 'yes', activity: 'idle' }))
})
test('playback reservation requires an explicit boolean and stable UUID', () => {
  assert.deepEqual(parse({ type: 'playback_ready', playback_id: id, accepted: false }), { type: 'playback_ready', playback_id: id, accepted: false })
  for (const accepted of [undefined, 'true', 1]) assert.throws(() => parse({ type: 'playback_ready', playback_id: id, accepted }))
  assert.throws(() => parse({ type: 'playback_ready', playback_id: 'old-turn', accepted: true }))
})
test('feedback state and receipt RPCs stay in the no-trace closure', () => {
  assert.equal(isSensitiveRpcCall('get_voice_output_state'), true)
  assert.equal(isSensitiveRpcCall('get_voice_playback_receipt'), true)
})
