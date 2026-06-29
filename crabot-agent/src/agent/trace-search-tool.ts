import type { ToolDefinition } from '../engine/types'
import { defineTool } from '../engine/tool-framework'
import type { TraceStore } from '../core/trace-store'

export function createSearchTracesTool(traceStore: TraceStore): ToolDefinition {
  return defineTool({
    name: 'search_traces',
    description:
      '已知 task_id 或 trace_id 时取过程详情：span 树、tool_call 序列、错误堆栈、执行流水。' +
      '【不要】用本工具的 keyword 字段当作"找历史 task 用什么 ID"的关键词探路——召回率低、噪声大、消耗轮数。' +
      '该场景应先调 `search_short_term`（事件流水账自带 task_id/trace_id 锚点），拿到 ID 后再用本工具取详情。' +
      '仅在已知 ID 或确实需要全库通搜（无更优锚点）时才用 keyword 字段。',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: '按任务 ID 查找关联的所有执行记录' },
        keyword: { type: 'string', description: '关键词搜索（匹配任务摘要和执行结果）' },
        time_range: {
          type: 'object',
          properties: {
            start: { type: 'string', description: 'ISO 8601 开始时间' },
            end: { type: 'string', description: 'ISO 8601 结束时间' },
          },
        },
        status: { type: 'string', enum: ['running', 'completed', 'failed'], description: '状态过滤' },
        include_spans: { type: 'boolean', description: '是否返回 span 详情（默认 false，需配合 task_id 使用）' },
        parent_span_id: { type: 'string', description: '只返回某个 span 的子 span（用于逐层钻取）' },
        limit: { type: 'number', description: '返回条数（默认 20）' },
        offset: { type: 'number', description: '分页偏移（默认 0）' },
      },
    },
    isReadOnly: true,
    call: async (input) => {
      try {
        const params = input as {
          task_id?: string
          keyword?: string
          time_range?: { start: string; end: string }
          status?: string
          include_spans?: boolean
          parent_span_id?: string
          limit?: number
          offset?: number
        }

        const limit = Math.max(0, Math.min(params.limit ?? 20, 100))
        const offset = Math.max(0, params.offset ?? 0)

        // When task_id is provided without include_spans, return trace tree
        if (params.task_id && !params.include_spans) {
          const tree = traceStore.getTraceTree(params.task_id)
          return { output: JSON.stringify(tree), isError: false }
        }

        // When include_spans is true, drill into a specific trace's spans
        if (params.include_spans && params.task_id) {
          const tree = traceStore.getTraceTree(params.task_id)
          const allTraceIds = [
            ...tree.tree.fronts.map(t => t.trace_id),
            ...tree.tree.workers.map(t => t.trace_id),
            ...tree.tree.subagents.map(t => t.trace_id),
          ]
          const targetTraceId = allTraceIds[0]
          if (targetTraceId) {
            const spanResult = traceStore.getSpansAtDepth(targetTraceId, {
              parent_span_id: params.parent_span_id,
            })
            return {
              output: JSON.stringify({ trace_id: targetTraceId, ...spanResult }),
              isError: false,
            }
          }
          return { output: JSON.stringify({ traces: [], total: 0 }), isError: false }
        }

        // General search
        const result = traceStore.searchTraces({
          task_id: params.task_id,
          keyword: params.keyword,
          time_range: params.time_range,
          status: params.status,
          limit,
          offset,
        })

        return { output: JSON.stringify({ traces: result.traces, total: result.total }), isError: false }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error)
        return { output: `search_traces error: ${msg}`, isError: true }
      }
    },
  })
}
