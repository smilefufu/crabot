/**
 * delegate_task 工具
 *
 * worker 工具表里唯一的 subagent 入口。
 * - description 含 <available_subagents> 段 + 每个 subagent 的 when_to_use（截断到 300 字符）
 * - inputSchema.subagent_type.enum 限制为已 enabled 的 subagent name
 * - call: 按 subagent_type 查表 → 调 runSubAgent（caller 提供）
 *
 * 注意：subagent 工具集**永远不含** delegate_task（防嵌套），由 subagent-tool-filter
 * 在 spawn 子 agent 工具表时统一剔除。
 *
 * Spec: crabot-docs/superpowers/specs/2026-05-17-subagent-customization-and-admin-ui-design.md §3.2
 *
 * TODO(phase-2b): support run_in_background for persistent subagent spawn
 */

import type { ToolDefinition, ToolCallContext, ToolCallResult } from '../engine/types.js'
import type { SubAgentConfig } from '../types.js'

/** Subagent 调用入参 */
export interface RunSubAgentInput {
  readonly subagent_type: string
  readonly task: string
  readonly context?: string
  readonly image_paths?: string[]
  /**
   * 显式同步模式：true = 阻塞等待 subagent 完成后返回结果。
   * 默认 false（异步派发，工具立即返回 {agent_id, status:'launched'}）。
   * 仅在 subagent 输出需要在同 turn 立即使用的少数场景传 true。
   */
  readonly sync?: boolean
}

/** 调用 subagent 的实际函数；由 caller（agent-handler）实现，注入到 createDelegateTaskTool */
export type RunSubAgentFn = (
  subagent: SubAgentConfig,
  input: RunSubAgentInput,
  ctx: ToolCallContext,
) => Promise<ToolCallResult>

/**
 * 组装 delegate_task 工具的 description。
 * 内含 <available_subagents> 列表 + 每个 subagent 的 when_to_use（截断到 300 字符）。
 */

/** when_to_use 内嵌全文的字符上限：超出部分截断并加省略标记，控制 description 体积 */
const WHEN_TO_USE_MAX_CHARS = 300

function truncateWhenToUse(text: string): string {
  if (text.length <= WHEN_TO_USE_MAX_CHARS) return text
  let cut = text.slice(0, WHEN_TO_USE_MAX_CHARS)
  // 末尾若落在 lone high surrogate（代理对中间被切开）则去掉该码元，
  // 避免 description 里出现非法字符
  const lastCode = cut.charCodeAt(cut.length - 1)
  if (lastCode >= 0xd800 && lastCode <= 0xdbff) {
    cut = cut.slice(0, -1)
  }
  return `${cut}…[truncated]`
}

export function buildDelegateTaskDescription(subAgents: ReadonlyArray<SubAgentConfig>): string {
  const lines: string[] = [
    'Launch a specialized subagent to autonomously handle a task that benefits from a focused expert + 独立上下文。',
    '',
    '<available_subagents>',
  ]
  if (subAgents.length === 0) {
    lines.push('(no subagents currently enabled)')
  } else {
    for (const s of subAgents) {
      const head = s.description || s.when_to_use.split('\n')[0] || s.name
      lines.push(`- "${s.name}": ${head}`)
    }
  }
  lines.push('</available_subagents>')

  if (subAgents.length > 0) {
    lines.push('', 'When to use each subagent type:')
    for (const s of subAgents) {
      lines.push('', `=== ${s.name} ===`, truncateWhenToUse(s.when_to_use))
    }
  }

  lines.push(
    '',
    'Usage notes:',
    '- 默认异步：工具立即返回 {agent_id, status:"launched"}，不阻塞你；subagent 完成时系统自动推送 <sub_agent_notification> 给你',
    '- 单条 message 内可 batch 调多次 delegate_task 并发派出多个 subagent',
    '- subagent 在隔离上下文执行，不继承父对话历史；prompt 要写完整任务描述',
    '- 子 agent 返回 final output 后退出，无法续会话',
    '- subagent 看不到 delegate_task 工具，不能再委派下一层',
    '- sync: true 仅在 subagent 输出需要在同 turn 立即使用时传入（极少数场景）',
  )
  return lines.join('\n')
}

export interface CreateDelegateTaskToolOptions {
  readonly subAgents: ReadonlyArray<SubAgentConfig>
  readonly runSubAgent: RunSubAgentFn
}

/**
 * 创建 delegate_task 工具实例。
 * - subAgents 决定 inputSchema.subagent_type.enum + description 内容
 * - runSubAgent 由 caller 注入（含 trace / spawn / model adapter 选择等运行时依赖）
 */
export function createDelegateTaskTool(opts: CreateDelegateTaskToolOptions): ToolDefinition {
  // 过滤掉 system_only=true 的 subagent —— 它们仅由系统隐式触发，不暴露给 worker
  const visible = opts.subAgents.filter((s) => !s.system_only)
  const enabledNames = visible.map((s) => s.name)
  return {
    name: 'delegate_task',
    description: buildDelegateTaskDescription(visible),
    isReadOnly: false,
    inputSchema: {
      type: 'object',
      properties: {
        subagent_type: { type: 'string', enum: enabledNames, description: 'Which subagent to delegate to' },
        task: { type: 'string', description: '完整的任务描述（subagent 不继承父对话历史）' },
        context: { type: 'string', description: '可选；将父任务相关上下文传给 subagent' },
        image_paths: {
          type: 'array',
          items: { type: 'string' },
          description: '可选；仅当 subagent 的模型支持 vision 时生效',
        },
        sync: {
          type: 'boolean',
          description: '默认 false（异步）。true = 同步等待 subagent 完成后返回结果，仅在同 turn 内必须用 subagent 输出时传入',
        },
      },
      required: ['subagent_type', 'task'],
    },
    call: async (input: Record<string, unknown>, ctx: ToolCallContext): Promise<ToolCallResult> => {
      const subagentType = String(input.subagent_type ?? '')
      const subagent = visible.find((s) => s.name === subagentType)
      if (subagent === undefined) {
        return {
          output: `Unknown subagent_type "${subagentType}"。可用：[${enabledNames.join(', ')}]`,
          isError: true,
        }
      }
      return opts.runSubAgent(subagent, input as unknown as RunSubAgentInput, ctx)
    },
  }
}
