import { describe, it, expect, vi } from 'vitest'
import { HumanMessageQueue } from '../../src/engine/human-message-queue'

describe('HumanMessageQueue', () => {
  describe('basic push/drain', () => {
    it('drainPending returns empty array when no messages', () => {
      const queue = new HumanMessageQueue()
      expect(queue.drainPending()).toEqual([])
    })

    it('drainPending returns all pushed messages and clears queue', () => {
      const queue = new HumanMessageQueue()
      queue.push('msg1')
      queue.push('msg2')
      expect(queue.drainPending()).toEqual(['msg1', 'msg2'])
      expect(queue.drainPending()).toEqual([])
    })

    it('hasPending reflects queue state', () => {
      const queue = new HumanMessageQueue()
      expect(queue.hasPending).toBe(false)
      queue.push('msg')
      expect(queue.hasPending).toBe(true)
      queue.drainPending()
      expect(queue.hasPending).toBe(false)
    })
  })

  describe('dequeue (async)', () => {
    it('dequeue resolves immediately when messages are pending', async () => {
      const queue = new HumanMessageQueue()
      queue.push('msg1')
      const result = await queue.dequeue()
      expect(result).toBe('msg1')
    })

    it('dequeue waits until push is called', async () => {
      const queue = new HumanMessageQueue()
      const promise = queue.dequeue()
      setTimeout(() => queue.push('delayed'), 10)
      const result = await promise
      expect(result).toBe('delayed')
    })
  })

  describe('broadcast to children', () => {
    it('push broadcasts to child queues', () => {
      const parent = new HumanMessageQueue()
      const child = parent.createChild()
      parent.push('broadcast msg')
      expect(child.drainPending()).toEqual(['broadcast msg'])
      expect(parent.drainPending()).toEqual(['broadcast msg'])
    })

    it('push broadcasts to multiple children', () => {
      const parent = new HumanMessageQueue()
      const child1 = parent.createChild()
      const child2 = parent.createChild()
      parent.push('msg')
      expect(child1.drainPending()).toEqual(['msg'])
      expect(child2.drainPending()).toEqual(['msg'])
    })

    it('removeChild stops broadcast', () => {
      const parent = new HumanMessageQueue()
      const child = parent.createChild()
      parent.removeChild(child)
      parent.push('msg after remove')
      expect(child.drainPending()).toEqual([])
      expect(parent.drainPending()).toEqual(['msg after remove'])
    })

    it('child push does NOT broadcast back to parent', () => {
      const parent = new HumanMessageQueue()
      const child = parent.createChild()
      child.push('child only')
      expect(parent.drainPending()).toEqual([])
      expect(child.drainPending()).toEqual(['child only'])
    })
  })

  describe('createChild with transform', () => {
    it('applies transform function to broadcast messages', () => {
      const parent = new HumanMessageQueue()
      const child = parent.createChild((content) => {
        const text = typeof content === 'string' ? content : '[media]'
        return `[transformed] ${text}`
      })
      parent.push('original msg')
      expect(child.drainPending()).toEqual(['[transformed] original msg'])
      expect(parent.drainPending()).toEqual(['original msg'])
    })

    it('transform receives ContentBlock[] and can convert', () => {
      const parent = new HumanMessageQueue()
      const child = parent.createChild((content) => {
        if (typeof content === 'string') return content
        return '[多媒体纠偏消息]'
      })
      const blocks = [{ type: 'text' as const, text: 'hello' }]
      parent.push(blocks)
      expect(child.drainPending()).toEqual(['[多媒体纠偏消息]'])
    })
  })

  describe('barrier', () => {
    it('hasBarrier is false by default', () => {
      const queue = new HumanMessageQueue()
      expect(queue.hasBarrier).toBe(false)
    })

    it('setBarrier makes hasBarrier true', () => {
      const queue = new HumanMessageQueue()
      queue.setBarrier(5000)
      expect(queue.hasBarrier).toBe(true)
    })

    it('clearBarrier makes hasBarrier false', () => {
      const queue = new HumanMessageQueue()
      queue.setBarrier(5000)
      queue.clearBarrier()
      expect(queue.hasBarrier).toBe(false)
    })

    it('waitBarrier resolves immediately when no barrier', async () => {
      const queue = new HumanMessageQueue()
      await queue.waitBarrier()  // should not hang
    })

    it('waitBarrier blocks until clearBarrier is called', async () => {
      const queue = new HumanMessageQueue()
      queue.setBarrier(5000)
      let resolved = false
      const promise = queue.waitBarrier().then(() => { resolved = true })
      // Should not resolve synchronously
      await Promise.resolve()
      expect(resolved).toBe(false)
      queue.clearBarrier()
      await promise
      expect(resolved).toBe(true)
    })

    it('push auto-clears barrier', async () => {
      const queue = new HumanMessageQueue()
      queue.setBarrier(5000)
      let resolved = false
      const promise = queue.waitBarrier().then(() => { resolved = true })
      await Promise.resolve()
      expect(resolved).toBe(false)
      queue.push('supplement msg')
      await promise
      expect(resolved).toBe(true)
      expect(queue.hasBarrier).toBe(false)
      expect(queue.hasPending).toBe(true)
    })

    it('barrier auto-clears on timeout', async () => {
      vi.useFakeTimers()
      try {
        const queue = new HumanMessageQueue()
        queue.setBarrier(100)
        let resolved = false
        const promise = queue.waitBarrier().then(() => { resolved = true })
        expect(resolved).toBe(false)
        vi.advanceTimersByTime(100)
        await promise
        expect(resolved).toBe(true)
        expect(queue.hasBarrier).toBe(false)
      } finally {
        vi.useRealTimers()
      }
    })

    it('setBarrier clears previous barrier before setting new one', () => {
      const queue = new HumanMessageQueue()
      queue.setBarrier(5000)
      queue.setBarrier(3000)
      expect(queue.hasBarrier).toBe(true)
      queue.clearBarrier()
      expect(queue.hasBarrier).toBe(false)
    })

    it('waitBarrier responds to AbortSignal', async () => {
      const queue = new HumanMessageQueue()
      queue.setBarrier(5000)
      const controller = new AbortController()
      let resolved = false
      const promise = queue.waitBarrier(controller.signal).then(() => { resolved = true })
      await Promise.resolve()
      expect(resolved).toBe(false)
      controller.abort()
      await promise
      expect(resolved).toBe(true)
      expect(queue.hasBarrier).toBe(false)
    })
  })
})
