import { describe, it, expect } from 'vitest'
import {
  classifySubAgentError,
  buildSubAgentFailureOutput,
} from '../../src/agent/subagent-error-classifier.js'

function apiError(status: number, body: unknown, message?: string): Error {
  const err = new Error(message ?? `${status} ${JSON.stringify(body)}`) as Error & {
    status?: number
    error?: unknown
  }
  err.status = status
  err.error = body
  return err
}

describe('classifySubAgentError', () => {
  describe('quota（不可重试，月度/计费周期耗尽）', () => {
    it('Kimi 403 permission_error + usage limit → quota', () => {
      const err = apiError(
        403,
        { error: { type: 'permission_error', message: "You've reached your usage limit for this billing cycle." } },
        '403 permission_error: usage limit reached',
      )
      const c = classifySubAgentError(err)
      expect(c.kind).toBe('quota')
      expect(c.retryable).toBe(false)
      expect(c.hint).toMatch(/不要重试|do not retry/i)
    })

    it('message 含 "quota" 关键字（无 status） → quota', () => {
      const c = classifySubAgentError(new Error('Provider quota exceeded for this month'))
      expect(c.kind).toBe('quota')
      expect(c.retryable).toBe(false)
    })

    it('billing cycle 关键词 → quota', () => {
      const c = classifySubAgentError(new Error('reached limit for this billing cycle'))
      expect(c.kind).toBe('quota')
    })
  })

  describe('auth（不可重试，credential 问题）', () => {
    it('401 + invalid_api_key → auth', () => {
      const err = apiError(401, { error: { type: 'invalid_api_key', message: 'bad key' } })
      const c = classifySubAgentError(err)
      expect(c.kind).toBe('auth')
      expect(c.retryable).toBe(false)
    })

    it('authentication_error 关键词 → auth', () => {
      const c = classifySubAgentError(new Error('401 authentication_error: token expired'))
      expect(c.kind).toBe('auth')
      expect(c.retryable).toBe(false)
    })
  })

  describe('rate_limit（短期不可重试，可后退）', () => {
    it('429 rate_limit_error → rate_limit', () => {
      const err = apiError(429, { error: { type: 'rate_limit_error' } })
      const c = classifySubAgentError(err)
      expect(c.kind).toBe('rate_limit')
      expect(c.retryable).toBe(true)
    })
  })

  describe('model_error（服务端/上游问题）', () => {
    it('503 overloaded_error → model_error', () => {
      const err = apiError(503, { error: { type: 'overloaded_error' } })
      const c = classifySubAgentError(err)
      expect(c.kind).toBe('model_error')
      expect(c.retryable).toBe(true)
    })

    it('500 + 任意 message → model_error', () => {
      const err = apiError(500, { error: { type: 'api_error' } }, '500 internal server error')
      const c = classifySubAgentError(err)
      expect(c.kind).toBe('model_error')
    })

    it.each([
      'Subagent LLM 调用失败: HTTP 502: Bad Gateway',
      'Subagent LLM 调用失败: HTTP 503: upstream connect error',
      'Service temporarily unavailable. Please try again later.',
    ])('字符串化上游错误 %s → model_error', (message) => {
      const c = classifySubAgentError(new Error(message))
      expect(c.kind).toBe('model_error')
      expect(c.retryable).toBe(true)
    })
  })

  describe('timeout / abort', () => {
    it('AbortError → timeout', () => {
      const err = new Error('The operation was aborted')
      err.name = 'AbortError'
      const c = classifySubAgentError(err)
      expect(c.kind).toBe('timeout')
    })

    it('message 含 ETIMEDOUT → timeout', () => {
      const c = classifySubAgentError(new Error('connect ETIMEDOUT 1.2.3.4:443'))
      expect(c.kind).toBe('timeout')
    })
  })

  describe('network', () => {
    it('ECONNRESET → network', () => {
      const c = classifySubAgentError(new Error('socket hang up: ECONNRESET'))
      expect(c.kind).toBe('network')
    })

    it('ENOTFOUND → network', () => {
      const c = classifySubAgentError(new Error('getaddrinfo ENOTFOUND api.example.com'))
      expect(c.kind).toBe('network')
    })
  })

  describe('unknown', () => {
    it('无 status + 无关键字 → unknown', () => {
      const c = classifySubAgentError(new Error('something weird happened'))
      expect(c.kind).toBe('unknown')
      // unknown 仍可重试，但 hint 要指明先看 trace
      expect(c.hint.length).toBeGreaterThan(0)
    })

    it('非 Error 值（string）→ unknown，不抛异常', () => {
      const c = classifySubAgentError('boom')
      expect(c.kind).toBe('unknown')
    })

    it('null / undefined → unknown，不抛异常', () => {
      expect(classifySubAgentError(null).kind).toBe('unknown')
      expect(classifySubAgentError(undefined).kind).toBe('unknown')
    })
  })

  describe('summary / hint 内容', () => {
    it('每个 kind 的 summary 是非空中文短句', () => {
      const cases = [
        new Error('quota exceeded for this billing cycle'),
        new Error('401 authentication_error'),
        new Error('weird unknown thing'),
      ]
      for (const e of cases) {
        const c = classifySubAgentError(e)
        expect(c.summary.length).toBeGreaterThan(0)
        expect(c.hint.length).toBeGreaterThan(0)
      }
    })
  })
})

describe('buildSubAgentFailureOutput', () => {
  const baseCtx = {
    subagentName: 'code_writer',
    providerEndpoint: 'https://api.kimi.com/coding',
    model: 'kimi-for-coding',
  }

  it('quota 错误：返回 error_kind=quota + retryable=false + 含 subagent / model / endpoint', () => {
    const out = buildSubAgentFailureOutput({
      ...baseCtx,
      errorSource: new Error("403 permission_error: You've reached your usage limit for this billing cycle"),
    })
    expect(out.outcome).toBe('failed')
    expect(out.error_kind).toBe('quota')
    expect(out.retryable).toBe(false)
    expect(out.subagent).toBe('code_writer')
    expect(out.model).toBe('kimi-for-coding')
    expect(out.provider_endpoint).toBe('https://api.kimi.com/coding')
    expect(out.hint).toMatch(/不要重试|do not retry/i)
  })

  it('带 partialOutput / totalTurns / childTraceId 时一并塞入', () => {
    const out = buildSubAgentFailureOutput({
      ...baseCtx,
      errorSource: new Error('boom'),
      partialOutput: 'already wrote some markdown',
      totalTurns: 3,
      childTraceId: 'trace-abc',
    })
    expect(out.partial_output).toBe('already wrote some markdown')
    expect(out.totalTurns).toBe(3)
    expect(out.child_trace_id).toBe('trace-abc')
  })

  it('error_message 截断到 500 字符以内', () => {
    const long = 'x'.repeat(2000)
    const out = buildSubAgentFailureOutput({
      ...baseCtx,
      errorSource: new Error(long),
    })
    expect(out.error_message.length).toBeLessThanOrEqual(500)
  })

  it('JSON.stringify 后是合法 JSON，且字段顺序可读', () => {
    const out = buildSubAgentFailureOutput({
      ...baseCtx,
      errorSource: new Error('socket hang up: ECONNRESET'),
      childTraceId: 't-1',
    })
    const json = JSON.stringify(out)
    const parsed = JSON.parse(json)
    expect(parsed.outcome).toBe('failed')
    expect(parsed.error_kind).toBe('network')
    expect(parsed.subagent).toBe('code_writer')
    expect(parsed.child_trace_id).toBe('t-1')
  })

  it('无 partialOutput / totalTurns / childTraceId 时这些字段不出现', () => {
    const out = buildSubAgentFailureOutput({
      ...baseCtx,
      errorSource: new Error('weird'),
    })
    expect(out).not.toHaveProperty('partial_output')
    expect(out).not.toHaveProperty('totalTurns')
    expect(out).not.toHaveProperty('child_trace_id')
  })
})
