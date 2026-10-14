import { randomUUID } from 'node:crypto'
import { VoiceTurnStore } from '../crabot-admin/src/voice-turn-store.js'

export async function enrolledVoiceContact(store: VoiceTurnStore, channelId: string, epoch: string, displayName: string, modelId: string) {
  await store.sync({ channel_id: channelId, connection_epoch: epoch, foreground: true })
  const result = await store.manage(channelId, { request_id: randomUUID(), expected_revision: store.registrations(channelId).enrollment_revision, command: { action: 'enroll_new', display_name: displayName } }, modelId)
  const task = result.catalog.pending_enrollment!, registration = task.registration
  await store.sync({ channel_id: channelId, connection_epoch: epoch, foreground: true, completed_enrollment: { registration_id: registration.registration_id, model_id: modelId, enrollment_revision: task.enrollment_revision } })
  return { contact: store.registrations(channelId).contacts.find(c => c.platform_user_id === registration.platform_user_id)!, registration, revision: store.registrations(channelId).enrollment_revision }
}
export async function revokedVoiceSample(store: VoiceTurnStore, channelId: string, registrationId: string) {
  return store.manage(channelId, { request_id: randomUUID(), expected_revision: store.registrations(channelId).enrollment_revision, command: { action: 'delete_registration', registration_id: registrationId } }, 'unused-for-revocation')
}
