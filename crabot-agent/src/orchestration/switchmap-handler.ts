/**
 * SwitchMap Handler - switchMap 消息合并机制
 *
 * 同一 session 新消息到达时取消旧请求，确保只处理最新消息
 */

import type { SessionId } from '../core/base-protocol.js'
import type { RpcClient } from '../core/module-base.js'
import type { SessionManager } from './session-manager.js'

export class SwitchMapHandler {
  constructor(
    private sessionManager: SessionManager,
    private rpcClient: RpcClient,
    private moduleId: string,
    private getAdminPort: () => number | Promise<number>
  ) {}

  /**
   * 处理新消息到达
   * 如果同 session 有 pending request，取消旧请求并设置新的
   */
  async handleNewMessage(
    sessionId: SessionId,
    newRequestId: string
  ): Promise<void> {
    const pendingRequestId = this.sessionManager.getPendingRequest(sessionId)

    if (pendingRequestId) {
      await this.cancelRequest(pendingRequestId)
    }

    this.sessionManager.setPendingRequest(sessionId, newRequestId)
  }

  /**
   * 完成请求处理，清除 pending 状态
   */
  completeRequest(sessionId: SessionId, requestId: string): void {
    const currentPending = this.sessionManager.getPendingRequest(sessionId)
    if (currentPending === requestId) {
      this.sessionManager.clearPendingRequest(sessionId)
    }
  }

  /**
   * 取消旧请求
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
      // 取消失败不阻塞新消息处理，依赖 Agent 超时机制
    }
  }
}
