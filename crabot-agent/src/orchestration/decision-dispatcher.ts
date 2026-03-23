/**
 * Decision Dispatcher - 决策分发器
 *
 * 根据 Front Agent 的决策类型执行相应操作
 */

import type { ModuleId } from '../core/base-protocol.js'
import type { RpcClient } from '../core/module-base.js'
import type {
  MessageDecision,
  DirectReplyDecision,
  CreateTaskDecision,
  ForwardToWorkerDecision,
  ChannelMessage,
  MemoryPermissions,
} from '../types.js'
import { WorkerSelector } from './worker-selector.js'
import { ContextAssembler } from './context-assembler.js'

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
      message: ChannelMessage
      memoryPermissions: MemoryPermissions
      admin_chat_callback?: {
        source_module_id: string
        request_id: string
      }
    }
  ): Promise<{ task_id?: string }> {
    switch (decision.type) {
      case 'direct_reply':
        return this.handleDirectReply(decision, params)

      case 'create_task':
        return this.handleCreateTask(decision, params)

      case 'forward_to_worker':
        return this.handleForwardToWorker(decision, params)

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
    }
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
        this.moduleId
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
        this.moduleId
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
      message: ChannelMessage
      memoryPermissions: MemoryPermissions
      admin_chat_callback?: {
        source_module_id: string
        request_id: string
      }
    }
  ): Promise<{ task_id: string }> {
    // 1. 发送即时回复
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
        this.moduleId
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
        this.moduleId
      )
    }

    // 2. 创建任务
    const adminPort = await this.getAdminPort()
    const taskResult = await this.rpcClient.call<
      {
        title: string
        description: string
        task_type: string
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
        task_type: decision.task_type,
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
              friend_id: params.message.sender.friend_id,
            },
      },
      this.moduleId
    )

    const task = taskResult.task

    // 3. 选择 Worker
    const workerId = await this.workerSelector.selectWorker({
      task_type: decision.task_type,
      specialization_hint: decision.preferred_worker_specialization,
    })

    // 4. 组装 Worker 上下文
    const workerContext = await this.contextAssembler.assembleWorkerContext({
      channel_id: params.channel_id,
      session_id: params.session_id,
      sender_id: params.message.sender.platform_user_id,
      message: params.message.content.text ?? '',
      friend_id: params.message.sender.friend_id,
    }, params.memoryPermissions)

    // 5. 调用 Worker 执行任务
    const workers = await this.rpcClient.resolve({ module_id: workerId }, this.moduleId)
    if (workers.length === 0) {
      throw new Error(`Worker not found: ${workerId}`)
    }

    await this.rpcClient.call(
      workers[0].port,
      'execute_task',
      {
        task: {
          task_id: task.id,
          task_title: task.title,
          task_description: task.description,
          task_type: task.type,
          priority: task.priority,
          plan: task.plan,
        },
        context: workerContext,
      },
      this.moduleId
    )

    return { task_id: task.id }
  }

  /**
   * 处理转发到 Worker
   */
  private async handleForwardToWorker(
    decision: ForwardToWorkerDecision,
    params: {
      channel_id: ModuleId
      session_id: string
      message: ChannelMessage
      memoryPermissions: MemoryPermissions
      admin_chat_callback?: {
        source_module_id: string
        request_id: string
      }
    }
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
          this.moduleId
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
          this.moduleId
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
      this.moduleId
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
          messages: [params.message],
        },
        this.moduleId
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
          append_description: params.message.content.text,
        },
        this.moduleId
      )
      return { task_id: decision.task_id }
    }

    // 任务已完成/取消/失败，回退到创建新任务
    const fallbackDecision: CreateTaskDecision = {
      type: 'create_task',
      task_title: 'Follow-up request',
      task_description: params.message.content.text ?? '',
      task_type: 'user_request',
      immediate_reply: {
        type: 'text',
        text: 'Creating a new task for your follow-up request.',
      },
    }

    return this.handleCreateTask(fallbackDecision, params)
  }
}
