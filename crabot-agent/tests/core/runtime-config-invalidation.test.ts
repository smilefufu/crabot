import { beforeEach, describe, expect, it, vi } from 'vitest'
import { UnifiedAgent } from '../../src/unified-agent.js'
import { ConfigLoader } from '../../src/core/config-loader.js'
import type { UnifiedAgentConfig } from '../../src/types.js'

function config(): UnifiedAgentConfig {
  return {
    module_id: 'crabot-agent', module_type: 'agent', version: '0.2.0', protocol_version: '3.1.1', port: 19999,
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
    await agent.onEvent({ type: 'admin.agent_config_invalidated', payload: { config_revision: 2, domains: ['models'] }, timestamp: new Date().toISOString() })
    await new Promise((resolve) => setTimeout(resolve, 70))
    expect(agent.agentConfig.system_prompt).toBe('new')
    expect(agent.agentConfig.model_config.powerful.model_id).toBe('new')
    expect(agent.configRevision).toBe(2)
    expect(agent.configStale).toBe(false)
  })

  it('clears stale after a successful equal-revision authenticated pull without reapplying config', async () => {
    const agent = new UnifiedAgent(config()) as any
    agent.adminPort = 19998
    agent.configRevision = 2
    agent.configAuthenticated = true
    agent.configStale = true
    const apply = vi.spyOn(agent, 'applyRuntimeConfigCandidate')
    vi.spyOn(ConfigLoader, 'pull').mockResolvedValue({ config: config(), revision: 2 })
    await agent.pullRuntimeConfig()
    expect(agent.configStale).toBe(false)
    expect(apply).not.toHaveBeenCalled()
  })

  it('cold unconfigured Agent atomically installs a handler before opening execution admission', async () => {
    const cold = config()
    cold.agent_config!.roles = ['worker']
    cold.agent_config!.model_config = {}
    const agent = new UnifiedAgent(cold) as any
    agent.adminPort = 19998
    agent.configRevision = 1
    agent.configAuthenticated = true
    agent.configStale = true
    expect(agent.agentHandler).toBeUndefined()
    const ready = config()
    ready.agent_config!.roles = ['worker']
    vi.spyOn(ConfigLoader, 'pull').mockResolvedValue({ config: ready, revision: 2 })

    await agent.pullRuntimeConfig()
    expect(agent.agentHandler).toBeDefined()
    expect(agent.configRevision).toBe(2)
    expect(agent.configStale).toBe(false)
    await expect(agent.managerStack.harness.spawnWorker({
      managerKey: 'admin-web::admin-chat', title: 'ready', prompt: 'ready',
      origin: { trigger_type: 'human' }, report_to: { channel_id: 'admin-web', session_id: 'admin-chat' },
    })).resolves.toBeDefined()
  })

  it('rejects candidate preparation failure without changing live revision or config', async () => {
    const agent = new UnifiedAgent(config()) as any
    agent.adminPort = 19998
    agent.configRevision = 1
    const old = JSON.stringify(agent.agentConfig)
    vi.spyOn(ConfigLoader, 'pull').mockResolvedValue({ config: { ...config(), agent_config: { ...config().agent_config!, max_iterations: 2 } }, revision: 2 })
    await expect(agent.pullRuntimeConfig()).rejects.toThrow('controlled restart')
    expect(JSON.stringify(agent.agentConfig)).toBe(old)
    expect(agent.configRevision).toBe(1)
  })

  it('rejects schedule, background maintenance, task execution, and new worker runtime resolution while stale', async () => {
    const agent = new UnifiedAgent(config()) as any
    agent.configAuthenticated = true
    agent.configStale = true
    const routeSchedule = vi.spyOn(agent.managerStack.registry, 'routeSchedule')
    const ledgerWrite = vi.spyOn(agent.managerStack.ledger, 'upsertWorker')
    const workerSpawn = vi.spyOn(agent.managerStack.harness, 'spawnWorker')
    const execute = vi.fn()
    agent.agentHandler = { executeTask: execute }
    await expect(agent.handleTriggerSchedule({ schedule_id: 's', title: 's' })).rejects.toThrow('AGENT_RUNTIME_CONFIG_STALE')
    await expect(agent.handleTriggerSchedule({ schedule_id: 'maintenance', title: 'maintenance', task_type: 'memory_maintenance', is_builtin: true })).rejects.toThrow('AGENT_RUNTIME_CONFIG_STALE')
    await expect(agent.handleExecuteTask({ task: { task_id: 't', task_title: 't' }, context: {} })).rejects.toThrow('AGENT_RUNTIME_CONFIG_STALE')
    await expect(agent.managerStack.harness.spawnWorker({
      managerKey: 'admin-web::admin-chat', title: 'new', prompt: 'new',
      origin: { trigger_type: 'human' }, report_to: { channel_id: 'admin-web', session_id: 'admin-chat' },
    })).rejects.toThrow('AGENT_RUNTIME_CONFIG_STALE')
    expect(routeSchedule).not.toHaveBeenCalled()
    expect(ledgerWrite).not.toHaveBeenCalled()
    expect(workerSpawn).toHaveBeenCalledOnce()
    expect(execute).not.toHaveBeenCalled()
  })

  it('rejects media completion Manager wakes while runtime config is stale', async () => {
    const agent = new UnifiedAgent(config()) as any
    agent.configAuthenticated = true
    agent.configStale = true
    const route = vi.spyOn(agent.managerStack.registry, 'routeMediaNotification')
    await expect(agent.onEvent({
      type: 'media.download_completed',
      timestamp: new Date().toISOString(),
      payload: { channel_id: 'admin-web', session_id: 'admin-chat', handle: 'fm_1', status: 'ready' },
    })).rejects.toThrow('AGENT_RUNTIME_CONFIG_STALE')
    expect(route).not.toHaveBeenCalled()
  })

  it('applies cold-start configured and unavailable image capability before first event', () => {
    const configured = config()
    configured.image_config = { endpoint: 'https://image.example', apikey: 'image-key', model_id: 'image-model', format: 'openai', provider_id: 'image' }
    configured.image_capability = { available: true }
    const ready = new UnifiedAgent(configured) as any
    expect(ready.imageConnInfo).toMatchObject({ endpoint: 'https://image.example', model_id: 'image-model' })
    expect(ready.imageCapability).toEqual({ available: true })
    const unavailable = new UnifiedAgent({ ...config(), image_capability: { available: false, reason: 'not_configured' } }) as any
    expect(unavailable.imageConnInfo).toBeUndefined()
    expect(unavailable.imageCapability).toEqual({ available: false, reason: 'not_configured' })
  })

  it('keeps old config and revision when MCP candidate preparation fails', async () => {
    const agent = new UnifiedAgent(config()) as any
    agent.adminPort = 19998
    agent.configRevision = 1
    const old = JSON.stringify(agent.agentConfig)
    const next = config()
    next.agent_config!.mcp_servers = [{ name: 'bad', transport: 'stdio', command: '' }]
    vi.spyOn(ConfigLoader, 'pull').mockResolvedValue({ config: next, revision: 2 })
    await expect(agent.pullRuntimeConfig()).rejects.toThrow()
    expect(JSON.stringify(agent.agentConfig)).toBe(old)
    expect(agent.configRevision).toBe(1)
  })

  it('keeps old config and revision when image or subagent candidate validation fails', async () => {
    const agent = new UnifiedAgent(config()) as any
    agent.adminPort = 19998
    agent.configRevision = 1
    const old = JSON.stringify(agent.agentConfig)
    const imageBroken = { ...config(), image_capability: { available: true } }
    vi.spyOn(ConfigLoader, 'pull').mockResolvedValueOnce({ config: imageBroken, revision: 2 })
    await expect(agent.pullRuntimeConfig()).rejects.toThrow('Image capability')
    expect(JSON.stringify(agent.agentConfig)).toBe(old)
    expect(agent.configRevision).toBe(1)
    const subagentBroken = config()
    subagentBroken.agent_config!.subagents = [{ id: 'same', name: 'one' } as any, { id: 'same', name: 'two' } as any]
    vi.mocked(ConfigLoader.pull).mockResolvedValueOnce({ config: subagentBroken, revision: 2 })
    await expect(agent.pullRuntimeConfig()).rejects.toThrow('Invalid runtime subagent')
    expect(JSON.stringify(agent.agentConfig)).toBe(old)
    expect(agent.configRevision).toBe(1)
  })

  it('rejects a lower revision, marks failed pull stale, and closes stale MCP connections', async () => {
    const agent = new UnifiedAgent(config()) as any
    agent.adminPort = 19998
    agent.configRevision = 3
    const disconnectAll = vi.spyOn(agent.mcpConnector, 'disconnectAll').mockResolvedValue(undefined)
    vi.spyOn(ConfigLoader, 'pull').mockResolvedValue({ config: config(), revision: 2 })
    await expect(agent.pullRuntimeConfig()).rejects.toThrow('stale config revision')
    expect(agent.agentConfig.system_prompt).toBe('old')
    vi.spyOn(ConfigLoader, 'pull').mockRejectedValue(new Error('admin unavailable'))
    await agent.onEvent({ type: 'admin.agent_config_invalidated', payload: {}, timestamp: new Date().toISOString() })
    await new Promise((resolve) => setTimeout(resolve, 70))
    expect(agent.configStale).toBe(true)
    expect(agent.isConfigured()).toBe(false)
    expect(disconnectAll).toHaveBeenCalled()
  })
})
