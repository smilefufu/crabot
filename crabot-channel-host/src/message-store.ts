/**
 * MessageStore - Session 消息历史存储（磁盘持久化）
 *
 * 按 session_id 分桶，每个 session 保留最近 200 条消息。
 * 数据持久化到 {dataDir}/message-history.json，写入时防抖。
 */

import fs from 'node:fs'
import path from 'node:path'
import type { SessionId, HistoryMessage, MessageType } from './types.js'

const MAX_MESSAGES_PER_SESSION = 200
const SAVE_DEBOUNCE_MS = 2000

export class MessageStore {
  private store: Map<SessionId, HistoryMessage[]> = new Map()
  private readonly dataPath: string
  private saveTimer: ReturnType<typeof setTimeout> | null = null

  constructor(dataDir: string) {
    this.dataPath = path.join(dataDir, 'message-history.json')
    this.loadFromDisk()
  }

  append(sessionId: SessionId, message: HistoryMessage): void {
    let messages = this.store.get(sessionId)
    if (!messages) {
      messages = []
      this.store.set(sessionId, messages)
    }
    messages.push(message)
    if (messages.length > MAX_MESSAGES_PER_SESSION) {
      this.store.set(sessionId, messages.slice(-MAX_MESSAGES_PER_SESSION))
    }
    this.scheduleSave()
  }

  appendInbound(params: {
    sessionId: SessionId
    platformMessageId: string
    senderName: string
    senderPlatformUserId?: string
    text: string
    contentType?: MessageType
    timestamp?: string
  }): void {
    this.append(params.sessionId, {
      platform_message_id: params.platformMessageId,
      sender_name: params.senderName,
      sender_platform_user_id: params.senderPlatformUserId,
      content: params.text,
      content_type: params.contentType ?? 'text',
      timestamp: params.timestamp ?? new Date().toISOString(),
    })
  }

  appendOutbound(params: {
    sessionId: SessionId
    platformMessageId: string
    text: string
    contentType?: MessageType
    timestamp?: string
  }): void {
    this.append(params.sessionId, {
      platform_message_id: params.platformMessageId,
      sender_name: 'Crabot',
      content: params.text,
      content_type: params.contentType ?? 'text',
      timestamp: params.timestamp ?? new Date().toISOString(),
    })
  }

  query(params: {
    sessionId: SessionId
    keyword?: string
    limit?: number
    timeRange?: { before?: string; after?: string }
    page?: number
    pageSize?: number
  }): { items: HistoryMessage[]; total: number } {
    let messages = this.store.get(params.sessionId) ?? []

    if (params.timeRange?.after) {
      const after = params.timeRange.after
      messages = messages.filter(m => m.timestamp >= after)
    }
    if (params.timeRange?.before) {
      const before = params.timeRange.before
      messages = messages.filter(m => m.timestamp <= before)
    }

    if (params.keyword) {
      const kw = params.keyword.toLowerCase()
      messages = messages.filter(m => m.content.toLowerCase().includes(kw))
    }

    const total = messages.length

    if (params.limit && !params.page) {
      return { items: messages.slice(-params.limit), total }
    }

    const page = params.page ?? 1
    const pageSize = params.pageSize ?? 20
    const start = (page - 1) * pageSize
    const end = start + pageSize
    return { items: messages.slice(start, end), total }
  }

  // ============================================================================
  // 磁盘持久化
  // ============================================================================

  private loadFromDisk(): void {
    if (!fs.existsSync(this.dataPath)) return
    try {
      const raw = fs.readFileSync(this.dataPath, 'utf-8')
      const data = JSON.parse(raw) as Record<string, HistoryMessage[]>
      for (const [sessionId, messages] of Object.entries(data)) {
        this.store.set(sessionId, messages)
      }
    } catch (error) {
      console.error('[MessageStore] Failed to load from disk:', error)
    }
  }

  private saveToDisk(): void {
    const data: Record<string, HistoryMessage[]> = {}
    for (const [sessionId, messages] of this.store.entries()) {
      data[sessionId] = messages
    }

    const dir = path.dirname(this.dataPath)
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }

    try {
      fs.writeFileSync(this.dataPath, JSON.stringify(data), 'utf-8')
    } catch (error) {
      console.error('[MessageStore] Failed to save to disk:', error)
    }
  }

  private scheduleSave(): void {
    if (this.saveTimer) return
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      this.saveToDisk()
    }, SAVE_DEBOUNCE_MS)
  }
}
