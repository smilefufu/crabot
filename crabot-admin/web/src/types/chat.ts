/**
 * 聊天类型定义
 */

/** 单个媒体附件引用 */
export interface MediaItem {
  media_url: string
  mime_type: string
  filename?: string
  size?: number
}

/** 消息内容（对齐 protocol-admin §3.20 升级后的 ChatMessage.content） */
export interface ChatMessageContent {
  type: 'text' | 'image' | 'file' | 'system_event'
  text?: string
  media_url?: string
  media?: MediaItem[]
}

/** 聊天消息 */
export interface ChatMessage {
  message_id: string
  role: 'user' | 'assistant'
  content: ChatMessageContent
  /** 只读历史兼容（P6-A §11.14）；新写用 request_ids。 */
  request_id?: string
  /** P6-A §11：本条 assistant 消息结算的入站 request IDs（proactive 缺席）。 */
  request_ids?: string[]
  /** P6-A §11：本条 assistant 消息的 delivery 事务 ID。 */
  delivery_id?: string
  task_id?: string
  /** 人类输入已被 Agent 写入 Manager 会话历史的时间（chat_acknowledge 落盘，ISO 8601）；未打标省略。 */
  acknowledged_at?: string
  timestamp: string
}

/** 客户端发送的聊天消息（WS 保持纯文本，不变） */
export interface ChatClientMessage {
  type: 'chat_message'
  request_id: string
  content: string
}

/** 服务端发送的聊天消息 */
export type ChatServerMessage =
  | {
      type: 'chat_reply'
      request_id: string
      content: string
      task_id?: string
      reply_type: 'direct_reply' | 'task_created' | 'task_completed' | 'task_failed'
      status: 'completed' | 'failed'
    }
  | { type: 'chat_error'; request_id?: string; error: string }
  | { type: 'chat_push'; message: ChatMessage }
  | { type: 'chat_task_update'; task: ChatTaskSnapshot }
  | { type: 'chat_message_tagged'; message_id: string; task_id: string }
  | { type: 'chat_message_deleted'; message_id: string }
  | { type: 'chat_message_acked'; request_ids: string[] }

/** 任务状态快照（chat_task_update / GET /api/chat/tasks/:id） */
export interface ChatTaskSnapshot {
  task_id: string
  status: string
  title: string
  step?: { index: number; total: number; description: string }
  /** 载体停止的事实记录(status='halted'):给人看的文案由这里推导 */
  halt?: {
    halted_at: string
    halt_reason: string
    worker_self_report?: { outcome: 'completed' | 'failed'; summary: string }
    stop_unverified?: boolean
    detail?: string
  }
  /** 关闭信息(status='closed') */
  closed?: { at: string; by: string; note?: string }
}

/** WebSocket 连接状态 */
export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected' | 'error'
