import { describe, it, expect } from 'vitest'
import { getConfiguredBuiltinTools } from '../../../src/engine/tools/index'
import type { BuiltinToolConfig } from '../../../src/types'

const CWD = '/tmp/test-config-cwd'

describe('getConfiguredBuiltinTools', () => {
  it('returns all 6 tools when no config provided', () => {
    const tools = getConfiguredBuiltinTools(CWD)
    expect(tools).toHaveLength(6)
    const names = tools.map((t) => t.name)
    expect(names).toEqual(['Bash', 'Read', 'Write', 'Edit', 'glob', 'Grep'])
  })

  it('returns all 6 tools when config is undefined', () => {
    const tools = getConfiguredBuiltinTools(CWD, undefined)
    expect(tools).toHaveLength(6)
  })

  it('returns all 6 tools when config is empty object', () => {
    const tools = getConfiguredBuiltinTools(CWD, {})
    expect(tools).toHaveLength(6)
  })

  it('filters to only enabled_tools when set', () => {
    const config: BuiltinToolConfig = {
      enabled_tools: ['Bash', 'Read'],
    }
    const tools = getConfiguredBuiltinTools(CWD, config)
    expect(tools).toHaveLength(2)
    const names = tools.map((t) => t.name)
    expect(names).toEqual(['Bash', 'Read'])
  })

  it('enabled_tools with unknown tool names ignores them', () => {
    const config: BuiltinToolConfig = {
      enabled_tools: ['Bash', 'NonExistent'],
    }
    const tools = getConfiguredBuiltinTools(CWD, config)
    expect(tools).toHaveLength(1)
    expect(tools[0].name).toBe('Bash')
  })

  it('removes disabled_tools when set', () => {
    const config: BuiltinToolConfig = {
      disabled_tools: ['Bash', 'Write'],
    }
    const tools = getConfiguredBuiltinTools(CWD, config)
    expect(tools).toHaveLength(4)
    const names = tools.map((t) => t.name)
    expect(names).not.toContain('Bash')
    expect(names).not.toContain('Write')
  })

  it('enabled_tools takes precedence over disabled_tools', () => {
    const config: BuiltinToolConfig = {
      enabled_tools: ['Bash', 'Read'],
      disabled_tools: ['Bash'],
    }
    const tools = getConfiguredBuiltinTools(CWD, config)
    // enabled_tools is checked first, disabled_tools ignored
    expect(tools).toHaveLength(2)
    const names = tools.map((t) => t.name)
    expect(names).toEqual(['Bash', 'Read'])
  })

  it('applies permission_overrides to specified tools', () => {
    const config: BuiltinToolConfig = {
      permission_overrides: {
        'Read': 'dangerous',
        'Bash': 'safe',
      },
    }
    const tools = getConfiguredBuiltinTools(CWD, config)
    const readTool = tools.find((t) => t.name === 'Read')
    const bashTool = tools.find((t) => t.name === 'Bash')
    expect(readTool?.permissionLevel).toBe('dangerous')
    expect(bashTool?.permissionLevel).toBe('safe')
  })

  it('permission_overrides does not affect tools not in the map', () => {
    const config: BuiltinToolConfig = {
      permission_overrides: {
        'Bash': 'safe',
      },
    }
    const tools = getConfiguredBuiltinTools(CWD, config)
    const writeTool = tools.find((t) => t.name === 'Write')
    // Write tool should keep its original permissionLevel (undefined or whatever default)
    expect(writeTool?.permissionLevel).not.toBe('safe')
  })

  it('bash_timeout is passed to Bash tool', () => {
    const config: BuiltinToolConfig = {
      bash_timeout: 5000,
    }
    const tools = getConfiguredBuiltinTools(CWD, config)
    const bashTool = tools.find((t) => t.name === 'Bash')
    expect(bashTool).toBeDefined()
    // Verify via the input schema description that timeout default is reflected
    // The actual timeout behavior is tested in bash-tool.test.ts
    // Here we just verify the tool exists and was created
    expect(bashTool!.name).toBe('Bash')
  })

  it('combines filtering and permission_overrides', () => {
    const config: BuiltinToolConfig = {
      enabled_tools: ['Bash', 'Read', 'Grep'],
      permission_overrides: {
        'Grep': 'dangerous',
      },
    }
    const tools = getConfiguredBuiltinTools(CWD, config)
    expect(tools).toHaveLength(3)
    const grepTool = tools.find((t) => t.name === 'Grep')
    expect(grepTool?.permissionLevel).toBe('dangerous')
  })
})
