import type { EngineToolLifecycleEvent, LLMRequestEvent } from '../../engine/types.js'
import { randomUUID } from 'node:crypto'
import type { WorkerRuntimeEvent, WorkerRuntimeSnapshot } from '../types.js'

/** Observation only: never drives input admission, retries or Worker lifecycle. */
export class BuiltinRuntimeObservation {
  private state: WorkerRuntimeSnapshot
  private compactionId?: string

  constructor(incarnationId: string, private readonly append: (event: WorkerRuntimeEvent) => void) {
    this.state = { incarnation_id: incarnationId, as_of: new Date().toISOString(), phase: 'unknown' }
  }

  snapshot(): WorkerRuntimeSnapshot {
    return structuredClone({ ...this.state, as_of: new Date().toISOString() })
  }

  private record(event: WorkerRuntimeEvent['event'], patch: Partial<WorkerRuntimeSnapshot>, progress = true): void {
    const now = new Date().toISOString()
    this.state = { ...this.state, ...patch, as_of: now, ...(progress ? { last_observed_at: now } : {}) }
    try { this.append({ kind: 'worker_runtime', version: 1, event, ...(this.compactionId ? { operation_id: this.compactionId } : {}), runtime: this.snapshot() }) }
    catch {
      if (!this.state.unavailable_reason) console.warn('[builtin-runtime] runtime trace write failed')
      this.state.unavailable_reason = 'runtime trace write failed'
    }
  }

  stage(phase: 'preparing' | 'idle' | 'ended', error?: string): void {
    this.record(phase, { phase, phase_started_at: new Date().toISOString(), retry: undefined, tools: [],
      ...(phase === 'preparing' && !error ? { request: undefined, error: undefined } : {}),
      ...(error ? { error } : {}) })
  }

  inputs(normal: number, priority: number, injected = false): void {
    this.record(injected ? 'input_injected' : 'input_queued', { pending_inputs: { normal, priority } }, false)
  }

  request(event: LLMRequestEvent, purpose: 'inference' | 'compaction'): void {
    const request = {
      request_id: event.requestId, call_id: event.callId, attempt: event.attempt, purpose,
      model_id: event.model, provider_id: event.providerId, started_at: new Date(event.startedAtMs).toISOString(),
      ...(event.firstChunkMs !== undefined ? { first_response_at: new Date(event.startedAtMs + event.firstChunkMs).toISOString() } : {}),
      ...(event.endedAtMs !== undefined ? { ended_at: new Date(event.endedAtMs).toISOString() } : {}),
    }
    if (event.phase === 'retry_wait') {
      this.record('retry_wait', { phase: 'retry_wait', phase_started_at: new Date(event.observedAtMs!).toISOString(),
        request: { ...this.state.request, ...request }, error: event.error,
        retry: { request_id: event.requestId, call_id: event.callId, retry_mode: event.retryMode!,
          started_at: new Date(event.observedAtMs!).toISOString(), delay_ms: event.delayMs!,
          ...(event.maxAttempts !== undefined ? { max_attempts: event.maxAttempts } : {}), error: event.error ?? '' } })
      return
    }
    const running = event.status === 'running'
    this.record(event.phase === 'first_response' ? 'first_response' : running ? 'request_started'
      : event.status === 'completed' ? 'request_completed' : 'request_failed', {
      phase: running ? 'llm_request' : purpose === 'compaction' ? 'compacting' : 'preparing',
      phase_started_at: running ? request.started_at : request.ended_at,
      request, retry: undefined, error: event.error,
    })
  }

  compaction(started: boolean, error?: string): void {
    if (started) this.compactionId = randomUUID()
    this.record(started ? 'compaction_started' : 'compaction_finished', {
      phase: started ? 'compacting' : 'preparing', phase_started_at: new Date().toISOString(),
      request: undefined, retry: undefined, error,
    })
    if (!started) this.compactionId = undefined
  }

  tool(event: EngineToolLifecycleEvent): void {
    const now = new Date().toISOString()
    const tools = (this.state.tools ?? []).filter((tool) => tool.call_id !== event.callId)
    if (event.type === 'tool_started') tools.push({ call_id: event.callId, name: event.name, started_at: new Date(event.startedAtMs).toISOString() })
    this.state = { ...this.state, tools, phase: tools.length ? 'tools' : 'preparing',
      phase_started_at: tools[0]?.started_at ?? now, last_observed_at: now, request: undefined, retry: undefined }
  }
}

export function isWorkerRuntimeEvent(value: unknown): value is WorkerRuntimeEvent {
  if (!value || typeof value !== 'object') return false
  const event = value as Partial<WorkerRuntimeEvent>
  return event.kind === 'worker_runtime' && event.version === 1 && !!event.runtime && typeof event.runtime.phase === 'string'
}
