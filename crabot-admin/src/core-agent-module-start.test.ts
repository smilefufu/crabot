import { describe, expect, it, vi } from 'vitest'
import AdminModule from './index.js'

describe('Admin core Agent module-start identity', () => {
  function subject(): any {
    const admin = Object.create(AdminModule.prototype) as any
    admin.agentPort = 0
    admin.config = { moduleId: 'admin-web' }
    admin.publishAgentConfigInvalidation = vi.fn().mockResolvedValue(true)
    admin.pushProxyConfigToModule = vi.fn().mockResolvedValue(undefined)
    return admin
  }

  it('caches and invalidates only the exact core Agent identity', async () => {
    const admin = subject()

    await admin.onEvent({
      type: 'module_manager.module_started', timestamp: new Date().toISOString(), source: 'module-manager',
      payload: { module_id: 'rogue-agent', module_type: 'agent', port: 19998 },
    })
    expect(admin.agentPort).toBe(0)
    expect(admin.publishAgentConfigInvalidation).not.toHaveBeenCalled()

    await admin.onEvent({
      type: 'module_manager.module_started', timestamp: new Date().toISOString(), source: 'module-manager',
      payload: { module_id: 'crabot-agent', module_type: 'agent', port: 19999 },
    })
    expect(admin.agentPort).toBe(19999)
    expect(admin.publishAgentConfigInvalidation).toHaveBeenCalledOnce()

    admin.invalidatePortCache('rogue-agent', 'agent')
    expect(admin.agentPort).toBe(19999)
    admin.invalidatePortCache('crabot-agent', 'agent')
    expect(admin.agentPort).toBe(0)
  })
})
