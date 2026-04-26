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

export interface WriteTaskCreatedParams extends MemoryWriteBase {
  task_id: string
  task_title: string
  friend_name: string
  friend_id: string
  channel_id: string
  session_id: string
  worker_id?: string
  trace_id?: string
}

export interface WriteTaskFinishedParams extends MemoryWriteBase {
  task_id: string
  task_title: string
  outcome: 'completed' | 'failed'
  summary: string
  friend_name: string
  friend_id: string
  channel_id: string
  session_id: string
  trace_id?: string
}

export interface WriteTriageDecisionParams extends MemoryWriteBase {
  friend_name: string
  friend_id: string
  channel_id: string
  session_id: string
  /** 用户消息的简要概述（≤80字，调用方截取，不需要 LLM） */
  message_brief: string
  decision: 'direct_reply' | 'create_task' | 'supplement_task'
  task_id?: string
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

export interface ConfirmedSnapshotEntry { id: string; brief: string; tags: string[] }
export interface ConfirmedSnapshot {
  snapshot_id: string
  generated_at: string
  by_type: { fact: ConfirmedSnapshotEntry[]; lesson: ConfirmedSnapshotEntry[]; concept: ConfirmedSnapshotEntry[] }
}

export class MemoryWriter {
  constructor(
    private rpcClient: RpcClient,
    private moduleId: string,
    private getMemoryPort: () => number | Promise<number>
  ) {}

  /** Task 创建事件 */
  async writeTaskCreated(params: WriteTaskCreatedParams): Promise<void> {
    const workerLabel = params.worker_id ? `，分配给 ${params.worker_id}` : ''
    const content = `为 ${params.friend_name} 创建任务 ${params.task_id}：${params.task_title}${workerLabel}`

    await this.write({
      content,
      source: { type: 'conversation' as const, channel_id: params.channel_id, session_id: params.session_id },
      refs: { task_id: params.task_id, friend_id: params.friend_id, session_id: params.session_id, channel_id: params.channel_id, ...(params.trace_id ? { trace_id: params.trace_id } : {}) },
      persons: [params.friend_name],
      entities: [params.task_id],
      topic: params.task_title,
      visibility: params.visibility,
      scopes: params.scopes,
    })
  }

  /** Task 完成/失败事件 */
  async writeTaskFinished(params: WriteTaskFinishedParams): Promise<void> {
    const outcomeLabel = params.outcome === 'completed' ? '完成' : '失败'
    const content = `任务 ${params.task_id}（${params.task_title}）${outcomeLabel}：${params.summary}`

    await this.write({
      content,
      source: { type: 'conversation' as const, channel_id: params.channel_id, session_id: params.session_id },
      refs: { task_id: params.task_id, friend_id: params.friend_id, session_id: params.session_id, channel_id: params.channel_id, ...(params.trace_id ? { trace_id: params.trace_id } : {}) },
      persons: [params.friend_name],
      entities: [params.task_id],
      topic: params.task_title,
      visibility: params.visibility,
      scopes: params.scopes,
    })
  }

  /** 分诊决策事件 */
  async writeTriageDecision(params: WriteTriageDecisionParams): Promise<void> {
    const channelLabel = params.channel_id === 'admin-web' ? 'Admin 管理聊天' : `频道 ${params.channel_id}`
    let content: string

    switch (params.decision) {
      case 'direct_reply':
        content = `${params.friend_name} 在 ${channelLabel} 的消息（${params.message_brief}），直接回复`
        break
      case 'create_task':
        content = `${params.friend_name} 在 ${channelLabel} 发来请求（${params.message_brief}），创建任务 ${params.task_id ?? ''}`
        break
      case 'supplement_task':
        content = `${params.friend_name} 对任务 ${params.task_id ?? ''} 发来纠偏/补充（${params.message_brief}）`
        break
    }

    await this.write({
      content,
      source: { type: 'conversation' as const, channel_id: params.channel_id, session_id: params.session_id },
      refs: {
        friend_id: params.friend_id,
        session_id: params.session_id,
        channel_id: params.channel_id,
        ...(params.task_id ? { task_id: params.task_id } : {}),
      },
      persons: [params.friend_name],
      topic: params.message_brief,
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

  /** 获取已确认快照，失败时返回 null */
  async fetchConfirmedSnapshot(): Promise<ConfirmedSnapshot | null> {
    try {
      const memoryPort = await this.getMemoryPort()
      const result = await this.rpcClient.call<Record<string, unknown>, Record<string, unknown>>(
        memoryPort,
        'get_confirmed_snapshot',
        {},
        this.moduleId
      )
      return ((result?.['data'] ?? result) as unknown) as ConfirmedSnapshot
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`[${this.moduleId}] Failed to fetch confirmed snapshot:`, message)
      return null
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
