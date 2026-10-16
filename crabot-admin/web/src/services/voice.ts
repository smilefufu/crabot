import type { ChannelInstance } from '../types'
import { api } from './api'
import type { AudioServiceProvider, VoiceInstanceConfig, VoiceAdminAction, VoiceAdminActionResult, VoiceConnectionConfig } from 'crabot-shared'

export type AudioServicePublic = Omit<AudioServiceProvider, 'api_key'> & { has_api_key: boolean }
export type AudioServiceEdit = Omit<AudioServiceProvider, 'id'> & { clear_api_key?: boolean }
const base = (id: string) => `/channels/${encodeURIComponent(id)}/voice`
export const voiceService = {
  setup: (name: string, config: VoiceInstanceConfig) => api.post<{ instance: ChannelInstance }>('/channels/voice/setup', { name, config }),
  resume: (id: string) => api.post<{ instance: ChannelInstance }>(base(id) + '/setup/resume', {}),
  pause: (id: string) => api.post<{ instance: ChannelInstance }>(base(id) + '/setup/pause', {}),
  finish: (id: string) => api.post<{ instance: ChannelInstance }>(base(id) + '/setup/finish', {}),
  connection: (id: string) => api.get<VoiceConnectionConfig | null>(base(id) + '/connection'),
  saveConnection: (id: string, value: VoiceConnectionConfig) => api.put<VoiceConnectionConfig>(base(id) + '/connection', value),
  list: () => api.get<{ items: AudioServicePublic[] }>('/audio-services'),
  save: (provider: AudioServiceEdit, id?: string) => id ? api.put(`/audio-services/${encodeURIComponent(id)}`, provider) : api.post('/audio-services', provider),
  remove: (id: string) => api.delete(`/audio-services/${encodeURIComponent(id)}`),
  config: (id: string) => api.get<VoiceInstanceConfig>(base(id) + '/config'),
  saveConfig: (id: string, config: VoiceInstanceConfig) => api.put<VoiceInstanceConfig>(base(id) + '/config', config),
  action: (id: string, command: VoiceAdminAction) => api.post<VoiceAdminActionResult>(base(id) + '/action', command),
  test: (id: string, capability: 'asr' | 'tts') => api.post<{ ok: boolean; text?: string; sample_count?: number }>(base(id) + '/test', { capability }),
}
