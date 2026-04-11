/**
 * Module Manager - 模块生命周期管理
 *
 * @see crabot-docs/protocols/protocol-module-manager.md
 */

import {
  type ModuleId,
  type ModuleStatus,
  type HealthStatus,
  type ModuleDefinition,
  type ModuleInfo,
  type ResolvedModule,
  type Event,
  createEvent,
} from 'crabot-shared'

// ============================================================================
// 端口分配
// ============================================================================

export interface PortAllocation {
  /** 端口范围起始值 */
  range_start: number // 默认 19001
  /** 端口范围结束值 */
  range_end: number // 默认 19999
}

// ============================================================================
// 模块运行时状态
// ============================================================================

/**
 * 模块运行时状态（扩展 ModuleDefinition）
 */
export interface ModuleRuntime extends ModuleDefinition {
  /** 模块状态 */
  status: ModuleStatus
  /** 分配的端口 */
  port: number
  /** 进程 PID（运行中时） */
  pid?: number
  /** 模块版本（从注册信息获取） */
  version?: string
  /** 协议版本（从注册信息获取） */
  protocol_version?: string
  /** 注册时间 */
  registered_at?: string
  /** 最后一次健康检查时间 */
  last_health_check?: string
  /** 最后一次健康检查结果 */
  last_health_status?: HealthStatus
  /** 健康检查连续失败次数 */
  health_check_failures?: number
  /** 是否为动态安装的模块 */
  is_installed?: boolean
  /** 安装来源 */
  install_source?: string
  /** 安装时间 */
  installed_at?: string
}

// ============================================================================
// 配置
// ============================================================================

export interface ModuleManagerConfig {
  /** 监听端口，固定 19000 */
  port: number
  /** 端口分配范围 */
  port_range: PortAllocation
  /** 健康检查间隔（秒），默认 30 */
  health_check_interval: number
  /** 健康检查超时（秒），默认 5 */
  health_check_timeout: number
  /** 连续失败多少次标记为 error，默认 3 */
  health_check_failure_threshold: number
  /** 模块优雅关闭超时（秒），默认 30 */
  shutdown_timeout: number
  /** 支持热插拔的模块类型列表 */
  hotplug_allowed_types: string[]
  /** 启动时加载的内置模块列表 */
  modules: ModuleDefinition[]
}

export const DEFAULT_CONFIG: ModuleManagerConfig = {
  port: 19000,
  port_range: {
    range_start: 19001,
    range_end: 19999,
  },
  health_check_interval: 30,
  health_check_timeout: 5,
  health_check_failure_threshold: 3,
  shutdown_timeout: 30,
  hotplug_allowed_types: ['agent', 'channel', 'memory'],
  modules: [],
}

// ============================================================================
// 事件 Payload 类型
// ============================================================================

export interface ModuleStartedPayload {
  module_id: ModuleId
  module_type: string
  port: number
}

export interface ModuleStoppedPayload {
  module_id: ModuleId
  module_type: string
  reason: ModuleStopReason
}

export interface ModuleErrorPayload {
  module_id: ModuleId
  module_type: string
  error: string
}

export interface ModuleHealthChangedPayload {
  module_id: ModuleId
  previous: HealthStatus
  current: HealthStatus
}

export interface ModuleDefinitionRegisteredPayload {
  module_id: ModuleId
  module_type: string
  is_installed: boolean
}

export interface ModuleDefinitionUnregisteredPayload {
  module_id: ModuleId
  module_type: string
}

/**
 * 模块停止原因
 */
export type ModuleStopReason =
  | 'shutdown' // 正常停止（收到 shutdown 指令后优雅退出）
  | 'crashed' // 进程意外退出（非零退出码或信号终止）
  | 'health_check_failed' // 连续健康检查失败后被 Module Manager 终止
  | 'forced' // 被 Admin 强制终止（force: true）

// ============================================================================
// 事件类型常量
// ============================================================================

export const ModuleManagerEventType = {
  MODULE_STARTED: 'module_manager.module_started',
  MODULE_STOPPED: 'module_manager.module_stopped',
  MODULE_ERROR: 'module_manager.module_error',
  MODULE_HEALTH_CHANGED: 'module_manager.module_health_changed',
  MODULE_DEFINITION_REGISTERED: 'module_manager.module_definition_registered',
  MODULE_DEFINITION_UNREGISTERED: 'module_manager.module_definition_unregistered',
} as const

// ============================================================================
// 事件创建函数
// ============================================================================

export function createModuleStartedEvent(
  source: ModuleId,
  payload: ModuleStartedPayload
): Event<ModuleStartedPayload> {
  return createEvent(ModuleManagerEventType.MODULE_STARTED, source, payload)
}

export function createModuleStoppedEvent(
  source: ModuleId,
  payload: ModuleStoppedPayload
): Event<ModuleStoppedPayload> {
  return createEvent(ModuleManagerEventType.MODULE_STOPPED, source, payload)
}

export function createModuleErrorEvent(
  source: ModuleId,
  payload: ModuleErrorPayload
): Event<ModuleErrorPayload> {
  return createEvent(ModuleManagerEventType.MODULE_ERROR, source, payload)
}

export function createModuleHealthChangedEvent(
  source: ModuleId,
  payload: ModuleHealthChangedPayload
): Event<ModuleHealthChangedPayload> {
  return createEvent(ModuleManagerEventType.MODULE_HEALTH_CHANGED, source, payload)
}

export function createModuleDefinitionRegisteredEvent(
  source: ModuleId,
  payload: ModuleDefinitionRegisteredPayload
): Event<ModuleDefinitionRegisteredPayload> {
  return createEvent(ModuleManagerEventType.MODULE_DEFINITION_REGISTERED, source, payload)
}

export function createModuleDefinitionUnregisteredEvent(
  source: ModuleId,
  payload: ModuleDefinitionUnregisteredPayload
): Event<ModuleDefinitionUnregisteredPayload> {
  return createEvent(ModuleManagerEventType.MODULE_DEFINITION_UNREGISTERED, source, payload)
}

// ============================================================================
// 辅助函数
// ============================================================================

/**
 * 将 ModuleRuntime 转换为 ModuleInfo
 */
export function runtimeToInfo(runtime: ModuleRuntime): ModuleInfo {
  return {
    module_id: runtime.module_id,
    module_type: runtime.module_type,
    version: runtime.version ?? 'unknown',
    protocol_version: runtime.protocol_version ?? 'unknown',
    host: 'localhost',
    port: runtime.port,
    status: runtime.status,
    pid: runtime.pid,
    registered_at: runtime.registered_at,
    last_health_check: runtime.last_health_check,
    last_health_status: runtime.last_health_status,
  }
}

/**
 * 将 ModuleRuntime 转换为 ResolvedModule
 */
export function runtimeToResolved(runtime: ModuleRuntime): ResolvedModule {
  return {
    module_id: runtime.module_id,
    module_type: runtime.module_type,
    host: 'localhost',
    port: runtime.port,
    status: runtime.status,
  }
}
