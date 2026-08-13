/**
 * TraceStore - Agent 执行 Trace 的 Ring Buffer 存储
 *
 * @see crabot-docs/protocols/protocol-agent-v2.md §8
 */

import * as fs from 'fs'
import * as path from 'path'
import type { AgentTrace, AgentSpan, AgentSpanType, AgentSpanDetails, TokenUsage } from '../types.js'
import { aggregateUsage } from './trace-usage.js'
import {
  isValidManagerEpisodeTrace,
  parseTraceRecordLine,
  wrapManagerEpisodeRecord,
  type ManagerEpisodeSpan,
  type ManagerEpisodeTrace,
  type ManagerEpisodeTrigger,
  type ManagerEpisodeUsage,
} from '../manager/trace-types.js'
import type { ManagerKey } from '../workers/harness/ledger-types.js'

export interface SpanWithMeta {
  span_id: string
  parent_span_id?: string
  trace_id: string
  type: AgentSpanType
  started_at: string
  ended_at?: string
  duration_ms?: number
  status: 'running' | 'completed' | 'failed'
  details: AgentSpanDetails
  children_count: number
}

export interface TraceTree {
  task_id: string
  tree: {
    fronts: TraceIndexEntry[]
    /** 一个 task 可能有多条 worker run（resume / 崩溃恢复续起时另起新 trace）；全部返回，按时间升序。 */
    workers: TraceIndexEntry[]
    subagents: TraceIndexEntry[]
  }
}

export interface TraceIndexEntry {
  trace_id: string
  related_task_id?: string
  parent_trace_id?: string
  trigger_type: string
  trigger_summary: string
  trigger_task_type?: string
  started_at: string
  ended_at?: string
  duration_ms?: number
  status: 'running' | 'completed' | 'failed'
  outcome_summary?: string
  dispatch_actions?: Array<{
    kind?: string
    outcome?: string
    target_task_id?: string
    spawned_trace_id?: string
    target_task_completed_at?: string
  }>
  span_count: number
  /** 全 trace 的 token 用量汇总（持久化时聚合，rebuild 时按 spans 重算） */
  total_usage?: TokenUsage
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

  // ── Manager episode traces（protocol-agent-v3 §8.4）────────────────
  // 与 legacy AgentTrace 完全分离：独立 in-memory map + per-manager 索引；
  // 持久化行带 kind discriminator（无 kind 的历史行仍按 legacy 读取）；
  // 不进入 legacy taskIndex/TraceTree，legacy search/getFullTrace 不可见。
  private managerEpisodes: Map<string, ManagerEpisodeTrace> = new Map()
  private managerIndex: Map<string, string[]> = new Map()
  private managerBadRecordCount = 0

  // ── In-flight 定时持久化 ────────────────────────────────
  // status='running' 的 trace 只在 endTrace 时才追加到按日期切片的 archive 文件。
  // 但 agent 被 SIGKILL（health 失败 / OOM / 外部强杀）时根本没机会 endTrace，
  // 整条主 task trace 连带所有 span 永久丢失 —— admin UI 上只能看到已结束的
  // sub-agent / dispatch trace，看不到死前主 loop 在做啥。
  //
  // 解决：定时把所有 in-flight trace 全量覆盖写到独立文件 traces-running.jsonl。
  // 覆盖式（writeFileSync + rename atomic 替换），文件大小有界。
  // 进程重启后 rebuildIndex 把上次 running 的 trace 重新加载到 this.traces，
  // searchTraces 的现有合并逻辑（line 107-112）能直接展示出来。
  private flushTimer?: ReturnType<typeof setInterval>
  private readonly runningFlushFile: string
  private readonly archiveFilePrefix: string
  private readonly readableArchiveFilePrefixes: readonly string[]

  // ── Worker checkpoint resume 集合 ──────────────────────
  // flushWorkerCheckpoint 把 worker trace（含 resume_checkpoint）原子写到
  // traces-running-<taskId>.jsonl。启动时 loadResumableCheckpoints 把这些文件
  // 读进此 Map，等 admin 裁决（HOLD，不立即标 failed）。
  private resumableCheckpoints = new Map<string, { traceId: string; checkpoint: import('../types.js').ResumeCheckpoint }>()

  constructor(
    maxSize = 100,
    persistDir?: string,
    runningFlushFile = 'traces-running.jsonl',
    archiveFilePrefix = 'traces-',
    readableArchiveFilePrefixes: readonly string[] = [archiveFilePrefix],
  ) {
    this.maxSize = maxSize
    this.persistDir = persistDir
    this.runningFlushFile = runningFlushFile
    this.archiveFilePrefix = archiveFilePrefix
    this.readableArchiveFilePrefixes = readableArchiveFilePrefixes
    if (persistDir) {
      fs.mkdirSync(persistDir, { recursive: true })
      this.rebuildIndex()
      this.loadResumableCheckpoints()
      this.loadRunningTraces()
    }
  }

  /**
   * 启动 in-flight trace 的定时全量 flush。caller（UnifiedAgent.onStart）调一次。
   * intervalMs 太短会增加 IO，太长会让"死前的最后状态"丢得多；默认 15s 是经验值。
   */
  startFlushTimer(intervalMs = 15_000): void {
    if (this.flushTimer || !this.persistDir) return
    this.flushTimer = setInterval(() => {
      try {
        this.flushInFlightTraces()
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.warn(`[TraceStore] flushInFlightTraces failed: ${msg}`)
      }
    }, intervalMs)
    this.flushTimer.unref?.()
  }

  stopFlushTimer(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer)
      this.flushTimer = undefined
    }
  }

  private static runningCheckpointFile(taskId: string): string {
    return `traces-running-${taskId}.jsonl`
  }

  /**
   * 把某 worker trace（含 resume_checkpoint）原子写到 per-task running 文件。
   * per-turn 调用；tmp+rename 保证崩在写一半时留下上一份完整旧快照。
   */
  flushWorkerCheckpoint(taskId: string, traceId: string, checkpoint: import('../types.js').ResumeCheckpoint): void {
    if (!this.persistDir) return
    const trace = this.traces.get(traceId)
    if (!trace) return
    trace.resume_checkpoint = checkpoint
    const finalPath = path.join(this.persistDir, TraceStore.runningCheckpointFile(taskId))
    const tmpPath = finalPath + '.tmp'
    fs.writeFileSync(tmpPath, JSON.stringify(trace) + '\n', 'utf-8')
    fs.renameSync(tmpPath, finalPath)
  }

  getResumableCheckpoint(taskId: string): { traceId: string; checkpoint: import('../types.js').ResumeCheckpoint } | undefined {
    return this.resumableCheckpoints.get(taskId)
  }

  /**
   * Recent terminal supplement 用：按 task_id 找最近一条已落盘/内存中的 worker trace checkpoint。
   * 这和 resumableCheckpoints 不同；后者只代表 agent 重启时遗留的 in-flight checkpoint。
   */
  findLatestResumeCheckpointByTaskId(taskId: string): { traceId: string; checkpoint: import('../types.js').ResumeCheckpoint } | undefined {
    let latest: { traceId: string; checkpoint: import('../types.js').ResumeCheckpoint; timeMs: number } | undefined

    const consider = (trace: AgentTrace | undefined) => {
      if (!trace) return
      if (trace.related_task_id !== taskId) return
      if (trace.trigger.type !== 'task') return
      if (!trace.resume_checkpoint) return
      const timeMs = new Date(trace.ended_at ?? trace.started_at).getTime()
      if (!Number.isFinite(timeMs)) return
      if (!latest || timeMs > latest.timeMs) {
        latest = { traceId: trace.trace_id, checkpoint: trace.resume_checkpoint, timeMs }
      }
    }

    for (const trace of this.traces.values()) {
      consider(trace)
    }

    const traceIds = this.taskIndex.get(taskId) ?? []
    for (const traceId of traceIds) {
      if (this.traces.has(traceId)) continue
      consider(this.readTraceFromIndex(traceId))
    }

    return latest ? { traceId: latest.traceId, checkpoint: latest.checkpoint } : undefined
  }

  /** 当前持有的所有可 resume checkpoint 的 taskId（admin 对账孤儿用）。 */
  getResumableTaskIds(): string[] {
    return Array.from(this.resumableCheckpoints.keys())
  }

  /**
   * worker loop 终结（completed/failed）时调用：删 per-task running 文件 + 移除可 resume 集合项。
   * **不** finalize/改任何 trace（trace 由 handleExecuteTask 的 endTrace 正常收尾）。
   *
   * 关键：不在 worker 结束时删这个文件，已完成任务的 checkpoint 就成孤儿——下次重启
   * loadResumableCheckpoints 把它（文件里 status 仍是 running）当 in-flight 载入，orphan
   * 对账再把这条**已完成**的 trace 误标 failed。
   */
  clearCheckpointFile(taskId: string): void {
    this.resumableCheckpoints.delete(taskId)
    if (!this.persistDir) return
    const file = path.join(this.persistDir, TraceStore.runningCheckpointFile(taskId))
    try { if (fs.existsSync(file)) fs.unlinkSync(file) } catch { /* best effort */ }
  }

  /** resume 接管成功后调用：finalize 旧（重启前）trace + 从集合移除 + 删 per-task 文件。 */
  consumeResumableCheckpoint(taskId: string): void {
    // finalize 旧 trace（loadResumableCheckpoints 载入、loadRunningTraces 跳过留下的、status=running）。
    // 不 finalize 它就会成「永远 running」的幽灵 trace，在 UI 上误显示成「当前」。resumed run
    // 用的是另起的新 trace，旧 trace 在此定格为「已被 resume 接管」。
    const entry = this.resumableCheckpoints.get(taskId)
    if (entry) {
      const trace = this.traces.get(entry.traceId)
      if (trace && trace.status === 'running') {
        const now = new Date()
        trace.status = 'completed'
        trace.ended_at = now.toISOString()
        trace.duration_ms = now.getTime() - new Date(trace.started_at).getTime()
        trace.outcome = { summary: '[已被 resume 接管，见新 trace]' }
        this.persistTrace(trace)
      }
    }
    this.resumableCheckpoints.delete(taskId)
    if (!this.persistDir) return
    const file = path.join(this.persistDir, TraceStore.runningCheckpointFile(taskId))
    try { if (fs.existsSync(file)) fs.unlinkSync(file) } catch { /* best effort */ }
  }

  /**
   * resume **续写**模式：复用重启/恢复前那条 trace（loadResumableCheckpoints 已把它连 spans
   * 一起载入 this.traces，status 仍 running），让一个 task 跨重启是**一条连续 trace**，而非每个
   * run 一条。从 resumableCheckpoints 摘除（已被续写接管，不再当可 resume 的孤儿）；**不** finalize
   * 旧 trace——resumed run 的 span 直接往它上追加，由 handleExecuteTask 的 endTrace 正常收尾。
   * per-task running 文件不在此删：续写期间每轮 flushWorkerCheckpoint 仍覆盖它，最终由
   * cleanupWorkerLoopResources 的 clearCheckpointFile 清掉。
   *
   * 返回被复用的 trace；若不存在（罕见边界）返回 null，调用方回退到 startTrace 新建。
   */
  reactivateResumableTrace(taskId: string): import('../types.js').AgentTrace | null {
    const entry = this.resumableCheckpoints.get(taskId)
    if (!entry) return null
    const trace = this.traces.get(entry.traceId)
    if (!trace) return null
    this.resumableCheckpoints.delete(taskId)
    return trace
  }

  /**
   * Terminal supplement resume 用：从已完成的历史 worker trace 继续追加 spans。
   * 与 reactivateResumableTrace 不同，这里的 checkpoint 来自已落盘 trace.resume_checkpoint，
   * 不在 resumableCheckpoints 集合里。
   */
  reactivateTraceById(traceId: string): import('../types.js').AgentTrace | null {
    const trace = this.traces.get(traceId) ?? this.readTraceFromIndex(traceId)
    if (!trace) return null
    trace.status = 'running'
    trace.ended_at = undefined
    trace.duration_ms = undefined
    trace.outcome = undefined
    this.traces.set(trace.trace_id, trace)
    if (!this.order.includes(trace.trace_id)) this.order.push(trace.trace_id)
    this.refreshTraceIndexFromMemory(trace)
    return trace
  }

  /** admin 放弃 resume 时调用：finalize 成 failed 落日期文件 + 清 running 文件。 */
  finalizeUnresumedCheckpoint(taskId: string): void {
    const entry = this.resumableCheckpoints.get(taskId)
    if (entry) {
      const trace = this.traces.get(entry.traceId)
      if (trace && trace.status === 'running') {
        const now = new Date()
        trace.status = 'failed'
        trace.ended_at = now.toISOString()
        trace.outcome = { summary: '[interrupted: agent restarted, not resumed]' }
        this.persistTrace(trace)
      }
    }
    this.consumeResumableCheckpoint(taskId)
  }

  /**
   * 启动时把 per-task running 文件（traces-running-<taskId>.jsonl）读进
   * resumableCheckpoints 集合。不修改文件、不写日期文件——等 admin 裁决。
   */
  private loadResumableCheckpoints(): void {
    if (!this.persistDir) return
    const files = fs.readdirSync(this.persistDir)
      .filter(f => f !== this.runningFlushFile && f.startsWith('traces-running-') && f.endsWith('.jsonl'))
    for (const file of files) {
      const taskId = file.slice('traces-running-'.length, -'.jsonl'.length)
      try {
        const content = fs.readFileSync(path.join(this.persistDir, file), 'utf-8').trim()
        if (!content) continue
        const trace = JSON.parse(content) as import('../types.js').AgentTrace
        if (!trace.resume_checkpoint) continue
        this.resumableCheckpoints.set(taskId, { traceId: trace.trace_id, checkpoint: trace.resume_checkpoint })
        this.traces.set(trace.trace_id, trace)
        if (!this.order.includes(trace.trace_id)) this.order.push(trace.trace_id)
        this.refreshTraceIndexFromMemory(trace)
      } catch { /* skip malformed */ }
    }
  }

  /**
   * 全量重写当前实例的 in-flight 文件（默认兼容旧 traces-running.jsonl）。
   * 用 tmp + rename 实现 atomic 替换：进程在写中间被杀，旧文件保持完好。
   */
  private flushInFlightTraces(): void {
    if (!this.persistDir) return
    const lines: string[] = []
    for (const trace of this.traces.values()) {
      if (trace.status === 'running') {
        lines.push(JSON.stringify(trace))
      }
    }
    for (const episode of this.managerEpisodes.values()) {
      if (episode.status === 'running') {
        lines.push(JSON.stringify(wrapManagerEpisodeRecord(episode)))
      }
    }
    const content = lines.length > 0 ? lines.join('\n') + '\n' : ''
    const finalPath = path.join(this.persistDir, this.runningFlushFile)
    const tmpPath = finalPath + '.tmp'
    fs.writeFileSync(tmpPath, content, 'utf-8')
    fs.renameSync(tmpPath, finalPath)
  }

  /**
   * 启动时加载当前实例的 in-flight 文件（默认为 traces-running.jsonl）。
   * 把这些 trace 标记为 failed（interrupted），写入日期文件，然后清空 running 文件。
   */
  private loadRunningTraces(): void {
    if (!this.persistDir) return
    const filePath = path.join(this.persistDir, this.runningFlushFile)
    if (!fs.existsSync(filePath)) return
    try {
      // 已被 loadResumableCheckpoints 持有的 worker trace（per-task checkpoint 文件）——它在
      // 等 admin 的 resume 裁决，绝不能在这里被旧的全量加载路径标 failed：否则 UI 显示
      // FAILED + `[interrupted: agent restarted]`，且 reconciliation 看到 trace=failed 会把
      // 对应 task 也误标 failed，resume 还没开始就被判死。
      const resumableTraceIds = new Set(
        Array.from(this.resumableCheckpoints.values()).map((e) => e.traceId),
      )
      const content = fs.readFileSync(filePath, 'utf-8')
      for (const line of content.split('\n')) {
        if (!line.trim()) continue
        const record = parseTraceRecordLine(line)
        if (record && record.kind === 'manager_episode') {
          // manager episode 以 running 形态载入；收口由 reconcileInterruptedManagerEpisodes
          // 在开放 read model 前统一执行（不在加载路径上直接判 failed）。
          // running flush 是 span 增量的最新载体（归档只在 start/finish 落行）：
          // 归档版仍是 running 且 running 文件版 span 更多时，以后者为准。
          const existing = this.managerEpisodes.get(record.trace.trace_id)
          if (!existing || (existing.status === 'running' && record.trace.spans.length >= existing.spans.length)) {
            this.loadManagerEpisode(record.trace)
          }
          continue
        }
        if (record && record.kind === 'legacy_agent_trace') {
          try {
          const trace = record.trace as AgentTrace
          // 已经 endTrace 过的（rebuildIndex 已读到）跳过
          if (this.traceIndex.some(e => e.trace_id === trace.trace_id)) continue
          // 正在等 resume 裁决的 worker trace 跳过（见上方注释）
          if (resumableTraceIds.has(trace.trace_id)) continue
          // 标记为 interrupted，写入日期文件让 UI 正确显示
          const now = new Date()
          trace.status = 'failed'
          if (!trace.ended_at) {
            trace.ended_at = now.toISOString()
            trace.duration_ms = now.getTime() - new Date(trace.started_at).getTime()
          }
          if (!trace.outcome) {
            trace.outcome = { summary: '[interrupted: agent restarted]' }
          }
          this.traces.set(trace.trace_id, trace)
          this.persistTrace(trace)
          } catch { /* skip malformed */ }
        }
      }
      // 清空 running 文件——这些 trace 已落到日期文件
      fs.writeFileSync(filePath, '', 'utf-8')
    } catch (err) {
      console.warn(`[TraceStore] loadRunningTraces failed: ${err instanceof Error ? err.message : err}`)
    }
  }

  private rebuildIndex(): void {
    if (!this.persistDir) return
    try {
      // 排除当前实例的覆盖式 in-flight 文件；它没有稳定
      // 字节 offset，不能进 traceIndex（getFullTrace 走 offset 读会乱）。
      // in-flight 由 loadRunningTraces 单独加载到内存 Map。
      const files = fs.readdirSync(this.persistDir)
        .filter((file) => this.readableArchiveFilePrefixes.some((prefix) => this.archiveDate(file, prefix) !== undefined))
        .sort()

      for (const file of files) {
        const filePath = path.join(this.persistDir, file)
        const content = fs.readFileSync(filePath, 'utf-8')
        let offset = 0
        for (const line of content.split('\n')) {
          const lineBytes = Buffer.byteLength(line + '\n', 'utf-8')
          if (!line.trim()) { offset += lineBytes; continue }
          const record = parseTraceRecordLine(line)
          if (record === null) {
            if (line.includes('"kind"')) {
              // 带 kind 但解析失败：新格式 record 坏行隔离并报告，不拖垮 legacy index。
              this.managerBadRecordCount += 1
              if (this.managerBadRecordCount <= 5 || this.managerBadRecordCount % 100 === 0) {
                console.warn(`[TraceStore] skipped malformed trace record (count=${this.managerBadRecordCount}) in ${file}`)
              }
            }
            offset += lineBytes
            continue
          }
          if (record.kind === 'manager_episode') {
            this.loadManagerEpisode(record.trace)
            offset += lineBytes
            continue
          }
          const trace = record.trace as AgentTrace
          const entry = this.traceToIndexEntry(trace, file, offset)
          // 同一 trace_id 可能多次写入（endTrace + appendTraceOutcome），保留最新 offset
          const existingIdx = this.traceIndex.findIndex(e => e.trace_id === trace.trace_id)
          if (existingIdx !== -1) {
            this.traceIndex[existingIdx] = entry
          } else {
            this.traceIndex.push(entry)
          }
          if (trace.related_task_id) {
            this.addToTaskIndex(trace.related_task_id, trace.trace_id)
          }
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
        results.push(this.traceToIndexEntry(trace, '', 0))
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
    const limit = Math.min(params.limit ?? 20, 1000)
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
      /** Back-date from post-hoc callbacks (e.g. agent-handler onTurn fires
       * after LLM + tools complete). Defaults to Date.now(). */
      started_at_ms?: number
    }
  ): AgentSpan {
    const startedAtMs = params.started_at_ms ?? Date.now()
    const span: AgentSpan = {
      span_id: crypto.randomUUID(),
      parent_span_id: params.parent_span_id,
      trace_id: traceId,
      type: params.type,
      started_at: new Date(startedAtMs).toISOString(),
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
    detailsUpdate?: Partial<AgentSpanDetails>,
    /** Back-date from post-hoc callbacks. Defaults to Date.now(). */
    endedAtMs?: number,
  ): void {
    const trace = this.traces.get(traceId)
    if (!trace) return

    const span = trace.spans.find((s) => s.span_id === spanId)
    if (!span) return

    const resolvedEndedAtMs = endedAtMs ?? Date.now()
    span.ended_at = new Date(resolvedEndedAtMs).toISOString()
    span.duration_ms = resolvedEndedAtMs - new Date(span.started_at).getTime()
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
    const totalUsage = aggregateUsage(trace.spans)
    if (totalUsage) {
      trace.total_usage = totalUsage
    }

    this.persistTrace(trace)
  }

  /**
   * Patch trace 顶层 outcome，不动 status / ended_at / duration_ms。
   *
   * 跟 endTrace 区别：endTrace 是 status-changing 操作（重置时间戳），
   * 适合 trace 终结那一刻调用；appendTraceOutcome 是事后 patch 工具，
   * 适合 trace 已 endTrace 后再补充关键 metadata 的场景（如 runGoalAudit
   * 拿到 audit verdict 后回写 audit trace summary）。
   *
   * Spec: 2026-05-26-goal-audit-loop-completion §2.1.1
   */
  appendTraceOutcome(traceId: string, partial: Partial<NonNullable<AgentTrace['outcome']>>): void {
    const trace = this.traces.get(traceId)
    if (!trace) return
    trace.outcome = { summary: '', ...(trace.outcome ?? {}), ...partial }
    this.persistTrace(trace)
  }

  updateTrace(traceId: string, updates: { related_task_id?: string }): void {
    const trace = this.traces.get(traceId)
    if (!trace) return
    if (updates.related_task_id !== undefined) {
      trace.related_task_id = updates.related_task_id
      if (updates.related_task_id) {
        this.addToTaskIndex(updates.related_task_id, traceId)
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

  private readTraceFromIndex(traceId: string): AgentTrace | undefined {
    const indexEntry = this.traceIndex.find(e => e.trace_id === traceId)
    if (!indexEntry || !this.persistDir || !indexEntry.file) return undefined

    try {
      const filePath = path.join(this.persistDir, indexEntry.file)
      const fd = fs.openSync(filePath, 'r')
      try {
        const CHUNK = 64 * 1024
        const buf = Buffer.allocUnsafe(CHUNK)
        const chunks: string[] = []
        let position = indexEntry.file_offset

        while (true) {
          const bytesRead = fs.readSync(fd, buf, 0, CHUNK, position)
          if (bytesRead === 0) break
          const slice = buf.toString('utf-8', 0, bytesRead)
          const nlIdx = slice.indexOf('\n')
          if (nlIdx >= 0) {
            chunks.push(slice.slice(0, nlIdx))
            break
          }
          chunks.push(slice)
          position += bytesRead
        }

        const line = chunks.join('')
        if (!line) return undefined
        return JSON.parse(line) as AgentTrace
      } finally {
        fs.closeSync(fd)
      }
    } catch {
      return undefined
    }
  }

  async getFullTrace(traceId: string): Promise<AgentTrace | undefined> {
    // 1. 先查 ring buffer
    const cached = this.traces.get(traceId)
    if (cached) return cached

    // 2. 从 JSONL 按需读取——分块循环读直到遇到换行符（容纳任意大小 trace；
    //    历史 bug：固定 64KB buffer 会把 spans 较多的 trace 截断 → JSON parse 失败 → 404）
    return this.readTraceFromIndex(traceId)
  }

  getSpansAtDepth(
    traceId: string,
    params: { parent_span_id?: string }
  ): { spans: SpanWithMeta[]; span_total: number } {
    const trace = this.traces.get(traceId)
    if (!trace) return { spans: [], span_total: 0 }

    const allSpans = trace.spans

    // Build children count map in O(n) instead of O(n²)
    const childrenCount = new Map<string, number>()
    for (const s of allSpans) {
      if (s.parent_span_id) {
        childrenCount.set(s.parent_span_id, (childrenCount.get(s.parent_span_id) ?? 0) + 1)
      }
    }

    const targetSpans = params.parent_span_id
      ? allSpans.filter(s => s.parent_span_id === params.parent_span_id)
      : allSpans.filter(s => !s.parent_span_id)

    const result: SpanWithMeta[] = targetSpans.map(span => ({
      span_id: span.span_id,
      parent_span_id: span.parent_span_id,
      trace_id: span.trace_id,
      type: span.type,
      started_at: span.started_at,
      ended_at: span.ended_at,
      duration_ms: span.duration_ms,
      status: span.status,
      details: span.details,
      children_count: childrenCount.get(span.span_id) ?? 0,
    }))

    return { spans: result, span_total: result.length }
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

  getTraceTree(taskId: string): TraceTree {
    const traces: TraceIndexEntry[] = []
    let offset = 0
    while (true) {
      const page = this.searchTraces({ task_id: taskId, limit: 1000, offset })
      traces.push(...page.traces)
      offset += page.traces.length
      if (offset >= page.total || page.traces.length === 0) break
    }

    const fronts: TraceIndexEntry[] = []
    const workers: TraceIndexEntry[] = []
    const subagents: TraceIndexEntry[] = []

    for (const t of traces) {
      switch (t.trigger_type) {
        case 'message':
          fronts.push(t)
          break
        case 'task':
          // 一个 task 可能有多条 worker trace（resume / 崩溃恢复续起时，旧 run 的 trace 被接管、
          // 另起新 trace）。**全部收集**——否则触发动作（如重启前调 request_restart 那条 run）在
          // UI 上整个消失，只剩 resume 后的 run，看着像没执行。按 started_at 升序展示完整执行链。
          workers.push(t)
          break
        case 'sub_agent_call':
          subagents.push(t)
          break
        default:
          fronts.push(t)
      }
    }
    workers.sort((a, b) => new Date(a.started_at).getTime() - new Date(b.started_at).getTime())

    return { task_id: taskId, tree: { fronts, workers, subagents } }
  }

  getDiskUsage(): {
    total_bytes: number
    trace_count: number
    oldest_iso?: string
    newest_iso?: string
  } {
    if (!this.persistDir || !fs.existsSync(this.persistDir)) {
      return { total_bytes: 0, trace_count: 0 }
    }
    let totalBytes = 0
    try {
      const files = fs.readdirSync(this.persistDir)
        .filter(f => f.startsWith('traces-') && f.endsWith('.jsonl') && f !== this.runningFlushFile && f !== 'traces-running.jsonl' && !f.startsWith('traces-running-'))
      for (const file of files) {
        const stat = fs.statSync(path.join(this.persistDir, file))
        totalBytes += stat.size
      }
    } catch (err) {
      console.warn('[TraceStore] getDiskUsage failed:', err instanceof Error ? err.message : err)
    }
    const traceCount = this.traceIndex.length
    let oldestIso: string | undefined
    let newestIso: string | undefined
    if (traceCount > 0) {
      let oldest = Infinity
      let newest = -Infinity
      for (const e of this.traceIndex) {
        const t = new Date(e.started_at).getTime()
        if (Number.isFinite(t)) {
          if (t < oldest) oldest = t
          if (t > newest) newest = t
        }
      }
      if (Number.isFinite(oldest)) oldestIso = new Date(oldest).toISOString()
      if (Number.isFinite(newest)) newestIso = new Date(newest).toISOString()
    }
    return {
      total_bytes: totalBytes,
      trace_count: traceCount,
      ...(oldestIso ? { oldest_iso: oldestIso } : {}),
      ...(newestIso ? { newest_iso: newestIso } : {}),
    }
  }

  /**
   * 按日级粒度清理当前实例的 archive 文件：找 `<archiveFilePrefix><date>.jsonl` 中
   * date < (today - retentionDays) 的整个文件删除。其他可读前缀只用于兼容查询，不参与清理。
   * dryRun=true 时只返回统计不实删。
   */
  cleanupOldTraces(retentionDays: number, dryRun: boolean): {
    affected_count: number
    affected_bytes: number
    deleted_trace_ids: string[]
  } {
    if (!this.persistDir || !Number.isFinite(retentionDays) || retentionDays < 1 || !fs.existsSync(this.persistDir)) {
      return { affected_count: 0, affected_bytes: 0, deleted_trace_ids: [] }
    }
    const cutoff = new Date()
    cutoff.setDate(cutoff.getDate() - retentionDays)
    const cutoffStr = cutoff.toISOString().slice(0, 10)
    return this.cleanupTracesBeforeDate(cutoffStr, dryRun)
  }

  /**
   * 按条数清理：保留最近 maxCount 条 trace，多余的按文件粒度近似删除。
   *
   * 由于持久化以按天切片的 archive 文件保存，无法精确删除"超出 N 条的尾巴"，
   * 这里按 traceIndex 时间倒序找第 N 条对应的日期，严格更老的整文件删。
   * 同一天文件不切割：实际保留条数 ≥ maxCount。
   */
  cleanupOldTracesByCount(maxCount: number, dryRun: boolean): {
    affected_count: number
    affected_bytes: number
    deleted_trace_ids: string[]
  } {
    if (!this.persistDir || !Number.isFinite(maxCount) || maxCount < 1 || !fs.existsSync(this.persistDir)) {
      return { affected_count: 0, affected_bytes: 0, deleted_trace_ids: [] }
    }
    const ownEntries = this.traceIndex.filter((entry) => this.archiveDate(entry.file) !== undefined)
    if (ownEntries.length <= maxCount) {
      return { affected_count: 0, affected_bytes: 0, deleted_trace_ids: [] }
    }
    // 时间倒序：第 maxCount 条（1-indexed）是要保留的最后一条；它所在日期及更新的整体保留
    const sortedDesc = [...ownEntries].sort(
      (a, b) => new Date(b.started_at).getTime() - new Date(a.started_at).getTime()
    )
    const boundary = sortedDesc[maxCount - 1]
    const keepDateStr = this.extractDateFromFile(boundary.file)
    if (!keepDateStr) {
      return { affected_count: 0, affected_bytes: 0, deleted_trace_ids: [] }
    }
    return this.cleanupTracesBeforeDate(keepDateStr, dryRun)
  }

  private extractDateFromFile(file: string): string | null {
    return this.archiveDate(file) ?? null
  }

  private archiveDate(file: string, prefix = this.archiveFilePrefix): string | undefined {
    if (!file.startsWith(prefix) || !file.endsWith('.jsonl')) return undefined
    const date = file.slice(prefix.length, -'.jsonl'.length)
    return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : undefined
  }

  /**
   * 删除 dateStr 严格小于 cutoffStr 的当前实例 archive 文件。
   * 其他 readable archive 前缀（如只读 legacy traces）不会被删除。
   */
  private cleanupTracesBeforeDate(cutoffStr: string, dryRun: boolean): {
    affected_count: number
    affected_bytes: number
    deleted_trace_ids: string[]
  } {
    if (!this.persistDir) {
      return { affected_count: 0, affected_bytes: 0, deleted_trace_ids: [] }
    }
    let affectedTraces = 0
    let affectedBytes = 0
    const deletedIds: string[] = []
    const toDelete: string[] = []

    try {
      const files = fs.readdirSync(this.persistDir)
        .filter((file) => this.archiveDate(file) !== undefined)
      for (const file of files) {
        const dateStr = this.archiveDate(file)
        if (!dateStr || dateStr >= cutoffStr) continue
        const filePath = path.join(this.persistDir, file)
        const stat = fs.statSync(filePath)
        affectedBytes += stat.size
        const content = fs.readFileSync(filePath, 'utf-8')
        const ids: string[] = []
        for (const line of content.split('\n')) {
          if (!line.trim()) continue
          const record = parseTraceRecordLine(line)
          if (record && record.trace.trace_id) ids.push(record.trace.trace_id)
        }
        affectedTraces += ids.length
        if (!dryRun) {
          deletedIds.push(...ids)
          toDelete.push(file)
        }
      }
      if (!dryRun) {
        for (const file of toDelete) {
          try {
            fs.unlinkSync(path.join(this.persistDir, file))
            this.traceIndex = this.traceIndex.filter(e => e.file !== file)
            this.dropManagerEpisodesForDeletedFile(file)
          } catch (err) {
            console.warn(`[TraceStore] cleanupTracesBeforeDate delete failed for ${file}:`, err instanceof Error ? err.message : err)
          }
        }
        if (toDelete.length > 0) {
          this.rebuildTaskIndex()
        }
      }
    } catch (err) {
      console.warn('[TraceStore] cleanupTracesBeforeDate failed:', err instanceof Error ? err.message : err)
    }

    return {
      affected_count: affectedTraces,
      affected_bytes: affectedBytes,
      deleted_trace_ids: deletedIds,
    }
  }

  /**
   * @deprecated 用 cleanupOldTraces 替代；保留是为了不破坏现有调用方。
   * 返回被删文件数（估算：通过会被清理的文件数预计算）。
   */
  cleanupOldFiles(retentionDays: number): number {
    if (!this.persistDir || !Number.isFinite(retentionDays) || retentionDays < 1 || !fs.existsSync(this.persistDir)) return 0
    const cutoff = new Date()
    cutoff.setDate(cutoff.getDate() - retentionDays)
    const cutoffStr = cutoff.toISOString().slice(0, 10)
    let fileCount = 0
    try {
      const files = fs.readdirSync(this.persistDir)
        .filter((file) => this.archiveDate(file) !== undefined)
      fileCount = files.filter((file) => (this.archiveDate(file) ?? '') < cutoffStr).length
    } catch { /* best effort */ }
    this.cleanupOldTraces(retentionDays, false)
    return fileCount
  }

  private addToTaskIndex(taskId: string, traceId: string): void {
    const existing = this.taskIndex.get(taskId) ?? []
    if (!existing.includes(traceId)) {
      this.taskIndex.set(taskId, [...existing, traceId])
    }
  }

  private refreshTraceIndexFromMemory(trace: AgentTrace): void {
    const existingIdx = this.traceIndex.findIndex(e => e.trace_id === trace.trace_id)
    const existing = existingIdx >= 0 ? this.traceIndex[existingIdx] : undefined
    const nextEntry = this.traceToIndexEntry(trace, existing?.file ?? '', existing?.file_offset ?? 0)
    if (existingIdx >= 0) this.traceIndex[existingIdx] = nextEntry
    else this.traceIndex.push(nextEntry)
    if (trace.related_task_id) this.addToTaskIndex(trace.related_task_id, trace.trace_id)
  }

  private traceToIndexEntry(trace: AgentTrace, file: string, fileOffset: number): TraceIndexEntry {
    // total_usage 优先取持久化时计算的值（endTrace 已回填）；rebuild 时若缺失则按 spans 重算。
    const totalUsage = trace.total_usage ?? aggregateUsage(trace.spans ?? [])
    const dispatchActions = extractDispatchActions(trace.spans ?? [])
    return {
      trace_id: trace.trace_id,
      related_task_id: trace.related_task_id,
      parent_trace_id: trace.parent_trace_id,
      trigger_type: trace.trigger.type,
      trigger_summary: trace.trigger.summary,
      trigger_task_type: trace.trigger.task_type,
      started_at: trace.started_at,
      ended_at: trace.ended_at,
      duration_ms: trace.duration_ms,
      status: trace.status,
      outcome_summary: trace.outcome?.summary,
      ...(dispatchActions.length > 0 ? { dispatch_actions: dispatchActions } : {}),
      span_count: trace.spans?.length ?? 0,
      ...(totalUsage ? { total_usage: totalUsage } : {}),
      file,
      file_offset: fileOffset,
    }
  }

  private rebuildTaskIndex(): void {
    this.taskIndex.clear()
    for (const entry of this.traceIndex) {
      if (entry.related_task_id) {
        this.addToTaskIndex(entry.related_task_id, entry.trace_id)
      }
    }
  }

  private persistTrace(trace: AgentTrace): void {
    if (!this.persistDir) return
    try {
      const date = trace.started_at.slice(0, 10)
      const file = `${this.archiveFilePrefix}${date}.jsonl`
      const filePath = path.join(this.persistDir, file)
      const line = JSON.stringify(trace) + '\n'

      let fileOffset = 0
      try { fileOffset = fs.statSync(filePath).size } catch { /* new file */ }

      fs.appendFileSync(filePath, line, 'utf-8')

      // 更新已有 index entry（如 appendTraceOutcome 二次写入），不重复 push
      const newEntry = this.traceToIndexEntry(trace, file, fileOffset)
      const existingIdx = this.traceIndex.findIndex(e => e.trace_id === trace.trace_id)
      if (existingIdx !== -1) {
        this.traceIndex[existingIdx] = newEntry
      } else {
        this.traceIndex.push(newEntry)
      }
      if (trace.related_task_id) {
        this.addToTaskIndex(trace.related_task_id, trace.trace_id)
      }
    } catch (err) {
      // persist failure must not affect main flow
      const msg = err instanceof Error ? err.message : String(err)
      console.warn(`[TraceStore] persistTrace failed for ${trace.trace_id}: ${msg}`)
    }
  }

  // ==========================================================================
  // Manager episode traces（protocol-agent-v3 §8.4）
  // ==========================================================================

  private addToManagerIndex(managerKey: string, traceId: string): void {
    const existing = this.managerIndex.get(managerKey) ?? []
    if (!existing.includes(traceId)) {
      this.managerIndex.set(managerKey, [...existing, traceId])
    }
  }

  /** 加载/覆盖一条 manager record（rebuildIndex / loadRunningTraces 共用；同 id 后写覆盖先写）。 */
  private loadManagerEpisode(episode: ManagerEpisodeTrace): void {
    if (!isValidManagerEpisodeTrace(episode)) {
      this.managerBadRecordCount += 1
      console.warn(`[TraceStore] invalid manager episode record dropped (trace_id=${String((episode as { trace_id?: unknown }).trace_id)})`)
      return
    }
    const previous = this.managerEpisodes.get(episode.trace_id)
    if (previous && previous.manager_key !== episode.manager_key) {
      // manager_key 不一致：fail loud 隔离，不猜归属（plan §7.1 的 key 不一致语义）。
      console.warn(`[TraceStore] manager episode ${episode.trace_id} manager_key changed (${previous.manager_key} -> ${episode.manager_key}); record dropped`)
      this.managerBadRecordCount += 1
      return
    }
    this.managerEpisodes.set(episode.trace_id, episode)
    this.addToManagerIndex(episode.manager_key, episode.trace_id)
  }

  private persistManagerEpisode(episode: ManagerEpisodeTrace, strict: boolean, deferred = false): void {
    if (!this.persistDir) return
    // deferred=true（span/worker 增量）：纯内存更新，不写盘——15s flush 定时器已覆盖
    // in-flight 快照，归档只在 start/finish 各落一行。每个 span 都同步写盘会把 manager
    // loop 的热路径压在阻塞 I/O 上，且等于把 O(n²) 搬到另一个文件。
    if (deferred) return
    try {
      const date = episode.started_at.slice(0, 10)
      const file = `${this.archiveFilePrefix}${date}.jsonl`
      const filePath = path.join(this.persistDir, file)
      fs.appendFileSync(filePath, JSON.stringify(wrapManagerEpisodeRecord(episode)) + '\n', 'utf-8')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (strict) throw new Error(`[TraceStore] manager episode persistence failed for ${episode.trace_id}: ${msg}`)
      console.warn(`[TraceStore] persistManagerEpisode failed for ${episode.trace_id}: ${msg}`)
    }
  }

  /**
   * 创建 running manager episode 并同步持久化。这是 episode admission：
   * 持久化失败必须 throw——调用方（ManagerLoop）不得继续调用 LLM/tool，
   * 原 wake 保持未结算走失败重投语义。
   */
  startManagerEpisode(traceId: string, managerKey: ManagerKey, trigger: ManagerEpisodeTrigger): void {
    if (this.managerEpisodes.has(traceId)) throw new Error(`[TraceStore] duplicate manager episode ${traceId}`)
    const episode: ManagerEpisodeTrace = {
      trace_id: traceId,
      manager_key: managerKey,
      started_at: new Date().toISOString(),
      status: 'running',
      trigger,
      spans: [],
      spawned_worker_ids: [],
    }
    // 先落盘成功才进内存索引（严格路径），保证「disk 可枚举」这一协议不变量。
    this.persistManagerEpisode(episode, true)
    this.managerEpisodes.set(traceId, episode)
    this.addToManagerIndex(managerKey, traceId)
  }

  appendManagerSpan(traceId: string, span: ManagerEpisodeSpan): void {
    const episode = this.managerEpisodes.get(traceId)
    if (!episode) return
    episode.spans.push(span)
    // span 级变更不整份重写归档（否则单 episode 落盘量随 span 数 O(n²)）：
    // running flush 每 15s 全量覆盖 running 文件兜底崩溃现场；start/finish 各落一行。
    this.persistManagerEpisode(episode, false, true)
  }

  finishManagerSpan(traceId: string, spanId: string, patch: { status: 'completed' | 'failed'; ended_at?: string; details?: unknown }): void {
    const episode = this.managerEpisodes.get(traceId)
    if (!episode) return
    const span = episode.spans.find((item) => item.span_id === spanId)
    if (!span || span.status !== 'running') return
    const endedAt = patch.ended_at ?? new Date().toISOString()
    span.status = patch.status
    span.ended_at = endedAt
    span.duration_ms = new Date(endedAt).getTime() - new Date(span.started_at).getTime()
    if (patch.details !== undefined) span.details = patch.details
    this.persistManagerEpisode(episode, false, true)
  }

  addSpawnedWorkerToManagerEpisode(traceId: string, workerId: string): void {
    const episode = this.managerEpisodes.get(traceId)
    if (!episode) return
    if (!episode.spawned_worker_ids.includes(workerId)) {
      episode.spawned_worker_ids.push(workerId)
      this.persistManagerEpisode(episode, false, true)
    }
  }

  /**
   * 原子收口 episode：ended_at/duration/status/outcome/usage/spawned 一次写入。
   * 同一 trace 只收口一次（重复调用幂等 no-op）。span/finish 写失败不影响业务，
   * 只记脱敏诊断（persistManagerEpisode strict=false 已 warn）。
   */
  finishManagerEpisode(
    traceId: string,
    patch: { status: 'completed' | 'failed'; outcome?: { summary: string; error?: string }; total_usage?: ManagerEpisodeUsage },
  ): void {
    const episode = this.managerEpisodes.get(traceId)
    if (!episode || episode.status !== 'running') return
    const endedAt = new Date().toISOString()
    episode.status = patch.status
    episode.ended_at = endedAt
    episode.duration_ms = new Date(endedAt).getTime() - new Date(episode.started_at).getTime()
    if (patch.outcome) episode.outcome = patch.outcome
    if (patch.total_usage) episode.total_usage = patch.total_usage
    // 收尾时把遗留 running span 一并收口，避免永久 running 的僵尸 span。
    for (const span of episode.spans) {
      if (span.status === 'running') {
        span.status = patch.status
        span.ended_at = endedAt
        span.duration_ms = new Date(endedAt).getTime() - new Date(span.started_at).getTime()
      }
    }
    this.persistManagerEpisode(episode, false)
  }

  getManagerEpisode(traceId: string): ManagerEpisodeTrace | undefined {
    return this.managerEpisodes.get(traceId)
  }

  listManagerEpisodes(managerKey: ManagerKey, pagination?: { page?: number; page_size?: number }): {
    items: ManagerEpisodeTrace[]
    pagination: { page: number; page_size: number; total_items: number; total_pages: number }
  } {
    const ids = this.managerIndex.get(managerKey) ?? []
    const matched = ids
      .map((id) => this.managerEpisodes.get(id))
      .filter((episode): episode is ManagerEpisodeTrace => episode !== undefined)
      .sort((left, right) => {
        const byStartedDesc = right.started_at.localeCompare(left.started_at)
        if (byStartedDesc !== 0) return byStartedDesc
        return left.trace_id.localeCompare(right.trace_id)
      })
    const normalizePositive = (value: number | undefined, fallback: number): number => {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) return fallback
      return Math.floor(value)
    }
    const page = normalizePositive(pagination?.page, 1)
    const pageSize = Math.min(normalizePositive(pagination?.page_size, 20), 100)
    const totalItems = matched.length
    const offset = (page - 1) * pageSize
    return {
      items: matched.slice(offset, offset + pageSize),
      pagination: {
        page,
        page_size: pageSize,
        total_items: totalItems,
        total_pages: Math.ceil(totalItems / pageSize),
      },
    }
  }

  countManagerEpisodes(managerKey: ManagerKey): number {
    return this.managerIndex.get(managerKey)?.length ?? 0
  }

  /** TraceStore 中已验证的 manager keys（与 disk session keys 的 union 由 read model 侧完成）。 */
  listTraceManagerKeys(): ManagerKey[] {
    return Array.from(this.managerIndex.keys()) as ManagerKey[]
  }

  /**
   * 启动收口：遗留 running episode 标 failed（outcome 写明 interrupted），保留 spans。
   * 必须在开放 Manager read model 前调用（UnifiedAgent.onStart）。
   */
  reconcileInterruptedManagerEpisodes(): void {
    for (const episode of this.managerEpisodes.values()) {
      if (episode.status !== 'running') continue
      const endedAt = new Date().toISOString()
      episode.status = 'failed'
      episode.ended_at = endedAt
      episode.duration_ms = new Date(endedAt).getTime() - new Date(episode.started_at).getTime()
      episode.outcome = { summary: '[interrupted: agent restarted]' }
      for (const span of episode.spans) {
        if (span.status === 'running') {
          span.status = 'failed'
          span.ended_at = endedAt
          span.duration_ms = new Date(endedAt).getTime() - new Date(span.started_at).getTime()
        }
      }
      this.persistManagerEpisode(episode, false)
    }
  }

  getManagerBadRecordCount(): number {
    return this.managerBadRecordCount
  }

  /**
   * P6-A：窄 trace writer 适配器（ManagerTraceWriter）。所有写盘前的脱敏都在这里收口：
   * redact 由调用方按 knownSecrets 注入（`redactSecrets(text, [...knownSecrets])`）。
   */
  managerTraceWriter(redact: (text: string) => string): import('../manager/trace-types.js').ManagerTraceWriter {
    const redactDetails = (details: unknown): unknown => {
      if (details === undefined) return undefined
      try { return JSON.parse(redact(JSON.stringify(details))) } catch { return '[unserializable details removed]' }
    }
    const redactTrigger = (trigger: ManagerEpisodeTrigger): ManagerEpisodeTrigger => ({
      ...trigger,
      summary: redact(trigger.summary),
      ...(trigger.source ? { source: redact(trigger.source) } : {}),
    })
    return {
      startEpisode: (traceId, managerKey, trigger) => this.startManagerEpisode(traceId, managerKey, redactTrigger(trigger)),
      appendSpan: (traceId, span) => this.appendManagerSpan(traceId, { ...span, details: redactDetails(span.details) }),
      finishSpan: (traceId, spanId, patch) => this.finishManagerSpan(traceId, spanId, {
        ...patch,
        details: patch.details !== undefined ? redactDetails(patch.details) : undefined,
      }),
      finishEpisode: (traceId, patch) => this.finishManagerEpisode(traceId, {
        ...patch,
        ...(patch.outcome ? {
          outcome: {
            summary: redact(patch.outcome.summary),
            ...(patch.outcome.error ? { error: redact(patch.outcome.error) } : {}),
          },
        } : {}),
      }),
      addSpawnedWorker: (traceId, workerId) => this.addSpawnedWorkerToManagerEpisode(traceId, workerId),
    }
  }

  /** cleanupTracesBeforeDate 删除文件后同步剔除 manager 内存条目。 */
  private dropManagerEpisodesForDeletedFile(file: string): void {
    const dateMatch = /(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(file)
    if (!dateMatch) return
    const date = dateMatch[1]
    const dropIds: string[] = []
    for (const episode of this.managerEpisodes.values()) {
      if (episode.started_at.slice(0, 10) === date) dropIds.push(episode.trace_id)
    }
    for (const id of dropIds) {
      const episode = this.managerEpisodes.get(id)
      if (!episode) continue
      this.managerEpisodes.delete(id)
      const list = this.managerIndex.get(episode.manager_key)
      if (list) {
        const filtered = list.filter((item) => item !== id)
        if (filtered.length > 0) this.managerIndex.set(episode.manager_key, filtered)
        else this.managerIndex.delete(episode.manager_key)
      }
    }
  }
}

function extractDispatchActions(spans: AgentSpan[]): NonNullable<TraceIndexEntry['dispatch_actions']> {
  return spans
    .filter((span) => span.type === 'dispatch_action')
    .map((span) => {
      const details = span.details as Record<string, unknown>
      return {
        ...(typeof details.kind === 'string' ? { kind: details.kind } : {}),
        ...(typeof details.outcome === 'string' ? { outcome: details.outcome } : {}),
        ...(typeof details.target_task_id === 'string' ? { target_task_id: details.target_task_id } : {}),
        ...(typeof details.spawned_trace_id === 'string' ? { spawned_trace_id: details.spawned_trace_id } : {}),
        ...(typeof details.target_task_completed_at === 'string' ? { target_task_completed_at: details.target_task_completed_at } : {}),
      }
    })
    .filter((action) => Object.keys(action).length > 0)
}
