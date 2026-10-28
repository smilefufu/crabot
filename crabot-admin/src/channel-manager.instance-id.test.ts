import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
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
  version: '0.1.0',
  created_at: '2026-04-30T00:00:00Z',
  updated_at: '2026-04-30T00:00:00Z',
}

function makeRpc() {
  return {
    registerModuleDefinition: vi.fn().mockResolvedValue({ registered: true }),
    startModule: vi.fn().mockResolvedValue({ started: true }),
  }
}

describe('ChannelManager.createInstance 实例 id 校验', () => {
  let dataDir: string

  beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'channel-mgr-id-'))
    await fs.mkdir(path.join(dataDir, 'channel-configs'), { recursive: true })
  })

  afterEach(async () => {
    await fs.rm(dataDir, { recursive: true, force: true })
  })

  it('接受中文实例名，module_id 原样注册到 MM', async () => {
    const rpc = makeRpc()
    const manager = new ChannelManager(dataDir, rpc as any)
    await manager.addImplementation(fakeImpl)

    const instance = await manager.createInstance({
      implementation_id: fakeImpl.id,
      name: '微信客服',
    })

    expect(instance.id).toBe('微信客服')
    expect(instance.name).toBe('微信客服')
    expect(rpc.registerModuleDefinition).toHaveBeenCalledWith(
      expect.objectContaining({ module_id: '微信客服' }),
      'admin'
    )
  })

  it('拒绝含空格、emoji 的实例名', async () => {
    const manager = new ChannelManager(dataDir, makeRpc() as any)
    await manager.addImplementation(fakeImpl)

    for (const name of ['微信 客服', '客服🤖']) {
      await expect(
        manager.createInstance({ implementation_id: fakeImpl.id, name })
      ).rejects.toThrow(/Invalid instance name/)
    }
  })

  it('大写混合实例名原样注册、持久化并在重新加载后读取配置', async () => {
    const rpc = makeRpc()
    const manager = new ChannelManager(dataDir, rpc as any)
    await manager.addImplementation(fakeImpl)
    const instance = await manager.createInstance({
      implementation_id: fakeImpl.id, name: 'AI客服bot', env: { APP_ID: 'original' },
    })
    expect(instance.id).toBe('AI客服bot')
    expect(instance.name).toBe('AI客服bot')
    expect(rpc.registerModuleDefinition).toHaveBeenCalledWith(
      expect.objectContaining({ module_id: 'AI客服bot' }), 'admin',
    )
    const restored = new ChannelManager(dataDir, rpc as any)
    await restored.initialize()
    expect(restored.getInstance('AI客服bot')?.name).toBe('AI客服bot')
    expect(restored.getInstance('ai客服bot')).toBeUndefined()
    expect(await restored.loadLocalConfig('AI客服bot')).toEqual({ APP_ID: 'original' })
    await expect(restored.createInstance({ implementation_id: fakeImpl.id, name: 'ai客服bot' }))
      .rejects.toThrow(/already exists/)
  })

  it.each([['AI客服bot', 'ai客服bot'], ['ai客服bot', 'AI客服bot']])(
    '已有 %s 时拒绝 %s，配置与注册保持原样', async (existing, duplicate) => {
      const rpc = makeRpc()
      const manager = new ChannelManager(dataDir, rpc as any)
      await manager.addImplementation(fakeImpl)
      await manager.createInstance({ implementation_id: fakeImpl.id, name: existing, env: { APP_ID: 'original' } })
      const before = await fs.readFile(path.join(dataDir, 'channel-instances.json'), 'utf8')
      await expect(manager.createInstance({
        implementation_id: fakeImpl.id, name: duplicate, env: { APP_ID: 'replacement' },
      })).rejects.toThrow(/already exists/)
      expect(manager.listInstances({}).items.map(i => i.id)).toEqual([existing])
      expect(await manager.loadLocalConfig(existing)).toEqual({ APP_ID: 'original' })
      expect(await fs.readFile(path.join(dataDir, 'channel-instances.json'), 'utf8')).toBe(before)
      expect(rpc.registerModuleDefinition).toHaveBeenCalledTimes(1)
    },
  )

  it('并发创建仅大小写不同的名称时只保留一个实例', async () => {
    const rpc = makeRpc()
    const manager = new ChannelManager(dataDir, rpc as any)
    await manager.addImplementation(fakeImpl)
    const results = await Promise.allSettled(['AI客服bot', 'ai客服bot'].map(name =>
      manager.createInstance({ implementation_id: fakeImpl.id, name }),
    ))
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1)
    expect(manager.listInstances({}).items).toHaveLength(1)
    expect(rpc.registerModuleDefinition).toHaveBeenCalledTimes(1)
  })

  it('同名中文实例重复创建被拒绝', async () => {
    const manager = new ChannelManager(dataDir, makeRpc() as any)
    await manager.addImplementation(fakeImpl)

    await manager.createInstance({ implementation_id: fakeImpl.id, name: '微信客服' })
    await expect(
      manager.createInstance({ implementation_id: fakeImpl.id, name: '微信客服' })
    ).rejects.toThrow(/already exists/)
  })
})

describe('ChannelManager.upsertInstanceById NFC 归一化', () => {
  let dataDir: string

  beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'channel-mgr-upsert-'))
    await fs.mkdir(path.join(dataDir, 'channel-configs'), { recursive: true })
  })

  afterEach(async () => {
    await fs.rm(dataDir, { recursive: true, force: true })
  })

  it('NFD id 归一化后与已有 NFC 实例匹配（skip 生效）', async () => {
    const manager = new ChannelManager(dataDir, makeRpc() as any)
    const nfc = 'café'.normalize('NFC')
    const base = {
      implementation_id: 'channel-feishu',
      platform: 'feishu',
      auto_start: false,
      start_priority: 30,
      module_registered: false,
      created_at: '2026-07-10T00:00:00Z',
      updated_at: '2026-07-10T00:00:00Z',
    }
    await manager.upsertInstanceById({ ...base, id: nfc, name: nfc }, null, 'skip')

    const result = await manager.upsertInstanceById(
      { ...base, id: 'café'.normalize('NFD'), name: 'café'.normalize('NFD') },
      null,
      'skip'
    )
    expect(result).toBe('skipped')
    expect(manager.getInstance(nfc)).toBeDefined()
  })

  it('NFD id 导入后以 NFC 形式存储', async () => {
    const manager = new ChannelManager(dataDir, makeRpc() as any)
    const nfd = 'naïve-渠道'.normalize('NFD')
    await manager.upsertInstanceById(
      {
        implementation_id: 'channel-feishu',
        id: nfd,
        name: nfd,
        platform: 'feishu',
        auto_start: false,
        start_priority: 30,
        module_registered: false,
        created_at: '2026-07-10T00:00:00Z',
        updated_at: '2026-07-10T00:00:00Z',
      },
      { SOME_KEY: 'v' },
      'overwrite'
    )
    const nfc = 'naïve-渠道'.normalize('NFC')
    expect(manager.getInstance(nfc)).toBeDefined()
    expect(manager.getInstance(nfc)!.id).toBe(nfc)
    expect(await manager.loadLocalConfig(nfc)).toEqual({ SOME_KEY: 'v' })
  })
})
