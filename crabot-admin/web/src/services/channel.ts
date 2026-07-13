import { api } from './api'
import { storage } from '../utils/storage'
import type {
  ChannelImplementation,
  ChannelInstance,
  ChannelConfig,
  CreateChannelInstanceParams,
  UpdateChannelInstanceParams,
  OnboardBeginResult,
  OnboardPollEvent,
} from '../types'

export const channelService = {
  // Implementation
  async listImplementations() {
    return api.get<{ items: ChannelImplementation[]; pagination: any }>('/channel-implementations')
  },

  async getImplementation(id: string) {
    return api.get<{ implementation: ChannelImplementation }>(`/channel-implementations/${encodeURIComponent(id)}`)
  },

  // Instance
  async listInstances() {
    return api.get<{ items: ChannelInstance[]; pagination: any }>('/channel-instances')
  },

  async getInstance(id: string) {
    return api.get<{ instance: ChannelInstance }>(`/channel-instances/${encodeURIComponent(id)}`)
  },

  async createInstance(params: CreateChannelInstanceParams) {
    return api.post<{ instance: ChannelInstance }>('/channel-instances', params)
  },

  async updateInstance(id: string, params: Partial<UpdateChannelInstanceParams>) {
    return api.patch<{ instance: ChannelInstance }>(`/channel-instances/${encodeURIComponent(id)}`, params)
  },

  async deleteInstance(id: string) {
    return api.delete(`/channel-instances/${encodeURIComponent(id)}`)
  },

  // Config
  async getInstanceConfig(id: string) {
    return api.get<{ config: ChannelConfig; schema?: any }>(`/channel-instances/${encodeURIComponent(id)}/config`)
  },

  async updateInstanceConfig(id: string, config: Partial<ChannelConfig>) {
    return api.patch<{ config: ChannelConfig; requires_restart: boolean }>(
      `/channel-instances/${encodeURIComponent(id)}/config`,
      { config }
    )
  },

  // Local Config（启动前环境变量配置）
  async getLocalConfig(id: string) {
    return api.get<{ config: Record<string, string> }>(`/channel-instances/${encodeURIComponent(id)}/local-config`)
  },

  async saveLocalConfig(id: string, config: Record<string, string>) {
    return api.post<{ config: Record<string, string> }>(`/channel-instances/${encodeURIComponent(id)}/local-config`, { config })
  },

  // Health（protocol-channel §7.1）
  async getHealth(id: string) {
    return api.get<{ status: string; details: Record<string, unknown> }>(`/channel-instances/${encodeURIComponent(id)}/health`)
  },

  // Module Control
  async startInstance(id: string) {
    return api.post(`/channel-instances/${encodeURIComponent(id)}/start`)
  },

  async stopInstance(id: string) {
    return api.post(`/channel-instances/${encodeURIComponent(id)}/stop`)
  },

  async restartInstance(id: string) {
    return api.post(`/channel-instances/${encodeURIComponent(id)}/restart`)
  },

  // ── 通用 Channel onboarding（base-protocol §10）────────────────────
  async onboardBegin(implementationId: string, methodId: string, params?: Record<string, unknown>) {
    return api.post<OnboardBeginResult>('/channels/onboard/begin', {
      implementation_id: implementationId,
      method_id: methodId,
      params,
    })
  },

  onboardPoll(
    implementationId: string,
    methodId: string,
    sessionId: string,
    onEvent: (ev: OnboardPollEvent) => void,
  ): { close: () => void } {
    const token = storage.getToken() ?? ''
    const url = `/api/channels/onboard/poll?implementation_id=${encodeURIComponent(implementationId)}&method_id=${encodeURIComponent(methodId)}&session_id=${encodeURIComponent(sessionId)}&token=${encodeURIComponent(token)}`
    const es = new EventSource(url)
    const types: OnboardPollEvent['type'][] = ['pending', 'slow_down', 'success', 'error']
    types.forEach((t) => {
      es.addEventListener(t, (ev) => {
        const messageEv = ev as MessageEvent
        try {
          onEvent(JSON.parse(messageEv.data) as OnboardPollEvent)
        } catch {
          // ignore malformed
        }
      })
    })
    return { close: () => es.close() }
  },

  async onboardFinish(implementationId: string, methodId: string, sessionId: string, name: string) {
    return api.post<{
      instance: ChannelInstance
      master_friend_id?: string
      master_display_name?: string
      scope_grant_url?: string
      event_subscription?: {
        url: string
        events: ReadonlyArray<{ name: string; identifier: string }>
        extra_instructions?: ReadonlyArray<string>
      }
      push_sent?: boolean
    }>('/channels/onboard/finish', {
      implementation_id: implementationId,
      method_id: methodId,
      session_id: sessionId,
      name,
    })
  },

  async onboardCancel(implementationId: string, methodId: string, sessionId: string) {
    return api.post('/channels/onboard/cancel', {
      implementation_id: implementationId,
      method_id: methodId,
      session_id: sessionId,
    })
  },

  /**
   * onboarding 完成后用户填写主人昵称时调用，通过 friend PATCH API 更新 display_name。
   * friendId 来自 onboardFinish 响应的 master_friend_id。
   */
  async updateMasterDisplayName(friendId: string, displayName: string) {
    return api.patch(`/friends/${encodeURIComponent(friendId)}`, { display_name: displayName })
  },
}
