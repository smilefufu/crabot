import fs from 'node:fs'
import path from 'node:path'
import { ModuleBase, RpcError, generateId, generateTimestamp, type Event } from 'crabot-shared'
import { messageFeatures, messageText } from './event-mapper.js'
import { ConfigStore } from './config.js'
import { Store, paginate } from './store.js'
import { SlackClient } from './slack-client.js'
import { displayName, type ChannelMessage, type HistoryMessage, type MessageContent, type PaginationParams,
  type Session, type SlackApi, type SlackConversation, type SlackEnvelope, type SlackResult, type SlackUser } from './types.js'

export interface SlackChannelInit {
  module_id: string; port: number; data_dir: string; env: Record<string, string | undefined>
}
const CAPABILITIES = {
  supported_message_types: ['text'], supported_features: ['mention'], supports_history_query: true,
  supports_platform_user_query: true, max_message_length: 4000, max_file_size: 0, supports_file_path: false,
  supports_list_contacts: true, supports_list_groups: true, supports_list_group_members: true,
}
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
export class SlackChannel extends ModuleBase {
  private readonly settings: ConfigStore
  private readonly store: Store
  private readonly api: SlackApi
  private identity = { team_id: '', user_id: '', app_id: '' }
  private pending: Promise<unknown> = Promise.resolve()
  private queued = 0
  private accepting = true
  private readonly seen = new Map<string, number>()
  private readonly lastSend = new Map<string, number>()
  private cleanup?: ReturnType<typeof setInterval>

  constructor(private readonly init: SlackChannelInit, api?: SlackApi) {
    super({ moduleId: init.module_id, moduleType: 'channel', version: '0.1.0', protocolVersion: '0.2.0', port: init.port, subscriptions: [] })
    this.settings = new ConfigStore(init.data_dir, init.env)
    this.store = new Store(init.data_dir, init.module_id)
    this.api = api ?? new SlackClient(this.settings.value.credentials.bot_token, this.settings.value.credentials.app_token)
    this.registerMethod('get_capabilities', () => structuredClone(CAPABILITIES))
    this.registerMethod('get_config', () => this.configResult())
    this.registerMethod<{ config: unknown }, unknown>('update_config', ({ config }) => this.serial(() => {
      if (config && typeof config === 'object' && 'crab_platform_user_id' in config) {
        const id = (config as Record<string, unknown>).crab_platform_user_id
        if (id !== this.identity.user_id) throw new RpcError('INVALID_PARAMS', '机器人身份不可修改')
        config = { ...config }; delete (config as Record<string, unknown>).crab_platform_user_id
      }
      const result = this.settings.update(config)
      return { ...result, config: this.configResult().config }
    }))
    this.registerMethod<{ type?: string; pagination?: PaginationParams }, unknown>('get_sessions', p => paginate([...this.store.sessions.values()].filter(s => !p.type || s.type === p.type), p.pagination))
    this.registerMethod<{ session_id: string }, unknown>('get_session', p => ({ session: this.store.session(p.session_id) }))
    this.registerMethod<{ session_id: string }, unknown>('delete_session', p => this.serial(async () => {
      const old = this.store.sessions.get(p.session_id)
      if (!old) return { deleted: false }
      // Publish before destructive local removal; a publish failure leaves a retryable session.
      await this.sessionChanged('removed', old)
      this.store.remove(p.session_id)
      return { deleted: true }
    }))
    this.registerMethod<{ session_id: string; time_range?: { start?: string; end?: string }; keyword?: string; limit?: number; pagination?: PaginationParams }, unknown>('get_history', p => paginate(this.store.history(p.session_id, this.settings.value.cache, p.time_range, p.keyword), p.pagination, p.limit))
    this.registerMethod<{ session_id: string; platform_message_id: string }, unknown>('get_message', p => {
      this.store.session(p.session_id)
      const message = this.store.messages(p.session_id, this.settings.value.cache).find(m => m.platform_message_id === p.platform_message_id)
      if (!message) throw new RpcError('CHANNEL_HISTORY_UNAVAILABLE', '消息未保留在本地交互缓存；不代表 Slack 消息不存在')
      return message
    })
    this.registerMethod<{ platform_user_id: string }, unknown>('get_platform_user_info', async p => {
      const user = await this.user(p.platform_user_id)
      return { platform_user_id: user.id, display_name: displayName(user), ...(user.profile?.image_192 ? { avatar_url: user.profile.image_192 } : {}) }
    })
    this.registerMethod<{ platform_user_id: string; account_id?: string }, unknown>('find_or_create_private_session', p => this.serial(async () => {
      if (p.account_id && p.account_id !== 'default') throw new RpcError('INVALID_ARGUMENT', '一个 Slack 实例仅支持一个 Bot 安装')
      const user = await this.user(p.platform_user_id)
      const result = await this.api.call('conversations.open', { users: p.platform_user_id, return_im: true })
      if (!result.channel?.id?.startsWith('D')) throw new RpcError('CHANNEL_PRIVATE_SESSION_UNAVAILABLE', 'Slack 未返回一对一 DM 会话')
      const value = this.store.upsert({ ...result.channel, is_im: true }, displayName(user), p.platform_user_id)
      await this.sessionChanged(value.created ? 'created' : 'updated', value.session)
      return value
    }))
    this.registerMethod('sync_sessions', () => this.serial(() => this.syncSessions()))
    this.registerMethod<{ search?: string; pagination?: PaginationParams }, unknown>('list_contacts', async p => {
      const users = await this.all<SlackUser>('users.list', {}, 'members')
      return paginate(users.filter(u => u.id && !u.deleted && !u.is_bot && !u.is_app_user && u.id !== 'USLACKBOT' && matches(displayName(u), p.search)).map(u => ({ platform_user_id: u.id!, display_name: displayName(u), ...(u.profile?.image_192 ? { avatar_url: u.profile.image_192 } : {}) })), p.pagination)
    })
    this.registerMethod<{ search?: string; pagination?: PaginationParams }, unknown>('list_groups', async p => {
      const groups = (await this.conversations()).filter(c => !c.is_im && matches(c.name || c.id || '', p.search))
      return paginate(groups.map(c => ({ platform_session_id: c.id!, group_name: c.name || c.id!, ...(c.num_members !== undefined ? { member_count: c.num_members } : {}) })), p.pagination)
    })
    this.registerMethod<{ session_id: string; pagination?: PaginationParams }, unknown>('list_group_members', async p => {
      const session = this.store.session(p.session_id)
      if (session.type !== 'group') throw new RpcError('INVALID_ARGUMENT', '指定 Session 不是群聊')
      const ids = [...new Set(await this.all<string>('conversations.members', { channel: session.platform_session_id }, 'members'))]
      // Slack enumerates member IDs; optional display names can be queried individually.
      const members = ids.map(id => ({ platform_user_id: id, role: 'member' as const }))
      return { ...paginate(members, p.pagination), member_count: members.length, members_complete: true }
    })
    this.registerMethod<{ session_id: string; content: MessageContent; features?: Record<string, unknown> }, unknown>('send_message', p => this.serial(() => this.send(p)))
  }
  private configResult() {
    return { config: { ...this.settings.public(), crab_platform_user_id: this.identity.user_id }, schema: {
      credentials: { sensitive: true, hot_reload: false, description: 'Slack Token 变更后需重启' },
      'group.only_respond_to_mentions': { hot_reload: true }, 'cache.max_days': { hot_reload: true }, 'cache.max_messages_per_session': { hot_reload: true },
    } }
  }
  private serial<T>(work: () => T | Promise<T>): Promise<T> {
    if (!this.accepting) return Promise.reject(new RpcError('SERVICE_UNAVAILABLE', 'Slack 模块正在停止'))
    if (this.queued >= 1000) return Promise.reject(new RpcError('SERVICE_UNAVAILABLE', 'Slack 本地队列已满，请稍后重试'))
    this.queued++
    const result = this.pending.then(work)
    this.pending = result.catch(() => {}).finally(() => { this.queued-- })
    return result
  }
  protected override async onStart() {
    try {
      for (const session of this.store.sessions.values()) this.store.messages(session.id, this.settings.value.cache)
      const auth = await this.api.call('auth.test')
      if (!auth.team_id || !auth.user_id || !auth.bot_id) throw new RpcError('INVALID_PARAMS', '凭据不是有效 Slack Bot 安装')
      const bot = await this.api.call('bots.info', { bot: auth.bot_id })
      if (!bot.bot?.app_id) throw new RpcError('INVALID_PARAMS', '无法核验 Slack App 身份')
      this.identity = { team_id: auth.team_id, user_id: auth.user_id, app_id: bot.bot.app_id }
      const file = path.join(this.init.data_dir, 'installation.json')
      if (fs.existsSync(file)) {
        const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
        if (saved.team_id !== auth.team_id || saved.user_id !== auth.user_id || saved.app_id !== bot.bot.app_id) throw new RpcError('INVALID_PARAMS', '此实例已绑定另一 Slack 安装，请新建实例')
      } else fs.writeFileSync(file, JSON.stringify(this.identity), { mode: 0o600, flag: 'wx' })
      // Health reflects socket state. Each event also verifies workspace AND App to reject mismatched tokens.
      await this.api.start(body => this.receive(body))
      this.cleanup = setInterval(() => {
        void this.serial(() => { for (const s of this.store.sessions.values()) this.store.messages(s.id, this.settings.value.cache) }).catch(() => console.error('[Slack] cache cleanup failed'))
      }, 3600000)
      this.cleanup.unref()
    } catch (error) { await this.api.stop().catch(() => {}); throw error }
  }
  protected override async onStop() {
    this.accepting = false
    if (this.cleanup) clearInterval(this.cleanup)
    await this.pending
    await this.api.stop()
  }
  protected override async getHealthDetails() {
    let count = 0
    for (const session of this.store.sessions.values()) count += this.store.messages(session.id, this.settings.value.cache).length
    return { platform: 'slack', platform_connected: this.api.connected, active_sessions: this.store.sessions.size, cached_messages: count }
  }
  protected override async getHealthStatus() { return this.accepting && this.api.connected ? 'healthy' as const : 'degraded' as const }
  private async publish(type: string, payload: unknown) {
    const event: Event = { id: generateId(), type, source: this.init.module_id, timestamp: generateTimestamp(), payload }
    await this.rpcClient.publishEvent(event, this.init.module_id)
  }
  private sessionChanged(type: 'created' | 'updated' | 'participants_changed' | 'removed', session: Session) {
    return this.publish('channel.session_changed', { type, channel_id: this.init.module_id, session })
  }
  async receive(body: SlackEnvelope): Promise<void> {
    // Capture admission config at receipt; a queued config update must not reclassify an older event.
    const onlyMentions = this.settings.value.group.only_respond_to_mentions
    return this.serial(async () => {
      const e = body.event
      if (body.team_id !== this.identity.team_id || body.api_app_id !== this.identity.app_id) return
      if (!e || !['message', 'app_mention'].includes(e.type || '') || !e.channel || !e.user || !e.ts || !/^\d+\.\d+$/.test(e.ts) || e.user === this.identity.user_id || e.user === 'USLACKBOT' || e.bot_id || e.hidden) return
      if (e.subtype && !['file_share', 'thread_broadcast'].includes(e.subtype)) return
      const key = `${e.channel}:${e.ts}`
      const cutoff = Date.now() - 6 * 3600000
      for (const [k, time] of this.seen) if (time < cutoff) this.seen.delete(k)
      if (this.seen.has(key)) return
      const features = messageFeatures(e, this.identity.user_id)
      // DM uses its native conversation id. MPIM is intentionally excluded.
      const isDm = e.channel.startsWith('D')
      if (!isDm && onlyMentions && !features.is_mention_crab) { this.markSeen(key); return }
      if (e.channel_type === 'mpim') { this.markSeen(key); return }
      let conversation: SlackConversation | undefined
      try {
        conversation = (await this.api.call('conversations.info', { channel: e.channel })).channel
      } catch (error) {
        // Message subscriptions carry native conversation type even when optional metadata is unavailable.
        if (!e.channel_type && !isDm) throw error
        conversation = { id: e.channel, is_im: isDm || e.channel_type === 'im', is_member: true }
      }
      if (conversation?.id !== e.channel || conversation.is_mpim || conversation.is_archived || (!conversation.is_im && !conversation.is_member)) { this.markSeen(key); return }
      let u: SlackUser
      try { u = await this.user(e.user) } catch { u = { id: e.user } }
      if (u.is_bot || u.is_app_user || u.deleted) { this.markSeen(key); return }
      const value = this.store.upsert(conversation, conversation.is_im ? displayName(u) : conversation.name || e.channel, e.user)
      await this.sessionChanged(value.created ? 'created' : 'updated', value.session)
      const content = { type: 'text' as const, text: messageText(e) }
      if (!content.text) { this.markSeen(key); return }
      const message: ChannelMessage = {
        platform_message_id: e.ts, session: { session_id: value.session.id, channel_id: this.init.module_id, type: value.session.type },
        sender: { platform_user_id: e.user, platform_display_name: displayName(u) }, content,
        features,
        platform_timestamp: new Date(Number(e.ts) * 1000).toISOString(),
      }
      const { session: _session, ...history } = message
      this.store.append(value.session.id, history, this.settings.value.cache)
      await this.publish('channel.message_received', { channel_id: this.init.module_id, message })
      this.markSeen(key)
    })
  }
  private markSeen(key: string) {
    this.seen.set(key, Date.now())
    if (this.seen.size > 10000) this.seen.delete(this.seen.keys().next().value!)
  }
  private async user(id: string): Promise<SlackUser> {
    if (!/^[UW][A-Z0-9]+$/.test(id || '')) throw new RpcError('INVALID_ARGUMENT', 'Slack 用户 ID 无效')
    const result = await this.api.call('users.info', { user: id })
    if (!result.user?.id) throw new RpcError('NOT_FOUND', 'Slack 用户不可见/不存在')
    return result.user
  }
  private async all<T>(method: string, args: Record<string, unknown>, key: 'members' | 'channels'): Promise<T[]> {
    const items: T[] = [], cursors = new Set<string>()
    let cursor = ''
    do {
      if (cursors.size >= 1000) throw new RpcError('SERVICE_UNAVAILABLE', 'Slack 列表超过单次同步预算，未应用会话删除')
      const result: SlackResult = await this.api.call(method, { ...args, limit: 200, ...(cursor ? { cursor } : {}) })
      if (!Array.isArray(result[key])) throw new RpcError('SERVICE_UNAVAILABLE', 'Slack 未返回完整列表')
      items.push(...result[key] as T[])
      cursor = result.response_metadata?.next_cursor?.trim() || ''
      if (cursor && cursors.has(cursor)) throw new RpcError('SERVICE_UNAVAILABLE', 'Slack 分页无进展，未应用会话删除')
      cursors.add(cursor)
    } while (cursor)
    return items
  }
  private async conversations() {
    const all = await this.all<SlackConversation>('conversations.list', { types: 'public_channel,private_channel,im', exclude_archived: true }, 'channels')
    return all.filter(c => c.id && !c.is_mpim && !c.is_archived && (c.is_im || c.is_member))
  }
  private async syncSessions() {
    const conversations = await this.conversations() // All pages must succeed before any destructive change.
    const prepared: Array<{ c: SlackConversation; title: string }> = []
    for (const c of conversations) prepared.push({ c, title: c.is_im && c.user ? displayName(await this.user(c.user)) : c.name || c.id! })
    const previous = [...this.store.sessions.values()], visible = new Set(conversations.map(c => c.id))
    let added = 0, updated = 0, removed = 0
    for (const { c, title } of prepared) {
      const value = this.store.upsert(c, title, c.is_im ? c.user : undefined)
      await this.sessionChanged(value.created ? 'created' : 'updated', value.session)
      value.created ? added++ : updated++
    }
    for (const session of previous) if (!visible.has(session.platform_session_id)) {
      await this.sessionChanged('removed', session)
      this.store.remove(session.id); removed++
    }
    return { added, updated, removed }
  }
  private async mentionIds(mentions: unknown): Promise<string[]> {
    if (mentions === undefined) return []
    if (!Array.isArray(mentions)) throw new RpcError('INVALID_ARGUMENT', 'mentions 必须为列表')
    const ids: string[] = []
    for (const mention of mentions) {
      let id: string | undefined
      if (typeof mention === 'object' && mention) id = mention.platform_user_id
      else if (typeof mention === 'string') {
        const modules = await this.rpcClient.resolve({ module_type: 'admin' }, this.init.module_id)
        if (!modules[0]) throw new RpcError('SERVICE_UNAVAILABLE', '无法解析 mention 的平台身份')
        const result = await this.rpcClient.call<{ friend_id: string }, { friend: { channel_identities: Array<{ channel_id: string; platform_user_id: string }> } }>(modules[0].port, 'get_friend', { friend_id: mention }, this.init.module_id)
        id = result.friend.channel_identities.find(ci => ci.channel_id === this.init.module_id)?.platform_user_id
      }
      if (!id || !/^[UW][A-Z0-9]+$/.test(id)) throw new RpcError('INVALID_ARGUMENT', 'mention 缺少本渠道平台身份')
      ids.push(id)
    }
    return [...new Set(ids)]
  }
  private async send(p: { session_id: string; content: MessageContent; features?: Record<string, unknown> }) {
    const session = this.store.session(p.session_id)
    if (!p.content || p.content.type !== 'text' || p.content.file_path || p.content.media_url || p.content.media?.length || p.content.handle) throw new RpcError('CHANNEL_UNSUPPORTED_MESSAGE_TYPE', 'Slack 首版只支持纯文本发送')
    for (const [key, value] of Object.entries(p.features || {})) if (key !== 'mentions' && value !== undefined) throw new RpcError('CHANNEL_UNSUPPORTED_FEATURE', 'Slack 首版不支持线程、引用或自定义投递目标')
    if (typeof p.content.text !== 'string' || !p.content.text.trim()) throw new RpcError('INVALID_ARGUMENT', '消息正文不能为空')
    const ids = await this.mentionIds(p.features?.mentions)
    const text = (ids.length ? ids.map(id => `<@${id}>`).join(' ') + ' ' : '') + p.content.text
    const chunks = splitText(text), sent: string[] = []
    try {
      for (const chunk of chunks) {
        const wait = 1000 - (Date.now() - (this.lastSend.get(session.id) || 0))
        if (wait > 0) await sleep(wait)
        const result = await this.api.call('chat.postMessage', { channel: session.platform_session_id, text: chunk, mrkdwn: true, unfurl_links: false, unfurl_media: false })
        if (!result.ts) throw new RpcError('CHANNEL_SEND_FAILED', 'Slack 未返回消息 ID，结果未知')
        this.lastSend.set(session.id, Date.now()); sent.push(result.ts)
        const message: HistoryMessage = { platform_message_id: result.ts, sender: { platform_user_id: this.identity.user_id, platform_display_name: 'Crabot' }, content: { type: 'text', text: chunk }, features: messageFeatures({ text: chunk }, this.identity.user_id), platform_timestamp: new Date(Number(result.ts) * 1000).toISOString() }
        this.store.append(session.id, message, this.settings.value.cache)
      }
    } catch (error) {
      const e = error instanceof RpcError ? error : new RpcError('CHANNEL_SEND_FAILED', 'Slack 发送或本地记录失败，结果可能未知')
      if (e.code === 'RATE_LIMITED') {
        const after = Number(e.details?.retry_after)
        this.lastSend.set(session.id, Date.now() + (Number.isFinite(after) && after > 0 ? after : 1) * 1000 - 1000)
      }
      throw new RpcError(e.code, e.message, { ...e.details, sent_platform_message_ids: sent, partial_success: sent.length > 0 })
    }
    return { platform_message_id: sent[sent.length - 1], sent_at: new Date(Number(sent[sent.length - 1]) * 1000).toISOString() }
  }
}
function matches(text: string, query?: string) { return !query || text.toLowerCase().includes(query.toLowerCase()) }
export function splitText(text: string): string[] {
  const chars = Array.from(text), chunks: string[] = []
  while (chars.length) {
    let size = Math.min(4000, chars.length)
    const head = chars.slice(0, size).join(''), open = head.lastIndexOf('<')
    if (size < chars.length && open >= 0 && head.lastIndexOf('>') < open && head.length - open < 100) size = Array.from(head.slice(0, open)).length || size
    chunks.push(chars.splice(0, size).join(''))
  }
  return chunks
}
