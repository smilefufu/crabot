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
  type WorkspaceRecoveryRuntimePlan,
  type VerifyWorkspaceRelocationRecoveryRuntimeParams,
  type VerifyWorkspaceRelocationRecoveryRuntimeResult,
  type VerifyWorkspaceRelocationRecoveryRootResult,
  type VerifyWorkspaceRelocationRecoveryFinalizationParams,
  type VerifyWorkspaceRelocationRecoveryFinalizationResult,
  type PrepareWorkspaceRelocationRecoveryCompletionResult,
  type VerifyWorkspaceRelocationRecoveryReleaseParams,
  type VerifyWorkspaceRelocationRecoveryReleaseResult,
  type ReleaseWorkspaceRelocationRecoveryCompletionResult,
  type ResumeWorkspaceRelocationRecoveryWebResult,
  type WorkspaceRelocationJobQuery,
  type WorkspaceRelocationStatusResult,
  type WorkspaceRelocationJobStage,
  parseWorkspaceRelocationJobQuery,
  type WorkspaceRelocationStartResult,
  type VerifyWorkspaceRelocationStartParams,
  type VerifyWorkspaceRelocationStartResult,
  parseWorkspaceRelocationStartRequest,
  type VerifyWorkspaceRelocationRecoveryAdmissionParams,
  type VerifyWorkspaceRelocationRecoveryAdmissionResult,
  type VerifyWorkspaceRelocationRecoveryRequestParams,
  type VerifyWorkspaceRelocationRecoveryRequestResult,
  type VerifyWorkspaceRelocationRequestParams,
  type VerifyWorkspaceRelocationRequestResult,
  type QuiesceWorkspaceRelocationWebParams,
  type QuiesceWorkspaceRelocationWebResult,
  type VerifyWorkspaceRelocationRuntimeParams,
  type VerifyWorkspaceRelocationRuntimeResult,
  type VerifyWorkspaceRelocationCoordinatorParams,
  type VerifyWorkspaceRelocationCoordinatorResult,
  type VerifyWorkspaceRelocationFinalizationParams,
  type VerifyWorkspaceRelocationFinalizationResult,
  type PrepareWorkspaceRelocationCompletionResult,
  type ResumeWorkspaceRelocationWebResult,
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
import { ModuleRuntimeRegistry, probeProcessStartIdentity, inspectWindowsPortOwners } from './module-runtime-registry.js'
import type { ModuleRuntimeRecord, OrphanTerminationCandidate } from './module-runtime-registry.js'

// ============================================================================
// 类型定义
// ============================================================================

interface RpcHandlerContext { authorizationBearer?: string }

interface WorkspaceModuleRestorationGuard { assertCurrent: () => void; verify: () => Promise<void> }
type WorkspaceModuleDefinitions = ReadonlyMap<ModuleId, { runtime: ModuleRuntime; hash: string; overrides: string }>
const workspaceModuleProgressFields = new Set(['status', 'pid', 'version', 'protocol_version', 'registered_at', 'last_health_check', 'last_health_status', 'health_check_failures', 'restart_history', 'schema_mismatch', '_pendingBearer', '_pendingCutover'])
const workspaceModuleDefinition = (runtime: ModuleRuntime) => Object.fromEntries(Object.entries(runtime).filter(([key]) => !workspaceModuleProgressFields.has(key)))

interface WorkspaceRecoveryAdmission {
  request: VerifyWorkspaceRelocationRecoveryRequestParams
  result: VerifyWorkspaceRelocationRecoveryRequestResult
  accepted: boolean
  verify: () => Promise<void>
  consume: () => Promise<WorkspaceRecoveryInitialization>
  close: () => void
}
interface WorkspaceRecoveryCoordinator {
  child: ChildProcess
  verify: () => Promise<void>
  close: () => void
  beginCompletionObservation: () => Promise<void>
  releaseCompletion: (prepared: PrepareWorkspaceRelocationRecoveryCompletionResult, credential: string, moduleManagerPort: number) => Promise<ReleaseWorkspaceRelocationRecoveryCompletionResult>
  observeRelease: (prepared: PrepareWorkspaceRelocationRecoveryCompletionResult) => Promise<ReleaseWorkspaceRelocationRecoveryCompletionResult>
}
interface WorkspaceRecoveryRuntimePreparation { plan: WorkspaceRecoveryRuntimePlan; verify: () => Promise<void> }
interface WorkspaceRecoveryRuntimeCleanup { runtime_ids: ReadonlyArray<string>; verify: () => Promise<void> }
interface WorkspaceRecoveryValidationLaunch {
  plan: WorkspaceRecoveryRuntimePlan
  modules: ReadonlyArray<{ module_id: ModuleId; runtime_id: string; process: WorkerProcessIdentity }>
  verify: () => Promise<void>
  assertCurrent: () => void
}
interface WorkspaceRecoveryValidationHealth extends WorkspaceRecoveryValidationLaunch {
  healthy_modules: ReadonlyArray<{ module_id: ModuleId; runtime_id: string }>
  root_verified: VerifyWorkspaceRelocationRecoveryRootResult
}
interface WorkspaceRecoveryReleasedHealth {
  root_verified: VerifyWorkspaceRelocationRecoveryRootResult
  assertCurrent: () => void
  verifyRuntime: () => Promise<void>
  verify: () => Promise<void>
}
interface WorkspaceRecoveryFinalizationGrant {
  token: string
  revoked: boolean
  phase: 'preparing' | 'prepared' | 'releasing' | 'released' | 'restoring' | 'restored' | 'resuming' | 'resumed'
  releasedHealth?: WorkspaceRecoveryReleasedHealth
  verifyRestored?: () => void
  verifyActors: () => void
  verifyHealth: () => Promise<void>
  job: Readonly<Omit<PrepareWorkspaceRelocationRecoveryCompletionResult, 'prepared'>>
  verify: () => void
}
interface WorkspaceRecoveryInitialization {
  request: VerifyWorkspaceRelocationRecoveryRequestParams
  result: VerifyWorkspaceRelocationRecoveryRequestResult
  verify: () => Promise<void>
  releaseParentLock: () => void
  coordinator?: WorkspaceRecoveryCoordinator
  readScope: () => { fingerprint: string; released?: boolean }
  allowCompletionObservation: () => void
  close: () => void
}

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

interface CurrentAdminRpc {
  call(method: string, params: unknown, options?: { authorizationBearer?: string }): Promise<unknown>
  close(): void
}
interface WorkspaceFinalizationGrant {
  token: string
  revoked: boolean
  phase: 'archiving' | 'archived' | 'prepared' | 'released'
  request: VerifyWorkspaceRelocationRequestParams
  completionHash: string
  launch: { launch_id: string; parent: WorkerProcessIdentity; process: WorkerProcessIdentity }
  child: ChildProcess
  verify: () => void
  release: (prepared: PrepareWorkspaceRelocationCompletionResult) => Promise<unknown>
  observeRelease: () => Promise<unknown>
  restoreModules: () => Promise<ReadonlyArray<{ module_id: ModuleId; runtime_id: string }>>
  close: () => void
}

interface WorkspaceWorkerStopJournal {
  prepare(workers: ReadonlyArray<WorkspaceRelocationWorker>): Promise<WorkspaceRelocationStopDispatch>
  complete(results: ReadonlyArray<WorkspaceRelocationStopResult>): Promise<void>
  close(): void
}

interface WorkspaceInitialJob {
  readonly request: VerifyWorkspaceRelocationStartParams
  readonly fingerprint: string
  readonly reply: Promise<WorkspaceRelocationStartResult>
  readonly resolve: (result: WorkspaceRelocationStartResult) => void
  readonly reject: (error: Error) => void
  phase: 'preparing' | 'accepted' | 'completed' | 'needs_attention'
  stage: WorkspaceRelocationJobStage
  coordinator?: { child: ChildProcess; identity: WorkerProcessIdentity }
  proof?: VerifyWorkspaceRelocationRequestParams
  completion?: Promise<void>
}

interface WorkspaceStopSequenceResult {
  readonly coordinator: ChildProcess
  readonly workerSubmission: StopWorkspaceRelocationWorkersResult
  readonly moduleSubmission: WorkspaceModuleStopResponse
}

interface WorkspaceFilePreparationResult {
  readonly coordinator: ChildProcess
  readonly plan_sha256: string
  readonly file_actors_sha256: string
}

interface WorkspaceWorkerClosureResult {
  readonly coordinator: ChildProcess
  readonly file_ready_sha256: string
  readonly closure_plan_sha256: string
  readonly closure_commit_sha256: string
  readonly recovery_plan_sha256: string
  readonly recovery_commit_sha256: string
}

interface WorkspaceRootSelectionResult extends WorkspaceWorkerClosureResult {
  readonly root_plan_sha256: string
  readonly root_published_sha256: string
  readonly root_selected_sha256: string
}

interface WorkspaceValidationLaunchResult extends WorkspaceRootSelectionResult {
  readonly validation_modules: ReadonlyArray<{ module_id: ModuleId; runtime_id: string; process: WorkerProcessIdentity }>
}

interface WorkspaceValidationHealthResult extends WorkspaceValidationLaunchResult {
  readonly healthy_modules: ReadonlyArray<{ module_id: ModuleId; runtime_id: string }>
  readonly root_verified: VerifyWorkspaceRelocationRuntimeResult
  readonly health_sha256: string
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
  private workspaceInitialJob?: WorkspaceInitialJob
  private workspaceCoordinatorGrant?: WorkspaceCoordinatorGrant
  private workspaceStopSequence?: { fingerprint: string; pending: Promise<WorkspaceStopSequenceResult> }
  private workspaceFilePreparation?: { fingerprint: string; pending: Promise<WorkspaceFilePreparationResult> }
  private workspaceWorkerClosure?: { fingerprint: string; pending: Promise<WorkspaceWorkerClosureResult> }
  private workspaceRootSelection?: { fingerprint: string; pending: Promise<WorkspaceRootSelectionResult> }
  private workspaceValidationLaunch?: { fingerprint: string; pending: Promise<WorkspaceValidationLaunchResult> }
  private readonly workspaceRecoveryRuntimePreparations = new WeakMap<WorkspaceRecoveryCoordinator, Promise<WorkspaceRecoveryRuntimePreparation>>()
  private readonly workspaceRecoveryRuntimeCleanups = new WeakMap<WorkspaceRecoveryCoordinator, Promise<WorkspaceRecoveryRuntimeCleanup>>()
  private readonly workspaceRecoveryValidationLaunches = new WeakMap<WorkspaceRecoveryCoordinator, Promise<WorkspaceRecoveryValidationLaunch>>()
  private readonly workspaceRecoveryValidationHealth = new WeakMap<WorkspaceRecoveryCoordinator, Promise<WorkspaceRecoveryValidationHealth>>()
  private readonly workspaceRecoveryCompletionObservations = new WeakMap<WorkspaceRecoveryCoordinator, Promise<WorkspaceRecoveryValidationHealth>>()
  private readonly workspaceRecoveryCompletionPreparations = new WeakMap<WorkspaceRecoveryCoordinator, Promise<PrepareWorkspaceRelocationRecoveryCompletionResult>>()
  private readonly workspaceRecoveryCompletionReleases = new WeakMap<WorkspaceRecoveryCoordinator, Promise<ReleaseWorkspaceRelocationRecoveryCompletionResult>>()
  private readonly workspaceRecoveryWebResumes = new WeakMap<WorkspaceRecoveryCoordinator, Promise<ResumeWorkspaceRelocationRecoveryWebResult>>()
  private readonly workspaceRecoveryCompletions = new Map<string, { fingerprint: string; bearerHash: string; pending: Promise<ResumeWorkspaceRelocationRecoveryWebResult> }>()
  private workspaceRecoveryFinalizationGrant?: WorkspaceRecoveryFinalizationGrant
  private workspaceRecoveryInitialization?: WorkspaceRecoveryInitialization
  private workspaceRecoveryInitializations = new Map<string, { fingerprint: string; bearerHash: string; pending: Promise<WorkspaceRecoveryCoordinator> }>()
  private workspaceRecoveryAdmission?: WorkspaceRecoveryAdmission
  private workspaceRecoveryAdmissionPreparation?: { fingerprint: string; bearerHash: string; pending: Promise<WorkspaceRecoveryAdmission> }
  private workspaceFinalizationGrant?: WorkspaceFinalizationGrant
  private workspaceFinalizationPreparation?: { fingerprint: string; pending: Promise<PrepareWorkspaceRelocationCompletionResult> }
  private workspaceFinalizationResume?: { fingerprint: string; pending: Promise<ResumeWorkspaceRelocationWebResult> }
  private workspaceFinalizationCompletion?: { fingerprint: string; pending: Promise<ResumeWorkspaceRelocationWebResult> }
  private workspaceValidationHealth?: { fingerprint: string; pending: Promise<WorkspaceValidationHealthResult> }
  private workspaceValidationProof?: {
    request: VerifyWorkspaceRelocationRequestParams
    result: WorkspaceValidationLaunchResult
    launchId: string
    launchHash: string
    verify: () => Promise<void>
    assertCurrent: () => void
  }
  private readonly workspaceValidationPermits = new WeakMap<object, { moduleId: ModuleId; runtime: ModuleRuntime; runtimeId?: string; recoveryId?: string; verify: () => Promise<void>; assertCurrent: () => void }>()
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
    this.registerMethod<VerifyWorkspaceRelocationStartParams, WorkspaceRelocationStartResult>('start_workspace_relocation', (params, context) => this.startWorkspaceRelocation(params, context?.authorizationBearer))
    this.registerMethod<WorkspaceRelocationJobQuery, WorkspaceRelocationStatusResult>('get_workspace_relocation_status', (params, context) => this.getWorkspaceRelocationStatus(params, context?.authorizationBearer))
    this.registerMethod('register', this.handleRegisterUnauthenticated.bind(this))
    this.registerMethod('register_core_agent', this.handleRegisterCoreAgent.bind(this))
    this.registerMethod('verify_workspace_relocation_recovery_admission', this.handleVerifyWorkspaceRelocationRecoveryAdmission.bind(this))
    this.registerMethod('verify_workspace_relocation_finalization', this.handleVerifyWorkspaceRelocationFinalization.bind(this))
    this.registerMethod('verify_workspace_relocation_runtime', this.handleVerifyWorkspaceRelocationRuntime.bind(this))
    this.registerMethod('verify_workspace_relocation_recovery_runtime', this.handleVerifyWorkspaceRelocationRecoveryRuntime.bind(this))
    this.registerMethod('verify_workspace_relocation_recovery_finalization', this.handleVerifyWorkspaceRelocationRecoveryFinalization.bind(this))
    this.registerMethod('verify_workspace_relocation_recovery_release', this.handleVerifyWorkspaceRelocationRecoveryRelease.bind(this))
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
    this.workspaceRecoveryAdmission?.close()
    this.workspaceRecoveryInitialization?.close()
    if (this.workspaceFinalizationGrant) {
      this.workspaceFinalizationGrant.revoked = true
      this.workspaceFinalizationGrant.close()
      await this.closeWorkspaceCoordinatorChannel(this.workspaceFinalizationGrant.child)
    }

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

  private assertWorkspaceProcessStartCurrent(moduleId: ModuleId, permit?: object, restoration?: WorkspaceModuleRestorationGuard): void {
    if (permit && restoration) throw Object.assign(new Error('Distinct workspace startup roles cannot be combined'), { code: 'FORBIDDEN' })
    if (!permit) { this.assertWorkspaceStartAllowed(moduleId); restoration?.assertCurrent(); return }
    const binding = this.workspaceValidationPermits.get(permit)
    if (!binding || binding.moduleId !== moduleId || this.modules.get(moduleId) !== binding.runtime
      || binding.runtimeId !== undefined && !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(binding.runtimeId)
      || binding.recoveryId !== undefined && (!binding.runtimeId || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(binding.recoveryId))) {
      throw Object.assign(new Error('工作区验证启动凭据无效。'), { code: 'FORBIDDEN' })
    }
    binding.assertCurrent()
  }

  private async assertWorkspaceProcessStartAllowed(moduleId: ModuleId, permit?: object, restoration?: WorkspaceModuleRestorationGuard): Promise<void> {
    const binding = permit && this.workspaceValidationPermits.get(permit)
    this.assertWorkspaceProcessStartCurrent(moduleId, permit, restoration)
    if (!binding) {
      if (restoration) { await restoration.verify(); this.assertWorkspaceProcessStartCurrent(moduleId, permit, restoration) }
      return
    }
    await binding.verify()
    if (this.workspaceValidationPermits.get(permit!) !== binding) throw Object.assign(new Error('工作区验证启动凭据已撤销。'), { code: 'FORBIDDEN' })
    this.assertWorkspaceProcessStartCurrent(moduleId, permit)
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

  private async getWorkspaceRelocationStatus(params: WorkspaceRelocationJobQuery, bearer?: string): Promise<WorkspaceRelocationStatusResult> {
    const snapshot = params && typeof params === 'object' && !Array.isArray(params) ? Object.freeze({ ...params }) : params
    if (typeof bearer !== 'string' || !bearer) throw Object.assign(new Error('Human Admin credential required'), { code: 'UNAUTHORIZED' })
    const unavailable = () => Object.assign(new Error('当前作业查询身份无法核实。'), { code: 'SERVICE_UNAVAILABLE' })
    let query: Readonly<WorkspaceRelocationJobQuery>
    try {
      query = await this.withCurrentAdminRpc(5000, async (rpc, verify) => {
        let response: unknown
        try { response = await rpc.call('verify_workspace_relocation_job_query', snapshot, { authorizationBearer: bearer }) }
        catch (error) { await verify(); throw error }
        await verify()
        const request = parseWorkspaceRelocationJobQuery(snapshot)
        if (sha256CanonicalJson(response) !== sha256CanonicalJson({ verified: true, ...request })) throw unavailable()
        return request
      })
    } catch (error) {
      const code = (error as { remote_code?: string; code?: string }).remote_code ?? (error as { code?: string }).code
      if (code && ['UNAUTHORIZED', 'FORBIDDEN', 'INVALID_PARAMS'].includes(code)) throw Object.assign(new Error('Human workspace query rejected'), { code })
      throw unavailable()
    }
    const job = this.workspaceInitialJob
    const ownId = job && (job.proof || job.phase === 'preparing') ? job.request.intent_id : undefined
    const records = require('../../scripts/lib/workspace-relocation-intent.mjs')
    let stored: WorkspaceRelocationStatusResult
    if (query.intent_id) stored = records.readWorkspaceRelocationJobStatus(this.dataDir, query.intent_id)
    else if (job?.phase === 'preparing' || job?.phase === 'accepted') stored = records.readWorkspaceRelocationJobStatus(this.dataDir, ownId)
    else {
      stored = records.readWorkspaceRelocationJobStatus(this.dataDir)
      if (stored.available && !stored.job && ownId) stored = records.readWorkspaceRelocationJobStatus(this.dataDir, ownId)
    }
    const id = query.intent_id ?? stored.job?.intent_id ?? ownId
    if (!stored.available || !job || ownId !== id || !ownId) return stored
    if ((job.proof && !stored.job) || (job.phase === 'completed' && stored.job?.state !== 'committed')) return { available: false, job: null }
    if (job.phase === 'accepted') {
      const owner = job.coordinator, native = require('../../scripts/lib/process-identity.cjs')
      try {
        if (!owner?.child.connected || owner.child.exitCode !== null || owner.child.signalCode !== null
          || !native.sameProcess(owner.identity, native.inspectProcess(owner.child.pid))) return { available: false, job: null }
      } catch { return { available: false, job: null } }
    }
    return { available: true, job: { ...(stored.job ?? { intent_id: ownId, target: job.request.target }),
      state: job.phase === 'accepted' ? 'running' : job.phase, stage: job.stage } }
  }

  /** Progress observation only; the original effect retains all admission and role checks. */
  private noteWorkspaceRelocationJobStage(request: VerifyWorkspaceRelocationRequestParams, stage: WorkspaceRelocationJobStage): void {
    const job = this.workspaceInitialJob
    if (job?.phase === 'accepted' && job.proof && sha256CanonicalJson(job.proof) === sha256CanonicalJson(request)) job.stage = stage
  }

  private async startWorkspaceRelocation(params: VerifyWorkspaceRelocationStartParams, bearer?: string): Promise<WorkspaceRelocationStartResult> {
    const verified = await this.verifyWorkspaceRelocationStartRequest(params, bearer)
    const { verified: _, ...request } = verified
    const fingerprint = sha256CanonicalJson(request), previous = this.workspaceInitialJob
    if (previous?.request.intent_id === request.intent_id) {
      if (previous.fingerprint !== fingerprint) throw Object.assign(new Error('Original workspace confirmation cannot change'), { code: 'FORBIDDEN' })
      return previous.reply
    }
    if (previous && previous.phase !== 'completed') throw Object.assign(new Error('已有工作区作业尚未完成，请查看当前作业。'), { code: 'SERVICE_UNAVAILABLE' })
    let resolve!: WorkspaceInitialJob['resolve'], reject!: WorkspaceInitialJob['reject']
    const reply = new Promise<WorkspaceRelocationStartResult>((yes, no) => { resolve = yes; reject = no })
    const job: WorkspaceInitialJob = { request: Object.freeze(request), fingerprint, reply, resolve, reject, phase: 'preparing', stage: 'preparing' }
    this.workspaceInitialJob = job
    job.completion = this.driveInitialWorkspaceRelocation(job, bearer!)
    return reply
  }

  /** Owned by the job, not an HTTP request or its cancellation signal. */
  private async driveInitialWorkspaceRelocation(job: WorkspaceInitialJob, bearer: string): Promise<void> {
    const unavailable = () => Object.assign(new Error('迁移作业尚未确认，请查看当前作业和诊断；未自动重发。'), { code: 'SERVICE_UNAVAILABLE' })
    const locks = require('../../scripts/lib/cli-lock.mjs')
    let lock: string | undefined, token: string | undefined
    try {
      if (this.isShuttingDown || this.managementOnly || this.modules.get('crabot-agent')?.status !== 'running' || !this.processes.has('crabot-agent')) throw unavailable()
      const policy = require('../../scripts/lib/workspace-target-policy.cjs').workspaceRelocationTargetPolicy(this.dataDir)
      lock = await locks.acquireCliLock(this.dataDir, 'workspace-relocation')
      token = locks.cliLockToken(lock)
      if (!token || this.workspaceInitialJob !== job || this.isShuttingDown) throw unavailable()
      await this.verifyWorkspaceRelocationStartRequest(job.request, bearer)
      if (locks.cliLockToken(lock) !== token || this.workspaceInitialJob !== job || this.isShuttingDown || this.managementOnly
        || this.modules.get('crabot-agent')?.status !== 'running' || !this.processes.has('crabot-agent')) throw unavailable()
      const records = require('../../scripts/lib/workspace-relocation-intent.mjs')
      const intent = await records.beginWorkspaceRelocationIntent({ dataDir: this.dataDir, id: job.request.intent_id,
        target: job.request.target, expectedRevision: job.request.expected_revision, ...policy })
      if (intent.unchanged) { job.phase = 'completed'; job.stage = 'finished'; job.resolve({ unchanged: true, source: intent.source }); return }
      job.proof = Object.freeze({ intent_id: intent.id, intent_sha256: sha256CanonicalJson(intent) })
      await this.completeWorkspaceRelocation(job.proof, bearer)
      if (this.workspaceInitialJob !== job || job.phase !== 'accepted') throw unavailable()
      job.phase = 'completed'; job.stage = 'finished'
    } catch (cause) {
      job.phase = 'needs_attention'
      const code = (cause as { code?: string })?.code
      const allowed = ['UNAUTHORIZED', 'FORBIDDEN', 'INVALID_PARAMS', 'WORKSPACE_INVALID_REQUEST', 'WORKSPACE_DIRECTORY_CONFLICT', 'WORKSPACE_REVISION_CONFLICT', 'WORKSPACE_RELOCATION_BLOCKED', 'WORKSPACE_MAINTENANCE']
      job.reject(cause instanceof Error && code && allowed.includes(code) ? cause : unavailable())
      if (!job.proof && this.workspaceInitialJob === job) this.workspaceInitialJob = undefined
    } finally {
      try { if (lock && token && locks.cliLockToken(lock) === token) locks.releaseCliLock(lock) }
      catch { job.phase = 'needs_attention'; job.reject(unavailable()) }
    }
  }

  /** Observation of this original fixed scope only; it does not grant any stop/file authority. */
  private markWorkspaceRelocationAccepted(request: VerifyWorkspaceRelocationRequestParams): void {
    const job = this.workspaceInitialJob
    if (!job || job.phase === 'completed') return
    if (!job.proof || sha256CanonicalJson(job.proof) !== sha256CanonicalJson(request) || job.phase !== 'preparing') {
      throw Object.assign(new Error('Initial workspace job is not current'), { code: 'FORBIDDEN' })
    }
    const grant = this.workspaceCoordinatorGrant
    if (!grant || grant.proof.intent_id !== request.intent_id) throw Object.assign(new Error('Current coordinator is unavailable'), { code: 'FORBIDDEN' })
    job.coordinator = { child: grant.child, identity: grant.identity }
    job.phase = 'accepted'; job.stage = 'stopping'; job.resolve({ intent_id: request.intent_id, accepted: true })
  }

  /** Initial human confirmation only; no intent, lock or coordinator is created here. */
  private async verifyWorkspaceRelocationStartRequest(
    params: VerifyWorkspaceRelocationStartParams, bearer?: string,
  ): Promise<VerifyWorkspaceRelocationStartResult> {
    const snapshot = params && typeof params === 'object' && !Array.isArray(params) ? Object.freeze({ ...params }) : params
    if (typeof bearer !== 'string' || !bearer) throw Object.assign(new Error('Human Admin credential required'), { code: 'UNAUTHORIZED' })
    const unavailable = () => Object.assign(new Error('当前人类迁移确认无法核实，未创建迁移作业。'), { code: 'SERVICE_UNAVAILABLE' })
    try {
      return await this.withCurrentAdminRpc(5000, async (rpc, verify) => {
        let response: unknown
        try { response = await rpc.call('verify_workspace_relocation_start', snapshot, { authorizationBearer: bearer }) }
        catch (error) { await verify(); throw error }
        await verify()
        const expected = { verified: true as const, ...parseWorkspaceRelocationStartRequest(snapshot) }
        if (sha256CanonicalJson(response) !== sha256CanonicalJson(expected)) throw unavailable()
        return Object.freeze(expected)
      })
    } catch (error) {
      const code = (error as { remote_code?: string; code?: string }).remote_code ?? (error as { code?: string }).code
      if (code && ['UNAUTHORIZED', 'FORBIDDEN', 'INVALID_PARAMS'].includes(code)) {
        throw Object.assign(new Error('Human workspace confirmation rejected'), { code })
      }
      throw unavailable()
    }
  }

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

  /** One current Admin carrier/runtime connection only; callers retain authorization and job semantics. */
  private async withCurrentAdminRpc<T>(timeoutMs: number, action: (rpc: CurrentAdminRpc, verify: () => Promise<void>) => Promise<T>): Promise<T> {
    const unavailable = () => Object.assign(new Error('当前Admin固定连接无法确认。'), { code: 'SERVICE_UNAVAILABLE' })
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
    let rpc: CurrentAdminRpc | undefined
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
      const verify = async (): Promise<void> => {
        verifyCurrent()
        if (sha256CanonicalJson((await this.runtimeRegistry.listRecords()).filter(record => record.module_id === 'admin-web')) !== fingerprint) throw unavailable()
        verifyCurrent()
        if (!native.sameProcess(root, native.inspectProcess(rootPid))) throw unavailable()
      }
      const result = await action(rpc!, verify)
      await verify()
      return result
    } finally { rpc?.close() }
  }

  private async callWorkspaceRelocationAdmin(
    method: 'verify_workspace_relocation_request' | 'quiesce_workspace_relocation_web',
    params: VerifyWorkspaceRelocationRequestParams, bearer?: string,
  ): Promise<VerifyWorkspaceRelocationRequestParams> {
    params = Object.freeze({ ...params })
    const field = method === 'verify_workspace_relocation_request' ? 'verified' : 'quiesced'
    const timeoutMs = method === 'verify_workspace_relocation_request' ? 1500 : 30000
    const unavailable = () => Object.assign(new Error('当前Admin固定请求无法确认，已保留维护保护。'), { code: 'SERVICE_UNAVAILABLE' })
    if (typeof bearer !== 'string' || !bearer) throw Object.assign(new Error('Human Admin credential required'), { code: 'UNAUTHORIZED' })
    try {
      return await this.withCurrentAdminRpc(timeoutMs, async (rpc, verify) => {
        const response = await rpc.call(method, params, { authorizationBearer: bearer })
        await verify()
        if (!response || typeof response !== 'object' || Array.isArray(response) || Object.keys(response).length !== 3
          || !Object.keys(response).every(key => key === field || key === 'intent_id' || key === 'intent_sha256')) throw unavailable()
        const result = response as Record<string, unknown>
        if (result[field] !== true || result.intent_id !== params.intent_id || result.intent_sha256 !== params.intent_sha256) throw unavailable()
        const { readWorkspaceRelocationIntent } = require('../../scripts/lib/workspace-relocation-intent.mjs')
        const intent = readWorkspaceRelocationIntent(this.dataDir)
        if (!intent) throw unavailable()
        const intentHash = sha256CanonicalJson(intent)
        if (intent.id !== params.intent_id || intentHash !== params.intent_sha256) throw Object.assign(new Error('Workspace request does not match this instance'), { code: 'FORBIDDEN' })
        return { intent_id: intent.id, intent_sha256: intentHash }
      })
    } catch (error) {
      if ((error as { code?: string }).code === 'FORBIDDEN') throw error
      throw unavailable()
    }
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
      let processJournal: { prepare(): Promise<'dispatch' | 'observe'>; observe(processes: ReadonlyArray<WorkerProcessIdentity>): Promise<void>; complete(): Promise<void>; confirmExecutionExit(): Promise<void>; close(): void } | undefined
      let active = true, stage = 'launch'
      try {
        child = await this.launchWorkspaceRelocationCoordinator(request, bearer)
        stage = 'quiesce-web'
        await this.quiesceWorkspaceRelocationWeb(request, bearer)
        stage = 'capture-workers'
        await this.captureWorkspaceRelocationWorkersForCoordinator(child, request, bearer)
        stage = 'capture-processes'
        const processes = await this.captureWorkspaceRelocationProcessesForCoordinator(child)
        stage = 'capture-modules'
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
        this.markWorkspaceRelocationAccepted(request)
        stage = 'process-attempt'
        if (await processJournal!.prepare() !== 'dispatch') throw failure()
        let submissions: Pick<WorkspaceStopSequenceResult, 'workerSubmission' | 'moduleSubmission'> | undefined
        const { stopKnownProcessScope } = require('../../scripts/lib/known-process-stop.cjs')
        stage = 'stop-known-scope'
        await stopKnownProcessScope(processes, { timeoutMs: Math.max(1, Math.round(this.config.shutdown_timeout * 1000)),
          onObserved: async (observed: ReadonlyArray<WorkerProcessIdentity>) => { verify(); await processJournal!.observe(observed); verify() },
          submit: async () => {
            verify()
            stage = 'stop-workers'
            const workerSubmission = await this.stopWorkspaceRelocationWorkersForCoordinator(child!)
            verify(); this.assertWorkspaceCoordinatorGrantCurrent(grant)
            stage = 'stop-modules'
            const moduleSubmission = await this.requestWorkspaceRelocationModuleStops(modules, journal!)
            verify(); submissions = { workerSubmission, moduleSubmission }
            stage = 'stop-known-scope'
          },
        }, { ...native, terminateKnownProcess: (target: WorkerProcessIdentity) => { verify(); return native.terminateKnownProcess(target) } })
        if (!submissions) throw failure()
        stage = 'complete-processes'
        await processJournal!.complete(); verify()
        const assertModulesStopped = (): void => {
          verify()
          if (JSON.stringify([...this.modules.keys()].filter(id => id !== 'admin-web').sort()) !== JSON.stringify(modules.map(item => item.module_id))
            || [...this.processes.keys()].some(id => id !== 'admin-web') || [...this.lifecycleQueues.keys()].some(id => id !== 'admin-web')) throw failure()
          for (const item of modules) {
            const runtime = this.modules.get(item.module_id)
            if (!runtime || runtime.port !== item.module_port || runtime.pid !== undefined || runtime.status === 'running' || runtime.status === 'starting') throw failure()
          }
        }
        const verifyStoppedModules = async (): Promise<void> => {
          assertModulesStopped()
          if ((await this.runtimeRegistry.listRecords()).some(record => record.module_id !== 'admin-web')) throw failure()
          assertModulesStopped()
        }
        stage = 'verify-stopped-modules'
        await verifyStoppedModules()
        stage = 'execution-exit'
        await processJournal!.confirmExecutionExit()
        await verifyStoppedModules()
        if (sha256CanonicalJson(records.readWorkspaceRelocationModuleStops(this.dataDir, request.intent_id).submission?.results) !== sha256CanonicalJson(submissions.moduleSubmission.results)
          || !records.readWorkspaceRelocationProcessStops(this.dataDir, request.intent_id).completion) throw failure()
        return Object.freeze({ coordinator: child, ...submissions })
      } catch (cause) {
        active = false
        await this.closeWorkspaceCoordinatorChannel(child)
        const diagnostic = cause as { code?: unknown; stage?: unknown } | null
        const safe = (value: unknown, pattern: RegExp) => typeof value === 'string' && value.length <= 128 && pattern.test(value) ? value : null
        throw Object.assign(failure(), { stage, cause_code: safe(diagnostic?.code, /^(?:CRABOT_|WORKSPACE_)[A-Z_]+$|^E[A-Z]+$/),
          cause_stage: safe(diagnostic?.stage, /^[a-z][a-z0-9-]*$/) })
      } finally { active = false; journal?.close(); processJournal?.close() }
    })
    this.workspaceStopSequence = { fingerprint, pending }
    return pending
  }

  private workspaceRelocationStoppedVerifier(request: VerifyWorkspaceRelocationRequestParams, child: ChildProcess): () => Promise<void> {
    const failure = () => Object.assign(new Error('迁移的原协调器或已停止模块范围无法核实，维护保护保留。'), { code: 'SERVICE_UNAVAILABLE' })
    const records = require('../../scripts/lib/workspace-relocation-intent.mjs'), native = require('../../scripts/lib/process-identity.cjs')
    const coordinator = records.readWorkspaceRelocationCoordinator(this.dataDir, request.intent_id)
    const modules: ReadonlyArray<WorkspaceModuleScope> = records.readWorkspaceRelocationModules(this.dataDir, request.intent_id).modules
    const verify = (): void => {
      if (this.isShuttingDown || !child.connected || child.exitCode !== null || child.signalCode !== null
        || sha256CanonicalJson(records.readWorkspaceRelocationIntent(this.dataDir)) !== request.intent_sha256
        || sha256CanonicalJson(records.readWorkspaceRelocationCoordinator(this.dataDir, request.intent_id)) !== sha256CanonicalJson(coordinator)
        || !records.readWorkspaceRelocationExecutionExit(this.dataDir, request.intent_id)
        || !native.sameProcess(coordinator.launch.parent, native.inspectProcess(process.pid))
        || !native.sameProcess(coordinator.launch.process, native.inspectProcess(child.pid))
        || JSON.stringify([...this.modules.keys()].filter(id => id !== 'admin-web').sort()) !== JSON.stringify(modules.map(item => item.module_id))
        || [...this.processes.keys()].some(id => id !== 'admin-web') || [...this.lifecycleQueues.keys()].some(id => id !== 'admin-web')) throw failure()
      for (const item of modules) {
        const runtime = this.modules.get(item.module_id)
        if (!runtime || runtime.port !== item.module_port || runtime.pid !== undefined || runtime.status === 'running' || runtime.status === 'starting') throw failure()
      }
    }
    const verifyStopped = async (): Promise<void> => {
      verify()
      if ((await this.runtimeRegistry.listRecords()).some(record => record.module_id !== 'admin-web')) throw failure()
      verify()
    }
    return verifyStopped
  }

  /** Bind the fixed file plan and idle host after the complete stop sequence; no file effects or root selection. */
  private prepareWorkspaceRelocationFiles(request: VerifyWorkspaceRelocationRequestParams, bearer?: string): Promise<WorkspaceFilePreparationResult> {
    request = Object.freeze({ ...request })
    const fingerprint = sha256CanonicalJson(request)
    const failure = () => Object.assign(new Error('迁移文件准备未能确认，已保留原目录、计划与维护保护；未重放。'), { code: 'SERVICE_UNAVAILABLE' })
    if (this.workspaceFilePreparation) {
      if (this.workspaceFilePreparation.fingerprint !== fingerprint) return Promise.reject(Object.assign(new Error('Workspace file intent cannot change'), { code: 'FORBIDDEN' }))
      return this.workspaceFilePreparation.pending
    }
    const pending = Promise.resolve().then(async (): Promise<WorkspaceFilePreparationResult> => {
      let child: ChildProcess | undefined
      let journal: { prepare(): Promise<{ plan: unknown }>; prepareHost(): Promise<{ actors: unknown }>; close(): void } | undefined
      try {
        child = (await this.submitWorkspaceRelocationStops(request, bearer)).coordinator
        const records = require('../../scripts/lib/workspace-relocation-intent.mjs')
        const coordinator = records.readWorkspaceRelocationCoordinator(this.dataDir, request.intent_id)
        const verifyStopped = this.workspaceRelocationStoppedVerifier(request, child)
        await verifyStopped()
        this.noteWorkspaceRelocationJobStage(request, 'moving')
        const { createWorkspaceFileJournal } = require('../../scripts/lib/workspace-file-journal.mjs')
        journal = createWorkspaceFileJournal(child, { dataDir: this.dataDir, id: request.intent_id, launch: coordinator.launch })
        const result = await journal!.prepare()
        await verifyStopped()
        const preparedHost = await journal!.prepareHost()
        await verifyStopped()
        return Object.freeze({ coordinator: child, plan_sha256: sha256CanonicalJson(result.plan), file_actors_sha256: sha256CanonicalJson(preparedHost.actors) })
      } catch {
        await this.closeWorkspaceCoordinatorChannel(child)
        throw failure()
      } finally { journal?.close() }
    })
    this.workspaceFilePreparation = { fingerprint, pending }
    return pending
  }

  /** Finish fixed files and Agent-owned closures/recovery retirement; keep maintenance and the original catalog. */
  private commitWorkspaceRelocationWorkers(request: VerifyWorkspaceRelocationRequestParams, bearer?: string): Promise<WorkspaceWorkerClosureResult> {
    request = Object.freeze({ ...request })
    const fingerprint = sha256CanonicalJson(request)
    const failure = () => Object.assign(new Error('执行器关闭结果尚未全部确认，已保留文件、提交事实和维护保护；未重放。'), { code: 'SERVICE_UNAVAILABLE' })
    if (this.workspaceWorkerClosure) {
      if (this.workspaceWorkerClosure.fingerprint !== fingerprint) return Promise.reject(Object.assign(new Error('Workspace closure intent cannot change'), { code: 'FORBIDDEN' }))
      return this.workspaceWorkerClosure.pending
    }
    const pending = Promise.resolve().then(async (): Promise<WorkspaceWorkerClosureResult> => {
      let child: ChildProcess | undefined
      let files: { prepareStage(): Promise<unknown>; prepareFiles(): Promise<{ ready: unknown }>; close(): void } | undefined
      let workers: { prepareClosure(): Promise<{ plan: unknown }>; commitClosure(): Promise<{ complete: unknown }>;
        prepareRecovery(): Promise<{ plan_sha256: string }>; commitRecovery(): Promise<{ commit_sha256: string }>; close(): void } | undefined
      try {
        child = (await this.prepareWorkspaceRelocationFiles(request, bearer)).coordinator
        this.noteWorkspaceRelocationJobStage(request, 'closing_executors')
        const records = require('../../scripts/lib/workspace-relocation-intent.mjs')
        const verifyStopped = this.workspaceRelocationStoppedVerifier(request, child)
        await verifyStopped()
        const context = { dataDir: this.dataDir, id: request.intent_id, launch: records.readWorkspaceRelocationCoordinator(this.dataDir, request.intent_id).launch }
        files = require('../../scripts/lib/workspace-file-journal.mjs').createWorkspaceFileJournal(child, context)
        workers = require('../../scripts/lib/workspace-worker-journal.mjs').createWorkspaceWorkerJournal(child, context)
        await files!.prepareStage()
        await verifyStopped()
        const fileResult = await files!.prepareFiles()
        await verifyStopped()
        const prepared = await workers!.prepareClosure()
        await verifyStopped()
        const committed = await workers!.commitClosure()
        await verifyStopped()
        const recoveryPlan = await workers!.prepareRecovery()
        await verifyStopped()
        const recoveryCommit = await workers!.commitRecovery()
        await verifyStopped()
        if (sha256CanonicalJson(records.readWorkspaceRelocationFileActors(this.dataDir, request.intent_id).file_ready) !== sha256CanonicalJson(fileResult.ready)
          || sha256CanonicalJson(records.readWorkspaceRelocationClosurePlan(this.dataDir, request.intent_id)) !== sha256CanonicalJson(prepared.plan)
          || sha256CanonicalJson(records.readWorkspaceRelocationClosureCommit(this.dataDir, request.intent_id)) !== sha256CanonicalJson(committed.complete)
          || sha256CanonicalJson(records.readWorkspaceRelocationRecoveryPlan(this.dataDir, request.intent_id)) !== recoveryPlan.plan_sha256
          || sha256CanonicalJson(records.readWorkspaceRelocationRecoveryCommit(this.dataDir, request.intent_id)) !== recoveryCommit.commit_sha256) throw failure()
        return Object.freeze({ coordinator: child, file_ready_sha256: sha256CanonicalJson(fileResult.ready),
          closure_plan_sha256: sha256CanonicalJson(prepared.plan), closure_commit_sha256: sha256CanonicalJson(committed.complete),
          recovery_plan_sha256: recoveryPlan.plan_sha256, recovery_commit_sha256: recoveryCommit.commit_sha256 })
      } catch {
        await this.closeWorkspaceCoordinatorChannel(child)
        throw failure()
      } finally { files?.close(); workers?.close() }
    })
    this.workspaceWorkerClosure = { fingerprint, pending }
    return pending
  }

  /** Select only the original published Root after closures; ordinary startup remains fenced. */
  private commitWorkspaceRelocationRoot(request: VerifyWorkspaceRelocationRequestParams, bearer?: string): Promise<WorkspaceRootSelectionResult> {
    request = Object.freeze({ ...request })
    const fingerprint = sha256CanonicalJson(request)
    const failure = () => Object.assign(new Error('新工作区位置尚未全部确认，已保留文件、终态与维护保护；未重放。'), { code: 'SERVICE_UNAVAILABLE' })
    if (this.workspaceRootSelection) {
      if (this.workspaceRootSelection.fingerprint !== fingerprint) return Promise.reject(Object.assign(new Error('Workspace Root intent cannot change'), { code: 'FORBIDDEN' }))
      return this.workspaceRootSelection.pending
    }
    const pending = Promise.resolve().then(async (): Promise<WorkspaceRootSelectionResult> => {
      let child: ChildProcess | undefined
      let files: { prepareRoot(): Promise<{ plan_sha256: string }>; publishRoot(): Promise<{ published_sha256: string }>;
        selectRoot(): Promise<{ selected_sha256: string }>;
        verifySelectedRoot(): Promise<{ selected_sha256: string; worker_commit_sha256: string; recovery_commit_sha256: string }>; close(): void } | undefined
      try {
        const closed = await this.commitWorkspaceRelocationWorkers(request, bearer)
        this.noteWorkspaceRelocationJobStage(request, 'switching')
        child = closed.coordinator
        const records = require('../../scripts/lib/workspace-relocation-intent.mjs')
        const verifyStopped = this.workspaceRelocationStoppedVerifier(request, child)
        await verifyStopped()
        const context = { dataDir: this.dataDir, id: request.intent_id, launch: records.readWorkspaceRelocationCoordinator(this.dataDir, request.intent_id).launch }
        files = require('../../scripts/lib/workspace-file-journal.mjs').createWorkspaceFileJournal(child, context)
        const plan = await files!.prepareRoot()
        await verifyStopped()
        const published = await files!.publishRoot()
        await verifyStopped()
        const selected = await files!.selectRoot()
        await verifyStopped()
        if (sha256CanonicalJson(records.readWorkspaceRelocationRootPlan(this.dataDir, request.intent_id)) !== plan.plan_sha256
          || sha256CanonicalJson(records.readWorkspaceRelocationRootPublished(this.dataDir, request.intent_id)) !== published.published_sha256
          || sha256CanonicalJson(records.readWorkspaceRelocationRootSelected(this.dataDir, request.intent_id)) !== selected.selected_sha256) throw failure()
        const { WorkspaceCatalog } = require('crabot-shared/dist/workspace-catalog.js')
        const snapshot = await new WorkspaceCatalog({ dataRoot: this.dataDir, files: require('../../scripts/lib/process-identity.cjs') }).snapshot()
        await verifyStopped()
        if (sha256CanonicalJson(snapshot) !== records.readWorkspaceRelocationRootSelected(this.dataDir, request.intent_id).catalog_sha256) throw failure()
        const current = await files!.verifySelectedRoot()
        await verifyStopped()
        if (current.selected_sha256 !== selected.selected_sha256 || current.worker_commit_sha256 !== closed.closure_commit_sha256
          || current.recovery_commit_sha256 !== closed.recovery_commit_sha256) throw failure()
        return Object.freeze({ ...closed, root_plan_sha256: plan.plan_sha256, root_published_sha256: published.published_sha256, root_selected_sha256: selected.selected_sha256 })
      } catch {
        await this.closeWorkspaceCoordinatorChannel(child)
        throw failure()
      } finally { files?.close() }
    })
    this.workspaceRootSelection = { fingerprint, pending }
    return pending
  }

  /** Start only original active Core modules for later health checks; maintenance stays closed. */
  private startWorkspaceRelocationValidationModules(request: VerifyWorkspaceRelocationRequestParams, bearer?: string): Promise<WorkspaceValidationLaunchResult> {
    request = Object.freeze({ ...request })
    const fingerprint = sha256CanonicalJson(request)
    const failure = () => Object.assign(new Error('迁移后的验证模块尚未全部确认，已保留维护保护和原记录；未重试启动。'), { code: 'SERVICE_UNAVAILABLE' })
    if (this.workspaceValidationLaunch) {
      if (this.workspaceValidationLaunch.fingerprint !== fingerprint) return Promise.reject(Object.assign(new Error('Workspace validation intent cannot change'), { code: 'FORBIDDEN' }))
      return this.workspaceValidationLaunch.pending
    }
    const pending = Promise.resolve().then(async (): Promise<WorkspaceValidationLaunchResult> => {
      let child: ChildProcess | undefined
      let stage = 'root'
      try {
        const selected = await this.commitWorkspaceRelocationRoot(request, bearer)
        this.noteWorkspaceRelocationJobStage(request, 'validating')
        child = selected.coordinator
        await this.workspaceRelocationStoppedVerifier(request, child)()
        const records = require('../../scripts/lib/workspace-relocation-intent.mjs'), native = require('../../scripts/lib/process-identity.cjs')
        const coordinator = records.readWorkspaceRelocationCoordinator(this.dataDir, request.intent_id)
        const scopes: ReadonlyArray<WorkspaceModuleScope> = records.readWorkspaceRelocationModules(this.dataDir, request.intent_id).modules
        const scopeHash = sha256CanonicalJson(scopes), admin = this.processes.get('admin-web')
        const definition = workspaceModuleDefinition
        const definitions = new Map([...this.modules].map(([id, runtime]) => [id, { runtime, hash: sha256CanonicalJson(definition(runtime)), overrides: sha256CanonicalJson(this.envOverrides.get(id) ?? {}) }]))
        const launched = new Map<ModuleId, { child: ChildProcess; state: ManagedChildState; process: WorkerProcessIdentity }>()
        let pendingModule: ModuleId | undefined
        const journalContext = { dataDir: this.dataDir, id: request.intent_id, launch: coordinator.launch }
        const assertCurrent = (): void => {
          const target = records.readWorkspaceRelocationRootPublished(this.dataDir, request.intent_id)?.target
          if (!target) throw failure()
          const stat = fs.lstatSync(target.path, { bigint: true })
          const frame = { path: target.path, dev: String(stat.dev), ino: String(stat.ino), native_id: process.platform === 'win32' ? native.inspectDirectoryFileId(target.path) : null }
          if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(target.path) !== target.path
            || sha256CanonicalJson(frame) !== sha256CanonicalJson(target)
            || sha256CanonicalJson(records.readWorkspaceRelocationRootSelected(this.dataDir, request.intent_id)) !== selected.root_selected_sha256) throw failure()
          if (this.isShuttingDown || !child!.connected || child!.exitCode !== null || child!.signalCode !== null
            || !admin || this.processes.get('admin-web') !== admin || admin.exitCode !== null || admin.signalCode !== null
            || sha256CanonicalJson(records.readWorkspaceRelocationIntent(this.dataDir)) !== request.intent_sha256
            || sha256CanonicalJson(records.readWorkspaceRelocationCoordinator(this.dataDir, request.intent_id)) !== sha256CanonicalJson(coordinator)
            || sha256CanonicalJson(records.readWorkspaceRelocationModules(this.dataDir, request.intent_id).modules) !== scopeHash
            || !native.sameProcess(coordinator.launch.parent, native.inspectProcess(process.pid))
            || !native.sameProcess(coordinator.launch.process, native.inspectProcess(child!.pid))
            || this.modules.size !== definitions.size || [...this.lifecycleQueues.keys()].some(id => id !== pendingModule)
            || [...this.processes.keys()].some(id => id !== 'admin-web' && !launched.has(id))) throw failure()
          for (const [id, expected] of definitions) {
            const runtime = this.modules.get(id)
            if (runtime !== expected.runtime || sha256CanonicalJson(definition(runtime!)) !== expected.hash
              || sha256CanonicalJson(this.envOverrides.get(id) ?? {}) !== expected.overrides) throw failure()
          }
          for (const scope of scopes) {
            const runtime = this.modules.get(scope.module_id)!, current = launched.get(scope.module_id)
            if (!current) {
              if (runtime.pid !== undefined || runtime.status === 'running' || runtime.status === 'starting' && scope.module_id !== pendingModule) throw failure()
              continue
            }
            if (this.processes.get(scope.module_id) !== current.child) throw Object.assign(failure(), { stage: 'new-module-child' })
            if (this.childStates.get(current.child) !== current.state) throw Object.assign(failure(), { stage: 'new-module-state' })
            if (current.state.finalizeStarted) throw Object.assign(failure(), { stage: 'new-module-finalizing' })
            if (runtime.pid !== current.child.pid) throw Object.assign(failure(), { stage: 'new-module-runtime-pid' })
            const actual = native.inspectProcess(current.child.pid)
            if (!native.sameProcess(current.process, actual)) {
              const sameGeneration = actual && actual.pid === current.process.pid && actual.owner === current.process.owner && actual.started === current.process.started
              throw Object.assign(failure(), { stage: sameGeneration ? 'new-module-executable' : 'new-module-generation' })
            }
          }
        }
        const verifyRegistrations = async (): Promise<void> => {
          assertCurrent()
          const rows = (await this.runtimeRegistry.listRecords()).filter(row => row.module_id !== 'admin-web')
          assertCurrent()
          if (rows.length !== launched.size || rows.some(row => {
            const current = launched.get(row.module_id)
            return !current || row.runtime_id !== current.state.runtimeId || row.root_pid !== current.child.pid
              || row.module_port !== this.modules.get(row.module_id)?.port || row.instance_id !== this.runtimeRegistry.getInstanceId()
          })) throw failure()
        }
        const verify = async (): Promise<void> => {
          await verifyRegistrations()
          const files = require('../../scripts/lib/workspace-file-journal.mjs').createWorkspaceFileJournal(child, journalContext)
          let proof
          try { proof = await files.verifySelectedRoot() } finally { files.close() }
          assertCurrent()
          if (proof.selected_sha256 !== selected.root_selected_sha256 || proof.worker_commit_sha256 !== selected.closure_commit_sha256
            || proof.recovery_commit_sha256 !== selected.recovery_commit_sha256) throw failure()
          await verifyRegistrations()
        }
        stage = 'verify-before-launch'
        await verify()
        const targets = scopes.filter(item => item.runtime_id !== undefined && item.processes.length > 0 && ['crabot-agent', 'memory-default'].includes(item.module_id))
          .sort((a, b) => (this.modules.get(a.module_id)!.start_priority ?? 100) - (this.modules.get(b.module_id)!.start_priority ?? 100))
        for (const scope of targets) {
          const permit = Object.freeze({}), runtime = this.modules.get(scope.module_id)!
          pendingModule = scope.module_id
          this.workspaceValidationPermits.set(permit, { moduleId: scope.module_id, runtime, verify, assertCurrent })
          stage = 'start-core-module'
          try {
            await this.enqueueLifecycle(scope.module_id, () => this.startModuleProcess(scope.module_id, undefined, this.envOverrides.get(scope.module_id), permit))
          } finally { this.workspaceValidationPermits.delete(permit) }
          stage = 'observe-new-module'
          const newChild = this.processes.get(scope.module_id), state = newChild && this.childStates.get(newChild)
          let identity = newChild?.pid && native.inspectProcess(newChild.pid)
          if (!newChild || !state || state.finalizeStarted || !identity || identity.parent !== coordinator.launch.parent.pid
            || identity.owner !== coordinator.launch.parent.owner) throw failure()
          if (scope.module_id === 'memory-default' && runtime.skip_health_check !== true
            && !(state.reachedRunning && runtime.status === 'running')) {
            stage = 'await-memory-bootstrap'
            const original = identity, deadline = Date.now() + 120000
            while (!(state.reachedRunning && (runtime as ModuleRuntime).status === 'running')) {
              if (Date.now() > deadline || this.isShuttingDown || this.processes.get(scope.module_id) !== newChild
                || this.childStates.get(newChild) !== state || state.finalizeStarted || state.rootExited
                || newChild.exitCode !== null || newChild.signalCode !== null
                || runtime.status === 'error' || runtime.status === 'stopped') throw failure()
              await new Promise(resolve => setTimeout(resolve, 100))
            }
            const registered = native.inspectProcess(newChild.pid)
            if (!registered || registered.pid !== original.pid || registered.started !== original.started
              || registered.owner !== original.owner || registered.parent !== original.parent) throw failure()
            identity = registered
          }
          launched.set(scope.module_id, { child: newChild, state, process: identity })
          stage = 'verify-new-module'
          await verify(); pendingModule = undefined
        }
        stage = 'final-verify'
        await verify()
        const result = Object.freeze({ ...selected, validation_modules: Object.freeze([...launched].map(([module_id, item]) =>
          Object.freeze({ module_id, runtime_id: item.state.runtimeId, process: Object.freeze({ ...item.process }) }))) })
        this.workspaceValidationProof = { request, result, launchId: coordinator.launch.launch_id, launchHash: sha256CanonicalJson(coordinator.launch), verify, assertCurrent }
        return result
      } catch (cause) { await this.closeWorkspaceCoordinatorChannel(child); throw Object.assign(failure(), { stage, cause }) }
    })
    this.workspaceValidationLaunch = { fingerprint, pending }
    return pending
  }

  private verifyWorkspaceRelocationValidationHealth(request: VerifyWorkspaceRelocationRequestParams, bearer?: string): Promise<WorkspaceValidationHealthResult> {
    request = Object.freeze({ ...request })
    const fingerprint = sha256CanonicalJson(request)
    const failure = () => Object.assign(new Error('迁移后的模块与目录尚未全部通过健康核验，已保留维护保护；未重试启动或探测。'), { code: 'SERVICE_UNAVAILABLE' })
    if (this.workspaceValidationHealth) {
      if (this.workspaceValidationHealth.fingerprint !== fingerprint) return Promise.reject(Object.assign(new Error('Workspace health intent cannot change'), { code: 'FORBIDDEN' }))
      return this.workspaceValidationHealth.pending
    }
    const pending = Promise.resolve().then(async (): Promise<WorkspaceValidationHealthResult> => {
      let child: ChildProcess | undefined, stage = 'launch'
      try {
        const launched = await this.startWorkspaceRelocationValidationModules(request, bearer), proof = this.workspaceValidationProof
        child = launched.coordinator
        if (!proof || proof.result !== launched) throw failure()
        const assertCurrent = () => {
          if (this.workspaceValidationProof !== proof) throw failure()
          proof.assertCurrent()
        }
        const { openSpawnedModuleRuntimeRpc } = require('../../scripts/lib/module-carrier-rpc.cjs')
        const instanceId = this.runtimeRegistry.getInstanceId(), healthy: Array<{ module_id: ModuleId; runtime_id: string }> = []
        stage = 'module-health'
        for (const module of launched.validation_modules) {
          const runtime = this.modules.get(module.module_id)!, deadline = Date.now() + 120000
          stage = 'await-runtime-registration'
          for (;;) {
            await proof.verify(); assertCurrent()
            const currentChild = this.processes.get(module.module_id), state = currentChild && this.childStates.get(currentChild)
            if (!state || Date.now() > deadline || runtime.status === 'error' || runtime.status === 'stopped') throw failure()
            if (state.reachedRunning && runtime.status === 'running') break
            await new Promise(resolve => setTimeout(resolve, 100))
          }
          stage = 'module-health'
          const rpc = await openSpawnedModuleRuntimeRpc(this.processes.get(module.module_id), module.process, runtime.port, { instance_id: instanceId, module_id: module.module_id, runtime_id: module.runtime_id },
            { timeoutMs: this.config.health_check_timeout * 1000 })
          try {
            assertCurrent()
            const result: HealthResult = await rpc.call('health', {})
            assertCurrent()
            if (result.status !== 'healthy') throw failure()
            await proof.verify(); assertCurrent()
            healthy.push({ module_id: module.module_id, runtime_id: module.runtime_id })
          } finally { rpc.close() }
        }
        stage = 'root-probe'
        const agent = launched.validation_modules.find(module => module.module_id === 'crabot-agent')
        const credential = this.runtimeBearers.get('crabot-agent')
        if (!agent || !credential) throw failure()
        const assertBearer = () => {
          assertCurrent()
          if (this.runtimeBearers.get('crabot-agent') !== credential || credential.revoked
            || this.processes.get('crabot-agent') !== credential.child) throw failure()
        }
        await proof.verify(); assertBearer()
        const expected: VerifyWorkspaceRelocationRuntimeResult = { verified: true, intent_id: request.intent_id, intent_sha256: request.intent_sha256,
          launch_id: proof.launchId, launch_sha256: proof.launchHash, root_selected_sha256: launched.root_selected_sha256,
          instance_id: instanceId, module_id: 'crabot-agent', runtime_id: agent.runtime_id }
        const rpc = await openSpawnedModuleRuntimeRpc(this.processes.get('crabot-agent'), agent.process, this.modules.get('crabot-agent')!.port,
          { instance_id: instanceId, module_id: 'crabot-agent', runtime_id: agent.runtime_id }, { timeoutMs: 30000 })
        try {
          assertBearer()
          const result = await rpc.call('verify_workspace_relocation_root', { intent_id: request.intent_id, launch_id: proof.launchId }, { authorizationBearer: credential.token })
          assertBearer()
          if (sha256CanonicalJson(result) !== sha256CanonicalJson(expected)) throw failure()
        } finally { rpc.close() }
        stage = 'final-verify'
        await proof.verify(); assertBearer()
        stage = 'record-health'
        const records = require('../../scripts/lib/workspace-relocation-intent.mjs')
        const files = require('../../scripts/lib/workspace-file-journal.mjs').createWorkspaceFileJournal(child,
          { dataDir: this.dataDir, id: request.intent_id, launch: records.readWorkspaceRelocationCoordinator(this.dataDir, request.intent_id).launch })
        let health
        try { health = await files.recordHealth({ modules: launched.validation_modules, root_proof: expected }) } finally { files.close() }
        await proof.verify(); assertBearer()
        return Object.freeze({ ...launched, healthy_modules: Object.freeze(healthy.map(module => Object.freeze(module))), root_verified: Object.freeze(expected), health_sha256: health.health_sha256 })
      } catch (cause) {
        await this.closeWorkspaceCoordinatorChannel(child)
        throw Object.assign(failure(), { stage, cause })
      }
    })
    this.workspaceValidationHealth = { fingerprint, pending }
    return pending
  }

  /** New human admission only; neither the old normal role nor this mutex grants recovery effects. */
  private prepareWorkspaceRelocationRecoveryAdmission(request: VerifyWorkspaceRelocationRecoveryRequestParams, bearer?: string): Promise<WorkspaceRecoveryAdmission> {
    if (!bearer) return Promise.reject(Object.assign(new Error('Current human credential required'), { code: 'UNAUTHORIZED' }))
    request = Object.freeze({ ...request })
    const fingerprint = sha256CanonicalJson(request), bearerHash = sha256CanonicalJson(bearer), previous = this.workspaceRecoveryAdmissionPreparation
    const failure = () => Object.assign(new Error('当前人类冷恢复接纳尚未确认，原维护保护已保留。'), { code: 'SERVICE_UNAVAILABLE' })
    if (previous) {
      if (previous.fingerprint !== fingerprint || previous.bearerHash !== bearerHash) return Promise.reject(Object.assign(failure(), { code: 'FORBIDDEN' }))
      return previous.pending.then(async admission => { await admission.verify(); return admission })
    }
    const pending = Promise.resolve().then(async (): Promise<WorkspaceRecoveryAdmission> => {
      let lock: string | undefined, token: string | undefined, admission: WorkspaceRecoveryAdmission | undefined
      const locks = require('../../scripts/lib/cli-lock.mjs'), { readWorkspaceRecoveryAdmissionScope } = require('../../scripts/lib/workspace-recovery-admission.mjs')
      const native = require('../../scripts/lib/process-identity.cjs')
      try {
        const scope = readWorkspaceRecoveryAdmissionScope(this.dataDir, request), self = native.inspectProcess(process.pid)
        if (!self || this.isShuttingDown || this.workspaceRecoveryAdmission || this.workspaceRecoveryInitialization) throw failure()
        lock = await locks.acquireWorkspaceRelocationRecoveryLock(this.dataDir, request.intent_id)
        token = locks.cliLockToken(lock)
        if (!token) throw failure()
        return await this.withCurrentAdminRpc(30000, async (rpc, verifyAdmin) => {
          const child = this.processes.get('admin-web')!, state = this.childStates.get(child)!, runtimeId = state.runtimeId
          const result: VerifyWorkspaceRelocationRecoveryRequestResult = { verified: true, ...request,
            instance_id: this.runtimeRegistry.getInstanceId(), admin_runtime_id: runtimeId, mm_sha256: sha256CanonicalJson(self) }
          const checkFacts = () => {
            const current = this.workspaceRecoveryInitialization
            const currentScope = current?.request === request && current.result === admission?.result ? current.readScope() : readWorkspaceRecoveryAdmissionScope(this.dataDir, request)
            if (this.isShuttingDown || !native.sameProcess(self, native.inspectProcess(process.pid)) || this.processes.get('admin-web') !== child
              || this.childStates.get(child) !== state || state.runtimeId !== runtimeId
              || currentScope.fingerprint !== scope.fingerprint) throw failure()
          }
          const checkAdmission = () => {
            checkFacts()
            if (this.workspaceRecoveryAdmission !== admission || closed || !lock || !token || locks.cliLockToken(lock) !== token) throw failure()
          }
          const verify = async () => {
            try { checkAdmission(); await verifyAdmin(); checkAdmission() }
            catch (cause) { admission?.close(); throw cause }
          }
          let closed = false
          const detach = () => {
            closed = true
            if (admission) admission.accepted = false
            if (this.workspaceRecoveryAdmission === admission) this.workspaceRecoveryAdmission = undefined
            if (this.workspaceRecoveryAdmissionPreparation?.pending === pending) this.workspaceRecoveryAdmissionPreparation = undefined
          }
          admission = { request, result: Object.freeze(result), accepted: false, verify, consume: async () => {
            await verify(); checkAdmission()
            if (!admission?.accepted || this.workspaceRecoveryInitialization) throw failure()
            let ended = false, parentReleased = false
            let completionObservation = false, releasedObserved = false
            const check = () => {
              checkFacts()
              if (ended || this.workspaceRecoveryInitialization !== context || !lock || !token
                || !parentReleased && locks.cliLockToken(lock) !== token) throw failure()
            }
            const context: WorkspaceRecoveryInitialization = { request, result: admission.result,
              readScope: () => {
                if (!completionObservation) return readWorkspaceRecoveryAdmissionScope(this.dataDir, request)
                const observed = require('../../scripts/lib/workspace-recovery-admission.mjs').readWorkspaceRecoveryCompletionScope(this.dataDir, request)
                if (releasedObserved && !observed.released) throw failure()
                releasedObserved ||= observed.released
                return observed
              },
              allowCompletionObservation: () => {
                check()
                if (completionObservation) throw failure()
                completionObservation = true
                check()
              },
              verify: async () => {
                try { check(); await verifyAdmin(); check() }
                catch (cause) { context.close(); throw cause }
              },
              releaseParentLock: () => {
                check()
                if (parentReleased) throw failure()
                locks.releaseCliLock(lock!); parentReleased = true
              },
              close: () => {
                if (ended) return
                ended = true; context.coordinator?.close()
                if (!parentReleased && lock && token && locks.cliLockToken(lock) === token) locks.releaseCliLock(lock)
                if (this.workspaceRecoveryInitialization === context) this.workspaceRecoveryInitialization = undefined
              },
            }
            // No await between consuming the admission and installing its sole successor.
            detach(); this.workspaceRecoveryInitialization = context
            return context
          }, close: () => {
            if (closed) return
            detach()
            if (lock && token && locks.cliLockToken(lock) === token) locks.releaseCliLock(lock)
          } }
          this.workspaceRecoveryAdmission = admission
          await verify()
          const response = await rpc.call('verify_workspace_relocation_recovery_request', request, { authorizationBearer: bearer })
          await verify()
          if (sha256CanonicalJson(response) !== sha256CanonicalJson(result)) throw failure()
          admission.accepted = true
          return admission
        })
      } catch (cause) {
        admission?.close()
        if (lock && token && locks.cliLockToken(lock) === token) locks.releaseCliLock(lock)
        if (this.workspaceRecoveryAdmissionPreparation?.pending === pending) this.workspaceRecoveryAdmissionPreparation = undefined
        const code = (cause as { remote_code?: string; code?: string }).remote_code ?? (cause as { code?: string }).code
        throw Object.assign(failure(), { ...(code && ['UNAUTHORIZED', 'FORBIDDEN', 'INVALID_PARAMS'].includes(code) ? { code } : {}), cause })
      }
    })
    this.workspaceRecoveryAdmissionPreparation = { fingerprint, bearerHash, pending }
    return pending
  }

  /** One fixed idle generation per accepted recovery id; never re-spawn an uncertain handoff. */
  private initializeWorkspaceRelocationRecovery(request: VerifyWorkspaceRelocationRecoveryRequestParams, bearer?: string): Promise<WorkspaceRecoveryCoordinator> {
    if (!bearer) return Promise.reject(Object.assign(new Error('Current human credential required'), { code: 'UNAUTHORIZED' }))
    request = Object.freeze({ ...request })
    const fingerprint = sha256CanonicalJson(request), bearerHash = sha256CanonicalJson(bearer), previous = this.workspaceRecoveryInitializations.get(request.recovery_id)
    if (previous) {
      if (previous.fingerprint !== fingerprint || previous.bearerHash !== bearerHash) return Promise.reject(Object.assign(new Error('Recovery initialization mismatch'), { code: 'FORBIDDEN' }))
      return previous.pending.then(async result => { await result.verify(); return result })
    }
    const pending = Promise.resolve().then(async () => {
      const admission = await this.prepareWorkspaceRelocationRecoveryAdmission(request, bearer), context = await admission.consume()
      try {
        const { launchWorkspaceRecoveryCoordinator } = require('../../scripts/lib/workspace-recovery-launch.mjs')
        const result = await launchWorkspaceRecoveryCoordinator({ dataDir: this.dataDir, request: context.request, admission: context.result,
          verify: context.verify, releaseParentLock: context.releaseParentLock })
        const coordinator = Object.freeze({ ...result, verify: async () => {
          try { await result.verify() } catch (cause) { context.close(); throw cause }
        }, close: () => { result.close(); context.close() } })
        context.coordinator = coordinator
        await coordinator.verify()
        return coordinator
      } catch (cause) { context.close(); throw cause }
    })
    this.workspaceRecoveryInitializations.set(request.recovery_id, { fingerprint, bearerHash, pending })
    return pending
  }

  /** Cold inspection grants no stop/start/release authority and does not adopt the old runtime. */
  private async inspectWorkspaceRelocationRecovery(request: VerifyWorkspaceRelocationRecoveryRequestParams, bearer?: string) {
    request = Object.freeze({ ...request })
    const coordinator = await this.initializeWorkspaceRelocationRecovery(request, bearer)
    try {
      const context = this.workspaceRecoveryInitialization
      if (!context || context.coordinator !== coordinator) throw new Error('No current recovery observation role')
      const readScope = () => {
        if (this.workspaceRecoveryInitialization !== context) throw new Error('Recovery observation role changed')
        return context.readScope()
      }
      const facts = await require('../../scripts/lib/workspace-recovery-admission.mjs').inspectWorkspaceRecoveryFacts({ dataDir: this.dataDir, request, verify: coordinator.verify, readScope })
      return Object.freeze({ ...facts, verify: async () => {
        try { await facts.verify() } catch (cause) { coordinator.close(); throw cause }
      } })
    } catch (cause) { coordinator.close(); throw cause }
  }

  /** Retire only this archive's known validation runs; never replay Worker or file actions. */
  private async cleanupWorkspaceRecoveryRuntimes(request: VerifyWorkspaceRelocationRecoveryRequestParams, bearer?: string): Promise<WorkspaceRecoveryRuntimeCleanup> {
    request = Object.freeze({ ...request })
    const coordinator = await this.initializeWorkspaceRelocationRecovery(request, bearer), previous = this.workspaceRecoveryRuntimeCleanups.get(coordinator)
    if (previous) { const result = await previous; await result.verify(); return result }
    const failure = () => Object.assign(new Error('原验证运行的完整退出尚未确认，维护保护与记录已保留；未重试。'), { code: 'SERVICE_UNAVAILABLE' })
    const pending = Promise.resolve().then(async () => {
      let active = true
      try {
        const records = require('../../scripts/lib/workspace-recovery-records.mjs'), admission = require('../../scripts/lib/workspace-recovery-admission.mjs')
        const native = require('../../scripts/lib/process-identity.cjs'), exits = require('../../scripts/lib/known-process-exit.cjs')
        const control = await admission.inspectWorkspaceRecoveryControlFacts({ dataDir: this.dataDir, request, verify: coordinator.verify })
        const state = admission.readWorkspaceRecoveryAdmissionScope(this.dataDir, request).state
        const history = records.readWorkspaceRecoveryRuntimeHistory(this.dataDir, request), historyHash = sha256CanonicalJson(history)
        if (history.some((item: any) => exits.probeKnownProcessExit([item.coordinator.launch.process]).state !== 'stopped')) throw failure()
        const scopes = new Map<string, WorkspaceModuleScope>(state.modules.modules.map((module: WorkspaceModuleScope) => [module.module_id, module]))
        const known = new Map<string, { moduleId: string; port: number; process?: WorkerProcessIdentity; registration?: ModuleRuntimeRecord }>()
        const add = (moduleId: string, runtimeId: string, process?: WorkerProcessIdentity, registration?: ModuleRuntimeRecord) => {
          const scope = scopes.get(moduleId)
          if (!scope || !['crabot-agent', 'memory-default'].includes(moduleId) || known.has(runtimeId)) throw failure()
          known.set(runtimeId, { moduleId, port: scope.module_port, process, registration })
        }
        for (const module of state.health.modules) add(module.module_id, module.runtime_id, module.process)
        for (const item of history) for (const module of item.plan.modules) {
          const start = item.starts.find((entry: any) => entry.runtime.runtime_id === module.runtime_id)
          add(module.module_id, module.runtime_id, start?.process, start?.runtime)
        }
        const definitions = new Map([...this.modules].map(([id, runtime]) => [id, {
          runtime, definition: sha256CanonicalJson(workspaceModuleDefinition(runtime)), overrides: sha256CanonicalJson(this.envOverrides.get(id) ?? {}),
        }]))
        const currentCoordinator = records.readWorkspaceRecoveryCoordinator(this.dataDir, request.recovery_id)
        const admin = this.processes.get('admin-web'), adminState = admin && this.childStates.get(admin), adminRuntimeId = adminState?.runtimeId
        const adminIdentity = admin?.pid && native.inspectProcess(admin.pid)
        if (!admin || !adminState || !adminIdentity || !currentCoordinator.launch) throw failure()
        const children = new Map([...this.processes].filter(([id]) => id !== 'admin-web').map(([id, child]) => [id, { child, state: this.childStates.get(child) }]))
        const initialRows: ModuleRuntimeRecord[] = (await this.runtimeRegistry.listRecords()).filter(row => row.module_id !== 'admin-web')
        await control.verify()
        const initial = new Map(initialRows.map(row => [row.runtime_id, row])), removals = new Set<string>()
        if (initial.size !== initialRows.length) throw failure()
        for (const row of initialRows) {
          const expected = known.get(row.runtime_id)
          if (!expected || row.instance_id !== this.runtimeRegistry.getInstanceId() || row.module_id !== expected.moduleId || row.module_port !== expected.port
            || expected.process && row.root_pid !== expected.process.pid || expected.registration && sha256CanonicalJson(row) !== sha256CanonicalJson(expected.registration)) throw failure()
        }
        for (const [id, item] of children) {
          const row = item.state && initial.get(item.state.runtimeId), runtime = this.modules.get(id)
          if (!item.state || !row || !runtime || item.state.moduleId !== id || row.root_pid !== item.child.pid || runtime.pid !== item.child.pid || runtime.port !== row.module_port) throw failure()
        }
        const roots = [...known].filter((entry): entry is [string, { moduleId: string; port: number; process: WorkerProcessIdentity; registration?: ModuleRuntimeRecord }] => !!entry[1].process)
        let pendingModule: string | undefined
        const assertCurrent = () => {
          if (!active || this.isShuttingDown || this.modules.size !== definitions.size
            || this.workspaceRecoveryInitialization?.coordinator !== coordinator || this.processes.get('admin-web') !== admin
            || this.childStates.get(admin) !== adminState || adminState.runtimeId !== adminRuntimeId
            || !native.sameProcess(adminIdentity, native.inspectProcess(admin.pid))
            || !native.sameProcess(currentCoordinator.launch.parent, native.inspectProcess(process.pid))
            || !native.sameProcess(currentCoordinator.launch.process, native.inspectProcess(currentCoordinator.launch.process.pid))
            || [...this.lifecycleQueues.keys()].some(id => id !== 'admin-web' && id !== pendingModule)
            || sha256CanonicalJson(records.readWorkspaceRecoveryRuntimeHistory(this.dataDir, request)) !== historyHash) throw failure()
          for (const [id, expected] of definitions) {
            if (this.modules.get(id) !== expected.runtime || sha256CanonicalJson(workspaceModuleDefinition(expected.runtime)) !== expected.definition
              || sha256CanonicalJson(this.envOverrides.get(id) ?? {}) !== expected.overrides) throw failure()
          }
          for (const [id, child] of this.processes) {
            if (id === 'admin-web') continue
            const expected = children.get(id), childState = this.childStates.get(child)
            if (!expected || expected.child !== child || childState !== expected.state || !childState
              || !removals.has(childState.runtimeId) && (childState.finalizeStarted || childState.rootExited)) throw failure()
          }
          for (const [id, item] of children) if (this.processes.get(id) !== item.child && !removals.has(item.state!.runtimeId)) throw failure()
        }
        const verify = async () => {
          try {
            await control.verify(); assertCurrent()
            const rows = (await this.runtimeRegistry.listRecords()).filter(row => row.module_id !== 'admin-web')
            assertCurrent()
            if (rows.some(row => !initial.has(row.runtime_id) || sha256CanonicalJson(row) !== sha256CanonicalJson(initial.get(row.runtime_id)))
              || initialRows.some(row => !removals.has(row.runtime_id) && !rows.some(current => current.runtime_id === row.runtime_id))) throw failure()
            const observed = exits.probeKnownProcessExit(roots.map(([, item]) => item.process))
            if (observed.state === 'unknown') throw failure()
            for (const [id, item] of roots) if (observed.running_pids.includes(item.process.pid)
              && (!rows.some(row => row.runtime_id === id) || !native.sameProcess(item.process, native.inspectProcess(item.process.pid)))) throw failure()
            await control.verify(); assertCurrent()
          } catch (cause) { active = false; coordinator.close(); throw Object.assign(failure(), { cause }) }
        }
        await verify()
        for (const [id, item] of children) {
          await verify(); pendingModule = id; removals.add(item.state!.runtimeId)
          await this.enqueueLifecycle(id, () => this.stopWorkspaceRecoveryChild(id, item.child, item.state!, verify, assertCurrent))
          await verify(); pendingModule = undefined
        }
        for (const row of initialRows) {
          if (children.has(row.module_id)) continue
          await verify()
          if (process.platform === 'win32' && await probeProcessStartIdentity(row.root_pid) !== row.process_start_identity) {
            await verify()
            const owners = await inspectWindowsPortOwners(row.module_port)
            await verify()
            // An empty port cannot establish complete exit of a departed recovery root.
            if (!owners.length) throw failure()
          }
          removals.add(row.runtime_id)
          await this.runtimeRegistry.recoverOrphans({ moduleId: row.module_id, runtimeIds: new Set([row.runtime_id]), currentRuntimeIds: this.currentRuntimeIds(),
            gracefulTimeoutMs: this.config.shutdown_timeout * 1000, verify })
          await verify()
        }
        const verifyStopped = async () => {
          try {
            await verify()
            if ([...this.processes.keys()].some(id => id !== 'admin-web') || (await this.runtimeRegistry.listRecords()).some(row => row.module_id !== 'admin-web')
              || exits.probeKnownProcessExit(roots.map(([, item]) => item.process)).state !== 'stopped') throw failure()
            for (const [, item] of roots) {
              await verify()
              if (process.platform !== 'win32') {
                const actual = native.inspectProcess(item.process.pid)
                if (actual && actual.started !== item.process.started) continue
              }
              if (!await waitForProcessTreeExit(item.process.pid, 0, 25, item.port, () => true)) throw failure()
              await verify()
            }
          } catch (cause) { active = false; coordinator.close(); throw Object.assign(failure(), { cause }) }
        }
        await verifyStopped()
        return Object.freeze({ runtime_ids: Object.freeze([...known.keys()].sort()), verify: verifyStopped })
      } catch (cause) {
        active = false; coordinator.close()
        throw Object.assign(failure(), { cause })
      }
    })
    this.workspaceRecoveryRuntimeCleanups.set(coordinator, pending)
    return pending
  }

  private async stopWorkspaceRecoveryChild(moduleId: string, child: ChildProcess, state: ManagedChildState, verify: () => Promise<void>, assertCurrent: () => void): Promise<void> {
    await verify()
    const runtime = this.modules.get(moduleId)!
    if (state.finalizeStarted || state.termination || state.forceTermination || state.rootExited) throw new Error('Recovery child already has an unconfirmed stop')
    const native = require('../../scripts/lib/process-identity.cjs')
    const scope: ReadonlyArray<WorkerProcessIdentity> = require('../../scripts/lib/spawned-process-tree.cjs').captureSpawnedProcessTree(child)
    await verify()
    this.cancelAutoRestart(moduleId); this.revokeRuntimeBearer(moduleId)
    state.intentionalReason = 'shutdown'
    state.termination = Promise.resolve().then(async () => {
      let rpc: { shutdown(): Promise<void>; close(): void } | undefined
      try {
        await verify()
        const timeoutMs = Math.max(1, Math.round(this.config.shutdown_timeout * 1000))
        const graceful = runtime.skip_health_check ? undefined : async () => {
          let stage = 'current-role'
          try {
            await verify()
            stage = 'owned-listener'
            const listeners = scope.filter(item => native.sameProcess(item, native.inspectProcess(item.pid)) && native.listListeningTcpPorts(item.pid).includes(runtime.port))
            if (listeners.length !== 1) throw new Error('Cannot verify the recovery module listener')
            stage = 'runtime-identity'
            rpc = await require('../../scripts/lib/module-shutdown-rpc.cjs').openModuleShutdownRpc(listeners[0], runtime.port,
              { instance_id: this.runtimeRegistry.getInstanceId(), module_id: moduleId, runtime_id: state.runtimeId }, { timeoutMs })
            stage = 'current-role-after-identity'
            await verify()
            stage = 'shutdown'
            await rpc!.shutdown()
          } catch (cause) {
            const errors = []
            for (let error: any = cause, depth = 0; error && depth < 4; error = error.cause, depth++) {
              const fixed = (value: unknown) => typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,127}$/.test(value) ? value : null
              errors.push({ code: fixed(error.code), stage: fixed(error.stage), transport_code: fixed(error.transport_code) })
            }
            console.error(JSON.stringify({ event: 'workspace_recovery_shutdown_unconfirmed', stage, causes: errors }))
            throw cause
          }
        }
        await require('../../scripts/lib/known-process-stop.cjs').stopKnownProcessScope(scope, { timeoutMs,
          onObserved: verify,
          graceful,
        }, { ...native, terminateKnownProcess: (target: WorkerProcessIdentity) => { assertCurrent(); return native.terminateKnownProcess(target) } })
        assertCurrent()
      } finally { rpc?.close() }
    })
    try {
      await state.termination
      await this.beginChildFinalize(state, null, null)
    } catch (error) {
      runtime.status = 'error'
      throw error
    }
  }

  /** Start only new planned validation generations after this role proves old execution stopped. */
  private async startWorkspaceRecoveryValidationModules(request: VerifyWorkspaceRelocationRecoveryRequestParams, bearer?: string): Promise<WorkspaceRecoveryValidationLaunch> {
    request = Object.freeze({ ...request })
    const coordinator = await this.initializeWorkspaceRelocationRecovery(request, bearer), previous = this.workspaceRecoveryValidationLaunches.get(coordinator)
    if (previous) { const result = await previous; await result.verify(); return result }
    const failure = () => Object.assign(new Error('新恢复验证运行尚未全部确认，维护保护与登记已保留；未重复启动。'), { code: 'SERVICE_UNAVAILABLE' })
    const pending = Promise.resolve().then(async () => {
      let active = true, pendingModule: ModuleId | undefined, completed = false
      try {
        const cleanup = await this.cleanupWorkspaceRecoveryRuntimes(request, bearer)
        await cleanup.verify()
        const preparation = await this.prepareWorkspaceRecoveryRuntimes(request, bearer), plan = preparation.plan
        const planHash = sha256CanonicalJson(plan)
        if (plan.modules.some(module => cleanup.runtime_ids.includes(module.runtime_id))) throw failure()
        const records = require('../../scripts/lib/workspace-recovery-records.mjs'), native = require('../../scripts/lib/process-identity.cjs')
        const launch = records.readWorkspaceRecoveryCoordinator(this.dataDir, request.recovery_id).launch
        const definitions: WorkspaceModuleDefinitions = new Map([...this.modules].map(([id, runtime]) => [id, {
          runtime, hash: sha256CanonicalJson(workspaceModuleDefinition(runtime)), overrides: sha256CanonicalJson(this.envOverrides.get(id) ?? {}),
        }]))
        const admin = this.processes.get('admin-web'), adminState = admin && this.childStates.get(admin), adminRuntimeId = adminState?.runtimeId
        const adminIdentity = admin?.pid && native.inspectProcess(admin.pid)
        if (!admin || !adminState || !adminIdentity || !launch) throw failure()
        const launched = new Map<ModuleId, { child: ChildProcess; state: ManagedChildState; process: WorkerProcessIdentity }>()
        const registrations = new Map<string, string>(), receipts = new Map<ModuleId, string>()
        const assertCurrent = () => {
          try { return require('../../scripts/lib/workspace-relocation-intent.mjs').observeWorkspaceRelocationRecords(() => {
            if (!active || this.isShuttingDown || this.workspaceRecoveryInitialization?.coordinator !== coordinator
              || sha256CanonicalJson(records.readWorkspaceRecoveryRuntimePlan(this.dataDir, request.recovery_id)) !== planHash
              || this.modules.size !== definitions.size || this.processes.get('admin-web') !== admin
              || this.childStates.get(admin) !== adminState || adminState.runtimeId !== adminRuntimeId
              || !native.sameProcess(adminIdentity, native.inspectProcess(admin.pid))
              || !native.sameProcess(launch.parent, native.inspectProcess(process.pid))
              || !native.sameProcess(launch.process, native.inspectProcess(launch.process.pid))
              || [...this.lifecycleQueues.keys()].some(id => id !== 'admin-web' && id !== pendingModule)) throw failure()
            for (const [id, expected] of definitions) {
              if (this.modules.get(id) !== expected.runtime || sha256CanonicalJson(workspaceModuleDefinition(expected.runtime)) !== expected.hash
                || sha256CanonicalJson(this.envOverrides.get(id) ?? {}) !== expected.overrides) throw failure()
            }
            for (const [id, child] of this.processes) {
              if (id === 'admin-web') continue
              const target = plan.modules.find(module => module.module_id === id), state = this.childStates.get(child), runtime = this.modules.get(id)!
              const identity = child.pid && native.inspectProcess(child.pid)
              if (!target || !state || state.runtimeId !== target.runtime_id || runtime.pid !== child.pid || state.moduleId !== id
                || state.finalizeStarted || state.rootExited || state.termination || state.forceTermination || child.exitCode !== null || child.signalCode !== null
                || !identity || identity.parent !== launch.parent.pid || identity.owner !== launch.parent.owner) throw failure()
              if (!launched.has(id)) {
                if (pendingModule !== id) throw failure()
                launched.set(id, { child, state, process: Object.freeze({ ...identity }) })
              }
              const bound = launched.get(id)!
              if (bound.child !== child || bound.state !== state || !native.sameProcess(bound.process, identity)) throw failure()
            }
            for (const [id, item] of launched) if (this.processes.get(id) !== item.child) throw failure()
            for (const [id, hash] of receipts) if (sha256CanonicalJson(records.readWorkspaceRecoveryRuntimeStart(this.dataDir, request.recovery_id, id)) !== hash) throw failure()
            if (completed && (launched.size !== plan.modules.length || receipts.size !== plan.modules.length)) throw failure()
          }) } catch (cause) { active = false; coordinator.close(); throw Object.assign(failure(), { cause }) }
        }
        const verify = async () => {
          try {
            await preparation.verify(); assertCurrent()
            const rows = (await this.runtimeRegistry.listRecords()).filter(row => row.module_id !== 'admin-web')
            assertCurrent()
            if (rows.length !== launched.size) throw failure()
            for (const row of rows) {
              const item = launched.get(row.module_id)
              if (!item || row.runtime_id !== item.state.runtimeId || row.root_pid !== item.process.pid
                || row.instance_id !== this.runtimeRegistry.getInstanceId() || row.module_port !== this.modules.get(row.module_id)?.port) throw failure()
              const hash = sha256CanonicalJson(row), previous = registrations.get(row.runtime_id)
              if (previous && previous !== hash) throw failure()
              registrations.set(row.runtime_id, hash)
            }
            await preparation.verify(); assertCurrent()
          } catch (cause) { active = false; coordinator.close(); throw Object.assign(failure(), { cause }) }
        }
        await cleanup.verify()
        await verify()
        const targets = [...plan.modules].sort((a, b) => (this.modules.get(a.module_id)?.start_priority ?? 100) - (this.modules.get(b.module_id)?.start_priority ?? 100))
        for (const module of targets) {
          const runtime = this.modules.get(module.module_id), permit = Object.freeze({})
          if (!runtime || !['crabot-agent', 'memory-default'].includes(module.module_id)) throw failure()
          pendingModule = module.module_id
          this.workspaceValidationPermits.set(permit, { moduleId: module.module_id, runtime, runtimeId: module.runtime_id, recoveryId: request.recovery_id, verify, assertCurrent })
          try {
            await this.enqueueLifecycle(module.module_id, () => this.startModuleProcess(module.module_id, undefined, this.envOverrides.get(module.module_id), permit))
          } finally { this.workspaceValidationPermits.delete(permit) }
          assertCurrent()
          const receipt = records.readWorkspaceRecoveryRuntimeStart(this.dataDir, request.recovery_id, module.module_id), owned = launched.get(module.module_id)
          if (!owned || !receipt || receipt.runtime.runtime_id !== module.runtime_id || !native.sameProcess(receipt.process, owned.process)) throw failure()
          receipts.set(module.module_id, sha256CanonicalJson(receipt))
          await verify(); pendingModule = undefined
        }
        completed = true
        await verify()
        return Object.freeze({ plan, modules: Object.freeze([...launched].map(([module_id, item]) => Object.freeze({ module_id, runtime_id: item.state.runtimeId, process: item.process }))), verify, assertCurrent })
      } catch (cause) { active = false; coordinator.close(); throw Object.assign(failure(), { cause }) }
    })
    this.workspaceRecoveryValidationLaunches.set(coordinator, pending)
    return pending
  }

  private async prepareWorkspaceRecoveryCompletion(request: VerifyWorkspaceRelocationRecoveryRequestParams, bearer?: string): Promise<PrepareWorkspaceRelocationRecoveryCompletionResult> {
    request = Object.freeze({ ...request })
    const coordinator = await this.initializeWorkspaceRelocationRecovery(request, bearer), previous = this.workspaceRecoveryCompletionPreparations.get(coordinator)
    if (previous) {
      const result = await previous, grant = this.workspaceRecoveryFinalizationGrant
      if (!grant || grant.phase !== 'prepared' || grant.job.recovery_id !== request.recovery_id) throw Object.assign(new Error('Recovery preparation is not current'), { code: 'FORBIDDEN' })
      grant.verify(); return result
    }
    const pending = Promise.resolve().then(async () => {
      const failure = () => Object.assign(new Error('当前恢复完成准备尚未确认，原保护和业务维护已保留。'), { code: 'SERVICE_UNAVAILABLE' })
      let grant: WorkspaceRecoveryFinalizationGrant | undefined
      try {
        const health = await this.verifyWorkspaceRecoveryValidationHealth(request, bearer), context = this.workspaceRecoveryInitialization
        if (!context || context.coordinator !== coordinator) throw failure()
        await health.verify(); health.assertCurrent()
        const scope = require('../../scripts/lib/workspace-recovery-admission.mjs').readWorkspaceRecoveryAdmissionScope(this.dataDir, request)
        const job = Object.freeze({ ...request, launch_sha256: health.root_verified.launch_sha256, plan_sha256: health.root_verified.plan_sha256,
          instance_id: health.root_verified.instance_id, admin_runtime_id: context.result.admin_runtime_id })
        if (job.instance_id !== context.result.instance_id) throw failure()
        const verifyActors = () => {
          if (this.workspaceRecoveryFinalizationGrant !== grant || grant!.revoked || this.workspaceRecoveryInitialization !== context
            || context.coordinator !== coordinator) throw failure()
          const completing = ['releasing', 'released', 'restoring', 'restored', 'resuming', 'resumed'].includes(grant!.phase)
          const currentScope = completing ? context.readScope()
            : require('../../scripts/lib/workspace-recovery-admission.mjs').readWorkspaceRecoveryAdmissionScope(this.dataDir, request)
          if (currentScope.fingerprint !== scope.fingerprint) throw failure()
          const admin = this.processes.get('admin-web'), state = admin && this.childStates.get(admin)
          if (!admin || !state || state.runtimeId !== job.admin_runtime_id || state.finalizeStarted || state.rootExited || state.termination || state.forceTermination
            || !state.reachedRunning || this.modules.get('admin-web')?.status !== 'running' || admin.exitCode !== null || admin.signalCode !== null) throw failure()
        }
        grant = { token: crypto.randomBytes(32).toString('base64url'), revoked: false, phase: 'preparing', job, verifyActors,
          verifyHealth: async () => {
            grant!.verify()
            if (context.readScope().released) {
              if (!grant!.releasedHealth) throw failure()
              await grant!.releasedHealth.verify()
            } else await health.verify()
            grant!.verify()
          }, verify: () => {
            try {
              verifyActors()
              if (context.readScope().released) {
                if (!grant!.releasedHealth) throw failure()
                grant!.releasedHealth.assertCurrent()
              } else health.assertCurrent()
            } catch (cause) { grant!.revoked = true; coordinator.close(); throw Object.assign(failure(), { cause }) }
          } }
        if (this.workspaceRecoveryFinalizationGrant) this.workspaceRecoveryFinalizationGrant.revoked = true
        this.workspaceRecoveryFinalizationGrant = grant; grant.verify()
        const expected = Object.freeze({ prepared: true as const, ...job })
        const response = await this.withCurrentAdminRpc(30000, async (rpc, verifyAdmin) => {
          grant!.verify()
          const result = await rpc.call('prepare_workspace_relocation_recovery_completion', request, { authorizationBearer: grant!.token })
          await verifyAdmin(); await health.verify(); grant!.verify()
          return result
        })
        if (sha256CanonicalJson(response) !== sha256CanonicalJson(expected)) throw failure()
        grant.phase = 'prepared'; grant.verify()
        return expected
      } catch (cause) {
        if (grant) grant.revoked = true
        coordinator.close()
        throw Object.assign(failure(), { cause })
      }
    })
    this.workspaceRecoveryCompletionPreparations.set(coordinator, pending)
    return pending
  }

  private handleVerifyWorkspaceRelocationRecoveryFinalization(
    params: VerifyWorkspaceRelocationRecoveryFinalizationParams, context?: RpcHandlerContext,
  ): VerifyWorkspaceRelocationRecoveryFinalizationResult {
    const bearer = context?.authorizationBearer, grant = this.workspaceRecoveryFinalizationGrant
    if (!bearer) throw Object.assign(new Error('Recovery completion credential required'), { code: 'UNAUTHORIZED' })
    if (!grant || grant.revoked || Buffer.byteLength(bearer) !== Buffer.byteLength(grant.token)
      || !crypto.timingSafeEqual(Buffer.from(bearer), Buffer.from(grant.token))) throw Object.assign(new Error('Recovery completion credential is not current'), { code: 'FORBIDDEN' })
    grant.verify()
    if (!params || typeof params !== 'object' || Array.isArray(params) || Object.keys(params).join() !== 'action'
      || !['prepare_web', 'resume_web'].includes(params.action)) throw Object.assign(new Error('Invalid recovery completion action'), { code: 'INVALID_PARAMS' })
    const allowed = params.action === 'prepare_web' ? ['preparing', 'prepared'] : ['restored', 'resuming', 'resumed']
    if (!allowed.includes(grant.phase)) throw Object.assign(new Error('Recovery completion action is not admitted'), { code: 'FORBIDDEN' })
    grant.verify()
    if (params.action === 'resume_web') {
      if (!grant.verifyRestored) throw Object.assign(new Error('Original recovery modules are not confirmed'), { code: 'FORBIDDEN' })
      grant.verifyRestored()
    }
    return { verified: true, ...grant.job, action: params.action }
  }

  /** Current generations only; lawful post-release catalog/ledger writes do not revive old authority. */
  private observeWorkspaceRecoveryReleasedHealth(request: VerifyWorkspaceRelocationRecoveryRequestParams, coordinator: WorkspaceRecoveryCoordinator,
    health: WorkspaceRecoveryValidationHealth, grant: WorkspaceRecoveryFinalizationGrant): WorkspaceRecoveryReleasedHealth {
    const native = require('../../scripts/lib/process-identity.cjs'), records = require('../../scripts/lib/workspace-recovery-records.mjs')
    const admission = require('../../scripts/lib/workspace-recovery-admission.mjs'), original = admission.readWorkspaceRecoveryAdmissionScope(this.dataDir, request)
    const stored = records.readWorkspaceRecoveryCoordinator(this.dataDir, request.recovery_id), planHash = sha256CanonicalJson(health.plan)
    const definitions: WorkspaceModuleDefinitions = new Map([...this.modules].map(([id, runtime]) => [id, {
      runtime, hash: sha256CanonicalJson(workspaceModuleDefinition(runtime)), overrides: sha256CanonicalJson(this.envOverrides.get(id) ?? {}),
    }]))
    const activeNonCore = new Map<string, WorkspaceModuleScope>(original.state.modules.modules.filter((scope: WorkspaceModuleScope) =>
      !['crabot-agent', 'memory-default'].includes(scope.module_id) && scope.runtime_id !== undefined && scope.processes.length > 0).map((scope: WorkspaceModuleScope) => [scope.module_id, scope]))
    const cores = health.modules.map(module => {
      const child = this.processes.get(module.module_id), state = child && this.childStates.get(child), runtime = this.modules.get(module.module_id)
      const start = records.readWorkspaceRecoveryRuntimeStart(this.dataDir, request.recovery_id, module.module_id)
      if (!child || !state || !runtime || !start || state.runtimeId !== module.runtime_id || start.runtime.runtime_id !== module.runtime_id) throw new Error('Current recovery Core is missing')
      return { ...module, child, state, runtime, start, startHash: sha256CanonicalJson(start) }
    })
    const admin = this.processes.get('admin-web'), adminIdentity = admin?.pid && native.inspectProcess(admin.pid)
    const workspaceRootOverride = process.env.WORKER_WORKSPACES_DIR
    let active = true
    const failure = () => Object.assign(new Error('当前已收口恢复的运行或新根无法确认，未重发启动。'), { code: 'SERVICE_UNAVAILABLE' })
    const assertCurrent = () => {
      try {
        grant.verifyActors()
        if (!active || !admin || !adminIdentity || this.processes.get('admin-web') !== admin || this.modules.size !== definitions.size
          || !native.sameProcess(adminIdentity, native.inspectProcess(admin.pid)) || !native.sameProcess(stored.launch.parent, native.inspectProcess(process.pid))
          || !native.sameProcess(stored.launch.process, native.inspectProcess(stored.launch.process.pid))
          || process.env.WORKER_WORKSPACES_DIR !== workspaceRootOverride || sha256CanonicalJson(records.readWorkspaceRecoveryRuntimePlan(this.dataDir, request.recovery_id)) !== planHash) throw failure()
        const scope = admission.readWorkspaceRecoveryCompletionScope(this.dataDir, request)
        if (!scope.released || scope.fingerprint !== original.fingerprint) throw failure()
        const target = scope.state.published.target, stat = fs.lstatSync(target.path, { bigint: true })
        const actual = { path: target.path, dev: String(stat.dev), ino: String(stat.ino), native_id: process.platform === 'win32' ? native.inspectDirectoryFileId(target.path) : null }
        if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(target.path) !== target.path || sha256CanonicalJson(actual) !== sha256CanonicalJson(target)) throw failure()
        for (const [id, expected] of definitions) if (this.modules.get(id) !== expected.runtime || sha256CanonicalJson(workspaceModuleDefinition(expected.runtime)) !== expected.hash
          || sha256CanonicalJson(this.envOverrides.get(id) ?? {}) !== expected.overrides) throw failure()
        for (const item of cores) {
          if (this.processes.get(item.module_id) !== item.child || this.childStates.get(item.child) !== item.state || item.state.runtimeId !== item.runtime_id
            || item.runtime.pid !== item.child.pid || item.runtime.status !== 'running' || !item.state.reachedRunning || item.state.finalizeStarted || item.state.rootExited
            || item.state.termination || item.state.forceTermination || item.child.exitCode !== null || item.child.signalCode !== null
            || !native.sameProcess(item.process, native.inspectProcess(item.child.pid))) throw failure()
          records.verifyWorkspaceRecoveryRuntimeStart({ dataDir: this.dataDir, recoveryId: request.recovery_id, moduleId: item.module_id,
            recordHash: item.startHash, definitionHash: item.start.definition_sha256 })
        }
        for (const id of this.processes.keys()) if (id !== 'admin-web' && !cores.some(item => item.module_id === id) && !activeNonCore.has(id)) throw failure()
        if (['restored', 'resuming', 'resumed'].includes(grant.phase) && [...activeNonCore.keys()].some(id => !this.processes.has(id))) throw failure()
      } catch (cause) { active = false; coordinator.close(); throw Object.assign(failure(), { cause }) }
    }
    const verifyRuntime = async () => {
      try {
        assertCurrent(); await coordinator.verify(); assertCurrent()
        const rows = await this.runtimeRegistry.listRecords()
        assertCurrent()
        if (cores.some(item => rows.filter(row => row.module_id === item.module_id).length !== 1)) throw failure()
        for (const row of rows) {
          const core = cores.find(item => item.module_id === row.module_id)
          if (core) { if (sha256CanonicalJson(row) !== sha256CanonicalJson(core.start.runtime)) throw failure(); continue }
          const child = this.processes.get(row.module_id), state = child && this.childStates.get(child), runtime = this.modules.get(row.module_id)
          if (!child || !state || !runtime || row.instance_id !== grant.job.instance_id || row.runtime_id !== state.runtimeId || row.root_pid !== child.pid || row.module_port !== runtime.port) throw failure()
          if (row.module_id === 'admin-web') { if (row.runtime_id !== grant.job.admin_runtime_id) throw failure(); continue }
          const old = activeNonCore.get(row.module_id), identity = native.inspectProcess(child.pid)
          if (!old || row.runtime_id === old.runtime_id || !identity || identity.parent !== stored.launch.parent.pid || identity.owner !== stored.launch.parent.owner) throw failure()
        }
        const { WorkspaceCatalog } = require('crabot-shared/dist/workspace-catalog.js')
        const catalog = await new WorkspaceCatalog({ dataRoot: this.dataDir, storageRoot: workspaceRootOverride, files: native }).snapshot()
        assertCurrent()
        if (catalog.storage_root !== original.state.published.target.path || catalog.revision < original.state.selected.catalog_revision) throw failure()
        await coordinator.verify(); assertCurrent()
      } catch (cause) { active = false; coordinator.close(); throw Object.assign(failure(), { cause }) }
    }
    const verify = async () => {
      try {
        await verifyRuntime()
        const { openSpawnedModuleRuntimeRpc } = require('../../scripts/lib/module-carrier-rpc.cjs')
        for (const item of cores) {
          const rpc = await openSpawnedModuleRuntimeRpc(item.child, item.process, item.runtime.port,
            { instance_id: grant.job.instance_id, module_id: item.module_id, runtime_id: item.runtime_id }, { timeoutMs: this.config.health_check_timeout * 1000 })
          try { assertCurrent(); if ((await rpc.call('health', {})).status !== 'healthy') throw failure(); assertCurrent() } finally { rpc.close() }
          await verifyRuntime()
        }
        const agent = cores.find(item => item.module_id === 'crabot-agent'), credential = this.runtimeBearers.get('crabot-agent')
        if (!agent || !credential || credential.revoked || credential.child !== agent.child) throw failure()
        const rpc = await openSpawnedModuleRuntimeRpc(agent.child, agent.process, agent.runtime.port,
          { instance_id: grant.job.instance_id, module_id: agent.module_id, runtime_id: agent.runtime_id }, { timeoutMs: 30000 })
        try {
          assertCurrent()
          if (sha256CanonicalJson(await rpc.call('verify_workspace_relocation_recovery_root', request, { authorizationBearer: credential.token })) !== sha256CanonicalJson(health.root_verified)) throw failure()
          assertCurrent()
          if (this.runtimeBearers.get('crabot-agent') !== credential || credential.revoked) throw failure()
        } finally { rpc.close() }
        await verifyRuntime()
      } catch (cause) { active = false; coordinator.close(); throw Object.assign(failure(), { cause }) }
    }
    return Object.freeze({ root_verified: health.root_verified, assertCurrent, verifyRuntime, verify })
  }

  private async handleVerifyWorkspaceRelocationRecoveryRelease(
    params: VerifyWorkspaceRelocationRecoveryReleaseParams, context?: RpcHandlerContext,
  ): Promise<VerifyWorkspaceRelocationRecoveryReleaseResult> {
    const bearer = context?.authorizationBearer, grant = this.workspaceRecoveryFinalizationGrant
    if (!bearer) throw Object.assign(new Error('Recovery release credential required'), { code: 'UNAUTHORIZED' })
    if (!grant || grant.revoked || Buffer.byteLength(bearer) !== Buffer.byteLength(grant.token)
      || !crypto.timingSafeEqual(Buffer.from(bearer), Buffer.from(grant.token))) throw Object.assign(new Error('Recovery release credential is not current'), { code: 'FORBIDDEN' })
    grant.verify()
    const request = require('../../scripts/lib/workspace-recovery-admission.mjs').parseWorkspaceRecoveryAdmissionRequest(params)
    if (!['releasing', 'released'].includes(grant.phase) || Object.keys(request).some(key => request[key] !== grant.job[key as keyof typeof grant.job])) {
      throw Object.assign(new Error('Recovery release does not match the current role'), { code: 'FORBIDDEN' })
    }
    await grant.verifyHealth(); grant.verify()
    return { verified: true, ...grant.job }
  }

  /** One new coordinator effect only. A lost reply queries that same effect, never sends it again. */
  private async releaseWorkspaceRecoveryCompletion(request: VerifyWorkspaceRelocationRecoveryRequestParams, bearer?: string): Promise<ReleaseWorkspaceRelocationRecoveryCompletionResult> {
    request = Object.freeze({ ...request })
    const coordinator = await this.initializeWorkspaceRelocationRecovery(request, bearer), previous = this.workspaceRecoveryCompletionReleases.get(coordinator)
    const failure = () => Object.assign(new Error('当前恢复保护收口尚未确认，业务维护及原材料已保留；未重发移动。'), { code: 'SERVICE_UNAVAILABLE' })
    if (previous) {
      const result = await previous, grant = this.workspaceRecoveryFinalizationGrant
      if (!grant || grant.phase !== 'released' || grant.job.recovery_id !== request.recovery_id) throw failure()
      await grant.verifyHealth(); grant.verify(); return result
    }
    const pending = Promise.resolve().then(async () => {
      let grant: WorkspaceRecoveryFinalizationGrant | undefined
      try {
        const prepared = await this.prepareWorkspaceRecoveryCompletion(request, bearer)
        grant = this.workspaceRecoveryFinalizationGrant
        if (!grant || grant.phase !== 'prepared' || grant.job.recovery_id !== request.recovery_id) throw failure()
        grant.verify()
        await this.beginWorkspaceRecoveryCompletionObservation(request, bearer)
        grant.verify()
        const health = this.workspaceRecoveryValidationHealth.get(coordinator)
        if (!health) throw failure()
        grant.releasedHealth = this.observeWorkspaceRecoveryReleasedHealth(request, coordinator, await health, grant)
        grant.phase = 'releasing'; grant.verify()
        await grant.verifyHealth(); grant.verify()
        let result
        try { result = await coordinator.releaseCompletion(prepared, grant.token, this.config.port) }
        catch { result = await coordinator.observeRelease(prepared) }
        const expected: ReleaseWorkspaceRelocationRecoveryCompletionResult = Object.freeze({ released: true, ...grant.job })
        if (sha256CanonicalJson(result) !== sha256CanonicalJson(expected)
          || !require('../../scripts/lib/workspace-recovery-admission.mjs').readWorkspaceRecoveryCompletionScope(this.dataDir, request).released) throw failure()
        await grant.verifyHealth(); grant.verify()
        grant.phase = 'released'; grant.verify()
        return expected
      } catch (cause) {
        if (grant) grant.revoked = true
        coordinator.close()
        throw Object.assign(failure(), { cause })
      }
    })
    this.workspaceRecoveryCompletionReleases.set(coordinator, pending)
    return pending
  }

  private async resumeWorkspaceRecoveryWeb(request: VerifyWorkspaceRelocationRecoveryRequestParams, bearer?: string): Promise<ResumeWorkspaceRelocationRecoveryWebResult> {
    request = Object.freeze({ ...request })
    const coordinator = await this.initializeWorkspaceRelocationRecovery(request, bearer), previous = this.workspaceRecoveryWebResumes.get(coordinator)
    const failure = () => Object.assign(new Error('新根已选择，当前恢复的服务或Web重开尚未完整确认；未重发启动。'), { code: 'SERVICE_UNAVAILABLE' })
    if (previous) {
      const result = await previous, grant = this.workspaceRecoveryFinalizationGrant
      if (!grant || grant.phase !== 'resumed' || !grant.verifyRestored || grant.job.recovery_id !== request.recovery_id) throw failure()
      grant.verifyRestored(); await grant.verifyHealth(); grant.verifyRestored(); return result
    }
    const pending = Promise.resolve().then(async () => {
      let grant: WorkspaceRecoveryFinalizationGrant | undefined, stage = 'release'
      try {
        await this.releaseWorkspaceRecoveryCompletion(request, bearer)
        grant = this.workspaceRecoveryFinalizationGrant
        if (!grant || grant.phase !== 'released' || !grant.releasedHealth || grant.job.recovery_id !== request.recovery_id) throw failure()
        grant.verify(); await grant.verifyHealth(); grant.verify()
        const scope = require('../../scripts/lib/workspace-recovery-admission.mjs').readWorkspaceRecoveryCompletionScope(this.dataDir, request)
        const launch = require('../../scripts/lib/workspace-recovery-records.mjs').readWorkspaceRecoveryCoordinator(this.dataDir, request.recovery_id).launch
        const definitions: WorkspaceModuleDefinitions = new Map([...this.modules].map(([id, runtime]) => [id, {
          runtime, hash: sha256CanonicalJson(workspaceModuleDefinition(runtime)), overrides: sha256CanonicalJson(this.envOverrides.get(id) ?? {}),
        }]))
        const current = grant
        stage = 'restore-modules'; current.phase = 'restoring'; current.verify()
        const restored = await this.restoreWorkspaceModules(scope.state.modules.modules, definitions, { parent: launch.parent, assertCurrent: () => {
          current.verify()
          if (this.workspaceRecoveryFinalizationGrant !== current || !['restoring', 'restored', 'resuming', 'resumed'].includes(current.phase)) throw failure()
        } })
        current.verifyRestored = restored.verify; current.phase = 'restored'; restored.verify()
        await current.verifyHealth(); restored.verify()
        stage = 'resume-web'; current.phase = 'resuming'; current.verify()
        const result = await this.withCurrentAdminRpc(30000, async (rpc, verifyAdmin) => {
          restored.verify()
          const value = await rpc.call('resume_workspace_relocation_recovery_web', request, { authorizationBearer: current.token })
          await verifyAdmin(); restored.verify()
          return value
        })
        const expected: ResumeWorkspaceRelocationRecoveryWebResult = Object.freeze({ resumed: true, ...current.job })
        if (sha256CanonicalJson(result) !== sha256CanonicalJson(expected)) throw failure()
        await current.verifyHealth(); restored.verify()
        current.phase = 'resumed'; restored.verify()
        return expected
      } catch (cause) {
        if (grant) grant.revoked = true
        coordinator.close()
        throw Object.assign(failure(), { stage, cause })
      }
    })
    this.workspaceRecoveryWebResumes.set(coordinator, pending)
    return pending
  }

  /** Retire only this current recovery after actual restoration and its coordinator exit. */
  private completeWorkspaceRecovery(request: VerifyWorkspaceRelocationRecoveryRequestParams, bearer?: string): Promise<ResumeWorkspaceRelocationRecoveryWebResult> {
    if (!bearer) return Promise.reject(Object.assign(new Error('Current human credential required'), { code: 'UNAUTHORIZED' }))
    request = require('../../scripts/lib/workspace-recovery-admission.mjs').parseWorkspaceRecoveryAdmissionRequest(request)
    const fingerprint = sha256CanonicalJson(request), bearerHash = sha256CanonicalJson(bearer), previous = this.workspaceRecoveryCompletions.get(request.recovery_id)
    const failure = () => Object.assign(new Error('当前恢复尚未完整收尾，请查看原作业状态；未重发效果。'), { code: 'SERVICE_UNAVAILABLE' })
    if (previous) return previous.fingerprint === fingerprint && previous.bearerHash === bearerHash ? previous.pending : Promise.reject(Object.assign(failure(), { code: 'FORBIDDEN' }))
    const pending = Promise.resolve().then(async () => {
      let grant: WorkspaceRecoveryFinalizationGrant | undefined, coordinator: WorkspaceRecoveryCoordinator | undefined
      let stage = 'restore-services'
      try {
        coordinator = await this.initializeWorkspaceRelocationRecovery(request, bearer)
        const initialized = this.workspaceRecoveryInitializations.get(request.recovery_id)
        const result = await this.resumeWorkspaceRecoveryWeb(request, bearer)
        grant = this.workspaceRecoveryFinalizationGrant
        if (!grant || grant.phase !== 'resumed' || !grant.verifyRestored || grant.job.recovery_id !== request.recovery_id) throw failure()
        grant.verifyRestored(); await grant.verifyHealth(); grant.verifyRestored()
        const record = require('../../scripts/lib/workspace-recovery-records.mjs').readWorkspaceRecoveryCoordinator(this.dataDir, request.recovery_id)
        stage = 'coordinator-exit'; grant.revoked = true; coordinator.close()
        await this.closeWorkspaceCoordinatorChannel(coordinator.child)
        if (coordinator.child.connected || require('../../scripts/lib/known-process-exit.cjs').probeKnownProcessExit([record.launch.process]).state !== 'stopped') throw failure()
        if (this.workspaceRecoveryFinalizationGrant === grant) this.workspaceRecoveryFinalizationGrant = undefined
        if (this.workspaceRecoveryInitializations.get(request.recovery_id) === initialized) this.workspaceRecoveryInitializations.delete(request.recovery_id)
        for (const cache of [this.workspaceRecoveryRuntimePreparations, this.workspaceRecoveryRuntimeCleanups, this.workspaceRecoveryValidationLaunches,
          this.workspaceRecoveryValidationHealth, this.workspaceRecoveryCompletionObservations, this.workspaceRecoveryCompletionPreparations,
          this.workspaceRecoveryCompletionReleases, this.workspaceRecoveryWebResumes]) cache.delete(coordinator)
        return result
      } catch (cause) {
        if (grant) grant.revoked = true
        coordinator?.close()
        throw Object.assign(failure(), { stage, cause })
      }
    })
    this.workspaceRecoveryCompletions.set(request.recovery_id, { fingerprint, bearerHash, pending })
    return pending
  }

  /** Observe this one completion effect under the current role; this performs no file release. */
  private async beginWorkspaceRecoveryCompletionObservation(request: VerifyWorkspaceRelocationRecoveryRequestParams, bearer?: string): Promise<WorkspaceRecoveryValidationHealth> {
    request = Object.freeze({ ...request })
    const coordinator = await this.initializeWorkspaceRelocationRecovery(request, bearer), previous = this.workspaceRecoveryCompletionObservations.get(coordinator)
    if (previous) { const result = await previous; await result.verify(); return result }
    const pending = Promise.resolve().then(async () => {
      try {
        const health = await this.verifyWorkspaceRecoveryValidationHealth(request, bearer), context = this.workspaceRecoveryInitialization
        if (!context || context.coordinator !== coordinator) throw new Error('Recovery observation context changed')
        await health.verify(); health.assertCurrent()
        await coordinator.beginCompletionObservation()
        if (this.workspaceRecoveryInitialization !== context || context.coordinator !== coordinator) throw new Error('Recovery observation context changed')
        context.allowCompletionObservation()
        await health.verify(); health.assertCurrent()
        return health
      } catch (cause) {
        coordinator.close()
        throw Object.assign(new Error('当前恢复收口观察尚未确认，原保护和材料已保留；未执行文件移动。'), { code: 'SERVICE_UNAVAILABLE', cause })
      }
    })
    this.workspaceRecoveryCompletionObservations.set(coordinator, pending)
    return pending
  }

  private async verifyWorkspaceRecoveryValidationHealth(request: VerifyWorkspaceRelocationRecoveryRequestParams, bearer?: string): Promise<WorkspaceRecoveryValidationHealth> {
    request = Object.freeze({ ...request })
    const coordinator = await this.initializeWorkspaceRelocationRecovery(request, bearer), previous = this.workspaceRecoveryValidationHealth.get(coordinator)
    if (previous) { const result = await previous; await result.verify(); return result }
    const failure = () => Object.assign(new Error('新恢复模块健康与目录能力尚未全部确认，维护保护已保留；未重复启动或探测。'), { code: 'SERVICE_UNAVAILABLE' })
    const pending = Promise.resolve().then(async () => {
      let active = true
      try {
        const launched = await this.startWorkspaceRecoveryValidationModules(request, bearer)
        const records = require('../../scripts/lib/workspace-recovery-records.mjs'), launch = records.readWorkspaceRecoveryCoordinator(this.dataDir, request.recovery_id).launch
        const instanceId = this.runtimeRegistry.getInstanceId(), agent = launched.modules.find(module => module.module_id === 'crabot-agent')
        const credential = this.runtimeBearers.get('crabot-agent')
        if (!agent || !credential || credential.child !== this.processes.get('crabot-agent')) throw failure()
        const expected: VerifyWorkspaceRelocationRecoveryRootResult = Object.freeze({ verified: true, ...request,
          launch_sha256: sha256CanonicalJson(launch), plan_sha256: sha256CanonicalJson(launched.plan), root_selected_sha256: launched.plan.root_selected_sha256,
          instance_id: instanceId, module_id: 'crabot-agent', runtime_id: agent.runtime_id })
        const assertCurrent = () => {
          try {
            if (!active || this.workspaceRecoveryInitialization?.coordinator !== coordinator || this.runtimeBearers.get('crabot-agent') !== credential
              || credential.revoked || credential.child !== this.processes.get('crabot-agent')) throw failure()
            launched.assertCurrent()
          } catch (cause) { active = false; coordinator.close(); throw Object.assign(failure(), { cause }) }
        }
        const { openSpawnedModuleRuntimeRpc } = require('../../scripts/lib/module-carrier-rpc.cjs')
        const verify = async () => {
          try {
            await launched.verify(); assertCurrent()
            for (const module of launched.modules) {
              const runtime = this.modules.get(module.module_id)!, deadline = Date.now() + 120000
              for (;;) {
                await launched.verify(); assertCurrent()
                const child = this.processes.get(module.module_id), state = child && this.childStates.get(child)
                if (!state || Date.now() > deadline || runtime.status === 'error' || runtime.status === 'stopped') throw failure()
                if (state.reachedRunning && runtime.status === 'running') break
                await new Promise(resolve => setTimeout(resolve, 100))
              }
              const rpc = await openSpawnedModuleRuntimeRpc(this.processes.get(module.module_id), module.process, runtime.port,
                { instance_id: instanceId, module_id: module.module_id, runtime_id: module.runtime_id }, { timeoutMs: this.config.health_check_timeout * 1000 })
              try {
                assertCurrent()
                const health: HealthResult = await rpc.call('health', {})
                assertCurrent()
                if (health.status !== 'healthy') throw failure()
                await launched.verify(); assertCurrent()
              } finally { rpc.close() }
            }
            const rpc = await openSpawnedModuleRuntimeRpc(credential.child, agent.process, this.modules.get('crabot-agent')!.port,
              { instance_id: instanceId, module_id: 'crabot-agent', runtime_id: agent.runtime_id }, { timeoutMs: 30000 })
            try {
              assertCurrent()
              const result = await rpc.call('verify_workspace_relocation_recovery_root', request, { authorizationBearer: credential.token })
              assertCurrent()
              if (sha256CanonicalJson(result) !== sha256CanonicalJson(expected)) throw failure()
            } finally { rpc.close() }
            await launched.verify(); assertCurrent()
          } catch (cause) { active = false; coordinator.close(); throw Object.assign(failure(), { cause }) }
        }
        await verify()
        return Object.freeze({ ...launched, healthy_modules: Object.freeze(launched.modules.map(module => Object.freeze({ module_id: module.module_id, runtime_id: module.runtime_id }))),
          root_verified: expected, verify, assertCurrent })
      } catch (cause) { active = false; coordinator.close(); throw Object.assign(failure(), { cause }) }
    })
    this.workspaceRecoveryValidationHealth.set(coordinator, pending)
    return pending
  }

  private async prepareWorkspaceRecoveryRuntimes(request: VerifyWorkspaceRelocationRecoveryRequestParams, bearer?: string): Promise<WorkspaceRecoveryRuntimePreparation> {
    request = Object.freeze({ ...request })
    const coordinator = await this.initializeWorkspaceRelocationRecovery(request, bearer), previous = this.workspaceRecoveryRuntimePreparations.get(coordinator)
    if (previous) { const result = await previous; await result.verify(); return result }
    const pending = Promise.resolve().then(async () => {
      try {
        const facts = await this.inspectWorkspaceRelocationRecovery(request, bearer)
        await facts.verify()
        const records = require('../../scripts/lib/workspace-recovery-records.mjs')
        const scope = require('../../scripts/lib/workspace-recovery-admission.mjs').readWorkspaceRecoveryAdmissionScope(this.dataDir, request)
        const modules = scope.state.health.modules.map((module: { module_id: string }) => ({ module_id: module.module_id, runtime_id: this.runtimeRegistry.createRuntimeId() }))
          .sort((a: { module_id: string }, b: { module_id: string }) => a.module_id.localeCompare(b.module_id))
        const plan: WorkspaceRecoveryRuntimePlan = await records.commitWorkspaceRecoveryRuntimePlan({ dataDir: this.dataDir, recoveryId: request.recovery_id, modules, verify: facts.verify })
        const planHash = sha256CanonicalJson(plan)
        for (const module of plan.modules) Object.freeze(module)
        Object.freeze(plan.modules); Object.freeze(plan)
        const assertPlan = () => {
          if (sha256CanonicalJson(records.readWorkspaceRecoveryRuntimePlan(this.dataDir, request.recovery_id)) !== planHash) throw new Error('Recovery runtime plan changed')
        }
        const verify = async () => {
          try { await facts.verify(); assertPlan(); await facts.verify(); assertPlan() }
          catch (cause) { coordinator.close(); throw cause }
        }
        await verify()
        return Object.freeze({ plan, verify })
      } catch (cause) {
        coordinator.close()
        throw Object.assign(new Error('新恢复运行预登记未全部确认，维护保护已保留；未启动业务模块。'), { code: 'SERVICE_UNAVAILABLE', cause })
      }
    })
    this.workspaceRecoveryRuntimePreparations.set(coordinator, pending)
    return pending
  }

  private async handleVerifyWorkspaceRelocationRecoveryRuntime(
    params: VerifyWorkspaceRelocationRecoveryRuntimeParams, context?: RpcHandlerContext,
  ): Promise<VerifyWorkspaceRelocationRecoveryRuntimeResult> {
    context = Object.freeze({ authorizationBearer: context?.authorizationBearer })
    this.handleVerifyCoreAgentRuntime({ expected_module_id: 'crabot-agent' }, context)
    const request = require('../../scripts/lib/workspace-recovery-admission.mjs').parseWorkspaceRecoveryAdmissionRequest(params)
    const current = this.workspaceRecoveryInitialization, coordinator = current?.coordinator
    const pending = coordinator && this.workspaceRecoveryValidationLaunches.get(coordinator)
    if (!current || !coordinator || !pending || sha256CanonicalJson(current.request) !== sha256CanonicalJson(request)) {
      throw Object.assign(new Error('No matching current recovery validation role'), { code: 'FORBIDDEN' })
    }
    const grant = this.workspaceRecoveryFinalizationGrant
    if (grant?.releasedHealth && grant.job.recovery_id === request.recovery_id && current.readScope().released) {
      grant.verify(); await grant.releasedHealth.verifyRuntime(); grant.verify()
      this.handleVerifyCoreAgentRuntime({ expected_module_id: 'crabot-agent' }, context)
      return grant.releasedHealth.root_verified
    }
    const launched = await pending
    await launched.verify()
    this.handleVerifyCoreAgentRuntime({ expected_module_id: 'crabot-agent' }, context)
    const agent = launched.modules.find(module => module.module_id === 'crabot-agent'), credential = this.runtimeBearers.get('crabot-agent')
    if (this.workspaceRecoveryInitialization !== current || current.coordinator !== coordinator || !agent || !credential
      || this.processes.get('crabot-agent') !== credential.child || credential.child.pid !== agent.process.pid) {
      throw Object.assign(new Error('Recovery Agent generation changed'), { code: 'FORBIDDEN' })
    }
    const record = require('../../scripts/lib/workspace-recovery-records.mjs').readWorkspaceRecoveryCoordinator(this.dataDir, request.recovery_id)
    launched.assertCurrent()
    return { verified: true, ...request, launch_sha256: sha256CanonicalJson(record.launch), plan_sha256: sha256CanonicalJson(launched.plan),
      root_selected_sha256: launched.plan.root_selected_sha256, instance_id: this.runtimeRegistry.getInstanceId(), module_id: 'crabot-agent', runtime_id: agent.runtime_id }
  }

  private async handleVerifyWorkspaceRelocationRecoveryAdmission(
    params: VerifyWorkspaceRelocationRecoveryAdmissionParams, context?: RpcHandlerContext,
  ): Promise<VerifyWorkspaceRelocationRecoveryAdmissionResult> {
    const bearer = context?.authorizationBearer
    if (!bearer) throw Object.assign(new Error('Current admission credential required'), { code: 'UNAUTHORIZED' })
    const admission = this.workspaceRecoveryAdmission, preparation = this.workspaceRecoveryAdmissionPreparation
    if (!admission || !preparation || sha256CanonicalJson(bearer) !== preparation.bearerHash) throw Object.assign(new Error('No current recovery admission'), { code: 'FORBIDDEN' })
    await admission.verify()
    const request = require('../../scripts/lib/workspace-recovery-admission.mjs').parseWorkspaceRecoveryAdmissionRequest(params)
    if (sha256CanonicalJson(request) !== sha256CanonicalJson(admission.request)) throw Object.assign(new Error('Recovery admission mismatch'), { code: 'FORBIDDEN' })
    await admission.verify()
    return admission.result
  }

  private async handleVerifyWorkspaceRelocationFinalization(
    params: VerifyWorkspaceRelocationFinalizationParams, context?: RpcHandlerContext,
  ): Promise<VerifyWorkspaceRelocationFinalizationResult> {
    const supplied = context?.authorizationBearer, grant = this.workspaceFinalizationGrant
    if (!supplied) throw Object.assign(new Error('Finalization credential required'), { code: 'UNAUTHORIZED' })
    if (!grant || grant.revoked || Buffer.byteLength(supplied) !== Buffer.byteLength(grant.token)
      || !crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(grant.token))) throw Object.assign(new Error('Finalization credential is not current'), { code: 'FORBIDDEN' })
    const uuid = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value)
    if (!params || typeof params !== 'object' || Array.isArray(params) || Object.keys(params).sort().join() !== 'action,completion_sha256,intent_id,launch_id'
      || !uuid(params.intent_id) || !uuid(params.launch_id) || typeof params.completion_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(params.completion_sha256)
      || !['prepare_web', 'resume_web'].includes(params.action)) throw Object.assign(new Error('Invalid finalization request'), { code: 'INVALID_PARAMS' })
    if (params.intent_id !== grant.request.intent_id || params.launch_id !== grant.launch.launch_id || params.completion_sha256 !== grant.completionHash
      || params.action === 'prepare_web' && !['archived', 'prepared'].includes(grant.phase)
      || params.action === 'resume_web' && grant.phase !== 'released') throw Object.assign(new Error('Finalization purpose or job does not match'), { code: 'FORBIDDEN' })
    try { grant.verify() }
    catch (cause) {
      if ((cause as { code?: string }).code === 'FORBIDDEN') throw cause
      throw Object.assign(new Error('Finalization facts cannot be verified'), { code: 'SERVICE_UNAVAILABLE', cause })
    }
    return { verified: true, ...params, intent_sha256: grant.request.intent_sha256, launch_sha256: sha256CanonicalJson(grant.launch) }
  }

  private prepareWorkspaceRelocationCompletion(request: VerifyWorkspaceRelocationRequestParams, bearer?: string): Promise<PrepareWorkspaceRelocationCompletionResult> {
    request = Object.freeze({ ...request })
    const fingerprint = sha256CanonicalJson(request), previous = this.workspaceFinalizationPreparation
    if (previous) {
      if (previous.fingerprint !== fingerprint) return Promise.reject(Object.assign(new Error('Finalization job cannot change'), { code: 'FORBIDDEN' }))
      return previous.pending.then(result => {
        const grant = this.workspaceFinalizationGrant
        if (!grant || grant.phase !== 'prepared') throw Object.assign(new Error('Finalization preparation is not current'), { code: 'FORBIDDEN' })
        grant.verify()
        return result
      })
    }
    const pending = Promise.resolve().then(async (): Promise<PrepareWorkspaceRelocationCompletionResult> => {
      const failure = () => Object.assign(new Error('迁移完成准备尚未确认，已保留维护保护。'), { code: 'SERVICE_UNAVAILABLE' })
      let child: ChildProcess | undefined, terminal: { archive(): Promise<unknown>; release(prepared: PrepareWorkspaceRelocationCompletionResult): Promise<unknown>; observeRelease(): Promise<unknown>; close(): void } | undefined
      try {
        const health = await this.verifyWorkspaceRelocationValidationHealth(request, bearer), proof = this.workspaceValidationProof
        this.noteWorkspaceRelocationJobStage(request, 'finalizing')
        child = health.coordinator
        if (!proof || proof.result.coordinator !== child || sha256CanonicalJson(proof.request) !== fingerprint) throw failure()
        proof.assertCurrent()
        const records = require('../../scripts/lib/workspace-relocation-intent.mjs'), native = require('../../scripts/lib/process-identity.cjs')
        const coordinator = records.readWorkspaceRelocationCoordinator(this.dataDir, request.intent_id), context = { dataDir: this.dataDir, id: request.intent_id, launch: coordinator.launch }
        const files = require('../../scripts/lib/workspace-coordinator-journal.mjs').createWorkspaceJournalClient(child, context, 'file')
        let completionHash: string
        try { completionHash = (await files.call('prepare_completion', {})).completion_sha256 } finally { files.close() }
        proof.assertCurrent()
        if (typeof completionHash !== 'string' || sha256CanonicalJson(records.readWorkspaceRelocationCompletion(this.dataDir, request.intent_id)) !== completionHash) throw failure()
        const admin = this.processes.get('admin-web'), adminState = admin && this.childStates.get(admin), adminRuntime = this.modules.get('admin-web')
        const self = native.inspectProcess(process.pid), adminIdentity = admin?.pid && native.inspectProcess(admin.pid), launch = coordinator.launch
        if (!admin || !adminState || !adminRuntime || !adminIdentity || !native.sameProcess(launch.parent, self)) throw failure()
        const adminRuntimeId = adminState.runtimeId, adminPort = adminRuntime.port, adminPid = admin.pid
        const originalScopes: ReadonlyArray<WorkspaceModuleScope> = records.readWorkspaceRelocationModules(this.dataDir, request.intent_id).modules
        const definitions: WorkspaceModuleDefinitions = new Map([...this.modules].map(([id, runtime]) => [id, {
          runtime, hash: sha256CanonicalJson(workspaceModuleDefinition(runtime)), overrides: sha256CanonicalJson(this.envOverrides.get(id) ?? {}),
        }]))
        let restoration: Promise<{ modules: ReadonlyArray<{ module_id: ModuleId; runtime_id: string }>; verify: () => void }> | undefined
        let finalizingHash: string | undefined
        const verifyActors = () => {
          const forbidden = () => { grant.revoked = true; return Object.assign(new Error('Finalization role changed'), { code: 'FORBIDDEN' }) }
          if (this.workspaceFinalizationGrant !== grant || grant.revoked || this.isShuttingDown || !child!.connected || child!.exitCode !== null || child!.signalCode !== null
            || this.processes.get('admin-web') !== admin || this.childStates.get(admin) !== adminState || this.modules.get('admin-web') !== adminRuntime
            || adminState.runtimeId !== adminRuntimeId || adminState.rootPid !== adminPid || adminRuntime.pid !== adminPid
            || adminRuntime.port !== adminPort || adminRuntime.module_type !== 'admin' || adminRuntime.status !== 'running'
            || adminState.finalizeStarted || adminState.rootExited || !adminState.reachedRunning || adminState.termination || admin.exitCode !== null || admin.signalCode !== null
            || !native.sameProcess(self, native.inspectProcess(process.pid)) || !native.sameProcess(launch.process, native.inspectProcess(child!.pid))
            || !native.sameProcess(adminIdentity, native.inspectProcess(admin.pid))) throw forbidden()
        }
        const acceptRelease = (result: unknown) => {
          const expected = { intent_id: request.intent_id, completion_sha256: completionHash, finalizing_sha256: finalizingHash }
          if (sha256CanonicalJson(result) !== sha256CanonicalJson(expected)) throw failure()
          grant.phase = 'released'; grant.verify()
          return Object.freeze(expected)
        }
        const grant: WorkspaceFinalizationGrant = { token: crypto.randomBytes(32).toString('base64url'), revoked: false, phase: 'archiving', request,
          completionHash, launch, child,
          release: async prepared => {
            grant.verify()
            if (grant.phase !== 'prepared' || !terminal) throw failure()
            const result = await terminal.release(prepared)
            return acceptRelease(result)
          },
          observeRelease: async () => {
            verifyActors()
            if (grant.phase !== 'prepared' || !terminal) throw failure()
            const result = await terminal.observeRelease()
            verifyActors()
            return acceptRelease(result)
          },
          restoreModules: async () => {
            grant.verify()
            if (grant.phase !== 'released') throw failure()
            restoration ??= this.restoreWorkspaceRelocationModules(grant, originalScopes, definitions)
            const result = await restoration
            result.verify()
            return result.modules
          }, close: () => terminal?.close(), verify: () => {
            verifyActors()
            const completion = grant.phase === 'archiving' ? records.readWorkspaceRelocationCompletion(this.dataDir, request.intent_id)
              : records.readWorkspaceRelocationArchivedCompletion(this.dataDir, request.intent_id)
            if (sha256CanonicalJson(completion) !== completionHash) throw failure()
            if (grant.phase !== 'archiving' && grant.phase !== 'released') {
              const fence = records.readWorkspaceRelocationFinalizing(this.dataDir, request.intent_id)
              if (!fence || fence.completion_sha256 !== completionHash || sha256CanonicalJson(fence) !== finalizingHash) throw failure()
            } else if (grant.phase === 'released') {
              if (workspaceMaintenancePending(this.dataDir) || sha256CanonicalJson(records.readWorkspaceRelocationReleased(this.dataDir, request.intent_id)) !== finalizingHash) throw failure()
            }
          } }
        if (this.workspaceFinalizationGrant) this.workspaceFinalizationGrant.revoked = true
        this.workspaceFinalizationGrant = grant; grant.verify()
        terminal = require('../../scripts/lib/workspace-finalization-journal.mjs').createWorkspaceFinalizationJournal(child, context)
        const archived = await terminal!.archive() as { completion_sha256: string; finalizing_sha256: string }
        if (archived.completion_sha256 !== completionHash) throw failure()
        finalizingHash = archived.finalizing_sha256
        grant.phase = 'archived'; grant.verify()
        const params = { intent_id: request.intent_id, launch_id: launch.launch_id, completion_sha256: completionHash }
        const response = await this.withCurrentAdminRpc(30000, async (rpc, verify) => {
          grant.verify()
          const result = await rpc.call('prepare_workspace_relocation_completion', params, { authorizationBearer: grant.token })
          await verify(); grant.verify()
          return result
        })
        const expected = { prepared: true as const, ...params, intent_sha256: request.intent_sha256, launch_sha256: sha256CanonicalJson(launch) }
        if (sha256CanonicalJson(response) !== sha256CanonicalJson(expected)) throw failure()
        grant.phase = 'prepared'; grant.verify()
        return Object.freeze(expected)
      } catch (cause) {
        if (this.workspaceFinalizationGrant?.request.intent_id === request.intent_id) this.workspaceFinalizationGrant.revoked = true
        await this.closeWorkspaceCoordinatorChannel(child)
        throw Object.assign(failure(), { cause })
      } finally { if (this.workspaceFinalizationGrant?.phase !== 'prepared') terminal?.close() }
    })
    this.workspaceFinalizationPreparation = { fingerprint, pending }
    return pending
  }

  /** Normal finalization keeps its original role; cold recovery never constructs this grant. */
  private restoreWorkspaceRelocationModules(grant: WorkspaceFinalizationGrant, scopes: ReadonlyArray<WorkspaceModuleScope>, definitions: WorkspaceModuleDefinitions) {
    return this.restoreWorkspaceModules(scopes, definitions, { parent: grant.launch.parent, assertCurrent: () => {
      grant.verify()
      if (this.workspaceFinalizationGrant !== grant || grant.phase !== 'released') throw Object.assign(new Error('Normal restoration role changed'), { code: 'SERVICE_UNAVAILABLE' })
    } })
  }

  /** Neutral original-active non-Core startup/health only; the caller owns its role and scope. */
  private async restoreWorkspaceModules(scopes: ReadonlyArray<WorkspaceModuleScope>, definitions: WorkspaceModuleDefinitions,
    role: { parent: WorkerProcessIdentity; assertCurrent: () => void }) {
    const failure = () => Object.assign(new Error('新工作区已选择，但原模块恢复尚未完整确认；未重发启动。'), { code: 'SERVICE_UNAVAILABLE' })
    const native = require('../../scripts/lib/process-identity.cjs'), { captureSpawnedProcessTree } = require('../../scripts/lib/spawned-process-tree.cjs')
    const restored = new Map<ModuleId, { child: ChildProcess; state: ManagedChildState; runtimeId: string; process: WorkerProcessIdentity }>()
    const nonCore = scopes.filter(scope => !['crabot-agent', 'memory-default'].includes(scope.module_id))
    let pendingModule: ModuleId | undefined
    const verify = () => {
      role.assertCurrent()
      if (this.modules.size !== definitions.size) throw failure()
      for (const [id, expected] of definitions) {
        if (this.modules.get(id) !== expected.runtime || sha256CanonicalJson(workspaceModuleDefinition(expected.runtime)) !== expected.hash
          || sha256CanonicalJson(this.envOverrides.get(id) ?? {}) !== expected.overrides) throw failure()
      }
      for (const scope of nonCore) {
        const current = restored.get(scope.module_id), runtime = this.modules.get(scope.module_id)!
        if (!current) {
          if (scope.module_id !== pendingModule && (this.processes.has(scope.module_id) || runtime.pid !== undefined || ['running', 'starting'].includes(runtime.status))) throw failure()
          continue
        }
        const actual = native.inspectProcess(current.child.pid)
        if (this.processes.get(scope.module_id) !== current.child || this.childStates.get(current.child) !== current.state
          || current.state.runtimeId !== current.runtimeId || current.state.rootPid !== current.child.pid || current.state.child !== current.child
          || current.state.moduleId !== scope.module_id || runtime.pid !== current.child.pid || runtime.status !== 'running' || !current.state.reachedRunning || current.state.finalizeStarted
          || current.state.rootExited || current.state.termination || current.child.exitCode !== null || current.child.signalCode !== null
          || !actual || actual.pid !== current.process.pid || actual.started !== current.process.started
          || actual.owner !== current.process.owner || actual.parent !== current.process.parent) throw failure()
      }
    }
    verify()
    const targets = nonCore.filter(scope => scope.runtime_id !== undefined && scope.processes.length > 0)
      .sort((a, b) => (this.modules.get(a.module_id)!.start_priority ?? 100) - (this.modules.get(b.module_id)!.start_priority ?? 100))
    for (const scope of targets) {
      verify(); pendingModule = scope.module_id
      const guard: WorkspaceModuleRestorationGuard = { assertCurrent: verify, verify: async () => {
        verify()
        if (!this.processes.has(scope.module_id) && (await this.runtimeRegistry.listRecords()).some(row => row.module_id === scope.module_id)) throw failure()
        verify()
      } }
      await this.enqueueLifecycle(scope.module_id, () => this.startModuleProcess(scope.module_id, undefined, this.envOverrides.get(scope.module_id), undefined, guard))
      verify()
      const child = this.processes.get(scope.module_id), state = child && this.childStates.get(child), runtime = this.modules.get(scope.module_id)!
      const original = child?.pid && native.inspectProcess(child.pid)
      if (!child || !state || !original || original.parent !== role.parent.pid || original.owner !== role.parent.owner) throw failure()
      const deadline = Date.now() + 120000
      while (!(state.reachedRunning && runtime.status === 'running')) {
        verify()
        if (Date.now() > deadline || this.processes.get(scope.module_id) !== child || this.childStates.get(child) !== state
          || state.finalizeStarted || state.rootExited || child.exitCode !== null || child.signalCode !== null
          || runtime.status === 'error' || runtime.status === 'stopped') throw failure()
        await new Promise(resolve => setTimeout(resolve, 100))
      }
      const identity = native.inspectProcess(child.pid)
      if (!identity || identity.pid !== original.pid || identity.started !== original.started || identity.owner !== original.owner || identity.parent !== original.parent) throw failure()
      restored.set(scope.module_id, { child, state, runtimeId: state.runtimeId, process: identity }); pendingModule = undefined
      verify()
      const rows = (await this.runtimeRegistry.listRecords()).filter(row => row.module_id === scope.module_id), row = rows[0], fingerprint = sha256CanonicalJson(rows)
      verify()
      if (rows.length !== 1 || row.instance_id !== scope.instance_id || row.runtime_id !== state.runtimeId || row.runtime_id === scope.runtime_id
        || row.root_pid !== child.pid || row.module_port !== runtime.port || await probeProcessStartIdentity(child.pid!) !== row.process_start_identity) throw failure()
      verify()
      if (runtime.skip_health_check !== true) {
        const locate = () => {
          verify()
          const listeners = captureSpawnedProcessTree(child).filter((item: WorkerProcessIdentity) => native.sameProcess(item, native.inspectProcess(item.pid))
            && native.listListeningTcpPorts(item.pid).includes(runtime.port))
          if (listeners.length !== 1) throw failure()
          return listeners[0]
        }
        const listener = locate(), { openModuleRuntimeRpc } = require('../../scripts/lib/module-runtime-rpc.cjs')
        const rpc = await openModuleRuntimeRpc(listener, runtime.port, { instance_id: row.instance_id, module_id: scope.module_id, runtime_id: state.runtimeId },
          { timeoutMs: this.config.health_check_timeout * 1000 })
        try {
          verify()
          if (!native.sameProcess(listener, locate())) throw failure()
          const result = await rpc.call('health', {})
          verify()
          if (result.status !== 'healthy' || !native.sameProcess(listener, locate())) throw failure()
        } finally { rpc.close() }
      }
      if (sha256CanonicalJson((await this.runtimeRegistry.listRecords()).filter(row => row.module_id === scope.module_id)) !== fingerprint) throw failure()
      verify()
    }
    verify()
    return { modules: Object.freeze([...restored].map(([module_id, current]) => Object.freeze({ module_id, runtime_id: current.state.runtimeId }))), verify }
  }

  /** The same accepted normal job only; this stage does not clear all job state or report full migration completion. */
  private resumeWorkspaceRelocationWeb(request: VerifyWorkspaceRelocationRequestParams, bearer?: string): Promise<ResumeWorkspaceRelocationWebResult> {
    request = Object.freeze({ ...request })
    const fingerprint = sha256CanonicalJson(request), previous = this.workspaceFinalizationResume
    const failure = () => Object.assign(new Error('工作区业务恢复尚未确认，请查看原作业诊断。'), { code: 'SERVICE_UNAVAILABLE' })
    if (previous) {
      if (previous.fingerprint !== fingerprint) return Promise.reject(Object.assign(failure(), { code: 'FORBIDDEN' }))
      return previous.pending.then(result => {
        const grant = this.workspaceFinalizationGrant
        if (!grant || grant.phase !== 'released') throw failure()
        grant.verify()
        return result
      })
    }
    const pending = Promise.resolve().then(async (): Promise<ResumeWorkspaceRelocationWebResult> => {
      let grant: WorkspaceFinalizationGrant | undefined
      let stage = 'prepare'
      try {
        const prepared = await this.prepareWorkspaceRelocationCompletion(request, bearer)
        grant = this.workspaceFinalizationGrant
        if (!grant || grant.phase !== 'prepared' || sha256CanonicalJson(grant.request) !== fingerprint) throw failure()
        grant.verify()
        stage = 'release'
        try { await grant.release(prepared) }
        catch {
          // Query the original existing effect only; never resend the release or recreate a role.
          stage = 'observe-release'
          await grant.observeRelease()
        }
        grant.verify()
        stage = 'current-root'
        const records = require('../../scripts/lib/workspace-relocation-intent.mjs')
        await records.verifyWorkspaceRelocationReleasedCapabilities({ dataDir: this.dataDir, id: request.intent_id, verify: async () => grant!.verify() })
        grant.verify()
        stage = 'restore-modules'
        this.noteWorkspaceRelocationJobStage(request, 'restoring')
        await grant.restoreModules()
        grant.verify()
        stage = 'resume-web'
        const params = { intent_id: prepared.intent_id, launch_id: prepared.launch_id, completion_sha256: prepared.completion_sha256 }
        const current = grant
        const result = await this.withCurrentAdminRpc(30000, async (rpc, verify) => {
          current.verify()
          const response = await rpc.call('resume_workspace_relocation_web', params, { authorizationBearer: current.token })
          await verify(); current.verify()
          return response
        })
        const expected = { resumed: true as const, ...params, intent_sha256: prepared.intent_sha256, launch_sha256: prepared.launch_sha256 }
        if (sha256CanonicalJson(result) !== sha256CanonicalJson(expected)) throw failure()
        grant.verify()
        return Object.freeze(expected)
      } catch (cause) {
        if (grant) { grant.revoked = true; grant.close(); await this.closeWorkspaceCoordinatorChannel(grant.child) }
        throw Object.assign(failure(), { stage, cause })
      }
    })
    this.workspaceFinalizationResume = { fingerprint, pending }
    return pending
  }

  /** Complete only this normal job after real Web/module recovery and the original lock owner's exit. */
  private completeWorkspaceRelocation(request: VerifyWorkspaceRelocationRequestParams, bearer?: string): Promise<ResumeWorkspaceRelocationWebResult> {
    request = Object.freeze({ ...request })
    const fingerprint = sha256CanonicalJson(request), previous = this.workspaceFinalizationCompletion
    const failure = () => Object.assign(new Error('原工作区作业尚未完整收尾，请查看当前状态；未重发迁移。'), { code: 'SERVICE_UNAVAILABLE' })
    if (previous) return previous.fingerprint === fingerprint ? previous.pending : Promise.reject(Object.assign(failure(), { code: 'FORBIDDEN' }))
    const pending = Promise.resolve().then(async (): Promise<ResumeWorkspaceRelocationWebResult> => {
      let grant: WorkspaceFinalizationGrant | undefined
      let stage = 'resume-web'
      try {
        const result = await this.resumeWorkspaceRelocationWeb(request, bearer)
        grant = this.workspaceFinalizationGrant
        if (!grant || grant.phase !== 'released' || sha256CanonicalJson(grant.request) !== fingerprint) throw failure()
        const current = grant, records = require('../../scripts/lib/workspace-relocation-intent.mjs')
        const moduleStop = this.workspaceModuleStop, moduleScopeHash = sha256CanonicalJson(records.readWorkspaceRelocationArchivedState(this.dataDir, request.intent_id).modules.modules)
        const cacheKeys = ['workspaceStopSequence', 'workspaceFilePreparation', 'workspaceWorkerClosure', 'workspaceRootSelection',
          'workspaceValidationLaunch', 'workspaceValidationHealth', 'workspaceFinalizationPreparation', 'workspaceFinalizationResume'] as const
        const ownsCaches = () => {
          if (this.workspaceFinalizationGrant !== current || this.workspaceFinalizationCompletion?.pending !== pending) throw failure()
          for (const key of cacheKeys) if (this[key] && this[key]!.fingerprint !== fingerprint) throw failure()
          if (this.workspaceModuleStop !== moduleStop || moduleStop && moduleStop.fingerprint !== moduleScopeHash) throw failure()
          if (this.workspaceValidationProof && sha256CanonicalJson(this.workspaceValidationProof.request) !== fingerprint
            || this.workspaceCoordinatorGrant && this.workspaceCoordinatorGrant.proof.intent_id !== request.intent_id) throw failure()
        }
        ownsCaches(); current.verify()
        stage = 'current-modules'
        await current.restoreModules()
        current.verify(); ownsCaches()
        await records.verifyWorkspaceRelocationReleasedCapabilities({ dataDir: this.dataDir, id: request.intent_id, verify: async () => { current.verify(); ownsCaches() } })
        current.verify(); ownsCaches()
        stage = 'coordinator-exit'
        current.revoked = true; current.close()
        this.workspaceCoordinatorGrant?.revoke?.()
        await this.closeWorkspaceCoordinatorChannel(current.child)
        if (current.child.connected || require('../../scripts/lib/known-process-exit.cjs').probeKnownProcessExit([current.launch.process]).state !== 'stopped') throw failure()
        ownsCaches()
        // No filesystem marker or unrelated job is removed here.
        for (const key of cacheKeys) this[key] = undefined
        this.workspaceModuleStop = undefined
        this.workspaceValidationProof = undefined
        this.workspaceCoordinatorGrant = undefined
        this.workspaceFinalizationGrant = undefined
        this.workspaceFinalizationCompletion = undefined
        return result
      } catch (cause) {
        if (grant) { grant.revoked = true; grant.close(); await this.closeWorkspaceCoordinatorChannel(grant.child) }
        throw Object.assign(failure(), { stage, cause })
      }
    })
    this.workspaceFinalizationCompletion = { fingerprint, pending }
    return pending
  }

  private async handleVerifyWorkspaceRelocationRuntime(
    params: VerifyWorkspaceRelocationRuntimeParams, context?: RpcHandlerContext,
  ): Promise<VerifyWorkspaceRelocationRuntimeResult> {
    context = Object.freeze({ authorizationBearer: context?.authorizationBearer })
    this.handleVerifyCoreAgentRuntime({ expected_module_id: 'crabot-agent' }, context)
    const uuid = (value: unknown) => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)
    if (!params || typeof params !== 'object' || Array.isArray(params) || Object.keys(params).length !== 2
      || !Object.keys(params).every(key => key === 'intent_id' || key === 'launch_id') || !uuid(params.intent_id) || !uuid(params.launch_id)) {
      throw Object.assign(new Error('Invalid workspace validation request'), { code: 'INVALID_PARAMS' })
    }
    const request = Object.freeze({ ...params }), proof = this.workspaceValidationProof
    if (!proof) throw Object.assign(new Error('Workspace validation launch is not confirmed'), { code: 'SERVICE_UNAVAILABLE' })
    if (request.intent_id !== proof.request.intent_id || request.launch_id !== proof.launchId) {
      throw Object.assign(new Error('Workspace validation job does not match'), { code: 'FORBIDDEN' })
    }
    const validateAgent = () => {
      this.handleVerifyCoreAgentRuntime({ expected_module_id: 'crabot-agent' }, context)
      proof.assertCurrent()
      const agent = proof.result.validation_modules.find(item => item.module_id === 'crabot-agent')
      const child = this.processes.get('crabot-agent'), state = child && this.childStates.get(child)
      if (this.workspaceValidationProof !== proof || !agent || !child || !state || state.runtimeId !== agent.runtime_id
        || this.runtimeBearers.get('crabot-agent')?.child !== child || state.rootExited || state.finalizeStarted || state.intentionalReason
        || state.termination || state.forceTermination || !state.reachedRunning) {
        throw Object.assign(new Error('Workspace validation Agent is not current'), { code: 'FORBIDDEN' })
      }
      return agent
    }
    try {
      validateAgent()
      await proof.verify()
      const agent = validateAgent()
      return { verified: true, ...request, intent_sha256: proof.request.intent_sha256, launch_sha256: proof.launchHash,
        root_selected_sha256: proof.result.root_selected_sha256, instance_id: this.runtimeRegistry.getInstanceId(), module_id: 'crabot-agent', runtime_id: agent.runtime_id }
    } catch (cause) {
      throw Object.assign(new Error('无法核实迁移后的Agent运行代际，已保留维护保护。'), { code: 'SERVICE_UNAVAILABLE', cause })
    }
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
        const { recaptureObservedProcessScope } = require('../../scripts/lib/owned-process-tree.cjs')
        const processes: ReadonlyArray<WorkerProcessIdentity> = recaptureObservedProcessScope(reply.processes)
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
    } catch (error) {
      runtime.status = 'error'
      const causes: Array<Record<string, string | null>> = []
      for (let current: unknown = error; current && typeof current === 'object' && causes.length < 4; current = (current as { cause?: unknown }).cause) {
        const value = current as { code?: unknown; stage?: unknown; transport_code?: unknown; remote_code?: unknown }
        const safe = (item: unknown, pattern: RegExp) => typeof item === 'string' && item.length <= 128 && pattern.test(item) ? item : null
        causes.push({ code: safe(value.code, /^(?:CRABOT_|WORKSPACE_)[A-Z_]+$|^E[A-Z]+$/), stage: safe(value.stage, /^[a-z][a-z0-9-]*$/),
          transport_code: safe(value.transport_code, /^(?:ERR_[A-Z_]+|E[A-Z]+|ABORT_ERR)$/), remote_code: safe(value.remote_code, /^(?:UNAUTHORIZED|FORBIDDEN|SERVICE_UNAVAILABLE|INTERNAL_ERROR|TIMEOUT)$/) })
      }
      console.error(JSON.stringify({ event: 'workspace_module_stop_unverified', module_id: scope.module_id, causes }))
    }
    return result
  }

  private async startModuleProcess(
    moduleId: ModuleId,
    entryOverride?: string,
    envOverride?: Record<string, string>,
    validationPermit?: object,
    restorationGuard?: WorkspaceModuleRestorationGuard
  ): Promise<void> {
    this.assertManagementOnlyAllowed(moduleId)
    this.assertAgentLifecycleAllowed(moduleId)
    this.assertCoreLifecycleInput(moduleId, entryOverride, envOverride)
    await this.assertWorkspaceProcessStartAllowed(moduleId, validationPermit, restorationGuard)
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

    await this.assertWorkspaceProcessStartAllowed(moduleId, validationPermit, restorationGuard)
    if (runtime.status === 'running' || runtime.status === 'starting') {
      throw new Error(`Module already running: ${moduleId}`)
    }

    await this.runtimeRegistry.initialize()
    if (validationPermit) await this.assertWorkspaceProcessStartAllowed(moduleId, validationPermit, restorationGuard)
    else {
      if (restorationGuard) await this.assertWorkspaceProcessStartAllowed(moduleId, undefined, restorationGuard)
      await this.runtimeRegistry.recoverOrphans({
        moduleId,
        currentRuntimeIds: this.currentRuntimeIds(),
        gracefulTimeoutMs: this.config.shutdown_timeout * 1000,
      })
      if (restorationGuard) await this.assertWorkspaceProcessStartAllowed(moduleId, undefined, restorationGuard)
    }

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
        if (validationPermit) throw Object.assign(new Error('验证启动不创建模块数据版本。'), { code: 'WORKSPACE_MAINTENANCE' })
        if (restorationGuard) throw Object.assign(new Error('恢复启动不重新初始化模块数据版本。'), { code: 'WORKSPACE_MAINTENANCE' })
        const { mkdirSync, writeFileSync } = await import('node:fs')
        await this.assertWorkspaceProcessStartAllowed(moduleId, validationPermit, restorationGuard)
        this.assertWorkspaceProcessStartCurrent(moduleId, validationPermit, restorationGuard)
        mkdirSync(runtime.data_dir, { recursive: true })
        writeFileSync(`${runtime.data_dir}/SCHEMA_VERSION`, `${result.writeVersion}\n`)
        console.log(`[ModuleManager] ${moduleId}: wrote initial SCHEMA_VERSION = ${result.writeVersion}`)
      }
    }

    if (this.isShuttingDown) {
      throw new Error(`Module Manager is shutting down; refusing to spawn ${moduleId}`)
    }

    await this.assertWorkspaceProcessStartAllowed(moduleId, validationPermit, restorationGuard)
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
    const runtimeId = (validationPermit && this.workspaceValidationPermits.get(validationPermit)?.runtimeId) ?? this.runtimeRegistry.createRuntimeId()

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

    const recoveryId = validationPermit && this.workspaceValidationPermits.get(validationPermit)?.recoveryId
    let runtimeGate: { child: ChildProcess; ready(): Promise<unknown>; start(input: unknown): Promise<unknown>; observe(): Promise<unknown>; close(): void } | undefined
    let proc: ChildProcess
    try {
      this.assertWorkspaceProcessStartCurrent(moduleId, validationPermit, restorationGuard)
      if (recoveryId) {
        runtimeGate = require('../../scripts/lib/workspace-runtime-gate.mjs').createWorkspaceRuntimeGate()
        proc = runtimeGate!.child
      } else proc = spawn(command, args, {
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

    let runtimeRecord: ModuleRuntimeRecord
    try {
      runtimeRecord = await this.runtimeRegistry.recordSpawn({
        runtimeId,
        moduleId,
        rootPid: proc.pid,
        modulePort: runtime.port,
      })
    } catch (error) {
      runtimeGate?.close()
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
      if (!runtimeGate || !cleanupError) await this.runtimeRegistry.removeRuntime(runtimeId).catch((removeError) => {
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
      // register may settle while recordSpawn is awaiting I/O.
      reachedRunning: (runtime as ModuleRuntime).status === 'running',
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

    if (runtimeGate) {
      try {
        await runtimeGate.ready()
        await this.assertWorkspaceProcessStartAllowed(moduleId, validationPermit)
        const invocation = { command, args, cwd: path.resolve(runtime.cwd ?? '.'), env: childEnv }
        const records = require('../../scripts/lib/workspace-recovery-records.mjs')
        const verify = () => this.assertWorkspaceProcessStartAllowed(moduleId, validationPermit)
        const assertCurrent = () => this.assertWorkspaceProcessStartCurrent(moduleId, validationPermit)
        const receipt = await records.commitWorkspaceRecoveryRuntimeStart({ dataDir: this.dataDir, recoveryId, moduleId,
          process: require('../../scripts/lib/process-identity.cjs').inspectProcess(proc.pid), runtime: runtimeRecord,
          definitionHash: sha256CanonicalJson(invocation), verify })
        try {
          await runtimeGate.start({ dataDir: this.dataDir, recoveryId, moduleId, recordHash: sha256CanonicalJson(receipt), invocation, verify, assertCurrent })
        } catch {
          // The release may have reached the carrier even when its acknowledgement did not.
          // Observe that same one-time effect; never issue another start.
          await runtimeGate.observe()
        }
      } catch {
        childState.intentionalReason = 'shutdown'
        this.revokeRuntimeBearer(moduleId)
        runtimeGate.close()
        runtime.status = 'error'
        throw Object.assign(new Error('恢复验证模块未能确认先登记后启动，已保留维护和技术材料；未重试。'), { code: 'CRABOT_WORKSPACE_RUNTIME_GATE' })
      }
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
    state.termination ??= state.forceTermination ?? this.terminateChildTree(state, false)
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
