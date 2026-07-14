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
  skillEnabled?: Array<{ id: string; name: string; enabled: boolean; skill_dir?: string }>
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
      description: '',
      skill_dir: `/tmp/skills/${s.id}`,
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
    // 图像 slot 解析：本测试默认未配置生图模型
    resolveImageConfig: async () => ({ available: false, reason: 'not_configured' }),
    // tmp_page_base_url 注入需读全局设置的 public_base_url（默认未配置）
    getGlobalConfig: () => ({}),
  }
  // subagents 现也由 get_agent_config 下发（buildSubAgentConfigsForPush 调 subAgentManager）；
  // 本测试只验 mcp/skills，stub 成无 enabled subagent 即可。
  admin.subAgentManager = {
    listEnabled: () => [],
  }
  admin.config = { moduleId: 'test-admin' }
  // tmp_page_base_url 注入需读 web_port 退化为本地地址
  admin.adminConfig = { web_port: 3000 }
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
        { id: 'skill-1', name: 'foo', enabled: true, skill_dir: '/skills/foo' },
        { id: 'skill-2', name: 'bar', enabled: false, skill_dir: '/skills/bar' }, // disabled
      ],
      agentConfig: { skill_ids: ['nonexistent-skill-id'] }, // deprecated 字段被忽略
    })

    const result = await (admin as { handleGetAgentConfig: (p: unknown) => Promise<{ config: { skills: Array<{ name: string }> } }> })
      .handleGetAgentConfig({ instance_id: 'test-agent' })

    const names = result.config.skills.map((s) => s.name)
    expect(names).toEqual(['foo'])
  })

  it('skill_dir 缺失的 enabled skill 被过滤（历史脏数据防御）', async () => {
    const admin = buildAdmin({
      skillEnabled: [
        { id: 'skill-1', name: 'good', enabled: true, skill_dir: '/skills/good' },
        { id: 'skill-2', name: 'legacy-no-dir', enabled: true }, // skill_dir 缺失（旧格式脏数据）
      ],
      agentConfig: {},
    })

    const result = await (admin as { handleGetAgentConfig: (p: unknown) => Promise<{ config: { skills: Array<{ name: string }> } }> })
      .handleGetAgentConfig({ instance_id: 'test-agent' })

    const names = result.config.skills.map((s) => s.name)
    expect(names).toEqual(['good'])
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
