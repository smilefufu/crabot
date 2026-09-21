import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DailyReflection, buildDailyReflectionTools, reflectionDigest, type DailyReflectionDeps } from '../../src/manager/daily-reflection.js'
import { runEngine } from '../../src/engine/query-loop.js'
import type { LLMAdapter } from '../../src/engine/llm-adapter-types.js'
import { chunksFromContent } from '../engine/helpers/mock-stream.js'
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
  it('counts missing frozen details as handled without inventing read evidence, including after restart', async () => {
    const { host, deps, records, store } = await setup()
    const record = { ...records[0], gaps: ['manager_trace_unavailable'] }
    vi.mocked(deps.capture).mockResolvedValueOnce({ records: [record], gaps: [] })
    await store.updateDailyReflection(key, state => ({ ...state!, read_records: { 'ref-0': false } }))
    const page = await host.list()
    expect(page.records[0]).toMatchObject({ gaps: record.gaps, skipped: 'source_unavailable' })
    expect(page.progress).toMatchObject({ evidence_gap_count: 0, skipped_record_count: 1, pending_record_count: 0 })
    expect(deps.read).not.toHaveBeenCalled()
    vi.mocked(deps.read).mockResolvedValue({ content: '[]', gaps: ['manager_trace_unavailable'] })
    const restarted = new DailyReflection(deps)
    expect(await restarted.read('ref-0')).toEqual({ record_ref: 'ref-0', content: '[]',
      gaps: ['manager_trace_unavailable', 'frozen_evidence_changed'], skipped: 'source_unavailable' })
    expect((await store.load(key)).dailyReflection?.read_records['ref-0']).not.toBe(true)
    expect(await restarted.validateFinish(completion({ evidence_refs: ['ref-0'] }).exitToolCall.input, 1)).toContain('skipped_source_unavailable')
    const result = await restarted.finish(completion())
    expect(result?.outcome).toBe('completed')
    expect(result?.validation_errors).toEqual([])
    expect(deps.confirm).toHaveBeenCalledWith(expect.objectContaining({ window_start: admission.window_start, window_end: admission.window_end }))
  })

  it.each([
    'manager_trace_unavailable', 'manager_history_unavailable', 'manager_span_unavailable:span',
    'human_input_unavailable:message', 'worker_turn_unavailable:turn', 'worker_events_truncated',
    'episode_history_truncated', 'ENOENT: no such file or directory, open /old/episode.jsonl',
    'native unavailable: Codex native rollout is unavailable',
    'native degraded (served from agent-owned copy): builtin trace source unavailable',
    'native unavailable: CodexWorkerAdapter.readTrace: no such incarnation w-old#1 resident in this process',
    '2 legacy trace reference(s) unavailable',
  ])('handles a missing detail discovered on read while retaining its frozen digest: %s', async gap => {
    const { host, deps, store, records } = await setup()
    await host.list()
    vi.mocked(deps.read).mockResolvedValueOnce({ content: 'surviving subset', gaps: [gap] })
    expect(await host.read('ref-0')).toMatchObject({ skipped: 'source_unavailable', content: 'surviving subset', gaps: [gap, 'frozen_evidence_changed'] })
    const current = (await store.load(key)).dailyReflection!
    expect(current.manifest!.records[0].digest).toBe(records[0].digest)
    expect(current.read_records['ref-0']).not.toBe(true)
    expect((await host.finish(completion()))?.outcome).toBe('completed')
  })

  it('handles a historical capture whose frozen trace bound is absent without treating a fresh read error as absence', async () => {
    const { host, deps, records } = await setup(21)
    const gap = 'worker_trace_unavailable:old-worker:1'
    const record: ReflectionRecord = { ...records[20], kind: 'worker', gaps: [gap], digest: '',
      source: { kind: 'worker', worker_id: 'old-worker', traces: [], turn_ids: [], event_count: 5, gaps: [gap] } }
    vi.mocked(deps.capture).mockResolvedValueOnce({ records: [...records.slice(0, 20), record], gaps: [] })
    const page = await host.list()
    expect(page.progress).toMatchObject({ directory_complete: false, skipped_record_count: 1, evidence_gap_count: 0 })
    vi.mocked(deps.read).mockResolvedValue({ content: 'surviving events', gaps: [gap] })
    expect(await host.read('ref-20')).toMatchObject({ skipped: 'source_unavailable', gaps: [gap] })
    expect((await host.finish(completion()))?.validation_errors).toContain('directory_not_fully_read')
    await host.list(page.next_cursor)
    expect((await host.finish(completion()))?.outcome).toBe('completed')
  })

  it('keeps surviving content pageable when some sources were skipped, without making it complete evidence', async () => {
    const { host, deps, records, store } = await setup()
    const gap = 'native degraded (served from agent-owned copy): builtin trace source unavailable'
    vi.mocked(deps.capture).mockResolvedValueOnce({ records: [{ ...records[0], gaps: [gap] }], gaps: [] })
    const content = 'surviving activity '.repeat(2000)
    vi.mocked(deps.read).mockResolvedValue({ content, gaps: [gap] })
    await host.list()
    let cursor: string | undefined
    let actual = ''
    do {
      const page = await host.read('ref-0', cursor) as { content: string; next_cursor?: string; skipped?: string }
      expect(page.skipped).toBe('source_unavailable')
      actual += page.content
      cursor = page.next_cursor
    } while (cursor)
    expect(actual).toBe(content)
    expect((await store.load(key)).dailyReflection?.read_records['ref-0']).toBe(false)
    expect(await host.validateFinish(completion({ evidence_refs: ['ref-0'] }).exitToolCall.input, 1)).toContain('skipped_source_unavailable')
    expect((await host.finish(completion()))?.outcome).toBe('completed')
  })

  it('rechecks explicitly requested skipped details and restores normal validation when all evidence is available', async () => {
    const { host, deps, records } = await setup()
    vi.mocked(deps.capture).mockResolvedValueOnce({ records: [{ ...records[0], gaps: ['manager_trace_unavailable'] }], gaps: [] })
    expect((await host.list()).progress.skipped_record_count).toBe(1)
    expect(await host.read('ref-0')).toEqual({ record_ref: 'ref-0', content: 'evidence', gaps: [] })
    expect(await host.validateFinish(completion({ evidence_refs: ['ref-0'] }).exitToolCall.input, 1)).toBeUndefined()
    expect((await host.list()).progress.skipped_record_count).toBe(0)
  })

  it.each(['frozen_evidence_changed', 'invalid_episode_history', 'EACCES: permission denied',
    'native unavailable: EIO: read failed', '637 malformed or unreadable legacy trace record(s)',
    'worker_trace_unavailable:old-worker:1'])('does not skip unproven source failures: %s', async gap => {
    const { host, deps } = await setup()
    await host.list()
    vi.mocked(deps.read).mockResolvedValueOnce({ content: 'evidence', gaps: [gap] })
    expect(await host.read('ref-0')).not.toHaveProperty('skipped')
    expect((await host.finish(completion()))?.outcome).toBe('partial')
    expect(deps.confirm).not.toHaveBeenCalled()
  })

  it('keeps directory and other read failures blocking even when a missing record was skipped', async () => {
    const { host, deps } = await setup(21)
    await host.list()
    vi.mocked(deps.read).mockResolvedValueOnce({ content: '', gaps: ['manager_trace_unavailable'] })
    await host.read('ref-0')
    vi.mocked(deps.read).mockResolvedValueOnce({ content: '', gaps: ['manager_trace_unavailable', 'EACCES: permission denied'] })
    expect(await host.read('ref-1')).not.toHaveProperty('skipped')
    const result = await host.finish(completion())
    expect(result?.validation_errors).toEqual(expect.arrayContaining(['directory_not_fully_read', 'known_evidence_gaps', 'record_not_fully_read']))
    expect(deps.confirm).not.toHaveBeenCalled()
  })

  it.each(['execution', 'mismatch', 'gap', 'read_failure', 'no_digest', 'trace', 'turn'])(
    'does not label an unproven frozen worker as migration-only: %s', async scenario => {
      const original = JSON.stringify([{ kind: 'legacy_imported', ts: admission.window_start }])
      const { host, deps, records, store } = await setup()
      const record: ReflectionRecord = { ...records[0], kind: 'worker', source_id: 'old-worker',
        digest: scenario === 'no_digest' ? '' : reflectionDigest(original),
        source: { kind: 'worker', worker_id: 'old-worker', event_count: 1, gaps: [],
          traces: scenario === 'trace' ? [{ seq: 1, incarnation_fingerprint: 'legacy', upper_bound: { native: 0, harness: 1, legacy: 1 } }] : [],
          turn_ids: scenario === 'turn' ? ['turn'] : [] } }
      const content = scenario === 'mismatch' ? `${original} `
        : scenario === 'execution' ? JSON.stringify([{ kind: 'error', ts: admission.window_start }]) : original
      if (scenario === 'execution') record.digest = reflectionDigest(content)
      vi.mocked(deps.capture).mockResolvedValueOnce({ records: [record], gaps: [] })
      vi.mocked(deps.read).mockResolvedValue({ content, gaps: scenario === 'gap' ? ['source unavailable'] : [] })
      if (scenario === 'read_failure') vi.mocked(deps.read).mockRejectedValue(new Error('source unavailable'))

      const page = await host.list()
      expect(page.records[0].summary).toBe(record.summary)
      const current = (await store.load(key)).dailyReflection!
      expect(current.manifest?.records[0]).toEqual(record)
      expect(current.read_records).toEqual({})
      if (['no_digest', 'trace', 'turn'].includes(scenario)) expect(deps.read).not.toHaveBeenCalled()
    },
  )

  it.each(['completed', 'partial'])('validates %s references without persisting a result or requiring full coverage', async outcome => {
    const { host, deps, store } = await setup(21)
    await host.list()
    await host.read('ref-0')
    vi.mocked(deps.read).mockResolvedValueOnce({ content: 'evidence', gaps: ['trace_unavailable'] })
    await host.read('ref-1')
    const before = await store.load(key)
    const finish = buildDailyReflectionTools(host).find(tool => tool.name === 'finish_daily_reflection')!
    const input = completion({ outcome, evidence_refs: ['mem-l-candidate', 'ref-1', 'ref-2'] }).exitToolCall.input
    const error = await finish.validateExit!(input, 1)
    expect(error).toContain('mem-l-candidate')
    expect(error).toContain('not_in_current_directory')
    expect(error).toContain('ref-1')
    expect(error).toContain('incomplete_or_gapped')
    expect(error).toContain('ref-2')
    expect(error).toContain('not_read')
    expect(await finish.validateExit!({ ...input, evidence_refs: ['ref-0'] }, 1)).toBeUndefined()
    expect(await finish.validateExit!({ ...input, evidence_refs: [] }, 1)).toBeUndefined()
    expect(await store.load(key)).toEqual(before)
    expect(deps.confirm).not.toHaveBeenCalled()
  })

  it('rejects malformed input and mixed calls before reading or writing host state', async () => {
    const { host, store } = await setup()
    const load = vi.spyOn(store, 'load')
    const finish = buildDailyReflectionTools(host).find(tool => tool.name === 'finish_daily_reflection')!
    expect(await finish.validateExit!({}, 1)).toContain('invalid_completion_input')
    expect(await finish.validateExit!(completion().exitToolCall.input, 2)).toContain('finish_must_be_called_alone')
    expect(load).not.toHaveBeenCalled()
  })

  it('uses the same current-directory rule before exit and in the final host check', async () => {
    const { host, store } = await setup()
    await host.list()
    await store.updateDailyReflection(key, state => ({ ...state!, read_records: { forged: true } }))
    const input = completion({ evidence_refs: ['forged'] })
    const finish = buildDailyReflectionTools(host).find(tool => tool.name === 'finish_daily_reflection')!
    expect(await finish.validateExit!(input.exitToolCall.input, 1)).toContain('not_in_current_directory')
    expect((await host.finish(input))?.validation_errors).toContain('unread_evidence_reference')
  })

  it('lets the actual Engine correct rejected evidence in the same run before persisting partial', async () => {
    const { host, deps, store } = await setup(21)
    await host.list()
    vi.mocked(deps.read).mockResolvedValue({ content: 'evidence', gaps: ['trace_unavailable'] })
    await host.read('ref-0')
    const before = await store.load(key)
    const corrected = completion({ outcome: 'partial', pending_items: ['history evidence unavailable'] }).exitToolCall.input
    let calls = 0
    const adapter: LLMAdapter = {
      updateConfig() {},
      async *stream(params) {
        if (calls++ === 1) {
          expect(params.messages.at(-1)).toMatchObject({ toolResults: [
            { is_error: true, content: expect.stringContaining('unread_evidence_reference') },
          ] })
          expect(await store.load(key)).toEqual(before)
        }
        yield* chunksFromContent([{ type: 'tool_use', id: `finish-${calls}`, name: 'finish_daily_reflection',
          input: calls === 1 ? { ...corrected, evidence_refs: ['ref-0', 'ref-1', 'mem-l-candidate'] } : corrected,
        }], 'tool_use', { inputTokens: 10, outputTokens: 10 })
      },
    }
    const result = await runEngine({ prompt: 'continue daily reflection', adapter,
      options: { systemPrompt: '', model: 'fixture', tools: buildDailyReflectionTools(host), maxTurns: 3 } })
    expect(calls).toBe(2)
    expect(result.exitToolCall?.input).toEqual(corrected)
    expect(await store.load(key)).toEqual(before)
    const finished = await host.finish({ outcome: result.outcome, exitToolCall: result.exitToolCall, messages: result.finalMessages })
    expect(finished?.outcome).toBe('partial')
    expect(finished?.validation_errors).not.toContain('unread_evidence_reference')
    expect(finished?.validation_errors).toContain('known_evidence_gaps')
    expect(deps.confirm).not.toHaveBeenCalled()
    expect((await store.load(key)).dailyReflection?.run_id).toBe(before.dailyReflection?.run_id)
  })

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
      resume_cursor: first.next_cursor, pending_record_count: 0, pending_records: [], evidence_gap_count: 0, skipped_record_count: 0 })
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
