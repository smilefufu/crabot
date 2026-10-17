import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QueryClient } from '@tanstack/react-query'
import type { ChatMessage } from 'crabot-client'
import { ChatSnapshotController, setServerScope } from './server-state'

const message = (id: string, time = 0): ChatMessage => ({
  message_id: id, role: 'user', content: { type: 'text', text: id }, timestamp: new Date(time).toISOString(),
})
let cache: QueryClient
beforeEach(() => { setServerScope('browser'); cache = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } }) })
afterEach(() => cache.clear())

describe('HTTP snapshot authority', () => {
  it('includes updates/ack/tags and omits deleted messages; empty snapshots really clear history', async () => {
    const current = { ...message('kept'), acknowledged_at: '2026-10-17T00:00:00Z', task_id: 'task' }
    const history = vi.fn().mockResolvedValue([current])
    const controller = new ChatSnapshotController({ history, task: async () => null }, 'browser', cache)
    const snapshot = await controller.refresh([message('kept'), message('deleted')])
    expect(snapshot?.messages).toEqual([current])
    history.mockResolvedValue([])
    expect((await controller.refresh(snapshot!.messages))?.messages).toEqual([])
    controller.dispose()
  })
  it('covers an arbitrary offline gap and the oldest loaded timestamp without expanding into unrelated older history', async () => {
    const all = Array.from({ length: 100 }, (_, id) => message(String(99 - id), 99 - id))
    const history = vi.fn(async (limit: number) => all.slice(0, limit))
    const controller = new ChatSnapshotController({ history, task: async () => null }, 'browser', cache)
    const snapshot = await controller.refresh(all.slice(50, 80))
    expect(history.mock.calls.map(call => call[0])).toEqual([60, 120])
    expect(snapshot?.messages).toHaveLength(80)
    expect(snapshot?.messages.at(-1)?.message_id).toBe('20')
    expect(snapshot?.hasMore).toBe(true)
    controller.dispose()
  })
  it('does not lose messages sharing the page-boundary timestamp', async () => {
    const all = Array.from({ length: 70 }, (_, id) => message(String(id)))
    const controller = new ChatSnapshotController({ history: async limit => all.slice(0, limit), task: async () => null }, 'browser', cache)
    expect((await controller.refresh([]))?.messages).toHaveLength(70)
    controller.dispose()
  })
  it('an old response cannot replace a newer invalidation or a different instance, even when transport ignores abort', async () => {
    let resolveOld!: (value: ChatMessage[]) => void
    const history = vi.fn().mockImplementationOnce(() => new Promise<ChatMessage[]>(resolve => { resolveOld = resolve }))
      .mockResolvedValueOnce([message('new')])
    const controller = new ChatSnapshotController({ history, task: async () => null }, 'browser', cache)
    const old = controller.refresh([])
    await vi.waitFor(() => expect(history).toHaveBeenCalledOnce())
    expect((await controller.refresh([]))?.messages[0].message_id).toBe('new')
    resolveOld([message('old')]); expect(await old).toBeNull()
    let resolveAnother!: (value: ChatMessage[]) => void
    history.mockImplementationOnce(() => new Promise<ChatMessage[]>(resolve => { resolveAnother = resolve }))
    const another = controller.refresh([])
    await vi.waitFor(() => expect(resolveAnother).toBeTypeOf('function'))
    setServerScope('another-instance')
    resolveAnother([message('wrong-instance')]); expect(await another).toBeNull()
    controller.dispose()
  })
  it('unavailable task reads leave a partial sync rather than inventing task completion or clearing facts as success', async () => {
    const controller = new ChatSnapshotController({ history: async () => [{ ...message('user'), task_id: 'task' }], task: async () => { throw new Error('unavailable') } }, 'browser', cache)
    const snapshot = await controller.refresh([])
    expect(snapshot?.incomplete).toBe(true)
    expect(snapshot?.messages).toHaveLength(1)
    expect(snapshot?.tasks.size).toBe(0)
    controller.dispose()
  })
})
