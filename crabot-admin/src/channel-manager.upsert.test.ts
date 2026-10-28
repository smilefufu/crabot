import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { ChannelManager } from './channel-manager.js'
import type { ChannelInstance } from './types.js'

const makeInstance = (id: string, name: string): ChannelInstance => ({
  id,
  implementation_id: 'channel-wechat',
  name,
  platform: 'wechat',
  auto_start: false,
  start_priority: 30,
  module_registered: false,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
})

describe('ChannelManager.upsertInstanceById', () => {
  let dataDir: string
  let manager: ChannelManager

  beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'channel-upsert-'))
    await fs.mkdir(path.join(dataDir, 'channel-configs'), { recursive: true })
    const rpc = {
      registerModuleDefinition: vi.fn().mockResolvedValue({ registered: true }),
      startModule: vi.fn().mockResolvedValue({ started: true }),
    }
    manager = new ChannelManager(dataDir, rpc as any)
  })

  afterEach(async () => {
    await fs.rm(dataDir, { recursive: true, force: true })
  })

  it('新 id → 返回 imported，可在 listInstances 中查到', async () => {
    const inst = makeInstance('ch-import-1', 'wechat-prod')
    const result = await manager.upsertInstanceById(inst, null, 'skip')
    expect(result).toBe('imported')
    const { items } = manager.listInstances({})
    expect(items.some(i => i.id === 'ch-import-1')).toBe(true)
    expect(items.find(i => i.id === 'ch-import-1')?.name).toBe('wechat-prod')
  })

  it('同 id + skip → 返回 skipped，值不变', async () => {
    const inst = makeInstance('ch-import-2', 'Original')
    await manager.upsertInstanceById(inst, null, 'skip')
    const result = await manager.upsertInstanceById(makeInstance('ch-import-2', 'Updated'), null, 'skip')
    expect(result).toBe('skipped')
    const found = manager.listInstances({}).items.find(i => i.id === 'ch-import-2')
    expect(found?.name).toBe('Original')
  })

  it('同 id + overwrite → 返回 overwritten，值更新', async () => {
    const inst = makeInstance('ch-import-3', 'Original')
    await manager.upsertInstanceById(inst, null, 'skip')
    const result = await manager.upsertInstanceById(makeInstance('ch-import-3', 'Updated'), null, 'overwrite')
    expect(result).toBe('overwritten')
    const found = manager.listInstances({}).items.find(i => i.id === 'ch-import-3')
    expect(found?.name).toBe('Updated')
  })

  it.each(['skip', 'overwrite'] as const)(
    '仅大小写不同的导入 id（%s）不改名、不覆盖配置', async onConflict => {
      await manager.upsertInstanceById(makeInstance('AI客服bot', 'AI客服bot'), { KEY: 'original' }, 'skip')
      const before = await fs.readFile(path.join(dataDir, 'channel-instances.json'), 'utf8')
      const importing = manager.upsertInstanceById(makeInstance('ai客服bot', 'ai客服bot'), { KEY: 'replacement' }, onConflict)
      if (onConflict === 'skip') expect(await importing).toBe('skipped')
      else await expect(importing).rejects.toThrow(/already exists/)
      expect(manager.listInstances({}).items.map(i => i.id)).toEqual(['AI客服bot'])
      expect(await manager.loadLocalConfig('AI客服bot')).toEqual({ KEY: 'original' })
      expect(await fs.readFile(path.join(dataDir, 'channel-instances.json'), 'utf8')).toBe(before)
    },
  )

  it('config 非空时写入本地配置文件', async () => {
    const inst = makeInstance('ch-import-4', 'with-config')
    const config = { WECHAT_API_KEY: 'secret-123' }
    await manager.upsertInstanceById(inst, config, 'skip')
    const configPath = path.join(dataDir, 'channel-configs', 'ch-import-4.json')
    const raw = await fs.readFile(configPath, 'utf-8')
    expect(JSON.parse(raw)).toMatchObject({ WECHAT_API_KEY: 'secret-123' })
  })
})
