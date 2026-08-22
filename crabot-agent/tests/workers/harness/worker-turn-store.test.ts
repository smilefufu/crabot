import { describe, expect, it, afterEach } from 'vitest'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { WorkerTurnStore } from '../../../src/workers/harness/worker-turn-store.js'

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

describe('WorkerTurnStore', () => {
  it('persists a pending turn, resolves it once, and rejects a conflicting second resolution', async () => {
    const workersDir = await fs.mkdtemp(join(tmpdir(), 'worker-turn-store-'))
    dirs.push(workersDir)
    const store = new WorkerTurnStore(workersDir)

    const turn = await store.create({
      worker_id: 'worker-1',
      manager_key: 'wechat::session-1',
      incarnation_id: 'incarnation-1',
      impl: 'builtin',
      seq: 1,
      session_ref: 'session-ref',
      activity_from: '0',
      activity_through: '3',
      completed_at: '2026-08-20T00:00:00.000Z',
      completion_source: 'builtin_end_turn',
    })

    expect(await store.get('worker-1')).toEqual(turn)

    const resolved = await store.resolve('worker-1', turn.turn_id, 'reported', '2026-08-20T00:01:00.000Z')
    expect(resolved).toMatchObject({
      turn_id: turn.turn_id,
      disposition: { status: 'resolved', resolution: 'reported', resolved_at: '2026-08-20T00:01:00.000Z' },
    })
    expect(await store.resolve('worker-1', turn.turn_id, 'reported', '2026-08-20T00:02:00.000Z')).toEqual(resolved)
    await expect(store.resolve('worker-1', turn.turn_id, 'suppressed', '2026-08-20T00:02:00.000Z')).rejects.toThrow('already resolved as reported')
  })
})
