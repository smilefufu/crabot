import { describe, it, expect } from 'vitest'

// 这是一个集成测试。AgentManager 是重对象，我们用 Object.create 跳过构造函数 +
// 注入 mock 子组件来验证 handleGetAgentConfig 的拼装逻辑。
//
// 关键断言：
// 1. mcp_servers 来自 mcpServerManager.list().filter(s => s.enabled)，
//    不再读 config.mcp_server_ids
// 2. skills 来自 skillManager.list().filter(s => s.enabled)，
//    不再读 config.skill_ids
// 3. 即使 config.mcp_server_ids 含一个真实 enabled MCP id，结果也不会因为
//    没在 mcp_server_ids 里就被排除（即"忽略 mcp_server_ids"）

import { AdminModule } from '../src/index.js'

function buildAdmin(deps: {
  mcpEnabled?: Array<{ id: string; name: string; enabled: boolean }>
  skillEnabled?: Array<{ id: string; name: string; enabled: boolean }>
  agentConfig?: Record<string, unknown>
}): unknown {
  const admin = Object.create(AdminModule.prototype) as Record<string, unknown>
  admin.mcpServerManager = {
    list: () => deps.mcpEnabled ?? [],
    get: (id: string) =>
      (deps.mcpEnabled ?? []).find((s) => s.id === id),
    toAgentConfig: (s: { id: string; name: string }) => ({
      name: s.name,
      transport: 'stdio',
      command: 'echo',
      env: {},
    }),
  }
  admin.skillManager = {
    list: () => deps.skillEnabled ?? [],
    get: (id: string) =>
      (deps.skillEnabled ?? []).find((s) => s.id === id),
    toAgentConfig: (s: { id: string; name: string }) => ({
      id: s.id,
      name: s.name,
      content: 'body',
    }),
  }
  admin.browserManager = { cdpUrl: 'http://localhost:9222' }
  admin.agentManager = {
    getInstance: () => ({
      instance_id: 'test-agent',
      role: 'worker',
      ...deps.agentConfig,
    }),
    getConfig: () => ({
      model_config: {},
      ...(deps.agentConfig ?? {}),
    }),
    getImplementation: () => ({ model_roles: [] }),
  }
  // model_config 解析逻辑需要的辅助 stub
  admin.modelProviderManager = {
    buildConnectionInfo: async () => null,
    resolveModelConfig: async () => {
      throw new Error('no global llm')
    },
  }
  admin.config = { moduleId: 'test-admin' }
  return admin
}

describe('handleGetAgentConfig — global enable layer', () => {
  it('mcp_servers 等于全部 enabled MCP（不读 config.mcp_server_ids）', async () => {
    const admin = buildAdmin({
      mcpEnabled: [
        { id: 'mcp-A', name: 'A', enabled: true },
        { id: 'mcp-B', name: 'B', enabled: true },
        { id: 'mcp-C', name: 'C', enabled: false }, // disabled
      ],
      agentConfig: { mcp_server_ids: ['nonexistent-id'] }, // deprecated 字段被忽略
    })

    const result = await (admin as { handleGetAgentConfig: (p: unknown) => Promise<{ config: { mcp_servers: Array<{ name: string }> } }> })
      .handleGetAgentConfig({ instance_id: 'test-agent' })

    const names = result.config.mcp_servers.map((s) => s.name).sort()
    expect(names).toEqual(['A', 'B'])
  })

  it('skills 等于全部 enabled skill（不读 config.skill_ids）', async () => {
    const admin = buildAdmin({
      skillEnabled: [
        { id: 'skill-1', name: 'foo', enabled: true },
        { id: 'skill-2', name: 'bar', enabled: false }, // disabled
      ],
      agentConfig: { skill_ids: ['nonexistent-skill-id'] }, // deprecated 字段被忽略
    })

    const result = await (admin as { handleGetAgentConfig: (p: unknown) => Promise<{ config: { skills: Array<{ name: string }> } }> })
      .handleGetAgentConfig({ instance_id: 'test-agent' })

    const names = result.config.skills.map((s) => s.name)
    expect(names).toEqual(['foo'])
  })

  it('全部 disabled 时 mcp_servers/skills 为空', async () => {
    const admin = buildAdmin({
      mcpEnabled: [{ id: 'mcp-A', name: 'A', enabled: false }],
      skillEnabled: [{ id: 'skill-1', name: 'foo', enabled: false }],
      agentConfig: {},
    })

    const result = await (admin as { handleGetAgentConfig: (p: unknown) => Promise<{ config: { mcp_servers: unknown[]; skills: unknown[] } }> })
      .handleGetAgentConfig({ instance_id: 'test-agent' })

    expect(result.config.mcp_servers).toEqual([])
    expect(result.config.skills).toEqual([])
  })
})
