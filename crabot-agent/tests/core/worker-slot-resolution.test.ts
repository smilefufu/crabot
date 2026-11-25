import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { UnifiedAgent } from '../../src/unified-agent.js'
import { ConfigLoader } from '../../src/core/config-loader.js'
import type { LLMConnectionInfo, UnifiedAgentConfig } from '../../src/types.js'

function connInfo(modelId: string): LLMConnectionInfo {
  return { endpoint: 'https://example.invalid', apikey: 'k', model_id: modelId, format: 'anthropic' }
}

function config(modelConfig: Record<string, LLMConnectionInfo>): UnifiedAgentConfig {
  return {
    module_id: 'crabot-agent', module_type: 'agent', version: '0.2.0', protocol_version: '3.4.0', port: 19999,
    orchestration: { front_context_recent_messages_window_hours: 1, front_context_recent_messages_max_cap: 1, front_context_short_term_memory_window_hours: 1, front_context_short_term_memory_max_cap: 1, worker_recent_messages_window_hours: 1, worker_recent_messages_max_cap: 1, worker_short_term_memory_window_hours: 1, worker_short_term_memory_max_cap: 1, worker_long_term_memory_limit: 1, front_agent_timeout: 1, session_state_ttl: 1, worker_config_refresh_interval: 1, front_agent_queue_max_length: 1, front_agent_queue_timeout: 1 },
    agent_config: { instance_id: 'crabot-agent', roles: ['worker'], system_prompt: 's', model_config: modelConfig },
  }
}

// 2026-11-25 槽位调整（协议 v3 §11 / spec 2026-11-25-worker-cost-effective-slot-design）：
// builtin worker loop 直接使用 cost_effective slot，不做槽位间回退；digest 维持 cost_effective → powerful 回退。
describe('builtin worker 槽位解析（cost_effective）', () => {
  let directory: string, previousDataDir: string | undefined
  const agents: UnifiedAgent[] = []
  const boot = (cfg: UnifiedAgentConfig) => { const agent = new UnifiedAgent(cfg); agents.push(agent); return agent }

  beforeEach(async () => {
    vi.restoreAllMocks()
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'worker-slot-resolution-'))
    previousDataDir = process.env.DATA_DIR
    process.env.DATA_DIR = directory
  })
  afterEach(async () => {
    await Promise.all(agents.splice(0).map(agent => agent.stop().catch(() => {})))
    if (previousDataDir === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDir
    await fs.rm(directory, { recursive: true, force: true })
  })

  it('worker handler 从 cost_effective slot 解析', () => {
    const agent = boot(config({ powerful: connInfo('p-model'), cost_effective: connInfo('c-model') })) as any
    expect(agent.sdkEnvWorker?.modelId).toBe('c-model')
  })

  it('只配 powerful（缺 cost_effective）→ 不建 worker handler，digest 维持回退 powerful', () => {
    const agent = boot(config({ powerful: connInfo('p-model') })) as any
    expect(agent.sdkEnvWorker).toBeUndefined()
    expect(agent.agentHandler).toBeUndefined()
    expect(agent.digestSdkEnv?.modelId).toBe('p-model')
  })

  it('builtin 起化身工厂现读 cost_effective；缺失时抛清晰错误', () => {
    const agent = boot(config({ powerful: connInfo('p-model'), cost_effective: connInfo('c-model') })) as any
    expect(agent.buildBuiltinWorkerRuntime({ worker_id: 'w-1' }).model).toBe('c-model')

    const missing = boot(config({ powerful: connInfo('p-model') })) as any
    expect(() => missing.buildBuiltinWorkerRuntime({ worker_id: 'w-2' })).toThrow(/cost_effective/)
  })

  it('builtin 就绪判据 = cost_effective 可解析（现读 live 配置）', () => {
    const agent = boot(config({ powerful: connInfo('p-model'), cost_effective: connInfo('c-model') })) as any
    const registry = agent.activationRegistry
    expect(registry.modelSlotResolvable()).toBe(true)
    delete agent.agentConfig.model_config.cost_effective
    expect(registry.modelSlotResolvable()).toBe(false)
  })

  it('authenticated pull 热更：worker 与 digest 都落 cost_effective 新值', async () => {
    const agent = boot(config({ powerful: connInfo('p-1'), cost_effective: connInfo('c-1') })) as any
    agent.adminPort = 19998
    const next = config({ powerful: connInfo('p-2'), cost_effective: connInfo('c-2') })
    vi.spyOn(ConfigLoader, 'pull').mockResolvedValue({ config: next, revision: 2 })
    await agent.onEvent({ type: 'admin.agent_config_invalidated', payload: { config_revision: 2, domains: ['models'] }, timestamp: new Date().toISOString() })
    const deadline = Date.now() + 10000
    while ((agent.agentConfig.model_config.cost_effective?.model_id !== 'c-2' || agent.configRevision !== 2) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    expect(agent.agentConfig.model_config.cost_effective?.model_id).toBe('c-2')
    expect(agent.configRevision).toBe(2)
    expect(agent.sdkEnvWorker?.modelId).toBe('c-2')
    expect(agent.digestSdkEnv?.modelId).toBe('c-2')
  })
})
