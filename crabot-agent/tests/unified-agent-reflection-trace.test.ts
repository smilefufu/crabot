import { expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { UnifiedAgent } from '../src/unified-agent.js'
import { TraceCursorStore } from '../src/workers/trace/cursor-store.js'

it('reflection keeps source bounds after cursor eviction and rejects changed incarnation identity', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'reflection-cursors-'))
  const cursors = new TraceCursorStore(dir)
  try {
    const incarnation = { seq: 1, incarnation_id: 'incarnation', impl: 'builtin', started_at: '2026-09-17T00:00:00.000Z' }
    const agent = Object.create(UnifiedAgent.prototype) as any
    agent.managerStack = { ledger: { findWorker: async () => ({ worker: { incarnations: [incarnation] } }) } }
    agent.traceCursorStore = () => cursors
    let currentLength = 2
    let fingerprint = ''
    agent.handleGetWorkerTrace = async ({ cursor }: { cursor: string }) => {
      const record = await cursors.resolve(cursor, 'worker', fingerprint)
      if (!record.window) {
        const end = { harness: currentLength, native: currentLength, legacy: 0 }
        const next = await cursors.mintDurable('worker', fingerprint, end)
        await cursors.captureWindow(cursor, { end, nextToken: next })
      }
      const upper = (await cursors.resolve(cursor, 'worker', fingerprint)).window!.end.native
      return { events: Array.from({ length: upper }, (_, index) => ({ kind: 'message', summary: `event-${index}` })), next_cursor: 'unused' }
    }
    const { incarnationFingerprint } = await import('../src/workers/trace/cursor-store.js')
    fingerprint = incarnationFingerprint(incarnation as any)
    const first = await agent.readReflectionWorkerTrace('worker', 1)
    expect(first.result.events).toHaveLength(2)
    expect(first.source).not.toHaveProperty('cursor')
    for (let i = 0; i < 520; i++) await cursors.mintDurable('worker', fingerprint, { harness: i, native: i, legacy: 0 })
    currentLength = 10
    expect((await agent.readReflectionWorkerTrace('worker', 1, first.source)).result.events).toHaveLength(2)
    incarnation.incarnation_id = 'replacement'
    await expect(agent.readReflectionWorkerTrace('worker', 1, first.source)).rejects.toThrow('incarnation changed')
  } finally {
    await (cursors as any).writeTail
    await rm(dir, { recursive: true, force: true })
  }
})
