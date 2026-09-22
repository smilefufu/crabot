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
import type { EngineMessage, EngineToolLifecycleEvent } from '../../src/engine/types.js'
import { listPage, readPage } from './reflection-fixture.js'

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
  await listPage(host)
}

describe('DailyReflection host', () => {
  it('continuation: traverses 15010 frozen records in bounded hundred-record pages without gaps or duplicates', async () => {
    const { deps, store, records } = await setup(15010)
    let session = await store.load(key)
    vi.spyOn(store, 'load').mockImplementation(async () => structuredClone(session))
    vi.spyOn(store, 'updateDailyReflection').mockImplementation(async (_key, update) => {
      session = { ...session, dailyReflection: update(session.dailyReflection) }
    })
    const host = new DailyReflection(deps)
    const refs: string[] = []
    let page = await listPage(host)
    expect(page.records).toHaveLength(100)
    let pages = 0
    do {
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(80 * 1024)
      refs.push(...page.records.map(record => record.record_ref))
      pages++
      if (!page.has_more) break
      page = await listPage(host)
    } while (true)
    expect(pages).toBe(151)
    expect(refs).toEqual(records.map(record => record.record_ref))
    expect((await listPage(host)).progress).toMatchObject({ directory_complete: true, directory_read: 15010 })
    expect(session.dailyReflection?.manifest?.records).toEqual(records)
    expect(session.dailyReflection?.read_records).toEqual({})
  })

  it('continuation: caps complete Unicode JSON pages and resumes a variable-length page after restart', async () => {
    const { host, records, deps, store, dir } = await setup(30)
    records.forEach(record => { record.summary = '汉🙂\\'.repeat(3000) })
    const first = await listPage(host)
    expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThanOrEqual(80 * 1024)
    expect(first.records.length).toBeGreaterThan(0)
    expect(first.records.length).toBeLessThan(30)
    expect(first.records[0].summary).toBe(records[0].summary)
    const second = await host.list()
    expect(Buffer.byteLength(JSON.stringify(second.output))).toBeLessThanOrEqual(80 * 1024)
    const saved = (await store.load(key)).dailyReflection!
    const restarted = new DailyReflection({ ...deps, store: new ManagerSessionStore(dir) })
    const discovered = await listPage(restarted)
    expect(discovered.progress.directory_read).toBe(second.output.progress.directory_read)
    expect(discovered.records.map(r => r.record_ref)).toEqual(second.output.records.map(r => r.record_ref))
    expect((await store.load(key)).dailyReflection?.reading?.directory.offset).toBe(saved.reading!.directory.pending!.end)
  })

  it.each(['record', 'metadata'])('continuation: refuses oversized %s without changing persisted progress', async oversized => {
    const { host, records, store } = await setup()
    if (oversized === 'record') records[0].summary = '汉'.repeat(30_000)
    else await store.updateDailyReflection(key, state => ({ ...state!, result: {
      ...completion().exitToolCall.input, outcome: 'partial', run_id: state!.run_id,
      window_start: state!.window_start, window_end: state!.window_end, completed_at: admission.window_end,
      validation_errors: [], summary: 'x'.repeat(90_000),
    } as never }))
    const before = await store.load(key)
    await expect(listPage(host)).rejects.toThrow('REFLECTION_DIRECTORY_PAGE_TOO_LARGE')
    expect(await store.load(key)).toEqual(before)
  })

  it.each([false, true])('continuation: conservatively resumes old twenty-record pages when upgrading completed=%s', async complete => {
    const { host, store, records, deps } = await setup(complete ? 225 : 301)
    await store.updateDailyReflection(key, state => ({ ...state!, manifest: { records, gaps: [] },
      directory_complete: complete,
      cursors: Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`old-${(i + 1) * 20}`, { offset: (i + 1) * 20 }])) }))
    const discovered = await listPage(host)
    expect(discovered.progress).toMatchObject({ directory_read: complete ? 220 : 200, directory_complete: false })
    expect(discovered.records[0].record_ref).toBe(complete ? 'ref-220' : 'ref-200')
    expect((await store.load(key)).dailyReflection?.reading?.directory.offset).toBe(complete ? 225 : 300)
    expect((await listPage(host, true)).records[0].record_ref).toBe('ref-0')
    expect(deps.capture).not.toHaveBeenCalled()
  })

  it('continuation: exposes unstarted gaps behind the frontier and drains them without changing pending detail semantics', async () => {
    const { host, store, records, deps } = await setup(301)
    records.slice(0, 23).forEach(record => { record.gaps = ['old diagnostic'] })
    records[23].gaps = ['manager_trace_unavailable']
    await store.updateDailyReflection(key, state => ({ ...state!, manifest: { records, gaps: [] },
      cursors: { old200: { offset: 200 }, old220: { offset: 220 } } }))
    const first = await listPage(host)
    expect(first.progress).toMatchObject({ evidence_gap_count: 23, pending_record_count: 0, skipped_record_count: 1 })
    expect(first.progress.evidence_gap_records).toEqual(records.slice(0, 20).map(({ record_ref }) => ({ record_ref })))
    for (const record of first.progress.evidence_gap_records) await readPage(host, record.record_ref)
    const restarted = new DailyReflection(deps)
    const next = await listPage(restarted)
    expect(next.progress.evidence_gap_records).toEqual(records.slice(20, 23).map(({ record_ref }) => ({ record_ref })))
    expect(next.progress).toMatchObject({ evidence_gap_count: 3, pending_record_count: 0 })
    vi.mocked(deps.read).mockRejectedValueOnce(new Error('EIO'))
    await readPage(restarted, 'ref-20')
    expect((await listPage(restarted)).progress).toMatchObject({ evidence_gap_count: 3, pending_record_count: 1 })
  })

  it('counts missing frozen details as handled without inventing read evidence, including after restart', async () => {
    const { host, deps, records, store } = await setup()
    const record = { ...records[0], gaps: ['manager_trace_unavailable'] }
    vi.mocked(deps.capture).mockResolvedValueOnce({ records: [record], gaps: [] })
    await store.updateDailyReflection(key, state => ({ ...state!, read_records: { 'ref-0': false } }))
    const page = await listPage(host)
    expect(page.records[0]).toMatchObject({ gaps: record.gaps, skipped: 'source_unavailable' })
    expect(page.progress).toMatchObject({ evidence_gap_count: 0, skipped_record_count: 1, pending_record_count: 0 })
    expect(deps.read).not.toHaveBeenCalled()
    vi.mocked(deps.read).mockResolvedValue({ content: '[]', gaps: ['manager_trace_unavailable'] })
    const restarted = new DailyReflection(deps)
    expect(await readPage(restarted, 'ref-0')).toEqual({ record_ref: 'ref-0', content: '[]', has_more: false,
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
    await listPage(host)
    vi.mocked(deps.read).mockResolvedValueOnce({ content: 'surviving subset', gaps: [gap] })
    expect(await readPage(host, 'ref-0')).toMatchObject({ skipped: 'source_unavailable', content: 'surviving subset', gaps: [gap, 'frozen_evidence_changed'] })
    const current = (await store.load(key)).dailyReflection!
    expect(current.manifest!.records[0].digest).toBe(records[0].digest)
    expect(current.read_records['ref-0']).not.toBe(true)
    expect((await host.finish(completion()))?.outcome).toBe('completed')
  })

  it('handles a historical capture whose frozen trace bound is absent without treating a fresh read error as absence', async () => {
    const { host, deps, records } = await setup(101)
    const gap = 'worker_trace_unavailable:old-worker:1'
    const record: ReflectionRecord = { ...records[100], kind: 'worker', gaps: [gap], digest: '',
      source: { kind: 'worker', worker_id: 'old-worker', traces: [], turn_ids: [], event_count: 5, gaps: [gap] } }
    vi.mocked(deps.capture).mockResolvedValueOnce({ records: [...records.slice(0, 100), record], gaps: [] })
    const page = await listPage(host)
    expect(page.progress).toMatchObject({ directory_complete: false, skipped_record_count: 1, evidence_gap_count: 0 })
    vi.mocked(deps.read).mockResolvedValue({ content: 'surviving events', gaps: [gap] })
    expect(await readPage(host, 'ref-100')).toMatchObject({ skipped: 'source_unavailable', gaps: [gap] })
    expect((await host.finish(completion()))?.validation_errors).toContain('directory_not_fully_read')
    await listPage(host)
    expect((await host.finish(completion()))?.outcome).toBe('completed')
  })

  it('keeps surviving content pageable when some sources were skipped, without making it complete evidence', async () => {
    const { host, deps, records, store } = await setup()
    const gap = 'native degraded (served from agent-owned copy): builtin trace source unavailable'
    vi.mocked(deps.capture).mockResolvedValueOnce({ records: [{ ...records[0], gaps: [gap] }], gaps: [] })
    const content = 'surviving activity '.repeat(2000)
    vi.mocked(deps.read).mockResolvedValue({ content, gaps: [gap] })
    await listPage(host)
    let hasMore: boolean
    let actual = ''
    do {
      const page = await readPage(host, 'ref-0')
      expect(page.skipped).toBe('source_unavailable')
      actual += page.content
      hasMore = page.has_more
    } while (hasMore)
    expect(actual).toBe(content)
    expect((await store.load(key)).dailyReflection?.read_records['ref-0']).toBe(false)
    expect(await host.validateFinish(completion({ evidence_refs: ['ref-0'] }).exitToolCall.input, 1)).toContain('skipped_source_unavailable')
    expect((await host.finish(completion()))?.outcome).toBe('completed')
  })

  it('rechecks explicitly requested skipped details and restores normal validation when all evidence is available', async () => {
    const { host, deps, records } = await setup()
    vi.mocked(deps.capture).mockResolvedValueOnce({ records: [{ ...records[0], gaps: ['manager_trace_unavailable'] }], gaps: [] })
    expect((await listPage(host)).progress.skipped_record_count).toBe(1)
    expect(await readPage(host, 'ref-0')).toEqual({ record_ref: 'ref-0', content: 'evidence', has_more: false, gaps: [] })
    expect(await host.validateFinish(completion({ evidence_refs: ['ref-0'] }).exitToolCall.input, 1)).toBeUndefined()
    expect((await listPage(host)).progress.skipped_record_count).toBe(0)
  })

  it.each(['frozen_evidence_changed', 'invalid_episode_history', 'EACCES: permission denied',
    'native unavailable: EIO: read failed', '637 malformed or unreadable legacy trace record(s)',
    'worker_trace_unavailable:old-worker:1'])('does not skip unproven source failures: %s', async gap => {
    const { host, deps } = await setup()
    await listPage(host)
    vi.mocked(deps.read).mockResolvedValueOnce({ content: 'evidence', gaps: [gap] })
    expect(await readPage(host, 'ref-0')).not.toHaveProperty('skipped')
    expect((await host.finish(completion()))?.outcome).toBe('partial')
    expect(deps.confirm).not.toHaveBeenCalled()
  })

  it('keeps directory and other read failures blocking even when a missing record was skipped', async () => {
    const { host, deps } = await setup(101)
    await listPage(host)
    vi.mocked(deps.read).mockResolvedValueOnce({ content: '', gaps: ['manager_trace_unavailable'] })
    await readPage(host, 'ref-0')
    vi.mocked(deps.read).mockResolvedValueOnce({ content: '', gaps: ['manager_trace_unavailable', 'EACCES: permission denied'] })
    expect(await readPage(host, 'ref-1')).not.toHaveProperty('skipped')
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

      const page = await listPage(host)
      expect(page.records[0].summary).toBe(record.summary)
      const current = (await store.load(key)).dailyReflection!
      expect(current.manifest?.records[0]).toEqual(record)
      expect(current.read_records).toEqual({})
      if (['no_digest', 'trace', 'turn'].includes(scenario)) expect(deps.read).not.toHaveBeenCalled()
    },
  )

  it.each(['completed', 'partial'])('validates %s references and rejects remaining actionable coverage without persisting a result', async outcome => {
    const { host, deps, store } = await setup(101)
    await listPage(host)
    await readPage(host, 'ref-0')
    vi.mocked(deps.read).mockResolvedValueOnce({ content: 'evidence', gaps: ['trace_unavailable'] })
    await readPage(host, 'ref-1')
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
    expect(await finish.validateExit!({ ...input, evidence_refs: ['ref-0'] }, 1)).toContain('actionable_evidence_remaining')
    expect(await finish.validateExit!({ ...input, evidence_refs: [] }, 1)).toContain('actionable_evidence_remaining')
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

  it('rejects early partial and lets the same Engine finish the directory before exiting', async () => {
    const { host, deps, store } = await setup(101)
    await listPage(host)
    const savedTools: EngineToolLifecycleEvent[] = []
    const input = completion({ outcome: 'partial', pending_items: ['memory review needs human input'] }).exitToolCall.input
    const before = await store.load(key)
    let calls = 0
    const adapter: LLMAdapter = {
      updateConfig() {},
      async *stream(params) {
        calls++
        if (calls === 2) {
          expect(params.messages.at(-1)).toMatchObject({ toolResults: [
            { is_error: true, content: expect.stringContaining('actionable_evidence_remaining') },
          ] })
          expect(await store.load(key)).toEqual(before)
        }
        yield* chunksFromContent([{ type: 'tool_use', id: `call-${calls}`,
          name: calls === 2 ? 'list_reflection_records' : 'finish_daily_reflection',
          input: calls === 2 ? {} : input,
        }], 'tool_use', { inputTokens: 10, outputTokens: 10 })
      },
    }
    const result = await runEngine({ prompt: 'continue', adapter,
      options: { systemPrompt: '', model: 'fixture', tools: buildDailyReflectionTools(host), maxTurns: 4,
        onToolLifecycle: event => { savedTools.push(event) }, onBeforeLlmCall: () => host.acknowledgePages(savedTools) } })
    expect(calls).toBe(3)
    expect(result.exitToolCall?.input).toEqual(input)
    expect((await store.load(key)).dailyReflection).toMatchObject({ run_id: before.dailyReflection!.run_id, directory_complete: true })
    expect((await store.load(key)).dailyReflection?.result).toBeUndefined()
    expect(deps.capture).toHaveBeenCalledOnce()
    expect(deps.confirm).not.toHaveBeenCalled()
    expect((await host.finish({ outcome: result.outcome, exitToolCall: result.exitToolCall, messages: result.finalMessages }))?.outcome).toBe('partial')
    expect(deps.confirm).not.toHaveBeenCalled()
  })

  it('requires remaining readable details even after a genuine directory failure', async () => {
    const { host, deps, store } = await setup(101, 'x'.repeat(20000))
    const page = await listPage(host)
    await readPage(host, 'ref-0')
    await store.updateDailyReflection(key, state => ({ ...state!, result: {
      ...completion().exitToolCall.input, outcome: 'partial', run_id: state!.run_id,
      window_start: admission.window_start, window_end: admission.window_end,
      completed_at: deps.now(), validation_errors: [], summary: 'x'.repeat(90000),
    } as any }))
    await expect(listPage(host)).rejects.toThrow('REFLECTION_DIRECTORY_PAGE_TOO_LARGE')
    const input = completion({ outcome: 'partial' }).exitToolCall.input
    expect(await host.validateFinish(input, 1)).toContain('ref-0')
    await readPage(host, 'ref-0')
    expect(await host.validateFinish(input, 1)).toBeUndefined()
    expect(await new DailyReflection(deps).validateFinish(input, 1)).toContain('actionable_evidence_remaining')
    await store.updateDailyReflection(key, state => ({ ...state!, result: undefined }))
    await listPage(host)
    expect(await host.validateFinish(input, 1)).toBeUndefined()
  })

  it('allows actual capture failure but clears it on success and never treats invalid input as a fault', async () => {
    const { host, deps } = await setup(101)
    const input = completion({ outcome: 'partial' }).exitToolCall.input
    expect(await host.validateFinish(input, 1)).toContain('actionable_evidence_remaining')
    const list = buildDailyReflectionTools(host).find(tool => tool.name === 'list_reflection_records')!
    expect((await list.call({ cursor: 'forged' }, {})).isError).toBe(true)
    expect(await host.validateFinish(input, 1)).toContain('actionable_evidence_remaining')
    vi.mocked(deps.capture).mockRejectedValueOnce(new Error('inventory I/O failure'))
    await expect(listPage(host)).rejects.toThrow('inventory I/O failure')
    expect(await host.validateFinish(input, 1)).toBeUndefined()
    await listPage(host)
    expect((await list.call({ cursor: 'forged' }, {})).isError).toBe(true)
    expect(await host.validateFinish(input, 1)).toContain('actionable_evidence_remaining')
  })

  it('does not carry a directory failure into another run on the same host', async () => {
    const { host, deps, store } = await setup()
    vi.mocked(deps.capture).mockRejectedValueOnce(new Error('inventory I/O failure'))
    await expect(listPage(host)).rejects.toThrow('inventory I/O failure')
    const input = completion({ outcome: 'partial' }).exitToolCall.input
    expect(await host.validateFinish(input, 1)).toBeUndefined()
    await store.updateDailyReflection(key, () => undefined)
    await host.admit({ ...admission, trigger_id: 'new-trigger' }, 'new-episode')
    expect(await host.validateFinish(input, 1)).toContain('actionable_evidence_remaining')
  })

  it.each(['read denied', 'manager_trace_unavailable'])('requires a pending readable detail but permits a genuine gap or skip: %s', async failure => {
    const { host, deps } = await setup(1, 'x'.repeat(20000))
    await listPage(host)
    await readPage(host, 'ref-0')
    const input = completion({ outcome: 'partial' }).exitToolCall.input
    expect(await host.validateFinish(input, 1)).toContain('ref-0')
    const read = buildDailyReflectionTools(host).find(tool => tool.name === 'read_reflection_record')!
    expect((await read.call({ record_ref: 'ref-0', cursor: 'wrong' }, {})).isError).toBe(true)
    expect(await host.validateFinish(input, 1)).toContain('ref-0')
    vi.mocked(deps.read).mockRejectedValueOnce(new Error(failure))
    await readPage(host, 'ref-0')
    expect(await host.validateFinish(input, 1)).toBeUndefined()
  })

  it('uses the same current-directory rule before exit and in the final host check', async () => {
    const { host, store } = await setup()
    await listPage(host)
    await store.updateDailyReflection(key, state => ({ ...state!, read_records: { forged: true } }))
    const input = completion({ evidence_refs: ['forged'] })
    const finish = buildDailyReflectionTools(host).find(tool => tool.name === 'finish_daily_reflection')!
    expect(await finish.validateExit!(input.exitToolCall.input, 1)).toContain('not_in_current_directory')
    expect((await host.finish(input))?.validation_errors).toContain('unread_evidence_reference')
  })

  it('lets the actual Engine correct rejected evidence in the same run before persisting partial', async () => {
    const { host, deps, store } = await setup(21)
    await listPage(host)
    vi.mocked(deps.read).mockResolvedValue({ content: 'evidence', gaps: ['trace_unavailable'] })
    await readPage(host, 'ref-0')
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
    await listPage(host)
    await host.finish(completion({ outcome: 'partial', pending_items: ['correct the memory ID'] }))
    await store.updateDailyReflection(key, state => ({ ...state!, tool_failures: { old: 'mcp__crab-memory__delete_memory' } }))
    const restarted = new DailyReflection(deps)
    await restarted.recover()
    await restarted.admit(undefined, 'continued')
    expect((await listPage(restarted) as any).previous_result.pending_items).toEqual(['correct the memory ID'])
    expect(deps.confirm).not.toHaveBeenCalled()
    expect((await restarted.finish(completion()))?.outcome).toBe('completed')
    expect(deps.confirm).toHaveBeenCalledOnce()
  })

  it.each(['partial', 'completed'])('keeps declared unfinished work partial when the model submits %s', async outcome => {
    const { host, deps, store } = await setup()
    await listPage(host)
    const result = await host.finish(completion({ outcome, pending_items: ['memory A is still unfinished'] }))
    expect(result?.outcome).toBe('partial')
    if (outcome === 'completed') expect(result?.validation_errors).toContain('pending_items_remain')
    await new DailyReflection(deps).recover()
    expect((await store.load(key)).dailyReflection?.result?.pending_items).toEqual(['memory A is still unfinished'])
    expect(deps.confirm).not.toHaveBeenCalled()
  })

  it('does not impose a prescribed Memory call sequence on explicit completion', async () => {
    const { host, deps } = await setup()
    await listPage(host)
    const result = await host.finish(completion())
    expect(result?.validation_errors).toEqual([])
    expect(result?.outcome).toBe('completed')
    expect(deps.confirm).toHaveBeenCalledOnce()
  })

  it('does not publish a failed inventory and retries without changing the admitted window', async () => {
    const { host, deps, store } = await setup()
    vi.mocked(deps.capture).mockResolvedValueOnce({ records: [], gaps: ['manager_inventory_unavailable'] })
    await expect(listPage(host)).rejects.toThrow('manager_inventory_unavailable')
    expect((await store.load(key)).dailyReflection?.manifest).toBeUndefined()
    await host.admit({ ...admission, window_end: '2026-09-18T18:00:00.000Z' }, 'retry')
    const page = await listPage(host) as any
    expect(page.window_end).toBe(admission.window_end)
    expect(page.records).toHaveLength(1)
    await listPage(host)
    expect(deps.capture).toHaveBeenCalledTimes(2)
  })

  it('recovers a failed initial detail read at the same source bounds and freezes its successful digest', async () => {
    const { host, deps, records } = await setup()
    vi.mocked(deps.capture).mockResolvedValueOnce({ records: [{ ...records[0], digest: '', gaps: ['temporary read failure'] }], gaps: [] })
    await ready(host)
    expect((await readPage(host, 'ref-0') as any).gaps).toEqual([])
    expect((await host.finish(completion()))?.outcome).toBe('completed')
    vi.mocked(deps.read).mockResolvedValueOnce({ content: 'changed evidence', gaps: [] })
    expect((await readPage(host, 'ref-0', true)).gaps).toContain('frozen_evidence_changed')
    expect(deps.read).toHaveBeenCalledWith(expect.objectContaining({ source: records[0].source }), expect.anything())
  })

  it('freezes the directory and preserves confirmed progress across restart/history saves', async () => {
    const { host, deps, store } = await setup(101)
    const stale = await store.load(key)
    const first = await listPage(host) as any
    expect(first.records).toHaveLength(100)
    expect(first.records[0]).not.toHaveProperty('source')
    await store.save({ ...stale, recent: [], foldedCount: 9 })
    const restarted = new DailyReflection(deps)
    const last = await listPage(restarted)
    expect(last.records).toHaveLength(1)
    expect(last.has_more).toBe(false)
    expect(deps.capture).toHaveBeenCalledOnce()
    expect((await store.load(key)).dailyReflection?.directory_complete).toBe(true)
  })

  it('reads Unicode through bounded pages without exposing record positions', async () => {
    const { host, store } = await setup(2, '汉🙂'.repeat(5000))
    await ready(host)
    let page = await readPage(host, 'ref-0') as any
    expect(Buffer.byteLength(page.content)).toBeLessThanOrEqual(16 * 1024)
    expect(page.content).not.toContain('\uFFFD')
    expect(page).not.toHaveProperty('next_cursor')
    expect((await host.finish(completion())).outcome).toBe('partial')
    while (page.has_more) page = await readPage(host, 'ref-0')
    expect((await store.load(key)).dailyReflection?.read_records['ref-0']).toBe(true)
  })

  it('rediscovers the persisted directory position after restart without the previous tool history', async () => {
    const { host, deps, dir } = await setup(205)
    await listPage(host)
    await listPage(host)
    const restarted = new DailyReflection({ ...deps, store: new ManagerSessionStore(dir) })
    await restarted.admit({ ...admission, trigger_id: 'next', window_end: '2026-09-19T18:00:00.000Z' }, 'next-episode')
    const rediscovered = await listPage(restarted) as any
    expect(rediscovered.window_end).toBe(admission.window_end)
    expect(rediscovered.records[0].record_ref).toBe('ref-200')
    expect(rediscovered.progress).toEqual({ directory_total: 205, directory_read: 200, directory_complete: false,
      pending_record_count: 0, pending_records: [], evidence_gap_count: 0, evidence_gap_records: [], skipped_record_count: 0 })
    expect(rediscovered.records.map((record: any) => record.record_ref)).toEqual(['ref-200', 'ref-201', 'ref-202', 'ref-203', 'ref-204'])
    const last = await listPage(restarted)
    expect(last.records).toEqual([])
    expect(last.progress).toMatchObject({ directory_read: 205, directory_complete: true })
    expect(last).not.toHaveProperty('next_cursor')
    expect(last.progress).not.toHaveProperty('resume_cursor')
    expect(deps.capture).toHaveBeenCalledOnce()
    expect(deps.confirm).not.toHaveBeenCalled()
    await readPage(restarted, 'ref-204')
    expect((await restarted.finish(completion({ evidence_refs: ['ref-204'] })))?.outcome).toBe('completed')
    expect(deps.confirm).toHaveBeenCalledWith(expect.objectContaining({ trigger_id: admission.trigger_id, window_end: admission.window_end }))
  })

  it.each([100, 200])('replays page %s after its progress is persisted but its tool result is lost', async offset => {
    const { host, deps, store, dir } = await setup(205)
    await listPage(host)
    if (offset === 200) await listPage(host)
    const save = store.updateDailyReflection.bind(store)
    vi.spyOn(store, 'updateDailyReflection').mockImplementationOnce(async (...args) => {
      await save(...args)
      throw new Error('restart before tool result checkpoint')
    })
    await expect(listPage(host)).rejects.toThrow('restart before tool result checkpoint')
    const restarted = new DailyReflection({ ...deps, store: new ManagerSessionStore(dir) })
    const discovered = await listPage(restarted)
    expect(discovered.progress).toMatchObject({ directory_read: offset, directory_complete: false })
    expect(discovered.records[0].record_ref).toBe(`ref-${offset}`)
    if (offset === 100) expect((await listPage(restarted)).records[0].record_ref).toBe('ref-200')
    expect(deps.capture).toHaveBeenCalledOnce()
    expect(deps.confirm).not.toHaveBeenCalled()
  })

  it.each([0, 1, 100, 200])('keeps EOF stable and allows explicit restart for a directory of %s records', async count => {
    const { host, deps, dir } = await setup(count)
    let page = await listPage(host)
    while (page.has_more) page = await listPage(host)
    const restarted = new DailyReflection({ ...deps, store: new ManagerSessionStore(dir) })
    const discovered = await listPage(restarted)
    expect(discovered.progress).toMatchObject({ directory_read: count, directory_complete: true })
    expect(discovered.records).toEqual([])
    const replayed = await listPage(restarted, true)
    expect(replayed.records).toHaveLength(Math.min(count, 100))
    expect(replayed.records[0]?.record_ref).toBe(count ? 'ref-0' : undefined)
  })

  it('rediscovers bounded unfinished details and gaps without treating old detail cursors as successful coverage', async () => {
    const { host, deps, dir } = await setup(21, 'x'.repeat(20_000))
    await listPage(host)
    for (let i = 0; i < 21; i++) await readPage(host, `ref-${i}`)
    vi.mocked(deps.read).mockRejectedValueOnce(new Error('source unavailable'))
    await readPage(host, 'ref-0')
    const restarted = new DailyReflection({ ...deps, store: new ManagerSessionStore(dir) })
    let page = await listPage(restarted) as any
    expect(page.progress).toMatchObject({ directory_total: 21, directory_read: 21, directory_complete: true,
      pending_record_count: 21, evidence_gap_count: 1 })
    expect(page.progress.pending_records).toEqual(Array.from({ length: 20 }, (_, i) => ({ record_ref: `ref-${i}` })))
    expect((await restarted.finish(completion()))?.validation_errors).toEqual(expect.arrayContaining(['record_not_fully_read', 'known_evidence_gaps']))
    await readPage(restarted, page.progress.pending_records[0].record_ref, true)
    await readPage(restarted, 'ref-0')
    page = await listPage(restarted) as any
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
    const list = buildDailyReflectionTools(restarted).find(tool => tool.name === 'list_reflection_records')!
    expect((await list.call({ cursor: 'old-run-cursor' }, {})).isError).toBe(true)
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
    const { host, deps } = await setup(101)
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
    expect((await readPage(host, 'ref-0') as any).gaps).toContain('source unavailable')
    expect((await host.finish(completion()))?.validation_errors).toContain('known_evidence_gaps')
    await readPage(host, 'ref-0', true)
    expect((await host.finish(completion({ evidence_refs: ['ref-0'] })))?.outcome).toBe('completed')
    expect(deps.confirm).toHaveBeenCalledOnce()
  })
})
