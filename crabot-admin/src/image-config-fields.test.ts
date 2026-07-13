import { describe, it, expect } from 'vitest'
import { imageResultToConfigFields } from './model-provider-manager'
import type { LLMConnectionInfo } from './types'

describe('imageResultToConfigFields', () => {
  it('maps available result to image_config + available capability', () => {
    const config = { endpoint: 'e', apikey: 'k', model_id: 'gpt-image-1', format: 'openai' } as LLMConnectionInfo
    expect(imageResultToConfigFields({ available: true, config })).toEqual({
      image_config: config,
      image_capability: { available: true },
    })
  })
  it('maps unavailable result to capability with reason and no config', () => {
    expect(imageResultToConfigFields({ available: false, reason: 'not_configured' })).toEqual({
      image_capability: { available: false, reason: 'not_configured' },
    })
  })
})
