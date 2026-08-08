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

  it('deduplicates a durable item while it is queued or in flight', async () => {
    const inbox = new WorkerInbox('worker-1')
    const first = makeItem('first', { dedupe_key: 'bg-shell:1' })
    const duplicate = makeItem('duplicate', { dedupe_key: 'bg-shell:1' })

    expect(inbox.enqueueUnique(first)).toBe(true)
    expect(inbox.enqueueUnique(duplicate)).toBe(false)

    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const flush = inbox.flush(async () => { await gate })
    await new Promise<void>((resolve) => setImmediate(resolve))

    expect(inbox.enqueueUnique(duplicate)).toBe(false)
    release()
    await flush
    expect(inbox.pending).toBe(0)
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

  it('settles a system item only after real delivery, not while held', async () => {
    const inbox = new WorkerInbox('worker-1')
    const settled = vi.fn()
    inbox.hold('provisioning')
    inbox.enqueue(makeItem('bg', { onSettled: settled }))

    await inbox.flush(async () => undefined)
    expect(settled).not.toHaveBeenCalled()

    inbox.release()
    await inbox.flush(async () => undefined)
    expect(settled).toHaveBeenCalledOnce()
    expect(settled).toHaveBeenCalledWith('delivered')
  })

  it('settlement persistence failure does not requeue an already delivered item', async () => {
    const inbox = new WorkerInbox('worker-1')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    inbox.enqueue(makeItem('bg', {
      onSettled: vi.fn().mockRejectedValue(new Error('registry write failed')),
    }))

    const delivered: string[] = []
    await expect(inbox.flush(async (item) => { delivered.push(item.text) })).resolves.toBe(1)

    expect(delivered).toEqual(['bg'])
    expect(inbox.pending).toBe(0)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('settlement callback failed'), expect.any(Error))
    warn.mockRestore()
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

  it('waiting_action hold lets the earliest raw control item bypass ordinary FIFO items', async () => {
    const inbox = new WorkerInbox('worker-1')
    inbox.enqueue(makeItem('normal-a'))
    inbox.enqueue(makeItem('normal-b'))
    inbox.enqueue(makeItem('Enter', { raw: true }))
    inbox.hold('waiting_action')
    const delivered: string[] = []
    await inbox.flush(async (item) => { delivered.push(item.text) })
    expect(delivered).toEqual(['Enter'])
    expect(inbox.pending).toBe(2)
    inbox.release('waiting_action')
    await inbox.flush(async (item) => { delivered.push(item.text) })
    expect(delivered).toEqual(['Enter', 'normal-a', 'normal-b'])
  })

  it('an exclusive hold keeps raw controls out of the pane', async () => {
    const inbox = new WorkerInbox('worker-1')
    inbox.enqueue(makeItem('Enter', { raw: true }))
    inbox.hold('provisioning')
    const delivered: string[] = []
    await inbox.flush(async (item) => { delivered.push(item.text) })
    expect(delivered).toEqual([])
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

  it('drain 之后 in-flight 条目投递失败:不放回队列、不向上抛未捕获,结算 dead-letter 并告警', async () => {
    const inbox = new WorkerInbox('worker-1')
    const settled = vi.fn()
    inbox.enqueue(makeItem('a', { onSettled: settled }))

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
    expect(settled).toHaveBeenCalledWith('dead_letter')
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(inbox.pending).toBe(0)

    warnSpy.mockRestore()
  })

  it('drain 之后 in-flight 条目返回hold_requeue：不把已终结化身的文本复活回队列', async () => {
    const inbox = new WorkerInbox('worker-1')
    inbox.enqueue(makeItem('a'))

    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const flushPromise = inbox.flush(async () => {
      await gate
      return { action: 'hold_requeue', reason: 'waiting_action' }
    })

    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(inbox.drain()).toEqual([])
    release()
    await expect(flushPromise).resolves.toBe(0)
    expect(inbox.pending).toBe(0)
  })

  it('drain → enqueue → flush 且 deliver 失败:新条目应当抛出、留队首(仅吞 drain 当刻的 in-flight)', async () => {
    // 复审 Minor:drain 之后的 enqueue('z') 若投递失败,本应抛出且保留队首,
    // 但当前实现因为 _drained 永久粘性,会错误地吞掉错误。
    // 修复:只吞 drain 当刻的那个 in-flight 条目,post-drain enqueue 走正常语义。
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

    // drain 当刻 'a' 在 in-flight 中
    inbox.drain()

    // post-drain 新入队
    inbox.enqueue(makeItem('z'))
    expect(inbox.pending).toBe(1) // drain 后队列是空的,'z' 是新的第一条

    // 让 'a' 的投递失败(drain 当刻的 in-flight)
    rejectDeliverA(boom)
    await expect(flushPromise).resolves.toBe(0) // 'a' 是 drain 当刻的 in-flight,吞掉错误

    // 现在尝试投递 'z'(post-drain 新条目)
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const boomZ = new Error('deliver failed on z')

    const delivered: string[] = []
    let thrown: unknown
    try {
      await inbox.flush(async (item) => {
        if (item.text === 'z') throw boomZ
        delivered.push(item.text)
      })
    } catch (err) {
      thrown = err
    }

    // 'z' 是 post-drain 新条目,失败应当抛出(不被 _drained 吞掉)
    expect(thrown).toBe(boomZ)
    expect(delivered).toEqual([])
    expect(inbox.pending).toBe(1) // 'z' 应放回队首
    expect(warnSpy).not.toHaveBeenCalled() // 不应告警(仅 drain 当刻的 in-flight 才告警)

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
