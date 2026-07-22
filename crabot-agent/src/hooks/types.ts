import type { ResolvedPermissions } from '../types.js'
import type { ReviewResult } from '../agent/cli-content-reviewer.js'

export type HookEvent = 'PreToolUse' | 'PostToolUse' | 'Stop'

export interface HookDefinition {
  readonly event: HookEvent
  readonly matcher?: string
  readonly if?: string
  readonly type: 'command' | 'prompt'
  readonly command?: string
  readonly prompt?: string
  readonly timeout?: number
  readonly model?: string
}

export interface HookInput {
  readonly event: HookEvent
  readonly toolName?: string
  readonly filePaths?: ReadonlyArray<string>
  readonly toolInput?: Record<string, unknown>
  readonly toolOutput?: string
  readonly workingDirectory?: string
}

export interface HookResult {
  readonly action: 'continue' | 'block'
  readonly message?: string
  readonly modifiedInput?: Record<string, unknown>
}

export interface FormattedDiagnostic {
  readonly filePath: string
  readonly line: number
  readonly column: number
  readonly severity: 'error' | 'warning' | 'info' | 'hint'
  readonly message: string
  readonly source: string
}

export interface LspManagerLike {
  notifyFileChanged(filePath: string, content: string): void
  getDiagnostics(filePath: string): Promise<ReadonlyArray<FormattedDiagnostic>>
}

export type ContentReviewer = (params: {
  readonly effectivePermissions: ResolvedPermissions
  readonly commandText: string
}) => Promise<ReviewResult>

export interface InternalHandlerContext {
  readonly workingDirectory: string
  readonly lspManager?: LspManagerLike
  /** 当前消息发起人是否 master（master 短路免审核） */
  readonly senderIsMaster?: boolean
  /** 发起人 effective permissions（friend ∪ session）——静态兜底值 */
  readonly resolvedPermissions?: ResolvedPermissions
  /**
   * 任务权限活值 getter（存在时优先于 resolvedPermissions）。
   * 由 worker loop 注入，读 taskState 持有者——supplement/resume 刷新后下一轮 hook 即生效
   * （spec: 2026-07-20-task-permission-hot-refresh-design.md）。
   */
  readonly getResolvedPermissions?: () => ResolvedPermissions | undefined
  /** 内容审核器（schedule add 等需要审核的命令使用） */
  readonly contentReviewer?: ContentReviewer
  /** 当前会话场景，用于拒绝指引文案区分群/私聊 */
  readonly sessionType?: 'private' | 'group'
}

export type InternalHandler = (
  input: HookInput,
  context: InternalHandlerContext,
) => Promise<HookResult>

export interface HookExecutorContext {
  readonly workingDirectory: string
  readonly lspManager?: LspManagerLike
  readonly adapter?: import('../engine/llm-adapter-types.js').LLMAdapter
  readonly model?: string
  /** ↓ Task 8 新增：CLI 权限闸需要的上下文 */
  readonly senderIsMaster?: boolean
  readonly resolvedPermissions?: ResolvedPermissions
  /** 任务权限活值 getter（存在时优先于 resolvedPermissions；spec: 2026-07-20-task-permission-hot-refresh-design.md） */
  readonly getResolvedPermissions?: () => ResolvedPermissions | undefined
  readonly contentReviewer?: ContentReviewer
  /** 当前会话场景，用于拒绝指引文案区分群/私聊 */
  readonly sessionType?: 'private' | 'group'
}
