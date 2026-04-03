import type { LLMAdapter } from './llm-adapter'
import type {
  EngineMessage,
  EngineOptions,
  EngineResult,
  EngineTurnEvent,
  StreamChunk,
  TextBlock,
  ToolUseBlock,
} from './types'
import {
  createUserMessage,
  createAssistantMessage,
  createToolResultMessage,
} from './types'
import { StreamProcessor } from './stream-processor'
import { ContextManager } from './context-manager'
import { partitionToolCalls } from './tool-framework'
import { executeToolBatches } from './tool-orchestration'

// --- Public Interface ---

export interface RunEngineParams {
  readonly prompt: string
  readonly adapter: LLMAdapter
  readonly options: EngineOptions
}

const DEFAULT_MAX_TURNS = 10
const DEFAULT_MAX_CONTEXT_TOKENS = 100_000

// --- Core Loop ---

export async function runEngine(params: RunEngineParams): Promise<EngineResult> {
  const { prompt, adapter, options } = params
  const maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS
  const abortSignal = options.abortSignal

  const messages: EngineMessage[] = [createUserMessage(prompt)]
  const processor = new StreamProcessor()
  const contextManager = new ContextManager({
    maxContextTokens: DEFAULT_MAX_CONTEXT_TOKENS,
  })

  let totalTurns = 0
  let finalText = ''

  for (let turn = 0; turn < maxTurns; turn++) {
    // Check abort before starting a turn
    if (abortSignal?.aborted) {
      return buildResult('aborted', finalText, totalTurns, contextManager)
    }

    // Check if context compaction is needed
    if (contextManager.shouldCompact(messages)) {
      const compacted = await contextManager.compactWithLLM(messages, adapter, options.model)
      messages.length = 0
      for (const msg of compacted) {
        messages.push(msg)
      }
    }

    processor.reset()

    // Stream from LLM
    let abortedDuringStream = false
    let streamError: string | undefined

    try {
      const stream = adapter.stream({
        messages,
        systemPrompt: options.systemPrompt,
        tools: [...options.tools],
        model: options.model,
        maxTokens: options.maxTokens,
        signal: abortSignal,
      })

      for await (const chunk of stream) {
        // Check abort during streaming
        if (abortSignal?.aborted) {
          abortedDuringStream = true
          break
        }

        // Handle error chunks
        if (chunk.type === 'error') {
          streamError = chunk.error
          break
        }

        processor.process(chunk)

        // Forward text deltas to callback
        if (chunk.type === 'text_delta' && options.onTextDelta) {
          options.onTextDelta(chunk.text)
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return buildResult('failed', finalText, totalTurns, contextManager, message)
    }

    if (abortedDuringStream) {
      return buildResult('aborted', finalText, totalTurns, contextManager)
    }

    if (streamError !== undefined) {
      return buildResult('failed', finalText, totalTurns, contextManager, streamError)
    }

    // Finalize the processed stream
    const processed = processor.finalize()
    totalTurns++

    // Update usage tracking
    if (processed.usage) {
      contextManager.updateFromUsage(processed.usage)
    }

    // Build assistant message content blocks
    const contentBlocks = buildAssistantContent(processed.text, processed.toolUseBlocks)
    const stopReason = normalizeStopReason(processed.stopReason)

    const assistantMessage = createAssistantMessage(contentBlocks, stopReason, processed.usage)
    messages.push(assistantMessage)

    finalText = processed.text

    // If no tool use, we're done
    if (stopReason !== 'tool_use') {
      return buildResult('completed', finalText, totalTurns, contextManager)
    }

    // Execute tools
    const batches = partitionToolCalls(processed.toolUseBlocks, options.tools)
    const toolResults = await executeToolBatches(batches, options.tools, {
      abortSignal,
    })

    // Fire onTurn callback
    if (options.onTurn) {
      const turnEvent: EngineTurnEvent = {
        turnNumber: totalTurns,
        assistantText: processed.text,
        toolCalls: processed.toolUseBlocks.map((b) => ({
          id: b.id,
          name: b.name,
          input: b.input,
        })),
        stopReason,
      }
      options.onTurn(turnEvent)
    }

    // Add tool results as individual messages
    for (const result of toolResults) {
      const toolResultMsg = createToolResultMessage(
        result.tool_use_id,
        result.content,
        result.is_error
      )
      messages.push(toolResultMsg)
    }
  }

  // Loop exhausted
  return buildResult('max_turns', finalText, totalTurns, contextManager)
}

// --- Helpers ---

function buildResult(
  outcome: EngineResult['outcome'],
  finalText: string,
  totalTurns: number,
  contextManager: ContextManager,
  error?: string
): EngineResult {
  const usage = contextManager.getCumulativeUsage()
  return {
    outcome,
    finalText,
    totalTurns,
    usage,
    ...(error !== undefined ? { error } : {}),
  }
}

function buildAssistantContent(
  text: string,
  toolUseBlocks: ReadonlyArray<ToolUseBlock>
): Array<TextBlock | ToolUseBlock> {
  const blocks: Array<TextBlock | ToolUseBlock> = []

  if (text.length > 0) {
    blocks.push({ type: 'text', text })
  }

  for (const block of toolUseBlocks) {
    blocks.push(block)
  }

  return blocks
}

function normalizeStopReason(
  raw: string | null
): 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence' | null {
  switch (raw) {
    case 'end_turn':
    case 'tool_use':
    case 'max_tokens':
    case 'stop_sequence':
      return raw
    default:
      return null
  }
}
