import type { LLMAdapter } from './llm-adapter'
import type { ToolDefinition, EngineTurnEvent, EngineResult, ContentBlock } from './types'
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
  readonly humanMessageQueue?: { readonly drainPending: () => Array<string | ContentBlock[]>; readonly hasPending: boolean }
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
  readonly supportsVision?: boolean
  readonly parentHumanQueue?: HumanMessageQueue
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
          onTurn: config.onSubAgentTurn,
          supportsVision: config.supportsVision,
          humanMessageQueue: childQueue,
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
      } finally {
        if (childQueue && config.parentHumanQueue) {
          config.parentHumanQueue.removeChild(childQueue)
        }
      }
    },
  }
}
