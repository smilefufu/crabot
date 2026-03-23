/**
 * Memory Writer - 记忆写入器
 *
 * 封装对 Memory 模块的短期记忆写入，与 ContextAssembler（读）形成对称的读写结构。
 * 写入内容为要素齐全的事件叙述（时间 + 地点 + 人物 + 发生了什么），不是聊天记录。
 *
 * @see crabot-docs/protocols/protocol-memory.md 3.1 write_short_term
 */

import type { RpcClient } from '../core/module-base.js'

interface WriteConversationParams {
  friend_id: string
  channel_id: string
  session_id: string
  sender_name: string
  user_message: string
  agent_reply: string
  /** 写入 visibility（由调用方根据权限决策派生） */
  visibility: 'private' | 'internal' | 'public'
  /** 写入 scopes（由调用方根据权限决策派生） */
  scopes: string[]
}

export class MemoryWriter {
  constructor(
    private rpcClient: RpcClient,
    private moduleId: string,
    private getMemoryPort: () => number | Promise<number>
  ) {}

  /**
   * 将一次对话写入短期记忆，格式为事件叙述（时间+地点+人物+事件）。
   * 失败时静默 log，不抛出，避免影响主流程。
   */
  async writeConversation(params: WriteConversationParams): Promise<void> {
    const { friend_id, channel_id, session_id, sender_name, user_message, agent_reply, visibility, scopes } = params

    // 格式化时间（本地时间，用于人类可读）
    const eventTime = new Date().toISOString()
    const formattedTime = new Date(eventTime).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })
    const channelLabel = channel_id === 'admin-web' ? 'Admin 管理聊天' : `频道 ${channel_id}`

    // 事件叙述格式：时间 + 地点 + 人物 + 发生了什么
    const content = `${formattedTime}，${sender_name}（${friend_id}）在 ${channelLabel} 发送消息："${user_message}"。Crabot 回复："${agent_reply}"`

    try {
      const memoryPort = await this.getMemoryPort()
      await this.rpcClient.call(
        memoryPort,
        'write_short_term',
        {
          content,
          source: {
            type: 'conversation',
            channel_id,
            session_id,
          },
          event_time: eventTime,
          refs: { friend_id, session_id, channel_id },
          persons: [sender_name],
          visibility,
          scopes,
        },
        this.moduleId
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`[${this.moduleId}] Failed to write short-term memory:`, message)
    }
  }
}
