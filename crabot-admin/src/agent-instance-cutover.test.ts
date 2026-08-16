import { describe, expect, it, vi } from 'vitest'
import AdminModule from './index.js'

describe('Admin dynamic Agent creation cutover (P6-D final retirement)', () => {
  it('dynamic instance write RPC 方法不再注册（method not found 即 retired 语义）', () => {
    const subject = Object.create(AdminModule.prototype) as any
    expect(subject.handleCreateAgentInstance).toBeUndefined()
    expect(subject.handleUpdateAgentInstance).toBeUndefined()
    expect(subject.handleDeleteAgentInstance).toBeUndefined()
  })

  it('legacy instance config 写仍被拒且零副作用', async () => {
    const subject = Object.create(AdminModule.prototype) as any
    subject.agentManager = { updateConfig: vi.fn() }
    await expect(subject.handleUpdateAgentConfig({ instance_id: 'legacy', system_prompt: 'changed' }))
      .rejects.toMatchObject({ code: 'ADMIN_HOTPLUG_NOT_ALLOWED' })
    expect(subject.agentManager.updateConfig).not.toHaveBeenCalled()
  })

  it('hides legacy records from live RPC read surfaces（静态 core 身份唯一可读）', async () => {
    const subject = Object.create(AdminModule.prototype) as any
    subject.agentManager = {
      getInstance: (id: string) => id === 'crabot-agent' ? { id, implementation_id: 'crabot-agent', auto_start: true } : undefined,
    }
    const impls = await subject.handleListAgentImplementations({ page: 1, page_size: 20 })
    expect(impls.items.map((item: { id: string }) => item.id)).toEqual(['crabot-agent'])
    const instances = await subject.handleListAgentInstances({ page: 1, page_size: 20 })
    expect(instances.items.map((item: { id: string }) => item.id)).toEqual(['crabot-agent'])
    await expect(subject.handleGetAgentImplementation({ implementation_id: 'legacy' })).rejects.toThrow('not found')
    await expect(subject.handleGetAgentInstance({ instance_id: 'legacy' })).rejects.toThrow('not found')
  })
})
