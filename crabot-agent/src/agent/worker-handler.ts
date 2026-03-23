/**
 * Worker Handler - 任务执行处理器
 *
 * 使用 Claude Agent SDK + createSdkMcpServer 实现工具调用
 */

import { runSdk, createSdkMcpServer, tool } from './sdk-runner.js'
import type { SdkRunOptions, SdkMcpServerConfig } from './sdk-runner.js'
import type { SdkEnvConfig } from './front-handler.js'
import { z } from 'zod/v4'
import type {
  ExecuteTaskParams,
  ExecuteTaskResult,
  WorkerAgentContext,
  WorkerTaskState,
  TaskId,
  ChannelMessage,
  TraceCallback,
} from '../types.js'

const TASK_INSTRUCTIONS = `## 任务执行规则（内部指令）

你负责执行复杂任务：
1. 深度分析任务需求
2. 使用可用工具完成任务
3. 如果需要人类反馈，调用 ask_human 工具
4. 完成后输出最终结果

工作原则：
- 仔细阅读任务描述，理解用户真实需求
- 制定清晰的执行计划
- 按步骤执行，遇到问题及时调整
- 如果无法完成，说明原因并给出建议

### 通讯能力
- 使用 get_history 查看更多聊天记录（预加载的消息可能不够）
- 使用 send_message 在任意 Channel/Session 中发送消息
- 使用 lookup_friend 查找联系人信息
- 使用 list_sessions 查看 Channel 上的会话列表
- 使用 open_private_session 打开与某人的私聊

完成任务后，直接输出最终结果。`

export interface WorkerHandlerConfig {
  personalityPrompt?: string
  maxIterations: number
}

export class WorkerHandler {
  private sdkEnv: SdkEnvConfig
  private config: WorkerHandlerConfig
  private systemPrompt: string
  private activeTasks: Map<TaskId, WorkerTaskState> = new Map()
  /** Factory that creates fresh MCP server configs per runSdk() call (avoids Protocol reuse) */
  private mcpConfigFactory: (() => Record<string, SdkMcpServerConfig>) | undefined

  constructor(
    sdkEnv: SdkEnvConfig,
    config?: Partial<WorkerHandlerConfig>,
    mcpConfigFactory?: () => Record<string, SdkMcpServerConfig>,
  ) {
    this.sdkEnv = sdkEnv
    this.mcpConfigFactory = mcpConfigFactory
    this.config = {
      personalityPrompt: config?.personalityPrompt,
      maxIterations: config?.maxIterations ?? 20,
    }
    this.systemPrompt = this.config.personalityPrompt
      ? `${this.config.personalityPrompt}\n\n${TASK_INSTRUCTIONS}`
      : TASK_INSTRUCTIONS
  }

  async executeTask(
    params: ExecuteTaskParams,
    traceCallback?: TraceCallback,
  ): Promise<ExecuteTaskResult> {
    const { task, context } = params
    const abortController = new AbortController()
    const taskState: WorkerTaskState = {
      taskId: task.task_id,
      status: 'executing',
      startedAt: new Date().toISOString(),
      abortController,
      pendingHumanMessages: [],
    }
    this.activeTasks.set(task.task_id, taskState)

    try {
      const taskMessage = this.buildTaskMessage(task, context)

      // ask_human 工具通过 SDK MCP 服务器提供
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
              const result = await this.handleAskHuman(task.task_id, { question: args.question }, taskState)
              return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] }
            },
          ),
        ],
      })

      // Create fresh MCP server configs per executeTask call (avoids Protocol reuse)
      const externalMcpConfigs = this.mcpConfigFactory?.() ?? {}
      const mcpServers: Record<string, SdkMcpServerConfig> = {
        'crabot-worker': askHumanServer as unknown as SdkMcpServerConfig,
        ...externalMcpConfigs,
      }

      const sdkOpts: SdkRunOptions = {
        prompt: taskMessage,
        systemPrompt: this.buildSystemPrompt(context),
        model: this.sdkEnv.modelId,
        env: this.sdkEnv.env,
        maxTurns: this.config.maxIterations,
        loopLabel: 'worker',
        mcpServers,
        // 不设置 allowedTools，让 SDK 使用默认工具集 + MCP 工具
        // Bash, Read, Write, Glob, Grep 等默认工具 + ask_human MCP 工具
        abortController,
        traceCallback,
      }

      const result = await runSdk(sdkOpts)

      return {
        task_id: task.task_id,
        outcome: result.isError ? 'failed' : 'completed',
        summary: result.text || (result.isError ? result.errors?.join('; ') ?? '执行失败' : '任务已完成'),
        final_reply: { type: 'text', text: result.text || '任务已完成' },
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      if (abortController.signal.aborted) {
        return { task_id: task.task_id, outcome: 'failed', summary: '任务被取消' }
      }
      return {
        task_id: task.task_id,
        outcome: 'failed',
        summary: `执行失败: ${errorMessage}`,
        final_reply: { type: 'text', text: `抱歉，执行任务时出现错误: ${errorMessage}` },
      }
    } finally {
      this.activeTasks.delete(task.task_id)
    }
  }

  deliverHumanResponse(taskId: TaskId, messages: ChannelMessage[]): void {
    const taskState = this.activeTasks.get(taskId)
    if (!taskState) { throw new Error(`Task not found: ${taskId}`) }
    taskState.pendingHumanMessages.push(...messages)
  }

  cancelTask(taskId: TaskId, _reason: string): void {
    const taskState = this.activeTasks.get(taskId)
    if (taskState) {
      taskState.abortController.abort()
      taskState.status = 'cancelled'
    }
  }

  getActiveTaskCount(): number { return this.activeTasks.size }

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
    parts.push(`\n## 任务描述\n${task.task_description}`)

    if (context.task_origin) {
      parts.push('\n## 任务来源（crab-messaging 工具请使用这些 ID）')
      parts.push(`- Channel ID: ${context.task_origin.channel_id}`)
      parts.push(`- Session ID: ${context.task_origin.session_id}`)
    }
    if (context.short_term_memories.length > 0) {
      parts.push('\n## 短期记忆')
      for (const m of context.short_term_memories.slice(-5)) { parts.push(`- ${m.content}`) }
    }
    if (context.long_term_memories.length > 0) {
      parts.push('\n## 长期记忆')
      for (const m of context.long_term_memories.slice(-5)) { parts.push(`- ${m.content}`) }
    }
    if (context.recent_messages && context.recent_messages.length > 0) {
      parts.push('\n## 最近相关消息')
      for (const m of context.recent_messages.slice(-20)) {
        parts.push(`- ${m.sender.platform_display_name}: ${m.content.text ?? '[非文本消息]'}`)
      }
    }
    return parts.join('\n')
  }

  private handleAskHuman(
    _taskId: TaskId,
    input: { question: string },
    taskState: WorkerTaskState,
  ): Promise<unknown> {
    taskState.status = 'waiting_for_human'
    return Promise.resolve({
      status: 'waiting',
      message: '已向人类发送问题，等待响应...',
      question: input.question,
    })
  }
}
