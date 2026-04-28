import { describe, it, expect, vi } from 'vitest'
import { UnifiedAgent } from '../src/unified-agent.js'

function buildAgent(deps: {
  mcpConnector?: { reconnect?: ReturnType<typeof vi.fn> }
  workerHandler?: {
    updateSkills?: ReturnType<typeof vi.fn>
    updateSystemPrompt?: ReturnType<typeof vi.fn>
    updateExtra?: ReturnType<typeof vi.fn>
  }
  agentConfig?: Record<string, unknown>
  extra?: Record<string, unknown>
}): unknown {
  // Bypass UnifiedAgent's heavy constructor by skipping it.
  // We construct a bare object with only the fields handleUpdateConfig touches.
  const agent = Object.create(UnifiedAgent.prototype) as Record<string, unknown>
  agent.agentConfig = deps.agentConfig ?? { mcp_servers: [], skills: [] }
  if (deps.mcpConnector) agent.mcpConnector = deps.mcpConnector
  if (deps.workerHandler) agent.workerHandler = deps.workerHandler
  agent.extra = deps.extra ?? {}
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

  it('system_prompt 变更触发 updateLlmClients（Front 重建路径）', async () => {
    // 此 test 锁定 review feedback I-2 修复：system_prompt 变更必须经过 updateLlmClients
    // 让 Front 重建（Front prompt closure 嵌入了 personality）
    const updateSkills = vi.fn()
    const updateSystemPrompt = vi.fn()
    const agent = buildAgent({ workerHandler: { updateSkills, updateSystemPrompt } })
    // Spy on updateLlmClients to verify it's invoked with correct options
    const updateLlmClients = vi.fn().mockResolvedValue(undefined)
    ;(agent as { updateLlmClients: typeof updateLlmClients }).updateLlmClients = updateLlmClients

    await (agent as { handleUpdateConfig: (p: unknown) => Promise<unknown> })
      .handleUpdateConfig({ system_prompt: 'new personality' })

    expect(updateLlmClients).toHaveBeenCalledTimes(1)
    const callArg = updateLlmClients.mock.calls[0][1] as { forceFrontRebuild: boolean; skipWorkerRebuild: boolean }
    expect(callArg.forceFrontRebuild).toBe(true)
    expect(callArg.skipWorkerRebuild).toBe(true) // worker 已通过 updateSystemPrompt 热更新，不该重建
  })

  it('skills 变更走 Front 重建但跳过 Worker 重建（防鬼存）', async () => {
    // 此 test 锁定 review feedback I-1 修复：skills 变更不重建 Worker handler
    // （否则 in-flight task 的 activeTasks 会被新 worker handler 丢失）
    const updateSkills = vi.fn()
    const updateSystemPrompt = vi.fn()
    const agent = buildAgent({ workerHandler: { updateSkills, updateSystemPrompt } })
    const updateLlmClients = vi.fn().mockResolvedValue(undefined)
    ;(agent as { updateLlmClients: typeof updateLlmClients }).updateLlmClients = updateLlmClients

    await (agent as { handleUpdateConfig: (p: unknown) => Promise<unknown> })
      .handleUpdateConfig({ skills: [{ id: 's1', name: 'foo', description: 'bar', content: '' }] })

    expect(updateLlmClients).toHaveBeenCalledTimes(1)
    const callArg = updateLlmClients.mock.calls[0][1] as { forceFrontRebuild: boolean; skipWorkerRebuild: boolean }
    expect(callArg.forceFrontRebuild).toBe(true)
    expect(callArg.skipWorkerRebuild).toBe(true)
  })

  it('extra 变更触发 workerHandler.updateExtra（防止 progress_digest_interval_seconds 等不生效）', async () => {
    const updateExtra = vi.fn()
    const agent = buildAgent({
      workerHandler: { updateExtra },
      extra: { progress_digest_interval_seconds: 60 },
    })

    const result = await (agent as { handleUpdateConfig: (p: unknown) => Promise<{ changed_fields: string[]; restart_required: boolean }> })
      .handleUpdateConfig({ extra: { progress_digest_interval_seconds: 30 } })

    expect(updateExtra).toHaveBeenCalledWith({ progress_digest_interval_seconds: 30 })
    expect(result.changed_fields).toContain('extra')
    expect(result.restart_required).toBe(false)
  })

  it('model_config 变更时不跳过 Worker 重建', async () => {
    // model_config 真正变化时才需要重建 Worker（SDK env 改变）
    const updateSkills = vi.fn()
    const updateSystemPrompt = vi.fn()
    const agent = buildAgent({ workerHandler: { updateSkills, updateSystemPrompt } })
    const updateLlmClients = vi.fn().mockResolvedValue(undefined)
    ;(agent as { updateLlmClients: typeof updateLlmClients }).updateLlmClients = updateLlmClients

    await (agent as { handleUpdateConfig: (p: unknown) => Promise<unknown> })
      .handleUpdateConfig({ model_config: { worker: { endpoint: 'https://x', apikey: 'k', model_id: 'm', format: 'anthropic', provider_id: 'p' } } })

    expect(updateLlmClients).toHaveBeenCalledTimes(1)
    const callArg = updateLlmClients.mock.calls[0][1] as { forceFrontRebuild: boolean; skipWorkerRebuild: boolean }
    expect(callArg.skipWorkerRebuild).toBe(false) // model_config 变更必须重建 Worker
  })
})
