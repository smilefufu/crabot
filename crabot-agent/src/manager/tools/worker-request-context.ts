import type { ToolCallContext, ToolDefinition } from '../../engine/types.js'
import type { ConversationRequestAuthority } from '../conversation-request-authority.js'

export interface WorkerRequestControl {
  scope: 'shared' | 'request'
  authority(selection: { source_id?: string; quote?: string }, operation: { tool_name: string; worker_id?: string }): Promise<ConversationRequestAuthority | undefined>
}
const CALLER = Symbol('host worker request caller')
type ScopedCall = ToolCallContext & { [CALLER]?: ConversationRequestAuthority }
export function workerRequestCaller(context?: ToolCallContext): ConversationRequestAuthority | undefined {
  return (context as ScopedCall | undefined)?.[CALLER]
}
const SOURCE_FIELDS = {
  source_id: { type: 'string', description: '系统为当前已接纳原始输入提供的定位ID；不能用旧消息、任务摘要或别人转述替代。' },
  quote: { type: 'string', description: '该原始消息中唯一匹配的精确任务摘录；省略使用整条。系统仍保留完整原文中的条件、否定和投递要求。' },
}
const SPAWN = '群内派发须关联系统提供的当前原始请求来源；此共享主控入口只使用群授权，不因 source_id 获得个人权限。需要本人权限或只向本人私发时先走 execute_request。个人请求上下文中的派发由系统固定原来源，不接收另一个人的授权身份。'
const CONTROL = '操作须关联当前真实请求来源，系统核验任务归属、原上限和当前授权。同群或相同权限模板不自动允许操作他人的个人任务；拒绝后不要换旧请求 ID、改发摘要或直接转述来绕过。'

/** A fresh per-call host context prevents concurrent tool calls from swapping actors. */
export function bindWorkerRequestTool(tool: ToolDefinition, control: WorkerRequestControl): ToolDefinition {
  const schema = tool.inputSchema as { properties?: Record<string, unknown> }
  const targetsWorker = tool.name === 'spawn_worker' || Object.prototype.hasOwnProperty.call(schema.properties ?? {}, 'worker_id')
  const prefix = control.scope === 'shared' && targetsWorker && tool.name !== 'get_execution_capabilities' ? (tool.name === 'spawn_worker' ? SPAWN : CONTROL) : ''
  return { ...tool,
    description: prefix + tool.description,
    inputSchema: control.scope === 'shared' && targetsWorker ? { ...tool.inputSchema, properties: { ...schema.properties, ...SOURCE_FIELDS } } : tool.inputSchema,
    async call(input, context) {
      try {
        if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('INVALID_PARAMS')
        const { source_id, quote, ...args } = input
        if (control.scope === 'request' && (source_id !== undefined || quote !== undefined)) throw new Error('REQUEST_IDENTITY_IS_FIXED')
        if (source_id !== undefined && (typeof source_id !== 'string' || !source_id.trim()) || quote !== undefined && typeof quote !== 'string') throw new Error('INVALID_REQUEST_SOURCE')
        const needsCaller = tool.name === 'spawn_worker' || Object.prototype.hasOwnProperty.call(input, 'worker_id') || control.scope === 'request'
        const selection = { ...(typeof source_id === 'string' ? { source_id } : {}), ...(typeof quote === 'string' ? { quote } : {}) }
        const operation = { tool_name: tool.name, ...(typeof input.worker_id === 'string' ? { worker_id: input.worker_id } : {}) }
        const authority = needsCaller ? await control.authority(selection, operation) : undefined
        if ((tool.name === 'spawn_worker' || control.scope === 'request') && !authority) throw new Error('REQUEST_SOURCE_REQUIRED')
        if (authority && authority.executionScope !== (control.scope === 'shared' ? 'group' : 'request')) throw new Error('REQUEST_CONTEXT_SCOPE_MISMATCH')
        return tool.call(args, { ...context, [CALLER]: authority } as ScopedCall)
      } catch (error) { return { isError: true, output: error instanceof Error ? error.message : String(error) } }
    },
  }
}
