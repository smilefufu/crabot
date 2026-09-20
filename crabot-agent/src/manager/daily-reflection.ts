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
} from './daily-reflection-types.js'

const finishSchema = z.object({
  outcome: z.enum(['completed', 'partial']), summary: z.string().trim().min(1),
  pending_items: z.array(z.string()),
  evidence_refs: z.array(z.string()).describe('仅填写本周期目录返回且已用 read_reflection_record 读完的 record_ref；不是 run_id、Memory ID 或 source_id。没有已读引用时填空数组。'),
  summary_delivered: z.boolean().optional(),
}).strict()

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

  private progress(state: DailyReflectionState): ReflectionProgress {
    const records = state.manifest!.records
    let directoryRead = 0
    let resumeCursor: string | undefined
    // Every directory cursor was issued only after delivering the preceding page.
    for (const [token, position] of Object.entries(state.cursors)) {
      if (position.record_ref === undefined && position.offset > directoryRead) {
        directoryRead = position.offset
        resumeCursor = token
      }
    }
    const pending = Object.entries(state.read_records).filter(([, complete]) => !complete)
    return { directory_total: records.length,
      directory_read: state.directory_complete ? records.length : directoryRead,
      directory_complete: state.directory_complete,
      ...(!state.directory_complete && resumeCursor ? { resume_cursor: resumeCursor } : {}),
      pending_record_count: pending.length,
      pending_records: pending.slice(0, 20).map(([record_ref]) => ({ record_ref })),
      evidence_gap_count: records.filter(record => record.gaps.length > 0).length }
  }

  async list(cursor?: string): Promise<ListReflectionRecordsOutput> {
    return this.mutex.run(async () => {
      const state = await this.state()
      const offset = this.offset(state, cursor)
      if (!state.manifest) {
        const manifest = await this.deps.capture(state)
        if (manifest.gaps.length) throw new Error(`REFLECTION_INVENTORY_UNAVAILABLE: ${manifest.gaps.join(', ')}`)
        state.manifest = manifest
      }
      const records = state.manifest.records.slice(offset, offset + 20)
      const next = offset + records.length
      const nextCursor = next < state.manifest.records.length ? this.nextCursor(state, next) : undefined
      if (!nextCursor) state.directory_complete = true
      await this.save(state)
      return { run_id: state.run_id, window_start: state.window_start, window_end: state.window_end,
        records: records.map(({ source: _source, digest: _digest, ...record }) => record),
        ...(nextCursor ? { next_cursor: nextCursor } : {}), gaps: state.manifest.gaps,
        coverage: 'available_persisted_evidence', progress: this.progress(state),
        ...(state.result ? { previous_result: state.result } : {}) }
    })
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
      return { record_ref: recordRef, content, ...(nextCursor ? { next_cursor: nextCursor } : {}), gaps: record.gaps }
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
      if (state.manifest?.gaps.length || state.manifest?.records.some(record => record.gaps.length)) errors.push('known_evidence_gaps')
      if (Object.values(state.read_records).some(read => !read)) errors.push('record_not_fully_read')
      if (input.evidence_refs.some(ref => state.read_records[ref] !== true)) errors.push('unread_evidence_reference')
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

export function buildDailyReflectionTools(host?: Pick<DailyReflection, 'list' | 'read'>): ToolDefinition[] {
  const tool = (name: string, description: string, schema: z.ZodType, call: (input: Record<string, unknown>) => Promise<unknown>) =>
    defineTool({ name, description, inputSchema: z.toJSONSchema(schema), isReadOnly: true, async call(input) {
      const parsed = schema.safeParse(input)
      if (!parsed.success) return { output: parsed.error.message, isError: true }
      return { output: JSON.stringify(await call(parsed.data as Record<string, unknown>)), isError: false }
    } })
  return [
    tool('list_reflection_records', '列出宿主固定反思周期内的执行与人类输入证据。首次不传 cursor，沿 next_cursor 翻完目录；恢复续办位置用返回的 progress.resume_cursor。progress 还列出未读完的详情引用（从首段重读）及证据缺口数量；已交付目录不等于语义复盘完成。gaps 表示已知证据缺口。',
      z.object({ cursor: z.string().optional() }).strict(), input => host ? host.list(input.cursor as string | undefined) : Promise.reject(new Error('DAILY_REFLECTION_UNAVAILABLE'))),
    tool('read_reflection_record', '分页读取本次目录返回的 record_ref。沿该记录的 next_cursor 读完；不能使用其他会话 ID、路径或其他记录的游标。',
      z.object({ record_ref: z.string(), cursor: z.string().optional() }).strict(), input => host ? host.read(input.record_ref as string, input.cursor as string | undefined) : Promise.reject(new Error('DAILY_REFLECTION_UNAVAILABLE'))),
    { ...tool('finish_daily_reflection', '提交本周期反思结果并结束本轮，必须单独调用。证据或处理未完成时用 partial，并列出 pending_items；等待分析 Worker 时直接结束回合。completed 还需宿主验证与 Admin 确认。',
      finishSchema, async () => { throw new Error('Host-only exit tool') }), isReadOnly: false, exitsLoop: true },
  ]
}
