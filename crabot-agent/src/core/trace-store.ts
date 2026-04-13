/**
 * TraceStore - Agent 执行 Trace 的 Ring Buffer 存储
 *
 * @see crabot-docs/protocols/protocol-agent-v2.md §8
 */

import * as fs from 'fs'
import * as path from 'path'
import type { AgentTrace, AgentSpan, AgentSpanType, AgentSpanDetails } from '../types.js'

export interface TraceIndexEntry {
  trace_id: string
  related_task_id?: string
  parent_trace_id?: string
  trigger_type: string
  trigger_summary: string
  started_at: string
  ended_at?: string
  status: 'running' | 'completed' | 'failed'
  outcome_summary?: string
  span_count: number
  file: string
  file_offset: number
}

export class TraceStore {
  private traces: Map<string, AgentTrace> = new Map()
  private order: string[] = []
  private maxSize: number
  private persistDir: string | undefined
  private traceIndex: TraceIndexEntry[] = []
  private taskIndex: Map<string, string[]> = new Map()

  constructor(maxSize = 100, persistDir?: string) {
    this.maxSize = maxSize
    this.persistDir = persistDir
    if (persistDir) {
      fs.mkdirSync(persistDir, { recursive: true })
      this.rebuildIndex()
    }
  }

  private rebuildIndex(): void {
    if (!this.persistDir) return
    try {
      const files = fs.readdirSync(this.persistDir)
        .filter(f => f.startsWith('traces-') && f.endsWith('.jsonl'))
        .sort()

      for (const file of files) {
        const filePath = path.join(this.persistDir, file)
        const content = fs.readFileSync(filePath, 'utf-8')
        let offset = 0
        for (const line of content.split('\n')) {
          const lineBytes = Buffer.byteLength(line + '\n', 'utf-8')
          if (!line.trim()) { offset += lineBytes; continue }
          try {
            const trace = JSON.parse(line) as AgentTrace
            const entry: TraceIndexEntry = {
              trace_id: trace.trace_id,
              related_task_id: trace.related_task_id,
              parent_trace_id: trace.parent_trace_id,
              trigger_type: trace.trigger.type,
              trigger_summary: trace.trigger.summary,
              started_at: trace.started_at,
              ended_at: trace.ended_at,
              status: trace.status,
              outcome_summary: trace.outcome?.summary,
              span_count: trace.spans?.length ?? 0,
              file,
              file_offset: offset,
            }
            this.traceIndex.push(entry)
            if (trace.related_task_id) {
              const existing = this.taskIndex.get(trace.related_task_id) ?? []
              this.taskIndex.set(trace.related_task_id, [...existing, trace.trace_id])
            }
          } catch { /* skip malformed lines */ }
          offset += lineBytes
        }
      }
    } catch { /* persist dir read failure */ }
  }

  searchTraces(params: {
    task_id?: string
    time_range?: { start: string; end: string }
    keyword?: string
    status?: string
    limit?: number
    offset?: number
  }): { traces: TraceIndexEntry[]; total: number } {
    let results = [...this.traceIndex]

    // Merge running traces from ring buffer not yet persisted
    for (const trace of this.traces.values()) {
      if (trace.status === 'running' && !results.some(e => e.trace_id === trace.trace_id)) {
        results.push({
          trace_id: trace.trace_id,
          related_task_id: trace.related_task_id,
          parent_trace_id: trace.parent_trace_id,
          trigger_type: trace.trigger.type,
          trigger_summary: trace.trigger.summary,
          started_at: trace.started_at,
          ended_at: trace.ended_at,
          status: trace.status,
          outcome_summary: trace.outcome?.summary,
          span_count: trace.spans.length,
          file: '',
          file_offset: 0,
        })
      }
    }

    if (params.task_id) {
      const traceIds = new Set(this.taskIndex.get(params.task_id) ?? [])
      for (const trace of this.traces.values()) {
        if (trace.related_task_id === params.task_id) traceIds.add(trace.trace_id)
      }
      results = results.filter(e => traceIds.has(e.trace_id))
    }

    if (params.time_range) {
      const start = new Date(params.time_range.start).getTime()
      const end = new Date(params.time_range.end).getTime()
      results = results.filter(e => {
        const t = new Date(e.started_at).getTime()
        return t >= start && t < end
      })
    }

    if (params.keyword) {
      const kw = params.keyword.toLowerCase()
      results = results.filter(e =>
        e.trigger_summary.toLowerCase().includes(kw) ||
        (e.outcome_summary?.toLowerCase().includes(kw) ?? false)
      )
    }

    if (params.status) {
      results = results.filter(e => e.status === params.status)
    }

    results.sort((a, b) => new Date(b.started_at).getTime() - new Date(a.started_at).getTime())

    const total = results.length
    const limit = Math.min(params.limit ?? 20, 100)
    const off = params.offset ?? 0
    return { traces: results.slice(off, off + limit), total }
  }

  startTrace(params: {
    module_id: string
    trigger: AgentTrace['trigger']
    parent_trace_id?: string
    parent_span_id?: string
    related_task_id?: string
  }): AgentTrace {
    const trace: AgentTrace = {
      trace_id: crypto.randomUUID(),
      parent_trace_id: params.parent_trace_id,
      parent_span_id: params.parent_span_id,
      related_task_id: params.related_task_id,
      module_id: params.module_id,
      started_at: new Date().toISOString(),
      status: 'running',
      trigger: params.trigger,
      spans: [],
    }

    // Ring Buffer：超出容量时淘汰最旧的
    if (this.order.length >= this.maxSize) {
      const oldest = this.order.shift()!
      this.traces.delete(oldest)
    }

    this.traces.set(trace.trace_id, trace)
    this.order.push(trace.trace_id)
    return trace
  }

  startSpan(
    traceId: string,
    params: {
      type: AgentSpanType
      parent_span_id?: string
      details: AgentSpanDetails
    }
  ): AgentSpan {
    const span: AgentSpan = {
      span_id: crypto.randomUUID(),
      parent_span_id: params.parent_span_id,
      trace_id: traceId,
      type: params.type,
      started_at: new Date().toISOString(),
      status: 'running',
      details: params.details,
    }

    const trace = this.traces.get(traceId)
    if (trace) {
      trace.spans.push(span)
    }

    return span
  }

  endSpan(
    traceId: string,
    spanId: string,
    status: 'completed' | 'failed',
    detailsUpdate?: Partial<AgentSpanDetails>
  ): void {
    const trace = this.traces.get(traceId)
    if (!trace) return

    const span = trace.spans.find((s) => s.span_id === spanId)
    if (!span) return

    const now = new Date()
    span.ended_at = now.toISOString()
    span.duration_ms = now.getTime() - new Date(span.started_at).getTime()
    span.status = status

    if (detailsUpdate) {
      span.details = { ...span.details, ...detailsUpdate } as AgentSpanDetails
    }
  }

  endTrace(
    traceId: string,
    status: 'completed' | 'failed',
    outcome?: AgentTrace['outcome']
  ): void {
    const trace = this.traces.get(traceId)
    if (!trace) return

    const now = new Date()
    trace.ended_at = now.toISOString()
    trace.duration_ms = now.getTime() - new Date(trace.started_at).getTime()
    trace.status = status
    if (outcome) {
      trace.outcome = outcome
    }

    this.persistTrace(trace)
  }

  updateTrace(traceId: string, updates: { related_task_id?: string }): void {
    const trace = this.traces.get(traceId)
    if (!trace) return
    if (updates.related_task_id !== undefined) {
      trace.related_task_id = updates.related_task_id
      if (updates.related_task_id) {
        const existing = this.taskIndex.get(updates.related_task_id) ?? []
        if (!existing.includes(traceId)) {
          this.taskIndex.set(updates.related_task_id, [...existing, traceId])
        }
      }
    }
  }

  getTraces(
    limit = 20,
    offset = 0,
    status?: string
  ): { traces: AgentTrace[]; total: number } {
    let all = this.order
      .map((id) => this.traces.get(id)!)
      .filter(Boolean)
      .reverse() // 最新的在前

    if (status) {
      all = all.filter((t) => t.status === status)
    }

    const total = all.length
    const traces = all.slice(offset, offset + Math.min(limit, 100))
    return { traces, total }
  }

  getTrace(traceId: string): AgentTrace | undefined {
    return this.traces.get(traceId)
  }

  clearTraces(before?: string, traceIds?: string[]): number {
    let count = 0

    if (traceIds && traceIds.length > 0) {
      for (const id of traceIds) {
        if (this.traces.has(id)) {
          this.traces.delete(id)
          const idx = this.order.indexOf(id)
          if (idx !== -1) this.order.splice(idx, 1)
          count++
        }
      }
      return count
    }

    if (before) {
      const beforeTime = new Date(before).getTime()
      const toDelete = this.order.filter((id) => {
        const trace = this.traces.get(id)
        return trace && new Date(trace.started_at).getTime() < beforeTime
      })
      for (const id of toDelete) {
        this.traces.delete(id)
        const idx = this.order.indexOf(id)
        if (idx !== -1) this.order.splice(idx, 1)
        count++
      }
      return count
    }

    // 清空全部
    count = this.traces.size
    this.traces.clear()
    this.order = []
    return count
  }

  private persistTrace(trace: AgentTrace): void {
    if (!this.persistDir) return
    try {
      const date = trace.started_at.slice(0, 10)
      const file = `traces-${date}.jsonl`
      const filePath = path.join(this.persistDir, file)
      const line = JSON.stringify(trace) + '\n'

      let fileOffset = 0
      try { fileOffset = fs.statSync(filePath).size } catch { /* new file */ }

      fs.appendFileSync(filePath, line, 'utf-8')

      const entry: TraceIndexEntry = {
        trace_id: trace.trace_id,
        related_task_id: trace.related_task_id,
        parent_trace_id: trace.parent_trace_id,
        trigger_type: trace.trigger.type,
        trigger_summary: trace.trigger.summary,
        started_at: trace.started_at,
        ended_at: trace.ended_at,
        status: trace.status,
        outcome_summary: trace.outcome?.summary,
        span_count: trace.spans.length,
        file,
        file_offset: fileOffset,
      }
      this.traceIndex.push(entry)
      if (trace.related_task_id) {
        const existing = this.taskIndex.get(trace.related_task_id) ?? []
        this.taskIndex.set(trace.related_task_id, [...existing, trace.trace_id])
      }
    } catch {
      // persist failure must not affect main flow
    }
  }
}
