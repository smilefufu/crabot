/**
 * API 客户端
 */

import { storage } from '../utils/storage'
import type { ApiError } from '../types'

const API_BASE = '/api'

class ApiClient {
  private async request<T>(
    endpoint: string,
    options: RequestInit = {}
  ): Promise<T> {
    const token = storage.getToken()

    const headers: Record<string, string> =
      options.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }

    if (options.headers) {
      Object.assign(headers, options.headers)
    }

    if (token && endpoint !== '/auth/login') {
      headers['Authorization'] = `Bearer ${token}`
    }

    const response = await fetch(`${API_BASE}${endpoint}`, {
      ...options,
      headers,
    })

    if (response.status === 401) {
      // 尽量先解析 body 拿 error code（不阻塞 throw）
      let body: { error?: string } = {}
      try { body = await response.clone().json() } catch {}
      if (body.error === 'ADMIN_TOKEN_REVOKED') {
        // token 已失效会自动跳转到 /login，重定向本身作为用户反馈
        console.warn('[auth] token revoked — admin password was changed elsewhere')
      }
      storage.clearToken()
      window.location.href = '/login'
      throw new Error('Unauthorized')
    }

    if (!response.ok) {
      const body: ApiError = await response.json().catch(() => ({ error: 'Request failed' }))
      const err = new Error(body.error || 'Request failed') as Error & {
        status?: number
        body?: ApiError & Record<string, unknown>
      }
      err.status = response.status
      err.body = body as ApiError & Record<string, unknown>
      throw err
    }

    if (response.status === 204 || response.headers.get('content-length') === '0') {
      return undefined as T
    }

    return response.json()
  }

  async get<T>(endpoint: string): Promise<T> {
    return this.request<T>(endpoint, { method: 'GET' })
  }

  async post<T>(endpoint: string, data?: unknown): Promise<T> {
    return this.request<T>(endpoint, {
      method: 'POST',
      body: data instanceof FormData ? data : data ? JSON.stringify(data) : undefined,
    })
  }

  async put<T>(endpoint: string, data: unknown): Promise<T> {
    return this.request<T>(endpoint, {
      method: 'PUT',
      body: JSON.stringify(data),
    })
  }

  async patch<T>(endpoint: string, data: unknown): Promise<T> {
    return this.request<T>(endpoint, {
      method: 'PATCH',
      body: JSON.stringify(data),
    })
  }

  async delete<T>(endpoint: string, data?: unknown): Promise<T> {
    return this.request<T>(endpoint, {
      method: 'DELETE',
      ...(data !== undefined ? { body: JSON.stringify(data) } : {}),
    })
  }

  listModules() {
    return this.get<{ modules: Array<{ module_id: string; module_type: string; status: string; pid?: number; port: number; last_health_status?: string }> }>('/modules')
  }

  getModuleLog(moduleId: string, tail = 500) {
    return this.get<{ module_id: string; lines: number; content: string }>(`/modules/${encodeURIComponent(moduleId)}/log?tail=${tail}`)
  }

  restartModule(moduleId: string) {
    return this.post<{ ok: boolean }>(`/modules/${encodeURIComponent(moduleId)}/restart`, {})
  }
}

export const api = new ApiClient()
