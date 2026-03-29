/**
 * Admin 模块 - Crabot 管理后台
 *
 * @see crabot-docs/protocols/protocol-admin.md
 */

import http, { type IncomingMessage, type ServerResponse } from 'node:http'
import type { Socket } from 'node:net'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { ModuleBase, type ModuleConfig } from './core/module-base.js'
import {
  type Event,
  type ModuleId,
  type FriendId,
  type TaskId,
  type ScheduleId,
  generateId,
  generateTimestamp,
} from './core/base-protocol.js'
import {
  type Friend,
  type PermissionTemplate,
  type ChannelIdentity,
  type AdminConfig,
  type PendingMessage,
  type LoginRequest,
  type LoginResponse,
  type CreateFriendParams,
  type UpdateFriendParams,
  type ResolveFriendParams,
  type FriendPermission,
  DEFAULT_ADMIN_CONFIG,
  AdminErrorCode,
  type Task,
  type Schedule,
  type TaskStatus,
  type CreateTaskParams,
  type GetTaskParams,
  type ListTasksParams,
  type UpdateTaskStatusParams,
  type AssignWorkerParams,
  type UpdatePlanParams,
  type AppendMessageParams,
  type GetTaskMessagesParams,
  type CancelTaskParams,
  type TaskStats,
  type CreateScheduleParams,
  type GetScheduleParams,
  type ListSchedulesParams,
  type UpdateScheduleParams,
  type DeleteScheduleParams,
  type TriggerNowParams,
  type TaskMessage,
  type TaskPriority,
  type ScheduleTrigger,
  type AdminEventPayloads,
  type CreateModelProviderParams,
  type UpdateModelProviderParams,
  type ImportFromVendorParams,
  type ResolveModelConfigParams,
  type GlobalModelConfig,
  type ModelConnectionInfo,
  type LLMConnectionInfo,
  type EmbeddingConnectionInfo,
  type AgentImplementation,
  type AgentInstance,
  type AgentInstanceConfig,
  type ResolvedAgentConfig,
  type CreateAgentInstanceParams,
  type UpdateAgentInstanceParams,
  type UpdateAgentConfigParams,
  type ListAgentImplementationsParams,
  type ListAgentInstancesParams,
  type ChannelImplementation,
  type ChannelInstance,
  type ChannelConfig,
  type CreateChannelInstanceParams,
  type UpdateChannelInstanceParams,
  type UpdateChannelConfigParams,
  type ListChannelImplementationsParams,
  type ListChannelInstancesParams,
  type ModuleSource,
  type PreviewModulePackageParams,
  type InstallModuleParams,
  type ChatCallbackParams,
  type ChatCallbackResult,
  type GetChatHistoryParams,
  type GetChatHistoryResult,
  type UpsertPendingMessageParams,
  type UpsertPendingMessageResult,
  type ChannelMessageRef,
} from './types.js'
import { ModelProviderManager } from './model-provider-manager.js'
import { AgentManager } from './agent-manager.js'
import { ChannelManager } from './channel-manager.js'
import { ModuleInstaller } from './module-installer.js'
import { ChatManager } from './chat-manager.js'
import { PtyManager } from './pty-manager.js'
import { MCPServerManager, SkillManager, EssentialToolsManager } from './mcp-skill-manager.js'
import { PRESET_VENDORS } from './preset-vendors.js'

// ============================================================================
// JWT 工具函数
// ============================================================================

interface JwtPayload {
  sub: string
  iat: number
  exp: number
}

function base64UrlEncode(data: string): string {
  return Buffer.from(data)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
}

function signJwt(payload: JwtPayload, secret: string): string {
  const header = { alg: 'HS256', typ: 'JWT' }
  const headerB64 = base64UrlEncode(JSON.stringify(header))
  const payloadB64 = base64UrlEncode(JSON.stringify(payload))
  const signature = crypto
    .createHmac('sha256', secret)
    .update(`${headerB64}.${payloadB64}`)
    .digest('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
  return `${headerB64}.${payloadB64}.${signature}`
}

function verifyJwt(token: string, secret: string): JwtPayload | null {
  const parts = token.split('.')
  if (parts.length !== 3) return null

  const [headerB64, payloadB64, signatureB64] = parts
  const expectedSignature = crypto
    .createHmac('sha256', secret)
    .update(`${headerB64}.${payloadB64}`)
    .digest('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')

  if (signatureB64 !== expectedSignature) return null

  try {
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64').toString())
    if (payload.exp < Math.floor(Date.now() / 1000)) return null
    return payload
  } catch {
    return null
  }
}

// ============================================================================
// Admin 模块
// ============================================================================

/**
 * Admin 模块实现
 */
export class AdminModule extends ModuleBase {
  private readonly adminConfig: AdminConfig
  private webServer: http.Server | null = null
  private jwtSecret: string = ''
  private password: string = ''

  // 数据存储
  private friends: Map<FriendId, Friend> = new Map()
  private permissionTemplates: Map<string, PermissionTemplate> = new Map()
  private pendingMessages: Map<string, PendingMessage> = new Map()
  private channelIdentityIndex: Map<string, FriendId> = new Map() // 快速查找
  private tasks: Map<TaskId, Task> = new Map()
  private schedules: Map<ScheduleId, Schedule> = new Map()

  // 模型供应商管理器
  private modelProviderManager: ModelProviderManager

  // Agent 管理器
  private agentManager: AgentManager

  // Channel 管理器
  private channelManager: ChannelManager

  // 模块安装器
  private moduleInstaller: ModuleInstaller

  // Chat 管理器
  private chatManager: ChatManager | null = null

  // PTY 管理器（Web CLI 终端）
  private ptyManager: PtyManager | null = null

  // MCP Server 管理器
  private mcpServerManager!: MCPServerManager

  // Skill 管理器
  private skillManager!: SkillManager

  // 必要工具配置管理器
  private essentialToolsManager!: EssentialToolsManager

  // 模块 env 配置缓存（用于 LiteLLM 按需加载）
  private moduleEnvConfigCache: Map<string, Record<string, string>> = new Map()

  // 数据文件路径
  private friendsFilePath: string = ''
  private templatesFilePath: string = ''
  private pendingMessagesFilePath: string = ''

  constructor(
    moduleConfig: ModuleConfig,
    adminConfig: Partial<AdminConfig> = {}
  ) {
    super(moduleConfig)
    this.adminConfig = { ...DEFAULT_ADMIN_CONFIG, ...adminConfig }

    // LiteLLM 配置
    const litellmBaseUrl = process.env.LITELLM_BASE_URL || 'http://localhost:4000'
    const litellmMasterKey = process.env.LITELLM_MASTER_KEY || 'sk-litellm-test-key-12345'
    const litellmConfigPath = process.env.LITELLM_CONFIG_PATH || path.join(this.adminConfig.data_dir, '../litellm/config.yaml')

    this.modelProviderManager = new ModelProviderManager(
      this.adminConfig.data_dir,
      litellmConfigPath,
      litellmBaseUrl,
      litellmMasterKey
    )
    this.agentManager = new AgentManager(this.adminConfig.data_dir)
    this.channelManager = new ChannelManager(this.adminConfig.data_dir, this.rpcClient)
    this.moduleInstaller = new ModuleInstaller(this.adminConfig.data_dir, this.agentManager)
    this.mcpServerManager = new MCPServerManager(this.adminConfig.data_dir)
    this.skillManager = new SkillManager(this.adminConfig.data_dir)
    this.essentialToolsManager = new EssentialToolsManager(this.adminConfig.data_dir)

    // 注入回调，实现跨模块解耦通信
    this.modelProviderManager.setUsedModelsProvider(
      () => this.agentManager.getUsedModels()
    )
    this.modelProviderManager.setModuleEnvModelsProvider(
      () => this.getModuleEnvLiteLLMModels()
    )
    this.agentManager.setOnConfigChanged(() => {
      this.modelProviderManager.requestSync()
      this.pushConfigToAgentModules().catch((err: Error) => {
        console.warn('[Admin] pushConfigToAgentModules after agent config change failed:', err.message)
      })
    })

    // 注册 Admin 协议方法
      this.registerMethod('list_friends', this.handleListFriends.bind(this))
    this.registerMethod('get_friend', this.handleGetFriend.bind(this))
    this.registerMethod('create_friend', async (params: CreateFriendParams) => {
      const result = this.handleCreateFriend(params)
      await this.saveData()
      return result
    })
    this.registerMethod('update_friend', this.handleUpdateFriend.bind(this))
    this.registerMethod('delete_friend', this.handleDeleteFriend.bind(this))
    this.registerMethod('link_channel_identity', this.handleLinkChannelIdentity.bind(this))
    this.registerMethod('unlink_channel_identity', this.handleUnlinkChannelIdentity.bind(this))
    this.registerMethod('resolve_friend', this.handleResolveFriend.bind(this))
    this.registerMethod('list_pending_messages', this.handleListPendingMessages.bind(this))
    this.registerMethod('approve_pending_message', this.handleApprovePendingMessage.bind(this))
    this.registerMethod('reject_pending_message', this.handleRejectPendingMessage.bind(this))
    this.registerMethod('upsert_pending_message', this.handleUpsertPendingMessage.bind(this))

    // Task 管理
    this.registerMethod('create_task', this.handleCreateTask.bind(this))
    this.registerMethod('get_task', this.handleGetTask.bind(this))
    this.registerMethod('list_tasks', this.handleListTasks.bind(this))
    this.registerMethod('update_task_status', this.handleUpdateTaskStatus.bind(this))
    this.registerMethod('assign_worker', this.handleAssignWorker.bind(this))
    this.registerMethod('update_plan', this.handleUpdatePlan.bind(this))
    this.registerMethod('append_message', this.handleAppendMessage.bind(this))
    this.registerMethod('get_task_messages', this.handleGetTaskMessages.bind(this))
    this.registerMethod('get_task_stats', this.handleGetTaskStats.bind(this))
    this.registerMethod('cancel_task', this.handleCancelTask.bind(this))

    // Schedule 管理
    this.registerMethod('create_schedule', this.handleCreateSchedule.bind(this))
    this.registerMethod('get_schedule', this.handleGetSchedule.bind(this))
    this.registerMethod('list_schedules', this.handleListSchedules.bind(this))
    this.registerMethod('update_schedule', this.handleUpdateSchedule.bind(this))
    this.registerMethod('delete_schedule', this.handleDeleteSchedule.bind(this))
    this.registerMethod('trigger_now', this.handleTriggerNow.bind(this))

    // Model Provider 管理
    this.registerMethod('resolve_model_config', this.handleResolveModelConfig.bind(this))

    // Agent 实现管理
    this.registerMethod('list_agent_implementations', this.handleListAgentImplementations.bind(this))
    this.registerMethod('get_agent_implementation', this.handleGetAgentImplementation.bind(this))

    // Agent 实例管理
    this.registerMethod('list_agent_instances', this.handleListAgentInstances.bind(this))
    this.registerMethod('get_agent_instance', this.handleGetAgentInstance.bind(this))
    this.registerMethod('create_agent_instance', this.handleCreateAgentInstance.bind(this))
    this.registerMethod('update_agent_instance', this.handleUpdateAgentInstance.bind(this))
    this.registerMethod('delete_agent_instance', this.handleDeleteAgentInstance.bind(this))

    // Agent 配置管理
    this.registerMethod('get_agent_config', this.handleGetAgentConfig.bind(this))
    this.registerMethod('update_agent_config', this.handleUpdateAgentConfig.bind(this))

    // Memory 配置管理（供 Memory 模块启动时 pull 初始配置）
    this.registerMethod('get_memory_config', this.handleGetMemoryConfig.bind(this))

    // Channel 实现管理
    this.registerMethod('list_channel_implementations', this.handleListChannelImplementations.bind(this))
    this.registerMethod('get_channel_implementation', this.handleGetChannelImplementation.bind(this))

    // Channel 实例管理
    this.registerMethod('list_channel_instances', this.handleListChannelInstances.bind(this))
    this.registerMethod('get_channel_instance', this.handleGetChannelInstance.bind(this))
    this.registerMethod('create_channel_instance', this.handleCreateChannelInstance.bind(this))
    this.registerMethod('update_channel_instance', this.handleUpdateChannelInstance.bind(this))
    this.registerMethod('delete_channel_instance', this.handleDeleteChannelInstance.bind(this))

    // Channel 配置管理
    this.registerMethod('get_channel_config', this.handleGetChannelConfig.bind(this))
    this.registerMethod('update_channel_config', this.handleUpdateChannelConfig.bind(this))

    // 模块安装管理
    this.registerMethod('preview_module_package', this.handlePreviewModulePackage.bind(this))
    this.registerMethod('install_module', this.handleInstallModule.bind(this))
    this.registerMethod('uninstall_module', this.handleUninstallModule.bind(this))

    // 模块配置管理
    this.registerMethod('get_module_config', this.handleGetModuleConfig.bind(this))
    this.registerMethod('set_module_config', this.handleSetModuleConfig.bind(this))

    // 模块生命周期控制
    this.registerMethod('start_module', this.handleStartModuleAdmin.bind(this))
    this.registerMethod('stop_module', this.handleStopModuleAdmin.bind(this))
    this.registerMethod('restart_module', this.handleRestartModuleAdmin.bind(this))

    // Chat 管理
    this.registerMethod('chat_callback', this.handleChatCallback.bind(this))
    this.registerMethod('get_chat_history', this.handleGetChatHistory.bind(this))
  }

  // ============================================================================
  // 生命周期
  // ============================================================================

  protected override async onStart(): Promise<void> {
    // 从环境变量读取配置
    this.password = process.env[this.adminConfig.password_env] ?? ''
    this.jwtSecret = process.env[this.adminConfig.jwt_secret_env] ?? ''

    if (!this.password) {
      console.warn('[Admin] Warning: No admin password configured')
    }
    if (!this.jwtSecret) {
      // 如果没有配置 JWT secret，生成一个随机的
      this.jwtSecret = crypto.randomBytes(32).toString('hex')
      console.warn('[Admin] Warning: No JWT secret configured, using random value')
    }

    // 确保数据目录存在
    await fs.mkdir(this.adminConfig.data_dir, { recursive: true })

    // 设置数据文件路径
    this.friendsFilePath = path.join(this.adminConfig.data_dir, 'friends.json')
    this.templatesFilePath = path.join(this.adminConfig.data_dir, 'templates.json')
    this.pendingMessagesFilePath = path.join(this.adminConfig.data_dir, 'pending-messages.json')

    // 加载数据
    await this.loadData()

    // 初始化系统权限模板
    await this.initSystemTemplates()

    // 加载模块 env 配置缓存（供 LiteLLM 按需加载使用）
    await this.loadModuleEnvConfigCache()

    // 初始化模型供应商管理器（会自动同步到 LiteLLM）
    await this.modelProviderManager.initialize()

    // 初始化 Agent 管理器
    await this.agentManager.initialize()

    // agentManager 初始化完成后，触发一次同步以纳入 agent configs 和模块 env 中的模型
    this.modelProviderManager.requestSync()

    // 初始化 Channel 管理器
    await this.channelManager.initialize()

    // 重新注册 channel-host 实例到 MM（MM 重启后动态注册会丢失）
    await this.channelManager.reRegisterInstances()

    // 初始化模块安装器
    await this.moduleInstaller.initialize()

    // 初始化 MCP Server 管理器
    await this.mcpServerManager.initialize()

    // 初始化 Skill 管理器
    await this.skillManager.initialize()

    // 初始化必要工具配置管理器
    await this.essentialToolsManager.initialize()

    // 初始化 Chat 管理器
    this.chatManager = new ChatManager(
      this.adminConfig.data_dir,
      this.rpcClient,
      () => this.ensureAgentPort(),
      this.jwtSecret
    )
    await this.chatManager.loadData()

    // 初始化 PTY 管理器（Web CLI 终端）
    this.ptyManager = new PtyManager(this.jwtSecret, 19000, verifyJwt)

    // 延迟解析 Agent 端口，等待 Agent 模块启动
    setTimeout(() => {
      this.resolveAgentPortWithRetry(3, 2000).catch((error) => {
        console.warn('[Admin] Failed to resolve Agent port after retries:', error)
      })
    }, 2000)

    // 启动 Web 服务器
    await this.startWebServer()

    console.log(`[Admin] Web server started on port ${this.adminConfig.web_port}`)
  }

  protected override async onStop(): Promise<void> {
    // 保存数据
    await this.saveData()

    // 关闭 Chat 管理器
    if (this.chatManager) {
      this.chatManager.close()
    }

    // 停止 Web 服务器
    if (this.webServer) {
      await new Promise<void>((resolve) => {
        this.webServer!.close(() => resolve())
      })
    }
  }

  protected override async getHealthDetails(): Promise<Record<string, unknown>> {
    const health: Record<string, unknown> = {
      web_server_running: this.webServer !== null,
      friends_count: this.friends.size,
      pending_messages_count: this.pendingMessages.size,
      providers_count: this.modelProviderManager.listProviders().length,
    }

    return health
  }

  protected override async onEvent(event: Event): Promise<void> {
    // 统一配置分发模式：
    // 1. 模块启动时先 pull 初始化（模块调用 Admin 的 get_xxx_config RPC）
    // 2. 运行时配置变更由 Admin push（通过 update_config RPC）
    // 3. module_started 事件的 push 作为补充保障（覆盖 pull 与 push 之间的时间窗口）
    switch (event.type) {
      case 'module_manager.module_started': {
        const { module_id, module_type } = event.payload as { module_id: string; module_type: string }
        if (module_type === 'memory') {
          console.log(`[Admin] Memory module ${module_id} started, pushing config as safety net...`)
          this.syncGlobalConfigToMemoryModules().catch((err: Error) => {
            console.warn(`[Admin] Failed to push config to ${module_id}:`, err.message)
          })
        }
        if (module_type === 'agent') {
          console.log(`[Admin] Agent module ${module_id} started, pushing config as safety net...`)
          // Agent 端口可能刚注册，给一点时间让 MM 更新端口映射
          setTimeout(() => {
            this.pushConfigToAgentModules().catch((err: Error) => {
              console.warn(`[Admin] Failed to push config to ${module_id}:`, err.message)
            })
          }, 1000)
        }
        break
      }
      case 'module_manager.module_stopped':
      case 'module_manager.module_error':
        break

      case 'channel.message_received': {
        const { channel_id, message, crab_display_name } = event.payload as { channel_id: ModuleId; message: ChannelMessageRef; crab_display_name?: string }
        await this.handleChannelMessage(channel_id, message, crab_display_name)
        break
      }
      // 其他事件处理...
    }
  }

  // ============================================================================
  // Web 服务器
  // ============================================================================

  private async startWebServer(): Promise<void> {
    this.webServer = http.createServer((req, res) => {
      this.handleWebRequest(req, res).catch((error) => {
        console.error('[Admin] Web request error:', error)
        res.writeHead(500)
        res.end(JSON.stringify({ error: 'Internal server error' }))
      })
    })

    // WebSocket upgrade 处理
    this.webServer.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      if (url.pathname.startsWith('/ws/pty/') && this.ptyManager) {
        this.ptyManager.handleUpgrade(req, socket as Socket, head)
      } else if (this.chatManager) {
        this.chatManager.handleUpgrade(req, socket as Socket, head)
      } else {
        socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n')
        socket.destroy()
      }
    })

    return new Promise((resolve, reject) => {
      this.webServer!.listen(this.adminConfig.web_port, () => {
        resolve()
      })
      this.webServer!.on('error', reject)
    })
  }

  private async handleWebRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // 设置 CORS 头
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')

    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    const url = new URL(req.url ?? '/', `http://localhost:${this.adminConfig.web_port}`)
    const pathname = url.pathname

    // 认证检查（排除登录接口和静态文件）
    if (pathname.startsWith('/api/') && pathname !== '/api/auth/login') {
      const authHeader = req.headers.authorization
      if (!authHeader?.startsWith('Bearer ')) {
        res.writeHead(401)
        res.end(JSON.stringify({ error: 'Unauthorized' }))
        return
      }

      const token = authHeader.slice(7)
      const payload = verifyJwt(token, this.jwtSecret)
      if (!payload) {
        res.writeHead(401)
        res.end(JSON.stringify({ error: 'Invalid or expired token' }))
        return
      }
    }

    // 路由处理
    try {
      if (pathname === '/api/auth/login' && req.method === 'POST') {
        await this.handleLogin(req, res)
        return
      }

      if (pathname === '/api/friends' && req.method === 'GET') {
        await this.handleListFriendsApi(req, res, url)
        return
      }

      if (pathname === '/api/friends' && req.method === 'POST') {
        await this.handleCreateFriendApi(req, res)
        return
      }

      // Friend :id 子路由 — identities 路由优先匹配
      if (req.method === 'POST' && pathname.match(/^\/api\/friends\/[^/]+\/identities$/)) {
        const friendId = pathname.split('/')[3]
        await this.handleLinkChannelIdentityApi(req, res, friendId)
        return
      }

      if (req.method === 'DELETE' && pathname.match(/^\/api\/friends\/[^/]+\/identities\/[^/]+\/[^/]+$/)) {
        const parts = pathname.split('/')
        const friendId = parts[3]
        const channelId = decodeURIComponent(parts[5])
        const platformUserId = decodeURIComponent(parts[6])
        await this.handleUnlinkChannelIdentityApi(req, res, friendId, channelId, platformUserId)
        return
      }

      // Friend :id 路由
      if (pathname.match(/^\/api\/friends\/[^/]+$/) && req.method === 'GET') {
        const friendId = pathname.split('/')[3]
        await this.handleGetFriendApi(req, res, friendId)
        return
      }

      if (pathname.match(/^\/api\/friends\/[^/]+$/) && req.method === 'PATCH') {
        const friendId = pathname.split('/')[3]
        await this.handleUpdateFriendApi(req, res, friendId)
        return
      }

      if (pathname.match(/^\/api\/friends\/[^/]+$/) && req.method === 'DELETE') {
        const friendId = pathname.split('/')[3]
        await this.handleDeleteFriendApi(req, res, friendId)
        return
      }

      // PendingMessage 路由 — /approve 子路径优先匹配
      if (req.method === 'POST' && pathname.match(/^\/api\/pending-messages\/[^/]+\/approve$/)) {
        const msgId = pathname.split('/')[3]
        await this.handleApprovePendingMessageApi(req, res, msgId)
        return
      }

      if (pathname.match(/^\/api\/pending-messages\/[^/]+$/) && req.method === 'DELETE') {
        const msgId = pathname.split('/')[3]
        await this.handleRejectPendingMessageApi(req, res, msgId)
        return
      }

      if (pathname === '/api/pending-messages' && req.method === 'GET') {
        await this.handleListPendingMessagesApi(req, res, url)
        return
      }

      if (pathname === '/api/pending-messages' && req.method === 'POST') {
        await this.handleUpsertPendingMessageApi(req, res)
        return
      }

      // Model Provider 路由
      if (pathname === '/api/model-providers' && req.method === 'GET') {
        await this.handleListProvidersApi(req, res)
        return
      }

      if (pathname === '/api/model-providers' && req.method === 'POST') {
        await this.handleCreateProviderApi(req, res)
        return
      }

      if (pathname.startsWith('/api/model-providers/') && req.method === 'GET') {
        const id = pathname.split('/')[3]
        await this.handleGetProviderApi(req, res, id)
        return
      }

      if (pathname.startsWith('/api/model-providers/') && req.method === 'PATCH') {
        const id = pathname.split('/')[3]
        await this.handleUpdateProviderApi(req, res, id)
        return
      }

      if (pathname.startsWith('/api/model-providers/') && req.method === 'DELETE') {
        const id = pathname.split('/')[3]
        await this.handleDeleteProviderApi(req, res, id)
        return
      }

      if (pathname === '/api/model-providers/import-from-vendor' && req.method === 'POST') {
        await this.handleImportFromVendorApi(req, res)
        return
      }

      if (pathname === '/api/preset-vendors' && req.method === 'GET') {
        await this.handleListPresetVendorsApi(req, res)
        return
      }

      if (pathname === '/api/model-config/global' && req.method === 'GET') {
        await this.handleGetGlobalConfigApi(req, res)
        return
      }

      if (pathname === '/api/model-config/global' && req.method === 'PATCH') {
        await this.handleUpdateGlobalConfigApi(req, res)
        return
      }

      if (pathname === '/api/config/status' && req.method === 'GET') {
        await this.handleGetConfigStatusApi(req, res)
        return
      }

      // Agent Implementation 路由
      if (pathname === '/api/agent-implementations' && req.method === 'GET') {
        await this.handleListImplementationsApi(req, res, url)
        return
      }

      if (pathname === '/api/agent-implementations/preview' && req.method === 'POST') {
        await this.handlePreviewModuleApi(req, res)
        return
      }

      if (pathname === '/api/agent-implementations/install' && req.method === 'POST') {
        await this.handleInstallModuleApi(req, res)
        return
      }

      if (pathname.startsWith('/api/agent-implementations/') && req.method === 'GET') {
        const id = pathname.split('/')[3]
        await this.handleGetImplementationApi(req, res, id)
        return
      }

      if (pathname.startsWith('/api/agent-implementations/') && req.method === 'DELETE') {
        const id = pathname.split('/')[3]
        await this.handleUninstallModuleApi(req, res, id)
        return
      }

      // Agent Instance 路由
      if (pathname === '/api/agent-instances' && req.method === 'GET') {
        await this.handleListInstancesApi(req, res, url)
        return
      }

      if (pathname === '/api/agent-instances' && req.method === 'POST') {
        await this.handleCreateInstanceApi(req, res)
        return
      }

      // Agent Instance :id 路由 — 需要检查是否有 /config 子路径
      if (pathname.match(/^\/api\/agent-instances\/[^/]+\/config$/) && req.method === 'GET') {
        const id = pathname.split('/')[3]
        await this.handleGetInstanceConfigApi(req, res, id)
        return
      }

      if (pathname.match(/^\/api\/agent-instances\/[^/]+\/config$/) && req.method === 'PATCH') {
        const id = pathname.split('/')[3]
        await this.handleUpdateInstanceConfigApi(req, res, id)
        return
      }

      if (pathname.startsWith('/api/agent-instances/') && req.method === 'GET') {
        const id = pathname.split('/')[3]
        await this.handleGetInstanceApi(req, res, id)
        return
      }

      if (pathname.startsWith('/api/agent-instances/') && req.method === 'PATCH') {
        const id = pathname.split('/')[3]
        await this.handleUpdateInstanceApi(req, res, id)
        return
      }

      if (pathname.startsWith('/api/agent-instances/') && req.method === 'DELETE') {
        const id = pathname.split('/')[3]
        await this.handleDeleteInstanceApi(req, res, id)
        return
      }

      // MCP Server 路由
      if (pathname === '/api/mcp-servers' && req.method === 'GET') {
        await this.handleListMCPServersApi(req, res)
        return
      }

      if (pathname === '/api/mcp-servers' && req.method === 'POST') {
        await this.handleCreateMCPServerApi(req, res)
        return
      }

      if (pathname.match(/^\/api\/mcp-servers\/[^/]+$/) && req.method === 'GET') {
        const id = pathname.split('/')[3]
        await this.handleGetMCPServerApi(req, res, id)
        return
      }

      if (pathname.match(/^\/api\/mcp-servers\/[^/]+$/) && req.method === 'PATCH') {
        const id = pathname.split('/')[3]
        await this.handleUpdateMCPServerApi(req, res, id)
        return
      }

      if (pathname.match(/^\/api\/mcp-servers\/[^/]+$/) && req.method === 'DELETE') {
        const id = pathname.split('/')[3]
        await this.handleDeleteMCPServerApi(req, res, id)
        return
      }

      // MCP Server JSON 批量导入
      if (pathname === '/api/mcp-servers/import-json' && req.method === 'POST') {
        await this.handleImportMCPServersFromJsonApi(req, res)
        return
      }

      // Skill 路由
      if (pathname === '/api/skills' && req.method === 'GET') {
        await this.handleListSkillsApi(req, res)
        return
      }

      if (pathname === '/api/skills' && req.method === 'POST') {
        await this.handleCreateSkillApi(req, res)
        return
      }

      if (pathname.match(/^\/api\/skills\/[^/]+$/) && req.method === 'GET') {
        const id = pathname.split('/')[3]
        await this.handleGetSkillApi(req, res, id)
        return
      }

      if (pathname.match(/^\/api\/skills\/[^/]+$/) && req.method === 'PATCH') {
        const id = pathname.split('/')[3]
        await this.handleUpdateSkillApi(req, res, id)
        return
      }

      if (pathname.match(/^\/api\/skills\/[^/]+$/) && req.method === 'DELETE') {
        const id = pathname.split('/')[3]
        await this.handleDeleteSkillApi(req, res, id)
        return
      }

      // Skill 导入路由
      if (pathname === '/api/skills/import-git/scan' && req.method === 'POST') {
        await this.handleScanSkillGitApi(req, res)
        return
      }

      if (pathname === '/api/skills/import-git/install' && req.method === 'POST') {
        await this.handleInstallSkillGitApi(req, res)
        return
      }

      if (pathname === '/api/skills/import-local' && req.method === 'POST') {
        await this.handleImportSkillLocalApi(req, res)
        return
      }

      if (pathname === '/api/skills/import-upload' && req.method === 'POST') {
        await this.handleImportSkillUploadApi(req, res)
        return
      }

      // 必要工具配置路由
      if (pathname === '/api/essential-tools' && req.method === 'GET') {
        const config = this.essentialToolsManager.get()
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(config))
        return
      }

      if (pathname === '/api/essential-tools' && req.method === 'PATCH') {
        const params = await this.readJsonBody<Record<string, unknown>>(req)
        const config = await this.essentialToolsManager.update(params)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(config))
        return
      }

      // Channel Implementation 路由
      if (pathname === '/api/channel-implementations' && req.method === 'GET') {
        await this.handleListChannelImplementationsApi(req, res, url)
        return
      }

      if (pathname.startsWith('/api/channel-implementations/') && req.method === 'GET') {
        const id = pathname.split('/')[3]
        await this.handleGetChannelImplementationApi(req, res, id)
        return
      }

      // Channel Instance 路由
      if (pathname === '/api/channel-instances' && req.method === 'GET') {
        await this.handleListChannelInstancesApi(req, res, url)
        return
      }

      if (pathname === '/api/channel-instances' && req.method === 'POST') {
        await this.handleCreateChannelInstanceApi(req, res)
        return
      }

      // Channel Instance :id/config 路由
      if (pathname.match(/^\/api\/channel-instances\/[^/]+\/config$/) && req.method === 'GET') {
        const id = decodeURIComponent(pathname.split('/')[3])
        await this.handleGetChannelInstanceConfigApi(req, res, id)
        return
      }

      if (pathname.match(/^\/api\/channel-instances\/[^/]+\/config$/) && req.method === 'PATCH') {
        const id = decodeURIComponent(pathname.split('/')[3])
        await this.handleUpdateChannelInstanceConfigApi(req, res, id)
        return
      }

      // Channel Instance :id/local-config 路由（启动前环境变量配置）
      if (pathname.match(/^\/api\/channel-instances\/[^/]+\/local-config$/) && req.method === 'GET') {
        const id = decodeURIComponent(pathname.split('/')[3])
        await this.handleGetChannelLocalConfigApi(res, id)
        return
      }

      if (pathname.match(/^\/api\/channel-instances\/[^/]+\/local-config$/) && (req.method === 'PUT' || req.method === 'POST')) {
        const id = decodeURIComponent(pathname.split('/')[3])
        await this.handlePutChannelLocalConfigApi(req, res, id)
        return
      }

      // Channel Instance health（protocol-channel §7.1）
      if (pathname.match(/^\/api\/channel-instances\/[^/]+\/health$/) && req.method === 'GET') {
        const id = decodeURIComponent(pathname.split('/')[3])
        try {
          const health = await this.channelManager.getHealth(id)
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(health))
        } catch (err) {
          const status = (err instanceof Error && err.message.includes('not running')) ? 503 : 500
          res.writeHead(status, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'health check failed' }))
        }
        return
      }

      // Channel Instance 生命周期路由
      if (pathname.match(/^\/api\/channel-instances\/[^/]+\/start$/) && req.method === 'POST') {
        const id = decodeURIComponent(pathname.split('/')[3])
        try {
          await this.handleStartModuleAdmin({ module_id: id })
          const finalStatus = await this.waitForModuleStatus(id, s => s !== 'starting', 8000)
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ status: finalStatus }))
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'start failed' }))
        }
        return
      }

      if (pathname.match(/^\/api\/channel-instances\/[^/]+\/stop$/) && req.method === 'POST') {
        const id = decodeURIComponent(pathname.split('/')[3])
        try {
          await this.handleStopModuleAdmin({ module_id: id, force: false })
          const finalStatus = await this.waitForModuleStatus(id, s => s !== 'running' && s !== 'stopping', 8000)
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ status: finalStatus }))
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'stop failed' }))
        }
        return
      }

      if (pathname.match(/^\/api\/channel-instances\/[^/]+\/restart$/) && req.method === 'POST') {
        const id = decodeURIComponent(pathname.split('/')[3])
        try {
          await this.handleRestartModuleAdmin({ module_id: id })
          const finalStatus = await this.waitForModuleStatus(id, s => s !== 'starting', 8000)
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ status: finalStatus }))
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'restart failed' }))
        }
        return
      }

      // Channel Instance :id 路由
      if (pathname.startsWith('/api/channel-instances/') && req.method === 'GET') {
        const id = decodeURIComponent(pathname.split('/')[3])
        await this.handleGetChannelInstanceApi(req, res, id)
        return
      }

      if (pathname.startsWith('/api/channel-instances/') && req.method === 'PATCH') {
        const id = decodeURIComponent(pathname.split('/')[3])
        await this.handleUpdateChannelInstanceApi(req, res, id)
        return
      }

      if (pathname.startsWith('/api/channel-instances/') && req.method === 'DELETE') {
        const id = decodeURIComponent(pathname.split('/')[3])
        await this.handleDeleteChannelInstanceApi(req, res, id)
        return
      }

      // Chat 路由
      if (pathname === '/api/chat/messages' && req.method === 'GET') {
        await this.handleGetChatMessagesApi(req, res, url)
        return
      }

      if (pathname === '/api/chat/messages' && req.method === 'DELETE') {
        await this.handleClearChatMessagesApi(req, res)
        return
      }

      // Agent LLM 需求 API
      if (pathname === '/api/agent-llm-requirements' && req.method === 'GET') {
        await this.handleGetAgentLLMRequirementsApi(req, res)
        return
      }

      // 模块配置管理 API
      if (req.method === 'GET' && pathname.match(/^\/api\/modules\/[^/]+\/config$/)) {
        const moduleId = pathname.split('/')[3]
        const result = await this.handleGetModuleConfig({ module_id: moduleId })
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(result))
        return
      }

      if (req.method === 'PUT' && pathname.match(/^\/api\/modules\/[^/]+\/config$/)) {
        const moduleId = pathname.split('/')[3]
        const body = await this.readJsonBody<{ config: Record<string, string> }>(req)
        const result = await this.handleSetModuleConfig({
          module_id: moduleId,
          config: body.config,
        })
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(result))
        return
      }

      // 模块生命周期控制 API
      if (req.method === 'POST' && pathname.match(/^\/api\/modules\/[^/]+\/start$/)) {
        const moduleId = pathname.split('/')[3]
        const result = await this.handleStartModuleAdmin({ module_id: moduleId })
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(result))
        return
      }

      if (req.method === 'POST' && pathname.match(/^\/api\/modules\/[^/]+\/stop$/)) {
        const moduleId = pathname.split('/')[3]
        const body = await this.readJsonBody<{ force?: boolean }>(req)
        const result = await this.handleStopModuleAdmin({
          module_id: moduleId,
          force: body.force || false,
        })
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(result))
        return
      }

      if (req.method === 'POST' && pathname.match(/^\/api\/modules\/[^/]+\/restart$/)) {
        const moduleId = pathname.split('/')[3]
        const result = await this.handleRestartModuleAdmin({ module_id: moduleId })
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(result))
        return
      }

      // Channel state_dir 扫描（检测已安装的 OpenClaw 插件）
      if (req.method === 'POST' && pathname === '/api/channels/scan-state-dir') {
        const body = await this.readJsonBody<{ state_dir: string }>(req)
        if (!body.state_dir) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'state_dir is required' }))
          return
        }
        try {
          const result = this.channelManager.scanStateDir(body.state_dir)
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(result))
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'scan failed' }))
        }
        return
      }

      // PTY 路由（Web CLI 终端）
      if (req.method === 'POST' && pathname === '/api/channels/pty/create') {
        const body = await this.readJsonBody<{ module_id?: string; init_cmd?: string }>(req)
        const moduleId = body.module_id ?? `channel-openclaw-${Date.now()}`
        const stateDir = path.join(this.adminConfig.data_dir, 'openclaw', moduleId)
        const sessionId = this.ptyManager!.createSession(moduleId, stateDir, body.init_cmd)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ session_id: sessionId, module_id: moduleId, state_dir: stateDir }))
        return
      }

      const ptyKillMatch = pathname.match(/^\/api\/channels\/pty\/([^/]+)$/)
      if (ptyKillMatch && req.method === 'DELETE') {
        this.ptyManager!.killSession(ptyKillMatch[1])
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true }))
        return
      }

      // Agent Trace API (simplified - no instanceId)
      if (pathname === '/api/agent/traces' && req.method === 'GET') {
        await this.handleGetAgentTracesApi(req, res, url)
        return
      }
      if (pathname === '/api/agent/traces' && req.method === 'DELETE') {
        await this.handleClearAgentTracesApi(req, res)
        return
      }

      const agentTraceDetailMatch = pathname.match(/^\/api\/agent\/traces\/([^/]+)$/)
      if (agentTraceDetailMatch && req.method === 'GET') {
        await this.handleGetAgentTraceApi(req, res, agentTraceDetailMatch[1])
        return
      }

      // Agent Config API (simplified - no instanceId)
      if (pathname === '/api/agent/config' && req.method === 'GET') {
        await this.handleGetActiveAgentConfigApi(req, res)
        return
      }
      if (pathname === '/api/agent/config' && req.method === 'PATCH') {
        await this.handleUpdateActiveAgentConfigApi(req, res)
        return
      }

      // Agent Trace API (legacy, kept for backward compatibility)
      const traceListMatch = pathname.match(/^\/api\/agents\/([^/]+)\/traces$/)
      if (traceListMatch && req.method === 'GET') {
        await this.handleGetAgentTracesApi(req, res, url)
        return
      }
      if (traceListMatch && req.method === 'DELETE') {
        await this.handleClearAgentTracesApi(req, res)
        return
      }

      const traceDetailMatch = pathname.match(/^\/api\/agents\/([^/]+)\/traces\/([^/]+)$/)
      if (traceDetailMatch && req.method === 'GET') {
        await this.handleGetAgentTraceApi(req, res, traceDetailMatch[2])
        return
      }

      // Memory 管理 API
      if (req.method === 'GET' && pathname === '/api/memory/modules') {
        await this.handleGetMemoryModulesApi(req, res)
        return
      }

      if (req.method === 'GET' && pathname === '/api/memory/stats') {
        await this.handleGetMemoryStatsApi(req, res, url)
        return
      }

      if (req.method === 'GET' && pathname === '/api/memory/short-term') {
        await this.handleSearchShortTermApi(req, res, url)
        return
      }

      if (req.method === 'GET' && pathname === '/api/memory/long-term') {
        await this.handleSearchLongTermApi(req, res, url)
        return
      }

      if (req.method === 'GET' && pathname.match(/^\/api\/memory\/[^/]+$/)) {
        const memoryId = pathname.split('/')[3]
        await this.handleGetMemoryApi(req, res, url, memoryId)
        return
      }

      if (req.method === 'DELETE' && pathname.match(/^\/api\/memory\/[^/]+$/)) {
        const memoryId = pathname.split('/')[3]
        await this.handleDeleteMemoryApi(req, res, url, memoryId)
        return
      }

      // 静态文件服务（Web UI）
      // dev 模式下前端由 Vite 提供，不 serve 静态文件（可能过期）
      if (!pathname.startsWith('/api/')) {
        if (process.env.CRABOT_DEV === 'true') {
          res.writeHead(404)
          res.end('Dev mode: use Vite dev server for frontend')
          return
        }
        await this.serveStaticFile(pathname, res)
        return
      }

      // API 404
      res.writeHead(404)
      res.end(JSON.stringify({ error: 'Not found' }))
    } catch (error) {
      console.error('[Admin] API error:', error)
      res.writeHead(500)
      res.end(JSON.stringify({ error: 'Internal server error' }))
    }
  }

  private async serveStaticFile(pathname: string, res: ServerResponse): Promise<void> {
    const webDir = path.join(__dirname, '../dist/web')
    let filePath = path.join(webDir, pathname)

    // 防止路径遍历
    if (!filePath.startsWith(webDir)) {
      res.writeHead(403)
      res.end('Forbidden')
      return
    }

    try {
      const stat = await fs.stat(filePath)
      if (stat.isFile()) {
        const content = await fs.readFile(filePath)
        const ext = path.extname(filePath).toLowerCase()
        const contentTypes: Record<string, string> = {
          '.html': 'text/html; charset=utf-8',
          '.js': 'application/javascript; charset=utf-8',
          '.css': 'text/css; charset=utf-8',
          '.json': 'application/json; charset=utf-8',
          '.png': 'image/png',
          '.jpg': 'image/jpeg',
          '.svg': 'image/svg+xml',
          '.ico': 'image/x-icon',
          '.woff': 'font/woff',
          '.woff2': 'font/woff2',
        }
        res.writeHead(200, { 'Content-Type': contentTypes[ext] || 'application/octet-stream' })
        res.end(content)
        return
      }
    } catch {
      // 文件不存在，继续
    }

    // SPA 回退：返回 index.html
    try {
      const indexPath = path.join(webDir, 'index.html')
      const content = await fs.readFile(indexPath)
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(content)
    } catch {
      res.writeHead(404)
      res.end('Web UI not found. Run "npm run build:web" in crabot-admin to build it.')
    }
  }

  private async readJsonBody<T>(req: IncomingMessage, maxBytes = 10 * 1024 * 1024): Promise<T> {
    return new Promise((resolve, reject) => {
      let body = ''
      let size = 0
      req.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > maxBytes) {
          req.destroy()
          reject(new Error(`Request body too large (max ${maxBytes} bytes)`))
          return
        }
        body += chunk
      })
      req.on('end', () => {
        try {
          resolve(JSON.parse(body) as T)
        } catch (e) {
          reject(new Error('Invalid JSON'))
        }
      })
      req.on('error', reject)
    })
  }

  // ============================================================================
  // 认证 API
  // ============================================================================

  private async handleLogin(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await this.readJsonBody<LoginRequest>(req)

    if (body.password !== this.password) {
      res.writeHead(401)
      res.end(JSON.stringify({
        error: AdminErrorCode.INVALID_PASSWORD,
        message: 'Invalid password',
      }))
      return
    }

    const now = Math.floor(Date.now() / 1000)
    const payload: JwtPayload = {
      sub: 'admin',
      iat: now,
      exp: now + this.adminConfig.token_ttl,
    }

    const token = signJwt(payload, this.jwtSecret)
    const response: LoginResponse = {
      token,
      expires_at: new Date(payload.exp * 1000).toISOString(),
    }

    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(response))
  }

  // ============================================================================
  // Friend REST API
  // ============================================================================

  private async handleListFriendsApi(
    _req: IncomingMessage,
    res: ServerResponse,
    url: URL
  ): Promise<void> {
    const permission = url.searchParams.get('permission') as FriendPermission | null
    const search = url.searchParams.get('search') ?? undefined
    const page = parseInt(url.searchParams.get('page') ?? '1', 10)
    const pageSize = parseInt(url.searchParams.get('page_size') ?? '20', 10)

    let friends = Array.from(this.friends.values())

    // 过滤
    if (permission) {
      friends = friends.filter((f) => f.permission === permission)
    }
    if (search) {
      const searchLower = search.toLowerCase()
      friends = friends.filter((f) =>
        f.display_name.toLowerCase().includes(searchLower)
      )
    }

    // 分页
    const total = friends.length
    const totalPages = Math.ceil(total / pageSize)
    const offset = (page - 1) * pageSize
    friends = friends.slice(offset, offset + pageSize)

    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      items: friends,
      pagination: {
        page,
        page_size: pageSize,
        total_items: total,
        total_pages: totalPages,
      },
    }))
  }

  private async handleCreateFriendApi(_req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await this.readJsonBody<CreateFriendParams>(_req)

    try {
      const result = this.handleCreateFriend(body)
      await this.saveData()

      res.writeHead(201, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(result))
    } catch (error) {
      if (error instanceof Error) {
        if (error.message.includes('master already exists')) {
          res.writeHead(400)
          res.end(JSON.stringify({
            error: AdminErrorCode.MASTER_ALREADY_EXISTS,
            message: error.message,
          }))
          return
        }
        if (error.message.includes('Channel identity already in use')) {
          res.writeHead(409)
          res.end(JSON.stringify({
            error: AdminErrorCode.CHANNEL_IDENTITY_IN_USE,
            message: error.message,
          }))
          return
        }
      }
      throw error
    }
  }

  private async handleGetFriendApi(_req: IncomingMessage, res: ServerResponse, friendId: string): Promise<void> {
    try {
      const result = await this.handleGetFriend({ friend_id: friendId })
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(result))
    } catch (error) {
      if (error instanceof Error && error.message === 'Friend not found') {
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Friend not found' }))
        return
      }
      throw error
    }
  }

  private async handleUpdateFriendApi(req: IncomingMessage, res: ServerResponse, friendId: string): Promise<void> {
    const body = await this.readJsonBody<Partial<UpdateFriendParams>>(req)
    try {
      const result = await this.handleUpdateFriend({ ...body, friend_id: friendId })
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(result))
    } catch (error) {
      if (error instanceof Error && error.message === 'Friend not found') {
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Friend not found' }))
        return
      }
      throw error
    }
  }

  private async handleDeleteFriendApi(_req: IncomingMessage, res: ServerResponse, friendId: string): Promise<void> {
    try {
      const result = await this.handleDeleteFriend({ friend_id: friendId })
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(result))
    } catch (error) {
      if (error instanceof Error) {
        if (error.message === 'Friend not found') {
          res.writeHead(404, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'Friend not found' }))
          return
        }
        if (error.message === 'Cannot delete master friend') {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: AdminErrorCode.CANNOT_DELETE_MASTER, message: error.message }))
          return
        }
      }
      throw error
    }
  }

  private async handleLinkChannelIdentityApi(req: IncomingMessage, res: ServerResponse, friendId: string): Promise<void> {
    const body = await this.readJsonBody<{ channel_identity: ChannelIdentity }>(req)
    try {
      const result = await this.handleLinkChannelIdentity({
        friend_id: friendId,
        channel_identity: body.channel_identity,
      })
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(result))
    } catch (error) {
      if (error instanceof Error && error.message === 'Channel identity already in use') {
        res.writeHead(409, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: AdminErrorCode.CHANNEL_IDENTITY_IN_USE, message: error.message }))
        return
      }
      throw error
    }
  }

  private async handleUnlinkChannelIdentityApi(
    _req: IncomingMessage, res: ServerResponse,
    friendId: string, channelId: string, platformUserId: string
  ): Promise<void> {
    try {
      const result = await this.handleUnlinkChannelIdentity({
        friend_id: friendId,
        channel_id: channelId,
        platform_user_id: platformUserId,
      })
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(result))
    } catch (error) {
      if (error instanceof Error) {
        if (error.message === 'Friend not found') {
          res.writeHead(404, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'Friend not found' }))
          return
        }
        if (error.message === 'Channel identity not found') {
          res.writeHead(404, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'Channel identity not found' }))
          return
        }
      }
      throw error
    }
  }

  private async handleListPendingMessagesApi(_req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const channelId = url.searchParams.get('channel_id') || undefined
    const page = parseInt(url.searchParams.get('page') ?? '1', 10)
    const pageSize = parseInt(url.searchParams.get('page_size') ?? '20', 10)

    const result = await this.handleListPendingMessages({
      channel_id: channelId,
      pagination: { page, page_size: pageSize },
    })
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(result))
  }

  private async handleApprovePendingMessageApi(req: IncomingMessage, res: ServerResponse, msgId: string): Promise<void> {
    const body = await this.readJsonBody<{ display_name: string; permission_template_id: string }>(req)
    try {
      const result = await this.handleApprovePendingMessage({
        pending_message_id: msgId,
        display_name: body.display_name,
        permission_template_id: body.permission_template_id,
      })
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(result))
    } catch (error) {
      if (error instanceof Error && error.message === 'Pending message not found') {
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Pending message not found' }))
        return
      }
      throw error
    }
  }

  private async handleRejectPendingMessageApi(_req: IncomingMessage, res: ServerResponse, msgId: string): Promise<void> {
    try {
      const result = await this.handleRejectPendingMessage({ pending_message_id: msgId })
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(result))
    } catch (error) {
      if (error instanceof Error && error.message === 'Pending message not found') {
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Pending message not found' }))
        return
      }
      throw error
    }
  }

  private async handleUpsertPendingMessageApi(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await this.readJsonBody<UpsertPendingMessageParams>(req)
    const result = await this.handleUpsertPendingMessage(body)
    res.writeHead(result.created ? 201 : 200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(result))
  }

  // ============================================================================
  // Friend 协议方法
  // =============================================================================

  private async handleListFriends(params: {
    permission?: FriendPermission
    search?: string
    pagination?: { page: number; page_size: number }
  }): Promise<{ items: Friend[]; pagination: { page: number; page_size: number; total_items: number; total_pages: number } }> {
    let friends = Array.from(this.friends.values())

    if (params.permission) {
      friends = friends.filter((f) => f.permission === params.permission)
    }
    if (params.search) {
      const searchLower = params.search.toLowerCase()
      friends = friends.filter((f) =>
        f.display_name.toLowerCase().includes(searchLower)
      )
    }

    const page = params.pagination?.page ?? 1
    const pageSize = params.pagination?.page_size ?? 20
    const total = friends.length
    const totalPages = Math.ceil(total / pageSize)
    const offset = (page - 1) * pageSize
    friends = friends.slice(offset, offset + pageSize)

    return {
      items: friends,
      pagination: {
        page,
        page_size: pageSize,
        total_items: total,
        total_pages: totalPages,
      },
    }
  }

  private async handleGetFriend(params: { friend_id: FriendId }): Promise<{ friend: Friend }> {
    const friend = this.friends.get(params.friend_id)
    if (!friend) {
      throw new Error('Friend not found')
    }
    return { friend }
  }

  private handleCreateFriend(params: CreateFriendParams): { friend: Friend } {
    // 检查是否已存在 master
    if (params.permission === 'master') {
      const existingMaster = Array.from(this.friends.values()).find(
        (f) => f.permission === 'master'
      )
      if (existingMaster) {
        throw new Error('A master friend already exists')
      }
    }

    // 检查 channel identity 是否已被使用
    if (params.channel_identities) {
      for (const identity of params.channel_identities) {
        const key = this.getChannelIdentityKey(identity)
        if (this.channelIdentityIndex.has(key)) {
          throw new Error(`Channel identity already in use: ${key}`)
        }
      }
    }

    const now = generateTimestamp()
    const friend: Friend = {
      id: generateId(),
      display_name: params.display_name,
      permission: params.permission,
      permission_template_id: params.permission_template_id,
      channel_identities: params.channel_identities ?? [],
      created_at: now,
      updated_at: now,
    }

    // 更新索引
    for (const identity of friend.channel_identities) {
      const key = this.getChannelIdentityKey(identity)
      this.channelIdentityIndex.set(key, friend.id)
    }

    this.friends.set(friend.id, friend)
    return { friend }
  }

  private async handleUpdateFriend(params: UpdateFriendParams): Promise<{ friend: Friend }> {
    const existing = this.friends.get(params.friend_id)
    if (!existing) {
      throw new Error('Friend not found')
    }

    // 检查 master 权限变更
    if (params.permission === 'master' && existing.permission !== 'master') {
      const existingMaster = Array.from(this.friends.values()).find(
        (f) => f.permission === 'master' && f.id !== params.friend_id
      )
      if (existingMaster) {
        throw new Error('A master friend already exists')
      }
    }

    const friend: Friend = {
      ...existing,
      ...(params.display_name !== undefined ? { display_name: params.display_name } : {}),
      ...(params.permission !== undefined ? { permission: params.permission } : {}),
      ...(params.permission_template_id !== undefined ? { permission_template_id: params.permission_template_id } : {}),
      updated_at: generateTimestamp(),
    }

    this.friends.set(friend.id, friend)
    await this.saveData()

    return { friend }
  }

  private async handleDeleteFriend(params: { friend_id: FriendId }): Promise<{ deleted: true }> {
    const friend = this.friends.get(params.friend_id)
    if (!friend) {
      throw new Error('Friend not found')
    }

    if (friend.permission === 'master') {
      throw new Error('Cannot delete master friend')
    }

    // 清理索引
    for (const identity of friend.channel_identities) {
      const key = this.getChannelIdentityKey(identity)
      this.channelIdentityIndex.delete(key)
    }

    this.friends.delete(params.friend_id)
    await this.saveData()

    return { deleted: true }
  }

  private async handleLinkChannelIdentity(params: {
    friend_id: FriendId
    channel_identity: ChannelIdentity
  }): Promise<{ friend: Friend }> {
    const existing = this.friends.get(params.friend_id)
    if (!existing) {
      throw new Error('Friend not found')
    }

    const key = this.getChannelIdentityKey(params.channel_identity)
    if (this.channelIdentityIndex.has(key)) {
      const existingFriendId = this.channelIdentityIndex.get(key)
      if (existingFriendId !== params.friend_id) {
        throw new Error('Channel identity already in use')
      }
    }

    const friend: Friend = {
      ...existing,
      channel_identities: [...existing.channel_identities, params.channel_identity],
      updated_at: generateTimestamp(),
    }

    this.channelIdentityIndex.set(key, friend.id)
    this.friends.set(friend.id, friend)
    await this.saveData()

    return { friend }
  }

  private async handleUnlinkChannelIdentity(params: {
    friend_id: FriendId
    channel_id: ModuleId
    platform_user_id: string
  }): Promise<{ friend: Friend }> {
    const existing = this.friends.get(params.friend_id)
    if (!existing) {
      throw new Error('Friend not found')
    }

    const key = `${params.channel_id}:${params.platform_user_id}`
    const hasIdentity = existing.channel_identities.some(
      (i) => i.channel_id === params.channel_id && i.platform_user_id === params.platform_user_id
    )

    if (!hasIdentity) {
      throw new Error('Channel identity not found')
    }

    const friend: Friend = {
      ...existing,
      channel_identities: existing.channel_identities.filter(
        (i) => !(i.channel_id === params.channel_id && i.platform_user_id === params.platform_user_id)
      ),
      updated_at: generateTimestamp(),
    }

    this.channelIdentityIndex.delete(key)
    this.friends.set(friend.id, friend)
    await this.saveData()

    return { friend }
  }

  private async handleResolveFriend(params: ResolveFriendParams): Promise<{ friend: Friend | null }> {
    const key = `${params.channel_id}:${params.platform_user_id}`
    const friendId = this.channelIdentityIndex.get(key)

    if (!friendId) {
      return { friend: null }
    }

    const friend = this.friends.get(friendId)
    return { friend: friend ?? null }
  }

  // ============================================================================
  // PendingMessage 协议方法
  // ============================================================================

  private async handleListPendingMessages(params: {
    channel_id?: ModuleId
    pagination?: { page: number; page_size: number }
  }): Promise<{ items: PendingMessage[]; pagination: { page: number; page_size: number; total_items: number; total_pages: number } }> {
    let messages = Array.from(this.pendingMessages.values())

    if (params.channel_id) {
      messages = messages.filter((m) => m.channel_id === params.channel_id)
    }

    // 过滤过期消息
    const now = new Date()
    messages = messages.filter((m) => new Date(m.expires_at) > now)

    const page = params.pagination?.page ?? 1
    const pageSize = params.pagination?.page_size ?? 20
    const total = messages.length
    const totalPages = Math.ceil(total / pageSize)
    const offset = (page - 1) * pageSize
    messages = messages.slice(offset, offset + pageSize)

    return {
      items: messages,
      pagination: {
        page,
        page_size: pageSize,
        total_items: total,
        total_pages: totalPages,
      },
    }
  }

  private async handleApprovePendingMessage(params: {
    pending_message_id: string
    display_name: string
    permission_template_id?: string
  }): Promise<{ friend: Friend; notification_sent: boolean }> {
    const message = this.pendingMessages.get(params.pending_message_id)
    if (!message) {
      throw new Error('Pending message not found')
    }

    // 根据 intent 决定权限
    const isPair = message.intent === 'pair'
    const newIdentity: ChannelIdentity = {
      channel_id: message.channel_id,
      platform_user_id: message.platform_user_id,
      platform_display_name: message.platform_display_name,
    }

    let result: { friend: Friend }

    if (isPair) {
      // /pair 意图：如果已有 master，将新 channel identity 追加到已有 master 上
      // 这支持同一个人通过多个 channel（如企业版+个人版飞书）接入同一个 master 账号
      const existingMaster = Array.from(this.friends.values()).find(f => f.permission === 'master')
      if (existingMaster) {
        result = await this.handleLinkChannelIdentity({
          friend_id: existingMaster.id,
          channel_identity: newIdentity,
        })
      } else {
        result = this.handleCreateFriend({
          display_name: params.display_name,
          permission: 'master',
          channel_identities: [newIdentity],
        })
      }
    } else {
      result = this.handleCreateFriend({
        display_name: params.display_name,
        permission: 'normal',
        channel_identities: [newIdentity],
        permission_template_id: params.permission_template_id,
      })
    }

    // 删除待授权消息
    this.pendingMessages.delete(params.pending_message_id)
    await this.saveData()

    // TODO: 通过 Channel 发送通知

    return { friend: result.friend, notification_sent: false }
  }

  private async handleRejectPendingMessage(params: {
    pending_message_id: string
  }): Promise<{ deleted: true }> {
    const exists = this.pendingMessages.has(params.pending_message_id)
    if (!exists) {
      throw new Error('Pending message not found')
    }

    this.pendingMessages.delete(params.pending_message_id)
    await this.saveData()

    return { deleted: true }
  }

  private async handleUpsertPendingMessage(params: UpsertPendingMessageParams): Promise<UpsertPendingMessageResult> {
    // 按 (channel_id, platform_user_id) 去重
    const existingEntry = Array.from(this.pendingMessages.values()).find(
      (m) => m.channel_id === params.channel_id && m.platform_user_id === params.platform_user_id
    )

    const now = generateTimestamp()
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()

    if (existingEntry) {
      const updated: PendingMessage = {
        ...existingEntry,
        platform_display_name: params.platform_display_name,
        content_preview: params.content_preview,
        raw_message: params.raw_message,
        intent: params.intent,
        received_at: now,
        expires_at: expiresAt,
      }
      this.pendingMessages.set(updated.id, updated)
      await this.saveData()
      return { pending_message: updated, created: false }
    }

    const pendingMessage: PendingMessage = {
      id: generateId(),
      channel_id: params.channel_id,
      platform_user_id: params.platform_user_id,
      platform_display_name: params.platform_display_name,
      content_preview: params.content_preview,
      raw_message: params.raw_message,
      intent: params.intent,
      received_at: now,
      expires_at: expiresAt,
    }

    this.pendingMessages.set(pendingMessage.id, pendingMessage)
    await this.saveData()
    return { pending_message: pendingMessage, created: true }
  }

  // ============================================================================
  // 消息鉴权网关（protocol-admin.md §3.4.5）
  // ============================================================================

  /**
   * 处理 channel.message_received 事件：鉴权，决定是否发出 channel.message_authorized
   */
  private async handleChannelMessage(channelId: ModuleId, message: ChannelMessageRef, crabDisplayName?: string): Promise<void> {
    const { platform_user_id, platform_display_name } = message.sender
    const friend = this.resolveFriendByChannelIdentity(channelId, platform_user_id)

    console.log(`[Admin] 📩 handleChannelMessage: channel=${channelId}, sender=${platform_user_id} (${platform_display_name}), friend=${friend ? friend.id : 'NOT_FOUND'}, sessionType=${message.session.type}`)

    if (friend) {
      // 已知 Friend：填充 friend_id，发出授权事件
      const authorizedMessage: ChannelMessageRef = {
        ...message,
        sender: {
          ...message.sender,
          friend_id: friend.id,
        },
      }
      await this.publishMessageAuthorizedEvent(channelId, authorizedMessage, friend, crabDisplayName)
      return
    }

    // 未知发信人
    if (message.session.type !== 'private') {
      // 群聊：检查此 Channel 上是否有 Master（群本身是准入门槛，§8.3/8.4）
      if (this.hasMasterOnChannel(channelId)) {
        const guestFriend: Friend = {
          id: `guest:${channelId}:${platform_user_id}` as FriendId,
          display_name: platform_display_name || platform_user_id,
          permission: 'normal',
          channel_identities: [{ channel_id: channelId, platform_user_id, platform_display_name: platform_display_name || platform_user_id }],
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }
        await this.publishMessageAuthorizedEvent(channelId, message, guestFriend, crabDisplayName)
        return
      }
      // 无 Master 在此 Channel → 静默丢弃
      console.log(`[Admin] ⚠️ Group message from unknown sender dropped: no master on channel ${channelId}`)
      return
    }

    const body = (message.content.type === 'text' ? (message.content.text ?? '') : '').trim()
    if (body === '/pair' || body === '/apply') {
      const intent = body === '/pair' ? 'pair' : 'apply'
      await this.handleUpsertPendingMessage({
        channel_id: channelId,
        platform_user_id,
        platform_display_name,
        content_preview: body,
        intent,
        raw_message: message,
      })
      console.log(`[Admin] Upserted pending message (${intent}) for unknown sender: ${platform_user_id} (${platform_display_name})`)
    }
    // 其他私聊陌生人消息静默丢弃
    console.log(`[Admin] ⚠️ Private message from unknown sender dropped (not /pair or /apply): ${platform_user_id}, text="${(message.content.text ?? '').slice(0, 30)}"`)
  }

  /**
   * 根据 (channelId, platformUserId) 在内存中查找 Friend
   */
  private resolveFriendByChannelIdentity(channelId: ModuleId, platformUserId: string): Friend | null {
    const key = `${channelId}:${platformUserId}`
    const friendId = this.channelIdentityIndex.get(key)
    if (!friendId) return null
    return this.friends.get(friendId) ?? null
  }

  /**
   * 检查给定 Channel 上是否注册了 Master（§8.4 群聊准入依据）
   */
  private hasMasterOnChannel(channelId: ModuleId): boolean {
    for (const friend of this.friends.values()) {
      if (friend.permission !== 'master') continue
      if (friend.channel_identities.some(ci => ci.channel_id === channelId)) return true
    }
    return false
  }

  /**
   * 发布 channel.message_authorized 事件
   */
  private async publishMessageAuthorizedEvent(
    channelId: ModuleId,
    message: ChannelMessageRef,
    friend: Friend,
    crabDisplayName?: string
  ): Promise<void> {
    const event: Event = {
      id: generateId(),
      type: 'channel.message_authorized',
      source: this.config.moduleId,
      payload: {
        channel_id: channelId,
        message,
        friend,
        ...(crabDisplayName !== undefined ? { crab_display_name: crabDisplayName } : {}),
      },
      timestamp: generateTimestamp(),
    }
    await this.rpcClient.publishEvent(event, this.config.moduleId)
  }

  // ============================================================================
  // 辅助方法（PendingMessage 区域）
  // ============================================================================

  private getChannelIdentityKey(identity: ChannelIdentity): string {
    return `${identity.channel_id}:${identity.platform_user_id}`
  }

  private async loadData(): Promise<void> {
    try {
      const friendsData = await fs.readFile(this.friendsFilePath, 'utf-8')
      const friendsArray = JSON.parse(friendsData) as Friend[]
      for (const friend of friendsArray) {
        // 兼容旧数据：ChannelIdentity 缺少 platform_display_name 时使用 platform_user_id
        const migratedFriend: Friend = {
          ...friend,
          channel_identities: friend.channel_identities.map((ci) => ({
            ...ci,
            platform_display_name: ci.platform_display_name || ci.platform_user_id,
          })),
        }
        this.friends.set(migratedFriend.id, migratedFriend)
        for (const identity of migratedFriend.channel_identities) {
          const key = this.getChannelIdentityKey(identity)
          this.channelIdentityIndex.set(key, friend.id)
        }
      }
      console.log(`[Admin] Loaded ${this.friends.size} friends`)
    } catch {
      console.log('[Admin] No existing friends data, starting fresh')
    }

    try {
      const templatesData = await fs.readFile(this.templatesFilePath, 'utf-8')
      const templatesArray = JSON.parse(templatesData) as PermissionTemplate[]
      for (const template of templatesArray) {
        this.permissionTemplates.set(template.id, template)
      }
      console.log(`[Admin] Loaded ${this.permissionTemplates.size} permission templates`)
    } catch {
      console.log('[Admin] No existing templates data')
    }

    try {
      const pendingData = await fs.readFile(this.pendingMessagesFilePath, 'utf-8')
      const pendingArray = JSON.parse(pendingData) as Array<Omit<PendingMessage, 'intent'> & { intent?: 'pair' | 'apply' }>
      const now = new Date()
      for (const msg of pendingArray) {
        // 跳过过期消息
        if (new Date(msg.expires_at) > now) {
          // 兼容旧数据：缺少 intent 时默认 apply
          const migrated: PendingMessage = { ...msg, intent: msg.intent ?? 'apply' }
          this.pendingMessages.set(migrated.id, migrated)
        }
      }
      console.log(`[Admin] Loaded ${this.pendingMessages.size} pending messages`)
    } catch {
      console.log('[Admin] No existing pending messages data')
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

  private async saveData(): Promise<void> {
    const friendsArray = Array.from(this.friends.values())
    await this.atomicWriteFile(this.friendsFilePath, JSON.stringify(friendsArray, null, 2))

    const templatesArray = Array.from(this.permissionTemplates.values())
    await this.atomicWriteFile(this.templatesFilePath, JSON.stringify(templatesArray, null, 2))

    const pendingArray = Array.from(this.pendingMessages.values())
    await this.atomicWriteFile(this.pendingMessagesFilePath, JSON.stringify(pendingArray, null, 2))
  }

  private async initSystemTemplates(): Promise<void> {
    const now = generateTimestamp()

    const systemTemplates: PermissionTemplate[] = [
      {
        id: 'master_private',
        name: 'Master 私聊',
        description: 'Master 用户私聊的权限配置',
        is_system: true,
        desktop: true,
        network: { mode: 'allow_all', rules: [] },
        storage: [{ path: '/', access: 'readwrite' }],
        memory_scopes: [],
        created_at: now,
        updated_at: now,
      },
      {
        id: 'group_default',
        name: '群聊默认',
        description: '群聊的默认权限配置',
        is_system: true,
        desktop: false,
        network: { mode: 'whitelist', rules: [] },
        storage: [{ path: '/shared', access: 'read' }],
        memory_scopes: [],
        created_at: now,
        updated_at: now,
      },
      {
        id: 'minimal',
        name: '最低权限',
        description: '最低权限配置',
        is_system: true,
        desktop: false,
        network: { mode: 'blacklist', rules: ['*'] },
        storage: [],
        memory_scopes: [],
        created_at: now,
        updated_at: now,
      },
      {
        id: 'standard',
        name: '普通权限',
        description: '普通用户的权限配置',
        is_system: true,
        desktop: false,
        network: { mode: 'whitelist', rules: [] },
        storage: [{ path: '/home', access: 'read' }],
        memory_scopes: [],
        created_at: now,
        updated_at: now,
      },
    ]

    for (const template of systemTemplates) {
      if (!this.permissionTemplates.has(template.id)) {
        this.permissionTemplates.set(template.id, template)
      }
    }

    await this.saveData()
  }

  // ============================================================================
  // Task 协议方法
  // ============================================================================

  private async handleCreateTask(params: CreateTaskParams): Promise<{ task: Task }> {
    const now = generateTimestamp()
    const task: Task = {
      id: generateId(),
      type: params.type,
      status: 'pending',
      priority: params.priority ?? 'normal',
      title: params.title,
      description: params.description,
      source: params.source,
      worker_agent_id: undefined,
      plan: undefined,
      input: params.input,
      output: undefined,
      error: undefined,
      messages: [],
      tags: params.tags ?? [],
      created_at: now,
      updated_at: now,
      started_at: undefined,
      completed_at: undefined,
      expires_at: params.expires_at,
    }

    this.tasks.set(task.id, task)

    // 发布事件
    this.publishAdminEvent('admin.task_created', { task })

    return { task }
  }

  private async handleGetTask(params: GetTaskParams): Promise<{ task: Task }> {
    const task = this.tasks.get(params.task_id)
    if (!task) {
      throw new Error(AdminErrorCode.TASK_NOT_FOUND)
    }
    return { task }
  }

  private async handleListTasks(params: ListTasksParams): Promise<{ items: Task[]; pagination: { page: number; page_size: number; total_items: number; total_pages: number } }> {
    let tasks = Array.from(this.tasks.values())

    // 过滤
    if (params.filter) {
      const filter = params.filter

      if (filter.status) {
        const statuses = Array.isArray(filter.status) ? filter.status : [filter.status]
        tasks = tasks.filter((t) => statuses.includes(t.status))
      }
      if (filter.type) {
        const types = Array.isArray(filter.type) ? filter.type : [filter.type]
        tasks = tasks.filter((t) => types.includes(t.type))
      }
      if (filter.priority) {
        const priorities = Array.isArray(filter.priority) ? filter.priority : [filter.priority]
        tasks = tasks.filter((t) => priorities.includes(t.priority))
      }
      if (filter.worker_agent_id) {
        tasks = tasks.filter((t) => t.worker_agent_id === filter.worker_agent_id)
      }
      if (filter.source_channel_id) {
        tasks = tasks.filter((t) => t.source.channel_id === filter.source_channel_id)
      }
      if (filter.source_friend_id) {
        tasks = tasks.filter((t) => t.source.friend_id === filter.source_friend_id)
      }
      if (filter.tags && filter.tags.length > 0) {
        tasks = tasks.filter((t) => filter.tags!.some((tag) => t.tags.includes(tag)))
      }
      if (filter.search) {
        const searchLower = filter.search.toLowerCase()
        tasks = tasks.filter(
          (t) =>
            t.title.toLowerCase().includes(searchLower) ||
            (t.description?.toLowerCase().includes(searchLower) ?? false)
        )
      }
      if (filter.created_after) {
        tasks = tasks.filter((t) => t.created_at >= filter.created_after!)
      }
      if (filter.created_before) {
        tasks = tasks.filter((t) => t.created_at <= filter.created_before!)
      }
    }

    // 排序
    if (params.sort) {
      const { field, order } = params.sort
      tasks.sort((a, b) => {
        let comparison = 0
        switch (field) {
          case 'created_at':
            comparison = a.created_at.localeCompare(b.created_at)
            break
          case 'updated_at':
            comparison = a.updated_at.localeCompare(b.updated_at)
            break
          case 'priority': {
            const priorityOrder: Record<TaskPriority, number> = { low: 0, normal: 1, high: 2, urgent: 3 }
            comparison = priorityOrder[a.priority] - priorityOrder[b.priority]
            break
          }
          case 'status': {
            const statusOrder: Record<TaskStatus, number> = {
              pending: 0, planning: 1, executing: 2, waiting_human: 3,
              completed: 4, failed: 5, cancelled: 6
            }
            comparison = statusOrder[a.status] - statusOrder[b.status]
            break
          }
        }
        return order === 'desc' ? -comparison : comparison
      })
    } else {
      // 默认按创建时间倒序
      tasks.sort((a, b) => b.created_at.localeCompare(a.created_at))
    }

    // 分页
    const page = params.page ?? 1
    const pageSize = params.page_size ?? 20
    const total = tasks.length
    const totalPages = Math.ceil(total / pageSize)
    const offset = (page - 1) * pageSize
    tasks = tasks.slice(offset, offset + pageSize)

    return {
      items: tasks,
      pagination: {
        page,
        page_size: pageSize,
        total_items: total,
        total_pages: totalPages,
      },
    }
  }

  private async handleUpdateTaskStatus(params: UpdateTaskStatusParams): Promise<{ task: Task }> {
    const task = this.tasks.get(params.task_id)
    if (!task) {
      throw new Error(AdminErrorCode.TASK_NOT_FOUND)
    }

    // 验证状态转换
    const validTransitions: Record<TaskStatus, TaskStatus[]> = {
      pending: ['planning', 'cancelled'],
      planning: ['executing', 'failed', 'cancelled'],
      executing: ['waiting_human', 'completed', 'failed', 'cancelled'],
      waiting_human: ['executing', 'cancelled'],
      completed: [],
      failed: [],
      cancelled: [],
    }

    if (!validTransitions[task.status].includes(params.status)) {
      throw new Error(AdminErrorCode.INVALID_STATUS_TRANSITION)
    }

    const oldStatus = task.status
    task.status = params.status
    task.updated_at = generateTimestamp()

    if (params.status === 'executing' && !task.started_at) {
      task.started_at = task.updated_at
    }

    if (['completed', 'failed', 'cancelled'].includes(params.status)) {
      task.completed_at = task.updated_at
    }

    if (params.error) {
      task.error = params.error
    }

    // 写入任务结果
    if (params.result) {
      task.result = params.result
    }

    this.tasks.set(task.id, task)

    // 发布事件
    this.publishAdminEvent('admin.task_status_changed', {
      task_id: task.id,
      old_status: oldStatus,
      new_status: params.status,
    })

    return { task }
  }

  private async handleAssignWorker(params: AssignWorkerParams): Promise<{ task: Task }> {
    const task = this.tasks.get(params.task_id)
    if (!task) {
      throw new Error(AdminErrorCode.TASK_NOT_FOUND)
    }

    if (task.worker_agent_id && task.worker_agent_id !== params.worker_agent_id) {
      throw new Error(AdminErrorCode.TASK_ALREADY_ASSIGNED)
    }

    task.worker_agent_id = params.worker_agent_id
    task.updated_at = generateTimestamp()

    this.tasks.set(task.id, task)

    // 发布事件
    this.publishAdminEvent('admin.task_assigned', {
      task_id: task.id,
      worker_agent_id: params.worker_agent_id,
    })

    return { task }
  }

  private async handleUpdatePlan(params: UpdatePlanParams): Promise<{ task: Task }> {
    const task = this.tasks.get(params.task_id)
    if (!task) {
      throw new Error(AdminErrorCode.TASK_NOT_FOUND)
    }

    task.plan = params.plan
    task.updated_at = generateTimestamp()

    this.tasks.set(task.id, task)

    // 发布事件
    this.publishAdminEvent('admin.task_plan_updated', {
      task_id: task.id,
      plan: params.plan,
    })

    return { task }
  }

  private async handleAppendMessage(params: AppendMessageParams): Promise<{ message: TaskMessage }> {
    const task = this.tasks.get(params.task_id)
    if (!task) {
      throw new Error(AdminErrorCode.TASK_NOT_FOUND)
    }

    const message: TaskMessage = {
      id: generateId(),
      type: params.type,
      content: params.content,
      timestamp: generateTimestamp(),
      metadata: params.metadata,
    }

    task.messages.push(message)
    task.updated_at = generateTimestamp()

    this.tasks.set(task.id, task)

    return { message }
  }

  private async handleGetTaskMessages(params: GetTaskMessagesParams): Promise<{ items: TaskMessage[]; pagination: { page: number; page_size: number; total_items: number; total_pages: number } }> {
    const task = this.tasks.get(params.task_id)
    if (!task) {
      throw new Error(AdminErrorCode.TASK_NOT_FOUND)
    }

    let messages = [...task.messages]

    // 过滤消息类型
    if (params.type && params.type.length > 0) {
      messages = messages.filter((m) => params.type!.includes(m.type))
    }

    // 分页
    const page = params.page ?? 1
    const pageSize = params.page_size ?? 20
    const total = messages.length
    const totalPages = Math.ceil(total / pageSize)
    const offset = (page - 1) * pageSize
    messages = messages.slice(offset, offset + pageSize)

    return {
      items: messages,
      pagination: {
        page,
        page_size: pageSize,
        total_items: total,
        total_pages: totalPages,
      },
    }
  }

  private async handleGetTaskStats(): Promise<TaskStats> {
    const tasks = Array.from(this.tasks.values())

    const stats: TaskStats = {
      total: tasks.length,
      by_status: {
        pending: 0,
        planning: 0,
        executing: 0,
        waiting_human: 0,
        completed: 0,
        failed: 0,
        cancelled: 0,
      },
      by_type: {
        single: 0,
        conversation: 0,
        background: 0,
        scheduled: 0,
      },
      by_priority: {
        low: 0,
        normal: 0,
        high: 0,
        urgent: 0,
      },
    }

    for (const task of tasks) {
      stats.by_status[task.status]++
      stats.by_type[task.type]++
      stats.by_priority[task.priority]++
    }

    return stats
  }

  private async handleCancelTask(params: CancelTaskParams): Promise<{ task: Task; cancelled: boolean }> {
    const task = this.tasks.get(params.task_id)
    if (!task) {
      throw new Error(AdminErrorCode.TASK_NOT_FOUND)
    }

    // pending 状态可以直接取消
    if (task.status === 'pending') {
      task.status = 'cancelled'
      task.completed_at = generateTimestamp()
      task.updated_at = generateTimestamp()
      if (params.reason) {
        task.error = params.reason
      }
      this.tasks.set(task.id, task)

      this.publishAdminEvent('admin.task_cancelled', {
        task_id: task.id,
        reason: params.reason,
      })

      return { task, cancelled: true }
    }

    // 其他状态需要检查是否可取消
    const cancellableStatuses: TaskStatus[] = ['planning', 'executing', 'waiting_human']
    if (!cancellableStatuses.includes(task.status)) {
      throw new Error(AdminErrorCode.TASK_NOT_CANCELLABLE)
    }

    // TODO: 调用 Worker Agent 的 cancel_task 方法
    // 暂时直接取消
    task.status = 'cancelled'
    task.completed_at = generateTimestamp()
    task.updated_at = generateTimestamp()
    if (params.reason) {
      task.error = params.reason
    }
    this.tasks.set(task.id, task)

    this.publishAdminEvent('admin.task_cancelled', {
      task_id: task.id,
      reason: params.reason,
    })

    return { task, cancelled: true }
  }

  // ============================================================================
  // Schedule 协议方法
  // ============================================================================

  private async handleCreateSchedule(params: CreateScheduleParams): Promise<{ schedule: Schedule }> {
    // 验证 cron 表达式
    if (params.trigger.type === 'cron') {
      if (!this.isValidCronExpression(params.trigger.expression)) {
        throw new Error(AdminErrorCode.INVALID_CRON_EXPRESSION)
      }
    }

    const now = generateTimestamp()
    const schedule: Schedule = {
      id: generateId(),
      name: params.name,
      description: params.description,
      enabled: params.enabled ?? true,
      trigger: params.trigger,
      task_template: params.task_template,
      last_triggered_at: undefined,
      next_trigger_at: this.calculateNextTriggerTime(params.trigger),
      execution_count: 0,
      last_task_id: undefined,
      created_at: now,
      updated_at: now,
    }

    this.schedules.set(schedule.id, schedule)

    // 发布事件
    this.publishAdminEvent('admin.schedule_created', { schedule })

    return { schedule }
  }

  private async handleGetSchedule(params: GetScheduleParams): Promise<{ schedule: Schedule }> {
    const schedule = this.schedules.get(params.schedule_id)
    if (!schedule) {
      throw new Error(AdminErrorCode.SCHEDULE_NOT_FOUND)
    }
    return { schedule }
  }

  private async handleListSchedules(params: ListSchedulesParams): Promise<{ items: Schedule[]; pagination: { page: number; page_size: number; total_items: number; total_pages: number } }> {
    let schedules = Array.from(this.schedules.values())

    // 过滤
    if (params.filter) {
      if (params.filter.enabled !== undefined) {
        schedules = schedules.filter((s) => s.enabled === params.filter!.enabled)
      }
      if (params.filter.trigger_type) {
        schedules = schedules.filter((s) => s.trigger.type === params.filter!.trigger_type)
      }
      if (params.filter.search) {
        const searchLower = params.filter.search.toLowerCase()
        schedules = schedules.filter(
          (s) =>
            s.name.toLowerCase().includes(searchLower) ||
            (s.description?.toLowerCase().includes(searchLower) ?? false)
        )
      }
    }

    // 按创建时间倒序
    schedules.sort((a, b) => b.created_at.localeCompare(a.created_at))

    // 分页
    const page = params.page ?? 1
    const pageSize = params.page_size ?? 20
    const total = schedules.length
    const totalPages = Math.ceil(total / pageSize)
    const offset = (page - 1) * pageSize
    schedules = schedules.slice(offset, offset + pageSize)

    return {
      items: schedules,
      pagination: {
        page,
        page_size: pageSize,
        total_items: total,
        total_pages: totalPages,
      },
    }
  }

  private async handleUpdateSchedule(params: UpdateScheduleParams): Promise<{ schedule: Schedule }> {
    const schedule = this.schedules.get(params.schedule_id)
    if (!schedule) {
      throw new Error(AdminErrorCode.SCHEDULE_NOT_FOUND)
    }

    if (params.name !== undefined) {
      schedule.name = params.name
    }
    if (params.description !== undefined) {
      schedule.description = params.description
    }
    if (params.enabled !== undefined) {
      schedule.enabled = params.enabled
    }
    if (params.trigger !== undefined) {
      if (params.trigger.type === 'cron' && !this.isValidCronExpression(params.trigger.expression)) {
        throw new Error(AdminErrorCode.INVALID_CRON_EXPRESSION)
      }
      schedule.trigger = params.trigger
    }
    if (params.task_template !== undefined) {
      schedule.task_template = params.task_template
    }

    schedule.updated_at = generateTimestamp()
    schedule.next_trigger_at = this.calculateNextTriggerTime(schedule.trigger)

    this.schedules.set(schedule.id, schedule)

    // 发布事件
    this.publishAdminEvent('admin.schedule_updated', { schedule })

    return { schedule }
  }

  private async handleDeleteSchedule(params: DeleteScheduleParams): Promise<{ deleted: true }> {
    const exists = this.schedules.has(params.schedule_id)
    if (!exists) {
      throw new Error(AdminErrorCode.SCHEDULE_NOT_FOUND)
    }

    this.schedules.delete(params.schedule_id)

    // 发布事件
    this.publishAdminEvent('admin.schedule_deleted', { schedule_id: params.schedule_id })

    return { deleted: true }
  }

  private async handleTriggerNow(params: TriggerNowParams): Promise<{ task: Task; schedule: Schedule }> {
    const schedule = this.schedules.get(params.schedule_id)
    if (!schedule) {
      throw new Error(AdminErrorCode.SCHEDULE_NOT_FOUND)
    }

    // 创建任务
    const now = generateTimestamp()
    const task: Task = {
      id: generateId(),
      type: schedule.task_template.type,
      status: 'pending',
      priority: schedule.task_template.priority,
      title: schedule.task_template.title,
      description: schedule.task_template.description,
      source: {
        trigger_type: 'scheduled',
      },
      worker_agent_id: undefined,
      plan: undefined,
      input: schedule.task_template.input,
      output: undefined,
      error: undefined,
      messages: [],
      tags: schedule.task_template.tags,
      created_at: now,
      updated_at: now,
      started_at: undefined,
      completed_at: undefined,
      expires_at: undefined,
    }

    this.tasks.set(task.id, task)

    // 更新调度状态
    schedule.last_triggered_at = now
    schedule.last_task_id = task.id
    schedule.execution_count++
    schedule.next_trigger_at = this.calculateNextTriggerTime(schedule.trigger)
    schedule.updated_at = now

    this.schedules.set(schedule.id, schedule)

    // 发布事件
    this.publishAdminEvent('admin.task_created', { task })
    this.publishAdminEvent('admin.schedule_triggered', { schedule, task })

    return { task, schedule }
  }

  // ============================================================================
  // 事件发布
  // ============================================================================

  private publishAdminEvent<K extends keyof AdminEventPayloads>(
    type: K,
    payload: AdminEventPayloads[K]
  ): void {
    const event = {
      id: generateId(),
      type,
      source: this.config.moduleId,
      payload,
      timestamp: generateTimestamp(),
    }
    this.rpcClient.publishEvent(event as Event, this.config.moduleId).catch((err: unknown) => {
      console.error(`[Admin] Failed to publish event ${type}:`, err)
    })
  }

  // ============================================================================
  // Schedule 辅助方法
  // ============================================================================

  private isValidCronExpression(expression: string): boolean {
    // 简单验证：检查是否至少有 5 个字段
    const parts = expression.trim().split(/\s+/)
    return parts.length >= 5
  }

  private calculateNextTriggerTime(trigger: ScheduleTrigger): string | undefined {
    switch (trigger.type) {
      case 'interval': {
        const next = new Date(Date.now() + trigger.seconds * 1000)
        return next.toISOString()
      }
      case 'once': {
        return trigger.execute_at
      }
      case 'cron': {
        // 简化实现：返回 undefined，实际需要 cron 解析库
        // TODO: 使用 cron 库计算下次执行时间
        return undefined
      }
      case 'threshold': {
        return undefined
      }
      default:
        return undefined
    }
  }

  // ============================================================================
  // Model Provider REST API
  // ============================================================================

  private async handleListProvidersApi(_req: IncomingMessage, res: ServerResponse): Promise<void> {
    const providers = this.modelProviderManager.listProviders()
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      items: providers,
      pagination: {
        page: 1,
        page_size: 100,
        total_items: providers.length,
        total_pages: 1
      }
    }))
  }

  private async handleCreateProviderApi(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await this.readJsonBody<CreateModelProviderParams>(req)
    const provider = await this.modelProviderManager.createProvider(body)

    this.publishAdminEvent('admin.model_provider_created', { provider })

    res.writeHead(201, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(provider))
  }

  private async handleGetProviderApi(_req: IncomingMessage, res: ServerResponse, id: string): Promise<void> {
    const provider = this.modelProviderManager.getProvider(id)
    if (!provider) {
      res.writeHead(404)
      res.end(JSON.stringify({ error: 'Provider not found' }))
      return
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(provider))
  }

  private async handleUpdateProviderApi(req: IncomingMessage, res: ServerResponse, id: string): Promise<void> {
    const body = await this.readJsonBody<UpdateModelProviderParams>(req)
    const provider = await this.modelProviderManager.updateProvider(id, body)

    this.publishAdminEvent('admin.model_provider_updated', { provider })

    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(provider))
  }

  private async handleDeleteProviderApi(_req: IncomingMessage, res: ServerResponse, id: string): Promise<void> {
    await this.modelProviderManager.deleteProvider(id)

    this.publishAdminEvent('admin.model_provider_deleted', { provider_id: id })

    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ deleted: true }))
  }

  private async handleImportFromVendorApi(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await this.readJsonBody<ImportFromVendorParams>(req)
    const result = await this.modelProviderManager.importFromVendor(body)

    this.publishAdminEvent('admin.model_provider_created', { provider: result.provider })

    res.writeHead(201, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(result))
  }

  private async handleListPresetVendorsApi(_req: IncomingMessage, res: ServerResponse): Promise<void> {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      items: PRESET_VENDORS,
      pagination: {
        page: 1,
        page_size: 100,
        total_items: PRESET_VENDORS.length,
        total_pages: 1
      }
    }))
  }

  private async handleGetGlobalConfigApi(_req: IncomingMessage, res: ServerResponse): Promise<void> {
    const config = this.modelProviderManager.getGlobalConfig()
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ config }))
  }

  private async handleUpdateGlobalConfigApi(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await this.readJsonBody<Partial<GlobalModelConfig>>(req)
    const config = await this.modelProviderManager.updateGlobalConfig(body)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ config }))

    // 后台推送新配置到所有模块（不阻塞响应）
    this.syncGlobalConfigToMemoryModules().catch((err: Error) => {
      console.warn('[Admin] syncGlobalConfigToMemoryModules failed:', err.message)
    })
    this.pushConfigToAgentModules().catch((err: Error) => {
      console.warn('[Admin] pushConfigToAgentModules failed:', err.message)
    })
  }

  private async handleGetConfigStatusApi(_req: IncomingMessage, res: ServerResponse): Promise<void> {
    const missing: string[] = []
    const warnings: string[] = []

    // 检查全局配置
    const globalConfig = this.modelProviderManager.getGlobalConfig()
    if (!globalConfig.default_llm_provider_id || !globalConfig.default_llm_model_id) {
      missing.push('全局 LLM 模型未配置')
    }
    if (!globalConfig.default_embedding_provider_id || !globalConfig.default_embedding_model_id) {
      missing.push('全局 Embedding 模型未配置')
    }

    // 检查 Provider 是否存在
    if (globalConfig.default_llm_provider_id) {
      const provider = this.modelProviderManager.getProvider(globalConfig.default_llm_provider_id)
      if (!provider) {
        warnings.push(`LLM Provider ${globalConfig.default_llm_provider_id} 不存在`)
      }
    }

    if (globalConfig.default_embedding_provider_id) {
      const provider = this.modelProviderManager.getProvider(globalConfig.default_embedding_provider_id)
      if (!provider) {
        warnings.push(`Embedding Provider ${globalConfig.default_embedding_provider_id} 不存在`)
      }
    }

    // 检查 Memory 模块状态
    try {
      const memoryStatus = await this.checkMemoryStatus()
      if (!memoryStatus.configured) {
        warnings.push('Memory 模块未配置')
      }
    } catch (error) {
      warnings.push('Memory 模块不可达')
    }

    const status = {
      configured: missing.length === 0,
      missing,
      warnings,
    }

    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(status))
  }

  private async checkMemoryStatus(): Promise<{ configured: boolean }> {
    try {
      const memoryPort = await this.getMemoryPort()
      const result = await this.rpcClient.call<{}, { configured: boolean }>(
        memoryPort,
        'get_status',
        {},
        'admin-web'
      )
      return result
    } catch {
      return { configured: false }
    }
  }

  // ============================================================================
  // Model Provider 协议方法
  // ============================================================================

  private async handleResolveModelConfig(params: ResolveModelConfigParams): Promise<ModelConnectionInfo> {
    return this.modelProviderManager.resolveModelConfig(params)
  }

  // ============================================================================
  // Agent Implementation 协议方法
  // ============================================================================

  private async handleListAgentImplementations(params: ListAgentImplementationsParams): Promise<{
    items: AgentImplementation[]
    pagination: { page: number; page_size: number; total_items: number; total_pages: number }
  }> {
    return this.agentManager.listImplementations(params)
  }

  private async handleGetAgentImplementation(params: { implementation_id: string }): Promise<{
    implementation: AgentImplementation
  }> {
    const impl = this.agentManager.getImplementation(params.implementation_id)
    if (!impl) {
      throw new Error(`Implementation not found: ${params.implementation_id}`)
    }
    return { implementation: impl }
  }

  // ============================================================================
  // Agent Instance 协议方法
  // ============================================================================

  private async handleListAgentInstances(params: ListAgentInstancesParams): Promise<{
    items: AgentInstance[]
    pagination: { page: number; page_size: number; total_items: number; total_pages: number }
  }> {
    return this.agentManager.listInstances(params)
  }

  private async handleGetAgentInstance(params: { instance_id: string }): Promise<{
    instance: AgentInstance
  }> {
    const instance = this.agentManager.getInstance(params.instance_id)
    if (!instance) {
      throw new Error(`Instance not found: ${params.instance_id}`)
    }
    return { instance }
  }

  private async handleCreateAgentInstance(params: CreateAgentInstanceParams): Promise<{
    instance: AgentInstance
  }> {
    const instance = await this.agentManager.createInstance(
      params,
      this.rpcClient,
      this.moduleInstaller.getRuntimeManager()
    )
    this.publishAdminEvent('admin.agent_instance_created', { instance })
    return { instance }
  }

  private async handleUpdateAgentInstance(params: UpdateAgentInstanceParams): Promise<{
    instance: AgentInstance
  }> {
    const instance = await this.agentManager.updateInstance(params)
    this.publishAdminEvent('admin.agent_instance_updated', { instance })
    return { instance }
  }

  private async handleDeleteAgentInstance(params: { instance_id: string }): Promise<{
    deleted: true
  }> {
    await this.agentManager.deleteInstance(params.instance_id, this.rpcClient)
    this.publishAdminEvent('admin.agent_instance_deleted', { instance_id: params.instance_id })
    return { deleted: true }
  }

  // ============================================================================
  // Agent Config 协议方法
  // ============================================================================

  private async handleGetAgentConfig(params: { instance_id: string }): Promise<{
    config: ResolvedAgentConfig
  }> {
    const config = this.agentManager.getConfig(params.instance_id)
    if (!config) {
      throw new Error(`Config not found for instance: ${params.instance_id}`)
    }

    // 全局默认 LLM 配置（作为 fallback）
    const globalLLM = await this.modelProviderManager.resolveModelConfig({
      module_id: params.instance_id,
      role: 'llm',
    }) as LLMConnectionInfo

    // 实时解析每个 slot 引用为连接信息
    const resolvedModelConfig: Record<string, LLMConnectionInfo> = {}
    for (const [key, ref] of Object.entries(config.model_config)) {
      try {
        resolvedModelConfig[key] = this.modelProviderManager.buildConnectionInfo(
          ref.provider_id, ref.model_id
        ) as LLMConnectionInfo
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error)
        console.warn(`[Admin] Slot "${key}" ref (${ref.provider_id}/${ref.model_id}) resolve failed: ${msg}, using global default`)
        resolvedModelConfig[key] = globalLLM
      }
    }

    // 确保 'default' slot 存在（如果存储中没有，用全局默认填入）
    if (!resolvedModelConfig['default']) {
      resolvedModelConfig['default'] = globalLLM
    }

    return {
      config: {
        ...config,
        model_config: resolvedModelConfig,
        // 将 ID 列表解析为完整对象，供 Agent 直接使用
        // 只看 agent config 中的 ID 列表（Agent 配置页是唯一控制点），不检查 s.enabled
        mcp_servers: (config.mcp_server_ids ?? [])
          .map((id) => this.mcpServerManager.get(id))
          .filter((s): s is NonNullable<typeof s> => s !== undefined)
          .map((s) => this.mcpServerManager.toAgentConfig(s)),
        skills: (config.skill_ids ?? [])
          .map((id) => this.skillManager.get(id))
          .filter((s): s is NonNullable<typeof s> => s !== undefined)
          .map((s) => this.skillManager.toAgentConfig(s)),
      },
    }
  }

  private async handleUpdateAgentConfig(params: UpdateAgentConfigParams): Promise<{
    config: AgentInstanceConfig
  }> {
    const config = await this.agentManager.updateConfig(params)
    this.publishAdminEvent('admin.agent_instance_config_updated', {
      instance_id: params.instance_id,
      config,
    })
    return { config }
  }

  // ============================================================================
  // MCP Server REST API 处理方法
  // ============================================================================

  private async handleListMCPServersApi(
    _req: IncomingMessage,
    res: ServerResponse
  ): Promise<void> {
    const servers = this.mcpServerManager.list()
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(servers))
  }

  private async handleCreateMCPServerApi(
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<void> {
    try {
      const params = await this.readJsonBody<Parameters<MCPServerManager['create']>[0]>(req)
      const server = await this.mcpServerManager.create(params)
      res.writeHead(201, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(server))
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'create failed' }))
    }
  }

  private async handleGetMCPServerApi(
    _req: IncomingMessage,
    res: ServerResponse,
    id: string
  ): Promise<void> {
    const server = this.mcpServerManager.get(id)
    if (!server) {
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'MCP Server not found' }))
      return
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(server))
  }

  private async handleUpdateMCPServerApi(
    req: IncomingMessage,
    res: ServerResponse,
    id: string
  ): Promise<void> {
    try {
      const params = await this.readJsonBody<Parameters<MCPServerManager['update']>[1]>(req)
      const server = await this.mcpServerManager.update(id, params)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(server))
    } catch (err) {
      const status = err instanceof Error && err.message.includes('not found') ? 404 : 400
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'update failed' }))
    }
  }

  private async handleDeleteMCPServerApi(
    _req: IncomingMessage,
    res: ServerResponse,
    id: string
  ): Promise<void> {
    try {
      await this.mcpServerManager.delete(id)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ deleted: true }))
    } catch (err) {
      const status = err instanceof Error && err.message.includes('not found') ? 404 : 400
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'delete failed' }))
    }
  }

  // ============================================================================
  // Skill REST API 处理方法
  // ============================================================================

  private async handleListSkillsApi(
    _req: IncomingMessage,
    res: ServerResponse
  ): Promise<void> {
    const skills = this.skillManager.list()
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(skills))
  }

  private async handleCreateSkillApi(
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<void> {
    try {
      const params = await this.readJsonBody<Parameters<SkillManager['create']>[0]>(req)
      const skill = await this.skillManager.create(params)
      res.writeHead(201, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(skill))
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'create failed' }))
    }
  }

  private async handleGetSkillApi(
    _req: IncomingMessage,
    res: ServerResponse,
    id: string
  ): Promise<void> {
    const skill = this.skillManager.get(id)
    if (!skill) {
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Skill not found' }))
      return
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(skill))
  }

  private async handleUpdateSkillApi(
    req: IncomingMessage,
    res: ServerResponse,
    id: string
  ): Promise<void> {
    try {
      const params = await this.readJsonBody<Parameters<SkillManager['update']>[1]>(req)
      const skill = await this.skillManager.update(id, params)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(skill))
    } catch (err) {
      const status = err instanceof Error && err.message.includes('not found') ? 404 : 400
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'update failed' }))
    }
  }

  private async handleDeleteSkillApi(
    _req: IncomingMessage,
    res: ServerResponse,
    id: string
  ): Promise<void> {
    try {
      await this.skillManager.delete(id)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ deleted: true }))
    } catch (err) {
      const status = err instanceof Error && err.message.includes('not found') ? 404 : 400
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'delete failed' }))
    }
  }

  // ============================================================================
  // MCP Server 导入 REST API 处理方法
  // ============================================================================

  private async handleImportMCPServersFromJsonApi(
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<void> {
    try {
      const body = await this.readJsonBody<{ json: string }>(req)
      const entries = await this.mcpServerManager.importFromJson(body.json)
      res.writeHead(201, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ entries, count: entries.length }))
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'import failed' }))
    }
  }

  // ============================================================================
  // Skill 导入 REST API 处理方法
  // ============================================================================

  private async handleScanSkillGitApi(
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<void> {
    try {
      const body = await this.readJsonBody<{ git_url: string }>(req)
      const skills = await this.skillManager.scanGitRepo(body.git_url)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ skills }))
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'scan failed' }))
    }
  }

  private async handleInstallSkillGitApi(
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<void> {
    try {
      const body = await this.readJsonBody<{ skill_md_url: string; source_git_url?: string }>(req)
      const skill = await this.skillManager.importFromGit(body.skill_md_url, body.source_git_url)
      res.writeHead(201, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(skill))
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'install failed' }))
    }
  }

  private async handleImportSkillLocalApi(
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<void> {
    try {
      const body = await this.readJsonBody<{ dir_path: string }>(req)
      const skill = await this.skillManager.importFromLocalPath(body.dir_path)
      res.writeHead(201, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(skill))
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'import failed' }))
    }
  }

  private async handleImportSkillUploadApi(
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<void> {
    try {
      // base64 编码后约为原始大小的 1.37 倍，允许最大 50MB zip 文件
      const body = await this.readJsonBody<{ base64_content: string; filename: string }>(req, 70 * 1024 * 1024)
      const skill = await this.skillManager.importFromZip(body.base64_content, body.filename)
      res.writeHead(201, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(skill))
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'import failed' }))
    }
  }

  // ============================================================================
  // Channel Implementation 协议方法
  // ============================================================================

  private async handleListChannelImplementations(params: ListChannelImplementationsParams): Promise<{
    items: ChannelImplementation[]
    pagination: { page: number; page_size: number; total_items: number; total_pages: number }
  }> {
    return this.channelManager.listImplementations(params)
  }

  private async handleGetChannelImplementation(params: { implementation_id: string }): Promise<{
    implementation: ChannelImplementation
  }> {
    const impl = this.channelManager.getImplementation(params.implementation_id)
    if (!impl) {
      throw new Error(`Implementation not found: ${params.implementation_id}`)
    }
    return { implementation: impl }
  }

  // ============================================================================
  // Channel Instance 协议方法
  // ============================================================================

  private async handleListChannelInstances(params: ListChannelInstancesParams): Promise<{
    items: ChannelInstance[]
    pagination: { page: number; page_size: number; total_items: number; total_pages: number }
  }> {
    return this.channelManager.listInstances(params)
  }

  private async handleGetChannelInstance(params: { instance_id: string }): Promise<{
    instance: ChannelInstance
  }> {
    const instance = this.channelManager.getInstance(params.instance_id)
    if (!instance) {
      throw new Error(`Instance not found: ${params.instance_id}`)
    }
    return { instance }
  }

  private async handleCreateChannelInstance(params: CreateChannelInstanceParams): Promise<{
    instance: ChannelInstance
  }> {
    const instance = await this.channelManager.createInstance(params)
    this.publishAdminEvent('admin.channel_instance_created', { instance })
    return { instance }
  }

  private async handleUpdateChannelInstance(params: UpdateChannelInstanceParams): Promise<{
    instance: ChannelInstance
  }> {
    const instance = await this.channelManager.updateInstance(params)
    this.publishAdminEvent('admin.channel_instance_updated', { instance })
    return { instance }
  }

  private async handleDeleteChannelInstance(params: { instance_id: string }): Promise<{
    deleted: true
  }> {
    await this.channelManager.deleteInstance(params.instance_id)
    this.publishAdminEvent('admin.channel_instance_deleted', { instance_id: params.instance_id })
    return { deleted: true }
  }

  // ============================================================================
  // Channel Config 协议方法
  // ============================================================================

  private async handleGetChannelConfig(params: { instance_id: string }): Promise<{
    config: ChannelConfig
    schema?: any
  }> {
    return this.channelManager.getConfig(params.instance_id)
  }

  private async handleUpdateChannelConfig(params: UpdateChannelConfigParams): Promise<{
    config: ChannelConfig
    requires_restart: boolean
  }> {
    const result = await this.channelManager.updateConfig(params)
    this.publishAdminEvent('admin.channel_instance_config_updated', {
      instance_id: params.instance_id,
      config: result.config,
    })
    return result
  }

  // ============================================================================
  // Agent Implementation REST API
  // ============================================================================

  private async handleListImplementationsApi(
    _req: IncomingMessage,
    res: ServerResponse,
    url: URL
  ): Promise<void> {
    const type = url.searchParams.get('type') as 'builtin' | 'installed' | null
    const engine = url.searchParams.get('engine') as AgentImplementation['engine'] | null
    const page = parseInt(url.searchParams.get('page') ?? '1', 10)
    const pageSize = parseInt(url.searchParams.get('page_size') ?? '20', 10)

    const result = this.agentManager.listImplementations({
      ...(type ? { type } : {}),
      ...(engine ? { engine } : {}),
      page,
      page_size: pageSize,
    })

    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(result))
  }

  private async handleGetImplementationApi(
    _req: IncomingMessage,
    res: ServerResponse,
    id: string
  ): Promise<void> {
    const impl = this.agentManager.getImplementation(id)
    if (!impl) {
      res.writeHead(404)
      res.end(JSON.stringify({ error: 'Implementation not found' }))
      return
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ implementation: impl }))
  }

  // ============================================================================
  // Agent Instance REST API
  // ============================================================================

  private async handleListInstancesApi(
    _req: IncomingMessage,
    res: ServerResponse,
    url: URL
  ): Promise<void> {
    const implementationId = url.searchParams.get('implementation_id')
    const autoStartParam = url.searchParams.get('auto_start')
    const page = parseInt(url.searchParams.get('page') ?? '1', 10)
    const pageSize = parseInt(url.searchParams.get('page_size') ?? '20', 10)

    const result = this.agentManager.listInstances({
      ...(implementationId ? { implementation_id: implementationId } : {}),
      ...(autoStartParam !== null ? { auto_start: autoStartParam === 'true' } : {}),
      page,
      page_size: pageSize,
    })

    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(result))
  }

  private async handleCreateInstanceApi(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const body = await this.readJsonBody<CreateAgentInstanceParams>(req)
      const instance = await this.agentManager.createInstance(
        body,
        this.rpcClient,
        this.moduleInstaller.getRuntimeManager()
      )
      this.publishAdminEvent('admin.agent_instance_created', { instance })
      res.writeHead(201, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ instance }))
    } catch (error) {
      if (error instanceof Error) {
        res.writeHead(400)
        res.end(JSON.stringify({ error: error.message }))
        return
      }
      throw error
    }
  }

  private async handleGetInstanceApi(
    _req: IncomingMessage,
    res: ServerResponse,
    id: string
  ): Promise<void> {
    const instance = this.agentManager.getInstance(id)
    if (!instance) {
      res.writeHead(404)
      res.end(JSON.stringify({ error: 'Instance not found' }))
      return
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ instance }))
  }

  private async handleUpdateInstanceApi(
    req: IncomingMessage,
    res: ServerResponse,
    id: string
  ): Promise<void> {
    try {
      const body = await this.readJsonBody<Omit<UpdateAgentInstanceParams, 'instance_id'>>(req)
      const instance = await this.agentManager.updateInstance({ ...body, instance_id: id })
      this.publishAdminEvent('admin.agent_instance_updated', { instance })
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ instance }))
    } catch (error) {
      if (error instanceof Error) {
        res.writeHead(error.message.includes('not found') ? 404 : 400)
        res.end(JSON.stringify({ error: error.message }))
        return
      }
      throw error
    }
  }

  private async handleDeleteInstanceApi(
    _req: IncomingMessage,
    res: ServerResponse,
    id: string
  ): Promise<void> {
    try {
      await this.agentManager.deleteInstance(id, this.rpcClient)
      this.publishAdminEvent('admin.agent_instance_deleted', { instance_id: id })
      res.writeHead(204)
      res.end()
    } catch (error) {
      if (error instanceof Error) {
        res.writeHead(error.message.includes('not found') ? 404 : 400)
        res.end(JSON.stringify({ error: error.message }))
        return
      }
      throw error
    }
  }

  // ============================================================================
  // Agent Config REST API
  // ============================================================================

  private async handleGetInstanceConfigApi(
    _req: IncomingMessage,
    res: ServerResponse,
    id: string
  ): Promise<void> {
    const config = this.agentManager.getConfig(id)
    if (!config) {
      res.writeHead(404)
      res.end(JSON.stringify({ error: 'Config not found' }))
      return
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ config }))
  }

  private async handleUpdateInstanceConfigApi(
    req: IncomingMessage,
    res: ServerResponse,
    id: string
  ): Promise<void> {
    try {
      const body = await this.readJsonBody<Omit<UpdateAgentConfigParams, 'instance_id'>>(req)
      const config = await this.agentManager.updateConfig({ ...body, instance_id: id })
      this.publishAdminEvent('admin.agent_instance_config_updated', {
        instance_id: id,
        config,
      })
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ config }))
    } catch (error) {
      if (error instanceof Error) {
        res.writeHead(error.message.includes('not found') ? 404 : 400)
        res.end(JSON.stringify({ error: error.message }))
        return
      }
      throw error
    }
  }

  // ============================================================================
  // Channel Implementation REST API
  // ============================================================================

  private async handleListChannelImplementationsApi(
    _req: IncomingMessage,
    res: ServerResponse,
    url: URL
  ): Promise<void> {
    const type = url.searchParams.get('type') as 'builtin' | 'installed' | null
    const platform = url.searchParams.get('platform')
    const page = parseInt(url.searchParams.get('page') ?? '1', 10)
    const pageSize = parseInt(url.searchParams.get('page_size') ?? '20', 10)

    const result = this.channelManager.listImplementations({
      ...(type ? { type } : {}),
      ...(platform ? { platform } : {}),
      page,
      page_size: pageSize,
    })

    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(result))
  }

  private async handleGetChannelImplementationApi(
    _req: IncomingMessage,
    res: ServerResponse,
    id: string
  ): Promise<void> {
    const impl = this.channelManager.getImplementation(id)
    if (!impl) {
      res.writeHead(404)
      res.end(JSON.stringify({ error: 'Implementation not found' }))
      return
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ implementation: impl }))
  }

  // ============================================================================
  // Channel Instance REST API
  // ============================================================================

  private async handleListChannelInstancesApi(
    _req: IncomingMessage,
    res: ServerResponse,
    url: URL
  ): Promise<void> {
    const platform = url.searchParams.get('platform')
    const page = parseInt(url.searchParams.get('page') ?? '1', 10)
    const pageSize = parseInt(url.searchParams.get('page_size') ?? '20', 10)

    const result = this.channelManager.listInstances({
      ...(platform ? { platform } : {}),
      page,
      page_size: pageSize,
    })

    // 查询 MM 获取实时模块状态
    const statusMap = await this.queryModuleStatuses()

    // 附加 runtime_status 到每个实例
    const enrichedItems = result.items.map(item => ({
      ...item,
      runtime_status: statusMap.get(item.id) ?? 'unknown',
    }))

    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ...result, items: enrichedItems }))
  }

  private async handleCreateChannelInstanceApi(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const body = await this.readJsonBody<CreateChannelInstanceParams>(req)
      const instance = await this.channelManager.createInstance(body)
      this.publishAdminEvent('admin.channel_instance_created', { instance })
      res.writeHead(201, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ instance }))
    } catch (error) {
      if (error instanceof Error) {
        res.writeHead(400)
        res.end(JSON.stringify({ error: error.message }))
        return
      }
      throw error
    }
  }

  private async handleGetChannelInstanceApi(
    _req: IncomingMessage,
    res: ServerResponse,
    id: string
  ): Promise<void> {
    const instance = this.channelManager.getInstance(id)
    if (!instance) {
      res.writeHead(404)
      res.end(JSON.stringify({ error: 'Instance not found' }))
      return
    }

    // 附加 runtime_status
    const statusMap = await this.queryModuleStatuses()
    const enriched = {
      ...instance,
      runtime_status: statusMap.get(id) ?? 'unknown',
    }

    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ instance: enriched }))
  }

  private async handleUpdateChannelInstanceApi(req: IncomingMessage, res: ServerResponse, id: string): Promise<void> {
    try {
      const body = await this.readJsonBody<Partial<UpdateChannelInstanceParams>>(req)
      const instance = await this.channelManager.updateInstance({
        instance_id: id,
        ...body,
      })
      this.publishAdminEvent('admin.channel_instance_updated', { instance })
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ instance }))
    } catch (error) {
      if (error instanceof Error) {
        res.writeHead(error.message.includes('not found') ? 404 : 400)
        res.end(JSON.stringify({ error: error.message }))
        return
      }
      throw error
    }
  }

  private async handleDeleteChannelInstanceApi(
    _req: IncomingMessage,
    res: ServerResponse,
    id: string
  ): Promise<void> {
    try {
      await this.channelManager.deleteInstance(id)
      this.publishAdminEvent('admin.channel_instance_deleted', { instance_id: id })
      res.writeHead(204)
      res.end()
    } catch (error) {
      if (error instanceof Error) {
        res.writeHead(error.message.includes('not found') ? 404 : 400)
        res.end(JSON.stringify({ error: error.message }))
        return
      }
      throw error
    }
  }

  private async handleGetChannelLocalConfigApi(res: ServerResponse, id: string): Promise<void> {
    const instance = this.channelManager.getInstance(id)
    if (!instance) {
      res.writeHead(404)
      res.end(JSON.stringify({ error: 'Instance not found' }))
      return
    }
    const config = await this.channelManager.loadLocalConfig(id)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ config: config ?? {} }))
  }

  private async handlePutChannelLocalConfigApi(req: IncomingMessage, res: ServerResponse, id: string): Promise<void> {
    const instance = this.channelManager.getInstance(id)
    if (!instance) {
      res.writeHead(404)
      res.end(JSON.stringify({ error: 'Instance not found' }))
      return
    }
    try {
      const body = await this.readJsonBody<{ config: Record<string, string> }>(req)
      await this.channelManager.saveLocalConfig(id, body.config)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ config: body.config }))
    } catch (error) {
      res.writeHead(400)
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : 'Invalid request' }))
    }
  }

  // ============================================================================
  // Channel Config REST API
  // ============================================================================

  private async handleGetChannelInstanceConfigApi(
    _req: IncomingMessage,
    res: ServerResponse,
    id: string
  ): Promise<void> {
    try {
      const result = await this.channelManager.getConfig(id)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(result))
    } catch (error) {
      if (error instanceof Error) {
        res.writeHead(error.message.includes('not found') ? 404 : 400)
        res.end(JSON.stringify({ error: error.message }))
        return
      }
      throw error
    }
  }

  private async handleUpdateChannelInstanceConfigApi(
    req: IncomingMessage,
    res: ServerResponse,
    id: string
  ): Promise<void> {
    try {
      const body = await this.readJsonBody<{ config: Partial<ChannelConfig> }>(req)
      const result = await this.channelManager.updateConfig({
        instance_id: id,
        config: body.config,
      })
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(result))
    } catch (error) {
      if (error instanceof Error) {
        res.writeHead(error.message.includes('not found') ? 404 : 400)
        res.end(JSON.stringify({ error: error.message }))
        return
      }
      throw error
    }
  }

  // ============================================================================
  // 模块安装 RPC 方法
  // ============================================================================

  private async handlePreviewModulePackage(params: PreviewModulePackageParams): Promise<{
    package_info: any
  }> {
    const packageInfo = await this.moduleInstaller.preview(params.source)
    return { package_info: packageInfo }
  }

  private async handleInstallModule(params: InstallModuleParams): Promise<{
    implementation: AgentImplementation
  }> {
    const implementation = await this.moduleInstaller.install(params.source, {
      overwrite: params.overwrite,
    })
    this.publishAdminEvent('admin.agent_implementation_installed', { implementation })
    return { implementation }
  }

  private async handleUninstallModule(params: { implementation_id: string }): Promise<{
    deleted: true
  }> {
    await this.moduleInstaller.uninstall(params.implementation_id)
    this.publishAdminEvent('admin.agent_implementation_uninstalled', {
      implementation_id: params.implementation_id,
    })
    return { deleted: true }
  }

  // ============================================================================
  // 模块安装 REST API
  // ============================================================================

  private async handlePreviewModuleApi(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const body = await this.readJsonBody<{ source: ModuleSource }>(req)
      const packageInfo = await this.moduleInstaller.preview(body.source)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ package_info: packageInfo }))
    } catch (error) {
      if (error instanceof Error) {
        res.writeHead(400)
        res.end(JSON.stringify({ error: error.message }))
        return
      }
      throw error
    }
  }

  private async handleInstallModuleApi(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const body = await this.readJsonBody<InstallModuleParams>(req)
      const implementation = await this.moduleInstaller.install(body.source, {
        overwrite: body.overwrite,
      })
      this.publishAdminEvent('admin.agent_implementation_installed', { implementation })
      res.writeHead(201, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ implementation }))
    } catch (error) {
      if (error instanceof Error) {
        res.writeHead(400)
        res.end(JSON.stringify({ error: error.message }))
        return
      }
      throw error
    }
  }

  private async handleUninstallModuleApi(
    _req: IncomingMessage,
    res: ServerResponse,
    id: string
  ): Promise<void> {
    try {
      await this.moduleInstaller.uninstall(id)
      this.publishAdminEvent('admin.agent_implementation_uninstalled', {
        implementation_id: id,
      })
      res.writeHead(204)
      res.end()
    } catch (error) {
      if (error instanceof Error) {
        res.writeHead(error.message.includes('not found') ? 404 : 400)
        res.end(JSON.stringify({ error: error.message }))
        return
      }
      throw error
    }
  }

  // ============================================================================
  // 模块配置管理
  // ============================================================================

  private async handleGetModuleConfig(params: {
    module_id: string
  }): Promise<{ config: Record<string, string> }> {
    const filePath = path.join(this.moduleConfigsDir, `${params.module_id}.json`)
    try {
      const content = await fs.readFile(filePath, 'utf-8')
      const data = JSON.parse(content) as {
        module_id: string
        config: Record<string, string>
        updated_at: string
      }
      return { config: data.config }
    } catch {
      return { config: {} }  // 不存在则返回空配置
    }
  }

  private async handleSetModuleConfig(params: {
    module_id: string
    config: Record<string, string>
  }): Promise<{ updated: true }> {
    await fs.mkdir(this.moduleConfigsDir, { recursive: true })
    const filePath = path.join(this.moduleConfigsDir, `${params.module_id}.json`)
    const data = {
      module_id: params.module_id,
      config: params.config,
      updated_at: generateTimestamp(),
    }
    await fs.writeFile(filePath, JSON.stringify(data, null, 2))
    // 同步内存缓存
    this.moduleEnvConfigCache.set(params.module_id, params.config)
    // 模块配置变更后触发 LiteLLM 同步（确保新配置引用的模型被加载）
    this.modelProviderManager.requestSync()
    return { updated: true }
  }

  // ============================================================================
  // 模块生命周期控制
  // ============================================================================

  /**
   * 将全局模型配置构建为 env 变量（作为模块启动时的默认值）
   * 模块自身的显式配置可覆盖这些默认值
   */
  private buildGlobalModelEnv(): Record<string, string> {
    const env: Record<string, string> = {}
    const globalConfig = this.modelProviderManager.getGlobalConfig()

    try {
      if (globalConfig.default_llm_provider_id && globalConfig.default_llm_model_id) {
        const info = this.modelProviderManager.buildConnectionInfo(
          globalConfig.default_llm_provider_id,
          globalConfig.default_llm_model_id
        ) as LLMConnectionInfo
        env.CRABOT_LLM_BASE_URL = info.endpoint
        env.CRABOT_LLM_MODEL = info.model_id
        env.CRABOT_LLM_API_KEY = info.apikey
      }
    } catch {
      console.warn('[Admin] buildGlobalModelEnv: failed to resolve global LLM config')
    }

    try {
      if (globalConfig.default_embedding_provider_id && globalConfig.default_embedding_model_id) {
        const info = this.modelProviderManager.buildConnectionInfo(
          globalConfig.default_embedding_provider_id,
          globalConfig.default_embedding_model_id
        ) as EmbeddingConnectionInfo
        env.CRABOT_EMBEDDING_BASE_URL = info.endpoint
        env.CRABOT_EMBEDDING_MODEL = info.model_id
        env.CRABOT_EMBEDDING_API_KEY = info.apikey
        if (info.dimension !== undefined) {
          env.CRABOT_EMBEDDING_DIMENSION = String(info.dimension)
        }
      }
    } catch {
      console.warn('[Admin] buildGlobalModelEnv: failed to resolve global embedding config')
    }

    return env
  }

  /**
   * 构建 Memory 模块的 RPC 配置参数（LLM + Embedding 连接信息）
   * 供 get_memory_config（模块启动 pull）和 syncGlobalConfigToMemoryModules（push）共用
   */
  private buildMemoryRpcConfig(): { llm?: Record<string, string>; embedding?: Record<string, string | number> } {
    const newEnv = this.buildGlobalModelEnv()
    const rpcParams: { llm?: Record<string, string>; embedding?: Record<string, string | number> } = {}
    if (newEnv.CRABOT_LLM_MODEL) {
      rpcParams.llm = {
        api_key: newEnv.CRABOT_LLM_API_KEY ?? '',
        base_url: newEnv.CRABOT_LLM_BASE_URL ?? '',
        model: newEnv.CRABOT_LLM_MODEL,
      }
    }
    if (newEnv.CRABOT_EMBEDDING_MODEL) {
      rpcParams.embedding = {
        api_key: newEnv.CRABOT_EMBEDDING_API_KEY ?? '',
        base_url: newEnv.CRABOT_EMBEDDING_BASE_URL ?? '',
        model: newEnv.CRABOT_EMBEDDING_MODEL,
      }
      if (newEnv.CRABOT_EMBEDDING_DIMENSION) {
        rpcParams.embedding.dimension = parseInt(newEnv.CRABOT_EMBEDDING_DIMENSION, 10)
      }
    }
    return rpcParams
  }

  /**
   * Memory 模块启动时调用此 RPC 拉取初始配置（pull 初始化）
   * 统一配置模式：模块启动 pull + 运行时 Admin push
   */
  private async handleGetMemoryConfig(_params: { instance_id: string }): Promise<{
    config: { llm?: Record<string, string>; embedding?: Record<string, string | number> }
  }> {
    return { config: this.buildMemoryRpcConfig() }
  }

  /**
   * 全局配置保存后，推送新配置到所有 Memory 模块（push 热更新）
   * 同时更新 module-configs 文件和内存缓存
   */
  private async syncGlobalConfigToMemoryModules(): Promise<void> {
    const newEnv = this.buildGlobalModelEnv()
    if (Object.keys(newEnv).length === 0) return

    // 1. 更新 memory-default.json（只更新已有 key 或新增模型相关 key）
    const moduleId = 'memory-default'
    const filePath = path.join(this.moduleConfigsDir, `${moduleId}.json`)
    let existingConfig: Record<string, string> = {}
    try {
      const content = await fs.readFile(filePath, 'utf-8')
      const data = JSON.parse(content) as { config: Record<string, string> }
      existingConfig = data.config ?? {}
    } catch {
      // 文件不存在，用空配置
    }

    const mergedConfig = { ...existingConfig }
    for (const [key, value] of Object.entries(newEnv)) {
      // 只更新模型相关的 env key
      if (key.startsWith('CRABOT_LLM_') || key.startsWith('CRABOT_EMBEDDING_')) {
        mergedConfig[key] = value
      }
    }

    await fs.mkdir(this.moduleConfigsDir, { recursive: true })
    await fs.writeFile(filePath, JSON.stringify({
      module_id: moduleId,
      config: mergedConfig,
      updated_at: generateTimestamp(),
    }, null, 2))
    this.moduleEnvConfigCache.set(moduleId, mergedConfig)
    this.modelProviderManager.requestSync()

    // 2. 推送到所有运行中的 Memory 模块
    const rpcParams = this.buildMemoryRpcConfig()

    if (Object.keys(rpcParams).length === 0) return

    try {
      await this.resolveMemoryModules()
      for (const mem of this.memoryModules) {
        try {
          const result = await this.rpcClient.call<typeof rpcParams, { updated: string[] }>(
            mem.port, 'update_config', rpcParams, this.config.moduleId
          )
          console.log(`[Admin] Memory ${mem.module_id} config updated:`, result.updated)
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e)
          console.warn(`[Admin] Failed to push config to Memory ${mem.module_id}:`, msg)
        }
      }
    } catch {
      // Memory 模块未运行，跳过 RPC 推送
    }
  }

  /**
   * 全局配置保存后或 Agent 启动时，推送 model_config 到 Agent 模块（热更新）
   * system_prompt/mcp_servers/skills 变更需要重启，不在这里推送
   */
  private async pushConfigToAgentModules(): Promise<void> {
    try {
      const port = await this.ensureAgentPort()
      if (!port) return

      // 复用 handleGetAgentConfig 的配置解析逻辑
      const { config } = await this.handleGetAgentConfig({ instance_id: 'crabot-agent' })

      // 只推送可热更新的 model_config
      const updateParams = {
        model_config: config.model_config,
      }

      const result = await this.rpcClient.call<typeof updateParams, { restart_required: boolean; changed_fields: string[] }>(
        port, 'update_config', updateParams, this.config.moduleId
      )
      console.log(`[Admin] Agent config pushed, changed: ${result.changed_fields?.join(', ') || 'none'}`)
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      console.warn(`[Admin] Failed to push config to Agent:`, msg)
    }
  }

  private async queryModuleStatuses(): Promise<Map<string, string>> {
    const mmEndpoint = process.env.CRABT_MM_ENDPOINT || process.env.CRABOT_MM_ENDPOINT || 'http://localhost:19000'
    try {
      const response = await fetch(`${mmEndpoint}/list_modules`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: generateId(), params: {} }),
      })
      const data = (await response.json()) as {
        success: boolean
        data?: { modules: Array<{ module_id: string; status: string }> }
      }
      if (data.success && data.data) {
        const map = new Map<string, string>()
        for (const m of data.data.modules) {
          map.set(m.module_id, m.status)
        }
        return map
      }
    } catch {
      // MM 不可用时返回空 map
    }
    return new Map()
  }

  private async waitForModuleStatus(
    moduleId: string,
    condition: (status: string) => boolean,
    timeoutMs: number
  ): Promise<string> {
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
      const statusMap = await this.queryModuleStatuses()
      const status = statusMap.get(moduleId) ?? 'unknown'
      if (condition(status)) {
        return status
      }
      await new Promise(r => setTimeout(r, 500))
    }
    // 超时，返回当前状态
    const statusMap = await this.queryModuleStatuses()
    return statusMap.get(moduleId) ?? 'unknown'
  }

  private async handleStartModuleAdmin(params: {
    module_id: string
  }): Promise<{ status: 'accepted'; tracking_id: string }> {
    // 1. 读取用户配置
    const { config } = await this.handleGetModuleConfig({ module_id: params.module_id })

    // 2. 全局模型配置始终优先（Admin 是唯一真相来源），
    //    模块文件只保留非模型的自定义配置（如 CRABOT_MEMORY_DATA_DIR 等）
    const globalEnv = this.buildGlobalModelEnv()
    const mergedConfig = { ...config, ...globalEnv }

    // 3. 调用 MM 的 start_module，注入配置为 env
    const mmEndpoint = process.env.CRABT_MM_ENDPOINT || process.env.CRABOT_MM_ENDPOINT || 'http://localhost:19000'
    const response = await fetch(`${mmEndpoint}/start_module`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: generateId(),
        params: {
          module_id: params.module_id,
          env: mergedConfig,
        },
      }),
    })

    const result = (await response.json()) as { success: boolean; error?: { message: string }; data?: { status: 'accepted'; tracking_id: string } }
    if (!result.success) {
      throw new Error(result.error?.message ?? 'start_module failed')
    }
    return result.data!
  }

  private async handleStopModuleAdmin(params: {
    module_id: string
    force?: boolean
  }): Promise<{ status: 'accepted'; tracking_id: string }> {
    const mmEndpoint = process.env.CRABT_MM_ENDPOINT || process.env.CRABOT_MM_ENDPOINT || 'http://localhost:19000'
    const response = await fetch(`${mmEndpoint}/stop_module`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: generateId(),
        params: {
          module_id: params.module_id,
          force: params.force || false,
        },
      }),
    })

    const result = (await response.json()) as { success: boolean; error?: { message: string }; data?: { status: 'accepted'; tracking_id: string } }
    if (!result.success) {
      throw new Error(result.error?.message ?? 'stop_module failed')
    }
    return result.data!
  }

  private async handleRestartModuleAdmin(params: {
    module_id: string
  }): Promise<{ status: 'accepted'; tracking_id: string }> {
    // 先停止
    await this.handleStopModuleAdmin({ module_id: params.module_id })
    // 等待 2 秒确保进程完全退出
    await new Promise(resolve => setTimeout(resolve, 2000))
    // 再启动
    return this.handleStartModuleAdmin({ module_id: params.module_id })
  }

  // ============================================================================
  // Chat RPC 方法
  // ============================================================================

  private async handleChatCallback(params: ChatCallbackParams): Promise<ChatCallbackResult> {
    if (!this.chatManager) {
      throw new Error('Chat manager not initialized')
    }
    return this.chatManager.handleChatCallback(params)
  }

  private async handleGetChatHistory(params: GetChatHistoryParams): Promise<GetChatHistoryResult> {
    if (!this.chatManager) {
      throw new Error('Chat manager not initialized')
    }
    const { limit = 20, before } = params
    // getMessages 返回最新在前，反转为时间正序（最旧在前）
    const msgs = this.chatManager.getMessages(limit, before).reverse()
    return {
      messages: msgs.map((msg) => ({
        platform_message_id: msg.message_id,
        session: { session_id: 'admin-chat', channel_id: 'admin-web', type: 'private' as const },
        sender: msg.role === 'user'
          ? { friend_id: 'master', platform_user_id: 'master', platform_display_name: 'Master' }
          : { friend_id: 'assistant', platform_user_id: 'assistant', platform_display_name: 'Crabot' },
        content: { type: 'text' as const, text: msg.content },
        features: { is_mention_crab: false as const },
        platform_timestamp: msg.timestamp,
      })),
    }
  }

  // ============================================================================
  // Chat REST API
  // ============================================================================

  private async handleGetChatMessagesApi(
    _req: IncomingMessage,
    res: ServerResponse,
    url: URL
  ): Promise<void> {
    if (!this.chatManager) {
      res.writeHead(503)
      res.end(JSON.stringify({ error: 'Chat not available' }))
      return
    }

    const limit = parseInt(url.searchParams.get('limit') ?? '50', 10)
    const before = url.searchParams.get('before') ?? undefined

    const messages = this.chatManager.getMessages(limit, before)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ messages }))
  }

  private async handleClearChatMessagesApi(_req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.chatManager) {
      res.writeHead(503)
      res.end(JSON.stringify({ error: 'Chat not available' }))
      return
    }

    await this.chatManager.clearMessages()
    res.writeHead(204)
    res.end()
  }

  // ============================================================================
  // Agent LLM 需求 API
  // ============================================================================

  private async handleGetAgentLLMRequirementsApi(
    _req: IncomingMessage,
    res: ServerResponse
  ): Promise<void> {
    try {
      // 优先从运行中的 agent 模块获取 LLM 需求
      // 如果 agent 模块未运行或没有实现 get_llm_requirements，回退到默认实现
      const defaultImpl = this.agentManager.getImplementation('default')
      if (!defaultImpl) {
        res.writeHead(500)
        res.end(JSON.stringify({ error: 'Default implementation not found' }))
        return
      }

      const result = {
        model_format: defaultImpl.model_format,
        requirements: defaultImpl.model_roles,
      }

      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(result))
    } catch (error) {
      if (error instanceof Error) {
        res.writeHead(500)
        res.end(JSON.stringify({ error: error.message }))
        return
      }
      throw error
    }
  }

  // ============================================================================
  // 辅助方法
  // ============================================================================

  private get moduleConfigsDir(): string {
    return path.join(this.adminConfig.data_dir, 'module-configs')
  }

  /** 启动时扫描 module-configs/ 目录，将所有模块 env 配置加载进内存缓存 */
  private async loadModuleEnvConfigCache(): Promise<void> {
    try {
      const dir = this.moduleConfigsDir
      await fs.mkdir(dir, { recursive: true })
      const files = await fs.readdir(dir)
      for (const file of files) {
        if (!file.endsWith('.json')) continue
        try {
          const content = await fs.readFile(path.join(dir, file), 'utf-8')
          const data = JSON.parse(content) as { module_id: string; config: Record<string, string> }
          if (data.module_id && data.config) {
            this.moduleEnvConfigCache.set(data.module_id, data.config)
          }
        } catch {
          // 忽略单个文件的解析错误
        }
      }
    } catch {
      // 目录不存在时忽略
    }
  }

  /** 从模块 env 配置缓存中收集所有被引用的 LiteLLM 模型名 */
  private getModuleEnvLiteLLMModels(): string[] {
    const names: string[] = []
    for (const config of this.moduleEnvConfigCache.values()) {
      if (config.CRABOT_LLM_MODEL) names.push(config.CRABOT_LLM_MODEL)
      if (config.CRABOT_EMBEDDING_MODEL) names.push(config.CRABOT_EMBEDDING_MODEL)
    }
    return names
  }

  private agentPort = 0

  private getAgentPort(): number {
    // 返回缓存的 Agent 端口
    // 端口在启动时通过 Module Manager 解析
    return this.agentPort
  }

  /**
   * 确保 Agent 端口已解析，如果缓存为空则重新解析
   */
  private async ensureAgentPort(): Promise<number> {
    if (this.agentPort > 0) {
      return this.agentPort
    }
    await this.resolveAgentPort()
    return this.agentPort
  }

  private memoryModules: Array<{ module_id: string; port: number; name: string }> = []

  /**
   * 解析 Memory 模块端口列表
   */
  private async resolveMemoryModules(): Promise<void> {
    try {
      const modules = await this.rpcClient.resolve(
        { module_type: 'memory' },
        this.config.moduleId
      )
      this.memoryModules = modules.map(m => ({
        module_id: m.module_id,
        port: m.port,
        name: m.module_id,
      }))
    } catch (error) {
      this.memoryModules = []
    }
  }

  /**
   * 获取指定 Memory 模块端口，缺省取第一个
   */
  private async getMemoryPort(moduleId?: string): Promise<number> {
    await this.resolveMemoryModules()
    if (this.memoryModules.length === 0) {
      throw new Error('Memory service is not running')
    }
    if (moduleId) {
      const found = this.memoryModules.find(m => m.module_id === moduleId)
      if (found) return found.port
    }
    return this.memoryModules[0].port
  }

  // ============================================================================
  // Agent Trace API 处理方法
  // ============================================================================

  private async handleGetAgentTracesApi(
    _req: IncomingMessage,
    res: ServerResponse,
    url: URL
  ): Promise<void> {
    try {
      const port = await this.ensureAgentPort()
      if (!port) {
        res.writeHead(503, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Agent not available' }))
        return
      }
      const limit = parseInt(url.searchParams.get('limit') ?? '20')
      const offset = parseInt(url.searchParams.get('offset') ?? '0')
      const status = url.searchParams.get('status') ?? undefined
      const result = await this.rpcClient.call<
        { limit?: number; offset?: number; status?: string },
        { traces: unknown[]; total: number }
      >(port, 'get_traces', { limit, offset, status }, this.config.moduleId)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(result))
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: msg }))
    }
  }

  private async handleGetAgentTraceApi(
    _req: IncomingMessage,
    res: ServerResponse,
    traceId: string
  ): Promise<void> {
    try {
      const port = await this.ensureAgentPort()
      if (!port) {
        res.writeHead(503, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Agent not available' }))
        return
      }
      const result = await this.rpcClient.call<
        { trace_id: string },
        { trace: unknown }
      >(port, 'get_trace', { trace_id: traceId }, this.config.moduleId)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(result))
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      if (msg.includes('not found') || msg.includes('Trace not found')) {
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: msg }))
      } else {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: msg }))
      }
    }
  }

  private async handleClearAgentTracesApi(
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<void> {
    try {
      const port = await this.ensureAgentPort()
      if (!port) {
        res.writeHead(503, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Agent not available' }))
        return
      }
      const body = await new Promise<string>((resolve) => {
        let data = ''
        req.on('data', (chunk) => { data += chunk })
        req.on('end', () => resolve(data))
      })
      const params = body ? (JSON.parse(body) as { before?: string; trace_ids?: string[] }) : {}
      const result = await this.rpcClient.call<
        { before?: string; trace_ids?: string[] },
        { cleared_count: number }
      >(port, 'clear_traces', params, this.config.moduleId)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(result))
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: msg }))
    }
  }

  private async handleGetActiveAgentConfigApi(
    _req: IncomingMessage,
    res: ServerResponse
  ): Promise<void> {
    try {
      // 返回存储的引用格式（provider_id + model_id），前端需要原始引用来渲染下拉框
      const config = this.agentManager.getConfig('crabot-agent')
      if (!config) {
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Config not found' }))
        return
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ config }))
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: msg }))
    }
  }

  private async handleUpdateActiveAgentConfigApi(
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<void> {
    try {
      const body = await this.readJsonBody<Omit<UpdateAgentConfigParams, 'instance_id'>>(req)

      // 防御性提取 model_config：只保留 provider_id + model_id
      const sanitizedBody = { ...body, instance_id: 'crabot-agent' } as UpdateAgentConfigParams
      if (body.model_config) {
        const sanitized: Record<string, import('./types.js').ModelSlotRef> = {}
        for (const [key, val] of Object.entries(body.model_config)) {
          if (val && val.provider_id && val.model_id) {
            sanitized[key] = { provider_id: val.provider_id, model_id: val.model_id }
          }
        }
        sanitizedBody.model_config = sanitized
      }

      const config = await this.agentManager.updateConfig(sanitizedBody)
      this.publishAdminEvent('admin.agent_instance_config_updated', {
        instance_id: 'crabot-agent',
        config,
      })
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ config }))
    } catch (error) {
      if (error instanceof Error) {
        res.writeHead(error.message.includes('not found') ? 404 : 400)
        res.end(JSON.stringify({ error: error.message }))
        return
      }
      throw error
    }
  }

  private async handleGetMemoryModulesApi(_req: IncomingMessage, res: ServerResponse): Promise<void> {
    await this.resolveMemoryModules()
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ items: this.memoryModules }))
  }

  private async handleGetMemoryStatsApi(_req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const moduleId = url.searchParams.get('module_id') ?? undefined
    const port = await this.getMemoryPort(moduleId)
    const result = await this.rpcClient.call<Record<string, never>, unknown>(
      port, 'get_stats', {}, this.config.moduleId
    )
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(result))
  }

  private async handleSearchShortTermApi(_req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const moduleId = url.searchParams.get('module_id') ?? undefined
    const q = url.searchParams.get('q') ?? undefined
    const limit = parseInt(url.searchParams.get('limit') ?? '20', 10)
    const port = await this.getMemoryPort(moduleId)
    const result = await this.rpcClient.call<{ query?: string; limit: number }, unknown>(
      port, 'search_short_term', { query: q, limit }, this.config.moduleId
    )
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(result))
  }

  private async handleSearchLongTermApi(_req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const moduleId = url.searchParams.get('module_id') ?? undefined
    const q = url.searchParams.get('q') ?? 'memory'
    const limit = parseInt(url.searchParams.get('limit') ?? '20', 10)
    const port = await this.getMemoryPort(moduleId)
    const result = await this.rpcClient.call<{ query: string; limit: number; detail: string }, unknown>(
      port, 'search_long_term', { query: q, limit, detail: 'L1' }, this.config.moduleId
    )
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(result))
  }

  private async handleGetMemoryApi(_req: IncomingMessage, res: ServerResponse, url: URL, memoryId: string): Promise<void> {
    const moduleId = url.searchParams.get('module_id') ?? undefined
    const port = await this.getMemoryPort(moduleId)
    const result = await this.rpcClient.call<{ memory_id: string }, unknown>(
      port, 'get_memory', { memory_id: memoryId }, this.config.moduleId
    )
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(result))
  }

  private async handleDeleteMemoryApi(_req: IncomingMessage, res: ServerResponse, url: URL, memoryId: string): Promise<void> {
    const moduleId = url.searchParams.get('module_id') ?? undefined
    const port = await this.getMemoryPort(moduleId)
    const result = await this.rpcClient.call<{ memory_id: string }, unknown>(
      port, 'delete_memory', { memory_id: memoryId }, this.config.moduleId
    )
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(result))
  }

  private async resolveAgentPortWithRetry(maxRetries: number, delayMs: number): Promise<void> {
    for (let i = 0; i < maxRetries; i++) {
      try {
        await this.resolveAgentPort()
        console.log('[Admin] Successfully resolved Agent port')
        return
      } catch (error: unknown) {
        if (i < maxRetries - 1) {
          await new Promise(resolve => setTimeout(resolve, delayMs))
        } else {
          throw error
        }
      }
    }
  }

  private async resolveAgentPort(): Promise<void> {
    try {
      const agentModules = await this.rpcClient.resolve(
        { module_type: 'agent' },
        this.config.moduleId
      )
      if (agentModules.length > 0) {
        this.agentPort = agentModules[0].port
      }
    } catch (error) {
      throw error
    }
  }
}

export default AdminModule
