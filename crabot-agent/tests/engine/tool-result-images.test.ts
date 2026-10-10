import { describe, expect, it } from 'vitest'
import { normalizeMessagesForOpenAI } from '../../src/engine/openai-adapter.js'
import { normalizeMessagesForResponses } from '../../src/engine/openai-responses-adapter.js'
import { createAssistantMessage, createBatchToolResultMessage, createUserMessage } from '../../src/engine/types.js'

for (const [format, normalize, imageType] of [
  ['openai', normalizeMessagesForOpenAI, 'image_url'],
  ['responses', normalizeMessagesForResponses, 'input_image'],
] as const) {
  describe(`${format} tool result images`, () => {
    it.each(['[Image: screenshot.png, 79240 bytes]', ''])('keeps pixels after all batch outputs, including output %j', (text) => {
      const assistant = createAssistantMessage([
        { type: 'tool_use', id: 'call_read', name: 'Read', input: {} },
        { type: 'tool_use', id: 'call_other', name: 'Read', input: {} },
      ], 'tool_use')
      const results = createBatchToolResultMessage([
        { tool_use_id: 'call_read', content: text, is_error: false,
          images: [{ media_type: 'image/jpeg', data: 'jpeg-pixels' }, { media_type: 'image/png', data: 'png-pixels' }] },
        { tool_use_id: 'call_other', content: 'partial', is_error: true,
          images: [{ media_type: 'image/webp', data: 'webp-pixels' }] },
      ])
      const original = JSON.stringify([assistant, results])
      const normalized = normalize([assistant, results]) as Array<Record<string, any>>
      const outputs = normalized.filter(message => message.role === 'tool' || message.type === 'function_call_output')
      expect(outputs.map(message => message.tool_call_id ?? message.call_id)).toEqual(['call_read', 'call_other'])
      expect(outputs[0].content ?? outputs[0].output).toBe(text)
      const imagesMessage = normalized.find(message => message.role === 'user')!
      expect(normalized.indexOf(imagesMessage)).toBeGreaterThan(normalized.indexOf(outputs[1]))
      const images = imagesMessage.content.filter((part: any) => part.type === imageType)
      expect(images.map((part: any) => part.image_url.url ?? part.image_url)).toEqual([
        'data:image/jpeg;base64,jpeg-pixels', 'data:image/png;base64,png-pixels', 'data:image/webp;base64,webp-pixels',
      ])
      expect(JSON.stringify([assistant, results])).toBe(original)
    })

    it('retains text-only outputs without adding an image message', () => {
      const normalized = normalize([createBatchToolResultMessage([
        { tool_use_id: 'call_read', content: 'text', is_error: false, images: [] },
      ])])
      expect(normalized).toHaveLength(1)
    })

    it('keeps encoded Responses call IDs and subsequent human input', () => {
      const normalized = normalize([
        createAssistantMessage([{ type: 'tool_use', id: 'call_read|fc_read', name: 'Read', input: {} }], 'tool_use'),
        createBatchToolResultMessage([{ tool_use_id: 'call_read|fc_read', content: '', is_error: false,
          images: [{ media_type: 'image/png', data: 'pixels' }] }]),
        createUserMessage('new human input'),
      ])
      expect(JSON.stringify(normalized)).toContain('new human input')
      expect(JSON.stringify(normalized)).toContain('data:image/png;base64,pixels')
      if (format === 'responses') expect(normalized[1]).toMatchObject({ call_id: 'call_read' })
    })
  })
}
