import { afterEach, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createWorkspaceGitMcpServerConfig, createWorkspaceGitTool, workspaceGitBridgeEnv, WORKSPACE_GIT_CONTEXT_ENV } from '../../src/workers/workspace-git-capability.js'
import { workspaceGitContextFromEnv } from '../../src/mcp/workspace-git-stdio-server.js'
import { WorkspaceGitInspector } from '../../src/workers/harness/workspace-git-inspector.js'

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn() })

describe('workspace Git stdio MCP bridge', () => {
  it('real stdio exposes exactly one read-only operation with a fixed immutable binding', async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'git-stdio-'))
    cleanup.push(() => fs.rm(root, { recursive: true, force: true }))
    const runtime = await fs.mkdtemp(path.join(tmpdir(), 'git-stdio-runtime-'))
    cleanup.push(() => fs.rm(runtime, { recursive: true, force: true }))
    const baseline = (await new WorkspaceGitInspector().inspect(root)).current
    const binding = { worker_id: 'w-bound', incarnation_id: 'inc-bound', workspace_root: root, baseline }
    const config = createWorkspaceGitMcpServerConfig()
    const client = new Client({ name: 'git-stdio-test', version: '1.0.0' }, { capabilities: {} })
    cleanup.push(() => client.close())
    await client.connect(new StdioClientTransport({
      command: config.command!, args: config.args,
      env: { PATH: process.env.PATH!, HOME: process.env.HOME!, ...await workspaceGitBridgeEnv(runtime, 1, binding),
        CRABOT_CORE_AGENT_RUNTIME_BEARER: 'core-sentinel', CRABOT_ADMIN_TOKEN: 'admin-sentinel' },
    }))
    const tools = (await client.listTools()).tools
    expect(tools.map((tool) => tool.name)).toEqual(['inspect_workspace_git'])
    expect(tools[0]).toMatchObject({ annotations: { readOnlyHint: true }, inputSchema: { additionalProperties: false, properties: {} } })
    const result = await client.callTool({ name: 'inspect_workspace_git', arguments: {} })
    expect(result.isError).toBe(false)
    const content = result.content as Array<{ type: string; text: string }>
    const actual = JSON.parse(content[0].text)
    expect(actual).toMatchObject({ worker_id: 'w-bound', incarnation_id: 'inc-bound', git: { baseline, comparison: 'not_repository' } })
    expect(content[0].text).not.toContain('sentinel')
    for (const input of [{ worker_id: 'other' }, { path: '/' }, { command: 'commit' }, { env: {} }, { incarnation_id: 'other' }]) {
      expect((await client.callTool({ name: 'inspect_workspace_git', arguments: input })).isError).toBe(true)
    }
    await expect(client.callTool({ name: 'arbitrary_rpc', arguments: {} })).rejects.toThrow('unknown workspace Git operation')
    const builtin = createWorkspaceGitTool(binding)
    for (const invalid of [null, [], '', 1]) expect((await builtin.call(invalid as never, {} as never)).isError).toBe(true)
    binding.worker_id = 'changed-after-assembly'
    expect(JSON.parse((await builtin.call({}, {} as never)).output)).toMatchObject({ worker_id: 'w-bound', git: { comparison: 'not_repository', baseline } })
    expect(await fs.readdir(root)).toEqual([])
  })

  it('rejects missing or malformed launch identity rather than inferring it from the cwd', async () => {
    const runtime = await fs.mkdtemp(path.join(tmpdir(), 'git-stdio-runtime-'))
    cleanup.push(() => fs.rm(runtime, { recursive: true, force: true }))
    await expect(workspaceGitContextFromEnv({})).rejects.toThrow('assembly-bound')
    await expect(workspaceGitContextFromEnv(await workspaceGitBridgeEnv(runtime, 1, { worker_id: 'w', incarnation_id: 'i', workspace_root: '.' }))).rejects.toThrow('assembly-bound')
  })

  it('keeps long baselines out of the environment and retains a separate private file per incarnation', async () => {
    const runtime = await fs.mkdtemp(path.join(tmpdir(), 'git-stdio-runtime-'))
    cleanup.push(() => fs.rm(runtime, { recursive: true, force: true }))
    const baseline = (await new WorkspaceGitInspector().inspect(runtime)).current
    const binding = { worker_id: 'w', incarnation_id: 'i-1', workspace_root: runtime, baseline: {
      ...baseline, state: { status: 'repository' as const, repository_root: runtime, scope: 'repository' as const,
        linked_worktree: false, workspace_ignored: false, branch: 'main', head: null, dirty: true,
        change_count: 100, unmerged_count: 0, changes_truncated: false,
        changes: Array.from({ length: 100 }, (_, i) => ({ path: `${i}/${'nested/'.repeat(450)}file`, index_status: '?', worktree_status: '?' })) },
    } }
    expect(Buffer.byteLength(JSON.stringify(binding))).toBeGreaterThan(128 * 1024)
    const env = await workspaceGitBridgeEnv(runtime, 1, binding)
    expect(JSON.stringify(env).length).toBeLessThan(1024)
    expect((await fs.stat(env[WORKSPACE_GIT_CONTEXT_ENV])).mode & 0o777).toBe(0o600)
    await workspaceGitBridgeEnv(runtime, 2, { ...binding, incarnation_id: 'i-2' })
    expect(await workspaceGitContextFromEnv(env)).toEqual(binding)
    const file = await fs.open(env[WORKSPACE_GIT_CONTEXT_ENV], 'r+')
    await file.truncate(33 * 1024 * 1024)
    await file.close()
    await expect(workspaceGitContextFromEnv(env)).rejects.toThrow('file limit')
  })
})
