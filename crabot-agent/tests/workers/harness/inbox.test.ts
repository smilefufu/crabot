import { describe, it, expect, vi } from 'vitest'
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

  it('drain 在 flush 卡在 deliver 期间调用,不把 in-flight 条目重复计入 dead-letter', async () => {
    // PoC(评审复现):flush 卡在 deliver('a') 时若 drain 直接 this.queue = [] 重新赋值,
    // 会把正在被投递的 'a' 也当作"未投递"一并 drain 出去;'a' 随后投递成功,导致它
    // 既被真正投递、又混进 dead-letter 批次 —— 调用方按注释重投 dead-letter 时 'a' 被投两次。
    const inbox = new WorkerInbox('worker-1')
    inbox.enqueue(makeItem('a'))
    inbox.enqueue(makeItem('b'))
    inbox.enqueue(makeItem('c'))

    let releaseDeliverA!: () => void
    const deliverAGate = new Promise<void>((resolve) => {
      releaseDeliverA = resolve
    })
    const delivered: string[] = []

    const flushPromise = inbox.flush(async (item) => {
      if (item.text === 'a') {
        await deliverAGate // 卡住,模拟 deliver('a') 长时间不返回(如 tmux 命令挂起)
      }
      delivered.push(item.text)
    })

    // 让出事件循环,确保 flush 已经进入 deliver('a') 并卡住
    await new Promise((resolve) => setTimeout(resolve, 10))

    const drained = inbox.drain()
    // 'a' 正在被投递中,不应出现在 drain 结果里;其成败由 flush 自己结算
    expect(drained.map((i) => i.text)).toEqual(['b', 'c'])
    expect(inbox.pending).toBe(0)

    releaseDeliverA()
    const count = await flushPromise

    // deliver('a') 最终成功,flush 的簿记应准确反映:只投了 'a' 一条,不重复、不丢
    expect(delivered).toEqual(['a'])
    expect(count).toBe(1)
  })

  it('drain 之后 in-flight 条目投递失败:不放回队列、不向上抛未捕获,仅告警', async () => {
    const inbox = new WorkerInbox('worker-1')
    inbox.enqueue(makeItem('a'))

    let rejectDeliverA!: (err: Error) => void
    const deliverAGate = new Promise<void>((_resolve, reject) => {
      rejectDeliverA = reject
    })
    const boom = new Error('deliver failed on a after drain')

    const flushPromise = inbox.flush(async (item) => {
      if (item.text === 'a') {
        await deliverAGate
      }
    })

    await new Promise((resolve) => setTimeout(resolve, 10))

    const drained = inbox.drain()
    expect(drained).toEqual([])

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    rejectDeliverA(boom)

    // 化身已终结(已 drain),该条已无投递目标:flush 不应把此失败向上抛出
    await expect(flushPromise).resolves.toBe(0)
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(inbox.pending).toBe(0)

    warnSpy.mockRestore()
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
