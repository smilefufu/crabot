/**
 * Front Handler v2 - Fast triage using direct Anthropic API
 *
 * Replaces SDK-based implementation. Zero cold-start, ~10 controlled tools,
 * structured tool_use decisions via make_decision.
 */

import { LLMClient, type LLMClientConfig } from './llm-client.js'
import { ToolExecutor, type ToolExecutorDeps } from './tool-executor.js'
import { runFrontLoop } from './front-loop.js'
import type {
  ChannelMessage,
  FrontAgentContext,
  HandleMessageParams,
  HandleMessageResult,
  TraceCallback,
} from '../types.js'

export interface FrontHandlerConfig {
  systemPrompt: string
}


export class FrontHandler {
  private llmClient: LLMClient
  private toolExecutor: ToolExecutor
  private systemPrompt: string

  constructor(
    llmConfig: LLMClientConfig,
    toolExecutorDeps: ToolExecutorDeps,
    config: FrontHandlerConfig,
  ) {
    this.llmClient = new LLMClient(llmConfig)
    this.toolExecutor = new ToolExecutor(toolExecutorDeps)
    this.systemPrompt = config.systemPrompt
  }

  async handleMessage(
    params: HandleMessageParams,
    traceCallback?: TraceCallback,
  ): Promise<HandleMessageResult> {
    const { messages, context } = params
    const userMessage = buildUserMessage(messages, context)
    const rawUserText = messages.map(m => m.content.text ?? '').join('\n').trim()

    try {
      const result = await runFrontLoop({
        systemPrompt: this.systemPrompt,
        userMessage,
        rawUserText,
        llmClient: this.llmClient,
        toolExecutor: this.toolExecutor,
        traceCallback,
      })

      return { decisions: [result.decision] }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      const isGroup = messages[0]?.session?.type === 'group'
      if (isGroup) {
        return { decisions: [{ type: 'silent' }] }
      }
      return {
        decisions: [{ type: 'direct_reply', reply: { type: 'text', text: `AI 服务异常：${msg}` } }],
      }
    }
  }

  updateLlmConfig(config: Partial<LLMClientConfig>): void {
    this.llmClient.updateConfig(config)
  }
}

/**
 * 构建 Front Handler 发给 LLM 的 user message
 *
 * 将当前消息、上下文（recent_messages / short_term_memories / active_tasks）
 * 组装为结构化的 prompt 文本。
 */
export function buildUserMessage(messages: ChannelMessage[], context: FrontAgentContext): string {
  const parts: string[] = []
  const isGroup = messages[0]?.session?.type === 'group'
  const hasMention = messages.some(m => m.features.is_mention_crab)

  // ── 上下文信息 ──
  parts.push('## 上下文信息')

  if (isGroup) {
    const senderNames = [...new Set(messages.map(m => m.sender.platform_display_name))]
    parts.push(`- 会话类型: 群聊`)
    parts.push(`- 本批消息参与者: ${senderNames.join(', ')}`)
    if (context.crab_display_name) {
      parts.push(`- 你在群中的昵称: ${context.crab_display_name}`)
    }
    parts.push(`- 已知熟人: ${context.sender_friend.display_name} (${context.sender_friend.permission})`)
  } else {
    parts.push(`- 用户: ${context.sender_friend.display_name}`)
    parts.push(`- 会话类型: 私聊`)
  }
  parts.push(`- 活跃任务数: ${context.active_tasks.length}`)

  // ── 活跃任务列表 ──
  if (context.active_tasks.length > 0) {
    parts.push('\n## 活跃任务列表')
    for (const task of context.active_tasks) {
      const sessionInfo = task.source_session_id ? `, 来源session: ${task.source_session_id}` : ''
      parts.push(`- [${task.task_id}] "${task.title}" (status: ${task.status}${sessionInfo})`)
      if (task.latest_progress) {
        parts.push(`  最近进度: ${task.latest_progress}`)
      }
      if (task.plan_summary) {
        parts.push(`  计划摘要: ${task.plan_summary}`)
      }
    }
    parts.push('\n当用户询问任务进度时，请根据上述任务列表回答。')
    parts.push('当用户消息可能是对某个任务的纠偏/补充时，使用 supplement_task 决策。')
    parts.push('纠偏判断优先匹配来源 session 与当前 session 相同的任务。')
  }

  // ── Channel/Session 元信息 ──
  if (messages.length > 0) {
    const session = messages[0].session
    parts.push(`- 当前 Channel ID: ${session.channel_id}`)
    parts.push(`- 当前 Session ID: ${session.session_id}`)
  }

  // ── 记忆系统提示 ──
  if (context.short_term_memories.length > 0) {
    parts.push(`\n- 该用户有 ${context.short_term_memories.length} 条短期记忆（近期事件流水账，记录跨所有 channel/session 的事件摘要，如"用户要求修改某项目"、"任务 X 已完成"等）。短期记忆不是聊天记录。如需查看特定 session 的原始聊天消息，使用 get_history 工具。`)
  }

  // ── 最近消息 ──
  if (context.recent_messages.length > 0) {
    parts.push(`\n## 最近消息（共 ${context.recent_messages.length} 条）`)
    for (const msg of context.recent_messages) {
      const sender = msg.sender.platform_display_name
      const fullText = msg.content.text ?? '[非文本消息]'
      const text = fullText.length > 300 ? fullText.slice(0, 300) + '...[内容截断]' : fullText
      parts.push(`- ${sender}: ${text}`)
    }
  }

  // ── 当前消息 ──
  if (isGroup) {
    parts.push(`\n## 当前群聊消息批次（共 ${messages.length} 条）`)
    parts.push(`- 是否 @你: ${hasMention ? '是' : '否'}`)
    for (const msg of messages) {
      const mention = msg.features.is_mention_crab ? ' [@你]' : ''
      parts.push(`- [${msg.sender.platform_display_name}]${mention}: ${msg.content.text ?? '[非文本消息]'}`)
    }

    if (hasMention) {
      parts.push('\n## 群聊决策提示')
      parts.push('本批次消息 @了你，你必须回复（direct_reply 或 create_task），禁止选择 silent。')
    } else {
      parts.push('\n## 群聊决策提示')
      parts.push('本批次消息没有 @你。群成员之间的讨论（即使涉及技术/代码话题）不算向你提问。')
      parts.push('除非有人明确叫你名字或话题中没有其他对话对象且明显在向你求助，否则默认选择 silent。')
    }
  } else {
    parts.push('\n## 当前消息')
    for (const msg of messages) {
      parts.push(`- ${msg.sender.platform_display_name}: ${msg.content.text ?? '[非文本消息]'}`)
    }
  }

  parts.push('\n## 指令')
  parts.push('请分析上述消息并调用 make_decision 工具输出决策。')
  return parts.join('\n')
}
