import { afterEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MCPServerManager } from '../src/mcp-skill-manager.js'

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true }))) })

async function registry(overrides = {}) {
  const directory = await fs.mkdtemp(join(tmpdir(), 'crabot-computer-registry-'))
  directories.push(directory)
  const entry = { id: 'existing-computer-use', name: 'computer-use', transport: 'stdio', command: 'node',
    args: ['/old/crabot-mcp-tools/dist/computer-use/main.js'], is_builtin: true, enabled: false,
    can_disable: true, created_at: '2026-10-01', updated_at: '2026-10-01', ...overrides }
  await fs.writeFile(join(directory, 'mcp-servers.json'), JSON.stringify([entry]))
  const manager = new MCPServerManager(directory)
  await manager.initialize()
  return { manager, entry }
}

describe('computer-use builtin migration', () => {
  it('upgrades only the standard launcher and preserves identity and enabled state', async () => {
    const { manager } = await registry()
    await manager.registerBuiltins('/new/crabot-mcp-tools')
    expect(manager.list().filter(entry => entry.name === 'computer-use')).toEqual([
      expect.objectContaining({ id: 'existing-computer-use', enabled: false, can_disable: true,
        args: ['/new/crabot-mcp-tools/dist/computer-use/main.js', '--crabot-standard'] }),
    ])
    await manager.registerBuiltins('/new/crabot-mcp-tools')
    expect(manager.list().filter(entry => entry.name === 'computer-use')).toHaveLength(1)
  })
  it.each([{ command: 'custom-driver', args: ['--input'] }, { env: { CUSTOM: '1' } }])('preserves user customization %j', async overrides => {
    const { manager, entry } = await registry(overrides)
    await manager.registerBuiltins('/new/crabot-mcp-tools')
    expect(manager.list().find(value => value.name === 'computer-use')).toEqual(entry)
  })
})
