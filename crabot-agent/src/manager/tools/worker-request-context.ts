import type { ToolCallContext, ToolDefinition } from '../../engine/types.js'
import type { ConversationRequestAuthority } from '../conversation-request-authority.js'

export interface WorkerRequestControl {
  scope: 'shared' | 'request'
  /** Host-only resolution; never sourced from model input. */
  authority(operation: { tool_name: string; worker_id?: string }): Promise<ConversationRequestAuthority | undefined>
}
const CALLER = Symbol('host worker request caller')
type ScopedCall = ToolCallContext & { [CALLER]?: ConversationRequestAuthority }
export function workerRequestCaller(context?: ToolCallContext): ConversationRequestAuthority | undefined {
  return (context as ScopedCall | undefined)?.[CALLER]
}
const SPAWN = '群内派发按当前群授权和主控归属执行；个人授权/私发请求由独立请求上下文处理。'
const CONTROL = '操作按执行器归属和当前群授权核验；个人/私发执行器只能在原请求上下文处理。'

/** A fresh per-call host context prevents concurrent tool calls from swapping actors. */
export function bindWorkerRequestTool(tool: ToolDefinition, control: WorkerRequestControl): ToolDefinition {
  const schema = tool.inputSchema as { properties?: Record<string, unknown> }
  const targetsWorker = tool.name === 'spawn_worker' || Object.prototype.hasOwnProperty.call(schema.properties ?? {}, 'worker_id')
  const prefix = control.scope === 'shared' && targetsWorker && tool.name !== 'get_execution_capabilities' ? (tool.name === 'spawn_worker' ? SPAWN : CONTROL) : ''
  return { ...tool,
    description: prefix + tool.description,
    async call(input, context) {
      try {
        if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('INVALID_PARAMS')
        const args = input as Record<string, unknown>
        const operation = { tool_name: tool.name, ...(typeof args.worker_id === 'string' ? { worker_id: args.worker_id } : {}) }
        const needsCaller = control.scope === 'request' || Object.prototype.hasOwnProperty.call(args, 'worker_id')
        const authority = needsCaller ? await control.authority(operation) : undefined
        if (control.scope === 'request' && !authority) throw new Error('REQUEST_SOURCE_REQUIRED')
        if (authority && authority.executionScope !== (control.scope === 'shared' ? 'group' : 'request')) throw new Error('REQUEST_CONTEXT_SCOPE_MISMATCH')
        return tool.call(args, authority ? { ...context, [CALLER]: authority } as ScopedCall : context)
      } catch (error) { return { isError: true, output: error instanceof Error ? error.message : String(error) } }
    },
  }
}
