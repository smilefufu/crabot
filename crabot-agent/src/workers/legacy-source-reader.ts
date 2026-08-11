import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { sha256CanonicalJson } from 'crabot-shared'
import type { NormalizedTraceEvent } from './types.js'

export interface LegacyTrace {
  readonly trace_id: string
  readonly related_task_id: string
  readonly started_at?: string
  readonly ended_at?: string
  readonly outcome?: { readonly summary?: string }
  readonly resume_checkpoint?: { readonly worker_state?: { readonly cwd?: string } }
  readonly raw: Record<string, unknown>
  readonly canonical_content_sha256: string
}

export interface LegacyTraceEventEntry {
  readonly event: NormalizedTraceEvent
  readonly started_at?: string
  readonly ended_at?: string
  readonly trace_id: string
  readonly source_ordinal: number
}

export interface LegacyTraceReadResult {
  readonly entries: LegacyTraceEventEntry[]
  readonly unavailable_reason?: string
}

export interface LegacyTraceScanResult {
  readonly traces: Map<string, LegacyTrace[]>
  readonly diagnostic_count: number
}

/** Read the imported trace references lazily; missing/retained source data degrades to a diagnostic. */
export async function readLegacyTraceEvents(
  traceDir: string,
  traceIds: ReadonlyArray<string>,
): Promise<LegacyTraceReadResult> {
  let scan: LegacyTraceScanResult
  try {
    scan = await scanLegacyTraces(traceDir)
  } catch (error) {
    return { entries: [], unavailable_reason: `legacy trace source unavailable: ${message(error)}` }
  }
  const byId = new Map<string, LegacyTrace>()
  for (const entries of scan.traces.values()) for (const trace of entries) byId.set(trace.trace_id, trace)
  let missing = 0
  const selected: LegacyTrace[] = []
  for (const id of traceIds) {
    const trace = byId.get(id)
    if (trace) selected.push(trace)
    else missing++
  }
  const entries = selected
    .sort(compareTrace)
    .map((trace, sourceOrdinal): LegacyTraceEventEntry => ({
      event: {
        ts: trace.started_at ?? trace.ended_at ?? '',
        kind: 'lifecycle',
        summary: trace.outcome?.summary ?? `legacy trace ${trace.trace_id}`,
        detail: trace.raw,
      },
      ...(trace.started_at ? { started_at: trace.started_at } : {}),
      ...(trace.ended_at ? { ended_at: trace.ended_at } : {}),
      trace_id: trace.trace_id,
      source_ordinal: sourceOrdinal,
    }))
  const unavailable: string[] = []
  if (missing > 0) unavailable.push(`${missing} legacy trace reference(s) unavailable`)
  if (scan.diagnostic_count > 0) unavailable.push(`${scan.diagnostic_count} malformed or unreadable legacy trace record(s)`)
  return {
    entries,
    ...(unavailable.length > 0 ? { unavailable_reason: unavailable.join('; ') } : {}),
  }
}

export function compareLegacyTraceEventEntries(
  left: LegacyTraceEventEntry,
  right: LegacyTraceEventEntry,
): number {
  const startedOrder = compareOptionalTimestamp(left.started_at, right.started_at)
  if (startedOrder !== 0) return startedOrder
  const endedOrder = compareOptionalTimestamp(left.ended_at, right.ended_at)
  if (endedOrder !== 0) return endedOrder
  return left.trace_id.localeCompare(right.trace_id) || left.source_ordinal - right.source_ordinal
}

export async function readLegacyTraces(traceDir: string): Promise<Map<string, LegacyTrace[]>> {
  return (await scanLegacyTraces(traceDir)).traces
}

/** Pure, read-only scan of v2 TraceStore archives with bounded diagnostics. */
export async function scanLegacyTraces(traceDir: string): Promise<LegacyTraceScanResult> {
  let files: string[]
  try {
    files = await fs.readdir(traceDir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { traces: new Map(), diagnostic_count: 0 }
    }
    throw error
  }

  let diagnosticCount = 0
  const byId = new Map<string, LegacyTrace>()
  for (const file of files.filter(isLegacyTraceFile).sort(compareTraceFile)) {
    let text: string
    try {
      text = await fs.readFile(join(traceDir, file), 'utf8')
    } catch (error) {
      diagnosticCount++
      console.warn(`[legacy-import] skipping unreadable trace file ${file}: ${message(error)}`)
      continue
    }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      const trace = parseTrace(line, file)
      if (!trace) {
        diagnosticCount++
        continue
      }
      const prior = byId.get(trace.trace_id)
      if (prior && prior.related_task_id !== trace.related_task_id) {
        throw new Error(
          `[legacy-import] trace_id ${trace.trace_id} belongs to both ` +
          `${prior.related_task_id} and ${trace.related_task_id}`,
        )
      }
      // TraceStore may append updated copies. Stable file/line order makes the final copy authoritative.
      byId.set(trace.trace_id, trace)
    }
  }

  const byTask = new Map<string, LegacyTrace[]>()
  for (const trace of byId.values()) {
    const entries = byTask.get(trace.related_task_id) ?? []
    entries.push(trace)
    byTask.set(trace.related_task_id, entries)
  }
  for (const entries of byTask.values()) entries.sort(compareTrace)
  return { traces: byTask, diagnostic_count: diagnosticCount }
}

function isLegacyTraceFile(name: string): boolean {
  if (name === 'traces-running-v3.jsonl') return false
  if (name === 'traces-running.jsonl') return true
  if (/^traces-\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)) return true
  return /^traces-running-.+\.jsonl$/.test(name)
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function compareTraceFile(left: string, right: string): number {
  const rank = (name: string): number => {
    if (/^traces-\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)) return 0
    if (name === 'traces-running.jsonl') return 1
    return 2 // per-task checkpoint is newer than the global in-flight snapshot
  }
  return rank(left) - rank(right) || left.localeCompare(right)
}

function parseTrace(line: string, file: string): LegacyTrace | undefined {
  let raw: unknown
  try {
    raw = JSON.parse(line)
  } catch {
    console.warn(`[legacy-import] skipping malformed trace line in ${file}`)
    return undefined
  }
  if (
    !isRecord(raw) ||
    !validIdentifier(raw.trace_id) ||
    !validIdentifier(raw.related_task_id)
  ) {
    console.warn(`[legacy-import] skipping unassociated or invalid trace in ${file}`)
    return undefined
  }

  let hash: string
  try {
    hash = sha256CanonicalJson(raw)
  } catch {
    console.warn(`[legacy-import] skipping non-canonical trace ${raw.trace_id}`)
    return undefined
  }

  const startedAt = optionalIso(raw.started_at, `trace ${raw.trace_id} started_at`)
  const endedAt = optionalIso(raw.ended_at, `trace ${raw.trace_id} ended_at`)
  const outcome = isRecord(raw.outcome) && typeof raw.outcome.summary === 'string'
    ? { summary: raw.outcome.summary }
    : undefined
  const checkpoint = isRecord(raw.resume_checkpoint) && isRecord(raw.resume_checkpoint.worker_state)
    ? raw.resume_checkpoint.worker_state
    : undefined
  const cwd = typeof checkpoint?.cwd === 'string' ? checkpoint.cwd : undefined

  return {
    trace_id: raw.trace_id,
    related_task_id: raw.related_task_id,
    ...(startedAt ? { started_at: startedAt } : {}),
    ...(endedAt ? { ended_at: endedAt } : {}),
    ...(outcome ? { outcome } : {}),
    ...(cwd ? { resume_checkpoint: { worker_state: { cwd } } } : {}),
    raw,
    canonical_content_sha256: hash,
  }
}

function compareTrace(left: LegacyTrace, right: LegacyTrace): number {
  const startedOrder = compareOptionalTimestamp(left.started_at, right.started_at)
  if (startedOrder !== 0) return startedOrder
  const endedOrder = compareOptionalTimestamp(left.ended_at, right.ended_at)
  if (endedOrder !== 0) return endedOrder
  return left.trace_id.localeCompare(right.trace_id)
}

function compareOptionalTimestamp(left: string | undefined, right: string | undefined): number {
  if (left && right) return Date.parse(left) - Date.parse(right)
  if (left) return -1
  if (right) return 1
  return 0
}

function optionalIso(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined
  if (validIso(value)) return value
  console.warn(`[legacy-import] ignoring invalid ${label}`)
  return undefined
}

function validIso(value: unknown): value is string {
  return typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
    Number.isFinite(Date.parse(value))
}

function validIdentifier(value: unknown): value is string {
  return typeof value === 'string' &&
    value.length > 0 &&
    value === value.trim() &&
    !/[\u0000-\u001f\u007f]/.test(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
