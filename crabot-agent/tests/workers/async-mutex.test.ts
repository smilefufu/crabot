import { describe, it, expect } from 'vitest'
import { AsyncMutex } from '../../src/workers/async-mutex'

describe('AsyncMutex', () => {
  it('should serialize two concurrent run() calls', async () => {
    const mutex = new AsyncMutex()
    const order: string[] = []

    const fn1 = async () => {
      order.push('fn1-enter')
      await new Promise((resolve) => setTimeout(resolve, 50))
      order.push('fn1-exit')
      return 'result1'
    }

    const fn2 = async () => {
      order.push('fn2-enter')
      await new Promise((resolve) => setTimeout(resolve, 50))
      order.push('fn2-exit')
      return 'result2'
    }

    // Start both concurrently
    const [result1, result2] = await Promise.all([
      mutex.run(fn1),
      mutex.run(fn2),
    ])

    expect(result1).toBe('result1')
    expect(result2).toBe('result2')

    // Verify serialization: no interleaving
    // fn1 should complete before fn2 starts
    expect(order).toEqual([
      'fn1-enter',
      'fn1-exit',
      'fn2-enter',
      'fn2-exit',
    ])
  })

  it('should not deadlock and allow retry after error', async () => {
    const mutex = new AsyncMutex()
    const order: string[] = []

    const failingFn = async () => {
      order.push('failing-enter')
      await new Promise((resolve) => setTimeout(resolve, 20))
      order.push('failing-exit')
      throw new Error('intentional error')
    }

    const successFn = async () => {
      order.push('success-enter')
      order.push('success-exit')
      return 'success'
    }

    // First call throws error
    let error: Error | null = null
    try {
      await mutex.run(failingFn)
    } catch (e) {
      error = e as Error
    }

    expect(error).not.toBeNull()
    expect(error?.message).toBe('intentional error')

    // Second call should still execute (not deadlocked)
    const result = await mutex.run(successFn)
    expect(result).toBe('success')

    // Verify order: failing function completes (even with error),
    // then success function executes
    expect(order).toEqual([
      'failing-enter',
      'failing-exit',
      'success-enter',
      'success-exit',
    ])
  })
})
