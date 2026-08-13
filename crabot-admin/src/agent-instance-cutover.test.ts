import { describe, expect, it, vi } from 'vitest'
import AdminModule from './index.js'

describe('Admin dynamic Agent creation cutover', () => {
  it('rejects the RPC write paths before calling AgentManager', async () => {
    const subject = Object.create(AdminModule.prototype) as any
    subject.agentManager = { createInstance: vi.fn(), updateInstance: vi.fn(), deleteInstance: vi.fn(), updateConfig: vi.fn() }

    await expect(subject.handleCreateAgentInstance({ implementation_id: 'legacy', name: 'legacy' }))
      .rejects.toMatchObject({ code: 'ADMIN_HOTPLUG_NOT_ALLOWED' })
    await expect(subject.handleUpdateAgentInstance({ instance_id: 'legacy', name: 'changed' }))
      .rejects.toMatchObject({ code: 'ADMIN_HOTPLUG_NOT_ALLOWED' })
    await expect(subject.handleDeleteAgentInstance({ instance_id: 'legacy' }))
      .rejects.toMatchObject({ code: 'ADMIN_HOTPLUG_NOT_ALLOWED' })
    await expect(subject.handleUpdateAgentConfig({ instance_id: 'legacy', system_prompt: 'changed' }))
      .rejects.toMatchObject({ code: 'ADMIN_HOTPLUG_NOT_ALLOWED' })
    expect(subject.agentManager.createInstance).not.toHaveBeenCalled()
    expect(subject.agentManager.updateInstance).not.toHaveBeenCalled()
    expect(subject.agentManager.deleteInstance).not.toHaveBeenCalled()
    expect(subject.agentManager.updateConfig).not.toHaveBeenCalled()
  })

  it('hides legacy records from live RPC read surfaces', async () => {
    const subject = Object.create(AdminModule.prototype) as any
    subject.agentManager = {
      getImplementation: (id: string) => id === 'default' ? { id: 'default', type: 'builtin', engine: 'crabot' } : { id, type: 'installed' },
      getInstance: (id: string) => id === 'crabot-agent' ? { id, implementation_id: 'default', auto_start: true } : { id, implementation_id: 'legacy', auto_start: true },
    }
    expect((await subject.handleListAgentImplementations({ page: 1, page_size: 20 })).items.map((item: { id: string }) => item.id)).toEqual(['default'])
    expect((await subject.handleListAgentInstances({ page: 1, page_size: 20 })).items.map((item: { id: string }) => item.id)).toEqual(['crabot-agent'])
    await expect(subject.handleGetAgentImplementation({ implementation_id: 'legacy' })).rejects.toThrow('not found')
    await expect(subject.handleGetAgentInstance({ instance_id: 'legacy' })).rejects.toThrow('not found')
  })
})
