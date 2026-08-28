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
      instance_id: 'crabot-agent',
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
    resolveModelConfig: async () => ({
      endpoint: 'https://example.test', apikey: 'test-key', model_id: 'test-model',
      format: 'openai', provider_id: 'test-provider',
    }),
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
  admin.configMutationCoordinator = {
    readCommittedEpoch: async () => ({ revision: 1, generation: 0 }),
  }
  // P6-B：runtime config 现携带 worker_implementations desired config；stub 成安全初始值。
  admin.workerImplementationStore = {
    load: async () => ({
      revision: 1,
      default_impl: 'builtin',
      implementations: {
        builtin: { enabled: true },
        'claude-code': { enabled: false },
        codex: { enabled: false },
      },
    }),
  }
  admin.workerConnectionRevisionSigner = { compute: async () => 'opaque-test-revision' }
  admin.rpcClient = {
    callModuleManagerSensitive: async () => ({ verified: true }),
    callModuleManager: async () => ({ module_id: 'crabot-agent', module_type: 'agent', port: 19002 }),
  }
  return admin
}

async function pullCoreConfig(admin: unknown): Promise<{ config: { agent_config: { mcp_servers: Array<{ name: string }>; skills: Array<{ name: string }> } } }> {
  return (admin as {
    handleGetAgentConfig: (p: unknown, context: unknown) => Promise<{ config: { agent_config: { mcp_servers: Array<{ name: string }>; skills: Array<{ name: string }> } } }>
  }).handleGetAgentConfig({ instance_id: 'crabot-agent' }, { authorizationBearer: 'runtime' })
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

    const result = await pullCoreConfig(admin)

    const names = result.config.agent_config.mcp_servers.map((s) => s.name).sort()
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

    const result = await pullCoreConfig(admin)

    const names = result.config.agent_config.skills.map((s) => s.name)
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

    const result = await pullCoreConfig(admin)

    const names = result.config.agent_config.skills.map((s) => s.name)
    expect(names).toEqual(['good'])
  })

  it('全部 disabled 时 mcp_servers/skills 为空', async () => {
    const admin = buildAdmin({
      mcpEnabled: [{ id: 'mcp-A', name: 'A', enabled: false }],
      skillEnabled: [{ id: 'skill-1', name: 'foo', enabled: false }],
      agentConfig: {},
    })

    const result = await pullCoreConfig(admin)

    expect(result.config.agent_config.mcp_servers).toEqual([])
    expect(result.config.agent_config.skills).toEqual([])
  })
})

// 槽位 thinking 附加（2026-08，spec §4.3/§9.2）：强度跟 slot 走，模型来源无关。
describe('handleGetAgentConfig — 槽位 thinking 附加', () => {
  function buildAdminForThinking(deps: { agentConfig?: Record<string, unknown> }): unknown {
    const admin = buildAdmin({ agentConfig: deps.agentConfig }) as Record<string, unknown>
    // buildConnectionInfo 返回可断言的连接信息（默认 stub 返回 null）
    ;(admin.modelProviderManager as Record<string, unknown>).buildConnectionInfo = async (pid: string, mid: string) => ({
      endpoint: 'https://ref.test', apikey: 'ref-key', model_id: mid,
      format: 'openai', provider_id: pid,
    })
    return admin
  }

  async function pullModelConfig(admin: unknown): Promise<Record<string, Record<string, unknown>>> {
    const result = await (admin as {
      handleGetAgentConfig: (p: unknown, context: unknown) => Promise<{ config: { agent_config: Record<string, unknown> } }>
    }).handleGetAgentConfig({ instance_id: 'crabot-agent' }, { authorizationBearer: 'runtime' })
    return result.config.agent_config.model_config as Record<string, Record<string, unknown>>
  }

  it('slot 配 thinking + 覆盖模型：附加到该 slot 解析结果', async () => {
    const admin = buildAdminForThinking({
      agentConfig: {
        model_config: { powerful: { provider_id: 'p1', model_id: 'm1' } },
        thinking: { powerful: { thinking_level: 'high' } },
      },
    })
    const modelConfig = await pullModelConfig(admin)
    expect(modelConfig.powerful.thinking_level).toBe('high')
    expect(modelConfig.powerful.thinking_custom).toBeUndefined()
  })

  it('slot 配 thinking + 回落全局默认：仍附加（强度跟 slot 走）', async () => {
    const admin = buildAdminForThinking({
      agentConfig: {
        model_config: {},
        thinking: { cost_effective: { thinking_custom: 'xhigh' } },
      },
    })
    const modelConfig = await pullModelConfig(admin)
    expect(modelConfig.cost_effective.thinking_custom).toBe('xhigh')
    // powerful 无 thinking 配置 → 不加字段（跟随默认）
    expect(modelConfig.powerful.thinking_level).toBeUndefined()
    expect(modelConfig.powerful.thinking_custom).toBeUndefined()
  })

  it('原始 thinking map 不随 runtime config 下发', async () => {
    const admin = buildAdminForThinking({
      agentConfig: {
        model_config: { powerful: { provider_id: 'p1', model_id: 'm1' } },
        thinking: { powerful: { thinking_level: 'off' } },
      },
    })
    const result = await (admin as {
      handleGetAgentConfig: (p: unknown, context: unknown) => Promise<{ config: { agent_config: Record<string, unknown> } }>
    }).handleGetAgentConfig({ instance_id: 'crabot-agent' }, { authorizationBearer: 'runtime' })
    expect(result.config.agent_config.thinking).toBeUndefined()
    expect(result.config.agent_config.model_config.powerful.thinking_level).toBe('off')
  })
})

// PR #127 review 意见 1 的回归：thinking 必须进 core_agent 语义投影。
// 否则 thinking-only 变更的 before/after fingerprint 相同，mutateComputed 判 noop
// 抛 'Config mutation did not change semantic snapshot'（400 且不落盘，主用例必现）。
describe('readCoreAgentSemanticSnapshot — thinking 进语义投影', () => {
  function buildSnapshotAdmin(config: Record<string, unknown>): unknown {
    const admin = Object.create(AdminModule.prototype) as Record<string, unknown>
    admin.agentManager = { getSemanticCoreConfig: () => config }
    admin.modelProviderManager = { getGlobalConfig: () => ({}), listProviders: () => [] }
    admin.mcpServerManager = { runtimeSemanticEntries: () => [] }
    admin.subAgentManager = { runtimeSemanticEntries: () => [], semanticMigrationState: () => ({ storage_version: 2, legacy_rewrite_pending: false }) }
    admin.skillManager = { runtimeSemanticEntries: () => [], semanticMigrationState: () => ({ storage_version: 2, legacy_rewrite_pending: false }) }
    admin.workerImplementationStore = { runtimeSemanticEntries: () => ({}) }
    return admin
  }

  function snapshotOf(config: Record<string, unknown>): string {
    return JSON.stringify((buildSnapshotAdmin(config) as {
      readCoreAgentSemanticSnapshot: () => unknown
    }).readCoreAgentSemanticSnapshot())
  }

  it('仅 thinking 不同的两份配置产生不同语义快照', () => {
    const base = {
      model_config: { powerful: { provider_id: 'p1', model_id: 'm1' } },
      system_prompt: 'x',
    }
    const withThinking = { ...base, thinking: { powerful: { thinking_level: 'high' } } }
    expect(snapshotOf(base)).not.toBe(snapshotOf(withThinking))
  })

  it('thinking 缺省与空对象在投影中归一化为相同快照（语义等价，不误判 noop 的前提）', () => {
    const base = { model_config: {}, system_prompt: 'x' }
    const withEmpty = { ...base, thinking: {} }
    expect(snapshotOf(base)).toBe(snapshotOf(withEmpty))
  })
})
