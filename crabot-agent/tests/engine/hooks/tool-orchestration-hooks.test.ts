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
    const results = await executeToolBatches(batches, tools, {}, undefined, registry, { workingDirectory: '/tmp' })

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
    const results = await executeToolBatches(batches, tools, {}, undefined, registry, { workingDirectory: '/tmp' })

    expect(results[0].is_error).toBe(false)
    expect(results[0].content).toContain('wrote:')
    expect(results[0].content).toContain('lint warning')
  })

  it('no hooks means normal execution', async () => {
    const batches = [{ parallel: false, blocks: [{ id: '1', name: 'Write', input: { file_path: '/tmp/x.ts' } }] }]
    const results = await executeToolBatches(batches, tools, {})

    expect(results[0].is_error).toBe(false)
    expect(results[0].content).toBe('wrote:/tmp/x.ts')
  })
})
