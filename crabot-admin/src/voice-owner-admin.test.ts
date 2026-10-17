import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RpcError, VOICE_MODEL_VERSIONS, type Friend, type VoiceDeviceOwner, type VoiceOwnerActivation } from 'crabot-shared'
import { VoiceAdmin, type VoiceAdminDeps } from './voice-admin.js'
import { enrolledVoiceContact } from '../../tests/voice-fixture.js'

describe('Voice owner activation through trusted Admin entrypoints', () => {
  const channel = 'owner-fixture', human = 'human-fixture', runtime = 'child-fixture'
  let directory: string, admin: VoiceAdmin, deps: VoiceAdminDeps, epoch: string, pairing: string, profile: VoiceDeviceOwner
  let friends: Map<string, Friend>, instance: any, pairedActivation: VoiceOwnerActivation | undefined
  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'voice-owner-admin-')); friends = new Map(); epoch = randomUUID(); pairing = randomUUID()
    profile = { profile_id: randomUUID(), display_name: 'Owner fixture', model_id: VOICE_MODEL_VERSIONS.embedding }
    instance = { id: channel, implementation_id: 'channel-voice', auto_start: false, voice_setup: { status: 'draft', owner_activation_required: true } }
    deps = {
      isVoice: id => id === channel, instance: () => instance, createInstance: vi.fn(), resumeInstance: vi.fn(), pauseInstance: vi.fn(), saveSetup: vi.fn(),
      fingerprint: () => undefined, terminalHosts: () => [], closeGateway: vi.fn(), admissionReady: () => true, ownerReady: () => true,
      friends: () => [...friends.values()], persistFriend: vi.fn(async friend => { friends.set(friend.id, structuredClone(friend)); await fs.writeFile(path.join(directory, 'friends-fixture.json'), JSON.stringify([...friends.values()])) }),
      verifyRuntime: async (_, bearer) => { if (bearer !== runtime) throw new RpcError('FORBIDDEN', 'current child required') },
      verifyCore: vi.fn(), verifyHuman: async bearer => { if (bearer !== human) throw new RpcError('FORBIDDEN', 'human required') },
      resolveFriend: (id, contact) => [...friends.values()].find(friend => friend.channel_identities.some(identity => identity.channel_id === id && identity.platform_user_id === contact)),
      checkGroup: async () => true,
      channelAction: vi.fn(async (_, command, __, activation) => {
        if (command.action === 'status') return { action: 'status', state: { pairing_id: pairing, pairing_owner: profile, owner_activation: null, hosts: [] } } as never
        if (command.action === 'confirm_pairing') { pairedActivation = activation; return { action: 'confirm_pairing', confirmed: true } }
        throw new Error('unexpected action')
      }), publish: vi.fn(), configurationChanged: vi.fn(), testAudio: vi.fn(), enrollmentModelId: VOICE_MODEL_VERSIONS.embedding,
    }
    admin = new VoiceAdmin(directory, deps); await admin.load()
    await admin.sync({ channel_id: channel, connection_epoch: epoch, foreground: true }, runtime)
  })
  afterEach(async () => { admin.stop(); vi.restoreAllMocks(); await fs.rm(directory, { recursive: true, force: true }) })
  async function confirm() { await admin.action(channel, { action: 'confirm_pairing', pairing_id: pairing }, human); return pairedActivation! }
  async function saved(activation: VoiceOwnerActivation, connection = epoch, bearer = runtime) {
    return admin.sync({ channel_id: channel, connection_epoch: connection, foreground: true, owner_saved: { operation_id: activation.operation_id, profile_id: activation.owner.profile_id, registration_id: activation.registration_id, model_id: activation.owner.model_id } }, bearer)
  }
  it('human confirmation reserves only; current foreground saved receipt completes contact and the unique Master', async () => {
    const activation = await confirm()
    expect(activation.status).toBe('pending'); expect(friends.size).toBe(0)
    expect((await admin.getConfig({ channel_id: channel }, runtime)).contacts).toEqual([])
    expect(admin.turns.catalog(channel).contacts).toEqual([])
    await expect(admin.submit({ channel_id: channel }, runtime)).rejects.toThrow(/所有者/)
    const result = await saved(activation)
    expect(result.owner_activation).toEqual({ ...activation, status: 'completed' })
    const config = await admin.getConfig({ channel_id: channel }, runtime)
    expect(config.owner_activation_required).toBe(true); expect(config.contacts).toHaveLength(1)
    expect(config.registrations[0]).toMatchObject({ registration_id: activation.registration_id, status: 'active', platform_user_id: activation.platform_user_id })
    const master = [...friends.values()][0]
    expect(master.permission).toBe('master'); expect(config.contacts[0].friend_id).toBe(master.id)
    await saved(activation); expect(friends.size).toBe(1); expect(admin.turns.catalog(channel).contacts).toHaveLength(1)
  })
  it('an existing global Master keeps its ID, name and old identities', async () => {
    const now = new Date().toISOString()
    const master: Friend = { id: randomUUID(), display_name: 'Original Master', permission: 'master', channel_identities: [{ channel_id: 'other', platform_user_id: 'original' }], created_at: now, updated_at: now }
    friends.set(master.id, master)
    const activation = await confirm(); await saved(activation)
    expect(friends.size).toBe(1); expect(friends.get(master.id)).toMatchObject({ display_name: master.display_name, created_at: now })
    expect(friends.get(master.id)?.channel_identities[0]).toEqual(master.channel_identities[0])
  })
  it('runtime/core cannot prepare activation, invent a saved mapping or use a different epoch', async () => {
    await expect(admin.action(channel, { action: 'confirm_pairing', pairing_id: pairing }, runtime)).rejects.toThrow('human')
    await expect(admin.action(channel, { action: 'confirm_pairing', pairing_id: pairing, owner_activation: {} }, human)).rejects.toThrow('Unknown')
    const activation = await confirm()
    await expect(saved(activation, randomUUID())).rejects.toThrow(/前台|连接/)
    await expect(saved({ ...activation, registration_id: randomUUID() })).rejects.toThrow()
    await expect(saved(activation, epoch, human)).rejects.toThrow('child')
    expect(friends.size).toBe(0)
  })
  it('failed Friend persistence leaves a recoverable pending operation and no public contact', async () => {
    const activation = await confirm()
    const persist = deps.persistFriend
    deps.persistFriend = vi.fn(async friend => { await persist(friend); throw new Error('injected lost commit result') })
    await expect(saved(activation)).rejects.toThrow('injected')
    expect(admin.owners.get(channel)?.status).toBe('pending')
    expect((await admin.getConfig({ channel_id: channel }, runtime)).contacts).toEqual([])
    deps.persistFriend = persist
    const restored = new VoiceAdmin(directory, deps); await restored.load(); admin = restored
    await admin.replayPending()
    expect(admin.owners.get(channel)?.status).toBe('completed'); expect(friends.size).toBe(1)
    expect(admin.turns.catalog(channel).contacts[0].platform_user_id).toBe(activation.platform_user_id)
  })
  it('same-channel conflict never overwrites the existing Master identity', async () => {
    const now = new Date().toISOString()
    const master: Friend = { id: randomUUID(), display_name: 'Original', permission: 'master', channel_identities: [{ channel_id: channel, platform_user_id: randomUUID() }], created_at: now, updated_at: now }
    friends.set(master.id, master)
    await expect(confirm()).rejects.toThrow(/同渠道|冲突/)
    expect(friends.get(master.id)).toEqual(master); expect(admin.owners.get(channel)).toBeNull()
  })
  it('legacy adoption offers only an existing Master contact and never creates a new identity', async () => {
    delete instance.voice_setup.owner_activation_required
    const { contact } = await enrolledVoiceContact(admin.turns, channel, epoch, 'Legacy owner', VOICE_MODEL_VERSIONS.embedding)
    const now = new Date().toISOString()
    const master: Friend = { id: randomUUID(), display_name: 'Original', permission: 'master', channel_identities: [{ channel_id: channel, platform_user_id: contact.platform_user_id }], created_at: now, updated_at: now }
    friends.set(master.id, master)
    const [config, concurrent] = await Promise.all([admin.getConfig({ channel_id: channel }, runtime), admin.getConfig({ channel_id: channel }, runtime)])
    const activation = config.owner_activation!
    expect(concurrent.owner_activation).toEqual(activation)
    expect(config.owner_activation_required).toBe(false); expect(activation.platform_user_id).toBe(contact.platform_user_id)
    await saved(activation)
    expect(friends.get(master.id)).toEqual(master); expect(deps.persistFriend).not.toHaveBeenCalled()
    expect(admin.turns.catalog(channel).contacts).toHaveLength(1)
  })
  it('legacy recovery retains the owner operation while an explicit rerecord replaces its active sample', async () => {
    delete instance.voice_setup.owner_activation_required
    const { contact } = await enrolledVoiceContact(admin.turns, channel, epoch, 'Legacy owner', VOICE_MODEL_VERSIONS.embedding)
    const now = new Date().toISOString()
    const master: Friend = { id: randomUUID(), display_name: 'Original', permission: 'master', channel_identities: [{ channel_id: channel, platform_user_id: contact.platform_user_id }], created_at: now, updated_at: now }
    friends.set(master.id, master)
    const activation = (await admin.getConfig({ channel_id: channel }, runtime)).owner_activation!
    const managed = await admin.manageContacts({ channel_id: channel, connection_epoch: epoch, request: { request_id: randomUUID(), expected_revision: admin.turns.catalog(channel).enrollment_revision, command: { action: 'enroll', platform_user_id: contact.platform_user_id } } }, runtime)
    const task = managed.catalog.pending_enrollment!
    await admin.sync({ channel_id: channel, connection_epoch: epoch, foreground: true, completed_enrollment: { registration_id: task.registration.registration_id, model_id: task.registration.model_id, enrollment_revision: task.enrollment_revision } }, runtime)
    expect((await saved(activation)).owner_activation).toEqual({ ...activation, status: 'completed' })
    expect(admin.turns.catalog(channel).registrations.filter(value => value.status === 'active').map(value => value.registration_id)).toEqual([task.registration.registration_id])
    expect(admin.owners.get(channel)?.registration_id).toBe(activation.registration_id)
    expect(friends.get(master.id)).toEqual(master)
  })
  it('startup recovery waits for the real Friend maps to load', async () => {
    const activation = await confirm()
    await admin.owners.acceptSaved(channel, { operation_id: activation.operation_id, profile_id: profile.profile_id, registration_id: activation.registration_id, model_id: profile.model_id })
    deps.ownerReady = () => false
    await admin.replayPending(); expect(friends.size).toBe(0); expect(admin.owners.get(channel)?.status).toBe('pending')
    deps.ownerReady = () => true
    await admin.replayPending(); expect(admin.owners.get(channel)?.status).toBe('completed')
  })
})
