import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { VoiceManagementCommand } from 'crabot-shared'
import { VoiceTurnStore } from './voice-turn-store.js'

describe('Voice v5 management transactions', () => {
  let directory: string, store: VoiceTurnStore
  const channel = 'voice-test', epoch = randomUUID()
  const request = (command: VoiceManagementCommand) => ({ request_id: randomUUID(), expected_revision: store.registrations(channel).enrollment_revision, command })
  beforeEach(async () => { directory = await mkdtemp(path.join(tmpdir(), 'voice-v5-')); store = new VoiceTurnStore(directory); await store.load(); await store.sync({ channel_id: channel, connection_epoch: epoch, foreground: true }) })
  afterEach(async () => { vi.restoreAllMocks(); await rm(directory, { recursive: true, force: true }) })
  async function enroll(name = 'User') {
    const r = request({ action: 'enroll_new', display_name: name })
    const result = await store.manage(channel, r, 'campplus')
    const task = result.catalog.pending_enrollment!
    return { r, task, ack: { registration_id: task.registration.registration_id, model_id: 'campplus', enrollment_revision: task.enrollment_revision } }
  }
  it('creates a formal contact only with a valid durable completion, idempotently', async () => {
    const { r, task, ack } = await enroll()
    expect(store.registrations(channel).contacts).toEqual([])
    expect((await store.manage(channel, r, 'campplus')).catalog.pending_enrollment?.registration.registration_id).toBe(task.registration.registration_id)
    await store.sync({ channel_id: channel, connection_epoch: epoch, foreground: true, completed_enrollment: ack })
    await store.sync({ channel_id: channel, connection_epoch: epoch, foreground: true, completed_enrollment: ack })
    expect(store.registrations(channel).contacts).toHaveLength(1)
    expect(store.managementResult(channel, r.request_id).status).toBe('completed')
    const loaded = new VoiceTurnStore(directory); await loaded.load()
    expect(loaded.registrations(channel).contacts[0].platform_user_id).toBe(task.registration.platform_user_id)
  })
  it('rejects conflicting request reuse and stale writes without duplicating identity', async () => {
    const { r } = await enroll()
    await expect(store.manage(channel, { ...r, command: { action: 'enroll_new', display_name: 'Different' } }, 'campplus')).rejects.toThrow()
    const stale = { ...request({ action: 'enroll_new', display_name: 'Other' }), expected_revision: 0 }
    expect((await store.manage(channel, stale, 'campplus')).code).toBe('CONFLICT')
    expect(store.registrations(channel).contacts).toEqual([])
  })
  it('rechecks terminal epoch when a queued write commits, without persisting an unauthorized request', async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const blocking = (store as unknown as { change(work: () => Promise<void>): Promise<void> }).change(async () => { await gate })
    const r = request({ action: 'enroll_new', display_name: 'Old connection' })
    const operation = store.manage(channel, r, 'campplus', false, epoch)
    const rejected = expect(operation).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await store.sync({ channel_id: channel, connection_epoch: randomUUID(), foreground: true })
    release(); await blocking; await rejected
    expect(store.managementResult(channel, r.request_id).status).toBe('unknown')
    expect(store.registrations(channel).contacts).toEqual([])
    expect(store.registrations(channel).pending_enrollment).toBeNull()
  })
  it('keeps the old sample on replacement cancellation and switches only after success', async () => {
    const first = await enroll(); await store.sync({ channel_id: channel, connection_epoch: epoch, foreground: true, completed_enrollment: first.ack })
    const id = first.task.registration.platform_user_id
    const second = await store.manage(channel, request({ action: 'enroll', platform_user_id: id }), 'campplus')
    expect(second.catalog.registrations.find(r => r.registration_id === first.ack.registration_id)?.status).toBe('active')
    await store.manage(channel, request({ action: 'cancel_enrollment', registration_id: second.catalog.pending_enrollment!.registration.registration_id }), 'campplus')
    expect(store.registrations(channel).registrations.find(r => r.registration_id === first.ack.registration_id)?.status).toBe('active')
    const third = await store.manage(channel, request({ action: 'enroll', platform_user_id: id }), 'campplus')
    const task = third.catalog.pending_enrollment!
    await store.sync({ channel_id: channel, connection_epoch: epoch, foreground: true, completed_enrollment: { registration_id: task.registration.registration_id, model_id: 'campplus', enrollment_revision: task.enrollment_revision } })
    expect(store.registrations(channel).contacts[0].platform_user_id).toBe(id)
    expect(store.registrations(channel).registrations.filter(r => r.status === 'active')).toHaveLength(1)
    expect(store.registrations(channel).registrations.find(r => r.registration_id === first.ack.registration_id)?.status).toBe('revoked')
  })
  it('expiry, wrong model and wrong task revision never create a contact', async () => {
    const { ack } = await enroll()
    await expect(store.sync({ channel_id: channel, connection_epoch: epoch, foreground: true, completed_enrollment: { ...ack, model_id: 'wrong' } })).rejects.toThrow()
    await expect(store.sync({ channel_id: channel, connection_epoch: epoch, foreground: true, completed_enrollment: { ...ack, enrollment_revision: ack.enrollment_revision + 1 } })).rejects.toThrow()
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 61000)
    await store.expireEnrollment(channel)
    await expect(store.sync({ channel_id: channel, connection_epoch: epoch, foreground: true, completed_enrollment: ack })).rejects.toThrow()
    expect(store.registrations(channel).contacts).toEqual([])
  })
  it('rename and revocation preserve contact identity, and clearing is idempotent', async () => {
    const { task, ack } = await enroll(); await store.sync({ channel_id: channel, connection_epoch: epoch, foreground: true, completed_enrollment: ack })
    const id = task.registration.platform_user_id
    await store.manage(channel, request({ action: 'rename_contact', platform_user_id: id, display_name: 'Renamed' }), 'campplus')
    const result = await store.manage(channel, request({ action: 'delete_registration', registration_id: ack.registration_id }), 'campplus')
    const cleared = { registration_id: ack.registration_id, enrollment_revision: result.catalog.enrollment_revision }
    await store.sync({ channel_id: channel, connection_epoch: epoch, foreground: true, cleared_registration: cleared })
    const revision = store.registrations(channel).enrollment_revision
    await store.sync({ channel_id: channel, connection_epoch: epoch, foreground: true, cleared_registration: cleared })
    expect(store.registrations(channel).enrollment_revision).toBe(revision)
    expect(store.registrations(channel).contacts).toEqual([{ platform_user_id: id, display_name: 'Renamed' }])
  })
  it('migrates active contacts, preserves unconfirmed placeholders and backs up v2', async () => {
    const contact = { platform_user_id: randomUUID(), display_name: 'Known' }, placeholder = { platform_user_id: randomUUID(), display_name: 'Unconfirmed' }
    const old = { version: 2, channels: { [channel]: { enrollment_revision: 3, contacts: [contact, placeholder], registrations: [{ registration_id: randomUUID(), ...contact, model_id: 'campplus', status: 'active', terminal_cleared: false }] } }, turns: {} }
    const file = path.join(directory, 'voice-turns.json'); await writeFile(file, JSON.stringify(old))
    const loaded = new VoiceTurnStore(directory); await loaded.load()
    expect(loaded.registrations(channel).contacts).toEqual([contact])
    expect(loaded.registrations(channel).unconfirmed_contacts).toEqual([placeholder])
    expect(JSON.parse(await readFile(file + '.v2.bak', 'utf8'))).toEqual(old)
    expect(JSON.parse(await readFile(file, 'utf8')).version).toBe(3)
  })
  it('preserves corrupt original data instead of partially migrating or resetting it', async () => {
    const file = path.join(directory, 'voice-turns.json')
    const original = JSON.stringify({ version: 2, channels: { [channel]: { enrollment_revision: 3, contacts: [{ platform_user_id: 'invalid', display_name: 'Known' }], registrations: [] } }, turns: {} })
    await writeFile(file, original)
    const loaded = new VoiceTurnStore(directory)
    await expect(loaded.load()).rejects.toThrow()
    expect(await readFile(file, 'utf8')).toBe(original)
    await expect(readFile(file + '.v2.bak')).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
