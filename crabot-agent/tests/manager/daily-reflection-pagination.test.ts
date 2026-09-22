import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DailyReflection, buildDailyReflectionTools, reflectionDigest } from '../../src/manager/daily-reflection.js'
import { ManagerSessionStore } from '../../src/manager/session-store.js'
import type { ManagerKey } from '../../src/manager/types.js'
import type { EngineToolLifecycleEvent } from '../../src/engine/types.js'
import type { DailyReflectionState, ReflectionRecord } from '../../src/manager/daily-reflection-types.js'
import { ManagerRegistry, type ManagerRegistryDeps } from '../../src/manager/registry.js'
import type { LLMAdapter } from '../../src/engine/llm-adapter-types.js'
import { chunksFromContent } from '../engine/helpers/mock-stream.js'
import type { ManagerResumeCheckpoint } from '../../src/manager/resume-checkpoint.js'

const key = 'admin-web::pagination' as ManagerKey
const dirs: string[] = []
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))) })

async function setup(count = 2, content = 'A'.repeat(16384) + 'B'.repeat(16384) + 'last') {
  const dir = await mkdtemp(join(tmpdir(), 'reflection-pagination-'))
  dirs.push(dir)
  const store = new ManagerSessionStore(dir)
  const records: ReflectionRecord[] = Array.from({ length: count }, (_, i) => ({
    record_ref: `ref-${i}`, kind: 'manager_episode', source_id: `episode-${i}`,
    activity_at: '2026-09-21T00:00:00.000Z', summary: 'evidence', gaps: [], digest: reflectionDigest(content),
    source: { kind: 'manager_episode', manager_key: 'other::session', episode_id: `episode-${i}`, log_bytes: 42, span_ids: [] },
  }))
  const deps = { key, store, now: () => '2026-09-22T00:00:00.000Z',
    capture: vi.fn(async () => ({ records: structuredClone(records), gaps: [] })),
    read: vi.fn(async () => ({ content, gaps: [] })), analysisWorkers: vi.fn(async () => []),
    confirm: vi.fn(async () => ({ status: 'applied' as const, watermark: '2026-09-22T00:00:00.000Z' })),
  }
  const host = new DailyReflection(deps)
  await host.admit({ target_session: { channel_id: 'admin-web', session_id: 'pagination', type: 'private' },
    schedule_id: 'daily', trigger_id: 'trigger', window_start: '2026-09-21T00:00:00.000Z', window_end: '2026-09-22T00:00:00.000Z' }, 'episode')
  return { host, deps, store, records, dir }
}

async function invoke(host: DailyReflection, name: string, input: Record<string, unknown> = {}) {
  const tool = buildDailyReflectionTools(host).find(tool => tool.name === name)!
  const result = await tool.call(input, {})
  const event: EngineToolLifecycleEvent = { type: 'tool_finished', responseId: 'response', callId: 'call',
    toolUseId: 'tool', turnNumber: 0, name, input, traceMetadata: result.traceMetadata,
    output: result.output, isError: result.isError, startedAtMs: 0, endedAtMs: 1, durationMs: 1 }
  return { result, event, page: result.isError ? undefined : JSON.parse(result.output) }
}

async function confirmed(host: DailyReflection, name: string, input: Record<string, unknown> = {}) {
  const call = await invoke(host, name, input)
  expect(call.result.isError).toBe(false)
  await host.acknowledgePages([call.event])
  return call.page
}

describe('host-owned daily reflection pagination', () => {
  it('exposes has_more without a position and refuses legacy cursor input without changing state', async () => {
    const { host, store } = await setup(101)
    const tools = buildDailyReflectionTools(host)
    for (const tool of tools) expect(JSON.stringify(tool.inputSchema)).not.toMatch(/cursor|offset|page_id/)
    const call = await invoke(host, 'list_reflection_records')
    expect(call.page).toMatchObject({ has_more: true, records: expect.any(Array) })
    expect(call.result.output).not.toMatch(/cursor|receipt|offset/)
    const before = await store.load(key)
    const bad = await invoke(host, 'list_reflection_records', { cursor: 'old' })
    expect(bad.result.isError).toBe(true)
    expect(await store.load(key)).toEqual(before)
  })

  it('continues directory pages with identical arguments and stops at EOF', async () => {
    const { host, records, store } = await setup(201)
    const actual: string[] = []
    for (let index = 0; index < 3; index++) {
      const page = await confirmed(host, 'list_reflection_records')
      actual.push(...page.records.map((record: ReflectionRecord) => record.record_ref))
      expect(page.has_more).toBe(index < 2)
    }
    expect(actual).toEqual(records.map(record => record.record_ref))
    expect((await store.load(key)).dailyReflection?.directory_complete).toBe(true)
    expect(await confirmed(host, 'list_reflection_records')).toMatchObject({ records: [], has_more: false })
    const restarted = await confirmed(host, 'list_reflection_records', { restart: true })
    expect(restarted.records.map((record: ReflectionRecord) => record.record_ref)).toEqual(actual.slice(0, 100))
    expect(restarted.has_more).toBe(true)
  })

  it('preserves acknowledged progress when compacted history is saved and a new episode starts', async () => {
    const { host, store, deps } = await setup(1)
    const staleHistory = await store.load(key)
    await confirmed(host, 'list_reflection_records')
    await confirmed(host, 'read_reflection_record', { record_ref: 'ref-0' })
    const before = (await store.load(key)).dailyReflection!
    await store.save({ ...staleHistory, recent: [], foldedCount: 20 })
    const restored = new DailyReflection(deps)
    await restored.admit(undefined, 'next-episode')
    const after = (await store.load(key)).dailyReflection!
    expect(after).toMatchObject({ run_id: before.run_id, reading: before.reading, manifest: before.manifest,
      window_start: before.window_start, window_end: before.window_end, episode_ids: ['episode', 'next-episode'] })
    expect(await confirmed(restored, 'read_reflection_record', { record_ref: 'ref-0' }))
      .toMatchObject({ content: 'B'.repeat(16384) })
  })

  it('keeps interleaved detail progress separate and requires explicit restart after completion', async () => {
    const { host, store } = await setup()
    await confirmed(host, 'list_reflection_records')
    for (const letter of ['A', 'B']) {
      for (const ref of ['ref-0', 'ref-1']) {
        expect(await confirmed(host, 'read_reflection_record', { record_ref: ref }))
          .toMatchObject({ content: letter.repeat(16384), has_more: true })
      }
    }
    expect(await confirmed(host, 'read_reflection_record', { record_ref: 'ref-0' }))
      .toMatchObject({ content: 'last', has_more: false })
    expect(await confirmed(host, 'read_reflection_record', { record_ref: 'ref-0' }))
      .toMatchObject({ content: '', has_more: false })
    expect((await store.load(key)).dailyReflection?.read_records['ref-0']).toBe(true)
    expect(await confirmed(host, 'read_reflection_record', { record_ref: 'ref-0', restart: true }))
      .toMatchObject({ content: 'A'.repeat(16384), has_more: true })
    expect((await store.load(key)).dailyReflection?.read_records['ref-0']).toBe(false)
    expect(await confirmed(host, 'read_reflection_record', { record_ref: 'ref-1' }))
      .toMatchObject({ content: 'last', has_more: false })
  })

  it('replays an unacknowledged page across restart and deduplicates same-stream calls before acknowledgement', async () => {
    const { host, deps, dir } = await setup()
    await confirmed(host, 'list_reflection_records')
    const first = await invoke(host, 'read_reflection_record', { record_ref: 'ref-0' })
    expect(first.result.traceMetadata).toBeDefined()
    const restored = new DailyReflection({ ...deps, store: new ManagerSessionStore(dir) })
    const [again, restart] = await Promise.all([
      invoke(restored, 'read_reflection_record', { record_ref: 'ref-0' }),
      invoke(restored, 'read_reflection_record', { record_ref: 'ref-0', restart: true }),
    ])
    expect(again.result).toEqual(first.result)
    expect(restart.result).toEqual(first.result)
    await restored.acknowledgePages([first.event, again.event, restart.event])
    expect(await confirmed(restored, 'read_reflection_record', { record_ref: 'ref-0' }))
      .toMatchObject({ content: 'B'.repeat(16384) })
  })

  it('does not complete the last page before its successful result is checkpointed', async () => {
    const { host, store } = await setup(1, 'last')
    await confirmed(host, 'list_reflection_records')
    const last = await invoke(host, 'read_reflection_record', { record_ref: 'ref-0' })
    expect(last.page).toMatchObject({ content: 'last', has_more: false })
    expect((await store.load(key)).dailyReflection?.read_records['ref-0']).toBe(false)
    const finish = { outcome: 'completed', summary: 'done', evidence_refs: [], pending_items: [] }
    expect(await host.validateFinish(finish, 1)).toContain('actionable_evidence_remaining')
    await host.acknowledgePages([{ ...last.event, type: 'tool_finished', isError: true,
      output: '[interrupted: agent restarted]', endedAtMs: 1, durationMs: 1 }])
    expect(await host.validateFinish(finish, 1)).toContain('actionable_evidence_remaining')
    await host.acknowledgePages([last.event])
    expect(await host.validateFinish({ ...finish, evidence_refs: ['ref-0'] }, 1)).toBeUndefined()
  })

  it('does not advance on failed persistence and retries the same page', async () => {
    const { host, store } = await setup(1)
    await confirmed(host, 'list_reflection_records')
    const before = await store.load(key)
    vi.spyOn(store, 'updateDailyReflection').mockRejectedValueOnce(new Error('write failed'))
    await expect(invoke(host, 'read_reflection_record', { record_ref: 'ref-0' })).rejects.toThrow('write failed')
    expect(await store.load(key)).toEqual(before)
    await expect(host.acknowledgePages([])).rejects.toThrow('write failed')
    await host.admit(undefined, 'retry-episode')
    expect(await confirmed(host, 'read_reflection_record', { record_ref: 'ref-0' }))
      .toMatchObject({ content: 'A'.repeat(16384) })
  })

  it('rejects mismatched or stale receipts and keeps the page pending when confirmation cannot be saved', async () => {
    const { host, store } = await setup()
    await confirmed(host, 'list_reflection_records')
    const first = await invoke(host, 'read_reflection_record', { record_ref: 'ref-0' })
    const before = await store.load(key)
    await host.acknowledgePages([{ ...first.event, input: { record_ref: 'ref-1' } },
      { ...first.event, traceMetadata: { ...first.event.traceMetadata, reflection_run_id: 'another-run' } }])
    expect(await store.load(key)).toEqual(before)
    vi.spyOn(store, 'updateDailyReflection').mockRejectedValueOnce(new Error('confirmation write failed'))
    await expect(host.acknowledgePages([first.event])).rejects.toThrow('confirmation write failed')
    expect(await store.load(key)).toEqual(before)
    await host.acknowledgePages([first.event])
    const restarted = await invoke(host, 'read_reflection_record', { record_ref: 'ref-0', restart: true })
    await host.acknowledgePages([first.event])
    expect((await store.load(key)).dailyReflection?.reading?.records['ref-0'].pending?.receipt)
      .toBe(restarted.result.traceMetadata?.reflection_page_receipt)
  })

  it('migrates old details once, preserving completed records and replaying the safe tail', async () => {
    const { host, store, records } = await setup(3)
    records[2].gaps = ['read failed']
    await store.updateDailyReflection(key, state => ({ ...state!, manifest: { records, gaps: [] },
      directory_complete: true, directory_page: { start: 0, end: 3 },
      read_records: { 'ref-0': false, 'ref-1': true, 'ref-2': false },
      cursors: { first: { record_ref: 'ref-0', offset: 16384 }, next: { record_ref: 'ref-0', offset: 32768 },
        duplicate: { record_ref: 'ref-0', offset: 32768 }, gapped: { record_ref: 'ref-2', offset: 32768 } } }))
    const before = (await store.load(key)).dailyReflection!
    const directory = await invoke(host, 'list_reflection_records')
    expect(directory.page.records).toHaveLength(3)
    expect((await store.load(key)).dailyReflection?.directory_complete).toBe(false)
    await host.acknowledgePages([directory.event])
    expect(await confirmed(host, 'read_reflection_record', { record_ref: 'ref-0' }))
      .toMatchObject({ content: 'B'.repeat(16384) })
    expect(await confirmed(host, 'read_reflection_record', { record_ref: 'ref-1' }))
      .toMatchObject({ content: '', has_more: false })
    expect(await confirmed(host, 'read_reflection_record', { record_ref: 'ref-2' }))
      .toMatchObject({ content: 'A'.repeat(16384) })
    const after = (await store.load(key)).dailyReflection!
    expect(after).toMatchObject({ run_id: before.run_id, window_start: before.window_start, window_end: before.window_end,
      cursors: before.cursors, read_records: { 'ref-1': true } })
    expect(after.manifest!.records.map(record => record.source)).toEqual(before.manifest!.records.map(record => record.source))
  })

  it.each(['normal', 'result_saved', 'result_lost', 'checkpoint_failure', 'page_save_failure'] as const)(
    'uses the real Manager checkpoint to confirm pages (%s)', async mode => {
      const { host, deps, store, dir } = await setup(1, 'A'.repeat(16384) + 'last')
      const requests: string[] = []
      const snapshots: Array<{ checkpoint: ManagerResumeCheckpoint; daily: DailyReflectionState }> = []
      let capture = true
      let failed = false
      if (mode === 'page_save_failure') {
        const update = store.updateDailyReflection.bind(store)
        vi.spyOn(store, 'updateDailyReflection').mockImplementation(async (key, transform) => {
          const daily = transform((await store.load(key)).dailyReflection)
          if (!failed && daily?.reading?.records['ref-0']?.pending) {
            failed = true
            throw new Error('page write failed')
          }
          return update(key, () => daily)
        })
      }
      const save = store.saveCheckpoint.bind(store)
      vi.spyOn(store, 'saveCheckpoint').mockImplementation(checkpoint => {
        const completed = checkpoint.tools.some(event => event.type === 'tool_finished' && event.name === 'read_reflection_record')
        if (capture && completed && mode === 'checkpoint_failure') {
          failed = true
          throw new Error('checkpoint write failed')
        }
        save(checkpoint)
        if (capture && completed) snapshots.push({ checkpoint: structuredClone(checkpoint),
          daily: JSON.parse(readFileSync(join(dir, encodeURIComponent(key), 'state.json'), 'utf8')).dailyReflection })
      })
      const adapter: LLMAdapter = { updateConfig() {}, async *stream(params) {
        const serialized = JSON.stringify(params.messages)
        expect(serialized).not.toContain('reflection_page_receipt')
        expect(JSON.stringify(params.tools)).not.toMatch(/next_cursor|resume_cursor/)
        requests.push(serialized)
        const daily = (await store.load(key)).dailyReflection!
        const input = daily.directory_complete
          ? daily.read_records['ref-0'] === true
            ? { name: 'finish_daily_reflection', input: { outcome: 'completed', summary: 'done', pending_items: [], evidence_refs: ['ref-0'] } }
            : { name: 'read_reflection_record', input: { record_ref: 'ref-0' } }
          : { name: 'list_reflection_records', input: {} }
        yield* chunksFromContent([{ type: 'tool_use', id: `call-${requests.length}`, ...input }], 'tool_use')
      } }
      const registry = (daily: DailyReflection) => new ManagerRegistry({ store, adapter: () => adapter,
        model: () => 'fixture', policy: { keepRecent: 100, hardCapTokens: 1000000 },
        managerKeyFor: key => key, promptInputs: () => ({}), toolFace: () => buildDailyReflectionTools(daily),
        dailyReflectionFor: () => daily, now: () => new Date(deps.now()), timezone: () => 'Asia/Shanghai',
        readCurrentWorkboard: async key => ({ manager_key: key, objectives: [], archive: [] }),
        harness: {} as ManagerRegistryDeps['harness'], ledger: {} as ManagerRegistryDeps['ledger'],
      })
      const current = registry(host)
      const operation = current.routeSchedule({ scheduleId: 'daily', triggerId: 'trigger', scheduleName: 'daily',
        title: 'daily', description: 'review', isBuiltin: true, taskType: 'daily_reflection',
        targetSession: { channel_id: 'admin-web', session_id: 'pagination', type: 'private' },
        reflectionWindow: { window_start: '2026-09-21T00:00:00.000Z', window_end: '2026-09-22T00:00:00.000Z' } })
      if (mode === 'checkpoint_failure' || mode === 'page_save_failure') {
        await expect(operation).rejects.toThrow(mode === 'checkpoint_failure' ? 'checkpoint write failed' : 'page write failed')
        expect(failed).toBe(true)
        expect(requests).toHaveLength(2)
        expect(deps.confirm).not.toHaveBeenCalled()
        expect((await store.load(key)).dailyReflection?.reading?.records['ref-0']?.offset ?? 0).toBe(0)
        capture = false
        const restored = new DailyReflection(deps)
        expect(await confirmed(restored, 'read_reflection_record', { record_ref: 'ref-0' }))
          .toMatchObject({ content: 'A'.repeat(16384) })
        return
      }
      const result = await operation
      expect(result.dailyReflection?.outcome).toBe('completed')
      expect(deps.confirm).toHaveBeenCalledOnce()
      expect(deps.read).toHaveBeenCalledTimes(2)
      if (mode === 'normal') return

      let checkpoint = snapshots[0].checkpoint
      const pendingState = snapshots[0].daily
      expect(pendingState.reading!.records['ref-0'].pending?.start).toBe(0)
      await store.updateDailyReflection(key, () => structuredClone(pendingState))
      if (mode === 'result_lost') checkpoint = { ...checkpoint, tools: checkpoint.tools.map(event => event.name === 'read_reflection_record'
        ? { type: 'tool_started', responseId: event.responseId, callId: event.callId, toolUseId: event.toolUseId,
          turnNumber: event.turnNumber, name: event.name, input: event.input, startedAtMs: event.startedAtMs } : event) }
      capture = false
      const callsBefore = deps.read.mock.calls.length
      const restored = registry(new DailyReflection(deps))
      restored.registerResumeCheckpoints([checkpoint])
      await restored.resumeInterruptedEpisodes()
      expect((await store.load(key)).dailyReflection?.result?.outcome).toBe('completed')
      expect(deps.read.mock.calls.length - callsBefore).toBe(mode === 'result_lost' ? 2 : 1)
    },
  )
})
