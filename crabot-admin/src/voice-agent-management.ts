import { randomUUID } from 'node:crypto'
import { RpcError, sha256CanonicalJson, validateVoiceAgentContext, validateVoiceManagementRequest, assertVoiceUuid,
  type Friend, type VoiceAgentActionParams, type VoiceAgentManagementResult, type VoiceAgentContext } from 'crabot-shared'
import { VoiceTurnStore } from './voice-turn-store.js'
import { commitVoiceContactFriend } from './voice-contact-friend.js'

interface Dependencies {
  turns: VoiceTurnStore
  modelId: string
  isVoice(id: string): boolean
  verifyCore(bearer?: string): Promise<void>
  ready(id: string): void
  friends(): Friend[]
  persist(friend: Friend): Promise<void>
  resolveFriend(channelId: string, platformUserId: string): Friend | undefined
}

/** Exact-core boundary. Models supply commands, never the request context or authority. */
export class VoiceAgentManagement {
  private writes: Promise<unknown> = Promise.resolve()
  constructor(private readonly deps: Dependencies) {}
  serialize<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.writes.then(operation)
    this.writes = run.catch(() => undefined)
    return run
  }
  private authorize(context: VoiceAgentContext): void {
    validateVoiceAgentContext(context)
    if (!this.deps.isVoice(context.source.channel_id)) throw new RpcError('INVALID_PARAMS', 'Voice source required')
    this.deps.ready(context.source.channel_id)
    this.deps.turns.validateAgentSource(context)
    const friend = this.deps.resolveFriend(context.source.channel_id, context.source.platform_user_id)
    if (!friend || friend.id !== context.source.sender_friend_id || friend.permission !== 'master') throw new RpcError('FORBIDDEN', '仅当前请求的 Master 可执行此操作')
  }
  async cancelUnauthorizedSampling(): Promise<void> {
    await this.serialize(async () => {
      for (const pending of this.deps.turns.agentSampling()) {
        try { this.authorize(pending.context) }
        catch { await this.deps.turns.cancelAgentSampling(pending.channel_id, pending.operation_id) }
      }
    })
  }
  async action(raw: unknown, bearer?: string): Promise<VoiceAgentManagementResult> {
    await this.deps.verifyCore(bearer)
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new RpcError('INVALID_PARAMS', 'Voice action required')
    const input = raw as VoiceAgentActionParams
    const allowed = input.action === 'list' ? ['action', 'context'] : input.action === 'manage'
      ? ['action', 'context', 'request', 'existing_friend_id'] : ['action', 'context', 'operation_id']
    if (!['list', 'manage', 'result', 'commit', 'ack'].includes(input.action) || Object.keys(input).some(key => !allowed.includes(key))) throw new RpcError('INVALID_PARAMS', 'Unknown voice request field')
    this.authorize(input.context)
    return this.serialize(() => this.execute(input))
  }
  private result(context: VoiceAgentContext, operationId: string | null): VoiceAgentManagementResult {
    const channelId = context.source.channel_id, catalog = this.deps.turns.catalog(channelId)
    const result = operationId ? this.deps.turns.managementResult(channelId, operationId) : { status: 'completed' as const }
    const binding = operationId ? this.deps.turns.agentOperation(channelId, operationId) : undefined
    if (binding && sha256CanonicalJson(binding.context) !== sha256CanonicalJson(context)) throw new RpcError('FORBIDDEN', '操作不属于原请求')
    if (operationId && !binding) return { operation_id: operationId, status: 'unknown', catalog, contacts: [] }
    const contacts = catalog.contacts.map(contact => {
      const friend = this.deps.resolveFriend(channelId, contact.platform_user_id)
      return { ...contact, ...(friend ? { friend_id: friend.id } : {}) }
    })
    const command = operationId ? this.deps.turns.agentRequest(channelId, operationId)?.command : undefined
    const clearing = command?.action === 'delete_registration' && catalog.registrations.some(item => item.registration_id === command.registration_id && !item.terminal_cleared)
    return { ...result, operation_id: operationId, catalog, contacts, ...(binding?.friend_id && result.status === 'completed' ? { friend_id: binding.friend_id } : {}),
      ...(clearing && result.status === 'completed' ? { message: '声音识别已停用；设备样本清除尚待确认，联系人、好友和历史保留' } : {}) }
  }
  private async execute(input: VoiceAgentActionParams): Promise<VoiceAgentManagementResult> {
    const { context } = input, channelId = context.source.channel_id
    this.authorize(context)
    await this.deps.turns.expireEnrollment(channelId)
    this.authorize(context)
    if (input.action === 'list') return this.result(context, null)
    if (input.action === 'manage') {
      validateVoiceManagementRequest(input.request)
      const command = input.request.command, live = this.deps.turns.connectionState(channelId)
      if (!live?.foreground || !live.epoch) throw new RpcError('FORBIDDEN', '需要当前前台语音终端')
      const previous = this.deps.turns.agentOperation(channelId, input.request.request_id)
      if (previous && sha256CanonicalJson(previous.context) !== sha256CanonicalJson(context)) throw new RpcError('FORBIDDEN', '操作不属于原请求')
      if (input.existing_friend_id !== undefined && (command.action !== 'enroll_new' || typeof input.existing_friend_id !== 'string' || !input.existing_friend_id)) throw new RpcError('INVALID_PARAMS', '已有好友只用于明确的新登记关联')
      let friendId: string | null = null, create = false
      if (command.action === 'enroll_new') {
        friendId = input.existing_friend_id ?? previous?.friend_id ?? randomUUID(); create = input.existing_friend_id === undefined
        const target = this.deps.friends().find(friend => friend.id === friendId)
        if ((!create && !target) || target?.channel_identities.some(identity => identity.channel_id === channelId)) {
          const original = previous && this.deps.turns.agentRequest(channelId, input.request.request_id)
          if (!original || sha256CanonicalJson(original) !== sha256CanonicalJson(input.request)) throw new RpcError('CONFLICT', '目标好友不存在或已有本渠道身份')
        }
      }
      await this.deps.turns.manage(channelId, input.request, this.deps.modelId, false, live.epoch,
        { context, connection_epoch: previous?.connection_epoch ?? live.epoch, friend_id: friendId, create_friend: create, sampled: false, acknowledged: false }, () => this.authorize(context))
      return this.result(context, input.request.request_id)
    }
    assertVoiceUuid(input.operation_id)
    const result = this.result(context, input.operation_id), binding = this.deps.turns.agentOperation(channelId, input.operation_id)
    if (!binding) return result
    if (input.action === 'commit' && binding.sampled && result.status === 'pending') {
      const task = this.deps.turns.agentTask(channelId, input.operation_id)
      if (!task) throw new RpcError('CONFLICT', '原登记任务已变化')
      await this.deps.turns.beginAgentCommit(channelId, input.operation_id)
      if (binding.friend_id) await commitVoiceContactFriend(channelId, task.registration, binding.friend_id, binding.create_friend,
        { friends: this.deps.friends, persist: friend => { this.authorize(context); return this.deps.persist(friend) } })
      this.authorize(context)
      await this.deps.turns.commitAgentEnrollment(channelId, input.operation_id, () => this.authorize(context))
    } else if (input.action === 'ack') await this.deps.turns.acknowledgeAgent(channelId, input.operation_id)
    return this.result(context, input.operation_id)
  }
}
