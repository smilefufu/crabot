import { describe, it, expect, vi } from 'vitest'
import type { RpcClient } from 'crabot-shared'
import { ConfigLoader } from '../../src/core/config-loader.js'
import type { UnifiedAgentConfig } from '../../src/types.js'

function runtimeConfig(): UnifiedAgentConfig {
  return {
    module_id: 'crabot-agent',
    module_type: 'agent',
    version: '0.2.0',
    protocol_version: '3.4.0',
    port: 19002,
    orchestration: {
      front_context_recent_messages_window_hours: 6,
      front_context_recent_messages_max_cap: 50,
      front_context_short_term_memory_window_hours: 12,
      front_context_short_term_memory_max_cap: 30,
      worker_recent_messages_window_hours: 4,
      worker_recent_messages_max_cap: 50,
      worker_short_term_memory_window_hours: 12,
      worker_short_term_memory_max_cap: 10,
      worker_long_term_memory_limit: 5,
      front_agent_timeout: 30,
      session_state_ttl: 3600,
      worker_config_refresh_interval: 60,
      front_agent_queue_max_length: 100,
      front_agent_queue_timeout: 300,
    },
    agent_config: {
      instance_id: 'crabot-agent',
      // wire 不下发 legacy roles；ConfigLoader 内部补齐 front+worker。
      system_prompt: '你是 crabot',
      model_config: {
        powerful: {
          endpoint: 'https://api.anthropic.com', apikey: 'sk-x', model_id: 'claude',
          format: 'anthropic', provider_id: 'provider',
        },
      },
      mcp_servers: [{ name: 'fs', command: 'node', args: [] }],
      tmp_page_base_url: 'http://localhost:3000',
    },
  }
}

describe('ConfigLoader authenticated runtime wire', () => {
  function connRefused(): Error {
    return new AggregateError(
      [new Error('connect ECONNREFUSED ::1:19002'), new Error('connect ECONNREFUSED 127.0.0.1:19002')],
      '',
    )
  }

  function fakeRpcClient(failTimes: number, result: unknown = { config_revision: 1, config: runtimeConfig() }) {
    let calls = 0
    const callSensitive = vi.fn(async () => {
      calls += 1
      if (calls <= failTimes) throw connRefused()
      return result
    })
    return { client: { callSensitive } as unknown as RpcClient, calls: () => calls }
  }

  it('consumes the exact outer runtime shape without dropping agent_config fields', async () => {
    const { client } = fakeRpcClient(0)
    const config = await ConfigLoader.load('', client, 'http://localhost:19002')
    expect(config.runtime_config_authenticated).toBe(true)
    expect(config.agent_config?.tmp_page_base_url).toBe('http://localhost:3000')
    // wire 不含 roles，Agent 内部固定补齐 front+worker（legacy 内部门控）
    expect(config.agent_config?.roles).toEqual(['front', 'worker'])
  })

  it('rejects a malformed outer identity before installing config', async () => {
    const malformed = { ...runtimeConfig(), module_id: 'legacy-agent' }
    const { client } = fakeRpcClient(0, { config_revision: 1, config: malformed })
    await expect(ConfigLoader.load('', client, 'http://localhost:19002')).rejects.toThrow('runtime identity')
  })

  it('admin 前 N 次不可达、之后可达 → 最终拿到真配置', async () => {
    const { client, calls } = fakeRpcClient(3)
    const config = await ConfigLoader.loadWithRetry(client, 'http://localhost:19002', {
      budgetMs: 5_000,
      initialDelayMs: 1,
      maxDelayMs: 2,
    })
    expect(calls()).toBe(4)
    expect(config.agent_config?.system_prompt).toBe('你是 crabot')
    expect(config.agent_config?.model_config).toHaveProperty('powerful')
    expect(config.agent_config?.mcp_servers).toHaveLength(1)
  })

  it('admin 始终不可达 → 重试耗尽后降级启动（存活、未认证、无 agent_config）', async () => {
    const { client, calls } = fakeRpcClient(Number.POSITIVE_INFINITY)
    const degraded = await ConfigLoader.loadWithRetry(client, 'http://localhost:19002', {
      budgetMs: 40,
      initialDelayMs: 5,
      maxDelayMs: 5,
    })
    expect(calls()).toBeGreaterThan(1)
    expect(degraded.module_id).toBe('crabot-agent')
    expect(degraded.agent_config).toBeUndefined()
    expect(degraded.runtime_config_authenticated).toBe(false)
  })

  it('adminEndpoint 未配置属环境问题 → 降级启动，不空转重试', async () => {
    const { client, calls } = fakeRpcClient(0)
    const degraded = await ConfigLoader.loadWithRetry(client, undefined, {
      budgetMs: 60_000,
      initialDelayMs: 1,
      maxDelayMs: 2,
    })
    expect(calls()).toBe(0)
    expect(degraded.agent_config).toBeUndefined()
    expect(degraded.runtime_config_authenticated).toBe(false)
  })
})
