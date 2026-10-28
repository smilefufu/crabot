/**
 * API 客户端
 */

import { storage } from '../utils/storage'
import { HttpClient, z } from 'crabot-client'
import { adminUrl, desktopBridge, desktopConnection, isDesktop } from './desktop-host'

const API_BASE = '/api'

let client: HttpClient | undefined
let clientSignal: AbortSignal | undefined
export function getWebClient(): HttpClient {
  const host = isDesktop ? desktopConnection() : undefined
  if (host && host.signal !== clientSignal) { client = undefined; clientSignal = host.signal }
  client ??= new HttpClient({
    endpoint: new URL(API_BASE, host?.origin ?? window.location.origin).href,
    signal: host?.signal,
    token: path => isDesktop || path === '/auth/login' ? null : storage.getToken(),
    fetch: async (url, options) => {
      const response = await fetch(url, options)
      if (response.status === 401) {
        if (isDesktop) void desktopBridge?.reconnect()
        else { storage.clearToken(); window.location.href = '/login' }
      }
      return response
    },
  })
  return client
}

// Binary uploads/downloads and SSE use the same verified direct Admin origin.
export function fetchAdmin(relative: string, options: RequestInit = {}): Promise<Response> {
  const headers = new Headers(options.headers)
  const token = isDesktop ? null : storage.getToken()
  if (token) headers.set('Authorization', 'Bearer ' + token)
  const hostSignal = isDesktop ? desktopConnection().signal : undefined
  const signals = [options.signal, hostSignal].filter((value): value is AbortSignal => !!value)
  return fetch(adminUrl(relative), { ...options, headers, redirect: 'error', ...(signals.length ? { signal: AbortSignal.any(signals) } : {}) })
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
