/**
 * Front Handler v2 - Fast triage using engine LLM adapter
 *
 * Replaces SDK-based implementation. Zero cold-start, ~10 controlled tools,
 * structured tool_use decisions via reply/create_task/supplement_task/stay_silent.
 */

import type { LLMAdapter } from '../engine/llm-adapter.js'
import type { ContentBlock, ToolDefinition } from '../engine/types.js'
import { ToolExecutor, type ToolExecutorDeps } from './tool-executor.js'
import { runFrontLoop } from './front-loop.js'
import { mcpServerToToolDefinitions } from './mcp-tool-bridge.js'
import { resolveImageBlocks } from './media-resolver.js'
import { formatMessageContent } from './media-resolver.js'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type {
  ChannelMessage,
  FrontAgentContext,
  HandleMessageParams,
  HandleMessageResult,
  TraceCallback,
} from '../types.js'

export type UserMessageContent = string | ContentBlock[]

export interface FrontHandlerConfig {
  getSystemPrompt: (isGroup: boolean) => string
  /**
   * 工厂返回 MCP server 实例集合（与 Worker 同款）。Front 启动每次 handleMessage 前调用，
   * 把这些 server 转成 ToolDefinition[] 拼到 Front 工具集中。messaging 工具在此注入，
   * 无需在 front-tools.ts 重新声明。
   */
  mcpConfigFactory: () => Record<string, McpServer>
}

export interface FrontHandlerLlmConfig {
  readonly adapter: LLMAdapter
  readonly model: string
}


export class FrontHandler {
  private adapter: LLMAdapter
  private model: string
  private toolExecutor: ToolExecutor
  private getSystemPrompt: (isGroup: boolean) => string
  private mcpConfigFactory: () => Record<string, McpServer>

  constructor(
    llmConfig: FrontHandlerLlmConfig,
    toolExecutorDeps: ToolExecutorDeps,
    config: FrontHandlerConfig,
  ) {
    this.adapter = llmConfig.adapter
    this.model = llmConfig.model
    this.toolExecutor = new ToolExecutor(toolExecutorDeps)
    this.getSystemPrompt = config.getSystemPrompt
    this.mcpConfigFactory = config.mcpConfigFactory
  }

  async handleMessage(
    params: HandleMessageParams,
    traceCallback?: TraceCallback,
  ): Promise<HandleMessageResult> {
    const { messages, context } = params
    const isGroup = messages[0]?.session?.type === 'group'
    const hasMention = messages.some(m => m.features.is_mention_crab)
    // silent 仅在群聊且未被 @ 时可用
    const allowSilent = isGroup && !hasMention
    const imageBlocks = await resolveImageBlocks(messages)
    const userMessage = buildUserMessage(messages, context, imageBlocks)
    const rawUserText = messages.map(m => m.content.text ?? '').join('\n').trim()

    // 装配 messaging 工具（来自 crab-messaging MCP；与 Worker 同一份实现）
    const mcpServers = this.mcpConfigFactory()
    const messagingTools: ToolDefinition[] = []
    for (const [serverName, server] of Object.entries(mcpServers)) {
      messagingTools.push(...mcpServerToToolDefinitions(server, serverName))
    }

    try {
      const result = await runFrontLoop({
        systemPrompt: this.getSystemPrompt(isGroup),
        userMessage,
        rawUserText,
        allowSilent,
        activeTaskIds: context.active_tasks.map(t => t.task_id),
        adapter: this.adapter,
        model: this.model,
        toolExecutor: this.toolExecutor,
        messagingTools,
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

  updateLlmConfig(config: { endpoint?: string; apikey?: string; accountId?: string; model?: string }): void {
    if (config.endpoint !== undefined || config.apikey !== undefined || config.accountId !== undefined) {
      this.adapter.updateConfig({
        ...(config.endpoint !== undefined ? { endpoint: config.endpoint } : {}),
        ...(config.apikey !== undefined ? { apikey: config.apikey } : {}),
        ...(config.accountId !== undefined ? { accountId: config.accountId } : {}),
      })
    }
    if (config.model !== undefined) {
      this.model = config.model
    }
  }
}

/**
 * 构建 Front Handler 发给 LLM 的 user message
 *
 * 将当前消息、上下文（recent_messages / short_term_memories / active_tasks）
 * 组装为结构化的 prompt 文本。
 */
export function buildUserMessage(
  messages: ChannelMessage[],
  context: FrontAgentContext,
  imageBlocks?: Array<{ type: 'image'; source: { type: 'base64' | 'url'; media_type: string; data: string } }>,
): UserMessageContent {
  const parts: string[] = []
  const isGroup = messages[0]?.session?.type === 'group'
  const hasMention = messages.some(m => m.features.is_mention_crab)

  if (context.scene_profile) {
    parts.push(`## 场景画像（${context.scene_profile.label}）`)
    parts.push('以下内容是当前场景必须加载并遵守的上下文：')
    parts.push('')
    parts.push(context.scene_profile.content)
    parts.push('')
  }

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
      const fullText = formatMessageContent(msg)
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
      parts.push(`- [${msg.sender.platform_display_name}]${mention}: ${formatMessageContent(msg)}`)
    }

    if (hasMention) {
      parts.push('\n## 群聊决策提示')
      parts.push('本批次消息 @了你，你必须回复（reply 或 create_task），禁止选择 stay_silent。')
    } else {
      // 检测对话延续性：recent_messages 中 bot 近期是否参与过对话
      const crabName = context.crab_display_name
      const botRecentlyActive = crabName
        ? context.recent_messages.some(m => m.sender.platform_display_name === crabName)
        : false

      // 检测引用回复：当前消息是否引用了 bot 的消息
      const quotedBotMessage = crabName
        ? messages.some(m => {
            const quoteId = m.features.quote_message_id ?? m.features.reply_to_message_id
            if (!quoteId) return false
            return context.recent_messages.some(
              rm => rm.platform_message_id === quoteId && rm.sender.platform_display_name === crabName
            )
          })
        : false

      parts.push('\n## 群聊决策提示')
      if (quotedBotMessage) {
        parts.push('本批次消息引用了你之前的回复，你应该回复（reply 或 create_task），禁止选择 stay_silent。')
      } else if (botRecentlyActive) {
        parts.push('本批次消息没有 @你，但你近期在群中参与过对话。如果本条消息与你之前的回复相关（如追问、延续讨论），你应该回复（reply）。')
        parts.push('如果消息明显与你无关（群成员之间的独立讨论、转换了话题），则选择 stay_silent。')
      } else {
        parts.push('本批次消息没有 @你。群成员之间的讨论（即使涉及技术/代码话题）不算向你提问。')
        parts.push('除非有人明确叫你名字或话题中没有其他对话对象且明显在向你求助，否则默认选择 stay_silent。')
      }
    }
  } else {
    parts.push('\n## 当前消息')
    for (const msg of messages) {
      parts.push(`- ${msg.sender.platform_display_name}: ${formatMessageContent(msg)}`)
    }
  }

  parts.push('\n## 指令')
  parts.push('请分析上述消息并调用决策工具（reply / create_task / supplement_task / stay_silent）。')

  const textPrompt = parts.join('\n')

  // 如果有图片内容，返回 ContentBlock[]（text + image blocks）
  if (imageBlocks && imageBlocks.length > 0) {
    return [
      { type: 'text' as const, text: textPrompt },
      ...imageBlocks,
    ]
  }

  return textPrompt
}
