import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseVoiceClientControl, validateVoiceManagementRequest } from './voice-wire.js'

const id = '00112233-4455-4677-8899-aabbccddeeff'
test('v5 terminal management accepts only scoped commands and exact request fields', () => {
  const request = { request_id: id, expected_revision: 1, command: { action: 'enroll_new', display_name: 'User' } }
  validateVoiceManagementRequest(request)
  assert.deepEqual(parseVoiceClientControl(JSON.stringify({ type: 'contact_action', request })), { type: 'contact_action', request })
  for (const extra of [{ channel_id: 'other' }, { friend_id: 'master' }, { vector: [1, 2] }, { permission: 'master' }]) assert.throws(() => validateVoiceManagementRequest({ ...request, command: { ...request.command, ...extra } }))
  assert.throws(() => validateVoiceManagementRequest({ ...request, expected_revision: -1 }))
  assert.throws(() => parseVoiceClientControl(JSON.stringify({ type: 'pair', protocol_version: 4, nonce: 'legacy' })))
  assert.deepEqual(parseVoiceClientControl(JSON.stringify({ type: 'catalog_applied', enrollment_revision: 2 })), { type: 'catalog_applied', enrollment_revision: 2 })
})
