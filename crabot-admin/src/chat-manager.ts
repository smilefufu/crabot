/**
 * Chat Manager - 管理 Master 聊天功能
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { IncomingMessage } from 'node:http'
import { Socket } from 'node:net'
import { WebSocket, WebSocketServer } from 'ws'
import { generateId, generateTimestamp, type RpcClient, type TaskId } from 'crabot-shared'
import { MediaStore } from './media-store.js'
import type {
  ChatMessage,
  ChatClientMessage,
  ChatServerMessage,
  ChatCallbackParams,
  ChatCallbackResult,
  ChatSendMessageParams,
  ChatSendMessageResult,
  ChatTaskSnapshot,
  Task,
  MessageContent,
  MediaItem,
} from './types.js'

const IMAGE_MIME_BY_EXT: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
}

function inferImageMimeType(filenameOrPath: string | undefined): string | undefined {
  if (!filenameOrPath) return undefined
  return IMAGE_MIME_BY_EXT[path.extname(filenameOrPath).toLowerCase()]
}

export class ChatManager {
  private messages: Map<string, ChatMessage> = new Map()
  private wsServer: WebSocketServer | null = null
  private activeClient: WebSocket | null = null
  private pendingRequests: Map<string, { timestamp: number }> = new Map()
  private readonly messagesFilePath: string

  constructor(
    private readonly dataDir: string,
    private readonly rpcClient: RpcClient,
    private readonly resolveAgentPort: () => Promise<number>,
    private readonly jwtSecret: string,
    private readonly verifyJwt: (token: string, secret: string, dataDir: string) => Promise<unknown>,
    private readonly mediaStore: MediaStore,
  ) {
    this.messagesFilePath = path.join(dataDir, 'chat_messages.json')
  }

  // ==========================================================================
  // 数据持久化
  // ==========================================================================

  async loadData(): Promise<void> {
    try {
      const data = await fs.readFile(this.messagesFilePath, 'utf-8')
      // content 字段可能是旧格式（string），需要 hydrate 为 MessageContent
      const parsed = JSON.parse(data) as Array<Omit<ChatMessage, 'content'> & { content: string | MessageContent }>
      this.messages = new Map(parsed.map((m) => [
        m.message_id,
        {
          ...m,
          content: typeof m.content === 'string' ? { type: 'text' as const, text: m.content } : m.content,
        },
      ]))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error('[ChatManager] Failed to load messages:', error)
      }
    }
  }

  /**
   * 原子写入文件：先写临时文件，再 rename（避免进程被杀时文件损坏）
   */
  private async atomicWriteFile(filePath: string, content: string): Promise<void> {
    const tempPath = `${filePath}.tmp`
    await fs.writeFile(tempPath, content, 'utf-8')
    await fs.rename(tempPath, filePath)
  }

  async saveData(): Promise<void> {
    try {
      const data = Array.from(this.messages.values())
      await this.atomicWriteFile(this.messagesFilePath, JSON.stringify(data, null, 2))
    } catch (error) {
      console.error('[ChatManager] Failed to save messages:', error)
    }
  }

  // ==========================================================================
  // WebSocket 管理
  // ==========================================================================

  async handleUpgrade(req: IncomingMessage, socket: Socket, head: Buffer): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`)

    if (url.pathname !== '/ws/chat') {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n')
      socket.destroy()
      return
    }

    // JWT 认证
    const token = url.searchParams.get('token')
    let tokenValid = false
    try {
      tokenValid = !!(token && (await this.verifyJwt(token, this.jwtSecret, this.dataDir)))
    } catch {
      tokenValid = false
    }
    if (!tokenValid) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
      socket.destroy()
      return
    }

    // 创建 WebSocket 服务器（如果还没有）
    if (!this.wsServer) {
      this.wsServer = new WebSocketServer({ noServer: true })
    }

    // 升级连接
    this.wsServer.handleUpgrade(req, socket, head, (ws) => {
      // 关闭旧连接（单用户模式）
      if (this.activeClient && this.activeClient.readyState === WebSocket.OPEN) {
        this.activeClient.close(1000, 'New connection established')
      }

      this.activeClient = ws
      this.setupWebSocket(ws)
    })
  }

  private setupWebSocket(ws: WebSocket): void {
    ws.on('message', async (data) => {
      try {
        const message = JSON.parse(data.toString()) as ChatClientMessage
        await this.onMessage(message)
      } catch (error) {
        console.error('[ChatManager] Failed to handle message:', error)
        this.pushToClient({
          type: 'chat_error',
          error: 'Invalid message format',
        })
      }
    })

    ws.on('close', () => {
      if (this.activeClient === ws) {
        this.activeClient = null
      }
    })

    ws.on('error', (error) => {
      console.error('[ChatManager] WebSocket error:', error)
    })
  }

  private async onMessage(data: ChatClientMessage): Promise<void> {
    if (data.type !== 'chat_message') {
      this.pushToClient({
        type: 'chat_error',
        request_id: data.request_id,
        error: 'Unknown message type',
      })
      return
    }

    // 存储用户消息（WS 纯文本路径：content 字段包装为 MessageContent）
    const userMessage: ChatMessage = {
      message_id: generateId(),
      role: 'user',
      content: { type: 'text', text: data.content },
      request_id: data.request_id,
      timestamp: generateTimestamp(),
    }
    this.messages.set(userMessage.message_id, userMessage)
    await this.saveData()

    // WS 纯文本路径：agent 侧 content 与落库 content 相同
    await this.dispatchToAgent(userMessage, data.request_id, { type: 'text', text: data.content })
  }

  /**
   * 向 Agent 发送 process_message（入站双路径共用）。
   * pendingRequests.set / chat_status / rpcClient.call / catch 推 chat_error 全部在此。
   */
  private async dispatchToAgent(
    userMessage: ChatMessage,
    requestId: string,
    agentContent: MessageContent,
  ): Promise<void> {
    // 记录 pending request
    this.pendingRequests.set(requestId, { timestamp: Date.now() })

    // 推送处理中状态
    this.pushToClient({
      type: 'chat_status',
      request_id: requestId,
      status: 'processing',
    })

    // 调用 Agent process_message
    try {
      const agentPort = await this.resolveAgentPort()
      if (!agentPort) {
        throw new Error('Agent module not available')
      }

      await this.rpcClient.call(
        agentPort,
        'process_message',
        {
          message: {
            platform_message_id: userMessage.message_id,
            session: {
              session_id: 'admin-chat',
              channel_id: 'admin-web',
              type: 'private',
            },
            sender: {
              friend_id: 'master',
              platform_user_id: 'master',
              platform_display_name: 'Master',
            },
            content: agentContent,
            features: {
              is_mention_crab: false,
            },
            platform_timestamp: userMessage.timestamp,
          },
          source_type: 'admin_chat',
          callback_info: {
            source_module_id: 'admin-web',
            request_id: requestId,
          },
        },
        'admin-web'
      )
      // in-flight 窗口精确等于这次 RPC 的生命周期：`process_message` resolve 意味着 agent 侧
      // 的 episode 已经结束，不存在合法的迟到认领——manager 回话走的是 episode 内的
      // `send_message`（`unified-agent.processAdminChatMessage` 整段 await 了 episode），
      // 失败兜底走的是 episode 内的 `chat_callback`，两条都在这一行之前就把它删掉了，
      // 重复 delete 幂等。
      //
      // 不兜这一下的后果（PR #59 review）：agent 侧还有第四种收口——F3，episode 跑完但
      // 一句话没说（只记日志）。那条路上没有任何一方删 request_id，它会**永久**留在
      // pendingRequests 里；`claimPendingRequestId` 又是 FIFO 取最早那条，于是下一条回复
      // 认领的是那具残骸：回复带着旧 request_id 落库并 chat_push，前端把**旧问题**的占位
      // 换成**新问题**的答案，新问题的占位永远转圈——且此后每多一次沉默 episode 就整体
      // 再错一位，不自愈。
      this.pendingRequests.delete(requestId)
    } catch (error) {
      console.error('[ChatManager] Failed to call Agent:', error)
      this.pushToClient({
        type: 'chat_error',
        request_id: requestId,
        error: '系统暂时不可用，请稍后重试',
      })
      this.pendingRequests.delete(requestId)
    }
  }

  /** HTTP multipart 入口：文字 + N 附件一条消息（design：2026-06-10-master-chat-redesign Phase 2） */
  async handleInboundMessage(params: {
    request_id: string
    text: string
    files: Array<{ buffer: Buffer; filename: string; mime_type: string }>
  }): Promise<{ message: ChatMessage }> {
    const text = params.text.trim()
    if (!text && params.files.length === 0) {
      throw new Error('Empty message')
    }
    // 附件落 store，保留两个视图：URL 形态（落库/前端）与绝对路径形态（agent VLM 直读磁盘）
    const saved = await Promise.all(
      params.files.map((f) => this.mediaStore.saveBuffer(f.buffer, { filename: f.filename, mime_type: f.mime_type }))
    )
    const mediaForStore: MediaItem[] = saved.map((s) => s.item)
    const mediaForAgent: MediaItem[] = saved.map((s) => ({ ...s.item, media_url: s.abs_path }))
    const type = mediaForStore.length === 0
      ? ('text' as const)
      : mediaForStore.some((m) => m.mime_type.startsWith('image/'))
        ? ('image' as const)
        : ('file' as const)

    const userMessage: ChatMessage = {
      message_id: generateId(),
      role: 'user',
      content: {
        type,
        ...(text ? { text } : {}),
        ...(mediaForStore.length > 0 ? { media: mediaForStore, media_url: mediaForStore[0].media_url } : {}),
      },
      request_id: params.request_id,
      timestamp: generateTimestamp(),
    }
    this.messages.set(userMessage.message_id, userMessage)
    await this.saveData()

    await this.dispatchToAgent(userMessage, params.request_id, {
      type,
      ...(text ? { text } : {}),
      ...(mediaForAgent.length > 0 ? { media: mediaForAgent, media_url: mediaForAgent[0].media_url } : {}),
    })
    return { message: userMessage }
  }

  private pushToClient(message: ChatServerMessage): void {
    if (this.activeClient && this.activeClient.readyState === WebSocket.OPEN) {
      // send 在 OPEN→CLOSING 竞态下可能同步抛错；推送是 best-effort，
      // 不能让异常冒泡污染调用方（尤其任务状态机 applyStatusTransition 钩子）
      try {
        this.activeClient.send(JSON.stringify(message))
      } catch (error) {
        console.warn('[ChatManager] pushToClient failed:', error instanceof Error ? error.message : String(error))
      }
    }
  }

  // ==========================================================================
  // RPC 回调
  // ==========================================================================

  async handleChatCallback(params: ChatCallbackParams): Promise<ChatCallbackResult> {
    // 存储 assistant 消息（chat_callback 仍传 string content，包装为 MessageContent）
    const assistantMessage: ChatMessage = {
      message_id: generateId(),
      role: 'assistant',
      content: { type: 'text', text: params.content },
      request_id: params.request_id,
      task_id: params.task_id,
      timestamp: generateTimestamp(),
    }
    this.messages.set(assistantMessage.message_id, assistantMessage)
    await this.saveData()

    // 推送给客户端
    this.pushToClient({
      type: 'chat_reply',
      request_id: params.request_id,
      content: params.content,
      task_id: params.task_id,
      reply_type: params.reply_type,
      status: params.reply_type === 'task_failed' ? 'failed' : 'completed',
    })

    // 清理 pending request
    this.pendingRequests.delete(params.request_id)

    // 带任务关联的回执（task_created / supplement）：回填触发它的 user 消息，
    // 历史重载时消息级任务图标才有数据
    if (params.task_id) {
      await this.tagUserMessageByRequestId(params.request_id, params.task_id)
    }

    return { received: true }
  }

  // ==========================================================================
  // send_message（admin-web 伪 channel 入口，spec 2026-06-10-master-chat-redesign §4）
  // ==========================================================================

  async handleSendMessage(params: ChatSendMessageParams): Promise<ChatSendMessageResult> {
    // P4 manager additive（task-8-brief.md）：放开 'system-tasks'（protocol-agent-v3 §4.4
    // 保留的系统任务线程 key）以外的白名单不变——本分支 cutover 前没有任何调用方会传
    // session_id='system-tasks'，默认行为（只认 'admin-chat'）不受影响。
    if (params.session_id !== 'admin-chat' && params.session_id !== 'system-tasks') {
      throw new Error(`Unknown chat session: ${params.session_id}`)
    }
    const c = params.content
    if (c.type === 'system_event') {
      // system_event：text 是协议规定的人类可读 fallback，按纯文本落库
      return this.storeAssistantMessage({ type: 'text', text: c.text ?? '' }, params.session_id)
    }
    // 归一：media[] 权威；否则单 media_url / file_path 包装成单元素列表
    const incoming: Array<Pick<MessageContent, 'media_url' | 'file_path' | 'filename' | 'mime_type'>> =
      c.media?.length
        ? c.media.map((m) => ({ media_url: m.media_url, filename: m.filename, mime_type: m.mime_type }))
        : (c.media_url ?? c.file_path) ? [c] : []

    const media: MediaItem[] = []
    const failures: string[] = []
    for (const m of incoming) {
      try {
        if (m.media_url?.startsWith('http://') || m.media_url?.startsWith('https://')) {
          // http(s) URL：直接存引用，不下载
          media.push({
            media_url: m.media_url,
            mime_type: m.mime_type ?? 'application/octet-stream',
            ...(m.filename !== undefined ? { filename: m.filename } : {}),
          })
        } else {
          // 本地路径：复制进 MediaStore
          const localPath = m.file_path ?? m.media_url
          if (!localPath) continue
          const mimeType = m.mime_type
            ?? (c.type === 'image'
              ? inferImageMimeType(m.filename) ?? inferImageMimeType(localPath)
              : undefined)
          media.push(await this.mediaStore.ingestFile(localPath, {
            ...(m.filename !== undefined ? { filename: m.filename } : {}),
            ...(mimeType !== undefined ? { mime_type: mimeType } : {}),
          }))
        }
      } catch {
        failures.push(m.filename ?? m.file_path ?? m.media_url ?? '未知附件')
      }
    }

    const failureNote = failures.length > 0 ? `\n[附件收存失败: ${failures.join(', ')}]` : ''
    const text = `${c.text ?? ''}${failureNote}`.trim()
    if (!text && media.length === 0) {
      throw new Error('Empty message content')
    }
    const type = media.length === 0
      ? ('text' as const)
      : media.some((m) => m.mime_type.startsWith('image/')) ? ('image' as const) : ('file' as const)
    return this.storeAssistantMessage({
      type,
      ...(text ? { text } : {}),
      ...(media.length > 0 ? { media, media_url: media[0].media_url } : {}),
    }, params.session_id)
  }

  /**
   * 认领当前 in-flight 的 request_id 并消费掉（Map 保插入序，取最早那条——它最先被回答）。
   * manager 正常回话走 send_message → chat_push，前端要靠这个 id 才能把「处理中」占位气泡
   * 原地收口（失败兜底走 chat_reply，用的是同一把钥匙）。
   *
   * 「认领即消费」定死了一轮多条回复的语义：第一条替换占位，后续几条按新消息追加。
   * 没有 in-flight（manager 主动推送，不是在回应某条请求）时返回 undefined，前端纯追加。
   */
  private claimPendingRequestId(): string | undefined {
    const first = this.pendingRequests.keys().next()
    if (first.done) return undefined
    this.pendingRequests.delete(first.value)
    return first.value
  }

  private async storeAssistantMessage(
    content: MessageContent,
    sessionId: string,
  ): Promise<ChatSendMessageResult> {
    // 占位气泡只在 Master Chat（admin-chat）会话里存在；'system-tasks' 是另一条线程，
    // 不能吃掉 Master Chat 的 in-flight request
    const requestId = sessionId === 'admin-chat' ? this.claimPendingRequestId() : undefined
    const message: ChatMessage = {
      message_id: generateId(),
      role: 'assistant',
      content,
      ...(requestId !== undefined ? { request_id: requestId } : {}),
      timestamp: generateTimestamp(),
    }
    this.messages.set(message.message_id, message)
    await this.saveData()
    this.pushToClient({ type: 'chat_push', message })
    return { platform_message_id: message.message_id, sent_at: message.timestamp }
  }

  /** 任务状态/计划变更推送（index.ts 的状态机钩子调用） */
  pushTaskUpdate(snapshot: ChatTaskSnapshot): void {
    this.pushToClient({ type: 'chat_task_update', task: snapshot })
  }

  /**
   * 给已落库消息回填任务归属并广播（消息级任务图标的数据源）。
   * 返回是否命中。幂等：已是同 task_id 时不重写不重推。
   */
  async tagMessageTask(messageId: string, taskId: TaskId): Promise<boolean> {
    const msg = this.messages.get(messageId)
    if (!msg) return false
    if (msg.task_id === taskId) return true
    this.messages.set(messageId, { ...msg, task_id: taskId })
    await this.saveData()
    this.pushToClient({ type: 'chat_message_tagged', message_id: messageId, task_id: taskId })
    return true
  }

  /** 按 request_id 回填 user 消息的任务归属（chat_callback 带 task_id 时调用） */
  async tagUserMessageByRequestId(requestId: string, taskId: TaskId): Promise<void> {
    for (const msg of this.messages.values()) {
      if (msg.request_id === requestId && msg.role === 'user') {
        await this.tagMessageTask(msg.message_id, taskId)
        return
      }
    }
  }

  // ==========================================================================
  // 消息查询
  // ==========================================================================

  getMessages(limit: number, before?: string): ChatMessage[] {
    let messages = Array.from(this.messages.values())

    // 按时间倒序排序
    messages.sort((a, b) => b.timestamp.localeCompare(a.timestamp))

    // 过滤 before
    if (before) {
      messages = messages.filter((m) => m.timestamp < before)
    }

    // 限制数量
    return messages.slice(0, limit)
  }

  /** 删除单条消息并广播（返回是否命中） */
  async deleteMessage(messageId: string): Promise<boolean> {
    if (!this.messages.has(messageId)) return false
    this.messages.delete(messageId)
    await this.saveData()
    this.pushToClient({ type: 'chat_message_deleted', message_id: messageId })
    return true
  }

  async clearMessages(): Promise<void> {
    this.messages.clear()
    await this.saveData()
  }

  // ==========================================================================
  // 清理
  // ==========================================================================

  close(): void {
    if (this.activeClient) {
      this.activeClient.close(1000, 'Server shutting down')
      this.activeClient = null
    }
    if (this.wsServer) {
      this.wsServer.close()
      this.wsServer = null
    }
  }
}

/** Task → 状态卡快照（chat_task_update 推送与 GET /api/chat/tasks/:id 共用） */
export function buildChatTaskSnapshot(task: Task): ChatTaskSnapshot {
  const steps = task.plan?.steps ?? []
  const idx = task.plan?.current_step_index ?? 0
  const current = steps[idx]
  return {
    task_id: task.id,
    status: task.status,
    title: task.title,
    ...(current ? { step: { index: idx, total: steps.length, description: current.description } } : {}),
  }
}
