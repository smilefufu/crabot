/**
 * Worker composite trace reader（P6-A §8）。
 *
 * 合并 harness / native / legacy 三源为一条时间线，使用 Agent-owned opaque composite
 * cursor（cursor-store.ts）。职责边界（复用语义审查 §8）：
 * - adapter `readTrace()` 只解析本实现 native source，不承担合并；
 * - legacy reader 是历史只读，不 reactivate checkpoint、不调 legacy adapter；
 * - 合并/化身解析/cursor 全在这个无实现语义的模块。
 */

import type { LedgerStore } from '../harness/ledger-store.js'
import type { WorkerHarness } from '../harness/harness.js'
import {
  findIncarnationBySeq,
  mainlineIncarnation,
  WorkerHasNoIncarnationError,
  WorkerNotFoundError,
} from '../harness/harness.js'
import {
  isLegacyIncarnation,
  type Incarnation,
} from '../harness/ledger-types.js'
import type { WorkerAdapter, IncarnationHandle, NormalizedTraceEvent, WorkerImplId } from '../types.js'
import type { HarnessEvent } from '../harness/worker-events.js'
import { readLegacyTraceEvents, type LegacyTraceEventEntry } from '../legacy-source-reader.js'
import {
  incarnationFingerprint,
  InvalidTraceCursorError,
  type TraceCursorStore,
  type TraceSourcePositions,
} from './cursor-store.js'
import type { NativeTraceCopyStore } from './native-copy.js'

export interface CompositeTraceDeps {
  readonly ledger: LedgerStore
  readonly harness: WorkerHarness
  readonly adapters: Map<WorkerImplId, WorkerAdapter>
  readonly cursorStore: TraceCursorStore
  readonly nativeCopy: NativeTraceCopyStore
  /** 脱敏（写 copy 与 detail 前必过）。 */
  readonly redact: (text: string) => string
  /** legacy trace 目录（$AGENT_DATA_DIR/traces）。 */
  readonly legacyTraceDir: string
}

export interface CompositeTraceParams {
  readonly worker_id: string
  readonly seq?: number
  readonly cursor?: string
}

export interface CompositeTraceResult {
  events: NormalizedTraceEvent[]
  /** 成功解析 worker/incarnation 后必填（即使 events 为空或 native unavailable）。 */
  next_cursor: string
  unavailable_reason?: string
}

interface SourcedEvent {
  readonly event: NormalizedTraceEvent
  readonly source: 'harness' | 'native' | 'legacy'
  readonly sourceOrdinal: number
}

const SOURCE_ORDER: Record<'harness' | 'native' | 'legacy', number> = { harness: 0, native: 1, legacy: 2 }

function normalizeHarnessEvent(event: HarnessEvent): NormalizedTraceEvent {
  return {
    ts: event.ts,
    kind: 'lifecycle',
    summary: harnessSummary(event),
    ...(event.detail ? { detail: event.detail } : {}),
    source: 'harness',
  }
}

/** lifecycle 行的 summary 带上关键 detail——裸事件名（如 state_changed 无目标态）是噪音。 */
function harnessSummary(event: HarnessEvent): string {
  const detail = (event.detail ?? {}) as Record<string, unknown>
  switch (event.kind) {
    case 'state_changed':
      return detail.to ? `state_changed → ${String(detail.to)}` : 'state_changed'
    case 'spawned':
      return detail.impl ? `spawned (${String(detail.impl)})` : 'spawned'
    case 'input_sent':
      return typeof detail.delivery_id === 'string'
        ? `input_sent delivery_id=${detail.delivery_id}`
        : 'input_sent'
    case 'input_delivery_failed': {
      const deliveryId = typeof detail.delivery_id === 'string' ? ` delivery_id=${detail.delivery_id}` : ''
      const reasonCode = typeof detail.reason_code === 'string' ? ` reason_code=${detail.reason_code}` : ''
      return `input_delivery_failed${deliveryId}${reasonCode}`
    }
    case 'query_completed': {
      const queryId = typeof detail.query_id === 'string' ? ` query_id=${detail.query_id}` : ''
      const forkSeq = typeof detail.fork_seq === 'number' ? ` fork_seq=${detail.fork_seq}` : ''
      return `query_completed${queryId}${forkSeq}`
    }
    case 'query_failed': {
      const queryId = typeof detail.query_id === 'string' ? ` query_id=${detail.query_id}` : ''
      const forkSeq = typeof detail.fork_seq === 'number' ? ` fork_seq=${detail.fork_seq}` : ''
      const reasonCode = typeof detail.reason_code === 'string' ? ` reason_code=${detail.reason_code}` : ''
      return `query_failed${queryId}${forkSeq}${reasonCode}`
    }
    default: {
      const message = typeof detail.message === 'string' ? detail.message
        : typeof detail.error === 'string' ? detail.error
        : typeof detail.reason === 'string' ? detail.reason
        : undefined
      return message ? `${event.kind}: ${message.slice(0, 120)}` : `${event.kind}`
    }
  }
}

function sortSourcedEvents(events: SourcedEvent[]): SourcedEvent[] {
  return [...events].sort((left, right) => {
    const byTs = left.event.ts.localeCompare(right.event.ts)
    if (byTs !== 0) return byTs
    const bySource = SOURCE_ORDER[left.source] - SOURCE_ORDER[right.source]
    if (bySource !== 0) return bySource
    return left.sourceOrdinal - right.sourceOrdinal
  })
}

/**
 * composite read。化身解析失败抛 WorkerNotFoundError/WorkerHasNoIncarnationError/Error（seq 不存在）；
 * cursor 非法/错化身抛 InvalidTraceCursorError（INVALID_PARAMS，不静默从头）。
 */
export async function readCompositeWorkerTrace(
  deps: CompositeTraceDeps,
  params: CompositeTraceParams,
): Promise<CompositeTraceResult> {
  const found = await deps.ledger.findWorker(params.worker_id)
  if (!found) throw new WorkerNotFoundError(params.worker_id)
  const worker = found.worker
  if (worker.incarnations.length === 0) throw new WorkerHasNoIncarnationError(params.worker_id)
  const incarnation =
    params.seq === undefined ? mainlineIncarnation(worker) : findIncarnationBySeq(worker, params.seq)
  if (!incarnation) {
    throw new Error(`get_worker_trace: no incarnation with seq=${params.seq} found for worker ${params.worker_id}`)
  }

  const fingerprint = incarnationFingerprint({
    impl: incarnation.impl as WorkerImplId,
    seq: incarnation.seq,
    started_at: incarnationStartedAt(incarnation),
  })

  // ── cursor 解析与校验 ────────────────────────────────────────────
  let positions: TraceSourcePositions = { harness: 0, native: 0, legacy: 0 }
  let cursorRecord: import('./cursor-store.js').TraceCursorRecord | undefined
  if (params.cursor !== undefined) {
    cursorRecord = await deps.cursorStore.resolve(params.cursor, params.worker_id, fingerprint)
    positions = cursorRecord.positions
  } else {
    const token = await deps.cursorStore.mint(params.worker_id, fingerprint, positions)
    cursorRecord = await deps.cursorStore.resolve(token, params.worker_id, fingerprint)
  }

  // 重放窗口钳制（§8.12）：已有窗口的 token 重放不得越过首次消费捕获的 upper bound，
  // 否则后续追加的事件会重复进入下一次翻页。
  const replayBound = cursorRecord.window?.end

  // ── harness source（恒定可读；事件按化身过滤，位置=本化身已消费记录序）──
  const allHarnessEvents = (await deps.harness.readWorkerEvents(params.worker_id)).filter(
    (event) => event.seq === incarnation.seq,
  )
  const harnessLimit = replayBound ? Math.min(replayBound.harness, allHarnessEvents.length) : allHarnessEvents.length
  const harnessEvents: SourcedEvent[] = []
  let harnessEnd = positions.harness
  for (let index = positions.harness; index < harnessLimit; index++) {
    harnessEvents.push({ event: normalizeHarnessEvent(allHarnessEvents[index]), source: 'harness', sourceOrdinal: index })
    harnessEnd = index + 1
  }
  if (replayBound) harnessEnd = replayBound.harness

  // ── native / legacy source ──────────────────────────────────────
  const nativeEvents: SourcedEvent[] = []
  let nativeEnd = positions.native
  let legacyEnd = positions.legacy
  let unavailableReason: string | undefined

  if (isLegacyIncarnation(incarnation)) {
    const legacy = await readLegacyTraceEvents(deps.legacyTraceDir, worker.legacy_source?.trace_ids ?? [])
    const entries: LegacyTraceEventEntry[] = legacy.entries
    const legacyLimit = replayBound ? Math.min(replayBound.legacy, entries.length) : entries.length
    for (let index = positions.legacy; index < legacyLimit; index++) {
      const entry = entries[index]
      nativeEvents.push({ event: { ...entry.event, source: 'legacy' }, source: 'legacy', sourceOrdinal: index })
      legacyEnd = index + 1
    }
    if (replayBound) legacyEnd = replayBound.legacy
    if (legacy.unavailable_reason) unavailableReason = legacy.unavailable_reason
  } else {
    const adapter = deps.adapters.get(incarnation.impl)
    const handle: IncarnationHandle = {
      worker_id: params.worker_id,
      seq: incarnation.seq,
      impl: incarnation.impl,
      session_ref: incarnationSessionRef(incarnation) ?? '',
    }
    if (!adapter) {
      unavailableReason = `native unavailable: no adapter registered for impl ${incarnation.impl}`
    } else if (!adapter.readTrace) {
      unavailableReason = `native unavailable: impl ${incarnation.impl} has no structured trace`
    } else {
      try {
        const native = await adapter.readTrace(handle, { offset: positions.native })
        // 按行号位置过滤（归一化跳过的行也消费行号，不能用事件条数当行号钳制）。
        const upper = replayBound ? replayBound.native : Number.POSITIVE_INFINITY
        const inWindow = native.events.filter((event) => {
          const offset = event.source_offset
          return offset === undefined || (offset >= positions.native && offset < upper)
        })
        inWindow.forEach((event, ordinal) => {
          nativeEvents.push({ event: { ...event, source: 'native' }, source: 'native', sourceOrdinal: event.source_offset ?? (positions.native + ordinal) })
        })
        nativeEnd = replayBound ? replayBound.native : native.nextCursor.offset
        // 从头成功读取到的是该化身的完整 native 快照：替换旧 copy，使 adapter 归一化修复
        // 能回填历史保留副本。增量页仍按 source_offset 追加，不能覆盖完整副本。
        await deps.nativeCopy.append(params.worker_id, incarnation.seq, fingerprint, native.events, deps.redact, {
          replace: positions.native === 0 && !replayBound,
        })
      } catch (error) {
        // live source 不可用时回退 Agent-owned copy（终态收割/上次增量写入的结果）。
        const copied = await deps.nativeCopy.read(params.worker_id, incarnation.seq, fingerprint)
        if (copied !== null) {
          // copy 事件带原生行号（source_offset）：按行号区间取，而不是事件下标。
          const upper = replayBound ? replayBound.native : Number.POSITIVE_INFINITY
          const events = copied.events.filter((event) => {
            const offset = event.source_offset
            return offset !== undefined && offset >= positions.native && offset < upper
          })
          events.forEach((event, ordinal) => {
            nativeEvents.push({ event: { ...event, source: 'native' }, source: 'native', sourceOrdinal: event.source_offset ?? ordinal })
          })
          nativeEnd = replayBound
            ? replayBound.native
            : (events.length > 0 ? Math.max(...events.map((event) => event.source_offset ?? 0)) + 1 : positions.native)
          unavailableReason = `native degraded (served from agent-owned copy): ${message(error)}`
        } else {
          unavailableReason = `native unavailable: ${message(error)}`
        }
      }
    }
  }

  // ── 窗口与下一 cursor ───────────────────────────────────────────
  const end: TraceSourcePositions = { harness: harnessEnd, native: nativeEnd, legacy: legacyEnd }
  let nextToken: string
  if (cursorRecord.window) {
    // 重放既有窗口：复用首次消费捕获的 upper bound 与 next token（后续文件追加不影响）。
    nextToken = cursorRecord.window.nextToken
  } else {
    nextToken = await deps.cursorStore.mint(params.worker_id, fingerprint, end)
    await deps.cursorStore.captureWindow(cursorRecord.token, { end, nextToken })
  }

  const merged = sortSourcedEvents([...harnessEvents, ...nativeEvents]).map((entry) => {
    // source_offset 是内部钳制坐标，不进 REST/RPC response。
    const { source_offset: _dropped, ...event } = entry.event
    // 出参统一脱敏（§8.1「所有 detail 先脱敏」）：live 读与 copy 回退一致，
    // CLI native trace 原文里的已知 secret 不得经 REST 直出。
    return {
      ...event,
      summary: deps.redact(event.summary),
      ...(event.detail !== undefined ? { detail: redactDetail(event.detail, deps.redact) } : {}),
    }
  })
  return {
    events: merged,
    next_cursor: nextToken,
    ...(unavailableReason ? { unavailable_reason: unavailableReason } : {}),
  }
}

function incarnationSessionRef(incarnation: Incarnation): string | undefined {
  const value = (incarnation as { session_ref?: unknown }).session_ref
  return typeof value === 'string' ? value : undefined
}

function incarnationStartedAt(incarnation: Incarnation): string | undefined {
  const value = (incarnation as { started_at?: unknown }).started_at
  return typeof value === 'string' ? value : undefined
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function redactDetail(detail: unknown, redact: (text: string) => string): unknown {
  try {
    return JSON.parse(redact(JSON.stringify(detail)))
  } catch {
    return '[unserializable detail removed]'
  }
}

// 供调用方识别 INVALID_PARAMS 的显式再导出。
export { InvalidTraceCursorError }
