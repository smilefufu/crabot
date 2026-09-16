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
    expect(result.implementations[0].permissions.tool_access.desktop).toBe(false)
    expect(result.implementations[0].current_incarnation_tools).toBe('unknown')
  })
})
