import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { VOICE_MODEL_VERSIONS, type Friend } from 'crabot-shared'
import type { VoiceOwnerActivationRecord } from './voice-owner-store.js'
import { commitVoiceOwnerMaster } from './voice-owner-master.js'

function fixture(existing = false) {
  const id = randomUUID(), channel = 'voice-fixture', now = new Date().toISOString()
  const record: VoiceOwnerActivationRecord = { channel_id: channel, mode: 'initial', pairing_id: randomUUID(), target_friend_id: id, create_master: !existing, master_was_present: existing, binding_revoked: false, samples_saved: true,
    activation: { operation_id: randomUUID(), owner: { profile_id: randomUUID(), display_name: 'Device name', model_id: VOICE_MODEL_VERSIONS.embedding }, platform_user_id: randomUUID(), registration_id: randomUUID(), status: 'pending' } }
  const master: Friend = { id, display_name: 'Existing Master name', permission: 'master', channel_identities: [{ channel_id: 'another-channel', platform_user_id: 'original' }], created_at: now, updated_at: now }
  const friends = new Map<string, Friend>(existing ? [[id, master]] : [])
  const persist = vi.fn(async (friend: Friend) => { friends.set(friend.id, structuredClone(friend)) })
  const deps = { friends: () => [...friends.values()], persist }
  return { record, master, friends, deps, persist }
}
describe('Voice owner Master binding transaction', () => {
  it('creates exactly the reserved Master only when the initial human basis allowed creation', async () => {
    const f = fixture()
    expect(await commitVoiceOwnerMaster(f.record, f.deps)).toBe(f.record.target_friend_id)
    const first = structuredClone([...f.friends.values()])
    expect(first).toHaveLength(1); expect(first[0]).toMatchObject({ id: f.record.target_friend_id, permission: 'master', display_name: 'Device name', channel_identities: [{ channel_id: f.record.channel_id, platform_user_id: f.record.activation.platform_user_id }] })
    await commitVoiceOwnerMaster(f.record, f.deps)
    expect([...f.friends.values()]).toEqual(first)
  })
  it('appends the new channel to the existing Master while preserving its identity, name and other channels', async () => {
    const f = fixture(true)
    await commitVoiceOwnerMaster(f.record, f.deps)
    const updated = f.friends.get(f.master.id)!
    expect(updated).toMatchObject({ id: f.master.id, display_name: f.master.display_name, permission: 'master', created_at: f.master.created_at })
    expect(updated.channel_identities).toEqual([...f.master.channel_identities, { channel_id: f.record.channel_id, platform_user_id: f.record.activation.platform_user_id, platform_display_name: f.record.activation.owner.display_name }])
  })
  it('never overwrites an existing identity in the same channel', async () => {
    const f = fixture(true)
    f.master.channel_identities.push({ channel_id: f.record.channel_id, platform_user_id: 'old-owner' })
    await expect(commitVoiceOwnerMaster(f.record, f.deps)).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(f.persist).not.toHaveBeenCalled(); expect(f.master.channel_identities[1].platform_user_id).toBe('old-owner')
  })
  it('does not recreate an existing Master that was deleted or downgraded after confirmation', async () => {
    for (const state of ['deleted', 'normal']) {
      const f = fixture(true)
      if (state === 'deleted') f.friends.delete(f.master.id)
      else f.master.permission = 'normal'
      await expect(commitVoiceOwnerMaster(f.record, f.deps)).rejects.toMatchObject({ code: 'CONFLICT' })
      expect(f.persist).not.toHaveBeenCalled()
    }
  })
  it('rejects another Master or another Friend already owning the reserved contact', async () => {
    for (const role of ['master', 'normal'] as const) {
      const f = fixture()
      const other = { ...f.master, id: randomUUID(), permission: role, channel_identities: role === 'normal' ? [{ channel_id: f.record.channel_id, platform_user_id: f.record.activation.platform_user_id }] : [] }
      f.friends.set(other.id, other)
      await expect(commitVoiceOwnerMaster(f.record, f.deps)).rejects.toMatchObject({ code: 'CONFLICT' })
      expect(f.persist).not.toHaveBeenCalled()
    }
  })
  it('a lost disk result retries the same Friend and does not produce a second Master', async () => {
    const f = fixture()
    f.persist.mockImplementationOnce(async friend => { f.friends.set(friend.id, structuredClone(friend)); throw new Error('injected disk failure') })
    await expect(commitVoiceOwnerMaster(f.record, f.deps)).rejects.toThrow('injected')
    await commitVoiceOwnerMaster(f.record, f.deps)
    expect(f.friends.size).toBe(1); expect(f.friends.get(f.record.target_friend_id)?.permission).toBe('master')
  })
  it('rechecks the current Master after awaiting persistence', async () => {
    const f = fixture(true)
    f.persist.mockImplementationOnce(async friend => { f.friends.set(friend.id, { ...friend, permission: 'normal' }) })
    await expect(commitVoiceOwnerMaster(f.record, f.deps)).rejects.toMatchObject({ code: 'CONFLICT' })
  })
  it('legacy adoption only verifies the already-bound Master and never writes a new identity', async () => {
    const f = fixture(true); f.record.mode = 'legacy'; f.record.pairing_id = null
    await expect(commitVoiceOwnerMaster(f.record, f.deps)).rejects.toMatchObject({ code: 'CONFLICT' })
    f.master.channel_identities.push({ channel_id: f.record.channel_id, platform_user_id: f.record.activation.platform_user_id })
    expect(await commitVoiceOwnerMaster(f.record, f.deps)).toBe(f.master.id)
    expect(f.persist).not.toHaveBeenCalled()
  })
  it('never recreates a newly committed Master or identity removed by a later human action', async () => {
    const f = fixture(); await commitVoiceOwnerMaster(f.record, f.deps)
    f.record.master_was_present = true; f.record.binding_revoked = true
    f.friends.delete(f.record.target_friend_id)
    await expect(commitVoiceOwnerMaster(f.record, f.deps)).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(f.friends.size).toBe(0)
  })
  it('does not bind anything before the device receipt has been durably accepted', async () => {
    const f = fixture(); f.record.samples_saved = false
    await expect(commitVoiceOwnerMaster(f.record, f.deps)).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(f.persist).not.toHaveBeenCalled()
  })
})
