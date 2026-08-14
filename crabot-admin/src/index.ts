/**
 * Admin 模块 - Crabot 管理后台
 *
 * @see crabot-docs/protocols/protocol-admin.md
 */

import http, { type IncomingMessage, type ServerResponse } from 'node:http'
import type { Socket } from 'node:net'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import { createReadStream, createWriteStream } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import yaml from 'js-yaml'
import { buildBackupOverview } from './openclaw-import/build-overview.js'
import { runImport, type ImportSelections } from './openclaw-import/run-import.js'
import { buildImportDeps } from './openclaw-import/build-import-deps.js'
import { StagedUploadStore } from './openclaw-import/staged-upload-store.js'
import { BACKUP_CATEGORIES, DEFAULT_CATEGORIES } from './backup/categories.js'
import { exportArchive } from './backup/export-archive.js'
import type { BackupCategory } from './backup/types.js'
import { validateBackupManifest } from './backup/manifest.js'
import { runCrabotImport, type ImportDeps } from './backup/import/run-import.js'
import type { ImportStatus, OnConflict, ImportItemResult } from './backup/import/import-types.js'
import { shouldDisableOnImport } from './backup/import/schedule-arm.js'
import { VersionService } from './version/version-service.js'
import { startUpgrade, canUpgrade, isUpgradeInProgress } from './version/upgrade-runner.js'
import { readArchiveTextFile, listArchiveEntries } from './openclaw-import/archive-reader.js'
import { extractArchiveSubtree } from './openclaw-import/extract-subtree.js'
import { CoreAgentConfigMutationCoordinator } from './core-agent-config-revision-store.js'
import { WorkerImplementationStore } from './worker-implementation-store.js'
import type { WorkerImplementationRuntimeConfig, CLIWorkerImplId } from './types.js'
import { WorkerConnectionRevisionSigner } from './worker-connection-revision.js'
import { WorkerOperationAssertions } from './worker-operation-assertions.js'
import { CoreAgentCutoverStore } from './core-agent-cutover.js'
import { CORE_AGENT_DEFINITION } from './core-agent-definition.js'
import { BrowserManager } from './browser-manager.js'
import { PermissionTemplateManager } from './permission-template-manager.js'
import { decodePathSegment, isPathSafeSegment } from './http-path.js'
import {
  ModuleBase,
  type ModuleConfig,
  type Event,
  type ModuleId,
  type FriendId,
  type TaskId,
  type ScheduleId,
  generateId,
  generateTimestamp,
  proxyManager,
  ProxyManager,
  type ProxyConfig,
  type RpcHandlerContext,
  RpcError,
  CLAIM_COMMANDS,
  CLAIM_PAIR_COMMANDS,
  normalizeSlash,
  UNCLAIMED_HINT_TEXT,
  ALREADY_CLAIMED_HINT_TEXT,
  GOAL_SHOW_PREFIX,
  GOAL_CLEAR_PREFIX,
  GOAL_LIST_EXACT,
  GOAL_SHOW_BARE,
  GOAL_CLEAR_BARE,
} from 'crabot-shared'
import {
  type Friend,
  type PermissionTemplate,
  type ChannelIdentity,
  type AdminConfig,
  type PendingMessage,
  type LoginRequest,
  type LoginResponse,
  type MeResponse,
  type ChangePasswordRequest,
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
  // spec 2026-06-09-task-trace-tool-unification.md §4.3 + §4.4
  type TraceSummary,
  type CleanupOldTasksByCountParams,
  type CleanupOldTasksByCountResult,
  type UpdateTaskStatusParams,
  type AssignWorkerParams,
  type UpdatePlanParams,
  type AppendMessageParams,
  type GetTaskMessagesParams,
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
  type ScheduleTriggerType,
  type ScheduleTargetSession,
  type AdminEventPayloads,
  type ModelProvider,
  type CreateModelProviderParams,
  type UpdateModelProviderParams,
  type ImportFromVendorParams,
  type GlobalModelConfig,
  type LLMConnectionInfo,
  type AgentImplementation,
  type AgentInstance,
  type AgentInstanceConfig,
  type ResolvedAgentConfig,
  type CoreAgentRuntimeConfig,
  type SubAgentConfig,
  type SubAgentRegistryEntry,
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
  type ChatSendMessageParams,
  type ChatSendMessageResult,
  type ChatTaskSnapshot,
  type AgentTaskStatus,
  type LedgerWorkerBrief,
  type ChannelMessageRef,
  type FriendPermissionConfig,
  type GetFriendPermissionResult,
  type ResolvedPermissions,
  type SessionPermissionConfig,
  type UpdateFriendPermissionBody,
  type CreatePermissionTemplateParams,
  type UpdatePermissionTemplateParams,
  type DialogObjectChannelSession,
  type CliAccessConfig,
  CLI_DOMAINS,
  createCliAccessConfig,
  type ResolvePrincipalPermissionsParams,
  type ResolvePrincipalPermissionsResult,
  type SetTaskGoalParams,
  type SetTaskGoalResult,
  type AppendTaskGoalAuditEntryParams,
  type AppendTaskGoalAuditEntryResult,
  type IncrementTaskGoalTokensParams,
  type IncrementTaskGoalTokensResult,
  type CompleteTaskGoalParams,
  type CompleteTaskGoalResult,
  type ClearTaskGoalParams,
  type ClearTaskGoalResult,
} from './types.js'
import {
  buildNewTaskGoal,
  appendAuditEntry,
  incrementTokens,
  transitionGoalStatus,
  shouldAutoBlock,
  TASK_GOAL_BLOCKED_THRESHOLD,
} from './task-goal.js'
import { unionResolved } from './permission-resolution.js'
import { ModelProviderManager, imageResultToConfigFields } from './model-provider-manager.js'
import { AgentManager } from './agent-manager.js'
import { buildOnboardFinishResponse } from './onboard-finish-response.js'
import { ChannelManager } from './channel-manager.js'
import {
  migrateScheduleTargetSession,
  repairScheduleTargetSession,
  type SessionTypeLookup,
  type TargetSessionRepairLookup,
} from './schedule-migration.js'
import { ModuleInstaller } from './module-installer.js'
import { ChatManager, buildChatTaskSnapshot } from './chat-manager.js'
import { MediaStore } from './media-store.js'
import { handleTmpPageRequest, resolveTmpPageBaseUrl } from './tmp-page-proxy.js'
import {
  MCPServerManager,
  SkillManager,
  EssentialToolsManager,
  DuplicateSkillError,
  type MCPServerRegistryEntry,
} from './mcp-skill-manager.js'
import { SubAgentManager, resolveSubAgentModel } from './subagent-manager.js'
import { getPresetVendors, initVendorRegistry } from './vendor-registry.js'
import { Cron } from 'croner'
import { ScheduleEngine } from './schedule-engine.js'
import {
  collectDialogObjectChannelSessions,
  extractChannelIdentityFromPrivateSession,
  projectApplicationDialogObjects,
  projectFriendDialogObjects,
  projectGroupDialogObjects,
  projectPrivatePoolDialogObjects,
  sessionHasMasterParticipant,
} from './dialog-objects.js'
import { createMemoryV2RestRouter } from './memory-v2-rest.js'
import { OnboardingManager } from './onboarding-manager.js'
import {
  mergeMasterChannelIdentity,
  buildOnboardingPushMessage,
  ONBOARDING_MASTER_DEFAULT_DISPLAY_NAME,
} from './onboarding-master.js'
import type { Onboarder } from 'crabot-shared'
import { tailLogFile } from './module-log-tail.js'
import {
  VALID_TRANSITIONS,
  applyDerivedFields,
  assertTaskInvariants,
  repairTaskInvariants,
} from './task-state-machine.js'
import { getBuiltinSkills } from './builtin-skills.js'
import { snapshotSessionConfig } from './session-config-snapshot-migration.js'
import { getBuiltinSubAgents } from './builtin-subagents.js'
import { parseCleanupParams } from './trace-cleanup-cron.js'
import {
  resolveTaskByShortIdPrefix,
  formatGoalShowResponse,
  formatGoalShowNotFound,
  formatGoalShowNoGoal,
  formatGoalClearResponse,
  formatGoalClearAlreadyTerminal,
  formatGoalClearAmbiguous,
  formatGoalListResponse,
  formatMissingIdResponse,
} from './goal-slash.js'
import { readCredentials, verifyPassword, rotateCredentials, writeCredentials } from './credentials.js'
import { getAdminLogsDir, getDataRootDir } from './core/data-paths.js'

// ============================================================================
// JWT 工具函数
// ============================================================================

interface JwtPayload {
  sub: string
  iat: number
  exp: number
  e?: number          // token_epoch；internal-token 无此字段
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

async function verifyJwtWithEpoch(
  token: string,
  secret: string,
  dataDir: string,
): Promise<JwtPayload | null> {
  const payload = verifyJwt(token, secret)
  if (!payload) return null
  if (payload.sub === 'internal') return payload   // 豁免

  const cred = await readCredentials(dataDir)
  if (!cred) return null
  if (payload.e !== cred.token_epoch) return null
  return payload
}

// ============================================================================
// Scene Profile 工具函数
// ============================================================================

interface SceneIdentity {
  type: 'friend' | 'group_session'
  friend_id?: string
  channel_id?: string
  session_id?: string
}

function parseSceneKey(key: string): SceneIdentity {
  const decoded = decodeURIComponent(key)
  if (decoded.startsWith('friend:')) {
    const friendId = decoded.slice('friend:'.length)
    if (!friendId) throw new Error(`Invalid friend scene key: ${decoded}`)
    return { type: 'friend', friend_id: friendId }
  }
  if (decoded.startsWith('group:')) {
    const rest = decoded.slice('group:'.length)
    const idx = rest.indexOf(':')
    if (idx <= 0 || idx === rest.length - 1) {
      throw new Error(`Invalid group scene key: ${decoded}`)
    }
    return {
      type: 'group_session',
      channel_id: rest.slice(0, idx),
      session_id: rest.slice(idx + 1),
    }
  }
  throw new Error(`Unknown scene key: ${decoded}`)
}

function defaultSceneProfileLabel(scene: SceneIdentity): string {
  if (scene.type === 'friend') return `friend:${scene.friend_id}`
  return `group:${scene.channel_id}:${scene.session_id}`
}

function normalizeSceneProfileTextField(
  value: string | undefined,
  fallback: string,
): string {
  if (value === undefined) {
    return fallback
  }
  const trimmed = value.trim()
  return trimmed || fallback
}

/**
 * Admin 运行代码根（升级目标 = 当前运行的代码，而非 data 目录的家）。
 * 优先用 cli.mjs 设的 CRABOT_HOME；dev.sh 直起 MM 不经 cli.mjs，回退到本模块编译产物位置
 * （crabot-admin/dist → 上两级 = 仓库根）。不从 data_dir 反推——代码与 data 可能不同根
 * （全局 crabot start 用 ~/.crabot/data 但代码在 repo），反推会把 data 的家误当代码的家。
 */
const CRABOT_HOME = process.env.CRABOT_HOME ?? path.resolve(__dirname, '../..')

/**
 * admin-web 伪 channel 的 id（spec 2026-06-10-master-chat-redesign §4）：manager 的
 * `send_message` 与 worker 的结果回报都经它路由回聊天界面。任务状态卡的归属判据。
 */
const ADMIN_CHAT_CHANNEL_ID = 'admin-web'

/**
 * query string 里的整数参数。缺省或非法（`?page=abc` / `?page_size=`）一律回落到 fallback。
 *
 * 与既有端点惯用的裸 `parseInt(x ?? '20', 10)` 的差别只在于挡住了 NaN——`/api/agent/workers*`
 * 的 page/page_size/seq 会原样进入 agent 侧的 slice/filter，NaN 会静默返回空结果而不报错。
 */
function coreAgentOrchestrationConfig(): CoreAgentRuntimeConfig['orchestration'] {
  return {
    front_context_recent_messages_window_hours: 6,
    front_context_recent_messages_max_cap: 50,
    front_context_short_term_memory_window_hours: 12,
    front_context_short_term_memory_max_cap: 30,
    worker_recent_messages_window_hours: 4,
    worker_recent_messages_max_cap: 50,
    worker_short_term_memory_window_hours: 12,
    worker_short_term_memory_max_cap: 10,
    worker_long_term_memory_limit: 5,
    front_agent_timeout: 30,
    session_state_ttl: 3600,
    worker_config_refresh_interval: 60,
    front_agent_queue_max_length: 100,
    front_agent_queue_timeout: 300,
  }
}
function parseIntParam(raw: string | null, fallback: number): number {
  const parsed = Number.parseInt(raw ?? '', 10)
  return Number.isFinite(parsed) ? parsed : fallback
}

/**
 * 没有合理 fallback 的整数参数（`?seq=`）：缺省或非法一律返回 undefined，由调用方**不下发
 * 该字段**，让 agent 侧走它自己的缺省语义。
 *
 * 不能像 page/page_size 那样回落到一个具体数字：化身 seq 从 1 开始编号，回落 0 在台账里
 * 永远不存在（output 端点因此 500、trace 端点静默返回空），回落 1 则锁死在**最早**那个
 * 化身上——worker 经历 revive/handoff 后主线早已不是 seq=1。唯一正确的缺省是"主线化身"，
 * 而那只有 agent 侧（持台账）算得出来。
 */
function parseOptionalIntParam(raw: string | null): number | undefined {
  const parsed = Number.parseInt(raw ?? '', 10)
  return Number.isFinite(parsed) ? parsed : undefined
}

/**
 * `/api/agent/workers*` 三个按 worker_id 读的端点统一的"worker 不存在 → 404"判定。
 *
 * agent 侧同一件事有两处文案，大小写不同：`unified-agent.ts` 的 handler 显式抛
 * `Worker not found: <id>`（detail / trace），`harness.ts` 的 `WorkerNotFoundError` 抛
 * `worker not found: <id>`（output 走 `harness.readWorkerOutput`）。各端点各写各的匹配串时，
 * output 端点对同一个不存在的 id 落 500 而另外两个落 404（P5 review 修复第二轮）。
 * 抽成一个谓词共用，是为了不让这种不对称再次悄悄漂移出来。
 *
 * 只做大小写归一、不放宽到 `includes('not found')`：agent 侧其它真错（如
 * `no incarnation with seq=N found for worker <id>` —— 化身不存在而非 worker 不存在）必须
 * 继续落 500，否则前端分不清"这个 worker 没了"和"这个化身没了"。
 */
function isWorkerNotFoundError(message: string): boolean {
  return message.toLowerCase().includes('worker not found')
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

async function wrapJsonHandler(res: ServerResponse, errorLabel: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    sendJson(res, 200, await fn())
  } catch (err) {
    const code = (err as { code?: unknown })?.code
    sendJson(res, code === 'ADMIN_CORE_AGENT_CUTOVER_INCOMPLETE' ? 503 : 500, { error: err instanceof Error ? err.message : errorLabel })
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
  private readonly configMutationCoordinator: CoreAgentConfigMutationCoordinator
  private readonly cutoverStore: CoreAgentCutoverStore
  private readonly managementOnly: boolean
  private readonly cutoverBearer?: string
  private cutoverActivated = false
  private configInvalidationPublicationEnabled = false
  private configDrainRetryTimer?: ReturnType<typeof setTimeout>
  private configDrainRetryDelayMs = 1_000
  private cutoverAttempt: Promise<void> | null = null
  private cutoverRecoveryReason: string | null = null
  private webServer: http.Server | null = null
  private jwtSecret: string = ''

  // 数据存储
  private friends: Map<FriendId, Friend> = new Map()
  private permissionTemplateManager = new PermissionTemplateManager()
  private pendingMessages: Map<string, PendingMessage> = new Map()
  private channelIdentityIndex: Map<string, FriendId> = new Map() // 快速查找
  private tasks: Map<TaskId, Task> = new Map()
  private schedules: Map<ScheduleId, Schedule> = new Map()
  private sessionConfigs: Map<string, SessionPermissionConfig> = new Map()
  private friendPermissionConfigs: Map<FriendId, FriendPermissionConfig> = new Map()

  // 模型供应商管理器
  private modelProviderManager: ModelProviderManager

  // Agent 管理器
  private workerImplementationStore!: WorkerImplementationStore
  private workerConnectionRevisionSigner!: WorkerConnectionRevisionSigner
  private workerOperationAssertions!: WorkerOperationAssertions
  private agentManager: AgentManager

  // Channel 管理器
  private channelManager: ChannelManager

  // 模块安装器
  private moduleInstaller: ModuleInstaller

  // Chat 管理器
  private chatManager: ChatManager | null = null

  // 媒体存储
  private mediaStore: MediaStore | null = null
  private mediaSweepTimer: NodeJS.Timeout | null = null

  // Channel 配置入口管理（onboarding_methods）
  private onboardingManager: OnboardingManager

  // MCP Server 管理器
  private mcpServerManager!: MCPServerManager

  // Skill 管理器
  private skillManager!: SkillManager

  // 必要工具配置管理器
  private essentialToolsManager!: EssentialToolsManager

  // SubAgent 管理器
  private subAgentManager!: SubAgentManager

  // Browser 管理器（CDP 浏览器自动化）
  private browserManager!: BrowserManager

  // 调度引擎
  private scheduleEngine: ScheduleEngine

  // Memory v2 REST router
  private memoryV2Router!: ReturnType<typeof createMemoryV2RestRouter>

  // OpenClaw 导入：上传备份的暂存（带 TTL 清扫，见 staged-upload-store.ts）
  private openclawImportStore: StagedUploadStore | null = null
  private openclawImportSweepTimer: NodeJS.Timeout | null = null

  // 版本检查与升级服务
  private versionService!: VersionService

  // 模块 env 配置缓存
  private moduleEnvConfigCache: Map<string, Record<string, string>> = new Map()

  // 数据文件路径（在 constructor 里就初始化好，避免 SIGINT 早于 onStart 时 saveData 写到错误位置）
  private readonly friendsFilePath: string
  private readonly templatesFilePath: string
  private readonly pendingMessagesFilePath: string
  private readonly sessionConfigsFilePath: string
  private readonly friendPermissionConfigsFilePath: string
  private readonly schedulesFilePath: string
  private readonly tasksFilePath: string

  // waiting_human 超时扫描器
  private static readonly WAITING_HUMAN_TIMEOUT_MS = 24 * 60 * 60 * 1000  // 24h
  private static readonly WAITING_HUMAN_SCAN_INTERVAL_MS = 5 * 60 * 1000  // 5min
  private waitingHumanScanTimer?: NodeJS.Timeout
  private stopTraceCleanupCron?: () => void
  private agentMaintenanceStarted = false

  // Task/Trace 状态对账（SSOT 重整 2026-06-09 兜底层）
  /** task 距上次更新 < 此阈值 = 跳过对账（防误判刚 spawn 的 task） */

  // 数据加载完成前 saveData 必须拒绝，否则会用空内存覆盖磁盘真实数据
  private dataLoaded = false

  // saveData 串行化锁：防止并发 saveData 在 atomicWriteFile 的 write(.tmp) + rename 上竞态
  // 典型场景：trigger_now 的 fire-and-forget saveData 与 admin.stop() 的 saveData 同时进行
  private saveDataLock: Promise<void> | null = null

  // saveTasks 专项串行化锁：tasks 写盘频率比 saveData 高得多（每条 task mutation 都触发），
  // 必须跟 saveData 解耦——共用 saveDataLock 会让 task 写盘等其他 6 个文件依次写完，性能不可接受。
  // 解决问题：handleCreateTask / handleUpdateTaskStatus 等并发 upsertTask 时，多个 atomicWriteFile
  // 同时 writeFile(tasks.json.tmp) → rename(tmp→tasks.json) 在 rename 阶段抢同一个 tmp 文件，
  // 后到的拿 ENOENT 抛错 → schedule create_task 失败 → ScheduledTaskRunner 不触发 → task 卡 pending。
  private saveTasksLock: Promise<void> | null = null

  constructor(
    moduleConfig: ModuleConfig,
    adminConfig: Partial<AdminConfig> = {}
  ) {
    super(moduleConfig)
    this.adminConfig = { ...DEFAULT_ADMIN_CONFIG, ...adminConfig }
    this.configMutationCoordinator = new CoreAgentConfigMutationCoordinator(this.adminConfig.data_dir, {
      readSemanticSnapshot: () => this.readCoreAgentSemanticSnapshot(),
      // Initial/upgrade seeding may commit multiple serialized source changes before Admin has
      // registered. Deferring network publication must not block the next local startup mutation;
      // the latest revision is published explicitly after activation.
      publishInvalidation: async ({ config_revision, domains }) => {
        if (!this.configInvalidationPublicationEnabled) return
        await this.publishAdminEventDurable('admin.agent_config_invalidated', { config_revision, domains })
      },
      // publish 失败后 outbox 保留 committed/invalidation_pending；运行期必须有重试入口，
      // 否则 readCommittedEpoch/mutate 会被一个卡住的 outbox 永久锁死（只能重启 Admin 解）。
      onInvalidationPublishFailure: () => this.scheduleConfigDrainRetry(),
      // journal-bound skill mutation 运行期中止时，立即跑与启动期同形的 journal 恢复
      // （回滚物理文件、删 journal、清 receipt binding），否则所有配置写入会被
      // 'source journal cleanup is still active' 锁死到重启。
      abortSourceJournal: () => this.skillManager.recoverSourceJournal(this.configMutationCoordinator),
    })
    this.cutoverStore = new CoreAgentCutoverStore(this.adminConfig.data_dir)
    this.managementOnly = process.env.CRABOT_ADMIN_STARTUP_MODE === 'core-agent-cutover'
    this.cutoverBearer = process.env.CRABOT_ADMIN_CUTOVER_BEARER
    delete process.env.CRABOT_ADMIN_STARTUP_MODE
    delete process.env.CRABOT_ADMIN_CUTOVER_BEARER
    this.webServer = null

    // 数据文件路径：constructor 里就算好，生命周期内不可变
    this.friendsFilePath = path.join(this.adminConfig.data_dir, 'friends.json')
    this.templatesFilePath = path.join(this.adminConfig.data_dir, 'templates.json')
    this.pendingMessagesFilePath = path.join(this.adminConfig.data_dir, 'pending-messages.json')
    this.sessionConfigsFilePath = path.join(this.adminConfig.data_dir, 'session-configs.json')
    this.friendPermissionConfigsFilePath = path.join(this.adminConfig.data_dir, 'friend-permission-configs.json')
    this.schedulesFilePath = path.join(this.adminConfig.data_dir, 'schedules.json')
    this.tasksFilePath = path.join(this.adminConfig.data_dir, 'tasks.json')

    this.modelProviderManager = new ModelProviderManager(
      this.adminConfig.data_dir
    )
    this.agentManager = new AgentManager(this.adminConfig.data_dir)
    this.channelManager = new ChannelManager(this.adminConfig.data_dir, this.rpcClient)
    this.moduleInstaller = new ModuleInstaller(this.adminConfig.data_dir, this.agentManager)
    this.mcpServerManager = new MCPServerManager(this.adminConfig.data_dir)
    this.skillManager = new SkillManager(this.adminConfig.data_dir)
    this.essentialToolsManager = new EssentialToolsManager(this.adminConfig.data_dir)
    this.subAgentManager = new SubAgentManager(this.adminConfig.data_dir, getBuiltinSubAgents)
    this.workerImplementationStore = new WorkerImplementationStore(this.adminConfig.data_dir)
    this.workerConnectionRevisionSigner = new WorkerConnectionRevisionSigner(this.adminConfig.data_dir)

    this.browserManager = new BrowserManager(
      this.adminConfig.data_dir,
      parseInt(process.env.CRABOT_PORT_OFFSET || '0', 10)
    )
    this.scheduleEngine = new ScheduleEngine({
      onTrigger: (schedule) => this.handleScheduleTrigger(schedule),
    })

    this.onboardingManager = new OnboardingManager()

    this.versionService = new VersionService({
      crabotHome: CRABOT_HOME,
      dataDir: this.adminConfig.data_dir,
      proxyUrlProvider: () => proxyManager.getProxyUrl(),
    })

    this.memoryV2Router = createMemoryV2RestRouter({
      rpcClient: this.rpcClient,
      moduleId: this.config.moduleId,
      getMemoryPort: (mid) => this.getMemoryPort(mid),
    })

    this.agentManager.setSemanticSnapshotProvider(() => this.readCoreAgentSemanticSnapshot())
    this.modelProviderManager.setSemanticSnapshotProvider(() => this.readCoreAgentSemanticSnapshot())
    this.agentManager.setMutationRunner(async (domains, preview, apply) => {
      await this.configMutationCoordinator.mutateComputed(domains, preview, apply)
    })
    this.modelProviderManager.setMutationRunner(async (domains, preview, apply, allowRuntimeNoop) => {
      await this.configMutationCoordinator.mutateComputed(domains, preview, apply, allowRuntimeNoop)
    })
    this.mcpServerManager.setSemanticSnapshotProvider(() => this.readCoreAgentSemanticSnapshot())
    this.subAgentManager.setSemanticSnapshotProvider(() => this.readCoreAgentSemanticSnapshot())
    this.skillManager.setSemanticSnapshotProvider(() => this.readCoreAgentSemanticSnapshot())
    this.mcpServerManager.setMutationRunner(async (domains, preview, apply, allowRuntimeNoop) => {
      await this.configMutationCoordinator.mutateComputed(domains, preview, apply, allowRuntimeNoop)
    })
    this.subAgentManager.setMutationRunner(async (domains, preview, apply, allowRuntimeNoop) => {
      await this.configMutationCoordinator.mutateComputed(domains, preview, apply, allowRuntimeNoop)
    })
    this.skillManager.setMutationRunner(async (domains, preview, apply, allowRuntimeNoop, options) => {
      await this.configMutationCoordinator.mutateComputed(domains, preview, apply, allowRuntimeNoop, options)
    })
    this.workerImplementationStore.setSemanticSnapshotComputer((candidate) => {
      const snapshot = this.readCoreAgentSemanticSnapshot() as Record<string, unknown>
      return { ...snapshot, worker_implementations: candidate }
    })
    this.workerImplementationStore.setMutationRunner(async (domains, preview, apply) => {
      await this.configMutationCoordinator.mutateComputed(domains, preview, apply)
    })
    // AgentManager still emits its legacy local callback for non-core compatibility; core runtime
    // invalidation is committed by the coordinator above, never by pushConfig.
    this.agentManager.setOnConfigChanged(() => undefined)
    this.modelProviderManager.setAgentConfigRefsProvider(
      (providerId) => this.agentManager.getReferencesForProvider(providerId)
    )

    // 注册 Admin 协议方法
    this.registerMethod('list_friends', this.handleListFriends.bind(this))
    this.registerMethod('get_friend', this.handleGetFriend.bind(this))
    this.registerMethod('find_master_friend', async () => {
      const friend = this.findMasterFriend()
      return { friend: friend ?? null }
    })
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
    // spec 2026-06-09-task-trace-tool-unification.md §4.3 + §4.4
    this.registerMethod('cleanup_old_tasks_by_count', this.handleCleanupOldTasksByCount.bind(this))
    this.registerMethod('update_task_status', this.handleUpdateTaskStatus.bind(this))
    this.registerMethod('update_task_outcome', this.handleUpdateTaskOutcome.bind(this))
    this.registerMethod('assign_worker', this.handleAssignWorker.bind(this))
    this.registerMethod('update_plan', this.handleUpdatePlan.bind(this))
    this.registerMethod('append_message', this.handleAppendMessage.bind(this))
    this.registerMethod('get_task_messages', this.handleGetTaskMessages.bind(this))
    this.registerMethod('get_task_stats', this.handleGetTaskStats.bind(this))
    this.registerMethod('delete_task', this.handleDeleteTask.bind(this))

    // Schedule 管理
    this.registerMethod('create_schedule', this.handleCreateSchedule.bind(this))
    this.registerMethod('get_schedule', this.handleGetSchedule.bind(this))
    this.registerMethod('list_schedules', this.handleListSchedules.bind(this))
    this.registerMethod('update_schedule', this.handleUpdateSchedule.bind(this))
    this.registerMethod('delete_schedule', this.handleDeleteSchedule.bind(this))
    this.registerMethod('trigger_now', this.handleTriggerNow.bind(this))

    // Model Provider 管理

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
    this.registerMethod('resolve_worker_connection', this.handleResolveWorkerConnection.bind(this))
    this.registerMethod('consume_worker_operation_assertion', this.handleConsumeWorkerOperationAssertion.bind(this))
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

    // Permission Template 管理
    this.registerMethod('list_permission_templates', this.handleListPermissionTemplates.bind(this))
    this.registerMethod('get_permission_template', this.handleGetPermissionTemplate.bind(this))
    this.registerMethod('create_permission_template', this.handleCreatePermissionTemplate.bind(this))
    this.registerMethod('update_permission_template', this.handleUpdatePermissionTemplate.bind(this))
    this.registerMethod('delete_permission_template', this.handleDeletePermissionTemplate.bind(this))

    // Session 配置管理
    this.registerMethod('get_friend_permissions', async (params: { friend_id: FriendId }) =>
      await this.handleGetFriendPermission(params.friend_id)
    )
    this.registerMethod('resolve_principal_permissions', this.resolvePrincipalPermissions.bind(this))
    this.registerMethod('get_session_config', this.handleGetSessionConfig.bind(this))
    this.registerMethod('update_session_config', this.handleUpdateSessionConfig.bind(this))
    this.registerMethod('delete_session_config', this.handleDeleteSessionConfig.bind(this))

    // Chat 管理
    this.registerMethod('consume_admin_chat_assertion', this.handleConsumeAdminChatAssertion.bind(this))
    this.registerMethod('chat_callback', this.handleChatCallback.bind(this))
    this.registerMethod('get_chat_history', this.handleGetChatHistory.bind(this))
    // admin-web 伪 channel：worker send_message 出站收口（spec 2026-06-10-master-chat-redesign §4）
    this.registerMethod('send_message', this.handleChatSendMessage.bind(this))

    // TaskGoal 管理（spec: 2026-05-23-goal-mode-design.md §3）
    this.registerMethod('set_task_goal', this.handleSetTaskGoal.bind(this))
    this.registerMethod('append_task_goal_audit_entry', this.handleAppendTaskGoalAuditEntry.bind(this))
    this.registerMethod('increment_task_goal_tokens', this.handleIncrementTaskGoalTokens.bind(this))
    this.registerMethod('complete_task_goal', this.handleCompleteTaskGoal.bind(this))
    this.registerMethod('clear_task_goal', this.handleClearTaskGoal.bind(this))
  }

  // ============================================================================
  // 生命周期
  // ============================================================================

  protected override async onStart(): Promise<void> {
    // 从环境变量读取配置
    this.jwtSecret = process.env[this.adminConfig.jwt_secret_env] ?? ''
    // 密码不再缓存：每次 login 实时读 credentials.json

    if (!this.jwtSecret) {
      // 如果没有配置 JWT secret，生成一个随机的
      this.jwtSecret = crypto.randomBytes(32).toString('hex')
      console.warn('[Admin] Warning: No JWT secret configured, using random value')
    }
    // worker operation assertion 签名密钥复用 jwtSecret（与 admin-chat assertion 同纪律）。
    this.workerOperationAssertions = new WorkerOperationAssertions(this.adminConfig.data_dir, this.jwtSecret)

    // 确保数据目录存在
    await fs.mkdir(this.adminConfig.data_dir, { recursive: true })
    // Source managers must load before coordinator recovery so its semantic HMAC observes
    // persisted data rather than empty in-memory maps.

    // 生成 internal-token 供 CLI 和 Agent 使用
    const internalTokenPayload: JwtPayload = {
      sub: 'internal',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 365 * 24 * 3600, // 1年有效期（每次启动重新生成）
    }
    const internalToken = signJwt(internalTokenPayload, this.jwtSecret)
    const tokenPath = path.join(this.adminConfig.data_dir, 'internal-token')
    await fs.writeFile(tokenPath, internalToken, { mode: 0o600 })
    console.log(`[Admin] Internal token written to ${tokenPath}`)

    // 加载数据（filePath 已在 constructor 初始化）
    await this.loadData()
    this.dataLoaded = true
    await this.saveTasks()

    // Agent v3 owns worker recovery. Legacy Admin tasks were finalized during loadData;
    // Admin must not poll for Agent readiness to revive a second task truth source.

    // 初始化系统权限模板
    await this.initSystemTemplates()

    // 迁移旧 sessionConfig：补齐缺失的 cli_access 字段（幂等）
    await this.runSessionConfigSnapshotMigration()

    // 加载模块 env 配置缓存
    await this.loadModuleEnvConfigCache()

    // Load all core config source managers without writes before coordinator recovery.
    await this.modelProviderManager.initialize()
    await this.agentManager.initialize()
    await initVendorRegistry(this.adminConfig.data_dir)

    // 加载并应用存储的代理配置
    const proxyConfig = this.modelProviderManager.getProxyConfig()
    proxyManager.updateConfig(proxyConfig)
    console.log(`[Admin] Proxy config loaded: mode=${proxyConfig.mode}`)

    // Load every source used by the semantic snapshot without writes before coordinator recovery.
    await this.mcpServerManager.initializeLoadOnly()
    await this.subAgentManager.initializeLoadOnly()
    await this.skillManager.initializeLoadOnly()
    await this.essentialToolsManager.initialize()
    // worker_implementations 同属 semantic snapshot 分量：recovery 前必须已 load
    //（新部署在此原子落 revision 1 安全初始配置）。
    await this.workerImplementationStore.load()

    // P6-B：worker_implementations 首次进入 semantic 投影时，存量实例的 committed
    // fingerprint 与 live 不一致——预埋一次性 rebaseline marker，让 coordinator initialize
    // 以 revision+1 合法扩展（而不是 fail closed）。fresh deploy 无 committed record，
    // 不需要 marker（initialize 直接以新投影建 revision 1）。
    {
      const recordExists = await fs.access(path.join(this.adminConfig.data_dir, 'config', 'core-agent-config-revision.json')).then(() => true).catch(() => false)
      if (recordExists) {
        const markerDir = path.join(this.adminConfig.data_dir, 'migrations')
        await fs.mkdir(markerDir, { recursive: true, mode: 0o700 })
        const markerPath = path.join(markerDir, 'core-config-projection-rebaseline.json')
        await fs.writeFile(markerPath, JSON.stringify({ projection: 'worker_implementations', prepared_at: new Date().toISOString() }), { mode: 0o600 })
      }
    }

    // Recover durable revision/outbox against fully loaded source state before any mutation.
    // Verify any Skill source journal binding before coordinator initialization/recovery trusts source projection.
    await this.skillManager.verifySourceJournalBinding(this.configMutationCoordinator)
    await this.configMutationCoordinator.initialize()
    await this.skillManager.recoverSourceJournal(this.configMutationCoordinator)
    await this.configMutationCoordinator.verifyCommittedFingerprint()
    if (!this.managementOnly) {
      // Normal mode is already eligible to publish; clear a committed startup outbox before
      // builtin seeding attempts another mutation. Management-only deliberately retains it
      // until the post-cutover activation phase.
      this.configInvalidationPublicationEnabled = true
      await this.configMutationCoordinator.drainPendingInvalidation()
      // Builtin seeding mutations have no live Agent consumer: the core Agent pulls the
      // latest revision through its own authenticated startup pull. Keep publication closed
      // until activation below so startup seeding never depends on MM event fan-out.
      this.configInvalidationPublicationEnabled = false
    }
    // A durable invalidation is replayed only after Admin has registered with MM. Startup source
    // mutations below remain blocked by an active outbox, so no pending event can be overwritten.
    await this.agentManager.initializeCoreDefaultsAndMigrations()

    // 初始化 Channel 管理器
    await this.channelManager.initialize()

    // management-only must not re-register/start Channel children before cutover opens.
    if (!this.managementOnly) await this.channelManager.reRegisterInstances()

    // 加载 onboarding handler（从 builtin 模块的 yaml 读取 onboarding_methods）
    this.onboardingManager.loadFromImplementations(this.channelManager.listImplementations().items)

    // 初始化模块安装器
    await this.moduleInstaller.initialize()

    // 初始化 MCP Server 管理器

    // 注册内置 MCP Server（幂等，仅首次启动时写入）
    const mcpToolsPath = process.env.CRABOT_MCP_TOOLS_PATH
      || path.resolve(this.adminConfig.data_dir, '../../crabot-mcp-tools')
    await this.mcpServerManager.registerBuiltins(mcpToolsPath)

    // Skill runtime configuration uses the same durable source/revision transaction.
    await this.skillManager.initializeMigrations()

    // 注册内置 Skill（幂等，仅首次启动时写入）
    const builtinSkillsPath = path.join(__dirname, '..', 'builtins', 'skills')
    const registeredBuiltins = await this.skillManager.registerBuiltins(builtinSkillsPath)
    console.log(`[Admin] Registered ${registeredBuiltins} builtin skills from ${builtinSkillsPath}`)

    // Seed builtin skills（幂等）
    await this.skillManager.seedBuiltinSkills(getBuiltinSkills())
    console.log(`[Admin] Seeded ${getBuiltinSkills().length} builtin skills`)

    // 扫描工作区 skill（来自 WORKSPACE_DIR/.agents/skills/）
    const scannedCount = await this.skillManager.scanWorkspaceSkills(this.workspaceDir)
    if (scannedCount > 0) {
      console.log(`[SkillManager] 扫描发现 ${scannedCount} 个新 skill（来自 ${this.workspaceDir}/.agents/skills/）`)
    }

    // 初始化 SubAgent 管理器

    // Prune 已下线的 builtin subagents，再 seed 当前版本（幂等）
    const builtinSubAgents = getBuiltinSubAgents()
    await this.subAgentManager.pruneObsoleteBuiltins(
      builtinSubAgents.map((s) => s.id)
    )
    await this.subAgentManager.seedBuiltin(builtinSubAgents)
    console.log(`[Admin] Seeded ${builtinSubAgents.length} builtin subagents`)

    // 初始化 Browser 管理器
    await this.browserManager.loadConfig()

    // 初始化媒体存储（在 chatManager 之前，Task 6 会把 mediaStore 注入 chatManager）
    this.mediaStore = new MediaStore(this.adminConfig.data_dir)
    await this.mediaStore.init()
    // 启动时补扫一次，覆盖停机期间超期的文件
    this.mediaStore.sweepExpired().catch(() => {})
    this.mediaSweepTimer = setInterval(() => {
      this.mediaStore?.sweepExpired().catch(() => {})
    }, 24 * 60 * 60 * 1000)
    this.mediaSweepTimer.unref?.()

    // OpenClaw 导入暂存：init 清掉重启遗留的孤儿；定时器清扫取消/放弃的暂存
    this.openclawImportStore = new StagedUploadStore(this.adminConfig.data_dir)
    await this.openclawImportStore.init()
    this.openclawImportSweepTimer = setInterval(() => {
      this.openclawImportStore?.sweepExpired().catch(() => {})
    }, 5 * 60 * 1000)
    this.openclawImportSweepTimer.unref?.()

    // 初始化 Chat 管理器（mediaStore 已在上方初始化，作为第 6 参注入）
    this.chatManager = new ChatManager(
      this.adminConfig.data_dir,
      this.rpcClient,
      () => this.ensureAgentPort(),
      this.jwtSecret,
      verifyJwtWithEpoch,
      this.mediaStore!,
    )
    await this.chatManager.loadData()
    // P6-A §11.12：开放 chat ingress（接受新 inbound/outbound delivery）前先 reconcile
    // 两类 journal——pending_dispatch 的入站 outbox 重放、prepared/committing 的 delivery
    // journal 按确定性 complete/rollback。
    await this.chatManager.reconcileInboundDispatches()
    await this.chatManager.reconcileDeliveries()

    // Agent 端口由 module_started 事件驱动写入（见 onEvent），
    // 若 Admin 单独重启错过事件，由 ensureAgentPort() 惰性兜底。

    if (!this.managementOnly) {
      await this.ensureBuiltinSchedules()
      // §3.19.12 step 4：bootstrap 的 CAS 提交要发布 invalidation（Agent 收到 hint 才会
      // pull 新 revision，commit 的 revision 核对才过得去）——所以 publication 必须先开，
      // 但 ingress（cutoverActivated）仍在 bootstrap 完成后才开。
      this.configInvalidationPublicationEnabled = true
      // 存量实例（cutover 早已完成）升级 P6-B 时在此补跑 bootstrap；
      // fresh deploy/已完成/user_superseded 都幂等快进。
      await this.runWorkerImplementationBootstrap()
      const allSchedules = Array.from(this.schedules.values())
      this.scheduleEngine.startAll(allSchedules)
      console.log(`[Admin] ScheduleEngine started with ${allSchedules.filter(s => s.enabled).length} active schedules`)
      this.cutoverActivated = true
      try {
        await this.startAgentDependentMaintenance()
      } catch (error) {
        this.cutoverActivated = false
        this.configInvalidationPublicationEnabled = false
        this.scheduleEngine.stop()
        throw error
      }
    }

    // 启动 Web 服务器
    await this.startWebServer()

    console.log(`[Admin] Web server started on port ${this.adminConfig.web_port}`)

    void this.versionService.check().catch((err) => {
      console.warn('[Admin] 首次版本检查失败:', err instanceof Error ? err.message : err)
    })

    // waiting_human legacy scan is local-only and may run in management-only mode.
    this.waitingHumanScanTimer = setInterval(
      () => { this.runWaitingHumanTimeoutScan().catch((err) => console.error('[Admin] waiting_human scan error:', err)) },
      AdminModule.WAITING_HUMAN_SCAN_INTERVAL_MS,
    )
  }

  private async startAgentDependentMaintenance(): Promise<void> {
    if (this.agentMaintenanceStarted) return
    this.agentMaintenanceStarted = true
    try {
      // P6-A §9.7：legacy task-trace reconciliation 已随 get_trace_tree 退役删除；
      // v3 恢复职责由 agent 侧 reconcileManagerStack 承担，这里不再起 timer/RPC。
      const { startTraceCleanupCron } = await import('./trace-cleanup-cron.js')
      this.stopTraceCleanupCron = startTraceCleanupCron({
        getGlobalConfig: () => this.modelProviderManager.getGlobalConfig(),
        callCleanup: async (days: number) => {
          return this.callAgentRpc<
            { days: number; dry_run: boolean },
            { affected_count: number; affected_bytes: number; deleted_trace_ids: string[] }
          >('cleanup_old_traces', { days, dry_run: false })
        },
        callCleanupByTaskCount: async (maxCount: number) => {
          return this.handleCleanupOldTasksByCount({ max_count: maxCount, dry_run: false })
        },
      })
      console.log('[Admin] Trace cleanup cron started')
    } catch (error) {
      this.stopTraceCleanupCron?.()
      this.stopTraceCleanupCron = undefined
      this.agentMaintenanceStarted = false
      throw error
    }
  }

  protected override async onStop(): Promise<void> {
    if (this.configDrainRetryTimer) {
      clearTimeout(this.configDrainRetryTimer)
      this.configDrainRetryTimer = undefined
    }
    // 停止媒体存储每日清扫定时器
    if (this.mediaSweepTimer) clearInterval(this.mediaSweepTimer)
    if (this.openclawImportSweepTimer) clearInterval(this.openclawImportSweepTimer)

    // 停止 waiting_human 超时扫描器
    if (this.waitingHumanScanTimer) clearInterval(this.waitingHumanScanTimer)


    // 停止 trace 自动清理 cron
    this.stopTraceCleanupCron?.()
    this.agentMaintenanceStarted = false

    // 停止调度引擎
    this.scheduleEngine.stop()

    // 保存数据
    await this.saveData()

    // 停止 Browser 管理器
    await this.browserManager.stop()

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

  protected override async getHealthStatus(): Promise<'healthy' | 'degraded' | 'unhealthy'> {
    if (this.cutoverActivated) return 'healthy'
    // cutover 等待/恢复一律不报 unhealthy：MM 对 unhealthy 会连续探活失败后强杀进程树并
    // 限流 auto_restart（5 分钟 3 次即永久放弃）。marker 冲突 / stop 失败这类快失败模式下，
    // admin-web 会在几分钟内永久下线——而这正是最需要人从 Admin Web 介入恢复的场景。
    // 恢复状态的区分留在 getHealthDetails（cutover_ready / recovery_reason）与
    // module.health_changed 事件里，不落 MM 的自动重启判据。
    return 'degraded'
  }

  protected override async getHealthDetails(): Promise<Record<string, unknown>> {
    const health: Record<string, unknown> = {
      web_server_running: this.webServer !== null,
      cutover_ready: this.cutoverActivated,
      ...(this.cutoverActivated ? {} : { recovery_reason: this.cutoverRecoveryReason ?? 'waiting for authenticated core Agent startup/configuration' }),
      friends_count: this.friends.size,
      pending_messages_count: this.pendingMessages.size,
      providers_count: this.modelProviderManager.listProviders().length,
    }

    return health
  }

  protected override async onEvent(event: Event): Promise<void> {
    // Core Agent config is pull-only: startup uses authenticated get_agent_config and runtime
    // changes publish a nonsecret revision invalidation. Memory retains its existing push path.
    switch (event.type) {
      case 'module_manager.module_started': {
        const { module_id, module_type, port } = event.payload as { module_id: string; module_type: string; port: number }
        if (module_type === 'memory') {
          console.log(`[Admin] Memory module ${module_id} started, pushing config as safety net...`)
          this.syncGlobalConfigToMemoryModules().catch((err: Error) => {
            console.warn(`[Admin] Failed to push config to ${module_id}:`, err.message)
          })
        }
        if (module_id === 'crabot-agent') {
          if (typeof port === 'number' && port > 0) {
            this.agentPort = port
          }
          console.log(`[Admin] Core Agent started (port=${port}), publishing invalidation hint...`)
          this.publishAgentConfigInvalidation().catch((err: Error) => {
            console.warn(`[Admin] Failed to publish config invalidation for ${module_id}: ${err.message}`)
          })
        }
        // 新启动的模块推送代理配置
        this.pushProxyConfigToModule(module_id).catch((err: Error) => {
          console.warn(`[Admin] Failed to push proxy config to ${module_id}:`, err.message)
        })
        break
      }
      case 'module_manager.module_stopped': {
        const { module_id, module_type } = event.payload as { module_id: string; module_type: string }
        this.invalidatePortCache(module_id, module_type)
        break
      }
      case 'module_manager.module_health_changed': {
        const { module_id, current } = event.payload as { module_id: string; current: string }
        if (current === 'unhealthy') {
          // 拿不到 module_type → 清所有可能命中的缓存（保险）
          this.invalidatePortCache(module_id, 'unknown')
        }
        break
      }
      case 'module_manager.module_error':
        break

      case 'channel.message_received': {
        const { channel_id, message, crab_display_name, crab_self_handle } = event.payload as { channel_id: ModuleId; message: ChannelMessageRef; crab_display_name?: string; crab_self_handle?: string }
        await this.handleChannelMessage(channel_id, message, crab_display_name, crab_self_handle)
        break
      }
      case 'agent.task_status_changed': {
        await this.handleAgentTaskStatusChanged(
          event.payload as { worker_id: string; task_id: TaskId; new_status: AgentTaskStatus }
        )
        break
      }
      // 其他事件处理...
    }
  }

  /**
   * protocol-agent-v3 §9.2：task 真相源迁到 agent 之后，状态变更由 agent 发事件。
   *
   * Master Chat 的任务状态卡在 v2 是由 admin 自己的 `applyStatusTransition` 顺手推的；
   * cutover 之后 admin 不再是那条状态机的执行者，**不订阅这个事件，卡片就永远停在
   * 创建时的那一帧**（既不会转完成也不会转失败，且没有任何报错）。
   *
   * 事件载荷里没有 title，也没有"这条 task 属不属于 admin chat"的信息，所以要回查一次
   * §8.3 的只读端点 `get_worker_detail`：拿 `task.title` 填卡片，拿 `report_to` 判定
   * 归属（v2 的判据是 `task.source.channel_id === 'admin-web'`，v3 的等价物是
   * "结果回报目标是不是 admin chat"）。回查失败只 warn——状态卡不是关键路径。
   */
  private async handleAgentTaskStatusChanged(payload: {
    worker_id: string
    task_id: TaskId
    new_status: AgentTaskStatus
  }): Promise<void> {
    if (!this.chatManager) return

    let worker: LedgerWorkerBrief
    try {
      const result = await this.callAgentRpc<{ worker_id: string }, { worker: LedgerWorkerBrief }>(
        'get_worker_detail',
        { worker_id: payload.worker_id }
      )
      worker = result.worker
    } catch (err) {
      console.warn(
        `[Admin] agent.task_status_changed: get_worker_detail(${payload.worker_id}) failed: ${err instanceof Error ? err.message : String(err)}`
      )
      return
    }

    if (worker?.report_to?.channel_id !== ADMIN_CHAT_CHANNEL_ID) return

    this.chatManager.pushTaskUpdate({
      task_id: payload.task_id,
      status: payload.new_status,
      title: worker.task?.title ?? payload.task_id,
    })
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
      const handleAsync = async (): Promise<void> => {
        if (!this.cutoverActivated) {
          socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n')
          socket.destroy()
          return
        }
        if (this.chatManager) {
          await this.chatManager.handleUpgrade(req, socket as Socket, head)
        } else {
          socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n')
          socket.destroy()
        }
      }
      handleAsync().catch(() => {
        socket.write('HTTP/1.1 500 Internal Server Error\r\n\r\n')
        socket.destroy()
      })
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

    if (!this.cutoverActivated && (pathname === '/api/chat/messages' || pathname === '/api/chat/tasks' || pathname.startsWith('/api/chat/messages/') || pathname.startsWith('/api/chat/tasks/'))) {
      sendJson(res, 503, { error: 'Core Agent cutover is incomplete' })
      return
    }

    // 认证检查（排除登录接口、静态文件、媒体文件端点）
    if (pathname.startsWith('/api/') && pathname !== '/api/auth/login' && !pathname.startsWith('/api/media/')) {
      const authHeader = req.headers.authorization
      let token: string | null = null
      if (authHeader?.startsWith('Bearer ')) {
        token = authHeader.slice(7)
      } else if (pathname === '/api/channels/onboard/poll') {
        // SSE：EventSource 不支持自定义 header，允许 ?token=xxx
        token = url.searchParams.get('token')
      }

      if (!token) {
        res.writeHead(401)
        res.end(JSON.stringify({ error: 'Unauthorized' }))
        return
      }

      const payload = await verifyJwtWithEpoch(token, this.jwtSecret, this.adminConfig.data_dir)
      if (!payload) {
        // 区分 token 不合法 vs epoch 失效
        const basicValid = verifyJwt(token, this.jwtSecret)
        if (basicValid && basicValid.sub !== 'internal') {
          res.writeHead(401)
          res.end(JSON.stringify({
            error: AdminErrorCode.TOKEN_REVOKED,
            message: 'Token revoked (password changed)',
          }))
        } else {
          res.writeHead(401)
          res.end(JSON.stringify({ error: 'Invalid or expired token' }))
        }
        return
      }
    }

    // 路由处理
    try {
      if (pathname === '/api/auth/login' && req.method === 'POST') {
        await this.handleLogin(req, res)
        return
      }

      if (pathname === '/api/auth/me' && req.method === 'GET') {
        await this.handleGetMe(req, res)
        return
      }

      if (pathname === '/api/auth/change-password' && req.method === 'POST') {
        await this.handleChangePassword(req, res)
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

      if (pathname === '/api/dialog-objects/friends' && req.method === 'GET') {
        await this.handleListDialogObjectFriendsApi(res)
        return
      }

      if (pathname === '/api/dialog-objects/private-pool' && req.method === 'GET') {
        await this.handleListDialogObjectPrivatePoolApi(res)
        return
      }

      if (pathname.match(/^\/api\/dialog-objects\/private-pool\/[^/]+\/assign-friend$/) && req.method === 'POST') {
        const sessionId = decodeURIComponent(pathname.split('/')[4])
        await this.handleAssignPrivatePoolFriendApi(req, res, sessionId)
        return
      }

      if (pathname.match(/^\/api\/dialog-objects\/private-pool\/[^/]+\/create-friend$/) && req.method === 'POST') {
        const sessionId = decodeURIComponent(pathname.split('/')[4])
        await this.handleCreatePrivatePoolFriendApi(req, res, sessionId)
        return
      }

      if (pathname === '/api/dialog-objects/groups' && req.method === 'GET') {
        await this.handleListDialogObjectGroupsApi(res)
        return
      }

      if (pathname.match(/^\/api\/dialog-objects\/groups\/[^/]+\/backfill-history$/) && req.method === 'POST') {
        const sessionId = decodeURIComponent(pathname.split('/')[4])
        await this.handleBackfillGroupHistoryApi(req, res, sessionId)
        return
      }

      if (pathname === '/api/dialog-objects/applications' && req.method === 'GET') {
        await this.handleListDialogObjectApplicationsApi(res)
        return
      }

      if (pathname.match(/^\/api\/dialog-objects\/applications\/[^/]+\/assign-friend$/) && req.method === 'POST') {
        const applicationId = decodeURIComponent(pathname.split('/')[4])
        await this.handleAssignDialogObjectApplicationFriendApi(req, res, applicationId)
        return
      }

      if (pathname.match(/^\/api\/dialog-objects\/applications\/[^/]+\/create-friend$/) && req.method === 'POST') {
        const applicationId = decodeURIComponent(pathname.split('/')[4])
        await this.handleCreateDialogObjectApplicationFriendApi(req, res, applicationId)
        return
      }

      if (pathname.match(/^\/api\/dialog-objects\/applications\/[^/]+\/link-master$/) && req.method === 'POST') {
        const applicationId = decodeURIComponent(pathname.split('/')[4])
        await this.handleLinkDialogObjectApplicationMasterApi(req, res, applicationId)
        return
      }

      if (pathname.match(/^\/api\/dialog-objects\/applications\/[^/]+$/) && req.method === 'DELETE') {
        const applicationId = decodeURIComponent(pathname.split('/')[4])
        await this.handleRejectDialogObjectApplicationApi(req, res, applicationId)
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

      // POST /api/model-providers/validate（草稿验证，不入库）
      // 必须放在 :id/test 路由之前，否则 'validate' 会被当成 provider id
      if (pathname === '/api/model-providers/validate' && req.method === 'POST') {
        await this.handleValidateDraftProviderApi(req, res)
        return
      }

      // POST /api/model-providers/:id/test
      if (pathname.match(/^\/api\/model-providers\/[^/]+\/test$/) && req.method === 'POST') {
        const id = pathname.split('/')[3]
        await this.handleTestProviderApi(req, res, id)
        return
      }

      // POST /api/model-providers/:id/refresh-models
      if (pathname.match(/^\/api\/model-providers\/[^/]+\/refresh-models$/) && req.method === 'POST') {
        const id = pathname.split('/')[3]
        await this.handleRefreshModelsApi(req, res, id)
        return
      }

      // GET /api/model-providers/:id/references
      if (pathname.match(/^\/api\/model-providers\/[^/]+\/references$/) && req.method === 'GET') {
        const id = pathname.split('/')[3]
        await this.handleGetProviderReferencesApi(req, res, id)
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

      if (pathname === '/api/system/version' && req.method === 'GET') {
        await this.handleGetSystemVersionApi(req, res)
        return
      }
      if (pathname === '/api/system/version/check' && req.method === 'POST') {
        await this.handleCheckSystemVersionApi(req, res)
        return
      }
      if (pathname === '/api/system/upgrade' && req.method === 'POST') {
        await this.handleStartUpgradeApi(req, res)
        return
      }

      if (pathname === '/api/proxy-config' && req.method === 'GET') {
        await this.handleGetProxyConfigApi(req, res)
        return
      }

      if (pathname === '/api/proxy-config' && req.method === 'PATCH') {
        await this.handleUpdateProxyConfigApi(req, res)
        return
      }

      if (pathname === '/api/config/status' && req.method === 'GET') {
        await this.handleGetConfigStatusApi(req, res)
        return
      }

      // OAuth 路由
      if (pathname === '/api/oauth/chatgpt/login' && req.method === 'POST') {
        await this.handleOAuthChatGPTLogin(req, res)
        return
      }

      if (pathname === '/api/oauth/chatgpt/status' && req.method === 'GET') {
        await this.handleOAuthChatGPTStatus(req, res)
        return
      }

      if (pathname === '/api/oauth/chatgpt/manual-callback' && req.method === 'POST') {
        await this.handleOAuthChatGPTManualCallback(req, res)
        return
      }

      if (pathname === '/api/oauth/chatgpt/import' && req.method === 'POST') {
        await this.handleOAuthChatGPTImport(req, res)
        return
      }

      if (pathname.match(/^\/api\/oauth\/chatgpt\/[^/]+\/logout$/) && req.method === 'POST') {
        const providerId = pathname.split('/')[4]
        await this.handleOAuthChatGPTLogout(req, res, providerId)
        return
      }

      if (pathname.match(/^\/api\/oauth\/chatgpt\/[^/]+\/token-info$/) && req.method === 'GET') {
        const providerId = pathname.split('/')[4]
        await this.handleOAuthChatGPTTokenInfo(req, res, providerId)
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

      if (pathname.match(/^\/api\/skills\/[^/]+\/previous-content$/) && req.method === 'GET') {
        const id = decodeURIComponent(pathname.split('/')[3])
        await this.handleGetSkillPreviousContentApi(req, res, id)
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

      if (pathname.match(/^\/api\/skills\/[^/]+\/restore$/) && req.method === 'POST') {
        const id = decodeURIComponent(pathname.split('/')[3])
        await this.handleRestoreSkillApi(req, res, id)
        return
      }

      if (pathname === '/api/skills/scan-workspace' && req.method === 'POST') {
        await this.handleScanWorkspaceSkillsApi(req, res)
        return
      }

      // OpenClaw 迁移导入
      if (pathname === '/api/openclaw-import/parse' && req.method === 'POST') {
        await this.handleOpenClawImportParseApi(req, res)
        return
      }
      if (pathname === '/api/openclaw-import/execute' && req.method === 'POST') {
        await this.handleOpenClawImportExecuteApi(req, res)
        return
      }

      // 备份导出
      if (pathname === '/api/backup/options' && req.method === 'GET') {
        await this.handleBackupOptionsApi(res)
        return
      }
      if (pathname === '/api/backup/export' && req.method === 'GET') {
        await this.handleBackupExportApi(req, res, url)
        return
      }
      if (pathname === '/api/backup/import/overview' && req.method === 'POST') {
        await this.handleBackupImportOverviewApi(req, res)
        return
      }
      if (pathname === '/api/backup/import/execute' && req.method === 'POST') {
        await this.handleBackupImportExecuteApi(req, res)
        return
      }

      // SubAgent 路由
      if (pathname === '/api/subagents' && req.method === 'GET') {
        await this.handleListSubAgentsApi(req, res)
        return
      }

      if (pathname === '/api/subagents' && req.method === 'POST') {
        await this.handleCreateSubAgentApi(req, res)
        return
      }

      if (pathname.match(/^\/api\/subagents\/[^/]+$/) && req.method === 'GET') {
        const id = pathname.split('/')[3]
        await this.handleGetSubAgentApi(req, res, id)
        return
      }

      if (pathname.match(/^\/api\/subagents\/[^/]+$/) && req.method === 'PATCH') {
        const id = pathname.split('/')[3]
        await this.handleUpdateSubAgentApi(req, res, id)
        return
      }

      if (pathname.match(/^\/api\/subagents\/[^/]+$/) && req.method === 'DELETE') {
        const id = pathname.split('/')[3]
        await this.handleDeleteSubAgentApi(req, res, id)
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

      // Browser 管理路由
      if (pathname === '/api/browser/config' && req.method === 'GET') {
        const browserConfig = await this.browserManager.loadConfig()
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          profile_mode: browserConfig.profile_mode,
          cdp_port: browserConfig.cdp_port,
          is_running: this.browserManager.isAlive(),
        }))
        return
      }

      if (pathname === '/api/browser/config' && req.method === 'PATCH') {
        const body = await this.readJsonBody<{ profile_mode?: string }>(req)
        if (body.profile_mode !== undefined && body.profile_mode !== 'isolated' && body.profile_mode !== 'user') {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'profile_mode must be "isolated" or "user"' }))
          return
        }
        const currentConfig = await this.browserManager.loadConfig()
        const updatedConfig = {
          ...currentConfig,
          ...(body.profile_mode !== undefined ? { profile_mode: body.profile_mode as 'isolated' | 'user' } : {}),
        }
        await this.browserManager.saveConfig(updatedConfig)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          profile_mode: updatedConfig.profile_mode,
          cdp_port: updatedConfig.cdp_port,
          is_running: this.browserManager.isAlive(),
        }))
        return
      }

      if (pathname === '/api/browser/start' && req.method === 'POST') {
        try {
          const cdpUrl = await this.browserManager.ensureRunning()
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ cdp_url: cdpUrl }))
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: message }))
        }
        return
      }

      if (pathname === '/api/browser/stop' && req.method === 'POST') {
        try {
          await this.browserManager.stop()
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: true }))
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: message }))
        }
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

      // Permission Template 路由
      if (pathname === '/api/permission-templates' && req.method === 'GET') {
        const systemOnly = url.searchParams.get('system_only') === 'true'
        const page = parseInt(url.searchParams.get('page') ?? '1', 10)
        const pageSize = parseInt(url.searchParams.get('page_size') ?? '50', 10)
        const result = await this.handleListPermissionTemplates({ system_only: systemOnly, page, page_size: pageSize })
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(result))
        return
      }

      if (pathname === '/api/permission-templates' && req.method === 'POST') {
        const body = await this.readJsonBody<CreatePermissionTemplateParams>(req)
        const result = await this.handleCreatePermissionTemplate(body)
        res.writeHead(201, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(result))
        return
      }

      if (pathname.match(/^\/api\/permission-templates\/[^/]+$/) && req.method === 'GET') {
        const id = decodeURIComponent(pathname.split('/')[3])
        const result = await this.handleGetPermissionTemplate({ template_id: id })
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(result))
        return
      }

      if (pathname.match(/^\/api\/permission-templates\/[^/]+$/) && req.method === 'PATCH') {
        const id = decodeURIComponent(pathname.split('/')[3])
        const body = await this.readJsonBody<Omit<UpdatePermissionTemplateParams, 'template_id'>>(req)
        const result = await this.handleUpdatePermissionTemplate({ template_id: id, ...body })
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(result))
        return
      }

      if (pathname.match(/^\/api\/permission-templates\/[^/]+$/) && req.method === 'DELETE') {
        const id = decodeURIComponent(pathname.split('/')[3])
        try {
          const result = await this.handleDeletePermissionTemplate({ template_id: id })
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(result))
        } catch (err: any) {
          const status = err.code === 'ADMIN_TEMPLATE_IN_USE' || err.code === 'ADMIN_CANNOT_DELETE_SYSTEM_TEMPLATE' ? 409 : 404
          res.writeHead(status, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: err.message, code: err.code }))
        }
        return
      }

      // Effective permissions 解析（agent 用，跨 friend × session）
      if (pathname === '/api/permissions/resolve-principal' && req.method === 'POST') {
        const body = await this.readJsonBody<ResolvePrincipalPermissionsParams>(req)
        const result = await this.resolvePrincipalPermissions(body)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(result))
        return
      }

      // Channel Sessions 代理路由
      if (pathname.match(/^\/api\/channels\/[^/]+\/sessions$/) && req.method === 'GET') {
        const channelId = decodeURIComponent(pathname.split('/')[3])
        const type = url.searchParams.get('type') ?? undefined
        try {
          const modules = await this.rpcClient.resolve(
            { module_id: channelId },
            this.config.moduleId
          )
          if (modules.length === 0) {
            res.writeHead(404, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'Channel module not found' }))
            return
          }
          const channelPort = modules[0].port
          const result = await this.rpcClient.call<
            { type?: string },
            { items: Array<{ id: string; channel_id: string; type: string; platform_session_id: string; title: string; participants: Array<{ friend_id?: string; platform_user_id: string; role: string }> }>; pagination: { total_items: number } }
          >(channelPort, 'get_sessions', { type }, this.config.moduleId)
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(result))
        } catch (err) {
          res.writeHead(502, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'Failed to fetch sessions from channel' }))
        }
        return
      }

      // Session 配置路由
      if (pathname.match(/^\/api\/sessions\/[^/]+\/config$/) && req.method === 'GET') {
        const sessionId = decodeURIComponent(pathname.split('/')[3])
        await this.handleGetSessionConfigApi(res, sessionId)
        return
      }

      if (pathname.match(/^\/api\/sessions\/[^/]+\/config$/) && req.method === 'PUT') {
        const sessionId = decodeURIComponent(pathname.split('/')[3])
        await this.handleUpdateSessionConfigApi(req, res, sessionId)
        return
      }

      if (pathname.match(/^\/api\/sessions\/[^/]+\/config$/) && req.method === 'DELETE') {
        const sessionId = decodeURIComponent(pathname.split('/')[3])
        await this.handleDeleteSessionConfigApi(res, sessionId)
        return
      }

      if (pathname.match(/^\/api\/friends\/[^/]+\/permissions$/) && req.method === 'GET') {
        const friendId = decodeURIComponent(pathname.split('/')[3]) as FriendId
        await this.handleGetFriendPermissionApi(res, friendId)
        return
      }

      if (pathname.match(/^\/api\/friends\/[^/]+\/permissions$/) && req.method === 'PUT') {
        const friendId = decodeURIComponent(pathname.split('/')[3]) as FriendId
        await this.handleUpdateFriendPermissionApi(req, res, friendId)
        return
      }

      // 媒体文件路由（端点内部自行认证，支持 ?token= 供 <img> 引用）
      if (pathname.startsWith('/api/media/') && req.method === 'GET') {
        await this.handleGetMediaApi(req, res, url)
        return
      }

      // Chat 路由
      if (pathname === '/api/chat/messages' && req.method === 'GET') {
        await this.handleGetChatMessagesApi(req, res, url)
        return
      }

      if (pathname === '/api/chat/messages' && req.method === 'POST') {
        await this.handlePostChatMessageApi(req, res)
        return
      }

      // 单条消息删除（必须在清空路由前，路径更具体）
      if (pathname.startsWith('/api/chat/messages/') && req.method === 'DELETE') {
        if (!this.chatManager) { sendJson(res, 503, { error: 'chat not ready' }); return }
        const messageId = decodeURIComponent(pathname.slice('/api/chat/messages/'.length))
        const ok = await this.chatManager.deleteMessage(messageId)
        if (!ok) { sendJson(res, 404, { error: 'message not found' }); return }
        res.writeHead(204); res.end()
        return
      }

      if (pathname === '/api/chat/messages' && req.method === 'DELETE') {
        await this.handleClearChatMessagesApi(req, res)
        return
      }

      if (pathname === '/api/chat/media-usage' && req.method === 'GET') {
        if (!this.mediaStore) { sendJson(res, 503, { error: 'media store not ready' }); return }
        sendJson(res, 200, await this.mediaStore.getUsage())
        return
      }

      if (pathname === '/api/chat/media-config' && req.method === 'PATCH') {
        if (!this.mediaStore) { sendJson(res, 503, { error: 'media store not ready' }); return }
        try {
          // readJsonBody 放 try 内：非法 JSON 也应回 400 而非 500
          const body = await this.readJsonBody<{ ttl_days?: number }>(req)
          await this.mediaStore.setConfig({ ttl_days: Number(body.ttl_days) })
          sendJson(res, 200, this.mediaStore.getConfig())
        } catch (err) {
          sendJson(res, 400, { error: err instanceof Error ? err.message : 'invalid ttl_days' })
        }
        return
      }

      if (pathname === '/api/chat/tasks' && req.method === 'GET') {
        // 进行中任务条 hydrate：运行中任务可能不在已加载的历史分页里，须全量列出
        sendJson(res, 200, { tasks: this.listActiveChatTaskSnapshots() })
        return
      }

      if (pathname.startsWith('/api/chat/tasks/') && req.method === 'GET') {
        const taskId = decodeURIComponent(pathname.slice('/api/chat/tasks/'.length))
        const task = this.tasks.get(taskId as TaskId)
        if (!task) {
          sendJson(res, 404, { error: 'task not found' })
          return
        }
        sendJson(res, 200, buildChatTaskSnapshot(task))
        return
      }

      // Agent LLM 需求 API
      if (pathname === '/api/agent-llm-requirements' && req.method === 'GET') {
        await this.handleGetAgentLLMRequirementsApi(req, res)
        return
      }

      // 模块配置管理 API
      if (req.method === 'GET' && pathname.match(/^\/api\/modules\/[^/]+\/config$/)) {
        const moduleId = decodePathSegment(pathname, 3)
        if (!isPathSafeSegment(moduleId)) {
          sendJson(res, 400, { error: 'Invalid module id' })
          return
        }
        const result = await this.handleGetModuleConfig({ module_id: moduleId })
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(result))
        return
      }

      if (req.method === 'PUT' && pathname.match(/^\/api\/modules\/[^/]+\/config$/)) {
        const moduleId = decodePathSegment(pathname, 3)
        if (!isPathSafeSegment(moduleId)) {
          sendJson(res, 400, { error: 'Invalid module id' })
          return
        }
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
        const moduleId = decodePathSegment(pathname, 3)
        const result = await this.handleStartModuleAdmin({ module_id: moduleId })
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(result))
        return
      }

      if (req.method === 'POST' && pathname.match(/^\/api\/modules\/[^/]+\/stop$/)) {
        const moduleId = decodePathSegment(pathname, 3)
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
        const moduleId = decodePathSegment(pathname, 3)
        const result = await this.handleRestartModuleAdmin({ module_id: moduleId })
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(result))
        return
      }

      // ── 通用 Channel onboarding（base-protocol §10）─────────────────────
      // SSE poll 走 query string token（EventSource 不支持自定义 header），其他三条走标准 Bearer
      if (req.method === 'POST' && pathname === '/api/channels/onboard/begin') {
        const body = await this.readJsonBody<{ implementation_id?: string; method_id?: string; params?: Record<string, unknown> }>(req).catch(() => ({} as { implementation_id?: string; method_id?: string; params?: Record<string, unknown> }))
        const onboarder = this.resolveOnboarder(res, body.implementation_id, body.method_id)
        if (!onboarder) return
        await wrapJsonHandler(res, 'onboard begin failed', () => onboarder.begin(body.params))
        return
      }
      if (req.method === 'GET' && pathname === '/api/channels/onboard/poll') {
        const implementationId = url.searchParams.get('implementation_id')
        const methodId = url.searchParams.get('method_id')
        const sessionId = url.searchParams.get('session_id')
        const onboarder = this.resolveOnboarder(res, implementationId, methodId)
        if (!onboarder) return
        if (!sessionId) {
          sendJson(res, 400, { error: 'session_id is required' })
          return
        }
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        })
        let aborted = false
        req.on('close', () => { aborted = true })
        try {
          for await (const ev of onboarder.poll(sessionId)) {
            if (aborted) break
            res.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`)
            if (ev.type === 'success' || ev.type === 'error') break
          }
        } catch (err) {
          const payload = JSON.stringify({ type: 'error', code: 'unknown', message: err instanceof Error ? err.message : 'poll failed' })
          res.write(`event: error\ndata: ${payload}\n\n`)
        }
        res.end()
        return
      }
      if (req.method === 'POST' && pathname === '/api/channels/onboard/finish') {
        const body = await this.readJsonBody<{ implementation_id?: string; method_id?: string; session_id?: string; name?: string; finish_params?: Record<string, unknown> }>(req)
        const onboarder = this.resolveOnboarder(res, body.implementation_id, body.method_id)
        if (!onboarder) return
        if (!body.session_id || !body.name) {
          sendJson(res, 400, { error: 'session_id and name are required' })
          return
        }
        await wrapJsonHandler(res, 'onboard finish failed', async () => {
          const finishResult = await onboarder.finish(body.session_id!, body.finish_params)
          const instance = await this.channelManager.createInstance({
            implementation_id: body.implementation_id!,
            name: body.name!,
            auto_start: true,
            env: finishResult.env,
          })
          const ownerOpenId = finishResult.env.FEISHU_OWNER_OPEN_ID
          let masterFriendId: FriendId | undefined
          let masterDisplayName: string | undefined
          let pushSent = false
          if (ownerOpenId && instance?.id) {
            const ensured = await this.ensureMasterForOnboarding(instance.id as ModuleId, ownerOpenId)
            masterFriendId = ensured?.friend_id
            masterDisplayName = ensured?.display_name
            if (finishResult.scope_grant_url) {
              pushSent = await this.pushOnboardingGuide(
                instance.id as ModuleId,
                ownerOpenId,
                finishResult.scope_grant_url,
              )
            }
          }
          return buildOnboardFinishResponse({
            finishResult,
            instance: instance as unknown as { id: ModuleId } & Record<string, unknown>,
            masterFriendId,
            masterDisplayName,
            pushSent,
          })
        })
        return
      }
      if (req.method === 'POST' && pathname === '/api/channels/onboard/cancel') {
        const body = await this.readJsonBody<{ implementation_id?: string; method_id?: string; session_id?: string }>(req).catch(() => ({} as { implementation_id?: string; method_id?: string; session_id?: string }))
        if (body.implementation_id && body.method_id && body.session_id) {
          this.onboardingManager.get(body.implementation_id, body.method_id)?.cancel(body.session_id)
        }
        sendJson(res, 200, { ok: true })
        return
      }

      // Agent trace 维护面（P6-A §9.6 后只保留这两个；raw trace 内容 API 全部退役）。
      if (pathname === '/api/agent/traces/disk-usage' && req.method === 'GET') {
        await this.handleGetTraceDiskUsageApi(req, res)
        return
      }
      if (pathname === '/api/agent/traces/old' && req.method === 'DELETE') {
        await this.handleCleanupOldTracesApi(req, res, url)
        return
      }

      // 单条删除 task（spec §4.3 后续 UI 清理辅助）。活跃 task 拒绝删
      const deleteTaskMatch = pathname.match(/^\/api\/admin\/tasks\/([^/]+)$/)
      if (deleteTaskMatch && req.method === 'DELETE') {
        await this.handleDeleteTaskApi(req, res, deleteTaskMatch[1])
        return
      }

      // Worker implementation desired config（protocol-admin §3.19.12，P6-B）。
      if (pathname === '/api/agent/worker-implementations' && req.method === 'GET') {
        await this.handleGetWorkerImplementationsApi(req, res)
        return
      }
      if (pathname === '/api/agent/worker-implementations' && req.method === 'PUT') {
        await this.handlePutWorkerImplementationsApi(req, res)
        return
      }
      // Worker implementation observed status（P6-B §6：Agent activation registry 透传）。
      if (pathname === '/api/agent/worker-implementations/status' && req.method === 'GET') {
        await this.proxyAgentRpc(res, 'list_worker_implementation_status', {})
        return
      }

      // Worker operation（P6-B §9）：install/verify/setup/cancel 的 Browser 入口。
      const workerOpMatch = pathname.match(/^\/api\/agent\/worker-implementations\/([^/]+)\/operations$/)
      if (workerOpMatch && req.method === 'POST') {
        await this.handleWorkerOperationApi(req, res, decodeURIComponent(workerOpMatch[1]))
        return
      }

      // Manager 只读代理（protocol-agent-v3 §8.4/§10.3，P6-A）。子路径先于 :managerKey 匹配。
      if (pathname === '/api/agent/managers' && req.method === 'GET') {
        await this.handleListManagersApi(req, res, url)
        return
      }
      const managerEpisodesMatch = pathname.match(/^\/api\/agent\/managers\/([^/]+)\/episodes$/)
      if (managerEpisodesMatch && req.method === 'GET') {
        await this.handleListManagerEpisodesApi(req, res, managerEpisodesMatch[1], url)
        return
      }

      // Worker 只读代理（protocol-agent-v3 §10.3）。子路径先于 :id 匹配。
      if (pathname === '/api/agent/workers' && req.method === 'GET') {
        await this.handleListWorkersApi(req, res, url)
        return
      }
      const workerOutputMatch = pathname.match(/^\/api\/agent\/workers\/([^/]+)\/output$/)
      if (workerOutputMatch && req.method === 'GET') {
        await this.handleReadWorkerOutputApi(req, res, workerOutputMatch[1], url)
        return
      }
      const workerTraceMatch = pathname.match(/^\/api\/agent\/workers\/([^/]+)\/trace$/)
      if (workerTraceMatch && req.method === 'GET') {
        await this.handleGetWorkerTraceApi(req, res, workerTraceMatch[1], url)
        return
      }
      const workerDetailMatch = pathname.match(/^\/api\/agent\/workers\/([^/]+)$/)
      if (workerDetailMatch && req.method === 'GET') {
        await this.handleGetWorkerDetailApi(req, res, workerDetailMatch[1])
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

      // Bg-entity admin REST API（Plan 3 Tasks 2+3）
      if (req.method === 'GET' && pathname === '/api/bg-entities') {
        await this.handleListBgEntitiesApi(req, res)
        return
      }
      const bgEntityLogMatch = pathname.match(/^\/api\/bg-entities\/([^/]+)\/log$/)
      if (bgEntityLogMatch && req.method === 'GET') {
        await this.handleGetBgEntityLogApi(req, res, decodeURIComponent(bgEntityLogMatch[1]))
        return
      }
      const bgEntityIdMatch = pathname.match(/^\/api\/bg-entities\/([^/]+)$/)
      if (bgEntityIdMatch && req.method === 'DELETE') {
        await this.handleKillBgEntityApi(req, res, decodeURIComponent(bgEntityIdMatch[1]))
        return
      }

      // 模块管理 REST：列出模块 + 看日志 + 重启
      if (req.method === 'GET' && pathname === '/api/modules') {
        await this.handleListModulesApi(req, res)
        return
      }
      const moduleLogMatch = pathname.match(/^\/api\/modules\/([^/]+)\/log$/)
      if (moduleLogMatch && req.method === 'GET') {
        await this.handleGetModuleLogApi(req, res, decodeURIComponent(moduleLogMatch[1]), url)
        return
      }

      // Memory v2 图谱重建：触发一次性 worker 任务全量重建记忆关联链接。
      // 必须在通用 memoryV2Router dispatch 之前——该 router 只持有 memory 模块 RPC，
      // 不能创建 admin 侧 task；重建语义是建一条 pending worker 任务。
      if (req.method === 'POST' && pathname === '/api/memory/v2/graph/rebuild') {
        await wrapJsonHandler(res, 'memory graph rebuild failed', async () => {
          this.assertIngressOpen()
          return this.handleRebuildMemoryGraph()
        })
        return
      }

      // Memory v2 REST API
      if (pathname.startsWith('/api/memory/v2/')) {
        const bodyText = req.method && ['POST', 'PATCH', 'PUT'].includes(req.method)
          ? JSON.stringify(await this.readJsonBody<unknown>(req).catch(() => ({})))
          : undefined
        const r = await this.memoryV2Router.dispatch(req.method ?? 'GET', req.url ?? '', bodyText)
        res.writeHead(r.status, { 'Content-Type': 'application/json' })
        if (r.status !== 204) res.end(JSON.stringify(r.body))
        else res.end()
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

      if (req.method === 'GET' && pathname.match(/^\/api\/memory\/[^/]+\/scene-profiles$/)) {
        const memoryId = pathname.split('/')[3]
        await this.handleListSceneProfilesByMemoryApi(req, res, url, memoryId)
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

      // Scene Profile 管理 API
      if (req.method === 'GET' && pathname === '/api/scene-profiles') {
        await this.handleListSceneProfilesApi(req, res, url)
        return
      }

      if (req.method === 'GET' && pathname.match(/^\/api\/scene-profiles\/.+$/)) {
        const key = pathname.slice('/api/scene-profiles/'.length)
        await this.handleGetSceneProfileApi(req, res, url, key)
        return
      }

      if (req.method === 'PATCH' && pathname.match(/^\/api\/scene-profiles\/.+$/)) {
        const key = pathname.slice('/api/scene-profiles/'.length)
        await this.handlePatchSceneProfileApi(req, res, url, key)
        return
      }

      if (req.method === 'DELETE' && pathname.match(/^\/api\/scene-profiles\/.+$/)) {
        const key = pathname.slice('/api/scene-profiles/'.length)
        await this.handleDeleteSceneProfileApi(req, res, url, key)
        return
      }

      // Schedule 管理路由
      if (pathname === '/api/schedules' && req.method === 'GET') {
        await this.handleListSchedulesApi(req, res, url)
        return
      }

      if (pathname === '/api/schedules' && req.method === 'POST') {
        await this.handleCreateScheduleApi(req, res)
        return
      }

      if (pathname.match(/^\/api\/schedules\/[^/]+\/trigger$/) && req.method === 'POST') {
        const id = decodeURIComponent(pathname.split('/')[3])
        await this.handleTriggerNowApi(req, res, id)
        return
      }

      if (pathname.match(/^\/api\/schedules\/[^/]+$/) && req.method === 'GET') {
        const id = decodeURIComponent(pathname.split('/')[3])
        await this.handleGetScheduleApi(req, res, id)
        return
      }

      if (pathname.match(/^\/api\/schedules\/[^/]+$/) && req.method === 'PATCH') {
        const id = decodeURIComponent(pathname.split('/')[3])
        await this.handleUpdateScheduleApi(req, res, id)
        return
      }

      if (pathname.match(/^\/api\/schedules\/[^/]+$/) && req.method === 'DELETE') {
        const id = decodeURIComponent(pathname.split('/')[3])
        await this.handleDeleteScheduleApi(req, res, id)
        return
      }

      // 临时交互页面反代（/tmp-pages/*）：按需拉起 server 后透明转发，不鉴权（匿名访问）。
      // 页面可用性以 meta.expires_at 为准；server 闲置退出由本入口与 agent 工具双侧复活
      //（spec 2026-07-24-tmp-page-availability-design.md）。
      // 注意：/tmp-pages/ 不以 /api/ 开头，认证拦截本就不触发。_manage 守卫在 handleTmpPageRequest 内。
      if (pathname.startsWith('/tmp-pages/')) {
        const tmpPort = parseInt(process.env.CRABOT_TMP_PAGE_PORT ?? '19099', 10)
        await handleTmpPageRequest(req, res, pathname, {
          serverScriptPath: path.join(CRABOT_HOME, 'crabot-admin', 'builtins', 'skills', 'tmp-page', 'scripts', 'server.cjs'),
          dataDir: getDataRootDir(),
          port: tmpPort,
        })
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
        // SPA cache 策略：hashed assets（/assets/*-<hash>.*）immutable 长 cache；
        // 其他（含 index.html）no-cache 强制 revalidate，避免浏览器 heuristic cache
        // 卡住旧 index.html → 引用旧 hash 资源 → 用户看不到新版。
        const isHashedAsset = /^\/assets\/.+-[A-Za-z0-9_-]{8,}\.[a-z0-9]+$/.test(pathname)
        const cacheControl = isHashedAsset
          ? 'public, max-age=31536000, immutable'
          : 'no-cache, must-revalidate'
        res.writeHead(200, {
          'Content-Type': contentTypes[ext] || 'application/octet-stream',
          'Cache-Control': cacheControl,
        })
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
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-cache, must-revalidate',
      })
      res.end(content)
    } catch {
      res.writeHead(404)
      res.end('Web UI not found. Run "npm run build:web" in crabot-admin to build it.')
    }
  }

  private resolveOnboarder(
    res: ServerResponse,
    implementationId: string | null | undefined,
    methodId: string | null | undefined,
  ): Onboarder | null {
    if (!implementationId || !methodId) {
      sendJson(res, 400, { error: 'implementation_id and method_id are required' })
      return null
    }
    const onboarder = this.onboardingManager.get(implementationId, methodId)
    if (!onboarder) {
      sendJson(res, 404, { error: `onboarder not found: ${implementationId}:${methodId}` })
      return null
    }
    return onboarder
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

    const cred = await readCredentials(this.adminConfig.data_dir)
    if (!cred) {
      res.writeHead(503)
      res.end(JSON.stringify({
        error: AdminErrorCode.SERVER_NOT_INITIALIZED,
        message: 'Admin password not configured. Run `crabot start` once on the terminal.',
      }))
      return
    }

    const ok = await verifyPassword(body.password, cred)
    if (!ok) {
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
      e: cred.token_epoch,
    }
    const token = signJwt(payload, this.jwtSecret)

    const response: LoginResponse = {
      token,
      expires_at: new Date(payload.exp * 1000).toISOString(),
      is_temp: cred.is_temp,
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(response))
  }

  private async handleGetMe(_req: IncomingMessage, res: ServerResponse): Promise<void> {
    // 鉴权已在 dispatcher 拦截（API 前置）；此处只读 credentials.json
    const cred = await readCredentials(this.adminConfig.data_dir)
    if (!cred) {
      res.writeHead(503)
      res.end(JSON.stringify({ error: AdminErrorCode.SERVER_NOT_INITIALIZED }))
      return
    }
    const body: MeResponse = { is_temp: cred.is_temp }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(body))
  }

  private async handleChangePassword(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // 拦截器已校验 JWT；这里再读一次 payload 以判断 sub
    const authHeader = req.headers.authorization
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null
    if (!token) {
      res.writeHead(401)
      res.end(JSON.stringify({ error: 'Unauthorized' }))
      return
    }
    const payload = await verifyJwtWithEpoch(token, this.jwtSecret, this.adminConfig.data_dir)
    if (!payload || payload.sub === 'internal') {
      res.writeHead(403)
      res.end(JSON.stringify({ error: 'Forbidden', message: 'internal-token cannot change human password' }))
      return
    }

    const body = await this.readJsonBody<ChangePasswordRequest>(req)
    if (typeof body.new_password !== 'string' || body.new_password.length < 4) {
      res.writeHead(400)
      res.end(JSON.stringify({
        error: AdminErrorCode.INVALID_PASSWORD,
        message: 'New password must be at least 4 characters.',
      }))
      return
    }

    const cred = await readCredentials(this.adminConfig.data_dir)
    if (!cred) {
      res.writeHead(503)
      res.end(JSON.stringify({ error: AdminErrorCode.SERVER_NOT_INITIALIZED }))
      return
    }

    if (cred.is_temp) {
      if (body.old_password !== undefined) {
        const ok = await verifyPassword(body.old_password, cred)
        if (!ok) {
          res.writeHead(401)
          res.end(JSON.stringify({ error: AdminErrorCode.INVALID_OLD_PASSWORD }))
          return
        }
      }
    } else {
      if (typeof body.old_password !== 'string') {
        res.writeHead(400)
        res.end(JSON.stringify({ error: AdminErrorCode.OLD_PASSWORD_REQUIRED }))
        return
      }
      const ok = await verifyPassword(body.old_password, cred)
      if (!ok) {
        res.writeHead(401)
        res.end(JSON.stringify({ error: AdminErrorCode.INVALID_OLD_PASSWORD }))
        return
      }
    }

    const newCred = await rotateCredentials(cred, body.new_password, 'ui')
    await writeCredentials(this.adminConfig.data_dir, newCred)
    res.writeHead(200)
    res.end(JSON.stringify({}))
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

  private async handleListDialogObjectFriendsApi(res: ServerResponse): Promise<void> {
    const items = projectFriendDialogObjects(this.friends.values())
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ items }))
  }

  private async handleListDialogObjectApplicationsApi(res: ServerResponse): Promise<void> {
    const items = projectApplicationDialogObjects(this.pendingMessages.values())
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ items }))
  }

  private async handleAssignDialogObjectApplicationFriendApi(
    req: IncomingMessage,
    res: ServerResponse,
    applicationId: string
  ): Promise<void> {
    const body = await this.readJsonBody<{ friend_id: FriendId }>(req)

    try {
      const result = await this.handleAssignDialogObjectApplicationFriend({
        pending_message_id: applicationId,
        friend_id: body.friend_id,
      })
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(result))
    } catch (error) {
      this.writeDialogObjectApplicationActionError(res, error)
    }
  }

  private async handleCreateDialogObjectApplicationFriendApi(
    req: IncomingMessage,
    res: ServerResponse,
    applicationId: string
  ): Promise<void> {
    const body = await this.readJsonBody<{
      display_name: string
      permission_template_id?: string
    }>(req)

    try {
      const result = await this.handleCreateDialogObjectApplicationFriend({
        pending_message_id: applicationId,
        display_name: body.display_name,
        permission_template_id: body.permission_template_id,
      })
      res.writeHead(201, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(result))
    } catch (error) {
      this.writeDialogObjectApplicationActionError(res, error)
    }
  }

  private async handleLinkDialogObjectApplicationMasterApi(
    _req: IncomingMessage,
    res: ServerResponse,
    applicationId: string
  ): Promise<void> {
    try {
      const result = await this.handleLinkDialogObjectApplicationMaster({
        pending_message_id: applicationId,
      })
      res.writeHead(result.created ? 201 : 200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ friend: result.friend }))
    } catch (error) {
      this.writeDialogObjectApplicationActionError(res, error)
    }
  }

  private async handleRejectDialogObjectApplicationApi(
    _req: IncomingMessage,
    res: ServerResponse,
    applicationId: string
  ): Promise<void> {
    try {
      const result = await this.handleRejectDialogObjectApplication({ pending_message_id: applicationId })
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(result))
    } catch (error) {
      this.writeDialogObjectApplicationActionError(res, error)
    }
  }

  private async handleListDialogObjectPrivatePoolApi(res: ServerResponse): Promise<void> {
    const sessions = await this.fetchChannelSessionsForDialogObjects('private')
    const items = projectPrivatePoolDialogObjects({
      friends: this.friends.values(),
      pendingMessages: this.pendingMessages.values(),
      sessions,
      sessionConfigs: this.sessionConfigs,
    })

    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ items }))
  }

  private async handleAssignPrivatePoolFriendApi(
    req: IncomingMessage,
    res: ServerResponse,
    sessionId: string
  ): Promise<void> {
    const body = await this.readJsonBody<{ channel_id: ModuleId; friend_id: FriendId }>(req)

    try {
      const result = await this.handleAssignPrivatePoolFriend({
        session_id: sessionId,
        channel_id: body.channel_id,
        friend_id: body.friend_id,
      })
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(result))
    } catch (error) {
      if (error instanceof Error) {
        if (error.message === 'Friend not found') {
          res.writeHead(404, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: error.message }))
          return
        }
        if (error.message === 'Channel module not found' || error.message === 'Session not found') {
          res.writeHead(404, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: error.message }))
          return
        }
        if (error.message === 'Channel identity already in use') {
          res.writeHead(409, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: AdminErrorCode.CHANNEL_IDENTITY_IN_USE, message: error.message }))
          return
        }
        if (
          error.message === 'Session channel mismatch' ||
          error.message === 'Session is not private' ||
          error.message === 'Private session has no participants' ||
          error.message === 'Private session identity is ambiguous'
        ) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: error.message }))
          return
        }
      }
      throw error
    }
  }

  private async handleCreatePrivatePoolFriendApi(
    req: IncomingMessage,
    res: ServerResponse,
    sessionId: string
  ): Promise<void> {
    const body = await this.readJsonBody<{
      channel_id: ModuleId
      display_name: string
      permission_template_id?: string
    }>(req)

    try {
      const result = await this.handleCreatePrivatePoolFriend({
        session_id: sessionId,
        channel_id: body.channel_id,
        display_name: body.display_name,
        permission_template_id: body.permission_template_id,
      })
      res.writeHead(201, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(result))
    } catch (error) {
      if (error instanceof Error) {
        if (error.message === 'Channel module not found' || error.message === 'Session not found') {
          res.writeHead(404, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: error.message }))
          return
        }
        if (error.message.startsWith('Channel identity already in use')) {
          res.writeHead(409, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: AdminErrorCode.CHANNEL_IDENTITY_IN_USE, message: error.message }))
          return
        }
        if (
          error.message === 'Session channel mismatch' ||
          error.message === 'Session is not private' ||
          error.message === 'Private session has no participants' ||
          error.message === 'Private session identity is ambiguous'
        ) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: error.message }))
          return
        }
      }
      throw error
    }
  }

  private async handleListDialogObjectGroupsApi(res: ServerResponse): Promise<void> {
    const sessions = await this.fetchChannelSessionsForDialogObjects('group')
    const channelPlatforms = new Map<string, string>()
    for (const inst of this.channelManager.listInstances({ page: 1, page_size: Number.MAX_SAFE_INTEGER }).items) {
      channelPlatforms.set(inst.id, inst.platform)
    }
    const items = projectGroupDialogObjects({
      friends: this.friends.values(),
      sessions,
      sessionConfigs: this.sessionConfigs,
      channelPlatforms,
    })

    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ items }))
  }

  /**
   * 手动触发 channel 的 backfill_history RPC 把指定群历史拉到本地。
   * body 需要带 channel_id 才能定位到正确的 channel module；可选 max_count / after / before。
   */
  private async handleBackfillGroupHistoryApi(
    req: IncomingMessage,
    res: ServerResponse,
    sessionId: string,
  ): Promise<void> {
    const body = await this.readJsonBody<{
      channel_id?: string
      max_count?: number
      after?: string
      before?: string
    }>(req)
    const channelId = body.channel_id?.trim()
    if (!channelId) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'channel_id is required' }))
      return
    }

    try {
      const modules = await this.rpcClient.resolve(
        { module_id: channelId },
        this.config.moduleId,
      )
      if (modules.length === 0) {
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: `Channel module not resolvable: ${channelId}` }))
        return
      }

      const channelPort = modules[0].port
      const result = await this.rpcClient.call<
        { session_id: string; max_count?: number; after?: string; before?: string },
        {
          session_id: string
          backfilled_count: number
          skipped_count: number
          has_more: boolean
          oldest_ts?: string
          newest_ts?: string
        }
      >(
        channelPort,
        'backfill_history',
        {
          session_id: sessionId,
          ...(body.max_count !== undefined ? { max_count: body.max_count } : {}),
          ...(body.after ? { after: body.after } : {}),
          ...(body.before ? { before: body.before } : {}),
        },
        this.config.moduleId,
      )

      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(result))
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      res.writeHead(502, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: message }))
    }
  }

  private async fetchChannelSessionsForDialogObjects(
    type: DialogObjectChannelSession['type']
  ): Promise<DialogObjectChannelSession[]> {
    const channelInstances = this.channelManager.listInstances({
      page: 1,
      page_size: Number.MAX_SAFE_INTEGER,
    }).items

    return collectDialogObjectChannelSessions({
      channels: channelInstances,
      type,
      fetchPage: async (instance, page, pageSize, sessionType) => {
        const modules = await this.rpcClient.resolve(
          { module_id: instance.id },
          this.config.moduleId
        )

        if (modules.length === 0) {
          throw new Error(`Channel instance not resolvable: ${instance.id}`)
        }

        const channelPort = modules[0].port
        return this.rpcClient.call<
          {
            type: DialogObjectChannelSession['type']
            pagination: { page: number; page_size: number }
            hydrate_participant_user_ids?: string[]
          },
          {
            items: DialogObjectChannelSession[]
            pagination: {
              page: number
              page_size: number
              total_items: number
              total_pages: number
            }
          }
        >(
          channelPort,
          'get_sessions',
          {
            type: sessionType,
            pagination: { page, page_size: pageSize },
            ...(instance.platform === 'telegram' && sessionType === 'group'
              ? {
                  hydrate_participant_user_ids: this.getMasterPlatformUserIdsForChannel(instance.id),
                }
              : {}),
          },
          this.config.moduleId
        )
      },
      onError: (instance, error) => {
        const message = error instanceof Error ? error.message : String(error)
        console.warn(`[Admin] Dialog object session fetch skipped for ${instance.id}: ${message}`)
      },
    })
  }

  private getMasterPlatformUserIdsForChannel(channelId: ModuleId): string[] {
    return Array.from(this.friends.values())
      .filter((friend) => friend.permission === 'master')
      .flatMap((friend) =>
        friend.channel_identities
          .filter((identity) => identity.channel_id === channelId)
          .map((identity) => identity.platform_user_id)
      )
  }

  private async handleAssignPrivatePoolFriend(params: {
    session_id: string
    channel_id: ModuleId
    friend_id: FriendId
  }): Promise<{ friend: Friend }> {
    const channelIdentity = await this.resolveChannelIdentityFromPrivateSession(params.channel_id, params.session_id)
    const result = await this.handleLinkChannelIdentity({
      friend_id: params.friend_id,
      channel_identity: channelIdentity,
    })
    await this.removePendingMessagesForChannelIdentity(channelIdentity)
    return result
  }

  private async handleCreatePrivatePoolFriend(params: {
    session_id: string
    channel_id: ModuleId
    display_name: string
    permission_template_id?: string
  }): Promise<{ friend: Friend }> {
    const channelIdentity = await this.resolveChannelIdentityFromPrivateSession(params.channel_id, params.session_id)
    const result = this.handleCreateFriend({
      display_name: params.display_name,
      permission: 'normal',
      permission_template_id: params.permission_template_id,
      channel_identities: [channelIdentity],
    })
    await this.removePendingMessagesForChannelIdentity(channelIdentity)
    await this.saveData()
    return result
  }

  private async handleAssignDialogObjectApplicationFriend(params: {
    pending_message_id: string
    friend_id: FriendId
  }): Promise<{ friend: Friend }> {
    const message = this.getPendingMessageOrThrow(params.pending_message_id)
    if (message.intent !== 'apply') {
      throw new Error('Application intent mismatch')
    }

    const channelIdentity = this.getChannelIdentityFromPendingMessage(message)
    const result = await this.handleLinkChannelIdentity({
      friend_id: params.friend_id,
      channel_identity: channelIdentity,
    })
    await this.removePendingMessagesForChannelIdentity(channelIdentity)
    return result
  }

  private async handleCreateDialogObjectApplicationFriend(params: {
    pending_message_id: string
    display_name: string
    permission_template_id?: string
  }): Promise<{ friend: Friend }> {
    const message = this.getPendingMessageOrThrow(params.pending_message_id)
    if (message.intent !== 'apply') {
      throw new Error('Application intent mismatch')
    }

    const channelIdentity = this.getChannelIdentityFromPendingMessage(message)
    const result = this.handleCreateFriend({
      display_name: params.display_name,
      permission: 'normal',
      permission_template_id: params.permission_template_id,
      channel_identities: [channelIdentity],
    })
    await this.removePendingMessagesForChannelIdentity(channelIdentity)
    await this.saveData()
    return result
  }

  private async handleLinkDialogObjectApplicationMaster(params: {
    pending_message_id: string
  }): Promise<{ friend: Friend; created: boolean }> {
    const message = this.getPendingMessageOrThrow(params.pending_message_id)
    if (message.intent !== 'pair') {
      throw new Error('Application intent mismatch')
    }

    const channelIdentity = this.getChannelIdentityFromPendingMessage(message)
    const existingMaster = this.findMasterFriend()

    const result = existingMaster
      ? await this.handleLinkChannelIdentity({
          friend_id: existingMaster.id,
          channel_identity: channelIdentity,
        })
      : this.handleCreateFriend({
          display_name: message.platform_display_name,
          permission: 'master',
          channel_identities: [channelIdentity],
        })

    await this.removePendingMessagesForChannelIdentity(channelIdentity)

    return { friend: result.friend, created: !existingMaster }
  }

  private async handleRejectDialogObjectApplication(params: {
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

  private async resolveChannelSession(
    channelId: ModuleId,
    sessionId: string,
    hydrateParticipantUserIds?: string[]
  ): Promise<{
    id: string
    channel_id: ModuleId
    type: 'private' | 'group'
    platform_session_id?: string
    title: string
    participants: Array<{ friend_id?: FriendId; platform_user_id: string; role: 'owner' | 'admin' | 'member' }>
  }> {
    const modules = await this.rpcClient.resolve(
      { module_id: channelId },
      this.config.moduleId
    )
    if (modules.length === 0) {
      throw new Error('Channel module not found')
    }

    const result = await this.rpcClient.call<
      { session_id: string; hydrate_participant_user_ids?: string[] },
      {
        session: {
          id: string
          channel_id: ModuleId
          type: 'private' | 'group'
          platform_session_id?: string
          title: string
          participants: Array<{ friend_id?: FriendId; platform_user_id: string; role: 'owner' | 'admin' | 'member' }>
        }
      }
    >(
      modules[0].port,
      'get_session',
      {
        session_id: sessionId,
        ...(hydrateParticipantUserIds && hydrateParticipantUserIds.length > 0
          ? { hydrate_participant_user_ids: hydrateParticipantUserIds }
          : {}),
      },
      this.config.moduleId
    )

    return result.session
  }

  private async listChannelSessions(channelId: ModuleId): Promise<Array<{
    id: string
    channel_id: ModuleId
    type: 'private' | 'group'
    platform_session_id: string
    title: string
  }>> {
    const modules = await this.rpcClient.resolve(
      { module_id: channelId },
      this.config.moduleId
    )
    if (modules.length === 0) {
      throw new Error('Channel module not found')
    }

    type ChannelSessionListResult = {
      items: Array<{
        id: string
        channel_id: ModuleId
        type: 'private' | 'group'
        platform_session_id: string
        title: string
      }>
      pagination: { page: number; page_size: number; total_items: number; total_pages: number }
    }

    const pageSize = 500
    const all: Array<{
      id: string
      channel_id: ModuleId
      type: 'private' | 'group'
      platform_session_id: string
      title: string
    }> = []
    let page = 1
    let totalPages = 1

    do {
      const result = await this.rpcClient.call<
        { pagination: { page: number; page_size: number } },
        ChannelSessionListResult
      >(
        modules[0].port,
        'get_sessions',
        { pagination: { page, page_size: pageSize } },
        this.config.moduleId,
      )
      all.push(...result.items)
      totalPages = Math.max(1, result.pagination.total_pages)
      page++
    } while (page <= totalPages)

    return all
  }

  private async resolveChannelIdentityFromPrivateSession(channelId: ModuleId, sessionId: string): Promise<ChannelIdentity> {
    const session = await this.resolveChannelSession(channelId, sessionId)
    if (session.channel_id !== channelId) {
      throw new Error('Session channel mismatch')
    }

    return extractChannelIdentityFromPrivateSession(session)
  }

  private getChannelIdentityFromPendingMessage(message: Pick<PendingMessage, 'channel_id' | 'platform_user_id' | 'platform_display_name'>): ChannelIdentity {
    return {
      channel_id: message.channel_id,
      platform_user_id: message.platform_user_id,
      platform_display_name: message.platform_display_name,
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
    if (params.permission === 'master' && this.findMasterFriend()) {
      throw new Error('A master friend already exists')
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
    const permissionTemplateId = params.permission === 'normal'
      ? (params.permission_template_id ?? 'standard')
      : undefined
    const friend: Friend = {
      id: generateId(),
      display_name: params.display_name,
      permission: params.permission,
      permission_template_id: permissionTemplateId,
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

    const nextPermission = params.permission ?? existing.permission
    const nextPermissionTemplateId = nextPermission === 'master'
      ? undefined
      : (
          params.permission_template_id !== undefined
            ? params.permission_template_id
            : (existing.permission_template_id ?? 'standard')
        )

    const friend: Friend = {
      ...existing,
      ...(params.display_name !== undefined ? { display_name: params.display_name } : {}),
      permission: nextPermission,
      permission_template_id: nextPermissionTemplateId,
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
    this.friendPermissionConfigs.delete(params.friend_id)
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

      return { friend: existing }
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
      const existingMaster = this.findMasterFriend()
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

  private getPendingMessageOrThrow(pendingMessageId: string): PendingMessage {
    const message = this.pendingMessages.get(pendingMessageId)
    if (!message) {
      throw new Error('Pending message not found')
    }
    return message
  }

  private writeDialogObjectApplicationActionError(res: ServerResponse, error: unknown): void {
    if (error instanceof Error) {
      if (error.message === 'Pending message not found') {
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: error.message }))
        return
      }
      if (error.message === 'Friend not found') {
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: error.message }))
        return
      }
      if (error.message === 'Channel module not found' || error.message === 'Session not found') {
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: error.message }))
        return
      }
      if (error.message === 'Channel identity already in use') {
        res.writeHead(409, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: AdminErrorCode.CHANNEL_IDENTITY_IN_USE, message: error.message }))
        return
      }
      if (error.message.startsWith('Channel identity already in use:')) {
        res.writeHead(409, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: AdminErrorCode.CHANNEL_IDENTITY_IN_USE, message: error.message }))
        return
      }
      if (
        error.message === 'Session channel mismatch' ||
        error.message === 'Session is not private' ||
        error.message === 'Private session has no participants' ||
        error.message === 'Private session identity is ambiguous' ||
        error.message === 'Application intent mismatch'
      ) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: error.message }))
        return
      }
    }
    throw error
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
  private async readLegacyAgentPackageEntries(): Promise<Array<{ source_id: string; raw: unknown }>> {
    const directory = path.join(this.adminConfig.data_dir, 'installed-modules')
    try {
      const entries = await fs.readdir(directory, { withFileTypes: true })
      const results: Array<{ source_id: string; raw: unknown }> = []
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name === 'crabot-agent') continue
        const packagePath = path.join(directory, entry.name)
        // 收窄 inventory 范围：cutover 归档只针对 legacy Agent 包。manifest 明确声明
        // 非 agent module_type 的包（如 cutover 后安装的 channel/memory 模块）不得进入
        // 归档/fingerprint——否则任何新安装模块都会让 marker 冲突判断 throw，把
        // admin-web 永久锁在 management-only。无法判定类型的保守保留（维持原退役语义）。
        const moduleType = await this.readInstalledModuleType(packagePath)
        if (moduleType !== undefined && moduleType !== 'agent') continue
        let raw: unknown = { package_id: entry.name, package_path: packagePath }
        for (const manifestName of ['crabot-module.yaml', 'crabot-module.yml', 'package.json']) {
          try {
            const manifest = await fs.readFile(path.join(packagePath, manifestName), 'utf8')
            raw = { package_id: entry.name, package_path: packagePath, manifest_name: manifestName, manifest }
            break
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
          }
        }
        results.push({ source_id: entry.name, raw })
      }
      return results.sort((left, right) => left.source_id.localeCompare(right.source_id))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
  }

  /**
   * 读取已安装模块 manifest 声明的 module_type；无法判定（无 manifest / 解析失败 /
   * 未声明）时返回 undefined，由调用方保守处理。
   */
  private async readInstalledModuleType(packagePath: string): Promise<string | undefined> {
    for (const manifestName of ['crabot-module.yaml', 'crabot-module.yml']) {
      try {
        const manifest = await fs.readFile(path.join(packagePath, manifestName), 'utf8')
        const parsed = yaml.load(manifest)
        if (parsed && typeof parsed === 'object' && typeof (parsed as Record<string, unknown>).module_type === 'string') {
          return (parsed as Record<string, unknown>).module_type as string
        }
        return undefined
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return undefined
      }
    }
    return undefined
  }

  private async readLegacyFrontWorkerConfigSources(): Promise<Array<{ source_id: string; raw: unknown }>> {
    const candidates = ['front-agent-config.json', 'worker-agent-config.json', 'front-worker-config.json']
    const results: Array<{ source_id: string; raw: unknown }> = []
    for (const name of candidates) {
      try {
        results.push({ source_id: name, raw: JSON.parse(await fs.readFile(path.join(this.adminConfig.data_dir, name), 'utf8')) })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    return results
  }

  private assertIngressOpen(): void {
    if (!this.cutoverActivated) throw Object.assign(new Error('Core Agent cutover is incomplete'), { code: 'ADMIN_CORE_AGENT_CUTOVER_INCOMPLETE' })
  }

  private async handleChannelMessage(channelId: ModuleId, message: ChannelMessageRef, crabDisplayName?: string, crabSelfHandle?: string): Promise<void> {
    if (!this.cutoverActivated) {
      console.warn(`[Admin] dropping channel message during management-only cutover: channel=${channelId}, sender=${message.sender.platform_user_id}`)
      return
    }
    const { platform_user_id, platform_display_name } = message.sender
    const friend = this.resolveFriendByChannelIdentity(channelId, platform_user_id)

    console.log(`[Admin] 📩 handleChannelMessage: channel=${channelId}, sender=${platform_user_id} (${platform_display_name}), friend=${friend ? friend.id : 'NOT_FOUND'}, sessionType=${message.session.type}`)

    // 群聊：master 不在场直接丢弃
    if (message.session.type !== 'private') {
      const masterInGroup = await this.checkMasterInSession(channelId, message.session.session_id)
      if (!masterInGroup) {
        console.log(`[Admin] ⚠️ Group message dropped: no master in session ${message.session.session_id} on channel ${channelId}`)
        return
      }
    }

    // system_event（如群成员加入）由 channel 模块包装成 ChannelMessage 推过来：
    // 走 master friend 视角的 publishMessageAuthorized，让 agent dispatcher 按场景画像决定要不要回应。
    // 见 base-protocol.md §5.4 system_event 和
    // crabot-docs/superpowers/specs/2026-06-02-channel-system-event-design.md
    if (message.content.type === 'system_event') {
      const master = this.findMasterFriend()
      if (!master) {
        console.log(`[Admin] ⚠️ system_event dropped (no master claimed): channel=${channelId}, session=${message.session.session_id}`)
        return
      }
      const authorizedMessage: ChannelMessageRef = {
        ...message,
        sender: { ...message.sender, friend_id: master.id },
      }
      await this.publishMessageAuthorizedEvent(channelId, authorizedMessage, master, crabDisplayName, crabSelfHandle)
      return
    }

    // 认主类指令在 admin 层完整处理：不放行到 agent，避免 agent 看到指令字面后鹦鹉学舌。
    // 已知 friend 发命令属于无意义/误触，回固定话术；未知发信人按现有 pending 队列流程。
    // 用 normalizeSlash 而非裸 trim：IM/复制粘贴常在 slash 词尾带零宽字符，
    // 裸 trim 去不掉，会让 "/认主" 精确匹配失败、漏到 dispatcher 触发无谓 LLM 调用。
    const body = normalizeSlash(message.content.text ?? '')
    if (CLAIM_COMMANDS.has(body)) {
      if (message.session.type !== 'private') {
        // 群聊里发命令现在没有特别语义，直接静默丢弃
        console.log(`[Admin] ⚠️ Claim command in group session dropped: ${body} from ${platform_user_id} on ${channelId}`)
        return
      }
      if (friend) {
        console.log(`[Admin] ⚠️ Claim command from known friend ${friend.id} (${platform_user_id}) intercepted; replying with already-claimed hint`)
        await this.replyClaimHint(channelId, message.session.session_id, platform_user_id, ALREADY_CLAIMED_HINT_TEXT)
        return
      }
      const intent: 'pair' | 'apply' = CLAIM_PAIR_COMMANDS.has(body) ? 'pair' : 'apply'
      await this.handleUpsertPendingMessage({
        channel_id: channelId,
        platform_user_id,
        platform_display_name,
        content_preview: body,
        intent,
        raw_message: message,
      })
      console.log(`[Admin] Upserted pending message (${intent}) for unknown sender: ${platform_user_id} (${platform_display_name})`)
      return
    }

    // === Goal slash 拦截（master 触发，私聊 + 群聊均支持） ===
    // 仅已认主 master friend 可触发；其他人发同样字面视为普通消息走 dispatcher（默认下面的 publish 路径）
    // 群聊里 slash 不拦截会被 attentionScheduler buffer 后 join 成普通文本，导致 dispatcher 无法确定性匹配
    if (friend?.permission === 'master') {
      if (body.startsWith(GOAL_SHOW_PREFIX)) {
        await this.handleGoalShowSlash(channelId, message, body)
        return
      }
      if (body.startsWith(GOAL_CLEAR_PREFIX)) {
        await this.handleGoalClearSlash(channelId, message, body)
        return
      }
      if (body === GOAL_LIST_EXACT) {
        await this.handleGoalListSlash(channelId, message)
        return
      }
      if (body === GOAL_SHOW_BARE || body === GOAL_CLEAR_BARE) {
        await this.handleGoalSlashMissingId(channelId, message, body)
        return
      }
    }

    if (friend) {
      // 已知 Friend：填充 friend_id，发出授权事件
      const authorizedMessage: ChannelMessageRef = {
        ...message,
        sender: {
          ...message.sender,
          friend_id: friend.id,
        },
      }
      await this.publishMessageAuthorizedEvent(channelId, authorizedMessage, friend, crabDisplayName, crabSelfHandle)
      return
    }

    // 未知发信人
    if (message.session.type !== 'private') {
      const guestFriend: Friend = {
        id: `guest:${channelId}:${platform_user_id}` as FriendId,
        display_name: platform_display_name || platform_user_id,
        permission: 'normal',
        channel_identities: [{ channel_id: channelId, platform_user_id, platform_display_name: platform_display_name || platform_user_id }],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }
      await this.publishMessageAuthorizedEvent(channelId, message, guestFriend, crabDisplayName, crabSelfHandle)
      return
    }

    // 已认主 channel 上的陌生人静默丢弃，未认主 channel 才回引导话术
    if (this.isChannelClaimed(channelId)) {
      console.log(`[Admin] ⚠️ Private message from unknown sender dropped (channel already claimed): ${platform_user_id}, text="${(message.content.text ?? '').slice(0, 30)}"`)
      return
    }
    console.log(`[Admin] ⚠️ Unknown private sender ${platform_user_id} on unclaimed channel; replying with onboarding hint`)
    await this.replyClaimHint(channelId, message.session.session_id, platform_user_id, UNCLAIMED_HINT_TEXT)
  }

  private isChannelClaimed(channelId: ModuleId): boolean {
    return this.getMasterPlatformUserIdsForChannel(channelId).length > 0
  }

  /**
   * 提示话术节流：同一 (channel, sender) 5 分钟内只回一次，避免被人刷消息打爆。
   * 复用一个 map 给 unclaimed / already-claimed 两种话术，因为对单一发信人来说同时
   * 只可能命中其中一种语义。
   */
  private readonly claimHintReplies: Map<string, number> = new Map()
  private static readonly CLAIM_HINT_TTL_MS = 5 * 60 * 1000
  // 防止 Map 无界增长：超过 cap 时按插入顺序删最早项 + 顺手扫一次过期项
  private static readonly CLAIM_HINT_CACHE_MAX = 5000

  private async replyClaimHint(
    channelId: ModuleId,
    sessionId: string,
    platformUserId: string,
    text: string,
  ): Promise<void> {
    const key = `${channelId}:${platformUserId}`
    const now = Date.now()
    const last = this.claimHintReplies.get(key) ?? 0
    if (now - last < AdminModule.CLAIM_HINT_TTL_MS) return
    this.evictStaleClaimHintEntries(now)
    this.claimHintReplies.set(key, now)

    try {
      const modules = await this.rpcClient.resolve({ module_id: channelId }, this.config.moduleId)
      if (modules.length === 0) {
        console.warn(`[Admin] replyClaimHint: channel module ${channelId} not resolvable`)
        return
      }
      await this.rpcClient.call(
        modules[0].port,
        'send_message',
        {
          session_id: sessionId,
          content: { type: 'text', text },
        },
        this.config.moduleId,
      )
    } catch (err) {
      console.warn(`[Admin] replyClaimHint failed for ${channelId}/${platformUserId}:`, err)
    }
  }

  private evictStaleClaimHintEntries(now: number): void {
    const map = this.claimHintReplies
    if (map.size < AdminModule.CLAIM_HINT_CACHE_MAX) return
    for (const [k, ts] of map) {
      if (now - ts >= AdminModule.CLAIM_HINT_TTL_MS) map.delete(k)
    }
    while (map.size >= AdminModule.CLAIM_HINT_CACHE_MAX) {
      const oldest = map.keys().next().value
      if (oldest === undefined) break
      map.delete(oldest)
    }
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

  private async checkMasterInSession(channelId: ModuleId, sessionId: string): Promise<boolean> {
    try {
      const session = await this.resolveChannelSession(
        channelId,
        sessionId,
        this.getMasterPlatformUserIdsForChannel(channelId)
      )
      if (session.type === 'private') {
        return true
      }
      return sessionHasMasterParticipant(session, this.friends.values())
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.warn(`[Admin] Failed to resolve session-level master gate for ${channelId}/${sessionId}: ${message}`)
      return false
    }
  }

  /**
   * 发布 channel.message_authorized 事件
   */
  private async publishMessageAuthorizedEvent(
    channelId: ModuleId,
    message: ChannelMessageRef,
    friend: Friend,
    crabDisplayName?: string,
    crabSelfHandle?: string
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
        ...(crabSelfHandle !== undefined ? { crab_self_handle: crabSelfHandle } : {}),
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

  private async removePendingMessagesForChannelIdentity(identity: ChannelIdentity): Promise<void> {
    let removed = false

    for (const [messageId, message] of this.pendingMessages.entries()) {
      if (message.channel_id === identity.channel_id && message.platform_user_id === identity.platform_user_id) {
        this.pendingMessages.delete(messageId)
        removed = true
      }
    }

    if (removed) {
      await this.saveData()
    }
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
      this.permissionTemplateManager.loadFromArray(templatesArray)
      console.log(`[Admin] Loaded ${this.permissionTemplateManager.size} permission templates`)
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

    try {
      const sessionConfigsData = await fs.readFile(this.sessionConfigsFilePath, 'utf-8')
      const entries = JSON.parse(sessionConfigsData) as Array<{ session_id: string; config: SessionPermissionConfig }>
      for (const entry of entries) {
        this.sessionConfigs.set(entry.session_id, entry.config)
      }
      console.log(`[Admin] Loaded ${this.sessionConfigs.size} session configs`)
    } catch {
      console.log('[Admin] No existing session configs data')
    }

    try {
      const friendPermissionConfigsData = await fs.readFile(this.friendPermissionConfigsFilePath, 'utf-8')
      const entries = JSON.parse(friendPermissionConfigsData) as Array<{ friend_id: FriendId; config: FriendPermissionConfig }>
      for (const entry of entries) {
        const friend = this.friends.get(entry.friend_id)
        if (!friend) {
          continue
        }
        this.friendPermissionConfigs.set(
          entry.friend_id,
          this.normalizeFriendPermissionConfig(friend, entry.config)
        )
      }
      console.log(`[Admin] Loaded ${this.friendPermissionConfigs.size} friend permission configs`)
    } catch {
      console.log('[Admin] No existing friend permission configs data')
    }

    try {
      const schedulesData = await fs.readFile(this.schedulesFilePath, 'utf-8')
      const schedulesArray = JSON.parse(schedulesData) as Schedule[]
      for (const schedule of schedulesArray) {
        this.schedules.set(schedule.id, schedule)
      }
      console.log(`[Admin] Loaded ${this.schedules.size} schedules`)

      // 一次性迁移 legacy task_template.input.target_* → target_session（幂等，跑失败 no-op）
      await this.runScheduleMigration()
    } catch {
      console.log('[Admin] No existing schedules data')
    }

    // Legacy Admin tasks are no longer executable in v3. Any persisted non-terminal
    // entry is historical state from the retired AgentHandler loop and must be
    // finalized locally instead of being resumed through a second truth source.
    try {
      const tasksData = await fs.readFile(this.tasksFilePath, 'utf-8')
      const loaded = JSON.parse(tasksData) as Task[]

      // 修正历史脏数据，并把已退役 legacy loop 的非终态记录本地收口为 failed。
      let repairCount = 0
      let retiredInflightCount = 0
      const legacyActiveStatuses: ReadonlySet<TaskStatus> = new Set([
        'pending', 'planning', 'executing', 'waiting_human', 'waiting',
      ])
      const repairedTasks = loaded.map((t) => {
        const { task: repaired, fixes } = repairTaskInvariants(t)
        if (fixes.length > 0) {
          repairCount++
          console.warn(`[Admin] Repaired task ${t.id} on load: fixed ${fixes.join(', ')}`)
        }
        if (!legacyActiveStatuses.has(repaired.status)) return repaired
        retiredInflightCount++
        return applyDerivedFields(repaired, 'failed', generateTimestamp(), {
          error: 'legacy Admin task execution retired in Agent v3',
        })
      })

      // 兜底：所有 task 必须满足不变量。修不掉的说明 repair 实现有漏洞或磁盘数据
      // 异常严重（如 status=waiting_human 但 waiting_human_at 缺失，无法凭空回填），
      // 此时立刻抛错暴露问题，比起静默运行更安全
      for (const t of repairedTasks) {
        assertTaskInvariants(t)
        this.tasks.set(t.id, t)
      }

      console.log(
        `[Admin] Loaded ${this.tasks.size} tasks` +
        (repairCount > 0 ? `, repaired ${repairCount} legacy dirty task(s)` : '') +
        (retiredInflightCount > 0 ? `, failed ${retiredInflightCount} retired in-flight task(s)` : ''),
      )
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
        console.log('[Admin] No existing tasks data')
      } else {
        throw err  // assert 抛错或其他读取异常，不能静默
      }
    }
  }

  /**
   * 一次性迁移历史 schedule：把 task_template.input.target_channel_id / target_session_id
   * 提升为顶层 target_session 字段（Task 10 引入）。
   *
   * 幂等：已迁移过的 schedule 直接跳过；session.type 查不到时保留 input.target_* 兜底，
   * 下次启动重试。
   *
   * 注意：本方法在 loadData 内调用，此时 RPC client 已就绪但 channel 模块可能还未启动。
   * 失败 schedule 会保留 input.target_* 字段，等下次启动（channel 起来后）补迁移。
   */
  private async runScheduleMigration(): Promise<void> {
    const sessionTypeLookup: SessionTypeLookup = async (channelId, sessionId) => {
      try {
        const session = await this.resolveChannelSession(channelId as ModuleId, sessionId)
        return session.type
      } catch {
        return undefined
      }
    }

    let migratedCount = 0
    for (const schedule of Array.from(this.schedules.values())) {
      const migrated = await migrateScheduleTargetSession(schedule, sessionTypeLookup)
      const repaired = await this.repairScheduleTargetSessionReference(migrated)
      if (repaired !== schedule) {
        this.schedules.set(repaired.id, repaired)
        migratedCount++
      }
    }
    if (migratedCount > 0) {
      const schedulesArray = Array.from(this.schedules.values())
      await this.atomicWriteFile(
        this.schedulesFilePath,
        JSON.stringify(schedulesArray, null, 2),
      )
      console.log(
        `[Admin] Migrated ${migratedCount} schedule(s) to target_session field`,
      )
    }
  }

  private async repairScheduleTargetSessionReference(schedule: Schedule): Promise<Schedule> {
    const targetSessionLookup: TargetSessionRepairLookup = async (channelId, sessionId, platformSessionId, scheduleForLookup) => {
      const expectedType = scheduleForLookup?.target_session?.type
      if (platformSessionId && expectedType) {
        try {
          const sessions = await this.listChannelSessions(channelId as ModuleId)
          const match = sessions.find(
            (s) => s.platform_session_id === platformSessionId && s.type === expectedType,
          )
          if (match) {
            return {
              session_id: match.id,
              platform_session_id: match.platform_session_id,
              type: match.type,
            }
          }
          return undefined
        } catch {
          return undefined
        }
      }

      try {
        const session = await this.resolveChannelSession(channelId as ModuleId, sessionId)
        return {
          session_id: session.id,
          type: session.type,
          ...(session.platform_session_id ? { platform_session_id: session.platform_session_id } : {}),
        }
      } catch {
        return undefined
      }
    }

    return repairScheduleTargetSession(schedule, targetSessionLookup)
  }

  /**
   * 迁移旧 sessionConfig：补齐缺失的 cli_access 字段（快照式，幂等）。
   * 必须在 initSystemTemplates() 之后调用，确保模板已就绪。
   */
  private async runSessionConfigSnapshotMigration(): Promise<void> {
    const total = this.sessionConfigs.size
    let migratedCount = 0
    for (const [sessionId, config] of Array.from(this.sessionConfigs.entries())) {
      const upgraded = snapshotSessionConfig(config, this.permissionTemplateManager)
      if (upgraded !== config) {
        this.sessionConfigs.set(sessionId, upgraded)
        migratedCount++
      }
    }
    console.info(`[migration] snapshot-session-config: migrated ${migratedCount} of ${total} sessionConfigs`)
    if (migratedCount > 0) {
      await this.saveData()
    }
  }

  /**
   * 原子写入文件：先写临时文件，再 rename（避免进程被杀时文件损坏）
   */
  private async atomicWriteFile(filePath: string, content: string): Promise<void> {
    if (!filePath) {
      throw new Error('atomicWriteFile: filePath must be a non-empty string')
    }
    const tempPath = `${filePath}.tmp`
    await fs.writeFile(tempPath, content, 'utf-8')
    await fs.rename(tempPath, filePath)
  }

  private async saveData(): Promise<void> {
    // 关键防御：数据未加载完成时 saveData 会把空 Map 序列化覆盖磁盘真实数据
    // 典型触发场景：SIGINT 在 onStart 早期（loadData 之前）到达 → onStop → saveData
    if (!this.dataLoaded) {
      console.warn('[Admin] saveData skipped: data not loaded yet')
      return
    }

    // 串行化：等待前一个 saveData 完成后再执行，防止并发 atomicWriteFile 在 write(.tmp) + rename 上竞态
    // 竞态现象：两个 saveData 先后 writeFile(friends.json.tmp)，然后先后 rename → 第二个 rename 拿到 ENOENT
    while (this.saveDataLock) {
      await this.saveDataLock
    }

    const promise = this.saveDataImpl()
    this.saveDataLock = promise
    try {
      await promise
    } finally {
      if (this.saveDataLock === promise) {
        this.saveDataLock = null
      }
    }
  }

  /** saveData 的实际实现，由 saveData 串行化调用 */
  private async saveDataImpl(): Promise<void> {
    const friendsArray = Array.from(this.friends.values())
    await this.atomicWriteFile(this.friendsFilePath, JSON.stringify(friendsArray, null, 2))

    const templatesArray = this.permissionTemplateManager.toArray()
    await this.atomicWriteFile(this.templatesFilePath, JSON.stringify(templatesArray, null, 2))

    const pendingArray = Array.from(this.pendingMessages.values())
    await this.atomicWriteFile(this.pendingMessagesFilePath, JSON.stringify(pendingArray, null, 2))

    const sessionConfigsArray = Array.from(this.sessionConfigs.entries()).map(
      ([session_id, config]) => ({ session_id, config })
    )
    await this.atomicWriteFile(this.sessionConfigsFilePath, JSON.stringify(sessionConfigsArray, null, 2))

    const friendPermissionConfigsArray = Array.from(this.friendPermissionConfigs.entries()).map(
      ([friend_id, config]) => ({ friend_id, config })
    )
    await this.atomicWriteFile(this.friendPermissionConfigsFilePath, JSON.stringify(friendPermissionConfigsArray, null, 2))

    const schedulesArray = Array.from(this.schedules.values())
    await this.atomicWriteFile(this.schedulesFilePath, JSON.stringify(schedulesArray, null, 2))

    await this.saveTasks()
  }

  /**
   * 单独的 tasks 落盘——比 saveData 轻得多。
   * 每个 task 变更都调一次（mutation 频率高，不能拖累其它六个文件）。
   */
  private async saveTasks(): Promise<void> {
    if (!this.dataLoaded) return

    // 串行化：等待前一个 saveTasks 完成后再执行——atomicWriteFile 在 write(.tmp) + rename 两步间
    // 不可并发（两个并发 saveTasks 各写 tasks.json.tmp 后 rename，后到的 rename 拿 ENOENT）。
    while (this.saveTasksLock) {
      await this.saveTasksLock
    }

    const promise = this.saveTasksImpl()
    this.saveTasksLock = promise
    try {
      await promise
    } finally {
      if (this.saveTasksLock === promise) {
        this.saveTasksLock = null
      }
    }
  }

  private async saveTasksImpl(): Promise<void> {
    const tasksArray = Array.from(this.tasks.values())
    await this.atomicWriteFile(this.tasksFilePath, JSON.stringify(tasksArray, null, 2))
  }

  /**
   * 写入 task 的统一入口：set + 落盘原子绑定，杜绝"改了内存忘了落盘"。
   * 所有 handler*Task / handle*TaskGoal / handleCancelTask 都走这里。
   *
   * @deprecated **P7 cutover 时删除**（protocol-agent-v3 §7）。v3 把 task 的真相源从 admin 的
   * `tasks.json` 迁到 agent 的台账（`LedgerStore`），admin 退化成只读代理，不再有 task 写路径。
   * 替代者：agent 侧 `LedgerStore` 的写入（由 `WorkerHarness` 的状态迁移驱动）。
   * P5 只加注记、**行为不变**——本阶段 admin 仍是 task 的写真相源。
   */
  private async upsertTask(task: Task): Promise<void> {
    this.tasks.set(task.id, task)
    await this.saveTasks()
  }

  private async initSystemTemplates(): Promise<void> {
    this.permissionTemplateManager.initSystemTemplates()
    await this.saveData()
  }

  // ============================================================================
  // Task 协议方法
  // ============================================================================

  private async handleCreateTask(params: CreateTaskParams): Promise<{ task: Task }> {
    const now = generateTimestamp()
    const taskId = params.id ?? generateId()
    if (params.id && this.tasks.has(params.id)) {
      throw new Error(AdminErrorCode.TASK_ALREADY_EXISTS)
    }
    const initialMessages: TaskMessage[] = params.initial_message
      ? [{
          id: generateId(),
          role: params.initial_message.role ?? 'human',
          content: params.initial_message.content,
          timestamp: now,
          ...(params.initial_message.source ? { source: params.initial_message.source } : {}),
        }]
      : []

    const task: Task = {
      id: taskId,
      status: 'pending',
      priority: params.priority ?? 'normal',
      title: params.title,
      source: params.source,
      worker_agent_id: undefined,
      plan: undefined,
      input: params.input,
      output: undefined,
      error: undefined,
      messages: initialMessages,
      tags: params.tags ?? [],
      created_at: now,
      updated_at: now,
      started_at: undefined,
      completed_at: undefined,
      expires_at: params.expires_at,
    }

    await this.upsertTask(task)

    // 发布事件
    this.publishAdminEvent('admin.task_created', { task })

    return { task }
  }

  /**
   * Trigger a manager-native memory graph rebuild.  This intentionally does not
   * create an Admin Task: the old task lifecycle cannot observe manager-owned
   * workers and would otherwise remain pending forever.
   */
  private async handleRebuildMemoryGraph(): Promise<{ accepted: true }> {
    const description =
      '你必须在当前 manager episode 直接完成长期记忆图谱的覆盖式重建，不要派 worker，也不要调用 Skill（本指令已经内联完整建链规则）：\n'
      + '1) 用 mcp__crab-memory__list_entries({ status: "confirmed", limit, offset }) 翻页遍历全部 confirmed 条目；\n'
      + '2) 对每条 N，用 mcp__crab-memory__search_long_term({ query: <N 的 brief>, filters: { status: "confirmed" }, k: 5 }) 找候选；默认不连，只有具体且有信息量的关系才连；\n'
      + '3) relation 只能是 refines（N 细化候选）、depends_on（N 依赖候选）、part_of（N 是候选的一部分）、related（确有跨条目引用价值时的最后兜底）；严禁仅因同项目/同主题/相似就连，近重复不连，related 对称关系只保留一个方向，不重复 source_cases/invalidated_by 已表达的边；\n'
      + '4) 对每一条 N 都调用 mcp__crab-memory__set_memory_links({ id: <N.id>, links: [...] }) 覆盖完整新列表，无有效关系时必须传 links:[] 以清掉旧边；\n'
      + '5) 完成后报告遍历条目数、清空条目数、新建链接数和 relation 分布。'
    await this.callAgentRpc('trigger_schedule', {
      schedule_id: 'memory-graph-rebuild',
      title: '重建长期记忆图谱',
      description,
      is_builtin: true,
    })
    return { accepted: true }
  }

  private async handleGetTask(params: GetTaskParams): Promise<{ task: Task }> {
    const task = this.tasks.get(params.task_id)
    if (!task) {
      throw new Error(AdminErrorCode.TASK_NOT_FOUND)
    }
    return { task }
  }

  // ============================================================================
  // TaskGoal 协议方法（spec: 2026-05-23-goal-mode-design.md §3）
  // ============================================================================

  private async handleSetTaskGoal(
    params: SetTaskGoalParams,
  ): Promise<SetTaskGoalResult> {
    const task = this.tasks.get(params.task_id)
    if (!task) throw new Error(AdminErrorCode.TASK_NOT_FOUND)
    // 反 specification-gaming 的"active goal 不可自改"锁，已移到 engine 侧 set_task_goal 工具的
    // "改目标券"门控（人类 supplement 到达才发券，worker 无券不能重设）。admin 这里不再硬拒——
    // 它只是唯一调用方（worker 工具）的执行端；终态（blocked/cleared/complete/budget_limited）
    // 重设续作也走这条路。
    // spec: 2026-05-26-goal-audit-loop-completion §2.3
    const now = generateTimestamp()
    const goal = buildNewTaskGoal({
      objective: params.objective,
      acceptance_criteria: params.acceptance_criteria,
      ...(params.token_budget !== undefined ? { token_budget: params.token_budget } : {}),
    }, now)
    task.goal = goal
    task.updated_at = now
    await this.upsertTask(task)
    this.publishAdminEvent('admin.task_updated', { task })
    return { task }
  }

  private async handleAppendTaskGoalAuditEntry(
    params: AppendTaskGoalAuditEntryParams,
  ): Promise<AppendTaskGoalAuditEntryResult> {
    const task = this.tasks.get(params.task_id)
    if (!task) throw new Error(AdminErrorCode.TASK_NOT_FOUND)
    if (!task.goal) throw new Error(`task ${params.task_id} 没有 goal，无法追加 audit 历史`)
    const now = generateTimestamp()
    task.goal = appendAuditEntry(task.goal, params.entry, now)

    // 系统兜底：连续 N 次 audit fail 且 failed_criteria 集合一致 → 自动 transition blocked
    // spec: 2026-05-23-goal-mode-design §2.7 / 2026-05-26-goal-audit-loop-completion §2.2
    if (shouldAutoBlock(task.goal, TASK_GOAL_BLOCKED_THRESHOLD)) {
      task.goal = transitionGoalStatus(task.goal, 'blocked', now)
    }

    task.updated_at = now
    await this.upsertTask(task)
    this.publishAdminEvent('admin.task_updated', { task })
    return { task }
  }

  private async handleIncrementTaskGoalTokens(
    params: IncrementTaskGoalTokensParams,
  ): Promise<IncrementTaskGoalTokensResult> {
    const task = this.tasks.get(params.task_id)
    if (!task) throw new Error(AdminErrorCode.TASK_NOT_FOUND)
    if (!task.goal) return { task } // noop：无 goal 不累加
    const now = generateTimestamp()
    const nextGoal = incrementTokens(task.goal, params.delta, now)
    if (nextGoal === task.goal) {
      // 非 active goal：incrementTokens 返回原 goal 引用，无实际变更，跳过 touch + event
      return { task }
    }
    task.goal = nextGoal
    task.updated_at = now
    await this.upsertTask(task)
    this.publishAdminEvent('admin.task_updated', { task })
    return { task }
  }

  private async handleCompleteTaskGoal(
    params: CompleteTaskGoalParams,
  ): Promise<CompleteTaskGoalResult> {
    const task = this.tasks.get(params.task_id)
    if (!task) throw new Error(AdminErrorCode.TASK_NOT_FOUND)
    if (!task.goal) throw new Error(`task ${params.task_id} 没有 goal，无法 complete`)
    const now = generateTimestamp()
    task.goal = transitionGoalStatus(task.goal, 'complete', now)
    task.updated_at = now
    await this.upsertTask(task)
    this.publishAdminEvent('admin.task_updated', { task })
    return { task }
  }

  private async handleClearTaskGoal(
    params: ClearTaskGoalParams,
  ): Promise<ClearTaskGoalResult> {
    const task = this.tasks.get(params.task_id)
    if (!task) throw new Error(AdminErrorCode.TASK_NOT_FOUND)
    if (!task.goal) {
      // 无 goal 视为幂等成功，不抛错
      return { task }
    }
    if (task.goal.status !== 'active') {
      throw new Error(`task ${params.task_id} 的 goal 当前 status=${task.goal.status}，不可清除`)
    }
    const now = generateTimestamp()
    task.goal = transitionGoalStatus(task.goal, 'cleared', now)
    task.updated_at = now
    await this.upsertTask(task)
    this.publishAdminEvent('admin.task_updated', { task })
    return { task }
  }

  /**
   * `/目标 <task-id>`：显示某 task 的 goal 详情。
   * Spec: 2026-05-25-goal-slash-commands-design.md §4.1 / §5.2
   */
  private async handleGoalShowSlash(
    channelId: ModuleId,
    message: ChannelMessageRef,
    body: string,
  ): Promise<void> {
    const input = body.slice(GOAL_SHOW_PREFIX.length).trim()
    const activeTasks = this.listActiveTasksForChannelSession(
      channelId,
      message.session.session_id,
    )
    let text: string
    if (input.length === 0) {
      text = formatMissingIdResponse('/目标', activeTasks)
    } else {
      const r = resolveTaskByShortIdPrefix(input, activeTasks)
      if (r.kind === 'invalid-input') {
        text = `[系统响应 /目标 ${input}]\n${r.reason}`
      } else if (r.kind === 'not-found') {
        text = formatGoalShowNotFound(input, activeTasks)
      } else if (r.kind === 'ambiguous') {
        text = formatGoalShowNotFound(input, r.candidates)
      } else {
        text = r.task.goal
          ? formatGoalShowResponse(input, r.task)
          : formatGoalShowNoGoal(input, r.task)
      }
    }
    await this.sendSlashResponse(channelId, message.session.session_id, text)
  }

  /**
   * `/清除目标 <task-id>`：清除某 task 的 goal。
   * Spec: 2026-05-25-goal-slash-commands-design.md §4.2 / §5.2
   */
  private async handleGoalClearSlash(
    channelId: ModuleId,
    message: ChannelMessageRef,
    body: string,
  ): Promise<void> {
    const input = body.slice(GOAL_CLEAR_PREFIX.length).trim()
    const activeTasks = this.listActiveTasksForChannelSession(
      channelId,
      message.session.session_id,
    )
    let text: string
    if (input.length === 0) {
      text = formatMissingIdResponse('/清除目标', activeTasks)
    } else {
      const r = resolveTaskByShortIdPrefix(input, activeTasks)
      if (r.kind === 'invalid-input') {
        text = `[系统响应 /清除目标 ${input}]\n${r.reason}`
      } else if (r.kind === 'not-found') {
        text = `[系统响应 /清除目标 ${input}]\n未找到 task ${input}（前缀匹配无果）。`
      } else if (r.kind === 'ambiguous') {
        text = formatGoalClearAmbiguous(input, r.candidates)
      } else if (!r.task.goal) {
        text = `[系统响应 /清除目标 ${input}]\n该 task 没有 goal，无需清除。`
      } else if (r.task.goal.status !== 'active') {
        text = formatGoalClearAlreadyTerminal(input, r.task.goal.status)
      } else {
        try {
          await this.handleClearTaskGoal({ task_id: r.task.id })
          text = formatGoalClearResponse(input, r.task.id)
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          text = `[系统响应 /清除目标 ${input}]\n清除失败：${msg}`
        }
      }
    }
    await this.sendSlashResponse(channelId, message.session.session_id, text)
  }

  /**
   * `/目标列表`：列出当前 channel + session 的 active task。
   * Spec: 2026-05-25-goal-slash-commands-design.md §4.3 / §5.2
   */
  private async handleGoalListSlash(
    channelId: ModuleId,
    message: ChannelMessageRef,
  ): Promise<void> {
    const activeTasks = this.listActiveTasksForChannelSession(
      channelId,
      message.session.session_id,
    )
    const text = formatGoalListResponse(activeTasks)
    await this.sendSlashResponse(channelId, message.session.session_id, text)
  }

  /** `/目标` 或 `/清除目标`（漏 id）的引导话术 */
  private async handleGoalSlashMissingId(
    channelId: ModuleId,
    message: ChannelMessageRef,
    body: string,
  ): Promise<void> {
    const command = body === GOAL_SHOW_BARE ? '/目标' : '/清除目标'
    const activeTasks = this.listActiveTasksForChannelSession(
      channelId,
      message.session.session_id,
    )
    const text = formatMissingIdResponse(command, activeTasks)
    await this.sendSlashResponse(channelId, message.session.session_id, text)
  }

  /**
   * 取"当前 channel + session 的活跃任务清单"——跟 agent dispatcher fetchActiveTasks
   * 同一规则（spec 2026-05-19 §3.2 + protocol-agent-v2.md §5.1）。
   *
   * 过滤规则：
   * - status ∈ {pending, planning, executing, waiting_human}
   * - source.channel_id + source.session_id 完全匹配
   * - 排除 trigger_type='scheduled'
   */
  private listActiveTasksForChannelSession(
    channelId: ModuleId,
    sessionId: string,
  ): Task[] {
    const ACTIVE_STATUSES: ReadonlySet<TaskStatus> = new Set([
      'pending', 'planning', 'executing', 'waiting_human',
    ])
    return Array.from(this.tasks.values()).filter((t) => {
      if (!ACTIVE_STATUSES.has(t.status)) return false
      if (t.source.channel_id !== channelId) return false
      if (t.source.session_id !== sessionId) return false
      if (t.source.trigger_type === 'scheduled') return false
      return true
    })
  }

  /**
   * 通用：发送 [系统响应 ...] 话术给 channel 的 session。
   * 跟 replyClaimHint 的范式一致但不走 5 分钟节流（slash 是 master 主动操作，要立刻响应）。
   */
  private async sendSlashResponse(
    channelId: ModuleId,
    sessionId: string,
    text: string,
  ): Promise<void> {
    try {
      const modules = await this.rpcClient.resolve(
        { module_id: channelId },
        this.config.moduleId,
      )
      if (modules.length === 0) {
        console.warn(`[Admin] sendSlashResponse: channel module ${channelId} not resolvable`)
        return
      }
      await this.rpcClient.call(
        modules[0].port,
        'send_message',
        { session_id: sessionId, content: { type: 'text', text } },
        this.config.moduleId,
      )
    } catch (err) {
      console.warn(`[Admin] sendSlashResponse failed for ${channelId}:`, err)
    }
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
      if (filter.source_session_id) {
        tasks = tasks.filter((t) => t.source.session_id === filter.source_session_id)
      }
      if (filter.source_friend_id) {
        tasks = tasks.filter((t) => t.source.friend_id === filter.source_friend_id)
      }
      if (filter.tags && filter.tags.length > 0) {
        tasks = tasks.filter((t) => filter.tags!.some((tag) => t.tags.includes(tag)))
      }
      if (filter.search) {
        const searchLower = filter.search.toLowerCase()
        // spec 2026-06-09-task-trace-tool-unification.md §4.2:
        // 旧字段 t.description 已删；改匹 title + task.messages[].content
        // （"按聊天细节词查找已结束 task"的命中字段）
        tasks = tasks.filter(
          (t) =>
            t.title.toLowerCase().includes(searchLower) ||
            t.messages.some((m) => m.content.toLowerCase().includes(searchLower))
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
              pending: 0, planning: 1, executing: 2, waiting_human: 3, waiting: 4,
              completed: 5, failed: 6, cancelled: 7
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

  /**
   * 所有 task 状态变更的统一入口。维护派生字段、校验状态机、断言不变量、发布事件。
   *
   * **In-place mutation**：本方法用 `Object.assign(task, applyDerivedFields(task,...))`
   * 把派生字段写回入参 `task`，保留对象引用——`this.tasks.get(id)` 拿到的引用、
   * RPC 返回的 `{ task }` 引用、外层 caller 持有的引用都会同时反映新状态。
   * 不要按 `applyDerivedFields` 的纯函数语义复制一份去做事——会跟内存 Map 失同步。
   *
   * 不持久化（upsertTask 由调用方负责）。不发额外事件（admin.task_cancelled 由
   * cancel 路径自行追发）。
   *
   * 任何直接 mutate task.status 的新代码 = bug。如发现需要绕过本方法的场景，
   * 优先检查是不是 VALID_TRANSITIONS 缺一条；不是的话再考虑加 opt。
   */
  /**
   * @deprecated **P7 cutover 时删除**（protocol-agent-v3 §5.2 / §9.2）。task 状态机在 v3 里
   * 属于 agent 台账，替代者是 `WorkerHarness` 的状态迁移（写台账 + 由 agent 发
   * `agent.task_status_changed`）。本方法体内的 `admin.task_status_changed` 发布点即 v3 要
   * 退役的两处 task 事件发布点之二（另一处在 `handleReviveTaskForSupplement`）。
   * P5 只加注记、**行为不变**。
   */
  private applyStatusTransition(
    task: Task,
    newStatus: TaskStatus,
    opts: {
      error?: string
      pendingQuestion?: string | null
    } = {},
  ): void {
    const oldStatus = task.status
    if (!VALID_TRANSITIONS[oldStatus].includes(newStatus)) {
      // 静默会让 caller（含 bestEffortRpc）吞错——SSOT 重整后约定：所有拒绝必须可见，
      // 否则 drift 会累积。caller 决定要不要重试 / 走 reconciliation 兜底，但本层必须记录。
      console.warn(
        `[Admin] applyStatusTransition rejected: task=${task.id} ${oldStatus} → ${newStatus} not in VALID_TRANSITIONS`
      )
      throw new Error(AdminErrorCode.INVALID_STATUS_TRANSITION)
    }

    const next = applyDerivedFields(task, newStatus, generateTimestamp(), {
      error: opts.error,
      pendingQuestion: opts.pendingQuestion,
    })
    Object.assign(task, next)
    assertTaskInvariants(task)

    this.publishAdminEvent('admin.task_status_changed', {
      task_id: task.id,
      old_status: oldStatus,
      new_status: newStatus,
    })

    // Master Chat 状态卡推送：admin-web 来源任务的所有状态变更都经此咽喉
    if (task.source.channel_id === 'admin-web') {
      this.chatManager?.pushTaskUpdate(buildChatTaskSnapshot(task))
    }
  }

  private async handleUpdateTaskStatus(params: UpdateTaskStatusParams): Promise<{ task: Task }> {
    const task = this.tasks.get(params.task_id)
    if (!task) {
      throw new Error(AdminErrorCode.TASK_NOT_FOUND)
    }

    this.applyStatusTransition(task, params.status, {
      error: params.error,
      pendingQuestion: params.pending_question,
    })

    // 应用层副作用（不属于状态机）
    if (params.result) {
      task.result = params.result
    }

    await this.upsertTask(task)

    // 任务完成时推进关联 Schedule 的 watermark
    if (params.status === 'completed') {
      const scheduleId = task.input?.schedule_id
      if (typeof scheduleId === 'string') {
        const schedule = this.schedules.get(scheduleId)
        if (schedule) {
          // 优先用任务声明的窗口终点（input.ingestion_time_end，触发时渲染的 {{datetime}}）。
          // 用 completed_at 会把任务执行期间 [触发时刻, 完成时刻) 入库的条目
          // 永久排除在后续增量窗口之外。
          const windowEnd = task.input?.ingestion_time_end
          const updated: Schedule = {
            ...schedule,
            watermark: typeof windowEnd === 'string' && windowEnd
              ? windowEnd
              : task.completed_at ?? task.updated_at,
            updated_at: task.updated_at,
          }
          this.schedules.set(scheduleId, updated)
          this.saveData().catch(() => {})
        }
      }
    }

    return { task }
  }

  private async handleUpdateTaskOutcome(params: {
    task_id: TaskId
    outcome_brief?: string
    process_highlights?: string[]
  }): Promise<{ task: Task }> {
    const task = this.tasks.get(params.task_id)
    if (!task) {
      throw new Error(AdminErrorCode.TASK_NOT_FOUND)
    }
    // task.result 必须存在：调用方应当先 update_task_status('completed'|'failed') 写入 outcome+finished_at，
    // 再调本方法 patch outcome_brief/process_highlights。缺失说明调用顺序错了，宁可显式报错也不要静默假设 outcome。
    if (!task.result) {
      throw new Error('update_task_outcome called before task.result was initialized (caller must update_task_status first)')
    }
    task.result = {
      ...task.result,
      ...(params.outcome_brief !== undefined ? { outcome_brief: params.outcome_brief } : {}),
      ...(params.process_highlights !== undefined ? { process_highlights: params.process_highlights } : {}),
    }
    task.updated_at = generateTimestamp()
    await this.upsertTask(task)
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

    await this.upsertTask(task)

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

    await this.upsertTask(task)

    // 发布事件
    this.publishAdminEvent('admin.task_plan_updated', {
      task_id: task.id,
      plan: params.plan,
    })

    if (task.source.channel_id === 'admin-web') {
      this.chatManager?.pushTaskUpdate(buildChatTaskSnapshot(task))
    }

    return { task }
  }

  private async handleAppendMessage(params: AppendMessageParams): Promise<{ message: TaskMessage }> {
    const task = this.tasks.get(params.task_id)
    if (!task) {
      throw new Error(AdminErrorCode.TASK_NOT_FOUND)
    }

    const message: TaskMessage = {
      id: generateId(),
      role: params.role,
      content: params.content,
      timestamp: generateTimestamp(),
      ...(params.source ? { source: params.source } : {}),
      ...(params.agent_intent ? { agent_intent: params.agent_intent } : {}),
    }

    task.messages.push(message)
    task.updated_at = generateTimestamp()

    await this.upsertTask(task)

    // worker 回复消息的任务归属反向回填：agent 出站成功后调本方法记录 task.messages，
    // source.platform_message_id 即聊天 message_id（admin-web 伪 channel send_message 的返回值）
    if (
      task.source.channel_id === 'admin-web' &&
      params.role === 'agent' &&
      params.source?.platform_message_id
    ) {
      this.chatManager?.tagMessageTask(params.source.platform_message_id, task.id).catch(() => {})
    }

    return { message }
  }

  private async handleGetTaskMessages(params: GetTaskMessagesParams): Promise<{ items: TaskMessage[]; pagination: { page: number; page_size: number; total_items: number; total_pages: number } }> {
    const task = this.tasks.get(params.task_id)
    if (!task) {
      throw new Error(AdminErrorCode.TASK_NOT_FOUND)
    }

    let messages = [...task.messages]

    // 过滤消息角色
    if (params.role && params.role.length > 0) {
      messages = messages.filter((m) => params.role!.includes(m.role))
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
        waiting: 0,
        completed: 0,
        failed: 0,
        cancelled: 0,
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
      stats.by_priority[task.priority]++
    }

    return stats
  }

  /**
   * spec §4.4: 按 task 个数清理。
   *
   * 1. 拉终态 task (status ∈ {completed, failed, cancelled}) + 有 completed_at
   * 2. 按 completed_at 倒序取第 max_count 个的 completed_at 作为 cutoff
   * 3. 删 cutoff 之前的所有 task 持久化条目 + 透传 agent cleanup_old_traces_by_count
   *    （估算 max_count * 3 trace 作为粗略 boundary —— 真正按日期粒度精确清理需要 agent 加新 RPC,
   *    本 Phase 3 用近似版本，等使用反馈再优化）
   * 4. 活跃 task 不计入配额、不删
   */
  private async handleCleanupOldTasksByCount(params: CleanupOldTasksByCountParams): Promise<CleanupOldTasksByCountResult> {
    this.assertIngressOpen()
    const maxCount = params.max_count
    const dryRun = params.dry_run ?? false
    if (!Number.isFinite(maxCount) || maxCount < 1) {
      return { affected_count: 0, affected_bytes: 0, deleted_trace_ids: [] }
    }

    const terminalTasks = Array.from(this.tasks.values())
      .filter((t) => t.status === 'completed' || t.status === 'failed' || t.status === 'cancelled')
      .filter((t) => t.completed_at != null)
      .sort((a, b) => (b.completed_at ?? '').localeCompare(a.completed_at ?? ''))

    if (terminalTasks.length <= maxCount) {
      return { affected_count: 0, affected_bytes: 0, deleted_trace_ids: [] }
    }

    const boundary = terminalTasks[maxCount - 1]
    const cutoff = boundary.completed_at!
    const tasksToDelete = terminalTasks.filter((t) => (t.completed_at ?? '') < cutoff)

    // P6-A §9.6：agent 侧 cleanup_old_traces_by_count 已退役；本方法只做本地 task 持久化清理。
    if (!dryRun) {
      for (const t of tasksToDelete) {
        this.tasks.delete(t.id)
      }
      await this.saveTasks()
    }

    return {
      affected_count: tasksToDelete.length,
      affected_bytes: 0,
      deleted_trace_ids: [],
    }
  }

  async runWaitingHumanTimeoutScan(): Promise<void> {
    const now = Date.now()
    const expiredTasks: Task[] = []
    for (const task of this.tasks.values()) {
      if (task.status !== 'waiting_human') continue
      if (!task.waiting_human_at) continue  // 防御：若字段缺失跳过
      const waitingAt = new Date(task.waiting_human_at).getTime()
      if (now - waitingAt < AdminModule.WAITING_HUMAN_TIMEOUT_MS) continue
      expiredTasks.push(task)
    }

    for (const task of expiredTasks) {
      // Legacy Admin task 只在本地归档中落 failed；v3 没有可按该 task id 叫停的 Agent worker。
      // 人类事后回复由 manager/ledger 新路径处理，不再复活旧 ResumeCheckpoint loop。
      try {
        await this.handleUpdateTaskStatus({
          task_id: task.id,
          status: 'failed',
          error: '超时未收到人类回复（24h），任务自动失败',
        })
      } catch (err) {
        console.error(`[Admin] Failed to timeout task ${task.id}:`, err)
      }
    }
  }

  /**
   * 永久删除 task（spec 2026-06-09 §4.3 后续 — UI 清理"测试消息"堆积的辅助 RPC）。
   *
   * 仅允许删除终态归档记录；活跃 task（pending/planning/executing/waiting_human/waiting）拒绝删。
   * legacy Admin task cancellation RPC 已退役，不再通过 Admin task id 控制 Agent worker。
   *
   * agent 侧的 trace 数据不受影响（仍在 traces-*.jsonl）；要清 trace 走 cleanup_old_tasks_by_count。
   */
  private async handleDeleteTask(params: { task_id: string }): Promise<{ deleted: boolean }> {
    const task = this.tasks.get(params.task_id)
    if (!task) {
      throw new Error(AdminErrorCode.TASK_NOT_FOUND)
    }
    const isActive = task.status === 'pending' || task.status === 'planning'
      || task.status === 'executing' || task.status === 'waiting_human' || task.status === 'waiting'
    if (isActive) {
      throw new Error('TASK_STILL_ACTIVE: 活跃 task 不能直接删除，请等待其进入终态')
    }
    this.tasks.delete(params.task_id)
    await this.saveTasks()
    // 不 publish admin.task_deleted 事件 —— 该事件不在 AdminEventPayloads enum；
    // 订阅者无人监听 task 删除（cancelTask 也只发 admin.task_cancelled）。
    return { deleted: true }
  }

  // ============================================================================
  // Schedule 协议方法
  // ============================================================================

  /**
   * 校验 target_session 字段。
   *
   * 当前只做轻量校验：
   * - channel_id / session_id 非空
   * - type 必须是 'private' | 'group'
   *
   * channel 注册存在性 / channel 侧 session 存在性 / type 一致性 校验延后（follow-up）。
   * 因为 schedule 可能在 channel 还未启动时创建（先配后用），过严校验会阻塞合法场景。
   */
  private validateTargetSession(target: ScheduleTargetSession): void {
    if (!target.channel_id || typeof target.channel_id !== 'string') {
      throw new Error('target_session.channel_id is required and must be a non-empty string')
    }
    if (!target.session_id || typeof target.session_id !== 'string') {
      throw new Error('target_session.session_id is required and must be a non-empty string')
    }
    if (target.type !== 'private' && target.type !== 'group') {
      throw new Error(`target_session.type must be 'private' or 'group', got: ${String(target.type)}`)
    }
  }

  private async handleCreateSchedule(params: CreateScheduleParams): Promise<{ schedule: Schedule }> {
    this.assertIngressOpen()
    // 验证 cron 表达式
    if (params.trigger.type === 'cron') {
      if (!this.isValidCronExpression(params.trigger.expression)) {
        throw new Error(AdminErrorCode.INVALID_CRON_EXPRESSION)
      }
    }

    // 验证 once 触发时间
    if (params.trigger.type === 'once') {
      const ts = new Date(params.trigger.execute_at).getTime()
      if (Number.isNaN(ts)) {
        throw new Error(`Invalid execute_at: "${params.trigger.execute_at}" is not a valid ISO 8601 date`)
      }
    }

    // 校验 creator_friend_id：传了就必须能解析到 friend；不传按系统级处理（触发时最高权限）。
    if (params.creator_friend_id !== undefined && !this.friends.has(params.creator_friend_id)) {
      throw new Error(`creator_friend_id ${params.creator_friend_id} not found`)
    }

    // 校验 target_session
    if (params.target_session !== undefined) {
      this.validateTargetSession(params.target_session)
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
      creator_friend_id: params.creator_friend_id,
      created_at: now,
      updated_at: now,
      target_session: params.target_session,
    }

    this.schedules.set(schedule.id, schedule)
    this.scheduleEngine.add(schedule)
    await this.saveData()

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
    this.assertIngressOpen()
    const existing = this.schedules.get(params.schedule_id)
    if (!existing) {
      throw new Error(AdminErrorCode.SCHEDULE_NOT_FOUND)
    }

    if (this.isManagedBuiltinSchedule(existing)) {
      const expectedTrigger = this.getManagedBuiltinTrigger(existing.task_template.type!)
      if (params.trigger !== undefined
        && JSON.stringify(params.trigger) !== JSON.stringify(expectedTrigger)) {
        throw new Error('INVALID_PARAMS')
      }
      if (params.task_template !== undefined
        && params.task_template.type !== existing.task_template.type) {
        throw new Error('INVALID_PARAMS')
      }
    }

    if (params.trigger !== undefined) {
      if (params.trigger.type === 'cron' && !this.isValidCronExpression(params.trigger.expression)) {
        throw new Error(AdminErrorCode.INVALID_CRON_EXPRESSION)
      }
    }

    // target_session 三态：undefined 不变 / null 清除 / 对象更新
    let targetSessionPatch: { target_session?: ScheduleTargetSession | undefined } = {}
    if (params.target_session === null) {
      targetSessionPatch = { target_session: undefined }
    } else if (params.target_session !== undefined) {
      this.validateTargetSession(params.target_session)
      targetSessionPatch = { target_session: params.target_session }
    }

    const merged: Schedule = {
      ...existing,
      ...(params.name !== undefined ? { name: params.name } : {}),
      ...(params.description !== undefined ? { description: params.description } : {}),
      ...(params.enabled !== undefined ? { enabled: params.enabled } : {}),
      ...(params.trigger !== undefined ? { trigger: params.trigger } : {}),
      ...(params.task_template !== undefined ? { task_template: params.task_template } : {}),
      ...targetSessionPatch,
      updated_at: generateTimestamp(),
    }
    const schedule: Schedule = {
      ...merged,
      next_trigger_at: this.calculateNextTriggerTime(merged.trigger),
    }

    this.schedules.set(schedule.id, schedule)

    // 同步调度引擎
    if (params.enabled !== undefined && params.enabled !== existing.enabled) {
      if (params.enabled) {
        this.scheduleEngine.enable(schedule.id, schedule)
      } else {
        this.scheduleEngine.disable(schedule.id)
      }
    } else {
      this.scheduleEngine.update(schedule.id, schedule)
    }

    await this.saveData()

    // 发布事件
    this.publishAdminEvent('admin.schedule_updated', { schedule })

    return { schedule }
  }

  private async handleDeleteSchedule(params: DeleteScheduleParams): Promise<{ deleted: true }> {
    this.assertIngressOpen()
    const schedule = this.schedules.get(params.schedule_id)
    if (!schedule) {
      throw new Error(AdminErrorCode.SCHEDULE_NOT_FOUND)
    }

    if (schedule.is_builtin) {
      throw new Error('Cannot delete builtin schedule. Use update to disable it instead.')
    }

    this.scheduleEngine.remove(params.schedule_id)
    this.schedules.delete(params.schedule_id)
    await this.saveData()

    // 发布事件
    this.publishAdminEvent('admin.schedule_deleted', { schedule_id: params.schedule_id })

    return { deleted: true }
  }

  /**
   * 立即触发。普通 Schedule 的 `trigger_schedule` 仍是 manager fire-and-forget；
   * builtin memory_maintenance 由 Agent 先持久化 system task，再返回 task_id。
   */
  private async handleTriggerNow(params: TriggerNowParams): Promise<{
    accepted: true
    schedule: Schedule
    task_id?: string
  }> {
    const schedule = this.schedules.get(params.schedule_id)
    if (!schedule) {
      throw new Error(AdminErrorCode.SCHEDULE_NOT_FOUND)
    }

    // 走统一触发链路（RPC → Agent trigger_schedule）
    const result = await this.handleScheduleTrigger(schedule)
    if (!result) {
      throw new Error('Schedule trigger failed: Agent not available or RPC error')
    }

    // 从 Map 中取最新状态（handleScheduleTrigger 已更新）
    const updatedSchedule = this.schedules.get(params.schedule_id) ?? schedule

    return {
      accepted: true,
      schedule: updatedSchedule,
      ...(result.task_id ? { task_id: result.task_id } : {}),
    }
  }

  // ============================================================================
  // Schedule 触发回调
  // ============================================================================

  /**
   * ScheduleEngine 到点时调用的回调
   * 替换模板变量 → RPC 调 Agent `trigger_schedule` → 更新 Schedule 状态
   *
   * **P7/J cutover**：普通 Schedule 从 `create_task_from_schedule` 切到
   * `trigger_schedule` 后仍只唤醒 manager，不产生同步 task_id。唯一例外是
   * `is_builtin=true && task_template.type=memory_maintenance`：Admin 透传既有模板
   * 元数据，由 Agent 先持久化 system task，再直接执行 Memory maintenance。
   */
  private async handleScheduleTrigger(schedule: Schedule): Promise<{
    accepted: true
    task_id?: string
  } | void> {
    this.assertIngressOpen()
    const repairedSchedule = await this.repairScheduleTargetSessionReference(schedule)
    if (repairedSchedule !== schedule) {
      this.schedules.set(repairedSchedule.id, repairedSchedule)
      schedule = repairedSchedule
    }

    const now = new Date()

    // 替换模板变量
    const replaceVars = (text: string): string =>
      text
        .replace(/\{\{date\}\}/g, now.toISOString().slice(0, 10))
        .replace(/\{\{time\}\}/g, now.toTimeString().slice(0, 8))
        .replace(/\{\{datetime\}\}/g, now.toISOString())
        .replace(/\{\{schedule_name\}\}/g, schedule.name)
        .replace(/\{\{watermark\}\}/g, schedule.watermark ?? schedule.created_at)

    const renderTemplateValue = (value: unknown): unknown => {
      if (typeof value === 'string') return replaceVars(value)
      if (Array.isArray(value)) return value.map(renderTemplateValue)
      if (value && typeof value === 'object') {
        return Object.fromEntries(
          Object.entries(value as Record<string, unknown>).map(([key, nestedValue]) => [
            key,
            renderTemplateValue(nestedValue),
          ]),
        )
      }
      return value
    }

    const title = replaceVars(schedule.task_template.title)
    const description = replaceVars(schedule.task_template.description ?? '')

    // 找到 Agent 模块并 RPC 调用
    try {
      const port = await this.ensureAgentPort()
      if (!port) {
        console.error(`[Admin] No agent module found, skipping schedule trigger for ${schedule.id} (${schedule.name})`)
        return
      }

      const directMaintenance = schedule.is_builtin === true
        && schedule.task_template.type === 'memory_maintenance'
      const triggerResult = await this.rpcClient.call<
        {
          schedule_id: string
          title: string
          description: string
          /** Schedule 的目标会话（可选）。无值时 agent 路由到系统任务线程 manager。 */
          target_session?: ScheduleTargetSession
          creator_friend_id?: FriendId
          is_builtin?: boolean
          task_type?: string
          priority?: TaskPriority
          input?: Record<string, unknown>
          tags?: string[]
        },
        { accepted: true; task_id?: string }
      >(
        port,
        'trigger_schedule',
        {
          schedule_id: schedule.id,
          title,
          description,
          ...(schedule.target_session ? { target_session: schedule.target_session } : {}),
          ...(schedule.creator_friend_id ? { creator_friend_id: schedule.creator_friend_id } : {}),
          ...(schedule.is_builtin ? { is_builtin: schedule.is_builtin } : {}),
          ...(directMaintenance ? {
            task_type: schedule.task_template.type,
            priority: schedule.task_template.priority,
            input: renderTemplateValue(schedule.task_template.input) as Record<string, unknown> | undefined,
            tags: schedule.task_template.tags,
          } : {}),
        },
        this.config.moduleId
      )

      // 更新 Schedule 状态（不可变模式）
      const nowIso = generateTimestamp()
      const updated: Schedule = {
        ...schedule,
        last_triggered_at: nowIso,
        execution_count: schedule.execution_count + 1,
        next_trigger_at: this.calculateNextTriggerTime(schedule.trigger),
        ...(triggerResult.task_id ? { last_task_id: triggerResult.task_id } : {}),
        updated_at: nowIso,
      }
      this.schedules.set(schedule.id, updated)

      // Once 类型触发后自动 disable
      if (schedule.trigger.type === 'once') {
        const disabled: Schedule = { ...updated, enabled: false }
        this.schedules.set(schedule.id, disabled)
        this.scheduleEngine.disable(schedule.id)
      }

      // 持久化状态变更（fire-and-forget，不阻塞触发链路）
      this.saveData().catch(() => {})

      this.publishAdminEvent('admin.schedule_triggered', { schedule: updated })
      return {
        accepted: true,
        ...(triggerResult.task_id ? { task_id: triggerResult.task_id } : {}),
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      console.error(`[Admin] Schedule trigger RPC failed for ${schedule.id} (${schedule.name}): ${msg}`)
      return
    }
  }

  // ============================================================================
  // 事件发布
  // ============================================================================

  private async publishAdminEventDurable<K extends keyof AdminEventPayloads>(
    type: K,
    payload: AdminEventPayloads[K]
  ): Promise<void> {
    const event = {
      id: generateId(),
      type,
      source: this.config.moduleId,
      payload,
      timestamp: generateTimestamp(),
    }
    await this.rpcClient.publishEvent(event as Event, this.config.moduleId)
  }

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
        const cron = new Cron(trigger.expression, { timezone: trigger.timezone })
        const next = cron.nextRun()
        cron.stop()
        return next?.toISOString()
      }
      default:
        return undefined
    }
  }

  private isManagedBuiltinSchedule(schedule: Pick<Schedule, 'is_builtin' | 'task_template'>): boolean {
    return schedule.is_builtin === true
      && (schedule.task_template.type === 'daily_reflection'
        || schedule.task_template.type === 'memory_maintenance')
  }

  private getManagedBuiltinTrigger(taskType: string): ScheduleTrigger {
    const baseHour = taskType === 'daily_reflection' ? 2 : 4
    const rawOffset = Number(process.env.CRABOT_PORT_OFFSET ?? '0')
    const delayMinutes = Number.isFinite(rawOffset) && rawOffset >= 0 ? Math.floor(rawOffset / 100) : 0
    const totalMinutes = baseHour * 60 + delayMinutes
    return {
      type: 'cron',
      expression: `${totalMinutes % 60} ${Math.floor(totalMinutes / 60) % 24} * * *`,
      timezone: 'Asia/Shanghai',
    }
  }

  /** 确保内置 Schedule 存在。首次启动时创建，后续启动收敛受管字段。 */
  private async ensureBuiltinSchedules(): Promise<void> {
    const SEEDS: Array<Pick<Schedule, 'name' | 'description' | 'trigger' | 'task_template'>> = [
      {
        name: '每日反思',
        description: '每天凌晨 2 点自动执行反思，分析前一天任务执行情况，提炼经验写入长期记忆。',
        trigger: this.getManagedBuiltinTrigger('daily_reflection'),
        task_template: {
          type: 'daily_reflection',
          title: '每日反思 — {{date}}',
          description: '第一步必须调用 Skill("daily-reflection")，禁止加载其他 reflection skill。反思时间范围：{{watermark}} 到 {{datetime}}。标准流程：1）获取此时间范围内的任务概览；2）筛选值得深入分析的任务（排除 daily_reflection 类型，优先关注失败、轮数异常、人类情绪明显的）；3）对每个选中任务委派 sub-agent 深入分析（trace span + 对话历史），返回分析结果和经验建议；4）综合所有 sub-agent 结果，跨任务去重，统一写入长期记忆；5）反思全过程是 crabot 内部产物：结构化报告只落 task outcome，永不外发；仅当存在 surprisal≥0.7 的发现且可翻译成一行人话时，调 send_master_private 发出一句人类视角摘要，否则保持沉默。禁止把 trace 数据 / Evolution Mode / 数字明细发出去。',
          priority: 'low',
          tags: ['daily_reflection', 'builtin'],
        },
      },
      {
        name: '记忆整理',
        description: '每小时扫一次 inbox，做去重和多因子打分，高分高置信晋升 confirmed。',
        trigger: { type: 'interval', seconds: 3600 },
        task_template: {
          type: 'memory_curate',
          title: '记忆整理 — {{datetime}}',
          description: '第一步必须调用 Skill("memory-curate")，禁止加载其他 reflection skill。整理范围：{{watermark}} 到 {{datetime}}。流程：按 ingestion_time 增量列出此窗口内的 inbox → 去重 → 多因子打分 → 晋升 confirmed / 丢弃 / 留待 daily-reflection。禁止用 search_long_term 拉 inbox 候选。',
          priority: 'low',
          input: {
            ingestion_time_start: '{{watermark}}',
            ingestion_time_end: '{{datetime}}',
          },
          tags: ['memory_curate', 'builtin'],
        },
      },
      {
        name: '记忆维护',
        description: '每天凌晨 4 点跑 memory.run_maintenance(scope=all)，做观察期到期检查 / stale 老化 / trash 清理。',
        trigger: this.getManagedBuiltinTrigger('memory_maintenance'),
        task_template: {
          type: 'memory_maintenance',
          title: '记忆维护 — {{date}}',
          description: '调用 memory 模块 run_maintenance({scope: "all"}) RPC。',
          priority: 'low',
          tags: ['memory_maintenance', 'builtin'],
        },
      },
    ]

    const memoryCurateSeed = SEEDS.find(s => s.name === '记忆整理')
    let migrated = false
    for (const [id, sched] of this.schedules) {
      if (sched.is_builtin && sched.name === '周期轻反思' && memoryCurateSeed) {
        this.schedules.set(id, {
          ...sched,
          name: memoryCurateSeed.name,
          description: memoryCurateSeed.description,
          trigger: memoryCurateSeed.trigger,
          task_template: memoryCurateSeed.task_template,
          updated_at: generateTimestamp(),
        })
        migrated = true
      }
    }

    // 两个受管日任务以 is_builtin + task_template.type 为身份；其余 builtin
    // 延续按名称识别。重复项只保留 created_at 最早的原记录与统计。
    const identityOf = (schedule: Schedule): string => this.isManagedBuiltinSchedule(schedule)
      ? `type:${schedule.task_template.type}`
      : `name:${schedule.name}`
    const builtinByIdentity = new Map<string, Schedule[]>()
    for (const schedule of this.schedules.values()) {
      if (!schedule.is_builtin) continue
      const identity = identityOf(schedule)
      const group = builtinByIdentity.get(identity) ?? []
      group.push(schedule)
      builtinByIdentity.set(identity, group)
    }
    for (const [identity, group] of builtinByIdentity) {
      if (group.length <= 1) continue
      const [keep, ...drop] = [...group].sort((a, b) =>
        a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id),
      )
      for (const duplicate of drop) this.schedules.delete(duplicate.id)
      console.warn(`[Admin] Collapsed ${drop.length} duplicate builtin schedule(s) for "${identity}", kept ${keep.id}`)
    }

    const findExisting = (seed: Pick<Schedule, 'name' | 'task_template'>): Schedule | undefined => {
      const managedType = seed.task_template.type === 'daily_reflection'
        || seed.task_template.type === 'memory_maintenance'
      return Array.from(this.schedules.values()).find(schedule => schedule.is_builtin && (
        managedType
          ? schedule.task_template.type === seed.task_template.type
          : schedule.name === seed.name
      ))
    }

    for (const seed of SEEDS) {
      const current = findExisting(seed)
      if (!current) continue

      if (this.isManagedBuiltinSchedule(current)) {
        // 系统 offset 决定受管 trigger；其他字段和原记录统计保持不变。
        if (JSON.stringify(current.trigger) !== JSON.stringify(seed.trigger)) {
          this.schedules.set(current.id, {
            ...current,
            trigger: seed.trigger,
            next_trigger_at: this.calculateNextTriggerTime(seed.trigger),
            updated_at: generateTimestamp(),
          })
        }
        continue
      }

      // memory_curate 等既有 builtin 延续原有 SEED 执行体同步语义。
      if (JSON.stringify(current.task_template) !== JSON.stringify(seed.task_template)) {
        this.schedules.set(current.id, {
          ...current,
          task_template: seed.task_template,
          updated_at: generateTimestamp(),
        })
        console.log(`[Admin] Resynced builtin schedule task_template for "${seed.name}"`)
      }
    }

    for (const seed of SEEDS) {
      if (findExisting(seed)) continue
      const now = generateTimestamp()
      const id = generateId()
      const schedule: Schedule = {
        id,
        ...seed,
        enabled: true,
        is_builtin: true,
        execution_count: 0,
        next_trigger_at: this.calculateNextTriggerTime(seed.trigger),
        created_at: now,
        updated_at: now,
      }
      this.schedules.set(id, schedule)
    }
    await this.saveData()
    if (migrated) {
      console.log('[Admin] Migrated builtin schedule: 周期轻反思 → 记忆整理 (quick_reflection → memory_curate)')
    }
    console.log('[Admin] Builtin schedules ensured: daily-reflection / memory-curate / memory-maintenance')
  }

  // ============================================================================
  // Schedule REST API
  // ============================================================================

  private async handleListSchedulesApi(
    _req: IncomingMessage,
    res: ServerResponse,
    url: URL
  ): Promise<void> {
    const params: ListSchedulesParams = {
      page: parseInt(url.searchParams.get('page') ?? '1', 10),
      page_size: parseInt(url.searchParams.get('page_size') ?? '50', 10),
      filter: {},
    }
    const enabled = url.searchParams.get('enabled')
    if (enabled !== null) params.filter!.enabled = enabled === 'true'
    const triggerType = url.searchParams.get('trigger_type')
    if (triggerType) params.filter!.trigger_type = triggerType as ScheduleTriggerType
    const search = url.searchParams.get('search')
    if (search) params.filter!.search = search

    const result = await this.handleListSchedules(params)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(result))
  }

  private async handleCreateScheduleApi(
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<void> {
    try {
      const params = await this.readJsonBody<CreateScheduleParams>(req)
      // Admin Web / 人类直接调 CLI 时 creator_friend_id 通常为空 → 自动填 master，
      // 让触发时能解析到 master_private 的最高权限。Worker 子进程通过 env 显式带创建人，
      // 走的是同一 REST 端点但已有值，跳过补 master。
      let effectiveParams = params
      if (params.creator_friend_id === undefined) {
        const master = this.findMasterFriend()
        if (master) effectiveParams = { ...params, creator_friend_id: master.id }
      }
      const result = await this.handleCreateSchedule(effectiveParams)
      res.writeHead(201, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(result))
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'create failed' }))
    }
  }

  private findMasterFriend(): Friend | undefined {
    for (const friend of this.friends.values()) {
      if (friend.permission === 'master') return friend
    }
    return undefined
  }

  // ============================================================================
  // Channel onboarding 自动认主 + 引导推送
  // ============================================================================

  /**
   * 扫码 onboarding 完成后，把 (channel_id, owner_open_id) 写入 master Friend。
   * 没有 master 则创建一个；有则合并 channel_identities。
   * 不抛错（设计目标：onboarding 锦上添花，不阻塞 finish）。
   */
  private async ensureMasterForOnboarding(
    channelId: ModuleId,
    ownerOpenId: string,
  ): Promise<{ friend_id: FriendId; display_name: string; created: boolean } | undefined> {
    try {
      const existing = this.findMasterFriend()
      const now = generateTimestamp()
      if (!existing) {
        // 无 master：创建一个，display_name 留空。Admin Web onboarding 卡片引导用户填。
        const initialIdentity: ChannelIdentity = {
          channel_id: channelId,
          platform_user_id: ownerOpenId,
          platform_display_name: ONBOARDING_MASTER_DEFAULT_DISPLAY_NAME,
        }
        const friend: Friend = {
          id: generateId(),
          display_name: ONBOARDING_MASTER_DEFAULT_DISPLAY_NAME,
          permission: 'master',
          channel_identities: [initialIdentity],
          created_at: now,
          updated_at: now,
        }
        this.channelIdentityIndex.set(this.getChannelIdentityKey(initialIdentity), friend.id)
        this.friends.set(friend.id, friend)
        await this.saveData()
        console.log(`[Admin] onboarding: master friend ${friend.id} 已创建 (channel=${channelId})`)
        return { friend_id: friend.id, display_name: friend.display_name, created: true }
      }
      // 有 master：channel_identity 的 platform_display_name 优先复用 master 现有 display_name
      // 保持跨渠道一致。无 display_name 时回退到空字符串占位。
      const merge = mergeMasterChannelIdentity(
        existing.channel_identities,
        channelId,
        ownerOpenId,
        existing.display_name || undefined,
      )
      if (!merge.changed) {
        return { friend_id: existing.id, display_name: existing.display_name, created: false }
      }
      if (merge.removedIdentity) {
        this.channelIdentityIndex.delete(this.getChannelIdentityKey(merge.removedIdentity))
      }
      const updated: Friend = {
        ...existing,
        channel_identities: merge.identities,
        updated_at: now,
      }
      for (const identity of merge.identities) {
        this.channelIdentityIndex.set(this.getChannelIdentityKey(identity), updated.id)
      }
      this.friends.set(updated.id, updated)
      await this.saveData()
      console.log(`[Admin] onboarding: master friend ${updated.id} 已合并新 channel identity (channel=${channelId})`)
      return { friend_id: updated.id, display_name: updated.display_name, created: false }
    } catch (err) {
      console.warn(`[Admin] onboarding ensureMaster failed (channel=${channelId}):`, err)
      return undefined
    }
  }

  /**
   * 给 master 私聊推送 onboarding 引导文案（含 scope_grant_url）。
   * 整段不抛错；任何步骤失败都 return false，caller 据此决定是否走 fallback UI。
   */
  private async pushOnboardingGuide(
    channelId: ModuleId,
    ownerOpenId: string,
    scopeGrantUrl: string,
    opts: { readyTimeoutMs?: number; pollIntervalMs?: number } = {},
  ): Promise<boolean> {
    const readyTimeoutMs = opts.readyTimeoutMs ?? 5000
    const pollIntervalMs = opts.pollIntervalMs ?? 200
    const deadline = Date.now() + readyTimeoutMs
    let modulePort: number | undefined
    while (Date.now() < deadline) {
      try {
        const modules = await this.rpcClient.resolve({ module_id: channelId }, this.config.moduleId)
        const mod = modules[0]
        if (mod && mod.status === 'running' && typeof mod.port === 'number') {
          modulePort = mod.port
          break
        }
      } catch {
        // resolve 失败也算未就绪，继续轮询
      }
      await new Promise((r) => setTimeout(r, pollIntervalMs))
    }
    if (!modulePort) {
      console.warn(`[Admin] onboarding push: channel ${channelId} 未在 ${readyTimeoutMs}ms 内就绪，跳过私聊推送`)
      return false
    }
    try {
      const sessionResp = await this.rpcClient.call<
        { platform_user_id: string },
        { session: { id: string } }
      >(
        modulePort,
        'find_or_create_private_session',
        { platform_user_id: ownerOpenId },
        this.config.moduleId,
      )
      const sessionId = sessionResp?.session?.id
      if (!sessionId) {
        console.warn(`[Admin] onboarding push: find_or_create_private_session 未返回 session.id`)
        return false
      }
      await this.rpcClient.call(
        modulePort,
        'send_message',
        {
          session_id: sessionId,
          content: { type: 'text', text: buildOnboardingPushMessage(scopeGrantUrl) },
        },
        this.config.moduleId,
      )
      console.log(`[Admin] onboarding push: scope_grant_url 已通过 ${channelId} 私聊推送给 ${ownerOpenId}`)
      return true
    } catch (err) {
      console.warn(`[Admin] onboarding push to ${ownerOpenId} via ${channelId} failed:`, err)
      return false
    }
  }

  private async handleGetScheduleApi(
    _req: IncomingMessage,
    res: ServerResponse,
    id: string
  ): Promise<void> {
    try {
      const result = await this.handleGetSchedule({ schedule_id: id })
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(result))
    } catch (err) {
      const status = err instanceof Error && err.message.includes('NOT_FOUND') ? 404 : 400
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'get failed' }))
    }
  }

  private async handleUpdateScheduleApi(
    req: IncomingMessage,
    res: ServerResponse,
    id: string
  ): Promise<void> {
    try {
      const body = await this.readJsonBody<Omit<UpdateScheduleParams, 'schedule_id'>>(req)
      const result = await this.handleUpdateSchedule({ ...body, schedule_id: id })
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(result))
    } catch (err) {
      const status = err instanceof Error && err.message.includes('NOT_FOUND') ? 404 : 400
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'update failed' }))
    }
  }

  private async handleDeleteScheduleApi(
    _req: IncomingMessage,
    res: ServerResponse,
    id: string
  ): Promise<void> {
    try {
      await this.handleDeleteSchedule({ schedule_id: id })
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ deleted: true }))
    } catch (err) {
      const status = err instanceof Error && err.message.includes('NOT_FOUND') ? 404 : 400
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'delete failed' }))
    }
  }

  private async handleTriggerNowApi(
    _req: IncomingMessage,
    res: ServerResponse,
    id: string
  ): Promise<void> {
    try {
      const result = await this.handleTriggerNow({ schedule_id: id })
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(result))
    } catch (err) {
      const status = err instanceof Error && err.message.includes('NOT_FOUND') ? 404 : 500
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'trigger failed' }))
    }
  }

  // ============================================================================
  // Model Provider REST API
  // ============================================================================

  /** 序列化 provider 给前端：剥离敏感的 oauth_credential，派生安全的 oauth_info */
  private sanitizeProviderForApi(provider: ModelProvider): Record<string, unknown> {
    const { oauth_credential, ...rest } = provider
    return {
      ...rest,
      ...(oauth_credential ? {
        oauth_info: {
          email: oauth_credential.email,
          expires_at: oauth_credential.expires_at,
          account_id: oauth_credential.account_id,
        },
      } : {}),
    }
  }

  private async handleListProvidersApi(_req: IncomingMessage, res: ServerResponse): Promise<void> {
    const providers = this.modelProviderManager.listProviders()
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      items: providers.map(p => this.sanitizeProviderForApi(p)),
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
    res.end(JSON.stringify(this.sanitizeProviderForApi(provider)))
  }

  private async handleUpdateProviderApi(req: IncomingMessage, res: ServerResponse, id: string): Promise<void> {
    const body = await this.readJsonBody<UpdateModelProviderParams>(req)
    const provider = await this.modelProviderManager.updateProvider(id, body)

    this.publishAdminEvent('admin.model_provider_updated', { provider })

    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(provider))

    // provider 连接信息可能变了：把全局默认的最新连接信息推给 memory，把整套 agent 配置重推一遍。
    // 不判断本次改的是不是全局默认 provider —— agent model_config 可能引用任何 provider。
    this.syncGlobalConfigToMemoryModules().catch((err: Error) => {
      console.warn('[Admin] syncGlobalConfigToMemoryModules after provider update failed:', err.message)
    })
  }

  private async handleDeleteProviderApi(_req: IncomingMessage, res: ServerResponse, id: string): Promise<void> {
    await this.modelProviderManager.deleteProvider(id)

    this.publishAdminEvent('admin.model_provider_deleted', { provider_id: id })

    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ deleted: true }))

    this.syncGlobalConfigToMemoryModules().catch((err: Error) => {
      console.warn('[Admin] syncGlobalConfigToMemoryModules after provider delete failed:', err.message)
    })
  }

  private async handleImportFromVendorApi(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await this.readJsonBody<ImportFromVendorParams>(req)
    const result = await this.modelProviderManager.importFromVendor(body)

    // OAuth vendor：自动关联最近一次 OAuth 登录的 credential
    if (result.provider.auth_type === 'oauth' && this.lastOAuthResult) {
      await this.modelProviderManager.setOAuthCredential(result.provider.id, {
        access_token: this.lastOAuthResult.access_token,
        refresh_token: this.lastOAuthResult.refresh_token,
        expires_at: this.lastOAuthResult.expires_at,
        account_id: this.lastOAuthResult.account_id,
        email: this.lastOAuthResult.email,
      })
      this.lastOAuthResult = null

      // OAuth 凭证已 attach，用 access_token 拉取真实模型列表
      try {
        const refreshed = await this.modelProviderManager.refreshModels(result.provider.id)
        result.models = refreshed.models
        result.provider.models = refreshed.models
      } catch (err) {
        console.warn(`[Admin] OAuth provider 模型列表刷新失败（继续使用默认列表）:`, err)
      }
    }

    this.publishAdminEvent('admin.model_provider_created', { provider: result.provider })

    res.writeHead(201, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(result))

    // vendor 导入完成（包含 OAuth credential / 模型列表刷新），下游 agent / memory 可能正等着用
    this.syncGlobalConfigToMemoryModules().catch((err: Error) => {
      console.warn('[Admin] syncGlobalConfigToMemoryModules after vendor import failed:', err.message)
    })
  }

  private async handleTestProviderApi(req: IncomingMessage, res: ServerResponse, id: string): Promise<void> {
    const body = await this.readJsonBody<{ model_id?: string }>(req).catch(() => ({} as { model_id?: string }))
    const result = await this.modelProviderManager.testProviderModel(id, body.model_id)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(result))
  }

  private async handleValidateDraftProviderApi(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await this.readJsonBody<CreateModelProviderParams>(req)
    const result = await this.modelProviderManager.validateDraftProvider(body)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(result))
  }

  private async handleRefreshModelsApi(_req: IncomingMessage, res: ServerResponse, id: string): Promise<void> {
    const result = await this.modelProviderManager.refreshModels(id)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(result))
  }

  private async handleGetProviderReferencesApi(_req: IncomingMessage, res: ServerResponse, id: string): Promise<void> {
    const result = this.modelProviderManager.getProviderReferences(id)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(result))
  }

  private async handleListPresetVendorsApi(_req: IncomingMessage, res: ServerResponse): Promise<void> {
    const vendors = getPresetVendors()
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      items: vendors,
      pagination: {
        page: 1,
        page_size: 100,
        total_items: vendors.length,
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
    // 手动改图像 slot 视为用户设定，锁定不被 autoConfigureImageSlot 覆盖（前端会显式带 true，此为兜底）
    if (
      (body.default_image_provider_id !== undefined || body.default_image_model_id !== undefined) &&
      body.image_slot_user_set === undefined
    ) {
      body.image_slot_user_set = true
    }
    const config = await this.modelProviderManager.updateGlobalConfig(body)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ config }))

    // 后台推送新配置到所有模块（不阻塞响应）
    this.syncGlobalConfigToMemoryModules().catch((err: Error) => {
      console.warn('[Admin] syncGlobalConfigToMemoryModules failed:', err.message)
    })
  }

  private async handleGetSystemVersionApi(_req: IncomingMessage, res: ServerResponse): Promise<void> {
    await wrapJsonHandler(res, '获取版本信息失败', async () => this.versionService.getState())
  }

  private async handleCheckSystemVersionApi(_req: IncomingMessage, res: ServerResponse): Promise<void> {
    await wrapJsonHandler(res, '检查更新失败', async () => this.versionService.check())
  }

  private async handleStartUpgradeApi(_req: IncomingMessage, res: ServerResponse): Promise<void> {
    const state = await this.versionService.check()
    const verdict = canUpgrade(state)
    if (!verdict.ok) {
      sendJson(res, 409, { error: verdict.reason ?? '当前不支持一键升级' })
      return
    }
    if (isUpgradeInProgress(this.adminConfig.data_dir)) {
      sendJson(res, 409, { error: '升级已在进行中' })
      return
    }
    sendJson(res, 200, startUpgrade(CRABOT_HOME, this.adminConfig.data_dir, state.current_version))
  }

  private async handleGetProxyConfigApi(_req: IncomingMessage, res: ServerResponse): Promise<void> {
    const config = this.modelProviderManager.getProxyConfig()
    const systemProxyUrl = ProxyManager.resolveSystemProxyUrl()
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ config, system_proxy_url: systemProxyUrl }))
  }

  private async handleUpdateProxyConfigApi(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const { mode, custom_url } = await this.readJsonBody<ProxyConfig>(req)
    const proxyConfig: ProxyConfig = { mode, custom_url }

    await this.modelProviderManager.updateProxyConfig(proxyConfig)
    proxyManager.updateConfig(proxyConfig)

    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ config: proxyConfig }))

    // 后台推送到所有模块
    this.pushProxyConfigToAllModules(proxyConfig).catch((err: Error) => {
      console.warn('[Admin] pushProxyConfigToAllModules failed:', err.message)
    })
  }

  // ============================================================================
  // OAuth API Handlers
  // ============================================================================

  private oauthLoginPromise: Promise<import('./oauth/openai-codex-oauth.js').OAuthLoginResult> | null = null
  private lastOAuthResult: import('./oauth/openai-codex-oauth.js').OAuthLoginResult | null = null

  private async handleOAuthChatGPTLogin(_req: IncomingMessage, res: ServerResponse): Promise<void> {
    const oauthMod = await import('./oauth/openai-codex-oauth.js')

    this.lastOAuthResult = null

    const flowPromise = oauthMod.waitForOAuthCallback()
    this.oauthLoginPromise = flowPromise

    // 在等待回调的同时，先用一个 race 拿到 listen 阶段的错误（PORT_IN_USE 等）
    // listen 失败时 promise 立即 reject；listen 成功时 promise 不会立刻 settle
    // 因此用 setImmediate 让 listen 事件循环先跑一轮
    await new Promise((r) => setImmediate(r))

    // 探测：如果 flowPromise 已经因 PORT_IN_USE 失败，捕获并返回 409
    let listenError: unknown = null
    flowPromise.catch((err) => { listenError = err })
    await new Promise((r) => setImmediate(r))

    const listenErrorCode = (listenError as { code?: string } | null)?.code
    if (listenErrorCode === 'PORT_IN_USE') {
      this.oauthLoginPromise = null
      res.writeHead(409, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        error: '端口 1455 被占用，可能是另一个 Crabot 实例正在进行 ChatGPT 登录。请先在那个实例完成或取消登录后重试。',
      }))
      return
    }

    // 自验证：确认 server 能响应
    const ok = await oauthMod.selfCheckCallbackServer()
    if (!ok) {
      oauthMod.cancelOAuthFlow()
      this.oauthLoginPromise = null
      res.writeHead(503, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'OAuth callback server 自验证失败，无法继续登录' }))
      return
    }

    const authUrl = oauthMod.getOAuthAuthUrl()
    if (!authUrl) {
      oauthMod.cancelOAuthFlow()
      this.oauthLoginPromise = null
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Failed to generate auth URL' }))
      return
    }

    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ auth_url: authUrl }))

    // 后台等待回调完成，保存结果
    flowPromise
      .then((result) => { this.lastOAuthResult = result })
      .catch(() => { /* 状态通过 /status 查询 */ })
  }

  private async handleOAuthChatGPTManualCallback(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const oauthMod = await import('./oauth/openai-codex-oauth.js')

    let body: { redirect_url?: string } | null = null
    try {
      body = await this.readJsonBody<{ redirect_url?: string }>(req)
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'Invalid JSON' }))
      return
    }

    const input = body?.redirect_url?.trim()
    if (!input) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: '请粘贴授权回调 URL' }))
      return
    }

    if (!this.oauthLoginPromise) {
      res.writeHead(409, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: '当前没有进行中的 OAuth 登录流程，请先点击"登录"按钮' }))
      return
    }

    try {
      const result = await oauthMod.submitManualCallback(input)
      this.lastOAuthResult = result
      this.oauthLoginPromise = null
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ status: 'success', email: result.email, account_id: result.account_id }))
    } catch (err) {
      // 校验错误（缺 code / state mismatch）submitManualCallback 不会清 pending flow，
      // 这里也就保留 oauthLoginPromise，让用户改了粘贴内容直接重提；token 兑换失败才会真正终结流程
      if (!oauthMod.isOAuthPending()) {
        this.oauthLoginPromise = null
      }
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }))
    }
  }

  private async handleOAuthChatGPTImport(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const oauthMod = await import('./oauth/openai-codex-oauth.js')

    let body: { auth_json?: string } | null = null
    try {
      body = await this.readJsonBody<{ auth_json?: string }>(req)
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'Invalid JSON' }))
      return
    }

    const text = body?.auth_json?.trim()
    if (!text) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: '请上传或粘贴 auth.json 内容' }))
      return
    }

    // 第一层：结构 + JWT 解析
    let parsed: import('./oauth/openai-codex-oauth.js').OAuthLoginResult
    try {
      parsed = oauthMod.parseCodexAuthJson(text)
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }))
      return
    }

    // 第二层：服务端实战校验（拉一次 /models）
    if (!parsed.account_id) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'auth.json 缺少 account_id' }))
      return
    }
    try {
      await oauthMod.validateChatGPTAccessToken(parsed.access_token, parsed.account_id)
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }))
      return
    }

    // 校验通过：取消任何 pending 扫码流程，把 result 写入 lastOAuthResult，
    // 后续 createProvider/importFromVendor 流程会消费它（与扫码登录路径完全一致）。
    oauthMod.cancelOAuthFlow()
    this.oauthLoginPromise = null
    this.lastOAuthResult = parsed

    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      status: 'success',
      email: parsed.email,
      account_id: parsed.account_id,
      expires_at: parsed.expires_at,
    }))
  }

  private async handleOAuthChatGPTStatus(_req: IncomingMessage, res: ServerResponse): Promise<void> {
    const { isOAuthPending } = await import('./oauth/openai-codex-oauth.js')

    if (!this.oauthLoginPromise) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ status: 'idle' }))
      return
    }

    if (isOAuthPending()) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ status: 'pending' }))
      return
    }

    // Flow 已完成
    try {
      const result = await this.oauthLoginPromise
      this.oauthLoginPromise = null
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        status: 'success',
        email: result.email,
        account_id: result.account_id,
        expires_at: result.expires_at,
      }))
    } catch (err) {
      this.oauthLoginPromise = null
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        status: 'failed',
        error: err instanceof Error ? err.message : String(err),
      }))
    }
  }

  private async handleOAuthChatGPTLogout(_req: IncomingMessage, res: ServerResponse, providerId: string): Promise<void> {
    try {
      await this.modelProviderManager.clearOAuthCredential(providerId)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ success: true }))
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }))
    }
  }

  private async handleOAuthChatGPTTokenInfo(_req: IncomingMessage, res: ServerResponse, providerId: string): Promise<void> {
    const credential = this.modelProviderManager.getOAuthCredential(providerId)
    if (!credential) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ logged_in: false }))
      return
    }

    const isExpired = Date.now() > credential.expires_at
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      logged_in: true,
      email: credential.email,
      account_id: credential.account_id,
      expires_at: credential.expires_at,
      is_expired: isExpired,
    }))
  }

  // ============================================================================
  // Config Status
  // ============================================================================

  private async handleGetConfigStatusApi(_req: IncomingMessage, res: ServerResponse): Promise<void> {
    const missing: string[] = []
    const warnings: string[] = []

    // 检查全局配置
    const globalConfig = this.modelProviderManager.getGlobalConfig()
    if (!globalConfig.default_llm_provider_id || !globalConfig.default_llm_model_id) {
      missing.push('全局 LLM 模型未配置')
    }

    // 检查 Provider 是否存在
    if (globalConfig.default_llm_provider_id) {
      const provider = this.modelProviderManager.getProvider(globalConfig.default_llm_provider_id)
      if (!provider) {
        warnings.push(`LLM Provider ${globalConfig.default_llm_provider_id} 不存在`)
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
  // Agent Implementation 协议方法
  // ============================================================================

  private async handleListAgentImplementations(params: ListAgentImplementationsParams): Promise<{
    items: AgentImplementation[]
    pagination: { page: number; page_size: number; total_items: number; total_pages: number }
  }> {
    const page = params.page ?? 1
    const pageSize = params.page_size ?? 20
    const core = this.agentManager.getImplementation('default')
    const items = core && (!params.type || core.type === params.type) && (!params.engine || core.engine === params.engine) ? [core] : []
    return { items: items.slice((page - 1) * pageSize, page * pageSize), pagination: { page, page_size: pageSize, total_items: items.length, total_pages: Math.ceil(items.length / pageSize) } }
  }

  private async handleGetAgentImplementation(params: { implementation_id: string }): Promise<{
    implementation: AgentImplementation
  }> {
    if (params.implementation_id !== 'default') throw new Error(`Implementation not found: ${params.implementation_id}`)
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
    const page = params.page ?? 1
    const pageSize = params.page_size ?? 20
    const core = this.agentManager.getInstance('crabot-agent')
    const items = core && (!params.implementation_id || core.implementation_id === params.implementation_id) && (params.auto_start === undefined || core.auto_start === params.auto_start) ? [core] : []
    return { items: items.slice((page - 1) * pageSize, page * pageSize), pagination: { page, page_size: pageSize, total_items: items.length, total_pages: Math.ceil(items.length / pageSize) } }
  }

  private async handleGetAgentInstance(params: { instance_id: string }): Promise<{
    instance: AgentInstance
  }> {
    if (params.instance_id !== 'crabot-agent') throw new Error(`Instance not found: ${params.instance_id}`)
    const instance = this.agentManager.getInstance(params.instance_id)
    if (!instance) {
      throw new Error(`Instance not found: ${params.instance_id}`)
    }
    return { instance }
  }

  private async handleCreateAgentInstance(_params: CreateAgentInstanceParams): Promise<{
    instance: AgentInstance
  }> {
    throw new RpcError('ADMIN_HOTPLUG_NOT_ALLOWED', 'Dynamic Agent instances are retired; only builtin crabot-agent is supported')
  }

  private async handleUpdateAgentInstance(_params: UpdateAgentInstanceParams): Promise<{
    instance: AgentInstance
  }> {
    throw new RpcError('ADMIN_HOTPLUG_NOT_ALLOWED', 'Dynamic Agent instances are retired; legacy Agent records are read-only')
  }

  private async handleDeleteAgentInstance(_params: { instance_id: string }): Promise<{
    deleted: true
  }> {
    throw new RpcError('ADMIN_HOTPLUG_NOT_ALLOWED', 'Dynamic Agent instances are retired; legacy Agent records are read-only')
  }
  private async waitForCoreAgentReady(options: { attempts?: number; delayMs?: number } = {}): Promise<void> {
    const attempts = options.attempts ?? 30
    const delayMs = options.delayMs ?? 500
    let lastReason = 'core Agent has not registered'
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const port = await this.ensureAgentPort()
        if (!port) throw new Error('core Agent port unavailable')
        const health = await this.rpcClient.call<{}, { status?: string; details?: { llm_status?: string } }>(port, 'health', {}, this.config.moduleId)
        if (health.status === 'healthy' && health.details?.llm_status === 'ready') return
        lastReason = `core Agent health=${health.status ?? 'unknown'} configured=${health.details?.llm_status ?? 'unknown'}`
      } catch (error) {
        lastReason = error instanceof Error ? error.message : String(error)
      }
      await new Promise((resolve) => setTimeout(resolve, delayMs))
    }
    throw new Error(`Core Agent readiness timed out: ${lastReason}`)
  }

  async completeCoreAgentCutover(): Promise<void> {
    if (this.cutoverActivated || !this.managementOnly) return
    if (this.cutoverAttempt) return this.cutoverAttempt
    this.cutoverRecoveryReason = null
    this.cutoverAttempt = this.completeCoreAgentCutoverAttempt()
      .catch((error) => {
        this.configInvalidationPublicationEnabled = false
        this.cutoverRecoveryReason = this.classifyCutoverRecoveryReason(error)
        throw error
      })
      .finally(() => { this.cutoverAttempt = null })
    return this.cutoverAttempt
  }

  private classifyCutoverRecoveryReason(error: unknown): string {
    const code = (error as { code?: unknown })?.code
    if (code === 'MODULE_MANAGER_CUTOVER_STOP_FAILED') return 'legacy Agent process tree could not be stopped; retry after recovery'
    if (code === 'MODULE_MANAGER_CUTOVER_CONFLICT') return 'core Agent cutover inventory conflicts with durable marker'
    const message = error instanceof Error ? error.message : String(error)
    if (message.startsWith('Core Agent readiness timed out:')) return 'waiting for core Agent health and authenticated configuration'
    if (message.includes('archive') || message.includes('cutover marker')) return 'legacy Agent archive or cutover marker requires recovery'
    return 'core Agent cutover requires operator recovery before retry'
  }

  private async reconcileCoreAgentCutoverRecord(
    archive: { fingerprint: string; record_count: number },
    completionError: unknown,
  ): Promise<unknown> {
    let response: { record: unknown }
    try {
      response = await this.rpcClient.callModuleManager<Record<string, never>, { record: unknown }>(
        'get_core_agent_cutover_record', {}, this.config.moduleId,
      )
    } catch {
      throw completionError
    }
    const result = response.record as {
      admin_archive_fingerprint?: unknown
      admin_archived_record_count?: unknown
    }
    if (result?.admin_archive_fingerprint !== archive.fingerprint || result?.admin_archived_record_count !== archive.record_count) throw completionError
    return result
  }

  private async completeCoreAgentCutoverAttempt(): Promise<void> {
    const packageEntries = await this.readLegacyAgentPackageEntries()
    const frontWorkerConfigs = await this.readLegacyFrontWorkerConfigSources()
    const sources = [
      ...this.agentManager.listImplementations().items.filter((item) => item.id !== 'default').map((item) => ({ source_kind: 'agent_implementation' as const, source_id: item.id, raw: item })),
      ...this.agentManager.listInstances().items.filter((item) => item.id !== 'crabot-agent').map((item) => ({ source_kind: 'agent_instance' as const, source_id: item.id, raw: item })),
      ...this.agentManager.listConfigs().filter((item) => item.instance_id !== 'crabot-agent').map((item) => ({ source_kind: 'agent_config' as const, source_id: item.instance_id, raw: item })),
      ...packageEntries.map((entry) => ({ source_kind: 'installed_package' as const, source_id: entry.source_id, raw: entry.raw })),
      ...frontWorkerConfigs.map((entry) => ({ source_kind: 'agent_config' as const, source_id: `legacy-${entry.source_id}`, raw: entry.raw })),
    ]
    // archive() 合并时对已归档记录的内容变化抛事实冲突（重新进入 gate）；新增条目只扩展只读归档。
    const archive = await this.cutoverStore.archive(sources)
    const existing = await this.cutoverStore.loadMarker()
    // marker 已提交 cutover 拓扑：提交后的每次重启都必须用已提交的 fingerprint/count 与 MM
    // 握手（MM record 按该值对账）。cutover 之后新增的 legacy 条目可以容忍——与 MM 侧
    // 「archived 子集仍在」的检查语义一致；否则 cutover 后任何新安装模块都会把 admin-web
    // 永久锁在 management-only。
    const handshake = existing
      ? { fingerprint: existing.archive_fingerprint, record_count: existing.archive_record_count }
      : { fingerprint: archive.fingerprint, record_count: archive.record_count }
    if (!this.cutoverBearer) throw new Error('Missing CRABOT_ADMIN_CUTOVER_BEARER')
    let result: unknown
    try {
      result = await this.rpcClient.callModuleManagerSensitive(
        'complete_core_agent_cutover',
        { schema_version: 1, admin_archive_fingerprint: handshake.fingerprint, admin_archived_record_count: handshake.record_count },
        this.config.moduleId,
        { authorizationBearer: this.cutoverBearer },
      )
      const wrapped = result as { record?: unknown }
      if (!wrapped || wrapped.record === undefined) throw new Error('Invalid complete_core_agent_cutover response')
    } catch (error) {
      result = await this.reconcileCoreAgentCutoverRecord(handshake, error)
    }
    if (!existing) {
      await this.cutoverStore.saveMarker({ schema_version: 1, completed: true, completed_at: new Date().toISOString(), archive_fingerprint: archive.fingerprint, archive_record_count: archive.record_count, mm_result: result })
    }
    // The durable marker commits topology cutover. Readiness activation is a separate,
    // retryable phase: the MM bearer has already been consumed and must never be replayed.
    await this.waitForCoreAgentReady()
    this.configInvalidationPublicationEnabled = true
    await this.configMutationCoordinator.drainPendingInvalidation()
    await this.channelManager.reRegisterInstances()
    await this.ensureBuiltinSchedules()
    await this.publishCurrentAgentConfigInvalidation()
    try {
      await this.startAgentDependentMaintenance()
    } catch (error) {
      this.configInvalidationPublicationEnabled = false
      throw error
    }
    // §3.19.12 step 4：开放 ingress 前完成 worker implementation 初始迁移
    // （grandfather bootstrap；fresh deploy 只落 completed marker，不 inspect 不付费 verify）。
    await this.runWorkerImplementationBootstrap()

    // Open ingress before arming timers: an already-due one-shot must never fire into
    // the management-only gate and be lost.
    this.cutoverActivated = true
    this.scheduleEngine.startAll(Array.from(this.schedules.values()))
    this.cutoverRecoveryReason = null
  }

  // ============================================================================
  // Agent Config 协议方法
  // ============================================================================

  private async handleGetAgentConfig(params: { instance_id: string }, context?: RpcHandlerContext, attempt = 0): Promise<{
    config_revision: number
    config: CoreAgentRuntimeConfig
  }> {
    if (params.instance_id !== 'crabot-agent') {
      throw new Error('Only exact core Agent may pull runtime config')
    }
    const bearer = context?.authorizationBearer
    if (!bearer) throw new RpcError('UNAUTHORIZED', 'Missing runtime credential')
    await this.rpcClient.callModuleManagerSensitive(
      'verify_core_agent_runtime',
      { expected_module_id: 'crabot-agent' },
      this.config.moduleId,
      { authorizationBearer: bearer },
    )
    const coreRuntime = await this.rpcClient.callModuleManager<
      { module_id: 'crabot-agent' },
      { module_id: string; module_type: string; port: number }
    >('get_module', { module_id: 'crabot-agent' }, this.config.moduleId)
    if (coreRuntime.module_id !== 'crabot-agent' || coreRuntime.module_type !== 'agent' || !Number.isSafeInteger(coreRuntime.port)) {
      throw new Error('Invalid core Agent runtime definition')
    }
    const epochBefore = await this.configMutationCoordinator.readCommittedEpoch()
    if (epochBefore === null) {
      // A durable mutation performs several fsync writes and can hold the outbox for tens to
      // hundreds of milliseconds; give the coherent read a bounded window that outlasts a
      // normal mutation before failing closed (the Agent outer pull retries regardless).
      if (attempt >= 25) throw new Error('Core Agent config mutation is active; retry later')
      await new Promise((resolve) => setTimeout(resolve, 20))
      return this.handleGetAgentConfig(params, context, attempt + 1)
    }
    const config = this.agentManager.getConfig(params.instance_id)
    if (!config) {
      throw new Error(`Config not found for instance: ${params.instance_id}`)
    }

    // 未知 slot 不属于 v3 静态 core definition，拒绝而不是 fallback 到旧实现。
    const modelRoles = CORE_AGENT_DEFINITION.model_roles ?? []
    for (const key of Object.keys(config.model_config)) {
      if (!modelRoles.some((role) => role.key === key)) throw new Error(`Unknown core Agent model role: ${key}`)
    }

    // 全局默认 LLM 配置（作为 fallback，未配置时为 null）
    let globalLLM: LLMConnectionInfo | null = null
    try {
      globalLLM = await this.modelProviderManager.resolveModelConfig({
        module_id: params.instance_id,
        role: 'llm',
      }) as LLMConnectionInfo
    } catch {
      // 首次安装时全局 LLM 未配置，允许返回空 model_config
    }

    // 获取静态 core Agent model_roles（legacy registry不参与运行时）
    const impl = CORE_AGENT_DEFINITION

    // 实时解析每个 slot 引用为连接信息，按 model_roles 遍历
    const resolvedModelConfig: Record<string, LLMConnectionInfo> = {}

    for (const role of modelRoles) {
      const ref = config.model_config[role.key]
      const fallback = role.fallback ?? 'global_default'

      if (ref) {
        // 用户显式配置了此 slot
        try {
          resolvedModelConfig[role.key] = await this.modelProviderManager.buildConnectionInfo(
            ref.provider_id, ref.model_id
          ) as LLMConnectionInfo
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error)
          if (fallback === 'global_default' && globalLLM) {
            console.warn(`[Admin] Slot "${role.key}" ref resolve failed: ${msg}, using global default`)
            resolvedModelConfig[role.key] = globalLLM
          } else {
            console.warn(`[Admin] Slot "${role.key}" ref resolve failed: ${msg}, slot unavailable`)
          }
        }
      } else if (fallback === 'global_default' && globalLLM) {
        // 未配置 + fallback 到全局默认
        resolvedModelConfig[role.key] = globalLLM
      }
      // fallback === 'none' 且未配置 → 不加入 resolvedModelConfig
    }

    if (!resolvedModelConfig.powerful) {
      throw new RpcError('ADMIN_CORE_AGENT_MODEL_NOT_CONFIGURED', 'Core Agent powerful model is not configured')
    }

    // 所有 enabled MCP server 都对所有 agent 实例可见——
    // 不再区分 builtin / user-installed，不再读 config.mcp_server_ids（已 @deprecated）
    const enabledMcpServers = this.mcpServerManager.list().filter((s) => s.enabled)

    // 将 MCP server 配置转换为 Agent 格式，并为 scrapling 注入 CDP URL 环境变量
    const mcpServerConfigs = enabledMcpServers.map((s) => {
      const agentConfig = this.mcpServerManager.toAgentConfig(s)
      if (s.name === 'scrapling') {
        return {
          ...agentConfig,
          env: { ...agentConfig.env, BROWSER_CDP_URL: this.browserManager.cdpUrl },
        }
      }
      return agentConfig
    })

    // subagents：startup pull 时就带上，避免 Agent 启动期 subagents 空窗。
    // 历史 bug：subagents 只走 push 不走 get_agent_config → agent 启动时 this.subAgents 为空，
    // worker loop 在 push 送达前 snapshot 就拿到空列表 → goal 审计找不到 builtin-goal-auditor →
    // end-turn gate fail open → goal 任务没满足目标就被放完成。startup 就带上从根上消除该 race。
    const subagents = await this.buildSubAgentConfigsForPush(config, resolvedModelConfig)

    // 对外可达 base URL，供 agent 拼临时页面链接（<base>/tmp-pages/<id>）
    const tmpPageBaseUrl = resolveTmpPageBaseUrl(
      this.modelProviderManager.getGlobalConfig().public_base_url,
      this.adminConfig.web_port,
    )

    // 生图能力：解析全局图像 slot，随 config 推给 agent
    const imageFields = imageResultToConfigFields(
      await this.modelProviderManager.resolveImageConfig(),
    )

    const epoch = await this.configMutationCoordinator.readCommittedEpoch()
    if (epoch === null || epoch.revision !== epochBefore.revision || epoch.generation !== epochBefore.generation) {
      if (attempt >= 25) throw new Error('Core Agent config changed during resolution; retry later')
      await new Promise((resolve) => setTimeout(resolve, 20))
      return this.handleGetAgentConfig(params, context, attempt + 1)
    }
    // 实例配置为 slot 制；legacy front/worker roles 不下发，Agent 内部自行补齐。
    const resolvedAgentConfig: ResolvedAgentConfig = {
      ...config,
      model_config: resolvedModelConfig,
      tmp_page_base_url: tmpPageBaseUrl,
      mcp_servers: mcpServerConfigs,
      skills: this.skillManager.list()
        .filter((s) => {
          if (!s.enabled) return false
          if (!s.skill_dir) {
            console.warn(`[Admin] skill "${s.name}" (${s.id}) skill_dir missing — skipped from agent push`)
            return false
          }
          return true
        })
        .map((s) => this.skillManager.toAgentConfig(s)),
      subagents,
    }
    const runtimeConfig: CoreAgentRuntimeConfig = {
      module_id: 'crabot-agent',
      module_type: 'agent',
      version: '0.2.0',
      protocol_version: '3.1.1',
      port: coreRuntime.port,
      orchestration: coreAgentOrchestrationConfig(),
      agent_config: resolvedAgentConfig,
      ...imageFields,
      ...(config.extra ? { extra: config.extra } : {}),
      worker_implementations: await this.buildWorkerImplementationRuntimeConfig(),
    }
    delete runtimeConfig.agent_config.extra
    return {
      config_revision: epoch.revision,
      config: runtimeConfig,
    }
  }

  private async handleUpdateAgentConfig(params: UpdateAgentConfigParams): Promise<{
    config: AgentInstanceConfig
  }> {
    if (params.instance_id !== 'crabot-agent') {
      throw new RpcError('ADMIN_HOTPLUG_NOT_ALLOWED', 'Legacy Agent configuration is read-only')
    }
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
    res.end(JSON.stringify(await this.skillManager.toRestEntries(skills)))
  }

  private async handleCreateSkillApi(
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<void> {
    try {
      const params = await this.readJsonBody<Parameters<SkillManager['create']>[0]>(req)
      const skill = await this.skillManager.create(params)
      res.writeHead(201, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(await this.skillManager.toRestEntry(skill)))
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
    res.end(JSON.stringify(await this.skillManager.toRestEntry(skill)))
  }

  private async handleGetSkillPreviousContentApi(
    _req: IncomingMessage,
    res: ServerResponse,
    id: string,
  ): Promise<void> {
    const data = await this.skillManager.readPreviousContent(id)
    if (!data) {
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: '没有上一版' }))
      return
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(data))
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
      res.end(JSON.stringify(await this.skillManager.toRestEntry(skill)))
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
  // SubAgent REST API 处理方法
  // ============================================================================

  private async handleListSubAgentsApi(
    _req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const list = this.subAgentManager.list()
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(list))
  }

  private async handleGetSubAgentApi(
    _req: IncomingMessage,
    res: ServerResponse,
    id: string,
  ): Promise<void> {
    const entry = this.subAgentManager.get(id)
    if (!entry) {
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: `SubAgent not found: ${id}` }))
      return
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(entry))
  }

  private async handleCreateSubAgentApi(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    try {
      const body = await this.readJsonBody<Parameters<typeof this.subAgentManager.create>[0]>(req)
      const entry = await this.subAgentManager.create(body)
      res.writeHead(201, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(entry))
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: msg }))
    }
  }

  private async handleUpdateSubAgentApi(
    req: IncomingMessage,
    res: ServerResponse,
    id: string,
  ): Promise<void> {
    try {
      const body = await this.readJsonBody<Parameters<typeof this.subAgentManager.update>[1]>(req)
      const entry = await this.subAgentManager.update(id, body)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(entry))
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const status = msg.includes('not found') ? 404 : 400
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: msg }))
    }
  }

  private async handleDeleteSubAgentApi(
    _req: IncomingMessage,
    res: ServerResponse,
    id: string,
  ): Promise<void> {
    try {
      await this.subAgentManager.delete(id)
      res.writeHead(204)
      res.end()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const status = msg.includes('not found') ? 404 : 400
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: msg }))
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

  /**
   * 将 DuplicateSkillError 转为 409 响应。前端可据此弹确认框并重试（携带 overwrite:true）。
   */
  private writeDuplicateSkillResponse(res: ServerResponse, err: DuplicateSkillError): void {
    res.writeHead(409, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      error: err.message,
      code: err.code,
      existing: {
        id: err.existing.id,
        name: err.existing.name,
        version: err.existing.version,
        is_builtin: err.existing.is_builtin,
      },
      incoming: err.incoming,
    }))
  }

  private async handleInstallSkillGitApi(
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<void> {
    try {
      const body = await this.readJsonBody<{ skill_md_url: string; source_git_url?: string; overwrite?: boolean }>(req)
      const { entry, was_overwrite } = await this.skillManager.importFromGit(
        body.skill_md_url, body.source_git_url, body.overwrite,
      )
      res.writeHead(201, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ...await this.skillManager.toRestEntry(entry), was_overwrite }))
    } catch (err) {
      if (err instanceof DuplicateSkillError) {
        this.writeDuplicateSkillResponse(res, err)
        return
      }
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'install failed' }))
    }
  }

  private async handleImportSkillLocalApi(
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<void> {
    try {
      const body = await this.readJsonBody<{ dir_path: string; overwrite?: boolean }>(req)
      const { entry, was_overwrite } = await this.skillManager.importFromLocalPath(body.dir_path, body.overwrite)
      res.writeHead(201, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ...await this.skillManager.toRestEntry(entry), was_overwrite }))
    } catch (err) {
      if (err instanceof DuplicateSkillError) {
        this.writeDuplicateSkillResponse(res, err)
        return
      }
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
      const body = await this.readJsonBody<{ base64_content: string; filename: string; overwrite?: boolean }>(req, 70 * 1024 * 1024)
      const { entry, was_overwrite } = await this.skillManager.importFromZip(
        body.base64_content, body.filename, body.overwrite,
      )
      res.writeHead(201, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ...await this.skillManager.toRestEntry(entry), was_overwrite }))
    } catch (err) {
      if (err instanceof DuplicateSkillError) {
        this.writeDuplicateSkillResponse(res, err)
        return
      }
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'import failed' }))
    }
  }

  /**
   * POST /api/openclaw-import/parse — 流式接收 OpenClaw backup .tar.gz（可能 GB 级，
   * 直接 pipe 落临时文件，绝不 buffer 进内存），解析出备份概览。
   */
  private async handleOpenClawImportParseApi(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const store = this.openclawImportStore!
    const { token, path: tmpFile } = store.stage()
    try {
      await pipeline(req, createWriteStream(tmpFile))
      const result = await buildBackupOverview(tmpFile)
      if (!result.ok) {
        await store.discard(token)
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: result.error }))
        return
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ token, overview: result.overview }))
    } catch (err) {
      await store.discard(token)
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'parse failed' }))
    }
  }

  /**
   * POST /api/openclaw-import/execute — 按用户勾选执行导入，用后即焚临时归档。
   * body: { token, selections }
   */
  private async handleOpenClawImportExecuteApi(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const store = this.openclawImportStore!
    let activeToken: string | undefined
    try {
      const body = await this.readJsonBody<{ token: string; selections: ImportSelections }>(req)
      const archivePath = store.resolve(body.token)
      if (!archivePath) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: '上传 token 已失效，请重新上传备份' }))
        return
      }
      activeToken = body.token

      const memoryPort = await this.getMemoryPort()
      const deps = buildImportDeps({
        listProviderNames: () => this.modelProviderManager.listProviders().map((p) => p.name),
        createProvider: (p) => this.modelProviderManager.createProvider(p),
        listChannelNames: () => this.channelManager.listInstances().items.map((i) => i.name),
        createChannel: (p) => this.channelManager.createInstance(p),
        listMcpNames: () => this.mcpServerManager.list().map((s) => s.name),
        importMcpJson: (json) => this.mcpServerManager.importFromJson(json),
        listSkillNames: () => this.skillManager.list().map((s) => s.name),
        importSkillDir: (dir) => this.skillManager.importFromLocalPath(dir),
        writeLongTerm: (params) =>
          this.rpcClient.call(
            memoryPort,
            'write_long_term',
            { ...params, author: 'user', status: 'confirmed' },
            this.config.moduleId,
          ),
        workspaceDir: this.workspaceDir,
      })

      const tempDir = path.join(os.tmpdir(), `openclaw-import-work-${crypto.randomUUID()}`)
      const summary = await runImport({ archivePath, tempDir, selections: body.selections, deps })

      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(summary))
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'import failed' }))
    } finally {
      // 终态清理：成功 / 失败都丢弃暂存归档（取消/放弃由 TTL 清扫兜底）
      if (activeToken) await store.discard(activeToken)
    }
  }

  private async handleRestoreSkillApi(
    _req: IncomingMessage,
    res: ServerResponse,
    id: string,
  ): Promise<void> {
    try {
      const entry = await this.skillManager.restore(id)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(await this.skillManager.toRestEntry(entry)))
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'restore failed' }))
    }
  }

  private get workspaceDir(): string {
    return process.env.WORKSPACE_DIR || path.dirname(this.adminConfig.data_dir)
  }

  private async handleScanWorkspaceSkillsApi(
    _req: IncomingMessage,
    res: ServerResponse
  ): Promise<void> {
    try {
      const workspaceDir = this.workspaceDir
      const added = await this.skillManager.scanWorkspaceSkills(workspaceDir)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ added, workspace_dir: workspaceDir }))
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : '扫描失败' }))
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

    const result = await this.handleListAgentImplementations({
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
    if (id !== 'default') {
      res.writeHead(404)
      res.end(JSON.stringify({ error: 'Implementation not found' }))
      return
    }
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

    const result = await this.handleListAgentInstances({
      ...(implementationId ? { implementation_id: implementationId } : {}),
      ...(autoStartParam !== null ? { auto_start: autoStartParam === 'true' } : {}),
      page,
      page_size: pageSize,
    })

    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(result))
  }

  private async handleCreateInstanceApi(_req: IncomingMessage, res: ServerResponse): Promise<void> {
    res.writeHead(410, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ code: 'ADMIN_HOTPLUG_NOT_ALLOWED', error: 'Dynamic Agent instances are retired; only builtin crabot-agent is supported' }))
  }

  private async handleGetInstanceApi(
    _req: IncomingMessage,
    res: ServerResponse,
    id: string
  ): Promise<void> {
    if (id !== 'crabot-agent') {
      res.writeHead(404)
      res.end(JSON.stringify({ error: 'Instance not found' }))
      return
    }
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
    _req: IncomingMessage,
    res: ServerResponse,
    _id: string
  ): Promise<void> {
    sendJson(res, 410, { code: 'ADMIN_HOTPLUG_NOT_ALLOWED', error: 'Dynamic Agent instances are retired; legacy Agent records are read-only' })
  }

  private async handleDeleteInstanceApi(
    _req: IncomingMessage,
    res: ServerResponse,
    _id: string
  ): Promise<void> {
    sendJson(res, 410, { code: 'ADMIN_HOTPLUG_NOT_ALLOWED', error: 'Dynamic Agent instances are retired; legacy Agent records are read-only' })
  }

  // ============================================================================
  // Agent Config REST API
  // ============================================================================

  private async handleGetInstanceConfigApi(
    _req: IncomingMessage,
    res: ServerResponse,
    id: string
  ): Promise<void> {
    if (id !== 'crabot-agent') {
      res.writeHead(404)
      res.end(JSON.stringify({ error: 'Config not found' }))
      return
    }
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
    if (id !== 'crabot-agent') {
      sendJson(res, 410, { code: 'ADMIN_HOTPLUG_NOT_ALLOWED', error: 'Legacy Agent configuration is read-only' })
      return
    }
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
    // 权威守卫：module_id 会拼进配置文件路径。除 config 路由外，start/restart 也经
    // handleStartModuleAdmin 走到这里，故守卫必须落在文件 sink 而非仅路由层。
    // 解码后的穿越 id（如 ../../x）当作不存在处理，返回空配置。
    if (!isPathSafeSegment(params.module_id)) {
      return { config: {} }
    }
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
    // 权威守卫：写 sink 必须硬拒穿越 id，防止 ../ 逃逸出 module-configs 目录写任意文件
    if (!isPathSafeSegment(params.module_id)) {
      throw Object.assign(new Error('Invalid module id'), { code: 'INVALID_MODULE_ID' })
    }
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
    return { updated: true }
  }

  // ============================================================================
  // 模块生命周期控制
  // ============================================================================

  /**
   * 将全局模型配置构建为 env 变量（作为模块启动时的默认值）
   * 模块自身的显式配置可覆盖这些默认值
   */
  private async buildGlobalModelEnv(): Promise<Record<string, string>> {
    const env: Record<string, string> = {}
    const globalConfig = this.modelProviderManager.getGlobalConfig()

    try {
      if (globalConfig.default_llm_provider_id && globalConfig.default_llm_model_id) {
        const info = await this.modelProviderManager.buildConnectionInfo(
          globalConfig.default_llm_provider_id,
          globalConfig.default_llm_model_id
        ) as LLMConnectionInfo
        env.CRABOT_LLM_BASE_URL = info.endpoint
        env.CRABOT_LLM_MODEL = info.model_id
        env.CRABOT_LLM_API_KEY = info.apikey
        env.CRABOT_LLM_FORMAT = info.format
        // OAuth provider（openai-responses + ChatGPT Codex 后端）需要 ChatGPT-Account-Id header
        if (info.account_id) {
          env.CRABOT_LLM_ACCOUNT_ID = info.account_id
        }
      }
    } catch {
      console.warn('[Admin] buildGlobalModelEnv: failed to resolve global LLM config')
    }

    return env
  }

  /**
   * 构建 Memory 模块的 RPC 配置参数（仅 LLM；v3 起 embedding 子系统已移除）
   * 供 get_memory_config（模块启动 pull）和 syncGlobalConfigToMemoryModules（push）共用
   */
  private async buildMemoryRpcConfig(): Promise<{ llm?: Record<string, string> }> {
    const newEnv = await this.buildGlobalModelEnv()
    const rpcParams: { llm?: Record<string, string> } = {}
    if (newEnv.CRABOT_LLM_MODEL) {
      rpcParams.llm = {
        api_key: newEnv.CRABOT_LLM_API_KEY ?? '',
        base_url: newEnv.CRABOT_LLM_BASE_URL ?? '',
        model: newEnv.CRABOT_LLM_MODEL,
        format: newEnv.CRABOT_LLM_FORMAT ?? 'openai',
        ...(newEnv.CRABOT_LLM_ACCOUNT_ID ? { account_id: newEnv.CRABOT_LLM_ACCOUNT_ID } : {}),
      }
    }
    return rpcParams
  }

  /**
   * Memory 模块启动时调用此 RPC 拉取初始配置（pull 初始化）
   * 统一配置模式：模块启动 pull + 运行时 Admin push
   */
  private async handleGetMemoryConfig(_params: { instance_id: string }): Promise<{
    config: { llm?: Record<string, string> }
  }> {
    return { config: await this.buildMemoryRpcConfig() }
  }

  /**
   * 全局配置保存后，推送新配置到所有 Memory 模块（push 热更新）
   * 同时更新 module-configs 文件和内存缓存
   */
  private async syncGlobalConfigToMemoryModules(): Promise<void> {
    const newEnv = await this.buildGlobalModelEnv()
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

    // 2. 推送到所有运行中的 Memory 模块
    const rpcParams = await this.buildMemoryRpcConfig()

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
   * Debounced nonsecret config invalidation trigger; retained only for import/finalize callers.
   */
  private pushDebounceTimer?: NodeJS.Timeout
  private pushDebouncedReasons?: string[]
  private triggerPushAfter(reason: string): void {
    // 防御 Object.create 跳过 ctor 的场景（测试 fixture 常用）
    this.pushDebouncedReasons ??= []
    this.pushDebouncedReasons.push(reason)
    if (this.pushDebounceTimer) clearTimeout(this.pushDebounceTimer)
    this.pushDebounceTimer = setTimeout(() => {
      const reasons = Array.from(new Set(this.pushDebouncedReasons ?? []))
      this.pushDebouncedReasons = []
      this.pushDebounceTimer = undefined
      const reasonLabel = reasons.length === 1 ? reasons[0] : `${reasons.length} triggers: ${reasons.join(', ')}`
      this.publishAgentConfigInvalidation().catch((err: Error) => {
        console.warn(`[Admin] config invalidation after ${reasonLabel} failed:`, err.message)
      })
    }, 200)
    this.pushDebounceTimer.unref?.()
  }

  private async buildSubAgentConfigsForPush(
    agentInstanceConfig: AgentInstanceConfig,
    resolvedModelConfig: Record<string, LLMConnectionInfo>,
  ): Promise<SubAgentConfig[]> {
    const enabled = this.subAgentManager.listEnabled()
    const result: SubAgentConfig[] = []

    for (const entry of enabled) {
      let model: LLMConnectionInfo
      try {
        const spec = resolveSubAgentModel(entry)
        if (spec.mode === 'specific') {
          model = await this.modelProviderManager.buildConnectionInfo(
            spec.provider_id, spec.model_id
          )
        } else {
          // 直接复用 handleGetAgentConfig 已解析的 model_config——
          // 它已应用了 ModelRoleDefinition.fallback='global_default'：
          // 实例未配 + 有全局默认 LLM 时，resolvedModelConfig[role] 即全局默认。
          const resolved = resolvedModelConfig[spec.role]
          if (!resolved) {
            console.warn(
              `[Admin] SubAgent "${entry.name}" model_role=${spec.role} ` +
              `在实例 ${agentInstanceConfig.instance_id} 未配置且无全局默认 LLM 可回退，跳过`
            )
            continue
          }
          model = resolved
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.warn(`[Admin] SubAgent "${entry.name}" model 解析失败: ${msg}，跳过`)
        continue
      }

      result.push({
        id: entry.id,
        name: entry.name,
        description: entry.description,
        when_to_use: entry.when_to_use,
        role: entry.role,
        workflow: entry.workflow,
        deliverables: entry.deliverables,
        verification: entry.verification,
        model,
        builtin_capabilities: { ...entry.builtin_capabilities, crab_messaging: false },
        allowed_mcp_server_ids: entry.allowed_mcp_server_ids,
        allowed_skill_ids: entry.allowed_skill_ids,
        max_turns: entry.max_turns,
        hook_preset: entry.hook_preset,
        system_only: entry.system_only,
      })
    }

    if (enabled.length > 0 && result.length === 0) {
      console.error(
        `[Admin] 0/${enabled.length} subagents 推送给 agent — 全部模型解析失败，` +
        `请检查全局 LLM Provider 配置 / 实例 model_config / subagent provider+model 引用`
      )
    }
    return result
  }

  /**
   * 启动末尾的主动配置对账：补推配置给「已在运行」的 agent / memory 模块。
   *
   * onEvent 里的 module_started 推送只能覆盖「admin 订阅之后才启动」的模块。但 admin 只在
   * onStart 重活（loadData / 供应商初始化 / 起 web server）跑完、再 register() 时才订阅事件；
   * 若 admin 单独重启、或启动慢于 agent（system mode 版本检查等会拖慢），agent 的 module_started
   * 会在 admin 订阅前就发完且不重放 → 永久错过 → agent 卡 unconfigured（"未配置 LLM" +
   * bg-entities "Worker handler not initialized"）。
   *
   * 本方法在 register()（订阅已生效）之后调用：订阅覆盖「未来启动」的模块，本快照覆盖「当下已在
   * 运行」的模块，两者无缝衔接、消除竞态。端口经 MM resolve 自解析，无运行模块时安全 no-op。
   */
  async reconcileRunningModuleConfigs(): Promise<void> {
    await this.configMutationCoordinator.drainPendingInvalidation()
    await this.publishAgentConfigInvalidation()
    await this.syncGlobalConfigToMemoryModules().catch((err: Error) => {
      console.warn('[Admin] 启动对账同步 memory 配置失败:', err.message)
    })
  }

  private readCoreAgentSemanticSnapshot(): unknown {
    const core = this.agentManager.getSemanticCoreConfig()
    const global = this.modelProviderManager.getGlobalConfig()
    const providers = this.modelProviderManager.listProviders()
      .map((provider) => ({
        id: provider.id,
        type: provider.type,
        format: provider.format,
        endpoint: provider.endpoint,
        status: provider.status,
        auth_type: provider.auth_type ?? null,
        api_key: provider.api_key,
        oauth_credential: provider.oauth_credential ?? null,
        models: provider.models,
      }))
      .sort((left, right) => left.id.localeCompare(right.id))
    return {
      core_agent: core ? {
        model_config: core.model_config,
        system_prompt: core.system_prompt,
        max_iterations: core.max_iterations,
        tools_readonly: core.tools_readonly,
        timezone: core.timezone ?? null,
        extra: core.extra ?? {},
      } : null,
      global: {
        default_llm_provider_id: global.default_llm_provider_id ?? null,
        default_llm_model_id: global.default_llm_model_id ?? null,
        default_image_provider_id: global.default_image_provider_id ?? null,
        default_image_model_id: global.default_image_model_id ?? null,
        image_slot_user_set: global.image_slot_user_set ?? null,
        public_base_url: global.public_base_url ?? null,
      },
      providers,
      mcp_servers: this.mcpServerManager.runtimeSemanticEntries(),
      subagents: this.subAgentManager.runtimeSemanticEntries(),
      subagent_storage: this.subAgentManager.semanticMigrationState(),
      skills: this.skillManager.runtimeSemanticEntries(),
      skill_storage: this.skillManager.semanticMigrationState(),
      worker_implementations: this.workerImplementationStore.runtimeSemanticEntries(),
    }
  }

  /**
   * publish 失败会把 outbox 卡在 committed/invalidation_pending；运行期必须有重试入口，
   * 否则一致性读与后续 mutation 都会被永久锁死（只能重启 Admin）。退避重试 drain，
   * 成功后复位退避；MM 短暂不可用（重启窗口/超时）恢复后自愈。
   */
  private scheduleConfigDrainRetry(): void {
    if (this.configDrainRetryTimer) return
    const delay = this.configDrainRetryDelayMs
    this.configDrainRetryDelayMs = Math.min(this.configDrainRetryDelayMs * 2, 30_000)
    this.configDrainRetryTimer = setTimeout(() => {
      this.configDrainRetryTimer = undefined
      this.configMutationCoordinator.drainPendingInvalidation()
        .then(() => { this.configDrainRetryDelayMs = 1_000 })
        .catch((error) => {
          console.warn('[Admin] config invalidation drain retry failed:', error instanceof Error ? error.message : String(error))
          this.scheduleConfigDrainRetry()
        })
    }, delay)
    this.configDrainRetryTimer.unref?.()
  }

  private async publishCurrentAgentConfigInvalidation(): Promise<void> {
    const revision = (await this.configMutationCoordinator.current()).revision
    await this.publishAdminEventDurable('admin.agent_config_invalidated', {
      config_revision: revision,
      domains: ['models', 'image', 'mcp', 'skills', 'subagents', 'behavior'],
    })
  }

  private async publishAgentConfigInvalidation(): Promise<boolean> {
    if (!this.cutoverActivated) return false
    await this.publishCurrentAgentConfigInvalidation()
    return true
  }

  /**
   * 推送代理配置到所有运行中的模块
   */
  private async pushProxyConfigToAllModules(proxyConfig?: ProxyConfig): Promise<void> {
    const config = proxyConfig ?? this.modelProviderManager.getProxyConfig()
    const params = { proxy: config }

    try {
      const result = await this.rpcClient.callModuleManager<
        Record<string, never>,
        { modules: Array<{ module_id: string; module_type: string; port: number; status: string }> }
      >('list_modules', {}, this.config.moduleId)

      const PROXY_SUPPORTED_TYPES = new Set(['agent', 'channel'])
      const pushPromises = result.modules
        .filter(m => m.module_id !== this.config.moduleId && m.status === 'running' && m.port > 0 && PROXY_SUPPORTED_TYPES.has(m.module_type))
        .map(m =>
          this.rpcClient.call(m.port, 'update_proxy_config', params, this.config.moduleId)
            .catch((err: Error) => {
              console.warn(`[Admin] Failed to push proxy config to ${m.module_id}:`, err.message)
            })
        )
      await Promise.allSettled(pushPromises)
    } catch (err) {
      console.warn('[Admin] Failed to resolve modules for proxy push:', err)
    }
  }

  /**
   * 推送代理配置到指定模块（模块启动时的安全网）
   */
  private async pushProxyConfigToModule(moduleId: string): Promise<void> {
    const PROXY_SUPPORTED_TYPES = new Set(['agent', 'channel'])
    try {
      const modules = await this.rpcClient.resolve({ module_id: moduleId }, this.config.moduleId)
      const target = modules[0]
      if (!target || !PROXY_SUPPORTED_TYPES.has(target.module_type) || target.status !== 'running') return

      const config = this.modelProviderManager.getProxyConfig()
      await this.rpcClient.call(target.port, 'update_proxy_config', { proxy: config }, this.config.moduleId)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.warn(`[Admin] Failed to push proxy config to ${moduleId}:`, msg)
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

  private async resolveModuleStartEnv(moduleId: string): Promise<Record<string, string>> {
    // Core Agent runtime secrets are available only via authenticated get_agent_config pull.
    // Never copy provider credentials into an MM lifecycle request or process environment.
    if (moduleId === 'crabot-agent') return {}

    // Channel 模块的配置存在 channel-configs/ 目录，其他模块在 module-configs/。
    const channelInstance = this.channelManager.getInstance(moduleId)
    const config = channelInstance
      ? await this.channelManager.loadLocalConfig(moduleId) ?? {}
      : (await this.handleGetModuleConfig({ module_id: moduleId })).config

    // Admin 是模型配置的唯一真相来源；实时解析结果覆盖模块文件中的旧模型字段。
    return { ...config, ...await this.buildGlobalModelEnv() }
  }

  private async handleStartModuleAdmin(params: {
    module_id: string
  }): Promise<{ status: 'accepted'; tracking_id: string }> {
    const mergedConfig = params.module_id === 'crabot-agent'
      ? undefined
      : await this.resolveModuleStartEnv(params.module_id)

    // 调用 MM 的 start_module，注入配置为 env
    const mmEndpoint = process.env.CRABT_MM_ENDPOINT || process.env.CRABOT_MM_ENDPOINT || 'http://localhost:19000'
    const response = await fetch(`${mmEndpoint}/start_module`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: generateId(),
        params: {
          module_id: params.module_id,
          ...(mergedConfig ? { env: mergedConfig } : {}),
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
    force?: boolean
  }): Promise<{ status: 'accepted'; tracking_id: string }> {
    const env = params.module_id === 'crabot-agent'
      ? undefined
      : await this.resolveModuleStartEnv(params.module_id)
    const mmEndpoint = process.env.CRABT_MM_ENDPOINT || process.env.CRABOT_MM_ENDPOINT || 'http://localhost:19000'
    const response = await fetch(`${mmEndpoint}/restart_module`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: generateId(),
        params: {
          module_id: params.module_id,
          force: params.force,
          ...(env ? { env } : {}),
        },
      }),
    })

    const result = (await response.json()) as { success: boolean; error?: { message: string }; data?: { status: 'accepted'; tracking_id: string } }
    if (!result.success) {
      throw new Error(result.error?.message ?? 'restart_module failed')
    }
    return result.data!
  }

  // ============================================================================
  // PermissionTemplate RPC 方法
  // ============================================================================

  private async handleListPermissionTemplates(params: { system_only?: boolean; page?: number; page_size?: number }): Promise<{ items: PermissionTemplate[]; total: number }> {
    const all = this.permissionTemplateManager.list(params.system_only)
    const page = params.page ?? 1
    const pageSize = params.page_size ?? 50
    const start = (page - 1) * pageSize
    return { items: all.slice(start, start + pageSize), total: all.length }
  }

  private async handleGetPermissionTemplate(params: { template_id: string }): Promise<{ template: PermissionTemplate }> {
    const template = this.permissionTemplateManager.get(params.template_id)
    if (!template) {
      throw Object.assign(new Error('Template not found'), { code: 'NOT_FOUND' })
    }
    return { template }
  }

  private async handleCreatePermissionTemplate(params: CreatePermissionTemplateParams): Promise<{ template: PermissionTemplate }> {
    const template = this.permissionTemplateManager.create(params)
    await this.saveData()
    return { template }
  }

  private async handleUpdatePermissionTemplate(params: UpdatePermissionTemplateParams): Promise<{ template: PermissionTemplate }> {
    const { template_id, ...rest } = params
    const template = this.permissionTemplateManager.update(template_id, rest)
    await this.saveData()
    return { template }
  }

  private async handleDeletePermissionTemplate(params: { template_id: string }): Promise<{ deleted: true }> {
    const isInUse = (templateId: string) => {
      for (const friend of this.friends.values()) {
        if (friend.permission_template_id === templateId) return true
      }
      return false
    }
    this.permissionTemplateManager.delete(params.template_id, isInUse)
    await this.saveData()
    return { deleted: true }
  }

  private normalizeFriendPermissionConfig(friend: Friend, config: FriendPermissionConfig): FriendPermissionConfig {
    // 兜底：旧持久化数据可能缺失 cli_access，或仅含部分 domain。
    // 缺失时按 'none' 默认补齐，避免后续 resolution 抛错。
    const incomingCli = config.cli_access as Partial<CliAccessConfig> | undefined
    const cliAccess: CliAccessConfig =
      incomingCli && CLI_DOMAINS.every((d) => d in incomingCli)
        ? { ...(incomingCli as CliAccessConfig) }
        : { ...createCliAccessConfig('none'), ...(incomingCli ?? {}) }

    if (friend.permission === 'master') {
      return {
        tool_access: { ...config.tool_access },
        cli_access: cliAccess,
        storage: config.storage ? { ...config.storage } : null,
        memory_scopes: [...config.memory_scopes],
        updated_at: config.updated_at,
      }
    }

    return {
      tool_access: { ...config.tool_access, desktop: false },
      cli_access: cliAccess,
      storage: config.storage ? { ...config.storage } : null,
      memory_scopes: [...config.memory_scopes],
      updated_at: config.updated_at,
    }
  }

  private resolveFriendTemplateId(friend: Friend): string | null {
    if (friend.permission === 'master') {
      return 'master_private'
    }
    return friend.permission_template_id ?? 'standard'
  }

  /**
   * 系统触发的一次性任务（记忆图谱重建 / self-healing recovery）执行权限。
   * 这类任务无 creator friend，统一用 master_private（最高权限，含 memory/file/shell），
   * 否则 worker 走 FAIL_CLOSED 拿不到任何工具，跑一轮空转就结束。
   */
  private resolveSystemTaskPermissions(): ResolvedPermissions | null {
    try {
      return this.permissionTemplateManager.resolvePermissions('master_private', null)
    } catch (err) {
      console.error('[Admin] master_private template missing for system task dispatch:', err)
      return null
    }
  }

  private buildResolvedFriendPermissions(friend: Friend): ResolvedPermissions | null {
    if (friend.permission === 'master') {
      return this.permissionTemplateManager.resolvePermissions('master_private', null)
    }

    const explicitConfig = this.friendPermissionConfigs.get(friend.id) ?? null
    if (explicitConfig) {
      const normalizedConfig = this.normalizeFriendPermissionConfig(friend, explicitConfig)
      return {
        tool_access: { ...normalizedConfig.tool_access },
        cli_access: { ...normalizedConfig.cli_access },
        storage: normalizedConfig.storage ? { ...normalizedConfig.storage } : null,
        memory_scopes: [...normalizedConfig.memory_scopes],
      }
    }

    const templateId = this.resolveFriendTemplateId(friend)
    if (!templateId) {
      return null
    }
    try {
      return this.permissionTemplateManager.resolvePermissions(templateId, null)
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'NOT_FOUND') {
        return null
      }
      throw error
    }
  }

  /**
   * 解析"消息发起人"的 effective permissions（friend ∪ session 并集）
   *
   * 设计意图：让 hook 层用统一一份 ResolvedPermissions 判断 cli_access / tool_access，
   * 不再在 agent 侧分私聊/群聊两条解析路径。
   *
   * 语义：
   * - master friend 短路：直接返回 master_private 模板的解析结果
   * - 非 master：friend ResolvedPermissions ∪ session ResolvedPermissions
   * - 都缺：fallback 到 minimal 模板
   */
  private async resolvePrincipalPermissions(
    params: ResolvePrincipalPermissionsParams,
  ): Promise<ResolvePrincipalPermissionsResult> {
    const sources: ResolvePrincipalPermissionsResult['sources'] = {}

    // 1. friend 侧
    let friendResolved: ResolvedPermissions | null = null
    if (params.sender_friend_id) {
      // 'master' 是 admin chat 的合成身份（chat-manager 固定 friend_id='master'，
      // admin web 经 JWT 认证，对话者必然是 master 本人）：映射到真实 master friend；
      // 无 master friend 记录时直接按 master_private 模板解析。
      // 修复前 friends.get('master') 查不到 → 落 minimal → worker 工具全被滤光。
      const friend = this.friends.get(params.sender_friend_id)
        ?? (params.sender_friend_id === 'master' ? this.findMasterFriend() : undefined)
      if (friend) {
        friendResolved = this.buildResolvedFriendPermissions(friend)
        sources.friend_template_id = friend.permission === 'master'
          ? 'master_private'
          : (friend.permission_template_id ?? 'standard')

        // master 短路：直接返回，跳过 session 合并
        if (friend.permission === 'master' && friendResolved) {
          return { resolved: friendResolved, sources }
        }
      } else if (params.sender_friend_id === 'master') {
        sources.friend_template_id = 'master_private'
        return {
          resolved: this.permissionTemplateManager.resolvePermissions('master_private', null),
          sources,
        }
      }
    }

    // 2. session 侧
    // 群聊：始终以 group_default 作为基底（叠 sessionConfig 字段覆盖），
    //   非 friend 发言人也按群聊默认权限处理 —— 这是合并 resolveGroupPermissions 时
    //   语义遗失的回填（commit c609772 引入的 regression）。
    // 私聊：仅当 sessionConfig 显式 template_id 时才解析；陌生人走 minimal 兜底。
    let sessionResolved: ResolvedPermissions | null = null
    const sessionConfig = this.sessionConfigs.get(params.session_id) ?? null
    const sessionTemplateId = sessionConfig?.template_id
      ?? (params.session_type === 'group' ? 'group_default' : null)
    if (sessionTemplateId) {
      try {
        sessionResolved = this.permissionTemplateManager.resolvePermissions(
          sessionTemplateId,
          sessionConfig,
        )
        sources.session_template_id = sessionTemplateId
      } catch (err) {
        console.warn(`[Admin] resolvePrincipalPermissions: session template '${sessionTemplateId}' missing for session ${params.session_id}:`, err)
      }
    }

    // 3. 都没有 → minimal 兜底（仅私聊路径会到这里；群聊已被 group_default 兜住）
    if (!friendResolved && !sessionResolved) {
      sources.fallback = 'minimal'
      return {
        resolved: this.permissionTemplateManager.resolvePermissions('minimal', null),
        sources,
      }
    }

    // 4. 取并集
    const merged = unionResolved(friendResolved, sessionResolved)
    if (!merged) {
      // 不可达：以上前提保证至少一方非 null，但兜底 minimal
      sources.fallback = 'minimal'
      return {
        resolved: this.permissionTemplateManager.resolvePermissions('minimal', null),
        sources,
      }
    }
    return { resolved: merged, sources }
  }

  private async handleGetFriendPermission(friendId: FriendId): Promise<GetFriendPermissionResult> {
    const friend = this.friends.get(friendId)
    if (!friend) {
      throw new Error('Friend not found')
    }

    const config = this.friendPermissionConfigs.get(friendId)
      ? this.normalizeFriendPermissionConfig(friend, this.friendPermissionConfigs.get(friendId)!)
      : null
    const resolved = this.buildResolvedFriendPermissions(friend)
    return { config, resolved }
  }

  private async handleUpdateFriendPermission(
    friendId: FriendId,
    config: UpdateFriendPermissionBody['config'],
  ): Promise<{ config: FriendPermissionConfig }> {
    const friend = this.friends.get(friendId)
    if (!friend) {
      throw new Error('Friend not found')
    }
    if (friend.permission === 'master') {
      throw new Error('Cannot update master friend permissions')
    }

    // body.config 类型层 require cli_access（来自 Omit<FriendPermissionConfig, 'updated_at'>），
    // 但旧 client 可能未升级；在此做运行时兜底，避免破坏 forward-compat。
    const incomingCli = (config as { cli_access?: CliAccessConfig }).cli_access
    const nextConfig = this.normalizeFriendPermissionConfig(friend, {
      tool_access: { ...config.tool_access, desktop: false },
      cli_access: incomingCli ? { ...incomingCli } : createCliAccessConfig('none'),
      storage: config.storage ? { ...config.storage } : null,
      memory_scopes: [...config.memory_scopes],
      updated_at: generateTimestamp(),
    })

    this.friendPermissionConfigs.set(friendId, nextConfig)
    await this.saveData()
    return { config: nextConfig }
  }

  // ============================================================================
  // Session 配置 RPC 方法
  // ============================================================================

  private async handleGetSessionConfig(params: { session_id: string }): Promise<{ config: SessionPermissionConfig | null }> {
    const config = this.sessionConfigs.get(params.session_id) ?? null
    return { config }
  }

  private async handleUpdateSessionConfig(params: { session_id: string; config: SessionPermissionConfig }): Promise<{ config: SessionPermissionConfig }> {
    const config: SessionPermissionConfig = {
      ...params.config,
      updated_at: generateTimestamp(),
    }
    this.sessionConfigs.set(params.session_id, config)
    await this.saveData()
    return { config }
  }

  private async handleDeleteSessionConfig(params: { session_id: string }): Promise<{ deleted: boolean }> {
    const existed = this.sessionConfigs.delete(params.session_id)
    if (existed) {
      await this.saveData()
    }
    return { deleted: existed }
  }

  // Session 配置 REST API

  private async handleGetSessionConfigApi(res: ServerResponse, sessionId: string): Promise<void> {
    const result = await this.handleGetSessionConfig({ session_id: sessionId })
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(result))
  }

  private async handleUpdateSessionConfigApi(req: IncomingMessage, res: ServerResponse, sessionId: string): Promise<void> {
    const body = await this.readJsonBody<{ config: SessionPermissionConfig }>(req)
    const result = await this.handleUpdateSessionConfig({ session_id: sessionId, config: body.config })
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(result))
  }

  private async handleDeleteSessionConfigApi(res: ServerResponse, sessionId: string): Promise<void> {
    const result = await this.handleDeleteSessionConfig({ session_id: sessionId })
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(result))
  }

  private async handleGetFriendPermissionApi(res: ServerResponse, friendId: FriendId): Promise<void> {
    try {
      const result = await this.handleGetFriendPermission(friendId)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ config: result.config, resolved: result.resolved }))
    } catch (error) {
      if (error instanceof Error && error.message === 'Friend not found') {
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Friend not found' }))
        return
      }
      throw error
    }
  }

  private async handleUpdateFriendPermissionApi(
    req: IncomingMessage,
    res: ServerResponse,
    friendId: FriendId,
  ): Promise<void> {
    const body = await this.readJsonBody<UpdateFriendPermissionBody>(req)
    try {
      const result = await this.handleUpdateFriendPermission(friendId, body.config)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ config: result.config }))
    } catch (error) {
      if (error instanceof Error && error.message === 'Cannot update master friend permissions') {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Cannot update master friend permissions' }))
        return
      }
      if (error instanceof Error && error.message === 'Friend not found') {
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Friend not found' }))
        return
      }
      throw error
    }
  }

  // ============================================================================
  // Chat RPC 方法
  // ============================================================================

  private async handleConsumeAdminChatAssertion(params: {
    assertion: string
    expected: { manager_key: 'admin-web::admin-chat'; request_id: string; payload_sha256: string }
  }): Promise<{ consumed: true; expires_at: string }> {
    if (!this.chatManager) throw new Error('chat not ready')
    return this.chatManager.consumeAdminChatAssertion(params)
  }

  private async handleChatCallback(params: ChatCallbackParams): Promise<ChatCallbackResult> {
    if (!this.chatManager) {
      throw new Error('Chat manager not initialized')
    }
    return this.chatManager.handleChatCallback(params)
  }

  private async handleChatSendMessage(params: ChatSendMessageParams): Promise<ChatSendMessageResult> {
    if (!this.chatManager) {
      throw new Error('Chat manager not initialized')
    }
    return this.chatManager.handleSendMessage(params)
  }

  /** admin-web 来源的非终态任务快照（进行中任务条数据源） */
  private listActiveChatTaskSnapshots(): ChatTaskSnapshot[] {
    const NON_TERMINAL: ReadonlySet<TaskStatus> = new Set(['pending', 'planning', 'executing', 'waiting', 'waiting_human'])
    return Array.from(this.tasks.values())
      .filter((t) => t.source.channel_id === 'admin-web' && NON_TERMINAL.has(t.status))
      .map((t) => buildChatTaskSnapshot(t))
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
        // Phase 2 起透传结构化 content（含 media[]），供 agent 侧 media-resolver 消费
        content: {
          type: msg.content.type,
          ...(msg.content.text !== undefined ? { text: msg.content.text } : {}),
          ...(msg.content.media_url !== undefined ? { media_url: msg.content.media_url } : {}),
          ...(msg.content.media !== undefined ? { media: msg.content.media } : {}),
        },
        features: { is_mention_crab: false as const },
        platform_timestamp: msg.timestamp,
        ...(msg.task_id ? { task_id: msg.task_id } : {}),
      })),
    }
  }

  // ============================================================================
  // 媒体文件 REST API
  // ============================================================================

  /** GET /api/media/:id — 自行认证（?token= 或 Authorization header），返回文件字节流 */
  private async handleGetMediaApi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    // 自行认证：?token= 或 Authorization header（与 /ws/chat 同模式）
    const token = url.searchParams.get('token')
      ?? (req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : null)
    let ok = false
    try {
      ok = !!(token && (await verifyJwtWithEpoch(token, this.jwtSecret, this.adminConfig.data_dir)))
    } catch { ok = false }
    if (!ok) {
      sendJson(res, 401, { error: 'Unauthorized' })
      return
    }
    const id = decodeURIComponent(url.pathname.slice('/api/media/'.length))
    const resolved = this.mediaStore?.resolve(id)
    if (!resolved) {
      sendJson(res, 404, { error: 'media not found or expired' })
      return
    }
    try {
      const buf = await fs.readFile(resolved.abs_path)
      res.writeHead(200, {
        'Content-Type': resolved.mime_type,
        'Content-Length': buf.length,
        'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(resolved.filename)}`,
        'Cache-Control': 'private, max-age=86400',
      })
      res.end(buf)
    } catch {
      sendJson(res, 404, { error: 'media not found or expired' })
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

  /** POST /api/chat/messages — multipart/form-data 消息入口（文字 + N 附件） */
  private async handlePostChatMessageApi(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.chatManager) {
      sendJson(res, 503, { error: 'chat not ready' })
      return
    }
    const MAX_FILE = 25 * 1024 * 1024
    const MAX_TOTAL = 100 * 1024 * 1024
    const contentLength = Number(req.headers['content-length'] ?? 0)
    if (contentLength > MAX_TOTAL) {
      sendJson(res, 413, { error: '请求体过大（上限 100MB）' })
      return
    }
    try {
      // 手动缓冲 body 并按累计字节硬熔断：Content-Length 预检对 chunked（无声明长度）
      // 请求无效，必须在读流时设上限，否则 formData() 会无界缓冲进内存
      const chunks: Buffer[] = []
      let totalBytes = 0
      for await (const chunk of req) {
        const buf = chunk as Buffer
        totalBytes += buf.length
        if (totalBytes > MAX_TOTAL) {
          sendJson(res, 413, { error: '请求体过大（上限 100MB）' })
          req.destroy()
          return
        }
        chunks.push(buf)
      }
      // Node 18+ 内建 multipart 解析：body 已缓冲为 Buffer，无需 stream duplex
      const RequestClass = Request as unknown as new (url: string, init: Record<string, unknown>) => { formData(): Promise<{ get(k: string): unknown; getAll(k: string): unknown[] }> }
      const request = new RequestClass('http://localhost/api/chat/messages', {
        method: 'POST',
        headers: req.headers,
        body: Buffer.concat(chunks),
      })
      const form = await request.formData()
      const text = String(form.get('text') ?? '')
      const requestId = String(form.get('request_id') ?? '')
      if (!requestId) {
        sendJson(res, 400, { error: 'request_id required' })
        return
      }
      const files: Array<{ buffer: Buffer; filename: string; mime_type: string }> = []
      // File 类在 Node 20+ 全局可用；使用 as unknown 绕过 tsconfig 中未含 DOM lib 的类型限制
      const FileClass = (globalThis as unknown as { File: new (...args: unknown[]) => { name: string; type: string; arrayBuffer(): Promise<ArrayBuffer> } }).File
      for (const value of form.getAll('files')) {
        if (!FileClass || !(value instanceof FileClass)) continue
        const buffer = Buffer.from(await value.arrayBuffer())
        if (buffer.length > MAX_FILE) {
          sendJson(res, 413, { error: `文件 ${value.name} 超过 25MB 上限` })
          return
        }
        files.push({ buffer, filename: value.name, mime_type: value.type || 'application/octet-stream' })
      }
      const authorization = req.headers.authorization ?? ''
      const jwt = authorization.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : ''
      const result = await this.chatManager.handleInboundMessage(
        { request_id: requestId, text, files },
        jwt,
      )
      sendJson(res, 200, result)
    } catch (err) {
      sendJson(res, 400, { error: err instanceof Error ? err.message : 'invalid multipart request' })
    }
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
        extra_schema: defaultImpl.extra_schema ?? [],
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

  private agentPort = 0

  /**
   * 模块意外退出/不健康时清相应类型的端口缓存。
   * agent 模块清 agentPort；memory 模块清 memoryModules 列表的对应项。
   */
  private invalidatePortCache(moduleId: string, moduleType: string): void {
    if (moduleId === 'crabot-agent') {
      if (this.agentPort > 0) {
        console.log(`[Admin] Invalidating cached agentPort=${this.agentPort} for ${moduleId}`)
        this.agentPort = 0
      }
    }
    if (moduleType === 'memory' || moduleType === 'unknown') {
      const before = this.memoryModules.length
      this.memoryModules = this.memoryModules.filter((m) => m.module_id !== moduleId)
      if (this.memoryModules.length !== before) {
        console.log(`[Admin] Invalidated cached memory port for ${moduleId}`)
      }
    }
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

  /**
   * 包装 RPC 调 agent，遇 ECONNREFUSED 自动清缓存重试一次。
   * 调用方应该用这个而不是裸 rpcClient.call(agentPort, ...)。
   */
  private async callAgentRpc<P, R>(method: string, params: P): Promise<R> {
    this.assertIngressOpen()
    const tryOnce = async (): Promise<R> => {
      const port = await this.ensureAgentPort()
      if (!port) throw new Error('Agent not available')
      return this.rpcClient.call<P, R>(port, method, params, this.config.moduleId)
    }
    try {
      return await tryOnce()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes('ECONNREFUSED') || msg.includes('connect failed')) {
        console.log(`[Admin] callAgentRpc(${method}) hit ECONNREFUSED, clearing cache and retrying once...`)
        this.agentPort = 0
        return tryOnce() // 再试一次（让 resolve 拿新端口或抛 503-style 错误）
      }
      throw err
    }
  }

  /**
   * `/api/agent/*` 转发端点的统一样板：调 agent RPC → 200 回传结果；失败按 agent 可达性
   * 映射 503（agent 不可达，固定文案）/ 500（其余，回传原始 message）。
   *
   * 抽自（P6-A 已退役的）raw v2 trace 端点**逐字相同**的 catch 块（P5 Task 5，纯重构）。
   * `notFoundWhen` 保留 detail 类端点的 404 分支——不传时行为与抽取前
   * 完全一致；该分支优先于 503/500 判定，与原实现的判定顺序相同。
   */
  private async proxyAgentRpc<P, R>(
    res: ServerResponse,
    method: string,
    params: P,
    notFoundWhen?: (message: string) => boolean,
  ): Promise<void> {
    try {
      const result = await this.callAgentRpc<P, R>(method, params)
      sendJson(res, 200, result)
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      if ((error as { code?: unknown }).code === 'ADMIN_CORE_AGENT_CUTOVER_INCOMPLETE') {
        sendJson(res, 503, { error: msg })
        return
      }
      if (notFoundWhen?.(msg)) {
        sendJson(res, 404, { error: msg })
        return
      }
      // 客户端输入错误（非法 cursor/参数）是 400，不是服务端 500。
      // code 在 RpcCallError 上（message 只是人读文本），两者都认。
      const errCode = (error as { code?: unknown }).code
      if (errCode === 'INVALID_PARAMS' || msg.includes('INVALID_PARAMS')) {
        sendJson(res, 400, { error: msg })
        return
      }
      const isUnreachable =
        msg.includes('Agent not available') ||
        msg.includes('ECONNREFUSED') ||
        msg.includes('connect failed')
      sendJson(res, isUnreachable ? 503 : 500, { error: isUnreachable ? 'Agent not available' : msg })
    }
  }

  /**
   * §6.5/§3.19.12 resolve_worker_connection：Agent-only、operation-time 实时解析。
   * - runtime bearer 先经 MM verify_core_agent_runtime 验证 exact core Agent；
   * - provider/model 引用只从 Admin persisted policy 取，不接受调用方临时引用；
   * - 每次调用唯一 buildConnectionInfo 实时解析，失败不 fallback snapshot；
   * - connection_revision 为 opaque HMAC（nonsecret invalidation signal）。
   */
  private async handleResolveWorkerConnection(
    params: { impl?: unknown; expected_policy_revision?: unknown },
    context?: RpcHandlerContext,
  ): Promise<{ connection: LLMConnectionInfo; connection_revision: string; policy_revision: number }> {
    const bearer = context?.authorizationBearer
    if (!bearer) throw new RpcError('UNAUTHORIZED', 'Missing runtime credential')
    await this.rpcClient.callModuleManagerSensitive(
      'verify_core_agent_runtime',
      { expected_module_id: 'crabot-agent' },
      this.config.moduleId,
      { authorizationBearer: bearer },
    )
    const impl = params.impl
    if (impl !== 'claude-code' && impl !== 'codex') {
      throw new RpcError('INVALID_PARAMS', 'impl must be claude-code or codex')
    }
    const desired = await this.workerImplementationStore.load()
    if (typeof params.expected_policy_revision !== 'number' || params.expected_policy_revision !== desired.revision) {
      throw new RpcError('CONFLICT', `worker implementation policy revision mismatch (current ${desired.revision})`)
    }
    const policy = desired.implementations[impl]
    if (!policy.enabled || policy.connection?.mode !== 'admin_provider') {
      throw new RpcError('INVALID_PARAMS', `${impl} is not enabled with admin_provider connection`)
    }
    // 每次调用实时解析；provider 不存在/解析失败直接 fail loud。
    const provider = this.modelProviderManager.getProvider(policy.connection.provider_id)
    if (!provider) {
      throw new RpcError('NOT_FOUND', `provider not found: ${policy.connection.provider_id}`)
    }
    const connection = await this.modelProviderManager.buildConnectionInfo(
      policy.connection.provider_id,
      policy.connection.model_id,
    ) as LLMConnectionInfo
    const revision = await this.workerConnectionRevisionSigner.compute({
      policy_revision: desired.revision,
      provider_id: provider.id,
      model_id: policy.connection.model_id,
      endpoint: provider.endpoint,
      credential_material: provider.api_key ?? '',
    })
    return { connection, connection_revision: revision, policy_revision: desired.revision }
  }

  /**
   * §3.19.12 consume_worker_operation_assertion：Agent 在执行 operation 前核销。
   * runtime bearer 先经 MM 验证 exact core Agent；nonce 一次性原子持久。
   */
  private async handleConsumeWorkerOperationAssertion(
    params: { assertion?: unknown; expected?: unknown },
    context?: RpcHandlerContext,
  ): Promise<{ consumed: true; expires_at: string }> {
    const bearer = context?.authorizationBearer
    if (!bearer) throw new RpcError('UNAUTHORIZED', 'Missing runtime credential')
    await this.rpcClient.callModuleManagerSensitive(
      'verify_core_agent_runtime',
      { expected_module_id: 'crabot-agent' },
      this.config.moduleId,
      { authorizationBearer: bearer },
    )
    if (typeof params.assertion !== 'string' || !params.expected || typeof params.expected !== 'object') {
      throw new RpcError('INVALID_PARAMS', 'assertion and expected are required')
    }
    try {
      return await this.workerOperationAssertions.consume(
        params.assertion,
        params.expected as Parameters<WorkerOperationAssertions['consume']>[1],
      )
    } catch (error) {
      throw new RpcError('FORBIDDEN', error instanceof Error ? error.message : String(error))
    }
  }

  /** GET /api/agent/worker-implementations：desired config（引用形态，无 secret）。 */
  private async handleGetWorkerImplementationsApi(_req: IncomingMessage, res: ServerResponse): Promise<void> {
    const desired = await this.workerImplementationStore.load()
    sendJson(res, 200, desired)
  }

  /**
   * PUT /api/agent/worker-implementations：CAS 更新（expected_revision 必传）。
   * body 只接受协议 shape（implementations 引用 provider/model，不含 credential）；
   * Agent unavailable 时只允许保存全 disabled intent（启用 CLI 需 Agent 在线评估 translator
   * 兼容——503 由 admission 抛出）。
   */
  private async handlePutWorkerImplementationsApi(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const body = (await this.readJsonBody<{ expected_revision?: unknown; default_impl?: unknown; implementations?: unknown }>(req))
      if (typeof body.expected_revision !== 'number' || !Number.isInteger(body.expected_revision)) {
        sendJson(res, 400, { error: 'expected_revision is required' })
        return
      }
      const updated = await this.workerImplementationStore.update(body.expected_revision, (current) => {
        const candidate = {
          revision: current.revision, // store 会 +1
          default_impl: body.default_impl ?? current.default_impl,
          implementations: body.implementations,
        }
        return candidate as never
      })
      sendJson(res, 200, updated)
    } catch (error) {
      const code = (error as { code?: unknown }).code
      if (code === 'ADMIN_WORKER_IMPL_REVISION_CONFLICT') {
        sendJson(res, 409, { error: (error as Error).message })
        return
      }
      console.error('[Admin] worker-implementations PUT failed:', error)
      sendJson(res, 400, { error: error instanceof Error ? (error.message || String(error)) : String(error) })
    }
  }

  /**
   * POST /api/agent/worker-implementations/:impl/operations（§3.19.12）。
   * body 只接受 {action, expected_revision, mode?}；不接受 credential/env/command/args/URL。
   * Admin 先 CAS/admission，再生成 operation/assertion 经 exact Agent RPC 下发——Browser
   * 永远拿不到 assertion。
   */
  private async handleWorkerOperationApi(req: IncomingMessage, res: ServerResponse, impl: string): Promise<void> {
    try {
      if (impl !== 'claude-code' && impl !== 'codex') {
        sendJson(res, 404, { error: `unknown worker implementation: ${impl}` })
        return
      }
      const body = await this.readJsonBody<{ action?: unknown; expected_revision?: unknown; mode?: unknown }>(req)
      const action = body.action
      if (action !== 'install' && action !== 'verify' && action !== 'cancel') {
        // setup 走独立 ticket/admission 路径（阶段 6），不在此入口。
        sendJson(res, 400, { error: 'action must be install|verify|cancel' })
        return
      }
      if (typeof body.expected_revision !== 'number') {
        sendJson(res, 400, { error: 'expected_revision is required' })
        return
      }
      const desired = await this.workerImplementationStore.load()
      if (desired.revision !== body.expected_revision) {
        sendJson(res, 409, { error: `worker implementation config revision conflict (current ${desired.revision})` })
        return
      }
      const policy = desired.implementations[impl]
      if (action !== 'install' && !policy.enabled) {
        sendJson(res, 409, { error: `${impl} is not enabled` })
        return
      }
      const mode = policy.connection?.mode ?? (typeof body.mode === 'string' ? body.mode : 'native_account')
      const operationId = generateId()
      const assertion = this.workerOperationAssertions.issue({
        action, operation_id: operationId, impl, mode, policy_revision: desired.revision,
      })
      const agentPort = await this.ensureAgentPort()
      if (!agentPort) {
        sendJson(res, 503, { error: 'Agent not available' })
        return
      }
      if (action === 'install') {
        const result = await this.rpcClient.callSensitive<
          Record<string, unknown>,
          { operation_id: string; state: string; version?: string }
        >(agentPort, 'install_worker_implementation', {
          impl,
          operation_id: operationId,
          assertion,
          expected: { action, operation_id: operationId, impl, mode, policy_revision: desired.revision },
        }, this.config.moduleId)
        sendJson(res, 200, result)
        return
      }
      if (action === 'verify') {
        const result = await this.rpcClient.callSensitive<
          Record<string, unknown>,
          { operation_id: string; state: string; passed: boolean; detail?: string }
        >(agentPort, 'verify_worker_implementation', {
          impl,
          operation_id: operationId,
          assertion,
          expected: { action, operation_id: operationId, impl, mode, policy_revision: desired.revision },
        }, this.config.moduleId)
        sendJson(res, 200, result)
        return
      }
      // cancel 的 Agent 端点在后续阶段落地；这里先明确 501 而不是假装受理。
      sendJson(res, 501, { error: `${action} operation is not yet implemented` })
    } catch (error) {
      sendJson(res, 502, { error: error instanceof Error ? error.message : String(error) })
    }
  }

  /**
   * §12 grandfather bootstrap（Admin 侧协调，plan §12 顺序）：
   * fresh deploy → completed marker 即走；pre-P6 升级（有 legacy worker 数据且无 marker）
   * → pending transaction → Agent inspect → CAS 写 migration config → invalidation →
   * commit（Agent 核对 observation/policy/binding）→ completed marker。
   * 用户 PUT 竞态：revision 变化即放弃本事务（store 的 update 天然 CAS 拒绝）。
   */
  private async runWorkerImplementationBootstrap(): Promise<void> {
    const markerPath = path.join(this.adminConfig.data_dir, 'migrations', 'worker-implementation-bootstrap-v1.json')
    type Marker = { state: 'pending' | 'completed' | 'user_superseded'; transaction_id: string }
    const readMarker = async (): Promise<Marker | null> => {
      try {
        return JSON.parse(await fs.readFile(markerPath, 'utf-8')) as Marker
      } catch {
        return null
      }
    }
    const writeMarker = async (marker: Marker): Promise<void> => {
      await fs.mkdir(path.dirname(markerPath), { recursive: true, mode: 0o700 })
      const tmp = `${markerPath}.tmp-${process.pid}`
      await fs.writeFile(tmp, JSON.stringify(marker), { mode: 0o600 })
      await fs.rename(tmp, markerPath)
    }

    const existing = await readMarker()
    if (existing?.state === 'completed' || existing?.state === 'user_superseded') return

    // pre-P6 信号：legacy agent worker 数据存在。
    const agentDataDir = path.join(path.dirname(this.adminConfig.data_dir), 'agent')
    const hasLegacyData = await fs.readdir(path.join(agentDataDir, 'workers')).then((entries) => entries.length > 0).catch(() => false)
    if (!hasLegacyData) {
      await writeMarker({ state: 'completed', transaction_id: existing?.transaction_id ?? generateId() })
      return
    }

    const marker: Marker = existing ?? { state: 'pending', transaction_id: generateId() }
    if (!existing) await writeMarker(marker)

    const agentPort = await this.ensureAgentPort()
    if (!agentPort) throw new Error('Agent not available for worker bootstrap')

    // 1. inspect（幂等重放）
    const inspection = await this.rpcClient.call<
      { transaction_id: string },
      { observation: Record<string, { installed: boolean; activated: boolean; version?: string }> }
    >(agentPort, 'inspect_worker_implementation_bootstrap', { transaction_id: marker.transaction_id }, this.config.moduleId)

    const qualifying = (['claude-code', 'codex'] as const).filter((impl) => {
      const observed = inspection.observation[impl]
      return observed?.installed && observed.activated && typeof observed.version === 'string'
    })
    if (qualifying.length === 0) {
      await writeMarker({ state: 'completed', transaction_id: marker.transaction_id })
      return
    }

    // 2. CAS 写 migration-owned config：qualifying CLI → existing_host+enabled，builtin default 不变。
    const desired = await this.workerImplementationStore.load()
    try {
      await this.workerImplementationStore.update(desired.revision, (current) => {
        const next = {
          revision: current.revision,
          default_impl: current.default_impl,
          implementations: {
            builtin: { ...current.implementations.builtin },
            'claude-code': { ...current.implementations['claude-code'] },
            codex: { ...current.implementations.codex },
          },
        }
        for (const impl of qualifying) {
          // 用户已显式配置（policy 带 connection 或 enabled=true）的不覆盖。
          const policy = current.implementations[impl]
          if (policy.enabled || policy.connection) continue
          next.implementations[impl] = { enabled: true, connection: { mode: 'existing_host' as const } }
        }
        return next
      })
    } catch (error) {
      // CAS 失败 = 用户并发 PUT → user_superseded，永不自动重试启用。
      if ((error as { code?: unknown }).code === 'ADMIN_WORKER_IMPL_REVISION_CONFLICT') {
        await writeMarker({ state: 'user_superseded', transaction_id: marker.transaction_id })
        return
      }
      throw error
    }

    // 3. invalidation → Agent pull → commit（revision 核对在 Agent 侧；短暂重试等 pull）。
    const newRevision = (await this.workerImplementationStore.load()).revision
    await this.publishCurrentAgentConfigInvalidation()
    let committed = false
    let lastError: unknown
    for (let attempt = 0; attempt < 25 && !committed; attempt++) {
      try {
        const result = await this.rpcClient.call<
          { transaction_id: string; policy_revision: number; grandfather_impls: string[] },
          { state: string }
        >(agentPort, 'commit_worker_implementation_bootstrap', {
          transaction_id: marker.transaction_id,
          policy_revision: newRevision,
          grandfather_impls: qualifying,
        }, this.config.moduleId)
        committed = result.state === 'committed'
      } catch (error) {
        lastError = error
        await new Promise((resolve) => setTimeout(resolve, 200))
      }
    }
    if (!committed) {
      console.error('[Admin] worker bootstrap commit did not converge:', lastError instanceof Error ? lastError.message : String(lastError))
      return // marker 保持 pending，下次启动重试（inspect/commit 幂等）
    }
    await writeMarker({ state: 'completed', transaction_id: marker.transaction_id })
    console.log(`[Admin] Worker implementation grandfather bootstrap completed: ${qualifying.join(', ')} grandfathered at revision ${newRevision}`)
  }

  /** §6.5：desired config + 当前 admin_provider connection 的 nonsecret opaque revision。 */
  private async buildWorkerImplementationRuntimeConfig(): Promise<WorkerImplementationRuntimeConfig> {
    const desired = await this.workerImplementationStore.load()
    const connectionRevisions: Partial<Record<CLIWorkerImplId, string>> = {}
    for (const impl of ['claude-code', 'codex'] as const) {
      const policy = desired.implementations[impl]
      if (policy.connection?.mode !== 'admin_provider') continue
      const provider = this.modelProviderManager.getProvider(policy.connection.provider_id)
      if (!provider) continue // 引用失效由 status/degraded 暴露；revision 缺省即失效信号
      connectionRevisions[impl] = await this.workerConnectionRevisionSigner.compute({
        policy_revision: desired.revision,
        provider_id: provider.id,
        model_id: policy.connection.model_id,
        endpoint: provider.endpoint,
        credential_material: provider.api_key ?? '',
      })
    }
    return { config: desired, connection_revisions: connectionRevisions }
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
  // Worker 只读 REST 代理（protocol-agent-v3 §10.3，转发 §8.3 的读模型 RPC）
  //
  // 纯转发：鉴权由 `/api/*` 的统一中间件负责，错误映射由 proxyAgentRpc 负责，本段只做
  // query string → RPC 参数的翻译。**本阶段生产链路无人调用**（web 切到 worker 视图在 P6、
  // 真相源 cutover 在 P7），先落端点是为了让 P6 只改前端。
  //
  // 台账 status 目前被 P7 阻塞项 #1（harness.processStateChange 硬编码 completed）污染，
  // 这里原样透传、不做任何补偿——修复在 agent 侧的 harness，不在代理层。
  // ============================================================================

  /** §10.3 `GET /api/agent/workers` → `list_workers_admin`（§8.3）。 */
  /** §8.4/§10.3：GET /api/agent/managers —— exact Agent `list_managers_admin` 透传。 */
  private async handleListManagersApi(
    _req: IncomingMessage,
    res: ServerResponse,
    url: URL,
  ): Promise<void> {
    const page = parseIntParam(url.searchParams.get('page'), 1)
    const pageSize = parseIntParam(url.searchParams.get('page_size'), 20)
    await this.proxyAgentRpc(res, 'list_managers_admin', { pagination: { page, page_size: pageSize } })
  }

  /** §8.4/§10.3：GET /api/agent/managers/:managerKey/episodes —— path 参数只 decode 一次。 */
  private async handleListManagerEpisodesApi(
    _req: IncomingMessage,
    res: ServerResponse,
    rawManagerKey: string,
    url: URL,
  ): Promise<void> {
    let managerKey: string
    try {
      managerKey = decodeURIComponent(rawManagerKey)
    } catch {
      sendJson(res, 400, { error: 'Invalid percent-encoding in manager key' })
      return
    }
    const page = parseIntParam(url.searchParams.get('page'), 1)
    const pageSize = parseIntParam(url.searchParams.get('page_size'), 20)
    await this.proxyAgentRpc(res, 'list_manager_episodes_admin', {
      manager_key: managerKey,
      pagination: { page, page_size: pageSize },
    })
  }

  private async handleListWorkersApi(
    _req: IncomingMessage,
    res: ServerResponse,
    url: URL,
  ): Promise<void> {
    // §8.3 的 status 是 `TaskStatus | TaskStatus[]`：重复出现 `?status=a&status=b` 即数组，
    // 单个即单值（沿用 parseAccessibleScopes 的 getAll 惯例，不另发明逗号分隔语法）。
    const statuses = url.searchParams.getAll('status').filter(Boolean)
    const managerKey = url.searchParams.get('manager_key') || undefined
    // base-protocol §5.7 的 TimeRange 两端各自可选（start 闭、end 开），故任一存在即下发；
    // 这点与 search_traces 端点"start+end 必须同时给"的旧写法不同——那是它自己的历史约定。
    const start = url.searchParams.get('start') || undefined
    const end = url.searchParams.get('end') || undefined

    await this.proxyAgentRpc<
      {
        status?: string | string[]
        manager_key?: string
        time_range?: { start?: string; end?: string }
        pagination?: { page: number; page_size: number }
      },
      { items: unknown[]; pagination: { page: number; page_size: number; total_items: number; total_pages: number } }
    >(res, 'list_workers_admin', {
      ...(statuses.length === 1 ? { status: statuses[0] } : {}),
      ...(statuses.length > 1 ? { status: statuses } : {}),
      ...(managerKey ? { manager_key: managerKey } : {}),
      ...(start || end ? { time_range: { ...(start ? { start } : {}), ...(end ? { end } : {}) } } : {}),
      pagination: {
        page: parseIntParam(url.searchParams.get('page'), 1),
        page_size: parseIntParam(url.searchParams.get('page_size'), 20),
      },
    })
  }

  /** §10.3 `GET /api/agent/workers/:id` → `get_worker_detail`（§8.3）。 */
  private async handleGetWorkerDetailApi(
    _req: IncomingMessage,
    res: ServerResponse,
    workerId: string,
  ): Promise<void> {
    await this.proxyAgentRpc<{ worker_id: string }, { worker: unknown }>(
      res,
      'get_worker_detail',
      { worker_id: workerId },
      // 404 与相邻的 `/api/agent/traces/:traceId` 一致；判定见 isWorkerNotFoundError。
      isWorkerNotFoundError,
    )
  }

  /** §10.3 `GET /api/agent/workers/:id/output` → `read_worker_output_admin`（§8.3）。 */
  private async handleReadWorkerOutputApi(
    _req: IncomingMessage,
    res: ServerResponse,
    workerId: string,
    url: URL,
  ): Promise<void> {
    const cursor = url.searchParams.get('cursor') || undefined
    // seq = 化身序号（从 1 起）。没给就**不下发该字段**，由 agent 侧取主线化身
    // （harness.readWorkerOutput 的既有缺省，见 parseOptionalIntParam 注释）——与 cursor 同一纪律。
    const seq = parseOptionalIntParam(url.searchParams.get('seq'))
    await this.proxyAgentRpc<
      { worker_id: string; seq?: number; cursor?: string },
      { chunk: string; next_cursor: string; eof: boolean }
    >(
      res,
      'read_worker_output_admin',
      {
        worker_id: workerId,
        ...(seq !== undefined ? { seq } : {}),
        ...(cursor ? { cursor } : {}),
      },
      isWorkerNotFoundError,
    )
  }

  /** §10.3 `GET /api/agent/workers/:id/trace` → `get_worker_trace`（§8.3）。 */
  private async handleGetWorkerTraceApi(
    _req: IncomingMessage,
    res: ServerResponse,
    workerId: string,
    url: URL,
  ): Promise<void> {
    const cursor = url.searchParams.get('cursor') || undefined
    // 同 output 端点：没给 seq 就不下发，agent 侧取主线化身，两个端点缺省落在同一个化身上。
    const seq = parseOptionalIntParam(url.searchParams.get('seq'))
    await this.proxyAgentRpc<
      { worker_id: string; seq?: number; cursor?: string },
      { events: unknown[]; next_cursor?: string; unavailable_reason?: string }
    >(
      res,
      'get_worker_trace',
      {
        worker_id: workerId,
        ...(seq !== undefined ? { seq } : {}),
        ...(cursor ? { cursor } : {}),
      },
      isWorkerNotFoundError,
    )
  }

  private async handleDeleteTaskApi(
    _req: IncomingMessage,
    res: ServerResponse,
    taskId: string,
  ): Promise<void> {
    try {
      const result = await this.handleDeleteTask({ task_id: taskId })
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(result))
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const notFound = msg.includes('TASK_NOT_FOUND')
      const active = msg.includes('TASK_STILL_ACTIVE')
      const code = notFound ? 404 : active ? 409 : 500
      res.writeHead(code, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: msg }))
    }
  }

  private async handleGetTraceDiskUsageApi(
    _req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    await this.proxyAgentRpc(res, 'get_trace_disk_usage', {})
  }

  private async handleCleanupOldTracesApi(
    _req: IncomingMessage,
    res: ServerResponse,
    url: URL,
  ): Promise<void> {
    const parsed = parseCleanupParams(url)
    if ('error' in parsed) {
      sendJson(res, 400, { error: parsed.error })
      return
    }
    const { days, dryRun } = parsed
    await this.proxyAgentRpc(res, 'cleanup_old_traces', { days, dry_run: dryRun })
  }

  private async handleListModulesApi(_req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const result = await this.rpcClient.callModuleManager<unknown, { modules: unknown[] }>(
        'list_modules',
        {},
        this.config.moduleId
      )
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(result))
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: msg }))
    }
  }

  private async handleGetModuleLogApi(
    _req: IncomingMessage,
    res: ServerResponse,
    moduleId: string,
    url: URL
  ): Promise<void> {
    try {
      const lines = parseInt(url.searchParams.get('tail') ?? '500', 10)
      const cappedLines = Math.min(Math.max(lines, 1), 5000)
      // MM 子进程日志统一在 ${DATA_DIR}/logs/<id>.log（见 crabot-core/index.ts spawn）
      const logsDir = getAdminLogsDir()
      const logFile = path.join(logsDir, `${moduleId}.log`)
      const content = await tailLogFile(logFile, cappedLines)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ module_id: moduleId, lines: cappedLines, content }))
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: msg }))
    }
  }

  // ============================================================================
  // Bg-entity admin REST API（Plan 3 Tasks 2+3）
  // ============================================================================

  private async handleListBgEntitiesApi(
    _req: IncomingMessage,
    res: ServerResponse
  ): Promise<void> {
    await this.proxyAgentRpc(res, 'list_bg_entities', {})
  }

  private async handleGetBgEntityLogApi(
    req: IncomingMessage,
    res: ServerResponse,
    entityId: string
  ): Promise<void> {
    const url = new URL(req.url ?? '', 'http://localhost')
    const fromOffset = parseInt(url.searchParams.get('from_offset') ?? '0', 10)
    const maxBytes = parseInt(url.searchParams.get('max_bytes') ?? '100000', 10)
    await this.proxyAgentRpc(
      res,
      'get_bg_entity_log',
      { entity_id: entityId, from_offset: fromOffset, max_bytes: maxBytes },
      (message) => message.includes('not found') || message.includes('Entity not found'),
    )
  }

  private async handleKillBgEntityApi(
    _req: IncomingMessage,
    res: ServerResponse,
    entityId: string
  ): Promise<void> {
    await this.proxyAgentRpc(res, 'kill_bg_entity', { entity_id: entityId })
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
    const friendId = url.searchParams.get('friend_id') ?? undefined
    const accessibleScopes = this.parseAccessibleScopes(url)
    const port = await this.getMemoryPort(moduleId)
    const result = await this.rpcClient.call<{
      query?: string
      limit: number
      filter?: { refs?: Record<string, string> }
      accessible_scopes?: string[]
    }, unknown>(
      port,
      'search_short_term',
      {
        query: q,
        limit,
        ...(friendId ? { filter: { refs: { friend_id: friendId } } } : {}),
        ...(accessibleScopes ? { accessible_scopes: accessibleScopes } : {}),
      },
      this.config.moduleId
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

  private async handleListSceneProfilesByMemoryApi(_req: IncomingMessage, res: ServerResponse, url: URL, memoryId: string): Promise<void> {
    const moduleId = url.searchParams.get('module_id') ?? undefined
    const port = await this.getMemoryPort(moduleId)
    const result = await this.rpcClient.call<{ memory_id: string }, unknown>(
      port,
      'list_scene_profiles_by_memory',
      { memory_id: memoryId },
      this.config.moduleId,
    )
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(result))
  }

  private parseAccessibleScopes(url: URL): string[] | undefined {
    const candidates = [
      ...url.searchParams.getAll('accessible_scope'),
      ...(url.searchParams.get('accessible_scopes')?.split(',') ?? []),
    ]

    const scopes = candidates
      .map((scope) => scope.trim())
      .filter(Boolean)

    if (scopes.length === 0) {
      return undefined
    }

    const validScopePattern = /^[A-Za-z0-9:_./-]+$/
    const invalidScope = scopes.find((scope) => !validScopePattern.test(scope))
    if (invalidScope) {
      throw new Error(`Invalid accessible_scope: ${invalidScope}`)
    }

    return scopes
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

  private async handleListSceneProfilesApi(_req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const moduleId = url.searchParams.get('module_id') ?? undefined
    const sceneType = url.searchParams.get('scene_type') ?? undefined
    const limit = parseInt(url.searchParams.get('limit') ?? '100', 10)
    const offset = parseInt(url.searchParams.get('offset') ?? '0', 10)
    const port = await this.getMemoryPort(moduleId)
    const params: { scene_type?: string; limit: number; offset: number } = { limit, offset }
    if (sceneType) params.scene_type = sceneType
    const result = await this.rpcClient.call<typeof params, unknown>(
      port, 'list_scene_profiles', params, this.config.moduleId
    )
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(result))
  }

  private async handleGetSceneProfileApi(_req: IncomingMessage, res: ServerResponse, url: URL, key: string): Promise<void> {
    const moduleId = url.searchParams.get('module_id') ?? undefined
    const scene = parseSceneKey(key)
    const port = await this.getMemoryPort(moduleId)
    const result = await this.rpcClient.call<{ scene: SceneIdentity }, unknown>(
      port, 'get_scene_profile', { scene }, this.config.moduleId
    )
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(result))
  }

  private async handlePatchSceneProfileApi(req: IncomingMessage, res: ServerResponse, url: URL, key: string): Promise<void> {
    const moduleId = url.searchParams.get('module_id') ?? undefined
    const scene = parseSceneKey(key)
    const body = await this.readJsonBody<{
      label?: string
      content?: string
      source_memory_ids?: string[]
    }>(req)

    const port = await this.getMemoryPort(moduleId)

    // 先取现有画像
    const getResult = await this.rpcClient.call<
      { scene: SceneIdentity },
      { profile: { scene: SceneIdentity; label: string; content: string; created_at: string; updated_at: string; last_declared_at?: string | null; source_memory_ids?: string[] | null } | null }
    >(port, 'get_scene_profile', { scene }, this.config.moduleId)

    const now = new Date().toISOString()
    const existing = getResult.profile
    const nextLabel = normalizeSceneProfileTextField(
      body.label,
      existing?.label ?? defaultSceneProfileLabel(scene),
    )
    const nextContent = body.content === undefined
      ? (existing?.content ?? '')
      : body.content.trim()

    if (!nextContent) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Scene profile content cannot be empty' }))
      return
    }

    const upsertParams = {
      scene,
      label: nextLabel,
      content: nextContent,
      source_memory_ids: body.source_memory_ids ?? existing?.source_memory_ids ?? undefined,
      created_at: existing?.created_at ?? now,
      updated_at: now,
      last_declared_at: existing?.last_declared_at ?? null,
    }

    const result = await this.rpcClient.call<typeof upsertParams, unknown>(
      port, 'upsert_scene_profile', upsertParams, this.config.moduleId
    )
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(result))
  }

  private async handleDeleteSceneProfileApi(_req: IncomingMessage, res: ServerResponse, url: URL, key: string): Promise<void> {
    const moduleId = url.searchParams.get('module_id') ?? undefined
    const scene = parseSceneKey(key)
    const port = await this.getMemoryPort(moduleId)
    const result = await this.rpcClient.call<{ scene: SceneIdentity }, unknown>(
      port, 'delete_scene_profile', { scene }, this.config.moduleId
    )
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(result))
  }

  private async resolveAgentPort(): Promise<void> {
    try {
      const agentModules = await this.rpcClient.resolve(
        { module_id: 'crabot-agent' },
        this.config.moduleId
      )
      if (agentModules.length > 0) {
        this.agentPort = agentModules[0].port
      }
    } catch (error) {
      throw error
    }
  }

  // ============================================================================
  // 备份导出 API 处理方法
  // ============================================================================

  private async handleBackupOptionsApi(res: ServerResponse): Promise<void> {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ categories: BACKUP_CATEGORIES, defaults: DEFAULT_CATEGORIES }))
  }

  // ============================================================================
  // 备份导入 API 处理方法（Crabot 原生备份；OpenClaw 备份由 overview 分流回旧入口）
  // ============================================================================

  /**
   * POST /api/backup/import/overview — 流式接收上传的 .tar.gz，暂存后读 manifest.json 判定来源：
   *   - Crabot 备份且 manifest 合法 → { product:'crabot', staged_id, categories }
   *   - OpenClaw 备份（product 非 crabot）→ { product:'openclaw' }（前端转去 /api/openclaw-import/*）
   *   - manifest 缺失 / 损坏 → 400 中文错误
   */
  private async handleBackupImportOverviewApi(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const store = this.openclawImportStore!
    const { token, path: tmpFile } = store.stage()
    try {
      await pipeline(req, createWriteStream(tmpFile))
      const manifestText = await readArchiveTextFile(tmpFile, 'manifest.json')
      if (manifestText === null) {
        await store.discard(token)
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: '备份归档缺少 manifest.json，不是有效的 Crabot 备份' }))
        return
      }
      let raw: unknown
      try {
        raw = JSON.parse(manifestText)
      } catch {
        await store.discard(token)
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'manifest.json 解析失败，备份可能已损坏' }))
        return
      }
      // 非 Crabot 备份（典型为 OpenClaw 备份）：保留暂存交给 OpenClaw 旧入口处理由前端发起，
      // 这里直接丢弃本次暂存（OpenClaw 流程会重新上传 parse），只回报 product 让前端分流。
      if ((raw as { product?: unknown }).product !== 'crabot') {
        await store.discard(token)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ product: 'openclaw' }))
        return
      }
      const validation = validateBackupManifest(raw)
      if (!validation.ok) {
        await store.discard(token)
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: validation.error }))
        return
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ product: 'crabot', staged_id: token, categories: validation.categories }))
    } catch (err) {
      await store.discard(token)
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : '解析备份失败' }))
    }
  }

  /**
   * POST /api/backup/import/execute — body { staged_id, categories, on_conflict }。
   * 接线 ImportDeps（onConflict 绑进闭包）→ runCrabotImport → 返回汇总；用后即焚暂存归档。
   */
  private async handleBackupImportExecuteApi(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const store = this.openclawImportStore!
    let activeToken: string | undefined
    try {
      const body = await this.readJsonBody<{
        staged_id: string
        categories: string[]
        on_conflict: OnConflict
      }>(req)
      const archivePath = store.resolve(body.staged_id)
      if (!archivePath) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: '上传 token 已失效，请重新上传备份' }))
        return
      }
      activeToken = body.staged_id
      const onConflict: OnConflict = body.on_conflict === 'overwrite' ? 'overwrite' : 'skip'
      const categories = (body.categories ?? []).filter((c): c is BackupCategory =>
        (BACKUP_CATEGORIES as readonly string[]).includes(c))

      const deps = this.buildCrabotImportDeps(archivePath, onConflict)
      const summary = await runCrabotImport({ archivePath, categories, onConflict, deps })

      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(summary))
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : '导入失败' }))
    } finally {
      if (activeToken) await store.discard(activeToken)
    }
  }

  /**
   * 把 onConflict 绑进闭包，组装 runCrabotImport 所需的 ImportDeps。
   * provider/mcp/subagent/template/channel 走各 manager 的 upsertById（Phase B）；
   * friend/task/sessionConfig/schedule 直接对 this.<Map> 单条 upsert（finalize 时 saveData 落盘）。
   */
  private buildCrabotImportDeps(archivePath: string, onConflict: OnConflict): ImportDeps {
    // 标记是否真的导入了 agent-instance：仅在导入时才在 finalize 重载 AgentManager 内存态，
    // 避免对未涉及 agent 的导入触发不必要的 re-initialize。
    let agentInstanceTouched = false

    return {
      upsertProvider: async (r) => this.modelProviderManager.upsertById(r as ModelProvider, onConflict),
      upsertMcp: async (r) => this.mcpServerManager.upsertById(r as MCPServerRegistryEntry, onConflict),
      upsertSubagent: async (r) => this.subAgentManager.upsertById(r as SubAgentRegistryEntry, onConflict),
      upsertTemplate: async (r) => this.permissionTemplateManager.upsertById(r as PermissionTemplate, onConflict),
      upsertChannel: async (r) => {
        const inst = r as ChannelInstance
        const cfgText = await readArchiveTextFile(
          archivePath,
          `payload/channels/channel-configs/${inst.id}.json`,
        )
        const config = cfgText ? (JSON.parse(cfgText) as Record<string, string>) : null
        return this.channelManager.upsertInstanceById(inst, config, onConflict)
      },
      upsertFriend: async (r) => this.upsertImportedRecord(this.friends as Map<string, { id: string }>, r as { id: string }, onConflict),
      upsertTask: async (r) => this.upsertImportedRecord(this.tasks as unknown as Map<string, { id: string }>, r as { id: string }, onConflict),
      upsertSessionConfig: async (r) => {
        // session-configs 导出格式为 { session_id, config } 数组（见 saveDataImpl），按 session_id 归并。
        const entry = r as { session_id: string; config: SessionPermissionConfig }
        const exists = this.sessionConfigs.has(entry.session_id)
        if (exists && onConflict === 'skip') return 'skipped'
        this.sessionConfigs.set(entry.session_id, entry.config)
        return exists ? 'overwritten' : 'imported'
      },
      upsertAgentInstance: async (r) => {
        const inst = r as AgentInstance
        const status = await this.upsertImportedAgentInstance(inst, archivePath, onConflict)
        if (status !== 'skipped') agentInstanceTouched = true
        return status
      },
      upsertSchedule: async (r) => {
        const sched = r as Schedule
        if (shouldDisableOnImport(sched, Date.now())) sched.enabled = false
        const exists = this.schedules.has(sched.id)
        if (exists && onConflict === 'skip') return 'skipped'
        this.schedules.set(sched.id, sched)
        // update = remove+add，幂等地重建定时器（覆盖已有 id 时不留重复 timer）。
        if (sched.enabled) this.scheduleEngine.update(sched.id, sched)
        else this.scheduleEngine.remove(sched.id)
        return exists ? 'overwritten' : 'imported'
      },
      importSkills: async (archivePath2, oc) => this.importSkillsFromArchive(archivePath2, oc),
      importMemory: async (archivePath2, oc) => this.importMemoryFromArchive(archivePath2, oc),
      finalize: async () => {
        await this.saveData()
        await this.saveTasks()
        if (agentInstanceTouched) {
          // 文件已直接落盘，重载 AgentManager 内存态使 Admin 列表/解析与磁盘一致。
          await this.agentManager.initialize()
        }
        this.triggerPushAfter('crabot import')
      },
    }
  }

  /**
   * 对内存 Map 做单条按 id 归并：exists+skip → 'skipped'；否则 set，返回 'overwritten' / 'imported'。
   * 落盘交给 finalize 的 saveData/saveTasks。
   */
  private upsertImportedRecord<T extends { id: string }>(
    map: Map<string, T>,
    record: T,
    onConflict: OnConflict,
  ): ImportStatus {
    const exists = map.has(record.id)
    if (exists && onConflict === 'skip') return 'skipped'
    map.set(record.id, record)
    return exists ? 'overwritten' : 'imported'
  }

  /**
   * 导入单个 agent 实例：写 agent-instances.json（按 id 归并）+ agent-configs/<id>.json（随实例）。
   * AgentManager 内存态在 finalize 里统一 reload，这里只做磁盘归并。
   */
  private async upsertImportedAgentInstance(
    instance: AgentInstance,
    archivePath: string,
    onConflict: OnConflict,
  ): Promise<ImportStatus> {
    const dataDir = this.adminConfig.data_dir
    const instancesPath = path.join(dataDir, 'agent-instances.json')
    let existing: AgentInstance[] = []
    try {
      existing = JSON.parse(await fs.readFile(instancesPath, 'utf-8')) as AgentInstance[]
      if (!Array.isArray(existing)) existing = []
    } catch {
      existing = []
    }
    const exists = existing.some((i) => i.id === instance.id)
    if (exists && onConflict === 'skip') return 'skipped'

    const merged = exists
      ? existing.map((i) => (i.id === instance.id ? instance : i))
      : [...existing, instance]
    await this.atomicWriteFile(instancesPath, JSON.stringify(merged, null, 2))

    // 随实例写 agent-configs/<id>.json（归档里可能不存在，缺失则不写）。
    const cfgText = await readArchiveTextFile(
      archivePath,
      `payload/config/agent-configs/${instance.id}.json`,
    )
    if (cfgText !== null) {
      const configsDir = path.join(dataDir, 'agent-configs')
      await fs.mkdir(configsDir, { recursive: true })
      await this.atomicWriteFile(path.join(configsDir, `${instance.id}.json`), cfgText)
    }
    return exists ? 'overwritten' : 'imported'
  }

  /**
   * 解归档内 payload/skills/skills/<name> 各子目录到临时 dir，逐个 importFromLocalPath。
   * onConflict='skip' 时遇重名 skill 抛 DuplicateSkillError → 记 'skipped'。
   */
  private async importSkillsFromArchive(
    archivePath: string,
    onConflict: OnConflict,
  ): Promise<ImportItemResult[]> {
    const results: ImportItemResult[] = []
    const entries = await listArchiveEntries(archivePath)
    const prefix = 'payload/skills/skills/'
    // 收集顶层 skill 目录名（prefix 之后的第一段）。
    const skillNames = new Set<string>()
    for (const entry of entries) {
      if (!entry.startsWith(prefix)) continue
      const rest = entry.slice(prefix.length)
      const name = rest.split('/')[0]
      if (name) skillNames.add(name)
    }
    if (skillNames.size === 0) return results

    const workRoot = path.join(os.tmpdir(), `crabot-import-skills-${crypto.randomUUID()}`)
    try {
      for (const name of skillNames) {
        const destDir = path.join(workRoot, name)
        try {
          await extractArchiveSubtree(archivePath, `${prefix}${name}`, destDir)
          const { was_overwrite } = await this.skillManager.importFromLocalPath(
            destDir,
            onConflict === 'overwrite',
          )
          results.push({ kind: 'skill', id: name, status: was_overwrite ? 'overwritten' : 'imported' })
        } catch (err) {
          if (err instanceof DuplicateSkillError) {
            results.push({ kind: 'skill', id: name, status: 'skipped' })
          } else {
            results.push({ kind: 'skill', id: name, status: 'failed', reason: String(err) })
          }
        }
      }
    } finally {
      await fs.rm(workRoot, { recursive: true, force: true }).catch(() => undefined)
    }
    return results
  }

  /**
   * 导入记忆：长期 payload/memory/long_term/<status>/<type>/<id>.md → RPC import_long_term；
   * 短期 payload/memory/short_term.json → RPC import_memories。
   * onConflict='overwrite' → mode='replace'；否则 mode='merge'。
   */
  private async importMemoryFromArchive(
    archivePath: string,
    onConflict: OnConflict,
  ): Promise<ImportItemResult[]> {
    const results: ImportItemResult[] = []
    const mode = onConflict === 'overwrite' ? 'replace' : 'merge'
    const memoryPort = await this.getMemoryPort()

    // 长期记忆：只取顶层 entry（status/type/id.md），跳过 *.versions/ 版本旁路。
    const entries = await listArchiveEntries(archivePath)
    const ltPrefix = 'payload/memory/long_term/'
    const ltEntries: Array<{ status: string; markdown: string }> = []
    for (const entry of entries) {
      if (!entry.startsWith(ltPrefix) || !entry.endsWith('.md')) continue
      if (entry.includes('.versions/')) continue
      const segs = entry.split('/')
      // payload / memory / long_term / <status> / <type> / <id>.md = 6 段
      if (segs.length !== 6) continue
      const status = segs[3]
      const markdown = await readArchiveTextFile(archivePath, entry)
      if (markdown !== null) ltEntries.push({ status, markdown })
    }
    if (ltEntries.length > 0) {
      try {
        const res = await this.rpcClient.call<
          { entries: Array<{ status: string; markdown: string }>; mode: string },
          { imported: number; skipped: number; overwritten: number }
        >(memoryPort, 'import_long_term', { entries: ltEntries, mode }, this.config.moduleId)
        results.push({ kind: 'memory', id: 'long_term', status: 'imported',
          reason: `imported=${res.imported} skipped=${res.skipped} overwritten=${res.overwritten}` })
      } catch (err) {
        results.push({ kind: 'memory', id: 'long_term', status: 'failed', reason: String(err) })
      }
    }

    // 短期记忆：整份 short_term.json 作为 export_memories 的 data 喂回 import_memories。
    const shortText = await readArchiveTextFile(archivePath, 'payload/memory/short_term.json')
    if (shortText !== null) {
      try {
        const data = JSON.parse(shortText)
        await this.rpcClient.call<{ data: unknown; mode: string }, unknown>(
          memoryPort, 'import_memories', { data, mode }, this.config.moduleId,
        )
        results.push({ kind: 'memory', id: 'short_term', status: 'imported' })
      } catch (err) {
        results.push({ kind: 'memory', id: 'short_term', status: 'failed', reason: String(err) })
      }
    }
    return results
  }

  private async handleBackupExportApi(
    _req: IncomingMessage,
    res: ServerResponse,
    url: URL,
  ): Promise<void> {
    const requested = (url.searchParams.get('categories') ?? '').split(',').filter(Boolean)
    const categories = requested.filter((c): c is BackupCategory =>
      (BACKUP_CATEGORIES as readonly string[]).includes(c)) as BackupCategory[]
    const includeSecrets = url.searchParams.get('includeSecrets') === 'true'

    if (categories.length === 0) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: '至少选择一个类别' }))
      return
    }

    const ts = new Date().toISOString().replace(/[:.]/g, '-')
    const outPath = path.join(os.tmpdir(), `crabot-backup-${ts}.tar.gz`)
    const stagingRoot = path.join(os.tmpdir(), `crabot-backup-staging-${ts}`)
    try {
      const memoryDataDir = path.join(this.adminConfig.data_dir, '..', 'memory')
      let exportShortTermMemory: (() => Promise<unknown>) | undefined
      if (categories.includes('memory')) {
        exportShortTermMemory = async () => {
          const memoryPort = await this.getMemoryPort()
          return this.rpcClient.call(memoryPort, 'export_memories', {}, this.config.moduleId)
        }
      }
      await exportArchive({
        selection: { categories, includeSecrets },
        outPath,
        stagingRoot,
        runtimeVersion: process.env.CRABOT_VERSION ?? 'dev',
        createdAt: new Date().toISOString(),
        deps: {
          adminDataDir: this.adminConfig.data_dir,
          memoryDataDir,
          exportShortTermMemory,
        },
      })
      const { size } = await fs.stat(outPath)
      res.writeHead(200, {
        'Content-Type': 'application/gzip',
        'Content-Disposition': `attachment; filename="crabot-backup-${ts}.tar.gz"`,
        'Content-Length': String(size),
      })
      // 真流式：从磁盘直接 pipe 到响应，避免把整份归档读进 admin 进程内存
      await pipeline(createReadStream(outPath), res)
    } catch (err) {
      console.error('[Backup] 导出失败:', err)
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: '导出失败' }))
      }
    } finally {
      await fs.rm(outPath, { force: true })
      await fs.rm(stagingRoot, { recursive: true, force: true })
    }
  }
}

export default AdminModule
