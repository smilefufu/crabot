import { describe, it, expect, vi } from 'vitest'
import { SessionLane, SessionLaneRegistry } from '../../src/orchestration/session-lane.js'

describe('SessionLane', () => {
  it('单条 enqueue → handler 收到 batch=[item1]', async () => {
    const handler = vi.fn().mockResolvedValue(undefined)
    const onDispose = vi.fn()
    const lane = new SessionLane<string>('key-a', handler, onDispose)
    lane.enqueue('a')
    // 等微任务队列：enqueue 内部 void kick，需等一个 await tick
    await new Promise(setImmediate)
    expect(handler).toHaveBeenCalledTimes(1)
    expect(handler.mock.calls[0][0]).toEqual(['a'])
  })

  it('handler 处理期间 enqueue 的消息合并到下一批', async () => {
    let resolveFirst: () => void = () => {}
    const firstReady = new Promise<void>(r => { resolveFirst = r })
    const calls: string[][] = []
    const handler = vi.fn().mockImplementation(async (batch: string[]) => {
      calls.push([...batch])
      if (calls.length === 1) await firstReady  // 第一批阻塞
    })
    const lane = new SessionLane<string>('k', handler, vi.fn())

    lane.enqueue('a')                         // 触发第一批
    await new Promise(setImmediate)
    lane.enqueue('b')                         // 第一批还在跑，进队列
    lane.enqueue('c')                         // 同上
    resolveFirst()                            // 放开第一批
    await new Promise(setImmediate)
    await new Promise(setImmediate)           // 等第二批 take + handler 完成

    expect(calls).toEqual([['a'], ['b', 'c']])
  })

  it('handler throw 不阻塞下一批，并写 console.error', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const calls: string[][] = []
    const handler = vi.fn().mockImplementation(async (batch: string[]) => {
      calls.push([...batch])
      if (calls.length === 1) throw new Error('boom')
    })
    const lane = new SessionLane<string>('k', handler, vi.fn())
    lane.enqueue('a')
    await new Promise(setImmediate)
    lane.enqueue('b')
    await new Promise(setImmediate)
    await new Promise(setImmediate)
    expect(calls).toEqual([['a'], ['b']])
    expect(errSpy).toHaveBeenCalled()
    errSpy.mockRestore()
  })

  it('处理完且队列空时调 onDispose', async () => {
    const onDispose = vi.fn()
    const lane = new SessionLane<string>('k', async () => {}, onDispose)
    lane.enqueue('a')
    await new Promise(setImmediate)
    expect(onDispose).toHaveBeenCalledWith('k')
  })

  it('isIdle 在空 + 非处理时为 true', async () => {
    const lane = new SessionLane<string>('k', async () => {}, vi.fn())
    expect(lane.isIdle()).toBe(true)
    lane.enqueue('a')
    await new Promise(setImmediate)
    expect(lane.isIdle()).toBe(true)
  })

  it('同一 tick 内多条 enqueue 合并为一批', async () => {
    let firstResolve: () => void = () => {}
    const firstReady = new Promise<void>(r => { firstResolve = r })
    const calls: string[][] = []
    const handler = vi.fn().mockImplementation(async (batch: string[]) => {
      calls.push([...batch])
      if (calls.length === 1) await firstReady  // 第一批阻塞，不返回
    })
    const lane = new SessionLane<string>('k', handler, vi.fn())

    // 第一批开始处理（但会阻塞）
    lane.enqueue('a')
    await new Promise(setImmediate)
    // 现在 processing=true；后续 enqueue 会进队列

    // 同一 tick 内多条
    lane.enqueue('b')
    lane.enqueue('c')
    // 不 await，继续同步
    lane.enqueue('d')

    // 确保 kick 来不及跑（processing 仍是 true）
    expect(calls).toEqual([['a']])

    // 放开第一批
    firstResolve()
    await new Promise(setImmediate)
    await new Promise(setImmediate)

    // 第二批应该是 b/c/d 合并
    expect(calls).toEqual([['a'], ['b', 'c', 'd']])
  })

  it('snapshot 同时返回当前 batch 和后续队列，读取不消费或重排', async () => {
    let release: () => void = () => {}
    const blocker = new Promise<void>(resolve => { release = resolve })
    const calls: string[][] = []
    const lane = new SessionLane<string>(
      'k',
      async (batch) => {
        calls.push([...batch])
        if (calls.length === 1) await blocker
      },
      vi.fn(),
    )

    lane.enqueue('a')
    await new Promise(setImmediate)
    lane.enqueue('b')
    lane.enqueue('c')

    const snapshot = lane.snapshot()
    expect(snapshot).toEqual({ current: ['a'], queued: ['b', 'c'] })
    snapshot.current.splice(0)
    snapshot.queued.reverse()

    expect(lane.snapshot()).toEqual({ current: ['a'], queued: ['b', 'c'] })
    release()
    await new Promise(setImmediate)
    await new Promise(setImmediate)
    expect(calls).toEqual([['a'], ['b', 'c']])
  })
})

describe('SessionLaneRegistry', () => {
  it('getOrCreate 同 key 返回同一 lane', () => {
    const registry = new SessionLaneRegistry<string>(async () => {})
    const a = registry.getOrCreate('k')
    const b = registry.getOrCreate('k')
    expect(a).toBe(b)
    expect(registry.size()).toBe(1)
  })

  it('不同 key 的 handler 完全并行', async () => {
    let firstStarted = 0
    let firstResolve: () => void = () => {}
    const blocker = new Promise<void>(r => { firstResolve = r })
    const order: string[] = []
    const registry = new SessionLaneRegistry<string>(async (batch) => {
      order.push(`start-${batch[0]}`)
      firstStarted++
      if (batch[0] === 'lane-a-item') await blocker
      order.push(`end-${batch[0]}`)
    })
    registry.getOrCreate('lane-a').enqueue('lane-a-item')
    await new Promise(setImmediate)
    registry.getOrCreate('lane-b').enqueue('lane-b-item')
    await new Promise(setImmediate)
    await new Promise(setImmediate)
    expect(order).toEqual(['start-lane-a-item', 'start-lane-b-item', 'end-lane-b-item'])
    expect(firstStarted).toBe(2)
    firstResolve()
  })

  it('lane 处理完后自我注销，再次 enqueue 会重建', async () => {
    const registry = new SessionLaneRegistry<string>(async () => {})
    const first = registry.getOrCreate('k')
    first.enqueue('a')
    await new Promise(setImmediate)
    expect(registry.size()).toBe(0)
    const second = registry.getOrCreate('k')
    expect(second).not.toBe(first)
    expect(registry.size()).toBe(1)
  })

  it('snapshot 只读取 exact key，未知或已注销 lane 返回空快照', async () => {
    let release: () => void = () => {}
    const blocker = new Promise<void>(resolve => { release = resolve })
    const registry = new SessionLaneRegistry<string>(async () => blocker)
    registry.getOrCreate('target').enqueue('a')
    await new Promise(setImmediate)

    expect(registry.snapshot('target')).toEqual({ current: ['a'], queued: [] })
    expect(registry.snapshot('other')).toEqual({ current: [], queued: [] })

    release()
    await new Promise(setImmediate)
    expect(registry.snapshot('target')).toEqual({ current: [], queued: [] })
  })
})
