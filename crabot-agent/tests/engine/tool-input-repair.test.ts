/**
 * 引擎编排层参数修复语义测试（spec 2026-09-03-tool-input-repair）。
 *
 * 覆盖 executeSingleTool 对 ToolDefinition.repairInput 的执行保证：
 * - 修复结果真实传入 handler
 * - 规则抛错 / 返回非对象 → 原样透传，handler 收到原始入参
 * - 修复不改变工具返回内容（返回内容与直接调用完全一致）
 * - 无 repairInput 的工具行为不变
 */
import { describe, it, expect } from 'vitest'
import { executeToolBatches } from '../../src/engine/tool-orchestration'
import { defineTool } from '../../src/engine/tool-framework'
import type { ToolDefinition, ToolUseBlock } from '../../src/engine/types'

function makeBlock(name: string, input: Record<string, unknown>): ToolUseBlock {
  return { type: 'tool_use', id: 't1', name, input }
}

async function runOne(tools: ReadonlyArray<ToolDefinition>, input: Record<string, unknown>) {
  const results = await executeToolBatches(
    [{ parallel: false, blocks: [makeBlock('echo', input)] }],
    tools,
  )
  return results[0]
}

describe('executeToolBatches 参数修复（repairInput）', () => {
  it('修复结果传入 handler', async () => {
    let seen: Record<string, unknown> | undefined
    const echo = defineTool({
      name: 'echo',
      description: 'echo',
      inputSchema: {},
      repairInput: async (input) => ({ ...input, channel_id: 'repaired' }),
      call: async (input) => {
        seen = input
        return { output: 'done', isError: false }
      },
    })
    const result = await runOne([echo], { session_id: 's1' })
    expect(seen).toEqual({ session_id: 's1', channel_id: 'repaired' })
    expect(result.is_error).toBe(false)
    expect(result.content).toContain('done')
  })

  it('规则抛错 → 原样透传，handler 收到原始入参且不产生错误结果', async () => {
    let seen: Record<string, unknown> | undefined
    const echo = defineTool({
      name: 'echo',
      description: 'echo',
      inputSchema: {},
      repairInput: async () => {
        throw new Error('rpc blew up')
      },
      call: async (input) => {
        seen = input
        return { output: 'done', isError: false }
      },
    })
    const result = await runOne([echo], { session_id: 's1' })
    expect(seen).toEqual({ session_id: 's1' })
    expect(result.is_error).toBe(false)
  })

  it('规则返回非对象 → 原样透传', async () => {
    let seen: Record<string, unknown> | undefined
    const echo = defineTool({
      name: 'echo',
      description: 'echo',
      inputSchema: {},
      repairInput: async () => undefined as unknown as Record<string, unknown>,
      call: async (input) => {
        seen = input
        return { output: 'done', isError: false }
      },
    })
    await runOne([echo], { session_id: 's1' })
    expect(seen).toEqual({ session_id: 's1' })
  })

  it('无 repairInput 的工具行为不变', async () => {
    let seen: Record<string, unknown> | undefined
    const echo = defineTool({
      name: 'echo',
      description: 'echo',
      inputSchema: {},
      call: async (input) => {
        seen = input
        return { output: 'done', isError: false }
      },
    })
    await runOne([echo], { channel_id: 'c', session_id: 's1' })
    expect(seen).toEqual({ channel_id: 'c', session_id: 's1' })
  })
})
