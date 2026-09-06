import { describe, expect, it, vi } from 'vitest'
import { UnifiedAgent } from '../../src/unified-agent.js'
import { TraceStore } from '../../src/core/trace-store.js'
import type { BuiltinTraceHooks } from '../../src/workers/builtin/adapter.js'

type BuiltinTraceHookFactory = {
  builtinTraceHooks(): BuiltinTraceHooks
}

describe('UnifiedAgent builtin trace hooks', () => {
  it('记录 fork 的 Manager 输入为脱敏后的 user message', () => {
    const traceStore = {
      startTrace: vi.fn(() => ({ trace_id: 'trace-fork' })),
      startSpan: vi.fn(() => ({ span_id: 'input-span' })),
      endSpan: vi.fn(),
    }
    const hooks = (UnifiedAgent.prototype as unknown as BuiltinTraceHookFactory).builtinTraceHooks.call({
      traceStore,
      knownSecrets: new Set(['secret-value']),
      config: { moduleId: 'agent-test' },
    })

    expect(hooks.startIncarnationTrace({
      worker_id: 'worker-1',
      seq: 2,
      summary: 'worker-1#2 (fork)',
      initial_input: '当前进度如何？secret-value',
    })).toBe('trace-fork')

    expect(traceStore.startSpan).toHaveBeenCalledWith('trace-fork', expect.objectContaining({
      type: 'context_assembly',
      details: {
        context_type: 'worker',
        message_batch: [{
          sender: 'manager',
          text: '当前进度如何？[REDACTED]',
          is_mention_crab: false,
        }],
      },
    }))
    expect(traceStore.endSpan).toHaveBeenCalledWith('trace-fork', 'input-span', 'completed')
  })

  it('持久化脱敏后的非空 assistant text，空文本不写字段', () => {
    const traceStore = new TraceStore(10)
    const trace = traceStore.startTrace({
      module_id: 'agent-test',
      trigger: { type: 'sub_agent_call', summary: 'test' },
    })
    const hooks = (UnifiedAgent.prototype as unknown as BuiltinTraceHookFactory).builtinTraceHooks.call({
      traceStore,
      knownSecrets: new Set(['secret-value']),
      config: { moduleId: 'agent-test' },
    })

    hooks.appendTurn(trace.trace_id, {
      responseId: 'response-1',
      turnNumber: 1,
      assistantText: '结果包含 secret-value。',
      stopReason: 'end_turn',
      toolCalls: [],
      llmStartedAtMs: 100,
      llmCallMs: 50,
    })
    hooks.appendTurn(trace.trace_id, {
      responseId: 'response-2',
      turnNumber: 2,
      assistantText: ' \n ',
      stopReason: 'tool_use',
      toolCalls: [],
    })

    const spans = traceStore.getTrace(trace.trace_id)?.spans ?? []
    expect(spans[0]).toMatchObject({
      type: 'llm_call',
      details: { assistant_text: '结果包含 [REDACTED]。', stop_reason: 'end_turn' },
      started_at: new Date(100).toISOString(),
      ended_at: new Date(150).toISOString(),
    })
    expect(spans[1].details).not.toHaveProperty('assistant_text')
  })
})
