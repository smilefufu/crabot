import { describe, expect, it, vi } from 'vitest'
import { callNonStreaming, type LLMAdapter } from '../../src/engine/llm-adapter-types.js'
import { TaggedVoiceOutput } from '../../src/manager/voice-output.js'

describe('voice streaming and irreversible delivery', () => {
  it('publishes only text_delta before response completion and never retries after committed audio text', async () => {
    const events: string[] = []
    const output = new TaggedVoiceOutput({ isVoice: () => true, save: () => {}, records: () => [], send: async ({ event }) => {
      events.push(event.type); return { accepted: true }
    } }, () => ({ channel_id: 'voice', session_id: 'group', turn_id: 'turn', connection_epoch: 'epoch', expires_at: new Date(Date.now() + 60000).toISOString() }), () => {})
    const stream = vi.fn(async function* () {
      yield { type: 'message_start' as const, messageId: 'fixture' }
      yield { type: 'raw_reasoning' as const, data: { text: '<voice_reply>不要播出推理。</voice_reply>' } }
      yield { type: 'tool_use_start' as const, id: 'tool', name: 'send_message' }
      yield { type: 'tool_use_delta' as const, id: 'tool', inputJson: '{"content":"<voice_reply>不要播出参数。</voice_reply>"' }
      expect(events).toEqual([])
      yield { type: 'text_delta' as const, text: '<voice_reply>你好。' }
      expect(events).toEqual(['reply_start', 'reply_text'])
      throw new Error('fetch failed')
    })
    const adapter: LLMAdapter = { stream, updateConfig: () => {} }
    await expect(callNonStreaming(adapter, { model: 'fixture', systemPrompt: 'fixture', messages: [], tools: [], createTextConsumer: () => output.consumer() })).rejects.toThrow('fetch failed')
    expect(stream).toHaveBeenCalledTimes(1); expect(events).toEqual(['reply_start', 'reply_text', 'reply_cancel'])
  })
  it('retries before nonempty external text and cancels the abandoned empty tag', async () => {
    vi.useFakeTimers()
    try {
      const events: string[] = []
      const output = new TaggedVoiceOutput({ isVoice: () => true, save: () => {}, records: () => [], send: async ({ event }) => {
        events.push(event.type)
        return event.type === 'reply_end' ? { platform_message_id: event.playback_id, sent_at: new Date().toISOString(), played_samples: 480 } : { accepted: true }
      } }, () => ({ channel_id: 'voice', session_id: 'group', turn_id: 'turn', connection_epoch: 'epoch', expires_at: new Date(Date.now() + 60000).toISOString() }), () => {})
      let attempts = 0
      const adapter: LLMAdapter = { updateConfig: () => {}, async *stream() {
        yield { type: 'message_start', messageId: 'fixture' }
        if (++attempts === 1) { yield { type: 'text_delta', text: '<voice_reply>' }; throw Object.assign(new Error('retryable fixture'), { code: 'ETIMEDOUT' }) }
        yield { type: 'text_delta', text: '<voice_reply>完成。</voice_reply>' }
        yield { type: 'message_end', stopReason: 'end_turn' }
      } }
      const result = callNonStreaming(adapter, { model: 'fixture', systemPrompt: 'fixture', messages: [], tools: [], createTextConsumer: () => output.consumer() })
      await vi.runAllTimersAsync()
      expect((await result).stopReason).toBe('end_turn'); expect(attempts).toBe(2)
      expect(events).toEqual(['reply_start', 'reply_cancel', 'reply_start', 'reply_text', 'reply_end'])
    } finally { vi.useRealTimers() }
  })

})
