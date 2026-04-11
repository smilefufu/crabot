import { api } from './api'

export interface ProxyConfig {
  mode: 'system' | 'custom' | 'none'
  custom_url?: string
}

export interface ProxyConfigResponse {
  config: ProxyConfig
  system_proxy_url: string | null
}

export const proxyService = {
  async getConfig(): Promise<ProxyConfigResponse> {
    return api.get<ProxyConfigResponse>('/proxy-config')
  },

  async updateConfig(config: ProxyConfig): Promise<ProxyConfig> {
    const res = await api.patch<{ config: ProxyConfig }>('/proxy-config', config)
    return res.config
  },
}
