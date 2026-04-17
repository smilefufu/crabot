/**
 * Decision Dispatcher - 决策分发器
 *
 * 根据 Front Agent 的决策类型执行相应操作。
 * Worker 在同一模块内，直接调用本地方法，不走 RPC。
 * 跨模块通信（Admin、Channel）通过 RPC。
 */

import type { ModuleId, RpcClient, RpcTraceContext } from 'crabot-shared'
import type {
  MessageDecision,
  DirectReplyDecision,
  CreateTaskDecision,
  SupplementTaskDecision,
  ChannelMessage,
  MemoryPermissions,
  Friend,
  ExecuteTaskParams,
  ExecuteTaskResult,
} from '../types.js'
import type { WorkerHandler } from '../agent/worker-handler.js'
import { ContextAssembler } from './context-assembler.js'
import { MemoryWriter } from './memory-writer.js'

/** Extended TraceStore interface with updateTrace support (not in base TraceStoreInterface) */
interface TraceStoreWithUpdate {
  updateTrace?(traceId: string, updates: { related_task_id?: string }): void
}

/** Admin create_task 返回的任务信息 */
interface AdminTask {
  id: string
  title: string
  description?: string
  priority: string
  plan?: string
  task_type?: string
}

export class DecisionDispatcher {
  private workerHandler: WorkerHandler | null = null

  constructor(
    private rpcClient: RpcClient,
    private moduleId: string,
    private contextAssembler: ContextAssembler,
    private memoryWriter: MemoryWriter,
    private getAdminPort: () => number | Promise<number>,
    private getChannelPort: (channelId: ModuleId) => Promise<number>,
    private executeTaskFn?: (params: ExecuteTaskParams & { related_task_id?: string }) => Promise<ExecuteTaskResult & { trace_id?: string }>,
  ) {}

  /**
   * 设置本地 Worker Handler 引用（UnifiedAgent 在初始化 Worker 后调用）
   */
  setWorkerHandler(handler: WorkerHandler): void {
    this.workerHandler = handler
  }

  /**
   * 分发决策
   */
  async dispatch(
    decision: MessageDecision,
    params: {
      channel_id: ModuleId
      session_id: string
      messages: ChannelMessage[]
      senderFriend?: Friend
      memoryPermissions: MemoryPermissions
      admin_chat_callback?: {
        source_module_id: string
        request_id: string
      }
    },
    traceCtx?: RpcTraceContext
  ): Promise<{ task_id?: string }> {
    switch (decision.type) {
      case 'direct_reply':
        return this.handleDirectReply(decision, params, traceCtx)

      case 'create_task':
        return this.handleCreateTask(decision, params, traceCtx)

      case 'silent':
        await this.releaseChannelDispatch(params.channel_id, params.session_id, traceCtx)
        return {}

      case 'supplement_task':
        return this.handleSupplementTask(decision, params, traceCtx)

      default:
        throw new Error(`Unknown decision type: ${(decision as { type: string }).type}`)
    }
  }

  /**
   * 处理直接回复
   */
  private async handleDirectReply(
    decision: DirectReplyDecision,
    params: {
      channel_id: ModuleId
      session_id: string
      admin_chat_callback?: {
        source_module_id: string
        request_id: string
      }
    },
    traceCtx?: RpcTraceContext
  ): Promise<{}> {
    if (params.admin_chat_callback) {
      // Admin Chat 回复
      const adminPort = await this.getAdminPort()
      await this.rpcClient.call(
        adminPort,
        'chat_callback',
        {
          request_id: params.admin_chat_callback.request_id,
          reply_type: 'direct_reply',
          content: decision.reply.text ?? '',
        },
        this.moduleId,
        traceCtx
      )
    } else {
      // Channel 回复
      const channelPort = await this.getChannelPort(params.channel_id)
      await this.rpcClient.call(
        channelPort,
        'send_message',
        {
          session_id: params.session_id,
          content: decision.reply,
        },
        this.moduleId,
        traceCtx
      )
    }

    return {}
  }

  /**
   * 处理创建任务
   */
  private async handleCreateTask(
    decision: CreateTaskDecision,
    params: {
      channel_id: ModuleId
      session_id: string
      messages: ChannelMessage[]
      senderFriend?: Friend
      memoryPermissions: MemoryPermissions
      admin_chat_callback?: {
        source_module_id: string
        request_id: string
      }
    },
    traceCtx?: RpcTraceContext
  ): Promise<{ task_id: string }> {
    if (!this.workerHandler) {
      throw new Error('Worker handler not configured')
    }

    // 1. 发送即时回复（如果有内容）
    const replyText = decision.immediate_reply?.text
    if (replyText) {
      if (params.admin_chat_callback) {
        const adminPort = await this.getAdminPort()
        await this.rpcClient.call(
          adminPort,
          'chat_callback',
          {
            request_id: params.admin_chat_callback.request_id,
            reply_type: 'task_created',
            content: replyText,
          },
          this.moduleId,
          traceCtx
        )
      } else {
        const channelPort = await this.getChannelPort(params.channel_id)
        await this.rpcClient.call(
          channelPort,
          'send_message',
          {
            session_id: params.session_id,
            content: decision.immediate_reply,
          },
          this.moduleId,
          traceCtx
        )
      }
    }

    // 2. 在 Admin 创建任务记录（跨模块 RPC）
    const adminPort = await this.getAdminPort()
    const taskResult = await this.rpcClient.call<
      {
        title: string
        description: string
        priority?: string
        source: {
          origin: string
          source_module_id: string
          channel_id?: string
          session_id?: string
          friend_id?: string
        }
      },
      { task: AdminTask }
    >(
      adminPort,
      'create_task',
      {
        title: decision.task_title,
        description: decision.task_description,
        priority: decision.priority,
        source: params.admin_chat_callback
          ? {
              origin: 'admin_chat',
              source_module_id: params.admin_chat_callback.source_module_id,
            }
          : {
              origin: 'human',
              source_module_id: params.channel_id,
              channel_id: params.channel_id,
              session_id: params.session_id,
              friend_id: params.messages[params.messages.length - 1].sender.friend_id,
            },
      },
      this.moduleId,
      traceCtx
    )

    const task = taskResult.task

    // Back-fill Front trace's related_task_id
    if (traceCtx?.traceStore && traceCtx.traceId) {
      const store = traceCtx.traceStore as TraceStoreWithUpdate
      store.updateTrace?.(traceCtx.traceId, { related_task_id: task.id })
    }

    // 3. 组装 Worker 上下文
    const lastMessage = params.messages[params.messages.length - 1]
    const sessionType = params.messages[0]?.session?.type ?? 'private'
    const workerContext = await this.contextAssembler.assembleWorkerContext({
      channel_id: params.channel_id,
      session_id: params.session_id,
      sender_id: lastMessage.sender.platform_user_id,
      message: params.messages.map(m => m.content.text ?? '').join('\n'),
      friend_id: lastMessage.sender.friend_id,
      session_type: sessionType,
    }, params.memoryPermissions)

    const enrichedContext = {
      ...workerContext,
      trigger_messages: params.messages,
      sender_friend: params.senderFriend,
      front_immediate_reply: replyText,
    }

    // 4. 直接调用本地 Worker 执行（fire-and-forget，不阻塞 Front）
    this.executeTaskInBackground(task, enrichedContext, params, task.id)

    return { task_id: task.id }
  }

  /**
   * 后台执行任务：本地 Worker 执行 → 更新 Admin 任务状态 → 回复用户
   */
  private executeTaskInBackground(
    task: AdminTask,
    workerContext: import('../types.js').WorkerAgentContext,
    params: {
      channel_id: ModuleId
      session_id: string
      messages: ChannelMessage[]
      senderFriend?: Friend
      memoryPermissions: MemoryPermissions
      admin_chat_callback?: {
        source_module_id: string
        request_id: string
      }
    },
    relatedTaskId: string,
  ): void {
    const run = async () => {
      const adminPort = await this.getAdminPort()

      // 推进任务状态：pending → planning → executing（Admin 跨模块 RPC）
      try {
        await this.rpcClient.call(
          adminPort, 'update_task_status',
          { task_id: task.id, status: 'planning' },
          this.moduleId
        )
        await this.rpcClient.call(
          adminPort, 'update_task_status',
          { task_id: task.id, status: 'executing' },
          this.moduleId
        )
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error(`[DecisionDispatcher] Failed to transition task ${task.id} to executing: ${msg}`)
      }

      try {
        // 直接调用本地 Worker（或通过回调函数）
        const taskPayload: ExecuteTaskParams = {
          task: {
            task_id: task.id,
            task_title: task.title,
            task_description: task.description ?? '',
            priority: task.priority,
            plan: task.plan,
            task_type: task.task_type,
          },
          context: workerContext,
        }

        const result: ExecuteTaskResult & { trace_id?: string } = this.executeTaskFn
          ? await this.executeTaskFn({ ...taskPayload, related_task_id: relatedTaskId })
          : await this.workerHandler!.executeTask(taskPayload)

        // 更新 Admin 任务状态（跨模块 RPC）
        const finalStatus = result.outcome === 'completed' ? 'completed' : 'failed'
        await this.rpcClient.call(
          adminPort,
          'update_task_status',
          {
            task_id: task.id,
            status: finalStatus,
            result: {
              outcome: result.outcome,
              summary: result.summary,
              final_reply: result.final_reply,
              finished_at: new Date().toISOString(),
            },
            ...(finalStatus === 'failed' && { error: result.summary }),
          },
          this.moduleId
        ).catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err)
          console.error(`[DecisionDispatcher] Failed to update task status: ${msg}`)
        })

        // 写入短期记忆（fire-and-forget）
        const friendName = params.senderFriend?.display_name ?? 'Unknown'
        const friendId = params.messages[params.messages.length - 1]?.sender?.friend_id ?? ''
        this.memoryWriter.writeTaskFinished({
          task_id: task.id,
          task_title: task.title,
          outcome: result.outcome,
          summary: result.summary,
          friend_name: friendName,
          friend_id: friendId,
          channel_id: params.channel_id,
          session_id: params.session_id,
          visibility: params.memoryPermissions.write_visibility,
          scopes: params.memoryPermissions.write_scopes,
          trace_id: result.trace_id,
        }).catch(() => {})

        // 回复用户（仅当 Worker 提供了 final_reply 时）
        if (result.final_reply?.text) {
          await this.sendReplyToUser(result.final_reply.text, params)
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error)
        console.error(`[DecisionDispatcher] Background task ${task.id} failed: ${msg}`)

        // 更新任务为失败
        try {
          await this.rpcClient.call(
            adminPort,
            'update_task_status',
            { task_id: task.id, status: 'failed', error: msg },
            this.moduleId
          )
        } catch { /* best effort */ }

        await this.sendReplyToUser('任务处理失败，请稍后重试', params).catch(() => {})

        const failFriendName = params.senderFriend?.display_name ?? 'Unknown'
        const failFriendId = params.messages[params.messages.length - 1]?.sender?.friend_id ?? ''
        this.memoryWriter.writeTaskFinished({
          task_id: task.id,
          task_title: task.title,
          outcome: 'failed',
          summary: msg,
          friend_name: failFriendName,
          friend_id: failFriendId,
          channel_id: params.channel_id,
          session_id: params.session_id,
          visibility: params.memoryPermissions.write_visibility,
          scopes: params.memoryPermissions.write_scopes,
        }).catch(() => {})
      }
    }

    run().catch((err) => {
      console.error(`[DecisionDispatcher] Unexpected error in background task: ${err}`)
    })
  }

  /**
   * 后台执行调度任务：无来源 channel，不发即时回复，仅更新 Admin 任务状态 + 写系统级短期记忆
   */
  executeScheduledTaskInBackground(
    task: AdminTask,
    workerContext: import('../types.js').WorkerAgentContext,
  ): void {
    const run = async () => {
      const adminPort = await this.getAdminPort()

      // 推进任务状态：pending → planning → executing
      try {
        await this.rpcClient.call(
          adminPort, 'update_task_status',
          { task_id: task.id, status: 'planning' },
          this.moduleId
        )
        await this.rpcClient.call(
          adminPort, 'update_task_status',
          { task_id: task.id, status: 'executing' },
          this.moduleId
        )
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error(`[DecisionDispatcher] Failed to transition scheduled task ${task.id} to executing: ${msg}`)
      }

      try {
        const taskPayload: ExecuteTaskParams = {
          task: {
            task_id: task.id,
            task_title: task.title,
            task_description: task.description ?? '',
            priority: task.priority,
            plan: task.plan,
            task_type: task.task_type,
          },
          context: workerContext,
        }

        const result: ExecuteTaskResult & { trace_id?: string } = this.executeTaskFn
          ? await this.executeTaskFn({ ...taskPayload, related_task_id: task.id })
          : await this.workerHandler!.executeTask(taskPayload)

        // 更新 Admin 任务状态
        const finalStatus = result.outcome === 'completed' ? 'completed' : 'failed'
        await this.rpcClient.call(
          adminPort,
          'update_task_status',
          {
            task_id: task.id,
            status: finalStatus,
            result: {
              outcome: result.outcome,
              summary: result.summary,
              final_reply: result.final_reply,
              finished_at: new Date().toISOString(),
            },
            ...(finalStatus === 'failed' && { error: result.summary }),
          },
          this.moduleId
        ).catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err)
          console.error(`[DecisionDispatcher] Failed to update scheduled task status: ${msg}`)
        })

        // 写入短期记忆（系统级参数）
        this.memoryWriter.writeTaskFinished({
          task_id: task.id,
          task_title: task.title,
          outcome: result.outcome,
          summary: result.summary,
          friend_name: 'system',
          friend_id: '',
          channel_id: '',
          session_id: '',
          visibility: 'internal',
          scopes: [],
          trace_id: result.trace_id,
        }).catch(() => {})

      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error)
        console.error(`[DecisionDispatcher] Background scheduled task ${task.id} failed: ${msg}`)

        // 更新任务为失败
        try {
          await this.rpcClient.call(
            adminPort,
            'update_task_status',
            { task_id: task.id, status: 'failed', error: msg },
            this.moduleId
          )
        } catch { /* best effort */ }

        this.memoryWriter.writeTaskFinished({
          task_id: task.id,
          task_title: task.title,
          outcome: 'failed',
          summary: msg,
          friend_name: 'system',
          friend_id: '',
          channel_id: '',
          session_id: '',
          visibility: 'internal',
          scopes: [],
        }).catch(() => {})
      }
    }

    run().catch((err) => {
      console.error(`[DecisionDispatcher] Unexpected error in scheduled task: ${err}`)
    })
  }

  /**
   * 向用户发送回复（Channel 或 Admin Chat，跨模块 RPC）
   */
  private async sendReplyToUser(
    text: string,
    params: {
      channel_id: ModuleId
      session_id: string
      admin_chat_callback?: {
        source_module_id: string
        request_id: string
      }
    }
  ): Promise<void> {
    if (params.admin_chat_callback) {
      const adminPort = await this.getAdminPort()
      await this.rpcClient.call(
        adminPort,
        'chat_callback',
        {
          request_id: params.admin_chat_callback.request_id,
          reply_type: 'task_completed',
          content: text,
        },
        this.moduleId
      )
    } else {
      const channelPort = await this.getChannelPort(params.channel_id)
      await this.rpcClient.call(
        channelPort,
        'send_message',
        {
          session_id: params.session_id,
          content: { type: 'text', text },
        },
        this.moduleId
      )
    }
  }

  /**
   * 处理补充/纠偏任务：直接调用本地 Worker 投递
   */
  private async handleSupplementTask(
    decision: SupplementTaskDecision,
    params: {
      channel_id: ModuleId
      session_id: string
      admin_chat_callback?: { source_module_id: string; request_id: string }
    },
    traceCtx?: RpcTraceContext,
  ): Promise<{ task_id?: string }> {
    if (!this.workerHandler) {
      throw new Error('Worker handler not configured')
    }

    // Back-fill Front trace's related_task_id
    if (traceCtx?.traceStore && traceCtx.traceId) {
      const store = traceCtx.traceStore as TraceStoreWithUpdate
      store.updateTrace?.(traceCtx.traceId, { related_task_id: decision.task_id })
    }

    // Step 1: 验证任务存在（本地 O(1) 查询）
    const taskExists = this.workerHandler.hasActiveTask(decision.task_id)

    // Step 2: 发送即时回复
    if (decision.immediate_reply?.text) {
      await this.sendReplyToUser(decision.immediate_reply.text, params)
    }

    // Step 3: 投递纠偏消息（本地直接调用）
    if (!taskExists) {
      console.error(`[DecisionDispatcher] Supplement target task ${decision.task_id} not found locally`)
      return { task_id: decision.task_id }
    }

    try {
      this.workerHandler.deliverHumanResponse(decision.task_id, [{
        platform_message_id: `supplement-${Date.now()}`,
        session: {
          channel_id: params.channel_id,
          session_id: params.session_id,
          type: 'private' as const,
        },
        sender: {
          friend_id: 'system',
          platform_user_id: 'system',
          platform_display_name: 'System',
        },
        content: {
          type: 'text' as const,
          text: `用户补充指示：${decision.supplement_content}`,
        },
        features: { is_mention_crab: false },
        platform_timestamp: new Date().toISOString(),
      }])
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      console.error(`[DecisionDispatcher] Failed to deliver supplement: ${msg}`)
    }

    return { task_id: decision.task_id }
  }

  /**
   * 通知 Channel 释放 pending dispatch（silent 等无回复场景）。
   * Admin Chat 不需要释放（没有 pending dispatch 机制）。
   */
  private async releaseChannelDispatch(
    channelId: ModuleId,
    sessionId: string,
    traceCtx?: RpcTraceContext
  ): Promise<void> {
    try {
      const channelPort = await this.getChannelPort(channelId)
      await this.rpcClient.call(
        channelPort,
        'complete_dispatch',
        { session_id: sessionId },
        this.moduleId,
        traceCtx
      )
    } catch {
      // Channel 可能不支持 complete_dispatch（如 admin-web），静默忽略
    }
  }
}
