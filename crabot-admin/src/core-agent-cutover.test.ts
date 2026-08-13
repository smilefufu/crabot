import { describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { CoreAgentCutoverStore } from './core-agent-cutover.js'

describe('CoreAgentCutoverStore', () => {
  it('archives legacy records deterministically and persists a replay marker', async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'crabot-cutover-'))
    try {
      const store = new CoreAgentCutoverStore(dataDir)
      const first = await store.archive([
        { source_kind: 'agent_instance' as const, source_id: 'legacy', raw: { b: 2, a: 1 } },
      ])
      const replay = await store.archive([
        { source_kind: 'agent_instance' as const, source_id: 'legacy', raw: { a: 1, b: 2 } },
      ])
      expect(replay.fingerprint).toBe(first.fingerprint)
      expect(replay.record_count).toBe(1)
      await store.saveMarker({ schema_version: 1, completed: true, completed_at: '2026-08-12T00:00:00.000Z', archive_fingerprint: first.fingerprint, archive_record_count: 1, mm_result: { completed: true } })
      expect((await store.loadMarker())?.archive_fingerprint).toBe(first.fingerprint)
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true })
    }
  })

  it('fails closed when a replayed legacy source diverges from its durable archive', async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'crabot-cutover-conflict-'))
    try {
      const store = new CoreAgentCutoverStore(dataDir)
      await store.archive([
        { source_kind: 'agent_instance' as const, source_id: 'legacy', raw: { name: 'before' } },
      ])
      await expect(store.archive([
        { source_kind: 'agent_instance' as const, source_id: 'legacy', raw: { name: 'after' } },
      ])).rejects.toThrow('archive conflict')
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true })
    }
  })
})
