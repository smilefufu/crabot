/**
 * Worker Handler v2 - 任务执行处理器
 *
 * 直接使用 query() 的完整 session 能力：
 * - async generator 输入 + 流式事件输出
 * - streamInput() 注入纠偏消息
 * - interrupt() 优雅中断
 * - cwd 隔离、工具白名单、进度推送
 *
 * 不再依赖 sdk-runner.ts 中间层。
 */

import {
  query,
  createSdkMcpServer,
  tool,
} from '@anthropic-ai/claude-agent-sdk'
import type {
  Options as SdkOptions,
  SDKMessage,
  SDKUserMessage,
  McpServerConfig as SdkMcpServerConfig,
  Query,
} from '@anthropic-ai/claude-agent-sdk'
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
} from '../types.js'
import type { RpcClient } from '../core/module-base.js'
import { createCrabMemoryServer } from '../mcp/crab-memory.js'
import type { MemoryTaskContext } from '../mcp/crab-memory.js'

import * as fs from 'fs'
import * as path from 'path'
import { execSync } from 'child_process'

const LOG_FILE = path.join(process.cwd(), '../data/worker-handler-debug.log')

function log(msg: string) {
  const ts = new Date().toISOString()
  try { fs.appendFileSync(LOG_FILE, `[${ts}] ${msg}\n`) } catch { /* ignore */ }
}

function findClaudeCodePath(): string | undefined {
  try {
    return execSync('which claude', { encoding: 'utf-8' }).trim() || undefined
  } catch {
    return undefined
  }
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

export interface SdkEnvConfig {
  modelId: string
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

/** Tools the Worker SDK is allowed to use */
const WORKER_ALLOWED_TOOLS = [
  'Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep',
  'Skill',
  'mcp__crab-messaging__lookup_friend',
  'mcp__crab-messaging__list_friends',
  'mcp__crab-messaging__list_sessions',
  'mcp__crab-messaging__open_private_session',
  'mcp__crab-messaging__send_message',
  'mcp__crab-messaging__get_history',
  'mcp__crabot-worker__ask_human',
  'mcp__crab-memory__store_memory',
  'mcp__crab-memory__search_memory',
  'mcp__crab-memory__get_memory_detail',
]

export class WorkerHandler {
  private sdkEnv: SdkEnvConfig
  private systemPrompt: string
  private longTermPreloadLimit = 20
  private activeTasks: Map<TaskId, WorkerTaskState> = new Map()
  /** Active query handles — for streamInput() injection */
  private activeQueries: Map<TaskId, Query> = new Map()
  private mcpConfigFactory: (() => Record<string, SdkMcpServerConfig>) | undefined
  private deps?: WorkerDeps

  constructor(
    sdkEnv: SdkEnvConfig,
    config: WorkerHandlerConfig,
    mcpConfigFactory?: () => Record<string, SdkMcpServerConfig>,
    deps?: WorkerDeps,
  ) {
    this.sdkEnv = sdkEnv
    this.mcpConfigFactory = mcpConfigFactory
    this.deps = deps
    this.systemPrompt = config.systemPrompt
    this.longTermPreloadLimit = config.longTermPreloadLimit ?? 20
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

      // 3. Build MCP servers
      const askHumanServer = createSdkMcpServer({
        name: 'crabot-worker',
        version: '1.0.0',
        tools: [
          tool(
            'ask_human',
            '请求人类反馈或确认',
            {
              question: z.string().describe('向人类提出的问题'),
              options: z.array(z.string()).optional().describe('可选的选项列表'),
            },
            async (args) => {
              taskState.status = 'waiting_for_human'
              return {
                content: [{
                  type: 'text' as const,
                  text: JSON.stringify({
                    status: 'waiting',
                    message: '已向人类发送问题，等待响应...',
                    question: args.question,
                  }),
                }],
              }
            },
          ),
        ],
      })

      // Build crab-memory MCP server (per-task, needs task context)
      const memoryTaskCtx: MemoryTaskContext = {
        taskId: task.task_id,
        channelId: context.task_origin?.channel_id,
        sessionId: context.task_origin?.session_id,
        visibility: context.memory_permissions?.write_visibility ?? 'public',
        scopes: context.memory_permissions?.write_scopes ?? [],
      }
      const crabMemoryServer = this.deps?.getMemoryPort
        ? createCrabMemoryServer({
            rpcClient: this.deps.rpcClient,
            moduleId: this.deps.moduleId,
            getMemoryPort: this.deps.getMemoryPort,
          }, memoryTaskCtx)
        : undefined

      const externalMcpConfigs = this.mcpConfigFactory?.() ?? {}
      const mcpServers: Record<string, SdkMcpServerConfig> = {
        'crabot-worker': askHumanServer as unknown as SdkMcpServerConfig,
        ...(crabMemoryServer ? { 'crab-memory': crabMemoryServer } : {}),
        ...externalMcpConfigs,
      }

      // 4. Build allowedTools
      const externalMcpToolNames = Object.keys(externalMcpConfigs)
        .filter(name => name !== 'crabot-worker')
        .map(name => `mcp__${name}__*`)
      const allowedTools = [...WORKER_ALLOWED_TOOLS, ...externalMcpToolNames]

      // 5. Build SDK options
      const claudePath = findClaudeCodePath()
      const cleanEnv = { ...process.env, ...this.sdkEnv.env } as Record<string, string | undefined>
      delete cleanEnv.ANTHROPIC_AUTH_TOKEN

      const sdkOptions: SdkOptions = {
        systemPrompt: this.buildSystemPrompt(context),
        model: this.sdkEnv.modelId,
        env: cleanEnv,
        cwd: taskDir,
        settingSources: ['project'],
        allowedTools,
        mcpServers,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        persistSession: false,
        thinking: { type: 'disabled' },
        // Worker 不设 maxTurns — 允许执行足够复杂的任务直到自然完成
        ...(claudePath && { pathToClaudeCodeExecutable: claudePath }),
        ...(taskState.abortController && { abortController: taskState.abortController as unknown as AbortController }),
        stderr: (data: string) => {
          if (data.trim()) log(`stderr: ${data.trim().slice(0, 500)}`)
        },
      }

      // 6. Start query with task message
      const taskMessage = this.buildTaskMessage(task, context)
      log(`Starting worker query: model=${this.sdkEnv.modelId}, task=${task.task_title}`)

      const queryHandle = query({ prompt: taskMessage, options: sdkOptions })
      this.activeQueries.set(task.task_id, queryHandle)

      // 7. Process output stream — progress, trace, result extraction
      const isMasterPrivate =
        context.sender_friend?.permission === 'master'
        && context.task_origin?.session_type === 'private'

      const result = await this.processQueryStream(
        queryHandle, task, context.task_origin, taskState, traceCallback, isMasterPrivate,
      )

      return result
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
      this.activeQueries.delete(task.task_id)
      this.activeTasks.delete(task.task_id)
      await this.cleanupTaskDir()
    }
  }

  /**
   * Process the query output stream — handle all SDK events.
   * This replaces sdk-runner.ts's event loop.
   */
  private async processQueryStream(
    queryHandle: Query,
    task: ExecuteTaskParams['task'],
    taskOrigin: TaskOrigin | undefined,
    taskState: WorkerTaskState,
    traceCallback?: TraceCallback,
    isMasterPrivate: boolean = false,
  ): Promise<ExecuteTaskResult> {
    let resultText = ''
    let isError = false
    let turnCount = 0
    let loopSpanId: string | undefined
    /** Accumulated tool call summaries waiting to be flushed */
    const pendingToolCalls: string[] = []

    for await (const message of queryHandle) {
      const msg = message as SDKMessage & Record<string, unknown>

      switch (msg.type) {
        case 'system': {
          if ((msg as Record<string, unknown>).subtype === 'init') {
            log(`System init: model=${msg.model}`)
            if (!loopSpanId) {
              loopSpanId = traceCallback?.onLoopStart('worker', {
                system_prompt: undefined,
                model: msg.model as string,
                tools: msg.tools as string[],
                mcp_servers: msg.mcp_servers as Array<{ name: string; status: string }>,
              })
            }
          }
          break
        }

        case 'assistant': {
          const betaMessage = (msg as Record<string, unknown>).message as {
            content?: Array<{ type: string; text?: string; name?: string; input?: unknown; id?: string }>
            stop_reason?: string
          }

          const inputSummary = turnCount === 0 ? task.task_title.slice(0, 150) : `(turn ${turnCount + 1})`
          const llmSpanId = traceCallback?.onLlmCallStart(turnCount + 1, inputSummary)
          let turnText = ''
          let turnToolCount = 0
          const turnToolSummaries: string[] = []

          if (betaMessage?.content) {
            for (const block of betaMessage.content) {
              if (block.type === 'text' && block.text) {
                resultText = block.text
                turnText += block.text
              }
              if (block.type === 'tool_use' && block.name) {
                turnToolCount++
                const summary = isMasterPrivate
                  ? this.summarizeToolCall(block.name, block.input)
                  : this.summarizeToolCallSanitized(block.name, block.input)
                if (summary !== null) {
                  turnToolSummaries.push(summary)
                }
                const toolSpanId = traceCallback?.onToolCallStart(
                  block.name,
                  JSON.stringify(block.input ?? {}).slice(0, 200),
                )
                if (toolSpanId) {
                  traceCallback?.onToolCallEnd(toolSpanId, '(executed by SDK)')
                }
              }
            }
          }

          if (llmSpanId) {
            traceCallback?.onLlmCallEnd(llmSpanId, {
              stopReason: betaMessage?.stop_reason,
              outputSummary: turnText.slice(0, 200) || undefined,
              toolCallsCount: turnToolCount > 0 ? turnToolCount : undefined,
            })
          }

          turnCount++

          // ── Content-type based progress reporting ──
          // 有 pending supplement 时抑制进度消息（interrupt 已触发，这是被中断 turn 的残留输出）
          if (taskOrigin && taskState.pendingHumanMessages.length === 0) {
            const trimmedText = turnText.trim()
            const hasText = trimmedText.length > 0
            const hasTools = turnToolSummaries.length > 0

            if (hasText) {
              if (pendingToolCalls.length > 0) {
                await this.sendToUser(taskOrigin, this.dedupeToolSummaries(pendingToolCalls.splice(0)).slice(0, 500))
              }
              await this.sendToUser(taskOrigin, trimmedText)
            }

            if (hasTools) {
              pendingToolCalls.push(...turnToolSummaries)
              if (pendingToolCalls.length >= 5) {
                await this.sendToUser(taskOrigin, this.dedupeToolSummaries(pendingToolCalls.splice(0)).slice(0, 500))
              }
            }
          } else if (taskState.pendingHumanMessages.length > 0) {
            // 有 pending supplement，丢弃被中断 turn 的进度
            pendingToolCalls.splice(0)
          }

          break
        }

        case 'result': {
          // Flush remaining pending tool calls (但有 pending supplement 时不发)
          if (taskOrigin && pendingToolCalls.length > 0 && taskState.pendingHumanMessages.length === 0) {
            await this.sendToUser(taskOrigin, this.dedupeToolSummaries(pendingToolCalls.splice(0)).slice(0, 500))
          } else {
            pendingToolCalls.splice(0)
          }

          const resultMsg = msg as Record<string, unknown>
          log(`Result: subtype=${resultMsg.subtype}, isError=${resultMsg.is_error}`)

          // ── Supplement injection: interrupt 已在 deliverHumanResponse 中触发，这里注入内容 ──
          if (taskState.pendingHumanMessages.length > 0) {
            const pending = taskState.pendingHumanMessages.splice(0)
            const supplement = pending
              .map(m => m.content.text ?? '')
              .filter(t => t.length > 0)
              .join('\n')

            if (supplement) {
              log(`[supplement] Injecting after interrupt: ${supplement.slice(0, 200)}`)
              await this.injectHumanMessage(task.task_id, supplement)
              log(`[supplement] streamInput() done, waiting for SDK to process next turn`)
            }
            // 这个 result 是被中断 turn 的结果，不是最终结果，继续 loop
            break
          }

          // This is the actual final result
          if (resultMsg.subtype === 'success' || !resultMsg.is_error) {
            if (resultMsg.result && typeof resultMsg.result === 'string') {
              resultText = resultMsg.result
            }
            isError = !!resultMsg.is_error
          } else {
            isError = true
            const errors = resultMsg.errors as string[] | undefined
            if (errors?.length) {
              resultText = errors.join('; ')
            }
          }
          break
        }
      }
    }

    if (loopSpanId) {
      traceCallback?.onLoopEnd(loopSpanId, isError ? 'failed' : 'completed', turnCount)
    }

    const finalText = resultText || '任务已完成，但模型未生成输出'

    const hasProgressDeps = !!taskOrigin && !!this.deps
    return {
      task_id: task.task_id,
      outcome: isError ? 'failed' : 'completed',
      summary: finalText,
      final_reply: (isError || !hasProgressDeps) ? { type: 'text', text: finalText } : undefined,
    }
  }

  /**
   * Inject a human message into a running query via streamInput()
   */
  private async injectHumanMessage(taskId: TaskId, text: string): Promise<void> {
    const queryHandle = this.activeQueries.get(taskId)
    if (!queryHandle) {
      log(`[supplement] injectHumanMessage: no queryHandle for task ${taskId}. activeQueries keys: [${Array.from(this.activeQueries.keys()).join(', ')}]`)
      return
    }

    log(`[supplement] Calling streamInput for task ${taskId}`)

    async function* singleMessage(): AsyncIterable<SDKUserMessage> {
      yield {
        type: 'user',
        session_id: '',
        message: { role: 'user', content: [{ type: 'text', text: `用户补充指示：${text}` }] },
        parent_tool_use_id: null,
      }
    }

    try {
      await queryHandle.streamInput(singleMessage())
      log(`[supplement] streamInput succeeded for task ${taskId}`)
    } catch (error) {
      log(`[supplement] streamInput FAILED for task ${taskId}: ${error instanceof Error ? error.message : error}`)
    }
  }

  deliverHumanResponse(taskId: TaskId, messages: ChannelMessage[]): void {
    const taskState = this.activeTasks.get(taskId)
    if (!taskState) {
      log(`[supplement] deliverHumanResponse: task ${taskId} NOT FOUND. activeTasks keys: [${Array.from(this.activeTasks.keys()).join(', ')}]`)
      throw new Error(`Task not found: ${taskId}`)
    }
    log(`[supplement] deliverHumanResponse: queued ${messages.length} messages for task ${taskId} (status: ${taskState.status}, pending: ${taskState.pendingHumanMessages.length})`)
    taskState.pendingHumanMessages.push(...messages)

    // 立即 interrupt，不等 turn 结束
    const queryHandle = this.activeQueries.get(taskId)
    if (queryHandle) {
      queryHandle.interrupt().catch((err) => {
        log(`[supplement] immediate interrupt() failed: ${err instanceof Error ? err.message : err}`)
      })
      log(`[supplement] immediate interrupt() fired for task ${taskId}`)
    }
  }

  cancelTask(taskId: TaskId, _reason: string): void {
    const taskState = this.activeTasks.get(taskId)
    if (taskState) {
      taskState.abortController.abort()
      taskState.status = 'cancelled'
    }
    // Also try to interrupt the query gracefully
    const queryHandle = this.activeQueries.get(taskId)
    if (queryHandle) {
      queryHandle.interrupt().catch(() => { /* ignore */ })
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
        parts.push(msg.content.text ?? '[非文本消息]')
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
        parts.push(`- ${m.sender.platform_display_name}: ${m.content.text ?? '[非文本消息]'}`)
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
