/**
 * recordSubAgentTurn — 把一轮 engine turn 的 llm_call + 嵌套 tool_call span 写入
 * 一条已存在的 sub-agent 子 trace。
 *
 * 抽出来是为了让异步 sub-agent 路径（bg-agent）记录的 span 瀑布与同步路径
 * （agent-handler 的 runSubAgentDirect 里的 subTraceCallback）一致。
 *
 * onTurn 是事后回调（LLM + 工具都执行完才触发），所以用 engine 测得的
 * started_at_ms 回填时间戳，保证瀑布图时序准确。
 */

import type { TraceStore } from '../core/trace-store.js'
import type { EngineTurnEvent } from './types.js'

export type TraceTextRedactor = (text: string) => string

export function recordSubAgentTurn(
  traceStore: TraceStore,
  traceId: string,
  event: EngineTurnEvent,
  redact: TraceTextRedactor = (text) => text,
): void {
  const assistantText = redact(event.assistantText)
  const llmEndedAtMs =
    event.llmStartedAtMs !== undefined && event.llmCallMs !== undefined
      ? event.llmStartedAtMs + event.llmCallMs
      : undefined

  const llmSpan = traceStore.startSpan(traceId, {
    type: 'llm_call',
    details: {
      iteration: event.turnNumber,
      input_summary: `turn ${event.turnNumber}`,
    },
    ...(event.llmStartedAtMs !== undefined ? { started_at_ms: event.llmStartedAtMs } : {}),
  })

  for (const toolCall of event.toolCalls) {
    const toolEndedAtMs =
      toolCall.startedAtMs !== undefined && toolCall.durationMs !== undefined
        ? toolCall.startedAtMs + toolCall.durationMs
        : undefined

    const toolSpan = traceStore.startSpan(traceId, {
      type: 'tool_call',
      parent_span_id: llmSpan.span_id,
      details: {
        tool_name: toolCall.name,
        input_summary: JSON.stringify(toolCall.input ?? {}).slice(0, 200),
      },
      ...(toolCall.startedAtMs !== undefined ? { started_at_ms: toolCall.startedAtMs } : {}),
    })
    traceStore.endSpan(
      traceId,
      toolSpan.span_id,
      toolCall.isError ? 'failed' : 'completed',
      {
        output_summary: String(toolCall.output).slice(0, 500),
        error: toolCall.isError ? String(toolCall.output) : undefined,
      },
      toolEndedAtMs,
    )
  }

  traceStore.endSpan(
    traceId,
    llmSpan.span_id,
    'completed',
    {
      stop_reason: event.stopReason ?? undefined,
      ...(assistantText.trim() ? { assistant_text: assistantText } : {}),
      tool_calls_count: event.toolCalls.length > 0 ? event.toolCalls.length : undefined,
    },
    llmEndedAtMs,
  )
}
