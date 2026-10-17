import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { VOICE_MODEL_VERSIONS } from './voice-models.js'
import { validateVoiceDeviceOwner, validateVoiceOwnerActivation, validateVoiceOwnerSaved } from './voice-wire.js'

const owner = () => ({ profile_id: randomUUID(), display_name: 'FuFu', model_id: VOICE_MODEL_VERSIONS.embedding })
const activation = () => ({ operation_id: randomUUID(), owner: owner(), platform_user_id: randomUUID(), registration_id: randomUUID(), status: 'pending' })
test('owner metadata never accepts vectors, roles or invented Friend authority', () => {
  validateVoiceDeviceOwner(owner())
  for (const field of ['friend_id', 'permission', 'values', 'credential', 'samples']) {
    assert.throws(() => validateVoiceDeviceOwner({ ...owner(), [field]: 'forged' }))
  }
  for (const display_name of ['', ' x ', 'a'.repeat(81), 'a\nb', 'a\u0085b', 1]) assert.throws(() => validateVoiceDeviceOwner({ ...owner(), display_name }))
  validateVoiceDeviceOwner({ ...owner(), display_name: '😀'.repeat(80) })
  assert.throws(() => validateVoiceDeviceOwner({ ...owner(), profile_id: 'not-a-profile' }))
  assert.throws(() => validateVoiceDeviceOwner({ ...owner(), model_id: 'other-model' }))
})
test('owner activation and saved receipt preserve exact stable references', () => {
  const value = activation()
  validateVoiceOwnerActivation(value)
  validateVoiceOwnerActivation({ ...value, status: 'completed' })
  assert.throws(() => validateVoiceOwnerActivation({ ...value, status: 'ready' }))
  assert.throws(() => validateVoiceOwnerActivation({ ...value, friend_id: randomUUID() }))
  for (const key of ['operation_id', 'platform_user_id', 'registration_id']) assert.throws(() => validateVoiceOwnerActivation({ ...value, [key]: 'bad' }))
  const saved = { operation_id: value.operation_id, profile_id: value.owner.profile_id, registration_id: value.registration_id, model_id: value.owner.model_id }
  validateVoiceOwnerSaved(saved)
  assert.throws(() => validateVoiceOwnerSaved({ ...saved, owner: value.owner }))
  assert.throws(() => validateVoiceOwnerSaved({ ...saved, model_id: 'other-model' }))
})
