/**
 * MessageStore - 简化版消息历史存储
 *
 * 消息以 JSONL 格式按 session 存储到 data_dir/messages/<session-id>.jsonl
 */

import fs from 'node:fs'
import path from 'node:path'
import type { MessageType, HistoryMessage } from './types.js'

interface StoredMessage {
  platform_message_id: string
  sender_name: string
  sender_platform_user_id?: string
  content: string
  content_type: MessageType
  timestamp: string
  direction: 'inbound' | 'outbound'
}

export class MessageStore {
  private readonly messagesDir: string

  constructor(dataDir: string) {
    this.messagesDir = path.join(dataDir, 'messages')
    if (!fs.existsSync(this.messagesDir)) {
      fs.mkdirSync(this.messagesDir, { recursive: true })
    }
  }

  appendInbound(params: {
    sessionId: string
    platformMessageId: string
    senderName: string
    senderPlatformUserId: string
    text: string
    contentType: MessageType
    timestamp: string
  }): void {
    const msg: StoredMessage = {
      platform_message_id: params.platformMessageId,
      sender_name: params.senderName,
      sender_platform_user_id: params.senderPlatformUserId,
      content: params.text,
      content_type: params.contentType,
      timestamp: params.timestamp,
      direction: 'inbound',
    }
    this.append(params.sessionId, msg)
  }

  appendOutbound(params: {
    sessionId: string
    platformMessageId: string
    text: string
    contentType: MessageType
    timestamp: string
  }): void {
    const msg: StoredMessage = {
      platform_message_id: params.platformMessageId,
      sender_name: 'bot',
      content: params.text,
      content_type: params.contentType,
      timestamp: params.timestamp,
      direction: 'outbound',
    }
    this.append(params.sessionId, msg)
  }

  query(params: {
    sessionId: string
    keyword?: string
    limit?: number
    page?: number
    pageSize?: number
  }): { items: HistoryMessage[]; total: number } {
    const filePath = path.join(this.messagesDir, `${params.sessionId}.jsonl`)
    if (!fs.existsSync(filePath)) {
      return { items: [], total: 0 }
    }

    let messages: StoredMessage[]
    try {
      const lines = fs.readFileSync(filePath, 'utf-8').trim().split('\n').filter(Boolean)
      messages = lines.map((line) => JSON.parse(line) as StoredMessage)
    } catch {
      return { items: [], total: 0 }
    }

    // keyword filter
    if (params.keyword) {
      const kw = params.keyword.toLowerCase()
      messages = messages.filter((m) => m.content.toLowerCase().includes(kw))
    }

    const total = messages.length

    // limit mode
    if (params.limit) {
      messages = messages.slice(-params.limit)
    } else {
      // pagination mode
      const page = params.page ?? 1
      const pageSize = params.pageSize ?? 20
      const start = (page - 1) * pageSize
      messages = messages.slice(start, start + pageSize)
    }

    const items: HistoryMessage[] = messages.map((m) => ({
      platform_message_id: m.platform_message_id,
      sender_name: m.sender_name,
      sender_platform_user_id: m.sender_platform_user_id,
      content: m.content,
      content_type: m.content_type,
      timestamp: m.timestamp,
    }))

    return { items, total }
  }

  private append(sessionId: string, msg: StoredMessage): void {
    try {
      const filePath = path.join(this.messagesDir, `${sessionId}.jsonl`)
      fs.appendFileSync(filePath, JSON.stringify(msg) + '\n', 'utf-8')
    } catch (error) {
      console.error('[MessageStore] Failed to append message:', error)
    }
  }
}
