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
import * as fs from 'fs'
import * as path from 'path'

const PROMPTS_FILE = path.join(process.cwd(), 'prompts.md')

const DEFAULT_SYSTEM_PROMPT = `你是 Crabot 的分诊员，负责快速分析消息并做出决策。

## 决策输出

你必须调用 make_decision 工具输出决策。四种类型：

1. direct_reply — 直接回复（简单问答、问候、任务状态查询）
2. create_task — 创建新任务（复杂操作、代码编写、数据分析）
3. supplement_task — 补充/纠偏已有任务（用户对正在执行的任务有新指示）
4. silent — 静默（群聊中与自己无关的消息）

## 群聊规则

在群聊中，默认 silent。只有以下情况才回复：
1. 消息标注了 [@你]
2. 结合上下文，消息明显是向你提问
3. 你正在跟进一个活跃任务，用户在追问进展

不满足以上任何条件 -> silent。

## 纠偏判断指南

当用户消息可能是对活跃任务的纠偏时：
- 检查活跃任务列表，优先匹配同 session 发起的任务
- 如果只有一个匹配任务且语义明确 -> confidence: high
- 如果有多个匹配任务或语义模糊 -> confidence: low
- 如果没有活跃任务或消息明显是新请求 -> create_task

## 判断标准

- 能在 1-2 步工具调用内完成 -> direct_reply
- 需要多步骤或复杂推理 -> create_task
- 不确定时 -> create_task（宁可派给 Worker）`

function loadPrompts(): string {
  try {
    if (fs.existsSync(PROMPTS_FILE)) {
      return fs.readFileSync(PROMPTS_FILE, 'utf-8')
    }
  } catch { /* ignore */ }
  return DEFAULT_SYSTEM_PROMPT
}

export interface FrontHandlerConfig {
  personalityPrompt?: string
}

/**
 * Kept for backward compatibility: worker-handler.ts imports this type.
 * Will be removed once worker-handler is updated in Task 10.
 */
export interface SdkEnvConfig {
  modelId: string
  env: Record<string, string>
}

export class FrontHandler {
  private llmClient: LLMClient
  private toolExecutor: ToolExecutor
  private systemPrompt: string

  constructor(
    llmConfig: LLMClientConfig,
    toolExecutorDeps: ToolExecutorDeps,
    config?: FrontHandlerConfig,
  ) {
    this.llmClient = new LLMClient(llmConfig)
    this.toolExecutor = new ToolExecutor(toolExecutorDeps)

    const routingInstructions = loadPrompts()
    this.systemPrompt = config?.personalityPrompt
      ? `${config.personalityPrompt}\n\n${routingInstructions}`
      : routingInstructions
  }

  async handleMessage(
    params: HandleMessageParams,
    traceCallback?: TraceCallback,
  ): Promise<HandleMessageResult> {
    const { messages, context } = params
    const userMessage = this.buildUserMessage(messages, context)
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

  private buildUserMessage(messages: ChannelMessage[], context: FrontAgentContext): string {
    const parts: string[] = []
    parts.push('## 上下文信息')
    parts.push(`- 用户: ${context.sender_friend.display_name}`)
    parts.push(`- 活跃任务数: ${context.active_tasks.length}`)

    if (context.active_tasks.length > 0) {
      parts.push('\n## 活跃任务列表')
      for (const task of context.active_tasks) {
        parts.push(`- [${task.task_id}] "${task.title}" (status: ${task.status}, 类型: ${task.task_type}, 优先级: ${task.priority})`)
        if (task.plan_summary) {
          parts.push(`  计划摘要: ${task.plan_summary}`)
        }
      }
      parts.push('\n当用户询问任务进度时，请根据上述任务列表回答。')
      parts.push('当用户消息可能是对某个任务的纠偏/补充时，使用 supplement_task 决策。')
    }

    if (messages.length > 0) {
      const session = messages[0].session
      parts.push(`- 当前 Channel ID: ${session.channel_id}`)
      parts.push(`- 当前 Session ID: ${session.session_id}`)
      parts.push(`- 会话类型: ${session.type}`)
    }

    if (context.short_term_memories.length > 0) {
      parts.push('\n## 短期记忆（近期对话片段）')
      for (const memory of context.short_term_memories.slice(-3)) {
        const content = memory.content.length > 200 ? memory.content.slice(0, 200) + '...' : memory.content
        parts.push(content)
        parts.push('---')
      }
    }

    if (context.recent_messages.length > 0) {
      parts.push(`\n## 最近消息（共 ${context.recent_messages.length} 条）`)
      for (const msg of context.recent_messages.slice(-10)) {
        const sender = msg.sender.platform_display_name
        const fullText = msg.content.text ?? '[非文本消息]'
        const text = fullText.length > 300 ? fullText.slice(0, 300) + '...[内容截断]' : fullText
        parts.push(`- ${sender}: ${text}`)
      }
    }

    const isGroup = messages[0]?.session?.type === 'group'
    const hasMention = messages.some(m => m.features.is_mention_crab)

    if (isGroup) {
      parts.push(`\n## 当前群聊消息批次（共 ${messages.length} 条）`)
      parts.push(`- 是否 @你: ${hasMention ? '是' : '否'}`)
      for (const msg of messages) {
        const mention = msg.features.is_mention_crab ? ' [@你]' : ''
        parts.push(`- [${msg.sender.platform_display_name}]${mention}: ${msg.content.text ?? '[非文本消息]'}`)
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
}
