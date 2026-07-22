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

  it('maps kimi coding /v1/models shape: display_name, context_length, supports_image_in', () => {
    // 实测 https://api.kimi.com/coding/v1/models 的返回结构（2026-07-21）
    const models = parseOpenAIModels([
      {
        id: 'kimi-for-coding',
        display_name: 'K2.7 Coding',
        context_length: 262144,
        supports_image_in: true,
        supports_reasoning: true,
      },
      {
        id: 'k3',
        display_name: 'K3',
        context_length: 1048576,
        supports_image_in: true,
      },
    ])
    expect(models).toHaveLength(2)
    const k27 = models.find((m) => m.model_id === 'kimi-for-coding')!
    expect(k27.display_name).toBe('K2.7 Coding')
    expect(k27.type).toBe('llm')
    expect(k27.supports_vision).toBe(true)
    expect(k27.context_window).toBe(262144)
    expect(models.find((m) => m.model_id === 'k3')?.context_window).toBe(1048576)
  })
})
