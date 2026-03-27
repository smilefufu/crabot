/**
 * SwitchMap Handler - switchMap 消息合并机制
 *
 * 同一 session 新消息到达时：
 * 1. 取消旧请求（best-effort）
 * 2. 将被中断的消息与新消息合并为一批
 * 3. 返回合并后的消息列表，供调用方以完整上下文重新处理
 *
 * @see protocol-agent-v2.md §5.1
 */

import type { SessionId } from '../core/base-protocol.js'
import type { RpcClient } from '../core/module-base.js'
import type { ChannelMessage } from '../types.js'
import type { SessionManager } from './session-manager.js'

export class SwitchMapHandler {
  /**
   * 每个 session 当前正在处理的消息批次
   * key: sessionId, value: 正在处理的所有消息（含此前被中断的）
   */
  private pendingBatches: Map<string, ChannelMessage[]> = new Map()

  constructor(
    private sessionManager: SessionManager,
    private rpcClient: RpcClient,
    private moduleId: string,
    private getAdminPort: () => number | Promise<number>
  ) {}

  /**
   * 处理新消息到达
   *
   * 如果同 session 有 pending request，取消旧请求并将被中断的消息合并到新批次中。
   * 返回合并后的消息列表（单条或多条），调用方应以此列表重新处理。
   */
  async handleNewMessage(
    sessionId: SessionId,
    newRequestId: string,
    newMessage: ChannelMessage
  ): Promise<ChannelMessage[]> {
    const pendingRequestId = this.sessionManager.getPendingRequest(sessionId)
    let mergedMessages = [newMessage]

    if (pendingRequestId) {
      await this.cancelRequest(pendingRequestId)
      // 将正在处理的消息批次与新消息合并
      const interrupted = this.pendingBatches.get(sessionId) ?? []
      if (interrupted.length > 0) {
        mergedMessages = [...interrupted, newMessage]
      }
    }

    this.sessionManager.setPendingRequest(sessionId, newRequestId)
    this.pendingBatches.set(sessionId, mergedMessages)
    return mergedMessages
  }

  /**
   * 完成请求处理，清除 pending 状态和消息批次
   */
  completeRequest(sessionId: SessionId, requestId: string): void {
    const currentPending = this.sessionManager.getPendingRequest(sessionId)
    if (currentPending === requestId) {
      this.sessionManager.clearPendingRequest(sessionId)
      this.pendingBatches.delete(sessionId)
    }
  }

  /**
   * 取消旧请求（best-effort，失败不阻塞新消息处理）
   */
  private async cancelRequest(requestId: string): Promise<void> {
    try {
      const adminPort = await this.getAdminPort()
      await this.rpcClient.call(
        adminPort,
        'cancel_task',
        { task_id: requestId },
        this.moduleId
      )
    } catch {
      // 取消失败不阻塞新消息处理
    }
  }
}
