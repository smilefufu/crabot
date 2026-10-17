/**
 * API 客户端
 */

import { storage } from '../utils/storage'
import { HttpClient, z } from 'crabot-client'

const API_BASE = '/api'

let client: HttpClient | undefined
export function getWebClient(): HttpClient {
  client ??= new HttpClient({
    endpoint: new URL(API_BASE, window.location.origin).href,
    token: path => path === '/auth/login' ? null : storage.getToken(),
    fetch: async (url, options) => {
      const response = await fetch(url, options)
      if (response.status === 401) {
        storage.clearToken()
        window.location.href = '/login'
      }
      return response
    },
  })
  return client
}

class ApiClient {
  private async request<T>(
    endpoint: string,
    options: RequestInit = {}
  ): Promise<T> {
    const headers: Record<string, string> =
      options.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }

    if (options.headers) {
      Object.assign(headers, options.headers)
    }

    // Compatibility boundary for advanced resource pages not yet assigned a shared DTO schema.
    return await getWebClient().request(endpoint, z.unknown(), { ...options, headers, timeoutMs: 120_000 }) as T
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

  async delete<T>(endpoint: string, data?: unknown, keepalive = false): Promise<T> {
    return this.request<T>(endpoint, {
      method: 'DELETE',
      ...(keepalive ? { keepalive: true } : {}),
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
