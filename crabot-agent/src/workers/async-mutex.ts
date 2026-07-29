/**
 * AsyncMutex — minimal in-process mutex for serializing async operations.
 * Extracted from BgEntityRegistry for general use.
 */

export class AsyncMutex {
  private queue: Promise<void> = Promise.resolve()

  async run<T>(fn: () => Promise<T>): Promise<T> {
    let release!: () => void
    const next = new Promise<void>((resolve) => {
      release = resolve
    })
    const previous = this.queue
    this.queue = previous.then(() => next)
    await previous
    try {
      return await fn()
    } finally {
      release()
    }
  }
}
