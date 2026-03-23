/**
 * Module Manager - Crabot 模块生命周期管理器
 *
 * 负责所有模块的启动、停止、健康检查、事件转发等
 *
 * @see crabot-docs/protocols/protocol-module-manager.md
 */

import { spawn, type ChildProcess } from 'node:child_process'
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
} from './core/base-protocol.js'
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
  runtimeToInfo,
  runtimeToResolved,
} from './types.js'
import { PortAllocator } from './port-allocator.js'

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

// ============================================================================
// Module Manager 类
// ============================================================================

export class ModuleManager {
  private readonly config: ModuleManagerConfig
  private readonly portAllocator: PortAllocator
  private readonly modules: Map<ModuleId, ModuleRuntime> = new Map()
  private readonly processes: Map<ModuleId, ChildProcess> = new Map()
  private readonly subscriptions: EventSubscription[] = []
  private readonly methodHandlers: Map<string, MethodHandler> = new Map()

  private server: http.Server | null = null
  private healthCheckTimer: NodeJS.Timeout | null = null
  private isShuttingDown = false

  constructor(config: Partial<ModuleManagerConfig> = {}, dataDir: string) {
    this.config = { ...DEFAULT_CONFIG, ...config }
    this.portAllocator = new PortAllocator(this.config.port_range, dataDir)

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

    // 停止所有运行中的模块
    const runningModules = Array.from(this.modules.values()).filter(
      (m) => m.status === 'running' || m.status === 'starting'
    )

    await Promise.all(
      runningModules.map((m) => this.stopModuleProcess(m.module_id, 'shutdown'))
    )

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

    // 注册事件订阅
    if (params.subscriptions && params.subscriptions.length > 0) {
      this.subscriptions.push({
        subscriber: params.module_id,
        eventTypes: params.subscriptions,
      })
    }

    // 发布事件
    await this.publishEvent(
      createModuleStartedEvent('module-manager', {
        module_id: params.module_id,
        module_type: params.module_type,
        port: params.port,
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

    // 移除订阅
    const subIndex = this.subscriptions.findIndex((s) => s.subscriber === params.module_id)
    if (subIndex !== -1) {
      this.subscriptions.splice(subIndex, 1)
    }

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

  private async handleStartModule(params: {
    module_id: ModuleId
    entry_override?: string
    env?: Record<string, string>
  }): Promise<{ status: 'accepted'; tracking_id: string }> {
    const trackingId = generateId()

    // 异步启动模块
    this.startModuleProcess(params.module_id, params.entry_override, params.env)
      .then(() => {
        // 通过 callback 通知成功
      })
      .catch((error) => {
        console.error(`[ModuleManager] Failed to start module ${params.module_id}:`, error)
      })

    return { status: 'accepted', tracking_id: trackingId }
  }

  private async handleStopModule(params: {
    module_id: ModuleId
    force?: boolean
  }): Promise<{ status: 'accepted'; tracking_id: string }> {
    const trackingId = generateId()

    this.stopModuleProcess(params.module_id, params.force ? 'forced' : 'shutdown')
      .catch((error) => {
        console.error(`[ModuleManager] Failed to stop module ${params.module_id}:`, error)
      })

    return { status: 'accepted', tracking_id: trackingId }
  }

  private async handleRestartModule(params: {
    module_id: ModuleId
    force?: boolean
  }): Promise<{ status: 'accepted'; tracking_id: string }> {
    const trackingId = generateId()

    // 停止后重新启动
    this.stopModuleProcess(params.module_id, params.force ? 'forced' : 'shutdown')
      .then(() => this.startModuleProcess(params.module_id))
      .catch((error) => {
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
    // 移除旧订阅
    const index = this.subscriptions.findIndex((s) => s.subscriber === params.subscriber)
    if (index !== -1) {
      this.subscriptions.splice(index, 1)
    }

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

    if (runtime.status === 'running') {
      throw new Error(`Module already running: ${moduleId}`)
    }

    runtime.status = 'starting'

    // 替换 entry 中的 {PORT} 模板
    const entry = (entryOverride ?? runtime.entry).replace(/{PORT}/g, String(runtime.port))
    const [command, ...args] = this.parseEntry(entry)

    const proc = spawn(command, args, {
      cwd: runtime.cwd,
      env: {
        ...process.env,
        ...runtime.env,
        ...envOverride,
        Crabot_MODULE_ID: moduleId,
        Crabot_PORT: String(runtime.port),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    this.processes.set(moduleId, proc)
    runtime.pid = proc.pid

    // 处理输出
    proc.stdout?.on('data', (data: Buffer) => {
      console.log(`[${moduleId}] ${data.toString().trim()}`)
    })

    proc.stderr?.on('data', (data: Buffer) => {
      console.error(`[${moduleId}] ${data.toString().trim()}`)
    })

    // 处理进程退出
    proc.on('exit', (code, signal) => {
      this.processes.delete(moduleId)
      runtime.pid = undefined

      const wasRunning = runtime.status === 'running'
      runtime.status = 'stopped'

      if (wasRunning && !this.isShuttingDown) {
        // 意外退出
        const reason: ModuleStopReason =
          code === 0 ? 'shutdown' : signal ? 'crashed' : 'crashed'

        this.publishEvent(
          createModuleStoppedEvent('module-manager', {
            module_id: moduleId,
            module_type: runtime.module_type,
            reason,
          })
        ).catch(console.error)

        if (code !== 0) {
          runtime.status = 'error'
          this.publishEvent(
            createModuleHealthChangedEvent('module-manager', {
              module_id: moduleId,
              previous: 'healthy',
              current: 'unhealthy',
            })
          ).catch(console.error)
        }
      }
    })

    proc.on('error', (error) => {
      console.error(`[ModuleManager] Process error for ${moduleId}:`, error)
      runtime.status = 'error'
    })

    console.log(`[ModuleManager] Started module: ${moduleId} (PID: ${proc.pid})`)

    // skip_health_check 模块不走 /register 流程，直接标记 running
    if (runtime.skip_health_check) {
      runtime.status = 'running'
      runtime.registered_at = generateTimestamp()
      this.publishEvent(
        createModuleStartedEvent('module-manager', {
          module_id: moduleId,
          module_type: runtime.module_type,
          port: runtime.port,
        })
      ).catch(console.error)
    }
  }

  private async stopModuleProcess(moduleId: ModuleId, reason: ModuleStopReason): Promise<void> {
    const runtime = this.modules.get(moduleId)
    const proc = this.processes.get(moduleId)

    if (!runtime) {
      throw new Error(`Module not found: ${moduleId}`)
    }

    if (!proc) {
      runtime.status = 'stopped'
      return
    }

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        console.warn(`[ModuleManager] Force killing module: ${moduleId}`)
        proc.kill('SIGKILL')
      }, this.config.shutdown_timeout * 1000)

      proc.on('exit', () => {
        clearTimeout(timeout)
        runtime.status = 'stopped'

        this.publishEvent(
          createModuleStoppedEvent('module-manager', {
            module_id: moduleId,
            module_type: runtime.module_type,
            reason,
          })
        ).catch(console.error)

        resolve()
      })

      // 发送优雅关闭信号
      proc.kill('SIGTERM')
    })
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
    try {
      const result = await this.sendToModule<HealthResult>(runtime.port, 'health', {})

      runtime.last_health_check = generateTimestamp()
      runtime.last_health_status = result.status
      runtime.health_check_failures = 0

      // 更新状态
      if (result.status !== runtime.last_health_status) {
        const previous = runtime.last_health_status
        await this.publishEvent(
          createModuleHealthChangedEvent('module-manager', {
            module_id: runtime.module_id,
            previous: previous ?? 'healthy',
            current: result.status,
          })
        )
      }
    } catch (error) {
      runtime.health_check_failures = (runtime.health_check_failures ?? 0) + 1
      console.warn(
        `[ModuleManager] Health check failed for ${runtime.module_id} (${runtime.health_check_failures}/${this.config.health_check_failure_threshold})`
      )

      if (runtime.health_check_failures >= this.config.health_check_failure_threshold) {
        console.error(`[ModuleManager] Module ${runtime.module_id} marked as error due to health check failures`)
        runtime.status = 'error'
        runtime.last_health_status = 'unhealthy'

        await this.publishEvent(
          createModuleHealthChangedEvent('module-manager', {
            module_id: runtime.module_id,
            previous: 'healthy',
            current: 'unhealthy',
          })
        )

        // 停止有问题的进程
        const proc = this.processes.get(runtime.module_id)
        if (proc) {
          proc.kill('SIGKILL')
          this.processes.delete(runtime.module_id)
        }
      }
    }
  }

  // ============================================================================
  // 辅助方法
  // ============================================================================

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

  private async sendToModule<R>(port: number, method: string, params: unknown): Promise<R> {
    return new Promise((resolve, reject) => {
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
          timeout: this.config.health_check_timeout * 1000,
        },
        (res) => {
          let data = ''
          res.on('data', (chunk: string) => {
            data += chunk
          })
          res.on('end', () => {
            try {
              const response: Response<R> = JSON.parse(data) as Response<R>
              if (response.success) {
                resolve(response.data as R)
              } else {
                reject(new Error(response.error?.message ?? 'Unknown error'))
              }
            } catch (e) {
              reject(new Error(`Failed to parse response: ${String(e)}`))
            }
          })
        }
      )

      req.on('error', reject)
      req.on('timeout', () => {
        req.destroy()
        reject(new Error('Request timeout'))
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
        await this.startModuleProcess(module.module_id)
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
      const icon = m.status === 'running' ? '\u2705' : m.status === 'error' ? '\u274c' : '\u2b55'
      const portInfo = m.status === 'running' ? `:${m.port}` : ''
      lines.push(`  ${icon} ${m.module_id} (${m.module_type}) ${m.status}${portInfo}`)
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
