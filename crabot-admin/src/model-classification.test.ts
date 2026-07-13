import { describe, it, expect } from 'vitest'
import { classifyModelType, isNonChatModel, parseOpenAIModels } from './model-provider-manager'

describe('classifyModelType', () => {
  it('classifies image generation models as image', () => {
    expect(classifyModelType('gpt-image-1')).toBe('image')
    expect(classifyModelType('dall-e-3')).toBe('image')
  })
  it('classifies chat models as llm', () => {
    expect(classifyModelType('gpt-4o')).toBe('llm')
    expect(classifyModelType('claude-sonnet-4-6')).toBe('llm')
  })
})

describe('isNonChatModel', () => {
  it('flags embedding/whisper/tts/moderation', () => {
    expect(isNonChatModel('text-embedding-3-large')).toBe(true)
    expect(isNonChatModel('whisper-1')).toBe(true)
    expect(isNonChatModel('gpt-4o')).toBe(false)
    expect(isNonChatModel('gpt-image-1')).toBe(false)
  })
})

describe('parseOpenAIModels', () => {
  it('keeps image models with type image, excludes embeddings', () => {
    const models = parseOpenAIModels([
      { id: 'gpt-4o' },
      { id: 'gpt-image-1' },
      { id: 'text-embedding-3-large' },
    ])
    const ids = models.map((m) => m.model_id)
    expect(ids).toContain('gpt-4o')
    expect(ids).toContain('gpt-image-1')
    expect(ids).not.toContain('text-embedding-3-large')
    expect(models.find((m) => m.model_id === 'gpt-image-1')?.type).toBe('image')
    expect(models.find((m) => m.model_id === 'gpt-4o')?.type).toBe('llm')
  })
})
