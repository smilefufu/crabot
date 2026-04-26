import { describe, it, expect } from 'vitest'
import { streamWithRetry } from '../../src/engine/retry-utils'

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
})
