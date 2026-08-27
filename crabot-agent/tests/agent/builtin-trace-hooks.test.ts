import { describe, expect, it, vi } from 'vitest'
import { UnifiedAgent } from '../../src/unified-agent.js'
import type { EngineTurnEvent } from '../../src/engine/types.js'
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
    const traceStore = {
      startSpan: vi.fn(() => ({ span_id: 'span-1' })),
      endSpan: vi.fn(),
    }
    const hooks = (UnifiedAgent.prototype as unknown as BuiltinTraceHookFactory).builtinTraceHooks.call({
      traceStore,
      knownSecrets: new Set(['secret-value']),
      config: { moduleId: 'agent-test' },
    })

    hooks.appendTurn('trace-1', {
      assistantText: '结果包含 secret-value。',
      stopReason: 'end_turn',
      toolCalls: [],
      llmStartedAtMs: 100,
      llmCallMs: 50,
    } as EngineTurnEvent)
    hooks.appendTurn('trace-1', {
      assistantText: ' \n ',
      stopReason: 'tool_use',
      toolCalls: [],
    } as EngineTurnEvent)

    expect(traceStore.startSpan.mock.calls[0][1]).toMatchObject({
      type: 'llm_call',
      details: { assistant_text: '结果包含 [REDACTED]。', stop_reason: 'end_turn' },
      started_at_ms: 100,
    })
    expect(traceStore.endSpan).toHaveBeenCalledWith('trace-1', 'span-1', 'completed', undefined, 150)
    expect(traceStore.startSpan.mock.calls[1][1].details).not.toHaveProperty('assistant_text')
  })
})
