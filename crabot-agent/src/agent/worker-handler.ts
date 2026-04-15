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
  ProgressDigest,
} from '../engine/index.js'
import type {
  ToolDefinition,
  EngineTurnEvent,
  EngineResult,
  ContentBlock,
  ProgressDigestConfig,
  ProgressDigestDeps,
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
import type { RpcClient } from 'crabot-shared'
import { createCrabMemoryServer } from '../mcp/crab-memory.js'
import type { MemoryTaskContext } from '../mcp/crab-memory.js'
import { formatMessageContent, resolveImageBlocks } from './media-resolver.js'
import type { McpConnector } from './mcp-connector.js'
import { createSubAgentTool } from '../engine/sub-agent.js'
import type { SubAgentDefinition } from './subagent-prompts.js'
import { DELEGATE_TASK_SYSTEM_PROMPT } from './subagent-prompts.js'
import { HumanMessageQueue } from '../engine/human-message-queue.js'
import { createCodingExpertHookRegistry } from '../hooks/defaults.js'

import * as fs from 'fs'
import * as path from 'path'

type ProgressReportMode = 'silent' | 'text_forward' | 'digest'

function getReportMode(
  sessionType: 'private' | 'group' | undefined,
  isMasterPrivate: boolean,
  extra: Record<string, unknown>,
): ProgressReportMode {
  const raw = sessionType === 'group'
    ? extra.progress_report_group
    : isMasterPrivate
      ? extra.progress_report_master_private
      : extra.progress_report_other_private
  if (raw === 'silent' || raw === 'text_forward' || raw === 'digest') return raw
  return 'digest'
}

const LOG_FILE = path.join(process.cwd(), '../data/worker-handler-debug.log')

function log(msg: string) {
  const ts = new Date().toISOString()
  try { fs.appendFileSync(LOG_FILE, `[${ts}] ${msg}\n`) } catch { /* ignore */ }
}

export interface WorkerHandlerConfig {
  systemPrompt: string
  longTermPreloadLimit?: number
  extra?: Record<string, unknown>
}

export interface WorkerDeps {
  rpcClient: RpcClient
  moduleId: string
  resolveChannelPort: (channelId: string) => Promise<number>
  getMemoryPort: () => Promise<number>
}

import type { LLMFormat } from '../engine/llm-adapter'

export interface WorkerTraceContext {
  traceStore: import('../core/trace-store').TraceStore
  traceId: string
  relatedTaskId?: string
}

export interface SdkEnvConfig {
  modelId: string
  format: LLMFormat
  supportsVision?: boolean
  env: Record<string, string>
}

function adapterFromSdkEnv(sdkEnv: SdkEnvConfig) {
  return createAdapter({
    endpoint: sdkEnv.env.LLM_BASE_URL ?? '',
    apikey: sdkEnv.env.LLM_API_KEY ?? '',
    format: sdkEnv.format,
  })
}


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
// WorkerHandler
// ============================================================================

export interface WorkerHandlerOptions {
  mcpConfigFactory?: () => Record<string, McpServer>
  deps?: WorkerDeps
  builtinToolConfig?: BuiltinToolConfig
  mcpConnector?: McpConnector
  digestSdkEnv?: SdkEnvConfig
  subAgentConfigs?: ReadonlyArray<{ readonly definition: SubAgentDefinition; readonly sdkEnv: SdkEnvConfig }>
  skills?: ReadonlyArray<SkillConfig>
  lspManager?: import('../lsp/lsp-manager').LSPManager
}

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
  private extra: Record<string, unknown>
  private digestSdkEnv?: SdkEnvConfig
  private readonly subAgentConfigs: ReadonlyArray<{ readonly definition: SubAgentDefinition; readonly sdkEnv: SdkEnvConfig }>
  private readonly skills: ReadonlyArray<SkillConfig>
  private readonly lspManager?: import('../lsp/lsp-manager').LSPManager

  constructor(
    sdkEnv: SdkEnvConfig,
    config: WorkerHandlerConfig,
    options?: WorkerHandlerOptions,
  ) {
    this.sdkEnv = sdkEnv
    this.mcpConfigFactory = options?.mcpConfigFactory
    this.deps = options?.deps
    this.systemPrompt = config.systemPrompt
    this.longTermPreloadLimit = config.longTermPreloadLimit ?? 20
    this.builtinToolConfig = options?.builtinToolConfig
    this.mcpConnector = options?.mcpConnector
    this.extra = config.extra ?? {}
    this.digestSdkEnv = options?.digestSdkEnv
    this.subAgentConfigs = options?.subAgentConfigs ?? []
    this.skills = options?.skills ?? []
    this.lspManager = options?.lspManager
  }

  async executeTask(
    params: ExecuteTaskParams,
    traceCallback?: TraceCallback,
    traceContext?: WorkerTraceContext,
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
      taskOrigin: context.task_origin,
    }
    this.activeTasks.set(task.task_id, taskState)

    // Create human message queue for this task
    const humanQueue = new HumanMessageQueue()
    this.humanQueues.set(task.task_id, humanQueue)

    let digest: ProgressDigest | undefined
    try {
      // 1. Create isolated task directory
      await fs.promises.mkdir(taskDir, { recursive: true })

      // 2. Write Admin Skills to task directory (from instance config, not RPC params)
      const skills = this.skills
      if (skills.length > 0) {
        const skillsDir = path.join(taskDir, '.claude', 'skills')
        await fs.promises.mkdir(skillsDir, { recursive: true })
        for (const skill of skills) {
          const skillDir = path.join(skillsDir, skill.id)
          await fs.promises.mkdir(skillDir, { recursive: true })
          await fs.promises.writeFile(path.join(skillDir, 'SKILL.md'), skill.content, 'utf-8')
          if (skill.skill_dir) {
            await fs.promises.writeFile(path.join(skillDir, '.skill_dir'), skill.skill_dir, 'utf-8')
          }
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
        sourceType: context.task_origin ? 'conversation' : 'system',
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
        const externalTools = this.mcpConnector.getAllTools()
        tools.push(...externalTools)
      }

      // 3e. Built-in file/shell tools (filtered by Admin config)
      tools.push(...getConfiguredBuiltinTools(taskDir, this.builtinToolConfig, skills.length > 0 ? { skillsDir: taskDir } : undefined))

      // 3f. Sub-agent delegation tools
      const baseTools = [...tools]
      const subAgentTraceConfig = traceContext ? {
        traceStore: traceContext.traceStore,
        parentTraceId: traceContext.traceId,
        relatedTaskId: traceContext.relatedTaskId,
      } : undefined

      for (const { definition, sdkEnv: subSdkEnv } of this.subAgentConfigs) {
        const hookRegistry = definition.hooks === 'coding_expert'
          ? createCodingExpertHookRegistry()
          : undefined

        tools.push(createSubAgentTool({
          name: definition.toolName,
          description: definition.toolDescription,
          adapter: adapterFromSdkEnv(subSdkEnv),
          model: subSdkEnv.modelId,
          systemPrompt: definition.systemPrompt,
          subTools: baseTools,
          maxTurns: definition.maxTurns,
          supportsVision: subSdkEnv.supportsVision,
          parentHumanQueue: humanQueue,
          traceConfig: subAgentTraceConfig,
          hookRegistry,
          lspManager: hookRegistry ? this.lspManager : undefined,
        }))
      }

      // 3g. Generic delegate_task tool (uses Worker's own model)
      const adapter = adapterFromSdkEnv(this.sdkEnv)
      tools.push(createSubAgentTool({
        name: 'delegate_task',
        description: '将子任务委派给一个独立的执行者。执行者在独立上下文中运行，使用与你相同的模型和工具，只返回最终结果。适合：(1) 子任务的中间过程会污染你的上下文 (2) 子任务可以独立完成，不需要你的持续关注',
        adapter,
        model: this.sdkEnv.modelId,
        systemPrompt: DELEGATE_TASK_SYSTEM_PROMPT,
        subTools: baseTools,
        maxTurns: 30,
        supportsVision: this.sdkEnv.supportsVision,
        parentHumanQueue: humanQueue,
        traceConfig: subAgentTraceConfig,
      }))

      // 3h. Trace search tool
      if (traceContext) {
        const { createSearchTracesTool } = await import('./trace-search-tool.js')
        tools.push(createSearchTracesTool(traceContext.traceStore))
      }

      // 5. Build system prompt and task message
      const systemPrompt = this.buildSystemPrompt(context)
      const taskMessage = await this.buildTaskMessage(task, context)
      log(`Starting worker engine: model=${this.sdkEnv.modelId}, task=${task.task_title}, tools=${tools.length}`)

      // 6. Set up trace and progress tracking
      const isMasterPrivate =
        context.sender_friend?.permission === 'master'
        && context.task_origin?.session_type === 'private'

      let loopSpanId: string | undefined
      const taskOrigin = context.task_origin

      // Start loop span
      loopSpanId = traceCallback?.onLoopStart('worker', {
        system_prompt: undefined,
        model: this.sdkEnv.modelId,
        tools: tools.map(t => t.name),
      })

      // 创建进度汇报（根据会话场景分支）
      let textForwardMode = false
      if (taskOrigin && this.deps) {
        const reportMode = getReportMode(
          taskOrigin.session_type,
          isMasterPrivate,
          this.extra,
        )

        if (reportMode === 'digest') {
          const ex = this.extra
          const intervalSec = typeof ex.progress_digest_interval_seconds === 'number'
            ? ex.progress_digest_interval_seconds
            : 120
          const digestMode: 'llm' | 'extract' = ex.progress_digest_mode === 'extract' ? 'extract' : 'llm'
          const digestAdapter = (digestMode !== 'extract' && this.digestSdkEnv)
            ? adapterFromSdkEnv(this.digestSdkEnv)
            : undefined

          const digestConfig: ProgressDigestConfig = {
            intervalMs: intervalSec * 1000,
            mode: digestMode,
            isMasterPrivate,
          }

          const deps = this.deps
          const digestDeps: ProgressDigestDeps = {
            sendToUser: (text: string) => this.sendToUser(taskOrigin, text),
            getChatHistory: async (limit: number) => {
              try {
                const channelPort = await deps.resolveChannelPort(taskOrigin.channel_id)
                const result = await deps.rpcClient.call<
                  { session_id: string; limit: number },
                  { items: Array<{ sender_name: string; content: string }> }
                >(channelPort, 'get_history', {
                  session_id: taskOrigin.session_id,
                  limit,
                }, deps.moduleId)
                return (result.items ?? []).map(m => `${m.sender_name}: ${m.content}`)
              } catch {
                return []
              }
            },
            digestAdapter,
            digestModelId: this.digestSdkEnv?.modelId,
          }

          digest = new ProgressDigest(digestConfig, digestDeps)
        } else if (reportMode === 'text_forward') {
          textForwardMode = true
        }
        // reportMode === 'silent' → no digest, no text forward
      }

      // 7. Run engine
      const engineResult = await runEngine({
        prompt: taskMessage,
        adapter,
        options: {
          systemPrompt,
          tools,
          model: this.sdkEnv.modelId,
          supportsVision: this.sdkEnv.supportsVision,
          // TODO: Wire resolved permissions from unified-agent (currently bypass)
          permissionConfig: { mode: 'bypass' },
          abortSignal: taskState.abortController.signal as AbortSignal,
          humanMessageQueue: humanQueue,
          onTurn: (event: EngineTurnEvent) => {
            // Trace: LLM call
            const inputSummary = event.turnNumber === 1
              ? task.task_title.slice(0, 150)
              : `(turn ${event.turnNumber})`
            const llmSpanId = traceCallback?.onLlmCallStart(event.turnNumber, inputSummary)

            // Trace: tool calls
            const perToolMs = event.toolCalls.length > 0
              ? Math.round((event.toolExecutionMs ?? 0) / event.toolCalls.length)
              : 0
            for (const tc of event.toolCalls) {
              const toolSpanId = traceCallback?.onToolCallStart(
                tc.name,
                JSON.stringify(tc.input ?? {}).slice(0, 200),
              )
              if (toolSpanId) {
                traceCallback?.onToolCallEnd(
                  toolSpanId,
                  `${tc.output?.slice(0, 500) || '(no output)'}${perToolMs > 0 ? ` [${perToolMs}ms]` : ''}`,
                  tc.isError ? tc.output : undefined,
                )
              }
            }

            if (llmSpanId) {
              traceCallback?.onLlmCallEnd(llmSpanId, {
                stopReason: event.stopReason ?? undefined,
                outputSummary: event.assistantText.slice(0, 200) || undefined,
                toolCallsCount: event.toolCalls.length > 0 ? event.toolCalls.length : undefined,
              })
            }

            // Progress: delegate based on report mode
            if (!humanQueue.hasPending) {
              if (digest) {
                digest.ingest(event)
              } else if (textForwardMode && taskOrigin) {
                const text = event.assistantText.trim()
                if (text.length > 0) {
                  this.sendToUser(taskOrigin, text).catch(() => {})
                }
              }
            }
          },
        },
      })

      // Dispose ProgressDigest (also in finally block as safety net)
      digest?.dispose()

      // End loop span
      const isError = engineResult.outcome === 'failed'
      if (loopSpanId) {
        traceCallback?.onLoopEnd(loopSpanId, isError ? 'failed' : 'completed', engineResult.totalTurns)
      }
      if (engineResult.error) {
        log(`Engine error (outcome=${engineResult.outcome}, turns=${engineResult.totalTurns}): ${engineResult.error}`)
      }

      // 8. Summarize if finalText is empty or the default placeholder
      // For failed outcomes, use the engine error as the summary instead of generating an optimistic one
      let finalEngineResult = engineResult
      if (isError && engineResult.error) {
        finalEngineResult = { ...engineResult, finalText: `执行失败 (${engineResult.totalTurns}轮后): ${engineResult.error}` }
      } else if (!engineResult.finalText || engineResult.finalText === '任务已完成，但模型未生成输出') {
        const summary = await this.summarizeTaskOutcome(
          task.task_title,
          engineResult.totalTurns,
          engineResult.outcome,
          engineResult.finalText,
        )
        finalEngineResult = { ...engineResult, finalText: summary }
      }

      // 9. Map EngineResult → ExecuteTaskResult
      return this.mapEngineResult(task.task_id, finalEngineResult)

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
      digest?.dispose()
      this.humanQueues.get(task.task_id)?.clearBarrier()
      this.humanQueues.delete(task.task_id)
      this.activeTasks.delete(task.task_id)
      await this.cleanupTaskDir()
    }
  }

  /**
   * Call LLM to generate a human-readable summary when the engine finishes
   * without producing a clear final text.
   */
  private async summarizeTaskOutcome(
    taskTitle: string,
    turnCount: number,
    outcome: string,
    lastText: string,
  ): Promise<string> {
    try {
      const adapter = adapterFromSdkEnv(this.sdkEnv)
      const { callNonStreaming } = await import('../engine/llm-adapter.js')
      const { createUserMessage } = await import('../engine/types.js')
      const response = await callNonStreaming(adapter, {
        messages: [createUserMessage(
          `任务"${taskTitle}"已${outcome === 'completed' ? '完成' : '结束'}，共执行了${turnCount}轮操作。` +
          (lastText ? `\n最后的输出是：${lastText.slice(0, 500)}` : '') +
          `\n请用1-2句话向用户简要报告任务执行情况和结果。不要提及内部实现细节。`
        )],
        systemPrompt: '你是一个任务执行助手，需要向用户简要报告任务结果。语言简洁自然。',
        tools: [],
        model: this.sdkEnv.modelId,
      })
      const text = response.content
        .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
        .map(b => b.text)
        .join('')
      return text || lastText || '任务已完成'
    } catch {
      return lastText || '任务已完成'
    }
  }

  /**
   * Map EngineResult to ExecuteTaskResult
   */
  private mapEngineResult(
    taskId: TaskId,
    result: EngineResult,
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
      final_reply: { type: 'text', text: finalText },
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
        humanQueue.push(
          `[实时纠偏 - 来自用户]\n` +
          `用户在任务执行期间发来了补充指示：\n\n` +
          `"${supplement}"\n\n` +
          `请结合当前任务进展，调整你的执行方向。`,
        )
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

  hasActiveTask(taskId: TaskId): boolean {
    return this.activeTasks.has(taskId)
  }

  setBarrierForTask(taskId: TaskId, timeoutMs: number): boolean {
    const queue = this.humanQueues.get(taskId)
    if (!queue) return false
    queue.setBarrier(timeoutMs)
    return true
  }

  clearBarrierForTask(taskId: TaskId): void {
    const queue = this.humanQueues.get(taskId)
    queue?.clearBarrier()
  }

  getActiveTasksByOrigin(channelId: string, sessionId: string): TaskId[] {
    const result: TaskId[] = []
    for (const [taskId, state] of this.activeTasks) {
      if (
        state.taskOrigin?.channel_id === channelId &&
        state.taskOrigin?.session_id === sessionId
      ) {
        result.push(taskId)
      }
    }
    return result
  }

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

  private async buildTaskMessage(task: ExecuteTaskParams['task'], context: WorkerAgentContext): Promise<string | ContentBlock[]> {
    const parts: string[] = []
    parts.push('## 任务信息')
    parts.push(`- 标题: ${task.task_title}`)
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

    // Front immediate reply — tell Worker what was already said to avoid repetition
    if (context.front_immediate_reply) {
      parts.push('\n## 已发送的即时回复')
      parts.push(`你已经向用户发送了："${context.front_immediate_reply}"`)
      parts.push('不要重复类似的确认或复述，直接开始执行任务。')
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

    const textContent = parts.join('\n')

    // VLM Worker: resolve images from trigger messages into ContentBlock[]
    if (this.sdkEnv.supportsVision && context.trigger_messages?.length) {
      const imageBlocks = await resolveImageBlocks(context.trigger_messages)
      if (imageBlocks.length > 0) {
        return [
          { type: 'text' as const, text: textContent },
          ...imageBlocks,
        ]
      }
    }

    return textContent
  }

  /**
   * Send a message to the user during task execution.
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
