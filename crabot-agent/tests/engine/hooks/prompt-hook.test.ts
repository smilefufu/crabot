import { describe, it, expect } from 'vitest'
import { runPromptHook } from '../../../src/hooks/prompt-hook'
import type { HookInput } from '../../../src/hooks/types'
import type { LLMAdapter } from '../../../src/engine/llm-adapter-types'
import type { StreamChunk } from '../../../src/engine/types'

function mockAdapter(responseText: string): LLMAdapter {
  return {
    async *stream() {
      yield { type: 'message_start' as const, messageId: 'msg-1' }
      yield { type: 'text_delta' as const, text: responseText }
      yield { type: 'message_end' as const, stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 5 } }
    },
    updateConfig() {},
  }
}

const baseInput: HookInput = {
  event: 'Stop',
  workingDirectory: '/tmp',
}

describe('runPromptHook', () => {
  it('parses JSON response with action block', async () => {
    const adapter = mockAdapter('{"action":"block","message":"tests are failing"}')
    const result = await runPromptHook({
      prompt: 'Check: $INPUT',
      input: baseInput,
      adapter,
      model: 'test-model',
    })
    expect(result.action).toBe('block')
    expect(result.message).toBe('tests are failing')
  })

  it('returns continue when LLM says continue', async () => {
    const adapter = mockAdapter('{"action":"continue"}')
    const result = await runPromptHook({
      prompt: 'Check: $INPUT',
      input: baseInput,
      adapter,
      model: 'test-model',
    })
    expect(result.action).toBe('continue')
  })

  it('returns continue with raw text on unparseable response', async () => {
    const adapter = mockAdapter('I think everything is fine')
    const result = await runPromptHook({
      prompt: 'Check: $INPUT',
      input: baseInput,
      adapter,
      model: 'test-model',
    })
    expect(result.action).toBe('continue')
    expect(result.message).toContain('everything is fine')
  })

  it('substitutes $INPUT in prompt template', async () => {
    let capturedMessages: unknown
    const adapter: LLMAdapter = {
      async *stream(params) {
        capturedMessages = params.messages
        yield { type: 'message_start' as const, messageId: 'msg-1' }
        yield { type: 'text_delta' as const, text: '{"action":"continue"}' }
        yield { type: 'message_end' as const, stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 5 } }
      },
      updateConfig() {},
    }

    await runPromptHook({
      prompt: 'Analyze: $INPUT',
      input: { event: 'Stop', workingDirectory: '/project' },
      adapter,
      model: 'test-model',
    })

    const msgs = capturedMessages as Array<{ content: string }>
    expect(msgs[0].content).toContain('/project')
  })
})
