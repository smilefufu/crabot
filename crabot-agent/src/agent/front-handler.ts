/**
 * Front Handler - 快速分诊处理器
 *
 * 使用 Claude Agent SDK 的 outputFormat 实现结构化输出
 */

import { runSdk, type SdkRunOptions } from './sdk-runner.js'
import type {
  ChannelMessage,
  FrontAgentContext,
  HandleMessageParams,
  HandleMessageResult,
  MessageDecision,
  MessageContent,
  TraceCallback,
} from '../types.js'
import { jsonrepair } from 'jsonrepair'
import * as fs from 'fs'
import * as path from 'path'

const LOG_FILE = path.join(process.cwd(), '../data/front-handler-debug.log')
const PROMPTS_FILE = path.join(process.cwd(), 'prompts.md')

function logToFile(message: string) {
  const timestamp = new Date().toISOString()
  try { fs.appendFileSync(LOG_FILE, `[${timestamp}] ${message}\n`) } catch { /* ignore */ }
  console.log(message)
}

function loadPrompts(): string {
  try {
    if (fs.existsSync(PROMPTS_FILE)) {
      return fs.readFileSync(PROMPTS_FILE, 'utf-8')
    }
  } catch { /* ignore */ }
  return DEFAULT_ROUTING_INSTRUCTIONS
}

export interface SdkEnvConfig {
  modelId: string
  env: Record<string, string>
}

export interface FrontHandlerConfig {
  personalityPrompt?: string
  maxIterations: number
}

const DEFAULT_ROUTING_INSTRUCTIONS = `## 分诊规则（内部指令）

你负责快速处理用户消息。你有两种方式响应：

### 方式一：直接处理（简单问题、快速命令）
- 问候、简单问答、数学计算 → 直接文字回复
- 简单命令（pwd、ls、cat 等）→ 使用工具执行后回复结果
- 直接处理时，输出 JSON：
\`\`\`json
{"decisions":[{"type":"direct_reply","reply":{"type":"text","text":"你的回复内容"}}]}
\`\`\`
- 如果你已经用工具得到了结果，把工具输出写进 reply.text 即可

### 方式二：创建任务（复杂问题）
- 需要多步骤操作、代码生成、数据分析、复杂文件操作 → 创建任务
- 输出 JSON：
\`\`\`json
{"decisions":[{"type":"create_task","task_title":"任务标题","task_description":"任务详细描述","task_type":"general","immediate_reply":{"type":"text","text":"好的，我来处理这个任务，请稍等..."}}]}
\`\`\`

### 任务进度查询
- 用户问"任务进度"、"处理得怎么样了"、"之前那个任务"等 → 从上下文的活跃任务列表中查找并直接回复状态
- 如果没有活跃任务 → 告知用户当前没有正在处理的任务

### 判断标准
- 能在 1-2 步工具调用内完成 → 直接处理
- 需要 3 步以上或复杂推理 → 创建任务
- 不确定时 → 创建任务（宁可派给 Worker，不要卡住用户）

### 规则
- create_task 必须包含：type, task_title, task_description, task_type
- task_type 可以是：general, code, analysis, command 等
- 你的回复必须包含上述 JSON 格式的决策

### 聊天历史
- 上下文中已包含该 Session 的最近 10 条消息
- 如果需要更早的消息来理解上下文，使用 get_history 工具查询
- 如果需要发送消息到其他会话，使用 send_message 工具`

export class FrontHandler {
  private config: FrontHandlerConfig
  private systemPrompt: string
  private sdkEnv: SdkEnvConfig
  /** Factory that creates fresh MCP server configs per runSdk() call (avoids Protocol reuse) */
  private mcpConfigFactory: (() => Record<string, import('./sdk-runner.js').SdkMcpServerConfig>) | undefined

  constructor(
    sdkEnv: SdkEnvConfig,
    config?: Partial<FrontHandlerConfig>,
    mcpConfigFactory?: () => Record<string, import('./sdk-runner.js').SdkMcpServerConfig>,
  ) {
    this.sdkEnv = sdkEnv
    this.mcpConfigFactory = mcpConfigFactory
    this.config = {
      personalityPrompt: config?.personalityPrompt,
      maxIterations: config?.maxIterations ?? 10,
    }
    const routingInstructions = loadPrompts()
    this.systemPrompt = this.config.personalityPrompt
      ? `${this.config.personalityPrompt}\n\n${routingInstructions}`
      : routingInstructions
  }

  async handleMessage(
    params: HandleMessageParams,
    traceCallback?: TraceCallback,
  ): Promise<HandleMessageResult> {
    const { messages, context } = params
    const userMessage = this.buildUserMessage(messages, context)

    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        // Create fresh MCP server instances per attempt to avoid Protocol reuse
        const mcpServers = this.mcpConfigFactory?.()
        const sdkOpts: SdkRunOptions = {
          prompt: userMessage,
          systemPrompt: this.systemPrompt,
          model: this.sdkEnv.modelId,
          env: this.sdkEnv.env,
          maxTurns: this.config.maxIterations,
          loopLabel: 'front',
          // 不设 allowedTools — 让 Front 有基础工具（Bash, Read 等）
          // 简单命令直接执行，复杂任务通过 JSON 决策派给 Worker
          ...(mcpServers && Object.keys(mcpServers).length > 0 && { mcpServers }),
          traceCallback,
        }

        const result = await runSdk(sdkOpts)

        // 1. 优先从 structuredOutput 解析 JSON 决策
        if (result.structuredOutput) {
          const parsed = result.structuredOutput as { decisions?: Record<string, unknown>[] }
          if (Array.isArray(parsed.decisions) && parsed.decisions.length > 0) {
            return { decisions: parsed.decisions.map((d) => this.parseDecision(d)) }
          }
        }

        // 2. 从文本中解析 JSON 决策
        if (result.text) {
          const jsonDecisions = this.extractDecisionsFromText(result.text)
          if (jsonDecisions) {
            return jsonDecisions
          }

          // 3. 有文本但不是 JSON 决策 → 模型可能用了工具后直接给出了回答
          //    私聊：包装为 direct_reply；群聊无@：静默
          if (result.text.trim().length > 0 && !result.text.includes('"decisions"')) {
            const isGroup = messages[0]?.session?.type === 'group'
            const hasMention = messages.some((m) => m.features.is_mention_crab)
            if (isGroup && !hasMention) {
              logToFile(`[FrontHandler] 群聊无@提及，纯文本输出静默处理`)
              return { decisions: [{ type: 'silent' }] }
            }
            logToFile(`[FrontHandler] 模型返回纯文本（可能用了工具），包装为 direct_reply`)
            return {
              decisions: [{
                type: 'direct_reply',
                reply: { type: 'text', text: result.text.trim() },
              }],
            }
          }
        }

        // 4. error_max_turns 或工具调用失败
        if (result.isError || (result.toolCalls.length > 0 && !result.text?.trim())) {
          logToFile(`[FrontHandler] 工具调用失败或超限(isError=${result.isError}, toolCalls=${result.toolCalls.length})`)
          const isGroup = messages[0]?.session?.type === 'group'
          if (isGroup) {
            return { decisions: [{ type: 'silent' }] }
          }
          return {
            decisions: [{
              type: 'create_task',
              task_title: this.extractTaskTitle(messages),
              task_description: messages.map(m => m.content.text ?? '').join('\n'),
              task_type: 'general',
              immediate_reply: { type: 'text', text: '收到，我来处理一下，请稍等...' },
            }],
          }
        }

        logToFile(`[FrontHandler] 第 ${attempt + 1} 次未返回有效决策，重试...`)
      }

      logToFile('[FrontHandler] 所有尝试均失败')
      const isGroup = messages[0]?.session?.type === 'group'
      if (isGroup) {
        return { decisions: [{ type: 'silent' }] }
      }
      return { decisions: [{ type: 'direct_reply', reply: { type: 'text', text: 'AI 服务暂时无法响应，请稍后再试' } }] }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      logToFile(`[FrontHandler] 异常: ${msg}`)
      const isGroup = messages[0]?.session?.type === 'group'
      if (isGroup) {
        return { decisions: [{ type: 'silent' }] }
      }
      return { decisions: [{ type: 'direct_reply', reply: { type: 'text', text: `AI 服务异常：${msg}` } }] }
    }
  }

  private buildUserMessage(messages: ChannelMessage[], context: FrontAgentContext): string {
    const parts: string[] = []
    parts.push('## 上下文信息')
    parts.push(`- 用户: ${context.sender_friend.display_name}`)
    parts.push(`- 活跃任务数: ${context.active_tasks.length}`)

    if (context.active_tasks.length > 0) {
      parts.push('\n## 活跃任务列表')
      for (const task of context.active_tasks) {
        parts.push(`- [${task.status}] ${task.title} (ID: ${task.task_id}, 类型: ${task.task_type}, 优先级: ${task.priority})`)
        if (task.plan_summary) {
          parts.push(`  计划摘要: ${task.plan_summary}`)
        }
      }
      parts.push('\n当用户询问任务进度时，请根据上述任务列表回答。')
    }

    // 从消息中提取当前会话信息（crab-messaging 工具需要）
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
      parts.push(`\n## 最近消息（已预加载，共 ${context.recent_messages.length} 条；如需更早历史，用 get_history 工具获取）`)
      for (const msg of context.recent_messages.slice(-10)) {
        const sender = msg.sender.platform_display_name
        const fullText = msg.content.text ?? '[非文本消息]'
        const text = fullText.length > 300 ? fullText.slice(0, 300) + '...[内容截断]' : fullText
        parts.push(`- ${sender}: ${text}`)
      }
    } else {
      parts.push('\n## 最近消息（暂无历史记录，如需更早历史可用 get_history 工具）')
    }

    const isGroup = messages[0]?.session?.type === 'group'
    const hasMention = messages.some((m) => m.features.is_mention_crab)

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

    if (context.available_tools.length > 0) {
      parts.push('\n## 可用工具')
      for (const t of context.available_tools) { parts.push(`- ${t.name}: ${t.description}`) }
    }

    parts.push('\n## 指令')
    parts.push('请分析上述消息并做出决策。输出结构化的 JSON 决策结果。')
    return parts.join('\n')
  }

  /**
   * 从 LLM 文本输出中提取 decisions JSON
   *
   * 流程：先 JSON.parse，失败则用 jsonrepair 修复后重试。
   * LLM（尤其非 Anthropic 模型通过 LiteLLM 代理）有时输出末尾损坏的 JSON，
   * 例如 `"}n }"` 等多余字符，jsonrepair 能自动修复。
   */
  private extractDecisionsFromText(text: string): HandleMessageResult | null {
    const m = text.match(/\{[\s\S]*"decisions"[\s\S]*\}/)
    if (!m) return null

    // 尝试 1：直接 JSON.parse
    try {
      const parsed = JSON.parse(m[0]) as { decisions?: Record<string, unknown>[] }
      if (Array.isArray(parsed.decisions) && parsed.decisions.length > 0) {
        return { decisions: parsed.decisions.map((d) => this.parseDecision(d)) }
      }
    } catch {
      // 尝试 2：jsonrepair 修复后重试
      try {
        const repaired = jsonrepair(m[0])
        logToFile(`[FrontHandler] JSON.parse 失败，jsonrepair 修复后重试`)
        const parsed = JSON.parse(repaired) as { decisions?: Record<string, unknown>[] }
        if (Array.isArray(parsed.decisions) && parsed.decisions.length > 0) {
          return { decisions: parsed.decisions.map((d) => this.parseDecision(d)) }
        }
      } catch (e) {
        logToFile(`[FrontHandler] jsonrepair 也失败: ${e instanceof Error ? e.message : String(e)}`)
      }
    }

    return null
  }

  /**
   * 从消息中提取简短的任务标题
   */
  private extractTaskTitle(messages: ChannelMessage[]): string {
    const text = messages.map(m => m.content.text ?? '').join(' ').trim()
    if (!text) return '用户请求'
    return text.length > 50 ? text.slice(0, 50) + '...' : text
  }

  private parseDecision(d: Record<string, unknown>): MessageDecision {
    const type = d.type as string
    switch (type) {
      case 'direct_reply': {
        const reply = d.reply as Record<string, unknown> | undefined
        return {
          type: 'direct_reply',
          reply: {
            type: (reply?.type as 'text' | 'image' | 'file') ?? 'text',
            text: reply?.text as string | undefined,
            media_url: reply?.media_url as string | undefined,
          } as MessageContent,
        }
      }
      case 'create_task': {
        const ir = d.immediate_reply as Record<string, unknown> | undefined
        // 兼容多种字段名：task_title 或 title 或 reply.name
        const taskTitle = (d.task_title ?? d.title ??
          (d.reply as Record<string, unknown> | undefined)?.name) as string | undefined
        // 兼容多种字段名：task_description 或 description 或 reply.prompt
        const taskDesc = (d.task_description ?? d.description ??
          (d.reply as Record<string, unknown> | undefined)?.prompt) as string | undefined
        return {
          type: 'create_task',
          task_title: taskTitle ?? '未命名任务',
          task_description: taskDesc ?? '',
          task_type: (d.task_type ?? 'general') as string,
          priority: d.priority as string | undefined,
          preferred_worker_specialization: d.preferred_worker_specialization as string | undefined,
          immediate_reply: ir
            ? { type: (ir.type as 'text' | 'image' | 'file') ?? 'text', text: ir.text as string | undefined, media_url: ir.media_url as string | undefined }
            : { type: 'text', text: '好的，我来处理这个任务，请稍等...' },
        }
      }
      case 'forward_to_worker':
        return {
          type: 'forward_to_worker',
          task_id: d.task_id as string,
          immediate_reply: d.immediate_reply ? (d.immediate_reply as MessageContent) : undefined,
        }
      case 'silent':
        return { type: 'silent' }
      default:
        return { type: 'direct_reply', reply: { type: 'text', text: '未知的决策类型' } }
    }
  }
}
