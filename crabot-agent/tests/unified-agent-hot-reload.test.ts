import { describe, it, expect, vi } from 'vitest'
import { UnifiedAgent } from '../src/unified-agent.js'

function buildAgent(deps: {
  mcpConnector?: { reconnect?: ReturnType<typeof vi.fn> }
  agentHandler?: {
    updateSkills?: ReturnType<typeof vi.fn>
    updateSystemPrompt?: ReturnType<typeof vi.fn>
    updateExtra?: ReturnType<typeof vi.fn>
    updateSubagents?: ReturnType<typeof vi.fn>
    updateSdkEnv?: ReturnType<typeof vi.fn>
    updateTmpPageBaseUrl?: ReturnType<typeof vi.fn>
  }
  agentConfig?: Record<string, unknown>
  extra?: Record<string, unknown>
}): unknown {
  // Bypass UnifiedAgent's heavy constructor by skipping it.
  // We construct a bare object with only the fields handleUpdateConfig touches.
  const agent = Object.create(UnifiedAgent.prototype) as Record<string, unknown>
  agent.agentConfig = deps.agentConfig ?? { mcp_servers: [], skills: [] }
  if (deps.mcpConnector) agent.mcpConnector = deps.mcpConnector
  if (deps.agentHandler) agent.agentHandler = deps.agentHandler
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

  it('skills 变更触发 agentHandler.updateSkills（不再标 restartRequired）', async () => {
    const updateSkills = vi.fn()
    const updateSystemPrompt = vi.fn()
    const agent = buildAgent({ agentHandler: { updateSkills, updateSystemPrompt } })

    const newSkills = [{ id: 's1', name: 'foo', description: 'bar', content: 'body' }]
    const result = await (agent as { handleUpdateConfig: (p: unknown) => Promise<{ changed_fields: string[]; restart_required: boolean }> })
      .handleUpdateConfig({ skills: newSkills })

    expect(updateSkills).toHaveBeenCalledWith(newSkills)
    expect(result.changed_fields).toContain('skills')
    expect(result.restart_required).toBe(false)
  })

  it('system_prompt 变更触发 agentHandler.updateSystemPrompt', async () => {
    const updateSkills = vi.fn()
    const updateSystemPrompt = vi.fn()
    const agent = buildAgent({ agentHandler: { updateSkills, updateSystemPrompt } })

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

  it('system_prompt 变更触发 updateLlmClients（无 skipWorkerRebuild 参数；handler 不重建）', async () => {
    // 2026-05-21 起 updateLlmClients 永不重建 handler；签名去掉 skipWorkerRebuild。
    // worker 内已通过 updateSystemPrompt 热更新；updateLlmClients 仅同步 sdkEnv（如有）。
    const updateSkills = vi.fn()
    const updateSystemPrompt = vi.fn()
    const agent = buildAgent({ agentHandler: { updateSkills, updateSystemPrompt } })
    const updateLlmClients = vi.fn().mockResolvedValue(undefined)
    ;(agent as { updateLlmClients: typeof updateLlmClients }).updateLlmClients = updateLlmClients

    await (agent as { handleUpdateConfig: (p: unknown) => Promise<unknown> })
      .handleUpdateConfig({ system_prompt: 'new personality' })

    expect(updateLlmClients).toHaveBeenCalledTimes(1)
    // 现在签名是 updateLlmClients(modelConfig)，没有 options 第二参
    expect(updateLlmClients.mock.calls[0]).toHaveLength(1)
  })

  it('subagents 变更走 handler.updateSubagents 热更新（不重建 handler）', async () => {
    const updateSubagents = vi.fn()
    const agent = buildAgent({
      agentHandler: { updateSubagents },
      agentConfig: { mcp_servers: [], skills: [], subagents: [{ name: 'old' }] },
    })
    const updateLlmClients = vi.fn().mockResolvedValue(undefined)
    ;(agent as { updateLlmClients: typeof updateLlmClients }).updateLlmClients = updateLlmClients

    const newList = [{ id: 'x', name: 'new_writer', description: 'd', when_to_use: 'w', role: 'r', workflow: 'w', deliverables: 'd', allowed_mcp_server_ids: [], allowed_skill_ids: [], max_turns: 10 }]
    await (agent as { handleUpdateConfig: (p: unknown) => Promise<{ changed_fields: string[]; restart_required: boolean }> })
      .handleUpdateConfig({ subagents: newList })

    expect(updateSubagents).toHaveBeenCalledWith(newList)
  })

  it('extra 变更触发 agentHandler.updateExtra（防止 progress_digest_interval_seconds 等不生效）', async () => {
    const updateExtra = vi.fn()
    const agent = buildAgent({
      agentHandler: { updateExtra },
      extra: { progress_digest_interval_seconds: 60 },
    })

    const result = await (agent as { handleUpdateConfig: (p: unknown) => Promise<{ changed_fields: string[]; restart_required: boolean }> })
      .handleUpdateConfig({ extra: { progress_digest_interval_seconds: 30 } })

    expect(updateExtra).toHaveBeenCalledWith({ progress_digest_interval_seconds: 30 })
    expect(result.changed_fields).toContain('extra')
    expect(result.restart_required).toBe(false)
  })

  it('model_config 变更触发 updateLlmClients（走热更新，不重建 handler）', async () => {
    // 2026-05-21 起 modelConfig 变更走 handler.updateSdkEnv 热更，不重建 handler 实例。
    const updateSkills = vi.fn()
    const updateSystemPrompt = vi.fn()
    const agent = buildAgent({ agentHandler: { updateSkills, updateSystemPrompt } })
    const updateLlmClients = vi.fn().mockResolvedValue(undefined)
    ;(agent as { updateLlmClients: typeof updateLlmClients }).updateLlmClients = updateLlmClients

    await (agent as { handleUpdateConfig: (p: unknown) => Promise<unknown> })
      .handleUpdateConfig({ model_config: { worker: { endpoint: 'https://x', apikey: 'k', model_id: 'm', format: 'anthropic', provider_id: 'p' } } })

    expect(updateLlmClients).toHaveBeenCalledTimes(1)
    // 签名是 updateLlmClients(modelConfig)，单参数
    expect(updateLlmClients.mock.calls[0]).toHaveLength(1)
  })

  it('tmp_page_base_url 变更同步到现有 handler', async () => {
    const updateTmpPageBaseUrl = vi.fn()
    const agent = buildAgent({
      agentHandler: { updateTmpPageBaseUrl },
      agentConfig: { mcp_servers: [], skills: [] },
    })

    const result = await (agent as { handleUpdateConfig: (p: unknown) => Promise<{ changed_fields: string[] }> })
      .handleUpdateConfig({ tmp_page_base_url: 'https://pages.example.com' })

    expect(updateTmpPageBaseUrl).toHaveBeenCalledWith('https://pages.example.com')
    expect(result.changed_fields).toContain('tmp_page_base_url')
  })

  it('首次配置补推时先保存 tmp_page_base_url，再进入 handler 创建路径', async () => {
    const agent = buildAgent({
      agentConfig: { mcp_servers: [], skills: [], model_config: {} },
    }) as {
      agentConfig: { tmp_page_base_url?: string }
      updateLlmClients: ReturnType<typeof vi.fn>
      handleUpdateConfig: (p: unknown) => Promise<unknown>
    }
    const observedBaseUrls: Array<string | undefined> = []
    agent.updateLlmClients = vi.fn(async () => {
      observedBaseUrls.push(agent.agentConfig.tmp_page_base_url)
    })

    await agent.handleUpdateConfig({
      model_config: {
        powerful: {
          endpoint: 'https://llm.example.com',
          apikey: 'k',
          model_id: 'm',
          format: 'anthropic',
          provider_id: 'p',
        },
      },
      tmp_page_base_url: 'https://pages.example.com',
    })

    expect(observedBaseUrls).toEqual(['https://pages.example.com'])
  })
})
