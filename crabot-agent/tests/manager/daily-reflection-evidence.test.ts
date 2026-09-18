import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { promises as fs } from 'node:fs'
import { ManagerSessionStore } from '../../src/manager/session-store.js'
import { DailyReflectionEvidence, type ReflectionEvidenceDeps } from '../../src/manager/daily-reflection-evidence.js'
import { reflectionDigest } from '../../src/manager/daily-reflection.js'
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

describe('daily reflection persisted evidence', () => {
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
