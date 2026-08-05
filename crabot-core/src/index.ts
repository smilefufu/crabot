/**
 * Module Manager - Crabot 模块生命周期管理器
 *
 * 负责所有模块的启动、停止、健康检查、事件转发等
 *
 * @see crabot-docs/protocols/protocol-module-manager.md
 */

import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
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

// ============================================================================
// 类型定义
// ============================================================================

interface MethodHandler<P = unknown, R = unknown> {
  (params: P): Promise<R> | R
}

interface EventSubscription {
  subscriber: ModuleId
  eventTypes: string[]
}

interface ManagedChildState {
  moduleId: ModuleId
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

// ============================================================================
// Module Manager 类
// ============================================================================

export class ModuleManager {
  private readonly config: ModuleManagerConfig
  private readonly portAllocator: PortAllocator
  private readonly modules: Map<ModuleId, ModuleRuntime> = new Map()
  private readonly processes: Map<ModuleId, ChildProcess> = new Map()
  private readonly childStates: WeakMap<ChildProcess, ManagedChildState> = new WeakMap()
  private readonly lifecycleQueues: Map<ModuleId, Promise<void>> = new Map()
  private readonly restartTimers: Map<ModuleId, NodeJS.Timeout> = new Map()
  private readonly envOverrides: Map<ModuleId, Record<string, string>> = new Map()
  private readonly healthProbes: Set<ModuleId> = new Set()
  private readonly healthRecoveries: Set<ModuleId> = new Set()
  private readonly subscriptions: EventSubscription[] = []
  private readonly methodHandlers: Map<string, MethodHandler> = new Map()

  private server: http.Server | null = null
  private healthCheckTimer: NodeJS.Timeout | null = null
  private diskWatcherTimer: NodeJS.Timeout | null = null
  private isShuttingDown = false
  private readonly logsDir: string
  private readonly dataDir: string

  constructor(config: Partial<ModuleManagerConfig> = {}, dataDir: string) {
    this.config = { ...DEFAULT_CONFIG, ...config }
    this.portAllocator = new PortAllocator(this.config.port_range, dataDir)
    this.logsDir = path.join(dataDir, 'logs')
    fs.mkdirSync(this.logsDir, { recursive: true })
    this.dataDir = dataDir

    // 注册所有方法处理器
    this.registerMethod('register', this.handleRegister.bind(this))
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

    // 启动 HTTP 服务器
    this.server = http.createServer((req, res) => {
      this.handleRequest(req, res).catch((error) => {
        console.error('[ModuleManager] Unhandled error:', error)
        res.writeHead(500)
        res.end(JSON.stringify({ error: 'Internal server error' }))
      })
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
  async stop(): Promise<void> {
    if (this.isShuttingDown) return
    this.isShuttingDown = true

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
    try {
      await Promise.all(
        managedModuleIds.map((moduleId) => this.enqueueLifecycle(
          moduleId,
          () => this.stopModuleProcess(moduleId, 'shutdown'),
        )),
      )
    } catch (error) {
      this.isShuttingDown = false
      throw error
    }

    // 关闭 HTTP 服务器
    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server!.close(() => resolve())
      })
    }

    console.log('[ModuleManager] Stopped')
  }

  // ============================================================================
  // HTTP 请求处理
  // ============================================================================

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const method = req.url?.slice(1) ?? ''

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
      const result = await handler(params)
      const response = createSuccessResponse(request?.id ?? generateId(), result)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(response))
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      const errorCode = (error as { code?: string }).code ?? GlobalErrorCode.INTERNAL_ERROR
      const errorResponse = createErrorResponse(
        request?.id ?? generateId(),
        errorCode,
        errorMessage
      )
      res.writeHead(500, { 'Content-Type': 'application/json' })
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

  // --- 模块注册 ---

  private async handleRegister(params: RegisterParams): Promise<{ registered: true }> {
    const runtime = this.modules.get(params.module_id)

    if (!runtime) {
      throw Object.assign(new Error('Module definition not found'), {
        code: 'MODULE_MANAGER_MODULE_NOT_FOUND',
      })
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

    // 发布事件
    await this.publishEvent(
      createModuleStartedEvent('module-manager', {
        module_id: params.module_id,
        module_type: params.module_type,
        port: params.port,
        restart_count: runtime.restart_history?.attempts.length ?? 0,
      })
    )

    console.log(`[ModuleManager] Module registered: ${params.module_id}`)
    return { registered: true }
  }

  private async handleUnregister(params: { module_id: ModuleId }): Promise<{ unregistered: true }> {
    const runtime = this.modules.get(params.module_id)
    if (!runtime) {
      throw Object.assign(new Error('Module not found'), { code: 'NOT_FOUND' })
    }

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

  private async handleStartModule(params: {
    module_id: ModuleId
    entry_override?: string
    env?: Record<string, string>
  }): Promise<{ status: 'accepted'; tracking_id: string }> {
    this.assertLifecycleRequestsAllowed()
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
    const trackingId = generateId()
    this.cancelAutoRestart(params.module_id)

    this.enqueueLifecycle(params.module_id, async () => {
      this.cancelAutoRestart(params.module_id)
      const env = params.env === undefined
        ? { ...(this.envOverrides.get(params.module_id) ?? {}) }
        : { ...params.env }
      this.envOverrides.set(params.module_id, env)
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
    const def = params.module_definition

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
    const runtime = this.modules.get(params.module_id)
    if (!runtime) {
      throw Object.assign(new Error('Module definition not found'), { code: 'NOT_FOUND' })
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

  private async handleShutdown(): Promise<Record<string, never>> {
    setTimeout(() => {
      this.stop().catch(console.error)
    }, 100)
    return {}
  }

  // ============================================================================
  // 进程管理
  // ============================================================================

  private async startModuleProcess(
    moduleId: ModuleId,
    entryOverride?: string,
    envOverride?: Record<string, string>
  ): Promise<void> {
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

    if (runtime.status === 'running' || runtime.status === 'starting') {
      throw new Error(`Module already running: ${moduleId}`)
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
        const { mkdirSync, writeFileSync } = await import('node:fs')
        mkdirSync(runtime.data_dir, { recursive: true })
        writeFileSync(`${runtime.data_dir}/SCHEMA_VERSION`, `${result.writeVersion}\n`)
        console.log(`[ModuleManager] ${moduleId}: wrote initial SCHEMA_VERSION = ${result.writeVersion}`)
      }
    }

    if (this.isShuttingDown) {
      throw new Error(`Module Manager is shutting down; refusing to spawn ${moduleId}`)
    }

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
    const adminEndpointOverride =
      adminRpcPort && moduleId !== 'admin-web'
        ? { CRABOT_ADMIN_ENDPOINT: `http://localhost:${adminRpcPort}` }
        : {}

    const proc = spawn(command, args, {
      cwd: runtime.cwd,
      env: {
        ...process.env,
        ...runtime.env,
        ...envOverride,
        Crabot_MODULE_ID: moduleId,
        Crabot_PORT: String(runtime.port),
        // MM 是自身端口的权威来源：显式注入回连端口/地址。
        // 否则动态注册的模块（如 channel）env 里没有 CRABOT_MM_PORT，
        // RpcClient 会 fallback 到默认 19000，在多实例/端口偏移部署下连到错误的 MM。
        CRABOT_MM_PORT: String(this.config.port),
        CRABOT_MM_ENDPOINT: `http://localhost:${this.config.port}`,
        ...adminEndpointOverride,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    })

    this.processes.set(moduleId, proc)
    runtime.pid = proc.pid

    let resolveFinalized!: () => void
    const finalized = new Promise<void>(resolve => { resolveFinalized = resolve })
    const childState: ManagedChildState = {
      moduleId,
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

    try {
      await this.ensureChildTreeTerminated(state)
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

  private async scheduleAutomaticRestart(runtime: ModuleRuntime): Promise<void> {
    if (this.isShuttingDown || !runtime.auto_restart) {
      await this.transitionHealthStatus(runtime, 'unhealthy')
      return
    }

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
        const env = { ...(this.envOverrides.get(runtime.module_id) ?? {}) }
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
    if (this.isShuttingDown || this.healthRecoveries.has(runtime.module_id)) return
    this.healthRecoveries.add(runtime.module_id)

    this.enqueueLifecycle(runtime.module_id, async () => {
      if (!failedChild || this.processes.get(runtime.module_id) !== failedChild) {
        if (!this.processes.has(runtime.module_id) && runtime.status === 'running') runtime.status = 'error'
        return
      }
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
      .filter((m) => m.auto_start)
      .sort((a, b) => a.start_priority - b.start_priority)

    for (const module of autoStartModules) {
      try {
        const env: Record<string, string> = {}
        this.envOverrides.set(module.module_id, env)
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
