import { promises as fs } from 'node:fs'
import type { TraceStore } from '../../core/trace-store.js'
import type { BgEntityRegistry } from './registry.js'
import { reviewFingerprint, type ReviewBackgroundFacts } from '../../workers/harness/idle-review-facts.js'

/** Local recorded facts only. Never reads Output, probes processes or settles receipts. */
export async function readReviewBackgrounds(
  registry: BgEntityRegistry,
  traces: TraceStore,
  workerIds: readonly string[],
): Promise<Record<string, ReviewBackgroundFacts>> {
  const owners = new Set(workerIds)
  const records = (await registry.list()).filter(record => record.owner.worker_id && owners.has(record.owner.worker_id))
    .sort((a, b) => a.entity_id.localeCompare(b.entity_id))
  const result: Record<string, ReviewBackgroundFacts> = {}
  for (const workerId of workerIds) {
    let canSkip = true
    let active = false
    const facts: unknown[] = []
    for (const record of records.filter(record => record.owner.worker_id === workerId)) {
      const pending = record.exit_notification?.status === 'pending'
      active ||= record.status === 'running' || record.status === 'stalled' || pending
      canSkip &&= !pending && record.status !== 'stalled'
      const fact: Record<string, unknown> = {
        id: record.entity_id, owner: record.owner, status: record.status, exit_code: record.exit_code,
        notification: record.exit_notification?.status,
      }
      if (record.type === 'agent' && record.stop_requested_at) canSkip = false
      if (record.status === 'running') {
        const file = record.type === 'shell' ? record.log_file : record.output_file
        try {
          if (!file) throw new Error('output source unavailable')
          const stat = await fs.stat(file, { bigint: true })
          if (!stat.isFile()) throw new Error('output source unavailable')
          // Append-only output identity; atime and registry last_activity_at are deliberately excluded.
          fact.output = [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].map(String)
          if (record.type === 'agent') {
            const trace = record.trace_id ? await traces.getFullTrace(record.trace_id) : undefined
            if (!trace) throw new Error('child business activity unavailable')
            fact.activity = trace.spans.filter(span => span.type === 'tool_call' || span.type === 'tool_result'
              || (span.type === 'context_assembly' && Array.isArray((span.details as Record<string, unknown>).message_batch)))
              .map(span => ({ id: span.span_id, type: span.type, status: span.status, details: span.details }))
          }
        } catch { canSkip = false }
      }
      facts.push(fact)
    }
    result[workerId] = { fingerprint: reviewFingerprint(facts), canSkip, active }
  }
  return result
}
