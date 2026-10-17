import { createHash } from 'node:crypto'
import type { VoiceAgentActionParams, VoiceAgentContext, VoiceAgentManagementResult } from 'crabot-shared'
import { defineTool, type ToolDefinition } from '../../engine/index.js'

export interface VoiceManagementPort {
  context: VoiceAgentContext
  call(input: VoiceAgentActionParams): Promise<VoiceAgentManagementResult>
}
export const VOICE_TOOL_NAMES = ['list_voice_contacts', 'manage_voice_contacts', 'get_voice_management_result'] as const
export const VOICE_FAMILY_DESCRIPTION = 'voice：记住新人的声音，重新录入或停用已有的声音识别，查询已登记的人，以及修改本渠道中的称呼。'

export function buildVoiceTools(port: VoiceManagementPort): ToolDefinition[] {
  const call = async (action: VoiceAgentActionParams) => {
    try { const result = await port.call(action); return { output: JSON.stringify(result), isError: result.status === 'rejected' } }
    catch { return { output: 'VOICE_OPERATION_UNCONFIRMED', isError: true } }
  }
  const invalid = () => ({ output: 'INVALID_PARAMS', isError: true })
  return [
    defineTool({ name: 'list_voice_contacts', description: '查询本渠道已登记的联系人、关联好友及声音识别是否可用。后续操作使用返回的 ID 指定对象；指代不明或存在同名对象时先澄清。',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false }, isReadOnly: true,
      call: input => Object.keys(input).length ? Promise.resolve(invalid()) : call({ action: 'list', context: port.context }) }),
    defineTool({ name: 'manage_voice_contacts', description: '新增联系人、录入或更新指定联系人的声音、修改本渠道显示名、停用声音识别，或取消已发起的操作。新增联系人默认建立普通好友；关联已有好友时须明确其 ID。录音由设备引导。返回 pending 时等待结果通知，不重复发起，成功前不宣称已经记住。改名仅影响本渠道显示名；停用声音识别保留联系人、好友和历史。',
      inputSchema: { type: 'object', additionalProperties: false, required: ['expected_revision', 'command'], properties: {
        expected_revision: { type: 'integer', minimum: 0 },
        command: { oneOf: [
          { type: 'object', additionalProperties: false, required: ['action', 'display_name'], properties: { action: { const: 'enroll_new' }, display_name: { type: 'string', minLength: 1, maxLength: 128 } } },
          { type: 'object', additionalProperties: false, required: ['action', 'platform_user_id'], properties: { action: { const: 'enroll' }, platform_user_id: { type: 'string' } } },
          { type: 'object', additionalProperties: false, required: ['action', 'platform_user_id', 'display_name'], properties: { action: { const: 'rename_contact' }, platform_user_id: { type: 'string' }, display_name: { type: 'string', minLength: 1, maxLength: 128 } } },
          { type: 'object', additionalProperties: false, required: ['action', 'registration_id'], properties: { action: { enum: ['delete_registration', 'cancel_enrollment'] }, registration_id: { type: 'string' } } },
        ] }, existing_friend_id: { type: 'string' },
      } }, isReadOnly: false,
      call: (input, context) => {
        if (Object.keys(input).some(key => !['expected_revision', 'command', 'existing_friend_id'].includes(key))) return Promise.resolve(invalid())
        if (!context.toolCallId) return Promise.resolve({ output: 'CAPABILITY_UNKNOWN', isError: true })
        const raw = createHash('sha256').update(`${port.context.request_id}\0${context.toolCallId}`).digest('hex').slice(0, 32)
        const id = `${raw.slice(0, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}-${raw.slice(16, 20)}-${raw.slice(20)}`
        return call({ action: 'manage', context: port.context, request: { request_id: id, expected_revision: input.expected_revision as number,
          command: input.command as import('crabot-shared').VoiceManagementCommand }, ...(input.existing_friend_id === undefined ? {} : { existing_friend_id: input.existing_friend_id as string }) })
      } }),
    defineTool({ name: 'get_voice_management_result', description: '核对已发起操作的状态与结果。结果未知时如实说明，不能据此重新发起同一操作；不循环查询。',
      inputSchema: { type: 'object', properties: { operation_id: { type: 'string' } }, required: ['operation_id'], additionalProperties: false }, isReadOnly: true,
      call: input => Object.keys(input).some(key => key !== 'operation_id') ? Promise.resolve(invalid()) : call({ action: 'result', context: port.context, operation_id: input.operation_id as string }) }),
  ]
}
