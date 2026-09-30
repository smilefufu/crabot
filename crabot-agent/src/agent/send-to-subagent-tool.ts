import type { ToolCallContext, ToolCallResult, ToolDefinition } from '../engine/types.js'

export function createSendToSubagentTool(
  sendInput: (agentId: string, text: string, context: ToolCallContext) => Promise<ToolCallResult>,
): ToolDefinition {
  return {
    name: 'send_to_subagent',
    description: '向你委派且尚未结束的子 Agent 追加要求、补充信息或纠偏。传入 delegate_task 返回的 agent_id；消息会在当前在途执行完成后的下一次模型请求前注入。若子 Agent 正因异步结果而暂停本轮，系统会恢复原上下文继续执行。返回 queued 只表示消息已受理，不代表已经处理；可用 Output 查看进展，最终结果仍由系统自动通知。已结束的子 Agent 不接受追加，此工具不会创建或重启子任务。',
    isReadOnly: false,
    inputSchema: {
      type: 'object', required: ['agent_id', 'text'], properties: {
        agent_id: { type: 'string', description: 'delegate_task 返回的、尚未结束的直接子 Agent 标识。' },
        text: { type: 'string', description: '需要该子 Agent 处理的追加要求或信息。' },
      },
    },
    call: async (input, context) => {
      if (typeof input.agent_id !== 'string' || !/^agent_.+/.test(input.agent_id)) {
        return { output: 'Invalid agent_id', isError: true }
      }
      if (typeof input.text !== 'string' || !input.text.trim()) {
        return { output: 'Invalid text: expected a non-empty string', isError: true }
      }
      return sendInput(input.agent_id, input.text, context)
    },
  }
}
