import type { LLMAdapter } from './llm-adapter'
import type {
  EngineMessage,
  EngineOptions,
  EngineResult,
  EngineTurnEvent,
  TextBlock,
  ToolUseBlock,
} from './types'
import {
  createUserMessage,
  createAssistantMessage,
  createBatchToolResultMessage,
} from './types'
import { StreamProcessor } from './stream-processor'
import { ContextManager } from './context-manager'
import { partitionToolCalls } from './tool-framework'
import { executeToolBatches, type HookConfig } from './tool-orchestration'
import { compressToolResultImages, pruneOldImages } from './image-utils'
import type { HookInput } from '../hooks/types'
import { executeHooks } from '../hooks/hook-executor'
import * as fs from 'fs'

// --- Public Interface ---

export interface RunEngineParams {
  readonly prompt: string | import('./types').ContentBlock[]
  readonly adapter: LLMAdapter
  readonly options: EngineOptions
}

const DEFAULT_MAX_TURNS = 200
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

  const workingDirectory = process.cwd()
  const hooks: HookConfig | undefined = options.hookRegistry ? {
    registry: options.hookRegistry,
    context: { workingDirectory, adapter, model: options.model, lspManager: options.lspManager },
  } : undefined

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
      // --- Stop hook ---
      if (hooks) {
        const stopInput: HookInput = { event: 'Stop', workingDirectory }
        const matching = hooks.registry.getMatching('Stop', stopInput)
        if (matching.length > 0) {
          const stopResult = await executeHooks(matching, stopInput, hooks.context)
          if (stopResult.action === 'block' && stopResult.message) {
            messages.push(createUserMessage(stopResult.message))
            continue
          }
        }
      }
      return buildResult('completed', finalText, totalTurns, contextManager)
    }

    // ── Barrier check: wait for potential supplement before executing tools ──
    if (options.humanMessageQueue?.hasBarrier) {
      await options.humanMessageQueue.waitBarrier(abortSignal)

      // Check abort after waiting
      if (abortSignal?.aborted) {
        return buildResult('aborted', finalText, totalTurns, contextManager)
      }

      // If supplement arrived during wait, cancel tools and inject
      if (options.humanMessageQueue.hasPending) {
        const cancelledResults = processed.toolUseBlocks.map(block => ({
          tool_use_id: block.id,
          content: '[操作已取消：收到用户实时纠偏，请根据新指示重新决策]',
          is_error: false,
        }))
        messages.push(createBatchToolResultMessage(cancelledResults))

        const supplements = options.humanMessageQueue.drainPending()
        for (const content of supplements) {
          messages.push(createUserMessage(content))
        }

        // Fire onTurn with cancelled tools for trace recording
        if (options.onTurn) {
          const turnEvent: EngineTurnEvent = {
            turnNumber: totalTurns,
            assistantText: processed.text,
            toolCalls: processed.toolUseBlocks.map(b => ({
              id: b.id,
              name: b.name,
              input: b.input,
              output: '[cancelled by supplement]',
              isError: false,
            })),
            stopReason,
            toolExecutionMs: 0,
          }
          options.onTurn(turnEvent)
        }

        continue  // Skip tool execution, go to next LLM turn
      }
      // else: barrier cleared without supplement → proceed normally
    }

    // Execute tools
    const batches = partitionToolCalls(processed.toolUseBlocks, options.tools)
    const toolStartTime = Date.now()
    const toolResults = await executeToolBatches(batches, options.tools, {
      abortSignal,
    }, options.permissionConfig, hooks)
    const toolExecutionMs = Date.now() - toolStartTime

    // Fire onTurn callback
    if (options.onTurn) {
      const turnEvent: EngineTurnEvent = {
        turnNumber: totalTurns,
        assistantText: processed.text,
        toolCalls: processed.toolUseBlocks.map((b, i) => ({
          id: b.id,
          name: b.name,
          input: b.input,
          output: toolResults[i]?.content ?? '',
          isError: toolResults[i]?.is_error ?? false,
        })),
        stopReason,
        toolExecutionMs,
      }
      options.onTurn(turnEvent)
    }

    // Process images based on model capability
    let processedResults: typeof toolResults
    if (options.supportsVision) {
      // VLM: compress images (resize + JPEG) then pass through
      processedResults = await compressToolResultImages(toolResults)
    } else {
      // LLM: save images to temp files, replace with text description
      processedResults = toolResults.map((r) => {
        if (!r.images?.length) return r

        const descriptions: string[] = [r.content]
        for (let i = 0; i < r.images.length; i++) {
          const img = r.images[i]
          const filename = `screenshot-${Date.now()}-${i}.png`
          const filePath = `/tmp/${filename}`
          fs.writeFileSync(filePath, Buffer.from(img.data, 'base64'))
          descriptions.push(`[Image saved to ${filePath}] Use Bash tool to analyze with OCR if needed.`)
        }
        return { ...r, content: descriptions.join('\n'), images: undefined }
      })
    }

    // Add tool results as a single batched message
    messages.push(createBatchToolResultMessage(processedResults))

    // Inject any pending human supplement messages
    if (options.humanMessageQueue) {
      const supplements = options.humanMessageQueue.drainPending()
      for (const content of supplements) {
        messages.push(createUserMessage(content))
      }
    }

    // Prune old images — keep only the most recent N screenshots
    if (options.supportsVision) {
      pruneOldImages(messages)
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
