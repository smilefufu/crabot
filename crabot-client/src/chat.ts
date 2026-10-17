import type { HttpClient, RequestOptions } from './http.js'
import { createRequestId } from './http.js'
import { ChatHistorySchema, ChatSendResultSchema, ChatTaskSnapshotSchema, ChatActiveTasksSchema, ChatInputMetadataSchema, z } from './contracts/index.js'

export interface ChatRequest {
  readonly request_id: string
  readonly text: string
  readonly files: readonly File[]
}

export function createChatRequest(text: string, files: readonly File[] = [], request_id = createRequestId()): ChatRequest {
  ChatInputMetadataSchema.parse({ request_id, text })
  if (!text.trim() && !files.length) throw new Error('Message cannot be empty')
  return Object.freeze({ request_id, text, files: Object.freeze([...files]) })
}

export class ChatClient {
  constructor(private readonly http: HttpClient) {}
  history(limit = 30, before?: string, options?: RequestOptions) {
    const query = new URLSearchParams({ limit: String(limit) })
    if (before) query.set('before', before)
    return this.http.request('/chat/messages?' + query, ChatHistorySchema, options)
  }
  task(taskId: string, options?: RequestOptions) {
    return this.http.request('/chat/tasks/' + encodeURIComponent(taskId), ChatTaskSnapshotSchema, options)
  }
  activeTasks(options?: RequestOptions) { return this.http.request('/chat/tasks', ChatActiveTasksSchema, options) }
  send(request: ChatRequest, options?: RequestOptions) {
    ChatInputMetadataSchema.parse(request)
    const body = new FormData()
    body.append('request_id', request.request_id)
    body.append('text', request.text)
    // A JSON string retains exact LF/CR; FormData scalar fields normalize newlines on the wire.
    body.append('text_json', JSON.stringify(request.text))
    for (const file of request.files) body.append('files', file, file.name)
    const headers = new Headers(options?.headers)
    headers.delete('Content-Type')
    // No automatic retry: the caller retains this exact request for retry/reconciliation.
    return this.http.request('/chat/messages', ChatSendResultSchema, { timeoutMs: 90_000, ...options, headers, requestId: request.request_id, method: 'POST', body })
  }
  delete(messageId: string, options?: RequestOptions) {
    return this.http.request('/chat/messages/' + encodeURIComponent(messageId), z.undefined(), { ...options, method: 'DELETE' })
  }
  clear(options?: RequestOptions) { return this.http.request('/chat/messages', z.undefined(), { ...options, method: 'DELETE' }) }
}
