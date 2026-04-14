import { describe, it, expect } from 'vitest'
import { runPromptHook } from '../../../src/hooks/prompt-hook'
import type { LLMAdapter } from '../../../src/engine/llm-adapter'
import type { StreamChunk } from '../../../src/engine/types'
import type { HookInput } from '../../../src/hooks/types'

// --- Test Helpers ---

function mockAdapter(text: string): LLMAdapter {
  return {
    async *stream() {
      const chunks: StreamChunk[] = [
        { type: 'message_start', messageId: 'msg-1' },
        { type: 'text_delta', text },
        { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 5 } },
      ]
      for (const chunk of chunks) {
        yield chunk
      }
    },
    updateConfig() {},
  }
}

function baseInput(overrides: Partial<HookInput> = {}): HookInput {
  return {
    event: 'PreToolUse',
    toolName: 'Write',
    filePaths: ['/tmp/test.ts'],
    toolInput: { content: 'const x = 1' },
    workingDirectory: '/tmp',
    ...overrides,
  }
}

// --- Tests ---

describe('runPromptHook', () => {
  it('returns block when LLM responds with action:block', async () => {
    const adapter = mockAdapter('{"action":"block","message":"tests are failing"}')

    const result = await runPromptHook({
      prompt: 'Check code quality. Input: $INPUT',
      input: baseInput(),
      adapter,
      model: 'test-model',
    })

    expect(result.action).toBe('block')
    expect(result.message).toBe('tests are failing')
  })

  it('returns continue when LLM responds with action:continue', async () => {
    const adapter = mockAdapter('{"action":"continue"}')

    const result = await runPromptHook({
      prompt: 'Check code quality. Input: $INPUT',
      input: baseInput(),
      adapter,
      model: 'test-model',
    })

    expect(result.action).toBe('continue')
  })

  it('returns continue when LLM returns non-JSON text', async () => {
    const adapter = mockAdapter('I think everything is fine, proceed.')

    const result = await runPromptHook({
      prompt: 'Check quality. Input: $INPUT',
      input: baseInput(),
      adapter,
      model: 'test-model',
    })

    expect(result.action).toBe('continue')
    expect(result.message).toBe('I think everything is fine, proceed.')
  })

  it('replaces $INPUT with JSON-serialized hook input', async () => {
    const capturedParams: unknown[] = []

    const adapter: LLMAdapter = {
      async *stream(params) {
        capturedParams.push(params)
        yield { type: 'message_start', messageId: 'msg-1' }
        yield { type: 'text_delta', text: '{"action":"continue"}' }
        yield { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 5 } }
      },
      updateConfig() {},
    }

    const input = baseInput({ toolName: 'Bash', toolInput: { command: 'ls' } })

    await runPromptHook({
      prompt: 'Evaluate: $INPUT',
      input,
      adapter,
      model: 'test-model',
    })

    expect(capturedParams).toHaveLength(1)
    const params = capturedParams[0] as { messages: Array<{ content: string | unknown[] }> }
    const userMessageContent = params.messages[0].content
    const contentText =
      typeof userMessageContent === 'string'
        ? userMessageContent
        : JSON.stringify(userMessageContent)

    expect(contentText).toContain('Bash')
    expect(contentText).not.toContain('$INPUT')
  })

  it('returns continue with no message when LLM returns empty response', async () => {
    const adapter = mockAdapter('')

    const result = await runPromptHook({
      prompt: 'Check: $INPUT',
      input: baseInput(),
      adapter,
      model: 'test-model',
    })

    expect(result.action).toBe('continue')
  })
})
