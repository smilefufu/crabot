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

describe('autoConfigureImageSlot', () => {
  it('auto-sets slot when an image model is discovered and slot is empty', async () => {
    const mgr = await newManager()
    const p = await mgr.createProvider({
      name: 'relay', type: 'manual', format: 'openai',
      endpoint: 'https://relay/v1', api_key: 'k',
      models: [
        { model_id: 'gpt-4o', display_name: 'gpt-4o', type: 'llm' },
        { model_id: 'gpt-image-1', display_name: 'gpt-image-1', type: 'image' },
      ],
    })
    expect(await mgr.autoConfigureImageSlot(p.id)).toBe(true)
    const cfg = mgr.getGlobalConfig()
    expect(cfg.default_image_provider_id).toBe(p.id)
    expect(cfg.default_image_model_id).toBe('gpt-image-1')
  })

  it('does not overwrite a user-set slot', async () => {
    const mgr = await newManager()
    const p = await mgr.createProvider({
      name: 'relay', type: 'manual', format: 'openai', endpoint: 'https://relay/v1', api_key: 'k',
      models: [{ model_id: 'gpt-image-1', display_name: 'gpt-image-1', type: 'image' }],
    })
    await mgr.updateGlobalConfig({
      default_image_provider_id: 'other', default_image_model_id: 'other-model', image_slot_user_set: true,
    })
    expect(await mgr.autoConfigureImageSlot(p.id)).toBe(false)
    expect(mgr.getGlobalConfig().default_image_model_id).toBe('other-model')
  })

  it('re-configures when the referenced model disappeared', async () => {
    const mgr = await newManager()
    const p = await mgr.createProvider({
      name: 'relay', type: 'manual', format: 'openai', endpoint: 'https://relay/v1', api_key: 'k',
      models: [{ model_id: 'gpt-image-2', display_name: 'gpt-image-2', type: 'image' }],
    })
    await mgr.updateGlobalConfig({ default_image_provider_id: p.id, default_image_model_id: 'gone-model' })
    expect(await mgr.autoConfigureImageSlot(p.id)).toBe(true)
    expect(mgr.getGlobalConfig().default_image_model_id).toBe('gpt-image-2')
  })
})
