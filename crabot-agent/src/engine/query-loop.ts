import type { LLMAdapter } from './llm-adapter'
import { callNonStreaming } from './llm-adapter'
import type {
  ContentBlock,
  EngineMessage,
  EngineOptions,
  EngineResult,
  EngineTurnEvent,
  RawReasoningBlock,
  ToolUseBlock,
} from './types'
import {
  createUserMessage,
  createAssistantMessage,
  createBatchToolResultMessage,
} from './types'
import { ContextManager } from './context-manager'
import { partitionToolCalls } from './tool-framework'
import { executeToolBatches, type HookConfig } from './tool-orchestration'
import { compressToolResultImages, pruneOldImages } from './image-utils'
import { formatError } from './error-utils'
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
const DEFAULT_MAX_CONTEXT_TOKENS = 200_000

// --- Core Loop ---

export async function runEngine(params: RunEngineParams): Promise<EngineResult> {
  const { prompt, adapter, options } = params
  const maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS
  const abortSignal = options.abortSignal

  const messages: EngineMessage[] = [createUserMessage(prompt)]
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

    // Call LLM (non-streaming by default; streaming infra preserved for rollback
    // via adapters that opt out of `complete()`).
    let response: import('./llm-adapter').LLMCallResponse
    const currentSystemPrompt = typeof options.systemPrompt === 'function'
      ? (options.systemPrompt as () => string)()
      : options.systemPrompt
    const currentTools = typeof options.tools === 'function'
      ? (options.tools as () => ReadonlyArray<import('./types').ToolDefinition>)()
      : options.tools
    try {
      response = await callNonStreaming(adapter, {
        messages,
        systemPrompt: currentSystemPrompt,
        tools: [...currentTools],
        model: options.model,
        maxTokens: options.maxTokens,
        signal: abortSignal,
      })
    } catch (error) {
      if (abortSignal?.aborted) {
        return buildResult('aborted', finalText, totalTurns, contextManager)
      }
      console.error('[query-loop] LLM call threw:', error)
      return buildResult('failed', finalText, totalTurns, contextManager, formatError(error))
    }

    const processed = partitionResponseContent(response.content)
    totalTurns++

    // Live progress: assistant text arrived (fires before tool execution).
    // 注意：emit 在 totalTurns++ 之后，turn 数与 onTurn.turnNumber 对齐。
    if (options.onLiveProgress && processed.text.length > 0) {
      options.onLiveProgress({
        type: 'turn_assistant',
        turn: totalTurns,
        text: processed.text,
      })
    }

    // Update usage tracking
    if (response.usage) {
      contextManager.updateFromUsage(response.usage)
    }

    // Build assistant message content blocks (preserves reasoning ordering: reasoning → text → tool_use)
    const contentBlocks = buildAssistantContent(processed.reasoningBlocks, processed.text, processed.toolUseBlocks)
    const stopReason = normalizeStopReason(response.stopReason)

    const assistantMessage = createAssistantMessage(contentBlocks, stopReason, response.usage)
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
    const batches = partitionToolCalls(processed.toolUseBlocks, currentTools)
    // Live progress: tools about to start
    if (options.onLiveProgress) {
      options.onLiveProgress({
        type: 'tools_start',
        tools: processed.toolUseBlocks.map(b => ({
          name: b.name,
          input_summary: summarizeToolInput(b.input),
        })),
      })
    }
    const toolStartTime = Date.now()
    const toolResults = await executeToolBatches(batches, currentTools, {
      abortSignal,
      ...(options.timezone ? { timezone: options.timezone } : {}),
    }, options.permissionConfig, hooks)
    const toolExecutionMs = Date.now() - toolStartTime
    // Live progress: tools finished
    if (options.onLiveProgress) {
      options.onLiveProgress({
        type: 'tools_end',
        results: processed.toolUseBlocks.map((b, i) => ({
          name: b.name,
          input_summary: summarizeToolInput(b.input),
          is_error: toolResults[i]?.is_error ?? false,
        })),
      })
    }

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
  reasoningBlocks: ReadonlyArray<RawReasoningBlock>,
  text: string,
  toolUseBlocks: ReadonlyArray<ToolUseBlock>
): ContentBlock[] {
  const blocks: ContentBlock[] = []

  // Reasoning must precede text/tool_use so Codex replay keeps encrypted_content intact
  for (const block of reasoningBlocks) {
    blocks.push(block)
  }

  if (text.length > 0) {
    blocks.push({ type: 'text', text })
  }

  for (const block of toolUseBlocks) {
    blocks.push(block)
  }

  return blocks
}

function partitionResponseContent(content: ReadonlyArray<ContentBlock>): {
  readonly text: string
  readonly toolUseBlocks: ReadonlyArray<ToolUseBlock>
  readonly reasoningBlocks: ReadonlyArray<RawReasoningBlock>
} {
  const textParts: string[] = []
  const toolUseBlocks: ToolUseBlock[] = []
  const reasoningBlocks: RawReasoningBlock[] = []
  for (const block of content) {
    if (block.type === 'text') textParts.push(block.text)
    else if (block.type === 'tool_use') toolUseBlocks.push(block)
    else if (block.type === 'raw_reasoning') reasoningBlocks.push(block)
  }
  return { text: textParts.join(''), toolUseBlocks, reasoningBlocks }
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

/**
 * 把工具输入压缩成 200 字以内的人类可读摘要，用于 live snapshot。
 * Bash 优先取 command 第一行；其它工具走 JSON.stringify 截断。
 */
function summarizeToolInput(input: Record<string, unknown> | undefined): string {
  if (!input || typeof input !== 'object') return ''
  const cmd = (input as { command?: unknown }).command
  if (typeof cmd === 'string') {
    const firstLine = cmd.split('\n', 1)[0].trim()
    return firstLine.length > 200 ? firstLine.slice(0, 200) + '…' : firstLine
  }
  const file = (input as { file_path?: unknown }).file_path
  if (typeof file === 'string') return file.length > 200 ? file.slice(0, 200) + '…' : file
  try {
    const json = JSON.stringify(input)
    return json.length > 200 ? json.slice(0, 200) + '…' : json
  } catch {
    return ''
  }
}
