import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { RpcCallError } from 'crabot-shared'
import { ChannelManager } from './channel-manager.js'

describe('Channel 删除确认', () => {
  let dir: string
  let manager: ChannelManager
  let rpc: { stopModule: ReturnType<typeof vi.fn>; unregisterModuleDefinition: ReturnType<typeof vi.fn> }
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'channel-delete-'))
    await fs.mkdir(path.join(dir, 'channel-configs'))
    rpc = {
      stopModule: vi.fn().mockResolvedValue({ status: 'accepted', tracking_id: 'stop' }),
      unregisterModuleDefinition: vi.fn(),
    }
    manager = new ChannelManager(dir, rpc as any)
    await manager.upsertInstanceById({
      id: '飞书客服', name: '飞书客服', implementation_id: 'channel-feishu', platform: 'feishu',
      auto_start: false, start_priority: 30, module_registered: true,
      created_at: '2026-10-28T00:00:00Z', updated_at: '2026-10-28T00:00:00Z',
    }, { TOKEN: 'keep' }, 'skip')
  })
  afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }) })

  it.each(['Module is running, stop it first', 'MM connection refused'])(
    '注销失败（%s）不吞错、不删除实例和配置', async message => {
      rpc.unregisterModuleDefinition.mockRejectedValue(new Error(message))
      const before = await fs.readFile(path.join(dir, 'channel-instances.json'), 'utf8')
      await expect(manager.deleteInstance('飞书客服')).rejects.toThrow(message)
      expect(manager.getInstance('飞书客服')).toBeDefined()
      expect(await manager.loadLocalConfig('飞书客服')).toEqual({ TOKEN: 'keep' })
      expect(await fs.readFile(path.join(dir, 'channel-instances.json'), 'utf8')).toBe(before)
    },
  )

  it('停止请求本身失败时保留实例/配置，且不发注销', async () => {
    rpc.stopModule.mockRejectedValue(new Error('stop failed'))
    await expect(manager.deleteInstance('飞书客服')).rejects.toThrow('stop failed')
    expect(rpc.unregisterModuleDefinition).not.toHaveBeenCalled()
    expect(manager.getInstance('飞书客服')).toBeDefined()
    expect(await manager.loadLocalConfig('飞书客服')).toEqual({ TOKEN: 'keep' })
  })

  it('模块已停止且注销成功时才删除实例和配置', async () => {
    rpc.unregisterModuleDefinition.mockResolvedValue({ module_id: '飞书客服', unregistered: true })
    await manager.deleteInstance('飞书客服')
    expect(rpc.unregisterModuleDefinition).toHaveBeenCalledWith('飞书客服', 'admin')
    expect(manager.getInstance('飞书客服')).toBeUndefined()
    expect(await manager.loadLocalConfig('飞书客服')).toBeNull()
    expect(JSON.parse(await fs.readFile(path.join(dir, 'channel-instances.json'), 'utf8'))).toEqual([])
  })

  it('MM 明确返回定义不存在时允许清理遗留实例', async () => {
    rpc.unregisterModuleDefinition.mockRejectedValue(new RpcCallError('NOT_FOUND', 'Module definition not found'))
    await manager.deleteInstance('飞书客服')
    expect(manager.getInstance('飞书客服')).toBeUndefined()
    expect(await manager.loadLocalConfig('飞书客服')).toBeNull()
  })
})
