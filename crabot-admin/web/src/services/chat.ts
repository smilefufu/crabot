import { ChatClient, ChatConnection, ClientError, createChatRequest, createRequestId } from 'crabot-client'
import { storage } from '../utils/storage'
import { getWebClient } from './api'

class ChatService extends ChatConnection {
  constructor() {
    super({
      url: () => {
        const token = storage.getToken()
        if (!token) throw new Error('Authentication required')
        const url = new URL('/ws/chat', window.location.origin)
        url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
        url.searchParams.set('token', token)
        return url.href
      },
      socket: url => new WebSocket(url),
    })
  }
  private get client() { return new ChatClient(getWebClient()) }
  async loadHistory(limit = 30, before?: string, signal?: AbortSignal) {
    return (await this.client.history(limit, before, { signal })).messages
  }
  async getTaskSnapshot(taskId: string, signal?: AbortSignal) {
    try { return await this.client.task(taskId, { signal }) }
    catch (error) { if (error instanceof ClientError && error.status === 404) return null; throw error }
  }
  async getActiveTasks() { return (await this.client.activeTasks()).tasks }
  async sendMessageWithAttachments(text: string, files: File[], requestId = createRequestId()) {
    const request = createChatRequest(text, files, requestId)
    const { message } = await this.client.send(request)
    return { message, request_id: request.request_id }
  }
  async sendMessage(text: string, requestId?: string) { return this.sendMessageWithAttachments(text, [], requestId) }
  deleteMessage(messageId: string) { return this.client.delete(messageId) }
  clearMessages() { return this.client.clear() }
  mediaSrc(mediaUrl: string) {
    if (mediaUrl.startsWith('http://') || mediaUrl.startsWith('https://')) return mediaUrl
    const token = storage.getToken()
    return token ? `${mediaUrl}?token=${encodeURIComponent(token)}` : mediaUrl
  }
}

export const chatService = new ChatService()
