import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DailyReflection, reflectionDigest, type DailyReflectionDeps } from '../../src/manager/daily-reflection.js'
import { ManagerSessionStore } from '../../src/manager/session-store.js'
import type { ManagerKey } from '../../src/manager/types.js'
import type { ReflectionRecord } from '../../src/manager/daily-reflection-types.js'
import type { EngineMessage } from '../../src/engine/types.js'

const key = 'admin-web::system-tasks' as ManagerKey
const admission = { target_session: { channel_id: 'admin-web', session_id: 'system-tasks', type: 'private' as const }, schedule_id: 'daily', trigger_id: 'trigger', window_start: '2026-09-16T18:00:00.000Z', window_end: '2026-09-17T18:00:00.000Z' }
const dirs: string[] = []
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))) })

async function setup(count = 1, content = 'evidence') {
  const dir = await mkdtemp(join(tmpdir(), 'daily-reflection-'))
  dirs.push(dir)
  const store = new ManagerSessionStore(dir)
  const records: ReflectionRecord[] = Array.from({ length: count }, (_, i) => ({
    record_ref: `ref-${i}`, kind: 'manager_episode', source_id: `episode-${i}`,
    activity_at: admission.window_start, summary: 'test evidence', gaps: [], digest: reflectionDigest(content),
    source: { kind: 'manager_episode', manager_key: 'other::session', episode_id: `episode-${i}`, log_bytes: 42, span_ids: [] },
  }))
  const deps: DailyReflectionDeps = { key, store, now: () => '2026-09-18T00:00:00.000Z',
    capture: vi.fn(async () => ({ records: structuredClone(records), gaps: [] })),
    read: vi.fn(async () => ({ content, gaps: [] })), analysisWorkers: vi.fn(async () => []),
    confirm: vi.fn(async () => ({ status: 'applied', watermark: admission.window_end })),
  }
  const host = new DailyReflection(deps)
  await host.admit(admission, 'episode-first')
  return { host, deps, store, records, dir }
}

function completion(extra: Record<string, unknown> = {}, toolCount = 1) {
  return { outcome: 'completed', exitToolCall: { name: 'finish_daily_reflection', input: {
    outcome: 'completed', summary: 'review done', pending_items: [], evidence_refs: [], ...extra,
  } }, messages: [{ id: 'a', role: 'assistant', timestamp: Date.now(), stopReason: 'tool_use',
    content: Array.from({ length: toolCount }, (_, i) => ({ type: 'tool_use', id: `call-${i}`, name: i ? 'write' : 'finish_daily_reflection', input: {} })),
  }] as EngineMessage[] }
}

async function ready(host: DailyReflection) {
  await host.list()
}

describe('DailyReflection host', () => {
  it('requires a new explicit completion after restarting with an obsolete failure ledger', async () => {
    const { host, deps, store } = await setup()
    await host.list()
    await host.finish(completion({ outcome: 'partial', pending_items: ['correct the memory ID'] }))
    await store.updateDailyReflection(key, state => ({ ...state!, tool_failures: { old: 'mcp__crab-memory__delete_memory' } }))
    const restarted = new DailyReflection(deps)
    await restarted.recover()
    await restarted.admit(undefined, 'continued')
    expect((await restarted.list() as any).previous_result.pending_items).toEqual(['correct the memory ID'])
    expect(deps.confirm).not.toHaveBeenCalled()
    expect((await restarted.finish(completion()))?.outcome).toBe('completed')
    expect(deps.confirm).toHaveBeenCalledOnce()
  })

  it.each(['partial', 'completed'])('keeps declared unfinished work partial when the model submits %s', async outcome => {
    const { host, deps, store } = await setup()
    await host.list()
    const result = await host.finish(completion({ outcome, pending_items: ['memory A is still unfinished'] }))
    expect(result?.outcome).toBe('partial')
    if (outcome === 'completed') expect(result?.validation_errors).toContain('pending_items_remain')
    await new DailyReflection(deps).recover()
    expect((await store.load(key)).dailyReflection?.result?.pending_items).toEqual(['memory A is still unfinished'])
    expect(deps.confirm).not.toHaveBeenCalled()
  })

  it('does not impose a prescribed Memory call sequence on explicit completion', async () => {
    const { host, deps } = await setup()
    await host.list()
    const result = await host.finish(completion())
    expect(result?.validation_errors).toEqual([])
    expect(result?.outcome).toBe('completed')
    expect(deps.confirm).toHaveBeenCalledOnce()
  })

  it('does not publish a failed inventory and retries without changing the admitted window', async () => {
    const { host, deps, store } = await setup()
    vi.mocked(deps.capture).mockResolvedValueOnce({ records: [], gaps: ['manager_inventory_unavailable'] })
    await expect(host.list()).rejects.toThrow('manager_inventory_unavailable')
    expect((await store.load(key)).dailyReflection?.manifest).toBeUndefined()
    await host.admit({ ...admission, window_end: '2026-09-18T18:00:00.000Z' }, 'retry')
    const page = await host.list() as any
    expect(page.window_end).toBe(admission.window_end)
    expect(page.records).toHaveLength(1)
    await host.list()
    expect(deps.capture).toHaveBeenCalledTimes(2)
  })

  it('recovers a failed initial detail read at the same source bounds and freezes its successful digest', async () => {
    const { host, deps, records } = await setup()
    vi.mocked(deps.capture).mockResolvedValueOnce({ records: [{ ...records[0], digest: '', gaps: ['temporary read failure'] }], gaps: [] })
    await ready(host)
    expect((await host.read('ref-0') as any).gaps).toEqual([])
    expect((await host.finish(completion()))?.outcome).toBe('completed')
    vi.mocked(deps.read).mockResolvedValueOnce({ content: 'changed evidence', gaps: [] })
    expect((await host.read('ref-0') as any).gaps).toContain('frozen_evidence_changed')
    expect(deps.read).toHaveBeenCalledWith(expect.objectContaining({ source: records[0].source }), expect.anything())
  })

  it('freezes the directory, refuses forged cursors, and preserves progress across restart/history saves', async () => {
    const { host, deps, store } = await setup(21)
    const stale = await store.load(key)
    const first = await host.list() as any
    expect(first.records).toHaveLength(20)
    expect(first.records[0]).not.toHaveProperty('source')
    await expect(host.list('forged')).rejects.toThrow('INVALID_REFLECTION_CURSOR')
    await store.save({ ...stale, recent: [], foldedCount: 9 })
    const restarted = new DailyReflection(deps)
    const last = await restarted.list(first.next_cursor) as any
    expect(last.records).toHaveLength(1)
    expect(last.next_cursor).toBeUndefined()
    expect(deps.capture).toHaveBeenCalledOnce()
    expect((await store.load(key)).dailyReflection?.directory_complete).toBe(true)
  })

  it('reads Unicode through bounded pages and rejects a cursor for another record', async () => {
    const { host, store } = await setup(2, '汉🙂'.repeat(5000))
    await ready(host)
    let page = await host.read('ref-0') as any
    expect(Buffer.byteLength(page.content)).toBeLessThanOrEqual(16 * 1024)
    expect(page.content).not.toContain('\uFFFD')
    await expect(host.read('ref-1', page.next_cursor)).rejects.toThrow('INVALID_REFLECTION_CURSOR')
    expect((await host.finish(completion())).outcome).toBe('partial')
    while (page.next_cursor) page = await host.read('ref-0', page.next_cursor)
    expect((await store.load(key)).dailyReflection?.read_records['ref-0']).toBe(true)
  })

  it('rediscovers the persisted directory position after restart without the previous tool history', async () => {
    const { host, deps, dir } = await setup(45)
    const first = await host.list() as any
    const second = await host.list(first.next_cursor) as any
    const restarted = new DailyReflection({ ...deps, store: new ManagerSessionStore(dir) })
    await restarted.admit({ ...admission, trigger_id: 'next', window_end: '2026-09-19T18:00:00.000Z' }, 'next-episode')
    const rediscovered = await restarted.list() as any
    expect(rediscovered.window_end).toBe(admission.window_end)
    expect(rediscovered.records[0].record_ref).toBe('ref-0')
    expect(rediscovered.progress).toEqual({ directory_total: 45, directory_read: 40, directory_complete: false,
      resume_cursor: first.next_cursor, pending_record_count: 0, pending_records: [], evidence_gap_count: 0 })
    expect((await restarted.list(rediscovered.next_cursor) as any).records[0].record_ref).toBe('ref-20')
    expect((await restarted.finish(completion()))?.validation_errors).toContain('directory_not_fully_read')
    const replayed = await restarted.list(rediscovered.progress.resume_cursor)
    expect(replayed.records[0].record_ref).toBe('ref-20')
    const last = await restarted.list(replayed.next_cursor)
    expect(last.records.map((record: any) => record.record_ref)).toEqual(['ref-40', 'ref-41', 'ref-42', 'ref-43', 'ref-44'])
    expect(last.progress).toMatchObject({ directory_read: 45, directory_complete: true })
    expect(last.progress.resume_cursor).toBe(second.next_cursor)
    expect((await restarted.list()).progress.resume_cursor).toBe(second.next_cursor)
    expect(deps.capture).toHaveBeenCalledOnce()
    expect(deps.confirm).not.toHaveBeenCalled()
    await restarted.read('ref-44')
    expect((await restarted.finish(completion({ evidence_refs: ['ref-44'] })))?.outcome).toBe('completed')
    expect(deps.confirm).toHaveBeenCalledWith(expect.objectContaining({ trigger_id: admission.trigger_id, window_end: admission.window_end }))
  })

  it.each([20, 40])('replays page %s after its progress is persisted but its tool result is lost', async offset => {
    const { host, deps, store, dir } = await setup(45)
    let page = await host.list()
    if (offset === 40) page = await host.list(page.next_cursor)
    const lostCursor = page.next_cursor
    const save = store.updateDailyReflection.bind(store)
    vi.spyOn(store, 'updateDailyReflection').mockImplementationOnce(async (...args) => {
      await save(...args)
      throw new Error('restart before tool result checkpoint')
    })
    await expect(host.list(lostCursor)).rejects.toThrow('restart before tool result checkpoint')
    const restarted = new DailyReflection({ ...deps, store: new ManagerSessionStore(dir) })
    const discovered = await restarted.list()
    expect(discovered.progress).toMatchObject({ directory_read: offset === 40 ? 45 : 40,
      directory_complete: offset === 40, resume_cursor: lostCursor })
    const replayed = await restarted.list(discovered.progress.resume_cursor)
    expect(replayed.records[0].record_ref).toBe(`ref-${offset}`)
    if (offset === 20) expect((await restarted.list(replayed.next_cursor)).records[0].record_ref).toBe('ref-40')
    expect(deps.capture).toHaveBeenCalledOnce()
    expect(deps.confirm).not.toHaveBeenCalled()
  })

  it.each([0, 1, 20, 40])('keeps the last page reachable for a directory of %s records', async count => {
    const { host, deps, dir } = await setup(count)
    let page = await host.list()
    while (page.next_cursor) page = await host.list(page.next_cursor)
    const restarted = new DailyReflection({ ...deps, store: new ManagerSessionStore(dir) })
    const discovered = await restarted.list()
    expect(discovered.progress).toMatchObject({ directory_read: count, directory_complete: true })
    if (count <= 20) expect(discovered.progress.resume_cursor).toBeUndefined()
    else expect((await restarted.list(discovered.progress.resume_cursor)).records[0].record_ref).toBe('ref-20')
  })

  it('rediscovers bounded unfinished details and gaps without treating old detail cursors as successful coverage', async () => {
    const { host, deps, dir } = await setup(21, 'x'.repeat(20_000))
    const first = await host.list() as any
    await host.list(first.next_cursor)
    for (let i = 0; i < 21; i++) await host.read(`ref-${i}`)
    vi.mocked(deps.read).mockRejectedValueOnce(new Error('source unavailable'))
    await host.read('ref-0')
    const restarted = new DailyReflection({ ...deps, store: new ManagerSessionStore(dir) })
    let page = await restarted.list() as any
    expect(page.progress).toMatchObject({ directory_total: 21, directory_read: 21, directory_complete: true,
      pending_record_count: 21, evidence_gap_count: 1 })
    expect(page.progress.pending_records).toEqual(Array.from({ length: 20 }, (_, i) => ({ record_ref: `ref-${i}` })))
    expect((await restarted.finish(completion()))?.validation_errors).toEqual(expect.arrayContaining(['record_not_fully_read', 'known_evidence_gaps']))
    const detail = await restarted.read(page.progress.pending_records[0].record_ref) as any
    await restarted.read('ref-0', detail.next_cursor)
    page = await restarted.list() as any
    expect(page.progress).toMatchObject({ pending_record_count: 20, evidence_gap_count: 0 })
    expect(page.progress.pending_records).toEqual(Array.from({ length: 20 }, (_, i) => ({ record_ref: `ref-${i + 1}` })))
    expect(deps.confirm).not.toHaveBeenCalled()
  })

  it('natural end_turn, max turns, or missing finish never confirms the watermark', async () => {
    const { host, deps } = await setup()
    await ready(host)
    await host.finish({ outcome: 'completed', messages: [] })
    await host.finish({ ...completion(), outcome: 'max_turns' })
    expect(deps.confirm).not.toHaveBeenCalled()
  })

  it('persists completion before confirmation and retries only confirmation after a lost response', async () => {
    const { host, deps, store } = await setup()
    await ready(host)
    vi.mocked(deps.confirm).mockImplementationOnce(async () => {
      expect((await store.load(key)).dailyReflection?.result?.outcome).toBe('completed')
      throw new Error('response lost')
    })
    expect((await host.finish(completion()))?.outcome).toBe('partial')
    expect((await store.load(key)).dailyReflection?.confirmation_pending).toBe(true)
    const restarted = new DailyReflection(deps)
    await restarted.recover()
    expect(deps.confirm).toHaveBeenCalledTimes(2)
    expect((await store.load(key)).dailyReflection?.confirmation_pending).toBe(false)
    expect(deps.capture).toHaveBeenCalledOnce()
    expect(deps.read).not.toHaveBeenCalled()
    expect(await restarted.admit({ ...admission, trigger_id: 'queued-before-confirmation' }, 'queued')).toBe(false)
    expect(await restarted.admit({ ...admission, trigger_id: 'next', window_start: admission.window_end, window_end: '2026-09-18T18:00:00.000Z' }, 'next')).toBe(true)
    await expect(restarted.list('old-run-cursor')).rejects.toThrow('INVALID_REFLECTION_CURSOR')
  })

  it('keeps the original window across waiting and next scheduled trigger', async () => {
    const { host, deps, store } = await setup()
    await ready(host)
    vi.mocked(deps.analysisWorkers).mockResolvedValue([{ worker_id: 'analysis', pending: true }])
    expect((await host.finish(completion()))?.validation_errors).toContain('analysis_worker_pending')
    await host.admit({ ...admission, trigger_id: 'next', window_end: '2026-09-18T18:00:00.000Z' }, 'episode-next')
    const state = (await store.load(key)).dailyReflection!
    expect(state.window_end).toBe(admission.window_end)
    expect(state.episode_ids).toEqual(['episode-first', 'episode-next'])
    expect(state.analysis_worker_ids).toEqual(['analysis'])
    expect(deps.confirm).not.toHaveBeenCalled()
  })

  it('blocks incomplete directory, unknown evidence, skipped tools and unproven delivery', async () => {
    const { host, deps } = await setup(21)
    await ready(host)
    const result = await host.finish(completion({ evidence_refs: ['forged'], summary_delivered: true }, 2))
    expect(result?.validation_errors).toEqual(expect.arrayContaining([
      'directory_not_fully_read', 'unread_evidence_reference', 'finish_must_be_called_alone', 'summary_delivery_unproven',
    ]))
    expect(deps.confirm).not.toHaveBeenCalled()
  })

  it('known evidence gaps remain partial until facts are resolved', async () => {
    const { host, deps } = await setup()
    await ready(host)
    vi.mocked(deps.read).mockRejectedValueOnce(new Error('source unavailable'))
    expect((await host.read('ref-0') as any).gaps).toContain('source unavailable')
    expect((await host.finish(completion()))?.validation_errors).toContain('known_evidence_gaps')
    await host.read('ref-0')
    expect((await host.finish(completion({ evidence_refs: ['ref-0'] })))?.outcome).toBe('completed')
    expect(deps.confirm).toHaveBeenCalledOnce()
  })
})
