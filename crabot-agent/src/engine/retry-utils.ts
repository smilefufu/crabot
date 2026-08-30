export const DEFAULT_MAX_RETRIES = 5
export const DEFAULT_RETRY_DELAY_MS = 1_000
export const BACKOFF_MAX_DELAY_MS = 8_000

/** Retry-After 延迟上限：超过此值不再等待，直接失败。 */
export const RETRY_AFTER_MAX_MS = 60_000

/** 无 Retry-After 的通用 429 最多重试次数。 */
export const OVERLOADED_WITHOUT_RETRY_AFTER_MAX_RETRIES = 3

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

// 上游 body 里出现这些 code 时视为过载/限流，走指数退避（包括 HTTP 400 的非标准载体）。
// 目前只见过 ChatGPT Codex 后端用 HTTP 400 + server_is_overloaded；其他 provider 后续按样本补。
const OVERLOADED_BODY_CODES = new Set([
  'server_is_overloaded',
])

// HTTP status 黑名单：明确指示客户端永久错误（认证 / 越权 / 不存在 / 方法错误 / 校验失败），
// 重试无意义。其他 4xx（含 400）和所有 5xx 都默认走重试 —— 现实中很多上游把 transient
// 错误（过载 / 路由抖动 / token 过期）伪装成 400，按状态码白名单一刀切会错杀整轮请求。
const NON_RETRYABLE_HTTP_STATUS = new Set([401, 403, 404, 405, 422])

// body code 黑名单：上游把"客户端永久错误"塞进 HTTP 400/429 body 的特殊 code。
// 这类错误重试也不会成功（同输入再发还是被拦），必须在状态码默认重试之前先短路。
const NON_RETRYABLE_BODY_CODES = new Set([
  'content_filter',           // 内容审查命中（OpenAI）
  'data_inspection_failed',   // 内容审查命中（阿里云百炼 / DashScope）
  'DataInspectionFailed',     // 同上，驼峰变体
  'invalid_prompt',           // prompt 结构不合法
  'invalid_request_error',    // 通用请求错（OpenAI 风格）
  'invalid_api_key',
  'invalid_authentication',
  // 额度 / 计费类：再发多少次都没用，必须 fail-fast 让用户换 provider
  'insufficient_quota',
  'quota_exceeded',
  'balance_exhausted',
  'credit_exhausted',
  'billing_not_active',
])

export class HttpResponseError extends Error {
  private parsedBodyCode: string | null | undefined

  constructor(
    public readonly status: number,
    public readonly body: string,
    label: string,
    /** 上游 Retry-After 头解析后的毫秒数（如有）。 */
    public readonly retryAfterMs?: number,
  ) {
    super(`${label} HTTP ${status}: ${body.slice(0, 300)}`)
    this.name = 'HttpResponseError'
  }

  /** body 中的 `code` 字段（如有），用于识别非标准过载/错误码。结果缓存。 */
  get bodyCode(): string | null {
    if (this.parsedBodyCode === undefined) {
      this.parsedBodyCode = extractBodyCode(this.body)
    }
    return this.parsedBodyCode
  }
}

/**
 * 流式超时错误：首 chunk 超 TTFB 未到（phase='ttfb'）、或相邻 chunk 间隔超过空闲
 * 阈值（phase='idle'）时由 withStreamTimeout 抛出。视为可重试——换一条新连接重发整
 * 请求；与用户主动取消（AbortError，不可重试）严格区分。
 */
export class StreamTimeoutError extends Error {
  constructor(
    public readonly phase: 'ttfb' | 'idle',
    public readonly timeoutMs: number,
  ) {
    super(`stream ${phase} timeout after ${timeoutMs}ms`)
    this.name = 'StreamTimeoutError'
  }
}

/**
 * 上游以 HTTP 200/SSE 正常结束，但缺少协议要求的终态事件/字段。
 * 这类结果不可信，但重发整次 buffered LLM 请求通常可以恢复。
 */
export class StreamProtocolError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'StreamProtocolError'
  }
}

// OpenAI 风格错误体把 code 放在 `error.code`（如 `{error:{code,message,type}}`）；
// 仅少数上游用顶层 `code`。优先读嵌套，找不到再回退顶层，保证两种结构都能识别。
function extractBodyCode(body: string): string | null {
  try {
    const obj = JSON.parse(body) as unknown
    if (obj && typeof obj === 'object') {
      const err = (obj as { error?: unknown }).error
      if (err && typeof err === 'object') {
        const nestedCode = (err as { code?: unknown }).code
        if (typeof nestedCode === 'string') return nestedCode
      }
      const topCode = (obj as { code?: unknown }).code
      if (typeof topCode === 'string') return topCode
      // OpenAI 风格永久错误（如 invalid_request_error）只在 error.type 给判别符，不带 code。
      // 黑名单里就列了 invalid_request_error，必须把 type 也纳入识别——否则 HTTP 400
      // invalid_request_error 会落到状态码默认重试，白烧整轮时间预算（见 deepseek 模型打到
      // Codex 端点的 400 案例）。优先级最低：code 命中时不会走到这里。
      if (err && typeof err === 'object') {
        const nestedType = (err as { type?: unknown }).type
        if (typeof nestedType === 'string') return nestedType
      }
    }
  } catch { /* not JSON */ }
  return null
}

export function isRetryableStatus(status: number): boolean {
  if (status < 400 || status >= 600) return false
  return !NON_RETRYABLE_HTTP_STATUS.has(status)
}

/**
 * 解析 Retry-After 头值为毫秒数。
 *   - 纯秒数（如 "5"）→ 直接 ×1000。
 *   - HTTP-date（如 "Wed, 21 Oct 2026 07:28:00 GMT"）→ 与当前时间差。
 *   - 无法解析 → undefined。
 */
export function parseRetryAfterMs(value: string | null | undefined): number | undefined {
  if (!value) return undefined
  const trimmed = value.trim()
  const seconds = Number(trimmed)
  if (Number.isFinite(seconds) && Number.isInteger(seconds) && seconds >= 0) {
    return seconds * 1000
  }
  const date = Date.parse(trimmed)
  if (Number.isFinite(date)) {
    return Math.max(0, date - Date.now())
  }
  return undefined
}

/** 从已知错误形态中提取 Retry-After 毫秒数。 */
export function getRetryAfterMs(err: unknown): number | undefined {
  if (err instanceof HttpResponseError) return err.retryAfterMs
  const headers = (err as Error & { headers?: Record<string, string | string[]> }).headers
  if (headers) {
    const value = headers['retry-after'] ?? headers['Retry-After']
    return parseRetryAfterMs(Array.isArray(value) ? value[0] : value)
  }
  return undefined
}

/** 判断是否为「无 Retry-After 的通用 429」，需要单独限制重试次数。 */
export function isOverloadedWithoutRetryAfter(err: unknown): boolean {
  if (err instanceof HttpResponseError) {
    return err.status === 429 && err.retryAfterMs === undefined
  }
  const status = (err as Error & { status?: unknown }).status
  if (status !== 429) return false
  return getRetryAfterMs(err) === undefined
}

/**
 * 是否属于过载/限流类错误，需要走指数退避。包含：
 *   - HTTP 429（标准限流）
 *   - HttpResponseError body code 命中 OVERLOADED_BODY_CODES（如 server_is_overloaded 走 HTTP 400）
 *   - SDK error 自带 status === 429
 *
 * 注意：本函数只做「分类」，不做「是否还应继续重试」的判断。
 * 无 Retry-After 的通用 429 另有次数上限（见 withStreamConsumptionRetry）。
 */
export function isOverloadedError(err: unknown): boolean {
  if (!(err instanceof Error)) return false

  if (err instanceof HttpResponseError) {
    if (err.status === 429) return true
    if (err.bodyCode && OVERLOADED_BODY_CODES.has(err.bodyCode)) return true
    return false
  }

  const sdkStatus = (err as Error & { status?: unknown }).status
  if (sdkStatus === 429) return true

  return false
}

/**
 * 计算单次重试前的等待时间。
 *   - retryAfterMs 有值：优先使用，上限 RETRY_AFTER_MAX_MS。
 *   - useBackoff=false：固定 baseDelayMs。
 *   - useBackoff=true：base * 2^attempt（cap 在 BACKOFF_MAX_DELAY_MS）。
 *
 * attempt 为 0-indexed —— 第一次失败时 attempt=0，对应 base * 1。
 */
export function computeRetryDelayMs(attempt: number, baseDelayMs: number, useBackoff: boolean, retryAfterMs?: number): number {
  if (retryAfterMs !== undefined) {
    return Math.min(Math.max(retryAfterMs, 0), RETRY_AFTER_MAX_MS)
  }
  if (!useBackoff) return baseDelayMs
  return Math.min(baseDelayMs * Math.pow(2, attempt), BACKOFF_MAX_DELAY_MS)
}

export function isRetryableError(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  if (err.name === 'AbortError') return false

  // 流式超时（TTFB / 空闲）总是可重试——换新连接重发
  if (err instanceof StreamTimeoutError) return true
  if (err instanceof StreamProtocolError) return true

  if (err instanceof HttpResponseError) {
    // 先短路 body code 黑名单（如 content_filter）—— 这类错误即使包在 5xx 里也不该重试
    if (err.bodyCode && NON_RETRYABLE_BODY_CODES.has(err.bodyCode)) return false
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
  /**
   * 可观测性回调：retry 发生（catch 后、sleep 前）触发。
   * 主要用途是 worker → admin web 显示"LLM 正在重试中"。
   */
  readonly onRetry?: (event: { attempt: number; maxAttempts: number; delayMs: number; error: Error }) => void
  /** 配置变更信号；触发时重试 sleep 会提前结束并由 onConfigChanged 刷新配置。 */
  readonly configChangedSignal?: AbortSignal
  /** 配置变更信号触发后调用；调用方应在此刷新 adapter/model 等运行时配置。 */
  readonly onConfigChanged?: () => Promise<void>
}

export interface InterruptibleSleepOptions {
  readonly abortSignal?: AbortSignal
  readonly configChangedSignal?: AbortSignal
  readonly onConfigChanged?: () => Promise<void>
}

/**
 * 可被用户取消或配置变更打断的 sleep。
 * - abortSignal 触发 → 抛 AbortError（用户主动取消）。
 * - configChangedSignal 触发 → 调用 onConfigChanged 并正常 resolve，让外层继续下一次 attempt。
 */
export async function interruptibleSleep(ms: number, options: InterruptibleSleepOptions = {}): Promise<void> {
  const { abortSignal, configChangedSignal, onConfigChanged } = options
  if (abortSignal?.aborted) {
    throw new DOMException('Aborted', 'AbortError')
  }
  if (configChangedSignal?.aborted) {
    await onConfigChanged?.()
    return
  }
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup()
      resolve()
    }, ms)
    const cleanup = (): void => {
      clearTimeout(timer)
      abortSignal?.removeEventListener('abort', onAbort)
      configChangedSignal?.removeEventListener('abort', onConfigChangedAbort)
    }
    const onAbort = (): void => {
      cleanup()
      reject(new DOMException('Aborted', 'AbortError'))
    }
    const onConfigChangedAbort = async (): Promise<void> => {
      cleanup()
      try {
        await onConfigChanged?.()
      } catch (err) {
        reject(err)
        return
      }
      resolve()
    }
    abortSignal?.addEventListener('abort', onAbort, { once: true })
    configChangedSignal?.addEventListener('abort', onConfigChangedAbort, { once: true })
  })
}

export interface StreamRetryOptions<T = unknown> extends RetryOptions {
  /**
   * 判断已 yield 的 chunk 是否对消费者可见。返回 true 后，再次失败将不再重试
   * （避免重复 chunk 送给消费者）。默认：所有 chunk 都视为可见 —— 等同旧行为。
   *
   * 用途：流式 LLM 响应可能先吐元事件（如 `message_start`，仅含 messageId，对
   * 下游 StreamProcessor 是 noop），再吐实质性内容。识别这类元事件后，即便
   * 已 yield 也允许在断流时重试。
   */
  readonly isMaterial?: (chunk: T) => boolean
}

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

  for (let attempt = 0; ; attempt++) {
    try {
      return await fn()
    } catch (err) {
      if (abortSignal?.aborted) throw err
      if (!isRetryableError(err)) throw err
      if (attempt >= maxRetries) throw err
      const actualDelay = computeRetryDelayMs(attempt, delayMs, true, getRetryAfterMs(err))
      console.error(
        `[${label}] attempt ${attempt + 1} failed, retrying in ${actualDelay}ms (backoff):`,
        err,
      )
      try {
        options.onRetry?.({
          attempt: attempt + 1,
          maxAttempts: maxRetries + 1,
          delayMs: actualDelay,
          error: err instanceof Error ? err : new Error(String(err)),
        })
      } catch { /* observability callback must not break retry */ }
      await interruptibleSleep(actualDelay, {
        abortSignal,
        configChangedSignal: options.configChangedSignal,
        onConfigChanged: options.onConfigChanged,
      })
    }
  }
}

/**
 * Wraps an async generator factory with retry semantics.
 * Retries are only attempted BEFORE the first *material* chunk is yielded;
 * once a material chunk has been forwarded to the consumer, errors propagate
 * (partial output cannot be safely replayed).
 * Uses capped exponential backoff for all retryable errors.
 */
export async function* streamWithRetry<T>(
  label: string,
  makeStream: () => AsyncGenerator<T>,
  options: StreamRetryOptions<T> = {},
): AsyncGenerator<T> {
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES
  const delayMs = options.delayMs ?? DEFAULT_RETRY_DELAY_MS
  const abortSignal = options.abortSignal
  const isMaterial = options.isMaterial ?? (() => true)

  for (let attempt = 0; ; attempt++) {
    let materialYielded = false
    try {
      for await (const chunk of makeStream()) {
        if (!materialYielded && isMaterial(chunk)) {
          materialYielded = true
        }
        yield chunk
      }
      return
    } catch (err) {
      if (materialYielded) throw err
      if (abortSignal?.aborted) throw err
      if (!isRetryableError(err)) throw err
      if (attempt >= maxRetries) throw err
      const actualDelay = computeRetryDelayMs(attempt, delayMs, true, getRetryAfterMs(err))
      console.error(
        `[${label}] attempt ${attempt + 1} failed, retrying in ${actualDelay}ms (backoff):`,
        err,
      )
      try {
        options.onRetry?.({
          attempt: attempt + 1,
          maxAttempts: maxRetries + 1,
          delayMs: actualDelay,
          error: err instanceof Error ? err : new Error(String(err)),
        })
      } catch { /* observability callback must not break retry */ }
      await interruptibleSleep(actualDelay, {
        abortSignal,
        configChangedSignal: options.configChangedSignal,
        onConfigChanged: options.onConfigChanged,
      })
    }
  }
}
