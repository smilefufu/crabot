import { describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { AudioServiceRegistry } from './audio-service-registry.js'

describe('voice audio service references', () => {
  it('resolves current services, redacts keys, preserves blank keys and prevents deleting referenced models', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'voice-audio-'))
    const registry = new AudioServiceRegistry(dir)
    const input = { name: 'local voice', format: 'openai-audio', endpoint: 'http://127.0.0.1:8765', api_key: 'secret-marker', models: [{ model_id: 'voice-v1', display_name: 'Voice', capabilities: ['asr', 'tts'] }] }
    try {
      await registry.load()
      expect(registry.resolve(null, 'asr')).toBeNull()
      const provider = await registry.saveProvider(input)
      expect(provider.has_api_key).toBe(true)
      expect(JSON.stringify(registry.list())).not.toContain('secret-marker')
      expect(provider).not.toHaveProperty('api_key')
      await registry.saveConfig('客厅', { asr: { provider_id: provider.id, model_id: 'voice-v1' }, tts: null, wake_word: '你好螃蟹' })
      await registry.saveProvider({ ...input, endpoint: 'http://127.0.0.1:9876', api_key: '' }, provider.id)
      expect(registry.resolve(registry.getConfig('客厅').asr, 'asr')).toMatchObject({ endpoint: 'http://127.0.0.1:9876', api_key: 'secret-marker' })
      await expect(registry.removeProvider(provider.id)).rejects.toThrow(/引用/)
      await expect(registry.saveProvider({ ...input, models: [{ model_id: 'other-model', display_name: 'Other', capabilities: ['asr'] }] }, provider.id)).rejects.toThrow(/引用/)
      await registry.saveProvider({ ...input, api_key: '', clear_api_key: true }, provider.id)
      expect(registry.resolve(registry.getConfig('客厅').asr, 'asr')).not.toHaveProperty('api_key')
      const restored = new AudioServiceRegistry(dir); await restored.load()
      expect(restored.getConfig('客厅')).toEqual(registry.getConfig('客厅'))
      expect(() => restored.resolve({ provider_id: 'missing', model_id: 'voice-v1' }, 'asr')).toThrow(/unavailable/)
    } finally { await fs.rm(dir, { recursive: true, force: true }) }
  })
  it('ignores only legacy kind on read and rewrites it away without changing references or keys', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'voice-audio-legacy-'))
    try {
      const registry = new AudioServiceRegistry(dir); await registry.load()
      const input = { name: 'API', format: 'openai-audio', endpoint: 'https://audio.example/v1', api_key: 'preserved-secret', models: [{ model_id: 'asr', display_name: 'ASR', capabilities: ['asr'] }] }
      const provider = await registry.saveProvider(input)
      await registry.saveConfig('voice', { asr: { provider_id: provider.id, model_id: 'asr' }, tts: null, wake_word: '你好螃蟹' })
      const file = path.join(dir, 'audio-services.json'), data = JSON.parse(await fs.readFile(file, 'utf8'))
      data.providers[0].kind = 'self_hosted'; await fs.writeFile(file, JSON.stringify(data))
      const restored = new AudioServiceRegistry(dir); await restored.load()
      expect(restored.resolve(restored.getConfig('voice').asr, 'asr')).toMatchObject({ endpoint: input.endpoint, api_key: input.api_key })
      expect(restored.list()[0]).not.toHaveProperty('kind')
      await expect(restored.saveProvider({ ...input, kind: 'cloud' }, provider.id)).rejects.toThrow()
      await restored.saveProvider(input, provider.id)
      expect(await fs.readFile(file, 'utf8')).not.toContain('"kind"')
      expect(restored.getConfig('voice').asr).toEqual({ provider_id: provider.id, model_id: 'asr' })
    } finally { await fs.rm(dir, { recursive: true, force: true }) }
  })
  it('rejects snapshots, malformed capabilities and secret-bearing endpoint URLs', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'voice-audio-invalid-'))
    const registry = new AudioServiceRegistry(dir)
    const valid = { name: 'ASR', format: 'sherpa-offline-ws', endpoint: 'ws://127.0.0.1:9876', models: [{ model_id: 'sensevoice', display_name: 'SenseVoice', capabilities: ['asr'] }] }
    try {
      for (const update of [{ endpoint: 'ws://user:secret@localhost:80' }, { models: [{ ...valid.models[0], capabilities: ['asr', 'tts'] }] }, { models: [valid.models[0], valid.models[0]] }, { old_snapshot: { api_key: 'secret' } }]) {
        await expect(registry.saveProvider({ ...valid, ...update })).rejects.toThrow()
      }
      await expect(registry.saveConfig('客厅', { asr: { endpoint: 'http://stale', apikey: 'secret' }, tts: null, wake_word: '你好螃蟹' })).rejects.toThrow()
      expect(registry.list()).toEqual([])
    } finally { await fs.rm(dir, { recursive: true, force: true }) }
  })
})
