import { describe, it, expect } from 'vitest'
import { assertToolMessageIntegrity, completeToolUseMessages } from '../../src/engine/tool-message-integrity.js'
import { normalizeMessagesForOpenAI } from '../../src/engine/openai-adapter.js'
import { normalizeMessagesForResponses } from '../../src/engine/openai-responses-adapter.js'
import { normalizeMessagesForAnthropic } from '../../src/engine/anthropic-adapter.js'
import { createAssistantMessage, createBatchToolResultMessage, createUserMessage } from '../../src/engine/types.js'

const call = (id: string) => createAssistantMessage([{ type: 'tool_use', id, name: 'Read', input: {} }], 'tool_use')
const result = (id: string) => createBatchToolResultMessage([{ tool_use_id: id, content: 'actual output', is_error: false }])

describe('complete tool history integrity', () => {
  it('keeps a valid complete history and all original message objects', () => {
    const original = [createUserMessage('task'), call('a'), result('a'), createUserMessage('next')]
    expect(() => assertToolMessageIntegrity(original)).not.toThrow()
    const complete = completeToolUseMessages(original)
    expect(complete).toEqual(original)
    expect(complete.every((message, index) => message === original[index])).toBe(true)
  })

  it('closes several missing historical batches before their subsequent messages', () => {
    const original = [call('a'), createUserMessage('next'), call('b')]
    expect(() => assertToolMessageIntegrity(original)).toThrow('missing tool_result a')
    const completed = completeToolUseMessages(original)
    expect(() => assertToolMessageIntegrity(completed)).not.toThrow()
    expect(completed.filter(message => 'toolResults' in message).flatMap(message => 'toolResults' in message ? message.toolResults : []))
      .toEqual(['a', 'b'].map(tool_use_id => expect.objectContaining({ tool_use_id, is_error: true, content: expect.stringContaining('unknown') })))
    expect(original).toHaveLength(3)
    expect(completeToolUseMessages(completed)).toEqual(completed)
  })


  it('keeps known images and missing outputs in one batch for all provider projections', () => {
    const assistant = createAssistantMessage([
      { type: 'tool_use', id: 'known', name: 'Read', input: {} },
      { type: 'tool_use', id: 'missing', name: 'Read', input: {} },
    ], 'tool_use')
    const existing = createBatchToolResultMessage([{ tool_use_id: 'known', content: 'actual', is_error: false,
      images: [{ media_type: 'image/png', data: 'pixel' }] }])
    const completed = completeToolUseMessages([assistant, existing])
    expect(() => assertToolMessageIntegrity(completed)).not.toThrow()
    const openai = normalizeMessagesForOpenAI(completed)
    expect(openai.slice(1, 3).map(message => message.role)).toEqual(['tool', 'tool'])
    expect(openai[3]).toMatchObject({ role: 'user', content: expect.arrayContaining([expect.objectContaining({ type: 'image_url' })]) })
    const responses = normalizeMessagesForResponses(completed)
    expect(responses.filter(item => item.type === 'function_call_output').map(item => item.call_id)).toEqual(['known', 'missing'])
    const imageIndex = responses.findIndex(item => item.role === 'user')
    expect(responses.slice(0, imageIndex).filter(item => item.type === 'function_call_output')).toHaveLength(2)
    const anthropic = normalizeMessagesForAnthropic(completed)
    expect(anthropic[1]).toMatchObject({ role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'known', is_error: false },
      { type: 'tool_result', tool_use_id: 'missing', is_error: true },
    ] })
    expect(completed[1].id).toBe(existing.id)
    expect(existing.toolResults).toHaveLength(1)
  })

  it.each([
    { name: 'duplicate call', messages: [call('a'), result('a'), call('a')], error: 'duplicate' },
    { name: 'duplicate result', messages: [call('a'), result('a'), result('a')], error: 'duplicate' },
    { name: 'result without call', messages: [result('a')], error: 'unmatched' },
    { name: 'result before call', messages: [result('a'), call('a')], error: 'unmatched' },
    { name: 'result after subsequent input', messages: [call('a'), createUserMessage('next'), result('a')], error: 'out-of-order' },
    { name: 'result belonging to another group', messages: [call('a'), call('b'), result('a'), result('b')], error: 'out-of-order' },
  ])('rejects ambiguous history: $name', ({ messages, error }) => {
    expect(() => completeToolUseMessages(messages)).toThrow(error)
    expect(() => assertToolMessageIntegrity(messages)).toThrow(error)
  })
})
