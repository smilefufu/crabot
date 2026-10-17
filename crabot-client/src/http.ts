import { RequestIdSchema } from './contracts/chat.js'

export interface RuntimeSchema<T> { safeParse(input: unknown): { success: true; data: T } | { success: false } }
export type ClientErrorKind = 'unauthorized' | 'forbidden' | 'conflict' | 'validation' | 'unreachable' | 'timeout' | 'cancelled' | 'http'
export class ClientError extends Error {
  constructor(readonly kind: ClientErrorKind, message: string, readonly status?: number,
    readonly body?: unknown, readonly requestId?: string) { super(message); this.name = 'ClientError' }
}
export interface RequestOptions extends Omit<RequestInit, 'headers' | 'redirect'> {
  headers?: HeadersInit
  timeoutMs?: number
  requestId?: string
}
export interface ClientDiagnostic {
  operation: string
  request_id: string
  status?: number
  error?: ClientErrorKind
  duration_ms: number
}
export interface ClientOptions {
  endpoint: string
  /** Host lifetime/instance cancellation; remains independent of any UI or desktop framework. */
  signal?: AbortSignal
  token?: (path: string) => string | null | undefined | Promise<string | null | undefined>
  fetch?: typeof fetch
  diagnose?: (event: ClientDiagnostic) => void
}

export class HttpClient {
  private readonly endpoint: string
  constructor(private readonly options: ClientOptions) {
    const endpoint = new URL(options.endpoint)
    if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
      throw new Error('Invalid Admin endpoint')
    }
    this.endpoint = endpoint.href.replace(/\/$/, '')
  }

  async request<T>(path: string, schema: RuntimeSchema<T>, options: RequestOptions = {}): Promise<T> {
    try {
      if (!path.startsWith('/') || path.startsWith('//') || /[\\\r\n#]/.test(path)
        || path.split('?')[0].split('/').some(part => ['.', '..'].includes(decodeURIComponent(part)))) throw new Error()
    } catch { throw new ClientError('validation', 'Invalid API path') }
    const { timeoutMs = 30_000, requestId = createRequestId(), ...init } = options
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new ClientError('validation', 'Invalid request timeout')
    if (!RequestIdSchema.safeParse(requestId).success) throw new ClientError('validation', 'Invalid request correlation ID')
    const operation = options.method ?? 'GET'
    const started = Date.now()
    const timeout = new AbortController()
    const timer = setTimeout(() => timeout.abort(), timeoutMs)
    const abort = () => timeout.abort()
    const signals = [options.signal, this.options.signal].filter((value): value is AbortSignal => !!value)
    signals.forEach(signal => signal.addEventListener('abort', abort, { once: true }))
    if (signals.some(signal => signal.aborted)) timeout.abort()
    let status: number | undefined, failure: ClientErrorKind | undefined
    try {
      const headers = new Headers(options.headers)
      headers.set('X-Crabot-Request-Id', requestId)
      if (timeout.signal.aborted) throw new Error('Request aborted')
      const token = await awaitSignal(Promise.resolve(this.options.token?.(path)), timeout.signal)
      timeout.signal.throwIfAborted()
      if (token) headers.set('Authorization', 'Bearer ' + token)
      const response = await awaitSignal((this.options.fetch ?? fetch)(this.endpoint + path, {
        ...init, headers, redirect: 'error', signal: timeout.signal,
      }), timeout.signal)
      status = response.status
      const raw = await awaitSignal(response.text(), timeout.signal)
      timeout.signal.throwIfAborted()
      let body: unknown
      try { body = raw ? JSON.parse(raw) : undefined } catch { body = raw }
      if (!response.ok) {
        const error = body && typeof body === 'object' ? body as Record<string, unknown> : {}
        let message = `HTTP ${status}`
        if (typeof error.message === 'string') message = error.message
        else if (typeof error.error === 'string') message = error.error
        else if (typeof body === 'string' && body) message = body
        let kind: ClientErrorKind = 'http'
        if (status === 401) kind = 'unauthorized'
        else if (status === 403) kind = 'forbidden'
        else if (status === 409) kind = 'conflict'
        throw new ClientError(kind, message, status, body, requestId)
      }
      const parsed = schema.safeParse(body)
      if (!parsed.success) throw new ClientError('validation', 'Server response does not match the API contract', status, undefined, requestId)
      return parsed.data
    } catch (error) {
      let mapped: ClientError
      if (error instanceof ClientError) mapped = error
      else if (timeout.signal.aborted) {
        const cancelled = signals.some(signal => signal.aborted)
        mapped = new ClientError(cancelled ? 'cancelled' : 'timeout', cancelled ? 'Request cancelled' : 'Request timed out', status, undefined, requestId)
      } else mapped = new ClientError('unreachable', 'Cannot reach Admin', status, undefined, requestId)
      failure = mapped.kind
      throw mapped
    } finally {
      clearTimeout(timer); signals.forEach(signal => signal.removeEventListener('abort', abort))
      // No URLs, query strings, headers, tokens, request/response bodies or user text.
      try { this.options.diagnose?.({ operation, request_id: requestId, status, error: failure, duration_ms: Date.now() - started }) } catch { /* diagnostics cannot affect a mutation result */ }
    }
  }
}

function awaitSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(new Error('Request aborted')) }
    if (signal.aborted) { abort(); return }
    signal.addEventListener('abort', abort, { once: true })
    promise.then(value => { signal.removeEventListener('abort', abort); resolve(value) },
      error => { signal.removeEventListener('abort', abort); reject(error) })
  })
}

export function createRequestId(): string {
  // getRandomValues is available on ordinary HTTP browser origins too; randomUUID is not.
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  return 'req_' + Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
}
