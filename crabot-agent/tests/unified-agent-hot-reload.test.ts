import { describe, it, expect, vi } from 'vitest'
import { UnifiedAgent } from '../src/unified-agent.js'

function buildAgent(deps: {
  mcpConnector?: { reconnect?: ReturnType<typeof vi.fn> }
  workerHandler?: {
    updateSkills?: ReturnType<typeof vi.fn>
    updateSystemPrompt?: ReturnType<typeof vi.fn>
  }
  agentConfig?: Record<string, unknown>
}): unknown {
  // Bypass UnifiedAgent's heavy constructor by skipping it.
  // We construct a bare object with only the fields handleUpdateConfig touches.
  const agent = Object.create(UnifiedAgent.prototype) as Record<string, unknown>
  agent.agentConfig = deps.agentConfig ?? { mcp_servers: [], skills: [] }
  if (deps.mcpConnector) agent.mcpConnector = deps.mcpConnector
  if (deps.workerHandler) agent.workerHandler = deps.workerHandler
  // 'config' is referenced for moduleId logging — provide minimal stub
  agent.config = { moduleId: 'test-agent' }
  // 'roles' is consulted by updateLlmClients (called when skills/model_config change).
  // Empty set safely no-ops both the front and worker rebuild branches.
  agent.roles = new Set()
  return agent
}

describe('UnifiedAgent.handleUpdateConfig — hot reload', () => {
  it('mcp_servers 变更触发 mcpConnector.reconnect（不再标 restartRequired）', async () => {
    const reconnect = vi.fn().mockResolvedValue(undefined)
    const agent = buildAgent({ mcpConnector: { reconnect } })

    const result = await (agent as { handleUpdateConfig: (p: unknown) => Promise<{ changed_fields: string[]; restart_required: boolean }> })
      .handleUpdateConfig({
        mcp_servers: [{ name: 'A', transport: 'stdio', command: 'echo' }],
      })

    expect(reconnect).toHaveBeenCalledWith([
      { name: 'A', transport: 'stdio', command: 'echo' },
    ])
    expect(result.changed_fields).toContain('mcp_servers')
    expect(result.restart_required).toBe(false)
  })

  it('skills 变更触发 workerHandler.updateSkills（不再标 restartRequired）', async () => {
    const updateSkills = vi.fn()
    const updateSystemPrompt = vi.fn()
    const agent = buildAgent({ workerHandler: { updateSkills, updateSystemPrompt } })

    const newSkills = [{ id: 's1', name: 'foo', description: 'bar', content: 'body' }]
    const result = await (agent as { handleUpdateConfig: (p: unknown) => Promise<{ changed_fields: string[]; restart_required: boolean }> })
      .handleUpdateConfig({ skills: newSkills })

    expect(updateSkills).toHaveBeenCalledWith(newSkills)
    expect(result.changed_fields).toContain('skills')
    expect(result.restart_required).toBe(false)
  })

  it('system_prompt 变更触发 workerHandler.updateSystemPrompt', async () => {
    const updateSkills = vi.fn()
    const updateSystemPrompt = vi.fn()
    const agent = buildAgent({ workerHandler: { updateSkills, updateSystemPrompt } })

    const result = await (agent as { handleUpdateConfig: (p: unknown) => Promise<{ changed_fields: string[]; restart_required: boolean }> })
      .handleUpdateConfig({ system_prompt: 'new prompt' })

    expect(updateSystemPrompt).toHaveBeenCalledWith('new prompt')
    expect(result.changed_fields).toContain('system_prompt')
    expect(result.restart_required).toBe(false)
  })

  it('mcpConnector.reconnect 失败时 handleUpdateConfig 抛错', async () => {
    const reconnect = vi.fn().mockRejectedValue(new Error('connect fail'))
    const agent = buildAgent({ mcpConnector: { reconnect } })

    await expect(
      (agent as { handleUpdateConfig: (p: unknown) => Promise<unknown> })
        .handleUpdateConfig({ mcp_servers: [{ name: 'A', transport: 'stdio', command: 'echo' }] }),
    ).rejects.toThrow('connect fail')
  })
})
