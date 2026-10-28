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
    await fs.mkdir(path.join(dir, 'channels', '飞书客服'), { recursive: true })
    await fs.writeFile(path.join(dir, 'channels', '飞书客服', 'cache.json'), '{"old":true}')
  })
  afterEach(async () => { vi.restoreAllMocks(); await fs.rm(dir, { recursive: true, force: true }) })

  it.each(['Module is running, stop it first', 'MM connection refused'])(
    '注销失败（%s）不吞错、不删除实例和配置', async message => {
      rpc.unregisterModuleDefinition.mockRejectedValue(new Error(message))
      const before = await fs.readFile(path.join(dir, 'channel-instances.json'), 'utf8')
      await expect(manager.deleteInstance('飞书客服')).rejects.toThrow(message)
      expect(manager.getInstance('飞书客服')).toBeDefined()
      expect(await manager.loadLocalConfig('飞书客服')).toEqual({ TOKEN: 'keep' })
      expect(await fs.readFile(path.join(dir, 'channel-instances.json'), 'utf8')).toBe(before)
      expect(await fs.readFile(path.join(dir, 'channels', '飞书客服', 'cache.json'), 'utf8')).toBe('{"old":true}')
    },
  )

  it('停止请求本身失败时保留实例/配置，且不发注销', async () => {
    rpc.stopModule.mockRejectedValue(new Error('stop failed'))
    await expect(manager.deleteInstance('飞书客服')).rejects.toThrow('stop failed')
    expect(rpc.unregisterModuleDefinition).not.toHaveBeenCalled()
    expect(manager.getInstance('飞书客服')).toBeDefined()
    expect(await manager.loadLocalConfig('飞书客服')).toEqual({ TOKEN: 'keep' })
    expect(await fs.readFile(path.join(dir, 'channels', '飞书客服', 'cache.json'), 'utf8')).toBe('{"old":true}')
  })

  it('模块已停止且注销成功时才删除实例和配置', async () => {
    rpc.unregisterModuleDefinition.mockResolvedValue({ module_id: '飞书客服', unregistered: true })
    await manager.deleteInstance('飞书客服')
    expect(rpc.unregisterModuleDefinition).toHaveBeenCalledWith('飞书客服', 'admin')
    expect(manager.getInstance('飞书客服')).toBeUndefined()
    expect(await manager.loadLocalConfig('飞书客服')).toBeNull()
    await expect(fs.stat(path.join(dir, 'channels', '飞书客服'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(JSON.parse(await fs.readFile(path.join(dir, 'channel-instances.json'), 'utf8'))).toEqual([])
  })

  it('MM 明确返回定义不存在时允许清理遗留实例', async () => {
    rpc.unregisterModuleDefinition.mockRejectedValue(new RpcCallError('NOT_FOUND', 'Module definition not found'))
    await manager.deleteInstance('飞书客服')
    expect(manager.getInstance('飞书客服')).toBeUndefined()
    expect(await manager.loadLocalConfig('飞书客服')).toBeNull()
    await expect(fs.stat(path.join(dir, 'channels', '飞书客服'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('实例目录缺失时仍能完成删除', async () => {
    await fs.rm(path.join(dir, 'channels', '飞书客服'), { recursive: true })
    await manager.deleteInstance('飞书客服')
    expect(manager.getInstance('飞书客服')).toBeUndefined()
  })

  it('清理失败时保留实例和配置，注销已完成后仍能重试', async () => {
    const before = await fs.readFile(path.join(dir, 'channel-instances.json'), 'utf8')
    const remove = vi.spyOn(fs, 'rm').mockRejectedValueOnce(Object.assign(new Error('cleanup denied'), { code: 'EACCES' }))
    await expect(manager.deleteInstance('飞书客服')).rejects.toThrow('cleanup denied')
    expect(manager.getInstance('飞书客服')).toBeDefined()
    expect(await manager.loadLocalConfig('飞书客服')).toEqual({ TOKEN: 'keep' })
    expect(await fs.readFile(path.join(dir, 'channel-instances.json'), 'utf8')).toBe(before)
    remove.mockRestore()
    rpc.unregisterModuleDefinition.mockRejectedValue(new RpcCallError('NOT_FOUND', 'Module definition not found'))
    await manager.deleteInstance('飞书客服')
    expect(manager.getInstance('飞书客服')).toBeUndefined()
    await expect(fs.stat(path.join(dir, 'channels', '飞书客服'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.each(['../keep', 'folder/../keep'])('拒绝越出实例目录的历史 id %s，不触发停止或删除相邻数据', async id => {
    const unsafe = { ...manager.getInstance('飞书客服')!, id, name: id }
    await manager.upsertInstanceById(unsafe, null, 'skip')
    await fs.mkdir(path.join(dir, 'keep'))
    await fs.writeFile(path.join(dir, 'keep', 'marker'), 'keep')
    await expect(manager.deleteInstance(unsafe.id)).rejects.toThrow(/Invalid instance data path/)
    expect(rpc.stopModule).not.toHaveBeenCalled()
    expect(await fs.readFile(path.join(dir, 'keep', 'marker'), 'utf8')).toBe('keep')
    expect(manager.getInstance(unsafe.id)).toBeDefined()
  })

  it('配置清理失败也不提前移除实例记录', async () => {
    const originalRemove = fs.rm
    const configPath = path.join(dir, 'channel-configs', '飞书客服.json')
    const remove = vi.spyOn(fs, 'rm').mockImplementation((target, options) =>
      target === configPath ? Promise.reject(new Error('config cleanup denied')) : originalRemove(target, options))
    await expect(manager.deleteInstance('飞书客服')).rejects.toThrow('config cleanup denied')
    expect(manager.getInstance('飞书客服')).toBeDefined()
    expect(await manager.loadLocalConfig('飞书客服')).toEqual({ TOKEN: 'keep' })
    remove.mockRestore()
    await manager.deleteInstance('飞书客服')
    expect(manager.getInstance('飞书客服')).toBeUndefined()
  })

  it('实例目录是符号链接时仅删除链接，不跟随清理目标', async () => {
    const target = path.join(dir, 'keep')
    await fs.mkdir(target)
    await fs.writeFile(path.join(target, 'marker'), 'keep')
    await fs.rm(path.join(dir, 'channels', '飞书客服'), { recursive: true })
    await fs.symlink(target, path.join(dir, 'channels', '飞书客服'), 'junction')
    await manager.deleteInstance('飞书客服')
    await expect(fs.lstat(path.join(dir, 'channels', '飞书客服'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await fs.readFile(path.join(target, 'marker'), 'utf8')).toBe('keep')
  })

  it.each(['AI-bot', 'ai-bot'])('删除后以 %s 重建不复用旧数据', async name => {
    const original = { ...manager.getInstance('飞书客服')!, id: 'AI-bot', name: 'AI-bot' }
    await manager.upsertInstanceById(original, null, 'skip')
    await fs.mkdir(path.join(dir, 'channels', original.id))
    await fs.writeFile(path.join(dir, 'channels', original.id, 'cache.json'), '{"old":true}')
    await manager.deleteInstance(original.id)
    // 用导入入口重建，覆盖原始 id，不依赖创建入口是否已放开大写。
    await manager.upsertInstanceById({ ...original, id: name, name }, null, 'skip')
    await expect(fs.stat(path.join(dir, 'channels', original.id))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(fs.readFile(path.join(dir, 'channels', name, 'cache.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
