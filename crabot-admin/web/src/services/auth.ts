/**
 * 认证服务
 */

import { api, getWebClient } from './api'
import { MeResponseSchema } from 'crabot-client'
import { storage } from '../utils/storage'
import type { LoginRequest, LoginResponse, ChangePasswordRequest, MeResponse } from '../types'
import { desktopBridge, isDesktop } from './desktop-host'

export const authService = {
  async login(password: string): Promise<LoginResponse> {
    const response = await api.post<LoginResponse>('/auth/login', {
      password,
    } as LoginRequest)

    storage.setToken(response.token, response.expires_at)

    return response
  },

  async getMe(): Promise<MeResponse> {
    return getWebClient().request('/auth/me', MeResponseSchema)
  },

  async changePassword(req: ChangePasswordRequest): Promise<void> {
    await api.post<void>('/auth/change-password', req)
  },

  logout(): void {
    if (isDesktop) { void desktopBridge!.quit(); return }
    storage.clearToken()
    window.location.href = '/login'
  },

  isAuthenticated(): boolean {
    return isDesktop || storage.isAuthenticated()
  },
}
