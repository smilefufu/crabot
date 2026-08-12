import { describe, expect, it, beforeEach } from 'vitest'
import { ConfigLoader } from '../../src/core/config-loader.js'

const config = { instance_id: 'crabot-agent', role: 'front', system_prompt: '', model_config: {} }

describe('ConfigLoader authenticated revision pull', () => {
  beforeEach(() => {
    ConfigLoader.captureRuntimeBearer()
  })
  it('uses sensitive transport and accepts revisioned config', async () => {
    process.env.CRABOT_CORE_AGENT_RUNTIME_BEARER = 'test-bearer'
    ConfigLoader.captureRuntimeBearer()
    const calls: unknown[] = []
    const rpc = { callSensitive: async (...args: unknown[]) => { calls.push(args); return { config_revision: 2, config } } } as any
    const result = await ConfigLoader.load('', rpc, 'http://localhost:19999')
    expect(result.agent_config.instance_id).toBe('crabot-agent')
    expect(calls).toHaveLength(1)
    expect((calls[0] as unknown[])[1]).toBe('get_agent_config')
  })
  it('rejects a stale revision', async () => {
    const rpc = { callSensitive: async () => ({ config_revision: 1, config }) } as any
    await expect(ConfigLoader.load('', rpc, 'http://localhost:19999')).rejects.toThrow(/stale config revision/)
  })
})
