import { describe, it, expect } from 'vitest'
import { executeToolBatches } from '../../../src/engine/tool-orchestration'
import { defineTool } from '../../../src/engine/tool-framework'
import { HookRegistry } from '../../../src/hooks/hook-registry'
import type { ToolDefinition } from '../../../src/engine/types'

describe('tool-orchestration with hooks', () => {
  const writeTool = defineTool({
    name: 'Write',
    description: 'write file',
    inputSchema: {},
    isReadOnly: false,
    call: async (input) => ({ output: `wrote:${String(input.file_path ?? '')}`, isError: false }),
  })

  const tools: ReadonlyArray<ToolDefinition> = [writeTool]

  it('PreToolUse block prevents tool execution', async () => {
    const registry = new HookRegistry()
    registry.register({
      event: 'PreToolUse', matcher: 'Write', type: 'command',
      command: 'echo "blocked" >&2; exit 2',
    })

    const batches = [{ parallel: false, blocks: [{ id: '1', name: 'Write', input: { file_path: '/tmp/x.ts' } }] }]
    const results = await executeToolBatches(batches, tools, {}, undefined, { registry, context: { workingDirectory: '/tmp' } })

    expect(results[0].is_error).toBe(true)
    expect(results[0].content).toContain('blocked')
  })

  it('PostToolUse message appended to output', async () => {
    const registry = new HookRegistry()
    registry.register({
      event: 'PostToolUse', matcher: 'Write', type: 'command',
      command: 'echo "lint warning: unused var"',
    })

    const batches = [{ parallel: false, blocks: [{ id: '1', name: 'Write', input: { file_path: '/tmp/x.ts' } }] }]
    const results = await executeToolBatches(batches, tools, {}, undefined, { registry, context: { workingDirectory: '/tmp' } })

    expect(results[0].is_error).toBe(false)
    expect(results[0].content).toContain('wrote:')
    expect(results[0].content).toContain('lint warning')
  })

  it('no hooks means normal execution', async () => {
    const batches = [{ parallel: false, blocks: [{ id: '1', name: 'Write', input: { file_path: '/tmp/x.ts' } }] }]
    const results = await executeToolBatches(batches, tools, {})

    expect(results[0].is_error).toBe(false)
    expect(results[0].content).toContain('wrote:/tmp/x.ts')
  })

  it('PreToolUse 按修复后的 input 和 filePaths 匹配，并与 handler 观察同一份有效入参', async () => {
    const registry = new HookRegistry()
    registry.register({
      event: 'PreToolUse', matcher: 'Write', if: 'Write(*.ts)', type: 'command',
      command: 'node -e \'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const i=JSON.parse(s);if(i.toolInput.file_path!=="/tmp/repaired.ts"||i.filePaths[0]!=="/tmp/repaired.ts")process.exit(2)})\'',
    })
    let seenByHandler: Record<string, unknown> | undefined
    const repairedWrite = defineTool({
      name: 'Write',
      description: 'write file',
      inputSchema: {},
      isReadOnly: false,
      repairInput: async (input) => ({ ...input, file_path: '/tmp/repaired.ts' }),
      call: async (input) => {
        seenByHandler = input
        return { output: 'done', isError: false }
      },
    })

    const results = await executeToolBatches(
      [{ parallel: false, blocks: [{ id: '1', name: 'Write', input: { file_path: '/tmp/raw.txt' } }] }],
      [repairedWrite],
      {},
      undefined,
      { registry, context: { workingDirectory: '/tmp' } },
    )

    expect(results[0].is_error).toBe(false)
    expect(results[0].content).toContain('done')
    expect(seenByHandler).toEqual({ file_path: '/tmp/repaired.ts' })
  })
})
