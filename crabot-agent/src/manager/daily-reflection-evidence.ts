import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { EngineMessage } from '../engine/types.js'
import type { TraceStore } from '../core/trace-store.js'
import { decodeSegment, encodeSegment, type LedgerStore } from '../workers/harness/ledger-store.js'
import type { WorkerHarness } from '../workers/harness/harness.js'
import type { WorkerTurnStore } from '../workers/harness/worker-turn-store.js'
import type { CompositeTraceResult } from '../workers/trace/composite-reader.js'
import type { ManagerSessionStore } from './session-store.js'
import type { ManagerEpisodeTrace } from './trace-types.js'
import type { ManagerKey } from './types.js'
import type { DailyReflectionState, ReflectionEvidence, ReflectionManifest, ReflectionRecord, ReflectionSource, ReflectionWindow, ReflectionWorkerTrace } from './daily-reflection-types.js'
import { reflectionDigest } from './daily-reflection.js'

export interface ReflectionEvidenceDeps {
  managersDir: string
  store: ManagerSessionStore
  ledger: LedgerStore
  harness: WorkerHarness
  turns: WorkerTurnStore
  traces: Pick<TraceStore, 'listTraceManagerKeys' | 'readManagerEpisodes' | 'readManagerEpisode'>
  captureWorkerTrace: (workerId: string, seq: number) => Promise<{ source: ReflectionWorkerTrace; result: Pick<CompositeTraceResult, 'events' | 'unavailable_reason'> }>
  readWorkerTrace: (workerId: string, source: ReflectionWorkerTrace) => Promise<Pick<CompositeTraceResult, 'events' | 'unavailable_reason'>>
  redact: (text: string) => string
}

function inWindow(value: number | string, window: ReflectionWindow): boolean {
  const time = typeof value === 'number' ? value : Date.parse(value)
  return time >= Date.parse(window.window_start) && time < Date.parse(window.window_end)
}

function isLegacyImportEvent(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const event = value as { kind?: string; source?: string; summary?: string }
  // Composite traces project the same audit event as a harness lifecycle row.
  return event.kind === 'legacy_imported'
    || (event.source === 'harness' && event.kind === 'lifecycle' && event.summary === 'legacy_imported')
}

function isHumanInput(message: EngineMessage): boolean {
  return message.role === 'user' && 'content' in message && typeof message.content === 'string'
    && (message.content.startsWith('[人类消息]\n') || message.content.startsWith('[补齐:群聊注意力放行期间累积的人类消息]\n'))
}

function visibleMessage(message: EngineMessage): unknown {
  if ('toolResults' in message) return { id: message.id, role: message.role, timestamp: message.timestamp,
    toolResults: message.toolResults.map(({ tool_use_id, content, is_error }) => ({ tool_use_id, content, is_error })) }
  const content = typeof message.content === 'string' ? message.content
    : message.content.filter(block => block.type !== 'raw_reasoning' && block.type !== 'image')
  return { id: message.id, role: message.role, timestamp: message.timestamp, content }
}

/** Source reads remain host-only; model-facing references are minted from the resulting manifest. */
export class DailyReflectionEvidence {
  constructor(private readonly deps: ReflectionEvidenceDeps) {}

  private episodePath(key: string, episodeId: string): string {
    // Both originate in the host inventory; also fail closed on corrupt persisted references.
    if (!/^[a-zA-Z0-9-]+$/.test(episodeId)) throw new Error('Invalid episode source')
    return join(this.deps.managersDir, encodeSegment(key), 'episodes', `${episodeId}.jsonl`)
  }

  private async messages(source: Extract<ReflectionSource, { kind: 'manager_episode' }>): Promise<EngineMessage[]> {
    if (source.log_bytes === 0) return []
    const file = await fs.open(this.episodePath(source.manager_key, source.episode_id), 'r')
    try {
      const buffer = Buffer.alloc(source.log_bytes)
      let offset = 0
      while (offset < buffer.length) {
        const read = await file.read(buffer, offset, buffer.length - offset, offset)
        if (read.bytesRead === 0) throw new Error('episode_history_truncated')
        offset += read.bytesRead
      }
      const unique = new Map<string, EngineMessage>()
      for (const line of buffer.toString('utf8').split('\n').filter(Boolean)) {
        const message = JSON.parse(line) as EngineMessage
        if (!message.id || !Number.isFinite(message.timestamp)) throw new Error('invalid_episode_history')
        unique.set(message.id, message)
      }
      return [...unique.values()]
    } finally { await file.close() }
  }

  async capture(state: DailyReflectionState): Promise<ReflectionManifest> {
    const records: ReflectionRecord[] = []
    const gaps: string[] = []
    const reflectionEpisodes = new Set(state.episode_ids)
    const keys = new Set([...await this.deps.store.listManagerKeys(), ...this.deps.traces.listTraceManagerKeys()])
    try {
      for (const entry of await fs.readdir(this.deps.managersDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        try {
          if (!keys.has(decodeSegment(entry.name) as ManagerKey)) gaps.push(`manager_state_unavailable:${entry.name}`)
        } catch { gaps.push(`manager_identity_unavailable:${entry.name}`) }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') gaps.push('manager_inventory_unavailable')
    }
    const add = async (source: ReflectionSource, activityAt: string, summary: string, episode?: ManagerEpisodeTrace): Promise<void> => {
      const evidence = await this.readSource(source, state, episode)
      records.push({ record_ref: randomUUID(), kind: source.kind, source_id: source.kind === 'worker' ? source.worker_id
        : source.kind === 'manager_episode' ? source.episode_id : source.manager_key,
      activity_at: activityAt, summary: this.deps.redact(summary), gaps: evidence.gaps, source,
      digest: evidence.gaps.length ? '' : reflectionDigest(evidence.content) })
    }

    const histories = new Map<ManagerKey, Set<string>>()
    const anchored = new Map<ManagerKey, Set<string>>()
    for (const key of keys) {
      const persisted = await this.deps.store.load(key)
      persisted.dailyReflection?.episode_ids.forEach(id => reflectionEpisodes.add(id))
      const ids = new Set<string>()
      try {
        for (const file of await fs.readdir(join(this.deps.managersDir, encodeSegment(key), 'episodes'))) {
          if (file.endsWith('.jsonl')) ids.add(file.slice(0, -6))
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') gaps.push(`manager_inventory_unavailable:${key}`)
      }
      histories.set(key, ids)
      anchored.set(key, new Set())
    }
    const addEpisode = async (key: ManagerKey, id: string, episode?: ManagerEpisodeTrace): Promise<void> => {
      if ((episode?.trigger.schedule?.is_builtin && episode.trigger.schedule.task_type === 'daily_reflection')
        || episode?.spans.some(span => span.type === 'agent_loop' && (span.details as { capability_profile?: string })?.capability_profile === 'daily_reflection')) reflectionEpisodes.add(id)
      if (reflectionEpisodes.has(id)) return
      if (episode && (Date.parse(episode.started_at) >= Date.parse(state.window_end)
        || (episode.ended_at && Date.parse(episode.ended_at) < Date.parse(state.window_start)))) return
      let bytes = 0
      try { bytes = (await fs.stat(this.episodePath(key, id))).size } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        // Missing history has no proven byte boundary; later arrivals cannot fill this snapshot.
      }
      const source: ReflectionSource = { kind: 'manager_episode', manager_key: key, episode_id: id, log_bytes: bytes,
        span_ids: episode?.spans.filter(span => ['tool_call', 'decision', 'memory_write', 'rpc_call'].includes(span.type)
          && !!span.ended_at && inWindow(span.ended_at, state)).map(span => span.span_id) ?? [] }
      let messages: EngineMessage[] = []
      try { messages = await this.messages(source) } catch {
        if (!episode) gaps.push(`manager_history_unreadable:${id}`)
        // With a known episode, readSource reports the detail gap at the frozen byte boundary.
      }
      const currentMessages = messages.filter(message => inWindow(message.timestamp, state))
      currentMessages.forEach(message => anchored.get(key)?.add(message.id))
      const times = [episode?.started_at, episode?.ended_at, ...episode?.spans.flatMap(span => [span.started_at, span.ended_at]) ?? [],
        ...currentMessages.map(message => new Date(message.timestamp).toISOString())]
        .filter((time): time is string => !!time && inWindow(time, state)).sort()
      if (!times.length) return
      const userPreview = currentMessages.filter(message => isHumanInput(message))
        .map(message => (message as { content: string }).content.slice(0, 200)).slice(-3).join('\n')
      await add(source, times.at(-1)!, `${episode?.trigger.summary ?? 'persisted episode'}; status=${episode?.ended_at && inWindow(episode.ended_at, state) ? episode.status : 'in_progress'}; llm_turns=${episode?.spans.filter(span => span.type === 'llm_call' && inWindow(span.started_at, state)).length ?? 'unknown'}\n${userPreview}`, episode)
    }
    for await (const episode of this.deps.traces.readManagerEpisodes()) {
      histories.get(episode.manager_key)?.delete(episode.trace_id)
      await addEpisode(episode.manager_key, episode.trace_id, episode)
    }
    for (const key of keys) {
      for (const id of histories.get(key) ?? []) await addEpisode(key, id)
      const session = await this.deps.store.load(key)
      const unanchored = session.recent.filter(message => isHumanInput(message)
        && inWindow(message.timestamp, state) && !anchored.get(key)?.has(message.id))
      if (unanchored.length) {
        await add({ kind: 'human_input', manager_key: key, message_ids: unanchored.map(message => message.id) },
          new Date(unanchored.at(-1)!.timestamp).toISOString(), '尚未关联完整 episode 的持久入站内容')
      }
    }

    for (const { worker } of await this.deps.ledger.listAllWorkers()) {
      if (worker.origin.spawned_by_episode && reflectionEpisodes.has(worker.origin.spawned_by_episode)) continue
      if (state.analysis_worker_ids.includes(worker.worker_id)) continue
      const events = await this.deps.harness.readWorkerEvents(worker.worker_id)
      const importedAt = worker.legacy_source?.kind === 'v2_admin_task' ? worker.legacy_source.imported_at : undefined
      const turns = await this.deps.turns.list(worker.worker_id)
      const traces: ReflectionWorkerTrace[] = []
      const periodTurns = turns.filter(turn => inWindow(turn.completed_at, state))
      const errors = new Set(events.filter(event => (event.kind === 'error'
        || (event.kind === 'exited' && event.detail?.reason === 'spawn_failed')) && inWindow(event.ts, state))
        .map(event => JSON.stringify(event.detail ?? {}).slice(0, 200)))
      const llmCallsBySeq: string[] = []
      const times = [...events.filter(event => !isLegacyImportEvent(event) && inWindow(event.ts, state)).map(event => event.ts),
        ...turns.filter(turn => inWindow(turn.completed_at, state)).map(turn => turn.completed_at)]
      const traceGaps: string[] = []
      for (const incarnation of worker.incarnations) {
        if (Date.parse(incarnation.started_at) >= Date.parse(state.window_end)
          || (incarnation.state === 'exited' && incarnation.ended_at && Date.parse(incarnation.ended_at) < Date.parse(state.window_start))) continue
        const incarnationEvents = events.filter(event => event.seq === incarnation.seq)
        // Only explicit pre-spawn failures without execution facts can have no native trace.
        if (incarnation.state === 'exited' && incarnation.ended_reason === 'failed' && !incarnation.session_ref
          && incarnationEvents.length > 0 && incarnationEvents.every(event => event.kind === 'exited'
            && event.detail?.reason === 'spawn_failed' && event.detail?.spawn_phase === 'pre_spawn')
          && !turns.some(turn => turn.seq === incarnation.seq)) continue
        // Preserve real legacy completion facts, including gaps, but not migration-time fallbacks.
        if (incarnation.impl === 'legacy' && importedAt && incarnation.ended_at !== importedAt
          && inWindow(incarnation.ended_at, state)) times.push(incarnation.ended_at)
        try {
          const captured = await this.deps.captureWorkerTrace(worker.worker_id, incarnation.seq)
          traces.push(captured.source)
          const periodEvents = captured.result.events.filter(event => !isLegacyImportEvent(event) && inWindow(event.ts, state))
          times.push(...periodEvents.map(event => event.ts))
          llmCallsBySeq.push(`${incarnation.seq}:${periodEvents.filter(event => event.kind === 'llm_call').length}`)
          periodEvents.filter(event => event.kind === 'error').forEach(event => errors.add(event.summary.slice(0, 200)))
          if (captured.result.unavailable_reason) traceGaps.push(captured.result.unavailable_reason)
        } catch { traceGaps.push(`worker_trace_unavailable:${worker.worker_id}:${incarnation.seq}`) }
      }
      const migrationOnlyUpdate = worker.updated_at === importedAt
      if (!times.length && (migrationOnlyUpdate || !inWindow(worker.updated_at, state))) continue
      await add({ kind: 'worker', worker_id: worker.worker_id, traces,
        turn_ids: periodTurns.map(turn => turn.turn_id), event_count: events.length, gaps: traceGaps },
      times.sort().at(-1) ?? worker.updated_at, [
        `${worker.task.title}; turns=${periodTurns.length}; recorded_llm_calls_by_seq=${llmCallsBySeq.join(',') || 'unknown'}`,
        ...[...errors].slice(-3).map(error => `error: ${error}`),
        ...periodTurns.slice(-2).map(turn => `result(${turn.completion_result?.source ?? 'unavailable'}): ${turn.completion_result?.content.slice(0, 200) ?? ''}`),
      ].join('\n'))
    }
    records.sort((left, right) => left.activity_at.localeCompare(right.activity_at) || left.source_id.localeCompare(right.source_id))
    return { records, gaps }
  }

  async read(record: ReflectionRecord, state: DailyReflectionState): Promise<ReflectionEvidence> {
    return this.readSource(record.source, state, undefined, record.digest)
  }

  private async readSource(source: ReflectionSource, window: ReflectionWindow, capturedEpisode?: ManagerEpisodeTrace, frozenDigest?: string): Promise<ReflectionEvidence> {
    const gaps: string[] = []
    const sourceGaps = source.kind === 'worker' ? source.gaps : []
    const values: unknown[] = []
    try {
      if (source.kind === 'manager_episode') {
        const episode = capturedEpisode ?? await this.deps.traces.readManagerEpisode(source.episode_id)
        if (!episode) gaps.push('manager_trace_unavailable')
        for (const id of source.span_ids) {
          const span = episode?.spans.find(item => item.span_id === id)
          if (span) values.push(span)
          else gaps.push(`manager_span_unavailable:${id}`)
        }
        if (!source.log_bytes) gaps.push('manager_history_unavailable')
        values.push(...(await this.messages(source)).filter(message => inWindow(message.timestamp, window)).map(visibleMessage))
      } else if (source.kind === 'human_input') {
        const session = await this.deps.store.load(source.manager_key as ManagerKey)
        for (const id of source.message_ids) {
          const message = session.recent.find(item => item.id === id)
          if (message) values.push(visibleMessage(message))
          else gaps.push(`human_input_unavailable:${id}`)
        }
      } else {
        const events = await this.deps.harness.readWorkerEvents(source.worker_id)
        if (events.length < source.event_count) gaps.push('worker_events_truncated')
        values.push(...events.slice(0, source.event_count).filter(event => inWindow(event.ts, window)))
        for (const trace of source.traces) {
          const result = await this.deps.readWorkerTrace(source.worker_id, trace)
          if (result.unavailable_reason) gaps.push(result.unavailable_reason)
          values.push(...result.events.filter(event => event.kind !== 'thinking' && inWindow(event.ts, window)))
        }
        for (const id of source.turn_ids) {
          const turn = await this.deps.turns.get(source.worker_id, id)
          if (!turn) gaps.push(`worker_turn_unavailable:${id}`)
          else values.push({ turn_id: turn.turn_id, completed_at: turn.completed_at, completion_result: turn.completion_result })
        }
      }
    } catch (error) { gaps.push(error instanceof Error ? error.message : String(error)) }
    const serialize = (items: unknown[]): string => this.deps.redact(JSON.stringify(items, (name, value) =>
      /^(raw_reasoning|reasoning|thinking|authorization|apikey|api_key|access_token)$/i.test(name) ? undefined : value))
    const filtered = source.kind === 'worker' ? values.filter(value => !isLegacyImportEvent(value)) : values
    let content = serialize(filtered)
    // Old manifests hashed migration audit rows too; preserve only an exact, still-redacted snapshot.
    if (frozenDigest && filtered.length !== values.length && reflectionDigest(content) !== frozenDigest) {
      const original = serialize(values)
      if (reflectionDigest(original) === frozenDigest) content = original
    }
    // Failed captures have no digest; retain the host's existing first-success hashing semantics.
    const verified = source.kind === 'worker' && source.traces.length > 0 && gaps.length === 0
      && frozenDigest !== undefined && (!frozenDigest || reflectionDigest(content) === frozenDigest)
    return { content, gaps: [
      ...sourceGaps.filter(gap => !verified || !/^\d+ malformed or unreadable legacy trace record\(s\)$/.test(gap)),
      ...gaps,
    ] }
  }
}
