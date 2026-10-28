import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import ModuleManager from './index.js'

const dataDirs: string[] = []
afterEach(async () => {
  await Promise.all(dataDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })))
})

describe('模块定义 id 大小写冲突', () => {
  it.each(['AI客服bot', 'crabot-agent', 'admin-web'])(
    '拒绝与已有 %s 仅大小写不同的动态实例，不分配新端口', async existing => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mm-instance-case-'))
      dataDirs.push(dir)
      const manager = new ModuleManager({
        port: 0, port_range: { range_start: 19890, range_end: 19910 }, hotplug_allowed_types: ['channel'], modules: [],
      }, dir) as any
      manager.managementOnly = false
      manager.modules.set(existing, { module_id: existing, status: 'stopped' })
      const allocate = vi.spyOn(manager.portAllocator, 'allocate')
      vi.spyOn(manager, 'publishEvent').mockResolvedValue({ subscriber_count: 0 })
      const duplicate = existing === 'AI客服bot' ? 'ai客服bot' : existing.toUpperCase()
      expect(() => manager.handleRegisterModuleDefinition({ module_definition: {
        module_id: duplicate, module_type: 'channel', entry: 'node test.js', auto_start: false, start_priority: 30,
      } })).toThrowError(expect.objectContaining({ code: 'MODULE_MANAGER_DUPLICATE_ID' }))
      expect(allocate).not.toHaveBeenCalled()
      expect([...manager.modules.keys()]).toEqual([existing])
    },
  )

  it('无冲突时原样保存大写混合 id', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mm-instance-case-'))
    dataDirs.push(dir)
    const manager = new ModuleManager({
      port: 0, port_range: { range_start: 19890, range_end: 19910 }, hotplug_allowed_types: ['channel'], modules: [],
    }, dir) as any
    manager.managementOnly = false
    vi.spyOn(manager, 'publishEvent').mockResolvedValue({ subscriber_count: 0 })
    expect(manager.handleRegisterModuleDefinition({ module_definition: {
      module_id: 'AI客服bot', module_type: 'channel', entry: 'node test.js', auto_start: false, start_priority: 30,
    } })).toEqual({ module_id: 'AI客服bot', registered: true })
    expect(manager.modules.get('AI客服bot')?.module_id).toBe('AI客服bot')
    expect(manager.modules.has('ai客服bot')).toBe(false)
  })
})
