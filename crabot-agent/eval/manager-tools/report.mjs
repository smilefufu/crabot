import { createReadStream } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { parseArgs } from 'node:util'
import { pathToFileURL } from 'node:url'

const MODES = new Set(['full', 'shadow', 'progressive'])
const PROFILES = new Set(['normal', 'daily_reflection', 'memory_graph_rebuild'])
const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0
const identity = d => [d.provider_id, d.model_id, d.format, d.capability_profile]
const identityKey = d => JSON.stringify(identity(d))
const rateKey = d => JSON.stringify([d.provider_id, d.model_id, d.format])
const sum = values => values.reduce((total, value) => total + value, 0)
const p95 = values => values.length ? [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1] : null
const ratioChange = (value, control) => value !== null && control > 0 ? value / control - 1 : null

/** Files are supplied oldest first. Only the last record for a trace is evaluated. */
export async function readEpisodes(files) {
  const latest = new Map()
  const quality = { invalid_records: 0, ignored_records: 0, duplicate_records: 0, identity_conflicts: 0 }
  for (const file of files) {
    const lines = createInterface({ input: createReadStream(file), crlfDelay: Infinity })
    for await (const line of lines) {
      if (!line.trim()) continue
      let record
      try { record = JSON.parse(line) } catch { quality.invalid_records++; continue }
      if (record?.kind !== 'manager_episode') { quality.ignored_records++; continue }
      const trace = record.trace
      if (!trace || typeof trace.trace_id !== 'string' || typeof trace.manager_key !== 'string'
        || !Number.isFinite(Date.parse(trace.started_at)) || !Array.isArray(trace.spans)
        || !['running', 'completed', 'failed'].includes(trace.status) || typeof trace.trigger?.type !== 'string') {
        quality.invalid_records++
        continue
      }
      const previous = latest.get(trace.trace_id)
      if (previous) {
        quality.duplicate_records++
        if (previous.manager_key !== trace.manager_key) quality.identity_conflicts++
      }
      latest.set(trace.trace_id, trace)
    }
  }
  return { episodes: [...latest.values()], quality }
}

function rateIndex(rates) {
  const result = new Map()
  if (rates === undefined) return result
  if (typeof rates.version !== 'string' || !rates.version.trim() || !Array.isArray(rates.entries)) throw new Error('Invalid rate table version/entries')
  for (const entry of rates.entries) {
    if (![entry.provider_id, entry.model_id, entry.format].every(value => typeof value === 'string' && value.length)
      || !['cloud', 'self_hosted'].includes(entry.kind)) throw new Error('Invalid rate identity/kind')
    if (result.has(rateKey(entry))) throw new Error('duplicate rate identity')
    if (entry.kind === 'cloud' && (typeof entry.currency !== 'string' || !entry.currency.trim()
      || !['input', 'cache_read', 'cache_creation', 'output'].every(key => finite(entry.per_million?.[key])))) {
      throw new Error('Invalid cloud rate or currency')
    }
    result.set(rateKey(entry), entry)
  }
  return result
}

function requestFact(span, prices) {
  const d = span.details
  const u = d.usage
  const validUsage = span.status === 'completed' && u && finite(u.inputTokens) && finite(u.outputTokens)
    && (u.cacheReadTokens === undefined || finite(u.cacheReadTokens))
    && (u.cacheCreationTokens === undefined || finite(u.cacheCreationTokens))
  const cacheKnown = !!validUsage && finite(u.cacheReadTokens)
    && (d.format !== 'anthropic' || finite(u.cacheCreationTokens))
  const tokens = validUsage ? u.inputTokens + u.outputTokens + (u.cacheReadTokens ?? 0) + (u.cacheCreationTokens ?? 0) : null
  // OpenAI-compatible adapters can reconstruct total prompt tokens even without a cache split.
  const workload = validUsage && (cacheKnown || ['openai', 'openai-responses', 'gemini'].includes(d.format)) ? tokens : null
  const price = prices.get(rateKey(d))
  const cost = cacheKnown && price?.kind === 'cloud'
    ? (u.inputTokens * price.per_million.input + u.outputTokens * price.per_million.output
      + u.cacheReadTokens * price.per_million.cache_read + (u.cacheCreationTokens ?? 0) * price.per_million.cache_creation) / 1_000_000
    : null
  return { span, d, validUsage: !!validUsage, cacheKnown, tokens, workload, cost, price }
}

function summarizeRequests(facts) {
  const cacheKnown = facts.length > 0 && facts.every(f => f.cacheKnown)
  const promptTokens = cacheKnown ? sum(facts.map(f => f.tokens - f.d.usage.outputTokens)) : 0
  return {
    requests: facts.length,
    compaction_requests: facts.filter(f => f.d.purpose === 'compaction').length,
    failed_requests: facts.filter(f => f.span.status === 'failed').length,
    running_requests: facts.filter(f => f.span.status === 'running').length,
    missing_usage_requests: facts.filter(f => !f.validUsage).length,
    cache_unreported_requests: facts.filter(f => !f.cacheKnown).length,
    reported_usage: Object.fromEntries(['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheCreationTokens'].map(key => {
      const values = facts.filter(f => f.validUsage && finite(f.d.usage[key])).map(f => f.d.usage[key])
      return [key, values.length ? sum(values) : null]
    })),
    observed_token_workload: sum(facts.map(f => f.tokens ?? 0)),
    observed_cost: facts.some(f => f.cost !== null) ? sum(facts.map(f => f.cost ?? 0)) : null,
    cache_read_ratio: cacheKnown && promptTokens > 0 ? sum(facts.map(f => f.d.usage.cacheReadTokens)) / promptTokens : null,
    p95_first_chunk_ms: p95(facts.filter(f => finite(f.d.first_chunk_ms)).map(f => f.d.first_chunk_ms)),
    missing_first_chunk_requests: facts.filter(f => !finite(f.d.first_chunk_ms)).length,
  }
}

function missingRequests(trace, facts) {
  const coverage = trace.spans.find(span => span.details?.kind === 'llm_request_coverage')?.details
  if (!coverage || coverage.resumed !== false || coverage.request_count !== facts.length) return true
  const ids = new Set(facts.map(f => f.d.request_id))
  if (trace.spans.some(span => span.type === 'llm_call' && !ids.has(span.details?.request_id))) return true
  const calls = new Map()
  for (const f of facts) {
    if (typeof f.d.call_id !== 'string' || !Number.isInteger(f.d.attempt) || f.d.attempt < 1) return true
    const attempts = calls.get(f.d.call_id) ?? new Set()
    attempts.add(f.d.attempt)
    calls.set(f.d.call_id, attempts)
  }
  return [...calls.values()].some(attempts => [...attempts].reduce((max, attempt) => Math.max(max, attempt), 0) !== attempts.size)
}

export function buildReport(episodes, { start, end, rates, sourceQuality = {} }) {
  const from = Date.parse(start)
  const until = Date.parse(end)
  if (!Number.isFinite(from) || !Number.isFinite(until) || from >= until) throw new Error('Invalid start/end window')
  const prices = rateIndex(rates)
  const window = episodes.filter(trace => Date.parse(trace.started_at) >= from && Date.parse(trace.started_at) < until)
  const quality = { ...sourceQuality, missing_or_legacy_episodes: 0, mixed_identity_episodes: 0, mixed_mode_episodes: 0, incomplete_request_episodes: 0, cohort_mode_changes: 0 }
  const manual_review = { no_match_episodes: 0, tool_error_episodes: 0, worker_event_episodes: 0 }
  const requestGroups = new Map()
  const episodeGroups = new Map()
  const keyModes = new Map()
  for (const trace of window) {
    const root = trace.spans.find(span => span.type === 'agent_loop')?.details
    const uniqueRequests = new Map()
    for (const span of trace.spans) {
      if (span.details?.kind === 'llm_request' && typeof span.details.request_id === 'string') uniqueRequests.set(span.details.request_id, span)
    }
    const facts = [...uniqueRequests.values()].map(span => requestFact(span, prices))
    const identities = new Set(facts.map(f => identityKey(f.d)))
    const modes = new Set(facts.map(f => f.d.tool_loading_mode))
    const mode = facts[0]?.d.tool_loading_mode
    const assignedModes = keyModes.get(trace.manager_key) ?? new Set()
    for (const item of modes) assignedModes.add(item)
    keyModes.set(trace.manager_key, assignedModes)
    if (root?.tool_loading_mode && facts.length) modes.add(root.tool_loading_mode)
    const missingIdentity = !facts.length || facts.some(f => !identity(f.d).every(v => typeof v === 'string' && v.length)
      || !MODES.has(f.d.tool_loading_mode) || !PROFILES.has(f.d.capability_profile))
    const ended = trace.status !== 'running' && Number.isFinite(Date.parse(trace.ended_at)) && Date.parse(trace.ended_at) <= until
    const incomplete = root?.request_observation_version !== 1 || missingIdentity || missingRequests(trace, facts)
      || !ended || facts.some(f => !f.validUsage)
    if (missingIdentity) quality.missing_or_legacy_episodes++
    if (identities.size > 1) quality.mixed_identity_episodes++
    if (modes.size > 1) quality.mixed_mode_episodes++
    if (incomplete) quality.incomplete_request_episodes++
    if (trace.trigger.type === 'worker_event') manual_review.worker_event_episodes++
    if (trace.spans.some(span => span.details?.tool_search_status === 'no_match')) manual_review.no_match_episodes++
    if (trace.spans.some(span => span.details?.tool_error_code)) manual_review.tool_error_episodes++
    for (const fact of facts) {
      const key = JSON.stringify([...identity(fact.d), trace.trigger.type, fact.d.tool_loading_mode])
      const group = requestGroups.get(key) ?? { dimensions: dimensions(fact.d, trace.trigger.type), mode: fact.d.tool_loading_mode, facts: [] }
      group.facts.push(fact)
      requestGroups.set(key, group)
    }
    // Mixed episodes retain all request accounting above but cannot form a matched episode comparison.
    if (missingIdentity || identities.size !== 1 || modes.size !== 1) continue
    const key = JSON.stringify([...identity(facts[0].d), trace.trigger.type, mode])
    const group = episodeGroups.get(key) ?? { dimensions: dimensions(facts[0].d, trace.trigger.type), mode, rows: [] }
    group.rows.push({ trace, facts, incomplete })
    episodeGroups.set(key, group)
  }
  quality.cohort_mode_changes = [...keyModes.values()].filter(modes => modes.size > 1).length
  const sourceIncomplete = !!(sourceQuality.invalid_records || sourceQuality.identity_conflicts || quality.cohort_mode_changes)
  const groups = [...episodeGroups.values()].map(({ dimensions, mode, rows }) => {
    const facts = rows.flatMap(row => row.facts)
    const complete = !sourceIncomplete && rows.every(row => !row.incomplete)
    const price = facts[0]?.price
    const durations = rows.map(row => row.trace.duration_ms)
    return {
      dimensions, mode, episodes: rows.length,
      manager_keys: new Set(rows.map(row => row.trace.manager_key)).size,
      complete_episodes: rows.filter(row => !row.incomplete).length,
      technical_completion_rate: rows.filter(row => row.trace.status === 'completed').length / rows.length,
      ...summarizeRequests(facts),
      mean_requests_per_episode: complete ? facts.length / rows.length : null,
      p95_episode_ms: rows.every(row => row.trace.status !== 'running') && durations.every(finite) ? p95(durations) : null,
      mean_token_workload: complete && facts.every(f => f.workload !== null) ? sum(facts.map(f => f.workload)) / rows.length : null,
      cost_kind: price?.kind ?? 'unpriced', currency: price?.currency ?? null,
      mean_cost: complete && facts.every(f => f.cost !== null) ? sum(facts.map(f => f.cost)) / rows.length : null,
      comparison_coverage_complete: complete,
    }
  })
  const comparisons = groups.filter(group => group.mode === 'progressive').map(group => {
    const control = groups.find(item => item.mode === 'full' && JSON.stringify(item.dimensions) === JSON.stringify(group.dimensions))
    if (!control) return { dimensions: group.dimensions, control: 'missing', gates: {} }
    const comparable = group.comparison_coverage_complete && control.comparison_coverage_complete
    const difference = (a, b) => comparable && a !== null && b !== null ? a - b : null
    const extraRequests = difference(group.mean_requests_per_episode, control.mean_requests_per_episode)
    const completionDelta = difference(group.technical_completion_rate, control.technical_completion_rate)
    const cacheDelta = difference(group.cache_read_ratio, control.cache_read_ratio)
    const costChange = comparable ? ratioChange(group.mean_cost, control.mean_cost) : null
    const workloadChange = comparable ? ratioChange(group.mean_token_workload, control.mean_token_workload) : null
    const latencyChange = comparable ? ratioChange(group.p95_episode_ms, control.p95_episode_ms) : null
    const gate = (value, test) => value === null ? 'unknown' : test(value) ? 'pass' : 'fail'
    return {
      dimensions: group.dimensions, control_episodes: control.episodes, progressive_episodes: group.episodes,
      extra_requests_per_episode: extraRequests, technical_completion_delta: completionDelta, cache_read_ratio_delta: cacheDelta,
      cost_change_ratio: costChange, workload_change_ratio: workloadChange, p95_latency_change_ratio: latencyChange,
      gates: {
        technical_completion: gate(completionDelta, v => v >= -0.01), extra_requests: gate(extraRequests, v => v <= 0.2),
        cache_read_ratio: gate(cacheDelta, v => v >= -0.05),
        mean_cost: gate(costChange, v => v <= 0),
        self_hosted_workload: group.cost_kind === 'self_hosted' ? gate(workloadChange, v => v <= 0) : 'not_applicable',
        p95_latency: gate(latencyChange, v => v <= 0.1),
        worker_turn_closure: 'manual_review', unresolved_tool_errors: 'manual_review',
      },
    }
  })
  return {
    report_version: 1, window: { start, end, hours: (until - from) / 3_600_000, basis: 'episode_started_at' },
    rate_version: rates?.version ?? null, episode_count: window.length, quality, groups,
    request_groups: [...requestGroups.values()].map(({ dimensions, mode, facts }) => ({
      dimensions, mode, cost_kind: facts[0]?.price?.kind ?? 'unpriced', currency: facts[0]?.price?.currency ?? null,
      ...summarizeRequests(facts),
    })),
    comparisons, manual_review, rollout_decision: 'manual_review_required',
  }
}

function dimensions(d, wakeType) {
  return { provider_id: d.provider_id ?? null, model_id: d.model_id ?? null, format: d.format ?? null,
    capability_profile: d.capability_profile ?? null, wake_type: wakeType }
}

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    start: { type: 'string' }, end: { type: 'string' }, rates: { type: 'string' }, help: { type: 'boolean' },
  } })
  if (values.help) {
    console.log('Usage: node eval/manager-tools/report.mjs --start ISO --end ISO [--rates rates.json] traces-oldest.jsonl ... traces-latest.jsonl')
    return
  }
  if (!positionals.length) throw new Error('At least one trace JSONL file is required')
  const { episodes, quality } = await readEpisodes(positionals)
  const rates = values.rates ? JSON.parse(await readFile(values.rates, 'utf8')) : undefined
  console.log(JSON.stringify(buildReport(episodes, { ...values, rates, sourceQuality: quality }), null, 2))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1 })
}
