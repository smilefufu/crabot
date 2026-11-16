import fs from 'node:fs'
import path from 'node:path'
import type { AgentSpan, AgentSpanDetails, AgentTrace, ResumeCheckpoint } from '../types.js'
import type { ManagerEpisodeSpan, ManagerEpisodeTrace } from '../manager/trace-types.js'

// Append-only trace log. One file per trace; every mutation is one small record.
// The in-memory trace is a fold; the ending record is the only "closed" marker.
// Line format is newline-delimited JSON. A trailing partial line is ignored on read.

export type TraceKind = 'agent' | 'manager_episode'
type Trace = AgentTrace | ManagerEpisodeTrace
type Span = AgentSpan | ManagerEpisodeSpan

interface Base {
  v: 1
  trace_id: string
  seq: number
  ts: string
}

export type TraceLogRecord =
  | (Base & { type: 'trace_start'; kind: TraceKind; trace: Trace })
  | (Base & { type: 'snapshot'; kind: TraceKind; trace: Trace })
  | (Base & { type: 'span_upsert'; span: Span })
  | (Base & { type: 'span_patch'; span_id: string; patch: { status?: 'completed' | 'failed'; ended_at?: string; duration_ms?: number; details?: unknown } })
  | (Base & { type: 'checkpoint'; checkpoint: ResumeCheckpoint })
  | (Base & { type: 'outcome_patch'; outcome: NonNullable<AgentTrace['outcome']> })
  | (Base & { type: 'trace_end'; status: 'completed' | 'failed'; ended_at: string; duration_ms?: number; outcome?: AgentTrace['outcome']; total_usage?: AgentTrace['total_usage'] })

type RecordInput = { [K in TraceLogRecord['type']]: Omit<Extract<TraceLogRecord, { type: K }>, 'v' | 'trace_id' | 'seq' | 'ts'> }[TraceLogRecord['type']] & { ts?: string }

export interface FoldedTrace {
  kind: TraceKind
  trace: Trace
  ended: boolean
  /** span_id -> seq of its last upsert; used for seq windows. */
  seqs: Map<string, number>
}

const END_MARKER_BYTES = 16 * 1024

function clone<T>(value: T): T { return structuredClone(value) }

/** Folds complete records; malformed lines and a partial trailing line are skipped. */
function apply(state: FoldedTrace | undefined, record: TraceLogRecord): FoldedTrace | undefined {
  if (record.type === 'trace_start' || record.type === 'snapshot') {
    const next: FoldedTrace = { kind: record.kind, trace: clone(record.trace), ended: false, seqs: new Map() }
    if (record.type === 'trace_start') next.trace.status = 'running'
    return next
  }
  if (!state) return undefined
  const trace = state.trace as AgentTrace & ManagerEpisodeTrace
  switch (record.type) {
    case 'span_upsert': {
      const spans = trace.spans as Span[]
      const index = spans.findIndex((span) => span.span_id === record.span.span_id)
      if (index < 0) spans.push(clone(record.span))
      else spans[index] = clone(record.span)
      state.seqs.set(record.span.span_id, record.seq)
      break
    }
    case 'span_patch': {
      const span = (trace.spans as Span[]).find((item) => item.span_id === record.span_id)
      if (!span) break
      if (record.patch.status) span.status = record.patch.status
      if (record.patch.ended_at) span.ended_at = record.patch.ended_at
      if (record.patch.duration_ms !== undefined) span.duration_ms = record.patch.duration_ms
      if (record.patch.details !== undefined) span.details = record.patch.details as AgentSpanDetails
      break
    }
    case 'checkpoint': trace.resume_checkpoint = clone(record.checkpoint); break
    case 'outcome_patch': trace.outcome = { ...(trace.outcome ?? { summary: '' }), ...clone(record.outcome) }; break
    case 'trace_end':
      trace.status = record.status
      trace.ended_at = record.ended_at
      if (record.duration_ms !== undefined) trace.duration_ms = record.duration_ms
      if (record.outcome) trace.outcome = clone(record.outcome)
      if (record.total_usage) trace.total_usage = clone(record.total_usage)
      state.ended = true
      break
  }
  return state
}

function parseRecords(content: string): TraceLogRecord[] {
  const records: TraceLogRecord[] = []
  const lines = content.split('\n')
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    if (!line.trim()) continue
    // A partial tail is the only line allowed to be malformed.
    try {
      const parsed = JSON.parse(line) as TraceLogRecord
      if (parsed.v === 1 && typeof parsed.type === 'string') records.push(parsed)
    } catch { if (index < lines.length - 2) throw new Error('Corrupt trace log line') }
  }
  return records
}

export class TraceLog {
  private readonly nextSeq = new Map<string, number>()
  private readonly handles = new Map<string, number>()
  private readonly known = new Set<string>()
  private readonly directories = new Set<string>()
  private readonly windowCache = new Map<string, { size: number; state: FoldedTrace | undefined }>()
  constructor(private readonly root: string) {}

  /** Whether this process already created the file (still verified by the caller on first use). */
  has(file: string): boolean { return this.known.has(file) }

  private write(file: string, line: string): void {
    let handle = this.handles.get(file)
    if (handle === undefined) {
      handle = fs.openSync(file, 'a')
      this.handles.set(file, handle)
    }
    fs.writeSync(handle, line)
  }

  /** Releases the append handle; later appends reopen the file. */
  close(traceId: string, startedAt: string): void {
    const file = this.file(traceId, startedAt)
    const handle = this.handles.get(file)
    if (handle === undefined) return
    this.handles.delete(file)
    try { fs.closeSync(handle) } catch { /* already closed */ }
  }

  private directory(startedAt: string): string {
    return path.join(this.root, 'traces-v4', startedAt.slice(0, 10))
  }

  /** Finds a trace file without an index; dates are scanned in order. */
  find(traceId: string): string | undefined {
    const root = path.join(this.root, 'traces-v4')
    if (!fs.existsSync(root)) return undefined
    for (const date of fs.readdirSync(root)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue
      const file = path.join(root, date, `${traceId}.jsonl`)
      if (fs.existsSync(file)) return file
    }
    return undefined
  }

  file(traceId: string, startedAt: string): string {
    return path.join(this.directory(startedAt), `${traceId}.jsonl`)
  }

  start(traceId: string, startedAt: string, kind: TraceKind, trace: Trace): void {
    const file = this.file(traceId, startedAt)
    const directory = path.dirname(file)
    if (!this.directories.has(directory)) {
      fs.mkdirSync(directory, { recursive: true })
      this.directories.add(directory)
    }
    this.known.add(file)
    this.write(file, JSON.stringify({ v: 1, trace_id: traceId, seq: 0, ts: new Date().toISOString(), type: 'trace_start', kind, trace }) + '\n')
  }

  append(traceId: string, startedAt: string, record: RecordInput): number {
    const file = this.file(traceId, startedAt)
    const seq = this.nextSeq.get(traceId) ?? this.lastSeq(traceId, startedAt) + 1
    this.write(file, JSON.stringify({ ...record, v: 1, trace_id: traceId, seq, ts: record.ts ?? new Date().toISOString() }) + '\n')
    return seq
  }

  read(traceId: string, startedAt: string, fromSeq = 0): TraceLogRecord[] {
    try {
      return parseRecords(fs.readFileSync(this.file(traceId, startedAt), 'utf-8')).filter((record) => record.seq >= fromSeq)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
  }

  fold(traceId: string, startedAt: string): FoldedTrace | undefined {
    let state: FoldedTrace | undefined
    const records = this.read(traceId, startedAt)
    for (const record of records) state = apply(state, record)
    const last = records.at(-1)
    if (last) this.nextSeq.set(traceId, last.seq + 1)
    return state
  }

  /** Spans upserted at or after fromSeq, with their seqs; undefined when the file is missing. */
  window(traceId: string, startedAt: string, fromSeq: number): { spans: Array<{ span: Span; seq: number }>; lastSeq: number } | undefined {
    const file = this.file(traceId, startedAt)
    let stat: fs.Stats
    try { stat = fs.statSync(file) } catch { return undefined }
    let cached = this.windowCache.get(traceId)
    if (!cached || cached.size !== stat.size) {
      const records = this.read(traceId, startedAt)
      let state: FoldedTrace | undefined
      for (const record of records) state = apply(state, record)
      cached = { size: stat.size, state }
      this.windowCache.set(traceId, cached)
    }
    const folded = cached.state
    if (!folded) return undefined
    const spans = (folded.trace.spans as Span[])
      .map((span) => ({ span, seq: folded.seqs.get(span.span_id) ?? 0 }))
      .filter((item) => item.seq >= fromSeq)
    const lastSeq = this.lastSeq(traceId, startedAt)
    this.nextSeq.set(traceId, lastSeq + 1)
    return { spans, lastSeq }
  }

  foldFile(file: string): FoldedTrace | undefined {
    let state: FoldedTrace | undefined
    const records = parseRecords(fs.readFileSync(file, 'utf-8'))
    for (const record of records) state = apply(state, record)
    const last = records.at(-1)
    if (last) this.nextSeq.set(last.trace_id, last.seq + 1)
    return state
  }

  /** Last complete record's seq; a partial tail is ignored. */
  lastSeq(traceId: string, startedAt: string): number {
    const file = this.file(traceId, startedAt)
    try {
      const content = fs.readFileSync(file, 'utf-8')
      const lines = content.split('\n').filter((line) => line.trim())
      for (let index = lines.length - 1; index >= 0; index--) {
        try { return (JSON.parse(lines[index]) as TraceLogRecord).seq } catch { continue }
      }
      return 0
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0
      throw error
    }
  }

  ended(file: string): { ended: boolean; ended_at?: string; size: number } {
    const stat = fs.statSync(file)
    const start = Math.max(0, stat.size - END_MARKER_BYTES)
    let tail = ''
    try {
      const handle = fs.openSync(file, 'r')
      try {
        const buffer = Buffer.alloc(stat.size - start)
        fs.readSync(handle, buffer, 0, buffer.length, start)
        tail = buffer.toString('utf-8')
      } finally { fs.closeSync(handle) }
    } catch { /* treat as active */ }
    const lines = tail.split('\n').filter((line) => line.trim())
    for (let index = lines.length - 1; index >= 0; index--) {
      try {
        const record = JSON.parse(lines[index]) as TraceLogRecord
        if (record.type === 'trace_end') return { ended: true, ended_at: record.ended_at, size: stat.size }
        // A new header reopens the trace; outcome/metadata patches do not.
        if (record.type === 'trace_start' || record.type === 'snapshot') return { ended: false, size: stat.size }
      } catch { continue }
    }
    return { ended: false, size: stat.size }
  }

  /** Rewrites an active file, keeping the header, the latest checkpoint and everything after it. */
  compact(traceId: string, startedAt: string, maxTailBytes: number): boolean {
    const file = this.file(traceId, startedAt)
    this.close(traceId, startedAt)
    let records: TraceLogRecord[]
    try { records = parseRecords(fs.readFileSync(file, 'utf-8')) } catch { return false }
    if (!records.length) return false
    const startIndex = records.findIndex((record) => record.type === 'trace_start' || record.type === 'snapshot')
    if (startIndex < 0) return false
    let checkpointIndex = -1
    for (let index = records.length - 1; index >= 0; index--) {
      if (records[index].type === 'checkpoint') { checkpointIndex = index; break }
    }
    // Always keep the header. With a checkpoint keep it and the record after; otherwise keep a byte budget tail.
    let cut = checkpointIndex > 0 ? checkpointIndex : records.length
    if (checkpointIndex < 0) {
      let bytes = 0
      for (let index = records.length - 1; index > startIndex; index--) {
        bytes += Buffer.byteLength(JSON.stringify(records[index]) + '\n')
        if (bytes > maxTailBytes) { cut = index + 1; break }
      }
    }
    if (cut <= startIndex + 1) return false
    const kept = [records[startIndex], ...records.slice(cut)]
    if (kept.length >= records.length) return false
    const temporary = `${file}.compact-${process.pid}`
    fs.writeFileSync(temporary, kept.map((record) => JSON.stringify(record)).join('\n') + '\n', 'utf-8')
    for (let attempt = 0; ; attempt++) {
      try { fs.renameSync(temporary, file); return true }
      catch (error) {
        const code = (error as NodeJS.ErrnoException).code ?? ''
        if (process.platform !== 'win32' || !['EPERM', 'EBUSY', 'EACCES'].includes(code) || attempt >= 8) {
          fs.rmSync(temporary, { force: true }); throw error
        }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25 * 2 ** attempt)
      }
    }
  }

  files(): string[] {
    const directory = path.join(this.root, 'traces-v4')
    if (!fs.existsSync(directory)) return []
    const result: string[] = []
    for (const date of fs.readdirSync(directory)) {
      const day = path.join(directory, date)
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !fs.statSync(day).isDirectory()) continue
      for (const name of fs.readdirSync(day)) if (name.endsWith('.jsonl')) result.push(path.join(day, name))
    }
    return result
  }

  /** Finished traces older than cutoff, oldest first. Active files are never returned. */
  deletable(cutoffMs: number): Array<{ file: string; ended_ms: number; size: number }> {
    const result: Array<{ file: string; ended_ms: number; size: number }> = []
    for (const file of this.files()) {
      const state = this.ended(file)
      if (!state.ended) continue
      const endedMs = state.ended_at ? Date.parse(state.ended_at) : fs.statSync(file).mtimeMs
      if (!Number.isFinite(endedMs) || endedMs >= cutoffMs) continue
      result.push({ file, ended_ms: endedMs, size: state.size })
    }
    return result.sort((a, b) => a.ended_ms - b.ended_ms)
  }

  remove(file: string): void {
    this.known.delete(file)
    const traceId = path.basename(file, '.jsonl')
    this.nextSeq.delete(traceId)
    this.windowCache.delete(traceId)
    for (const [path, handle] of this.handles) {
      if (path !== file) continue
      this.handles.delete(path)
      try { fs.closeSync(handle) } catch { /* already closed */ }
    }
    fs.rmSync(file, { force: true })
  }
}
