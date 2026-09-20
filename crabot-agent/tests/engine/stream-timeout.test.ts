import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest'
import { withStreamTimeout } from '../../src/engine/stream-timeout'
import { StreamTimeoutError, isRetryableError } from '../../src/engine/retry-utils'

/** 可被 signal 取消的延时；超时/取消时 reject AbortError */
function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('Aborted', 'AbortError'))
      return
    }
    const t = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => {
      clearTimeout(t)
      reject(new DOMException('Aborted', 'AbortError'))
    }, { once: true })
  })
}

async function drain<T>(gen: AsyncGenerator<T>, sink?: T[]): Promise<void> {
  for await (const c of gen) sink?.push(c)
}

describe('withStreamTimeout', () => {
  it('在超时内正常透传所有 chunk', async () => {
    const out: number[] = []
    await drain(
      withStreamTimeout<number>(async function* () { yield 1; yield 2; yield 3 }, undefined, { ttfbMs: 1000, idleMs: 1000 }),
      out,
    )
    expect(out).toEqual([1, 2, 3])
  })

  it('首 chunk 超 TTFB 未到 → StreamTimeoutError(ttfb)', async () => {
    const gen = withStreamTimeout<number>(
      async function* (signal) { await delay(1000, signal); yield 1 },
      undefined,
      { ttfbMs: 50, idleMs: 1000 },
    )
    await expect(drain(gen)).rejects.toMatchObject({ name: 'StreamTimeoutError', phase: 'ttfb' })
  })

  it('相邻 chunk 间隔超空闲阈值 → StreamTimeoutError(idle)，已收到的 chunk 保留', async () => {
    const out: number[] = []
    const gen = withStreamTimeout<number>(
      async function* (signal) { yield 1; await delay(1000, signal); yield 2 },
      undefined,
      { ttfbMs: 1000, idleMs: 50 },
    )
    await expect(drain(gen, out)).rejects.toMatchObject({ name: 'StreamTimeoutError', phase: 'idle' })
    expect(out).toEqual([1])
  })

  it('用户取消 → 原样抛 AbortError，不翻译成 StreamTimeoutError', async () => {
    const ctrl = new AbortController()
    const gen = withStreamTimeout<number>(
      async function* (signal) { await delay(1000, signal); yield 1 },
      ctrl.signal,
      { ttfbMs: 1000, idleMs: 1000 },
    )
    const p = drain(gen)
    ctrl.abort()
    let caught: unknown
    try { await p } catch (e) { caught = e }
    expect((caught as Error).name).toBe('AbortError')
    expect(caught).not.toBeInstanceOf(StreamTimeoutError)
  })

  it('StreamTimeoutError 被判定为可重试', () => {
    expect(isRetryableError(new StreamTimeoutError('ttfb', 90_000))).toBe(true)
    expect(isRetryableError(new StreamTimeoutError('idle', 120_000))).toBe(true)
  })
})

describe('default stream waiting budgets', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubEnv('CRABOT_STREAM_TTFB_MS', '')
    vi.stubEnv('CRABOT_STREAM_IDLE_MS', '')
    vi.resetModules()
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllEnvs()
  })

  it('waits through 100s and 599s, then aborts the underlying request at 600s', async () => {
    const { withStreamTimeout } = await import('../../src/engine/stream-timeout')
    let signal!: AbortSignal
    const result = drain(withStreamTimeout(async function* (s) {
      signal = s
      await delay(700_000, s)
      yield 1
    }, undefined)).catch(e => e)
    await vi.advanceTimersByTimeAsync(100_000)
    expect(signal.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(499_000)
    expect(signal.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(1000)
    expect(signal.aborted).toBe(true)
    expect(await result).toMatchObject({ name: 'StreamTimeoutError', phase: 'ttfb' })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('accepts a first chunk just before the ten-minute deadline and clears timers', async () => {
    const { withStreamTimeout } = await import('../../src/engine/stream-timeout')
    const out: number[] = []
    const result = drain(withStreamTimeout(async function* (signal) {
      await delay(599_000, signal)
      yield 1
    }, undefined), out).catch(e => e)
    await vi.advanceTimersByTimeAsync(599_000)
    expect(await result).toBeUndefined()
    expect(out).toEqual([1])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('switches to the unchanged 120s idle budget after a late first chunk', async () => {
    const { withStreamTimeout } = await import('../../src/engine/stream-timeout')
    const out: number[] = []
    const result = drain(withStreamTimeout(async function* (signal) {
      await delay(100_000, signal)
      yield 1
      await delay(200_000, signal)
      yield 2
    }, undefined), out).catch(e => e)
    await vi.advanceTimersByTimeAsync(219_999)
    expect(out).toEqual([1])
    await vi.advanceTimersByTimeAsync(1)
    expect(await result).toMatchObject({ name: 'StreamTimeoutError', phase: 'idle' })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('preserves explicit 90s overrides', async () => {
    const { withStreamTimeout } = await import('../../src/engine/stream-timeout')
    const result = drain(withStreamTimeout(async function* (signal) {
      await delay(100_000, signal)
      yield 1
    }, undefined, { ttfbMs: 90_000 })).catch(e => e)
    await vi.advanceTimersByTimeAsync(90_000)
    expect(await result).toMatchObject({ name: 'StreamTimeoutError', phase: 'ttfb' })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('honors cancellation while waiting and removes the task listener', async () => {
    const { withStreamTimeout } = await import('../../src/engine/stream-timeout')
    const ctrl = new AbortController()
    const remove = vi.spyOn(ctrl.signal, 'removeEventListener')
    const result = drain(withStreamTimeout(async function* (signal) {
      await delay(700_000, signal)
      yield 1
    }, ctrl.signal)).catch(e => e)
    await vi.advanceTimersByTimeAsync(100_000)
    ctrl.abort()
    expect(await result).toMatchObject({ name: 'AbortError' })
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function))
    expect(vi.getTimerCount()).toBe(0)
  })
})
