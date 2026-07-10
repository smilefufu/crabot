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

  it('拒绝含空格、大写、emoji 的实例名', async () => {
    const manager = new ChannelManager(dataDir, makeRpc() as any)
    await manager.addImplementation(fakeImpl)

    for (const name of ['微信 客服', 'Telegram', '客服🤖']) {
      await expect(
        manager.createInstance({ implementation_id: fakeImpl.id, name })
      ).rejects.toThrow(/Invalid instance name/)
    }
  })

  it('NFD 输入以 NFC 形式存储', async () => {
    const manager = new ChannelManager(dataDir, makeRpc() as any)
    await manager.addImplementation(fakeImpl)

    const nfd = 'café'.normalize('NFD')
    const instance = await manager.createInstance({
      implementation_id: fakeImpl.id,
      name: nfd,
    })
    expect(instance.id).toBe('café'.normalize('NFC'))
  })

  it('NFC/NFD 视为同名，重复创建被拒绝', async () => {
    const manager = new ChannelManager(dataDir, makeRpc() as any)
    await manager.addImplementation(fakeImpl)

    await manager.createInstance({
      implementation_id: fakeImpl.id,
      name: 'café'.normalize('NFC'),
    })
    await expect(
      manager.createInstance({
        implementation_id: fakeImpl.id,
        name: 'café'.normalize('NFD'),
      })
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
