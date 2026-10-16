import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { UnifiedAgent } from '../../src/unified-agent.js'
import { makeAgentConfig, useTmpDataDir, type DataDirGuard } from './harness.js'

describe('authorized voice event registration', () => {
  let guard: DataDirGuard
  beforeEach(async () => { guard = await useTmpDataDir('voice-subscription-') })
  afterEach(async () => { vi.restoreAllMocks(); await guard.restore() })

  it('registers the actual core Agent as a subscriber of authorized voice turns', async () => {
    const agent = new UnifiedAgent(makeAgentConfig({ configured: false, moduleId: 'crabot-agent', port: 19999 }))
    const register = vi.spyOn((agent as any).rpcClient, 'callSensitive').mockResolvedValue({})
    await agent.register('test-core-runtime')
    expect(register).toHaveBeenCalledWith(
      expect.any(Number), 'register_core_agent',
      expect.objectContaining({ module_id: 'crabot-agent', subscriptions: expect.arrayContaining(['channel.voice_turn_authorized']) }),
      'crabot-agent', { authorizationBearer: 'test-core-runtime' },
    )
  })
})
