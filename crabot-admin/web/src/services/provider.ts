/**
 * Model Provider 服务
 */

import { api } from './api'
import type {
  ModelProvider,
  ModelInfo,
  PresetVendor,
  GlobalModelConfig,
  PaginatedResponse,
} from '../types'

export const providerService = {
  async listProviders(): Promise<PaginatedResponse<ModelProvider>> {
    return api.get<PaginatedResponse<ModelProvider>>('/model-providers')
  },

  async getProvider(id: string): Promise<ModelProvider> {
    return api.get<ModelProvider>(`/model-providers/${id}`)
  },

  async createProvider(data: Partial<ModelProvider>): Promise<ModelProvider> {
    return api.post<ModelProvider>('/model-providers', data)
  },

  async updateProvider(
    id: string,
    data: Partial<ModelProvider>
  ): Promise<ModelProvider> {
    return api.patch<ModelProvider>(`/model-providers/${id}`, data)
  },

  async deleteProvider(id: string): Promise<void> {
    await api.delete(`/model-providers/${id}`)
  },

  async listPresetVendors(): Promise<PaginatedResponse<PresetVendor>> {
    return api.get<PaginatedResponse<PresetVendor>>('/preset-vendors')
  },

  async importFromVendor(
    vendorId: string,
    apiKey: string,
    endpoint?: string
  ): Promise<ModelProvider> {
    return api.post<ModelProvider>('/model-providers/import-from-vendor', {
      vendor_id: vendorId,
      api_key: apiKey,
      ...(endpoint ? { endpoint } : {}),
    })
  },

  async getGlobalConfig(): Promise<GlobalModelConfig> {
    const response = await api.get<{ config: GlobalModelConfig }>('/model-config/global')
    return response.config
  },

  async updateGlobalConfig(
    config: GlobalModelConfig
  ): Promise<GlobalModelConfig> {
    const response = await api.patch<{ config: GlobalModelConfig }>('/model-config/global', config)
    return response.config
  },

  async testProvider(
    id: string,
    modelId?: string
  ): Promise<{ success: boolean; latency_ms: number; error?: string }> {
    return api.post(`/model-providers/${id}/test`, modelId ? { model_id: modelId } : {})
  },

  async refreshModels(
    id: string
  ): Promise<{ models: ModelInfo[]; added: string[]; removed: string[] }> {
    return api.post(`/model-providers/${id}/refresh-models`, {})
  },

  async getReferences(
    id: string
  ): Promise<{ references: string[] }> {
    return api.get(`/model-providers/${id}/references`)
  },

  // OAuth
  async startOAuthLogin(): Promise<{ auth_url: string }> {
    return api.post('/oauth/chatgpt/login', {})
  },

  async submitOAuthManualCallback(
    redirectUrl: string,
  ): Promise<{ status: 'success'; email?: string; account_id?: string }> {
    return api.post('/oauth/chatgpt/manual-callback', { redirect_url: redirectUrl })
  },

  async getOAuthStatus(): Promise<{
    status: 'idle' | 'pending' | 'success' | 'failed'
    email?: string
    account_id?: string
    expires_at?: number
    error?: string
  }> {
    return api.get('/oauth/chatgpt/status')
  },

  async logoutOAuth(providerId: string): Promise<{ success: boolean }> {
    return api.post(`/oauth/chatgpt/${providerId}/logout`, {})
  },

  async getOAuthTokenInfo(providerId: string): Promise<{
    logged_in: boolean
    email?: string
    account_id?: string
    expires_at?: number
    is_expired?: boolean
  }> {
    return api.get(`/oauth/chatgpt/${providerId}/token-info`)
  },
}
