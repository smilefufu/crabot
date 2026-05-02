/**
 * bg-entities trace helpers — emit point-in-time spans into the current task's
 * agent_loop trace.
 *
 * All span emissions are best-effort: errors are swallowed so that tracing
 * failures never interrupt spawn / exit / tool-call paths.
 *
 * Plan 3 Task 20: crabot-docs/superpowers/plans/2026-05-01-long-running-agent-plan-3.md
 */

import type { TraceStore } from '../../core/trace-store.js'
import type { AgentSpanType } from '../../types.js'

export interface BgEntityTraceContext {
  readonly traceStore: TraceStore
  readonly traceId: string
}

type BgSpanType = Extract<
  AgentSpanType,
  'bg_entity_spawn' | 'bg_entity_kill' | 'bg_entity_output' | 'bg_entity_exit'
>

/**
 * Emit a point-in-time (instant) span. Duration will be ~0ms.
 */
export function emitInstantSpan(
  ctx: BgEntityTraceContext,
  type: BgSpanType,
  details: Record<string, unknown>,
  status: 'completed' | 'failed' = 'completed',
): void {
  try {
    const span = ctx.traceStore.startSpan(ctx.traceId, {
      type,
      details: details as Parameters<TraceStore['startSpan']>[1]['details'],
    })
    ctx.traceStore.endSpan(ctx.traceId, span.span_id, status)
  } catch (err) {
    console.error(`[bg-entities] emit ${type} span failed:`, err)
  }
}

/**
 * Emit a span that started at `startedAtMs` and ends now.
 * Uses TraceStore.startSpan's `started_at_ms` back-dating support.
 */
export function emitDurationSpan(
  ctx: BgEntityTraceContext,
  type: Extract<BgSpanType, 'bg_entity_spawn' | 'bg_entity_exit'>,
  startedAtMs: number,
  details: Record<string, unknown>,
  status: 'completed' | 'failed' = 'completed',
): void {
  try {
    const span = ctx.traceStore.startSpan(ctx.traceId, {
      type,
      details: details as Parameters<TraceStore['startSpan']>[1]['details'],
      started_at_ms: startedAtMs,
    })
    ctx.traceStore.endSpan(ctx.traceId, span.span_id, status)
  } catch (err) {
    console.error(`[bg-entities] emit ${type} span failed:`, err)
  }
}
