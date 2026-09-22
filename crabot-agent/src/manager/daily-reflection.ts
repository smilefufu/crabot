import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod/v4'
import { defineTool } from '../engine/tool-framework.js'
import type { EngineMessage, EngineToolLifecycleEvent, ToolDefinition, ToolTraceMetadata } from '../engine/types.js'
import { AsyncMutex } from '../workers/async-mutex.js'
import type { ManagerKey } from './types.js'
import type { ManagerSessionStore } from './session-store.js'
import type {
  CompleteDailyReflectionParams, CompleteDailyReflectionResult, DailyReflectionAdmission,
  DailyReflectionResult, DailyReflectionState, ReflectionEvidence, ReflectionManifest, ReflectionRecord,
  ListReflectionRecordsOutput, ReflectionProgress,
  ReflectionRecordSummary,
  ReadReflectionRecordOutput, ReflectionReadPosition,
} from './daily-reflection-types.js'

interface ReflectionPage<T> { output: T; traceMetadata?: ToolTraceMetadata }

const finishSchema = z.object({
  outcome: z.enum(['completed', 'partial']), summary: z.string().trim().min(1),
  pending_items: z.array(z.string()),
  evidence_refs: z.array(z.string()).describe('completed 和 partial 都只填写本周期目录中的 record_ref，且 read_reflection_record 已完整读至 has_more=false、gaps 为空。目录中仅看过摘要的引用、有缺口的引用、run_id、Memory ID 和 source_id 均不能填写。没有符合条件的引用时填 []；缺口及未完成事项写入 pending_items，Memory 核验和建链结果写入 summary。'),
  summary_delivered: z.boolean().optional(),
}).strict()

function invalidEvidenceRefs(state: DailyReflectionState, refs: string[]): Array<{ record_ref: string; reason: string }> {
  const records = new Map(state.manifest?.records.map(record => [record.record_ref, record]))
  return refs.flatMap(record_ref => {
    const record = records.get(record_ref)
    const reason = !record ? 'not_in_current_directory'
      : record.skipped ? 'skipped_source_unavailable'
      : record.gaps.length || state.read_records[record_ref] === false ? 'incomplete_or_gapped'
        : state.read_records[record_ref] !== true ? 'not_read' : undefined
    return reason ? [{ record_ref, reason }] : []
  })
}

function skipUnavailableDetail(record: ReflectionRecord): void {
  const source = record.source
  const missing = record.gaps.filter(gap => gap !== 'frozen_evidence_changed')
  if (missing.length && missing.every(gap =>
    ['manager_trace_unavailable', 'manager_history_unavailable', 'episode_history_truncated', 'worker_events_truncated'].includes(gap)
    || /^(manager_span_unavailable|human_input_unavailable|worker_turn_unavailable):[^\n]+$/.test(gap)
    || /^ENOENT: no such file or directory, /.test(gap)
    || /^\d+ legacy trace reference\(s\) unavailable$/.test(gap)
    // A failed old capture with no trace bound cannot reproduce its original detail window.
    || (source.kind === 'worker' && source.traces.length === 0 && source.gaps.includes(gap)
      && gap.startsWith(`worker_trace_unavailable:${source.worker_id}:`))
    || /^native (?:unavailable|degraded \(served from agent-owned copy(?: \+ harness persisted activity)?\)): (?:Claude Code native session is unavailable|Codex native rollout is unavailable|builtin trace source unavailable|(?:CodexWorkerAdapter|ClaudeCodeAdapter)\.readTrace: no such incarnation [\w-]+#\d+ resident in this process)$/.test(gap))) {
    record.skipped = 'source_unavailable'
  }
}

export interface DailyReflectionDeps {
  key: ManagerKey
  store: ManagerSessionStore
  now: () => string
  capture: (state: DailyReflectionState) => Promise<ReflectionManifest>
  read: (record: ReflectionRecord, state: DailyReflectionState) => Promise<ReflectionEvidence>
  analysisWorkers: (episodeIds: string[]) => Promise<Array<{ worker_id: string; pending: boolean }>>
  confirm: (params: CompleteDailyReflectionParams) => Promise<CompleteDailyReflectionResult>
}

export function reflectionDigest(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

/** Keep the durable completion receipt for retry, but do not report it as confirmed. */
export function dailyReflectionResultForTrace(state?: DailyReflectionState): DailyReflectionResult | undefined {
  if (!state?.result || !state.confirmation_pending) return state?.result
  return { ...state.result, outcome: 'partial',
    validation_errors: [...state.result.validation_errors,
      state.confirmation_error ? `watermark_confirmation_failed: ${state.confirmation_error}` : 'watermark_confirmation_pending'] }
}

/** The existing Manager owns execution; this host only owns evidence and completion receipts. */
export class DailyReflection {
  private readonly mutex = new AsyncMutex()
  private failedDirectoryRun?: string
  private pagePersistenceError?: Error
  constructor(private readonly deps: DailyReflectionDeps) {}

  private async state(): Promise<DailyReflectionState> {
    const value = (await this.deps.store.load(this.deps.key)).dailyReflection
    if (!value) throw new Error('DAILY_REFLECTION_UNAVAILABLE')
    if (value.manifest) this.reading(value)
    return value
  }

  private async save(value: DailyReflectionState): Promise<void> {
    await this.deps.store.updateDailyReflection(this.deps.key, current => {
      if (current && current.run_id !== value.run_id) throw new Error('DAILY_REFLECTION_RUN_CHANGED')
      return value
    })
  }

  /** Returns false when only a previously persisted confirmation was replayed. */
  async admit(admission: DailyReflectionAdmission | undefined, episodeId: string): Promise<boolean> {
    return this.mutex.run(async () => {
      this.pagePersistenceError = undefined
      let state = (await this.deps.store.load(this.deps.key)).dailyReflection
      if (state?.confirmation_pending) { await this.confirm(state); return false }
      if (state?.result?.outcome === 'completed') {
        if (!admission || admission.window_start === state.window_start) return false
        if (admission.window_start !== state.window_end) throw new Error('DAILY_REFLECTION_WINDOW_CONFLICT')
        await this.deps.store.updateDailyReflection(this.deps.key, () => undefined)
        state = undefined
      }
      if (!state) {
        if (!admission || !admission.schedule_id || !admission.trigger_id
          || !Number.isFinite(Date.parse(admission.window_start)) || !Number.isFinite(Date.parse(admission.window_end))
          || Date.parse(admission.window_start) >= Date.parse(admission.window_end)) {
          throw new Error('DAILY_REFLECTION_INVALID_WINDOW')
        }
        state = {
          ...admission, run_id: randomUUID(), episode_ids: [], analysis_worker_ids: [],
          directory_complete: false, read_records: {}, cursors: {},
          summary_delivered: false,
        }
      } else if (admission && admission.schedule_id !== state.schedule_id) {
        throw new Error('DAILY_REFLECTION_SCHEDULE_CONFLICT')
      }
      if (!state.episode_ids.includes(episodeId)) state.episode_ids.push(episodeId)
      await this.save(state)
      return true
    })
  }

  /** Startup/later wake recovery replays only this RPC, never an LLM or business tool. */
  async recover(): Promise<void> {
    await this.mutex.run(async () => {
      const state = (await this.deps.store.load(this.deps.key)).dailyReflection
      if (state?.confirmation_pending) await this.confirm(state)
    })
  }

  private async confirm(state: DailyReflectionState): Promise<void> {
    try {
      const result = await this.deps.confirm({ schedule_id: state.schedule_id, trigger_id: state.trigger_id,
        window_start: state.window_start, window_end: state.window_end })
      if (result.watermark !== state.window_end || !['applied', 'already_applied'].includes(result.status)) {
        throw new Error('Invalid daily reflection confirmation')
      }
      await this.deps.store.updateDailyReflection(this.deps.key, current => {
        if (current?.run_id !== state.run_id) throw new Error('DAILY_REFLECTION_RUN_CHANGED')
        return { ...current, confirmation_pending: false, confirmation_error: undefined }
      })
    } catch (error) {
      state.confirmation_error = error instanceof Error ? error.message : String(error)
      await this.save(state)
      console.error(`[DailyReflection] watermark confirmation failed; run=${state.run_id}; pending result retained for reconciliation`)
    }
  }

  private legacyDirectoryPage(state: DailyReflectionState): { start: number; end: number } {
    if (state.directory_page) return state.directory_page
    let end = 0
    for (const position of Object.values(state.cursors)) {
      if (position.record_ref === undefined) end = Math.max(end, position.offset)
    }
    // Old states used fixed 20-record pages and did not persist the last page range.
    return state.directory_complete ? { start: end, end: state.manifest!.records.length }
      : { start: Math.max(0, end - 20), end }
  }

  private reading(state: DailyReflectionState): NonNullable<DailyReflectionState['reading']> {
    if (state.reading) return state.reading
    const records: Record<string, ReflectionReadPosition> = {}
    for (const [ref, complete] of Object.entries(state.read_records)) {
      const offsets = [...new Set(Object.values(state.cursors).filter(position => position.record_ref === ref)
        .map(position => position.offset))].sort((a, b) => a - b)
      const hasGaps = state.manifest?.records.find(record => record.record_ref === ref)?.gaps.length
      records[ref] = { offset: complete || hasGaps ? 0 : offsets.at(-2) ?? 0, complete }
    }
    state.reading = { version: 1, directory: { offset: this.legacyDirectoryPage(state).start, complete: false }, records }
    state.directory_complete = false
    return state.reading
  }

  private page<T>(state: DailyReflectionState, position: ReflectionReadPosition, output: T): ReflectionPage<T> {
    return { output, ...(position.pending ? { traceMetadata: {
      reflection_run_id: state.run_id, reflection_page_receipt: position.pending.receipt,
    } } : {}) }
  }

  /** Called only after Manager has durably checkpointed the real successful tool results. */
  async acknowledgePages(events: readonly EngineToolLifecycleEvent[]): Promise<void> {
    await this.mutex.run(async () => {
      if (this.pagePersistenceError) throw this.pagePersistenceError
      const state = await this.state()
      if (!state.reading) return
      let changed = false
      for (const event of events) {
        if (event.type !== 'tool_finished' || event.isError || event.traceMetadata?.reflection_run_id !== state.run_id) continue
        const ref = event.name === 'read_reflection_record' && typeof event.input.record_ref === 'string' ? event.input.record_ref : undefined
        const position = event.name === 'list_reflection_records' ? state.reading.directory
          : ref ? state.reading.records[ref] : undefined
        const pending = position?.pending
        if (!position || !pending || event.traceMetadata?.reflection_page_receipt !== pending.receipt) continue
        position.offset = pending.end
        position.complete = !pending.has_more
        delete position.pending
        if (ref) {
          const record = state.manifest?.records.find(record => record.record_ref === ref)
          state.read_records[ref] = position.complete && !!record && !record.skipped && record.gaps.length === 0
        } else state.directory_complete = position.complete
        changed = true
      }
      if (changed) await this.save(state)
    })
  }

  private async savePage(state: DailyReflectionState): Promise<void> {
    try { await this.save(state) } catch (error) {
      // Tool exceptions become ordinary error results; stop before the next model request.
      this.pagePersistenceError = error instanceof Error ? error : new Error(String(error))
      throw this.pagePersistenceError
    }
  }

  private progress(state: DailyReflectionState): ReflectionProgress {
    const records = state.manifest!.records
    const directory = this.reading(state).directory
    const skipped = new Set(records.filter(record => record.skipped).map(record => record.record_ref))
    const pending = Object.entries(state.read_records).filter(([ref, complete]) => !complete && !skipped.has(ref))
    const gaps = records.filter(record => record.gaps.length > 0 && !record.skipped)
    return { directory_total: records.length,
      directory_read: directory.offset,
      directory_complete: state.directory_complete,
      pending_record_count: pending.length,
      pending_records: pending.slice(0, 20).map(([record_ref]) => ({ record_ref })),
      evidence_gap_count: gaps.length,
      evidence_gap_records: gaps.slice(0, 20).map(({ record_ref }) => ({ record_ref })),
      skipped_record_count: skipped.size }
  }

  async list(restart = false): Promise<ReflectionPage<ListReflectionRecordsOutput>> {
    return this.mutex.run(async () => {
      const state = await this.state()
      let output: ReflectionPage<ListReflectionRecordsOutput>
      try {
        output = await this.listPage(state, restart)
      } catch (error) {
        this.failedDirectoryRun = state.run_id
        throw error
      }
      await this.savePage(state)
      this.failedDirectoryRun = undefined
      return output
    })
  }

  private async listPage(state: DailyReflectionState, restart: boolean): Promise<ReflectionPage<ListReflectionRecordsOutput>> {
    if (!state.manifest) {
      const manifest = await this.deps.capture(state)
      if (manifest.gaps.length) throw new Error(`REFLECTION_INVENTORY_UNAVAILABLE: ${manifest.gaps.join(', ')}`)
      state.manifest = manifest
    }
    for (const record of state.manifest.records) skipUnavailableDetail(record)
    const position = this.reading(state).directory
    if (restart && !position.pending) {
      position.offset = 0
      position.complete = false
      state.directory_complete = false
    }
    const offset = position.pending?.start ?? position.offset
    const progress = this.progress(state)
    const outputFor = (records: ReflectionRecordSummary[]): ListReflectionRecordsOutput => {
      const end = offset + records.length
      return { run_id: state.run_id, window_start: state.window_start, window_end: state.window_end,
        records, has_more: !position.complete && end < state.manifest!.records.length,
        gaps: state.manifest!.gaps, coverage: 'available_persisted_evidence',
        progress,
        ...(state.result ? { previous_result: state.result } : {}) }
    }
    let output = outputFor([])
    if (Buffer.byteLength(JSON.stringify(output)) > 80 * 1024) throw new Error('REFLECTION_DIRECTORY_PAGE_TOO_LARGE: metadata')
    if (position.complete) return { output }
    for (const record of state.manifest.records.slice(offset, position.pending?.end ?? offset + 100)) {
      const candidate = outputFor([...output.records, await this.recordSummary(record, state)])
      if (Buffer.byteLength(JSON.stringify(candidate)) > 80 * 1024) {
        if (!output.records.length) throw new Error(`REFLECTION_DIRECTORY_PAGE_TOO_LARGE: ${record.record_ref}`)
        break
      }
      output = candidate
    }
    const end = offset + output.records.length
    if (position.pending && end !== position.pending.end) delete position.pending
    position.pending ??= { receipt: randomUUID(), start: offset, end, has_more: output.has_more }
    return this.page(state, position, output)
  }

  private async recordSummary(record: ReflectionRecord, state: DailyReflectionState): Promise<ReflectionRecordSummary> {
    const { source, digest, ...summary } = record
    if (record.skipped) return summary
    if (source.kind !== 'worker' || source.traces.length || source.turn_ids.length || !source.event_count || !digest) return summary
    try {
      const evidence = await this.deps.read(record, state)
      if (evidence.gaps.length || reflectionDigest(evidence.content) !== digest) return summary
      const events: unknown = JSON.parse(evidence.content)
      if (Array.isArray(events) && events.length > 0
        && events.every(event => event?.kind === 'legacy_imported')) {
        summary.summary = '仅有迁移审计记录；迁移时间不是业务执行时间，该冻结项不包含本周期业务执行证据。'
      }
    } catch {
      // Keep the frozen summary when it cannot be verified; detail reads still report source failures.
    }
    return summary
  }

  async read(recordRef: string, restart = false): Promise<ReflectionPage<ReadReflectionRecordOutput>> {
    return this.mutex.run(async () => {
      const state = await this.state()
      const record = state.manifest?.records.find(item => item.record_ref === recordRef)
      if (!record) throw new Error('INVALID_REFLECTION_RECORD')
      const reading = this.reading(state)
      const position = reading.records[recordRef] ??= { offset: 0, complete: false }
      if (restart && !position.pending) {
        position.offset = 0
        position.complete = false
      }
      if (position.complete) return { output: { record_ref: recordRef, content: '', has_more: false, gaps: record.gaps,
        ...(record.skipped ? { skipped: record.skipped } : {}) } }
      const offset = position.pending?.start ?? position.offset
      state.read_records[recordRef] = false
      let evidence: ReflectionEvidence
      try {
        evidence = await this.deps.read(record, state)
        const digest = reflectionDigest(evidence.content)
        if (record.digest && digest !== record.digest) evidence.gaps.push('frozen_evidence_changed')
        else if (!record.digest && !evidence.gaps.length) record.digest = digest
      } catch (error) {
        evidence = { content: '', gaps: [error instanceof Error ? error.message : String(error)] }
      }
      record.gaps = [...new Set(evidence.gaps)]
      delete record.skipped
      skipUnavailableDetail(record)
      // Slice at Unicode character boundaries; no replacement characters across pages.
      let bytes = 0
      let content = ''
      for (const character of evidence.content.slice(offset)) {
        const size = Buffer.byteLength(character)
        if (bytes + size > 16 * 1024) break
        content += character
        bytes += size
      }
      const next = offset + content.length
      const hasMore = next < evidence.content.length
      // Changed evidence must not acknowledge an older page range using the same receipt.
      if (position.pending && (position.pending.end !== next || position.pending.has_more !== hasMore)) delete position.pending
      position.pending ??= { receipt: randomUUID(), start: offset, end: next, has_more: hasMore }
      await this.savePage(state)
      return this.page(state, position, { record_ref: recordRef, content, has_more: hasMore, gaps: record.gaps,
        ...(record.skipped ? { skipped: record.skipped } : {}) })
    })
  }

  /** Persist the successful delivery receipt before history compaction can discard it. */
  async recordSummaryDelivery(): Promise<void> {
    await this.mutex.run(async () => {
      const state = await this.state()
      state.summary_delivered = true
      await this.save(state)
    })
  }

  async validateFinish(input: Record<string, unknown>, toolCallCount: number): Promise<string | undefined> {
    if (toolCallCount !== 1) return 'finish_must_be_called_alone: 本批次未执行任何工具，请单独调用 finish_daily_reflection。'
    const parsed = finishSchema.safeParse(input)
    if (!parsed.success) return `invalid_completion_input: ${parsed.error.message}`
    return this.mutex.run(async () => {
      const state = await this.state()
      const invalid = invalidEvidenceRefs(state, parsed.data.evidence_refs)
      if (invalid.length) return `unread_evidence_reference: ${JSON.stringify(invalid)}。evidence_refs 仅接受本周期目录内已完整读取且无缺口的 record_ref。没有合格引用时填 []；缺口及未完成事项写入 pending_items，Memory 核验和建链结果写入 summary。`
      const directoryPending = !state.directory_complete && this.failedDirectoryRun !== state.run_id
      const pending = state.manifest?.records.filter(record =>
        state.read_records[record.record_ref] === false && !record.skipped && record.gaps.length === 0) ?? []
      if (directoryPending || pending.length) {
        const progress = state.manifest ? this.progress(state) : undefined
        return `actionable_evidence_remaining: ${JSON.stringify({
          directory_pending: directoryPending,
          ...(progress ? { directory_read: progress.directory_read, directory_total: progress.directory_total } : {}),
          pending_record_count: pending.length, pending_records: pending.slice(0, 20).map(({ record_ref }) => ({ record_ref })),
        })}。尚有可继续读取的证据，本次退出未执行。默认调用 list_reflection_records 继续目录，调用 read_reflection_record 并指定未完 record_ref 继续详情；宿主管理读取位置，按 has_more 读完。已知故障只暂停依赖它的判断，继续处理其他可读事项。`
      }
      return undefined
    })
  }

  async finish(params: { outcome: string; exitToolCall?: { name: string; input: Record<string, unknown> }; messages: readonly EngineMessage[] }): Promise<DailyReflectionResult | undefined> {
    return this.mutex.run(async () => {
      const state = await this.state()
      const workers = await this.deps.analysisWorkers(state.episode_ids)
      state.analysis_worker_ids = workers.map(worker => worker.worker_id)
      if (params.exitToolCall?.name !== 'finish_daily_reflection') {
        state.result = {
          outcome: 'partial', summary: workers.some(worker => worker.pending) ? '等待已登记的分析 Worker' : '本轮未提交显式反思结果',
          pending_items: workers.filter(worker => worker.pending).map(worker => worker.worker_id), evidence_refs: [],
          run_id: state.run_id, window_start: state.window_start, window_end: state.window_end,
          completed_at: this.deps.now(), validation_errors: ['completion_not_submitted', ...(params.outcome !== 'completed' ? [params.outcome] : [])],
        }
        await this.save(state)
        return state.result
      }
      const parsed = finishSchema.safeParse(params.exitToolCall.input)
      const input = parsed.success ? parsed.data : { outcome: 'partial' as const, summary: 'Invalid completion input', pending_items: [], evidence_refs: [] }
      const errors: string[] = []
      if (!parsed.success) errors.push('invalid_completion_input')
      if (params.outcome !== 'completed') errors.push('episode_not_completed')
      const lastAssistant = [...params.messages].reverse().find(message => message.role === 'assistant')
      if (lastAssistant?.role !== 'assistant' || lastAssistant.content.filter(block => block.type === 'tool_use').length !== 1) errors.push('finish_must_be_called_alone')
      if (!state.directory_complete) errors.push('directory_not_fully_read')
      if (state.manifest?.gaps.length || state.manifest?.records.some(record => record.gaps.length && !record.skipped)) errors.push('known_evidence_gaps')
      const skipped = new Set(state.manifest?.records.filter(record => record.skipped).map(record => record.record_ref))
      if (Object.entries(state.read_records).some(([ref, read]) => !read && !skipped.has(ref))) errors.push('record_not_fully_read')
      if (invalidEvidenceRefs(state, input.evidence_refs).length) errors.push('unread_evidence_reference')
      if (workers.some(worker => worker.pending)) errors.push('analysis_worker_pending')
      if (input.summary_delivered && !state.summary_delivered) errors.push('summary_delivery_unproven')
      if (input.outcome === 'completed' && input.pending_items.length) errors.push('pending_items_remain')
      const result: DailyReflectionResult = { ...input,
        outcome: input.outcome === 'completed' && errors.length === 0 ? 'completed' : 'partial',
        run_id: state.run_id, window_start: state.window_start, window_end: state.window_end,
        completed_at: this.deps.now(), validation_errors: errors }
      state.result = result
      state.confirmation_pending = result.outcome === 'completed'
      await this.save(state)
      if (state.confirmation_pending) await this.confirm(state)
      return dailyReflectionResultForTrace(await this.state())
    })
  }
}

export function buildDailyReflectionTools(host?: Pick<DailyReflection, 'list' | 'read' | 'validateFinish'>): ToolDefinition[] {
  const tool = (name: string, description: string, schema: z.ZodType, call: (input: Record<string, unknown>) => Promise<ReflectionPage<unknown>>) =>
    defineTool({ name, description, inputSchema: z.toJSONSchema(schema), isReadOnly: true, async call(input) {
      const parsed = schema.safeParse(input)
      if (!parsed.success) return { output: parsed.error.message, isError: true }
      const result = await call(parsed.data as Record<string, unknown>)
      return { output: JSON.stringify(result.output), isError: false, traceMetadata: result.traceMetadata }
    } })
  return [
    tool('list_reflection_records', '读取宿主固定反思周期的下一页目录，每页最多 100 条，完整回包受字节预算限制。默认从宿主保存的位置继续，has_more=true 时再次调用；读完后默认返回空目录及最新进度，不从头重开。只有确需从头重读目录时传 restart=true。progress 是已确认进度，可能尚未计入本页；pending_records 是待继续的详情，直接用其中的 record_ref 读取；evidence_gap_records 是未跳过的缺口记录，需要复核时对该详情传 restart=true。中断恢复可能重发尚未确认保存的一页。读取或回包已保存不证明完成语义复盘。gaps 保留已知缺口；skipped 项已按来源缺失处置，不阻止完成且不能作为 evidence_refs。',
      z.object({ restart: z.boolean().optional() }).strict(), input => host ? host.list(input.restart as boolean | undefined) : Promise.reject(new Error('DAILY_REFLECTION_UNAVAILABLE'))),
    tool('read_reflection_record', '读取本周期 record_ref 的下一段详情，位置由宿主按记录分别保存。has_more=true 时用相同 record_ref 再次调用；读完后默认返回空正文和 has_more=false，不重新打开。只有确需从头复核该详情时传 restart=true，重读后须再次读完；尚未确认保存的回包会先重发。不能使用其他会话 ID 或路径。',
      z.object({ record_ref: z.string(), restart: z.boolean().optional() }).strict(), input => host ? host.read(input.record_ref as string, input.restart as boolean | undefined) : Promise.reject(new Error('DAILY_REFLECTION_UNAVAILABLE'))),
    { ...tool('finish_daily_reflection', '当前可推进事项处理完后提交本周期结果并结束本轮，必须单独调用。满足全部完成条件才用 completed；仍有真实阻塞或取证缺口时用 partial，列明未完成事项及不能继续的依据。只剩等待分析 Worker 时直接结束回合。completed 还需宿主验证与 Admin 确认。',
      finishSchema, async () => { throw new Error('Host-only exit tool') }), isReadOnly: false, exitsLoop: true,
      validateExit: (input, count) => host ? host.validateFinish(input, count) : Promise.reject(new Error('DAILY_REFLECTION_UNAVAILABLE')) },
  ]
}
