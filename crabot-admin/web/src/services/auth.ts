/**
 * 认证服务
 */

import { api } from './api'
import { storage } from '../utils/storage'
import type { LoginRequest, LoginResponse } from '../types'

export const authService = {
  async login(password: string): Promise<LoginResponse> {
    const response = await api.post<LoginResponse>('/auth/login', {
      password,
    } as LoginRequest)

    storage.setToken(response.token, response.expires_at)

    return response
  },

  logout(): void {
    storage.clearToken()
    window.location.href = '/login'
  },

  isAuthenticated(): boolean {
    return storage.isAuthenticated()
  },
}
