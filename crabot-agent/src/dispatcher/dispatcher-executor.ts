/**
 * Dispatcher 动作执行器：按顺序执行 DispatchAction[]。
 *
 * 每个动作通过 ExecuteContext 注入的回调执行：
 * - supplement → pushSupplement 投递到 humanQueue；返回 fallback 时降级为 new_task
 *               （避免静默吃消息——schema 白名单已先拦了 LLM 编 task_id 的大多数 case，
 *                这里兜底处理 agent 进程内 activeTasks 与 dispatcher 看到的 admin
 *                snapshot 之间的 race 窗口）
 * - new_task   → spawnAgentInstance 启动 agent 实例
 * - stay_silent → discard（无副作用）
 *
 * 单个动作失败不阻塞后续动作。
 * 若 ExecuteContext.trace 已注入，每个动作执行前后写 dispatch_action span。
 *
 * Spec: crabot-docs/superpowers/specs/2026-05-19-prefront-dispatcher-design.md §3.4 §3.6 §6
 */

import type { DispatchAction, ExecuteContext, ImmediateReplySentInfo, TerminalSupplementResult } from './dispatcher-types.js'
import { formatMessageContent, EMPTY_MESSAGE_PLACEHOLDER } from '../agent/media-resolver.js'

/**
 * 取批次最后一条消息的 platform_message_id。空批次返回 null。
 * 选最后一条原因：人类视角"我刚说的最后一句话被接住了"最自然。
 */
function lastTriggerMessageId(ctx: ExecuteContext): string | null {
  const msgs = ctx.dispatchCtx.messages
  if (msgs.length === 0) return null
  return msgs[msgs.length - 1].platform_message_id
}

async function fireReaction(ctx: ExecuteContext): Promise<void> {
  if (!ctx.reactToTriggerMessage) return
  const id = lastTriggerMessageId(ctx)
  if (!id) return
  try {
    await ctx.reactToTriggerMessage(id)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.warn(`[dispatcher-executor] reactToTriggerMessage failed (non-fatal): ${msg}`)
  }
}

function renderCurrentHumanInput(ctx: ExecuteContext): string {
  const text = ctx.dispatchCtx.messages
    .map((m) => formatMessageContent(m))
    .filter((t) => t !== EMPTY_MESSAGE_PLACEHOLDER)
    .join('\n')
  return text || EMPTY_MESSAGE_PLACEHOLDER
}

export async function executeDispatchActions(
  actions: ReadonlyArray<DispatchAction>,
  ctx: ExecuteContext,
): Promise<void> {
  for (const action of actions) {
    // 写 dispatch_action span（若调用方注入了 trace callback）
    const span = ctx.trace?.startSpan({
      type: 'dispatch_action',
      details: buildActionSpanDetails(action),
    })

    try {
      if (action.kind === 'supplement') {
        const currentHumanInput = renderCurrentHumanInput(ctx)
        const target = ctx.dispatchCtx.activeTasks.find((t) => t.task_id === action.target_task_id)
        if (target?.candidate_kind === 'recent_terminal') {
          let revive: TerminalSupplementResult
          if (ctx.reviveTerminalSupplement) {
            try {
              revive = await ctx.reviveTerminalSupplement(action.target_task_id, currentHumanInput)
            } catch (err) {
              revive = {
                outcome: 'fallback' as const,
                reason: err instanceof Error ? err.message : String(err),
              }
            }
          } else {
            revive = { outcome: 'fallback' as const, reason: 'revive_callback_missing' }
          }
          if (revive.outcome === 'revived') {
            ctx.markSupplementLinkedToTask?.(action.target_task_id)
            if (span && ctx.trace) {
              ctx.trace.endSpan(span.span_id, 'completed', {
                outcome: 'terminal_task_revived',
                target_task_status: target.status,
                target_task_completed_at: target.completed_at,
                ...(revive.traceId ? { spawned_trace_id: revive.traceId } : {}),
              })
            }
            await fireReaction(ctx)
            continue
          }

          const { spawnedTraceId } = await ctx.spawnAgentInstance(currentHumanInput)
          if (span && ctx.trace) {
            ctx.trace.endSpan(span.span_id, 'completed', {
              outcome: 'supplement_fallback_recovered',
              recovered_via: 'new_task',
              spawned_trace_id: spawnedTraceId,
              attempted_target_task_id: action.target_task_id,
              target_task_status: target.status,
              target_task_completed_at: target.completed_at,
            })
          }
          await fireReaction(ctx)
          continue
        }

        const outcome = await ctx.pushSupplement(action.target_task_id)
        if (outcome === 'fallback') {
          const visibleIds = ctx.dispatchCtx.activeTasks.map((t) => t.task_id).join(', ') || '(empty)'
          console.warn(
            `[dispatcher-executor] supplement_fallback: target_task_id=${action.target_task_id} not in agent activeTasks; visible=${visibleIds} — falling back to new_task to avoid silently dropping the user message`,
          )
          const { spawnedTraceId } = await ctx.spawnAgentInstance(currentHumanInput)
          if (span && ctx.trace) {
            ctx.trace.endSpan(span.span_id, 'completed', {
              outcome: 'supplement_fallback_recovered',
              recovered_via: 'new_task',
              spawned_trace_id: spawnedTraceId,
              attempted_target_task_id: action.target_task_id,
            })
          }
        } else if (span && ctx.trace) {
          ctx.trace.endSpan(span.span_id, 'completed', { outcome: 'supplement_delivered' })
          ctx.markSupplementLinkedToTask?.(action.target_task_id)
        } else {
          ctx.markSupplementLinkedToTask?.(action.target_task_id)
        }
        await fireReaction(ctx)
      } else if (action.kind === 'new_task') {
        // 预回复（如果 dispatcher 判定复杂任务带了 immediate_reply）：
        // 1) 在 spawnAgentInstance 之前 await 一次 channel.send_message 把 ack 发给用户；
        // 2) 捕获 channel 返回的 platform_message_id / sent_at；
        // 3) 把 ack 元数据透给 spawnAgentInstance(spawnOptions.immediateReply)，
        //    让 spawn 实现拼成一条 outbound ChannelMessage 注入 worker 的 recent_messages，
        //    worker 第一轮 prompt 就能看到"自己刚发过这条 ack"，不会重复 ack。
        // 失败兜底：warn 不阻塞 spawn——预回复不是必发，worker 起来照常跑（语义降级为
        // "没发预回复"，会有重复 ack 的概率回升，但不会断流程）。
        // Spec: 2026-06-03-dispatcher-immediate-reply-and-overdue-removal-design.md
        let immediateReplyInfo: ImmediateReplySentInfo | undefined
        if (action.immediate_reply && ctx.sendImmediateReply) {
          try {
            immediateReplyInfo = await ctx.sendImmediateReply(action.immediate_reply)
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            console.warn(
              `[dispatcher-executor] sendImmediateReply failed (continuing to spawn worker without ack): ${msg}`,
            )
          }
        }
        const { spawnedTraceId } = await ctx.spawnAgentInstance(
          undefined,
          immediateReplyInfo ? { immediateReply: immediateReplyInfo } : undefined,
        )
        if (span && ctx.trace) {
          ctx.trace.endSpan(span.span_id, 'completed', {
            outcome: 'new_task_spawned',
            spawned_trace_id: spawnedTraceId,
            immediate_reply_sent: immediateReplyInfo !== undefined,
          })
        }
        await fireReaction(ctx)
      } else if (action.kind === 'stay_silent') {
        // 无副作用——attention scheduler 通过"是否有非 stay_silent 动作"判断退避
        if (span && ctx.trace) {
          ctx.trace.endSpan(span.span_id, 'completed', { outcome: 'silent_discard' })
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[dispatcher-executor] action ${action.kind} failed (continuing):`, msg)
      if (span && ctx.trace) {
        ctx.trace.endSpan(span.span_id, 'failed', { error: msg })
      }
    }
  }
}

function buildActionSpanDetails(action: DispatchAction): Record<string, unknown> {
  if (action.kind === 'supplement') {
    return {
      kind: action.kind,
      target_task_id: action.target_task_id,
    }
  }
  if (action.kind === 'new_task') {
    return {
      kind: action.kind,
    }
  }
  // stay_silent
  return {
    kind: action.kind,
    ...(action.reason != null ? { reason: action.reason } : {}),
  }
}
