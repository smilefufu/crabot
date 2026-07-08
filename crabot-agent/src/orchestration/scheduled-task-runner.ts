/**
 * Scheduled Task Runner - 调度任务执行器
 *
 * unified-agent.handleCreateTaskFromSchedule 触发的调度任务执行入口。
 * 其他决策（direct_reply / create_task / supplement_task / silent）已由 unified loop 直接处理，
 * 本模块仅负责 schedule 触发的任务。
 */

import { SYSTEM_SESSION, type RpcClient } from 'crabot-shared'
import type {
  ChannelMessage,
  ExecuteTaskParams,
  WorkerAgentContext,
} from '../types.js'
import type { AgentHandler } from '../agent/agent-handler.js'
import { MemoryWriter } from './memory-writer.js'
import { AgentLoopSubstrate } from './agent-loop-substrate.js'

/** Admin create_task 返回的任务信息 */
interface AdminTask {
  id: string
  title: string
  description?: string
  priority: string
  plan?: string
  task_type?: string
  /**
   * Schedule 目标会话（来自 Schedule.target_session 顶层字段）。
   * - 有值：ScheduledTaskRunner 用它填 trigger_message.session
   * - 无值：trigger_message.session 用 SYSTEM_SESSION 哨兵
   */
  target_session?: {
    channel_id: string
    session_id: string
    type: 'private' | 'group'
  }
}

export class ScheduledTaskRunner {
  constructor(
    private rpcClient: RpcClient,
    private moduleId: string,
    private memoryWriter: MemoryWriter,
    private getAdminPort: () => number | Promise<number>,
    private agentLoopSubstrate: AgentLoopSubstrate,
  ) {}

  /**
   * 设置本地 Worker Handler 引用（UnifiedAgent 在初始化 Worker 后调用）
   */
  setWorkerHandler(handler: AgentHandler): void {
    this.agentLoopSubstrate.setWorkerHandler(handler)
  }

  /**
   * 后台执行调度任务：无来源 channel，不发即时回复，仅更新 Admin 任务状态 + 写系统级短期记忆
   */
  executeScheduledTaskInBackground(
    task: AdminTask,
    workerContext: WorkerAgentContext,
    opts?: { resumeFrom?: ExecuteTaskParams['resumeFrom'] },
  ): void {
    const run = async () => {
      const adminPort = await this.getAdminPort()

      // 推进任务状态：pending → planning → executing
      // resume 路径（resumeFrom 存在）时任务已是 executing，跳过冗余转换，
      // 避免 executing→planning 不合法转换触发状态机拒绝日志。
      if (!opts?.resumeFrom) {
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
          console.error(`[ScheduledTaskRunner] Failed to transition scheduled task ${task.id} to executing: ${msg}`)
        }
      }

      // memory_maintenance 直接走 RPC，不经 Worker
      if (task.task_type === 'memory_maintenance') {
        try {
          await this.memoryWriter.runMaintenance('all')
          await this.rpcClient.call(
            adminPort,
            'update_task_status',
            {
              task_id: task.id,
              status: 'completed',
              result: {
                outcome: 'completed',
                summary: '记忆维护完成（observation_check / stale_aging / trash_cleanup）',
                finished_at: new Date().toISOString(),
              },
            },
            this.moduleId,
          )
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error)
          console.error(`[ScheduledTaskRunner] memory_maintenance task ${task.id} failed: ${msg}`)
          await this.rpcClient.call(
            adminPort,
            'update_task_status',
            {
              task_id: task.id,
              status: 'failed',
              result: { outcome: 'failed', summary: msg, finished_at: new Date().toISOString() },
              error: msg,
            },
            this.moduleId,
          ).catch(() => undefined)
        }
        return
      }

      // 构造 system_event trigger_message
      //   - target_session 有值 → session 用 schedule 目标
      //   - 无值（恢复任务 / 无目标 schedule） → session 用 SYSTEM_SESSION 哨兵
      //     （crab-messaging.send_message 拒收，worker 必须按文本走 send_master_private 等）
      const session = task.target_session
        ? {
            channel_id: task.target_session.channel_id as ChannelMessage['session']['channel_id'],
            session_id: task.target_session.session_id as ChannelMessage['session']['session_id'],
            type: task.target_session.type,
          }
        : {
            channel_id: SYSTEM_SESSION.channel_id,
            session_id: SYSTEM_SESSION.session_id,
            type: SYSTEM_SESSION.type,
          }

      const triggerMsg: ChannelMessage = {
        platform_message_id: `system:scheduled:${task.id}`,
        session,
        sender: {
          platform_user_id: 'crabot',
          platform_display_name: 'Crabot',
        },
        content: {
          type: 'system_event',
          event_type: 'scheduled',
          text: task.description ?? '',
        },
        features: { is_mention_crab: false },
        platform_timestamp: new Date().toISOString(),
      }

      try {
        const taskPayload: ExecuteTaskParams = {
          task: {
            task_id: task.id,
            task_title: task.title,
            priority: task.priority,
            plan: task.plan,
            task_type: task.task_type,
            source: { trigger_type: 'scheduled' },
          },
          context: {
            ...workerContext,
            trigger_messages: [triggerMsg],
          },
        }

        // worker handler 内部已完成：update_task_status + update_task_outcome + 记忆写入
        await this.agentLoopSubstrate.executeAgentLoop({
          ...taskPayload,
          related_task_id: task.id,
          ...(opts?.resumeFrom ? { resumeFrom: opts.resumeFrom } : {}),
        })
      } catch (error) {
        // worker handler 自身崩溃（throw）——兜底：标失败 + 写失败记忆
        const msg = error instanceof Error ? error.message : String(error)
        console.error(`[ScheduledTaskRunner] Background scheduled task ${task.id} failed: ${msg}`)

        try {
          await this.rpcClient.call(
            adminPort,
            'update_task_status',
            { task_id: task.id, status: 'failed', error: msg },
            this.moduleId
          )
        } catch { /* best effort */ }

        this.finalizeTaskMemory({
          taskId: task.id,
          taskTitle: task.title,
          outcome: 'failed',
          outcomeBrief: msg.slice(0, 200),
          processHighlights: [],
          friendName: 'system',
          friendId: '',
          channelId: '',
          sessionId: '',
          visibility: 'internal',
          scopes: [],
        })
      }
    }

    run().catch((err) => {
      console.error(`[ScheduledTaskRunner] Unexpected error in scheduled task: ${err}`)
    })
  }

  /**
   * worker handler 自身崩溃时的失败记忆兜底写入（短期 + 长期）。两者均 fire-and-forget。
   *
   * 成功路径的记忆已由 agent-handler.finalizeMemoryWrite 内部写入，dispatcher 不再重复。
   */
  private finalizeTaskMemory(args: {
    taskId: string
    taskTitle: string
    outcome: 'completed' | 'failed'
    outcomeBrief: string
    processHighlights: readonly string[]
    friendName: string
    friendId: string
    channelId: string
    sessionId: string
    visibility: 'private' | 'internal' | 'public'
    scopes: string[]
    traceId?: string
  }): void {
    const {
      taskId, taskTitle, outcome, outcomeBrief, processHighlights,
      friendName, friendId, channelId, sessionId, visibility, scopes, traceId,
    } = args

    this.memoryWriter.writeTaskFinished({
      task_id: taskId,
      task_title: taskTitle,
      outcome,
      outcome_brief: outcomeBrief,
      process_highlights: [...processHighlights],
      friend_name: friendName,
      friend_id: friendId,
      channel_id: channelId,
      session_id: sessionId,
      visibility,
      scopes,
      ...(traceId ? { trace_id: traceId } : {}),
    }).catch(() => {})

    const briefSrc = `${taskTitle} → ${outcomeBrief}`.slice(0, 80)
    const outcomeLabel = outcome === 'completed' ? '完成' : '失败'
    this.memoryWriter.quickCapture({
      type: 'lesson',
      brief: briefSrc,
      content: `任务 ${taskId}（${taskTitle}）${outcomeLabel}：${outcomeBrief}`,
      source_ref: { type: 'conversation', task_id: taskId, channel_id: channelId, session_id: sessionId },
      entities: [],
      tags: [`task_outcome:${outcome}`],
      importance_factors: {
        proximity: 0.6,
        surprisal: outcome === 'failed' ? 0.8 : 0.4,
        entity_priority: 0.5,
        unambiguity: 0.6,
      },
    }).catch(() => undefined)
  }
}
