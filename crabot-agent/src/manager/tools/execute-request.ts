import { defineTool, type ToolDefinition } from '../../engine/index.js'
import { authorizeTool, roleAuthorization } from '../../permissions/tool-authorization.js'
import { parseConversationRequestProposal } from '../conversation-request-runner.js'
import type { ExecuteConversationRequestParams, ExecuteConversationRequestResult } from '../conversation-request.js'

const ORIGIN_RESULT = '[请求执行结果：沿固定来源、任务范围和投递目标继续处理；不是新的人类授权。]'
const PRIVATE_RESULT = '[本人私发请求状态：正文不在共享上下文显示。不得要求返回正文或改发原群。]'

export function buildExecuteRequestTool(execute: (input: ExecuteConversationRequestParams) => Promise<ExecuteConversationRequestResult>): ToolDefinition {
  return authorizeTool(defineTool({
    name: 'execute_request',
    description: '从当前系统核验的原始输入建立或继续独立请求执行上下文。只传 source_id、唯一原文摘录（可省略表示整条）及原会话/本人私发意图；发起人、Master、权限和完整原文由系统确定。用于需要发起人个人授权或明确私发的请求，不为普通回复预先调用。返回已接纳不代表任务或投递成功；沿原请求结果继续跟进，不以新请求重放未知副作用。',
    inputSchema: { type: 'object', properties: {
      source_id: { type: 'string', description: '系统为当前已接纳原始输入提供的定位ID；不能用旧消息、任务摘要或别人转述替代。' },
      quote: { type: 'string', description: '该原始消息中唯一匹配的精确任务摘录；省略使用整条。系统仍保留完整原文中的条件、否定和投递要求。' },
      delivery: { type: 'string', enum: ['origin', 'requester_private'], description: 'origin 默认回原会话；只有原发起人明确要求结果私发本人时才选 requester_private。不能指定其他接收者或借此改变执行权限。' },
    }, required: ['source_id', 'delivery'], additionalProperties: false },
    isReadOnly: false,
    async call(input) {
      let args: ExecuteConversationRequestParams
      try { args = parseConversationRequestProposal(input) }
      catch (error) { return { output: error instanceof Error ? error.message : String(error), isError: true } }
      const prefix = args.delivery === 'requester_private' ? PRIVATE_RESULT : ORIGIN_RESULT
      try {
        const result = await execute(args)
        // Return a fixed status projection, never a nested model/tool body from another context.
        const receipt: ExecuteConversationRequestResult = { request_id: result.request_id, status: result.status, delivery: result.delivery, worker_ids: [...result.worker_ids] }
        return { output: prefix + '\n' + JSON.stringify(receipt), isError: result.status === 'recovery_required' }
      } catch { return { output: prefix + '\n' + JSON.stringify({ error: 'REQUEST_EXECUTION_FAILED' }), isError: true } }
    },
  }), roleAuthorization('manager'))
}
