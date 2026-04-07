/**
 * Decision Dispatcher - 决策分发器
 *
 * 根据 Front Agent 的决策类型执行相应操作
 */

import type { ModuleId } from '../core/base-protocol.js'
import type { RpcClient, RpcTraceContext } from '../core/module-base.js'
import type {
  MessageDecision,
  DirectReplyDecision,
  CreateTaskDecision,
  SupplementTaskDecision,
  ChannelMessage,
  MemoryPermissions,
  Friend,
} from '../types.js'
import { WorkerSelector } from './worker-selector.js'
import { ContextAssembler } from './context-assembler.js'
import { MemoryWriter } from './memory-writer.js'

/** Admin create_task 返回的任务信息 */
interface AdminTask {
  id: string
  title: string
  description?: string
  type: string
  priority: string
  plan?: string
}

export class DecisionDispatcher {
  constructor(
    private rpcClient: RpcClient,
    private moduleId: string,
    private workerSelector: WorkerSelector,
    private contextAssembler: ContextAssembler,
    private memoryWriter: MemoryWriter,
    private getAdminPort: () => number | Promise<number>,
    private getChannelPort: (channelId: ModuleId) => Promise<number>
  ) {}

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

    // 2. 创建任务
    const adminPort = await this.getAdminPort()
    const taskResult = await this.rpcClient.call<
      {
        title: string
        description: string
        type: string
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
        type: decision.task_type,
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

    // 3. 选择 Worker
    const workerId = await this.workerSelector.selectWorker({
      task_type: decision.task_type,
      specialization_hint: decision.preferred_worker_specialization,
    })

    // 4. 组装 Worker 上下文
    const lastMessage = params.messages[params.messages.length - 1]
    const workerContext = await this.contextAssembler.assembleWorkerContext({
      channel_id: params.channel_id,
      session_id: params.session_id,
      sender_id: lastMessage.sender.platform_user_id,
      message: params.messages.map(m => m.content.text ?? '').join('\n'),
      friend_id: lastMessage.sender.friend_id,
    }, params.memoryPermissions)

    // 5. 异步调用 Worker 执行任务（fire-and-forget，不阻塞 Front）
    //    Worker 完成后更新 Admin 任务状态 + 回复用户
    const workers = await this.rpcClient.resolve({ module_id: workerId }, this.moduleId)
    if (workers.length === 0) {
      throw new Error(`Worker not found: ${workerId}`)
    }

    const enrichedContext = {
      ...workerContext,
      trigger_messages: params.messages,
      sender_friend: params.senderFriend,
      front_immediate_reply: replyText,
    }

    this.executeTaskInBackground(
      workers[0].port,
      task,
      enrichedContext,
      params
    )

    return { task_id: task.id }
  }

  /**
   * 后台执行任务：调用 Worker → 更新 Admin 任务状态 → 回复用户
   */
  private executeTaskInBackground(
    workerPort: number,
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
    }
  ): void {
    const run = async () => {
      const adminPort = await this.getAdminPort()

      // 推进任务状态：pending → planning → executing（遵循 Admin 状态机）
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
        // 调用 Worker 执行
        const result = await this.rpcClient.call<
          import('../types.js').ExecuteTaskParams,
          import('../types.js').ExecuteTaskResult
        >(
          workerPort,
          'execute_task',
          {
            task: {
              task_id: task.id,
              task_title: task.title,
              task_description: task.description ?? '',
              task_type: task.type,
              priority: task.priority,
              plan: task.plan,
            },
            context: workerContext,
          },
          this.moduleId
        )

        // 更新 Admin 任务状态 + 持久化 result
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

        // 写入短期记忆：Task 完成/失败事件（fire-and-forget）
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
        }).catch(() => {})

        // 回复用户（仅当 Worker 提供了 final_reply 时；进度流已发过的不重复）
        if (result.final_reply?.text) {
          await this.sendReplyToUser(result.final_reply.text, params)
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error)
        console.error(`[DecisionDispatcher] Background task ${task.id} failed: ${msg}`)

        // 更新任务为失败：executing → failed
        try {
          await this.rpcClient.call(
            adminPort,
            'update_task_status',
            { task_id: task.id, status: 'failed', error: msg },
            this.moduleId
          )
        } catch { /* best effort */ }

        // 回复用户失败信息
        await this.sendReplyToUser('任务处理失败，请稍后重试', params).catch(() => {})

        // 写入短期记忆：Task 失败事件（fire-and-forget）
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
   * 向用户发送回复（Channel 或 Admin Chat）
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
   * 处理补充任务指示
   *
   * 通过 Admin RPC 查找任务对应的 Worker，然后投递补充消息。
   * 统一处理本地和远程 Worker 场景。
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
    // Send immediate reply if provided
    if (decision.immediate_reply?.text) {
      const adminPort = await this.getAdminPort()
      if (params.admin_chat_callback) {
        await this.rpcClient.call(adminPort, 'chat_callback', {
          request_id: params.admin_chat_callback.request_id,
          reply_type: 'direct_reply',
          content: decision.immediate_reply.text,
        }, this.moduleId, traceCtx)
      } else {
        const channelPort = await this.getChannelPort(params.channel_id)
        await this.rpcClient.call(channelPort, 'send_message', {
          session_id: params.session_id,
          content: { type: 'text', text: decision.immediate_reply.text },
        }, this.moduleId, traceCtx)
      }
    }

    // Find worker via Admin and deliver supplement
    try {
      const adminPort = await this.getAdminPort()
      const taskResult = await this.rpcClient.call<
        { task_id: string },
        { task: { id: string; status: string; worker_agent_id?: string } }
      >(adminPort, 'get_task', { task_id: decision.task_id }, this.moduleId, traceCtx)
      const taskInfo = taskResult.task

      if (taskInfo.worker_agent_id && ['executing', 'planning'].includes(taskInfo.status)) {
        const workers = await this.rpcClient.resolve(
          { module_id: taskInfo.worker_agent_id }, this.moduleId,
        )
        if (workers.length > 0) {
          await this.rpcClient.call(workers[0].port, 'deliver_human_response', {
            task_id: decision.task_id,
            messages: [{
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
            }],
          }, this.moduleId, traceCtx)
        }
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      console.error(`[DecisionDispatcher] Failed to deliver supplement to task ${decision.task_id}: ${msg}`)
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
