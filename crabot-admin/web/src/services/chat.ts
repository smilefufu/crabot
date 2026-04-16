/**
 * Chat WebSocket 服务
 */

import { storage } from '../utils/storage'
import { api } from './api'
import type { ChatMessage, ChatClientMessage, ChatServerMessage, ConnectionStatus } from '../types/chat'

type MessageHandler = (message: ChatServerMessage) => void
type StatusHandler = (status: ConnectionStatus) => void

class ChatWebSocketClient {
  private ws: WebSocket | null = null
  private messageHandlers: Set<MessageHandler> = new Set()
  private statusHandlers: Set<StatusHandler> = new Set()
  private reconnectAttempts = 0
  private maxReconnectAttempts = 5
  private reconnectDelay = 1000
  private _status: ConnectionStatus = 'disconnected'

  get status(): ConnectionStatus {
    return this._status
  }

  private setStatus(status: ConnectionStatus): void {
    this._status = status
    this.statusHandlers.forEach((handler) => handler(status))
  }

  connect(): void {
    const token = storage.getToken()
    if (!token) {
      this.setStatus('error')
      return
    }

    // 清理已有连接，防止旧连接的 onclose 覆盖新连接状态
    if (this.ws) {
      this.ws.onopen = null
      this.ws.onclose = null
      this.ws.onerror = null
      this.ws.onmessage = null
      this.ws.close()
      this.ws = null
    }

    // 构建 WebSocket URL
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const host = window.location.host
    const wsUrl = `${protocol}//${host}/ws/chat?token=${encodeURIComponent(token)}`

    this.setStatus('connecting')
    this.ws = new WebSocket(wsUrl)

    this.ws.onopen = () => {
      this.setStatus('connected')
      this.reconnectAttempts = 0
    }

    this.ws.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data) as ChatServerMessage
        this.messageHandlers.forEach((handler) => handler(message))
      } catch (error) {
        console.error('[ChatService] Failed to parse message:', error)
      }
    }

    this.ws.onclose = (event) => {
      this.setStatus('disconnected')

      // 如果不是正常关闭，尝试重连
      if (event.code !== 1000 && this.reconnectAttempts < this.maxReconnectAttempts) {
        this.reconnectAttempts++
        const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1)
        setTimeout(() => this.connect(), delay)
      }
    }

    this.ws.onerror = () => {
      this.setStatus('error')
    }
  }

  disconnect(): void {
    if (this.ws) {
      this.ws.close(1000, 'User disconnected')
      this.ws = null
    }
    this.setStatus('disconnected')
  }

  sendMessage(content: string): string {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket not connected')
    }

    const request_id = this.generateRequestId()
    const message: ChatClientMessage = {
      type: 'chat_message',
      request_id,
      content,
    }

    this.ws.send(JSON.stringify(message))
    return request_id
  }

  onMessage(handler: MessageHandler): () => void {
    this.messageHandlers.add(handler)
    return () => this.messageHandlers.delete(handler)
  }

  onStatusChange(handler: StatusHandler): () => void {
    this.statusHandlers.add(handler)
    return () => this.statusHandlers.delete(handler)
  }

  async loadHistory(limit = 30, before?: string): Promise<ChatMessage[]> {
    let url = `/chat/messages?limit=${limit}`
    if (before) url += `&before=${encodeURIComponent(before)}`
    const { messages } = await api.get<{ messages: ChatMessage[] }>(url)
    return messages
  }

  private generateRequestId(): string {
    return `req_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`
  }
}

export const chatService = new ChatWebSocketClient()