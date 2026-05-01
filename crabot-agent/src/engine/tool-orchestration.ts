import type { ToolDefinition, ToolCallContext, ToolPermissionConfig } from './types'
import { findTool, type ToolBatch } from './tool-framework'
import { checkToolPermission } from './permission-checker'
import type { HookExecutorContext } from '../hooks/types'
import type { HookRegistry } from '../hooks/hook-registry'
import { executeHooks } from '../hooks/hook-executor'
import { stampToolResult, resolveTimezone } from '../utils/time'

export interface ToolResultEntry {
  readonly tool_use_id: string
  readonly content: string
  readonly images?: ReadonlyArray<{ readonly media_type: string; readonly data: string }>
  readonly is_error: boolean
  readonly duration_ms?: number
  readonly started_at_ms?: number
}

export interface HookConfig {
  readonly registry: HookRegistry
  readonly context: HookExecutorContext
}

const MAX_CONCURRENT = 10

export function extractFilePaths(input: Record<string, unknown>): string[] {
  const paths: string[] = []
  const fp = input.file_path ?? input.filePath ?? input.path
  if (typeof fp === 'string') paths.push(fp)
  return paths
}

async function executeSingleTool(
  block: { readonly id: string; readonly name: string; readonly input: Record<string, unknown> },
  tools: ReadonlyArray<ToolDefinition>,
  context: ToolCallContext,
  permissionConfig?: ToolPermissionConfig,
  hooks?: HookConfig,
): Promise<ToolResultEntry> {
  const startedAtMs = Date.now()
  const stampTiming = (entry: ToolResultEntry): ToolResultEntry => ({
    ...entry,
    started_at_ms: startedAtMs,
    duration_ms: Date.now() - startedAtMs,
  })
  // context.timezone 由调用方（runEngine / front-loop）保证已 resolve；缺省时兜底
  const timezone = context.timezone ?? resolveTimezone(undefined)
  const stamp = (content: string): string => stampToolResult(content, timezone)

  const tool = findTool(tools, block.name)
  if (tool === undefined) {
    return stampTiming({ tool_use_id: block.id, content: stamp(`Tool not found: ${block.name}`), is_error: true })
  }

  const permission = await checkToolPermission(block.name, block.input, tool, permissionConfig)
  if (!permission.allowed) {
    return stampTiming({ tool_use_id: block.id, content: stamp(`Permission denied: ${permission.reason}`), is_error: true })
  }

  // --- PreToolUse hook ---
  let effectiveInput = block.input
  if (hooks) {
    const filePaths = extractFilePaths(block.input)
    const preInput = {
      event: 'PreToolUse' as const,
      toolName: block.name,
      toolInput: block.input,
      workingDirectory: hooks.context.workingDirectory,
      filePaths,
    }
    const matching = hooks.registry.getMatching('PreToolUse', preInput)
    if (matching.length > 0) {
      const preResult = await executeHooks(matching, preInput, hooks.context)
      if (preResult.action === 'block') {
        return stampTiming({ tool_use_id: block.id, content: stamp(preResult.message ?? 'Blocked by hook'), is_error: true })
      }
      if (preResult.modifiedInput) {
        effectiveInput = { ...effectiveInput, ...preResult.modifiedInput }
      }
    }
  }

  try {
    const result = await tool.call(effectiveInput, context)

    // --- PostToolUse hook ---
    let finalContent = result.output
    if (hooks) {
      const filePaths = extractFilePaths(effectiveInput)
      const postInput = {
        event: 'PostToolUse' as const,
        toolName: block.name,
        toolInput: effectiveInput,
        toolOutput: result.output,
        workingDirectory: hooks.context.workingDirectory,
        filePaths,
      }
      const matching = hooks.registry.getMatching('PostToolUse', postInput)
      if (matching.length > 0) {
        const postResult = await executeHooks(matching, postInput, hooks.context)
        if (postResult.message) {
          const suffix = postResult.action === 'block'
            ? `\n\n${postResult.message}\n\n请修复以上问题后继续。`
            : `\n\n${postResult.message}`
          finalContent = finalContent + suffix
        }
      }
    }

    return stampTiming({
      tool_use_id: block.id,
      content: stamp(finalContent),
      ...(result.images !== undefined ? { images: result.images } : {}),
      is_error: result.isError,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return stampTiming({ tool_use_id: block.id, content: stamp(`Tool execution error: ${message}`), is_error: true })
  }
}

async function executeParallelBatch(
  batch: ToolBatch,
  tools: ReadonlyArray<ToolDefinition>,
  context: ToolCallContext,
  permissionConfig?: ToolPermissionConfig,
  hooks?: HookConfig,
): Promise<ReadonlyArray<ToolResultEntry>> {
  const blocks = batch.blocks
  const results: ToolResultEntry[] = new Array(blocks.length)

  // Process in chunks of MAX_CONCURRENT
  for (let i = 0; i < blocks.length; i += MAX_CONCURRENT) {
    const chunk = blocks.slice(i, i + MAX_CONCURRENT)
    const chunkResults = await Promise.all(
      chunk.map((block) => executeSingleTool(block, tools, context, permissionConfig, hooks))
    )
    for (let j = 0; j < chunkResults.length; j++) {
      results[i + j] = chunkResults[j]
    }
  }

  return results
}

async function executeSerialBatch(
  batch: ToolBatch,
  tools: ReadonlyArray<ToolDefinition>,
  context: ToolCallContext,
  permissionConfig?: ToolPermissionConfig,
  hooks?: HookConfig,
): Promise<ReadonlyArray<ToolResultEntry>> {
  const results: ToolResultEntry[] = []
  for (const block of batch.blocks) {
    const result = await executeSingleTool(block, tools, context, permissionConfig, hooks)
    results.push(result)
  }
  return results
}

export async function executeToolBatches(
  batches: ReadonlyArray<ToolBatch>,
  tools: ReadonlyArray<ToolDefinition>,
  context?: ToolCallContext,
  permissionConfig?: ToolPermissionConfig,
  hooks?: HookConfig,
): Promise<ToolResultEntry[]> {
  const resolvedContext: ToolCallContext = context ?? {}
  const allResults: ToolResultEntry[] = []

  for (const batch of batches) {
    const batchResults = batch.parallel
      ? await executeParallelBatch(batch, tools, resolvedContext, permissionConfig, hooks)
      : await executeSerialBatch(batch, tools, resolvedContext, permissionConfig, hooks)

    for (const result of batchResults) {
      allResults.push(result)
    }
  }

  return allResults
}
