/**
 * Memory Writer - 短期记忆写入器
 *
 * 写入跨 session、跨 channel 的系统级事件，不写聊天原文。
 * 与 ContextAssembler（读）形成对称的读写结构。
 *
 * @see crabot-docs/design-records/design-decisions.md §5.3
 */

import type { RpcClient } from '../core/module-base.js'

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
      refs: { task_id: params.task_id, friend_id: params.friend_id, session_id: params.session_id, channel_id: params.channel_id },
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
      refs: { task_id: params.task_id, friend_id: params.friend_id, session_id: params.session_id, channel_id: params.channel_id },
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

  /** 写入长期记忆，失败时静默 log 不抛出 */
  async writeLongTerm(params: {
    content: string
    category: string
    source?: { type: 'conversation' | 'reflection' | 'manual' | 'system'; task_id?: string; channel_id?: string; session_id?: string }
    importance?: number
    tags?: string[]
    metadata?: Record<string, unknown>
    visibility?: 'private' | 'internal' | 'public'
    scopes?: string[]
  }): Promise<void> {
    try {
      const memoryPort = await this.getMemoryPort()
      await this.rpcClient.call(
        memoryPort,
        'write_long_term',
        params,
        this.moduleId
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`[${this.moduleId}] Failed to write long-term memory:`, message)
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
