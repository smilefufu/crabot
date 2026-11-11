import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { ChannelManager } from './channel-manager.js'
import type { ChannelImplementation } from './types.js'

const fakeImpl: ChannelImplementation = {
  id: 'channel-feishu',
  name: 'feishu',
  type: 'builtin',
  platform: 'feishu',
  module_path: '../crabot-channel-feishu',
  version: '0.1.1',
  created_at: '2026-04-30T00:00:00Z',
  updated_at: '2026-04-30T00:00:00Z',
}

describe('ChannelManager.createInstance auto_start', () => {
  let dataDir: string

  beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'channel-mgr-'))
    await fs.mkdir(path.join(dataDir, 'channel-configs'), { recursive: true })
    const plugin = path.join(dataDir, 'channel-packages/crabot-channel-feishu/0.1.1/node_modules/crabot-channel-feishu')
    await fs.mkdir(path.join(plugin, 'dist'), { recursive: true })
    await fs.writeFile(path.join(plugin, 'package.json'), JSON.stringify({ name: 'crabot-channel-feishu', version: '0.1.1', main: 'dist/main.js' }))
    await fs.writeFile(path.join(plugin, 'dist/main.js'), '')
    await fs.writeFile(path.join(plugin, 'crabot-module.yaml'), 'module_id: channel-feishu')
    await fs.writeFile(path.join(plugin, '../../installation.json'), JSON.stringify({ name: 'crabot-channel-feishu', version: '0.1.1' }))
  })

  afterEach(async () => {
    await fs.rm(dataDir, { recursive: true, force: true })
  })

  it('calls startModule after register when auto_start is true', async () => {
    const rpc = {
      registerModuleDefinition: vi.fn().mockResolvedValue({ registered: true }),
      startModule: vi.fn().mockResolvedValue({ started: true }),
    }
    const manager = new ChannelManager(dataDir, rpc as any)
    await manager.addImplementation(fakeImpl)

    const instance = await manager.createInstance({
      implementation_id: fakeImpl.id,
      name: 'feishu-prod',
      auto_start: true,
    })

    expect(rpc.registerModuleDefinition).toHaveBeenCalledOnce()
    expect(rpc.startModule).toHaveBeenCalledWith('feishu-prod', 'admin')
    expect(instance.module_registered).toBe(true)
  })

  it('does NOT call startModule when auto_start is false', async () => {
    const rpc = {
      registerModuleDefinition: vi.fn().mockResolvedValue({ registered: true }),
      startModule: vi.fn().mockResolvedValue({ started: true }),
    }
    const manager = new ChannelManager(dataDir, rpc as any)
    await manager.addImplementation(fakeImpl)

    await manager.createInstance({
      implementation_id: fakeImpl.id,
      name: 'feishu-staging',
      auto_start: false,
    })

    expect(rpc.startModule).not.toHaveBeenCalled()
  })

  it('swallows ALREADY_RUNNING error from startModule (does not abort creation)', async () => {
    const rpc = {
      registerModuleDefinition: vi.fn().mockResolvedValue({ registered: true }),
      startModule: vi.fn().mockRejectedValue(new Error('ALREADY_RUNNING')),
    }
    const manager = new ChannelManager(dataDir, rpc as any)
    await manager.addImplementation(fakeImpl)

    const instance = await manager.createInstance({
      implementation_id: fakeImpl.id,
      name: 'feishu-already',
      auto_start: true,
    })

    expect(instance.module_registered).toBe(true)
    expect(rpc.startModule).toHaveBeenCalledOnce()
  })

  it('does not abort creation when startModule throws non-ALREADY_RUNNING error', async () => {
    const rpc = {
      registerModuleDefinition: vi.fn().mockResolvedValue({ registered: true }),
      startModule: vi.fn().mockRejectedValue(new Error('boom')),
    }
    const manager = new ChannelManager(dataDir, rpc as any)
    await manager.addImplementation(fakeImpl)

    const instance = await manager.createInstance({
      implementation_id: fakeImpl.id,
      name: 'feishu-boom',
      auto_start: true,
    })

    expect(instance.module_registered).toBe(true)
    expect(manager.getInstance('feishu-boom')).toBeDefined()
  })
})
