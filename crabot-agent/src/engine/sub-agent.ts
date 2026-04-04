import type { LLMAdapter } from './llm-adapter'
import type { ToolDefinition, EngineTurnEvent, EngineResult } from './types'
import { runEngine } from './query-loop'

// --- Fork Engine ---

export interface ForkEngineParams {
  /** Task description for the sub-agent */
  readonly prompt: string
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
}

const DEFAULT_SUB_AGENT_MAX_TURNS = 20

export async function forkEngine(params: ForkEngineParams): Promise<ForkEngineResult> {
  const fullPrompt = params.parentContext
    ? `## Parent Context\n${params.parentContext}\n\n## Your Task\n${params.prompt}`
    : params.prompt

  const result = await runEngine({
    prompt: fullPrompt,
    adapter: params.adapter,
    options: {
      systemPrompt: params.systemPrompt,
      tools: [...params.tools],
      model: params.model,
      maxTurns: params.maxTurns ?? DEFAULT_SUB_AGENT_MAX_TURNS,
      abortSignal: params.abortSignal,
      onTurn: params.onTurn,
    },
  })

  return {
    output: result.finalText,
    outcome: result.outcome,
    usage: result.usage,
    totalTurns: result.totalTurns,
  }
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
  readonly onSubAgentTurn?: (event: EngineTurnEvent) => void
}

export function createSubAgentTool(config: SubAgentToolConfig): ToolDefinition {
  return {
    name: config.name,
    description: config.description,
    isReadOnly: true,
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'Task description for the sub-agent' },
        context: { type: 'string', description: 'Optional parent context to share with the sub-agent' },
      },
      required: ['task'],
    },
    call: async (input, callContext) => {
      try {
        const result = await forkEngine({
          prompt: String(input.task),
          adapter: config.adapter,
          model: config.model,
          systemPrompt: config.systemPrompt,
          tools: config.subTools,
          maxTurns: config.maxTurns,
          parentContext: input.context !== undefined ? String(input.context) : undefined,
          abortSignal: callContext.abortSignal,
          onTurn: config.onSubAgentTurn,
        })

        return {
          output: JSON.stringify({
            output: result.output,
            outcome: result.outcome,
            totalTurns: result.totalTurns,
          }),
          isError: result.outcome === 'failed',
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return {
          output: `Sub-agent error: ${message}`,
          isError: true,
        }
      }
    },
  }
}
