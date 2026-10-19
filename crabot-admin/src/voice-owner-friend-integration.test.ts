import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { VOICE_MODEL_VERSIONS } from 'crabot-shared'
import AdminModule from './index.js'
import { commitVoiceOwnerMaster } from './voice-owner-master.js'

describe('Owner recovery and actual Admin Friend mutations', () => {
  let directory: string, admin: any, activation: any, friendId: string
  function module() {
    return new AdminModule({ moduleId: 'owner-friend-fixture', moduleType: 'admin', version: 'test', protocolVersion: '0.1.0', port: 0, subscriptions: [] }, { data_dir: directory, web_port: 0 }) as any
  }
  function binding(instance: any) {
    return { friends: () => [...instance.friends.values()], persist: instance.voiceAdmin.deps.persistFriend }
  }
  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'voice-owner-friend-'))
    admin = module(); admin.dataLoaded = true
    await admin.voiceAdmin.owners.load()
    friendId = randomUUID()
    activation = await admin.voiceAdmin.owners.prepareInitial('voice-fixture', randomUUID(), { profile_id: randomUUID(), display_name: 'Fixture', model_id: VOICE_MODEL_VERSIONS.embedding }, friendId, true)
    await admin.voiceAdmin.owners.acceptSaved('voice-fixture', { operation_id: activation.operation_id, profile_id: activation.owner.profile_id, registration_id: activation.registration_id, model_id: activation.owner.model_id })
    await commitVoiceOwnerMaster(admin.voiceAdmin.owners.record('voice-fixture'), binding(admin))
  })
  afterEach(async () => { vi.restoreAllMocks(); admin.voiceAdmin.stop(); await fs.rm(directory, { recursive: true, force: true }) })
  async function recover() {
    const restored = module(); restored.dataLoaded = true
    await restored.voiceAdmin.owners.load()
    for (const friend of JSON.parse(await fs.readFile(path.join(directory, 'friends.json'), 'utf8'))) restored.friends.set(friend.id, friend)
    const before = await fs.readFile(path.join(directory, 'friends.json'), 'utf8')
    await expect(commitVoiceOwnerMaster(restored.voiceAdmin.owners.record('voice-fixture'), binding(restored))).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(await fs.readFile(path.join(directory, 'friends.json'), 'utf8')).toBe(before)
    expect(restored.voiceAdmin.owners.record('voice-fixture').binding_revoked).toBe(true)
  }
  it('persists the real index and prevents restart recovery from relinking a human-unlinked identity', async () => {
    expect(admin.channelIdentityIndex.get(`voice-fixture:${activation.platform_user_id}`)).toBe(friendId)
    await admin.handleUnlinkChannelIdentity({ friend_id: friendId, channel_id: 'voice-fixture', platform_user_id: activation.platform_user_id })
    expect(admin.channelIdentityIndex.has(`voice-fixture:${activation.platform_user_id}`)).toBe(false)
    expect(admin.friends.get(friendId).channel_identities).toEqual([])
    await recover()
  })
  it('does not promote a Master downgraded through the real Admin mutation', async () => {
    await admin.handleUpdateFriend({ friend_id: friendId, permission: 'normal' })
    expect(admin.friends.get(friendId).permission).toBe('normal')
    await recover()
  })
  it('does not recreate a newly created Master after human downgrade and deletion', async () => {
    await admin.handleUpdateFriend({ friend_id: friendId, permission: 'normal' })
    await admin.handleDeleteFriend({ friend_id: friendId })
    expect(admin.friends.has(friendId)).toBe(false)
    await recover()
  })
  it('a failed withdrawal journal does not modify the Friend or its index', async () => {
    const before = await fs.readFile(path.join(directory, 'friends.json'), 'utf8')
    vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('injected journal failure'))
    await expect(admin.handleUnlinkChannelIdentity({ friend_id: friendId, channel_id: 'voice-fixture', platform_user_id: activation.platform_user_id })).rejects.toThrow('injected')
    expect(await fs.readFile(path.join(directory, 'friends.json'), 'utf8')).toBe(before)
    expect(admin.channelIdentityIndex.get(`voice-fixture:${activation.platform_user_id}`)).toBe(friendId)
    expect(admin.voiceAdmin.owners.record('voice-fixture').binding_revoked).toBe(false)
  })
})
