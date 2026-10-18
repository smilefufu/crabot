import { afterEach, beforeEach, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { voiceSessionId } from 'crabot-shared'
import { VoiceTurnStore } from './voice-turn-store.js'

let root: string, store: VoiceTurnStore
const channel = 'voice-fixture', epoch = randomUUID()
const context = { delivery: 'origin' as const, request_id: 'a'.repeat(64), turn_id: randomUUID(), source: { source_id: randomUUID(), channel_id: channel,
  session_id: voiceSessionId(channel), session_type: 'group' as const, platform_message_id: 'message', platform_user_id: randomUUID(), sender_friend_id: 'master-fixture' } }
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'voice-agent-')); store = new VoiceTurnStore(root); await store.load(); await store.sync({ channel_id: channel, connection_epoch: epoch, foreground: true }) })
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }) })

async function begin() {
  const request = { request_id: randomUUID(), expected_revision: 0, command: { action: 'enroll_new' as const, display_name: 'Synthetic guest' } }
  const result = await store.manage(channel, request, 'fixture-model', false, epoch,
    { context, connection_epoch: epoch, friend_id: randomUUID(), create_friend: true, sampled: false, acknowledged: false })
  const task = result.catalog.pending_enrollment!
  return { request, task, ack: { registration_id: task.registration.registration_id, model_id: 'fixture-model', enrollment_revision: task.enrollment_revision } }
}
it('sample acceptance stays pending and invisible until the original host commits; accepted samples survive timeout/restart', async () => {
  const { request, task, ack } = await begin()
  await store.sync({ channel_id: channel, connection_epoch: epoch, foreground: true, completed_enrollment: ack })
  expect(store.catalog(channel).contacts).toEqual([])
  expect(store.catalog(channel).registrations.find(r => r.registration_id === ack.registration_id)?.status).toBe('pending')
  expect(store.managementResult(channel, request.request_id).status).toBe('pending')
  const saved = new VoiceTurnStore(root); await saved.load()
  await saved.commitAgentEnrollment(channel, request.request_id)
  await saved.commitAgentEnrollment(channel, request.request_id)
  expect(saved.catalog(channel).contacts).toEqual([{ platform_user_id: task.registration.platform_user_id, display_name: 'Synthetic guest' }])
  expect(saved.managementResult(channel, request.request_id).status).toBe('completed')
})
it('ordinary terminal completion keeps its existing semantics', async () => {
  const request = { request_id: randomUUID(), expected_revision: 0, command: { action: 'enroll_new' as const, display_name: 'Button guest' } }
  const result = await store.manage(channel, request, 'fixture-model', false, epoch), task = result.catalog.pending_enrollment!
  await store.sync({ channel_id: channel, connection_epoch: epoch, foreground: true, completed_enrollment: { registration_id: task.registration.registration_id, model_id: 'fixture-model', enrollment_revision: task.enrollment_revision } })
  expect(store.managementResult(channel, request.request_id).status).toBe('completed')
})
it('never activates an unsampled request and preserves old-format data when migration backup conflicts', async () => {
  const { request } = await begin()
  await expect(store.commitAgentEnrollment(channel, request.request_id)).rejects.toThrow()
  expect(store.catalog(channel).contacts).toEqual([])
  const file = path.join(root, 'voice-turns.json')
  const v3 = JSON.stringify({ version: 3, channels: {}, turns: {} })
  await fs.writeFile(file, v3); await fs.writeFile(file + '.v3.bak', 'different backup')
  await expect(new VoiceTurnStore(root).load()).rejects.toThrow()
  expect(await fs.readFile(file, 'utf8')).toBe(v3)
})
