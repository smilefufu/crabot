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

export { canonicalizeJson, sha256CanonicalJson } from './canonical-json.js'

export {
  ModuleBase,
  RpcClient,
  RpcError,
  RpcCallError,
  type ModuleConfig,
  type ModuleMetadata,
  type RpcTraceContext,
  type RpcHandlerContext,
  type SensitiveRpcTransportOptions,
  type SensitiveRpcMethod,
  isSensitiveRpcCall,
  type TraceStoreInterface,
} from './module-base.js'

export { ProxyManager, proxyManager } from './proxy-manager.js'

export { SYSTEM_SESSION, SYSTEM_SESSION_ID, SYSTEM_CHANNEL_ID } from './system-session.js'

export { CLI_WRITE_SUBCOMMANDS, CLI_MUST_CONFIRM_SUBCOMMANDS } from './cli-write-commands.js'

export {
  classifyCliSubcommand,
  REQUIRES_CONTENT_REVIEW,
  type CliKind,
  type CliClassification,
  type CliDomain,
} from './cli-domains.js'

export {
  CLAIM_COMMANDS,
  CLAIM_PAIR_COMMANDS,
  UNCLAIMED_HINT_TEXT,
  ALREADY_CLAIMED_HINT_TEXT,
  LEGACY_UNCLAIMED_HINT_TEXT,
  LEGACY_ALREADY_CLAIMED_HINT_TEXT,
  GOAL_SHOW_PREFIX,
  GOAL_CLEAR_PREFIX,
  GOAL_LIST_EXACT,
  GOAL_SHOW_BARE,
  GOAL_CLEAR_BARE,
  normalizeSlash,
  isClaimCommand,
  isClaimSystemHint,
  isSlashSystemResponse,
  isLegacyUnclaimedHint,
  isLegacyAlreadyClaimedHint,
} from './slash-commands.js'

export {
  type Onboarder,
  type OnboarderEvent,
  type OnboarderBeginResult,
  type OnboarderFinishResult,
  type OnboarderFactory,
} from './onboarder.js'

export {
  type MarkdownFormat,
  type TelegramParseMode,
  MARKDOWN_FORMAT_VALUES,
  parseMarkdownFormat,
  decideMarkdownEnabled,
  hasMarkdownMarkers,
  markdownToTelegramHtml,
} from './markdown.js'

export * from './media-fetch/index.js'

export { INSTANCE_ID_REGEX, validateInstanceId, type InstanceIdResult } from './instance-id.js'
