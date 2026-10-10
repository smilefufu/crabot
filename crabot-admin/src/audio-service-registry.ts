import { promises as fs } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { AudioModelReference, AudioServiceCapability, AudioServiceConnection, AudioServiceProvider, VoiceInstanceConfig } from 'crabot-shared'

type State = { providers: AudioServiceProvider[]; configs: Record<string, VoiceInstanceConfig> }
export type AudioServicePublic = Omit<AudioServiceProvider, 'api_key'> & { has_api_key: boolean }

function fail(message: string): never { throw Object.assign(new Error(message), { code: 'INVALID_PARAMS' }) }
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('Expected object')
  return value as Record<string, unknown>
}
function text(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > 2048) fail('Expected non-empty string')
}
function keys(value: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) fail('Unknown audio configuration field')
}
function publicProvider(provider: AudioServiceProvider): AudioServicePublic {
  const { api_key, ...rest } = structuredClone(provider)
  return { ...rest, has_api_key: !!api_key }
}

/** Owns only audio service references; it never falls back to LLM slots or connection snapshots. */
export class AudioServiceRegistry {
  private state: State = { providers: [], configs: {} }
  private serial: Promise<unknown> = Promise.resolve()
  private readonly filename: string
  constructor(dataDir: string) { this.filename = path.join(dataDir, 'audio-services.json') }
  async load(): Promise<void> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.filename, 'utf8')) as State
      if (!Array.isArray(parsed.providers) || !parsed.configs || typeof parsed.configs !== 'object') throw new Error('Corrupt audio service registry')
      this.state = parsed
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }
  list(): AudioServicePublic[] { return this.state.providers.map(publicProvider) }
  getConfig(channelId: string): VoiceInstanceConfig {
    return structuredClone(Object.prototype.hasOwnProperty.call(this.state.configs, channelId) ? this.state.configs[channelId] : { asr: null, tts: null, wake_word: '你好螃蟹' })
  }
  resolve(reference: AudioModelReference | null, capability: AudioServiceCapability): AudioServiceConnection | null {
    if (!reference) return null
    const provider = this.state.providers.find(p => p.id === reference.provider_id)
    const model = provider?.models.find(m => m.model_id === reference.model_id && m.capabilities.includes(capability))
    if (!provider || !model) fail(`Audio ${capability} reference is unavailable`)
    return { provider_id: provider.id, kind: provider.kind, format: provider.format, endpoint: provider.endpoint, ...(provider.api_key ? { api_key: provider.api_key } : {}), model_id: model.model_id, ...(model.voice ? { voice: model.voice } : {}), ...(model.language ? { language: model.language } : {}) }
  }
  async saveConfig(channelId: string, raw: unknown): Promise<VoiceInstanceConfig> {
    return this.change(state => {
      const v = record(raw); keys(v, ['asr', 'tts', 'wake_word']); text(v.wake_word)
      for (const capability of ['asr', 'tts'] as const) {
        if (v[capability] === null) continue
        const ref = record(v[capability]); keys(ref, ['provider_id', 'model_id']); text(ref.provider_id); text(ref.model_id)
        this.resolve(ref as unknown as AudioModelReference, capability)
      }
      const config = structuredClone(v) as unknown as VoiceInstanceConfig
      Object.defineProperty(state.configs, channelId, { value: config, enumerable: true, configurable: true, writable: true })
      return config
    })
  }
  async saveProvider(raw: unknown, id?: string): Promise<AudioServicePublic> {
    return this.change(state => {
      const v = record(raw)
      keys(v, ['id', 'name', 'kind', 'format', 'endpoint', 'api_key', 'models', 'clear_api_key'])
      text(v.name); text(v.endpoint)
      if (!['self_hosted', 'cloud'].includes(v.kind as string) || !['sherpa-offline-ws', 'mlx-audio-http', 'openai-audio'].includes(v.format as string)) fail('Invalid audio service kind/format')
      const url = new URL(v.endpoint)
      const protocols = v.format === 'sherpa-offline-ws' ? ['ws:', 'wss:'] : ['http:', 'https:']
      if (!protocols.includes(url.protocol) || url.username || url.password || url.hash || url.search) fail('Invalid audio endpoint')
      if (!Array.isArray(v.models) || !v.models.length) fail('Audio models are required')
      const names = new Set<string>()
      for (const rawModel of v.models) {
        const m = record(rawModel); keys(m, ['model_id', 'display_name', 'capabilities', 'voice', 'language'])
        text(m.model_id); text(m.display_name)
        if (names.has(m.model_id)) fail('Duplicate audio model'); names.add(m.model_id)
        if (!Array.isArray(m.capabilities) || !m.capabilities.length || new Set(m.capabilities).size !== m.capabilities.length) fail('Invalid audio capabilities')
        for (const capability of m.capabilities) {
          if (!['asr', 'tts'].includes(capability) || (v.format === 'sherpa-offline-ws' && capability !== 'asr') || (v.format === 'mlx-audio-http' && capability !== 'tts')) fail('Unsupported audio capability')
        }
        if (m.voice !== undefined) text(m.voice)
        if (m.language !== undefined) text(m.language)
      }
      const previous = id ? state.providers.find(p => p.id === id) : undefined
      if (id && !previous) fail('Audio service not found')
      if (v.id !== undefined && v.id !== id) fail('Audio service ID is assigned by Admin')
      if (v.api_key !== undefined && typeof v.api_key !== 'string') fail('Invalid API key')
      if (v.clear_api_key !== undefined && typeof v.clear_api_key !== 'boolean') fail('Invalid clear_api_key')
      const apiKey = v.clear_api_key === true ? undefined : (v.api_key as string | undefined)?.trim() || previous?.api_key
      const provider: AudioServiceProvider = { id: id ?? randomUUID(), name: v.name, kind: v.kind as AudioServiceProvider['kind'], format: v.format as AudioServiceProvider['format'], endpoint: v.endpoint.replace(/\/$/, ''), ...(apiKey ? { api_key: apiKey } : {}), models: structuredClone(v.models) as AudioServiceProvider['models'] }
      for (const config of Object.values(state.configs)) {
        for (const capability of ['asr', 'tts'] as const) {
          const ref = config[capability]
          if (ref?.provider_id === provider.id && !provider.models.some(m => m.model_id === ref.model_id && m.capabilities.includes(capability))) fail('该模型仍被 Voice 实例引用')
        }
      }
      state.providers = [...state.providers.filter(p => p.id !== provider.id), provider]
      return publicProvider(provider)
    })
  }
  async removeProvider(id: string): Promise<void> {
    await this.change(state => {
      if (Object.values(state.configs).some(c => c.asr?.provider_id === id || c.tts?.provider_id === id)) fail('该音频服务仍被 Voice 实例引用')
      if (!state.providers.some(p => p.id === id)) fail('Audio service not found')
      state.providers = state.providers.filter(p => p.id !== id)
    })
  }
  private async change<T>(update: (state: State) => T): Promise<T> {
    const pending = this.serial.then(async () => {
      const state = structuredClone(this.state)
      const result = update(state)
      await fs.mkdir(path.dirname(this.filename), { recursive: true })
      const tmp = this.filename + '.' + randomUUID() + '.tmp'
      try {
        await fs.writeFile(tmp, JSON.stringify(state), { mode: 0o600 })
        await fs.rename(tmp, this.filename)
      } finally { await fs.rm(tmp, { force: true }) }
      this.state = state
      return result
    })
    this.serial = pending.catch(() => {})
    return pending
  }
}
