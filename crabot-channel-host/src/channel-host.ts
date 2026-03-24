/**
 * ChannelHost - OpenClaw 插件兼容层（Shim）主类
 *
 * 作为标准 Crabot Channel 模块运行，内部加载 OpenClaw 插件，
 * 并提供替换了 LLM 调用路径的 channelRuntime，将消息流路由到 Crabot Agent。
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { ModuleBase, type ModuleConfig } from './core/module-base.js'
import { generateId, generateTimestamp, type Event } from './core/base-protocol.js'
import { PendingDispatchMap } from './pending-dispatch.js'
import { SessionManager } from './session-manager.js'
import { MessageStore } from './message-store.js'
import { loadPlugin } from './plugin-loader.js'
import { createChannelRuntime } from './runtime/index.js'
import { msgContextToChannelMessage, messageContentToReplyPayload } from './msg-converter.js'
import type {
  ModuleId,
  MsgContext,
  ChannelMessage,
  ChannelCapabilities,
  ChannelConfig,
  GetConfigResult,
  UpdateConfigParams,
  UpdateConfigResult,
  SendMessageParams,
  SendMessageResult,
  GetSessionsParams,
  GetSessionsResult,
  GetSessionParams,
  GetSessionResult,
  FindOrCreatePrivateSessionParams,
  FindOrCreatePrivateSessionResult,
  GetHistoryParams,
  GetHistoryResult,
  SessionType,
} from './types.js'

// ============================================================================
// 配置类型
// ============================================================================

export interface ChannelHostConfig {
  module_id: ModuleId
  module_type: 'channel'
  version: string
  protocol_version: string
  port: number
  /** 数据目录 */
  data_dir: string
  /** OpenClaw state_dir（存放 openclaw.json / config.json） */
  state_dir?: string
  /** OpenClaw 插件入口文件的绝对路径 */
  plugin_path: string
  /** 插件配置（JSON 对象） */
  plugin_config: unknown
}

// ============================================================================
// ChannelHost
// ============================================================================

export class ChannelHost extends ModuleBase {
  private readonly pendingDispatches: PendingDispatchMap
  private readonly sessionManager: SessionManager
  private readonly messageStore: MessageStore
  private readonly hostConfig: ChannelHostConfig
  private pluginAbortController: AbortController | null = null
  private cleanupInterval: ReturnType<typeof setInterval> | null = null

  constructor(config: ChannelHostConfig) {
    const moduleConfig: ModuleConfig = {
      moduleId: config.module_id,
      moduleType: config.module_type,
      version: config.version,
      protocolVersion: config.protocol_version,
      port: config.port,
      subscriptions: [],
    }

    super(moduleConfig)

    this.hostConfig = config
    this.pendingDispatches = new PendingDispatchMap()
    this.sessionManager = new SessionManager(config.module_id, config.data_dir)
    this.messageStore = new MessageStore(config.data_dir)

    // 注册 RPC 方法
    this.registerMethods()

    // 定期清理过期 dispatch（每 60 秒）
    this.cleanupInterval = setInterval(() => {
      this.pendingDispatches.cleanup()
    }, 60_000)
  }

  // ============================================================================
  // 生命周期
  // ============================================================================

  protected override async onStart(): Promise<void> {
    // 先创建 channelRuntime，再传给 loadPlugin
    // 对于 register(api) 格式的插件，runtime 会在 register 时注入到插件单例
    const runtime = createChannelRuntime(
      this.pendingDispatches,
      this.onMessageReceived.bind(this),
      this.hostConfig.plugin_config
    )

    const plugin = await loadPlugin(this.hostConfig.plugin_path, runtime)

    this.pluginAbortController = new AbortController()

    // 启动 OpenClaw 插件（长期运行，不 await）
    // 注入 Crabot 策略覆盖：群消息不需要 @bot（Crabot 由 Admin 层统一做准入控制）
    const cfg = injectCrabotPolicy(this.hostConfig.plugin_config)

    // 列出所有已注册账号，逐个解析并启动
    const accountIds = plugin.listAccountIds(cfg)

    if (accountIds.length === 0) {
      console.warn('[ChannelHost] No accounts found — plugin installed but not logged in?')
      console.warn('[ChannelHost] Run "openclaw channels login" in the Admin PTY terminal to configure.')
    }

    for (const accountId of accountIds) {
      const account = plugin.resolveAccount(cfg, accountId)
      console.log(`[ChannelHost] Starting account: ${accountId}`)
      plugin
        .startAccount({
          cfg,
          abortSignal: this.pluginAbortController.signal,
          account,
        })
        .then(() => {
          console.log(`[ChannelHost] Account ${accountId} startAccount() resolved (plugin stopped or completed)`)
        })
        .catch((error: unknown) => {
          console.error(`[ChannelHost] Plugin startAccount error (${accountId}):`, error)
        })
    }

    console.log(`[ChannelHost] Plugin loaded from: ${this.hostConfig.plugin_path}`)
  }

  protected override async onStop(): Promise<void> {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval)
      this.cleanupInterval = null
    }
    this.pluginAbortController?.abort()
  }

  // ============================================================================
  // 注册 RPC 方法
  // ============================================================================

  private registerMethods(): void {
    this.registerMethod('send_message', this.handleSendMessage.bind(this))
    this.registerMethod('get_capabilities', this.handleGetCapabilities.bind(this))
    this.registerMethod('get_sessions', this.handleGetSessions.bind(this))
    this.registerMethod('get_session', this.handleGetSession.bind(this))
    this.registerMethod('find_or_create_private_session', this.handleFindOrCreatePrivateSession.bind(this))
    this.registerMethod('get_history', this.handleGetHistory.bind(this))
    this.registerMethod('get_config', this.handleGetConfig.bind(this))
    this.registerMethod('update_config', this.handleUpdateConfig.bind(this))
  }

  // ============================================================================
  // Channel 协议方法
  // ============================================================================

  /**
   * ★ 核心出站路径：发送消息（Agent 调用此方法）
   */
  private async handleSendMessage(params: SendMessageParams): Promise<SendMessageResult> {
    const dispatch = this.pendingDispatches.get(params.session_id)
    if (!dispatch) {
      throw new Error(`No pending dispatch for session: ${params.session_id}`)
    }

    const replyPayload = messageContentToReplyPayload(params.content)

    await dispatch.deliver(replyPayload, { kind: 'block' })

    // 消费完毕后删除
    this.pendingDispatches.delete(params.session_id)

    const messageId = generateId()
    const sentAt = generateTimestamp()

    // 记录出站消息到历史
    this.messageStore.appendOutbound({
      sessionId: params.session_id,
      platformMessageId: messageId,
      text: params.content.text ?? '[非文本消息]',
      contentType: params.content.type,
      timestamp: sentAt,
    })

    return {
      platform_message_id: messageId,
      sent_at: sentAt,
    }
  }

  /**
   * 查询 Channel 能力
   */
  private handleGetCapabilities(): ChannelCapabilities {
    return {
      supported_message_types: ['text'],
      supported_features: [],
      supports_history_query: true,
      supports_platform_user_query: false,
      max_message_length: null,
      max_file_size: null,
      supports_file_path: false,
      allowed_file_paths: [],
    }
  }

  /**
   * 查询 Session 列表
   */
  private handleGetSessions(params: GetSessionsParams): GetSessionsResult {
    const sessions = this.sessionManager.listSessions(params.type as SessionType | undefined)

    const page = params.pagination?.page ?? 1
    const pageSize = params.pagination?.page_size ?? 20
    const start = (page - 1) * pageSize
    const end = start + pageSize
    const items = sessions.slice(start, end)

    return {
      items,
      pagination: {
        page,
        page_size: pageSize,
        total_items: sessions.length,
        total_pages: Math.ceil(sessions.length / pageSize),
      },
    }
  }

  /**
   * 查询单个 Session
   */
  private handleGetSession(params: GetSessionParams): GetSessionResult {
    const session = this.sessionManager.findById(params.session_id)
    if (!session) {
      throw new Error('Session not found')
    }
    return { session }
  }

  /**
   * 查询历史消息（protocol-channel.md §3.3）
   */
  private handleGetHistory(params: GetHistoryParams): GetHistoryResult {
    const session = this.sessionManager.findById(params.session_id)
    if (!session) {
      throw new Error('Session not found')
    }

    const page = params.pagination?.page ?? 1
    const pageSize = params.pagination?.page_size ?? 20

    const { items, total } = this.messageStore.query({
      sessionId: params.session_id,
      keyword: params.keyword,
      limit: params.limit,
      timeRange: params.time_range,
      page: params.limit ? undefined : page,
      pageSize: params.limit ? undefined : pageSize,
    })

    return {
      items,
      pagination: {
        page,
        page_size: params.limit ?? pageSize,
        total_items: total,
        total_pages: Math.ceil(total / (params.limit ?? pageSize)),
      },
    }
  }

  /**
   * 查找或创建私聊 Session（不做 Friend 鉴权，由 Admin 负责）
   */
  private async handleFindOrCreatePrivateSession(
    params: FindOrCreatePrivateSessionParams
  ): Promise<FindOrCreatePrivateSessionResult> {
    return this.sessionManager.upsertPrivateSession({
      platform_session_id: params.platform_user_id,
      participant_platform_user_id: params.platform_user_id,
      participant_display_name: params.platform_user_id,
    })
  }

  // ============================================================================
  // 入站消息处理（由 runtime/reply.ts 触发）
  // ============================================================================

  /**
   * 收到来自 OpenClaw 插件的消息时调用
   */
  private async onMessageReceived(ctx: MsgContext, sessionId: string): Promise<void> {
    const platformUserId = ctx.SenderId ?? 'unknown'
    const isGroupChat = ctx.ChatType === 'group'
    const displayName = ctx.SenderName ?? ctx.SenderUsername ?? platformUserId

    console.log(`[ChannelHost] 📩 Message received: sender=${platformUserId} (${displayName}), session=${sessionId}, type=${isGroupChat ? 'group' : 'private'}, text=${(ctx.Body ?? '').slice(0, 50)}`)

    // 创建/更新 Session（不做 Friend 鉴权，鉴权由 Admin 负责）
    const { session } = isGroupChat
      ? this.sessionManager.upsertGroupSession({
          platform_session_id: sessionId,
          participant_platform_user_id: platformUserId,
          participant_display_name: displayName,
        })
      : this.sessionManager.upsertPrivateSession({
          platform_session_id: sessionId,
          participant_platform_user_id: platformUserId,
          participant_display_name: displayName,
        })

    // ★ 修复：将 pendingDispatch 从平台 sessionId 重新映射到 session.id (UUID)
    // 因为 Agent 回复时使用的是 channelMessage.session.session_id（即 session.id UUID），
    // 而 pendingDispatches 最初以平台 sessionId（如 "agent:main:feishu:dm:ou_..."）为 key 存储
    if (session.id !== sessionId) {
      const dispatch = this.pendingDispatches.get(sessionId)
      if (dispatch) {
        this.pendingDispatches.delete(sessionId)
        this.pendingDispatches.set(session.id, { deliver: dispatch.deliver })
      }
    }

    const channelMessage: ChannelMessage = msgContextToChannelMessage(
      ctx,
      session.id,
      session,
      this.config.moduleId
    )

    // 记录入站消息到历史
    this.messageStore.appendInbound({
      sessionId: session.id,
      platformMessageId: channelMessage.platform_message_id,
      senderName: displayName,
      senderPlatformUserId: platformUserId,
      text: channelMessage.content.text ?? '[非文本消息]',
      contentType: channelMessage.content.type,
      timestamp: channelMessage.platform_timestamp,
    })

    await this.publishMessageReceivedEvent(channelMessage)
    console.log(`[ChannelHost] 📤 Event published: channel.message_received, session.id=${session.id}`)
  }

  /**
   * 发布 channel.message_received 事件（无条件，所有消息均发布）
   */
  private async publishMessageReceivedEvent(message: ChannelMessage): Promise<void> {
    const event: Event = {
      id: generateId(),
      type: 'channel.message_received',
      source: this.config.moduleId,
      payload: { channel_id: this.config.moduleId, message },
      timestamp: generateTimestamp(),
    }

    await this.rpcClient.publishEvent(event, this.config.moduleId)
  }

  // ============================================================================
  // 配置管理（protocol-channel.md §6.1, base-protocol §8.3）
  // ============================================================================

  /**
   * get_config — 返回当前配置
   * 从 state_dir 中读取 openclaw.json 或 config.json
   * 敏感字段（credentials）以掩码返回
   */
  private async handleGetConfig(): Promise<GetConfigResult> {
    const config = await this.readConfig()
    // 掩码敏感字段
    const maskedCredentials: Record<string, string> = {}
    for (const [key, value] of Object.entries(config.credentials ?? {})) {
      maskedCredentials[key] = value ? '***' : ''
    }
    return {
      config: { ...config, credentials: maskedCredentials },
      schema: {
        credentials: { sensitive: true, description: '平台 API 凭证，变更后需重启' },
        'group.only_respond_to_mentions': { hot_reload: true, description: '群聊中是否只响应 @Crabot' },
      },
    }
  }

  /**
   * update_config — 部分更新配置
   * 将变更合并后写回 state_dir
   */
  private async handleUpdateConfig(params: UpdateConfigParams): Promise<UpdateConfigResult> {
    const existing = await this.readConfig()

    // 合并更新（credentials 中 '***' 值保留原有值）
    const incoming = params.config
    const mergedCredentials = { ...(existing.credentials ?? {}) }
    if (incoming.credentials) {
      for (const [key, value] of Object.entries(incoming.credentials)) {
        if (value !== '***') {
          mergedCredentials[key] = value
        }
      }
    }

    const { credentials: _incomingCreds, ...incomingRest } = incoming
    const merged: ChannelConfig = {
      ...existing,
      ...incomingRest,
      credentials: mergedCredentials,
    }

    await this.writeConfig(merged)

    // 热更新运行时配置（plugin_config）
    this.hostConfig.plugin_config = await this.readRawPluginConfig()

    // 掩码返回
    const maskedCredentials: Record<string, string> = {}
    for (const [key, value] of Object.entries(merged.credentials ?? {})) {
      maskedCredentials[key] = value ? '***' : ''
    }

    return {
      config: { ...merged, credentials: maskedCredentials },
      requires_restart: this.hasRestartRequiredChanges(existing, merged),
    }
  }

  /**
   * 从 state_dir 读取配置，转为协议 ChannelConfig 格式
   */
  private async readConfig(): Promise<ChannelConfig> {
    const stateDir = this.hostConfig.state_dir
    if (!stateDir) {
      return { platform: 'unknown', credentials: {} }
    }

    // 策略 1：openclaw.json
    const openclawJsonPath = path.join(stateDir, 'openclaw.json')
    try {
      const content = await fs.readFile(openclawJsonPath, 'utf-8')
      const data = JSON.parse(content) as {
        channels?: Record<string, Record<string, unknown>>
      }
      if (data.channels) {
        const channelName = Object.keys(data.channels)[0]
        if (channelName) {
          const raw = data.channels[channelName] as Record<string, any>
          return this.rawToChannelConfig(raw)
        }
      }
    } catch {
      // 继续尝试 config.json
    }

    // 策略 2：config.json
    const configPath = path.join(stateDir, 'config.json')
    try {
      const content = await fs.readFile(configPath, 'utf-8')
      const raw = JSON.parse(content) as Record<string, any>
      return this.rawToChannelConfig(raw)
    } catch {
      return { platform: 'unknown', credentials: {} }
    }
  }

  /**
   * 将 ChannelConfig 写回 state_dir
   */
  private async writeConfig(config: ChannelConfig): Promise<void> {
    const stateDir = this.hostConfig.state_dir
    if (!stateDir) {
      throw new Error('No state_dir configured, cannot write config')
    }

    const openclawJsonPath = path.join(stateDir, 'openclaw.json')
    try {
      const content = await fs.readFile(openclawJsonPath, 'utf-8')
      const data = JSON.parse(content) as {
        channels?: Record<string, Record<string, unknown>>
        [key: string]: unknown
      }
      if (data.channels) {
        const channelName = Object.keys(data.channels)[0]
        if (channelName) {
          data.channels[channelName] = this.channelConfigToRaw(config)
          await fs.writeFile(openclawJsonPath, JSON.stringify(data, null, 2), 'utf-8')
          return
        }
      }
    } catch {
      // openclaw.json 不存在，写入 config.json
    }

    const configPath = path.join(stateDir, 'config.json')
    await fs.writeFile(configPath, JSON.stringify(this.channelConfigToRaw(config), null, 2), 'utf-8')
  }

  /**
   * 读取原始插件配置（供热更新 plugin_config 用）
   */
  private async readRawPluginConfig(): Promise<unknown> {
    const stateDir = this.hostConfig.state_dir
    if (!stateDir) return {}

    const openclawJsonPath = path.join(stateDir, 'openclaw.json')
    try {
      const content = await fs.readFile(openclawJsonPath, 'utf-8')
      return JSON.parse(content)
    } catch {
      // 继续
    }

    const configPath = path.join(stateDir, 'config.json')
    try {
      const content = await fs.readFile(configPath, 'utf-8')
      return JSON.parse(content)
    } catch {
      return {}
    }
  }

  /**
   * 将 openclaw 原始配置转为协议 ChannelConfig 格式
   * openclaw.json channels 段是扁平结构（appId, appSecret 等）
   */
  private rawToChannelConfig(raw: Record<string, any>): ChannelConfig {
    const { appId, appSecret, domain, connectionMode, ...rest } = raw
    const credentials: Record<string, string> = {}
    if (appId) credentials.app_id = appId
    if (appSecret) credentials.app_secret = appSecret

    const platform = domain ?? 'unknown'
    return { platform, credentials, ...rest }
  }

  /**
   * 将协议 ChannelConfig 转回 openclaw 原始格式
   */
  private channelConfigToRaw(config: ChannelConfig): Record<string, unknown> {
    const { platform, credentials, ...rest } = config
    const raw: Record<string, unknown> = { ...rest }
    // 恢复 openclaw 扁平字段名
    if (credentials.app_id) raw.appId = credentials.app_id
    if (credentials.app_secret) raw.appSecret = credentials.app_secret
    raw.domain = platform
    return raw
  }

  /**
   * 判断配置变更是否需要重启
   */
  private hasRestartRequiredChanges(oldConfig: ChannelConfig, newConfig: ChannelConfig): boolean {
    // credentials 变更需要重启
    const oldCreds = JSON.stringify(oldConfig.credentials ?? {})
    const newCreds = JSON.stringify(newConfig.credentials ?? {})
    if (oldCreds !== newCreds) return true
    // crab_platform_user_id 变更需要重启
    if (oldConfig.crab_platform_user_id !== newConfig.crab_platform_user_id) return true
    return false
  }

  // ============================================================================
  // 健康检查
  // ============================================================================

  protected override async getHealthDetails(): Promise<Record<string, unknown>> {
    return {
      platform: 'openclaw-host',
      platform_connected: this.pluginAbortController !== null && !this.pluginAbortController.signal.aborted,
      active_sessions: this.sessionManager.listSessions().length,
      pending_dispatches: this.pendingDispatches.size,
    }
  }
}

// ============================================================================
// 工具函数
// ============================================================================

/**
 * 将 Crabot 策略注入插件配置，覆盖 OpenClaw 插件的默认行为。
 *
 * - requireMention: false — 群消息不需要 @bot。
 *   OpenClaw 默认 true，但 Crabot 的准入控制由 Admin 层统一处理（§8.3/§8.4），
 *   插件层不应再做二次过滤。
 */
function injectCrabotPolicy(cfg: unknown): unknown {
  if (!cfg || typeof cfg !== 'object') return cfg
  const config = cfg as Record<string, unknown>

  const channels = config.channels as Record<string, unknown> | undefined
  if (!channels) return cfg

  const injected: Record<string, unknown> = {}
  for (const [key, channelCfg] of Object.entries(channels)) {
    injected[key] = {
      ...(channelCfg as Record<string, unknown>),
      requireMention: false,
    }
  }

  return { ...config, channels: injected }
}
