import { describe, it, expect, vi } from 'vitest'
import { createExecutionCapabilitiesTool } from '../../src/manager/tools/execution-capabilities.js'
import { BUILTIN_WORKER_PERMISSIONS } from '../../src/workers/builtin/runtime.js'

function setup() {
  const current = { ...BUILTIN_WORKER_PERMISSIONS, tool_access: { ...BUILTIN_WORKER_PERMISSIONS.tool_access, task: true, desktop: true } }
  const old = { ...current, tool_access: { ...current.tool_access, shell: false, desktop: false } }
  const deps = {
    workerContext: () => ({ managerKey: 'm::s', principalPermissions: current }),
    workerImplSnapshot: () => ({ statuses: [{ impl: 'builtin', ready: true }] }),
    projectDocs: {
      ledger: { findWorker: vi.fn(async () => ({ managerKey: 'm::s', worker: { incarnations: [{ impl: 'builtin', workspace: '/fixture' }] } })) },
      readWorkerContext: vi.fn(async () => ({ principal_permissions: old })),
    },
    describeExecutionTools: vi.fn(() => ({ tools: ['Read'], mcp_servers: [], source: 'current_builtin_assembly', limitations: [], observed_at: 'now' })),
  }
  return { current, old, deps, tool: createExecutionCapabilitiesTool(deps as never) }
}
async function query(tool: ReturnType<typeof createExecutionCapabilitiesTool>, input: object) {
  const result = await tool.call(input, {} as never)
  expect(result.isError).toBe(false)
  return JSON.parse(result.output)
}
describe('execution capability evidence', () => {
  it.each([true, false])('omits the unimplemented category from new-worker awareness when remote_exec=%s', async (remoteExec) => {
    const { current, tool } = setup()
    current.tool_access.remote_exec = remoteExec
    const before = structuredClone(current)
    const result = await query(tool, {})

    expect(result.implementations.map((item: { impl: string }) => item.impl)).toEqual(['builtin', 'claude-code', 'codex'])
    for (const implementation of result.implementations) {
      expect(implementation.permissions.tool_access).toEqual({
        memory: false, messaging: false, task: false, mcp_skill: true,
        file_io: true, browser: true, shell: true, desktop: true,
      })
    }
    expect(current).toEqual(before)
    expect(BUILTIN_WORKER_PERMISSIONS.tool_access.remote_exec).toBe(false)
  })

  it.each(['builtin', 'claude-code', 'codex'])('omits the unimplemented category from existing %s worker awareness without changing its snapshot', async (impl) => {
    const { deps, old, tool } = setup()
    old.tool_access.remote_exec = true
    const before = structuredClone(old)
    deps.projectDocs.ledger.findWorker.mockResolvedValue({ managerKey: 'm::s', worker: { incarnations: [{ impl, workspace: '/fixture' }] } })
    const result = await query(tool, { worker_id: 'old-worker' })

    expect(result.permission_source).toBe('persisted_worker_principal')
    expect(result.implementations[0].permissions.tool_access).not.toHaveProperty('remote_exec')
    expect(result.implementations[0].permissions.tool_access).toMatchObject({ shell: false, desktop: false })
    expect(old).toEqual(before)
    expect(deps.describeExecutionTools).toHaveBeenCalledWith(impl, old)
  })

  it('separates dispatch permission from ready/worker capability', async () => {
    const { current, tool } = setup(); current.tool_access.task = false
    const result = await query(tool, { impl: 'builtin' })
    expect(result.can_spawn).toBe(false)
    expect(result.implementations[0]).toMatchObject({ ready: true, permissions: { tool_access: { file_io: true, desktop: true } } })
  })
  it('uses the existing worker snapshot after a new principal has more permission', async () => {
    const { deps, old, tool } = setup()
    const result = await query(tool, { worker_id: 'old-worker' })
    expect(result.permission_source).toBe('persisted_worker_principal')
    expect(result.implementations[0].permissions.tool_access).toMatchObject({ shell: false, desktop: false })
    expect(deps.describeExecutionTools).toHaveBeenCalledWith('builtin', old)
  })
  it('does not consult worker context or assembly before checking ownership', async () => {
    const { deps, tool } = setup()
    deps.projectDocs.ledger.findWorker.mockResolvedValue({ managerKey: 'other::s', worker: { incarnations: [] } })
    expect((await tool.call({ worker_id: 'foreign' }, {} as never)).isError).toBe(true)
    expect(deps.projectDocs.readWorkerContext).not.toHaveBeenCalled()
    expect(deps.describeExecutionTools).not.toHaveBeenCalled()
  })
  it('distinguishes unknown principal/CLI live tools from current configuration', async () => {
    const { deps, tool } = setup()
    deps.projectDocs.readWorkerContext.mockResolvedValue(undefined as never)
    deps.projectDocs.ledger.findWorker.mockResolvedValue({ managerKey: 'm::s', worker: { incarnations: [{ impl: 'codex', workspace: '/fixture' }] } })
    const result = await query(tool, { worker_id: 'old' })
    expect(result.principal_known).toBe(false)
    expect(result.implementations[0].permissions.tool_access).not.toHaveProperty('remote_exec')
    expect(result.implementations[0].permissions.tool_access.desktop).toBe(false)
    expect(result.implementations[0].current_incarnation_tools).toBe('unknown')
  })
})
