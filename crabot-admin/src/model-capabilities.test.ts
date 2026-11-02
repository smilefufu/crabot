import { describe, expect, it } from 'vitest'
import { fillModelCapabilities, preserveModelSettings } from './model-capabilities.js'
import type { ModelInfo } from './types.js'

const model = (id: string, extra: Partial<ModelInfo> = {}): ModelInfo => ({ model_id: id, display_name: id, type: 'llm', ...extra })
const openai = { endpoint: 'https://api.openai.com/v1', format: 'openai' }

describe('model capability defaults', () => {
  it('fills exact API models without conflating context with output budget', () => {
    expect(fillModelCapabilities(model('gpt-5.2'), openai)).toMatchObject({ supports_vision: true, context_window: 400000 })
    expect(fillModelCapabilities(model('gpt-5.4'), openai)).toMatchObject({ supports_vision: true, context_window: 1050000 })
    expect(fillModelCapabilities(model('gpt-4o'), openai)).not.toHaveProperty('max_tokens')
  })
  it('retains explicit false and saved context limits', () => {
    expect(fillModelCapabilities(model('gpt-5.2', { supports_vision: false, context_window: 32000, max_tokens: 4000 }), openai))
      .toMatchObject({ supports_vision: false, context_window: 32000, max_tokens: 4000 })
  })
  it('does not guess unknown series, subscription or gateway limits', () => {
    for (const [id, connection] of [
      ['gpt-future', openai], ['gpt-5.2', { endpoint: 'https://chatgpt.com/backend-api/codex', format: 'openai-responses' }],
      ['gpt-5.2', { ...openai, endpoint: 'https://gateway.example/v1' }],
      ['glm-5.2', { format: 'anthropic', endpoint: 'https://open.bigmodel.cn/api/anthropic' }],
    ] as const) expect(fillModelCapabilities(model(id), connection)).not.toHaveProperty('context_window')
  })
  it('distinguishes text and vision GLM models and Kimi K3', () => {
    const glm = { endpoint: 'https://open.bigmodel.cn/api/paas/v4', format: 'openai' }
    expect(fillModelCapabilities(model('glm-5.2'), glm)).toMatchObject({ supports_vision: false, context_window: 1000000 })
    expect(fillModelCapabilities(model('glm-4.6v'), glm)).toMatchObject({ supports_vision: true, context_window: 128000 })
    expect(fillModelCapabilities(model('kimi-k3'), { ...openai, endpoint: 'https://api.moonshot.cn/v1' }))
      .toMatchObject({ supports_vision: true, context_window: 1000000 })
  })
  it('preserves saved capabilities and budget on refresh without restoring removed models', () => {
    const previous = [model('a', { supports_vision: false, context_window: 8000, max_tokens: 1000 }), model('removed')]
    const fresh = [model('a', { supports_vision: true, context_window: 1000000 }), model('new')]
    expect(preserveModelSettings(fresh, previous)).toEqual([model('a', { supports_vision: false, context_window: 8000, max_tokens: 1000 }), model('new')])
    expect(fresh[0].supports_vision).toBe(true)
  })
})
