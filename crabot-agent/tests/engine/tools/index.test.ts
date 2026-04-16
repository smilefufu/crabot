import { describe, it, expect } from 'vitest'
import { getAllBuiltinTools } from '../../../src/engine/tools/index'

describe('getAllBuiltinTools', () => {
  const tools = getAllBuiltinTools('/tmp/test-cwd')

  it('returns exactly 6 tools', () => {
    expect(tools).toHaveLength(6)
  })

  it('returns tools with correct names', () => {
    const names = tools.map((t) => t.name)
    expect(names).toEqual(['Bash', 'Read', 'Write', 'Edit', 'glob', 'Grep'])
  })

  it('all tools have a valid inputSchema with type "object"', () => {
    for (const tool of tools) {
      expect(tool.inputSchema).toBeDefined()
      expect(tool.inputSchema.type).toBe('object')
      expect(tool.inputSchema.properties).toBeDefined()
    }
  })

  it('read-only tools have isReadOnly=true', () => {
    const readOnlyNames = new Set(['Read', 'glob', 'Grep'])
    for (const tool of tools) {
      if (readOnlyNames.has(tool.name)) {
        expect(tool.isReadOnly, `${tool.name} should be read-only`).toBe(true)
      }
    }
  })

  it('writable tools have isReadOnly=false', () => {
    const writableNames = new Set(['Bash', 'Write', 'Edit'])
    for (const tool of tools) {
      if (writableNames.has(tool.name)) {
        expect(tool.isReadOnly, `${tool.name} should not be read-only`).toBe(false)
      }
    }
  })

  it('Bash tool has permissionLevel="dangerous"', () => {
    const bash = tools.find((t) => t.name === 'Bash')
    expect(bash).toBeDefined()
    expect(bash!.permissionLevel).toBe('dangerous')
  })

  it('all tools have a callable call function', () => {
    for (const tool of tools) {
      expect(typeof tool.call).toBe('function')
    }
  })
})
