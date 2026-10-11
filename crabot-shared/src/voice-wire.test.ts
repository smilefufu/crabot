import assert from 'node:assert/strict'
import { test } from 'node:test'
import { encodeVoiceFrame, parseVoiceClientControl, validateVoiceSegments, validateSubmitVoiceTurn, VoiceInputBuffer } from './voice-wire.js'
import { isSensitiveRpcCall, RpcClient } from './module-base.js'

const id = '00112233-4455-6677-8899-aabbccddeeff'
const other = 'ffeeddcc-bbaa-9988-7766-554433221100'
test('PCM wire golden header and final short frame round trip', () => {
  const buffer = new VoiceInputBuffer(id)
  const frame = encodeVoiceFrame(1, id, 0, Buffer.alloc(640, 7))
  assert.equal(frame.subarray(0, 21).toString('hex'), '0100112233445566778899aabbccddeeff00000000')
  buffer.append(frame)
  buffer.append(encodeVoiceFrame(1, id, 1, Buffer.alloc(20, 9)))
  assert.equal(buffer.finish(330).length, 660)
  assert.throws(() => buffer.finish(330))
})
test('audio rejects wrong turn, sequence, kind, empty frame and frames after a short tail', () => {
  for (const frame of [encodeVoiceFrame(1, other, 0, Buffer.alloc(640)), encodeVoiceFrame(1, id, 1, Buffer.alloc(640)), encodeVoiceFrame(2, id, 0, Buffer.alloc(640)), Buffer.alloc(21)]) {
    assert.throws(() => new VoiceInputBuffer(id).append(frame))
  }
  const buffer = new VoiceInputBuffer(id)
  buffer.append(encodeVoiceFrame(1, id, 0, Buffer.alloc(2)))
  assert.throws(() => buffer.append(encodeVoiceFrame(1, id, 1, Buffer.alloc(640))))
  assert.throws(() => buffer.finish(2))
})
test('a 15 second turn cannot accumulate another frame', () => {
  const buffer = new VoiceInputBuffer(id)
  for (let i = 0; i < 750; i++) buffer.append(encodeVoiceFrame(1, id, i, Buffer.alloc(640)))
  assert.throws(() => buffer.append(encodeVoiceFrame(1, id, 750, Buffer.alloc(2))))
  buffer.clear()
})
test('speaker segments retain A B A and reject overlapping, fractional or misindexed boundaries', () => {
  const segments = ['A', 'B', 'A'].map((speaker, i) => ({ segment_index: i, start_sample: i * 16000, end_sample: (i + 1) * 16000, anonymous_speaker: speaker, identity_status: 'matched', registration_id: speaker }))
  validateVoiceSegments(segments, 48000)
  for (const patch of [{ start_sample: 15999 }, { start_sample: 16000.5 }, { segment_index: 0 }, { registration_id: undefined }]) {
    assert.throws(() => validateVoiceSegments([segments[0], { ...segments[1], ...patch }, segments[2]], 48000))
  }
  validateVoiceSegments([{ ...segments[0], identity_status: 'unknown', registration_id: undefined }].map(({ registration_id, ...rest }) => rest), 16000)
})
test('controls reject extra identity fields, wrong versions and oversized input', () => {
  assert.deepEqual(parseVoiceClientControl(JSON.stringify({ type: 'turn_start', turn_id: id })), { type: 'turn_start', turn_id: id })
  for (const value of [{ type: 'turn_start', turn_id: id, friend_id: 'master' }, { type: 'pair', protocol_version: 2, nonce: 'test' }, { type: 'heartbeat', foreground: 'true', microphone: 'closed', playback: 'idle' }]) {
    assert.throws(() => parseVoiceClientControl(JSON.stringify(value)))
  }
  assert.throws(() => parseVoiceClientControl(' '.repeat(65537)))
})
test('submission rejects sender-supplied Friend, partial session and non-text instructions', () => {
  const params = { channel_id: '客厅', session_id: 'household-session', turn_id: id, connection_epoch: other, enrollment_revision: 1, messages: [{ platform_message_id: id + ':0', session: { channel_id: '客厅', session_id: 'household-session', type: 'group' }, sender: { platform_user_id: 'registered-a', platform_display_name: 'A' }, content: { type: 'text', text: '不要开灯' }, features: { is_mention_crab: true, voice: { turn_id: id, segment_index: 0, start_sample: 0, end_sample: 16000, anonymous_speaker: '0' } }, platform_timestamp: '2026-10-10T00:00:00.000Z' }] }
  validateSubmitVoiceTurn(params)
  for (const change of [(p: typeof params) => Object.assign(p.messages[0].sender, { friend_id: 'master' }), (p: typeof params) => p.messages[0].session.type = 'private', (p: typeof params) => p.messages[0].content.type = 'system_event']) {
    const copy = structuredClone(params); change(copy); assert.throws(() => validateSubmitVoiceTurn(copy))
  }
})
test('all voice runtime RPC methods require the no-trace transport', async () => {
  const client = new RpcClient()
  for (const method of ['sync_voice_terminal', 'get_voice_config', 'submit_voice_turn', 'get_voice_turn_status', 'confirm_voice_turn', 'verify_voice_runtime', 'register_voice_runtime', 'voice_admin_action', 'verify_voice_admin']) {
    assert.equal(isSensitiveRpcCall(method, {}), true)
    await assert.rejects(client.call(1, method, {}, 'forged-source'), /callSensitive/)
  }
})
