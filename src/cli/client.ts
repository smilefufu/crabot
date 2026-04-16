import type { AuthConfig } from './auth.js'

class ApiError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

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
    try {
      body = JSON.parse(text)
    } catch {
      body = text
    }

    if (!response.ok) {
      const errorMessage =
        typeof body === 'object' && body !== null
          ? ((body as Record<string, unknown>)['message'] as string) ??
            ((body as Record<string, unknown>)['error'] as string) ??
            `HTTP ${response.status}: ${response.statusText}`
          : `HTTP ${response.status}: ${response.statusText}`
      throw new ApiError(errorMessage, response.status)
    }

    return body as T
  }

  async get<T>(path: string): Promise<T> {
    const response = await fetch(this.buildUrl(path), {
      method: 'GET',
      headers: this.buildHeaders(),
    })
    return this.parseResponse<T>(response)
  }

  async post<T>(path: string, body?: unknown): Promise<T> {
    const response = await fetch(this.buildUrl(path), {
      method: 'POST',
      headers: this.buildHeaders(),
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
    return this.parseResponse<T>(response)
  }

  async patch<T>(path: string, body: unknown): Promise<T> {
    const response = await fetch(this.buildUrl(path), {
      method: 'PATCH',
      headers: this.buildHeaders(),
      body: JSON.stringify(body),
    })
    return this.parseResponse<T>(response)
  }

  async delete<T>(path: string): Promise<T> {
    const response = await fetch(this.buildUrl(path), {
      method: 'DELETE',
      headers: this.buildHeaders(),
    })
    return this.parseResponse<T>(response)
  }
}
