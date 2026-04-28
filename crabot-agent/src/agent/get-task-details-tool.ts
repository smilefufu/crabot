/**
 * get_task_details 工具 — 拉取一个任务的"完整执行复盘"。
 *
 * 用途：用户说"继续之前那个任务" / "上次到哪了" 时，agent 用这个工具拉详情，
 * 决定下一步该干什么（基于已做的工作、停止原因、遗留现场）。
 *
 * 数据源：
 * - admin.get_task → 任务元数据（title / description / plan / result / outcome / 时间）
 * - 本地 traceStore.getFullTrace → trace span 树（含每轮 llm_call + tool_call）
 *
 * 输出：人类可读文本。如果原始数据估算 token 超阈值，自动用 digest LLM 压缩。
 */

import type { ToolDefinition } from '../engine/types'
import { defineTool } from '../engine/tool-framework'
import { callNonStreaming } from '../engine/llm-adapter'
import type { LLMAdapter } from '../engine/llm-adapter'
import type { TraceStore } from '../core/trace-store'
import type { RpcClient } from 'crabot-shared'
import type { AgentTrace, AgentSpan, ToolCallDetails, LlmCallDetails } from '../types'

/** 估算 token 的粗略系数（中文混排约 1 token ≈ 2.5 字符，留余量） */
const CHARS_PER_TOKEN = 2.5
/** 超过这个 token 数就用 digest LLM 压缩 */
const COMPRESS_THRESHOLD_TOKENS = 4000
/** tool 输出的最终硬上限（即便压缩失败也要截断） */
const FINAL_HARD_LIMIT_CHARS = 16_000

export interface GetTaskDetailsToolDeps {
  readonly rpcClient: RpcClient
  readonly moduleId: string
  readonly getAdminPort: () => Promise<number>
  readonly traceStore: TraceStore
  /** 可选：digest LLM adapter（用于超阈值压缩）；缺省则只截断不压缩 */
  readonly digestAdapter?: LLMAdapter
  readonly digestModelId?: string
}

/** 估算字符串的 token 数（粗算） */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN)
}

/** 把 ISO 时间戳格式化为简短可读 */
function fmtTime(iso?: string): string {
  if (!iso) return '?'
  return iso.slice(0, 19).replace('T', ' ')
}

/** 截断长字符串（用于 raw output_summary） */
function truncate(text: string | undefined, max: number): string {
  if (!text) return ''
  return text.length > max ? text.slice(0, max) + '…(截断)' : text
}

/**
 * 把 trace 列表转成"按轮次排列的工具调用流水"
 * 返回纯文本块。
 */
function renderTraceFlow(traces: AgentTrace[]): string {
  if (traces.length === 0) return '（无 trace 记录）'
  const lines: string[] = []
  for (const trace of traces) {
    lines.push(`### Trace: ${trace.trigger.summary} [${trace.status}]`)
    lines.push(`时间: ${fmtTime(trace.started_at)} → ${fmtTime(trace.ended_at)}`)
    if (trace.outcome?.summary) lines.push(`结局: ${trace.outcome.summary}`)
    if (trace.outcome?.error) lines.push(`错误: ${trace.outcome.error}`)

    // 索引：parent_span_id → children
    const childrenByParent = new Map<string, AgentSpan[]>()
    for (const s of trace.spans) {
      const pid = s.parent_span_id ?? '__root__'
      const arr = childrenByParent.get(pid) ?? []
      arr.push(s)
      childrenByParent.set(pid, arr)
    }

    // 找到 llm_call 类 span，按时间序列出，每个下面挂 tool_call 子 span
    const llmCalls = trace.spans
      .filter(s => s.type === 'llm_call')
      .sort((a, b) => a.started_at.localeCompare(b.started_at))

    if (llmCalls.length === 0) {
      lines.push('（无 llm_call span）')
    } else {
      for (const llm of llmCalls) {
        const d = llm.details as LlmCallDetails
        const turn = d.iteration ?? '?'
        lines.push(`- 第 ${turn} 轮：${truncate(d.input_summary, 80) || '(无摘要)'}`)
        const toolChildren = (childrenByParent.get(llm.span_id) ?? [])
          .filter(s => s.type === 'tool_call')
        for (const tc of toolChildren) {
          const td = tc.details as ToolCallDetails
          const flag = tc.status === 'failed' ? ' ❌' : ''
          lines.push(`  → ${td.tool_name}${flag}: ${truncate(td.input_summary, 200)}`)
          if (td.output_summary) {
            lines.push(`     结果: ${truncate(td.output_summary, 300)}`)
          }
          if (td.error) lines.push(`     错误: ${truncate(td.error, 200)}`)
        }
      }
    }
    lines.push('')
  }
  return lines.join('\n')
}

/** 渲染 task 元数据段 */
function renderTaskMeta(task: {
  id: string
  title: string
  status: string
  description?: string
  created_at: string
  updated_at: string
  started_at?: string
  completed_at?: string
  plan?: { goal: string; steps?: Array<{ description?: string; status?: string }> }
  result?: { outcome: string; summary: string; final_reply?: { text: string } }
  error?: string
}): string {
  const lines: string[] = []
  lines.push(`# 任务 [${task.id}] ${task.title}`)
  lines.push(`状态: ${task.status}`)
  lines.push(`创建: ${fmtTime(task.created_at)} / 启动: ${fmtTime(task.started_at)} / 结束: ${fmtTime(task.completed_at)}`)
  if (task.description) lines.push(`描述: ${task.description}`)
  if (task.plan) {
    lines.push(`计划目标: ${task.plan.goal}`)
    if (task.plan.steps && task.plan.steps.length > 0) {
      lines.push('计划步骤:')
      task.plan.steps.forEach((step, i) => {
        lines.push(`  ${i + 1}. ${step.description ?? '(无)'} [${step.status ?? '?'}]`)
      })
    }
  }
  if (task.result) {
    lines.push(`\n## 最终结果`)
    lines.push(`outcome: ${task.result.outcome}`)
    lines.push(`summary: ${task.result.summary}`)
    if (task.result.final_reply?.text) {
      lines.push(`final_reply: ${task.result.final_reply.text}`)
    }
  }
  if (task.error) lines.push(`错误: ${task.error}`)
  return lines.join('\n')
}

/**
 * 调 digest LLM 压缩超长详情。
 * 提示语专门保留续跑判断所需的信息（停止原因、遗留现场）。
 */
async function compressWithDigestLLM(
  rawText: string,
  adapter: LLMAdapter,
  modelId: string,
): Promise<string> {
  const systemPrompt = `你是任务复盘助手。你会收到一个任务的元数据 + 完整执行流水。
请压缩到 1500 字以内，但必须保留以下要素（这些是判断"接下来该不该继续以及怎么继续"的依据）：

1. 任务标题、最终状态（completed/failed/aborted/running）
2. 主要做了什么（按时间顺序的关键动作，不必逐工具）
3. 停止原因（如果未完成）：是被中止？出错？还是已完成？
4. 遗留现场：创建了哪些文件 / 改了哪些远程配置 / 起了哪些进程，但可能还没验证
5. 下一步该做什么的提示（如果原始数据里能推断出来）

不要使用 markdown 标题（# / ##）；用纯文本和短列表即可。
不要编造任何原始数据里没有的信息。`

  try {
    const result = await callNonStreaming(adapter, {
      messages: [{
        id: 'compress-input',
        role: 'user',
        content: rawText,
        timestamp: Date.now(),
      }],
      systemPrompt,
      tools: [],
      model: modelId,
      maxTokens: 2000,
    })
    const text = result.content
      .filter(b => b.type === 'text')
      .map(b => (b as { text: string }).text)
      .join('')
    return text.length > 0 ? text : rawText.slice(0, FINAL_HARD_LIMIT_CHARS)
  } catch (error) {
    // 压缩失败回退到硬截断；不让 agent 拿不到任何东西
    const msg = error instanceof Error ? error.message : String(error)
    return `[压缩失败：${msg}，以下为截断后的原始详情]\n\n${rawText.slice(0, FINAL_HARD_LIMIT_CHARS)}`
  }
}

export function createGetTaskDetailsTool(deps: GetTaskDetailsToolDeps): ToolDefinition {
  return defineTool({
    name: 'get_task_details',
    description:
      '查询某个历史任务的完整执行详情：元数据、计划、按时间顺序的工具调用流水、最终结果或停止原因。' +
      '用于回答"上次做到哪了"/"之前那个任务怎么样了"，或在"继续之前的任务"场景里判断下一步该做什么。' +
      '超长时会自动压缩。',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: {
          type: 'string',
          description: '要查询的任务 ID（可从 active_tasks / recently_closed_tasks 里挑）',
        },
      },
      required: ['task_id'],
    },
    isReadOnly: true,
    call: async (input) => {
      const { task_id } = input as { task_id: string }
      if (!task_id || typeof task_id !== 'string') {
        return { output: 'get_task_details: task_id 必填且为字符串', isError: true }
      }

      // 1. 拉 admin task 元数据
      let task: Parameters<typeof renderTaskMeta>[0]
      try {
        const adminPort = await deps.getAdminPort()
        const result = await deps.rpcClient.call<
          { task_id: string },
          { task: Parameters<typeof renderTaskMeta>[0] }
        >(adminPort, 'get_task', { task_id }, deps.moduleId)
        task = result.task
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error)
        return { output: `get_task_details: 找不到任务 ${task_id}（${msg}）`, isError: true }
      }

      // 2. 拉本地 trace 树，加载完整 trace（getFullTrace 走 ring buffer + 文件按需读）
      const tree = deps.traceStore.getTraceTree(task_id)
      const traceIds = [
        ...tree.tree.fronts.map(t => t.trace_id),
        ...(tree.tree.worker ? [tree.tree.worker.trace_id] : []),
        ...tree.tree.subagents.map(t => t.trace_id),
      ]
      const traces: AgentTrace[] = []
      for (const tid of traceIds) {
        const t = await deps.traceStore.getFullTrace(tid)
        if (t) traces.push(t)
      }

      // 3. 拼可读文本
      const metaBlock = renderTaskMeta(task)
      const flowBlock = renderTraceFlow(traces)
      const rawText = `${metaBlock}\n\n## 执行流水\n\n${flowBlock}`

      // 4. token 估算 + 按需压缩
      const tokens = estimateTokens(rawText)
      if (tokens <= COMPRESS_THRESHOLD_TOKENS) {
        return { output: rawText, isError: false }
      }

      if (deps.digestAdapter && deps.digestModelId) {
        const compressed = await compressWithDigestLLM(rawText, deps.digestAdapter, deps.digestModelId)
        return {
          output: `[原始 ${tokens} tokens 超过 ${COMPRESS_THRESHOLD_TOKENS} 阈值，已压缩]\n\n${compressed}`,
          isError: false,
        }
      }

      // 没有 digest LLM 可用 → 硬截断
      return {
        output: `[原始 ${tokens} tokens 超过 ${COMPRESS_THRESHOLD_TOKENS} 阈值且无 digest LLM 可用，硬截断]\n\n${rawText.slice(0, FINAL_HARD_LIMIT_CHARS)}`,
        isError: false,
      }
    },
  })
}
