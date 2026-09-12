import { describe, expect, it } from 'vitest'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildReport, readEpisodes } from '../../eval/manager-tools/report.mjs'

const start = '2026-09-01T00:00:00Z'
const end = '2026-09-09T00:00:00Z'
const rates = { version: 'fixture-only', entries: [{ provider_id: 'provider', model_id: 'model', format: 'openai',
  kind: 'cloud', currency: 'USD', per_million: { input: 10, cache_read: 1, cache_creation: 10, output: 20 } }] }
function episode(id = 'episode', mode = 'full', tokens = 100): any {
  return { trace_id: id, manager_key: `channel::${mode}`, started_at: '2026-09-02T00:00:00Z', ended_at: '2026-09-02T00:00:01Z',
    status: 'completed', duration_ms: 1000, trigger: { type: 'human_message', summary: 'private text' }, spawned_worker_ids: [],
    spans: [
      { span_id: 'root', type: 'agent_loop', details: { request_observation_version: 1, tool_loading_mode: mode, capability_profile: 'normal' } },
      { span_id: 'request', type: 'rpc_call', status: 'completed', duration_ms: 900, details: {
        kind: 'llm_request', request_id: 'request', call_id: 'call', attempt: 1, provider_id: 'provider', model_id: 'model', format: 'openai',
        tool_loading_mode: mode, capability_profile: 'normal', purpose: 'inference', first_chunk_ms: 10,
        usage: { inputTokens: tokens, outputTokens: 5, cacheReadTokens: 0 },
      } },
      { span_id: 'llm', type: 'llm_call', details: { request_id: 'request', usage: { inputTokens: tokens, outputTokens: 5 } } },
      { span_id: 'coverage', type: 'decision', details: { kind: 'llm_request_coverage', request_count: 1, resumed: false } },
    ] }
}
const report = (episodes: any[], overrides: any = {}) => buildReport(episodes, { start, end, rates, ...overrides })

describe('read-only Manager cost report', () => {
  it('counts requests once, not llm_call usage; computes only stratified point estimates', () => {
    const result = report([episode('control'), episode('treatment', 'progressive', 60)])
    expect(result.groups[0].requests).toBe(1)
    expect(result.groups[0].mean_cost).toBeCloseTo(0.0011)
    expect(result.groups[1].mean_cost).toBeCloseTo(0.0007)
    expect(result.comparisons[0].cost_change_ratio).toBeCloseTo(-4 / 11)
    expect(result.comparisons[0].gates.mean_cost).toBe('pass')
    expect(result.rollout_decision).toBe('manual_review_required')
    expect(JSON.stringify(result)).not.toContain('private text')
  })

  it('includes compaction and failed attempts, and refuses to turn their missing cost into zero', () => {
    const trace = episode()
    trace.spans.push({ ...trace.spans[1], span_id: 'fold', status: 'failed', details: {
      ...trace.spans[1].details, request_id: 'fold', call_id: 'fold-call', purpose: 'compaction', usage: undefined,
    } })
    trace.status = 'failed'
    const group = report([trace]).groups[0]
    expect(group).toMatchObject({ episodes: 1, requests: 2, compaction_requests: 1, failed_requests: 1,
      technical_completion_rate: 0, mean_cost: null, mean_token_workload: null })
    expect(group.observed_cost).toBeCloseTo(0.0011)
  })

  it('preserves absent cache reporting, while zero is a measurable zero', () => {
    const absent = episode()
    delete absent.spans[1].details.usage.cacheReadTokens
    expect(report([absent]).groups[0]).toMatchObject({ cache_read_ratio: null, mean_cost: null, mean_token_workload: 105 })
    expect(report([episode()]).groups[0]).toMatchObject({ cache_read_ratio: 0, mean_cost: 0.0011 })
  })

  it('does not mix provider changes or episode loading modes into a homogeneous comparison', () => {
    const mixed = episode()
    mixed.spans.push({ ...mixed.spans[1], span_id: 'other', details: { ...mixed.spans[1].details,
      request_id: 'other', call_id: 'other', provider_id: 'other-provider', tool_loading_mode: 'progressive' } })
    const result = report([mixed])
    expect(result.groups).toHaveLength(0)
    expect(result.request_groups).toHaveLength(2)
    expect(result.quality).toMatchObject({ mixed_identity_episodes: 1, mixed_mode_episodes: 1 })
  })

  it('reports legacy/missing request spans and incomplete attempt sequences without guessing prices', () => {
    const legacy = episode('legacy')
    legacy.spans = legacy.spans.slice(2)
    const missing = episode('missing')
    missing.spans[1].details.attempt = 2
    const result = report([legacy, missing])
    expect(result.quality).toMatchObject({ missing_or_legacy_episodes: 1, incomplete_request_episodes: 2 })
    expect(result.groups[0].mean_cost).toBeNull()
  })

  it('keeps self-hosted workload and cloud currency separate', () => {
    const selfHosted = { version: 'fixture', entries: [{ provider_id: 'provider', model_id: 'model', format: 'openai', kind: 'self_hosted' }] }
    expect(report([episode()], { rates: selfHosted }).groups[0]).toMatchObject({ cost_kind: 'self_hosted', mean_cost: null, mean_token_workload: 105 })
    expect(report([episode()], { rates: undefined }).groups[0]).toMatchObject({ cost_kind: 'unpriced', mean_cost: null })
    expect(() => report([], { rates: { ...rates, entries: [...rates.entries, ...rates.entries] } })).toThrow(/duplicate/)
    expect(() => report([], { rates: { ...rates, entries: [{ ...rates.entries[0], per_million: { input: -1 } }] } })).toThrow(/rate/)
  })

  it('uses a half-open episode-start window and marks episodes still running or crossing its end incomplete', () => {
    const excluded = { ...episode('excluded'), started_at: end }
    const running = { ...episode(), status: 'running', ended_at: undefined, duration_ms: undefined }
    const result = report([excluded, running])
    expect(result.episode_count).toBe(1)
    expect(result.groups[0]).toMatchObject({ mean_cost: null, p95_episode_ms: null })
    expect(() => report([], { start: end })).toThrow(/window/)
  })

  it('leaves no_match and Worker-turn closure for manual review, not a success-rate proxy', () => {
    const trace = episode('worker', 'progressive')
    trace.trigger.type = 'worker_event'
    trace.spans.push({ type: 'tool_call', details: { name: 'search_tools', tool_search_status: 'no_match' } })
    expect(report([trace]).manual_review).toMatchObject({ no_match_episodes: 1, worker_event_episodes: 1 })
  })

  it('detects missing request writes, restart coverage and changes to a fixed ManagerKey cohort', () => {
    const trace = episode()
    trace.spans[3].details.request_count = 2
    expect(report([trace]).groups[0].mean_cost).toBeNull()
    trace.spans[3].details.request_count = 1
    trace.spans[3].details.resumed = true
    expect(report([trace]).groups[0].mean_cost).toBeNull()
    const control = episode()
    const changed = { ...episode('changed', 'progressive'), manager_key: control.manager_key }
    const result = report([control, changed])
    expect(result.quality.cohort_mode_changes).toBe(1)
    expect(result.comparisons[0].gates.mean_cost).toBe('unknown')
  })

  it('deduplicates JSONL by latest record and diagnoses malformed rows without leaking them', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tool-report-'))
    try {
      const path = join(dir, 'traces.jsonl')
      const trace = episode()
      const rows = [JSON.stringify({ kind: 'manager_episode', trace: { ...trace, status: 'running' } }),
        JSON.stringify({ trace_id: 'legacy' }), 'PRIVATE MALFORMED CONTENT', JSON.stringify({ kind: 'manager_episode', trace })]
      await writeFile(path, rows.join('\n'))
      const loaded = await readEpisodes([path])
      expect(loaded.episodes).toHaveLength(1)
      expect(loaded.episodes[0].status).toBe('completed')
      expect(loaded.quality).toMatchObject({ duplicate_records: 1, invalid_records: 1, ignored_records: 1 })
      expect(JSON.stringify(report(loaded.episodes, { sourceQuality: loaded.quality }))).not.toContain('PRIVATE')
    } finally { await rm(dir, { recursive: true, force: true }) }
  })
})
