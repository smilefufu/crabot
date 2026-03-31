/**
 * Module Base - Crabot 模块基类
 *
 * 提供模块的标准实现，包括 HTTP 服务器、请求处理、健康检查等
 */

import http, { type IncomingMessage, type ServerResponse } from 'node:http'
import {
  type Request,
  type Response,
  type HealthResult,
  type Event,
  type ModuleId,
  type ResolvedModule,
  type RegisterParams,
  type PublishEventParams,
  generateId,
  generateTimestamp,
  createSuccessResponse,
  createErrorResponse,
  GlobalErrorCode,
} from './base-protocol.js'

// ============================================================================
// 类型定义
// ============================================================================

/**
 * 模块配置
 */
export interface ModuleConfig {
  /** 模块实例 ID */
  moduleId: ModuleId
  /** 模块类型 */
  moduleType: string
  /** 模块版本 */
  version: string
  /** 协议版本 */
  protocolVersion: string
  /** 监听端口 */
  port: number
  /** 要订阅的事件类型 */
  subscriptions?: string[]
}

/**
 * 模块元数据
 */
export interface ModuleMetadata {
  module_id: ModuleId
  module_type: string
  version: string
  protocol_version: string
  host: string
  port: number
}

/**
 * 方法处理器
 */
type MethodHandler<P = unknown, R = unknown> = (params: P) => Promise<R> | R

/**
 * 回调处理器
 */
type CallbackHandler<P = unknown> = (payload: P) => Promise<void> | void

// ============================================================================
// RPC 客户端
// ============================================================================

/**
 * RPC 客户端 - 用于模块间通信
 */
export class RpcClient {
  private readonly moduleManagerPort: number

  constructor(moduleManagerPort = parseInt(process.env.CRABOT_MM_PORT || '19000', 10)) {
    this.moduleManagerPort = moduleManagerPort
  }

  /**
   * 调用 Module Manager 方法（使用构造时的 MM 端口）
   */
  async callModuleManager<P, R>(method: string, params: P, source: ModuleId): Promise<R> {
    return this.call<P, R>(this.moduleManagerPort, method, params, source)
  }

  /**
   * 调用远程模块方法
   */
  async call<P, R>(
    targetPort: number,
    method: string,
    params: P,
    source: ModuleId
  ): Promise<R> {
    const request: Request<P> = {
      id: generateId(),
      source,
      method,
      params,
      timestamp: generateTimestamp(),
    }

    const body = JSON.stringify(request)

    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: 'localhost',
          port: targetPort,
          method: 'POST',
          path: `/${method}`,
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
          },
        },
        (res) => {
          let data = ''
          res.on('data', (chunk) => {
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
      req.write(body)
      req.end()
    })
  }

  /**
   * 解析模块地址
   */
  async resolve(
    params: { module_id?: ModuleId; module_type?: string },
    source: ModuleId
  ): Promise<ResolvedModule[]> {
    return this.call<ResolveParams, { modules: ResolvedModule[] }>(
      this.moduleManagerPort,
      'resolve',
      params,
      source
    ).then((r) => r.modules)
  }

  /**
   * 发布事件
   */
  async publishEvent(event: Event, source: ModuleId): Promise<number> {
    const result = await this.call<PublishEventParams, { subscriber_count: number }>(
      this.moduleManagerPort,
      'publish_event',
      { event },
      source
    )
    return result.subscriber_count
  }

  /**
   * 注册模块定义
   */
  async registerModuleDefinition(
    moduleDefinition: ModuleDefinition,
    source: ModuleId
  ): Promise<{ module_id: string; registered: true }> {
    return this.call(
      this.moduleManagerPort,
      'register_module_definition',
      { module_definition: moduleDefinition },
      source
    )
  }

  /**
   * 启动模块
   */
  async startModule(
    moduleId: string,
    source: ModuleId,
    entryOverride?: string,
    env?: Record<string, string>
  ): Promise<{ status: 'accepted'; tracking_id: string }> {
    return this.call(
      this.moduleManagerPort,
      'start_module',
      { module_id: moduleId, entry_override: entryOverride, env },
      source
    )
  }

  /**
   * 停止模块
   */
  async stopModule(
    moduleId: string,
    source: ModuleId
  ): Promise<{ status: 'accepted'; tracking_id: string }> {
    return this.call(
      this.moduleManagerPort,
      'stop_module',
      { module_id: moduleId },
      source
    )
  }

  /**
   * 注销模块定义
   */
  async unregisterModuleDefinition(
    moduleId: string,
    source: ModuleId
  ): Promise<{ module_id: string; unregistered: true }> {
    return this.call(
      this.moduleManagerPort,
      'unregister_module_definition',
      { module_id: moduleId },
      source
    )
  }
}

interface ModuleDefinition {
  module_id: string
  module_type: string
  entry: string
  cwd: string
  env?: Record<string, string>
  auto_start: boolean
  start_priority: number
}

interface ResolveParams {
  module_id?: ModuleId
  module_type?: string
}

// ============================================================================
// 模块基类
// ============================================================================

/**
 * Crabot 模块基类
 *
 * 所有模块都应该继承此类，它提供了：
 * - HTTP 服务器
 * - 请求信封解析和响应封装
 * - 健康检查端点
 * - Shutdown 端点
 * - 事件订阅/发布
 */
export abstract class ModuleBase {
  protected readonly config: ModuleConfig
  protected readonly rpcClient: RpcClient
  protected readonly methodHandlers: Map<string, MethodHandler> = new Map()
  protected readonly callbackHandlers: Map<string, CallbackHandler> = new Map()

  private server: http.Server | null = null
  private isShuttingDown = false

  constructor(config: ModuleConfig) {
    this.config = config
    this.rpcClient = new RpcClient()

    // 注册必需端点
    this.registerMethod('health', this.handleHealth.bind(this))
    this.registerMethod('shutdown', this.handleShutdown.bind(this))
    this.registerMethod('on_event', this.handleOnEvent.bind(this))
    this.registerMethod('callback', this.handleCallback.bind(this))
  }

  // ============================================================================
  // 公共方法
  // ============================================================================

  /**
   * 启动模块
   */
  async start(): Promise<void> {
    await this.onStart()

    this.server = http.createServer((req, res) => {
      this.handleRequest(req, res).catch((error) => {
        console.error('Unhandled error in request handler:', error)
        res.writeHead(500)
        res.end(JSON.stringify({ error: 'Internal server error' }))
      })
    })

    return new Promise((resolve, reject) => {
      this.server!.listen(this.config.port, () => {
        console.log(`[${this.config.moduleId}] Listening on port ${this.config.port}`)
        resolve()
      })

      this.server!.on('error', reject)
    })
  }

  /**
   * 停止模块
   */
  async stop(): Promise<void> {
    if (this.isShuttingDown) return
    this.isShuttingDown = true

    console.log(`[${this.config.moduleId}] Shutting down...`)

    await this.onStop()

    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server!.close(() => resolve())
      })
    }
  }

  /**
   * 向 Module Manager 注册
   */
  async register(): Promise<void> {
    const params: RegisterParams = {
      module_id: this.config.moduleId,
      module_type: this.config.moduleType,
      version: this.config.version,
      protocol_version: this.config.protocolVersion,
      port: this.config.port,
      subscriptions: this.config.subscriptions ?? [],
    }

    await this.rpcClient.callModuleManager('register', params, this.config.moduleId)
    console.log(`[${this.config.moduleId}] Registered to Module Manager`)
  }

  /**
   * 获取模块元数据
   */
  getMetadata(): ModuleMetadata {
    return {
      module_id: this.config.moduleId,
      module_type: this.config.moduleType,
      version: this.config.version,
      protocol_version: this.config.protocolVersion,
      host: 'localhost',
      port: this.config.port,
    }
  }

  /**
   * 注册方法处理器
   */
  protected registerMethod<P, R>(method: string, handler: MethodHandler<P, R>): void {
    this.methodHandlers.set(method, handler as MethodHandler)
  }

  /**
   * 注册回调处理器
   */
  protected registerCallback<P>(trackingId: string, handler: CallbackHandler<P>): void {
    this.callbackHandlers.set(trackingId, handler as CallbackHandler)
  }

  // ============================================================================
  // 子类可重写的方法
  // ============================================================================

  /**
   * 子类重写：启动时的初始化逻辑
   */
  protected async onStart(): Promise<void> {
    // 默认空实现，子类可重写
  }

  /**
   * 子类重写：停止时的清理逻辑
   */
  protected async onStop(): Promise<void> {
    // 默认空实现，子类可重写
  }

  /**
   * 子类重写：自定义健康检查逻辑
   */
  protected async getHealthDetails(): Promise<Record<string, unknown>> {
    return {}
  }

  /**
   * 子类重写：处理接收到的事件
   */
  protected async onEvent(_event: Event): Promise<void> {
    // 默认空实现，子类可重写
  }

  // ============================================================================
  // 内部方法
  // ============================================================================

  /**
   * 处理 HTTP 请求
   */
  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // 提取方法名（去掉开头的 /）
    const method = req.url?.slice(1) ?? ''

    if (req.method !== 'POST') {
      res.writeHead(405)
      res.end(JSON.stringify({ error: 'Method not allowed' }))
      return
    }

    // 读取请求体
    const body = await this.readBody(req)

    // 尝试解析为信封格式
    let request: Request | null = null
    try {
      request = JSON.parse(body) as Request
    } catch {
      // 如果不是信封格式，创建一个简单的请求
    }

    // 查找方法处理器
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
      // 提取参数
      const params = request?.params ?? this.parseQueryParams(req.url ?? '')

      // 调用处理器
      const result = await handler(params)

      // 如果是 AcceptedResponse，保持格式
      if (
        result &&
        typeof result === 'object' &&
        'status' in result &&
        result.status === 'accepted'
      ) {
        const response = {
          id: request?.id ?? generateId(),
          success: true,
          data: result,
          timestamp: generateTimestamp(),
        }
        res.writeHead(202, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(response))
        return
      }

      // 普通成功响应
      const response = createSuccessResponse(request?.id ?? generateId(), result)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(response))
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      const errorResponse = createErrorResponse(
        request?.id ?? generateId(),
        GlobalErrorCode.INTERNAL_ERROR,
        errorMessage
      )
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(errorResponse))
    }
  }

  /**
   * 读取请求体
   */
  private readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      let body = ''
      req.on('data', (chunk) => {
        body += chunk
      })
      req.on('end', () => resolve(body))
      req.on('error', reject)
    })
  }

  /**
   * 解析查询参数
   */
  private parseQueryParams(url: string): Record<string, string> {
    const params: Record<string, string> = {}
    const queryIndex = url.indexOf('?')
    if (queryIndex === -1) return params

    const query = url.slice(queryIndex + 1)
    for (const pair of query.split('&')) {
      const [key, value] = pair.split('=')
      if (key) {
        params[decodeURIComponent(key)] = decodeURIComponent(value ?? '')
      }
    }
    return params
  }

  // ============================================================================
  // 必需端点处理器
  // ============================================================================

  /**
   * 健康检查处理器
   */
  private async handleHealth(): Promise<HealthResult> {
    const details = await this.getHealthDetails()
    return {
      status: this.isShuttingDown ? 'degraded' : 'healthy',
      details,
    }
  }

  /**
   * Shutdown 处理器
   */
  private async handleShutdown(): Promise<Record<string, never>> {
    // 异步执行停止，不阻塞响应
    setTimeout(() => {
      this.stop().catch(console.error)
    }, 100)

    return {}
  }

  /**
   * 事件接收处理器
   */
  private async handleOnEvent(params: { event: Event }): Promise<{ received: true }> {
    // 异步处理事件，不阻塞响应
    setTimeout(() => {
      this.onEvent(params.event).catch((error) => {
        console.error(`[${this.config.moduleId}] Error handling event:`, error)
      })
    }, 0)

    return { received: true }
  }

  /**
   * 回调处理器
   */
  private async handleCallback(params: {
    tracking_id: string
    success: boolean
    data?: unknown
    error?: { code: string; message: string }
  }): Promise<{ received: true }> {
    const handler = this.callbackHandlers.get(params.tracking_id)
    if (handler) {
      this.callbackHandlers.delete(params.tracking_id)
      await handler(params)
    }
    return { received: true }
  }
}
