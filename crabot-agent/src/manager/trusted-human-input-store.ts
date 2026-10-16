import { promises as fs } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { ChannelMessage, Friend } from '../types.js'
import { AsyncMutex } from '../workers/async-mutex.js'
import { encodeSegment } from '../workers/harness/ledger-store.js'
import type { ManagerKey } from './types.js'
import type { TrustedHumanInput } from './trusted-human-input.js'

interface Dependencies {
  resolveSender(channelId: string, platformUserId: string): Promise<Friend | null>
  now(): string
}
interface State { version: 1; inputs: TrustedHumanInput[] }
const INPUT_KEYS = ['source_id', 'manager_key', 'sequence', 'received_at', 'identity_status', 'sender_friend_id', 'message']
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value) }
function exact(value: unknown, keys: string[]): value is Record<string, unknown> {
  return record(value) && Object.keys(value).length === keys.length && keys.every(key => Object.prototype.hasOwnProperty.call(value, key))
}
function nonempty(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0 }
function timestamp(value: unknown): value is string { return typeof value === 'string' && Number.isFinite(Date.parse(value)) }
function assertMessage(key: ManagerKey, value: unknown): asserts value is ChannelMessage {
  if (!record(value) || !nonempty(value.platform_message_id) || !record(value.session) || !record(value.sender) || !record(value.content) || !record(value.features)
    || !nonempty(value.session.channel_id) || !nonempty(value.session.session_id) || !['private', 'group'].includes(String(value.session.type))
    || !nonempty(value.sender.platform_user_id) || typeof value.sender.platform_display_name !== 'string' || !nonempty(value.content.type)
    || (value.content.text !== undefined && typeof value.content.text !== 'string') || typeof value.features.is_mention_crab !== 'boolean' || !timestamp(value.platform_timestamp)) throw new Error('Invalid trusted human input message')
  if (`${value.session.channel_id}::${value.session.session_id}` !== key) throw new Error('Trusted human input target mismatch')
}
function original(message: ChannelMessage): ChannelMessage {
  const { friend_id, ...sender } = message.sender
  const { task_id, ...raw } = message
  // Persist exactly the JSON wire facts; absent optional fields must hash identically after recovery.
  return JSON.parse(JSON.stringify({ ...raw, sender })) as ChannelMessage
}

/** Not exposed to tools/RPC. Only the authenticated ingress composition may call capture. */
export class TrustedHumanInputStore {
  private readonly locks = new Map<ManagerKey, AsyncMutex>()
  constructor(private readonly root: string, private readonly deps: Dependencies) {}
  private mutex(key: ManagerKey): AsyncMutex {
    let mutex = this.locks.get(key)
    if (!mutex) { mutex = new AsyncMutex(); this.locks.set(key, mutex) }
    return mutex
  }
  private file(key: ManagerKey): string { return path.join(this.root, encodeSegment(key), 'request-sources.json') }
  async list(key: ManagerKey): Promise<TrustedHumanInput[]> { return this.mutex(key).run(async () => (await this.read(key)).inputs) }
  capture(key: ManagerKey, messages: ReadonlyArray<ChannelMessage>): Promise<TrustedHumanInput[]> {
    const batch = structuredClone(messages), receivedAt = this.deps.now()
    if (!timestamp(receivedAt)) return Promise.reject(new Error('Invalid trusted human input receive time'))
    return this.mutex(key).run(async () => {
      const state = await this.read(key), results: TrustedHumanInput[] = []
      let changed = false
      for (const message of batch) {
        assertMessage(key, message)
        const wireMessage = original(message)
        const existing = state.inputs.find(input => input.message.platform_message_id === message.platform_message_id)
        if (existing) {
          if (!isDeepStrictEqual(original(existing.message), wireMessage)) throw new Error('Trusted human input source conflict')
          results.push(existing); continue
        }
        let status: TrustedHumanInput['identity_status'] = 'unresolved', friendId: string | null = null
        try {
          const friend = await this.deps.resolveSender(message.session.channel_id, message.sender.platform_user_id)
          if (friend === null) status = 'stranger'
          else if (nonempty(friend.id) && friend.channel_identities.some(identity => identity.channel_id === message.session.channel_id && identity.platform_user_id === message.sender.platform_user_id)) {
            status = 'friend'; friendId = friend.id
          }
        } catch { /* Unavailable identity remains explicit; it never inherits a preceding speaker. */ }
        const saved: TrustedHumanInput = {
          source_id: randomUUID(), manager_key: key, sequence: (state.inputs.at(-1)?.sequence ?? 0) + 1,
          received_at: receivedAt, identity_status: status, sender_friend_id: friendId,
          message: { ...wireMessage, sender: { ...wireMessage.sender, ...(friendId ? { friend_id: friendId } : {}) } },
        }
        state.inputs.push(saved); results.push(saved); changed = true
      }
      if (changed) await this.write(key, state)
      return structuredClone(results)
    })
  }
  private async read(key: ManagerKey): Promise<State> {
    let value: unknown
    try { value = JSON.parse(await fs.readFile(this.file(key), 'utf8')) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, inputs: [] }; throw error }
    if (!exact(value, ['version', 'inputs']) || value.version !== 1 || !Array.isArray(value.inputs)) throw new Error('Unsupported trusted human input store')
    const ids = new Set<string>(), messages = new Set<string>()
    let sequence = 0
    for (const input of value.inputs) {
      if (!exact(input, INPUT_KEYS) || typeof input.source_id !== 'string' || !uuid.test(input.source_id) || input.manager_key !== key || !Number.isSafeInteger(input.sequence)
        || (input.sequence as number) <= sequence || !timestamp(input.received_at) || !['friend', 'stranger', 'unresolved'].includes(String(input.identity_status))) throw new Error('Invalid trusted human input record')
      assertMessage(key, input.message)
      if (input.identity_status === 'friend' ? !nonempty(input.sender_friend_id) || input.message.sender.friend_id !== input.sender_friend_id : input.sender_friend_id !== null || input.message.sender.friend_id !== undefined) throw new Error('Invalid trusted human input sender')
      if (ids.has(input.source_id) || messages.has(input.message.platform_message_id)) throw new Error('Duplicate trusted human input source')
      ids.add(input.source_id); messages.add(input.message.platform_message_id); sequence = input.sequence as number
    }
    return value as unknown as State
  }
  private async write(key: ManagerKey, state: State): Promise<void> {
    const target = this.file(key), temporary = `${target}.${randomUUID()}.tmp`
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 })
    try {
      const handle = await fs.open(temporary, 'wx', 0o600)
      try { await handle.writeFile(JSON.stringify(state)); await handle.sync() } finally { await handle.close() }
      await fs.rename(temporary, target)
    } catch (error) { await fs.rm(temporary, { force: true }).catch(() => undefined); throw error }
  }
}
