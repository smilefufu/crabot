import type { ToolDefinition, ToolUseBlock, ToolCallContext, ToolCallResult, ToolPermissionLevel } from './types'

// --- Define Tool ---

export interface DefineToolParams {
  readonly name: string
  readonly description: string
  readonly inputSchema: Record<string, unknown>
  readonly isReadOnly?: boolean
  readonly permissionLevel?: ToolPermissionLevel
  readonly call: (input: Record<string, unknown>, context: ToolCallContext) => Promise<ToolCallResult>
}

export function defineTool(params: DefineToolParams): ToolDefinition {
  return {
    name: params.name,
    description: params.description,
    inputSchema: params.inputSchema,
    isReadOnly: params.isReadOnly ?? false,
    ...(params.permissionLevel !== undefined ? { permissionLevel: params.permissionLevel } : {}),
    call: params.call,
  }
}

// --- Find Tool ---

export function findTool(
  tools: ReadonlyArray<ToolDefinition>,
  name: string
): ToolDefinition | undefined {
  return tools.find((tool) => tool.name === name)
}

// --- Partition Tool Calls ---

export interface ToolBatch {
  readonly parallel: boolean
  readonly blocks: ReadonlyArray<ToolUseBlock>
}

function isReadOnlyBlock(
  block: ToolUseBlock,
  tools: ReadonlyArray<ToolDefinition>
): boolean {
  const tool = findTool(tools, block.name)
  return tool !== undefined && tool.isReadOnly
}

export function partitionToolCalls(
  blocks: ReadonlyArray<ToolUseBlock>,
  tools: ReadonlyArray<ToolDefinition>
): ReadonlyArray<ToolBatch> {
  if (blocks.length === 0) {
    return []
  }

  const batches: ToolBatch[] = []
  let currentReadOnlyBlocks: ToolUseBlock[] = []

  for (const block of blocks) {
    if (isReadOnlyBlock(block, tools)) {
      currentReadOnlyBlocks.push(block)
    } else {
      // Flush any accumulated read-only blocks as a parallel batch
      if (currentReadOnlyBlocks.length > 0) {
        batches.push({ parallel: true, blocks: currentReadOnlyBlocks })
        currentReadOnlyBlocks = []
      }
      // Non-read-only tool gets its own serial batch
      batches.push({ parallel: false, blocks: [block] })
    }
  }

  // Flush remaining read-only blocks
  if (currentReadOnlyBlocks.length > 0) {
    batches.push({ parallel: true, blocks: currentReadOnlyBlocks })
  }

  return batches
}
