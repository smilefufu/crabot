import type { AuthConfig } from './auth.js'
import { CliError, fromHttpError } from './errors.js'
import { HttpClient, ClientError, z } from 'crabot-client'

export class AdminClient {
  private readonly http: HttpClient
  constructor(private readonly auth: AuthConfig) {
    this.http = new HttpClient({ endpoint: auth.endpoint, token: () => auth.token })
  }

  private async fetchWithErrorMap<T>(path: string, init: RequestInit): Promise<T> {
    const normalizedPath = path.startsWith('/') ? path : `/${path}`
    try {
      // Compatibility boundary for commands not yet assigned a resource DTO schema.
      const result = await this.http.request(normalizedPath, z.unknown(), {
        ...init, headers: { 'Content-Type': 'application/json' }, timeoutMs: 120_000,
      })
      return (result === undefined ? '' : result) as T // preserve the CLI's empty-response value
    } catch (e) {
      if (e instanceof ClientError) {
        if (e.kind === 'timeout' || e.kind === 'cancelled') throw new CliError('ADMIN_TIMEOUT', e.message)
        if (e.kind !== 'unreachable') throw fromHttpError(e.status ?? 500, e.message)
      }
      throw new CliError('ADMIN_UNREACHABLE', `Cannot reach Admin at ${this.auth.endpoint}: ${(e as Error).message}`)
    }
  }

  async get<T>(path: string): Promise<T> {
    return this.fetchWithErrorMap<T>(path, {
      method: 'GET',
    })
  }

  async post<T>(path: string, body?: unknown): Promise<T> {
    return this.fetchWithErrorMap<T>(path, {
      method: 'POST',
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
  }

  async patch<T>(path: string, body: unknown): Promise<T> {
    return this.fetchWithErrorMap<T>(path, {
      method: 'PATCH',
      body: JSON.stringify(body),
    })
  }

  async delete<T>(path: string): Promise<T> {
    return this.fetchWithErrorMap<T>(path, {
      method: 'DELETE',
    })
  }

  // Helper for list endpoints — Admin returns either bare arrays or {items: [...]}.
  // Always returns a plain array.
  async getList<T>(path: string): Promise<T[]> {
    const raw = await this.get<unknown>(path)
    if (Array.isArray(raw)) return raw as T[]
    if (raw && typeof raw === 'object' && Array.isArray((raw as { items?: unknown }).items)) {
      return (raw as { items: T[] }).items
    }
    return []
  }

  // Helper for single-resource GET endpoints that wrap response as { <key>: T }.
  // admin REST 普遍包一层（{config:{...}} / {friend:{...}} / {template:{...}} / {schedule:{...}}），
  // 但对应的 PATCH 接受 flat body — snapshot 取自 GET 时必须 unwrap，否则反向 PATCH 字段全丢。
  async getUnwrap<T>(path: string, key: string): Promise<T> {
    const raw = await this.get<Record<string, unknown>>(path)
    return (raw?.[key] ?? {}) as T
  }
}
