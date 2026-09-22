import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod/v4'
import { defineTool } from '../engine/tool-framework.js'
import type { EngineMessage, ToolDefinition } from '../engine/types.js'
import { AsyncMutex } from '../workers/async-mutex.js'
import type { ManagerKey } from './types.js'
import type { ManagerSessionStore } from './session-store.js'
import type {
  CompleteDailyReflectionParams, CompleteDailyReflectionResult, DailyReflectionAdmission,
  DailyReflectionResult, DailyReflectionState, ReflectionEvidence, ReflectionManifest, ReflectionRecord,
  ListReflectionRecordsOutput, ReflectionProgress,
  ReflectionRecordSummary,
} from './daily-reflection-types.js'

const finishSchema = z.object({
  outcome: z.enum(['completed', 'partial']), summary: z.string().trim().min(1),
  pending_items: z.array(z.string()),
  evidence_refs: z.array(z.string()).describe('completed 和 partial 都只填写本周期目录中的 record_ref，且 read_reflection_record 已沿 next_cursor 读至末页、gaps 为空。目录中仅看过摘要的引用、有缺口的引用、run_id、Memory ID 和 source_id 均不能填写。没有符合条件的引用时填 []；缺口及未完成事项写入 pending_items，Memory 核验和建链结果写入 summary。'),
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
  constructor(private readonly deps: DailyReflectionDeps) {}

  private async state(): Promise<DailyReflectionState> {
    const value = (await this.deps.store.load(this.deps.key)).dailyReflection
    if (!value) throw new Error('DAILY_REFLECTION_UNAVAILABLE')
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

  private nextCursor(state: DailyReflectionState, offset: number, recordRef?: string): string {
    const token = randomUUID()
    state.cursors[token] = { offset, ...(recordRef ? { record_ref: recordRef } : {}) }
    return token
  }

  private offset(state: DailyReflectionState, cursor: string | undefined, recordRef?: string): number {
    if (cursor === undefined) return 0
    const position = state.cursors[cursor]
    if (!position || position.record_ref !== recordRef) throw new Error('INVALID_REFLECTION_CURSOR')
    return position.offset
  }

  private directoryPage(state: DailyReflectionState): { start: number; end: number } {
    if (state.directory_page) return state.directory_page
    let end = 0
    for (const position of Object.values(state.cursors)) {
      if (position.record_ref === undefined) end = Math.max(end, position.offset)
    }
    // Old states used fixed 20-record pages and did not persist the last page range.
    return state.directory_complete ? { start: end, end: state.manifest!.records.length }
      : { start: Math.max(0, end - 20), end }
  }

  private progress(state: DailyReflectionState): ReflectionProgress {
    const records = state.manifest!.records
    const page = this.directoryPage(state)
    const resumeCursor = Object.entries(state.cursors).find(([, position]) =>
      position.record_ref === undefined && position.offset === page.start)?.[0]
    const skipped = new Set(records.filter(record => record.skipped).map(record => record.record_ref))
    const pending = Object.entries(state.read_records).filter(([ref, complete]) => !complete && !skipped.has(ref))
    const gaps = records.filter(record => record.gaps.length > 0 && !record.skipped)
    return { directory_total: records.length,
      directory_read: page.end,
      directory_complete: state.directory_complete,
      ...(resumeCursor ? { resume_cursor: resumeCursor } : {}),
      pending_record_count: pending.length,
      pending_records: pending.slice(0, 20).map(([record_ref]) => ({ record_ref })),
      evidence_gap_count: gaps.length,
      evidence_gap_records: gaps.slice(0, 20).map(({ record_ref }) => ({ record_ref })),
      skipped_record_count: skipped.size }
  }

  async list(cursor?: string): Promise<ListReflectionRecordsOutput> {
    return this.mutex.run(async () => {
      const state = await this.state()
      const offset = this.offset(state, cursor)
      let output: ListReflectionRecordsOutput
      try {
        output = await this.listPage(state, offset)
      } catch (error) {
        this.failedDirectoryRun = state.run_id
        throw error
      }
      await this.save(state)
      this.failedDirectoryRun = undefined
      return output
    })
  }

  private async listPage(state: DailyReflectionState, offset: number): Promise<ListReflectionRecordsOutput> {
    if (!state.manifest) {
      const manifest = await this.deps.capture(state)
      if (manifest.gaps.length) throw new Error(`REFLECTION_INVENTORY_UNAVAILABLE: ${manifest.gaps.join(', ')}`)
      state.manifest = manifest
    }
    for (const record of state.manifest.records) skipUnavailableDetail(record)
    const previousPage = this.directoryPage(state)
    const { resume_cursor, ...progress } = this.progress(state)
    const nextCursor = randomUUID()
    const pageStartCursor = Object.entries(state.cursors).find(([, position]) =>
      position.record_ref === undefined && position.offset === offset)?.[0]
    const outputFor = (records: ReflectionRecordSummary[]): ListReflectionRecordsOutput => {
      const end = offset + records.length
      const advanced = end > previousPage.end
      const resume = advanced ? pageStartCursor : resume_cursor
      return { run_id: state.run_id, window_start: state.window_start, window_end: state.window_end,
        records, ...(end < state.manifest!.records.length ? { next_cursor: nextCursor } : {}),
        gaps: state.manifest!.gaps, coverage: 'available_persisted_evidence',
        progress: { ...progress, directory_read: Math.max(previousPage.end, end),
          directory_complete: state.directory_complete || end === state.manifest!.records.length,
          ...(resume ? { resume_cursor: resume } : {}) },
        ...(state.result ? { previous_result: state.result } : {}) }
    }
    let output = outputFor([])
    if (Buffer.byteLength(JSON.stringify(output)) > 80 * 1024) throw new Error('REFLECTION_DIRECTORY_PAGE_TOO_LARGE: metadata')
    for (const record of state.manifest.records.slice(offset, offset + 100)) {
      const candidate = outputFor([...output.records, await this.recordSummary(record, state)])
      if (Buffer.byteLength(JSON.stringify(candidate)) > 80 * 1024) {
        if (!output.records.length) throw new Error(`REFLECTION_DIRECTORY_PAGE_TOO_LARGE: ${record.record_ref}`)
        break
      }
      output = candidate
    }
    const end = offset + output.records.length
    state.directory_page = end > previousPage.end ? { start: offset, end } : previousPage
    state.directory_complete = output.progress.directory_complete
    if (output.next_cursor) state.cursors[nextCursor] = { offset: end }
    return output
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

  async read(recordRef: string, cursor?: string): Promise<unknown> {
    return this.mutex.run(async () => {
      const state = await this.state()
      const record = state.manifest?.records.find(item => item.record_ref === recordRef)
      if (!record) throw new Error('INVALID_REFLECTION_RECORD')
      const offset = this.offset(state, cursor, recordRef)
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
      const nextCursor = next < evidence.content.length ? this.nextCursor(state, next, recordRef) : undefined
      state.read_records[recordRef] = !nextCursor && record.gaps.length === 0
      await this.save(state)
      return { record_ref: recordRef, content, ...(nextCursor ? { next_cursor: nextCursor } : {}), gaps: record.gaps,
        ...(record.skipped ? { skipped: record.skipped } : {}) }
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
          ...(progress ? { directory_read: progress.directory_read, directory_total: progress.directory_total,
            ...(progress.resume_cursor ? { resume_cursor: progress.resume_cursor } : {}) } : {}),
          pending_record_count: pending.length, pending_records: pending.slice(0, 20).map(({ record_ref }) => ({ record_ref })),
        })}。尚有可继续读取的证据，本次退出未执行。目录从 resume_cursor 保守续读，没有时从首页开始，再沿 next_cursor 前进；未完详情优先沿该记录已有 next_cursor 续读，确无可用游标时才从首段重读。已知故障只暂停依赖它的判断，继续处理其他可读事项。`
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
  const tool = (name: string, description: string, schema: z.ZodType, call: (input: Record<string, unknown>) => Promise<unknown>) =>
    defineTool({ name, description, inputSchema: z.toJSONSchema(schema), isReadOnly: true, async call(input) {
      const parsed = schema.safeParse(input)
      if (!parsed.success) return { output: parsed.error.message, isError: true }
      return { output: JSON.stringify(await call(parsed.data as Record<string, unknown>)), isError: false }
    } })
  return [
    tool('list_reflection_records', '列出宿主固定反思周期内的执行与人类输入证据，每页最多 100 条，实际页长受完整回包字节预算限制。首次不传 cursor；恢复续办时用 progress.resume_cursor 保守重读最后一页（首页不返回该游标），之后沿当前页 next_cursor 前进，不反复跟随 progress.resume_cursor。目录翻完但周期未完成时也可重读末页。progress.pending_records 是未读完的详情，evidence_gap_records 是未跳过的缺口记录，可能位于此前目录页；两者都可从详情首段重读，成功后再次 list 取得剩余引用。宿主已读取不证明模型已收到或完成复盘。gaps 保留已知缺口；skipped 项已按来源缺失处置，不阻止完成且不能作为 evidence_refs。',
      z.object({ cursor: z.string().optional() }).strict(), input => host ? host.list(input.cursor as string | undefined) : Promise.reject(new Error('DAILY_REFLECTION_UNAVAILABLE'))),
    tool('read_reflection_record', '分页读取本次目录返回的 record_ref。沿该记录的 next_cursor 读完；不能使用其他会话 ID、路径或其他记录的游标。',
      z.object({ record_ref: z.string(), cursor: z.string().optional() }).strict(), input => host ? host.read(input.record_ref as string, input.cursor as string | undefined) : Promise.reject(new Error('DAILY_REFLECTION_UNAVAILABLE'))),
    { ...tool('finish_daily_reflection', '当前可推进事项处理完后提交本周期结果并结束本轮，必须单独调用。满足全部完成条件才用 completed；仍有真实阻塞或取证缺口时用 partial，列明未完成事项及不能继续的依据。只剩等待分析 Worker 时直接结束回合。completed 还需宿主验证与 Admin 确认。',
      finishSchema, async () => { throw new Error('Host-only exit tool') }), isReadOnly: false, exitsLoop: true,
      validateExit: (input, count) => host ? host.validateFinish(input, count) : Promise.reject(new Error('DAILY_REFLECTION_UNAVAILABLE')) },
  ]
}
