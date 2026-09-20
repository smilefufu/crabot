import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { promises as fs } from 'node:fs'
import { ManagerSessionStore } from '../../src/manager/session-store.js'
import { DailyReflectionEvidence, type ReflectionEvidenceDeps } from '../../src/manager/daily-reflection-evidence.js'
import { reflectionDigest } from '../../src/manager/daily-reflection.js'
import { importV2LegacyTasks } from '../../src/workers/legacy-importer.js'
import { LedgerStore } from '../../src/workers/harness/ledger-store.js'
import { WorkspaceManager } from '../../src/workers/harness/workspace-manager.js'
import { WorkerEventLog } from '../../src/workers/harness/worker-events.js'
import { readCompositeWorkerTrace } from '../../src/workers/trace/composite-reader.js'
import { TraceCursorStore } from '../../src/workers/trace/cursor-store.js'
import { NativeTraceCopyStore } from '../../src/workers/trace/native-copy.js'
import { WorkerTurnStore } from '../../src/workers/harness/worker-turn-store.js'
import { TraceStore } from '../../src/core/trace-store.js'
import type { ManagerKey } from '../../src/manager/types.js'
import type { DailyReflectionState } from '../../src/manager/daily-reflection-types.js'
import type { ManagerEpisodeTrace } from '../../src/manager/trace-types.js'
import type { EngineMessage } from '../../src/engine/types.js'

const window = { window_start: '2026-09-17T00:00:00.000Z', window_end: '2026-09-18T00:00:00.000Z' }
const activity = '2026-09-17T12:00:00.000Z'
const state = { ...window, run_id: 'run', episode_ids: ['daily'], analysis_worker_ids: [] } as unknown as DailyReflectionState
const dirs: string[] = []
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))) })

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'reflection-evidence-')); dirs.push(root)
  const managersDir = join(root, 'managers')
  const store = new ManagerSessionStore(managersDir)
  const traces = new Map<string, ManagerEpisodeTrace>()
  const workers: any[] = []
  const events = new Map<string, any[]>()
  const deps: ReflectionEvidenceDeps = {
    managersDir, store, turns: new WorkerTurnStore(join(root, 'workers')),
    ledger: { listAllWorkers: async () => workers.map(worker => ({ worker, managerKey: worker.manager_key })) } as any,
    harness: { readWorkerEvents: async id => events.get(id) ?? [] } as any,
    traces: {
      listTraceManagerKeys: () => [...new Set([...traces.values()].map(trace => trace.manager_key))],
      readManagerEpisode: async id => traces.get(id),
      readManagerEpisodes: async function* () { yield* traces.values() },
    },
    captureWorkerTrace: vi.fn(async () => ({ source: { seq: 1, incarnation_fingerprint: 'fingerprint', upper_bound: { native: 0, harness: 0, legacy: 0 } }, result: { events: [], next_cursor: 'next' } })),
    readWorkerTrace: vi.fn(async () => ({ events: [], next_cursor: 'next' })),
    redact: text => text.replaceAll('test-secret', '[REDACTED]'),
  }
  const addEpisode = async (id: string, key: string, content: string) => {
    const messages: EngineMessage[] = [{ id: `${id}-human`, role: 'user', content: `[人类消息]\n${content}`, timestamp: Date.parse(activity) }]
    await store.save({ key: key as ManagerKey, recent: messages, foldedCount: 0 })
    await store.appendEpisodeLog(key as ManagerKey, id, messages)
    traces.set(id, { trace_id: id, manager_key: key as ManagerKey, started_at: activity, ended_at: activity,
      status: 'failed', trigger: { type: 'human_message', summary: content }, spawned_worker_ids: [], spans: [] })
  }
  return { root, store, workers, events, traces, deps, addEpisode, provider: new DailyReflectionEvidence(deps) }
}

async function importLegacyWorker(f: Awaited<ReturnType<typeof fixture>>, status = 'completed', completedAt = '2026-07-05T14:15:00.000Z') {
  const adminDataDir = join(f.root, 'admin')
  const agentDataDir = join(f.root, 'agent')
  const traceDir = join(agentDataDir, 'traces')
  await fs.mkdir(adminDataDir, { recursive: true })
  await fs.mkdir(traceDir, { recursive: true })
  await fs.writeFile(join(adminDataDir, 'tasks.json'), JSON.stringify([{
    id: 'old-task', title: 'historical task', status, priority: 'normal',
    created_at: '2026-07-05T14:00:00.000Z',
    ...(status === 'completed' ? { completed_at: completedAt } : {}),
    source: { channel_id: 'chat', session_id: 'one', trigger_type: 'message' },
  }]))
  const ledger = new LedgerStore(join(agentDataDir, 'worker-ledgers'))
  await importV2LegacyTasks({ adminDataDir, agentDataDir, traceDir, ledger,
    workspaces: new WorkspaceManager(join(f.root, 'workspaces')), now: () => activity })
  const [{ worker }] = await ledger.listAllWorkers()
  f.workers.push(worker)
  f.events.set(worker.worker_id, await new WorkerEventLog(join(agentDataDir, 'workers', worker.worker_id)).readAll())
  return worker
}

describe('daily reflection persisted evidence', () => {
  it.each(['pre_spawn', 'spawn', 'legacy', 'started', 'session', 'turn', 'other_seq'])('keeps trace requirements grounded in persisted spawn facts: %s', async scenario => {
    const f = await fixture()
    const workerId = 'failed-worker'
    f.workers.push({ worker_id: workerId, manager_key: 'chat::one', origin: {}, updated_at: activity,
      task: { title: 'failed attempt' }, incarnations: [{ seq: 1, incarnation_id: 'inc-1', impl: 'builtin',
        state: 'exited', ended_reason: 'failed', session_ref: scenario === 'session' ? 'native-session' : '',
        started_at: activity, ended_at: activity }] })
    const failure = { worker_id: workerId, seq: scenario === 'other_seq' ? 2 : 1, kind: 'exited', ts: activity,
      detail: { reason: 'spawn_failed', message: 'credential preparation failed test-secret',
        ...(scenario === 'legacy' ? {} : { spawn_phase: scenario === 'spawn' ? 'spawn' : 'pre_spawn' }) } }
    f.events.set(workerId, [failure, ...(scenario === 'started'
      ? [{ worker_id: workerId, seq: 1, kind: 'lifecycle_changed', ts: activity, detail: { change: 'spawned' } }] : [])])
    if (scenario === 'turn') vi.spyOn(f.deps.turns, 'list').mockResolvedValueOnce([
      { seq: 1, completed_at: activity, turn_id: 'turn-1' } as any,
    ])
    vi.mocked(f.deps.captureWorkerTrace).mockRejectedValue(new Error('no native session'))
    const manifest = await f.provider.capture(state)
    expect(manifest.records).toHaveLength(1)
    const record = manifest.records[0]
    if (scenario === 'pre_spawn') {
      expect(f.deps.captureWorkerTrace).not.toHaveBeenCalled()
      expect(record.gaps).toEqual([])
      expect(record.summary).toContain('credential preparation failed [REDACTED]')
      f.events.get(workerId)!.push({ ...failure, detail: { message: 'later event' } })
      const detail = await f.provider.read(record, state)
      expect(detail.gaps).toEqual([])
      expect(detail.content).toContain('credential preparation failed [REDACTED]')
      expect(detail.content).not.toContain('later event')
      expect(reflectionDigest(detail.content)).toBe(record.digest)
    } else {
      expect(f.deps.captureWorkerTrace).toHaveBeenCalledWith(workerId, 1)
      expect(record.gaps).toContain(`worker_trace_unavailable:${workerId}:1`)
    }
  })

  it('reads evicted archived episodes, including episodes whose history is missing', async () => {
    const f = await fixture()
    const traces = new TraceStore(20, join(f.root, 'traces'))
    try {
      for (let i = 0; i < 1002; i++) {
        traces.startManagerEpisode(`archived-${i}`, 'chat::one' as ManagerKey, { type: 'human_message', summary: 'archive fixture' })
        traces.finishManagerEpisode(`archived-${i}`, { status: 'completed' })
      }
      const timestamp = Date.now()
      await f.store.save({ key: 'chat::one' as ManagerKey, recent: [], foldedCount: 0 })
      const archiveState = { ...state, window_start: new Date(timestamp - 60_000).toISOString(), window_end: new Date(timestamp + 60_000).toISOString() }
      await f.store.appendEpisodeLog('chat::one' as ManagerKey, 'archived-0', [
        { id: 'human', role: 'user', content: '[人类消息]\narchived input', timestamp },
      ])
      expect(traces.getManagerEpisode('archived-0')).toBeUndefined()
      const provider = new DailyReflectionEvidence({ ...f.deps, traces })
      const manifest = await provider.capture(archiveState)
      const record = manifest.records.find(item => item.source_id === 'archived-0')!
      expect(record.gaps).toEqual([])
      expect((await provider.read(record, archiveState)).content).toContain('archived input')
      expect(manifest.records.find(item => item.source_id === 'archived-1')?.gaps).toEqual(['manager_history_unavailable'])
      expect(traces.getManagerEpisode('archived-0')).toBeUndefined()
    } finally { traces.stopFlushTimer() }
  })

  it('retries detail I/O at frozen history bytes without including later messages', async () => {
    const f = await fixture()
    await f.addEpisode('first', 'chat::one', 'frozen history')
    const actualOpen = fs.open
    const open = vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      if (String(args[0]).endsWith('/episodes/first.jsonl')) throw new Error('temporary I/O')
      return actualOpen(...args)
    })
    let manifest
    try { manifest = await f.provider.capture(state) } finally { open.mockRestore() }
    expect(manifest.gaps).toEqual([])
    const record = manifest.records.find(item => item.source_id === 'first')!
    expect(record.digest).toBe('')
    expect(record.gaps).toEqual(['temporary I/O'])
    await f.store.appendEpisodeLog('chat::one' as ManagerKey, 'first', [
      { id: 'late', role: 'user', content: '[人类消息]\nlate append', timestamp: Date.parse(activity) },
    ])
    const recovered = await f.provider.read(record, state)
    expect(recovered.gaps).toEqual([])
    expect(recovered.content).toContain('frozen history')
    expect(recovered.content).not.toContain('late append')
  })

  it('includes two sessions and an old task that failed in this window, excludes reflection analysis', async () => {
    const f = await fixture()
    await f.addEpisode('first', 'chat::one', '这个结果错了 test-secret')
    await f.addEpisode('second', 'chat::two', 'success')
    f.workers.push({ worker_id: 'old-worker', manager_key: 'chat::two', origin: {}, incarnations: [],
      task: { title: 'created last month', created_at: '2026-08-01T00:00:00.000Z' }, updated_at: activity })
    f.workers.push({ ...f.workers[0], worker_id: 'analysis', origin: { spawned_by_episode: 'daily' } })
    f.events.set('old-worker', [{ kind: 'error', ts: activity, detail: { message: 'failed test-secret' } }])
    const manifest = await f.provider.capture(state)
    expect(manifest.records.map(record => record.source_id).sort()).toEqual(['first', 'old-worker', 'second'])
    const worker = manifest.records.find(record => record.source_id === 'old-worker')!
    expect(worker.summary).toContain('failed [REDACTED]')
    expect((await f.provider.read(worker, state)).content).toContain('failed [REDACTED]')
    expect(JSON.stringify(manifest)).not.toContain('test-secret')
    const first = manifest.records.find(record => record.source_id === 'first')!
    expect((await f.provider.read(first, state)).content).toContain('这个结果错了')
  })

  it('excludes a completed historical task whose only current activity is the real v2 migration', async () => {
    const f = await fixture()
    const worker = await importLegacyWorker(f)
    expect(worker.updated_at).toBe(activity)
    expect(f.events.get(worker.worker_id)).toMatchObject([{ kind: 'legacy_imported', ts: activity }])
    expect(await f.provider.capture(state)).toEqual({ records: [], gaps: [] })
    expect(f.deps.captureWorkerTrace).not.toHaveBeenCalled()
  })

  it('does not reintroduce migration-only activity through the composite harness trace', async () => {
    const f = await fixture()
    const worker = await importLegacyWorker(f, 'executing')
    expect(worker.incarnations[0].ended_at).toBe(activity)
    const cursorStore = new TraceCursorStore(join(f.root, 'cursors'))
    let result
    try {
      result = await readCompositeWorkerTrace({
        ledger: { findWorker: async () => ({ worker, managerKey: worker.manager_key }) } as LedgerStore,
        harness: f.deps.harness, adapters: new Map(), cursorStore,
        nativeCopy: new NativeTraceCopyStore(join(f.root, 'native-copy')),
        redact: f.deps.redact, legacyTraceDir: join(f.root, 'agent', 'traces'),
      }, { worker_id: worker.worker_id, seq: 1 })
    } finally { await cursorStore.flush() }
    expect(result.events).toMatchObject([{ ts: activity, kind: 'lifecycle', source: 'harness', summary: 'legacy_imported' }])
    vi.mocked(f.deps.captureWorkerTrace).mockResolvedValueOnce({
      source: { seq: 1, incarnation_fingerprint: 'legacy', upper_bound: { native: 0, harness: 1, legacy: 0 } }, result,
    })
    expect(await f.provider.capture(state)).toEqual({ records: [], gaps: [] })
    expect(f.deps.captureWorkerTrace).toHaveBeenCalledWith(worker.worker_id, 1)
  })

  it('preserves real legacy execution in the window and uses its time instead of migration time', async () => {
    const f = await fixture()
    const worker = await importLegacyWorker(f, 'executing')
    const executedAt = '2026-09-17T10:00:00.000Z'
    const events = [
      { ts: executedAt, kind: 'error' as const, source: 'legacy' as const, summary: 'historical execution failed' },
      { ts: activity, kind: 'lifecycle' as const, source: 'harness' as const, summary: 'legacy_imported' },
    ]
    vi.mocked(f.deps.captureWorkerTrace).mockResolvedValueOnce({
      source: { seq: 1, incarnation_fingerprint: 'legacy', upper_bound: { native: 0, harness: 1, legacy: 1 } }, result: { events },
    })
    vi.mocked(f.deps.readWorkerTrace).mockResolvedValue({ events })
    const manifest = await f.provider.capture(state)
    expect(manifest.records).toHaveLength(1)
    const record = manifest.records[0]
    expect(record).toMatchObject({ source_id: worker.worker_id, activity_at: executedAt, gaps: [] })
    const evidence = await f.provider.read(record, state)
    expect(evidence.content).toContain('historical execution failed')
    expect(evidence.content).not.toContain('legacy_imported')
    expect(record.digest).toBe(reflectionDigest(evidence.content))
  })

  it.each([window.window_start, '2026-09-17T10:00:00.000Z'])(
    'preserves a real legacy completion at %s when execution details are unavailable', async completedAt => {
      const f = await fixture()
      const worker = await importLegacyWorker(f, 'completed', completedAt)
      vi.mocked(f.deps.captureWorkerTrace).mockRejectedValueOnce(new Error('legacy trace unavailable'))
      const manifest = await f.provider.capture(state)
      expect(manifest.records).toHaveLength(1)
      expect(manifest.records[0]).toMatchObject({ source_id: worker.worker_id, activity_at: completedAt,
        gaps: [`worker_trace_unavailable:${worker.worker_id}:1`] })
    },
  )

  it('preserves real input sent to an imported worker, including at the migration timestamp', async () => {
    const f = await fixture()
    const worker = await importLegacyWorker(f)
    f.events.get(worker.worker_id)!.push({ kind: 'input_sent', ts: activity, detail: { delivery_id: 'new-input' } })
    const manifest = await f.provider.capture(state)
    expect(manifest.records).toHaveLength(1)
    expect(manifest.records[0]).toMatchObject({ source_id: worker.worker_id, activity_at: activity })
    const evidence = await f.provider.read(manifest.records[0], state)
    expect(evidence.content).toContain('new-input')
    expect(evidence.content).not.toContain('legacy_imported')
  })

  it('preserves the update fallback after a migrated worker has subsequently changed', async () => {
    const f = await fixture()
    const worker = await importLegacyWorker(f)
    worker.updated_at = '2026-09-17T13:00:00.000Z'
    const manifest = await f.provider.capture(state)
    expect(manifest.records).toHaveLength(1)
    expect(manifest.records[0]).toMatchObject({ source_id: worker.worker_id, activity_at: worker.updated_at })
  })

  it('frozen Manager history ignores appended messages and never emits raw reasoning', async () => {
    const f = await fixture()
    await f.addEpisode('first', 'chat::one', 'first')
    await f.store.appendEpisodeLog('chat::one' as ManagerKey, 'first', [{ id: 'reasoning', role: 'assistant', timestamp: Date.parse(activity),
      stopReason: 'end_turn', content: [{ type: 'raw_reasoning', data: { private: 'never expose' } }, { type: 'text', text: 'visible answer' }] }])
    const manifest = await f.provider.capture(state)
    const record = manifest.records[0]
    await f.store.appendEpisodeLog('chat::one' as ManagerKey, 'first', [{ id: 'late', role: 'user', timestamp: Date.parse(activity), content: 'late append' }])
    const evidence = await f.provider.read(record, state)
    expect(evidence.content).toContain('visible answer')
    expect(evidence.content).not.toMatch(/never expose|late append|raw_reasoning/)
    expect(reflectionDigest(evidence.content)).toBe(record.digest)
  })

  it('persistent human inputs without an episode remain visible, later removal is a gap', async () => {
    const f = await fixture()
    const key = 'chat::unhandled' as ManagerKey
    await f.store.save({ key, foldedCount: 0, recent: [{ id: 'human', role: 'user', timestamp: Date.parse(activity), content: '[人类消息]\n尚未处理的负面反馈' }] })
    const manifest = await f.provider.capture(state)
    expect(manifest.records).toHaveLength(1)
    expect(manifest.records[0].kind).toBe('human_input')
    await f.store.save({ key, foldedCount: 1, recent: [] })
    expect((await f.provider.read(manifest.records[0], state)).gaps).toEqual(['human_input_unavailable:human'])
  })

  it('expired trace/history and unavailable native collection are explicit gaps', async () => {
    const f = await fixture()
    await f.addEpisode('expired', 'chat::one', 'history')
    f.traces.delete('expired')
    f.workers.push({ worker_id: 'worker', manager_key: 'chat::one', origin: {}, incarnations: [{ seq: 1 }], task: { title: 'job' }, updated_at: activity })
    vi.mocked(f.deps.captureWorkerTrace).mockRejectedValueOnce(new Error('native unavailable'))
    const manifest = await f.provider.capture(state)
    expect(manifest.records.find(record => record.source_id === 'expired')?.gaps).toContain('manager_trace_unavailable')
    const worker = manifest.records.find(record => record.source_id === 'worker')!
    expect((await f.provider.read(worker, state)).gaps).toContain('worker_trace_unavailable:worker:1')
  })

  it('does not turn unavailable incarnations wholly outside the period into current evidence gaps', async () => {
    const f = await fixture()
    f.workers.push({ worker_id: 'continued', manager_key: 'chat::one', origin: {}, task: { title: 'continued task' }, updated_at: activity,
      incarnations: [
        { seq: 1, state: 'exited', started_at: '2026-08-01T00:00:00.000Z', ended_at: '2026-08-02T00:00:00.000Z' },
        { seq: 2, state: 'running', started_at: activity },
        { seq: 3, state: 'running', started_at: window.window_end },
      ] })
    vi.mocked(f.deps.captureWorkerTrace).mockImplementation(async (_id, seq) => {
      if (seq !== 2) throw new Error('outside period trace unavailable')
      return { source: { seq, incarnation_fingerprint: 'same', upper_bound: { harness: 0, native: 0, legacy: 0 } }, result: { events: [] } }
    })
    const manifest = await f.provider.capture(state)
    expect(manifest.records).toHaveLength(1)
    expect(manifest.records[0].gaps).toEqual([])
    expect(vi.mocked(f.deps.captureWorkerTrace).mock.calls).toEqual([['continued', 2]])
  })

  it('ordinary absence is an empty directory, while out-of-window evidence is excluded', async () => {
    const f = await fixture()
    expect(await f.provider.capture(state)).toEqual({ records: [], gaps: [] })
    f.workers.push({ worker_id: 'later', manager_key: 'chat::one', origin: {}, incarnations: [], task: { title: 'later' }, updated_at: window.window_end })
    f.events.set('later', [{ kind: 'error', ts: window.window_end }])
    expect((await f.provider.capture(state)).records).toEqual([])
  })
})
