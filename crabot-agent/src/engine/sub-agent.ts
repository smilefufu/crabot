import type { LLMAdapter } from './llm-adapter'
import type { ToolDefinition, EngineTurnEvent, EngineResult, ContentBlock, HumanMessageQueueLike, ToolPermissionConfig } from './types'
import type { AgentTrace } from '../types'
import type { TraceStore } from '../core/trace-store'
import { runEngine } from './query-loop'
import { resolveImageFromPaths } from '../agent/media-resolver'
import { formatSupplementForSubAgent } from '../agent/subagent-prompts'
import { HumanMessageQueue } from './human-message-queue'

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
  /** Optional: parent context to share (recent messages summary) */
  readonly parentContext?: string
  /** Abort signal (linked to parent) */
  readonly abortSignal?: AbortSignal
  /** Callback for sub-agent turns */
  readonly onTurn?: (event: EngineTurnEvent) => void
  /** Whether the sub-agent's model supports vision (image inputs) */
  readonly supportsVision?: boolean
  readonly humanMessageQueue?: HumanMessageQueueLike
  readonly hookRegistry?: import('../hooks/hook-registry').HookRegistry
  readonly lspManager?: import('../hooks/types').LspManagerLike
  /** 继承自父（Worker）的 permissionConfig；sub-agent 使用的工具子集仍需遵循相同权限策略 */
  readonly permissionConfig?: ToolPermissionConfig
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
}

const DEFAULT_SUB_AGENT_MAX_TURNS = 20

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
      abortSignal: params.abortSignal,
      onTurn: params.onTurn,
      supportsVision: params.supportsVision,
      humanMessageQueue: params.humanMessageQueue,
      hookRegistry: params.hookRegistry,
      lspManager: params.lspManager,
      permissionConfig: params.permissionConfig,
    },
  })

  return {
    output: result.finalText,
    outcome: result.outcome,
    usage: result.usage,
    totalTurns: result.totalTurns,
    error: result.error,
  }
}

// --- Sub-Agent Trace Config ---

export interface SubAgentTraceConfig {
  readonly traceStore: TraceStore
  readonly parentTraceId: string
  readonly parentSpanId?: string
  readonly relatedTaskId?: string
}

// --- Sub-Agent Tool ---

export interface SubAgentToolConfig {
  /** Tool name (e.g., 'research_agent', 'code_review_agent') */
  readonly name: string
  readonly description: string
  readonly adapter: LLMAdapter
  readonly model: string
  readonly systemPrompt: string
  /** Tools available to the sub-agent */
  readonly subTools: ReadonlyArray<ToolDefinition>
  readonly maxTurns?: number
  readonly supportsVision?: boolean
  readonly parentHumanQueue?: HumanMessageQueue
  readonly traceConfig?: SubAgentTraceConfig
  readonly hookRegistry?: import('../hooks/hook-registry').HookRegistry
  readonly lspManager?: import('../hooks/types').LspManagerLike
  /** 从父 Worker 继承的 permissionConfig；sub-agent 的工具执行也需遵守同一 session 的权限策略 */
  readonly permissionConfig?: ToolPermissionConfig
}

export function createSubAgentTool(config: SubAgentToolConfig): ToolDefinition {
  const properties: Record<string, unknown> = {
    task: { type: 'string', description: 'Task description for the sub-agent' },
    context: { type: 'string', description: 'Optional parent context to share with the sub-agent' },
  }
  if (config.supportsVision) {
    properties.image_paths = {
      type: 'array',
      items: { type: 'string' },
      description: 'Local file paths of images to pass to the sub-agent for visual analysis',
    }
  }

  return {
    name: config.name,
    description: config.description,
    isReadOnly: true,
    inputSchema: {
      type: 'object',
      properties,
      required: ['task'],
    },
    call: async (input, callContext) => {
      let childQueue: HumanMessageQueue | undefined
      if (config.parentHumanQueue) {
        childQueue = config.parentHumanQueue.createChild((content) => {
          const text = typeof content === 'string' ? content : '[多媒体纠偏消息]'
          return formatSupplementForSubAgent(text)
        })
      }

      // Create sub-agent independent trace
      const tc = config.traceConfig
      let subTrace: AgentTrace | undefined
      let subTraceCallback: ((event: EngineTurnEvent) => void) | undefined

      if (tc) {
        subTrace = tc.traceStore.startTrace({
          module_id: 'sub-agent',
          trigger: {
            type: 'sub_agent_call',
            summary: String(input.task).slice(0, 200),
          },
          parent_trace_id: tc.parentTraceId,
          parent_span_id: tc.parentSpanId,
          related_task_id: tc.relatedTaskId,
        })

        // onTurn fires post-hoc (after LLM + tools), so back-date span timestamps
        // with engine-measured ms to keep the waterfall accurate.
        subTraceCallback = (event: EngineTurnEvent) => {
          const llmEndedAtMs = event.llmStartedAtMs !== undefined && event.llmCallMs !== undefined
            ? event.llmStartedAtMs + event.llmCallMs
            : undefined

          const llmSpan = tc.traceStore.startSpan(subTrace!.trace_id, {
            type: 'llm_call',
            details: {
              iteration: event.turnNumber,
              input_summary: `turn ${event.turnNumber}`,
            },
            ...(event.llmStartedAtMs !== undefined ? { started_at_ms: event.llmStartedAtMs } : {}),
          })

          for (const toolCall of event.toolCalls) {
            const toolEndedAtMs = toolCall.startedAtMs !== undefined && toolCall.durationMs !== undefined
              ? toolCall.startedAtMs + toolCall.durationMs
              : undefined

            const toolSpan = tc.traceStore.startSpan(subTrace!.trace_id, {
              type: 'tool_call',
              parent_span_id: llmSpan.span_id,
              details: {
                tool_name: toolCall.name,
                input_summary: JSON.stringify(toolCall.input ?? {}).slice(0, 200),
              },
              ...(toolCall.startedAtMs !== undefined ? { started_at_ms: toolCall.startedAtMs } : {}),
            })
            tc.traceStore.endSpan(
              subTrace!.trace_id,
              toolSpan.span_id,
              toolCall.isError ? 'failed' : 'completed',
              {
                output_summary: String(toolCall.output).slice(0, 500),
                error: toolCall.isError ? String(toolCall.output) : undefined,
              },
              toolEndedAtMs,
            )
          }

          tc.traceStore.endSpan(
            subTrace!.trace_id,
            llmSpan.span_id,
            'completed',
            {
              stop_reason: event.stopReason ?? undefined,
              output_summary: event.assistantText.slice(0, 200) || undefined,
              tool_calls_count: event.toolCalls.length > 0 ? event.toolCalls.length : undefined,
            },
            llmEndedAtMs,
          )
        }
      }

      try {
        let prompt: string | ReadonlyArray<ContentBlock> = String(input.task)
        const imagePaths = input.image_paths as string[] | undefined
        if (config.supportsVision && imagePaths?.length) {
          const imageBlocks = await resolveImageFromPaths(imagePaths)
          if (imageBlocks.length > 0) {
            prompt = [
              { type: 'text' as const, text: String(input.task) },
              ...imageBlocks,
            ]
          }
        }

        const result = await forkEngine({
          prompt,
          adapter: config.adapter,
          model: config.model,
          systemPrompt: config.systemPrompt,
          tools: config.subTools,
          maxTurns: config.maxTurns,
          parentContext: input.context !== undefined ? String(input.context) : undefined,
          abortSignal: callContext.abortSignal,
          onTurn: subTraceCallback,
          supportsVision: config.supportsVision,
          humanMessageQueue: childQueue,
          hookRegistry: config.hookRegistry,
          lspManager: config.lspManager,
          permissionConfig: config.permissionConfig,
        })

        if (subTrace && tc) {
          const traceSummary = result.output.slice(0, 200) || result.error?.slice(0, 200) || ''
          tc.traceStore.endTrace(subTrace.trace_id, result.outcome === 'failed' ? 'failed' : 'completed', {
            summary: traceSummary,
            error: result.outcome === 'failed' ? (result.error?.slice(0, 200) || result.output.slice(0, 200)) : undefined,
          })
        }

        return {
          output: JSON.stringify({
            output: result.output,
            outcome: result.outcome,
            totalTurns: result.totalTurns,
            child_trace_id: subTrace?.trace_id,
          }),
          isError: result.outcome === 'failed',
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (subTrace && tc) {
          tc.traceStore.endTrace(subTrace.trace_id, 'failed', { summary: message, error: message })
        }
        return {
          output: `Sub-agent error: ${message}`,
          isError: true,
        }
      } finally {
        if (childQueue && config.parentHumanQueue) {
          config.parentHumanQueue.removeChild(childQueue)
        }
      }
    },
  }
}
