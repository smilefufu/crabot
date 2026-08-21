import { createHash } from 'crypto'
import type { IncarnationId, NormalizedTraceEvent, WorkerActivity, WorkerActivityView } from '../types.js'

/**
 * Manager activity is a native-session read model. Harness events wake the manager, but are not
 * worker conversation content and therefore never appear in this projection.
 */
export function projectWorkerActivity(
  events: ReadonlyArray<NormalizedTraceEvent>,
  view: WorkerActivityView,
  identity: { worker_id: string; incarnation_id: IncarnationId },
): WorkerActivity[] {
  return events.flatMap((event) => {
    if (event.source === 'harness') return []
    const kind = event.kind === 'message' && event.role === 'assistant'
      ? 'assistant_text'
      : event.kind === 'tool_call' || event.kind === 'tool_result'
        ? event.kind
        : undefined
    if (!kind || (view === 'assistant' && kind !== 'assistant_text')) return []
    const activity: WorkerActivity = {
      activity_id: stableActivityId(identity.incarnation_id, event),
      worker_id: identity.worker_id,
      incarnation_id: identity.incarnation_id,
      kind,
      occurred_at: event.ts,
      summary: event.summary,
      ...(kind === 'assistant_text' ? { text: event.summary } : {}),
      ...(view === 'all' && event.detail !== undefined ? { detail: event.detail } : {}),
    }
    return [activity]
  })
}

function stableActivityId(incarnationId: IncarnationId, event: NormalizedTraceEvent): string {
  return createHash('sha256')
    .update(JSON.stringify([incarnationId, event.source_offset, event.ts, event.kind, event.role, event.summary, event.detail]))
    .digest('hex')
    .slice(0, 32)
}
