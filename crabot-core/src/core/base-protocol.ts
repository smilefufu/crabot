/**
 * Base Protocol - Crabot 系统中所有模块共用的通信规范
 *
 * @see crabot-docs/protocols/base-protocol.md
 */

import { randomUUID } from 'node:crypto'

// ============================================================================
// 基础标识符类型
// ============================================================================

/** 模块实例唯一标识，如 "front-agent"、"channel-feishu" */
export type ModuleId = string

/** 熟人唯一标识，UUID v4 */
export type FriendId = string

/** 会话唯一标识，UUID v4 */
export type SessionId = string

/** 任务唯一标识，UUID v4 */
export type TaskId = string

/** 记忆条目唯一标识，UUID v4 */
export type MemoryId = string

/** 调度项唯一标识，UUID v4 */
export type ScheduleId = string

// ============================================================================
// 模块状态
// ============================================================================

export type ModuleStatus = 'starting' | 'running' | 'stopping' | 'stopped' | 'error'

export type HealthStatus = 'healthy' | 'degraded' | 'unhealthy'

// ============================================================================
// 请求/响应信封
// ============================================================================

/**
 * 统一的请求信封
 */
export interface Request<P = unknown> {
  /** 请求唯一标识，UUID v4 */
  id: string
  /** 发起请求的模块实例 ID */
  source: ModuleId
  /** 接口方法名 */
  method: string
  /** 方法参数 */
  params: P
  /** 请求发起时间，ISO 8601 */
  timestamp: string
}

/**
 * 同步响应信封
 */
export interface Response<D = unknown> {
  /** 对应请求的 id */
  id: string
  /** 是否成功 */
  success: boolean
  /** 成功时的返回数据 */
  data?: D
  /** 失败时的错误信息 */
  error?: ErrorDetail
  /** 响应时间，ISO 8601 */
  timestamp: string
}

/**
 * 异步接受响应
 */
export interface AcceptedResponse {
  id: string
  success: true
  data: {
    status: 'accepted'
    /** 可用于查询进度的追踪 ID */
    tracking_id: string
  }
  timestamp: string
}

/**
 * 异步完成回调，发送到请求方的 /callback 端点
 */
export interface CallbackPayload<D = unknown> {
  /** 对应的 tracking_id */
  tracking_id: string
  /** 原始请求 id */
  request_id: string
  /** 是否成功 */
  success: boolean
  data?: D
  error?: ErrorDetail
  timestamp: string
}

// ============================================================================
// 错误码体系
// ============================================================================

/**
 * 错误详情
 */
export interface ErrorDetail {
  /** 错误码 */
  code: string
  /** 人类可读的错误描述 */
  message: string
  /** 可选的补充数据 */
  details?: Record<string, unknown>
}

/** 全局错误码 */
export const GlobalErrorCode = {
  INVALID_REQUEST: 'INVALID_REQUEST',
  INVALID_PARAMS: 'INVALID_PARAMS',
  METHOD_NOT_FOUND: 'METHOD_NOT_FOUND',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
  TIMEOUT: 'TIMEOUT',
} as const

// ============================================================================
// 事件机制
// ============================================================================

/**
 * 事件结构
 */
export interface Event<P = unknown> {
  /** 事件唯一标识，UUID v4 */
  id: string
  /** 事件类型 */
  type: string
  /** 发布者模块实例 ID */
  source: ModuleId
  /** 事件数据 */
  payload: P
  /** 事件发生时间，ISO 8601 */
  timestamp: string
}

/**
 * 事件订阅参数
 */
export interface SubscribeParams {
  /** 订阅者模块实例 ID */
  subscriber: ModuleId
  /** 要订阅的事件类型列表，支持通配符如 "taskstore.*" */
  event_types: string[]
}

/**
 * 事件发布参数
 */
export interface PublishEventParams {
  event: Event
}

// ============================================================================
// 服务发现
// ============================================================================

/**
 * 服务发现请求参数
 */
export interface ResolveParams {
  /** 按模块实例 ID 查找 */
  module_id?: ModuleId
  /** 按模块类型查找（返回该类型所有运行中的实例） */
  module_type?: string
}

/**
 * 解析到的模块信息
 */
export interface ResolvedModule {
  module_id: ModuleId
  module_type: string
  host: string // 始终为 "localhost"
  port: number
  status: ModuleStatus
}

/**
 * 服务发现结果
 */
export interface ResolveResult {
  modules: ResolvedModule[]
}

// ============================================================================
// 健康检查
// ============================================================================

/**
 * 健康检查结果
 */
export interface HealthResult {
  status: HealthStatus
  /** 模块自定义的附加信息 */
  details?: Record<string, unknown>
}

// ============================================================================
// 模块定义
// ============================================================================

/**
 * 模块定义（用于 Module Manager 配置）
 */
export interface ModuleDefinition {
  module_id: ModuleId
  module_type: string
  /** 启动命令 */
  entry: string
  /** 模块工作目录 */
  cwd?: string
  /** 环境变量 */
  env?: Record<string, string>
  /** 是否随 Module Manager 启动时自动启动，默认 true */
  auto_start: boolean
  /** 启动顺序优先级，数字越小越先启动，默认 100 */
  start_priority: number
  /** 跳过健康检查和注册（用于不实现 Crabot 协议的工具进程，如 Vite） */
  skip_health_check?: boolean
}

/**
 * 模块运行时信息
 */
export interface ModuleInfo {
  module_id: ModuleId
  module_type: string
  version: string
  protocol_version: string
  host: string
  port: number
  status: ModuleStatus
  /** 进程 PID（运行中时） */
  pid?: number
  /** 模块注册时间 */
  registered_at?: string
  /** 最后一次健康检查时间 */
  last_health_check?: string
  /** 最后一次健康检查结果 */
  last_health_status?: HealthStatus
}

/**
 * 模块注册参数
 */
export interface RegisterParams {
  /** 模块实例唯一标识 */
  module_id: ModuleId
  /** 模块类型 */
  module_type: string
  /** 模块版本号 */
  version: string
  /** 遵循的协议版本 */
  protocol_version: string
  /** 模块监听的端口（由 Module Manager 预先分配） */
  port: number
  /** 模块需要订阅的事件类型列表 */
  subscriptions?: string[]
}

// ============================================================================
// 分页
// ============================================================================

export interface PaginationParams {
  /** 页码，从 1 开始 */
  page: number
  /** 每页数量，默认 20，最大 100 */
  page_size: number
}

export interface PaginatedResult<T> {
  items: T[]
  pagination: {
    page: number
    page_size: number
    total_items: number
    total_pages: number
  }
}

// ============================================================================
// 工具函数
// ============================================================================

/**
 * 生成 UUID v4
 */
export function generateId(): string {
  return randomUUID()
}

/**
 * 生成当前时间戳 (ISO 8601)
 */
export function generateTimestamp(): string {
  return new Date().toISOString()
}

/**
 * 创建成功响应
 */
export function createSuccessResponse<D>(id: string, data: D): Response<D> {
  return {
    id,
    success: true,
    data,
    timestamp: generateTimestamp(),
  }
}

/**
 * 创建错误响应
 */
export function createErrorResponse(
  id: string,
  code: string,
  message: string,
  details?: Record<string, unknown>
): Response<never> {
  const error: ErrorDetail = { code, message }
  if (details !== undefined) {
    error.details = details
  }
  return {
    id,
    success: false,
    error,
    timestamp: generateTimestamp(),
  }
}

/**
 * 创建接受响应（异步模式）
 */
export function createAcceptedResponse(id: string, trackingId: string): AcceptedResponse {
  return {
    id,
    success: true,
    data: {
      status: 'accepted',
      tracking_id: trackingId,
    },
    timestamp: generateTimestamp(),
  }
}

/**
 * 创建事件
 */
export function createEvent<P>(type: string, source: ModuleId, payload: P): Event<P> {
  return {
    id: generateId(),
    type,
    source,
    payload,
    timestamp: generateTimestamp(),
  }
}
