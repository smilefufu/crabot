import { api } from './api'
import type { AudioServiceProvider, VoiceInstanceConfig, VoiceAdminAction, VoiceAdminActionResult } from 'crabot-shared'

export type AudioServicePublic = Omit<AudioServiceProvider, 'api_key'> & { has_api_key: boolean }
export type AudioServiceEdit = Omit<AudioServiceProvider, 'id'> & { clear_api_key?: boolean }
const base = (id: string) => `/channels/${encodeURIComponent(id)}/voice`
export const voiceService = {
  list: () => api.get<{ items: AudioServicePublic[] }>('/audio-services'),
  save: (provider: AudioServiceEdit, id?: string) => id ? api.put(`/audio-services/${encodeURIComponent(id)}`, provider) : api.post('/audio-services', provider),
  remove: (id: string) => api.delete(`/audio-services/${encodeURIComponent(id)}`),
  config: (id: string) => api.get<VoiceInstanceConfig>(base(id) + '/config'),
  saveConfig: (id: string, config: VoiceInstanceConfig) => api.put<VoiceInstanceConfig>(base(id) + '/config', config),
  action: (id: string, command: VoiceAdminAction) => api.post<VoiceAdminActionResult>(base(id) + '/action', command),
  test: (id: string, capability: 'asr' | 'tts') => api.post<{ ok: boolean; text?: string; sample_count?: number }>(base(id) + '/test', { capability }),
}
