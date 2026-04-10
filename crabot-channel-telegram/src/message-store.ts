/**
 * MessageStore - 本地消息存储
 *
 * 按 session 分文件，JSONL 格式存储。
 * 支持按时间和条数两个维度清理旧消息。
 *
 * 存储路径：DATA_DIR/messages/<session-id>.jsonl
 */

import fs from 'node:fs'
import path from 'node:path'
import type { StoredMessage, MessageType, TelegramCacheConfig } from './types.js'

const DEFAULT_CACHE_CONFIG: TelegramCacheConfig = {
  max_days: 30,
  max_messages_per_session: 1000,
}

const CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000 // 6 hours

export class MessageStore {
  private readonly messagesDir: string
  private readonly cacheConfig: TelegramCacheConfig
  private cleanupTimer: ReturnType<typeof setInterval> | null = null

  constructor(dataDir: string, cacheConfig?: Partial<TelegramCacheConfig>) {
    this.messagesDir = path.join(dataDir, 'messages')
    this.cacheConfig = { ...DEFAULT_CACHE_CONFIG, ...cacheConfig }
    fs.mkdirSync(this.messagesDir, { recursive: true })
  }

  startCleanup(): void {
    this.cleanup()
    this.cleanupTimer = setInterval(() => this.cleanup(), CLEANUP_INTERVAL_MS)
  }

  stopCleanup(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer)
      this.cleanupTimer = null
    }
  }

  appendInbound(params: {
    sessionId: string
    platformMessageId: string
    senderPlatformUserId: string
    senderName: string
    text: string
    contentType: MessageType
    mediaUrl?: string
    mimeType?: string
    filename?: string
    timestamp: string
  }): void {
    const record: StoredMessage = {
      platform_message_id: params.platformMessageId,
      direction: 'inbound',
      sender_platform_user_id: params.senderPlatformUserId,
      sender_name: params.senderName,
      content_type: params.contentType,
      text: params.text,
      media_url: params.mediaUrl,
      mime_type: params.mimeType,
      filename: params.filename,
      timestamp: params.timestamp,
    }
    this.appendRecord(params.sessionId, record)
  }

  appendOutbound(params: {
    sessionId: string
    platformMessageId: string
    text: string
    contentType: MessageType
    timestamp: string
  }): void {
    const record: StoredMessage = {
      platform_message_id: params.platformMessageId,
      direction: 'outbound',
      sender_platform_user_id: 'self',
      sender_name: 'Crabot',
      content_type: params.contentType,
      text: params.text,
      timestamp: params.timestamp,
    }
    this.appendRecord(params.sessionId, record)
  }

  query(params: {
    sessionId: string
    keyword?: string
    timeRange?: { before?: string; after?: string }
    page?: number
    pageSize?: number
  }): { items: StoredMessage[]; total: number } {
    const records = this.readRecords(params.sessionId)

    const afterMs = params.timeRange?.after ? new Date(params.timeRange.after).getTime() : null
    const beforeMs = params.timeRange?.before ? new Date(params.timeRange.before).getTime() : null
    const kw = params.keyword?.toLowerCase()

    const filtered = records.filter((r) => {
      if (afterMs !== null && new Date(r.timestamp).getTime() < afterMs) return false
      if (beforeMs !== null && new Date(r.timestamp).getTime() > beforeMs) return false
      if (kw && !r.text.toLowerCase().includes(kw)) return false
      return true
    })

    const total = filtered.length

    if (params.page !== undefined && params.pageSize !== undefined) {
      const start = (params.page - 1) * params.pageSize
      return { items: filtered.slice(start, start + params.pageSize), total }
    }

    return { items: filtered, total }
  }

  findByMessageId(sessionId: string, platformMessageId: string): StoredMessage | undefined {
    const records = this.readRecords(sessionId)
    return records.find((r) => r.platform_message_id === platformMessageId)
  }

  // ── 内部方法 ──────────────────────────────────────────────────────────────

  private sessionFilePath(sessionId: string): string {
    return path.join(this.messagesDir, `${sessionId}.jsonl`)
  }

  private appendRecord(sessionId: string, record: StoredMessage): void {
    const filePath = this.sessionFilePath(sessionId)
    const line = JSON.stringify(record) + '\n'
    fs.appendFileSync(filePath, line, 'utf-8')
  }

  private readRecords(sessionId: string): StoredMessage[] {
    return this.readRecordsFromPath(this.sessionFilePath(sessionId))
  }

  private readRecordsFromPath(filePath: string): StoredMessage[] {
    let content: string
    try {
      content = fs.readFileSync(filePath, 'utf-8').trim()
    } catch {
      return []
    }
    if (!content) return []

    const records: StoredMessage[] = []
    for (const line of content.split('\n')) {
      if (!line.trim()) continue
      try {
        records.push(JSON.parse(line) as StoredMessage)
      } catch {
        // 跳过损坏的行
      }
    }
    return records
  }

  private cleanup(): void {
    let files: string[]
    try {
      files = fs.readdirSync(this.messagesDir).filter((f) => f.endsWith('.jsonl'))
    } catch {
      return
    }

    const cutoffTime = Date.now() - this.cacheConfig.max_days * 24 * 60 * 60 * 1000

    for (const file of files) {
      const filePath = path.join(this.messagesDir, file)
      const records = this.readRecordsFromPath(filePath)

      let kept = records.filter((r) => new Date(r.timestamp).getTime() >= cutoffTime)

      if (kept.length > this.cacheConfig.max_messages_per_session) {
        kept = kept.slice(kept.length - this.cacheConfig.max_messages_per_session)
      }

      if (kept.length === 0) {
        fs.unlinkSync(filePath)
      } else if (kept.length < records.length) {
        const content = kept.map((r) => JSON.stringify(r)).join('\n') + '\n'
        fs.writeFileSync(filePath, content, 'utf-8')
      }
    }
  }
}
