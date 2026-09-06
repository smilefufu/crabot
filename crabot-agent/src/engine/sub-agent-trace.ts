/**
 * Engine-backed builtin traces use append-only tool_call/tool_result records so a
 * cursor that has consumed the call can still observe the later result.
 *
 * 主线 builtin Worker、fork 和后台 sub-agent 共用这一投影，避免各自复制配对规则。
 *
 * onLlmResponse 在工具前写完整 LLM record；onTurn 只按稳定 ID 补漏。
 */

import type { TraceStore } from '../core/trace-store.js'
import { llmUsageToTrace } from '../core/trace-usage.js'
import type { AgentSpan, AgentSpanDetails } from '../types.js'
import type { EngineLlmResponseEvent, EngineToolLifecycleEvent, EngineTurnEvent } from './types.js'

export type TraceTextRedactor = (text: string) => string

function detailsOf(span: AgentSpan): Record<string, unknown> {
  return (span.details ?? {}) as Record<string, unknown>
}

function findLlmResponseSpan(traceStore: TraceStore, traceId: string, responseId: string): AgentSpan | undefined {
  return traceStore.getTrace(traceId)?.spans.find((span) =>
    span.type === 'llm_call' && detailsOf(span).response_id === responseId,
  )
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

function appendLlmResponseIfMissing(
  traceStore: TraceStore,
  traceId: string,
  event: EngineLlmResponseEvent,
  redact: TraceTextRedactor,
): AgentSpan | undefined {
  const existing = findLlmResponseSpan(traceStore, traceId, event.responseId)
  if (existing) return existing
  const assistantText = redact(event.assistantText)
  const llmSpan = traceStore.startSpan(traceId, {
    type: 'llm_call',
    details: {
      response_id: event.responseId,
      iteration: event.turnNumber,
      input_summary: `turn ${event.turnNumber}`,
      stop_reason: event.stopReason,
      ...(assistantText.trim() ? { assistant_text: assistantText } : {}),
      tool_calls_count: event.toolCallsCount,
      ...(event.forcedSummaryAttempt !== undefined ? { forced_summary_attempt: event.forcedSummaryAttempt } : {}),
      ...(event.usage ? { usage: llmUsageToTrace(event.usage) } : {}),
      ...(event.diagnostics ? {
        stream_retries: event.diagnostics.retries,
        ...(event.diagnostics.firstChunkMs !== undefined ? { first_chunk_ms: event.diagnostics.firstChunkMs } : {}),
        chunk_count: event.diagnostics.chunkCount,
      } : {}),
    },
    started_at_ms: event.llmStartedAtMs,
  })
  traceStore.endSpan(
    traceId,
    llmSpan.span_id,
    'completed',
    undefined,
    event.llmStartedAtMs + event.llmCallMs,
  )
  return llmSpan
}

export function recordEngineLlmResponse(
  traceStore: TraceStore,
  traceId: string,
  event: EngineLlmResponseEvent,
  redact: TraceTextRedactor = (text) => text,
): void {
  appendLlmResponseIfMissing(traceStore, traceId, event, redact)
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
  call: { responseId: string; callId: string; toolUseId: string; name: string; input: Record<string, unknown>; startedAtMs: number },
  redact: TraceTextRedactor,
  parentSpanId?: string,
): void {
  if (hasToolPhase(traceStore, traceId, call.callId, 'tool_call')) return
  appendCompletedSpan(traceStore, traceId, 'tool_call', {
    response_id: call.responseId,
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
    responseId: string
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
    response_id: call.responseId,
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
  const parentSpanId = findLlmResponseSpan(traceStore, traceId, event.responseId)?.span_id
  if (event.type === 'tool_started') {
    appendToolCallIfMissing(traceStore, traceId, event, redact, parentSpanId)
    return
  }
  appendToolCallIfMissing(traceStore, traceId, event, redact, parentSpanId)
  appendToolResultIfMissing(traceStore, traceId, event, redact, parentSpanId)
}

export function recordEngineTurnTools(
  traceStore: TraceStore,
  traceId: string,
  event: EngineTurnEvent,
  redact: TraceTextRedactor = (text) => text,
): void {
  const parentSpanId = findLlmResponseSpan(traceStore, traceId, event.responseId)?.span_id
  for (const toolCall of event.toolCalls) {
    const startedAtMs = toolCall.startedAtMs ?? Date.now()
    appendToolCallIfMissing(traceStore, traceId, {
      responseId: event.responseId,
      callId: toolCall.callId,
      toolUseId: toolCall.id,
      name: toolCall.name,
      input: toolCall.input,
      startedAtMs,
    }, redact, parentSpanId)
    appendToolResultIfMissing(traceStore, traceId, {
      responseId: event.responseId,
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
  recordEngineLlmResponse(traceStore, traceId, {
    responseId: event.responseId,
    turnNumber: event.turnNumber,
    assistantText: event.assistantText,
    stopReason: event.stopReason,
    toolCallsCount: event.toolCalls.length,
    llmCallMs: event.llmCallMs ?? 0,
    llmStartedAtMs: event.llmStartedAtMs ?? Date.now(),
    ...(event.forcedSummaryAttempt !== undefined ? { forcedSummaryAttempt: event.forcedSummaryAttempt } : {}),
    ...(event.usage ? { usage: event.usage } : {}),
    ...(event.diagnostics ? { diagnostics: event.diagnostics } : {}),
  }, redact)
  recordEngineTurnTools(traceStore, traceId, event, redact)
}
