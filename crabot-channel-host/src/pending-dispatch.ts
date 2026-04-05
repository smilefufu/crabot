/**
 * PendingDispatch - 管理等待 Agent 回复的挂起请求
 *
 * 每条入站消息对应一个 PendingDispatch 条目，存储 deliver 回调。
 * Agent 调用 send_message 时取出 deliver 并调用，完成消息发送。
 */

import type { DeliverFn } from './types.js'

// ============================================================================
// 类型定义
// ============================================================================

export interface PendingDispatch {
  deliver: DeliverFn
  /** 释放 dispatch（不发送消息），用于 silent 等无回复场景 */
  release?: () => void
  sessionId: string
  createdAt: number
}

// ============================================================================
// PendingDispatchMap
// ============================================================================

export class PendingDispatchMap {
  private readonly map = new Map<string, PendingDispatch>()
  private readonly ttlMs = 5 * 60 * 1000 // 5 分钟 TTL

  /**
   * 存储一个挂起请求
   */
  set(sessionId: string, dispatch: { deliver: DeliverFn; release?: () => void }): void {
    this.map.set(sessionId, {
      deliver: dispatch.deliver,
      release: dispatch.release,
      sessionId,
      createdAt: Date.now(),
    })
  }

  /**
   * 获取挂起请求（不删除）
   */
  get(sessionId: string): PendingDispatch | undefined {
    return this.map.get(sessionId)
  }

  /**
   * 删除挂起请求
   */
  delete(sessionId: string): void {
    this.map.delete(sessionId)
  }

  /**
   * 清理超时条目（防止内存泄漏）
   */
  cleanup(): void {
    const now = Date.now()
    for (const [sessionId, dispatch] of this.map.entries()) {
      if (now - dispatch.createdAt > this.ttlMs) {
        this.map.delete(sessionId)
      }
    }
  }

  /**
   * 当前挂起数量
   */
  get size(): number {
    return this.map.size
  }
}
