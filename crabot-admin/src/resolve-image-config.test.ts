import { describe, it, expect } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ModelProviderManager } from './model-provider-manager'

async function newManager(): Promise<ModelProviderManager> {
  const dir = await mkdtemp(join(tmpdir(), 'mpm-'))
  const mgr = new ModelProviderManager(dir)
  await mgr.initialize()
  return mgr
}

describe('resolveImageConfig', () => {
  it('returns unavailable when not configured', async () => {
    const mgr = await newManager()
    expect(await mgr.resolveImageConfig()).toEqual({ available: false, reason: 'not_configured' })
  })

  it('resolves connection info for a configured apikey provider', async () => {
    const mgr = await newManager()
    const provider = await mgr.createProvider({
      name: 'relay', type: 'manual', format: 'openai',
      endpoint: 'https://relay.example.com/v1', api_key: 'sk-test',
      models: [{ model_id: 'gpt-image-1', display_name: 'gpt-image-1', type: 'image' }],
    })
    await mgr.updateGlobalConfig({
      default_image_provider_id: provider.id,
      default_image_model_id: 'gpt-image-1',
    })
    const res = await mgr.resolveImageConfig()
    expect(res.available).toBe(true)
    if (res.available) {
      expect(res.config.endpoint).toBe('https://relay.example.com/v1')
      expect(res.config.apikey).toBe('sk-test')
      expect(res.config.model_id).toBe('gpt-image-1')
    }
  })

  it('rejects oauth providers (cannot generate images)', async () => {
    const mgr = await newManager()
    const provider = await mgr.createProvider({
      name: 'chatgpt', type: 'preset', format: 'openai-responses', auth_type: 'oauth',
      endpoint: 'https://chatgpt.com/backend-api', api_key: '',
      models: [{ model_id: 'gpt-image-1', display_name: 'gpt-image-1', type: 'image' }],
    })
    await mgr.updateGlobalConfig({
      default_image_provider_id: provider.id,
      default_image_model_id: 'gpt-image-1',
    })
    const res = await mgr.resolveImageConfig()
    expect(res).toEqual({ available: false, reason: 'oauth_provider_cannot_generate_images' })
  })
})
