import { promises as fs } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { assertVoiceUuid, validateVoiceDeviceOwner, validateVoiceOwnerActivation, validateVoiceOwnerSaved,
  type VoiceDeviceOwner, type VoiceOwnerActivation, type VoiceOwnerSaved } from 'crabot-shared'

type ActivationRecord = {
  channel_id: string
  mode: 'initial' | 'legacy'
  pairing_id: string | null
  target_friend_id: string
  activation: VoiceOwnerActivation
  samples_saved: boolean
}
type State = { version: 1; records: ActivationRecord[] }
function conflict(message: string): never { throw Object.assign(new Error(message), { code: 'CONFLICT' }) }
function sameOwner(a: VoiceDeviceOwner, b: VoiceDeviceOwner): boolean {
  return a.profile_id === b.profile_id && a.display_name === b.display_name && a.model_id === b.model_id
}
function required(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('Invalid voice owner reference')
}
function exactKeys(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length || keys.some(key => !Object.prototype.hasOwnProperty.call(value, key))) throw new Error('Corrupt voice owner store')
}

/** Durable facts only. Human authorization and real Friend binding remain VoiceAdmin's responsibility. */
export class VoiceOwnerStore {
  private state: State = { version: 1, records: [] }
  private loaded = false
  private serial: Promise<unknown> = Promise.resolve()
  private readonly filename: string
  constructor(private readonly dataDir: string) { this.filename = path.join(dataDir, 'voice-owner-activations.json') }

  async load(): Promise<void> {
    let value: unknown
    try { value = JSON.parse(await fs.readFile(this.filename, 'utf8')) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      this.loaded = true
      return
    }
    exactKeys(value, ['version', 'records'])
    if (value.version !== 1 || !Array.isArray(value.records)) throw new Error('Unsupported voice owner store')
    const channels = new Set<string>()
    for (const record of value.records) {
      exactKeys(record, ['channel_id', 'mode', 'pairing_id', 'target_friend_id', 'activation', 'samples_saved'])
      required(record.channel_id); required(record.target_friend_id)
      validateVoiceOwnerActivation(record.activation)
      if (channels.has(record.channel_id) || !['initial', 'legacy'].includes(record.mode as string) || typeof record.samples_saved !== 'boolean') throw new Error('Corrupt voice owner activation')
      if (record.mode === 'initial') assertVoiceUuid(record.pairing_id)
      else if (record.pairing_id !== null) throw new Error('Corrupt legacy owner reference')
      if (record.activation.status === 'completed' && !record.samples_saved) throw new Error('Unconfirmed voice owner completion')
      channels.add(record.channel_id)
    }
    this.state = value as unknown as State
    this.loaded = true
  }
  record(channelId: string): ActivationRecord | null {
    if (!this.loaded) throw new Error('Voice owner store is not loaded')
    return structuredClone(this.state.records.find(record => record.channel_id === channelId) ?? null)
  }
  get(channelId: string): VoiceOwnerActivation | null { return this.record(channelId)?.activation ?? null }
  pendingBindings(): ActivationRecord[] {
    if (!this.loaded) throw new Error('Voice owner store is not loaded')
    return structuredClone(this.state.records.filter(record => record.samples_saved && record.activation.status === 'pending'))
  }
  prepareInitial(channelId: string, pairingId: string, owner: VoiceDeviceOwner, friendId: string): Promise<VoiceOwnerActivation> {
    assertVoiceUuid(pairingId)
    return this.prepare({ channel_id: channelId, mode: 'initial', pairing_id: pairingId, target_friend_id: friendId,
      activation: { operation_id: randomUUID(), owner, platform_user_id: randomUUID(), registration_id: randomUUID(), status: 'pending' }, samples_saved: false })
  }
  prepareLegacy(channelId: string, owner: VoiceDeviceOwner, friendId: string, contactId: string, registrationId: string): Promise<VoiceOwnerActivation> {
    assertVoiceUuid(contactId); assertVoiceUuid(registrationId)
    return this.prepare({ channel_id: channelId, mode: 'legacy', pairing_id: null, target_friend_id: friendId,
      activation: { operation_id: randomUUID(), owner, platform_user_id: contactId, registration_id: registrationId, status: 'pending' }, samples_saved: false })
  }
  private prepare(record: ActivationRecord): Promise<VoiceOwnerActivation> {
    required(record.channel_id); required(record.target_friend_id); validateVoiceDeviceOwner(record.activation.owner)
    const candidate = structuredClone(record)
    return this.update(next => {
      const previous = next.records.find(value => value.channel_id === candidate.channel_id)
      if (previous) {
        if (previous.mode !== candidate.mode || previous.target_friend_id !== candidate.target_friend_id || !sameOwner(previous.activation.owner, candidate.activation.owner) ||
          (candidate.mode === 'legacy' && (previous.activation.platform_user_id !== candidate.activation.platform_user_id || previous.activation.registration_id !== candidate.activation.registration_id))) conflict('所有者或原 Master 关联冲突，不能重新认主')
        if (previous.activation.status === 'pending') previous.pairing_id = candidate.pairing_id
        return previous.activation
      }
      next.records.push(candidate)
      return candidate.activation
    })
  }
  acceptSaved(channelId: string, saved: VoiceOwnerSaved): Promise<VoiceOwnerActivation> {
    validateVoiceOwnerSaved(saved)
    const receipt = structuredClone(saved)
    return this.update(next => {
      const record = this.find(next, channelId)
      const value = record.activation
      if (value.operation_id !== receipt.operation_id || value.registration_id !== receipt.registration_id || value.owner.profile_id !== receipt.profile_id || value.owner.model_id !== receipt.model_id) conflict('所有者保存回执与原操作不符')
      record.samples_saved = true
      return value
    })
  }
  complete(channelId: string, verifiedFriendId: string): Promise<VoiceOwnerActivation> {
    return this.update(next => {
      const record = this.find(next, channelId)
      if (!record.samples_saved || record.target_friend_id !== verifiedFriendId) conflict('手机保存或原 Master 持久关联尚未完成')
      record.activation.status = 'completed'
      return record.activation
    })
  }
  private find(state: State, channelId: string): ActivationRecord {
    const record = state.records.find(value => value.channel_id === channelId)
    if (!record) throw Object.assign(new Error('所有者激活操作不存在'), { code: 'NOT_FOUND' })
    return record
  }
  private update(change: (state: State) => VoiceOwnerActivation): Promise<VoiceOwnerActivation> {
    const operation = this.serial.then(async () => {
      if (!this.loaded) throw new Error('Voice owner store is not loaded')
      const next = structuredClone(this.state)
      const result = change(next)
      if (JSON.stringify(next) !== JSON.stringify(this.state)) {
        await fs.mkdir(this.dataDir, { recursive: true, mode: 0o700 })
        const temporary = `${this.filename}.${randomUUID()}.tmp`
        try {
          const handle = await fs.open(temporary, 'wx', 0o600)
          try { await handle.writeFile(JSON.stringify(next)); await handle.sync() } finally { await handle.close() }
          await fs.rename(temporary, this.filename)
        } catch (error) {
          await fs.rm(temporary, { force: true }).catch(() => undefined)
          throw error
        }
        this.state = next
      }
      return structuredClone(result)
    })
    this.serial = operation.catch(() => undefined)
    return operation
  }
}
