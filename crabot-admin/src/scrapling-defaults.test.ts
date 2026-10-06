import { describe, it, expect, vi } from 'vitest'
import { promises as fs } from 'fs'
import os from 'os'
import path from 'path'
import { createRequire } from 'node:module'
import AdminModule from './index.js'
import { MCPServerManager } from './mcp-skill-manager.js'

describe('Scrapling builtin registration', () => {
  it('新条目默认启用；重启保留关闭状态和自定义启动参数', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'scrapling-registry-'))
    try {
      const manager = new MCPServerManager(dir)
      await manager.initialize()
      await manager.registerBuiltins('/fixture/mcp-tools')
      const entry = manager.list().find(s => s.name === 'scrapling')!
      expect(entry.enabled).toBe(true)
      expect(entry.can_disable).toBe(true)
      await manager.update(entry.id, { enabled: false, command: 'custom-scrapling', args: ['mcp', '--http'] })
      const restarted = new MCPServerManager(dir)
      await restarted.initialize()
      await restarted.registerBuiltins('/moved/mcp-tools')
      expect(restarted.get(entry.id)).toMatchObject({ enabled: false, command: 'custom-scrapling', args: ['mcp', '--http'] })
    } finally { await fs.rm(dir, { recursive: true, force: true }) }
  })
})


describe('Scrapling runtime failure isolation', () => {
  it('缺失产品环境只降级 Scrapling，保留模型、其它 MCP、Skill 和 registry 启用值', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'scrapling-config-'))
    const admin = new AdminModule(
      { moduleId: 'admin-web', moduleType: 'admin', version: '0.1.0', protocolVersion: '0.1.0', port: 0, subscriptions: [] },
      { web_port: 0, data_dir: dir, password_env: 'UNUSED_SCRAPLING_PASSWORD', jwt_secret_env: 'UNUSED_SCRAPLING_JWT', token_ttl: 3600 },
    )
    const subject = admin as any
    const runtime = createRequire(import.meta.url)('../../scripts/lib/scrapling-runtime.cjs')
    const original = runtime.resolveScraplingConfig
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      // 使用真实解析器读不存在的 ready 资源，不改变本机已准备的产品环境。
      vi.spyOn(runtime, 'resolveScraplingConfig').mockImplementation((_root: string, ...args: any[]) => original(dir, ...args))
      subject.rpcClient.callModuleManagerSensitive = vi.fn().mockResolvedValue({ verified: true })
      subject.rpcClient.callModuleManager = vi.fn().mockResolvedValue({ module_id: 'crabot-agent', module_type: 'agent', port: 19002 })
      subject.configMutationCoordinator.readCommittedEpoch = vi.fn().mockResolvedValue({ revision: 1, generation: 0 })
      subject.agentManager.configs.set('crabot-agent', { instance_id: 'crabot-agent', model_config: { powerful: { provider_id: 'p', model_id: 'm' } } })
      subject.modelProviderManager.resolveModelConfig = vi.fn().mockResolvedValue(null)
      subject.modelProviderManager.buildConnectionInfo = vi.fn().mockResolvedValue({ endpoint: 'https://model.example', apikey: 'fixture', model_id: 'm', format: 'openai', provider_id: 'p' })
      subject.modelProviderManager.resolveImageConfig = vi.fn().mockResolvedValue({ available: false, reason: 'none' })
      const scrapling = { id: 'preserved-id', name: 'scrapling', is_builtin: true, enabled: true, transport: 'stdio', command: 'scrapling', args: ['mcp'] }
      subject.mcpServerManager.list = vi.fn().mockReturnValue([scrapling, { name: 'other', enabled: true, transport: 'stdio', command: 'echo', args: [] }])
      subject.skillManager.list = vi.fn().mockReturnValue([{ id: 'skill-preserved', name: 'unrelated', description: 'fixture', skill_dir: '/fixture/skill', enabled: true }])
      subject.subAgentManager.listEnabled = vi.fn().mockReturnValue([])
      const result = await subject.handleGetAgentConfig({ instance_id: 'crabot-agent' }, { authorizationBearer: 'runtime' })
      expect(result.config.agent_config.model_config.powerful).toMatchObject({ endpoint: 'https://model.example', model_id: 'm' })
      expect(result.config.agent_config.mcp_servers).toEqual([expect.objectContaining({ name: 'other', command: 'echo' })])
      expect(result.config.agent_config.skills).toEqual([expect.objectContaining({ name: 'unrelated' })])
      expect(scrapling).toMatchObject({ id: 'preserved-id', enabled: true })
      expect(warning).toHaveBeenCalledWith(expect.stringContaining('scrapling'), expect.stringContaining('Scrapling runtime unavailable'))
    } finally {
      vi.restoreAllMocks()
      await admin.stop().catch(() => {})
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})
