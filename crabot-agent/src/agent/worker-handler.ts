/**
 * Worker Handler v3 - 任务执行处理器（self-built engine）
 *
 * 使用自建 engine 替代 claude-agent-sdk 的 query()：
 * - runEngine() + AnthropicAdapter 驱动 LLM 循环
 * - ToolDefinition[] 统一工具注册
 * - humanMessageQueue 注入纠偏消息
 * - AbortController 取消任务
 * - MCP Server 工具自动转换为 ToolDefinition
 */

import {
  runEngine,
  createAdapter,
  defineTool,
  getConfiguredBuiltinTools,
} from '../engine/index.js'
import type {
  ToolDefinition,
  EngineTurnEvent,
  EngineResult,
  ContentBlock,
} from '../engine/index.js'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod/v4'
import type {
  ExecuteTaskParams,
  ExecuteTaskResult,
  WorkerAgentContext,
  WorkerTaskState,
  TaskId,
  TaskOrigin,
  ChannelMessage,
  TraceCallback,
  SkillConfig,
  BuiltinToolConfig,
} from '../types.js'
import type { RpcClient } from '../core/module-base.js'
import { createCrabMemoryServer } from '../mcp/crab-memory.js'
import type { MemoryTaskContext } from '../mcp/crab-memory.js'
import { formatMessageContent } from './media-resolver.js'
import type { McpConnector } from './mcp-connector.js'

import * as fs from 'fs'
import * as path from 'path'

const LOG_FILE = path.join(process.cwd(), '../data/worker-handler-debug.log')

function log(msg: string) {
  const ts = new Date().toISOString()
  try { fs.appendFileSync(LOG_FILE, `[${ts}] ${msg}\n`) } catch { /* ignore */ }
}

export interface WorkerHandlerConfig {
  systemPrompt: string
  longTermPreloadLimit?: number
}

export interface WorkerDeps {
  rpcClient: RpcClient
  moduleId: string
  resolveChannelPort: (channelId: string) => Promise<number>
  getMemoryPort: () => Promise<number>
}

import type { LLMFormat } from '../engine/llm-adapter'

export interface SdkEnvConfig {
  modelId: string
  format: LLMFormat
  env: Record<string, string>
}

/** Human-readable descriptions for tools (used in sanitized progress for non-master sessions) */
const TOOL_DESCRIPTIONS: Record<string, string> = {
  'mcp__crabot-worker__ask_human': '请求人类反馈',
  'mcp__crab-memory__store_memory': '写入长期记忆',
  'mcp__crab-memory__search_memory': '搜索记忆',
  'mcp__crab-memory__get_memory_detail': '查看记忆详情',
  'Skill': '使用技能',
}

/** Tool prefixes that are internal agent workflow — never reported as progress */
const INTERNAL_TOOL_PREFIXES = [
  'mcp__crab-messaging__',
]

// ============================================================================
// MCP Server → ToolDefinition conversion
// ============================================================================

interface RegisteredMcpTool {
  description?: string
  inputSchema?: unknown
  enabled?: boolean
  handler: {
    (args: Record<string, unknown>, extra: unknown): Promise<{ content: Array<{ type: string; text?: string }>; isError?: boolean }>
  }
}

/**
 * Convert a McpServer's registered tools into engine ToolDefinition[].
 * Uses the internal _registeredTools map (McpServer from @modelcontextprotocol/sdk).
 */
function mcpServerToToolDefinitions(
  server: McpServer,
  serverName: string,
): ToolDefinition[] {
  // Access the internal _registeredTools map
  const registeredTools = (server as unknown as { _registeredTools: Record<string, RegisteredMcpTool> })._registeredTools
  if (!registeredTools) return []

  const tools: ToolDefinition[] = []

  for (const [toolName, registeredTool] of Object.entries(registeredTools)) {
    if (registeredTool.enabled === false) continue

    const prefixedName = `mcp__${serverName}__${toolName}`

    // Convert zod schema to JSON schema for the engine
    let inputSchema: Record<string, unknown> = { type: 'object', properties: {} }
    if (registeredTool.inputSchema) {
      try {
        // Use zod's toJSONSchema if available, otherwise use a basic conversion
        const zodSchema = registeredTool.inputSchema as { _def?: unknown }
        if (typeof (z as unknown as { toJSONSchema?: unknown }).toJSONSchema === 'function') {
          inputSchema = (z as unknown as { toJSONSchema: (s: unknown) => Record<string, unknown> }).toJSONSchema(zodSchema)
        }
      } catch {
        // Fallback: empty object schema
      }
    }

    const handler = registeredTool.handler
    tools.push(defineTool({
      name: prefixedName,
      description: registeredTool.description ?? '',
      inputSchema,
      isReadOnly: false,
      call: async (input) => {
        try {
          const result = await handler(input, {})
          const textParts = (result.content ?? [])
            .filter((block) => block.type === 'text' && block.text)
            .map((block) => block.text as string)
          return {
            output: textParts.join('\n') || JSON.stringify(result.content),
            isError: !!result.isError,
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          return { output: message, isError: true }
        }
      },
    }))
  }

  return tools
}

// ============================================================================
// Human Message Queue
// ============================================================================

/**
 * A simple async queue that the engine polls via dequeue().
 * deliverHumanResponse() pushes messages; the engine pulls them.
 */
class HumanMessageQueue {
  private pending: Array<string | ContentBlock[]> = []
  private waitResolve: ((value: string | ContentBlock[]) => void) | null = null

  push(content: string | ContentBlock[]): void {
    if (this.waitResolve) {
      const resolve = this.waitResolve
      this.waitResolve = null
      resolve(content)
    } else {
      this.pending = [...this.pending, content]
    }
  }

  async dequeue(): Promise<string | ContentBlock[]> {
    if (this.pending.length > 0) {
      const [first, ...rest] = this.pending
      this.pending = rest
      return first
    }
    return new Promise<string | ContentBlock[]>((resolve) => {
      this.waitResolve = resolve
    })
  }

  get hasPending(): boolean {
    return this.pending.length > 0
  }
}

// ============================================================================
// WorkerHandler
// ============================================================================

export class WorkerHandler {
  private sdkEnv: SdkEnvConfig
  private systemPrompt: string
  private longTermPreloadLimit = 20
  private activeTasks: Map<TaskId, WorkerTaskState> = new Map()
  /** Human message queues for active tasks */
  private humanQueues: Map<TaskId, HumanMessageQueue> = new Map()
  private mcpConfigFactory: (() => Record<string, McpServer>) | undefined
  private deps?: WorkerDeps
  private builtinToolConfig?: BuiltinToolConfig
  private mcpConnector?: McpConnector

  constructor(
    sdkEnv: SdkEnvConfig,
    config: WorkerHandlerConfig,
    mcpConfigFactory?: () => Record<string, McpServer>,
    deps?: WorkerDeps,
    builtinToolConfig?: BuiltinToolConfig,
    mcpConnector?: McpConnector,
  ) {
    this.sdkEnv = sdkEnv
    this.mcpConfigFactory = mcpConfigFactory
    this.deps = deps
    this.systemPrompt = config.systemPrompt
    this.longTermPreloadLimit = config.longTermPreloadLimit ?? 20
    this.builtinToolConfig = builtinToolConfig
    this.mcpConnector = mcpConnector
  }

  async executeTask(
    params: ExecuteTaskParams,
    traceCallback?: TraceCallback,
  ): Promise<ExecuteTaskResult> {
    const { task, context } = params
    const taskDir = `/tmp/crabot-task-${task.task_id}`

    const taskState: WorkerTaskState = {
      taskId: task.task_id,
      status: 'executing',
      startedAt: new Date().toISOString(),
      title: task.task_title,
      abortController: new AbortController(),
      pendingHumanMessages: [],
    }
    this.activeTasks.set(task.task_id, taskState)

    // Create human message queue for this task
    const humanQueue = new HumanMessageQueue()
    this.humanQueues.set(task.task_id, humanQueue)

    try {
      // 1. Create isolated task directory
      await fs.promises.mkdir(taskDir, { recursive: true })

      // 2. Write Admin Skills to task directory
      const skills = (params as { skills?: SkillConfig[] }).skills
      if (skills && skills.length > 0) {
        const skillsDir = path.join(taskDir, '.claude', 'skills')
        await fs.promises.mkdir(skillsDir, { recursive: true })
        for (const skill of skills) {
          const skillDir = path.join(skillsDir, skill.id)
          await fs.promises.mkdir(skillDir, { recursive: true })
          await fs.promises.writeFile(path.join(skillDir, 'SKILL.md'), skill.content, 'utf-8')
        }
      }

      // 3. Build tools from MCP servers
      const tools: ToolDefinition[] = []

      // 3a. ask_human built-in tool
      tools.push(defineTool({
        name: 'mcp__crabot-worker__ask_human',
        description: '请求人类反馈或确认',
        inputSchema: {
          type: 'object',
          properties: {
            question: { type: 'string', description: '向人类提出的问题' },
            options: {
              type: 'array',
              items: { type: 'string' },
              description: '可选的选项列表',
            },
          },
          required: ['question'],
        },
        isReadOnly: false,
        call: async (input) => {
          taskState.status = 'waiting_for_human'
          return {
            output: JSON.stringify({
              status: 'waiting',
              message: '已向人类发送问题，等待响应...',
              question: (input as { question: string }).question,
            }),
            isError: false,
          }
        },
      }))

      // 3b. crab-memory MCP server tools
      const memoryTaskCtx: MemoryTaskContext = {
        taskId: task.task_id,
        channelId: context.task_origin?.channel_id,
        sessionId: context.task_origin?.session_id,
        visibility: context.memory_permissions?.write_visibility ?? 'public',
        scopes: context.memory_permissions?.write_scopes ?? [],
      }
      if (this.deps?.getMemoryPort) {
        const crabMemoryServer = createCrabMemoryServer({
          rpcClient: this.deps.rpcClient,
          moduleId: this.deps.moduleId,
          getMemoryPort: this.deps.getMemoryPort,
        }, memoryTaskCtx)
        tools.push(...mcpServerToToolDefinitions(crabMemoryServer, 'crab-memory'))
      }

      // 3c. External MCP server tools (crab-messaging, etc.)
      const externalMcpServers = this.mcpConfigFactory?.() ?? {}
      for (const [serverName, server] of Object.entries(externalMcpServers)) {
        tools.push(...mcpServerToToolDefinitions(server, serverName))
      }

      // 3d. External MCP tools (from Admin-managed servers via McpConnector)
      if (this.mcpConnector) {
        const externalTools = await this.mcpConnector.getAllTools()
        tools.push(...externalTools)
      }

      // 3e. Built-in file/shell tools (filtered by Admin config)
      const hasSkills = (params as { skills?: SkillConfig[] }).skills?.length
      tools.push(...getConfiguredBuiltinTools(taskDir, this.builtinToolConfig, hasSkills ? { skillsDir: taskDir } : undefined))

      // 4. Create LLM adapter from sdkEnv (format-based routing)
      const adapter = createAdapter({
        endpoint: this.sdkEnv.env.ANTHROPIC_BASE_URL ?? this.sdkEnv.env.ANTHROPIC_API_BASE ?? '',
        apikey: this.sdkEnv.env.ANTHROPIC_API_KEY ?? '',
        format: this.sdkEnv.format,
      })

      // 5. Build system prompt and task message
      const systemPrompt = this.buildSystemPrompt(context)
      const taskMessage = this.buildTaskMessage(task, context)
      log(`Starting worker engine: model=${this.sdkEnv.modelId}, task=${task.task_title}, tools=${tools.length}`)

      // 6. Set up trace and progress tracking
      const isMasterPrivate =
        context.sender_friend?.permission === 'master'
        && context.task_origin?.session_type === 'private'

      let loopSpanId: string | undefined
      const pendingToolCalls: string[] = []
      const taskOrigin = context.task_origin

      // Start loop span
      loopSpanId = traceCallback?.onLoopStart('worker', {
        system_prompt: undefined,
        model: this.sdkEnv.modelId,
        tools: tools.map(t => t.name),
      })

      // 7. Run engine
      const engineResult = await runEngine({
        prompt: taskMessage,
        adapter,
        options: {
          systemPrompt,
          tools,
          model: this.sdkEnv.modelId,
          abortSignal: taskState.abortController.signal as AbortSignal,
          humanMessageQueue: humanQueue,
          onTurn: (event: EngineTurnEvent) => {
            // Trace: LLM call
            const inputSummary = event.turnNumber === 1
              ? task.task_title.slice(0, 150)
              : `(turn ${event.turnNumber})`
            const llmSpanId = traceCallback?.onLlmCallStart(event.turnNumber, inputSummary)

            // Compute tool summaries
            const turnToolSummaries: string[] = []
            for (const tc of event.toolCalls) {
              const summary = isMasterPrivate
                ? this.summarizeToolCall(tc.name, tc.input)
                : this.summarizeToolCallSanitized(tc.name, tc.input)
              if (summary !== null) {
                turnToolSummaries.push(summary)
              }

              // Trace: tool call
              const toolSpanId = traceCallback?.onToolCallStart(
                tc.name,
                JSON.stringify(tc.input ?? {}).slice(0, 200),
              )
              if (toolSpanId) {
                traceCallback?.onToolCallEnd(toolSpanId, '(executed by engine)')
              }
            }

            if (llmSpanId) {
              traceCallback?.onLlmCallEnd(llmSpanId, {
                stopReason: event.stopReason ?? undefined,
                outputSummary: event.assistantText.slice(0, 200) || undefined,
                toolCallsCount: event.toolCalls.length > 0 ? event.toolCalls.length : undefined,
              })
            }

            // Progress reporting (suppress when pending human messages exist)
            if (taskOrigin && !humanQueue.hasPending) {
              const trimmedText = event.assistantText.trim()
              const hasText = trimmedText.length > 0
              const hasTools = turnToolSummaries.length > 0

              if (hasText) {
                if (pendingToolCalls.length > 0) {
                  this.sendToUser(taskOrigin, this.dedupeToolSummaries(pendingToolCalls.splice(0)).slice(0, 500))
                }
                this.sendToUser(taskOrigin, trimmedText)
              }

              if (hasTools) {
                pendingToolCalls.push(...turnToolSummaries)
                if (pendingToolCalls.length >= 5) {
                  this.sendToUser(taskOrigin, this.dedupeToolSummaries(pendingToolCalls.splice(0)).slice(0, 500))
                }
              }
            } else if (humanQueue.hasPending) {
              // Discard interrupted turn's progress
              pendingToolCalls.splice(0)
            }
          },
        },
      })

      // Flush remaining pending tool calls
      if (taskOrigin && pendingToolCalls.length > 0 && !humanQueue.hasPending) {
        await this.sendToUser(taskOrigin, this.dedupeToolSummaries(pendingToolCalls.splice(0)).slice(0, 500))
      }

      // End loop span
      const isError = engineResult.outcome === 'failed'
      if (loopSpanId) {
        traceCallback?.onLoopEnd(loopSpanId, isError ? 'failed' : 'completed', engineResult.totalTurns)
      }

      // 8. Map EngineResult → ExecuteTaskResult
      return this.mapEngineResult(task.task_id, engineResult, !!taskOrigin && !!this.deps)

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      log(`Worker error: ${errorMessage}`)
      if (taskState.abortController.signal.aborted) {
        return { task_id: task.task_id, outcome: 'failed', summary: '任务被取消' }
      }
      return {
        task_id: task.task_id,
        outcome: 'failed',
        summary: `执行失败: ${errorMessage}`,
        final_reply: { type: 'text', text: `抱歉，执行任务时出现错误: ${errorMessage}` },
      }
    } finally {
      this.humanQueues.delete(task.task_id)
      this.activeTasks.delete(task.task_id)
      await this.cleanupTaskDir()
    }
  }

  /**
   * Map EngineResult to ExecuteTaskResult
   */
  private mapEngineResult(
    taskId: TaskId,
    result: EngineResult,
    hasProgressDeps: boolean,
  ): ExecuteTaskResult {
    const isError = result.outcome === 'failed' || result.outcome === 'aborted'
    const finalText = result.finalText || '任务已完成，但模型未生成输出'

    if (result.outcome === 'aborted') {
      return { task_id: taskId, outcome: 'failed', summary: '任务被取消' }
    }

    return {
      task_id: taskId,
      outcome: isError ? 'failed' : 'completed',
      summary: finalText,
      final_reply: (isError || !hasProgressDeps) ? { type: 'text', text: finalText } : undefined,
    }
  }

  deliverHumanResponse(taskId: TaskId, messages: ChannelMessage[]): void {
    const taskState = this.activeTasks.get(taskId)
    if (!taskState) {
      log(`[supplement] deliverHumanResponse: task ${taskId} NOT FOUND. activeTasks keys: [${Array.from(this.activeTasks.keys()).join(', ')}]`)
      throw new Error(`Task not found: ${taskId}`)
    }

    log(`[supplement] deliverHumanResponse: queued ${messages.length} messages for task ${taskId} (status: ${taskState.status})`)

    // Build supplement text from messages
    const supplement = messages
      .map(m => m.content.text ?? '')
      .filter(t => t.length > 0)
      .join('\n')

    if (supplement) {
      const humanQueue = this.humanQueues.get(taskId)
      if (humanQueue) {
        humanQueue.push(`用户补充指示：${supplement}`)
        log(`[supplement] pushed to humanMessageQueue for task ${taskId}`)
      }
    }

    // Also store in pendingHumanMessages for backward compat with task state
    taskState.pendingHumanMessages.push(...messages)
    taskState.status = 'executing'
  }

  cancelTask(taskId: TaskId, _reason: string): void {
    const taskState = this.activeTasks.get(taskId)
    if (taskState) {
      taskState.abortController.abort()
      taskState.status = 'cancelled'
    }
  }

  getActiveTaskCount(): number { return this.activeTasks.size }

  getActiveTasksForQuery(): Array<{ task_id: string; status: string; started_at: string; title?: string }> {
    return Array.from(this.activeTasks.values()).map(t => ({
      task_id: t.taskId,
      status: t.status,
      started_at: t.startedAt,
      title: t.title,
    }))
  }

  private buildSystemPrompt(context: WorkerAgentContext): string {
    const parts: string[] = [this.systemPrompt]
    if (context.available_tools.length > 0) {
      parts.push('\n## 可用工具')
      for (const t of context.available_tools) { parts.push(`- ${t.name}: ${t.description}`) }
    }
    if (context.sandbox_path_mappings && context.sandbox_path_mappings.length > 0) {
      parts.push('\n## 文件访问路径')
      for (const m of context.sandbox_path_mappings) {
        parts.push(`- ${m.sandbox_path} -> ${m.host_path} (${m.read_only ? '只读' : '读写'})`)
      }
    }
    return parts.join('\n')
  }

  private buildTaskMessage(task: ExecuteTaskParams['task'], context: WorkerAgentContext): string {
    const parts: string[] = []
    parts.push('## 任务信息')
    parts.push(`- 标题: ${task.task_title}`)
    parts.push(`- 类型: ${task.task_type}`)
    parts.push(`- 优先级: ${task.priority}`)
    if (task.plan) { parts.push(`- 计划: ${task.plan}`) }

    // trigger_messages: 用户的原始请求（核心内容）
    if (context.trigger_messages && context.trigger_messages.length > 0) {
      parts.push(`\n## 用户请求（共 ${context.trigger_messages.length} 条消息）`)
      for (const msg of context.trigger_messages) {
        const time = msg.platform_timestamp ? ` (${msg.platform_timestamp})` : ''
        parts.push(`\n### ${msg.sender.platform_display_name}${time}`)
        parts.push(formatMessageContent(msg))
      }
      if (task.task_description) {
        parts.push(`\n## 任务分类\n${task.task_description}`)
      }
    } else {
      // 无 trigger_messages（如定时任务），回退到 task_description
      parts.push(`\n## 任务描述\n${task.task_description}`)
    }

    if (context.sender_friend) {
      parts.push(`\n## 发送者信息`)
      parts.push(`- 名称: ${context.sender_friend.display_name}`)
      parts.push(`- 权限: ${context.sender_friend.permission}`)
    }

    if (context.task_origin) {
      parts.push('\n## 任务来源（crab-messaging 工具请使用这些 ID）')
      parts.push(`- Channel ID: ${context.task_origin.channel_id}`)
      parts.push(`- Session ID: ${context.task_origin.session_id}`)
    }
    const hasShortTerm = context.short_term_memories.length > 0
    const hasLongTerm = context.long_term_memories.length > 0
    if (hasShortTerm || hasLongTerm) {
      parts.push('\n## 记忆系统')

      if (hasShortTerm) {
        parts.push(`\n### 短期记忆（${context.short_term_memories.length} 条）`)
        parts.push('近期事件流水账，记录跨所有 channel/session 的事件摘要。不是聊天记录。')
      }

      if (hasLongTerm) {
        const count = context.long_term_memories.length
        const isOverflow = count >= this.longTermPreloadLimit
        if (isOverflow) {
          parts.push(`\n### 长期记忆（相关度最高的 ${count} 条，可能还有更多）`)
        } else {
          parts.push(`\n### 长期记忆（共 ${count} 条）`)
        }
        for (const mem of context.long_term_memories) {
          const tagStr = mem.tags.length > 0 ? ` [${mem.tags.slice(0, 3).join(', ')}]` : ''
          parts.push(`- [${mem.id}]${tagStr} ${mem.abstract} (importance: ${mem.importance})`)
        }
        if (isOverflow) {
          parts.push('\n如需查找更多记忆，使用 search_memory 工具。')
        }
        parts.push('如需查看某条记忆详情，使用 get_memory_detail 工具。')
      }

      parts.push('\n- 聊天记录: 使用 crab-messaging 的 get_history 工具查看特定 channel/session 的原始消息')
      parts.push('- 写入记忆: 使用 crab-memory 的 store_memory 工具保存重要信息到长期记忆')
    }
    if (context.recent_messages && context.recent_messages.length > 0) {
      parts.push(`\n## 最近相关消息（共 ${context.recent_messages.length} 条）`)
      for (const m of context.recent_messages) {
        parts.push(`- ${m.sender.platform_display_name}: ${formatMessageContent(m)}`)
      }
    }

    // front_context from forced Front termination
    const taskWithContext = task as { front_context?: Array<{ tool_name: string; output_summary: string }> }
    if (taskWithContext.front_context && Array.isArray(taskWithContext.front_context)) {
      parts.push('\n## Front Agent 已完成的工作')
      parts.push('（以下信息已获取，请直接使用，不要重复查询）')
      for (const entry of taskWithContext.front_context) {
        parts.push(`- ${entry.tool_name}: ${entry.output_summary}`)
      }
    }

    return parts.join('\n')
  }

  /**
   * Extract a human-readable summary from a tool call
   */
  private summarizeToolCall(toolName: string, input: unknown): string | null {
    if (INTERNAL_TOOL_PREFIXES.some(p => toolName.startsWith(p))) return null
    const args = input as Record<string, unknown> | undefined
    switch (toolName) {
      case 'Bash':
        return `> ${(args?.command as string ?? '').slice(0, 120)}`
      case 'Write':
        return `写入 ${args?.file_path ?? '文件'}`
      case 'Edit':
        return `编辑 ${args?.file_path ?? '文件'}`
      case 'Read':
        return `读取 ${args?.file_path ?? '文件'}`
      case 'Glob':
        return `搜索文件 ${args?.pattern ?? ''}`
      case 'Grep':
        return `搜索 "${(args?.pattern as string ?? '').slice(0, 30)}" in ${args?.path ?? '.'}`
      default:
        return toolName
    }
  }

  /**
   * Sanitized tool summary for non-master sessions.
   * Strips file paths to basename, sanitizes Bash commands, skips unknown tools.
   * Returns null to indicate the tool should be omitted from progress.
   */
  private summarizeToolCallSanitized(toolName: string, input: unknown): string | null {
    if (INTERNAL_TOOL_PREFIXES.some(p => toolName.startsWith(p))) return null
    const args = input as Record<string, unknown> | undefined
    switch (toolName) {
      case 'Bash': {
        const cmd = (args?.command as string ?? '')
        const sanitized = cmd.replace(/(?:\/[\w.-]+)+/g, (match) => {
          const segments = match.split('/')
          return segments[segments.length - 1]
        })
        return `> ${sanitized.slice(0, 120)}`
      }
      case 'Write':
        return `写入 ${this.basenameOf(args?.file_path)}`
      case 'Edit':
        return `编辑 ${this.basenameOf(args?.file_path)}`
      case 'Read':
        return `读取 ${this.basenameOf(args?.file_path)}`
      case 'Glob':
        return `搜索文件 ${args?.pattern ?? ''}`
      case 'Grep':
        return `搜索 "${(args?.pattern as string ?? '').slice(0, 30)}"`
      default:
        return TOOL_DESCRIPTIONS[toolName] ?? null
    }
  }

  /**
   * Deduplicate consecutive identical tool summaries, appending ×N for runs > 1.
   * e.g. ["编辑 A.tsx", "编辑 A.tsx", "编辑 B.tsx"] → "编辑 A.tsx ×2\n编辑 B.tsx"
   */
  private dedupeToolSummaries(summaries: string[]): string {
    if (summaries.length === 0) return ''
    const result: string[] = []
    let current = summaries[0]
    let count = 1
    for (let i = 1; i < summaries.length; i++) {
      if (summaries[i] === current) {
        count++
      } else {
        result.push(count > 1 ? `${current} ×${count}` : current)
        current = summaries[i]
        count = 1
      }
    }
    result.push(count > 1 ? `${current} ×${count}` : current)
    return result.join('\n')
  }

  private basenameOf(filePath: unknown): string {
    if (typeof filePath !== 'string') return '文件'
    return path.basename(filePath)
  }

  /**
   * Send a message to the user during task execution.
   * No prefix — text is forwarded as-is (agent's natural speech or tool summaries).
   */
  private async sendToUser(
    taskOrigin: TaskOrigin,
    text: string,
  ): Promise<void> {
    if (!this.deps) return
    try {
      const channelPort = await this.deps.resolveChannelPort(taskOrigin.channel_id)
      await this.deps.rpcClient.call(channelPort, 'send_message', {
        session_id: taskOrigin.session_id,
        content: { type: 'text', text },
      }, this.deps.moduleId)
    } catch { /* ignore send failures */ }
  }

  private async cleanupTaskDir(): Promise<void> {
    try {
      const maxRetained = 5
      const entries = await fs.promises.readdir('/tmp')
      const dirs = entries.filter(d => d.startsWith('crabot-task-')).map(d => `/tmp/${d}`)
      if (dirs.length > maxRetained) {
        const withStats = await Promise.all(
          dirs.map(async d => {
            try {
              const stat = await fs.promises.stat(d)
              return { path: d, mtime: stat.mtimeMs }
            } catch { return null }
          }),
        )
        const valid = withStats.filter((s): s is { path: string; mtime: number } => s !== null)
        const sorted = valid.sort((a, b) => a.mtime - b.mtime)
        for (const dir of sorted.slice(0, dirs.length - maxRetained)) {
          await fs.promises.rm(dir.path, { recursive: true, force: true })
        }
      }
    } catch { /* ignore cleanup errors */ }
  }
}
