import type { ToolDefinition, ToolCallContext } from './types'
import { findTool, type ToolBatch } from './tool-framework'

export interface ToolResultEntry {
  readonly tool_use_id: string
  readonly content: string
  readonly is_error: boolean
}

const MAX_CONCURRENT = 10

async function executeSingleTool(
  block: { readonly id: string; readonly name: string; readonly input: Record<string, unknown> },
  tools: ReadonlyArray<ToolDefinition>,
  context: ToolCallContext,
): Promise<ToolResultEntry> {
  const tool = findTool(tools, block.name)
  if (tool === undefined) {
    return { tool_use_id: block.id, content: `Tool not found: ${block.name}`, is_error: true }
  }

  try {
    const result = await tool.call(block.input, context)
    return { tool_use_id: block.id, content: result.output, is_error: result.isError }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { tool_use_id: block.id, content: `Tool execution error: ${message}`, is_error: true }
  }
}

async function executeParallelBatch(
  batch: ToolBatch,
  tools: ReadonlyArray<ToolDefinition>,
  context: ToolCallContext,
): Promise<ReadonlyArray<ToolResultEntry>> {
  const blocks = batch.blocks
  const results: ToolResultEntry[] = new Array(blocks.length)

  // Process in chunks of MAX_CONCURRENT
  for (let i = 0; i < blocks.length; i += MAX_CONCURRENT) {
    const chunk = blocks.slice(i, i + MAX_CONCURRENT)
    const chunkResults = await Promise.all(
      chunk.map((block) => executeSingleTool(block, tools, context))
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
): Promise<ReadonlyArray<ToolResultEntry>> {
  const results: ToolResultEntry[] = []
  for (const block of batch.blocks) {
    const result = await executeSingleTool(block, tools, context)
    results.push(result)
  }
  return results
}

export async function executeToolBatches(
  batches: ToolBatch[],
  tools: ReadonlyArray<ToolDefinition>,
  context?: ToolCallContext,
): Promise<ToolResultEntry[]> {
  const resolvedContext: ToolCallContext = context ?? {}
  const allResults: ToolResultEntry[] = []

  for (const batch of batches) {
    const batchResults = batch.parallel
      ? await executeParallelBatch(batch, tools, resolvedContext)
      : await executeSerialBatch(batch, tools, resolvedContext)

    for (const result of batchResults) {
      allResults.push(result)
    }
  }

  return allResults
}
