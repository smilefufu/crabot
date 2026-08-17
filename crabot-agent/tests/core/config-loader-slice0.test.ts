import { beforeEach, describe, expect, it } from 'vitest'
import { ConfigLoader } from '../../src/core/config-loader.js'
import type { UnifiedAgentConfig } from '../../src/types.js'

function runtimeConfig(): UnifiedAgentConfig {
  return {
    module_id: 'crabot-agent', module_type: 'agent', version: '0.2.0', protocol_version: '3.1.2', port: 19002,
    orchestration: {
      front_context_recent_messages_window_hours: 6, front_context_recent_messages_max_cap: 50,
      front_context_short_term_memory_window_hours: 12, front_context_short_term_memory_max_cap: 30,
      worker_recent_messages_window_hours: 4, worker_recent_messages_max_cap: 50,
      worker_short_term_memory_window_hours: 12, worker_short_term_memory_max_cap: 10,
      worker_long_term_memory_limit: 5, front_agent_timeout: 30, session_state_ttl: 3600,
      worker_config_refresh_interval: 60, front_agent_queue_max_length: 100, front_agent_queue_timeout: 300,
    },
    agent_config: {
      // wire 不下发 legacy roles（slot 制实例配置）；ConfigLoader 内部补齐。
      instance_id: 'crabot-agent', system_prompt: '',
      model_config: {
        powerful: { endpoint: 'https://example.test', apikey: 'key', model_id: 'model', format: 'openai', provider_id: 'provider' },
      },
    },
  }
}

describe('ConfigLoader authenticated revision pull', () => {
  beforeEach(() => ConfigLoader.captureRuntimeBearer())

  it('uses sensitive transport and accepts the exact revisioned runtime config', async () => {
    process.env.CRABOT_CORE_AGENT_RUNTIME_BEARER = 'test-bearer'
    ConfigLoader.captureRuntimeBearer()
    const calls: unknown[] = []
    const rpc = { callSensitive: async (...args: unknown[]) => { calls.push(args); return { config_revision: 2, config: runtimeConfig() } } } as any
    const result = await ConfigLoader.load('', rpc, 'http://localhost:19999')
    expect(result.agent_config?.instance_id).toBe('crabot-agent')
    expect(result.agent_config?.builtin_tool_config).toBeUndefined()
    expect(result.runtime_config_authenticated).toBe(true)
    expect(calls).toHaveLength(1)
    expect((calls[0] as unknown[])[1]).toBe('get_agent_config')
  })

  it('rejects a stale revision', async () => {
    const rpc = { callSensitive: async () => ({ config_revision: 1, config: runtimeConfig() }) } as any
    await expect(ConfigLoader.load('', rpc, 'http://localhost:19999')).rejects.toThrow(/stale config revision/)
  })
})
