import { beforeEach, describe, expect, it, vi } from 'vitest'
import { UnifiedAgent } from '../../src/unified-agent.js'
import { ConfigLoader } from '../../src/core/config-loader.js'
import type { UnifiedAgentConfig } from '../../src/types.js'

function config(): UnifiedAgentConfig {
  return {
    module_id: 'crabot-agent', module_type: 'agent', version: '0.2.0', protocol_version: '0.3.0', port: 19999,
    orchestration: { front_context_recent_messages_window_hours: 1, front_context_recent_messages_max_cap: 1, front_context_short_term_memory_window_hours: 1, front_context_short_term_memory_max_cap: 1, worker_recent_messages_window_hours: 1, worker_recent_messages_max_cap: 1, worker_short_term_memory_window_hours: 1, worker_short_term_memory_max_cap: 1, worker_long_term_memory_limit: 1, front_agent_timeout: 1, session_state_ttl: 1, worker_config_refresh_interval: 1, front_agent_queue_max_length: 1, front_agent_queue_timeout: 1 },
    agent_config: { instance_id: 'crabot-agent', roles: [], system_prompt: 'old', model_config: { powerful: { endpoint: 'https://old.example', apikey: 'old', model_id: 'old', format: 'openai', provider_id: 'old' } } },
  }
}

describe('UnifiedAgent runtime config invalidation', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('subscribes to nonsecret invalidation and atomically accepts a higher pull revision', async () => {
    const agent = new UnifiedAgent(config()) as any
    expect(agent.config.subscriptions).toContain('admin.agent_config_invalidated')
    agent.adminPort = 19998
    const next = config()
    next.agent_config!.system_prompt = 'new'
    next.agent_config!.model_config.powerful.model_id = 'new'
    vi.spyOn(ConfigLoader, 'pull').mockResolvedValue({ config: next, revision: 2 })
    const update = vi.spyOn(agent, 'handleUpdateConfig').mockResolvedValue({})
    await agent.onEvent({ type: 'admin.agent_config_invalidated', payload: { config_revision: 2, domains: ['models'] }, timestamp: new Date().toISOString() })
    await new Promise((resolve) => setTimeout(resolve, 70))
    expect(update).toHaveBeenCalledOnce()
    expect(agent.configRevision).toBe(2)
    expect(agent.configStale).toBe(false)
  })

  it('rejects a lower revision and marks failed pull stale without changing running config', async () => {
    const agent = new UnifiedAgent(config()) as any
    agent.adminPort = 19998
    agent.configRevision = 3
    vi.spyOn(ConfigLoader, 'pull').mockResolvedValue({ config: config(), revision: 2 })
    await expect(agent.pullRuntimeConfig()).rejects.toThrow('stale config revision')
    expect(agent.agentConfig.system_prompt).toBe('old')
    vi.spyOn(ConfigLoader, 'pull').mockRejectedValue(new Error('admin unavailable'))
    await agent.onEvent({ type: 'admin.agent_config_invalidated', payload: {}, timestamp: new Date().toISOString() })
    await new Promise((resolve) => setTimeout(resolve, 70))
    expect(agent.configStale).toBe(true)
    expect(agent.isConfigured()).toBe(false)
  })
})
