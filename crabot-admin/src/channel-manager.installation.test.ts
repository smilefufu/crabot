import { installTestChannel } from '../tests/helpers/installed-channel.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { ChannelManager } from './channel-manager.js'

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

  it('never starts an old auto-start account when package preparation failed', async () => {
    const { root, rpc } = await fixture()
    await fs.writeFile(path.join(root, 'channel-instances.json'), JSON.stringify([{ id: 'restore-me', name: 'restore-me', implementation_id: 'channel-feishu', platform: 'feishu', auto_start: true, start_priority: 30, module_registered: false, created_at: '', updated_at: '' }]))
    const restored = new ChannelManager(root, rpc as any)
    await restored.initialize()
    vi.spyOn(restored, 'installPlugin').mockRejectedValue(new Error('synthetic-private-install-failure'))
    await restored.reRegisterInstances()
    expect(rpc.startModule).not.toHaveBeenCalled()
    expect(restored.getInstance('restore-me')).toMatchObject({ auto_start: true })
    expect(restored.getStartupError('restore-me')).toContain('账号配置已保留')
    expect(restored.getStartupError('restore-me')).not.toContain('synthetic-private')
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
