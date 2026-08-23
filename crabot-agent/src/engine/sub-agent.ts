import type { LLMAdapter } from './llm-adapter'
import type { ToolDefinition, EngineTurnEvent, EngineResult, ContentBlock, HumanMessageQueueLike, ToolPermissionConfig } from './types'
import type { ResolvedPermissions } from '../types'
import type { TraceStore } from '../core/trace-store'
import { runEngine } from './query-loop'

// --- Fork Engine ---

export interface ForkEngineParams {
  /** Task description for the sub-agent (string or content blocks with images) */
  readonly prompt: string | ReadonlyArray<ContentBlock>
  /** LLM adapter (can be same or different from parent) */
  readonly adapter: LLMAdapter
  /** Model to use (can be lighter model for cost savings) */
  readonly model: string
  /** System prompt for the sub-agent */
  readonly systemPrompt: string
  /** Tools available to the sub-agent (subset of parent's tools) */
  readonly tools: ReadonlyArray<ToolDefinition>
  /** Max turns for sub-agent (default: 20, lower than parent) */
  readonly maxTurns?: number
  /** Per-call max output tokens；缺省时让 adapter 走默认行为 */
  readonly maxTokens?: number
  /** Optional: parent context to share (recent messages summary) */
  readonly parentContext?: string
  /** Abort signal (linked to parent) */
  readonly abortSignal?: AbortSignal
  /** Callback for sub-agent turns */
  readonly onTurn?: (event: EngineTurnEvent) => void
  /** Whether the sub-agent's model supports vision (image inputs) */
  readonly supportsVision?: boolean
  /** 模型 context_window；当前 subagent disableCompaction=true 时不生效，仅为语义完整透传 */
  readonly contextWindowTokens?: number
  readonly humanMessageQueue?: HumanMessageQueueLike
  readonly hookRegistry?: import('../hooks/hook-registry').HookRegistry
  readonly lspManager?: import('../hooks/types').LspManagerLike
  /** 继承自父（Worker）的 permissionConfig；sub-agent 使用的工具子集仍需遵循相同权限策略 */
  readonly permissionConfig?: ToolPermissionConfig
  /** 继承自父 Worker 的权限快照，供 CLI permission gate 使用。 */
  readonly resolvedPermissions?: ResolvedPermissions
  /** 子 Agent 没有可验证的发起人身份，不能绕过 CLI permission gate。 */
  readonly senderIsMaster?: boolean
}

export interface ForkEngineResult {
  /** Sub-agent's final output text */
  readonly output: string
  /** Outcome */
  readonly outcome: EngineResult['outcome']
  /** Token usage */
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number }
  /** Number of turns used */
  readonly totalTurns: number
  /** Error message (when outcome is 'failed') */
  readonly error?: string
  /** 早退工具（exitsLoop=true）触发时的 tool name + input。
   *  例：goal_audit 路径 auditor 调 submit_audit_result 时，input 是
   *  schema-enforced 的 {pass, failed_criteria, evidence}，caller 直接拿
   *  结构化结果，不必 regex parse free text。 */
  readonly exitToolCall?: { readonly name: string; readonly input: Record<string, unknown> }
}

// 兜底值——subagent 都该在 builtin-subagents.ts 显式设 max_turns；这里只防"忘配"。
// 参考：Claude Code 的隐式 fork 是 200 turns，显式 subagent 默认无限制（靠 frontmatter）。
// Crabot 保持有上限（防失控），但提到 50 减少"忘配 + 触顶"事故。
const DEFAULT_SUB_AGENT_MAX_TURNS = 50

export async function forkEngine(params: ForkEngineParams): Promise<ForkEngineResult> {
  let prompt: string | ReadonlyArray<ContentBlock>
  if (params.parentContext) {
    if (typeof params.prompt === 'string') {
      prompt = `## Parent Context\n${params.parentContext}\n\n## Your Task\n${params.prompt}`
    } else {
      prompt = [
        { type: 'text' as const, text: `## Parent Context\n${params.parentContext}\n\n## Your Task\n` },
        ...params.prompt,
      ]
    }
  } else {
    prompt = params.prompt
  }

  const result = await runEngine({
    prompt: typeof prompt === 'string' ? prompt : [...prompt],
    adapter: params.adapter,
    options: {
      systemPrompt: params.systemPrompt,
      tools: [...params.tools],
      model: params.model,
      maxTurns: params.maxTurns ?? DEFAULT_SUB_AGENT_MAX_TURNS,
      ...(params.maxTokens !== undefined ? { maxTokens: params.maxTokens } : {}),
      abortSignal: params.abortSignal,
      onTurn: params.onTurn,
      supportsVision: params.supportsVision,
      ...(params.contextWindowTokens !== undefined ? { contextWindowTokens: params.contextWindowTokens } : {}),
      humanMessageQueue: params.humanMessageQueue,
      hookRegistry: params.hookRegistry,
      lspManager: params.lspManager,
      permissionConfig: params.permissionConfig,
      resolvedPermissions: params.resolvedPermissions,
      senderIsMaster: params.senderIsMaster,
      // subagent 内禁用 compaction：靠 maxTurns 控规模，避免父侧无感知的隐式压缩 +
      // 嵌套 LLM call。详见 EngineOptions.disableCompaction 注释。
      disableCompaction: true,
    },
  })

  return {
    output: result.finalText,
    outcome: result.outcome,
    usage: result.usage,
    totalTurns: result.totalTurns,
    error: result.error,
    ...(result.exitToolCall ? { exitToolCall: result.exitToolCall } : {}),
  }
}

// --- Sub-Agent Trace Config ---

export interface SubAgentTraceConfig {
  readonly traceStore: TraceStore
  readonly parentTraceId: string
  readonly parentSpanId?: string
  readonly relatedTaskId?: string
}
