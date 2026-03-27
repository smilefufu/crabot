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
  TaskOrigin,
  ChannelMessage,
  TraceCallback,
  SkillConfig,
} from '../types.js'
import type { RpcClient } from '../core/module-base.js'

import * as fs from 'fs'
import * as path from 'path'

const WORKER_PROMPTS_FILE = path.join(process.cwd(), 'prompts-worker.md')

const DEFAULT_TASK_INSTRUCTIONS = `## 任务执行规则（内部指令）

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

## 你已知道的上下文（无需工具获取）

上下文中已预加载：
- **最近相关消息**：当前会话最近消息（"## 最近相关消息"段落，条数见标题）
- **短期记忆**：与该用户的近期对话摘要
- **长期记忆**：通过语义搜索检索到的相关记忆

**不要用工具重复获取这些已有的信息。**

## 通讯工具

- **get_history**：查询当前会话更早的历史（已预加载的消息之前的内容）
- **send_message**：在任意 Channel/Session 中发送消息
- **lookup_friend**：查找联系人信息
- **list_sessions**：查看 Channel 上的会话列表
- **open_private_session**：打开与某人的私聊

完成任务后，直接输出最终结果。`

function loadWorkerPrompts(): string {
  try {
    if (fs.existsSync(WORKER_PROMPTS_FILE)) {
      return fs.readFileSync(WORKER_PROMPTS_FILE, 'utf-8')
    }
  } catch { /* ignore */ }
  return DEFAULT_TASK_INSTRUCTIONS
}

export interface WorkerHandlerConfig {
  personalityPrompt?: string
  /** 最大轮次，undefined 表示不限制 */
  maxIterations?: number
}

export interface ProgressDeps {
  rpcClient: RpcClient
  moduleId: string
  resolveChannelPort: (channelId: string) => Promise<number>
}

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
]

export class WorkerHandler {
  private sdkEnv: SdkEnvConfig
  private config: WorkerHandlerConfig
  private systemPrompt: string
  private activeTasks: Map<TaskId, WorkerTaskState> = new Map()
  /** Factory that creates fresh MCP server configs per runSdk() call (avoids Protocol reuse) */
  private mcpConfigFactory: (() => Record<string, SdkMcpServerConfig>) | undefined
  private progressDeps?: ProgressDeps

  constructor(
    sdkEnv: SdkEnvConfig,
    config?: Partial<WorkerHandlerConfig>,
    mcpConfigFactory?: () => Record<string, SdkMcpServerConfig>,
    progressDeps?: ProgressDeps,
  ) {
    this.sdkEnv = sdkEnv
    this.mcpConfigFactory = mcpConfigFactory
    this.progressDeps = progressDeps
    this.config = {
      personalityPrompt: config?.personalityPrompt,
      maxIterations: config?.maxIterations,
    }
    const taskInstructions = loadWorkerPrompts()
    this.systemPrompt = this.config.personalityPrompt
      ? `${this.config.personalityPrompt}\n\n${taskInstructions}`
      : taskInstructions
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
      title: task.task_title,
      abortController,
      pendingHumanMessages: [],
    }
    this.activeTasks.set(task.task_id, taskState)

    // Create isolated task directory
    const taskDir = `/tmp/crabot-task-${task.task_id}`

    try {
      await fs.promises.mkdir(taskDir, { recursive: true })

      // Write Admin Skills to task directory
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

      // Build allowedTools: static list + external MCP tool names
      const externalMcpToolNames = Object.keys(externalMcpConfigs)
        .filter((name) => name !== 'crabot-worker')
        .map((name) => `mcp__${name}__*`)
      const allowedTools = [...WORKER_ALLOWED_TOOLS, ...externalMcpToolNames]

      // Build progress callback
      const progressCallback = context.task_origin
        ? async (summary: string) => {
            await this.sendProgress(context.task_origin!, task.task_title, summary)
          }
        : undefined

      const sdkOpts: SdkRunOptions = {
        prompt: taskMessage,
        systemPrompt: this.buildSystemPrompt(context),
        model: this.sdkEnv.modelId,
        env: this.sdkEnv.env,
        ...(this.config.maxIterations !== undefined && { maxTurns: this.config.maxIterations }),
        loopLabel: 'worker',
        mcpServers,
        allowedTools,
        cwd: taskDir,
        progressCallback,
        abortController,
        traceCallback,
      }

      const result = await runSdk(sdkOpts)

      // SDK 结果可能为空（模型 thinking 消耗所有 token），从工具调用结果中提取
      const resultText = result.text
        || this.extractToolOutputSummary(result.toolCalls)
        || (result.isError ? result.errors?.join('; ') ?? '执行失败' : '任务已完成，但模型未生成输出')

      return {
        task_id: task.task_id,
        outcome: result.isError ? 'failed' : 'completed',
        summary: resultText,
        final_reply: { type: 'text', text: resultText },
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
      await this.cleanupTaskDir(taskDir)
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

  getActiveTasksForQuery(): Array<{ task_id: string; status: string; started_at: string; title?: string }> {
    return Array.from(this.activeTasks.values()).map((t) => ({
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
      parts.push(`\n## 最近相关消息（已预加载，共 ${context.recent_messages.length} 条；更早的历史用 get_history 工具获取）`)
      for (const m of context.recent_messages.slice(-20)) {
        parts.push(`- ${m.sender.platform_display_name}: ${m.content.text ?? '[非文本消息]'}`)
      }
    } else {
      parts.push('\n## 最近相关消息（暂无；如需历史消息，用 get_history 工具获取）')
    }

    // Check for front_context (from forced Front termination)
    const taskWithContext = task as { front_context?: Array<{ tool_name: string; input_summary: string; output_summary: string }> }
    if (taskWithContext.front_context && Array.isArray(taskWithContext.front_context)) {
      const frontContext = taskWithContext.front_context
      parts.push('\n## Front Agent 已完成的工作')
      parts.push('（以下是 Front 在分诊阶段已获取的信息，请直接使用，不要重复查询）')
      for (const entry of frontContext) {
        parts.push(`- ${entry.tool_name}: ${entry.output_summary}`)
      }
    }

    return parts.join('\n')
  }

  /**
   * 从工具调用记录中提取最后有意义的输出
   * 当 LLM 未生成文本时（thinking 消耗所有 token），从工具输出中兜底
   */
  private extractToolOutputSummary(toolCalls: Array<{ name: string; input: unknown; output: unknown }>): string | undefined {
    if (toolCalls.length === 0) return undefined

    // 从后往前找最后一个有输出的工具调用
    for (let i = toolCalls.length - 1; i >= 0; i--) {
      const call = toolCalls[i]
      if (call.output) {
        const text = typeof call.output === 'string'
          ? call.output
          : JSON.stringify(call.output)
        if (text.length > 0 && text !== 'undefined') {
          return `[${call.name}] ${text.slice(0, 2000)}`
        }
      }
    }

    // 没有输出，至少说明调用了哪些工具
    const toolNames = toolCalls.map((c) => c.name).join(', ')
    return `已执行工具: ${toolNames}（模型未生成总结文本）`
  }

  private async sendProgress(
    taskOrigin: TaskOrigin,
    taskTitle: string,
    summary: string,
  ): Promise<void> {
    if (!this.progressDeps) return
    try {
      const channelPort = await this.progressDeps.resolveChannelPort(taskOrigin.channel_id)
      await this.progressDeps.rpcClient.call(channelPort, 'send_message', {
        session_id: taskOrigin.session_id,
        content: { type: 'text', text: `[任务进度] ${taskTitle}\n${summary}` },
      }, this.progressDeps.moduleId)
    } catch { /* ignore progress send failures */ }
  }

  private async cleanupTaskDir(_taskDir: string): Promise<void> {
    try {
      const maxRetained = 5
      const entries = await fs.promises.readdir('/tmp')
      const dirs = entries.filter((d) => d.startsWith('crabot-task-')).map((d) => `/tmp/${d}`)
      if (dirs.length > maxRetained) {
        const withStats = await Promise.all(
          dirs.map(async (d) => {
            try {
              const stat = await fs.promises.stat(d)
              return { path: d, mtime: stat.mtimeMs }
            } catch {
              return null
            }
          })
        )
        const valid = withStats.filter((s): s is { path: string; mtime: number } => s !== null)
        const sorted = valid.sort((a, b) => a.mtime - b.mtime)
        for (const dir of sorted.slice(0, dirs.length - maxRetained)) {
          await fs.promises.rm(dir.path, { recursive: true, force: true })
        }
      }
    } catch { /* ignore cleanup errors */ }
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
