import type { AuthConfig } from './auth.js'
import { CliError, fromHttpError } from './errors.js'

export class AdminClient {
  constructor(private readonly auth: AuthConfig) {}

  private buildUrl(path: string): string {
    const base = this.auth.endpoint.replace(/\/$/, '')
    const normalizedPath = path.startsWith('/') ? path : `/${path}`
    return `${base}${normalizedPath}`
  }

  private buildHeaders(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this.auth.token}`,
    }
  }

  private async parseResponse<T>(response: Response): Promise<T> {
    let body: unknown
    const text = await response.text()
    try { body = JSON.parse(text) } catch { body = text }

    if (!response.ok) {
      const message = (typeof body === 'object' && body !== null
        ? ((body as Record<string, unknown>)['message'] as string) ??
          ((body as Record<string, unknown>)['error'] as string) ??
          `HTTP ${response.status}`
        : typeof body === 'string' && body.length > 0 ? body : `HTTP ${response.status}`)
      throw fromHttpError(response.status, message)
    }
    return body as T
  }

  private async fetchWithErrorMap<T>(url: string, init: RequestInit): Promise<T> {
    let response: Response
    try {
      response = await fetch(url, init)
    } catch (e) {
      throw new CliError('ADMIN_UNREACHABLE', `Cannot reach Admin at ${url}: ${(e as Error).message}`)
    }
    return this.parseResponse<T>(response)
  }

  async get<T>(path: string): Promise<T> {
    return this.fetchWithErrorMap<T>(this.buildUrl(path), {
      method: 'GET',
      headers: this.buildHeaders(),
    })
  }

  async post<T>(path: string, body?: unknown): Promise<T> {
    return this.fetchWithErrorMap<T>(this.buildUrl(path), {
      method: 'POST',
      headers: this.buildHeaders(),
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
  }

  async patch<T>(path: string, body: unknown): Promise<T> {
    return this.fetchWithErrorMap<T>(this.buildUrl(path), {
      method: 'PATCH',
      headers: this.buildHeaders(),
      body: JSON.stringify(body),
    })
  }

  async delete<T>(path: string): Promise<T> {
    return this.fetchWithErrorMap<T>(this.buildUrl(path), {
      method: 'DELETE',
      headers: this.buildHeaders(),
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
}
