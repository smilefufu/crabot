import { describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { recordEngineToolLifecycle, recordSubAgentTurn } from '../../src/engine/sub-agent-trace.js'
import { TraceStore } from '../../src/core/trace-store.js'

describe('recordSubAgentTurn', () => {
  it('生命周期按 call_id 追加 call/result，onTurn 只补漏且重复回调幂等', () => {
    const traceStore = new TraceStore(10)
    const trace = traceStore.startTrace({ module_id: 'test', trigger: { type: 'sub_agent_call', summary: 'test' } })
    const started = {
      type: 'tool_started' as const,
      callId: 'engine-call',
      turnNumber: 1,
      toolUseId: 'provider-call',
      name: 'delegate_task',
      input: { path: '/secret/path' },
      startedAtMs: 1_000,
    }
    const finished = {
      type: 'tool_finished' as const,
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

    recordEngineToolLifecycle(traceStore, trace.trace_id, started, redact)
    recordEngineToolLifecycle(traceStore, trace.trace_id, started, redact)
    expect(traceStore.getTrace(trace.trace_id)?.spans.map((span) => span.type)).toEqual(['tool_call'])

    recordEngineToolLifecycle(traceStore, trace.trace_id, finished, redact)
    recordEngineToolLifecycle(traceStore, trace.trace_id, finished, redact)
    recordSubAgentTurn(traceStore, trace.trace_id, {
      turnNumber: 1,
      assistantText: '',
      toolCalls: [{
        callId: 'engine-call', id: 'provider-call', name: 'delegate_task', input: { path: '/secret/path' },
        output: '[12:34:56]\n{"agent_id":"agent-child","result":"secret output"}',
        isError: false, startedAtMs: 1_000, durationMs: 250,
      }],
      stopReason: 'tool_use',
    }, redact)

    const spans = traceStore.getTrace(trace.trace_id)?.spans ?? []
    expect(spans.map((span) => span.type)).toEqual(['tool_call', 'tool_result', 'llm_call'])
    expect(spans[0].details).toMatchObject({
      call_id: 'engine-call', tool_use_id: 'provider-call', tool_name: 'delegate_task',
      input_summary: '{"path":"/[REDACTED]/path"}',
    })
    expect(spans[1].details).toMatchObject({
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
        type: 'tool_started', callId: 'engine-call', turnNumber: 1, toolUseId: 'provider-call',
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
        details: { call_id: 'engine-call', is_error: true, output_summary: '[interrupted: agent restarted]' },
      })
      rebuilt.stopFlushTimer()
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('persists the complete redacted assistant text for child trace projection', () => {
    const traceStore = {
      startSpan: vi.fn(() => ({ span_id: 'llm-1' })),
      endSpan: vi.fn(),
    } as unknown as TraceStore
    const assistantText = `标题\n${'完整内容。'.repeat(80)}`

    recordSubAgentTurn(traceStore, 'trace-1', {
      turnNumber: 1,
      assistantText: `${assistantText} secret-value`,
      toolCalls: [],
      stopReason: 'end_turn',
    }, (text) => text.replace('secret-value', '[REDACTED]'))

    const endDetails = traceStore.endSpan.mock.calls[0][3] as Record<string, unknown>
    expect(endDetails).toMatchObject({ stop_reason: 'end_turn', assistant_text: `${assistantText} [REDACTED]` })
    expect(String(endDetails.assistant_text)).toHaveLength(assistantText.length + 11)
    expect(endDetails).not.toHaveProperty('output_summary')
  })

  it('does not persist an assistant text field for whitespace-only turns', () => {
    const traceStore = {
      startSpan: vi.fn(() => ({ span_id: 'llm-1' })),
      endSpan: vi.fn(),
    } as unknown as TraceStore

    recordSubAgentTurn(traceStore, 'trace-1', {
      turnNumber: 1,
      assistantText: ' \n\t',
      toolCalls: [],
    })

    expect(traceStore.endSpan.mock.calls[0][3]).not.toHaveProperty('assistant_text')
  })
})
