// crabot-shared/src/index.ts
export {
  // Types
  type ModuleId,
  type FriendId,
  type SessionId,
  type TaskId,
  type MemoryId,
  type ScheduleId,
  type ModuleStatus,
  type HealthStatus,
  type Request,
  type Response,
  type AcceptedResponse,
  type CallbackPayload,
  type ErrorDetail,
  type Event,
  type SubscribeParams,
  type PublishEventParams,
  type ResolveParams,
  type ResolvedModule,
  type ResolveResult,
  type HealthResult,
  type ModuleDefinition,
  type ModuleInfo,
  type RegisterParams,
  type PaginationParams,
  type PaginatedResult,
  type ProxyConfig,
  // Constants
  GlobalErrorCode,
  // Functions
  generateId,
  generateTimestamp,
  createSuccessResponse,
  createErrorResponse,
  createAcceptedResponse,
  createEvent,
} from './base-protocol.js'

export {
  ModuleBase,
  RpcClient,
  type ModuleConfig,
  type ModuleMetadata,
  type RpcTraceContext,
  type TraceStoreInterface,
} from './module-base.js'

export { ProxyManager, proxyManager } from './proxy-manager.js'

export { CLI_WRITE_SUBCOMMANDS, CLI_MUST_CONFIRM_SUBCOMMANDS } from './cli-write-commands.js'
