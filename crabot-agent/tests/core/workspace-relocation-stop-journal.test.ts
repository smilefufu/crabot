import { describe, it, expect } from 'vitest'
import { createWorkspaceRelocationStopJournal } from '../../src/core/workspace-relocation-stop-journal.js'
import { relocationMmFixture } from './fixtures/relocation-mm.js'

const workers = [{ worker_id: 'worker', manager_key: 'channel::session' as const, task_id: 'task', incarnations: [
  { incarnation_id: 'inc', impl: 'builtin' as const, seq: 1, workspace: 'fixture-project', started_at: '2026-10-20T00:00:00.000Z' },
] }]
const results = [{ worker_id: 'worker', incarnation_id: 'inc', status: 'submitted' as const }]
async function fixture(mode = 'normal', capture = true) {
  const f = await relocationMmFixture(mode, true)
  if (capture) await f.journal.capture(workers)
  const params = { intent_id: f.options.params.intent_id, launch_id: f.options.params.launch_id }
  return { ...f, params, stopOptions: { ...f.options, params } }
}

describe('Agent independently consumes stop journals from its native fixed MM', () => {
  it('confirms actual attempt and complete receipt without writing them itself or leaking header credentials', async () => {
    const f = await fixture()
    try {
      const binding = await createWorkspaceRelocationStopJournal(f.stopOptions)
      expect(binding.workers).toEqual(workers)
      expect(await binding.journal.prepare(workers)).toBe('dispatch')
      expect(await binding.journal.prepare(workers)).toBe('observe')
      await binding.journal.complete(results)
      await binding.verify()
      expect(f.records.readWorkspaceRelocationStops(f.data, f.params.intent_id).submission.results).toEqual(results)
      expect(f.calls.every(call => call.header_present && call.body.source === 'crabot-agent')).toBe(true)
      expect(JSON.stringify(f.calls)).not.toContain(f.options.bearer)
    } finally { await f.cleanup() }
  }, 30000)
  for (const mode of ['false-prepare', 'extra-prepare', 'revoke-prepare', 'drop-prepare']) it(`refuses unverified preparation without an automatic repeat: ${mode}`, async () => {
    const f = await fixture(mode)
    try {
      const binding = await createWorkspaceRelocationStopJournal(f.stopOptions)
      await expect(binding.journal.prepare(workers)).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
      expect(f.calls.filter(call => call.body.method === 'prepare_workspace_relocation_worker_stops')).toHaveLength(1)
      const actual = f.records.readWorkspaceRelocationStops(f.data, f.params.intent_id)
      if (mode === 'false-prepare') expect(actual.attempt).toBeNull()
      else expect(actual.attempt).not.toBeNull()
    } finally { await f.cleanup() }
  }, 30000)
  for (const mode of ['false-complete', 'drop-complete']) it(`does not equate completion acknowledgement with durable evidence: ${mode}`, async () => {
    const f = await fixture(mode)
    try {
      const binding = await createWorkspaceRelocationStopJournal(f.stopOptions)
      expect(await binding.journal.prepare(workers)).toBe('dispatch')
      await expect(binding.journal.complete(results)).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
      expect(f.calls.filter(call => call.body.method === 'complete_workspace_relocation_worker_stops')).toHaveLength(1)
      const actual = f.records.readWorkspaceRelocationStops(f.data, f.params.intent_id)
      if (mode === 'false-complete') expect(actual.submission).toBeNull()
      else expect(actual.submission.results).toEqual(results)
    } finally { await f.cleanup() }
  }, 30000)
  it('rejects a replacement Worker set before asking MM to register an attempt', async () => {
    const f = await fixture()
    try {
      const binding = await createWorkspaceRelocationStopJournal(f.stopOptions)
      await expect(binding.journal.prepare([])).rejects.toMatchObject({ code: 'WORKSPACE_MAINTENANCE' })
      expect(f.calls.some(call => call.body.method === 'prepare_workspace_relocation_worker_stops')).toBe(false)
      expect(f.records.readWorkspaceRelocationStops(f.data, f.params.intent_id).attempt).toBeNull()
    } finally { await f.cleanup() }
  }, 30000)
  it('refuses a scope changed after the actual attempt was persisted', async () => {
    const f = await fixture('scope-change-prepare')
    try {
      const binding = await createWorkspaceRelocationStopJournal(f.stopOptions)
      await expect(binding.journal.prepare(workers)).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
      expect(f.calls.filter(call => call.body.method === 'prepare_workspace_relocation_worker_stops')).toHaveLength(1)
      expect(() => f.records.readWorkspaceRelocationStops(f.data, f.params.intent_id)).toThrow()
    } finally { await f.cleanup() }
  }, 30000)
  it('does not create a missing fixed scope', async () => {
    const f = await fixture('normal', false)
    try {
      await expect(createWorkspaceRelocationStopJournal(f.stopOptions)).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
      expect(f.records.readWorkspaceRelocationWorkers(f.data, f.params.intent_id)).toBeNull()
    } finally { await f.cleanup() }
  }, 30000)
  it('rejects missing credentials and extra params before reading the private records or sending requests', async () => {
    const f = await fixture()
    try {
      await expect(createWorkspaceRelocationStopJournal({ ...f.stopOptions, bearer: undefined, dataDir: 'absent' })).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
      await expect(createWorkspaceRelocationStopJournal({ ...f.stopOptions, params: { ...f.params, action: 'stop_workers' } as any })).rejects.toMatchObject({ code: 'INVALID_PARAMS' })
      expect(f.calls).toEqual([])
    } finally { await f.cleanup() }
  }, 30000)
})
