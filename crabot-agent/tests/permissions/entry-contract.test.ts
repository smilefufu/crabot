import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { UnifiedAgent } from '../../src/unified-agent.js'
import { BUILTIN_WORKER_PERMISSIONS, narrowWorkerPermissions } from '../../src/workers/builtin/runtime.js'
import { buildWorkerTools } from '../../src/manager/tools/worker-tools.js'
import type { ResolvedPermissions } from '../../src/types.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))) })
async function fixture(access: 'read' | 'readwrite' = 'read') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'crabot-entry-'))
  roots.push(root)
  const workspace = path.join(root, 'workspace')
  await fs.mkdir(workspace)
  const principal: ResolvedPermissions = {
    ...BUILTIN_WORKER_PERMISSIONS,
    tool_access: { ...BUILTIN_WORKER_PERMISSIONS.tool_access, task: false },
    storage: { workspace_path: workspace, access },
  }
  const agent = Object.create(UnifiedAgent.prototype) as any
  Object.assign(agent, {
    config: { moduleId: 'fixture' },
    agentConfig: { skills: [{ id: 'tmp-page', name: 'tmp-page', description: 'fixture', skill_dir: root }], subagents: [] },
    agentHandler: { createBuiltinBgToolOptions: () => undefined },
    mcpConnector: { getAllTools: () => [] }, knownSecrets: [],
  })
  return { root, workspace, principal, tools: agent.buildBuiltinWorkerTools({ worker_id: 'fixture', workspace: { root: workspace }, principal_permissions: principal }) }
}

describe('production entry authorization contract', () => {
  it('retains the immutable principal file scope', async () => {
    const { principal } = await fixture()
    expect(narrowWorkerPermissions(BUILTIN_WORKER_PERMISSIONS, principal).storage).toEqual(principal.storage)
  })
  it.each(['read', 'readwrite'] as const)('direct Write rejects an outside path under %s', async access => {
    const { root, tools } = await fixture(access)
    const file = path.join(root, 'outside.txt')
    const result = await tools.find((tool: any) => tool.name === 'Write').call({ file_path: file, content: 'fixture' }, {})
    expect(result.isError).toBe(true)
    expect(await fs.stat(file).then(() => true, () => false)).toBe(false)
  })
  it('read-only scope rejects an in-scope write without a side effect', async () => {
    const { workspace, tools } = await fixture()
    const file = path.join(workspace, 'new.txt')
    const result = await tools.find((tool: any) => tool.name === 'Write').call({ file_path: file, content: 'fixture' }, {})
    expect(result.isError).toBe(true)
    expect(await fs.stat(file).then(() => true, () => false)).toBe(false)
  })
  it('task=false does not prohibit owned Manager dispatch', async () => {
    const { principal } = await fixture()
    const spawnWorker = vi.fn(async () => ({ worker_id: 'fixture', incarnations: [] }))
    const tools = buildWorkerTools({ harness: { spawnWorker } as never, context: () => ({ managerKey: 'audit::s', principalPermissions: principal, reportTo: { channel_id: 'audit', session_id: 's' } }) })
    const result = await tools.find(tool => tool.name === 'spawn_worker')!.call({ title: 'fixture', prompt: 'fixture' }, {} as never)
    expect(result.isError).toBe(false)
    expect(spawnWorker).toHaveBeenCalledOnce()
  })
  it('missing principal cannot recover the broad fixed Worker profile', () => {
    const effective = narrowWorkerPermissions(BUILTIN_WORKER_PERMISSIONS, null)
    expect(effective.tool_access.file_io).toBe(false)
    expect(effective.tool_access.shell).toBe(false)
    expect(effective.tool_access.mcp_skill).toBe(false)
  })
})
