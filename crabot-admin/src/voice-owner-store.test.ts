import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { VOICE_MODEL_VERSIONS, type VoiceOwnerActivation } from 'crabot-shared'
import { VoiceOwnerStore } from './voice-owner-store.js'

const owner = () => ({ profile_id: randomUUID(), display_name: 'Owner fixture', model_id: VOICE_MODEL_VERSIONS.embedding })
const receipt = (value: VoiceOwnerActivation) => ({ operation_id: value.operation_id, profile_id: value.owner.profile_id, registration_id: value.registration_id, model_id: value.owner.model_id })
const directories: string[] = []
async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'voice-owner-store-')); directories.push(directory)
  const store = new VoiceOwnerStore(directory); await store.load()
  return { store, directory, file: path.join(directory, 'voice-owner-activations.json') }
}
afterEach(async () => { vi.restoreAllMocks(); for (const directory of directories.splice(0)) await fs.rm(directory, { recursive: true, force: true }) })

describe('Voice owner durable activation facts', () => {
  it('reserves stable IDs without claiming a sample, Friend or completed identity', async () => {
    const f = await fixture(); const profile = owner(); const master = randomUUID()
    const first = await f.store.prepareInitial('voice-a', randomUUID(), profile, master, false)
    const again = await f.store.prepareInitial('voice-a', randomUUID(), profile, master, false)
    expect(again).toEqual(first); expect(first.status).toBe('pending')
    expect(f.store.get('unknown')).toBeNull(); expect(f.store.pendingBindings()).toEqual([])
    const restored = new VoiceOwnerStore(f.directory); await restored.load()
    expect(restored.get('voice-a')).toEqual(first)
    expect(restored.record('voice-a')).toMatchObject({ mode: 'initial', target_friend_id: master, samples_saved: false })
  })
  it('serializes initial activation and never replaces a different profile or Master', async () => {
    const f = await fixture(); const profile = owner(); const master = randomUUID()
    const [a, b] = await Promise.all([f.store.prepareInitial('voice-a', randomUUID(), profile, master, false), f.store.prepareInitial('voice-a', randomUUID(), profile, master, false)])
    expect(a).toEqual(b)
    await expect(f.store.prepareInitial('voice-a', randomUUID(), owner(), master, false)).rejects.toMatchObject({ code: 'CONFLICT' })
    await expect(f.store.prepareInitial('voice-a', randomUUID(), profile, randomUUID(), false)).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(f.store.get('voice-a')).toEqual(a)
  })
  it('persists whether initial activation was allowed to create a new global Master', async () => {
    const f = await fixture(); const profile = owner(); const master = randomUUID()
    await f.store.prepareInitial('voice-new', randomUUID(), profile, master, true)
    const restored = new VoiceOwnerStore(f.directory); await restored.load()
    expect(restored.record('voice-new')).toMatchObject({ target_friend_id: master, create_master: true })
    await expect(restored.prepareInitial('voice-new', randomUUID(), profile, master, false)).rejects.toMatchObject({ code: 'CONFLICT' })
  })
  it('accepts only the original saved mapping, and cannot complete before its durable receipt', async () => {
    const f = await fixture(); const master = randomUUID()
    const activation = await f.store.prepareInitial('voice-a', randomUUID(), owner(), master, false)
    await expect(f.store.complete('voice-a', master)).rejects.toThrow()
    const saved = receipt(activation)
    for (const field of ['operation_id', 'profile_id', 'registration_id']) await expect(f.store.acceptSaved('voice-a', { ...saved, [field]: randomUUID() })).rejects.toThrow()
    await expect(f.store.acceptSaved('voice-b', saved)).rejects.toThrow()
    await f.store.acceptSaved('voice-a', saved)
    expect(f.store.pendingBindings()).toHaveLength(1)
    await expect(f.store.complete('voice-a', randomUUID())).rejects.toMatchObject({ code: 'CONFLICT' })
    await f.store.complete('voice-a', master)
    expect(f.store.get('voice-a')?.status).toBe('completed'); expect(f.store.pendingBindings()).toEqual([])
    await f.store.acceptSaved('voice-a', saved); await f.store.complete('voice-a', master)
    expect(f.store.get('voice-a')).toEqual({ ...activation, status: 'completed' })
  })
  it('preserves an accepted receipt across restart so final binding can resume with original IDs', async () => {
    const f = await fixture(); const master = randomUUID()
    const activation = await f.store.prepareInitial('voice-a', randomUUID(), owner(), master, false)
    await f.store.acceptSaved('voice-a', receipt(activation))
    const restored = new VoiceOwnerStore(f.directory); await restored.load()
    expect(restored.pendingBindings()[0]).toMatchObject({ target_friend_id: master, activation })
    await restored.complete('voice-a', master)
    expect(restored.get('voice-a')).toEqual({ ...activation, status: 'completed' })
  })
  it('failed disk commit preserves memory and durable facts, and does not poison later retries', async () => {
    const f = await fixture(); const master = randomUUID()
    const activation = await f.store.prepareInitial('voice-a', randomUUID(), owner(), master, false)
    const before = await fs.readFile(f.file)
    vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('injected rename failure'))
    await expect(f.store.acceptSaved('voice-a', receipt(activation))).rejects.toThrow('injected')
    expect(f.store.pendingBindings()).toEqual([]); expect(await fs.readFile(f.file)).toEqual(before)
    expect((await fs.readdir(f.directory)).filter(name => name.endsWith('.tmp'))).toEqual([])
    await f.store.acceptSaved('voice-a', receipt(activation))
    vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('injected final failure'))
    await expect(f.store.complete('voice-a', master)).rejects.toThrow('injected')
    expect(f.store.get('voice-a')?.status).toBe('pending')
    const restored = new VoiceOwnerStore(f.directory); await restored.load()
    await restored.complete('voice-a', master)
    expect(restored.get('voice-a')).toEqual({ ...activation, status: 'completed' })
  })
  it('staging cleanup failure never masks the original commit failure or changes the accepted state', async () => {
    const f = await fixture(); const master = randomUUID()
    const activation = await f.store.prepareInitial('voice-a', randomUUID(), owner(), master, false)
    vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('original commit failure'))
    vi.spyOn(fs, 'rm').mockRejectedValueOnce(new Error('cleanup failure'))
    await expect(f.store.acceptSaved('voice-a', receipt(activation))).rejects.toThrow('original commit failure')
    expect(f.store.pendingBindings()).toEqual([])
    expect(f.store.get('voice-a')).toEqual(activation)
  })
  it('new human pairing preserves identity IDs but requires saving the rotated credential again', async () => {
    const f = await fixture(); const profile = owner(); const master = randomUUID(); const pairing = randomUUID()
    const activation = await f.store.prepareInitial('voice-a', pairing, profile, master, true)
    await f.store.acceptSaved('voice-a', receipt(activation))
    await f.store.prepareInitial('voice-a', pairing, profile, master, true)
    expect(f.store.record('voice-a')?.samples_saved).toBe(true)
    expect(await f.store.prepareInitial('voice-a', randomUUID(), profile, master, true)).toEqual(activation)
    expect(f.store.record('voice-a')?.samples_saved).toBe(false)
    await expect(f.store.complete('voice-a', master)).rejects.toThrow()
    await f.store.acceptSaved('voice-a', receipt(activation)); await f.store.complete('voice-a', master)
    expect(f.store.get('voice-a')?.status).toBe('completed')
  })
  it('legacy adoption uses explicit existing IDs and remains distinct from initial auto-binding', async () => {
    const f = await fixture(); const master = randomUUID(); const contact = randomUUID(); const registration = randomUUID(); const profile = owner()
    const activation = await f.store.prepareLegacy('voice-old', profile, master, contact, registration)
    expect(activation).toMatchObject({ platform_user_id: contact, registration_id: registration, status: 'pending' })
    expect(f.store.record('voice-old')?.mode).toBe('legacy')
    await expect(f.store.prepareInitial('voice-old', randomUUID(), profile, master, false)).rejects.toMatchObject({ code: 'CONFLICT' })
    await f.store.acceptSaved('voice-old', receipt(activation)); await f.store.complete('voice-old', master)
    expect(f.store.get('voice-old')?.status).toBe('completed')
  })
  it('journals a pending identity removal before the Friend mutation and blocks late completion', async () => {
    const f = await fixture(); const profile = owner(); const master = randomUUID()
    const activation = await f.store.prepareInitial('voice-new', randomUUID(), profile, master, true)
    await f.store.acceptSaved('voice-new', receipt(activation))
    await f.store.noteIdentityUnlink(master, 'voice-new', activation.platform_user_id)
    await expect(f.store.complete('voice-new', master)).rejects.toThrow()
    const restored = new VoiceOwnerStore(f.directory); await restored.load()
    expect(restored.record('voice-new')?.binding_revoked).toBe(true)
    await restored.prepareInitial('voice-new', randomUUID(), profile, master, true)
    expect(restored.record('voice-new')?.binding_revoked).toBe(false)
    await restored.noteFriendWithdrawal(master)
    expect(restored.record('voice-new')).toMatchObject({ master_was_present: true, binding_revoked: true })
    await expect(restored.complete('voice-new', master)).rejects.toThrow()
  })
  it('rejects corrupt or future storage without replacing its bytes', async () => {
    const f = await fixture()
    for (const invalid of ['{"version":2,"records":[]}', '{"version":1,"records":[{}]}', 'broken']) {
      await fs.writeFile(f.file, invalid)
      const restored = new VoiceOwnerStore(f.directory)
      await expect(restored.load()).rejects.toThrow()
      expect(await fs.readFile(f.file, 'utf8')).toBe(invalid)
      expect(() => restored.get('voice-a')).toThrow()
    }
  })
})
