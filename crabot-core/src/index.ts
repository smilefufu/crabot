/**
 * Module Manager - Crabot 模块生命周期管理器
 *
 * 负责所有模块的启动、停止、健康检查、事件转发等
 *
 * @see crabot-docs/protocols/protocol-module-manager.md
 */

import { spawn, ChildProcess } from 'node:child_process'
import crypto from 'node:crypto'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import type { Socket } from 'node:net'
import {
  type Request,
  type Response,
  type HealthResult,
  type ModuleId,
  type ModuleDefinition,
  type ModuleInfo,
  type ResolvedModule,
  type Event,
  type RegisterParams,
  type SubscribeParams,
  type PublishEventParams,
  type WorkspaceRelocationWorker,
  type StopWorkspaceRelocationWorkersResult,
  type CaptureWorkspaceRelocationWorkersResult,
  type CaptureWorkspaceRelocationProcessesResult,
  type WorkerProcessIdentity,
  type WorkspaceRelocationStopResult,
  type WorkspaceRelocationStopDispatch,
  type PrepareWorkspaceRelocationWorkerStopsParams,
  type PrepareWorkspaceRelocationWorkerStopsResult,
  type CompleteWorkspaceRelocationWorkerStopsParams,
  type CompleteWorkspaceRelocationWorkerStopsResult,
  type VerifyWorkspaceRelocationRequestParams,
  type VerifyWorkspaceRelocationRequestResult,
  type QuiesceWorkspaceRelocationWebParams,
  type QuiesceWorkspaceRelocationWebResult,
  type VerifyWorkspaceRelocationCoordinatorParams,
  type VerifyWorkspaceRelocationCoordinatorResult,
  assertWorkspaceExecutionAllowed,
  workspaceMaintenancePending,
  sha256CanonicalJson,
  generateId,
  generateTimestamp,
  createSuccessResponse,
  createErrorResponse,
  GlobalErrorCode,
} from 'crabot-shared'
import {
  type ModuleManagerConfig,
  type ModuleRuntime,
  type ModuleStopReason,
  type ShutdownParams,
  DEFAULT_CONFIG,
  createModuleStartedEvent,
  createModuleStoppedEvent,
  createModuleHealthChangedEvent,
  createModuleDefinitionRegisteredEvent,
  createModuleDefinitionUnregisteredEvent,
  createSystemDiskLowEvent,
  runtimeToInfo,
  runtimeToResolved,
} from './types.js'
import { PortAllocator } from './port-allocator.js'
import { scheduleRestart } from './restart-policy.js'
import { checkDiskLow } from './disk-watcher.js'
import { resolveExecutable } from './executable-resolver.js'
import { terminateProcessTree, waitForProcessTreeExit } from './process-tree.js'
import { ModuleRuntimeRegistry, probeProcessStartIdentity } from './module-runtime-registry.js'
import type { OrphanTerminationCandidate } from './module-runtime-registry.js'

// ============================================================================
// 类型定义
// ============================================================================

interface RpcHandlerContext { authorizationBearer?: string }

interface MethodHandler<P = unknown, R = unknown> {
  (params: P, context?: RpcHandlerContext): Promise<R> | R
}

interface EventSubscription {
  subscriber: ModuleId
  eventTypes: string[]
}

export interface ModuleManagerOptions {
  confirmOrphanTermination?: (candidate: OrphanTerminationCandidate) => Promise<boolean>
}

// Internal maintenance observations; not an RPC payload or a global exit receipt.
interface WorkspaceModuleScope {
  readonly instance_id: string
  readonly module_id: string
  readonly module_port: number
  readonly runtime_id?: string
  readonly processes: ReadonlyArray<{
    readonly pid: number
    readonly parent: number
    readonly started: string
    readonly owner: string
    readonly executable: string
  }>
}

interface WorkspaceModuleStopResult {
  module_id: string
  runtime_id?: string
  shutdown: 'not_submitted' | 'submitted' | 'unknown'
  status: 'inactive' | 'known_scope_exited' | 'unknown'
}
interface WorkspaceModuleStopJournal {
  prepare(modules: ReadonlyArray<WorkspaceModuleScope>): Promise<'dispatch' | 'observe'>
  observe(moduleId: string, processes: WorkspaceModuleScope['processes']): Promise<void>
  complete(results: ReadonlyArray<WorkspaceModuleStopResult>): Promise<void>
}
interface WorkspaceModuleStopResponse {
  dispatch: 'dispatch' | 'observe'
  results: ReadonlyArray<WorkspaceModuleStopResult>
}

interface ManagedChildState {
  moduleId: ModuleId
  runtimeId: string
  child: ChildProcess
  rootPid?: number
  rootExited: boolean
  reachedRunning: boolean
  intentionalReason?: ModuleStopReason
  finalReason?: ModuleStopReason
  finalizeStarted: boolean
  finalizeError?: Error
  finalized: Promise<void>
  resolveFinalized: () => void
  termination?: Promise<void>
  forceTermination?: Promise<void>
  logStream: ReturnType<typeof fs.createWriteStream>
  logEnded: boolean
}

interface WorkspaceAgentRpc {
  call(method: string, params: unknown, options: { authorizationBearer: string }): Promise<unknown>
  close(): void
}

interface WorkspaceWorkerStopJournal {
  prepare(workers: ReadonlyArray<WorkspaceRelocationWorker>): Promise<WorkspaceRelocationStopDispatch>
  complete(results: ReadonlyArray<WorkspaceRelocationStopResult>): Promise<void>
  close(): void
}

interface WorkspaceStopSequenceResult {
  readonly coordinator: ChildProcess
  readonly workerSubmission: StopWorkspaceRelocationWorkersResult
  readonly moduleSubmission: WorkspaceModuleStopResponse
}

interface WorkspaceCoordinatorGrant {
  capture?: Promise<ReadonlyArray<WorkspaceRelocationWorker>>
  workersHash?: string
  captureProcesses?: Promise<ReadonlyArray<WorkerProcessIdentity>>
  processesHash?: string
  captureModules?: Promise<ReadonlyArray<WorkspaceModuleScope>>
  modulesHash?: string
  stop?: Promise<StopWorkspaceRelocationWorkersResult>
  revoked?: boolean
  token: string
  revoke?: () => void
  proof: Omit<VerifyWorkspaceRelocationCoordinatorResult, 'verified' | 'action'>
  readyHash: string
  child: ChildProcess
  identity: WorkspaceModuleScope['processes'][number]
  agent: {
    child: ChildProcess
    state: ManagedChildState
    runtime: ModuleRuntime
    identity: WorkspaceModuleScope['processes'][number]
    port: number
    runtimeId: string
  }
}

// ============================================================================
// Module Manager 类
// ============================================================================

export class ModuleManager {
  private readonly config: ModuleManagerConfig
  private readonly portAllocator: PortAllocator
  private readonly modules: Map<ModuleId, ModuleRuntime> = new Map()
  private readonly processes: Map<ModuleId, ChildProcess> = new Map()
  private workspaceCoordinatorGrant?: WorkspaceCoordinatorGrant
  private workspaceStopSequence?: { fingerprint: string; pending: Promise<WorkspaceStopSequenceResult> }
  private workspaceModuleStop?: { fingerprint: string; pending: Promise<WorkspaceModuleStopResponse> }
  private readonly childStates: WeakMap<ChildProcess, ManagedChildState> = new WeakMap()
  private readonly lifecycleQueues: Map<ModuleId, Promise<void>> = new Map()
  private readonly restartTimers: Map<ModuleId, NodeJS.Timeout> = new Map()
  private readonly envOverrides: Map<ModuleId, Record<string, string>> = new Map()
  private readonly healthProbes: Set<ModuleId> = new Set()
  private readonly healthRecoveries: Set<ModuleId> = new Set()
  private readonly runtimeRegistry: ModuleRuntimeRegistry
  private readonly subscriptions: EventSubscription[] = []
  private readonly methodHandlers: Map<string, MethodHandler> = new Map()
  private readonly runtimeBearers = new Map<ModuleId, { token: string; child: ChildProcess; revoked: boolean }>()
  private readonly cutoverBearers = new Map<ModuleId, { token: string; child: ChildProcess; revoked: boolean; completing?: boolean }>()
  private managementOnly = false
  private cutoverRecord: { schema_version: 1; completed: true; completed_at: string; admin_archive_fingerprint: string; admin_archived_record_count: number; mm_archived_module_ids: ModuleId[]; process_trees_confirmed_stopped: true } | null = null

  private server: http.Server | null = null
  private healthCheckTimer: NodeJS.Timeout | null = null
  private diskWatcherTimer: NodeJS.Timeout | null = null
  private isShuttingDown = false
  private stopPromise: Promise<void> | null = null
  private readonly logsDir: string
  private readonly dataDir: string

  constructor(
    config: Partial<ModuleManagerConfig> = {},
    dataDir: string,
    options: ModuleManagerOptions = {},
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config }
    if (this.config.hotplug_allowed_types.includes('agent')) {
      throw new Error('Invalid Module Manager config: hotplug_allowed_types must not contain reserved type "agent"')
    }
    this.portAllocator = new PortAllocator(this.config.port_range, dataDir)
    this.runtimeRegistry = new ModuleRuntimeRegistry(dataDir, {
      confirmOrphanTermination: options.confirmOrphanTermination,
    })
    this.logsDir = path.join(dataDir, 'logs')
    fs.mkdirSync(this.logsDir, { recursive: true })
    this.dataDir = dataDir

    // 注册所有方法处理器
    this.registerMethod('register', this.handleRegisterUnauthenticated.bind(this))
    this.registerMethod('register_core_agent', this.handleRegisterCoreAgent.bind(this))
    this.registerMethod('verify_workspace_relocation_coordinator', this.handleVerifyWorkspaceRelocationCoordinator.bind(this))
    this.registerMethod('prepare_workspace_relocation_worker_stops', this.handlePrepareWorkspaceRelocationWorkerStops.bind(this))
    this.registerMethod('complete_workspace_relocation_worker_stops', this.handleCompleteWorkspaceRelocationWorkerStops.bind(this))
    this.registerMethod('verify_core_agent_runtime', this.handleVerifyCoreAgentRuntime.bind(this))
    this.registerMethod('verify_voice_runtime', this.handleVerifyVoiceRuntime.bind(this))
    this.registerMethod('register_voice_runtime', this.handleRegisterVoiceRuntime.bind(this))
    this.registerMethod('complete_core_agent_cutover', this.handleCompleteCoreAgentCutover.bind(this))
    this.registerMethod('get_core_agent_cutover_record', this.handleGetCoreAgentCutoverRecord.bind(this))

    this.registerMethod('unregister', this.handleUnregister.bind(this))
    this.registerMethod('allocate_port', this.handleAllocatePort.bind(this))
    this.registerMethod('start_module', this.handleStartModule.bind(this))
    this.registerMethod('stop_module', this.handleStopModule.bind(this))
    this.registerMethod('restart_module', this.handleRestartModule.bind(this))
    this.registerMethod('get_module', this.handleGetModule.bind(this))
    this.registerMethod('list_modules', this.handleListModules.bind(this))
    this.registerMethod('resolve', this.handleResolve.bind(this))
    this.registerMethod('subscribe', this.handleSubscribe.bind(this))
    this.registerMethod('unsubscribe', this.handleUnsubscribe.bind(this))
    this.registerMethod('publish_event', this.handlePublishEvent.bind(this))
    this.registerMethod('register_module_definition', this.handleRegisterModuleDefinition.bind(this))
    this.registerMethod('unregister_module_definition', this.handleUnregisterModuleDefinition.bind(this))
    this.registerMethod('update_module_definition', this.handleUpdateModuleDefinition.bind(this))
    this.registerMethod('list_module_definitions', this.handleListModuleDefinitions.bind(this))
    this.registerMethod('get_module_definition', this.handleGetModuleDefinition.bind(this))
    this.registerMethod('health', this.handleHealth.bind(this))
    this.registerMethod('shutdown', this.handleShutdown.bind(this))
  }

  // ============================================================================
  // 生命周期
  // ============================================================================

  /**
   * 启动 Module Manager
   */
  async start(): Promise<void> {
    // 初始化端口分配器
    await this.portAllocator.initialize()
    this.cutoverRecord = this.loadCutoverRecord()

    // 加载内置模块定义
    for (const def of this.config.modules) {
      if (!this.modules.has(def.module_id)) {
        const port = this.portAllocator.allocate(def.module_id)
        this.modules.set(def.module_id, {
          ...def,
          status: 'stopped',
          port,
        })
      }
    }

    await this.runtimeRegistry.initialize()
    await this.runtimeRegistry.recoverOrphans({
      // Maintenance recovery must retain execution evidence for its fixed job.
      moduleId: workspaceMaintenancePending(this.dataDir) ? 'admin-web' : undefined,
      currentRuntimeIds: this.currentRuntimeIds(),
      gracefulTimeoutMs: this.config.shutdown_timeout * 1000,
    })

    // Every singleton-topology boot re-enters management-only until Admin re-inventories
    // legacy records and completes the authenticated cutover handshake. A completed marker
    // is an idempotency record, not permission to skip the restart rescan: otherwise a
    // newly introduced runnable non-core Agent could hide behind an old marker.
    this.managementOnly = this.modules.has('admin-web') && this.modules.has('crabot-agent')

    // 启动 HTTP 服务器
    this.server = http.createServer((req, res) => {
      this.handleRequest(req, res).catch((error) => {
        console.error('[ModuleManager] Unhandled error:', error)
        res.writeHead(500)
        res.end(JSON.stringify({ error: 'Internal server error' }))
      })
    })
    this.server.on('clientError', (error, socket) => {
      const client = socket as Socket
      const peer = `${client.remoteAddress ?? 'unknown'}:${client.remotePort ?? 'unknown'}`
      console.error(`[ModuleManager] HTTP client error from ${peer}: ${error.message}`)
      if (!socket.writable) {
        socket.destroy()
        return
      }
      const response = (error as NodeJS.ErrnoException).code === 'HPE_HEADER_OVERFLOW'
        ? 'HTTP/1.1 431 Request Header Fields Too Large\r\n\r\n'
        : 'HTTP/1.1 400 Bad Request\r\n\r\n'
      socket.end(response)
    })

    return new Promise((resolve, reject) => {
      this.server!.listen(this.config.port, () => {
        console.log(`[ModuleManager] Listening on port ${this.config.port}`)
        this.startHealthCheckTimer()

        // 磁盘水位线监控（每 60s 一次；同状态不重复广播 → 去抖）
        let lastWasLow = false
        this.diskWatcherTimer = setInterval(async () => {
          const r = await checkDiskLow(this.dataDir, 1_000_000_000) // 1GB 阈值
          if (r.is_low && !lastWasLow && r.payload) {
            lastWasLow = true
            this.publishEvent(
              createSystemDiskLowEvent('module-manager', r.payload)
            ).catch(console.error)
            console.warn(
              `[ModuleManager] DISK LOW: ${(r.available_bytes / 1e9).toFixed(2)}GB free at ${r.payload.path}`
            )
          } else if (!r.is_low && lastWasLow) {
            lastWasLow = false
            console.log(`[ModuleManager] Disk recovered: ${(r.available_bytes / 1e9).toFixed(2)}GB free`)
          }
        }, 60_000)

        // 启动 auto_start 模块
        this.startAutoStartModules().catch(console.error)

        resolve()
      })
      this.server!.on('error', reject)
    })
  }

  /**
   * 停止 Module Manager
   */
  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise
    this.isShuttingDown = true
    this.stopPromise = this.performStop().catch((error) => {
      this.isShuttingDown = false
      this.stopPromise = null
      throw error
    })
    return this.stopPromise
  }

  private async performStop(): Promise<void> {
    console.log('[ModuleManager] Shutting down...')

    // 停止健康检查定时器
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer)
      this.healthCheckTimer = null
    }

    // 停止磁盘水位线监控定时器
    if (this.diskWatcherTimer) {
      clearInterval(this.diskWatcherTimer)
      this.diskWatcherTimer = null
    }

    for (const timer of this.restartTimers.values()) clearTimeout(timer)
    this.restartTimers.clear()

    // Drain operations accepted before shutdown. startModuleProcess rechecks
    // the terminal flag immediately before spawn, so a paused start cannot
    // escape the process snapshot below.
    await Promise.allSettled(Array.from(this.lifecycleQueues.values()))

    // 清理所有仍受管的进程树（包括 health/error 状态下尚未 finalize 的树）。
    const managedModuleIds = Array.from(this.processes.keys())
    await Promise.all(
      managedModuleIds.map((moduleId) => this.enqueueLifecycle(
        moduleId,
        () => this.stopModuleProcess(moduleId, 'shutdown'),
      )),
    )

    // 关闭 HTTP 服务器
    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server!.close(() => resolve())
      })
    }

    await this.portAllocator.flush()

    console.log('[ModuleManager] Stopped')
  }

  // ============================================================================
  // HTTP 请求处理
  // ============================================================================

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const method = req.url?.slice(1) ?? ''
    const isRegisterRequest = method === 'register'
    const peer = `${req.socket.remoteAddress ?? 'unknown'}:${req.socket.remotePort ?? 'unknown'}`
    let registerRequestId = 'unknown'
    let registerModuleId = 'unknown'
    let registerResponseFinished = false

    if (isRegisterRequest) {
      const details = () => `request_id=${registerRequestId} module_id=${registerModuleId} peer=${peer}`
      req.once('aborted', () => {
        console.warn(`[ModuleManager] Register request aborted before response: ${details()}`)
      })
      res.once('finish', () => {
        registerResponseFinished = true
        console.log(`[ModuleManager] Register response completed: ${details()}`)
      })
      res.once('close', () => {
        if (!registerResponseFinished) {
          console.warn(`[ModuleManager] Register response closed before completion: ${details()}`)
        }
      })
      res.once('error', (error) => {
        console.warn(`[ModuleManager] Register response error: ${details()} error=${error.message}`)
      })
    }

    if (req.method !== 'POST') {
      res.writeHead(405)
      res.end(JSON.stringify({ error: 'Method not allowed' }))
      return
    }

    const body = await this.readBody(req)
    let request: Request | null = null
    try {
      request = JSON.parse(body) as Request
    } catch {
      // 忽略解析错误
    }

    if (isRegisterRequest) {
      registerRequestId = request?.id ?? 'unknown'
      const params = request?.params as Partial<RegisterParams> | undefined
      registerModuleId = typeof params?.module_id === 'string' ? params.module_id : 'unknown'
      console.log(`[ModuleManager] Register request received: request_id=${registerRequestId} module_id=${registerModuleId} peer=${peer}`)
    }

    const handler = this.methodHandlers.get(method)
    if (!handler) {
      const errorResponse = createErrorResponse(
        request?.id ?? generateId(),
        GlobalErrorCode.METHOD_NOT_FOUND,
        `Method "${method}" not found`
      )
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(errorResponse))
      return
    }

    try {
      const params = request?.params ?? {}
      const authorization = req.headers.authorization
      const authorizationBearer = authorization?.startsWith('Bearer ') ? authorization.slice(7) : undefined
      if (authorization && (!authorization.startsWith('Bearer ') || !authorizationBearer || /[\r\n]/.test(authorizationBearer))) {
        throw Object.assign(new Error('Invalid Authorization metadata'), { code: 'UNAUTHORIZED' })
      }
      const result = await handler(params, { authorizationBearer })
      const response = createSuccessResponse(request?.id ?? generateId(), result)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(response))
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      const errorCode = (error as { code?: string }).code ?? GlobalErrorCode.INTERNAL_ERROR
      if (isRegisterRequest) {
        console.warn(`[ModuleManager] Register handler failed: request_id=${registerRequestId} module_id=${registerModuleId} code=${errorCode} error=${errorMessage}`)
      }
      const errorResponse = createErrorResponse(
        request?.id ?? generateId(),
        errorCode,
        errorMessage
      )
      const status = errorCode === 'UNAUTHORIZED' ? 401 : errorCode === 'FORBIDDEN' ? 403 : 500
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(errorResponse))
    }
  }

  private readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      let body = ''
      req.on('data', (chunk: string) => {
        body += chunk
      })
      req.on('end', () => resolve(body))
      req.on('error', reject)
    })
  }

  // ============================================================================
  // 方法处理器注册
  // ============================================================================

  private registerMethod<P, R>(method: string, handler: MethodHandler<P, R>): void {
    this.methodHandlers.set(method, handler as MethodHandler)
  }

  // ============================================================================
  // API 方法实现
  // ============================================================================

  private handleVerifyCoreAgentRuntime(
    params: { expected_module_id: 'crabot-agent' },
    context?: RpcHandlerContext,
  ): { verified: true } {
    if (params.expected_module_id !== 'crabot-agent' || !context?.authorizationBearer) {
      throw Object.assign(new Error('Missing runtime credential'), { code: 'UNAUTHORIZED' })
    }
    const record = this.runtimeBearers.get('crabot-agent')
    if (!record || record.revoked || record.child.exitCode !== null) {
      throw Object.assign(new Error('Runtime credential revoked'), { code: 'FORBIDDEN' })
    }
    const a = Buffer.from(record.token); const b = Buffer.from(context.authorizationBearer)
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      throw Object.assign(new Error('Invalid runtime credential'), { code: 'FORBIDDEN' })
    }
    return { verified: true }
  }

  private isVoiceModule(moduleId: ModuleId): boolean {
    const runtime = this.modules.get(moduleId)
    return runtime?.module_type === 'channel' && runtime.env?.CRABOT_CHANNEL_IMPLEMENTATION_ID === 'channel-voice'
  }

  private handleVerifyVoiceRuntime(
    params: { expected_module_id: ModuleId },
    context?: RpcHandlerContext,
  ): { verified: true } {
    const moduleId = params?.expected_module_id
    if (typeof moduleId !== 'string' || !this.isVoiceModule(moduleId) || !context?.authorizationBearer) {
      throw Object.assign(new Error('Missing voice runtime credential'), { code: 'UNAUTHORIZED' })
    }
    const record = this.runtimeBearers.get(moduleId)
    if (!record || record.revoked || record.child.exitCode !== null) {
      throw Object.assign(new Error('Voice runtime credential revoked'), { code: 'FORBIDDEN' })
    }
    const a = Buffer.from(record.token); const b = Buffer.from(context.authorizationBearer)
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      throw Object.assign(new Error('Invalid voice runtime credential'), { code: 'FORBIDDEN' })
    }
    return { verified: true }
  }

  private async handleRegisterVoiceRuntime(params: RegisterParams, context?: RpcHandlerContext): Promise<{ registered: true }> {
    this.handleVerifyVoiceRuntime({ expected_module_id: params.module_id }, context)
    if (!this.processes.has(params.module_id)) {
      throw Object.assign(new Error('Voice registration requires the exact spawned child'), { code: 'FORBIDDEN' })
    }
    return this.handleRegister(params, false, true)
  }

  private handleGetCoreAgentCutoverRecord(): { record: NonNullable<ModuleManager['cutoverRecord']> } {
    if (!this.cutoverRecord) {
      throw Object.assign(new Error('Core Agent cutover record not found'), { code: 'NOT_FOUND' })
    }
    const definition = this.modules.get('crabot-agent')
    if (!definition || definition.module_type !== 'agent' || definition.legacy_archive) {
      throw Object.assign(new Error('Core Agent definition is unavailable'), { code: 'FORBIDDEN' })
    }
    return { record: { ...this.cutoverRecord, mm_archived_module_ids: [...this.cutoverRecord.mm_archived_module_ids] } }
  }

  private async handleCompleteCoreAgentCutover(
    params: { schema_version: 1; admin_archive_fingerprint: string; admin_archived_record_count: number },
    context?: RpcHandlerContext,
  ): Promise<{ record: { schema_version: 1; completed: true; completed_at: string; admin_archive_fingerprint: string; admin_archived_record_count: number; mm_archived_module_ids: ModuleId[]; process_trees_confirmed_stopped: true } }> {
    const record = this.cutoverBearers.get('admin-web')
    if (!record || record.revoked || record.completing || !context?.authorizationBearer || record.child.exitCode !== null) throw Object.assign(new Error('Invalid cutover bearer'), { code: 'FORBIDDEN' })
    const a = Buffer.from(record.token); const b = Buffer.from(context.authorizationBearer)
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw Object.assign(new Error('Invalid cutover bearer'), { code: 'FORBIDDEN' })
    record.completing = true
    try {
      if (params.schema_version !== 1) throw Object.assign(new Error('Invalid cutover schema'), { code: 'INVALID_PARAMS' })
      const archived: ModuleId[] = []
      for (const runtime of this.modules.values()) {
        if (runtime.module_type !== 'agent' || runtime.module_id === 'crabot-agent') continue
        try {
          await this.stopModuleProcess(runtime.module_id, 'forced')
        } catch (error) {
          throw Object.assign(new Error(`Unable to confirm non-core Agent ${runtime.module_id} stopped: ${error instanceof Error ? error.message : String(error)}`), { code: 'MODULE_MANAGER_CUTOVER_STOP_FAILED' })
        }
        if (this.processes.has(runtime.module_id)) {
          throw Object.assign(new Error(`Non-core Agent process still exists: ${runtime.module_id}`), { code: 'MODULE_MANAGER_CUTOVER_STOP_FAILED' })
        }
        if (runtime.status === 'running' || runtime.status === 'starting') {
          throw Object.assign(new Error(`Non-core Agent runtime remains active: ${runtime.module_id}`), { code: 'MODULE_MANAGER_CUTOVER_STOP_FAILED' })
        }
        runtime.auto_start = false
        runtime.legacy_archive = {
          kind: 'unsupported_non_core_agent',
          archived_at: generateTimestamp(),
          reason: 'Dynamic Agent runtime retired by core singleton cutover',
        }
        archived.push(runtime.module_id)
      }
      if (this.cutoverRecord) {
        const replayed = new Set(this.cutoverRecord.mm_archived_module_ids)
        if (this.cutoverRecord.admin_archive_fingerprint !== params.admin_archive_fingerprint || this.cutoverRecord.admin_archived_record_count !== params.admin_archived_record_count || archived.some((moduleId) => !replayed.has(moduleId))) {
          throw Object.assign(new Error('Cutover marker conflicts with current Admin/MM inventory'), { code: 'MODULE_MANAGER_CUTOVER_CONFLICT' })
        }
        this.managementOnly = false
        record.revoked = true
        void this.startAutoStartModules()
        return { record: this.cutoverRecord }
      }
      const completed = { schema_version: 1 as const, completed: true as const, completed_at: generateTimestamp(), admin_archive_fingerprint: params.admin_archive_fingerprint, admin_archived_record_count: params.admin_archived_record_count, mm_archived_module_ids: archived.sort(), process_trees_confirmed_stopped: true as const }
      this.saveCutoverRecord(completed)
      this.cutoverRecord = completed
      this.managementOnly = false
      record.revoked = true
      void this.startAutoStartModules()
      return { record: completed }
    } catch (error) {
      if (!record.revoked) record.completing = false
      throw error
    }
  }

  private loadCutoverRecord(): ModuleManager['cutoverRecord'] {
    const markerPath = path.join(this.dataDir, 'migrations', 'core-agent-singleton-v1.json')
    try {
      const record = JSON.parse(fs.readFileSync(markerPath, 'utf8')) as NonNullable<ModuleManager['cutoverRecord']>
      if (record.schema_version !== 1 || record.completed !== true || !Array.isArray(record.mm_archived_module_ids) || record.process_trees_confirmed_stopped !== true) throw new Error('invalid cutover marker')
      return record
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }

  private saveCutoverRecord(record: NonNullable<ModuleManager['cutoverRecord']>): void {
    const directory = path.join(this.dataDir, 'migrations')
    fs.mkdirSync(directory, { recursive: true })
    const target = path.join(directory, 'core-agent-singleton-v1.json')
    const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`
    const fd = fs.openSync(temporary, 'w', 0o600)
    try { fs.writeFileSync(fd, JSON.stringify(record, null, 2)); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
    fs.renameSync(temporary, target)
    // Node's Windows directory handles cannot be flushed; the file was synced before rename.
    if (process.platform !== 'win32') {
      const directoryFd = fs.openSync(directory, 'r')
      try { fs.fsyncSync(directoryFd) } finally { fs.closeSync(directoryFd) }
    }
  }

  private assertWorkspaceStartAllowed(moduleId: ModuleId): void {
    if (moduleId !== 'admin-web') assertWorkspaceExecutionAllowed(this.dataDir)
  }

  private assertManagementOnlyAllowed(moduleId: ModuleId): void {
    if (!this.managementOnly || moduleId === 'admin-web') return
    throw Object.assign(new Error('Module Manager is in management-only cutover mode'), { code: 'MODULE_MANAGER_CUTOVER_INCOMPLETE' })
  }

  // --- 模块注册 ---

  private async handleRegisterUnauthenticated(params: RegisterParams): Promise<{ registered: true }> {
    return this.handleRegister(params, false)
  }

  private async handleRegisterCoreAgent(params: RegisterParams, context?: RpcHandlerContext): Promise<{ registered: true }> {
    this.handleVerifyCoreAgentRuntime({ expected_module_id: 'crabot-agent' }, context)
    if (params.module_id !== 'crabot-agent') {
      throw Object.assign(new Error('Only exact core Agent may use authenticated registration'), { code: 'FORBIDDEN' })
    }
    return this.handleRegister(params, true)
  }

  private async handleRegister(params: RegisterParams, coreAuthenticated = false, voiceAuthenticated = false): Promise<{ registered: true }> {
    this.assertManagementOnlyAllowed(params.module_id)
    const runtime = this.modules.get(params.module_id)
    if (this.isVoiceModule(params.module_id) && !voiceAuthenticated) {
      throw Object.assign(new Error('Voice registration requires runtime authentication'), { code: 'UNAUTHORIZED' })
    }

    if (runtime?.module_type === 'agent' && params.module_id !== 'crabot-agent') {
      throw Object.assign(new Error('Only builtin crabot-agent may register'), { code: 'MODULE_MANAGER_AGENT_SINGLETON_ONLY' })
    }

    if (!runtime) {
      throw Object.assign(new Error('Module definition not found'), {
        code: 'MODULE_MANAGER_MODULE_NOT_FOUND',
      })
    }

    if (runtime.module_type === 'agent' && params.module_id === 'crabot-agent') {
      if (!coreAuthenticated) {
        throw Object.assign(new Error('Core Agent registration requires runtime authentication'), { code: 'UNAUTHORIZED' })
      }
      if (!this.processes.has('crabot-agent')) {
        throw Object.assign(new Error('Core Agent registration requires the exact spawned child'), { code: 'MODULE_MANAGER_AGENT_SINGLETON_ONLY' })
      }
      if (params.protocol_version !== '3.4.0') {
        throw Object.assign(new Error('Core Agent protocol version must be 3.4.0'), { code: 'MODULE_MANAGER_PROTOCOL_VERSION_MISMATCH' })
      }
    }

    if (runtime.status === 'running') {
      throw Object.assign(new Error('Module already running'), {
        code: 'MODULE_MANAGER_DUPLICATE_ID',
      })
    }

    // 验证端口
    const allocatedPort = this.portAllocator.get(params.module_id)
    if (allocatedPort !== params.port) {
      throw Object.assign(new Error('Port mismatch'), {
        code: 'MODULE_MANAGER_PORT_MISMATCH',
      })
    }

    // 更新运行时信息
    runtime.status = 'running'
    runtime.version = params.version
    runtime.protocol_version = params.protocol_version
    runtime.registered_at = generateTimestamp()
    const child = this.processes.get(params.module_id)
    if (child) {
      const state = this.childStates.get(child)
      if (state) state.reachedRunning = true
    }
    console.log(`[ModuleManager] Register state accepted: module_id=${params.module_id}`)

    // 模块重启时订阅会重复注册，必须先清掉同 subscriber 的旧记录再写入，
    // 否则 publish_event 会把同一事件投递给同一模块多次。
    if (params.subscriptions && params.subscriptions.length > 0) {
      const removed = this.removeSubscriptionsBySubscriber(params.module_id)
      this.subscriptions.push({
        subscriber: params.module_id,
        eventTypes: params.subscriptions,
      })
      if (removed > 0) {
        console.log(
          `[ModuleManager] Replaced ${removed} stale subscription record(s) for ${params.module_id}`
        )
      }
    }
    console.log(`[ModuleManager] Register subscriptions recorded: module_id=${params.module_id}`)

    console.log(`[ModuleManager] Register event delivery started: module_id=${params.module_id}`)
    await this.publishEvent(
      createModuleStartedEvent('module-manager', {
        module_id: params.module_id,
        module_type: params.module_type,
        port: params.port,
        restart_count: runtime.restart_history?.attempts.length ?? 0,
      })
    )
    console.log(`[ModuleManager] Register event delivery completed: module_id=${params.module_id}`)

    console.log(`[ModuleManager] Module registered: ${params.module_id}`)
    return { registered: true }
  }

  private async handleUnregister(params: { module_id: ModuleId }): Promise<{ unregistered: true }> {
    const runtime = this.modules.get(params.module_id)
    if (!runtime) {
      throw Object.assign(new Error('Module not found'), { code: 'NOT_FOUND' })
    }
    this.assertAgentLifecycleAllowed(params.module_id)

    this.removeSubscriptionsBySubscriber(params.module_id)

    runtime.status = 'stopped'
    console.log(`[ModuleManager] Module unregistered: ${params.module_id}`)
    return { unregistered: true }
  }

  // --- 端口分配 ---

  private handleAllocatePort(params: { module_id: ModuleId }): { port: number } {
    const port = this.portAllocator.allocate(params.module_id)
    return { port }
  }

  // --- 模块控制 ---

  private assertLifecycleRequestsAllowed(): void {
    if (!this.isShuttingDown) return
    throw Object.assign(new Error('Module Manager is shutting down'), {
      code: 'MODULE_MANAGER_SHUTTING_DOWN',
    })
  }

  private assertAgentLifecycleAllowed(moduleId: ModuleId): void {
    const runtime = this.modules.get(moduleId)
    if (runtime?.legacy_archive || (runtime?.module_type === 'agent' && moduleId !== 'crabot-agent')) {
      throw Object.assign(new Error('Only builtin crabot-agent may run'), { code: 'MODULE_MANAGER_AGENT_SINGLETON_ONLY' })
    }
  }

  private assertCoreLifecycleInput(moduleId: ModuleId, entryOverride?: string, env?: Record<string, string>): void {
    if (moduleId !== 'crabot-agent') return
    if (entryOverride !== undefined || (env !== undefined && Object.keys(env).length > 0)) {
      throw Object.assign(new Error('Core Agent executable and environment are immutable'), { code: 'MODULE_MANAGER_CORE_MODULE_IMMUTABLE' })
    }
  }

  private revokeRuntimeBearer(moduleId: ModuleId): void {
    const bearer = this.runtimeBearers.get(moduleId)
    if (bearer) bearer.revoked = true
  }

  private async handleStartModule(params: {
    module_id: ModuleId
    entry_override?: string
    env?: Record<string, string>
  }): Promise<{ status: 'accepted'; tracking_id: string }> {
    this.assertLifecycleRequestsAllowed()
    this.assertManagementOnlyAllowed(params.module_id)
    this.assertAgentLifecycleAllowed(params.module_id)
    this.assertCoreLifecycleInput(params.module_id, params.entry_override, params.env)
    this.assertWorkspaceStartAllowed(params.module_id)
    const trackingId = generateId()
    this.cancelAutoRestart(params.module_id)

    this.enqueueLifecycle(params.module_id, async () => {
      this.cancelAutoRestart(params.module_id)
      const env = { ...(params.env ?? {}) }
      this.envOverrides.set(params.module_id, env)
      await this.startModuleProcess(params.module_id, params.entry_override, env)
      this.cancelAutoRestart(params.module_id)
    }).catch((error) => {
      console.error(`[ModuleManager] Failed to start module ${params.module_id}:`, error)
    })

    return { status: 'accepted', tracking_id: trackingId }
  }

  private async handleStopModule(params: {
    module_id: ModuleId
    force?: boolean
  }): Promise<{ status: 'accepted'; tracking_id: string }> {
    this.assertLifecycleRequestsAllowed()
    const trackingId = generateId()
    this.revokeRuntimeBearer(params.module_id)
    this.cancelAutoRestart(params.module_id)

    this.enqueueLifecycle(params.module_id, async () => {
      this.cancelAutoRestart(params.module_id)
      await this.stopModuleProcess(params.module_id, params.force ? 'forced' : 'shutdown')
      this.cancelAutoRestart(params.module_id)
    }).catch((error) => {
      console.error(`[ModuleManager] Failed to stop module ${params.module_id}:`, error)
    })

    return { status: 'accepted', tracking_id: trackingId }
  }

  private async handleRestartModule(params: {
    module_id: ModuleId
    force?: boolean
    env?: Record<string, string>
  }): Promise<{ status: 'accepted'; tracking_id: string }> {
    this.assertLifecycleRequestsAllowed()
    this.assertManagementOnlyAllowed(params.module_id)
    this.assertAgentLifecycleAllowed(params.module_id)
    this.assertCoreLifecycleInput(params.module_id, undefined, params.env)
    this.assertWorkspaceStartAllowed(params.module_id)
    const trackingId = generateId()
    this.revokeRuntimeBearer(params.module_id)
    this.cancelAutoRestart(params.module_id)

    this.enqueueLifecycle(params.module_id, async () => {
      this.cancelAutoRestart(params.module_id)
      const env = params.module_id === 'crabot-agent'
        ? {}
        : params.env === undefined
          ? { ...(this.envOverrides.get(params.module_id) ?? {}) }
          : { ...params.env }
      if (params.module_id === 'crabot-agent') this.envOverrides.delete(params.module_id)
      else this.envOverrides.set(params.module_id, env)
      await this.stopModuleProcess(params.module_id, params.force ? 'forced' : 'shutdown')
      this.cancelAutoRestart(params.module_id)
      await this.startModuleProcess(params.module_id, undefined, env)
      this.cancelAutoRestart(params.module_id)
    }).catch((error) => {
      console.error(`[ModuleManager] Failed to restart module ${params.module_id}:`, error)
    })

    return { status: 'accepted', tracking_id: trackingId }
  }

  // --- 查询 ---

  private handleGetModule(params: { module_id: ModuleId }): ModuleInfo {
    const runtime = this.modules.get(params.module_id)
    if (!runtime) {
      throw Object.assign(new Error('Module not found'), { code: 'NOT_FOUND' })
    }
    return runtimeToInfo(runtime)
  }

  private handleListModules(params: {
    module_type?: string
    status?: string
  }): { modules: ModuleInfo[] } {
    let list = Array.from(this.modules.values())

    if (params.module_type) {
      list = list.filter((m) => m.module_type === params.module_type)
    }
    if (params.status) {
      list = list.filter((m) => m.status === params.status)
    }

    return { modules: list.map(runtimeToInfo) }
  }

  private handleResolve(params: ResolveParamsInternal): { modules: ResolvedModule[] } {
    if (this.managementOnly) throw Object.assign(new Error('Resolve is closed during core Agent cutover'), { code: 'MODULE_MANAGER_CUTOVER_INCOMPLETE' })
    if (params.module_id && params.module_id !== 'crabot-agent') {
      const requested = this.modules.get(params.module_id)
      if (requested?.module_type === 'agent' || requested?.legacy_archive) {
        throw Object.assign(new Error('Only exact core Agent may be resolved'), { code: 'MODULE_MANAGER_AGENT_SINGLETON_ONLY' })
      }
    }
    // Preserve protocol-0.2 service-discovery compatibility for module_type callers, but
    // never expose a legacy Agent: only the exact core singleton can be returned.
    if (params.module_type === 'agent') {
      const core = this.modules.get('crabot-agent')
      if (!core || core.status !== 'running') {
        throw Object.assign(new Error('Module not found'), { code: 'NOT_FOUND' })
      }
      return { modules: [runtimeToResolved(core)] }
    }
    if (!params.module_id && !params.module_type) {
      throw Object.assign(new Error('module_id or module_type required'), {
        code: 'INVALID_PARAMS',
      })
    }

    let list = Array.from(this.modules.values()).filter(
      (m) => m.status === 'running'
    )

    if (params.module_id) {
      list = list.filter((m) => m.module_id === params.module_id)
    }
    if (params.module_type) {
      list = list.filter((m) => m.module_type === params.module_type)
    }

    if (list.length === 0) {
      throw Object.assign(new Error('Module not found'), { code: 'NOT_FOUND' })
    }

    return { modules: list.map(runtimeToResolved) }
  }

  // --- 事件 ---

  private handleSubscribe(params: SubscribeParams): { subscribed: true; event_types: string[] } {
    this.assertManagementOnlyAllowed(params.subscriber)
    this.assertAgentLifecycleAllowed(params.subscriber)
    // 移除该 subscriber 的所有旧订阅记录后再写入（与 register 行为一致）
    this.removeSubscriptionsBySubscriber(params.subscriber)

    this.subscriptions.push({
      subscriber: params.subscriber,
      eventTypes: params.event_types,
    })

    return { subscribed: true, event_types: params.event_types }
  }

  private handleUnsubscribe(params: {
    subscriber: ModuleId
    event_types: string[]
  }): { unsubscribed: true } {
    const sub = this.subscriptions.find((s) => s.subscriber === params.subscriber)
    if (sub) {
      sub.eventTypes = sub.eventTypes.filter((t) => !params.event_types.includes(t))
    }
    return { unsubscribed: true }
  }

  private async handlePublishEvent(params: PublishEventParams): Promise<{ subscriber_count: number }> {
    if (this.managementOnly && !params.event.type.startsWith('module_manager.')) {
      throw Object.assign(new Error('Event publication is closed during core Agent cutover'), { code: 'MODULE_MANAGER_CUTOVER_INCOMPLETE' })
    }
    const { event } = params
    const matchingSubscribers = this.findSubscribers(event.type)

    // 异步发送给所有订阅者
    await Promise.all(
      matchingSubscribers.map(async (subscriberId) => {
        const runtime = this.modules.get(subscriberId)
        if (!runtime || runtime.status !== 'running') return

        try {
          await this.sendToModule(runtime.port, 'on_event', { event })
        } catch (error) {
          console.error(
            `[ModuleManager] Failed to send event to ${subscriberId}:`,
            error
          )
        }
      })
    )

    return { subscriber_count: matchingSubscribers.length }
  }

  // --- 模块定义管理 ---

  private handleRegisterModuleDefinition(params: {
    module_definition: ModuleDefinition
  }): { module_id: ModuleId; registered: true } {
    if (this.managementOnly) throw Object.assign(new Error('Module definition changes are closed during core Agent cutover'), { code: 'MODULE_MANAGER_CUTOVER_INCOMPLETE' })
    const def = params.module_definition

    if (def.module_type === 'agent') {
      throw Object.assign(new Error('Only builtin crabot-agent may be registered'), { code: 'MODULE_MANAGER_HOTPLUG_NOT_ALLOWED' })
    }

    // 检查是否支持热插拔
    if (!this.config.hotplug_allowed_types.includes(def.module_type)) {
      throw Object.assign(new Error('Module type does not support hot-plug'), {
        code: 'MODULE_MANAGER_HOTPLUG_NOT_ALLOWED',
      })
    }

    // 检查 ID 冲突
    if (this.modules.has(def.module_id)) {
      throw Object.assign(new Error('Module ID already exists'), {
        code: 'MODULE_MANAGER_DUPLICATE_ID',
      })
    }

    // 分配端口并创建运行时
    const port = this.portAllocator.allocate(def.module_id)
    this.modules.set(def.module_id, {
      ...def,
      status: 'stopped',
      port,
      is_installed: true,
      installed_at: generateTimestamp(),
    })

    // 发布事件
    this.publishEvent(
      createModuleDefinitionRegisteredEvent('module-manager', {
        module_id: def.module_id,
        module_type: def.module_type,
        is_installed: true,
      })
    ).catch(console.error)

    console.log(`[ModuleManager] Module definition registered: ${def.module_id}`)
    return { module_id: def.module_id, registered: true }
  }

  private handleUnregisterModuleDefinition(params: {
    module_id: ModuleId
    delete_files?: boolean
  }): { module_id: ModuleId; unregistered: true } {
    const runtime = this.modules.get(params.module_id)
    if (!runtime) {
      throw Object.assign(new Error('Module definition not found'), { code: 'NOT_FOUND' })
    }

    if (runtime.module_id === 'crabot-agent' || !runtime.is_installed) {
      throw Object.assign(new Error('Builtin module definitions are immutable'), { code: 'MODULE_MANAGER_CORE_MODULE_IMMUTABLE' })
    }

    if (runtime.status === 'running') {
      throw Object.assign(new Error('Module is running, stop it first'), {
        code: 'MODULE_MANAGER_MODULE_RUNNING',
      })
    }

    this.modules.delete(params.module_id)
    this.portAllocator.release(params.module_id)

    // 发布事件
    this.publishEvent(
      createModuleDefinitionUnregisteredEvent('module-manager', {
        module_id: params.module_id,
        module_type: runtime.module_type,
      })
    ).catch(console.error)

    console.log(`[ModuleManager] Module definition unregistered: ${params.module_id}`)
    return { module_id: params.module_id, unregistered: true }
  }

  private handleUpdateModuleDefinition(params: {
    module_id: ModuleId
    updates: Partial<ModuleDefinition>
  }): { module_definition: ModuleDefinition } {
    this.assertManagementOnlyAllowed(params.module_id)
    this.assertAgentLifecycleAllowed(params.module_id)
    const runtime = this.modules.get(params.module_id)
    if (!runtime) {
      throw Object.assign(new Error('Module definition not found'), { code: 'NOT_FOUND' })
    }

    if (runtime.module_id === 'crabot-agent' || !runtime.is_installed) {
      throw Object.assign(new Error('Builtin module definitions are immutable'), { code: 'MODULE_MANAGER_CORE_MODULE_IMMUTABLE' })
    }

    if (runtime.status === 'running') {
      throw Object.assign(new Error('Module is running, stop it first'), {
        code: 'MODULE_MANAGER_MODULE_RUNNING',
      })
    }

    // 应用更新（不允许修改 module_id 和 module_type）
    const { module_id: _, module_type: __, ...updates } = params.updates
    Object.assign(runtime, updates)

    console.log(`[ModuleManager] Module definition updated: ${params.module_id}`)
    return { module_definition: runtime }
  }

  private handleListModuleDefinitions(params: {
    module_type?: string
    installed_only?: boolean
  }): { definitions: Array<ModuleRuntime & { is_installed: boolean }> } {
    let list = Array.from(this.modules.values())

    if (params.module_type) {
      list = list.filter((m) => m.module_type === params.module_type)
    }
    if (params.installed_only) {
      list = list.filter((m) => m.is_installed)
    }

    return {
      definitions: list.map((m) => ({
        ...m,
        is_installed: m.is_installed ?? false,
      })),
    }
  }

  private handleGetModuleDefinition(params: { module_id: ModuleId }): { definition: ModuleRuntime } {
    const runtime = this.modules.get(params.module_id)
    if (!runtime) {
      throw Object.assign(new Error('Module definition not found'), { code: 'NOT_FOUND' })
    }
    return { definition: runtime }
  }

  // --- 健康检查 ---

  private async handleHealth(): Promise<HealthResult> {
    const modules = Array.from(this.modules.values())
    const errorCount = modules.filter((m) => m.status === 'error').length

    let status: 'healthy' | 'degraded' | 'unhealthy' = 'healthy'
    if (this.managementOnly) status = 'degraded'
    if (errorCount > 0) {
      status = 'degraded'
    }
    if (this.isShuttingDown) {
      status = 'unhealthy'
    }

    return {
      status,
      details: {
        total_modules: modules.length,
        running_modules: modules.filter((m) => m.status === 'running').length,
        error_modules: errorCount,
      },
    }
  }

  // --- Shutdown ---

  private async handleShutdown(params: ShutdownParams = {}): Promise<Record<string, never>> {
    if (params.expected_generation !== undefined
      && (typeof params.expected_generation !== 'string' || !params.expected_generation
        || params.expected_generation !== process.env.CRABOT_INSTANCE_GENERATION)) {
      throw Object.assign(new Error('Shutdown generation does not match this instance'), { code: 'STALE_INSTANCE' })
    }
    setTimeout(() => {
      this.stop().catch(console.error)
    }, 100)
    return {}
  }

  // ============================================================================
  // 进程管理
  // ============================================================================

  private async verifyWorkspaceRelocationRequest(
    params: VerifyWorkspaceRelocationRequestParams, bearer?: string,
  ): Promise<VerifyWorkspaceRelocationRequestResult> {
    return { verified: true, ...await this.callWorkspaceRelocationAdmin('verify_workspace_relocation_request', params, bearer) }
  }

  private async quiesceWorkspaceRelocationWeb(
    params: QuiesceWorkspaceRelocationWebParams, bearer?: string,
  ): Promise<QuiesceWorkspaceRelocationWebResult> {
    return { quiesced: true, ...await this.callWorkspaceRelocationAdmin('quiesce_workspace_relocation_web', params, bearer) }
  }

  /** Shared current-Admin connection/intent proof; each caller retains its own action and result tag. */
  private async callWorkspaceRelocationAdmin(
    method: 'verify_workspace_relocation_request' | 'quiesce_workspace_relocation_web',
    params: VerifyWorkspaceRelocationRequestParams, bearer?: string,
  ): Promise<VerifyWorkspaceRelocationRequestParams> {
    params = Object.freeze({ ...params })
    const field = method === 'verify_workspace_relocation_request' ? 'verified' : 'quiesced'
    const timeoutMs = method === 'verify_workspace_relocation_request' ? 1500 : 30000
    const unavailable = () => Object.assign(new Error('当前Admin固定请求无法确认，已保留维护保护。'), { code: 'SERVICE_UNAVAILABLE' })
    if (typeof bearer !== 'string' || !bearer) throw Object.assign(new Error('Human Admin credential required'), { code: 'UNAUTHORIZED' })
    const runtime = this.modules.get('admin-web'), child = this.processes.get('admin-web')
    const state = child ? this.childStates.get(child) : undefined
    if (!runtime || !child?.pid || !state) throw unavailable()
    const port = runtime.port, runtimeId = state.runtimeId, rootPid = child.pid
    const verifyCurrent = (): void => {
      if (this.isShuttingDown || this.modules.get('admin-web') !== runtime || runtime.module_type !== 'admin' || runtime.status !== 'running'
        || runtime.port !== port || runtime.pid !== rootPid || this.processes.get('admin-web') !== child || this.childStates.get(child) !== state
        || state.runtimeId !== runtimeId || state.rootPid !== rootPid || state.rootExited || !state.reachedRunning
        || state.finalizeStarted || state.termination || child.exitCode !== null || child.signalCode !== null) throw unavailable()
    }
    let rpc: { call(method: string, params: unknown, options?: { authorizationBearer?: string }): Promise<unknown>; close(): void } | undefined
    try {
      verifyCurrent()
      const records = (await this.runtimeRegistry.listRecords()).filter(record => record.module_id === 'admin-web')
      const record = records[0], fingerprint = sha256CanonicalJson(records)
      verifyCurrent()
      if (records.length !== 1 || record.instance_id !== this.runtimeRegistry.getInstanceId() || record.runtime_id !== runtimeId
        || record.root_pid !== rootPid || record.module_port !== port || await probeProcessStartIdentity(rootPid) !== record.process_start_identity) throw unavailable()
      verifyCurrent()
      const native = require('../../scripts/lib/process-identity.cjs'), { captureSpawnedProcessTree } = require('../../scripts/lib/spawned-process-tree.cjs')
      const processes: WorkspaceModuleScope['processes'] = captureSpawnedProcessTree(child), root = processes.find(item => item.pid === rootPid)
      if (!root || await probeProcessStartIdentity(rootPid) !== record.process_start_identity) throw unavailable()
      verifyCurrent()
      const listeners = processes.filter(item => native.sameProcess(item, native.inspectProcess(item.pid)) && native.listListeningTcpPorts(item.pid).includes(port))
      if (listeners.length !== 1) throw unavailable()
      const { openModuleRuntimeRpc } = require('../../scripts/lib/module-runtime-rpc.cjs')
      rpc = await openModuleRuntimeRpc(listeners[0], port, { instance_id: record.instance_id, module_id: 'admin-web', runtime_id: runtimeId }, { timeoutMs })
      verifyCurrent()
      const response = await rpc!.call(method, params, { authorizationBearer: bearer })
      verifyCurrent()
      if (!response || typeof response !== 'object' || Array.isArray(response) || Object.keys(response).length !== 3
        || !Object.keys(response).every(key => key === field || key === 'intent_id' || key === 'intent_sha256')) throw unavailable()
      const result = response as Record<string, unknown>
      if (result[field] !== true || result.intent_id !== params.intent_id || result.intent_sha256 !== params.intent_sha256) throw unavailable()
      if (sha256CanonicalJson((await this.runtimeRegistry.listRecords()).filter(record => record.module_id === 'admin-web')) !== fingerprint) throw unavailable()
      verifyCurrent()
      if (!native.sameProcess(root, native.inspectProcess(rootPid))) throw unavailable()
      const { readWorkspaceRelocationIntent } = require('../../scripts/lib/workspace-relocation-intent.mjs')
      const intent = readWorkspaceRelocationIntent(this.dataDir)
      if (!intent) throw unavailable()
      const intentHash = sha256CanonicalJson(intent)
      if (intent.id !== params.intent_id || intentHash !== params.intent_sha256) {
        throw Object.assign(new Error('Workspace request does not match this instance'), { code: 'FORBIDDEN' })
      }
      return { intent_id: intent.id, intent_sha256: intentHash }
    } catch (error) {
      if ((error as { code?: string }).code === 'FORBIDDEN') throw error
      throw unavailable()
    } finally { rpc?.close() }
  }

  /** Fixed host startup only; subsequent scope capture still owns Agent grant authorization. */
  private async launchWorkspaceRelocationCoordinator(
    request: VerifyWorkspaceRelocationRequestParams, bearer?: string,
  ): Promise<ChildProcess> {
    request = Object.freeze({ ...request })
    const unavailable = () => Object.assign(new Error('固定迁移宿主未能接纳，原目录和维护记录已保留。'), { code: 'SERVICE_UNAVAILABLE' })
    const { cliLockToken } = require('../../scripts/lib/cli-lock.mjs')
    const lock = path.resolve(this.dataDir, 'cli.lock'), token = cliLockToken(lock)
    if (!token || this.isShuttingDown) throw unavailable()
    await this.verifyWorkspaceRelocationRequest(request, bearer)
    if (cliLockToken(lock) !== token || this.isShuttingDown) throw unavailable()
    let child: ChildProcess | undefined
    try {
      const launcher = require('../../scripts/lib/workspace-coordinator-launch.mjs')
      const host: { child: ChildProcess } = await launcher.launchWorkspaceRelocationCoordinator({ dataDir: this.dataDir, id: request.intent_id })
      child = host.child
      const { readWorkspaceRelocationIntent } = require('../../scripts/lib/workspace-relocation-intent.mjs')
      if (this.isShuttingDown || sha256CanonicalJson(readWorkspaceRelocationIntent(this.dataDir)) !== request.intent_sha256) throw unavailable()
      return child
    } catch {
      // No grant or journal action has been handed to a driver at this point.
      await this.closeWorkspaceCoordinatorChannel(child)
      throw unavailable()
    }
  }

  /** Neutral channel cleanup only; no business shutdown, signal, rollback or record deletion. */
  private async closeWorkspaceCoordinatorChannel(child?: ChildProcess): Promise<void> {
    try { if (child?.connected) child.disconnect() } catch { /* Preserve uncertainty and the first records. */ }
    if (child && child.exitCode === null && child.signalCode === null) {
      const pending = child
      await new Promise<void>(resolve => {
        const done = () => { clearTimeout(timer); pending.off('exit', done); resolve() }
        const timer = setTimeout(done, 2000)
        pending.once('exit', done)
        if (pending.exitCode !== null || pending.signalCode !== null) done()
      })
    }
  }

  /** One submission/known-scope sequence; this is never a global-exit or file-move permit. */
  private submitWorkspaceRelocationStops(request: VerifyWorkspaceRelocationRequestParams, bearer?: string): Promise<WorkspaceStopSequenceResult> {
    request = Object.freeze({ ...request })
    const fingerprint = sha256CanonicalJson(request)
    const failure = () => Object.assign(new Error('迁移停止提交段未能确认，已保留原记录和维护保护；未重放。'), { code: 'SERVICE_UNAVAILABLE' })
    if (this.workspaceStopSequence) {
      if (this.workspaceStopSequence.fingerprint !== fingerprint) return Promise.reject(Object.assign(new Error('Workspace stop intent cannot change'), { code: 'FORBIDDEN' }))
      return this.workspaceStopSequence.pending
    }
    const pending = Promise.resolve().then(async (): Promise<WorkspaceStopSequenceResult> => {
      let child: ChildProcess | undefined
      let journal: (WorkspaceModuleStopJournal & { close(): void }) | undefined
      let processJournal: { prepare(): Promise<'dispatch' | 'observe'>; observe(processes: ReadonlyArray<WorkerProcessIdentity>): Promise<void>; complete(): Promise<void>; close(): void } | undefined
      let active = true
      try {
        child = await this.launchWorkspaceRelocationCoordinator(request, bearer)
        await this.quiesceWorkspaceRelocationWeb(request, bearer)
        await this.captureWorkspaceRelocationWorkersForCoordinator(child, request, bearer)
        const processes = await this.captureWorkspaceRelocationProcessesForCoordinator(child)
        const modules = await this.captureWorkspaceRelocationModulesForCoordinator(child)
        const grant = this.workspaceCoordinatorGrant
        if (!grant || grant.child !== child) throw failure()
        this.assertWorkspaceCoordinatorGrantCurrent(grant)
        const records = require('../../scripts/lib/workspace-relocation-intent.mjs')
        const coordinator = records.readWorkspaceRelocationCoordinator(this.dataDir, request.intent_id)
        const native = require('../../scripts/lib/process-identity.cjs')
        const verify = (): void => {
          // Planned Agent exit revokes its grant; only original coordinator/material identity continues.
          if (!active || this.isShuttingDown || !child!.connected || child!.exitCode !== null || child!.signalCode !== null
            || sha256CanonicalJson(records.readWorkspaceRelocationIntent(this.dataDir)) !== request.intent_sha256
            || sha256CanonicalJson(records.readWorkspaceRelocationCoordinator(this.dataDir, request.intent_id)) !== sha256CanonicalJson(coordinator)
            || sha256CanonicalJson(records.readWorkspaceRelocationWorkers(this.dataDir, request.intent_id)) !== grant.workersHash
            || sha256CanonicalJson(records.readWorkspaceRelocationProcesses(this.dataDir, request.intent_id)) !== grant.processesHash
            || sha256CanonicalJson(records.readWorkspaceRelocationModules(this.dataDir, request.intent_id)) !== grant.modulesHash
            || !native.sameProcess(coordinator.launch.parent, native.inspectProcess(process.pid))
            || !native.sameProcess(coordinator.launch.process, native.inspectProcess(child!.pid))) throw failure()
        }
        const { createWorkspaceModuleJournal } = require('../../scripts/lib/workspace-module-journal.mjs')
        const { createWorkspaceProcessJournal } = require('../../scripts/lib/workspace-process-journal.mjs')
        const context = { dataDir: this.dataDir, id: request.intent_id, launch: coordinator.launch }
        journal = createWorkspaceModuleJournal(child, context)
        processJournal = createWorkspaceProcessJournal(child, context)
        verify()
        if (await processJournal!.prepare() !== 'dispatch') throw failure()
        let submissions: Pick<WorkspaceStopSequenceResult, 'workerSubmission' | 'moduleSubmission'> | undefined
        const { stopKnownProcessScope } = require('../../scripts/lib/known-process-stop.cjs')
        await stopKnownProcessScope(processes, { timeoutMs: Math.max(1, Math.round(this.config.shutdown_timeout * 1000)),
          onObserved: async (observed: ReadonlyArray<WorkerProcessIdentity>) => { verify(); await processJournal!.observe(observed); verify() },
          submit: async () => {
            verify()
            const workerSubmission = await this.stopWorkspaceRelocationWorkersForCoordinator(child!)
            verify(); this.assertWorkspaceCoordinatorGrantCurrent(grant)
            const moduleSubmission = await this.requestWorkspaceRelocationModuleStops(modules, journal!)
            verify(); submissions = { workerSubmission, moduleSubmission }
          },
        }, { ...native, terminateKnownProcess: (target: WorkerProcessIdentity) => { verify(); return native.terminateKnownProcess(target) } })
        if (!submissions) throw failure()
        await processJournal!.complete(); verify()
        if (sha256CanonicalJson(records.readWorkspaceRelocationModuleStops(this.dataDir, request.intent_id).submission?.results) !== sha256CanonicalJson(submissions.moduleSubmission.results)
          || !records.readWorkspaceRelocationProcessStops(this.dataDir, request.intent_id).completion) throw failure()
        return Object.freeze({ coordinator: child, ...submissions })
      } catch {
        active = false
        await this.closeWorkspaceCoordinatorChannel(child)
        throw failure()
      } finally { active = false; journal?.close(); processJournal?.close() }
    })
    this.workspaceStopSequence = { fingerprint, pending }
    return pending
  }

  private assertWorkspaceCoordinatorGrantCurrent(grant: WorkspaceCoordinatorGrant): void {
    const unavailable = () => Object.assign(new Error('迁移协调授权无法核实，已保留维护保护。'), { code: 'SERVICE_UNAVAILABLE' })
    const forbidden = () => {
      if (this.workspaceCoordinatorGrant === grant) grant.revoke?.()
      return Object.assign(new Error('Workspace coordinator binding revoked'), { code: 'FORBIDDEN' })
    }
    const agent = grant.agent
    if (this.isShuttingDown) throw unavailable()
    if (grant.revoked || !grant.child.connected || grant.child.exitCode !== null || grant.child.signalCode !== null || grant.child.pid !== grant.identity.pid
      || this.modules.get('crabot-agent') !== agent.runtime || agent.runtime.module_id !== 'crabot-agent' || agent.runtime.module_type !== 'agent'
      || this.processes.get('crabot-agent') !== agent.child || this.childStates.get(agent.child) !== agent.state
      || agent.runtime.port !== agent.port || agent.runtime.pid !== agent.identity.pid || agent.child.pid !== agent.identity.pid
      || agent.state.moduleId !== 'crabot-agent' || agent.state.runtimeId !== agent.runtimeId || agent.state.rootPid !== agent.identity.pid
      || !agent.state.reachedRunning || agent.state.rootExited || agent.state.finalizeStarted || agent.state.intentionalReason
      || agent.state.termination || agent.state.forceTermination || agent.child.exitCode !== null || agent.child.signalCode !== null) throw forbidden()
    try {
      const native = require('../../scripts/lib/process-identity.cjs')
      const records = require('../../scripts/lib/workspace-relocation-intent.mjs')
      const intent = records.readWorkspaceRelocationIntent(this.dataDir), current = records.readWorkspaceRelocationCoordinator(this.dataDir, grant.proof.intent_id)
      if (!intent || !current.launch || !current.ready || intent.id !== grant.proof.intent_id
        || sha256CanonicalJson(intent) !== grant.proof.intent_sha256 || current.launch.launch_id !== grant.proof.launch_id
        || sha256CanonicalJson(current.launch) !== grant.proof.launch_sha256 || sha256CanonicalJson(current.ready) !== grant.readyHash) throw unavailable()
      if (grant.workersHash && sha256CanonicalJson(records.readWorkspaceRelocationWorkers(this.dataDir, grant.proof.intent_id)) !== grant.workersHash) throw unavailable()
      if (grant.processesHash && sha256CanonicalJson(records.readWorkspaceRelocationProcesses(this.dataDir, grant.proof.intent_id)) !== grant.processesHash) throw unavailable()
      if (grant.modulesHash && sha256CanonicalJson(records.readWorkspaceRelocationModules(this.dataDir, grant.proof.intent_id)) !== grant.modulesHash) throw unavailable()
      const self = native.inspectProcess(process.pid), coordinator = native.inspectProcess(grant.identity.pid)
      if (grant.identity.owner !== self.owner || agent.identity.owner !== self.owner
        || !native.sameProcess(current.launch.parent, self) || !native.sameProcess(current.launch.process, grant.identity)
        || !native.sameProcess(grant.identity, coordinator) || coordinator.parent !== self.pid
        || !native.sameProcess(agent.identity, native.inspectProcess(agent.identity.pid))) throw forbidden()
    } catch (error) {
      if ((error as { code?: string }).code === 'FORBIDDEN') throw error
      throw unavailable()
    }
  }

  private async authorizeWorkspaceRelocationCoordinator(
    child: ChildProcess, request: VerifyWorkspaceRelocationRequestParams, bearer?: string,
  ): Promise<{ authorizationBearer: string }> {
    request = Object.freeze({ ...request })
    await this.verifyWorkspaceRelocationRequest(request, bearer)
    const unavailable = () => Object.assign(new Error('迁移协调授权无法核实，已保留维护保护。'), { code: 'SERVICE_UNAVAILABLE' })
    const agentChild = this.processes.get('crabot-agent'), runtime = this.modules.get('crabot-agent')
    const state = agentChild ? this.childStates.get(agentChild) : undefined
    if (!(child instanceof ChildProcess) || !child.pid || !agentChild?.pid || !runtime || !state) throw unavailable()
    let grant: WorkspaceCoordinatorGrant
    try {
      const native = require('../../scripts/lib/process-identity.cjs'), records = require('../../scripts/lib/workspace-relocation-intent.mjs')
      const current = records.readWorkspaceRelocationCoordinator(this.dataDir, request.intent_id)
      if (!current.launch || !current.ready) throw unavailable()
      grant = { token: crypto.randomBytes(32).toString('hex'),
        proof: { intent_id: request.intent_id, intent_sha256: request.intent_sha256, launch_id: current.launch.launch_id, launch_sha256: sha256CanonicalJson(current.launch) },
        readyHash: sha256CanonicalJson(current.ready), child, identity: native.inspectProcess(child.pid),
        agent: { child: agentChild, state, runtime, identity: native.inspectProcess(agentChild.pid), port: runtime.port, runtimeId: state.runtimeId } }
      this.assertWorkspaceCoordinatorGrantCurrent(grant)
    } catch { throw unavailable() }
    const previous = this.workspaceCoordinatorGrant
    if (previous) {
      this.assertWorkspaceCoordinatorGrantCurrent(previous)
      if (previous.child !== child || previous.agent.child !== agentChild || sha256CanonicalJson(previous.proof) !== sha256CanonicalJson(grant.proof)) throw unavailable()
      return { authorizationBearer: previous.token }
    }
    this.workspaceCoordinatorGrant = grant
    const revoke = () => {
      grant.revoked = true
      if (this.workspaceCoordinatorGrant === grant) this.workspaceCoordinatorGrant = undefined
      child.off('exit', revoke); child.off('error', revoke); child.off('disconnect', revoke)
      agentChild.off('exit', revoke); agentChild.off('error', revoke)
      grant.revoke = undefined
    }
    grant.revoke = revoke
    child.once('exit', revoke); child.once('error', revoke); child.once('disconnect', revoke)
    agentChild.once('exit', revoke); agentChild.once('error', revoke)
    return { authorizationBearer: grant.token }
  }

  /** Connection/runtime proof only; callers retain their own capture/stop policy. */
  private async openWorkspaceRelocationAgentRpc(grant: WorkspaceCoordinatorGrant): Promise<WorkspaceAgentRpc> {
    let rpc: WorkspaceAgentRpc | undefined
    try {
      this.assertWorkspaceCoordinatorGrantCurrent(grant)
      const native = require('../../scripts/lib/process-identity.cjs'), { captureSpawnedProcessTree } = require('../../scripts/lib/spawned-process-tree.cjs')
      const processes: WorkspaceModuleScope['processes'] = captureSpawnedProcessTree(grant.agent.child)
      const listeners = processes.filter(item => native.sameProcess(item, native.inspectProcess(item.pid)) && native.listListeningTcpPorts(item.pid).includes(grant.agent.port))
      if (listeners.length !== 1) throw new Error('One current Agent listener required')
      const { openModuleRuntimeRpc } = require('../../scripts/lib/module-runtime-rpc.cjs')
      const connection = await openModuleRuntimeRpc(listeners[0], grant.agent.port,
        { instance_id: this.runtimeRegistry.getInstanceId(), module_id: 'crabot-agent', runtime_id: grant.agent.runtimeId },
        { timeoutMs: 30000, maxResponseBytes: 32 * 1024 * 1024 })
      rpc = connection
      this.assertWorkspaceCoordinatorGrantCurrent(grant)
      return connection
    } catch {
      rpc?.close()
      throw Object.assign(new Error('当前Agent固定连接无法核实，已保留维护保护。'), { code: 'SERVICE_UNAVAILABLE' })
    }
  }

  private async captureWorkspaceRelocationWorkersForCoordinator(
    child: ChildProcess, request: VerifyWorkspaceRelocationRequestParams, bearer?: string,
  ): Promise<ReadonlyArray<WorkspaceRelocationWorker>> {
    await this.authorizeWorkspaceRelocationCoordinator(child, request, bearer)
    const grant = this.workspaceCoordinatorGrant
    const unavailable = () => Object.assign(new Error('执行器范围未能经原协调器确认，已保留维护保护；未重发捕获。'), { code: 'SERVICE_UNAVAILABLE' })
    if (!grant || grant.child !== child) throw unavailable()
    this.assertWorkspaceCoordinatorGrantCurrent(grant)
    if (!grant.capture) grant.capture = Promise.resolve().then(async () => {
      let rpc: WorkspaceAgentRpc | undefined
      let journal: { capture(workers: unknown): Promise<void>; close(): void } | undefined
      try {
        const connection = await this.openWorkspaceRelocationAgentRpc(grant)
        rpc = connection
        const result = await connection.call('capture_workspace_relocation_workers',
          { intent_id: grant.proof.intent_id, launch_id: grant.proof.launch_id }, { authorizationBearer: grant.token })
        this.assertWorkspaceCoordinatorGrantCurrent(grant)
        if (!result || typeof result !== 'object' || Array.isArray(result) || Object.keys(result).length !== 1
          || !Object.prototype.hasOwnProperty.call(result, 'workers')) throw unavailable()
        const captured = result as Partial<CaptureWorkspaceRelocationWorkersResult>
        if (!Array.isArray(captured.workers)) throw unavailable()
        const records = require('../../scripts/lib/workspace-relocation-intent.mjs')
        const { launch } = records.readWorkspaceRelocationCoordinator(this.dataDir, grant.proof.intent_id)
        const { createWorkspaceWorkerJournal } = require('../../scripts/lib/workspace-worker-journal.mjs')
        const channel = createWorkspaceWorkerJournal(child, { dataDir: this.dataDir, id: grant.proof.intent_id, launch })
        journal = channel
        await channel.capture(captured.workers)
        this.assertWorkspaceCoordinatorGrantCurrent(grant)
        const fixed = records.readWorkspaceRelocationWorkers(this.dataDir, grant.proof.intent_id)
        const workers: WorkspaceRelocationWorker[] = fixed.workers
        if (sha256CanonicalJson(workers) !== sha256CanonicalJson(captured.workers)) throw unavailable()
        grant.workersHash = sha256CanonicalJson(fixed)
        return Object.freeze(workers.map(worker => Object.freeze({ ...worker,
          incarnations: Object.freeze(worker.incarnations.map(incarnation => Object.freeze({ ...incarnation }))) })))
      } catch { throw unavailable() }
      finally { journal?.close(); rpc?.close() }
    })
    return grant.capture
  }

  private async captureWorkspaceRelocationProcessesForCoordinator(child: ChildProcess): Promise<ReadonlyArray<WorkerProcessIdentity>> {
    const grant = this.workspaceCoordinatorGrant
    const unavailable = () => Object.assign(new Error('原执行器进程范围无法确认，已保留维护保护；未重新捕获。'), { code: 'SERVICE_UNAVAILABLE' })
    if (!grant || grant.child !== child || !grant.capture) throw unavailable()
    const capture = grant.capture
    this.assertWorkspaceCoordinatorGrantCurrent(grant)
    if (!grant.captureProcesses) grant.captureProcesses = Promise.resolve().then(async () => {
      let rpc: WorkspaceAgentRpc | undefined
      let journal: { captureProcesses(processes: ReadonlyArray<WorkerProcessIdentity>): Promise<void>; close(): void } | undefined
      try {
        await capture
        this.assertWorkspaceCoordinatorGrantCurrent(grant)
        if (!grant.workersHash) throw unavailable()
        const records = require('../../scripts/lib/workspace-relocation-intent.mjs')
        const connection = await this.openWorkspaceRelocationAgentRpc(grant)
        rpc = connection
        const result = await connection.call('capture_workspace_relocation_processes',
          { intent_id: grant.proof.intent_id, launch_id: grant.proof.launch_id }, { authorizationBearer: grant.token })
        this.assertWorkspaceCoordinatorGrantCurrent(grant)
        if (!result || typeof result !== 'object' || Array.isArray(result) || Object.keys(result).length !== 1
          || !Object.prototype.hasOwnProperty.call(result, 'processes')) throw unavailable()
        const reply = result as Partial<CaptureWorkspaceRelocationProcessesResult>
        const fields = ['pid', 'parent', 'started', 'owner', 'executable']
        if (!Array.isArray(reply.processes) || reply.processes.length > 32768
          || reply.processes.some(item => !item || typeof item !== 'object' || Array.isArray(item)
            || Object.keys(item).length !== fields.length || !Object.keys(item).every(key => fields.includes(key)))
          || new Set(reply.processes.map(item => item.pid)).size !== reply.processes.length) throw unavailable()
        const { captureOwnedProcessTree } = require('../../scripts/lib/owned-process-tree.cjs')
        const processes: ReadonlyArray<WorkerProcessIdentity> = captureOwnedProcessTree(reply.processes)
        const { launch } = records.readWorkspaceRelocationCoordinator(this.dataDir, grant.proof.intent_id)
        const { createWorkspaceWorkerJournal } = require('../../scripts/lib/workspace-worker-journal.mjs')
        const channel = createWorkspaceWorkerJournal(child, { dataDir: this.dataDir, id: grant.proof.intent_id, launch })
        journal = channel
        await channel.captureProcesses(processes)
        this.assertWorkspaceCoordinatorGrantCurrent(grant)
        const fixed = records.readWorkspaceRelocationProcesses(this.dataDir, grant.proof.intent_id)
        if (!fixed || fixed.workers_sha256 !== grant.workersHash || sha256CanonicalJson(fixed.processes) !== sha256CanonicalJson(processes)) throw unavailable()
        grant.processesHash = sha256CanonicalJson(fixed)
        return processes
      } catch { throw unavailable() }
      finally { journal?.close(); rpc?.close() }
    })
    return grant.captureProcesses
  }

  private async captureWorkspaceRelocationModulesForCoordinator(child: ChildProcess): Promise<ReadonlyArray<WorkspaceModuleScope>> {
    const grant = this.workspaceCoordinatorGrant
    const unavailable = () => Object.assign(new Error('原执行模块范围无法确认，已保留维护保护；未重新捕获。'), { code: 'SERVICE_UNAVAILABLE' })
    if (!grant || grant.child !== child || !grant.captureProcesses) throw unavailable()
    const capture = grant.captureProcesses
    this.assertWorkspaceCoordinatorGrantCurrent(grant)
    if (!grant.captureModules) grant.captureModules = Promise.resolve().then(async () => {
      let journal: { capture(modules: ReadonlyArray<WorkspaceModuleScope>): Promise<void>; close(): void } | undefined
      try {
        await capture
        this.assertWorkspaceCoordinatorGrantCurrent(grant)
        if (!grant.processesHash) throw unavailable()
        const scope = await this.captureWorkspaceRelocationModules()
        this.assertWorkspaceCoordinatorGrantCurrent(grant)
        const records = require('../../scripts/lib/workspace-relocation-intent.mjs')
        const { launch } = records.readWorkspaceRelocationCoordinator(this.dataDir, grant.proof.intent_id)
        const { createWorkspaceModuleJournal } = require('../../scripts/lib/workspace-module-journal.mjs')
        const channel = createWorkspaceModuleJournal(child, { dataDir: this.dataDir, id: grant.proof.intent_id, launch })
        journal = channel
        await channel.capture(scope)
        this.assertWorkspaceCoordinatorGrantCurrent(grant)
        const fixed = records.readWorkspaceRelocationModules(this.dataDir, grant.proof.intent_id)
        if (!fixed || fixed.workers_sha256 !== grant.workersHash || sha256CanonicalJson(fixed.modules) !== sha256CanonicalJson(scope)) throw unavailable()
        grant.modulesHash = sha256CanonicalJson(fixed)
        return scope
      } catch { throw unavailable() }
      finally { journal?.close() }
    })
    return grant.captureModules
  }

  private async stopWorkspaceRelocationWorkersForCoordinator(child: ChildProcess): Promise<StopWorkspaceRelocationWorkersResult> {
    const grant = this.workspaceCoordinatorGrant
    const unavailable = () => Object.assign(new Error('原执行器停止提交无法确认，已保留维护保护；未重发。'), { code: 'SERVICE_UNAVAILABLE' })
    if (!grant || grant.child !== child || !grant.capture) throw unavailable()
    const capture = grant.capture
    this.assertWorkspaceCoordinatorGrantCurrent(grant)
    if (!grant.stop) grant.stop = Promise.resolve().then(async () => {
      let rpc: WorkspaceAgentRpc | undefined
      try {
        const workers = await capture
        const connection = await this.openWorkspaceRelocationAgentRpc(grant)
        rpc = connection
        const result = await connection.call('stop_workspace_relocation_workers',
          { intent_id: grant.proof.intent_id, launch_id: grant.proof.launch_id }, { authorizationBearer: grant.token })
        this.assertWorkspaceCoordinatorGrantCurrent(grant)
        if (!result || typeof result !== 'object' || Array.isArray(result) || Object.keys(result).length !== 2
          || !Object.keys(result).every(key => key === 'dispatch' || key === 'results')) throw unavailable()
        const reply = result as Partial<StopWorkspaceRelocationWorkersResult>
        if (reply.dispatch !== 'dispatch' && reply.dispatch !== 'observe' || !Array.isArray(reply.results)) throw unavailable()
        const records = require('../../scripts/lib/workspace-relocation-intent.mjs')
        if (sha256CanonicalJson(records.readWorkspaceRelocationWorkers(this.dataDir, grant.proof.intent_id).workers) !== sha256CanonicalJson(workers)) throw unavailable()
        const stopped = records.readWorkspaceRelocationStops(this.dataDir, grant.proof.intent_id)
        if (!stopped.attempt) throw unavailable()
        if (reply.dispatch === 'observe') {
          if (reply.results.length) throw unavailable()
          return Object.freeze({ dispatch: 'observe' as const, results: Object.freeze([]) })
        }
        if (!stopped.submission || sha256CanonicalJson(stopped.submission.results) !== sha256CanonicalJson(reply.results)) throw unavailable()
        const results: WorkspaceRelocationStopResult[] = stopped.submission.results
        return Object.freeze({ dispatch: 'dispatch' as const, results: Object.freeze(results.map(item => Object.freeze({ ...item }))) })
      } catch { throw unavailable() }
      finally { rpc?.close() }
    })
    return grant.stop
  }

  private requireWorkspaceCoordinatorGrant(bearer?: string): WorkspaceCoordinatorGrant {
    const grant = this.workspaceCoordinatorGrant
    if (!bearer) throw Object.assign(new Error('Coordinator credential required'), { code: 'UNAUTHORIZED' })
    if (!grant) throw Object.assign(new Error('Coordinator credential revoked'), { code: 'FORBIDDEN' })
    const supplied = Buffer.from(bearer), expected = Buffer.from(grant.token)
    if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) throw Object.assign(new Error('Invalid coordinator credential'), { code: 'FORBIDDEN' })
    return grant
  }

  private openWorkspaceRelocationWorkerJournal(grant: WorkspaceCoordinatorGrant): { workers: ReadonlyArray<WorkspaceRelocationWorker>; journal: WorkspaceWorkerStopJournal } {
    this.assertWorkspaceCoordinatorGrantCurrent(grant)
    const records = require('../../scripts/lib/workspace-relocation-intent.mjs')
    const scope = records.readWorkspaceRelocationWorkers(this.dataDir, grant.proof.intent_id)
    if (!scope) throw new Error('Fixed Worker scope required')
    const { launch } = records.readWorkspaceRelocationCoordinator(this.dataDir, grant.proof.intent_id)
    const { createWorkspaceWorkerJournal } = require('../../scripts/lib/workspace-worker-journal.mjs')
    return { workers: scope.workers, journal: createWorkspaceWorkerJournal(grant.child, { dataDir: this.dataDir, id: grant.proof.intent_id, launch }) }
  }

  private async handlePrepareWorkspaceRelocationWorkerStops(params: PrepareWorkspaceRelocationWorkerStopsParams, context?: RpcHandlerContext): Promise<PrepareWorkspaceRelocationWorkerStopsResult> {
    const grant = this.requireWorkspaceCoordinatorGrant(context?.authorizationBearer)
    if (!params || typeof params !== 'object' || Array.isArray(params) || Object.keys(params).length !== 2
      || !Object.keys(params).every(key => key === 'intent_id' || key === 'launch_id')) {
      throw Object.assign(new Error('Invalid Worker stop preparation params'), { code: 'INVALID_PARAMS' })
    }
    this.handleVerifyWorkspaceRelocationCoordinator({ ...params, action: 'stop_workers' }, context)
    let channel: WorkspaceWorkerStopJournal | undefined
    try {
      const { journal, workers } = this.openWorkspaceRelocationWorkerJournal(grant)
      channel = journal
      const dispatch = await journal.prepare(workers)
      this.assertWorkspaceCoordinatorGrantCurrent(grant)
      return { dispatch }
    } catch { throw Object.assign(new Error('停止尝试未能确认，已保留维护保护。'), { code: 'SERVICE_UNAVAILABLE' }) }
    finally { channel?.close() }
  }

  private async handleCompleteWorkspaceRelocationWorkerStops(params: CompleteWorkspaceRelocationWorkerStopsParams, context?: RpcHandlerContext): Promise<CompleteWorkspaceRelocationWorkerStopsResult> {
    const grant = this.requireWorkspaceCoordinatorGrant(context?.authorizationBearer)
    if (!params || typeof params !== 'object' || Array.isArray(params) || Object.keys(params).length !== 3
      || !Object.keys(params).every(key => key === 'intent_id' || key === 'launch_id' || key === 'results') || !Array.isArray(params.results)) {
      throw Object.assign(new Error('Invalid Worker stop completion params'), { code: 'INVALID_PARAMS' })
    }
    this.handleVerifyWorkspaceRelocationCoordinator({ intent_id: params.intent_id, launch_id: params.launch_id, action: 'stop_workers' }, context)
    let channel: WorkspaceWorkerStopJournal | undefined
    try {
      const { journal } = this.openWorkspaceRelocationWorkerJournal(grant)
      channel = journal
      await journal.complete(params.results)
      this.assertWorkspaceCoordinatorGrantCurrent(grant)
      return { recorded: true }
    } catch { throw Object.assign(new Error('停止提交回执未能确认，已保留维护保护。'), { code: 'SERVICE_UNAVAILABLE' }) }
    finally { channel?.close() }
  }

  private handleVerifyWorkspaceRelocationCoordinator(
    params: VerifyWorkspaceRelocationCoordinatorParams, context?: RpcHandlerContext,
  ): VerifyWorkspaceRelocationCoordinatorResult {
    const grant = this.requireWorkspaceCoordinatorGrant(context?.authorizationBearer)
    const uuid = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value)
    if (!params || typeof params !== 'object' || Array.isArray(params) || Object.keys(params).length !== 3
      || !Object.keys(params).every(key => key === 'intent_id' || key === 'launch_id' || key === 'action')
      || !uuid(params.intent_id) || !uuid(params.launch_id) || !['capture_workers', 'stop_workers'].includes(params.action)) {
      throw Object.assign(new Error('Invalid coordinator verification parameters'), { code: 'INVALID_PARAMS' })
    }
    if (params.intent_id !== grant.proof.intent_id || params.launch_id !== grant.proof.launch_id) throw Object.assign(new Error('Coordinator job mismatch'), { code: 'FORBIDDEN' })
    this.assertWorkspaceCoordinatorGrantCurrent(grant)
    return { verified: true, ...grant.proof, action: params.action }
  }

  async captureWorkspaceRelocationModules(): Promise<ReadonlyArray<WorkspaceModuleScope>> {
    const fail = (): never => { throw Object.assign(new Error('执行模块范围无法完整核验，保留维护保护。'), { code: 'CRABOT_WORKSPACE_MODULE_SCOPE' }) }
    const requireFence = (): void => { if (!workspaceMaintenancePending(this.dataDir) || this.isShuttingDown) fail() }
    const executionQueues = (): Promise<void>[] => [...this.lifecycleQueues]
      .filter(([id]) => id !== 'admin-web').map(([, pending]) => pending)
    requireFence()
    for (;;) {
      const pending = executionQueues()
      if (!pending.length) break
      await Promise.all(pending)
      requireFence()
    }
    const snapshots = [...this.modules].filter(([id]) => id !== 'admin-web').map(([id, runtime]) => {
      const child = this.processes.get(id)
      const state = child ? this.childStates.get(child) : undefined
      return { id, runtime, port: runtime.port, child, state, runtimeId: state?.runtimeId, rootPid: state?.rootPid }
    }).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
    const verifySnapshots = (): void => {
      requireFence()
      if (executionQueues().length || [...this.modules.keys()].filter(id => id !== 'admin-web').length !== snapshots.length) fail()
      for (const id of this.processes.keys()) if (id !== 'admin-web' && !snapshots.some(item => item.id === id)) fail()
      for (const item of snapshots) {
        if (this.modules.get(item.id) !== item.runtime || item.runtime.port !== item.port || this.processes.get(item.id) !== item.child) fail()
        if (!item.child) {
          if (item.runtime.pid !== undefined || item.runtime.status === 'running' || item.runtime.status === 'starting') fail()
          continue
        }
        const state = item.state
        if (!state || this.childStates.get(item.child) !== state || state.moduleId !== item.id || state.child !== item.child
          || state.runtimeId !== item.runtimeId || state.rootPid !== item.rootPid || state.rootPid !== item.child.pid || state.rootExited || state.finalizeStarted || state.termination || state.forceTermination
          || item.child.exitCode !== null || item.child.signalCode !== null) fail()
      }
    }
    verifySnapshots()
    const records = (await this.runtimeRegistry.listRecords()).filter(record => record.module_id !== 'admin-web')
    const recordKey = (items: typeof records): string => JSON.stringify([...items].sort((a, b) => a.runtime_id < b.runtime_id ? -1 : a.runtime_id > b.runtime_id ? 1 : 0))
    const originalRecords = recordKey(records), instanceId = this.runtimeRegistry.getInstanceId()
    verifySnapshots()
    if (records.length !== snapshots.filter(item => item.child).length) fail()
    const { captureSpawnedProcessTree } = require('../../scripts/lib/spawned-process-tree.cjs')
    const { inspectProcess, sameProcess } = require('../../scripts/lib/process-identity.cjs')
    const result: WorkspaceModuleScope[] = [], seenPids = new Set<number>()
    for (const item of snapshots) {
      const matching = records.filter(record => record.module_id === item.id)
      if (!item.child) {
        if (matching.length) fail()
        result.push(Object.freeze({ instance_id: instanceId, module_id: item.id, module_port: item.port, processes: Object.freeze([]) }))
        continue
      }
      const state = item.state!, record = matching[0]
      if (matching.length !== 1 || record.instance_id !== instanceId || record.runtime_id !== state.runtimeId
        || record.root_pid !== state.rootPid || record.module_port !== item.port) fail()
      if (await probeProcessStartIdentity(record.root_pid) !== record.process_start_identity) fail()
      verifySnapshots()
      const processes: WorkspaceModuleScope['processes'] = captureSpawnedProcessTree(item.child)
      if (await probeProcessStartIdentity(record.root_pid) !== record.process_start_identity) fail()
      verifySnapshots()
      const root = processes.find(process => process.pid === record.root_pid)
      if (!root || !sameProcess(root, inspectProcess(record.root_pid))) fail()
      for (const process of processes) { if (seenPids.has(process.pid)) fail(); seenPids.add(process.pid) }
      result.push(Object.freeze({ instance_id: instanceId, module_id: item.id, module_port: item.port, runtime_id: state.runtimeId, processes }))
    }
    if (recordKey((await this.runtimeRegistry.listRecords()).filter(record => record.module_id !== 'admin-web')) !== originalRecords) fail()
    verifySnapshots()
    return Object.freeze(result)
  }

  requestWorkspaceRelocationModuleStops(
    expected: ReadonlyArray<WorkspaceModuleScope>, journal: WorkspaceModuleStopJournal,
  ): Promise<WorkspaceModuleStopResponse> {
    const fingerprint = sha256CanonicalJson(expected)
    const failure = () => Object.assign(new Error('迁移模块停止范围不能更换，保留维护保护。'), { code: 'CRABOT_WORKSPACE_MODULE_SCOPE' })
    if (this.workspaceModuleStop) {
      if (this.workspaceModuleStop.fingerprint !== fingerprint) return Promise.reject(failure())
      return this.workspaceModuleStop.pending
    }
    const pending = Promise.resolve().then(async (): Promise<WorkspaceModuleStopResponse> => {
      const scope = expected
      // Descendants can exit or appear while Workers settle; retain the original known set.
      const bindingKey = (items: ReadonlyArray<WorkspaceModuleScope>): string => sha256CanonicalJson(items.map(item => {
        const rootPid = this.processes.get(item.module_id)?.pid
        const root = item.processes.find(process => process.pid === rootPid)
        if (item.runtime_id && !root) throw failure()
        return { ...item, processes: root ? [root] : [] }
      }))
      const bindings = bindingKey(scope)
      if (bindingKey(await this.captureWorkspaceRelocationModules()) !== bindings) throw failure()
      const dispatch = await journal.prepare(scope)
      if (dispatch === 'observe') return { dispatch, results: [] }
      if (dispatch !== 'dispatch' || bindingKey(await this.captureWorkspaceRelocationModules()) !== bindings) throw failure()
      const verifySet = (): void => {
        if (!workspaceMaintenancePending(this.dataDir) || this.isShuttingDown
          || JSON.stringify([...this.modules.keys()].filter(id => id !== 'admin-web').sort()) !== JSON.stringify(scope.map(item => item.module_id))) throw failure()
      }
      const results: WorkspaceModuleStopResult[] = []
      for (const item of scope) {
        verifySet()
        results.push(await this.enqueueLifecycle(item.module_id, () => this.stopWorkspaceRelocationModule(item, journal)))
      }
      verifySet()
      await journal.complete(results)
      return { dispatch, results }
    })
    this.workspaceModuleStop = { fingerprint, pending }
    return pending
  }

  private async stopWorkspaceRelocationModule(
    scope: WorkspaceModuleScope, journal: WorkspaceModuleStopJournal,
  ): Promise<WorkspaceModuleStopResult> {
    const result: WorkspaceModuleStopResult = { module_id: scope.module_id,
      ...(scope.runtime_id ? { runtime_id: scope.runtime_id } : {}), shutdown: 'not_submitted', status: 'unknown' }
    const runtime = this.modules.get(scope.module_id), child = this.processes.get(scope.module_id)
    const state = child ? this.childStates.get(child) : undefined
    if (!workspaceMaintenancePending(this.dataDir) || this.isShuttingDown || !runtime || runtime.port !== scope.module_port) return result
    if (!scope.runtime_id) {
      if (!child && !runtime.pid && runtime.status !== 'running' && runtime.status !== 'starting' && !scope.processes.length) result.status = 'inactive'
      return result
    }
    if (!child || !state || state.runtimeId !== scope.runtime_id || state.rootPid !== child.pid || state.finalizeStarted
      || state.termination || state.rootExited || !scope.processes.some(item => item.pid === child.pid)) return result
    this.cancelAutoRestart(scope.module_id)
    this.revokeRuntimeBearer(scope.module_id)
    state.intentionalReason = 'shutdown'
    // Install before any asynchronous RPC or exit callback can enter ordinary tree finalization.
    state.termination = Promise.resolve().then(async () => {
      const native = require('../../scripts/lib/process-identity.cjs')
      const { openModuleShutdownRpc } = require('../../scripts/lib/module-shutdown-rpc.cjs')
      const { stopKnownProcessScope } = require('../../scripts/lib/known-process-stop.cjs')
      const timeoutMs = Math.max(1, Math.round(this.config.shutdown_timeout * 1000))
      const assertCurrent = (): void => {
        if (!workspaceMaintenancePending(this.dataDir) || this.isShuttingDown || this.modules.get(scope.module_id) !== runtime
          || this.processes.get(scope.module_id) !== child || this.childStates.get(child) !== state
          || state.runtimeId !== scope.runtime_id || runtime.port !== scope.module_port) {
          throw new Error('Fixed module maintenance ownership changed')
        }
      }
      let rpc: { shutdown(): Promise<void>; close(): void } | undefined
      try {
        assertCurrent()
        if (!runtime.skip_health_check) {
          const listeners = scope.processes.filter(item => native.sameProcess(item, native.inspectProcess(item.pid))
            && native.listListeningTcpPorts(item.pid).includes(scope.module_port))
          if (listeners.length !== 1) throw new Error('Cannot verify the fixed module listener')
          rpc = await openModuleShutdownRpc(listeners[0], scope.module_port, {
            instance_id: scope.instance_id, module_id: scope.module_id, runtime_id: scope.runtime_id,
          }, { timeoutMs })
        }
        await stopKnownProcessScope(scope.processes, { timeoutMs,
          onObserved: async (processes: WorkspaceModuleScope['processes']) => { assertCurrent(); await journal.observe(scope.module_id, processes) },
          graceful: rpc ? async () => {
            assertCurrent()
            result.shutdown = 'unknown'
            await rpc!.shutdown()
            result.shutdown = 'submitted'
          } : undefined,
        }, { ...native, terminateKnownProcess: (process: WorkspaceModuleScope['processes'][number]) => {
          assertCurrent(); return native.terminateKnownProcess(process)
        } })
        assertCurrent()
      } finally { rpc?.close() }
    })
    try {
      await state.termination
      await this.beginChildFinalize(state, null, null)
      result.status = 'known_scope_exited'
    } catch { runtime.status = 'error' }
    return result
  }

  private async startModuleProcess(
    moduleId: ModuleId,
    entryOverride?: string,
    envOverride?: Record<string, string>
  ): Promise<void> {
    this.assertManagementOnlyAllowed(moduleId)
    this.assertAgentLifecycleAllowed(moduleId)
    this.assertCoreLifecycleInput(moduleId, entryOverride, envOverride)
    this.assertWorkspaceStartAllowed(moduleId)
    const runtime = this.modules.get(moduleId)
    if (!runtime) {
      throw new Error(`Module definition not found: ${moduleId}`)
    }
    const existingChild = this.processes.get(moduleId)
    if (existingChild) {
      const existingState = this.childStates.get(existingChild)
      if (!existingState?.finalizeStarted) {
        throw new Error(`Module already running: ${moduleId}`)
      }
      await existingState.finalized
      if (existingState.finalizeError || this.processes.has(moduleId)) {
        throw existingState.finalizeError ?? new Error(`Previous process tree still exists: ${moduleId}`)
      }
    }

    this.assertWorkspaceStartAllowed(moduleId)
    if (runtime.status === 'running' || runtime.status === 'starting') {
      throw new Error(`Module already running: ${moduleId}`)
    }

    await this.runtimeRegistry.initialize()
    await this.runtimeRegistry.recoverOrphans({
      moduleId,
      currentRuntimeIds: this.currentRuntimeIds(),
      gracefulTimeoutMs: this.config.shutdown_timeout * 1000,
    })

    // schema 检测（仅当模块声明了 data_dir）
    if (runtime.data_dir) {
      const { checkSchema } = await import('./schema-check.js')
      const result = checkSchema({ moduleDir: runtime.cwd ?? '.', dataDir: runtime.data_dir })
      if (result.kind === 'block') {
        runtime.status = 'schema_mismatch'
        runtime.schema_mismatch = {
          code_version: result.codeVersion,
          data_version: result.dataVersion,
        }
        console.error('')
        console.error(`[ModuleManager] FATAL: ${moduleId} schema mismatch`)
        console.error(`  Code expects: ${result.codeVersion}`)
        console.error(`  Data version: ${result.dataVersion ?? '(none — data exists but unversioned)'}`)
        console.error('')
        console.error('  This module will not start. To upgrade:')
        console.error('    crabot stop')
        console.error('    crabot upgrade')
        console.error('    crabot start')
        console.error('')
        return
      }
      if (result.kind === 'allow_first_install') {
        const { mkdirSync, writeFileSync } = await import('node:fs')
        this.assertWorkspaceStartAllowed(moduleId)
        mkdirSync(runtime.data_dir, { recursive: true })
        writeFileSync(`${runtime.data_dir}/SCHEMA_VERSION`, `${result.writeVersion}\n`)
        console.log(`[ModuleManager] ${moduleId}: wrote initial SCHEMA_VERSION = ${result.writeVersion}`)
      }
    }

    if (this.isShuttingDown) {
      throw new Error(`Module Manager is shutting down; refusing to spawn ${moduleId}`)
    }

    this.assertWorkspaceStartAllowed(moduleId)
    runtime.status = 'starting'
    runtime.health_check_failures = 0

    // 替换 entry 中的 {PORT} 模板
    const entry = (entryOverride ?? runtime.entry).replace(/{PORT}/g, String(runtime.port))
    const [rawCommand, ...args] = this.parseEntry(entry)
    // 把 uv 这类用户级 installer 装的工具解析成绝对路径，避开 user PATH 传播延迟
    const command = resolveExecutable(rawCommand)

    // 子进程日志同时落盘到 ${DATA_DIR}/logs/<moduleId>.log，
    // 避免子进程崩溃时 console pipe 里的栈被丢失看不到。
    // 'a' 模式 append；轮转交给用户/外部工具
    const logFile = path.join(this.logsDir, `${moduleId}.log`)
    const logStream = fs.createWriteStream(logFile, { flags: 'a' })
    logStream.write(`\n[${generateTimestamp()}] === spawn ${moduleId} ===\n`)

    // CRABOT_ADMIN_ENDPOINT 的权威来源是 MM 的端口分配，不是 main.ts 里 `19001+OFFSET`
    // 的静态猜测。历史 bug：main.ts 派生 ADMIN_RPC_PORT=19001，但 admin 实际绑端口池分配到的
    // 端口（首个池端口=19002），两者不一致 → agent/memory 启动 pull get_agent_config 连 19001
    // （无人监听）永远失败，只能靠 module_started 推送兜底；一旦错过推送竞态就永久 unconfigured。
    // 这里用 admin 模块真实分配的端口覆盖静态值，让启动 pull 这条主路径可靠工作。
    const adminRpcPort = this.modules.get('admin-web')?.port
    const runtimeId = this.runtimeRegistry.createRuntimeId()

    const childEnv: Record<string, string> = {
      ...process.env,
      ...runtime.env,
      ...envOverride,
      Crabot_MODULE_ID: moduleId,
      Crabot_PORT: String(runtime.port),
      CRABOT_INSTANCE_ID: this.runtimeRegistry.getInstanceId(),
      CRABOT_MODULE_RUNTIME_ID: runtimeId,
      CRABOT_MM_PORT: String(this.config.port),
      CRABOT_MM_ENDPOINT: `http://localhost:${this.config.port}`,
      ...(adminRpcPort && moduleId !== 'admin-web' ? { CRABOT_ADMIN_ENDPOINT: `http://localhost:${adminRpcPort}` } : {}),
      ...(moduleId === 'admin-web' ? { CRABOT_ADMIN_STARTUP_MODE: 'core-agent-cutover', CRABOT_ADMIN_CUTOVER_BEARER: (() => { const token = crypto.randomBytes(32).toString('base64url'); (runtime as ModuleRuntime & { _pendingCutover?: { token: string; child: ChildProcess; revoked: boolean } })._pendingCutover = { token, child: undefined as unknown as ChildProcess, revoked: false }; return token })() } : {}),
    }
    if (moduleId !== 'admin-web') {
      for (const key of Object.keys(childEnv)) {
        if (['CRABOT_JWT_SECRET', 'CRABOT_ADMIN_PASSWORD', 'CRABOT_ADMIN_CUTOVER_BEARER'].includes(key.toUpperCase())) delete childEnv[key]
      }
    }
    delete childEnv.CRABOT_VOICE_RUNTIME_BEARER
    // Runtime credentials bind only the exact core Agent or voice child.
    if (moduleId === 'crabot-agent' || this.isVoiceModule(moduleId)) {
      const token = crypto.randomBytes(32).toString('base64url')
      const bearer = { token, child: undefined as unknown as ChildProcess, revoked: false }
      delete childEnv.CRABOT_CORE_AGENT_RUNTIME_BEARER
      childEnv[moduleId === 'crabot-agent' ? 'CRABOT_CORE_AGENT_RUNTIME_BEARER' : 'CRABOT_VOICE_RUNTIME_BEARER'] = token
      // bound to the exact child immediately after spawn below
      ;(runtime as ModuleRuntime & { _pendingBearer?: typeof bearer })._pendingBearer = bearer
    } else {
      delete childEnv.CRABOT_CORE_AGENT_RUNTIME_BEARER
    }
    const clearPendingCredentials = (): void => {
      delete (runtime as ModuleRuntime & { _pendingBearer?: unknown })._pendingBearer
      delete (runtime as ModuleRuntime & { _pendingCutover?: unknown })._pendingCutover
    }

    let proc: ChildProcess
    try {
      proc = spawn(command, args, {
        cwd: runtime.cwd,
        env: childEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
      })
    } catch (error) {
      clearPendingCredentials()
      runtime.status = 'error'
      logStream.end(`[${generateTimestamp()}] === spawn failed ${moduleId} ===\n`)
      throw error
    }
    let spawnError: Error | undefined
    const captureSpawnError = (error: Error): void => { spawnError = error }
    proc.once('error', captureSpawnError)
    if (!proc.pid && !spawnError) {
      await new Promise<void>((resolve) => {
        const settled = (): void => {
          proc.removeListener('spawn', settled)
          proc.removeListener('error', settled)
          resolve()
        }
        proc.once('spawn', settled)
        proc.once('error', settled)
      })
    }
    if (!proc.pid) {
      proc.removeListener('error', captureSpawnError)
      clearPendingCredentials()
      runtime.status = 'error'
      logStream.end(`[${generateTimestamp()}] === spawn failed ${moduleId} ===\n`)
      throw spawnError ?? new Error(`Spawn did not return a PID for module ${moduleId}`)
    }

    try {
      await this.runtimeRegistry.recordSpawn({
        runtimeId,
        moduleId,
        rootPid: proc.pid,
        modulePort: runtime.port,
      })
    } catch (error) {
      let cleanupError: unknown
      try {
        await terminateProcessTree(proc.pid, {
          gracefulTimeoutMs: 0,
          forceImmediately: true,
          modulePort: runtime.port,
        })
      } catch (terminationError) {
        cleanupError = terminationError
      }
      await this.runtimeRegistry.removeRuntime(runtimeId).catch((removeError) => {
        cleanupError ??= removeError
      })
      proc.removeListener('error', captureSpawnError)
      clearPendingCredentials()
      runtime.status = 'error'
      logStream.end(`[${generateTimestamp()}] === runtime registration failed ${moduleId} ===\n`)
      if (cleanupError) {
        throw new Error(
          `Failed to persist runtime ${runtimeId} and clean up PID ${proc.pid}: ${String(cleanupError)}`,
        )
      }
      throw error
    }
    const pendingBearer = (runtime as ModuleRuntime & { _pendingBearer?: { token: string; child: ChildProcess; revoked: boolean } })._pendingBearer
    if (pendingBearer) {
      pendingBearer.child = proc
      this.runtimeBearers.set(moduleId, pendingBearer)
      delete (runtime as ModuleRuntime & { _pendingBearer?: unknown })._pendingBearer
    }
    const pendingCutover = (runtime as ModuleRuntime & { _pendingCutover?: { token: string; child: ChildProcess; revoked: boolean } })._pendingCutover
    if (pendingCutover) {
      pendingCutover.child = proc
      this.cutoverBearers.set(moduleId, pendingCutover)
      delete (runtime as ModuleRuntime & { _pendingCutover?: unknown })._pendingCutover
    }

    this.processes.set(moduleId, proc)
    runtime.pid = proc.pid

    let resolveFinalized!: () => void
    const finalized = new Promise<void>(resolve => { resolveFinalized = resolve })
    const childState: ManagedChildState = {
      moduleId,
      runtimeId,
      child: proc,
      rootPid: proc.pid,
      rootExited: false,
      reachedRunning: false,
      finalizeStarted: false,
      finalized,
      resolveFinalized,
      logStream,
      logEnded: false,
    }
    this.childStates.set(proc, childState)

    // 处理输出：同时落盘 + 终端转发（dev/调试可见）
    proc.stdout?.on('data', (data: Buffer) => {
      if (!childState.logEnded) logStream.write(data)
      console.log(`[${moduleId}] ${data.toString().trim()}`)
    })

    proc.stderr?.on('data', (data: Buffer) => {
      if (!childState.logEnded) logStream.write(data)
      console.error(`[${moduleId}] ${data.toString().trim()}`)
    })

    const finalize = (code: number | null, signal: NodeJS.Signals | null, processError?: Error): void => {
      this.beginChildFinalize(childState, code, signal, processError).catch((error) => {
        console.error(`[ModuleManager] Finalize failed for ${moduleId}:`, error)
      })
    }

    proc.removeListener('error', captureSpawnError)
    proc.once('exit', (code, signal) => {
      childState.rootExited = true
      finalize(code, signal)
    })
    proc.once('error', (error) => {
      if (!childState.finalizeStarted) {
        console.error(`[ModuleManager] Process error for ${moduleId}:`, error)
      }
      finalize(null, null, error)
    })

    if (spawnError || proc.exitCode !== null || proc.signalCode !== null) {
      childState.rootExited = true
      await this.beginChildFinalize(childState, proc.exitCode, proc.signalCode, spawnError)
      throw spawnError ?? new Error(`Module ${moduleId} exited during startup`)
    }

    console.log(`[ModuleManager] Started module: ${moduleId} (PID: ${proc.pid})`)

    // skip_health_check 模块不走 /register 流程，直接标记 running
    if (runtime.skip_health_check) {
      childState.reachedRunning = true
      runtime.status = 'running'
      runtime.registered_at = generateTimestamp()
      this.publishEvent(
        createModuleStartedEvent('module-manager', {
          module_id: moduleId,
          module_type: runtime.module_type,
          port: runtime.port,
          restart_count: runtime.restart_history?.attempts.length ?? 0,
        })
      ).catch(console.error)
    }
  }

  private async stopModuleProcess(moduleId: ModuleId, reason: ModuleStopReason): Promise<void> {
    this.revokeRuntimeBearer(moduleId)
    const runtime = this.modules.get(moduleId)
    if (!runtime) throw new Error(`Module not found: ${moduleId}`)

    const child = this.processes.get(moduleId)
    if (!child) {
      runtime.status = reason === 'health_check_failed' ? 'error' : 'stopped'
      return
    }

    const state = this.childStates.get(child)
    if (!state) throw new Error(`Missing child state for module: ${moduleId}`)

    if (!state.finalizeStarted) {
      state.intentionalReason = reason
      try {
        if (reason === 'shutdown' && !runtime.skip_health_check) {
          await this.ensureGracefulChildShutdown(state, runtime)
        } else {
          await this.ensureChildTreeTerminated(state, reason === 'forced')
        }
        if (reason === 'forced') {
          state.termination = state.forceTermination
          state.finalizeError = undefined
        }
      } catch (error) {
        runtime.status = 'error'
        state.finalizeError = error instanceof Error ? error : new Error(String(error))
        throw error
      }
      // Usually exit/error already started finalization. If Node has not emitted it
      // yet, complete from the confirmed-empty tree instead of waiting forever.
      await this.beginChildFinalize(state, null, null)
    } else {
      if (reason === 'forced') {
        try {
          await this.ensureChildTreeTerminated(state, true)
        } catch (error) {
          runtime.status = 'error'
          state.finalizeError = error instanceof Error ? error : new Error(String(error))
          throw error
        }
        await state.finalized
        if (state.finalizeError) {
          this.resetChildFinalizeAfterConfirmedForce(state)
          await this.beginChildFinalize(state, null, null)
        }
      } else {
        await state.finalized
      }
    }

    if (state.finalizeError) throw state.finalizeError
  }

  private enqueueLifecycle<T>(moduleId: ModuleId, operation: () => Promise<T>): Promise<T> {
    const previous = this.lifecycleQueues.get(moduleId) ?? Promise.resolve()
    const result = previous.then(operation, operation)
    const settled = result.then(() => undefined, () => undefined)
    this.lifecycleQueues.set(moduleId, settled)
    settled.then(() => {
      if (this.lifecycleQueues.get(moduleId) === settled) this.lifecycleQueues.delete(moduleId)
    })
    return result
  }

  private currentRuntimeIds(): Set<string> {
    const runtimeIds = new Set<string>()
    for (const child of this.processes.values()) {
      const state = this.childStates.get(child)
      if (state) runtimeIds.add(state.runtimeId)
    }
    return runtimeIds
  }

  private cancelAutoRestart(moduleId: ModuleId): void {
    const timer = this.restartTimers.get(moduleId)
    if (!timer) return
    clearTimeout(timer)
    this.restartTimers.delete(moduleId)
  }

  private async terminateChildTree(state: ManagedChildState, forceImmediately: boolean): Promise<void> {
    if (!state.rootPid) {
      if (state.finalReason === 'crashed' && state.reachedRunning) {
        throw new Error(`Cannot confirm process ownership for crashed module ${state.moduleId}`)
      }
      // spawn errors with no PID cannot have created an owned process tree.
      return
    }
    const runtime = this.modules.get(state.moduleId)
    await terminateProcessTree(state.rootPid, {
      gracefulTimeoutMs: this.config.shutdown_timeout * 1000,
      forceImmediately,
      modulePort: runtime?.port,
      requireOwnedProcess: state.finalReason === 'crashed',
      isRootPidExited: () => state.rootExited,
    })
  }

  private resetChildFinalizeAfterConfirmedForce(state: ManagedChildState): void {
    let resolveFinalized!: () => void
    state.finalized = new Promise<void>(resolve => { resolveFinalized = resolve })
    state.resolveFinalized = resolveFinalized
    state.finalizeStarted = false
    state.finalizeError = undefined
    state.termination = state.forceTermination ?? Promise.resolve()
  }

  private async ensureGracefulChildShutdown(
    state: ManagedChildState,
    runtime: ModuleRuntime,
  ): Promise<void> {
    state.termination ??= this.requestGracefulChildShutdown(state, runtime)
    await state.termination
  }

  private async requestGracefulChildShutdown(
    state: ManagedChildState,
    runtime: ModuleRuntime,
  ): Promise<void> {
    const timeoutMs = this.config.shutdown_timeout * 1000
    const deadline = Date.now() + timeoutMs
    try {
      await this.sendToModule<Record<string, never>>(
        runtime.port,
        'shutdown',
        {},
        timeoutMs,
      )
    } catch (error) {
      console.warn(
        `[ModuleManager] Graceful shutdown RPC failed for ${runtime.module_id}: `
        + `${error instanceof Error ? error.message : String(error)}`,
      )
    }

    if (!state.rootPid) return
    const remainingMs = Math.max(0, deadline - Date.now())
    if (await waitForProcessTreeExit(
      state.rootPid,
      remainingMs,
      25,
      runtime.port,
      () => state.rootExited,
    )) return
    await terminateProcessTree(state.rootPid, {
      gracefulTimeoutMs: 0,
      forceImmediately: true,
      modulePort: runtime.port,
      isRootPidExited: () => state.rootExited,
    })
  }

  private async ensureChildTreeTerminated(state: ManagedChildState, forceImmediately = false): Promise<void> {
    if (forceImmediately) {
      state.forceTermination ??= this.terminateChildTree(state, true)
      await state.forceTermination
      return
    }
    state.termination ??= this.terminateChildTree(state, false)
    await state.termination
  }

  private async beginChildFinalize(
    state: ManagedChildState,
    _code: number | null,
    _signal: NodeJS.Signals | null,
    processError?: Error,
  ): Promise<void> {
    if (state.finalizeStarted) {
      await state.finalized
      if (state.finalizeError) throw state.finalizeError
      return
    }

    state.finalizeStarted = true
    state.finalReason = state.intentionalReason ?? 'crashed'
    const runtime = this.modules.get(state.moduleId)
    const bearer = this.runtimeBearers.get(state.moduleId)
    if (bearer && bearer.child === state.child) bearer.revoked = true
    const cutover = this.cutoverBearers.get(state.moduleId)
    if (cutover && cutover.child === state.child) cutover.revoked = true


    try {
      if (this.workspaceRecoveryPaused(state.moduleId) && !state.intentionalReason && !state.termination) {
        throw Object.assign(new Error('迁移期间模块意外退出，进程范围尚待核验。'), { code: 'CRABOT_WORKSPACE_MODULE_SCOPE' })
      }
      await this.ensureChildTreeTerminated(state)
      await this.runtimeRegistry.removeRuntime(state.runtimeId)
      const isCurrent = this.processes.get(state.moduleId) === state.child
      if (!isCurrent || !runtime) return

      this.processes.delete(state.moduleId)
      runtime.pid = undefined
      runtime.status = state.finalReason === 'shutdown' || state.finalReason === 'forced'
        ? 'stopped'
        : 'error'

      if (!state.reachedRunning) return

      this.removeSubscriptionsBySubscriber(state.moduleId)
      this.publishEvent(
        createModuleStoppedEvent('module-manager', {
          module_id: state.moduleId,
          module_type: runtime.module_type,
          reason: state.finalReason,
        }),
      ).catch(console.error)

      if (state.finalReason === 'crashed' || state.finalReason === 'health_check_failed') {
        await this.scheduleAutomaticRestart(runtime)
      }
    } catch (error) {
      state.finalizeError = error instanceof Error ? error : new Error(String(error))
      if (runtime && this.processes.get(state.moduleId) === state.child) runtime.status = 'error'
      throw state.finalizeError
    } finally {
      if (!state.logEnded) {
        state.logEnded = true
        state.logStream.end(
          `[${generateTimestamp()}] === exit ${state.moduleId}${processError ? ` error=${processError.message}` : ''} ===\n`,
        )
      }
      state.resolveFinalized()
    }
  }

  private workspaceRecoveryPaused(moduleId: ModuleId): boolean {
    return moduleId !== 'admin-web' && workspaceMaintenancePending(this.dataDir)
  }

  private async scheduleAutomaticRestart(runtime: ModuleRuntime): Promise<void> {
    if (this.isShuttingDown || !runtime.auto_restart) {
      await this.transitionHealthStatus(runtime, 'unhealthy')
      return
    }

    if (this.workspaceRecoveryPaused(runtime.module_id)) return

    const decision = scheduleRestart(runtime.restart_history ?? { attempts: [] }, Date.now())
    runtime.restart_history = decision.next_history
    if (!decision.should_restart) {
      console.error(`[ModuleManager] ${runtime.module_id} restart suppressed: ${decision.reason}`)
      await this.transitionHealthStatus(runtime, 'unhealthy')
      return
    }

    console.log(
      `[ModuleManager] Auto-restart ${runtime.module_id} in ${decision.delay_ms}ms `
      + `(attempt ${decision.next_history.attempts.length}/3)`,
    )
    const timer = setTimeout(() => {
      if (this.restartTimers.get(runtime.module_id) !== timer) return
      this.restartTimers.delete(runtime.module_id)
      this.enqueueLifecycle(runtime.module_id, async () => {
        if (this.isShuttingDown || this.processes.has(runtime.module_id)) return
        const env = runtime.module_id === 'crabot-agent'
          ? {}
          : { ...(this.envOverrides.get(runtime.module_id) ?? {}) }
        await this.startModuleProcess(runtime.module_id, undefined, env)
      }).catch((error) => {
        console.error(`[ModuleManager] Auto-restart failed for ${runtime.module_id}:`, error)
      })
    }, decision.delay_ms)
    this.restartTimers.set(runtime.module_id, timer)
  }

  private parseEntry(entry: string): string[] {
    // 简单解析：支持 "node script.js" 或 "npm start" 等
    const parts = entry.match(/(?:[^\s"]+|"[^"]*")+/g) ?? [entry]
    return parts.map((p) => p.replace(/^"|"$/g, ''))
  }

  // ============================================================================
  // 健康检查
  // ============================================================================

  private startHealthCheckTimer(): void {
    this.healthCheckTimer = setInterval(() => {
      this.runHealthChecks().catch(console.error)
    }, this.config.health_check_interval * 1000)
  }

  private async runHealthChecks(): Promise<void> {
    const runningModules = Array.from(this.modules.values()).filter(
      (m) => m.status === 'running' && !m.skip_health_check
    )

    await Promise.all(runningModules.map((m) => this.checkModuleHealth(m)))
  }

  private async checkModuleHealth(runtime: ModuleRuntime): Promise<void> {
    if (this.healthProbes.has(runtime.module_id) || this.healthRecoveries.has(runtime.module_id)) return
    this.healthProbes.add(runtime.module_id)
    const probedChild = this.processes.get(runtime.module_id)

    try {
      const result = await this.sendToModule<HealthResult>(runtime.port, 'health', {})
      if (this.processes.get(runtime.module_id) !== probedChild) return
      runtime.last_health_check = generateTimestamp()
      if (!result || !['healthy', 'degraded', 'unhealthy'].includes(result.status)) {
        throw new Error(`Invalid health status: ${String(result?.status)}`)
      }

      if (result.status === 'unhealthy') {
        await this.recordHealthFailure(runtime, probedChild, undefined, true)
      } else {
        runtime.health_check_failures = 0
        await this.transitionHealthStatus(runtime, result.status)
      }
    } catch (error) {
      if (this.processes.get(runtime.module_id) !== probedChild) return
      runtime.last_health_check = generateTimestamp()
      await this.recordHealthFailure(runtime, probedChild, error)
    } finally {
      this.healthProbes.delete(runtime.module_id)
    }
  }

  private async recordHealthFailure(
    runtime: ModuleRuntime,
    failedChild: ChildProcess | undefined,
    error?: unknown,
    explicitlyUnhealthy = false,
  ): Promise<void> {
    runtime.health_check_failures = (runtime.health_check_failures ?? 0) + 1
    console.warn(
      `[ModuleManager] Health check failed for ${runtime.module_id} `
      + `(${runtime.health_check_failures}/${this.config.health_check_failure_threshold})`
      + (error ? `: ${error instanceof Error ? error.message : String(error)}` : ''),
    )

    if (explicitlyUnhealthy) await this.transitionHealthStatus(runtime, 'unhealthy')
    if (runtime.health_check_failures < this.config.health_check_failure_threshold) return

    await this.transitionHealthStatus(runtime, 'unhealthy')
    this.scheduleHealthRecovery(runtime, failedChild)
  }

  private async transitionHealthStatus(runtime: ModuleRuntime, current: HealthResult['status']): Promise<void> {
    const previous = runtime.last_health_status ?? 'healthy'
    const changed = previous !== current
    runtime.last_health_status = current
    if (!changed) return

    await this.publishEvent(
      createModuleHealthChangedEvent('module-manager', {
        module_id: runtime.module_id,
        previous,
        current,
      }),
    )
  }

  private scheduleHealthRecovery(runtime: ModuleRuntime, failedChild: ChildProcess | undefined): void {
    if (this.isShuttingDown || this.workspaceRecoveryPaused(runtime.module_id) || this.healthRecoveries.has(runtime.module_id)) return
    this.healthRecoveries.add(runtime.module_id)

    this.enqueueLifecycle(runtime.module_id, async () => {
      if (!failedChild || this.processes.get(runtime.module_id) !== failedChild) {
        if (!this.processes.has(runtime.module_id) && runtime.status === 'running') runtime.status = 'error'
        return
      }
      if (this.workspaceRecoveryPaused(runtime.module_id)) return
      await this.stopModuleProcess(runtime.module_id, 'health_check_failed')
    }).catch((error) => {
      runtime.status = 'error'
      console.error(`[ModuleManager] Health recovery failed for ${runtime.module_id}:`, error)
    }).finally(() => {
      this.healthRecoveries.delete(runtime.module_id)
    })
  }

  // ============================================================================
  // 辅助方法
  // ============================================================================

  // 倒序遍历以避免 splice 后索引偏移
  private removeSubscriptionsBySubscriber(moduleId: ModuleId): number {
    let removed = 0
    for (let i = this.subscriptions.length - 1; i >= 0; i--) {
      if (this.subscriptions[i].subscriber === moduleId) {
        this.subscriptions.splice(i, 1)
        removed++
      }
    }
    return removed
  }

  private findSubscribers(eventType: string): ModuleId[] {
    const result: ModuleId[] = []

    for (const sub of this.subscriptions) {
      for (const pattern of sub.eventTypes) {
        if (this.matchEventType(eventType, pattern)) {
          result.push(sub.subscriber)
          break
        }
      }
    }

    return result
  }

  private matchEventType(eventType: string, pattern: string): boolean {
    if (pattern === '*') return true
    if (pattern.endsWith('.*')) {
      const prefix = pattern.slice(0, -2)
      return eventType.startsWith(prefix + '.')
    }
    return eventType === pattern
  }

  private async sendToModule<R>(
    port: number,
    method: string,
    params: unknown,
    timeoutMs = this.config.health_check_timeout * 1000,
  ): Promise<R> {
    return new Promise((resolve, reject) => {
      let settled = false
      let absoluteTimer: NodeJS.Timeout | undefined
      const clearAbsoluteTimer = (): void => {
        if (absoluteTimer) clearTimeout(absoluteTimer)
        absoluteTimer = undefined
      }
      const succeed = (value: R): void => {
        if (settled) return
        settled = true
        clearAbsoluteTimer()
        resolve(value)
      }
      const fail = (error: unknown): void => {
        if (settled) return
        settled = true
        clearAbsoluteTimer()
        reject(error instanceof Error ? error : new Error(String(error)))
      }

      const request: Request = {
        id: generateId(),
        source: 'module-manager',
        method,
        params,
        timestamp: generateTimestamp(),
      }

      const body = JSON.stringify(request)
      const req = http.request(
        {
          hostname: 'localhost',
          port,
          method: 'POST',
          path: `/${method}`,
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
          },
          timeout: timeoutMs,
        },
        (res) => {
          let data = ''
          res.on('data', (chunk: string) => { data += chunk })
          res.on('aborted', () => fail(new Error('Response aborted')))
          res.on('error', fail)
          res.on('close', () => {
            if (!res.complete) fail(new Error('Response closed before completion'))
          })
          res.on('end', () => {
            try {
              const response: Response<R> = JSON.parse(data) as Response<R>
              if (response.success) succeed(response.data as R)
              else fail(new Error(response.error?.message ?? 'Unknown error'))
            } catch (error) {
              fail(new Error(`Failed to parse response: ${String(error)}`))
            }
          })
        },
      )

      absoluteTimer = setTimeout(() => {
        const error = new Error('Request deadline exceeded')
        req.destroy(error)
        fail(error)
      }, timeoutMs)
      req.on('error', fail)
      req.on('timeout', () => {
        const error = new Error('Request timeout')
        req.destroy(error)
        fail(error)
      })
      req.write(body)
      req.end()
    })
  }

  private async publishEvent(event: Event): Promise<void> {
    await this.handlePublishEvent({ event })
  }

  private async startAutoStartModules(): Promise<void> {
    const autoStartModules = Array.from(this.modules.values())
      .filter((m) => m.auto_start
        && m.status !== 'running' && m.status !== 'starting'
        && (!this.managementOnly || m.module_id === 'admin-web'))
      .sort((a, b) => (a.module_id === 'crabot-agent' ? -1 : b.module_id === 'crabot-agent' ? 1 : a.start_priority - b.start_priority))

    for (const module of autoStartModules) {
      try {
        const env: Record<string, string> = {}
        if (module.module_id === 'crabot-agent') this.envOverrides.delete(module.module_id)
        else this.envOverrides.set(module.module_id, env)
        await this.enqueueLifecycle(
          module.module_id,
          () => this.startModuleProcess(module.module_id, undefined, env),
        )
        // 等待模块启动完成
        await new Promise((resolve) => setTimeout(resolve, 1000))
      } catch (error) {
        console.error(`[ModuleManager] Failed to auto-start module ${module.module_id}:`, error)
      }
    }

    this.printStartupSummary()
  }

  private printStartupSummary(): void {
    const modules = Array.from(this.modules.values())
    const lines: string[] = []

    lines.push('')
    lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
    lines.push('  Crabot Module Manager')
    lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
    lines.push('')

    for (const m of modules) {
      const icon =
        m.status === 'running' ? '\u2705'
        : m.status === 'error' ? '\u274c'
        : m.status === 'schema_mismatch' ? '\ud83d\udd27'
        : '\u2b55'
      const portInfo = m.status === 'running' ? `:${m.port}` : ''
      lines.push(`  ${icon} ${m.module_id} (${m.module_type}) ${m.status}${portInfo}`)
    }

    const blocked = modules.filter((m) => m.status === 'schema_mismatch')
    if (blocked.length > 0) {
      lines.push('')
      lines.push('  Modules blocked by schema mismatch (run "crabot upgrade"):')
      for (const m of blocked) {
        const sm = m.schema_mismatch
        if (sm) {
          lines.push(`    - ${m.module_id}: code=${sm.code_version}, data=${sm.data_version ?? 'none'}`)
        } else {
          lines.push(`    - ${m.module_id}`)
        }
      }
    }

    lines.push('')
    lines.push(`  Module Manager: http://localhost:${this.config.port}`)

    const vite = modules.find((m) => m.module_id === 'vite-dev')
    const admin = modules.find((m) => m.module_id === 'admin-web')

    if (vite?.status === 'running') {
      // dev 模式：只显示 Vite 地址，3000 端口对用户不可见
      lines.push(`  Frontend:       http://localhost:${vite.port}`)
    } else if (admin?.status === 'running') {
      // 非 dev 模式：显示 Admin Web 地址
      const webPort = admin.env?.CRABOT_ADMIN_WEB_PORT ?? '3000'
      lines.push(`  Admin Web:      http://localhost:${webPort}`)
    }

    lines.push('')
    console.log(lines.join('\n'))
  }
}

interface ResolveParamsInternal {
  module_id?: ModuleId
  module_type?: string
}

// 默认导出
export default ModuleManager
