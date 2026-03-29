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
  ForwardToWorkerDecision,
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

      case 'forward_to_worker':
        return this.handleForwardToWorker(decision, params, traceCtx)

      case 'silent':
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

        // 写入短期记忆：Task 完成/失败事件
        const friendName = params.senderFriend?.display_name ?? 'Unknown'
        const friendId = params.messages[params.messages.length - 1]?.sender?.friend_id ?? ''
        await this.memoryWriter.writeTaskFinished({
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
        })

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

        // 写入短期记忆：Task 失败事件
        const failFriendName = params.senderFriend?.display_name ?? 'Unknown'
        const failFriendId = params.messages[params.messages.length - 1]?.sender?.friend_id ?? ''
        await this.memoryWriter.writeTaskFinished({
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
        }).catch(() => {}) // best effort
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
   * 处理转发到 Worker
   */
  private async handleForwardToWorker(
    decision: ForwardToWorkerDecision,
    params: {
      channel_id: ModuleId
      session_id: string
      messages: ChannelMessage[]
      memoryPermissions: MemoryPermissions
      admin_chat_callback?: {
        source_module_id: string
        request_id: string
      }
    },
    traceCtx?: RpcTraceContext
  ): Promise<{ task_id: string }> {
    // 1. 发送即时回复（如果有）
    if (decision.immediate_reply) {
      if (params.admin_chat_callback) {
        const adminPort = await this.getAdminPort()
        await this.rpcClient.call(
          adminPort,
          'chat_callback',
          {
            request_id: params.admin_chat_callback.request_id,
            reply_type: 'task_created',
            content: decision.immediate_reply.text ?? '',
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

    // 2. 查询任务状态和分配的 Worker
    const adminPort = await this.getAdminPort()
    const taskInfo = await this.rpcClient.call<
      { task_id: string },
      {
        status: string
        assigned_worker?: string
      }
    >(
      adminPort,
      'get_task',
      { task_id: decision.task_id },
      this.moduleId,
      traceCtx
    )

    // 3. 根据任务状态处理
    if (['executing', 'planning', 'waiting_human'].includes(taskInfo.status)) {
      // 投递消息给 Worker
      if (!taskInfo.assigned_worker) {
        throw new Error('Task has no assigned worker')
      }

      const workers = await this.rpcClient.resolve(
        { module_id: taskInfo.assigned_worker },
        this.moduleId
      )
      if (workers.length === 0) {
        throw new Error(`Worker not found: ${taskInfo.assigned_worker}`)
      }

      await this.rpcClient.call(
        workers[0].port,
        'deliver_human_response',
        {
          task_id: decision.task_id,
          messages: params.messages,
        },
        this.moduleId,
        traceCtx
      )

      return { task_id: decision.task_id }
    }

    if (taskInfo.status === 'pending') {
      // 任务尚未分配 Worker，追加补充信息到描述
      await this.rpcClient.call(
        adminPort,
        'update_task',
        {
          task_id: decision.task_id,
          append_description: params.messages.map(m => m.content.text ?? '').join('\n'),
        },
        this.moduleId,
        traceCtx
      )
      return { task_id: decision.task_id }
    }

    // 任务已完成/取消/失败，回退到创建新任务
    const fallbackDecision: CreateTaskDecision = {
      type: 'create_task',
      task_title: 'Follow-up request',
      task_description: params.messages.map(m => m.content.text ?? '').join('\n'),
      task_type: 'user_request',
      immediate_reply: {
        type: 'text',
        text: 'Creating a new task for your follow-up request.',
      },
    }

    return this.handleCreateTask(fallbackDecision, params, traceCtx)
  }

  /**
   * 处理补充任务指示
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
    const adminPort = await this.getAdminPort()

    if (decision.confidence === 'low') {
      // Low confidence: ask user to confirm which task
      const confirmText = await this.buildConfirmationMessage(adminPort)
      if (params.admin_chat_callback) {
        await this.rpcClient.call(adminPort, 'chat_callback', {
          request_id: params.admin_chat_callback.request_id,
          reply_type: 'direct_reply',
          content: confirmText,
        }, this.moduleId, traceCtx)
      } else {
        const channelPort = await this.getChannelPort(params.channel_id)
        await this.rpcClient.call(channelPort, 'send_message', {
          session_id: params.session_id,
          content: { type: 'text', text: confirmText },
        }, this.moduleId, traceCtx)
      }
      return {}
    }

    // High confidence: send immediate reply then inject into worker
    if (decision.immediate_reply?.text) {
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

    // Find worker and deliver supplement
    try {
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
   * 构建任务确认消息（低置信度时列出活跃任务供用户选择）
   */
  private async buildConfirmationMessage(adminPort: number): Promise<string> {
    try {
      const result = await this.rpcClient.call<
        { status: string[] },
        { tasks: Array<{ task_id: string; title: string; status: string }> }
      >(adminPort, 'query_tasks', {
        status: ['executing', 'planning', 'waiting_human'],
      }, this.moduleId)

      if (result.tasks.length <= 1) {
        return '您是想调整当前正在执行的任务吗？请确认。'
      }

      const options = result.tasks
        .map((t, i) => `${i + 1}. 「${t.title}」(${t.status})`)
        .join('\n')
      return `您想调整哪个任务？\n${options}`
    } catch {
      return '您是想调整当前正在执行的任务吗？请确认。'
    }
  }
}
