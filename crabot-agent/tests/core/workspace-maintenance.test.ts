import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { UnifiedAgent } from '../../src/unified-agent.js'
import type { UnifiedAgentConfig } from '../../src/types.js'

const config: UnifiedAgentConfig = {
  module_id: 'crabot-agent', module_type: 'agent', version: '0.2.0', protocol_version: '3.4.0', port: 19999,
  orchestration: { front_context_recent_messages_window_hours: 1, front_context_recent_messages_max_cap: 1, front_context_short_term_memory_window_hours: 1, front_context_short_term_memory_max_cap: 1, worker_recent_messages_window_hours: 1, worker_recent_messages_max_cap: 1, worker_short_term_memory_window_hours: 1, worker_short_term_memory_max_cap: 1, worker_long_term_memory_limit: 1, front_agent_timeout: 1, session_state_ttl: 1, worker_config_refresh_interval: 1, front_agent_queue_max_length: 1, front_agent_queue_timeout: 1 },
  agent_config: { instance_id: 'crabot-agent', roles: [], system_prompt: 'fixture', model_config: { powerful: { endpoint: 'https://fixture.invalid', apikey: 'fixture', model_id: 'fixture', format: 'openai', provider_id: 'fixture' } } },
}

describe.each(['relocation.json', 'relocation-workers.json'])('workspace maintenance execution admission: %s', record => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs() })

  it('blocks messages, schedules, and Harness dispatch before metadata or ledger writes', async () => {
    const data = await fs.mkdtemp(path.join(tmpdir(), 'crabot-agent-workspace-gate-'))
    vi.stubEnv('DATA_DIR', data); vi.stubEnv('CRABOT_AGENT_DATA_DIR', path.join(data, 'agent'))
    const agent = new UnifiedAgent(config) as any
    const ledgerWrite = vi.spyOn(agent.managerStack.ledger, 'upsertWorker')
    const route = vi.spyOn(agent.managerStack.registry, 'routeSchedule')
    try {
      agent.assertRuntimeExecutionAdmission()
      await fs.mkdir(path.join(data, 'workspace-control'), { recursive: true })
      await fs.writeFile(path.join(data, 'workspace-control', record), 'fixed job')
      await expect(agent.handleMessageReceived({ crab_display_name: 'must not cache' })).rejects.toMatchObject({ code: 'WORKSPACE_MAINTENANCE' })
      await expect(agent.handleTriggerSchedule({ schedule_id: 'script' })).rejects.toMatchObject({ code: 'WORKSPACE_MAINTENANCE' })
      await expect(agent.managerStack.harness.sendToWorker('old', 'new input')).rejects.toMatchObject({ code: 'WORKSPACE_MAINTENANCE' })
      await expect(agent.managerStack.harness.spawnWorker({ managerKey: 'admin-web::admin-chat', title: 'new', prompt: 'new',
        origin: { trigger_type: 'human' }, report_to: { channel_id: 'admin-web', session_id: 'admin-chat' },
      })).rejects.toMatchObject({ code: 'WORKSPACE_MAINTENANCE' })
      expect(agent.crabDisplayNames.size).toBe(0)
      expect(ledgerWrite).not.toHaveBeenCalled(); expect(route).not.toHaveBeenCalled()
    } finally { await agent.managerStack.dispose(); await fs.rm(data, { recursive: true, force: true }) }
  })

  it('blocks direct Manager ingress, late notifications, and queued wakes without creating an episode', async () => {
    const data = await fs.mkdtemp(path.join(tmpdir(), 'crabot-manager-workspace-gate-'))
    vi.stubEnv('DATA_DIR', data); vi.stubEnv('CRABOT_AGENT_DATA_DIR', path.join(data, 'agent'))
    const agent = new UnifiedAgent(config) as any, registry = agent.managerStack.registry
    const loop = vi.spyOn(registry, 'getOrCreate')
    try {
      await fs.mkdir(path.join(data, 'workspace-control'), { recursive: true })
      await fs.writeFile(path.join(data, 'workspace-control', record), '{}')
      await expect(registry.routeHumanMessages('admin-web', 'admin-chat', [])).rejects.toMatchObject({ code: 'WORKSPACE_MAINTENANCE' })
      await expect(registry.routeMediaNotification({ channelId: 'admin-web', sessionId: 'admin-chat', text: 'late' })).rejects.toMatchObject({ code: 'WORKSPACE_MAINTENANCE' })
      await expect(registry.runWake('admin-web::admin-chat', undefined)).rejects.toMatchObject({ code: 'WORKSPACE_MAINTENANCE' })
      expect(loop).not.toHaveBeenCalled()
      // Protection does not fabricate closure or make a display inventory prove a verified stop.
      expect((await agent.managerStack.harness.getWorkspaceExecutionInventory()).ready).toBe(false)
    } finally { await agent.managerStack.dispose(); await fs.rm(data, { recursive: true, force: true }) }
  })
})
