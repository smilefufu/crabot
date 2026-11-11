import { installTestChannel } from '../tests/helpers/installed-channel.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { ChannelManager } from './channel-manager.js'
import { RpcCallError } from 'crabot-shared'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }) })
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'channel-installation-'))
  roots.push(root)
  const rpc = { registerModuleDefinition: vi.fn(), startModule: vi.fn() }
  const manager = new ChannelManager(root, rpc as any)
  await manager.initialize()
  return { root, rpc, manager }
}

describe('Channel installation admission', () => {
  it('does not turn the official catalog or old implementation records into installed modules', async () => {
    const { root, manager } = await fixture()
    expect(manager.listImplementations().items).toEqual([])
    const catalog = await manager.listPlugins()
    expect(catalog.items).toHaveLength(6)
    expect(catalog.items.every(item => item.installed === false)).toBe(true)
    await fs.writeFile(path.join(root, 'channel-implementations.json'), JSON.stringify([{ id: 'channel-feishu', type: 'builtin', module_path: '../crabot-channel-feishu' }]))
    const restored = new ChannelManager(root, {} as any)
    await restored.initialize()
    expect(restored.listImplementations().items).toEqual([])
  })

  it('rejects creating and onboarding an uninstalled official plugin without creating an instance or downloading', async () => {
    const { manager, rpc } = await fixture()
    await expect(manager.createInstance({ implementation_id: 'channel-feishu', name: 'feishu-test' })).rejects.toMatchObject({ code: 'CHANNEL_NOT_INSTALLED' })
    await expect(manager.prepareOnboarding('channel-feishu', 'device_code')).rejects.toMatchObject({ code: 'CHANNEL_NOT_INSTALLED' })
    expect(manager.listInstances().items).toEqual([])
    expect(rpc.registerModuleDefinition).not.toHaveBeenCalled()
  })

  it('lists exactly the installed packages and mounts their onboarding and managed host paths', async () => {
    const { root, manager, rpc } = await fixture()
    const feishu = await installTestChannel(root, 'feishu')
    await installTestChannel(root, 'telegram')
    expect(manager.listImplementations().items.map(item => item.id)).toEqual(['channel-feishu', 'channel-telegram'])
    expect(manager.listImplementations({ page_size: 1, page: 2 }).items[0].id).toBe('channel-telegram')
    expect(manager.getImplementation('channel-feishu')).toMatchObject({ type: 'installed', installed_path: feishu, version: '0.1.1' })
    const installed = (await manager.listPlugins()).items.filter(item => item.installed)
    expect(installed.map(item => item.platform)).toEqual(['feishu', 'telegram'])
    const instance = await manager.createInstance({ implementation_id: 'channel-feishu', name: 'my-feishu', auto_start: false })
    expect(instance.module_registered).toBe(true)
    expect(rpc.registerModuleDefinition.mock.calls[0][0]).toMatchObject({ env: { CRABOT_CHANNEL_PLUGIN_PATH: path.join(feishu, 'dist/main.js') } })
    expect(rpc.registerModuleDefinition.mock.calls[0][0].entry).toContain('channel-host.js')
    expect(rpc.startModule).not.toHaveBeenCalled()
    await fs.rm(path.join(feishu, 'dist/main.js'))
    expect(manager.listImplementations().items.map(item => item.id)).toEqual(['channel-telegram'])
  })

  it('does not count an uncommitted package tree as a completed installation', async () => {
    const { root, manager } = await fixture()
    const directory = await installTestChannel(root, 'feishu')
    await fs.rm(path.join(directory, '../../installation.json'))
    expect(manager.listImplementations().items).toEqual([])
    expect((await manager.listPlugins()).items.every(item => !item.installed)).toBe(true)
  })

  it.each(['feishu', 'telegram', 'wechat', 'dingtalk', 'slack', 'voice'])('keeps an existing %s account and credentials without starting when its plugin installation fails', async platform => {
    const { root, rpc } = await fixture()
    await fs.writeFile(path.join(root, 'channel-instances.json'), JSON.stringify([{ id: 'restore-me', name: 'restore-me', implementation_id: `channel-${platform}`, platform, auto_start: true, start_priority: 30, module_registered: false, created_at: '', updated_at: '' }]))
    const config = { FIXTURE_CREDENTIAL: 'synthetic-existing-secret' }
    await fs.writeFile(path.join(root, 'channel-configs/restore-me.json'), JSON.stringify(config))
    const restored = new ChannelManager(root, rpc as any)
    await restored.initialize()
    vi.spyOn(restored, 'installPlugin').mockRejectedValue(new Error('synthetic-private-install-failure'))
    await restored.reRegisterInstances()
    expect(rpc.registerModuleDefinition).not.toHaveBeenCalled()
    expect(rpc.startModule).not.toHaveBeenCalled()
    expect(restored.getInstance('restore-me')).toMatchObject({ auto_start: true })
    expect(await restored.loadLocalConfig('restore-me')).toEqual(config)
    expect(restored.getStartupError('restore-me')).toContain('账号配置已保留')
    expect(restored.getStartupError('restore-me')).not.toContain('synthetic-private')
  })

  it.each(['feishu', 'telegram', 'wechat', 'dingtalk', 'slack'])('restores an existing %s auto-start account by installing its missing plugin before registration and start', async platform => {
    const { root, rpc } = await fixture()
    const saved = { id: '已有账号', name: '已有账号', implementation_id: `channel-${platform}`, platform, auto_start: true, start_priority: 30, module_registered: true, created_at: '', updated_at: '' }
    const config = { FIXTURE_CREDENTIAL: 'synthetic-existing-secret' }
    await fs.writeFile(path.join(root, 'channel-instances.json'), JSON.stringify([saved]))
    await fs.writeFile(path.join(root, 'channel-configs', `${saved.id}.json`), JSON.stringify(config))
    const restored = new ChannelManager(root, rpc as any)
    await restored.initialize()
    expect(restored.listImplementations().items).toEqual([])
    const order: string[] = []
    vi.spyOn(restored, 'installPlugin').mockImplementation(async id => {
      order.push('install')
      await installTestChannel(root, platform)
      return restored.requireInstalled(id)
    })
    rpc.registerModuleDefinition.mockImplementation(async () => { order.push('register') })
    rpc.startModule.mockImplementation(async () => { order.push('start') })

    await restored.reRegisterInstances()

    expect(order).toEqual(['install', 'register', 'start'])
    expect(restored.getInstance(saved.id)).toEqual(saved)
    expect(await restored.loadLocalConfig(saved.id)).toEqual(config)
    expect(rpc.registerModuleDefinition).toHaveBeenCalledWith(expect.objectContaining({
      module_id: saved.id, auto_start: true,
      env: expect.objectContaining({ ...config, DATA_DIR: path.join(root, 'channels', saved.id) }),
    }), 'admin')
    expect(restored.getStartupError(saved.id)).toBeUndefined()
  })

  it('does not download a stopped existing account until explicitly preparing its original definition for start', async () => {
    const { root, rpc } = await fixture()
    const saved = { id: '已有停用账号', name: '已有停用账号', implementation_id: 'channel-telegram', platform: 'telegram', auto_start: false, start_priority: 30, module_registered: true, created_at: '', updated_at: '' }
    await fs.writeFile(path.join(root, 'channel-instances.json'), JSON.stringify([saved]))
    const restored = new ChannelManager(root, rpc as any)
    await restored.initialize()
    const install = vi.spyOn(restored, 'installPlugin').mockImplementation(async id => {
      await installTestChannel(root, 'telegram')
      return restored.requireInstalled(id)
    })
    await restored.reRegisterInstances()
    expect(install).not.toHaveBeenCalled()
    expect(rpc.registerModuleDefinition).not.toHaveBeenCalled()
    expect(rpc.startModule).not.toHaveBeenCalled()

    await restored.ensureInstanceDefinition(saved.id)

    expect(install).toHaveBeenCalledWith(saved.implementation_id)
    expect(rpc.registerModuleDefinition).toHaveBeenCalledOnce()
    expect(rpc.startModule).not.toHaveBeenCalled()
    expect(restored.getInstance(saved.id)).toEqual(saved)
  })

  it('accepts the protocol duplicate-definition result when preparing an existing instance for restart or Admin recovery', async () => {
    const { root, manager, rpc } = await fixture()
    await installTestChannel(root, 'feishu')
    const instance = await manager.createInstance({ implementation_id: 'channel-feishu', name: 'existing-feishu', auto_start: false })
    rpc.registerModuleDefinition.mockRejectedValue(new RpcCallError('MODULE_MANAGER_DUPLICATE_ID', 'Module ID already exists'))
    await expect(manager.ensureInstanceDefinition(instance.id)).resolves.toBeUndefined()
    expect(await manager.registerBuiltinInstanceDefinitions()).toEqual([expect.objectContaining({ id: instance.id })])
    expect(manager.getStartupError(instance.id)).toBeUndefined()
    expect(rpc.startModule).not.toHaveBeenCalled()
  })

  it('preserves saved stopped accounts even when the plugin is not installed', async () => {
    const { root } = await fixture()
    const saved = { id: 'old-channel', name: 'old-channel', implementation_id: 'channel-telegram', platform: 'telegram', auto_start: false, start_priority: 30, module_registered: false, created_at: '', updated_at: '' }
    await fs.writeFile(path.join(root, 'channel-instances.json'), JSON.stringify([saved]))
    const rpc = { startModule: vi.fn() }
    const restored = new ChannelManager(root, rpc as any)
    await restored.initialize()
    expect(restored.listInstances().items).toEqual([saved])
    expect(restored.listImplementations().items).toEqual([])
    expect(rpc.startModule).not.toHaveBeenCalled()
  })
})
