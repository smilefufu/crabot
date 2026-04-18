// LLM adapter retry policy: fixed interval, applied ONLY before the first
// stream chunk has been yielded. Retrying after partial output would duplicate
// text deltas to the consumer (query-loop → UI/trace), so we never retry a
// stream that has already started emitting.

export const DEFAULT_MAX_RETRIES = 10
export const DEFAULT_RETRY_DELAY_MS = 10_000

const RETRYABLE_CODES = new Set([
  // POSIX
  'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE',
  'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH', 'ENOTFOUND',
  // undici
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET', 'UND_ERR_CLOSED',
  'UND_ERR_REQ_RETRY',
])

const RETRYABLE_MESSAGE_PATTERNS = [
  'fetch failed', 'terminated', 'socket hang up', 'network error',
]

export class HttpResponseError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string,
    label: string,
  ) {
    super(`${label} HTTP ${status}: ${body.slice(0, 300)}`)
    this.name = 'HttpResponseError'
  }
}

export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || (status >= 500 && status < 600)
}

export function isRetryableError(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  if (err.name === 'AbortError') return false

  if (err instanceof HttpResponseError) {
    return isRetryableStatus(err.status)
  }

  // SDK errors (@anthropic-ai/sdk, openai sdk) expose .status as a number.
  const sdkStatus = (err as Error & { status?: unknown }).status
  if (typeof sdkStatus === 'number') {
    // status === 0 typically means "no response / connection failure" (retryable)
    if (sdkStatus === 0) return true
    return isRetryableStatus(sdkStatus)
  }

  // SDK connection errors (no status, but distinctive name)
  if (err.name === 'APIConnectionError' || err.name === 'APIConnectionTimeoutError') {
    return true
  }

  // walk cause chain for a known network error code
  const seen = new Set<unknown>()
  let cur: unknown = err
  while (cur instanceof Error && !seen.has(cur)) {
    seen.add(cur)
    const code = (cur as Error & { code?: unknown }).code
    if (typeof code === 'string' && RETRYABLE_CODES.has(code)) return true
    cur = (cur as Error & { cause?: unknown }).cause
  }

  // Last resort: match generic undici message strings
  return RETRYABLE_MESSAGE_PATTERNS.some((p) => err.message.includes(p))
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new DOMException('Aborted', 'AbortError'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export interface RetryOptions {
  readonly maxRetries?: number
  readonly delayMs?: number
  readonly abortSignal?: AbortSignal
}

export type StreamRetryOptions = RetryOptions

/**
 * Wraps a promise-returning factory with retry semantics. Retries on known
 * network / HTTP 5xx / 429 errors; gives up on AbortError and non-retryable
 * errors immediately.
 */
export async function withRetry<T>(
  label: string,
  fn: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES
  const delayMs = options.delayMs ?? DEFAULT_RETRY_DELAY_MS
  const abortSignal = options.abortSignal

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn()
    } catch (err) {
      if (abortSignal?.aborted) throw err
      if (!isRetryableError(err)) throw err
      if (attempt >= maxRetries) throw err
      console.error(
        `[${label}] attempt ${attempt + 1}/${maxRetries + 1} failed, retrying in ${delayMs}ms:`,
        err,
      )
      await sleep(delayMs, abortSignal)
    }
  }
  throw new Error(`${label}: retry loop exited unexpectedly`)
}

/**
 * Wraps an async generator factory with retry semantics.
 * Retries are only attempted BEFORE the first chunk is yielded; once any chunk
 * has been forwarded to the consumer, errors propagate (partial output cannot
 * be safely replayed).
 */
export async function* streamWithRetry<T>(
  label: string,
  makeStream: () => AsyncGenerator<T>,
  options: RetryOptions = {},
): AsyncGenerator<T> {
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES
  const delayMs = options.delayMs ?? DEFAULT_RETRY_DELAY_MS
  const abortSignal = options.abortSignal

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let yielded = false
    try {
      for await (const chunk of makeStream()) {
        yielded = true
        yield chunk
      }
      return
    } catch (err) {
      if (yielded) throw err
      if (abortSignal?.aborted) throw err
      if (!isRetryableError(err)) throw err
      if (attempt >= maxRetries) throw err
      console.error(
        `[${label}] attempt ${attempt + 1}/${maxRetries + 1} failed, retrying in ${delayMs}ms:`,
        err,
      )
      await sleep(delayMs, abortSignal)
    }
  }
}
