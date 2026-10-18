import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { MCPServerManager } from './mcp-skill-manager.js'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }) })
async function manager(bundled = true) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'crabot-managed-mcp-')); roots.push(root)
  const subject = new MCPServerManager(root, bundled)
  await subject.initializeLoadOnly()
  return { root, subject }
}

describe('managed MCP registry contract', () => {
  it('defaults only fresh standard entries in a bundled install; old and custom stay unchanged', async () => {
    const { root, subject } = await manager()
    const legacy = { id: 'legacy', name: 'old', command: 'npx', enabled: true }
    await fs.writeFile(path.join(root, 'mcp-servers.json'), JSON.stringify([legacy]))
    await subject.initializeLoadOnly()
    expect(subject.get('legacy')?.managed_runtime).toBeUndefined()
    expect((await subject.create({ name: 'node', command: 'npx' })).managed_runtime).toBe('node')
    expect((await subject.create({ name: 'python', command: 'uvx' })).managed_runtime).toBe('python')
    for (const options of [{ command: '/opt/bin/npx' }, { command: 'npx', env: { API_KEY: 'configured' } },
      { command: 'npx', managed_runtime: null }, { command: 'node' }]) {
      expect((await subject.create({ name: 'custom', ...options })).managed_runtime).toBeUndefined()
    }
    expect((await (await manager(false)).subject.create({ name: 'source', command: 'npx' })).managed_runtime).toBeUndefined()
  })

  it('preserves selection and id across rename; null clears selection and persistence never stores null', async () => {
    const { root, subject } = await manager()
    const original = await subject.create({ name: 'one', command: 'npx' })
    const before = subject.runtimeSemanticEntries()
    const renamed = await subject.update(original.id, { name: 'two' })
    expect(renamed).toMatchObject({ id: original.id, managed_runtime: 'node', enabled: true })
    expect((await subject.update(original.id, { managed_runtime: null })).managed_runtime).toBeUndefined()
    expect(subject.runtimeSemanticEntries()).not.toEqual(before)
    expect(JSON.parse(await fs.readFile(path.join(root, 'mcp-servers.json'), 'utf8'))[0]).not.toHaveProperty('managed_runtime')
  })

  it('rejects illegal combinations atomically, including updates and multi-entry JSON import', async () => {
    const { root, subject } = await manager()
    const original = await subject.create({ name: 'one', command: 'npx' })
    const before = await fs.readFile(path.join(root, 'mcp-servers.json'), 'utf8')
    for (const patch of [{ command: '/bin/npx' }, { managed_runtime: 'python' },
      { env: { Path: '/custom' } }, { args: ['--prefix=/custom'] }, { managed_runtime: 'bad' },
      { transport: 'sse' }, { env: { NPM_CONFIG_CACHE: '/custom' } }]) {
      await expect(subject.update(original.id, patch as any)).rejects.toThrow()
      expect(await fs.readFile(path.join(root, 'mcp-servers.json'), 'utf8')).toBe(before)
    }
    await expect(subject.importFromJson(JSON.stringify({ mcpServers: {
      valid: { command: 'uvx' }, invalid: { command: '/custom/python', managed_runtime: 'python' },
    } }))).rejects.toThrow()
    expect(await fs.readFile(path.join(root, 'mcp-servers.json'), 'utf8')).toBe(before)
    expect(subject.get(original.id)).toMatchObject({ command: 'npx', enabled: true })
  })

  it('preserves MCP program arguments and project selection while rejecting runner environment overrides', async () => {
    const { subject } = await manager()
    expect((await subject.create({ name: 'forwarded', command: 'npx', args: ['-y', 'server', '--prefix', './project'] })).managed_runtime).toBe('node')
    expect((await subject.create({ name: 'project', command: 'uvx', args: ['--from', './project', 'server', '--python', 'task-value'] })).managed_runtime).toBe('python')
    await expect(subject.create({ name: 'override', command: 'uvx', args: ['--from', './project', '--python', '/host/python', 'server'] })).rejects.toThrow(/自定义/)
  })

  it('imports fresh defaults but preserves explicit custom and restores existing entries without defaulting', async () => {
    const { subject } = await manager()
    const imported = await subject.importFromJson(JSON.stringify({ mcpServers: {
      node: { command: 'npx' }, python: { command: 'uvx' },
      custom: { command: 'npx', managed_runtime: null }, credential: { command: 'uvx', env: { TOKEN: 'own' } },
    } }))
    expect(imported.map(entry => entry.managed_runtime)).toEqual(['node', 'python', undefined, undefined])
    const restored = { ...imported[0], id: 'restored', managed_runtime: undefined }
    await subject.upsertById(restored, 'overwrite')
    expect(subject.get('restored')?.managed_runtime).toBeUndefined()
    expect(subject.toAgentConfig(imported[0])).not.toHaveProperty('managed_runtime')
  })

  it('includes the environment choice in the runtime revision digest independently of display fields', async () => {
    const { subject } = await manager()
    const original = await subject.create({ name: 'one', command: 'npx', managed_runtime: null })
    const before = subject.runtimeSemanticEntries()
    await subject.update(original.id, { managed_runtime: 'node' })
    expect(subject.runtimeSemanticEntries()).not.toEqual(before)
    expect(subject.runtimeSemanticEntries()).toEqual([expect.objectContaining({ id: original.id, managed_runtime: 'node' })])
  })
})
