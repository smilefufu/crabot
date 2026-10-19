import { assertVoiceUuid, type VoiceAgentActionParams, type VoiceAgentContext, type VoiceAgentManagementReadyPayload, type VoiceAgentManagementResult } from 'crabot-shared'
import { ConversationRequestStore, requestSourceFor } from './conversation-request-store.js'
import { ConversationRequestAuthority } from './conversation-request-authority.js'
import type { ConversationRequestRunner } from './conversation-request-runner.js'
import type { ManagerKey } from './types.js'
import { allowed, denied } from '../permissions/tool-authorization.js'

interface Dependencies {
  requests: ConversationRequestStore
  runner: ConversationRequestRunner
  resolveCurrent: ConstructorParameters<typeof ConversationRequestAuthority>[4]
  call(input: VoiceAgentActionParams): Promise<VoiceAgentManagementResult>
}
export class VoiceManagementHost {
  constructor(private readonly deps: Dependencies) {}
  private async bound(key: ManagerKey, requestId: string) {
    const fixed = await this.deps.requests.get(key, requestId), voice = fixed?.source.message.features.voice
    if (!fixed || !voice || fixed.record.status !== 'open' || !fixed.record.permission_sources.friend?.is_master) throw new Error('Original Master voice request unavailable')
    return { fixed, context: { request_id: requestId, source: requestSourceFor(fixed.source), turn_id: voice.turn_id, delivery: fixed.record.delivery.kind } satisfies VoiceAgentContext,
      authority: new ConversationRequestAuthority(this.deps.requests, key, requestId, 'request', this.deps.resolveCurrent) }
  }
  private async call(key: ManagerKey, requestId: string, action: 'result' | 'commit' | 'ack', operationId: string): Promise<VoiceAgentManagementResult> {
    const bound = await this.bound(key, requestId)
    return bound.authority.run(async source => source.kind === 'friend' && source.is_master ? allowed : denied('PERMISSION_DENIED', '需要原发起人的 Master 授权'),
      () => this.deps.call({ action, context: bound.context, operation_id: operationId }))
  }
  async validate(key: ManagerKey, requestId: string, expected: VoiceAgentManagementResult): Promise<void> {
    if (!expected.operation_id) throw new Error('Management operation unavailable')
    const actual = await this.call(key, requestId, 'result', expected.operation_id)
    if (actual.status !== expected.status || actual.friend_id !== expected.friend_id || actual.code !== expected.code) throw new Error('Management result does not match the original operation')
  }
  async ready(raw: VoiceAgentManagementReadyPayload): Promise<void> {
    if (!raw || typeof raw !== 'object' || Object.keys(raw).sort().join(',') !== 'channel_id,operation_id,request_id,session_id'
      || typeof raw.channel_id !== 'string' || typeof raw.session_id !== 'string' || typeof raw.request_id !== 'string' || !/^[a-f0-9]{64}$/.test(raw.request_id)) throw new Error('Invalid management locator')
    assertVoiceUuid(raw.operation_id)
    const key = `${raw.channel_id}::${raw.session_id}` as ManagerKey
    let result = await this.call(key, raw.request_id, 'result', raw.operation_id)
    if (result.status === 'pending') result = await this.call(key, raw.request_id, 'commit', raw.operation_id)
    if (!['completed', 'rejected'].includes(result.status)) return
    await this.deps.runner.routeVoiceManagement(key, raw.request_id, result)
    await this.call(key, raw.request_id, 'ack', raw.operation_id)
  }
}
