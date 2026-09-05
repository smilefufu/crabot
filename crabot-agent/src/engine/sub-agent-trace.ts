/**
 * Engine-backed builtin traces use append-only tool_call/tool_result records so a
 * cursor that has consumed the call can still observe the later result.
 *
 * 主线 builtin Worker、fork 和后台 sub-agent 共用这一投影，避免各自复制配对规则。
 *
 * onTurn 是事后回调（LLM + 工具都执行完才触发），所以用 engine 测得的
 * started_at_ms 回填时间戳，保证瀑布图时序准确。
 */

import type { TraceStore } from '../core/trace-store.js'
import type { AgentSpan, AgentSpanDetails } from '../types.js'
import type { EngineToolLifecycleEvent, EngineTurnEvent } from './types.js'

export type TraceTextRedactor = (text: string) => string

function detailsOf(span: AgentSpan): Record<string, unknown> {
  return (span.details ?? {}) as Record<string, unknown>
}

function hasToolPhase(traceStore: TraceStore, traceId: string, callId: string, type: 'tool_call' | 'tool_result'): boolean {
  return traceStore.getTrace(traceId)?.spans.some((span) =>
    span.type === type && detailsOf(span).call_id === callId,
  ) ?? false
}

function summarizeInput(input: Record<string, unknown>, redact: TraceTextRedactor): string {
  try {
    return redact(JSON.stringify(input)).slice(0, 300)
  } catch {
    return '[unserializable input removed]'
  }
}

export function subagentIdFromToolOutput(output: string | undefined): string | undefined {
  if (!output) return undefined
  const timestampPrefix = /^\[\d{2}:\d{2}:\d{2}\]\n/
  const payload = timestampPrefix.test(output) ? output.replace(timestampPrefix, '') : output
  try {
    const parsed = JSON.parse(payload) as { agent_id?: unknown }
    return typeof parsed.agent_id === 'string' ? parsed.agent_id : undefined
  } catch {
    return undefined
  }
}

function appendCompletedSpan(
  traceStore: TraceStore,
  traceId: string,
  type: 'tool_call' | 'tool_result',
  details: AgentSpanDetails,
  atMs: number,
  status: 'completed' | 'failed' = 'completed',
  parentSpanId?: string,
): void {
  const span = traceStore.startSpan(traceId, {
    type,
    details,
    started_at_ms: atMs,
    ...(parentSpanId ? { parent_span_id: parentSpanId } : {}),
  })
  traceStore.endSpan(traceId, span.span_id, status, undefined, atMs)
}

function appendToolCallIfMissing(
  traceStore: TraceStore,
  traceId: string,
  call: { callId: string; toolUseId: string; name: string; input: Record<string, unknown>; startedAtMs: number },
  redact: TraceTextRedactor,
  parentSpanId?: string,
): void {
  if (hasToolPhase(traceStore, traceId, call.callId, 'tool_call')) return
  appendCompletedSpan(traceStore, traceId, 'tool_call', {
    call_id: call.callId,
    tool_use_id: call.toolUseId,
    tool_name: call.name,
    input_summary: summarizeInput(call.input, redact),
  }, call.startedAtMs, 'completed', parentSpanId)
}

function appendToolResultIfMissing(
  traceStore: TraceStore,
  traceId: string,
  call: {
    callId: string
    toolUseId: string
    name: string
    output: string
    isError: boolean
    endedAtMs: number
  },
  redact: TraceTextRedactor,
  parentSpanId?: string,
): void {
  if (hasToolPhase(traceStore, traceId, call.callId, 'tool_result')) return
  const output = redact(call.output).slice(0, 500)
  const subagentId = call.name === 'delegate_task' ? subagentIdFromToolOutput(call.output) : undefined
  appendCompletedSpan(traceStore, traceId, 'tool_result', {
    call_id: call.callId,
    tool_use_id: call.toolUseId,
    tool_name: call.name,
    output_summary: output,
    ...(call.isError ? { is_error: true, error: output } : {}),
    ...(subagentId ? { subagent_id: subagentId } : {}),
  }, call.endedAtMs, call.isError ? 'failed' : 'completed', parentSpanId)
}

export function recordEngineToolLifecycle(
  traceStore: TraceStore,
  traceId: string,
  event: EngineToolLifecycleEvent,
  redact: TraceTextRedactor = (text) => text,
): void {
  if (event.type === 'tool_started') {
    appendToolCallIfMissing(traceStore, traceId, event, redact)
    return
  }
  appendToolCallIfMissing(traceStore, traceId, event, redact)
  appendToolResultIfMissing(traceStore, traceId, event, redact)
}

export function recordEngineTurnTools(
  traceStore: TraceStore,
  traceId: string,
  event: EngineTurnEvent,
  redact: TraceTextRedactor = (text) => text,
  parentSpanId?: string,
): void {
  for (const toolCall of event.toolCalls) {
    const startedAtMs = toolCall.startedAtMs ?? Date.now()
    appendToolCallIfMissing(traceStore, traceId, {
      callId: toolCall.callId,
      toolUseId: toolCall.id,
      name: toolCall.name,
      input: toolCall.input,
      startedAtMs,
    }, redact, parentSpanId)
    appendToolResultIfMissing(traceStore, traceId, {
      callId: toolCall.callId,
      toolUseId: toolCall.id,
      name: toolCall.name,
      output: toolCall.output,
      isError: toolCall.isError,
      endedAtMs: startedAtMs + (toolCall.durationMs ?? 0),
    }, redact, parentSpanId)
  }
}

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

  recordEngineTurnTools(traceStore, traceId, event, redact, llmSpan.span_id)

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
