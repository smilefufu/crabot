import { describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  recordEngineLlmResponse,
  recordEngineToolLifecycle,
  recordSubAgentTurn,
} from '../../src/engine/sub-agent-trace.js'
import { TraceStore } from '../../src/core/trace-store.js'

describe('recordSubAgentTurn', () => {
  it('按 response_id/call_id 追加 response/call/result，onTurn 只补漏且重复回调幂等', () => {
    const traceStore = new TraceStore(10)
    const trace = traceStore.startTrace({ module_id: 'test', trigger: { type: 'sub_agent_call', summary: 'test' } })
    const started = {
      type: 'tool_started' as const,
      responseId: 'engine-response',
      callId: 'engine-call',
      turnNumber: 1,
      toolUseId: 'provider-call',
      name: 'delegate_task',
      input: { path: '/secret/path' },
      startedAtMs: 1_000,
    }
    const finished = {
      type: 'tool_finished' as const,
      responseId: 'engine-response',
      callId: 'engine-call',
      turnNumber: 1,
      toolUseId: 'provider-call',
      name: 'delegate_task',
      input: { path: '/secret/path' },
      output: '[12:34:56]\n{"agent_id":"agent-child","result":"secret output"}',
      isError: false,
      startedAtMs: 1_000,
      endedAtMs: 1_250,
      durationMs: 250,
    }
    const redact = (text: string) => text.replaceAll('secret', '[REDACTED]')

    const response = {
      responseId: 'engine-response',
      turnNumber: 1,
      assistantText: '准备调用 secret tool',
      stopReason: 'tool_use' as const,
      toolCallsCount: 1,
      llmCallMs: 100,
      llmStartedAtMs: 800,
      usage: { inputTokens: 20, outputTokens: 10 },
    }
    recordEngineLlmResponse(traceStore, trace.trace_id, response, redact)
    recordEngineLlmResponse(traceStore, trace.trace_id, response, redact)

    recordEngineToolLifecycle(traceStore, trace.trace_id, started, redact)
    recordEngineToolLifecycle(traceStore, trace.trace_id, started, redact)
    expect(traceStore.getTrace(trace.trace_id)?.spans.map((span) => span.type)).toEqual(['llm_call', 'tool_call'])

    recordEngineToolLifecycle(traceStore, trace.trace_id, finished, redact)
    recordEngineToolLifecycle(traceStore, trace.trace_id, finished, redact)
    recordSubAgentTurn(traceStore, trace.trace_id, {
      responseId: 'engine-response',
      turnNumber: 1,
      assistantText: '准备调用 secret tool',
      toolCalls: [{
        callId: 'engine-call', id: 'provider-call', name: 'delegate_task', input: { path: '/secret/path' },
        output: '[12:34:56]\n{"agent_id":"agent-child","result":"secret output"}',
        isError: false, startedAtMs: 1_000, durationMs: 250,
      }],
      stopReason: 'tool_use',
      llmCallMs: 100,
      llmStartedAtMs: 800,
      usage: { inputTokens: 20, outputTokens: 10 },
    }, redact)

    const spans = traceStore.getTrace(trace.trace_id)?.spans ?? []
    expect(spans.map((span) => span.type)).toEqual(['llm_call', 'tool_call', 'tool_result'])
    expect(spans[0].details).toMatchObject({
      response_id: 'engine-response',
      assistant_text: '准备调用 [REDACTED] tool',
      stop_reason: 'tool_use',
    })
    expect(spans[1].parent_span_id).toBe(spans[0].span_id)
    expect(spans[1].details).toMatchObject({
      response_id: 'engine-response',
      call_id: 'engine-call', tool_use_id: 'provider-call', tool_name: 'delegate_task',
      input_summary: '{"path":"/[REDACTED]/path"}',
    })
    expect(spans[2].details).toMatchObject({
      response_id: 'engine-response',
      call_id: 'engine-call', tool_use_id: 'provider-call',
      output_summary: '[12:34:56]\n{"agent_id":"agent-child","result":"[REDACTED] output"}',
      subagent_id: 'agent-child',
    })
  })

  it('重启重建为已持久 call 追加唯一 interrupted result', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-tool-trace-restart-'))
    try {
      const first = new TraceStore(10, dir)
      const trace = first.startTrace({ module_id: 'test', trigger: { type: 'sub_agent_call', summary: 'test' } })
      recordEngineToolLifecycle(first, trace.trace_id, {
        type: 'tool_started', responseId: 'engine-response', callId: 'engine-call', turnNumber: 1, toolUseId: 'provider-call',
        name: 'Read', input: { path: 'a' }, startedAtMs: Date.now(),
      })
      ;(first as unknown as { flushInFlightTraces(): void }).flushInFlightTraces()
      first.stopFlushTimer()

      const rebuilt = new TraceStore(10, dir)
      const spans = rebuilt.getTrace(trace.trace_id)?.spans ?? []
      expect(spans.filter((span) => span.type === 'tool_call')).toHaveLength(1)
      expect(spans.filter((span) => span.type === 'tool_result')).toHaveLength(1)
      expect(spans.find((span) => span.type === 'tool_result')).toMatchObject({
        status: 'failed',
        details: { response_id: 'engine-response', call_id: 'engine-call', is_error: true, output_summary: '[interrupted: agent restarted]' },
      })
      rebuilt.stopFlushTimer()
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('persists the complete redacted assistant text for child trace projection', () => {
    const traceStore = new TraceStore(10)
    const trace = traceStore.startTrace({ module_id: 'test', trigger: { type: 'sub_agent_call', summary: 'test' } })
    const assistantText = `标题\n${'完整内容。'.repeat(80)}`

    recordSubAgentTurn(traceStore, trace.trace_id, {
      responseId: 'response-1',
      turnNumber: 1,
      assistantText: `${assistantText} secret-value`,
      toolCalls: [],
      stopReason: 'end_turn',
    }, (text) => text.replace('secret-value', '[REDACTED]'))

    const details = traceStore.getTrace(trace.trace_id)?.spans[0].details as Record<string, unknown>
    expect(details).toMatchObject({ stop_reason: 'end_turn', assistant_text: `${assistantText} [REDACTED]` })
    expect(String(details.assistant_text)).toHaveLength(assistantText.length + 11)
    expect(details).not.toHaveProperty('output_summary')
  })

  it('does not persist an assistant text field for whitespace-only turns', () => {
    const traceStore = new TraceStore(10)
    const trace = traceStore.startTrace({ module_id: 'test', trigger: { type: 'sub_agent_call', summary: 'test' } })

    recordSubAgentTurn(traceStore, trace.trace_id, {
      responseId: 'response-1',
      turnNumber: 1,
      assistantText: ' \n\t',
      toolCalls: [],
    })

    expect(traceStore.getTrace(trace.trace_id)?.spans[0].details).not.toHaveProperty('assistant_text')
  })
})
