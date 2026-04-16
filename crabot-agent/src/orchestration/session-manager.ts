/**
 * Session Manager - 会话状态管理
 */

import type { SessionId } from 'crabot-shared'
import type { SessionState } from '../types.js'

export class SessionManager {
  private sessions: Map<string, SessionState> = new Map()
  private cleanupInterval?: ReturnType<typeof setInterval>

  constructor(private sessionTtl: number) {}

  /**
   * 获取会话状态
   */
  getSession(sessionId: SessionId): SessionState | undefined {
    return this.sessions.get(sessionId)
  }

  /**
   * 创建新会话
   */
  createSession(sessionId: SessionId): SessionState {
    const state: SessionState = {
      session_id: sessionId,
      last_message_time: Date.now(),
      message_count: 0,
    }
    this.sessions.set(sessionId, state)
    return state
  }

  /**
   * 获取或创建会话
   */
  getOrCreateSession(sessionId: SessionId): SessionState {
    return this.getSession(sessionId) ?? this.createSession(sessionId)
  }

  /**
   * 设置 pending request
   */
  setPendingRequest(sessionId: SessionId, requestId: string): void {
    const session = this.getOrCreateSession(sessionId)
    session.pending_request_id = requestId
  }

  /**
   * 清除 pending request
   */
  clearPendingRequest(sessionId: SessionId): void {
    const session = this.getSession(sessionId)
    if (session) {
      session.pending_request_id = undefined
    }
  }

  /**
   * 获取 pending request ID
   */
  getPendingRequest(sessionId: SessionId): string | undefined {
    return this.getSession(sessionId)?.pending_request_id
  }

  /**
   * 更新最后消息时间
   */
  updateLastMessageTime(sessionId: SessionId): void {
    const session = this.getOrCreateSession(sessionId)
    session.last_message_time = Date.now()
    session.message_count++
  }

  /**
   * 启动定期清理
   */
  startCleanup(): void {
    this.cleanupInterval = setInterval(() => {
      this.cleanup()
    }, this.sessionTtl * 1000)
  }

  /**
   * 停止定期清理
   */
  stopCleanup(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval)
      this.cleanupInterval = undefined
    }
  }

  /**
   * 清理过期会话
   */
  cleanup(): void {
    const now = Date.now()
    const ttlMs = this.sessionTtl * 1000

    for (const [sessionId, state] of this.sessions.entries()) {
      if (now - state.last_message_time > ttlMs) {
        this.sessions.delete(sessionId)
      }
    }
  }

  /**
   * 获取活跃会话数
   */
  getActiveSessionCount(): number {
    return this.sessions.size
  }

  /**
   * 获取有 pending request 的会话数
   */
  getPendingSessionCount(): number {
    let count = 0
    for (const state of this.sessions.values()) {
      if (state.pending_request_id) {
        count++
      }
    }
    return count
  }
}
