import { describe, it, expect } from 'vitest'
import {
  BACKOFF_MAX_DELAY_MS,
  HttpResponseError,
  computeRetryDelayMs,
  isOverloadedError,
  isRetryableError,
  streamWithRetry,
  withRetry,
} from '../../src/engine/retry-utils'

class SocketError extends Error {
  readonly code = 'UND_ERR_SOCKET'
  constructor() {
    super('other side closed')
    this.name = 'SocketError'
  }
}

function makeRetryableError(): Error {
  const inner = new SocketError()
  return Object.assign(new TypeError('terminated'), { cause: inner })
}

interface Chunk {
  readonly type: 'message_start' | 'text_delta'
  readonly text?: string
}

const isMaterial = (c: Chunk) => c.type !== 'message_start'

describe('streamWithRetry', () => {
  it('retries when only non-material chunks (message_start) were yielded before failure', async () => {
    let attempts = 0
    const collected: Chunk[] = []

    const stream = streamWithRetry<Chunk>(
      'test',
      async function* () {
        attempts += 1
        yield { type: 'message_start' } as Chunk
        if (attempts === 1) throw makeRetryableError()
        yield { type: 'text_delta', text: 'ok' } as Chunk
      },
      { isMaterial, delayMs: 1, maxRetries: 2 },
    )

    for await (const chunk of stream) collected.push(chunk)

    expect(attempts).toBe(2)
    expect(collected.map(c => c.type)).toEqual(['message_start', 'message_start', 'text_delta'])
  })

  it('does NOT retry once a material chunk (text_delta) was yielded', async () => {
    let attempts = 0
    const collected: Chunk[] = []

    const stream = streamWithRetry<Chunk>(
      'test',
      async function* () {
        attempts += 1
        yield { type: 'message_start' } as Chunk
        yield { type: 'text_delta', text: 'partial' } as Chunk
        throw makeRetryableError()
      },
      { isMaterial, delayMs: 1, maxRetries: 5 },
    )

    await expect(async () => {
      for await (const chunk of stream) collected.push(chunk)
    }).rejects.toThrow(/terminated/)

    expect(attempts).toBe(1)
    expect(collected.map(c => c.type)).toEqual(['message_start', 'text_delta'])
  })

  it('defaults isMaterial to true for backward compatibility (any yielded chunk blocks retry)', async () => {
    let attempts = 0

    const stream = streamWithRetry<Chunk>(
      'test',
      async function* () {
        attempts += 1
        yield { type: 'message_start' } as Chunk
        throw makeRetryableError()
      },
      { delayMs: 1, maxRetries: 5 },
    )

    await expect(async () => {
      for await (const _chunk of stream) {
        // drain
      }
    }).rejects.toThrow(/terminated/)

    expect(attempts).toBe(1)
  })

  it('still gives up on non-retryable errors', async () => {
    let attempts = 0

    const stream = streamWithRetry<Chunk>(
      'test',
      async function* () {
        attempts += 1
        yield { type: 'message_start' } as Chunk
        throw new Error('400 bad request')
      },
      { isMaterial, delayMs: 1, maxRetries: 5 },
    )

    await expect(async () => {
      for await (const _chunk of stream) {
        // drain
      }
    }).rejects.toThrow(/bad request/)

    expect(attempts).toBe(1)
  })

  it('treats HTTP 400 with body code "server_is_overloaded" as retryable + backoff', async () => {
    const err = new HttpResponseError(
      400,
      JSON.stringify({ code: 'server_is_overloaded', message: 'overloaded' }),
      'openai-responses-adapter',
    )
    expect(isRetryableError(err)).toBe(true)
    expect(isOverloadedError(err)).toBe(true)
    expect(err.bodyCode).toBe('server_is_overloaded')
  })

  it('treats generic HTTP 400 as retryable (no body code) with fixed-interval delay', async () => {
    // HTTP 4xx 的不可重试白名单仅 401/403/404/405/422，其他 4xx 默认重试，避开错杀
    // 上游把 transient 错（过载/路由抖动/token 过期）伪装成 400 的情况。
    const err = new HttpResponseError(400, 'unknown reason', 'test')
    expect(isRetryableError(err)).toBe(true)
    expect(isOverloadedError(err)).toBe(false)
  })

  it('treats auth-class HTTP errors (401/403/404/422) as non-retryable', async () => {
    for (const status of [401, 403, 404, 422]) {
      const err = new HttpResponseError(status, '', 'test')
      expect(isRetryableError(err)).toBe(false)
      expect(isOverloadedError(err)).toBe(false)
    }
  })

  it('treats body-code blacklist (content_filter / invalid_prompt) as non-retryable even on retryable status', async () => {
    for (const code of ['content_filter', 'invalid_prompt', 'invalid_request_error']) {
      const err = new HttpResponseError(400, JSON.stringify({ code }), 'test')
      expect(isRetryableError(err)).toBe(false)
    }
    // 即便包在 5xx 里也短路 —— 客户端永久错不该被状态码意外救活
    const err500 = new HttpResponseError(500, JSON.stringify({ code: 'content_filter' }), 'test')
    expect(isRetryableError(err500)).toBe(false)
  })

  it('extracts code from nested OpenAI-style error body {error:{code}}', async () => {
    const err = new HttpResponseError(
      400,
      JSON.stringify({ error: { code: 'invalid_api_key', message: 'bad key' } }),
      'openai-adapter',
    )
    expect(err.bodyCode).toBe('invalid_api_key')
    expect(isRetryableError(err)).toBe(false)
  })

  it('treats OpenAI-style {error:{type:invalid_request_error}} (no code) as non-retryable', async () => {
    // 真实形态：mirror/Codex 端点拒绝非兼容模型时返回 error.type 而非 error.code。
    // 旧实现只读 code → 漏判 → HTTP 400 被当可重试，白烧整轮时间预算。
    const err = new HttpResponseError(
      400,
      JSON.stringify({
        error: {
          message: "The 'deepseek-v4-flash' model is not supported when using Codex with a ChatGPT account.",
          type: 'invalid_request_error',
        },
      }),
      'openai-adapter',
    )
    expect(err.bodyCode).toBe('invalid_request_error')
    expect(isRetryableError(err)).toBe(false)
  })

  it('treats DashScope data_inspection_failed (content moderation) as non-retryable', async () => {
    // 阿里云百炼把内容审核拦截塞进 HTTP 400 + `{error:{code:"data_inspection_failed"}}`。
    // 重试 10 次会原样重发被拦的输入 → 必须 fail-fast。
    const err = new HttpResponseError(
      400,
      JSON.stringify({
        error: {
          code: 'data_inspection_failed',
          param: null,
          message: 'Input text data may contain inappropriate content.',
          type: 'data_inspection_failed',
        },
        id: 'chatcmpl-test',
      }),
      'openai-adapter',
    )
    expect(err.bodyCode).toBe('data_inspection_failed')
    expect(isRetryableError(err)).toBe(false)
  })

  it('falls back to top-level body code when error.code is absent', async () => {
    const err = new HttpResponseError(
      400,
      JSON.stringify({ code: 'server_is_overloaded', message: 'overloaded' }),
      'test',
    )
    expect(err.bodyCode).toBe('server_is_overloaded')
  })

  it('treats HTTP 429 as retryable + backoff regardless of body', async () => {
    const err = new HttpResponseError(429, 'Too Many Requests', 'test')
    expect(isRetryableError(err)).toBe(true)
    expect(isOverloadedError(err)).toBe(true)
  })

  it('computeRetryDelayMs: fixed delay when useBackoff=false', () => {
    expect(computeRetryDelayMs(0, 1_000, false)).toBe(1_000)
    expect(computeRetryDelayMs(5, 1_000, false)).toBe(1_000)
  })

  it('computeRetryDelayMs: exponential growth capped at BACKOFF_MAX_DELAY_MS', () => {
    const base = 10_000
    expect(computeRetryDelayMs(0, base, true)).toBe(BACKOFF_MAX_DELAY_MS)
    expect(computeRetryDelayMs(3, base, true)).toBe(BACKOFF_MAX_DELAY_MS)
    expect(computeRetryDelayMs(0, 1_000, true)).toBe(1_000)
    expect(computeRetryDelayMs(1, 1_000, true)).toBe(2_000)
    expect(computeRetryDelayMs(2, 1_000, true)).toBe(4_000)
    expect(computeRetryDelayMs(3, 1_000, true)).toBe(8_000)
    expect(computeRetryDelayMs(4, 1_000, true)).toBe(8_000)
  })

  it('withRetry: surfaces backoff delay via onRetry callback for overloaded errors', async () => {
    const calls: number[] = []
    const baseDelay = 100
    let attempts = 0

    const result = await withRetry(
      'test',
      async () => {
        attempts += 1
        if (attempts < 3) {
          throw new HttpResponseError(
            400,
            JSON.stringify({ code: 'server_is_overloaded' }),
            'test',
          )
        }
        return 'ok'
      },
      {
        delayMs: baseDelay,
        maxRetries: 5,
        onRetry: (e) => calls.push(e.delayMs),
      },
    )

    expect(result).toBe('ok')
    expect(attempts).toBe(3)
    // attempt 0 delay = base; attempt 1 delay = base*2
    expect(calls).toHaveLength(2)
    expect(calls[0]).toBe(baseDelay)
    expect(calls[1]).toBe(baseDelay * 2)
  })

  it('withRetry: uses exponential backoff for non-overloaded retryable (network) errors', async () => {
    // 网络错误（ECONNRESET 等）与过载错误一样走指数退避。
    // attempt 0 delay = base; attempt 1 delay = base*2
    const calls: number[] = []
    const baseDelay = 50
    let attempts = 0

    await withRetry(
      'test',
      async () => {
        attempts += 1
        if (attempts < 3) {
          const inner = Object.assign(new Error('socket'), { code: 'ECONNRESET' })
          throw Object.assign(new TypeError('terminated'), { cause: inner })
        }
        return 'ok'
      },
      {
        delayMs: baseDelay,
        maxRetries: 5,
        onRetry: (e) => calls.push(e.delayMs),
      },
    )

    expect(calls).toHaveLength(2)
    expect(calls[0]).toBe(baseDelay)
    expect(calls[1]).toBe(baseDelay * 2)
  })

  it('honors maxRetries cap when failures keep happening pre-material', async () => {
    let attempts = 0

    const stream = streamWithRetry<Chunk>(
      'test',
      async function* () {
        attempts += 1
        yield { type: 'message_start' } as Chunk
        throw makeRetryableError()
      },
      { isMaterial, delayMs: 1, maxRetries: 2 },
    )

    await expect(async () => {
      for await (const _chunk of stream) {
        // drain
      }
    }).rejects.toThrow(/terminated/)

    expect(attempts).toBe(3)
  })
  it('withRetry: uses capped exponential backoff for network errors', async () => {
    const delays: number[] = []
    let attempts = 0
    await expect(
      withRetry(
        'test',
        async () => { attempts += 1; throw makeRetryableError() },
        {
          delayMs: 20,
          maxRetries: 5,
          onRetry: (e) => delays.push(e.delayMs),
        },
      ),
    ).rejects.toThrow('terminated')
    expect(attempts).toBe(6)
    expect(delays).toEqual([20, 40, 80, 160, 320])
  })
})
