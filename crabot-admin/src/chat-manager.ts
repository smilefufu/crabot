/**
 * Chat Manager - 管理 Master 聊天功能
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { IncomingMessage } from 'node:http'
import { Socket } from 'node:net'
import { WebSocket, WebSocketServer } from 'ws'
import { generateId, generateTimestamp, sha256CanonicalJson, type RpcClient, type TaskId } from 'crabot-shared'
import { createHash } from 'node:crypto'
import { AdminChatAssertions } from './admin-chat-assertions.js'
import { ChatRequestIndex } from './chat-request-index.js'
import { ChatDeliveryJournalStore, type ChatDeliveryJournalRecord } from './chat-delivery-journal.js'
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

/** P6-A §11.1：WS 与 multipart 共用的入站指纹（exact text 不 normalize；附件按请求顺序）。 */
function computeInboundFingerprintV1(input: {
  text: string
  files: Array<{ buffer: Buffer; filename: string; mime_type: string }>
}): string {
  return createHash('sha256').update(JSON.stringify({
    v: 1,
    text: input.text,
    attachments: input.files.map((file) => ({
      sha256: createHash('sha256').update(file.buffer).digest('hex'),
      size: file.buffer.length,
      filename: file.filename,
      mime_type: file.mime_type ? file.mime_type.toLowerCase() : null,
    })),
  })).digest('hex')
}

/** 发给 Agent 的 ChannelMessage（Admin 构造的 exact wire shape，首次生成后固定）。 */
interface AgentBoundChannelMessage {
  platform_message_id: string
  session: { session_id: string; channel_id: string; type: 'private' }
  sender: { friend_id: string; platform_user_id: string; platform_display_name: string }
  content: MessageContent
  features: { is_mention_crab: boolean }
  platform_timestamp: string
}

/** 入站 dispatch outbox journal 记录（§3.4）。 */
interface InboundDispatchJournalRecord {
  readonly kind: 'admin_chat_inbound_dispatch'
  readonly request_id: string
  /** 首次生成后固定的完整 Agent ChannelMessage（每次 attempt 原样重放）。 */
  readonly message: AgentBoundChannelMessage
  /** 入站 fingerprint（§11.3）：reconcile 自愈 index 需要原值重放。 */
  readonly fingerprint: string
  attempt: number
  status: 'pending_dispatch' | 'agent_accepted' | 'expired'
  readonly created_at: string
}

/** request_id 是前端可控字符串且用作 journal 文件名——必须是无路径分隔符的安全形态。 */
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

function assertValidRequestId(requestId: string): void {
  if (!REQUEST_ID_PATTERN.test(requestId)) {
    const error = new Error(`invalid request_id: ${requestId}`)
    ;(error as { code?: string }).code = 'ADMIN_CHAT_INVALID_REQUEST_ID'
    throw error
  }
}

export class ChatManager {
  private messages: Map<string, ChatMessage> = new Map()
  private wsServer: WebSocketServer | null = null
  private activeClient: WebSocket | null = null
  private readonly messagesFilePath: string
  private readonly assertions: AdminChatAssertions
  /** P6-A §3.4：request 级 CAS 真相源（fingerprint 幂等/冲突判据）。 */
  private readonly requestIndex: ChatRequestIndex
  /** P6-A §3.4/§11.8：delivery 事务 journal（prepared/committing/committed/rolled_back）。 */
  private readonly deliveryJournal: ChatDeliveryJournalStore

  constructor(
    private readonly dataDir: string,
    private readonly rpcClient: RpcClient,
    private readonly resolveAgentPort: () => Promise<number>,
    private readonly jwtSecret: string,
    private readonly verifyJwt: (token: string, secret: string, dataDir: string) => Promise<unknown>,
    private readonly mediaStore: MediaStore,
  ) {
    this.messagesFilePath = path.join(dataDir, 'chat_messages.json')
    this.assertions = new AdminChatAssertions(dataDir, jwtSecret)
    this.requestIndex = new ChatRequestIndex(dataDir)
    this.deliveryJournal = new ChatDeliveryJournalStore(dataDir)
  }

  // ==========================================================================
  // 数据持久化
  // ==========================================================================

  async loadData(): Promise<void> {
    await this.assertions.load()
    await this.requestIndex.load()
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

    // P6-A §11.2-4：先 fingerprint CAS 判重，再入站事务（message+index+outbox journal）。
    const admission = await this.admitInbound({
      request_id: data.request_id,
      text: data.content,
      files: [],
      agentContent: { type: 'text', text: data.content },
      storeContent: { type: 'text', text: data.content },
    })
    if (admission.kind === 'duplicate') return
    if (admission.kind === 'conflict') {
      this.pushToClient({ type: 'chat_error', request_id: data.request_id, error: 'request_id 已被不同内容占用（409）' })
      return
    }
  }

  // ==========================================================================
  // P6-A §11：入站 CAS + dispatch outbox
  // ==========================================================================

  private inboundJournalPath(requestId: string): string {
    assertValidRequestId(requestId)
    return path.join(this.dataDir, 'chat-inbound-dispatch-journal', `${requestId}.json`)
  }

  private async readInboundJournal(requestId: string): Promise<InboundDispatchJournalRecord | null> {
    try {
      const raw = await fs.readFile(this.inboundJournalPath(requestId), 'utf-8')
      return JSON.parse(raw) as InboundDispatchJournalRecord
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }

  private async writeInboundJournal(record: InboundDispatchJournalRecord): Promise<void> {
    const filePath = this.inboundJournalPath(record.request_id)
    await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 })
    const tmpPath = `${filePath}.tmp-${generateId()}`
    await fs.writeFile(tmpPath, JSON.stringify(record), { mode: 0o600 })
    await fs.rename(tmpPath, filePath)
  }

  /**
   * 入站统一判准（WS 纯文本 + HTTP multipart 共用）：
   * per-request mutex 内、任何 MediaStore promotion/chat 写入之前计算 fingerprint 并查 index。
   * exact duplicate → duplicate（零 media/chat/index mutation，不触发第二 loop、不停止已有
   * pending loop）；同 ID 不同 fingerprint/session → conflict（409，零 mutation）；
   * 新请求 → user message/placeholder、request index、完整 inbound dispatch outbox 作为
   * crash-recoverable 事务提交，然后起 dispatch loop。
   */
  private async admitInbound(params: {
    request_id: string
    text: string
    files: Array<{ buffer: Buffer; filename: string; mime_type: string }>
    storeContent: MessageContent
    agentContent: MessageContent
  }): Promise<{ kind: 'admitted'; message: ChatMessage } | { kind: 'duplicate' } | { kind: 'conflict' }> {
    assertValidRequestId(params.request_id)
    return this.requestIndex.withMutex(params.request_id, async () => {
      const fingerprint = computeInboundFingerprintV1({ text: params.text, files: params.files })
      let verdict: Awaited<ReturnType<ChatRequestIndex['check']>>
      try {
        verdict = await this.requestIndex.check({
          request_id: params.request_id,
          session_id: 'admin-chat',
          fingerprint,
        })
      } catch {
        return { kind: 'conflict' }
      }
      if (verdict.kind === 'duplicate') return { kind: 'duplicate' }

      // crash-recoverable 事务顺序（P6-A §11.3）：journal → user message → index。
      // 崩在 index 之前：journal 自持完整可重放载荷，startup reconcile 重放 dispatch；
      // 崩在 journal 之前：零副作用，client 重发即新请求。
      const userMessage: ChatMessage = {
        message_id: generateId(),
        role: 'user',
        content: params.storeContent,
        request_id: params.request_id,
        timestamp: generateTimestamp(),
      }
      const agentMessage: AgentBoundChannelMessage = {
        platform_message_id: userMessage.message_id,
        session: { session_id: 'admin-chat', channel_id: 'admin-web', type: 'private' as const },
        sender: { friend_id: 'master', platform_user_id: 'master', platform_display_name: 'Master' },
        content: params.agentContent,
        features: { is_mention_crab: false },
        platform_timestamp: userMessage.timestamp,
      }
      const journal: InboundDispatchJournalRecord = {
        kind: 'admin_chat_inbound_dispatch',
        request_id: params.request_id,
        message: agentMessage,
        fingerprint,
        attempt: 0,
        status: 'pending_dispatch',
        created_at: userMessage.timestamp,
      }
      await this.writeInboundJournal(journal)
      this.messages.set(userMessage.message_id, userMessage)
      await this.saveData()
      await this.requestIndex.recordAdmission({
        request_id: params.request_id,
        session_id: 'admin-chat',
        fingerprint,
        user_message_id: userMessage.message_id,
      })

      // dispatch loop 后台跑；重启由 reconcileInboundDispatches 兜底。
      // 「已接收」反馈由 Agent commit 后经 chat_acknowledge 打标（protocol-admin §3.20.2），
      // 入站不再推 chat_status 占位状态。
      void this.runInboundDispatch(journal).catch((error) => {
        console.error(`[ChatManager] inbound dispatch loop failed for ${params.request_id}:`,
          error instanceof Error ? error.message : String(error))
      })
      return { kind: 'admitted', message: userMessage }
    })
  }

  /**
   * dispatch loop：每次 attempt 签新的短 TTL assertion、重放首次固定的 exact message。
   * 只有 Agent 在 wake commit 后返回才标 agent_accepted；timeout/EOF/unknown 保持
   * pending_dispatch，Admin startup 在开放 chat ingress 前恢复重放。
   */
  private async runInboundDispatch(record: InboundDispatchJournalRecord): Promise<void> {
    const MAX_ATTEMPTS = 5
    while (record.status === 'pending_dispatch') {
      try {
        const agentPort = await this.resolveAgentPort()
        if (!agentPort) throw new Error('Agent module not available')
        record.attempt += 1
        await this.writeInboundJournal(record)
        const assertion = this.assertions.issue({
          requestId: record.request_id,
          payloadSha256: sha256CanonicalJson(record.message),
        })
        await this.rpcClient.callSensitive(
          agentPort,
          'process_message',
          {
            message: record.message,
            source_type: 'admin_chat',
            callback_info: { source_module_id: 'admin-web', request_id: record.request_id },
            admin_chat_assertion: assertion,
          },
          'admin-web',
        )
        record.status = 'agent_accepted'
        await this.writeInboundJournal(record)
        // 终态 journal 即删：Agent 侧 wake journal 已接管恢复责任，Admin 无需保留——
        // 否则 journal 目录随历史消息线性增长。
        await fs.rm(this.inboundJournalPath(record.request_id), { force: true })
        return
      } catch (error) {
        console.error(`[ChatManager] dispatch attempt ${record.attempt} failed for ${record.request_id}:`,
          error instanceof Error ? error.message : String(error))
        if (record.attempt >= MAX_ATTEMPTS) {
          // 放弃即终态：journal 与 request index 都标 expired——重启不再重投，
          // 用户不会收到对过期问题的迟到回答。
          this.pushToClient({ type: 'chat_error', request_id: record.request_id, error: '系统暂时不可用，请稍后重试' })
          record.status = 'expired'
          await this.writeInboundJournal(record)
          await this.requestIndex.expire(record.request_id)
          await fs.rm(this.inboundJournalPath(record.request_id), { force: true })
          return
        }
        await new Promise((resolve) => setTimeout(resolve, Math.min(1000 * 2 ** record.attempt, 10_000)))
      }
    }
  }

  /** startup：开放 chat ingress 前恢复 pending_dispatch 的入站 outbox。 */
  async reconcileInboundDispatches(): Promise<void> {
    let entries: string[]
    try {
      entries = await fs.readdir(path.join(this.dataDir, 'chat-inbound-dispatch-journal'))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue
      try {
        const record = await this.readInboundJournal(entry.slice(0, -'.json'.length))
        if (!record || record.status !== 'pending_dispatch') continue
        // 崩在 journal 与 recordAdmission 之间：重放前先把 index 补上（journal 自持
        // fingerprint），否则 Agent 回答回来会被 pending 前置校验永久拒收。
        const existing = this.requestIndex.get(record.request_id)
        if (!existing) {
          await this.requestIndex.recordAdmission({
            request_id: record.request_id,
            session_id: 'admin-chat',
            fingerprint: record.fingerprint,
            user_message_id: record.message.platform_message_id,
          })
        }
        void this.runInboundDispatch(record).catch((error) => {
          console.error(`[ChatManager] startup dispatch replay failed for ${record.request_id}:`,
            error instanceof Error ? error.message : String(error))
        })
      } catch { /* 坏 record 隔离跳过 */ }
    }
  }

  /** HTTP multipart 入口：文字 + N 附件一条消息（design：2026-06-10-master-chat-redesign Phase 2） */
  async handleInboundMessage(params: {
    request_id: string
    text: string
    files: Array<{ buffer: Buffer; filename: string; mime_type: string }>
  }, jwt: string): Promise<{ message: ChatMessage }> {
    if (!jwt || !(await this.verifyJwt(jwt, this.jwtSecret, this.dataDir))) {
      throw new Error('Admin Chat ingress was not JWT authenticated')
    }
    assertValidRequestId(params.request_id)
    const text = params.text.trim()
    if (!text && params.files.length === 0) {
      throw new Error('Empty message')
    }

    // P6-A §11.1-3：fingerprint 在任何 MediaStore promotion/chat 写入之前计算；
    // exact duplicate 返回既有状态（不二次 promote、不新 journal）。
    const admission = await this.requestIndex.withMutex(params.request_id, async () => {
      const fingerprint = computeInboundFingerprintV1({ text, files: params.files })
      let verdict: Awaited<ReturnType<ChatRequestIndex['check']>>
      try {
        verdict = await this.requestIndex.check({ request_id: params.request_id, session_id: 'admin-chat', fingerprint })
      } catch {
        return { kind: 'conflict' as const }
      }
      if (verdict.kind === 'duplicate') return { kind: 'duplicate' as const, entry: verdict.entry }

      // 新请求：附件落 store（允许不可见可 GC orphan），两个视图照旧。
      const saved = await Promise.all(
        params.files.map((f) => this.mediaStore.saveBuffer(f.buffer, { filename: f.filename, mime_type: f.mime_type }))
      )
      const mediaForStore: MediaItem[] = saved.map((savedItem) => savedItem.item)
      const mediaForAgent: MediaItem[] = saved.map((savedItem) => ({ ...savedItem.item, media_url: savedItem.abs_path }))
      const type = mediaForStore.length === 0
        ? ('text' as const)
        : mediaForStore.some((m) => m.mime_type.startsWith('image/'))
          ? ('image' as const)
          : ('file' as const)
      const storeContent: MessageContent = {
        type,
        ...(text ? { text } : {}),
        ...(mediaForStore.length > 0 ? { media: mediaForStore, media_url: mediaForStore[0].media_url } : {}),
      }
      const agentContent: MessageContent = {
        type,
        ...(text ? { text } : {}),
        ...(mediaForAgent.length > 0 ? { media: mediaForAgent, media_url: mediaForAgent[0].media_url } : {}),
      }

      const userMessage: ChatMessage = {
        message_id: generateId(),
        role: 'user',
        content: storeContent,
        request_id: params.request_id,
        timestamp: generateTimestamp(),
      }
      const agentMessage: AgentBoundChannelMessage = {
        platform_message_id: userMessage.message_id,
        session: { session_id: 'admin-chat', channel_id: 'admin-web', type: 'private' as const },
        sender: { friend_id: 'master', platform_user_id: 'master', platform_display_name: 'Master' },
        content: agentContent,
        features: { is_mention_crab: false },
        platform_timestamp: userMessage.timestamp,
      }
      const journal: InboundDispatchJournalRecord = {
        kind: 'admin_chat_inbound_dispatch',
        request_id: params.request_id,
        message: agentMessage,
        fingerprint,
        attempt: 0,
        status: 'pending_dispatch',
        created_at: userMessage.timestamp,
      }
      await this.writeInboundJournal(journal)
      this.messages.set(userMessage.message_id, userMessage)
      await this.saveData()
      await this.requestIndex.recordAdmission({
        request_id: params.request_id,
        session_id: 'admin-chat',
        fingerprint,
        user_message_id: userMessage.message_id,
      })
      void this.runInboundDispatch(journal).catch((error) => {
        console.error(`[ChatManager] inbound dispatch loop failed for ${params.request_id}:`,
          error instanceof Error ? error.message : String(error))
      })
      return { kind: 'admitted' as const, message: userMessage }
    })

    if (admission.kind === 'conflict') {
      const error = new Error(`chat request conflict: ${params.request_id}`)
      ;(error as { code?: string }).code = 'ADMIN_CHAT_REQUEST_CONFLICT'
      throw error
    }
    if (admission.kind === 'duplicate') {
      const existing = admission.entry.user_message_id ? this.messages.get(admission.entry.user_message_id) : undefined
      if (!existing) throw new Error(`duplicate request ${params.request_id} has no stored message`)
      return { message: existing }
    }
    return { message: admission.message }
  }

  async consumeAdminChatAssertion(params: {
    assertion: string
    expected: { manager_key: 'admin-web::admin-chat'; request_id: string; payload_sha256: string }
  }): Promise<{ consumed: true; expires_at: string }> {
    return this.assertions.consume(params.assertion, params.expected)
  }

  /**
   * chat_acknowledge（protocol-admin §3.20.2）：为入站 request IDs 打「已接收」标记。
   * 幂等（已打标跳过），未知 request_id 静默忽略；标记随聊天记录持久化，并推一条
   * `chat_message_acked` 给 ws 客户端（前端据此渲染标记，刷新经聊天历史恢复显示）。
   */
  async acknowledgeRequests(requestIds: string[]): Promise<number> {
    const acknowledgedAt = new Date().toISOString()
    const marked: string[] = []
    for (const requestId of requestIds) {
      const userMessageId = this.requestIndex.get(requestId)?.user_message_id
      const message = userMessageId ? this.messages.get(userMessageId) : undefined
      if (!message || message.role !== 'user' || message.acknowledged_at) continue
      message.acknowledged_at = acknowledgedAt
      marked.push(requestId)
    }
    if (marked.length === 0) return 0
    await this.saveData()
    this.pushToClient({ type: 'chat_message_acked', request_ids: marked })
    return marked.length
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

  /**
   * P6-A §11.11：chat_callback 退役——v3 assistant 新写只有 Manager → crab-messaging →
   * admin-web send_message 一条路；本 handler 只返回 retired 错误，不写消息、不结算占位。
   */
  async handleChatCallback(_params: ChatCallbackParams): Promise<ChatCallbackResult> {
    throw new Error('chat_callback is retired: assistant replies must go through the admin-web send_message delivery transaction')
  }

  // ==========================================================================
  // send_message（admin-web 伪 channel 入口，spec 2026-06-10-master-chat-redesign §4）
  // ==========================================================================

  async handleSendMessage(params: ChatSendMessageParams): Promise<ChatSendMessageResult> {
    // P6-A §11.6 严格校验：session 白名单；admin-chat 的 v3 delivery（含 proactive）必须带
    // delivery_id；request_ids 重复整批拒绝；存在时全部 pending + 同 session 才可 commit。
    if (params.session_id !== 'admin-chat' && params.session_id !== 'system-tasks') {
      throw new Error(`Unknown chat session: ${params.session_id}`)
    }
    const requestIds = params.request_ids ?? []
    if (params.session_id === 'system-tasks' && requestIds.length > 0) {
      throw new Error('system-tasks delivery must not carry request_ids')
    }
    if (params.session_id === 'admin-chat' && !params.delivery_id) {
      throw new Error('delivery_id is required for admin-chat deliveries')
    }
    if (new Set(requestIds).size !== requestIds.length) {
      throw new Error('duplicate request_id in request_ids')
    }

    const content = params.content
    if (content.type === 'system_event' && !params.delivery_id) {
      // 无 delivery_id 的 system_event（system-tasks 等）：直接写（无结算语义）。
      return this.storeAssistantMessage(
        { type: 'text', text: content.text ?? '' },
        { requestIds, deliveryId: params.delivery_id },
      )
    }
    // 带 delivery_id 的 system_event 与其余 delivery 同走 journal 幂等纪律（统一由下方
    // prepared → commit 事务处理，不另开直写捷径）。

    // wire 原始 content 的稳定 hash（§11.7：不含 staging path/UUID/推断字段等服务端值）。
    const payloadHash = createHash('sha256').update(JSON.stringify({
      session_id: params.session_id,
      content,
      request_ids: requestIds,
      task_id: null,
    })).digest('hex')

    if (!params.delivery_id) {
      // system-tasks 等无 delivery_id 的 legacy/proactive 路径：直接写（幂等由调用方保证）。
      return this.storeAssistantMessageFromContent(content, params.session_id, { requestIds })
    }

    return this.deliveryJournal.withMutex(params.delivery_id, async () => {
      const existing = await this.deliveryJournal.read(params.delivery_id!)
      if (existing) {
        const sameIds = existing.request_ids.length === requestIds.length
          && existing.request_ids.every((id, index) => id === requestIds[index])
        if (existing.payload_sha256 !== payloadHash || !sameIds) {
          const error = new Error(`delivery ${params.delivery_id} conflicts with a recorded delivery`)
          ;(error as { code?: string }).code = 'ADMIN_CHAT_DELIVERY_CONFLICT'
          throw error
        }
        // 已 commit 的 delivery 重试（响应丢失/Agent 重启 reconcile）：幂等返回首次结果——
        // pending 校验只约束**新** delivery，已 committed 的 replay 天然是 settled 状态。
        if (existing.state === 'committed') {
          return { platform_message_id: existing.platform_message_id!, sent_at: existing.sent_at! }
        }
        // prepared/committing：复用首次 journal 的 staging/planned UUID/finalized content 继续。
        return this.commitDelivery(existing, requestIds)
      }
      // 新 delivery 才做 pending 前置校验：所有 ID 必须存在、pending、同 session。
      for (const requestId of requestIds) {
        const entry = this.requestIndex.get(requestId)
        if (!entry || entry.session_id !== 'admin-chat' || entry.status !== 'pending') {
          throw new Error(`request ${requestId} is not pending in admin-chat`)
        }
      }
      const prepared = await this.prepareDelivery(params, content, requestIds, payloadHash)
      return this.commitDelivery(prepared, requestIds)
    })
  }

  /** 首次 delivery：媒体 stage + planned UUID/URL + finalized content 写入 prepared journal。 */
  private async prepareDelivery(
    params: ChatSendMessageParams,
    content: MessageContent,
    requestIds: string[],
    payloadHash: string,
  ): Promise<ChatDeliveryJournalRecord> {
    const deliveryId = params.delivery_id!
    const stagingDir = this.deliveryJournal.stagingDir(deliveryId)
    const incoming: Array<Pick<MessageContent, 'media_url' | 'file_path' | 'filename' | 'mime_type'>> =
      content.media?.length
        ? content.media.map((m) => ({ media_url: m.media_url, filename: m.filename, mime_type: m.mime_type }))
        : (content.media_url ?? content.file_path) ? [content] : []

    const plannedMedia: ChatDeliveryJournalRecord['planned_media'] = []
    const mediaItems: MediaItem[] = []
    const failures: string[] = []
    for (const item of incoming) {
      try {
        if (item.media_url?.startsWith('http://') || item.media_url?.startsWith('https://')) {
          mediaItems.push({
            media_url: item.media_url,
            mime_type: item.mime_type ?? 'application/octet-stream',
            ...(item.filename !== undefined ? { filename: item.filename } : {}),
          })
        } else {
          const localPath = item.file_path ?? item.media_url
          if (!localPath) continue
          const mimeType = item.mime_type
            ?? (content.type === 'image' ? inferImageMimeType(item.filename) ?? inferImageMimeType(localPath) : undefined)
          const buffer = await fs.readFile(localPath)
          const staged = await this.mediaStore.stageBuffer(buffer, {
            filename: item.filename ?? path.basename(localPath),
            mime_type: mimeType ?? 'application/octet-stream',
          }, stagingDir)
          plannedMedia.push({
            staged_path: staged.staged_path,
            planned_media_id: staged.planned_id,
            planned_media_url: staged.media_url,
            entry: staged.entry,
          })
          mediaItems.push({
            media_url: staged.media_url,
            mime_type: staged.entry.mime_type,
            filename: staged.entry.filename,
            size: staged.entry.size,
          })
        }
      } catch {
        failures.push(item.filename ?? item.file_path ?? item.media_url ?? '未知附件')
      }
    }

    // 降级结果在 prepare 时定型（retry/restart 不重新决定）。
    const failureNote = failures.length > 0 ? `\n[附件收存失败: ${failures.join(', ')}]` : ''
    const text = `${content.text ?? ''}${failureNote}`.trim()
    // system_event 按协议规定的人类可读 fallback 文本落库（无媒体）。
    if (content.type === 'system_event' && !text) {
      // system_event 无 text 是异常形态，拒绝落库。
      throw new Error('Empty message content')
    }
    if (content.type !== 'system_event' && !text && mediaItems.length === 0) throw new Error('Empty message content')
    const type = mediaItems.length === 0
      ? ('text' as const)
      : mediaItems.some((m) => m.mime_type.startsWith('image/')) ? ('image' as const) : ('file' as const)
    const finalizedContent: MessageContent = {
      type,
      ...(text ? { text } : {}),
      ...(mediaItems.length > 0 ? { media: mediaItems, media_url: mediaItems[0].media_url } : {}),
    }
    return this.deliveryJournal.prepare({
      delivery_id: deliveryId,
      request_ids: requestIds,
      payload_sha256: payloadHash,
      session_id: params.session_id,
      planned_media: plannedMedia,
      finalized_content: finalizedContent,
      // message id 在 prepare 时定型：committing 崩溃恢复/重试复用同一 id，不二次落新消息。
      planned_message_id: generateId(),
    })
  }

  /** journal 确定性 commit：media promotion + assistant message + request settlement + index。 */
  private async commitDelivery(
    journal: ChatDeliveryJournalRecord,
    requestIds: string[],
  ): Promise<ChatSendMessageResult> {
    await this.deliveryJournal.transition(journal.delivery_id, 'committing')
    const finalized = journal.finalized_content as MessageContent
    try {
      // media promotion 按 planned UUID（幂等）。
      for (const planned of journal.planned_media) {
        await this.mediaStore.promoteStaged(planned.staged_path, planned.entry as never)
      }
      // message 用 prepare 时定型的 planned_message_id：committing 崩溃恢复/rolled_back 重试
      // 复用同一 id（幂等覆盖），不会产生第二条消息。
      const result = await this.storeAssistantMessage(finalized, {
        requestIds,
        deliveryId: journal.delivery_id,
        push: false,
        messageId: journal.planned_message_id,
      })
      // 先标 committed（durable），再 settle request——崩溃在两者之间时由 startup reconcile
      // 对 committed 但 request 仍 pending 的 journal 补 settle（见 reconcileDeliveries）。
      await this.deliveryJournal.transition(journal.delivery_id, 'committed', {
        platform_message_id: result.platform_message_id,
        sent_at: result.sent_at,
      })
      for (const requestId of requestIds) {
        await this.requestIndex.settle(requestId, result.platform_message_id)
      }
      await this.deliveryJournal.cleanStaging(journal.delivery_id)
      // commit 后才 chat_push；无 WS 也算成功（refresh 从 history 可见）。
      const message = this.messages.get(result.platform_message_id)
      if (message) this.pushToClient({ type: 'chat_push', message })
      return result
    } catch (error) {
      // Browser 可见前 rollback：撤掉已落库消息（尚未 push）；staging 保留——
      // rolled_back 的重试契约要求同 delivery_id 复用首次 staged 文件（删掉会让
      // 重试 rename ENOENT 永久失败）；media orphan 留待 GC。request 未 settle 无需回滚。
      this.messages.delete(journal.planned_message_id)
      await this.saveData()
      await this.deliveryJournal.transition(journal.delivery_id, 'rolled_back')
      throw error
    }
  }

  /** startup：reconcile delivery journal——committing 确定性补完，prepared 回滚重来，
   *  committed 补 settle，终态超龄 GC。单趟扫描，不再 readdir 两遍。 */
  async reconcileDeliveries(): Promise<void> {
    const records = await this.deliveryJournal.listAll()
    for (const journal of records) {
      if (journal.state === 'prepared' || journal.state === 'committing') {
        try {
          // prepared/committing 都按 journal 确定性重跑 commit（幂等）。
          await this.commitDelivery(journal, journal.request_ids)
        } catch (error) {
          console.error(`[ChatManager] delivery reconcile failed for ${journal.delivery_id}:`,
            error instanceof Error ? error.message : String(error))
        }
        continue
      }
      if (journal.state === 'committed') {
        // committed 但 request 未 settle（崩溃在 commit 与 settle 之间）：补结算。
        for (const requestId of journal.request_ids) {
          const idx = this.requestIndex.get(requestId)
          if (idx && idx.status === 'pending') {
            await this.requestIndex.settle(requestId, journal.platform_message_id ?? journal.planned_message_id)
          }
        }
      }
    }
    // 终态 journal 超龄 GC（7 天 > Agent 侧任何 delivery 重放窗口）。
    await this.deliveryJournal.gcTerminal(7 * 24 * 3600 * 1000)
  }

  /**
   * assistant 消息落库 + chat_push（P6-A §11：新写带 request_ids/delivery_id；
   * placeholder 结算只发生在 delivery commit——本方法不再做任何 FIFO 认领）。
   */
  private async storeAssistantMessage(
    content: MessageContent,
    options: { requestIds?: string[]; deliveryId?: string; push?: boolean; messageId?: string } = {},
  ): Promise<ChatSendMessageResult> {
    const message: ChatMessage = {
      message_id: options.messageId ?? generateId(),
      role: 'assistant',
      content,
      ...(options.requestIds && options.requestIds.length > 0 ? { request_ids: options.requestIds } : {}),
      ...(options.deliveryId !== undefined ? { delivery_id: options.deliveryId } : {}),
      timestamp: generateTimestamp(),
    }
    this.messages.set(message.message_id, message)
    await this.saveData()
    if (options.push !== false) this.pushToClient({ type: 'chat_push', message })
    return { platform_message_id: message.message_id, sent_at: message.timestamp }
  }

  /** 无 delivery 的 legacy 内容写路径（system_event / system-tasks proactive）。 */
  private async storeAssistantMessageFromContent(
    c: MessageContent,
    sessionId: string,
    options: { requestIds?: string[] } = {},
  ): Promise<ChatSendMessageResult> {
    const incoming: Array<Pick<MessageContent, 'media_url' | 'file_path' | 'filename' | 'mime_type'>> =
      c.media?.length
        ? c.media.map((m) => ({ media_url: m.media_url, filename: m.filename, mime_type: m.mime_type }))
        : (c.media_url ?? c.file_path) ? [c] : []
    const media: MediaItem[] = []
    const failures: string[] = []
    for (const m of incoming) {
      try {
        if (m.media_url?.startsWith('http://') || m.media_url?.startsWith('https://')) {
          media.push({
            media_url: m.media_url,
            mime_type: m.mime_type ?? 'application/octet-stream',
            ...(m.filename !== undefined ? { filename: m.filename } : {}),
          })
        } else {
          const localPath = m.file_path ?? m.media_url
          if (!localPath) continue
          const mimeType = m.mime_type
            ?? (c.type === 'image' ? inferImageMimeType(m.filename) ?? inferImageMimeType(localPath) : undefined)
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
    if (!text && media.length === 0) throw new Error('Empty message content')
    const type = media.length === 0
      ? ('text' as const)
      : media.some((m) => m.mime_type.startsWith('image/')) ? ('image' as const) : ('file' as const)
    return this.storeAssistantMessage({
      type,
      ...(text ? { text } : {}),
      ...(media.length > 0 ? { media, media_url: media[0].media_url } : {}),
    }, options)
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
