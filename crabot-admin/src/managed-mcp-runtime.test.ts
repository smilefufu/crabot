import { afterEach, describe, expect, it, vi } from 'vitest'
import * as childProcess from 'node:child_process'
import { resolveManagedMcpConfig } from './managed-mcp-runtime.js'
import type { MCPServerRegistryEntry } from './mcp-skill-manager.js'

vi.mock('node:child_process', () => ({ execFile: vi.fn() }))

const entry = (id: string): MCPServerRegistryEntry => ({ id, name: id, transport: 'stdio', command: 'npx',
  managed_runtime: 'node', env: { MCP_TOKEN: 'own-mcp-token' }, enabled: true, is_builtin: false,
  is_essential: false, can_disable: true, created_at: '', updated_at: '' })
afterEach(() => { vi.resetAllMocks(); vi.unstubAllEnvs() })

describe('async managed MCP preparation', () => {
  it('deduplicates a concurrent preparation without sending MCP or Admin credentials to the helper', async () => {
    vi.stubEnv('CRABOT_ADMIN_PASSWORD', 'secret-admin-password')
    vi.stubEnv('CRABOT_CORE_AGENT_RUNTIME_BEARER', 'secret-internal-bearer')
    vi.stubEnv('APPLE_SIGNING_SECRET', 'secret-signing')
    let callback: any
    const spawn = vi.mocked(childProcess.execFile).mockImplementation(((...args: any[]) => {
      callback = args[3]
      expect(args[1].join(' ')).not.toMatch(/own-mcp-token|secret/)
      expect(args[2]).toMatchObject({ timeout: 130_000, windowsHide: true })
      expect(args[2].env).not.toHaveProperty('CRABOT_ADMIN_PASSWORD')
      expect(args[2].env).not.toHaveProperty('CRABOT_CORE_AGENT_RUNTIME_BEARER')
      expect(args[2].env).not.toHaveProperty('APPLE_SIGNING_SECRET')
    }) as any)
    const server = entry('deduplicate')
    const config = { ...server, args: ['--offline', 'probe'] }
    const first = resolveManagedMcpConfig('/product', '/data', server, config)
    const second = resolveManagedMcpConfig('/product', '/data', server, config)
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(1))
    callback(null, JSON.stringify({ command: '/bundled/node', args: ['npx-cli.js'], env: { PATH: '/managed/bin' } }))
    const [a, b] = await Promise.all([first, second])
    expect(a).toEqual(b)
    expect(a).toMatchObject({ id: server.id, name: server.name, command: '/bundled/node',
      args: ['npx-cli.js', '--offline', 'probe'], env: { MCP_TOKEN: 'own-mcp-token', PATH: '/managed/bin' } })
  })

  it('retries a failed preparation, keeps other custom MCPs available and never exposes helper output', async () => {
    const spawn = vi.mocked(childProcess.execFile).mockImplementation(((...args: any[]) => {
      args[3](new Error('private-helper-output'), '', 'secret-stderr')
    }) as any)
    const server = entry('retry')
    const custom = { ...server, managed_runtime: undefined }
    expect(await resolveManagedMcpConfig('/product', '/data', custom, custom)).toBe(custom)
    for (let i = 0; i < 2; i++) {
      await expect(resolveManagedMcpConfig('/product', '/data', server, server)).rejects.toThrow('CRABOT_MCP_ENV_PREPARE_FAILED')
    }
    expect(spawn).toHaveBeenCalledTimes(2)
    expect(server).toMatchObject({ enabled: true, command: 'npx', managed_runtime: 'node' })
  })
})
