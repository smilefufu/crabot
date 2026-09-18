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
import type { ManagerKey } from './types.js'
import type { DailyReflectionState, ReflectionEvidence, ReflectionManifest, ReflectionRecord, ReflectionSource, ReflectionWindow, ReflectionWorkerTrace } from './daily-reflection-types.js'
import { reflectionDigest } from './daily-reflection.js'

export interface ReflectionEvidenceDeps {
  managersDir: string
  store: ManagerSessionStore
  ledger: LedgerStore
  harness: WorkerHarness
  turns: WorkerTurnStore
  traces: Pick<TraceStore, 'listTraceManagerKeys' | 'listManagerEpisodes' | 'getManagerEpisode'>
  captureWorkerTrace: (workerId: string, seq: number) => Promise<{ source: ReflectionWorkerTrace; result: Pick<CompositeTraceResult, 'events' | 'unavailable_reason'> }>
  readWorkerTrace: (workerId: string, source: ReflectionWorkerTrace) => Promise<Pick<CompositeTraceResult, 'events' | 'unavailable_reason'>>
  redact: (text: string) => string
}

function inWindow(value: number | string, window: ReflectionWindow): boolean {
  const time = typeof value === 'number' ? value : Date.parse(value)
  return time >= Date.parse(window.window_start) && time < Date.parse(window.window_end)
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
    const add = async (source: ReflectionSource, activityAt: string, summary: string): Promise<void> => {
      const evidence = await this.readSource(source, state)
      records.push({ record_ref: randomUUID(), kind: source.kind, source_id: source.kind === 'worker' ? source.worker_id
        : source.kind === 'manager_episode' ? source.episode_id : source.manager_key,
      activity_at: activityAt, summary: this.deps.redact(summary), gaps: evidence.gaps, source, digest: reflectionDigest(evidence.content) })
    }

    // Establish every reflection episode before selecting Workers, including earlier runs.
    for (const key of keys) {
      const persisted = await this.deps.store.load(key)
      persisted.dailyReflection?.episode_ids.forEach(id => reflectionEpisodes.add(id))
      for (let page = 1; ; page++) {
        const result = this.deps.traces.listManagerEpisodes(key, { page, page_size: 100 })
        for (const episode of result.items) {
          if ((episode.trigger.schedule?.is_builtin && episode.trigger.schedule.task_type === 'daily_reflection')
            || episode.spans.some(span => span.type === 'agent_loop' && (span.details as { capability_profile?: string })?.capability_profile === 'daily_reflection')) reflectionEpisodes.add(episode.trace_id)
        }
        if (page >= result.pagination.total_pages) break
      }
    }

    for (const key of keys) {
      const ids = new Set<string>()
      for (let page = 1; ; page++) {
        const result = this.deps.traces.listManagerEpisodes(key, { page, page_size: 100 })
        result.items.forEach(episode => ids.add(episode.trace_id))
        if (page >= result.pagination.total_pages) break
      }
      try {
        for (const file of await fs.readdir(join(this.deps.managersDir, encodeSegment(key), 'episodes'))) {
          if (file.endsWith('.jsonl')) ids.add(file.slice(0, -6))
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') gaps.push(`manager_inventory_unavailable:${key}`)
      }
      const anchored = new Set<string>()
      for (const id of ids) {
        if (reflectionEpisodes.has(id)) continue
        const episode = this.deps.traces.getManagerEpisode(id)
        if (episode && (Date.parse(episode.started_at) >= Date.parse(state.window_end)
          || (episode.ended_at && Date.parse(episode.ended_at) < Date.parse(state.window_start)))) continue
        let bytes = 0
        try { bytes = (await fs.stat(this.episodePath(key, id))).size } catch { /* readSource exposes the missing history */ }
        const source: ReflectionSource = { kind: 'manager_episode', manager_key: key, episode_id: id, log_bytes: bytes,
          span_ids: episode?.spans.filter(span => ['tool_call', 'decision', 'memory_write', 'rpc_call'].includes(span.type)
            && !!span.ended_at && inWindow(span.ended_at, state)).map(span => span.span_id) ?? [] }
        let messages: EngineMessage[] = []
        try { messages = await this.messages(source) } catch { gaps.push(`manager_history_unreadable:${id}`) }
        const currentMessages = messages.filter(message => inWindow(message.timestamp, state))
        currentMessages.forEach(message => anchored.add(message.id))
        const times = [episode?.started_at, episode?.ended_at, ...episode?.spans.flatMap(span => [span.started_at, span.ended_at]) ?? [],
          ...currentMessages.map(message => new Date(message.timestamp).toISOString())]
          .filter((time): time is string => !!time && inWindow(time, state)).sort()
        if (!times.length) continue
        const userPreview = currentMessages.filter(message => isHumanInput(message))
          .map(message => (message as { content: string }).content.slice(0, 200)).slice(-3).join('\n')
        await add(source, times.at(-1)!, `${episode?.trigger.summary ?? 'persisted episode'}; status=${episode?.ended_at && inWindow(episode.ended_at, state) ? episode.status : 'in_progress'}; llm_turns=${episode?.spans.filter(span => span.type === 'llm_call' && inWindow(span.started_at, state)).length ?? 'unknown'}\n${userPreview}`)
      }
      const session = await this.deps.store.load(key)
      const unanchored = session.recent.filter(message => isHumanInput(message)
        && inWindow(message.timestamp, state) && !anchored.has(message.id))
      if (unanchored.length) {
        await add({ kind: 'human_input', manager_key: key, message_ids: unanchored.map(message => message.id) },
          new Date(unanchored.at(-1)!.timestamp).toISOString(), '尚未关联完整 episode 的持久入站内容')
      }
    }

    for (const { worker } of await this.deps.ledger.listAllWorkers()) {
      if (worker.origin.spawned_by_episode && reflectionEpisodes.has(worker.origin.spawned_by_episode)) continue
      if (state.analysis_worker_ids.includes(worker.worker_id)) continue
      const events = await this.deps.harness.readWorkerEvents(worker.worker_id)
      const turns = await this.deps.turns.list(worker.worker_id)
      const traces: ReflectionWorkerTrace[] = []
      const times = [...events.filter(event => inWindow(event.ts, state)).map(event => event.ts),
        ...turns.filter(turn => inWindow(turn.completed_at, state)).map(turn => turn.completed_at)]
      const traceGaps: string[] = []
      for (const incarnation of worker.incarnations) {
        try {
          const captured = await this.deps.captureWorkerTrace(worker.worker_id, incarnation.seq)
          traces.push(captured.source)
          times.push(...captured.result.events.filter(event => inWindow(event.ts, state)).map(event => event.ts))
          if (captured.result.unavailable_reason) traceGaps.push(captured.result.unavailable_reason)
        } catch { traceGaps.push(`worker_trace_unavailable:${worker.worker_id}:${incarnation.seq}`) }
      }
      if (!times.length && !inWindow(worker.updated_at, state)) continue
      await add({ kind: 'worker', worker_id: worker.worker_id, traces,
        turn_ids: turns.filter(turn => inWindow(turn.completed_at, state)).map(turn => turn.turn_id), event_count: events.length, gaps: traceGaps },
      times.sort().at(-1) ?? worker.updated_at, `${worker.task.title}; turns=${turns.filter(turn => inWindow(turn.completed_at, state)).length}`)
    }
    records.sort((left, right) => left.activity_at.localeCompare(right.activity_at) || left.source_id.localeCompare(right.source_id))
    return { records, gaps }
  }

  async read(record: ReflectionRecord, state: DailyReflectionState): Promise<ReflectionEvidence> {
    return this.readSource(record.source, state)
  }

  private async readSource(source: ReflectionSource, window: ReflectionWindow): Promise<ReflectionEvidence> {
    const gaps: string[] = []
    const values: unknown[] = []
    try {
      if (source.kind === 'manager_episode') {
        const episode = this.deps.traces.getManagerEpisode(source.episode_id)
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
        gaps.push(...source.gaps)
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
    const content = this.deps.redact(JSON.stringify(values, (name, value) =>
      /^(raw_reasoning|reasoning|thinking|authorization|apikey|api_key|access_token)$/i.test(name) ? undefined : value))
    return { content, gaps }
  }
}
