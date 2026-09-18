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
  return { host, deps, store, records }
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
  await host.observe('mcp__crab-memory__list_entries', { status: 'inbox' }, { isError: false, output: '{}' })
}

describe('DailyReflection host', () => {
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
    expect((await host.finish(completion()))?.outcome).toBe('completed')
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

  it('known evidence gaps and unresolved Memory failure remain partial until facts are resolved', async () => {
    const { host, deps } = await setup()
    await ready(host)
    await host.observe('mcp__crab-memory__delete_memory', { id: 'entry' }, { isError: true, output: 'failed' })
    expect((await host.finish(completion()))?.validation_errors).toContain('unresolved_tool_failures')
    await host.observe('mcp__crab-memory__delete_memory', { id: 'entry' }, { isError: false, output: '{}' })
    vi.mocked(deps.read).mockRejectedValueOnce(new Error('source unavailable'))
    expect((await host.read('ref-0') as any).gaps).toContain('source unavailable')
    expect((await host.finish(completion()))?.validation_errors).toContain('known_evidence_gaps')
    await host.read('ref-0')
    expect((await host.finish(completion({ evidence_refs: ['ref-0'] })))?.outcome).toBe('completed')
    expect(deps.confirm).toHaveBeenCalledOnce()
  })
})
