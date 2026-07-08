/**
 * Memory Writer - 短期记忆写入器
 *
 * 写入跨 session、跨 channel 的系统级事件，不写聊天原文。
 * 与 ContextAssembler（读）形成对称的读写结构。
 *
 * @see crabot-docs/design-records/design-decisions.md §5.3
 */

import type { RpcClient } from 'crabot-shared'

interface MemoryWriteBase {
  visibility: 'private' | 'internal' | 'public'
  scopes: string[]
}

export interface WriteTaskFinishedParams extends MemoryWriteBase {
  task_id: string
  task_title: string
  outcome: 'completed' | 'failed'
  /** 简明摘要（≤200 字）；调用方负责长度截断 */
  outcome_brief: string
  /** 过程亮点（异常 / 兜底 / 关键决策），每条 ≤80 字最多 3 条；无亮点传 [] */
  process_highlights: string[]
  friend_name: string
  friend_id: string
  channel_id: string
  session_id: string
  trace_id?: string
}

export interface WriteUserSignalParams extends MemoryWriteBase {
  friend_name: string
  friend_id: string
  channel_id: string
  session_id: string
  /** 用户原话简要概述（≤80 字，调用方截取） */
  message_brief: string
  /** Front LLM 在 reply 工具里附带的 emotion；只有 frustrated/angry/dismissive 才会触发本写入 */
  emotion: 'unhappy' | 'frustrated' | 'angry' | 'dismissive'
  trace_id?: string
}

export interface QuickCaptureParams {
  type: 'fact' | 'lesson' | 'concept'
  brief: string
  content: string
  source_ref: { type: 'conversation' | 'reflection' | 'manual' | 'system'; task_id?: string; channel_id?: string; session_id?: string }
  entities: Array<{ type: string; id: string; name: string }>
  tags: string[]
  importance_factors: { proximity: number; surprisal: number; entity_priority: number; unambiguity: number }
  author?: string
}

export class MemoryWriter {
  constructor(
    private rpcClient: RpcClient,
    private moduleId: string,
    private getMemoryPort: () => number | Promise<number>
  ) {}

  /** Task 成功完成事件；失败任务只保留在 Admin task result / trace，不写跨 task 记忆。 */
  async writeTaskFinished(params: WriteTaskFinishedParams): Promise<void> {
    if (params.outcome !== 'completed') return

    const head = `任务 ${params.task_id}（${params.task_title}）完成：${params.outcome_brief}`

    const lines: string[] = [head]
    if (params.process_highlights.length > 0) {
      lines.push('', '过程亮点:')
      for (const h of params.process_highlights) {
        lines.push(`- ${h}`)
      }
    }
    const content = lines.join('\n')

    await this.write({
      content,
      source: { type: 'conversation' as const, channel_id: params.channel_id, session_id: params.session_id },
      refs: {
        task_id: params.task_id,
        friend_id: params.friend_id,
        session_id: params.session_id,
        channel_id: params.channel_id,
        ...(params.trace_id ? { trace_id: params.trace_id } : {}),
      },
      persons: [params.friend_name],
      entities: [params.task_id],
      topic: params.task_title,
      visibility: params.visibility,
      scopes: params.scopes,
    })
  }

  /** L1 写入：用户情绪信号（spec §6.1）；触发条件 = direct_reply 且 emotion 是负向 */
  async writeUserSignal(params: WriteUserSignalParams): Promise<void> {
    const channelLabel = params.channel_id === 'admin-web' ? 'Admin 管理聊天' : `频道 ${params.channel_id}`
    const content = `${params.friend_name} 在 ${channelLabel} 表达 ${params.emotion} 情绪：${params.message_brief}`
    await this.write({
      content,
      source: { type: 'conversation' as const, channel_id: params.channel_id, session_id: params.session_id },
      refs: {
        friend_id: params.friend_id,
        session_id: params.session_id,
        channel_id: params.channel_id,
        ...(params.trace_id ? { trace_id: params.trace_id } : {}),
      },
      persons: [params.friend_name],
      topic: `user_signal:${params.emotion}`,
      visibility: params.visibility,
      scopes: params.scopes,
    })
  }

  /** 快速捕获长期记忆候选，fire-and-forget */
  async quickCapture(params: QuickCaptureParams): Promise<void> {
    try {
      const memoryPort = await this.getMemoryPort()
      await this.rpcClient.call(
        memoryPort,
        'quick_capture',
        params,
        this.moduleId
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`[${this.moduleId}] Failed to quick_capture memory:`, message)
    }
  }

  /** 增加 lesson 使用计数，fire-and-forget */
  async bumpLessonUseCount(memId: string): Promise<void> {
    try {
      const memoryPort = await this.getMemoryPort()
      await this.rpcClient.call(
        memoryPort,
        'bump_lesson_use',
        { id: memId },
        this.moduleId
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`[${this.moduleId}] Failed to bump lesson use count:`, message)
    }
  }

  /** 触发记忆机械维护，fire-and-forget */
  async runMaintenance(scope: 'all' | 'observation_check' | 'stale_aging' | 'trash_cleanup' = 'all'): Promise<void> {
    try {
      const memoryPort = await this.getMemoryPort()
      await this.rpcClient.call(
        memoryPort,
        'run_maintenance',
        { scope },
        this.moduleId
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`[${this.moduleId}] Failed to run memory maintenance:`, message)
    }
  }

  /** 列出最近 N 天命中的 lesson（按 last_validated_at 排序，fire-and-forget 友好） */
  async listRecentLessons(windowDays: number = 1, limit: number = 20): Promise<ReadonlyArray<{ id: string; type: string }>> {
    try {
      const memoryPort = await this.getMemoryPort()
      const result = await this.rpcClient.call(
        memoryPort,
        'list_recent',
        { window_days: windowDays, type: 'lesson', limit },
        this.moduleId
      ) as { results?: Array<{ id: string; type: string }> } | undefined
      return result?.results ?? []
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`[${this.moduleId}] Failed to list recent lessons:`, message)
      return []
    }
  }

  /** 标记验证结果，fire-and-forget */
  async markValidationOutcome(memId: string, outcome: 'pass' | 'fail' | 'pending'): Promise<void> {
    try {
      const memoryPort = await this.getMemoryPort()
      await this.rpcClient.call(
        memoryPort,
        'update_long_term',
        { id: memId, patch: { validation_outcome: outcome } },
        this.moduleId
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`[${this.moduleId}] Failed to mark validation outcome:`, message)
    }
  }

  /**
   * Phase A (2026-04-25): 报告 task feedback，给该 task 期间引用的 lesson 累加 observation 投票计数。
   *
   * 求准策略 — 调用方（Front Handler 代码层）已确认 attitude 是明确信号才会调本方法。
   * fire-and-forget — RPC 失败不阻塞主流程。
   *
   * Spec: 2026-04-25-self-learning-feedback-signal-design.md §9.3
   */
  async reportTaskFeedback(
    taskId: string,
    attitude: 'strong_pass' | 'pass' | 'fail' | 'strong_fail',
  ): Promise<void> {
    try {
      const memoryPort = await this.getMemoryPort()
      await this.rpcClient.call(
        memoryPort,
        'report_task_feedback',
        { task_id: taskId, attitude },
        this.moduleId,
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`[${this.moduleId}] Failed to report task feedback:`, message)
    }
  }

  /** 底层写入方法，失败时静默 log 不抛出 */
  private async write(payload: {
    content: string
    source: { type: 'conversation' | 'reflection' | 'manual' | 'system'; channel_id?: string; session_id?: string }
    refs: Record<string, string>
    persons?: string[]
    entities?: string[]
    topic?: string
    visibility: 'private' | 'internal' | 'public'
    scopes: string[]
  }): Promise<void> {
    try {
      const memoryPort = await this.getMemoryPort()
      await this.rpcClient.call(
        memoryPort,
        'write_short_term',
        {
          ...payload,
          event_time: new Date().toISOString(),
        },
        this.moduleId
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`[${this.moduleId}] Failed to write short-term memory:`, message)
    }
  }
}
