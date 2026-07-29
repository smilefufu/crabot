import { describe, it, expect } from 'vitest'
import { WorkerInbox, type InboxItem } from '../../../src/workers/harness/inbox'

function makeItem(text: string, overrides: Partial<InboxItem> = {}): InboxItem {
  return { text, raw: false, enqueued_at: new Date().toISOString(), ...overrides }
}

describe('WorkerInbox', () => {
  it('enqueue 返回入队后的待投条数', () => {
    const inbox = new WorkerInbox('worker-1')
    expect(inbox.enqueue(makeItem('a'))).toBe(1)
    expect(inbox.enqueue(makeItem('b'))).toBe(2)
    expect(inbox.pending).toBe(2)
  })

  it('hold 期间 flush 不投递', async () => {
    const inbox = new WorkerInbox('worker-1')
    inbox.enqueue(makeItem('a'))
    inbox.enqueue(makeItem('b'))
    inbox.hold('provisioning')
    expect(inbox.held).toBe(true)

    const delivered: string[] = []
    const count = await inbox.flush(async (item) => {
      delivered.push(item.text)
    })

    expect(count).toBe(0)
    expect(delivered).toEqual([])
    expect(inbox.pending).toBe(2)
  })

  it('release 后按序补投', async () => {
    const inbox = new WorkerInbox('worker-1')
    inbox.hold('handoff')
    inbox.enqueue(makeItem('a'))
    inbox.enqueue(makeItem('b'))
    inbox.enqueue(makeItem('c'))

    const heldCount = await inbox.flush(async () => {
      throw new Error('should not be called while held')
    })
    expect(heldCount).toBe(0)

    inbox.release()
    expect(inbox.held).toBe(false)

    const delivered: string[] = []
    const count = await inbox.flush(async (item) => {
      delivered.push(item.text)
    })

    expect(count).toBe(3)
    expect(delivered).toEqual(['a', 'b', 'c'])
    expect(inbox.pending).toBe(0)
  })

  it('deliver 抛错时该条不丢、留在队首、后续不投,并原样抛出', async () => {
    const inbox = new WorkerInbox('worker-1')
    inbox.enqueue(makeItem('a'))
    inbox.enqueue(makeItem('b'))
    inbox.enqueue(makeItem('c'))

    const delivered: string[] = []
    const boom = new Error('deliver failed on b')
    let thrown: unknown

    try {
      await inbox.flush(async (item) => {
        if (item.text === 'b') throw boom
        delivered.push(item.text)
      })
    } catch (err) {
      thrown = err
    }

    expect(thrown).toBe(boom)
    // a 已成功投递;b 失败留队首;c 未投
    expect(delivered).toEqual(['a'])
    expect(inbox.pending).toBe(2)
    expect(inbox.drain().map((i) => i.text)).toEqual(['b', 'c'])
  })

  it('deliver 抛错后重新 flush 从失败条目续投(不重复投已成功的)', async () => {
    const inbox = new WorkerInbox('worker-1')
    inbox.enqueue(makeItem('a'))
    inbox.enqueue(makeItem('b'))

    let failOnce = true
    const delivered: string[] = []
    await expect(
      inbox.flush(async (item) => {
        if (item.text === 'b' && failOnce) {
          failOnce = false
          throw new Error('transient')
        }
        delivered.push(item.text)
      })
    ).rejects.toThrow('transient')

    expect(delivered).toEqual(['a'])
    expect(inbox.pending).toBe(1)

    const count = await inbox.flush(async (item) => {
      delivered.push(item.text)
    })
    expect(count).toBe(1)
    expect(delivered).toEqual(['a', 'b'])
    expect(inbox.pending).toBe(0)
  })

  it('并发 flush 不重复投递同一 item', async () => {
    const inbox = new WorkerInbox('worker-1')
    const items = ['a', 'b', 'c', 'd']
    for (const text of items) inbox.enqueue(makeItem(text))

    const delivered: string[] = []
    const deliver = async (item: InboxItem) => {
      // 制造重叠窗口,模拟两个并发 flush 调用交叠执行
      await new Promise((resolve) => setTimeout(resolve, 5))
      delivered.push(item.text)
    }

    const [count1, count2] = await Promise.all([inbox.flush(deliver), inbox.flush(deliver)])

    expect(delivered).toEqual(items)
    expect(new Set(delivered).size).toBe(items.length)
    expect(count1 + count2).toBe(items.length)
    expect(inbox.pending).toBe(0)
  })

  it('flush 途中再次被 hold 则停止本轮,已入队未投的保留', async () => {
    const inbox = new WorkerInbox('worker-1')
    inbox.enqueue(makeItem('a'))
    inbox.enqueue(makeItem('b'))
    inbox.enqueue(makeItem('c'))

    const delivered: string[] = []
    const count = await inbox.flush(async (item) => {
      delivered.push(item.text)
      if (item.text === 'a') inbox.hold('modal-detected')
    })

    expect(count).toBe(1)
    expect(delivered).toEqual(['a'])
    expect(inbox.held).toBe(true)
    expect(inbox.pending).toBe(2)
    expect(inbox.drain().map((i) => i.text)).toEqual(['b', 'c'])
  })

  it('drain 取出全部并清空队列', () => {
    const inbox = new WorkerInbox('worker-1')
    inbox.enqueue(makeItem('a'))
    inbox.enqueue(makeItem('b'))

    const items = inbox.drain()
    expect(items.map((i) => i.text)).toEqual(['a', 'b'])
    expect(inbox.pending).toBe(0)
    expect(inbox.drain()).toEqual([])
  })
})
