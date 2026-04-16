import { describe, it, expect, beforeEach } from 'vitest'
import { StreamProcessor, type ProcessedResponse } from '../../src/engine/stream-processor'
import type { StreamChunk, ToolUseBlock } from '../../src/engine/types'

describe('StreamProcessor', () => {
  let processor: StreamProcessor

  beforeEach(() => {
    processor = new StreamProcessor()
  })

  describe('text accumulation', () => {
    it('should accumulate text_delta chunks into a single text string', () => {
      processor.process({ type: 'text_delta', text: 'Hello' })
      processor.process({ type: 'text_delta', text: ', ' })
      processor.process({ type: 'text_delta', text: 'world!' })

      const result = processor.finalize()

      expect(result.text).toBe('Hello, world!')
      expect(result.toolUseBlocks).toHaveLength(0)
      expect(result.stopReason).toBeNull()
    })

    it('should return empty text when no text_delta chunks are received', () => {
      const result = processor.finalize()

      expect(result.text).toBe('')
    })
  })

  describe('single tool_use extraction', () => {
    it('should extract a complete tool_use block with parsed JSON input', () => {
      processor.process({ type: 'tool_use_start', id: 'tu_001', name: 'search' })
      processor.process({ type: 'tool_use_delta', id: 'tu_001', inputJson: '{"qu' })
      processor.process({ type: 'tool_use_delta', id: 'tu_001', inputJson: 'ery":' })
      processor.process({ type: 'tool_use_delta', id: 'tu_001', inputJson: ' "hello"}' })
      processor.process({ type: 'tool_use_end', id: 'tu_001' })

      const result = processor.finalize()

      expect(result.toolUseBlocks).toHaveLength(1)
      expect(result.toolUseBlocks[0]).toEqual({
        type: 'tool_use',
        id: 'tu_001',
        name: 'search',
        input: { query: 'hello' },
      })
    })

    it('should handle tool_use with empty JSON input', () => {
      processor.process({ type: 'tool_use_start', id: 'tu_002', name: 'get_status' })
      processor.process({ type: 'tool_use_delta', id: 'tu_002', inputJson: '{}' })
      processor.process({ type: 'tool_use_end', id: 'tu_002' })

      const result = processor.finalize()

      expect(result.toolUseBlocks).toHaveLength(1)
      expect(result.toolUseBlocks[0].input).toEqual({})
    })
  })

  describe('multiple tool_use blocks', () => {
    it('should capture multiple tool_use blocks interleaved with text', () => {
      processor.process({ type: 'text_delta', text: 'Let me search.' })
      processor.process({ type: 'tool_use_start', id: 'tu_010', name: 'search' })
      processor.process({ type: 'tool_use_delta', id: 'tu_010', inputJson: '{"q":"a"}' })
      processor.process({ type: 'tool_use_end', id: 'tu_010' })
      processor.process({ type: 'tool_use_start', id: 'tu_011', name: 'read_file' })
      processor.process({ type: 'tool_use_delta', id: 'tu_011', inputJson: '{"path":"/tmp/f"}' })
      processor.process({ type: 'tool_use_end', id: 'tu_011' })

      const result = processor.finalize()

      expect(result.text).toBe('Let me search.')
      expect(result.toolUseBlocks).toHaveLength(2)
      expect(result.toolUseBlocks[0].name).toBe('search')
      expect(result.toolUseBlocks[0].input).toEqual({ q: 'a' })
      expect(result.toolUseBlocks[1].name).toBe('read_file')
      expect(result.toolUseBlocks[1].input).toEqual({ path: '/tmp/f' })
    })
  })

  describe('malformed JSON fallback', () => {
    it('should use jsonrepair for slightly malformed JSON', () => {
      processor.process({ type: 'tool_use_start', id: 'tu_020', name: 'tool_a' })
      // Missing closing brace — jsonrepair can fix this
      processor.process({ type: 'tool_use_delta', id: 'tu_020', inputJson: '{"key": "value"' })
      processor.process({ type: 'tool_use_end', id: 'tu_020' })

      const result = processor.finalize()

      expect(result.toolUseBlocks).toHaveLength(1)
      expect(result.toolUseBlocks[0].input).toEqual({ key: 'value' })
    })

    it('should fall back to _raw when JSON is completely unparseable', () => {
      processor.process({ type: 'tool_use_start', id: 'tu_021', name: 'tool_b' })
      processor.process({ type: 'tool_use_delta', id: 'tu_021', inputJson: '<<<not json at all>>>' })
      processor.process({ type: 'tool_use_end', id: 'tu_021' })

      const result = processor.finalize()

      expect(result.toolUseBlocks).toHaveLength(1)
      expect(result.toolUseBlocks[0].input).toEqual({ _raw: '<<<not json at all>>>' })
    })

    it('should handle empty input JSON string', () => {
      processor.process({ type: 'tool_use_start', id: 'tu_022', name: 'tool_c' })
      processor.process({ type: 'tool_use_end', id: 'tu_022' })

      const result = processor.finalize()

      expect(result.toolUseBlocks).toHaveLength(1)
      expect(result.toolUseBlocks[0].input).toEqual({})
    })
  })

  describe('usage tracking', () => {
    it('should capture stopReason and usage from message_end', () => {
      processor.process({ type: 'text_delta', text: 'Done.' })
      processor.process({
        type: 'message_end',
        stopReason: 'end_turn',
        usage: { inputTokens: 150, outputTokens: 42 },
      })

      const result = processor.finalize()

      expect(result.stopReason).toBe('end_turn')
      expect(result.usage).toEqual({ inputTokens: 150, outputTokens: 42 })
    })

    it('should capture stopReason without usage', () => {
      processor.process({
        type: 'message_end',
        stopReason: 'tool_use',
      })

      const result = processor.finalize()

      expect(result.stopReason).toBe('tool_use')
      expect(result.usage).toBeUndefined()
    })

    it('should capture null stopReason', () => {
      processor.process({
        type: 'message_end',
        stopReason: null,
      })

      const result = processor.finalize()

      expect(result.stopReason).toBeNull()
    })
  })

  describe('reset', () => {
    it('should clear all accumulated state', () => {
      processor.process({ type: 'text_delta', text: 'Some text' })
      processor.process({ type: 'tool_use_start', id: 'tu_030', name: 'tool_x' })
      processor.process({ type: 'tool_use_delta', id: 'tu_030', inputJson: '{"a":1}' })
      processor.process({ type: 'tool_use_end', id: 'tu_030' })
      processor.process({
        type: 'message_end',
        stopReason: 'end_turn',
        usage: { inputTokens: 100, outputTokens: 50 },
      })

      processor.reset()
      const result = processor.finalize()

      expect(result.text).toBe('')
      expect(result.toolUseBlocks).toHaveLength(0)
      expect(result.stopReason).toBeNull()
      expect(result.usage).toBeUndefined()
    })

    it('should allow re-use after reset', () => {
      processor.process({ type: 'text_delta', text: 'First' })
      processor.reset()

      processor.process({ type: 'text_delta', text: 'Second' })
      const result = processor.finalize()

      expect(result.text).toBe('Second')
    })
  })
})
