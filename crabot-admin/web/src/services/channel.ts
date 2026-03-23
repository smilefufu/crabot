import { api } from './api'
import type {
  ChannelImplementation,
  ChannelInstance,
  ChannelConfig,
  CreateChannelInstanceParams,
  UpdateChannelInstanceParams,
  ScanResult,
} from '../types'

export const channelService = {
  // Implementation
  async listImplementations() {
    return api.get<{ items: ChannelImplementation[]; pagination: any }>('/channel-implementations')
  },

  async getImplementation(id: string) {
    return api.get<{ implementation: ChannelImplementation }>(`/channel-implementations/${id}`)
  },

  // Instance
  async listInstances() {
    return api.get<{ items: ChannelInstance[]; pagination: any }>('/channel-instances')
  },

  async getInstance(id: string) {
    return api.get<{ instance: ChannelInstance }>(`/channel-instances/${id}`)
  },

  async createInstance(params: CreateChannelInstanceParams) {
    return api.post<{ instance: ChannelInstance }>('/channel-instances', params)
  },

  async updateInstance(id: string, params: Partial<UpdateChannelInstanceParams>) {
    return api.patch<{ instance: ChannelInstance }>(`/channel-instances/${id}`, params)
  },

  async deleteInstance(id: string) {
    return api.delete(`/channel-instances/${id}`)
  },

  // Config
  async getInstanceConfig(id: string) {
    return api.get<{ config: ChannelConfig; schema?: any }>(`/channel-instances/${id}/config`)
  },

  async updateInstanceConfig(id: string, config: Partial<ChannelConfig>) {
    return api.patch<{ config: ChannelConfig; requires_restart: boolean }>(
      `/channel-instances/${id}/config`,
      { config }
    )
  },

  // Module Control
  async startInstance(id: string) {
    return api.post(`/channel-instances/${id}/start`)
  },

  async stopInstance(id: string) {
    return api.post(`/channel-instances/${id}/stop`)
  },

  async restartInstance(id: string) {
    return api.post(`/channel-instances/${id}/restart`)
  },

  // State Dir Scan
  async scanStateDir(stateDir: string) {
    return api.post<ScanResult>('/channels/scan-state-dir', { state_dir: stateDir })
  },
}
