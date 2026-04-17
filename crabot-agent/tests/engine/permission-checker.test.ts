import { describe, it, expect, vi } from 'vitest'
import { checkToolPermission, filterToolsByPermission } from '../../src/engine/permission-checker'
import { defineTool } from '../../src/engine/tool-framework'
import { executeToolBatches } from '../../src/engine/tool-orchestration'
import type { ToolDefinition, ToolPermissionConfig, PermissionDecision } from '../../src/engine/types'

function makeTool(
  name: string,
  permissionLevel?: 'safe' | 'normal' | 'dangerous'
): ToolDefinition {
  return defineTool({
    name,
    description: `Tool: ${name}`,
    inputSchema: {},
    permissionLevel,
    call: async () => ({ output: `${name}_ok`, isError: false }),
  })
}

describe('checkToolPermission', () => {
  it('no config → always allowed', async () => {
    const tool = makeTool('read_file')
    const result = await checkToolPermission('read_file', {}, tool, undefined)
    expect(result).toEqual({ allowed: true })
  })

  it('bypass mode → always allowed', async () => {
    const tool = makeTool('dangerous_tool', 'dangerous')
    const config: ToolPermissionConfig = { mode: 'bypass' }
    const result = await checkToolPermission('dangerous_tool', {}, tool, config)
    expect(result).toEqual({ allowed: true })
  })

  it('allowList → allowed if tool in list', async () => {
    const tool = makeTool('read_file')
    const config: ToolPermissionConfig = {
      mode: 'allowList',
      toolNames: ['read_file', 'search'],
    }
    const result = await checkToolPermission('read_file', {}, tool, config)
    expect(result).toEqual({ allowed: true })
  })

  it('allowList → denied if tool not in list', async () => {
    const tool = makeTool('write_file')
    const config: ToolPermissionConfig = {
      mode: 'allowList',
      toolNames: ['read_file', 'search'],
    }
    const result = await checkToolPermission('write_file', {}, tool, config)
    expect(result.allowed).toBe(false)
    if (!result.allowed) {
      expect(result.reason).toContain('write_file')
    }
  })

  it('denyList → denied if tool in list', async () => {
    const tool = makeTool('delete_all')
    const config: ToolPermissionConfig = {
      mode: 'denyList',
      toolNames: ['delete_all', 'drop_table'],
    }
    const result = await checkToolPermission('delete_all', {}, tool, config)
    expect(result.allowed).toBe(false)
    if (!result.allowed) {
      expect(result.reason).toContain('delete_all')
    }
  })

  it('denyList → allowed if tool not in list', async () => {
    const tool = makeTool('read_file')
    const config: ToolPermissionConfig = {
      mode: 'denyList',
      toolNames: ['delete_all', 'drop_table'],
    }
    const result = await checkToolPermission('read_file', {}, tool, config)
    expect(result).toEqual({ allowed: true })
  })

  it('dangerous tool without explicit permission → denied', async () => {
    const tool = makeTool('nuke', 'dangerous')
    // No config at all — dangerous tools should be denied
    const result = await checkToolPermission('nuke', {}, tool, undefined)
    expect(result.allowed).toBe(false)
    if (!result.allowed) {
      expect(result.reason).toContain('dangerous')
    }
  })

  it('dangerous tool with allowList including it → allowed', async () => {
    const tool = makeTool('nuke', 'dangerous')
    const config: ToolPermissionConfig = {
      mode: 'allowList',
      toolNames: ['nuke'],
    }
    const result = await checkToolPermission('nuke', {}, tool, config)
    expect(result).toEqual({ allowed: true })
  })

  it('dangerous tool with bypass mode → allowed', async () => {
    const tool = makeTool('nuke', 'dangerous')
    const config: ToolPermissionConfig = { mode: 'bypass' }
    const result = await checkToolPermission('nuke', {}, tool, config)
    expect(result).toEqual({ allowed: true })
  })

  it('dangerous tool with denyList (not listed) → allowed', async () => {
    // denyList 已是用户明确声明，dangerous 的默认保护在此模式下不叠加
    const tool = makeTool('bash', 'dangerous')
    const config: ToolPermissionConfig = {
      mode: 'denyList',
      toolNames: ['write_file'],
    }
    const result = await checkToolPermission('bash', {}, tool, config)
    expect(result).toEqual({ allowed: true })
  })

  it('checkPermission callback overrides static checks', async () => {
    const tool = makeTool('read_file')
    const config: ToolPermissionConfig = {
      mode: 'denyList',
      toolNames: ['read_file'],
      checkPermission: async (_name, _input) => ({ allowed: true }),
    }
    // Static check would deny (read_file is in denyList), but callback overrides
    const result = await checkToolPermission('read_file', {}, tool, config)
    expect(result).toEqual({ allowed: true })
  })

  it('checkPermission callback can deny an otherwise-allowed tool', async () => {
    const tool = makeTool('read_file')
    const config: ToolPermissionConfig = {
      mode: 'bypass',
      checkPermission: async (_name, _input) => ({
        allowed: false,
        reason: 'custom deny reason',
      }),
    }
    const result = await checkToolPermission('read_file', {}, tool, config)
    expect(result.allowed).toBe(false)
    if (!result.allowed) {
      expect(result.reason).toBe('custom deny reason')
    }
  })

  it('checkPermission callback receives tool name and input', async () => {
    const tool = makeTool('read_file')
    const inputData = { path: '/etc/passwd' }
    const checkFn = vi.fn<
      [string, Record<string, unknown>],
      Promise<PermissionDecision>
    >().mockResolvedValue({ allowed: true })

    const config: ToolPermissionConfig = {
      mode: 'allowList',
      toolNames: ['read_file'],
      checkPermission: checkFn,
    }

    await checkToolPermission('read_file', inputData, tool, config)
    expect(checkFn).toHaveBeenCalledWith('read_file', inputData)
  })
})

describe('executeToolBatches with permission config (integration)', () => {
  it('permission denied → error result', async () => {
    const tool = makeTool('write_file')
    const tools: ReadonlyArray<ToolDefinition> = [tool]
    const config: ToolPermissionConfig = {
      mode: 'allowList',
      toolNames: ['read_file'],
    }

    const batches = [
      {
        parallel: false,
        blocks: [
          { type: 'tool_use' as const, id: 'tu-1', name: 'write_file', input: {} },
        ],
      },
    ]

    const results = await executeToolBatches(batches, tools, undefined, config)
    expect(results).toHaveLength(1)
    expect(results[0].is_error).toBe(true)
    expect(results[0].content).toContain('Permission denied')
    expect(results[0].content).toContain('write_file')
  })

  it('permission allowed → normal execution', async () => {
    const tool = makeTool('read_file')
    const tools: ReadonlyArray<ToolDefinition> = [tool]
    const config: ToolPermissionConfig = {
      mode: 'allowList',
      toolNames: ['read_file'],
    }

    const batches = [
      {
        parallel: false,
        blocks: [
          { type: 'tool_use' as const, id: 'tu-2', name: 'read_file', input: {} },
        ],
      },
    ]

    const results = await executeToolBatches(batches, tools, undefined, config)
    expect(results).toHaveLength(1)
    expect(results[0].is_error).toBe(false)
    expect(results[0].content).toBe('read_file_ok')
  })

  it('no permission config → all tools execute normally', async () => {
    const tool = makeTool('write_file')
    const tools: ReadonlyArray<ToolDefinition> = [tool]

    const batches = [
      {
        parallel: false,
        blocks: [
          { type: 'tool_use' as const, id: 'tu-3', name: 'write_file', input: {} },
        ],
      },
    ]

    const results = await executeToolBatches(batches, tools)
    expect(results).toHaveLength(1)
    expect(results[0].is_error).toBe(false)
    expect(results[0].content).toBe('write_file_ok')
  })
})

describe('filterToolsByPermission', () => {
  const read = makeTool('read_file')
  const write = makeTool('write_file')
  const bash = makeTool('bash')

  it('undefined config → returns all tools', () => {
    expect(filterToolsByPermission([read, write], undefined).map(t => t.name)).toEqual(['read_file', 'write_file'])
  })

  it('bypass mode → returns all tools', () => {
    const result = filterToolsByPermission([read, write], { mode: 'bypass' })
    expect(result.map(t => t.name)).toEqual(['read_file', 'write_file'])
  })

  it('denyList → drops listed tools', () => {
    const result = filterToolsByPermission(
      [read, write, bash],
      { mode: 'denyList', toolNames: ['write_file', 'bash'] },
    )
    expect(result.map(t => t.name)).toEqual(['read_file'])
  })

  it('allowList → keeps only listed tools', () => {
    const result = filterToolsByPermission(
      [read, write, bash],
      { mode: 'allowList', toolNames: ['read_file'] },
    )
    expect(result.map(t => t.name)).toEqual(['read_file'])
  })

  it('checkPermission callback → skips static filtering, returns all', () => {
    const result = filterToolsByPermission(
      [read, write],
      { mode: 'denyList', toolNames: ['write_file'], checkPermission: async () => ({ allowed: true }) },
    )
    expect(result.map(t => t.name)).toEqual(['read_file', 'write_file'])
  })
})
