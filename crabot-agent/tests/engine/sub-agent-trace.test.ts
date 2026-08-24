import { describe, expect, it, vi } from 'vitest'
import { recordSubAgentTurn } from '../../src/engine/sub-agent-trace.js'
import type { TraceStore } from '../../src/core/trace-store.js'

describe('recordSubAgentTurn', () => {
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
